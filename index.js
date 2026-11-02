"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || "";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");
const PUBLIC_DIR = path.join(__dirname, "public");
const DIRECTIONS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  ssl:
    process.env.PG_SSL === "require"
      ? { rejectUnauthorized: false }
      : undefined,
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(
  express.static(PUBLIC_DIR, { index: "index.html", extensions: ["html"] }),
);

const PgSessionStore = connectPgSimple(session);
const sessionStore = new PgSessionStore({
  pool,
  tableName: "web_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 60,
});
const sessionMiddleware = session({
  name: "filipino_dama",
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure:
      process.env.NODE_ENV === "production" ||
      process.env.APP_HTTPS_ONLY === "1",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
});
if (DATABASE_URL) {
  app.use("/api.php", sessionMiddleware);
} else {
  app.use("/api.php", (_req, res) =>
    res.status(503).json({
      ok: false,
      error:
        "Online play needs a PostgreSQL DATABASE_URL. Local practice is still available.",
    }),
  );
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assertDatabaseConfigured() {
  if (!DATABASE_URL) {
    throw new ApiError(
      503,
      "Online play needs a PostgreSQL DATABASE_URL. Local practice is still available.",
    );
  }
}

function initSession(req) {
  if (!req.session.playerId) req.session.playerId = crypto.randomUUID();
  if (!req.session.nickname) {
    req.session.nickname = `Guest ${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  }
  if (!req.session.csrf)
    req.session.csrf = crypto.randomBytes(32).toString("hex");
}

function requireCsrf(req) {
  const sent = String(req.get("X-CSRF-Token") || "");
  const expected = String(req.session.csrf || "");
  if (
    !sent ||
    !expected ||
    sent.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))
  ) {
    throw new ApiError(
      419,
      "Security token expired. Refresh the page and try again.",
    );
  }
}

function roomCode(value) {
  if (typeof value !== "string")
    throw new ApiError(422, "Enter a valid six-character room code.");
  const code = value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code))
    throw new ApiError(422, "Enter a valid six-character room code.");
  return code;
}

async function ensurePlayer(queryable, req) {
  await queryable.query(
    `INSERT INTO players (id, nickname, created_at, last_seen)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET nickname = EXCLUDED.nickname, last_seen = NOW()`,
    [req.session.playerId, req.session.nickname],
  );
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function playerName(queryable, playerId) {
  const result = await queryable.query(
    "SELECT nickname FROM players WHERE id = $1",
    [playerId],
  );
  return result.rows[0]?.nickname || "Guest";
}

function initialState() {
  const board = Array(64).fill(null);
  let id = 1;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1)
        board[row * 8 + col] = { id: id++, side: "dark", king: false };
    }
  }
  for (let row = 5; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if ((row + col) % 2 === 1)
        board[row * 8 + col] = { id: id++, side: "light", king: false };
    }
  }
  return {
    board,
    side: "light",
    chain: null,
    quietTurns: 0,
    history: [],
    gameOver: false,
    result: null,
  };
}

function inside(row, col) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}
function rowCol(position) {
  return [Math.floor(position / 8), position % 8];
}
function forward(side) {
  return side === "light" ? -1 : 1;
}
function promote(piece, position) {
  const [row] = rowCol(position);
  if (
    !piece.king &&
    ((piece.side === "light" && row === 0) ||
      (piece.side === "dark" && row === 7))
  )
    piece.king = true;
}
function cloneBoard(board) {
  return board.map((piece) => (piece ? { ...piece } : null));
}

function captureMoves(board, position, piece, taken = []) {
  const [row, col] = rowCol(position);
  const moves = [];
  if (!piece.king) {
    for (const [dr, dc] of DIRECTIONS) {
      const mr = row + dr;
      const mc = col + dc;
      const tr = row + 2 * dr;
      const tc = col + 2 * dc;
      if (!inside(mr, mc) || !inside(tr, tc)) continue;
      const middle = mr * 8 + mc;
      const to = tr * 8 + tc;
      const enemy = board[middle];
      if (
        enemy &&
        enemy.side !== piece.side &&
        !taken.includes(middle) &&
        board[to] === null
      ) {
        moves.push({ from: position, to, capture: middle });
      }
    }
    return moves;
  }
  for (const [dr, dc] of DIRECTIONS) {
    let r = row + dr;
    let c = col + dc;
    let enemyAt = null;
    while (inside(r, c)) {
      const at = r * 8 + c;
      const occupant = board[at];
      if (occupant === null) {
        if (enemyAt !== null)
          moves.push({ from: position, to: at, capture: enemyAt });
        r += dr;
        c += dc;
        continue;
      }
      if (
        enemyAt !== null ||
        occupant.side === piece.side ||
        taken.includes(at)
      )
        break;
      enemyAt = at;
      r += dr;
      c += dc;
    }
  }
  return moves;
}

function simulateCapture(board, move, piece, taken = []) {
  const nextBoard = cloneBoard(board);
  const moved = { ...piece };
  nextBoard[move.from] = null;
  promote(moved, move.to);
  nextBoard[move.to] = moved;
  return { board: nextBoard, piece: moved, taken: [...taken, move.capture] };
}

function boardKey(board) {
  return board
    .map((piece) => {
      if (!piece) return ".";
      if (piece.side === "light") return piece.king ? "L" : "l";
      return piece.king ? "D" : "d";
    })
    .join("");
}

function maxFurther(board, position, piece, taken, memo) {
  const key = `${boardKey(board)}|${position}|${piece.king ? "K" : "M"}|${[...taken].sort((a, b) => a - b).join(",")}`;
  if (memo.has(key)) return memo.get(key);
  let best = 0;
  for (const move of captureMoves(board, position, piece, taken)) {
    const sim = simulateCapture(board, move, piece, taken);
    best = Math.max(
      best,
      1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo),
    );
  }
  memo.set(key, best);
  return best;
}

function maxCaptures(state) {
  let best = 0;
  const memo = new Map();
  state.board.forEach((piece, position) => {
    if (!piece || piece.side !== state.side) return;
    for (const move of captureMoves(state.board, position, piece, [])) {
      const sim = simulateCapture(state.board, move, piece, []);
      best = Math.max(
        best,
        1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo),
      );
    }
  });
  return best;
}

function quietMoves(board, position, piece) {
  const [row, col] = rowCol(position);
  const moves = [];
  if (piece.king) {
    for (const [dr, dc] of DIRECTIONS) {
      let r = row + dr;
      let c = col + dc;
      while (inside(r, c) && board[r * 8 + c] === null) {
        moves.push({ from: position, to: r * 8 + c, capture: null });
        r += dr;
        c += dc;
      }
    }
  } else {
    const dr = forward(piece.side);
    for (const dc of [-1, 1]) {
      const r = row + dr;
      const c = col + dc;
      if (inside(r, c) && board[r * 8 + c] === null)
        moves.push({ from: position, to: r * 8 + c, capture: null });
    }
  }
  return moves;
}

function legalMoves(state) {
  if (!state || state.gameOver) return [];
  const board = state.board;
  if (state.chain !== null) {
    const position = Number(state.chain.pos);
    const piece = board[position];
    if (!piece) return [];
    const memo = new Map();
    return captureMoves(board, position, piece, state.chain.taken).filter(
      (move) => {
        const sim = simulateCapture(board, move, piece, state.chain.taken);
        return (
          1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo) ===
          Number(state.chain.remaining)
        );
      },
    );
  }
  const best = maxCaptures(state);
  if (best > 0) {
    const result = [];
    const memo = new Map();
    board.forEach((piece, position) => {
      if (!piece || piece.side !== state.side) return;
      for (const move of captureMoves(board, position, piece, [])) {
        const sim = simulateCapture(board, move, piece, []);
        if (
          1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo) ===
          best
        )
          result.push(move);
      }
    });
    return result;
  }
  const result = [];
  board.forEach((piece, position) => {
    if (piece && piece.side === state.side)
      result.push(...quietMoves(board, position, piece));
  });
  return result;
}

function applyMove(currentState, from, to) {
  const move = legalMoves(currentState).find(
    (candidate) => candidate.from === from && candidate.to === to,
  );
  if (!move) throw new ApiError(422, "That move is not legal.");
  const state = structuredClone(currentState);
  const board = state.board;
  const piece = board[from];
  if (!piece) throw new ApiError(422, "Piece not found.");
  const wasKing = Boolean(piece.king);
  const [fromRow] = rowCol(from);
  const [toRow] = rowCol(to);
  const advanced = !wasKing && toRow - fromRow === forward(piece.side);
  const chain = state.chain;
  const taken = chain ? [...chain.taken] : [];
  const path = chain ? [...chain.path] : [];
  const count = chain ? Number(chain.count) : 0;
  let manAdvanced = chain ? Boolean(chain.manAdvanced) : false;
  const targetRemaining = chain
    ? Number(chain.remaining)
    : maxCaptures(currentState);

  board[from] = null;
  promote(piece, to);
  board[to] = piece;
  path.push({
    from,
    to,
    capture: move.capture,
    promoted: !wasKing && Boolean(piece.king),
  });
  let captureCount = count;
  if (move.capture !== null) {
    taken.push(Number(move.capture));
    captureCount++;
    manAdvanced = manAdvanced || advanced;
    const remaining = targetRemaining - 1;
    if (remaining > 0) {
      state.chain = {
        pos: to,
        taken,
        remaining,
        path,
        count: captureCount,
        manAdvanced,
      };
      return state;
    }
  } else {
    manAdvanced = manAdvanced || advanced;
  }

  for (const capturedAt of taken) board[capturedAt] = null;
  state.chain = null;
  state.quietTurns =
    captureCount > 0 || manAdvanced ? 0 : Number(state.quietTurns || 0) + 1;
  state.history.push({ side: piece.side, path, captures: captureCount });
  if (state.history.length > 80) state.history.shift();
  const mover = state.side;
  state.side = mover === "light" ? "dark" : "light";
  const lightCount = board.filter((p) => p?.side === "light").length;
  const darkCount = board.filter((p) => p?.side === "dark").length;
  if (lightCount === 0 || darkCount === 0) {
    state.gameOver = true;
    state.result = {
      type: "win",
      winner: lightCount === 0 ? "dark" : "light",
      reason: "all-pieces-captured",
    };
  } else if (legalMoves(state).length === 0) {
    state.gameOver = true;
    state.result = {
      type: "win",
      winner: mover,
      reason: "opponent-has-no-legal-move",
    };
  } else if (state.quietTurns >= 40) {
    state.gameOver = true;
    state.result = { type: "draw", winner: null, reason: "40-quiet-turns" };
  }
  return state;
}

async function makeCode(queryable) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++)
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    const exists = await queryable.query(
      "SELECT 1 FROM games WHERE room_code = $1",
      [code],
    );
    if (exists.rowCount === 0) return code;
  }
  throw new Error("Could not allocate a room code. Please retry.");
}

async function createGame(queryable, lightPlayer, darkPlayer, code, status) {
  const state = initialState();
  const lightName = await playerName(queryable, lightPlayer);
  const darkName = darkPlayer ? await playerName(queryable, darkPlayer) : null;
  const result = await queryable.query(
    `INSERT INTO games (room_code, status, light_player, dark_player, light_name, dark_name, state_json, revision, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 0, NOW(), NOW()) RETURNING id`,
    [
      code,
      status,
      lightPlayer,
      darkPlayer,
      lightName,
      darkName,
      JSON.stringify(state),
    ],
  );
  return Number(result.rows[0].id);
}

function publicGame(row, playerId) {
  const state =
    typeof row.state_json === "string"
      ? JSON.parse(row.state_json)
      : row.state_json;
  const viewerSide =
    playerId === row.light_player
      ? "light"
      : playerId === row.dark_player
        ? "dark"
        : null;
  const moves =
    viewerSide && row.status === "active" && state.side === viewerSide
      ? legalMoves(state)
      : [];
  return {
    ok: true,
    code: String(row.room_code).trim(),
    status: row.status,
    revision: Number(row.revision),
    viewerSide,
    lightName: row.light_name || "Light",
    darkName: row.dark_name || "Waiting for player",
    state,
    legal: moves,
  };
}

async function roomRow(queryable, code, playerId, lock = false) {
  const result = await queryable.query(
    `SELECT * FROM games WHERE room_code = $1${lock ? " FOR UPDATE" : ""}`,
    [code],
  );
  const row = result.rows[0];
  if (!row)
    throw new ApiError(404, "Room not found. Check the code and try again.");
  if (playerId !== row.light_player && playerId !== row.dark_player) {
    throw new ApiError(403, "You are not a player in this room.");
  }
  return row;
}

async function roomPayload(code, playerId) {
  const row = await roomRow(pool, code, playerId);
  return publicGame(row, playerId);
}

async function updateResultStats(queryable, state, row) {
  if (!state.gameOver || !state.result) return;
  if (state.result.type === "draw") {
    await queryable.query(
      "UPDATE players SET draws = draws + 1, games_played = games_played + 1 WHERE id IN ($1, $2)",
      [row.light_player, row.dark_player],
    );
    return;
  }
  const winner =
    state.result.winner === "light" ? row.light_player : row.dark_player;
  const loser =
    state.result.winner === "light" ? row.dark_player : row.light_player;
  if (!winner || !loser) return;
  await queryable.query(
    "UPDATE players SET wins = wins + 1, games_played = games_played + 1 WHERE id = $1",
    [winner],
  );
  await queryable.query(
    "UPDATE players SET losses = losses + 1, games_played = games_played + 1 WHERE id = $1",
    [loser],
  );
}

async function apiHandler(req, res) {
  try {
    assertDatabaseConfigured();
    const action = typeof req.query.action === "string" ? req.query.action : "";
    initSession(req);

    if (action === "bootstrap") {
      if (req.method !== "GET") throw new ApiError(405, "Method not allowed.");
      return res.json({
        ok: true,
        csrf: req.session.csrf,
        playerId: req.session.playerId,
        nickname: req.session.nickname,
      });
    }

    if (action === "stats" || action === "room" || action === "match_status") {
      if (req.method !== "GET") throw new ApiError(405, "Method not allowed.");
      await ensurePlayer(pool, req);
      if (action === "stats") {
        const result = await pool.query(
          "SELECT nickname, wins, losses, draws, games_played FROM players WHERE id = $1",
          [req.session.playerId],
        );
        return res.json({ ok: true, stats: result.rows[0] || null });
      }
      if (action === "room") {
        return res.json(
          await roomPayload(roomCode(req.query.code), req.session.playerId),
        );
      }
      const active = await pool.query(
        `SELECT * FROM games WHERE (light_player = $1 OR dark_player = $1)
         AND status = 'active' ORDER BY id DESC LIMIT 1`,
        [req.session.playerId],
      );
      if (active.rows[0])
        return res.json(publicGame(active.rows[0], req.session.playerId));
      const queued = await pool.query(
        "SELECT created_at FROM matchmaking WHERE player_id = $1",
        [req.session.playerId],
      );
      if (
        queued.rows[0] &&
        Date.now() - new Date(queued.rows[0].created_at).getTime() > 180_000
      ) {
        await pool.query("DELETE FROM matchmaking WHERE player_id = $1", [
          req.session.playerId,
        ]);
        return res.json({ ok: true, status: "idle" });
      }
      return res.json({
        ok: true,
        status: queued.rowCount ? "queued" : "idle",
      });
    }

    if (req.method !== "POST") throw new ApiError(405, "Method not allowed.");
    requireCsrf(req);
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      throw new ApiError(400, "Invalid JSON request.");
    await ensurePlayer(pool, req);
    const data = req.body;
    const playerId = req.session.playerId;

    if (action === "set_name") {
      if (typeof data.nickname !== "string")
        throw new ApiError(422, "Choose a name from 1 to 24 characters.");
      let name = data.nickname.trim();
      const points = Array.from(name);
      if (points.length > 24) name = points.slice(0, 24).join("");
      if (!name || /[<>\x00-\x1F]/u.test(name))
        throw new ApiError(422, "Choose a name from 1 to 24 characters.");
      req.session.nickname = name;
      await pool.query(
        "UPDATE players SET nickname = $1, last_seen = NOW() WHERE id = $2",
        [name, playerId],
      );
      return res.json({ ok: true, nickname: name });
    }

    if (action === "create_room") {
      const code = await withTransaction(async (client) => {
        await client.query("DELETE FROM matchmaking WHERE player_id = $1", [
          playerId,
        ]);
        const newCode = await makeCode(client);
        await createGame(client, playerId, null, newCode, "waiting");
        return newCode;
      });
      return res.json(await roomPayload(code, playerId));
    }

    if (action === "join_room") {
      const code = roomCode(data.code);
      await withTransaction(async (client) => {
        const result = await client.query(
          "SELECT * FROM games WHERE room_code = $1 FOR UPDATE",
          [code],
        );
        const row = result.rows[0];
        if (!row)
          throw new ApiError(
            404,
            "Room not found. Check the code and try again.",
          );
        if (row.light_player === playerId || row.dark_player === playerId)
          return;
        if (row.status !== "waiting" || row.dark_player !== null)
          throw new ApiError(409, "That room is already full.");
        await client.query("DELETE FROM matchmaking WHERE player_id = $1", [
          playerId,
        ]);
        await client.query(
          "UPDATE games SET dark_player = $1, dark_name = $2, status = 'active', updated_at = NOW() WHERE id = $3",
          [playerId, req.session.nickname, row.id],
        );
      });
      return res.json(await roomPayload(code, playerId));
    }

    if (action === "quick_match") {
      const match = await withTransaction(async (client) => {
        await client.query(
          "DELETE FROM matchmaking WHERE created_at < NOW() - INTERVAL '3 minutes'",
        );
        const existing = await client.query(
          `SELECT * FROM games WHERE (light_player = $1 OR dark_player = $1)
           AND status = 'active' ORDER BY id DESC LIMIT 1`,
          [playerId],
        );
        if (existing.rows[0]) return { game: existing.rows[0] };

        const ownQueue = await client.query(
          "SELECT player_id FROM matchmaking WHERE player_id = $1 FOR UPDATE",
          [playerId],
        );
        const opponent = await client.query(
          `SELECT player_id FROM matchmaking
           WHERE player_id <> $1 AND created_at >= NOW() - INTERVAL '3 minutes'
           ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [playerId],
        );
        if (opponent.rows[0]) {
          const opponentId = opponent.rows[0].player_id;
          await client.query(
            "DELETE FROM matchmaking WHERE player_id IN ($1, $2)",
            [opponentId, playerId],
          );
          const code = await makeCode(client);
          await createGame(client, opponentId, playerId, code, "active");
          return { code };
        }
        if (!ownQueue.rowCount) {
          await client.query(
            "INSERT INTO matchmaking (player_id, created_at) VALUES ($1, NOW()) ON CONFLICT (player_id) DO NOTHING",
            [playerId],
          );
        }
        return { status: "queued" };
      });
      if (match.game) return res.json(publicGame(match.game, playerId));
      if (match.code) return res.json(await roomPayload(match.code, playerId));
      return res.json({ ok: true, status: match.status });
    }

    if (action === "move") {
      const code = roomCode(data.code);
      const from = Number(data.from);
      const to = Number(data.to);
      const revision = Number(data.revision);
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        !Number.isInteger(revision) ||
        from < 0 ||
        from > 63 ||
        to < 0 ||
        to > 63 ||
        revision < 0
      ) {
        throw new ApiError(422, "Invalid move data.");
      }
      const gameId = await withTransaction(async (client) => {
        const result = await client.query(
          "SELECT * FROM games WHERE room_code = $1 FOR UPDATE",
          [code],
        );
        const row = result.rows[0];
        if (!row) throw new ApiError(404, "Room not found.");
        if (playerId !== row.light_player && playerId !== row.dark_player)
          throw new ApiError(403, "You are not a player in this room.");
        if (row.status !== "active")
          throw new ApiError(409, "This game is not active.");
        if (Number(row.revision) !== revision)
          throw new ApiError(
            409,
            "The board changed. Refreshing the game now.",
          );
        const state =
          typeof row.state_json === "string"
            ? JSON.parse(row.state_json)
            : row.state_json;
        const actorSide = playerId === row.light_player ? "light" : "dark";
        if (state.side !== actorSide)
          throw new ApiError(403, "It is the other player's turn.");
        const next = applyMove(state, from, to);
        const status = next.gameOver ? "finished" : "active";
        const winner =
          next.result?.type === "win"
            ? next.result.winner === "light"
              ? row.light_player
              : row.dark_player
            : null;
        await client.query(
          `UPDATE games SET state_json = $1::jsonb, revision = revision + 1, status = $2,
           winner_player = $3, updated_at = NOW() WHERE id = $4`,
          [JSON.stringify(next), status, winner, row.id],
        );
        if (status === "finished") await updateResultStats(client, next, row);
        return row.id;
      });
      const updated = await pool.query("SELECT * FROM games WHERE id = $1", [
        gameId,
      ]);
      return res.json(publicGame(updated.rows[0], playerId));
    }

    if (action === "leave") {
      await withTransaction(async (client) => {
        await client.query("DELETE FROM matchmaking WHERE player_id = $1", [
          playerId,
        ]);
        if (data.code) {
          const code = roomCode(data.code);
          const waiting = await client.query(
            "SELECT id FROM games WHERE room_code = $1 AND light_player = $2 AND status = 'waiting' FOR UPDATE",
            [code, playerId],
          );
          if (waiting.rows[0])
            await client.query("DELETE FROM games WHERE id = $1", [
              waiting.rows[0].id,
            ]);
        }
        const result = await client.query(
          `SELECT * FROM games WHERE (light_player = $1 OR dark_player = $1)
           AND status = 'active' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [playerId],
        );
        const row = result.rows[0];
        if (!row) return;
        const state =
          typeof row.state_json === "string"
            ? JSON.parse(row.state_json)
            : row.state_json;
        const winnerSide = playerId === row.light_player ? "dark" : "light";
        state.gameOver = true;
        state.result = {
          type: "win",
          winner: winnerSide,
          reason: "opponent-left",
        };
        const winnerId =
          winnerSide === "light" ? row.light_player : row.dark_player;
        await client.query(
          `UPDATE games SET state_json = $1::jsonb, status = 'finished', winner_player = $2,
           revision = revision + 1, updated_at = NOW() WHERE id = $3`,
          [JSON.stringify(state), winnerId, row.id],
        );
        await updateResultStats(client, state, row);
      });
      return res.json({ ok: true });
    }

    throw new ApiError(404, "Unknown API action.");
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 405) res.set("Allow", "GET, POST");
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    console.error("[Dama API]", error);
    return res
      .status(500)
      .json({
        ok: false,
        error:
          "The game service is temporarily unavailable. Check the server configuration and try again.",
      });
  }
}

app.all("/api.php", apiHandler);
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("*splat", (_req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "index.html")),
);

const schema = `
CREATE TABLE IF NOT EXISTS players (
  id VARCHAR(36) PRIMARY KEY,
  nickname VARCHAR(24) NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players (last_seen);
CREATE TABLE IF NOT EXISTS games (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  room_code CHAR(6) NOT NULL UNIQUE,
  status VARCHAR(10) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'finished')),
  light_player VARCHAR(36) NOT NULL REFERENCES players(id),
  dark_player VARCHAR(36) NULL REFERENCES players(id),
  light_name VARCHAR(24) NOT NULL,
  dark_name VARCHAR(24) NULL,
  state_json JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  winner_player VARCHAR(36) NULL REFERENCES players(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_players ON games (light_player, dark_player);
CREATE INDEX IF NOT EXISTS idx_game_status_updated ON games (status, updated_at);
CREATE TABLE IF NOT EXISTS matchmaking (
  player_id VARCHAR(36) PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matchmaking_created ON matchmaking (created_at);
`;

async function start() {
  if (DATABASE_URL) {
    await pool.query(schema);
    console.log("PostgreSQL schema is ready.");
  } else {
    console.warn(
      "DATABASE_URL is not set. Static/local play works; online features will return 503.",
    );
  }
  app.listen(PORT, "0.0.0.0", () =>
    console.log(`Filipino Dama listening on port ${PORT}`),
  );
}

start().catch((error) => {
  console.error("Could not start Filipino Dama:", error);
  process.exit(1);
});
