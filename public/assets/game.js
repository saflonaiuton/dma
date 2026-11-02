(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const boot = window.DAMA_BOOT || {};
  const LIGHT = "light";
  const DARK = "dark";
  const DIRS = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
  let csrf = boot.csrf || "";
  let bootstrapPromise = null;
  let mode = "local";
  let state = null;
  let selected = -1;
  let selectedMoves = [];
  let flipped = false;
  let humanSide = LIGHT;
  let aiLevel = "calm";
  let turnSnapshot = null;
  let undoStack = [];
  let onlineData = null;
  let onlineCode = "";
  let onlineTimer = null;
  let matchTimer = null;
  let matchmakingQueued = false;
  let privateRoomWaiting = false;
  let queueInFlight = false;
  let pollInFlight = false;
  let toastTimer = null;
  let countedResult = false;
  let moveSound = localStorage.getItem("dama-sound") !== "off";

  const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const index = (r, c) => r * 8 + c;
  const rowCol = (i) => [Math.floor(i / 8), i % 8];
  const forward = (side) => (side === LIGHT ? -1 : 1);
  const deepCopy = (value) => JSON.parse(JSON.stringify(value));
  const positionName = (i) => {
    const [r, c] = rowCol(i);
    return String.fromCharCode(65 + c) + (8 - r);
  };

  function initialState() {
    const board = Array(64).fill(null);
    let id = 1;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 8; c++)
        if ((r + c) % 2 === 1)
          board[index(r, c)] = { id: id++, side: DARK, king: false };
    for (let r = 5; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if ((r + c) % 2 === 1)
          board[index(r, c)] = { id: id++, side: LIGHT, king: false };
    return {
      board,
      side: LIGHT,
      chain: null,
      quietTurns: 0,
      history: [],
      gameOver: false,
      result: null,
    };
  }

  function promote(piece, pos) {
    const [r] = rowCol(pos);
    if (
      !piece.king &&
      ((piece.side === LIGHT && r === 0) || (piece.side === DARK && r === 7))
    )
      piece.king = true;
  }

  function captureMoves(board, pos, piece, taken = []) {
    const [r, c] = rowCol(pos);
    const out = [];
    if (!piece.king) {
      for (const [dr, dc] of DIRS) {
        const mr = r + dr,
          mc = c + dc,
          tr = r + 2 * dr,
          tc = c + 2 * dc;
        if (!inside(mr, mc) || !inside(tr, tc)) continue;
        const mid = index(mr, mc),
          to = index(tr, tc),
          enemy = board[mid];
        if (
          enemy &&
          enemy.side !== piece.side &&
          !taken.includes(mid) &&
          !board[to]
        )
          out.push({ from: pos, to, capture: mid });
      }
      return out;
    }
    for (const [dr, dc] of DIRS) {
      let rr = r + dr,
        cc = c + dc,
        enemyAt = -1;
      while (inside(rr, cc)) {
        const at = index(rr, cc),
          occupant = board[at];
        if (!occupant) {
          if (enemyAt >= 0) out.push({ from: pos, to: at, capture: enemyAt });
          rr += dr;
          cc += dc;
          continue;
        }
        if (enemyAt >= 0 || occupant.side === piece.side || taken.includes(at))
          break;
        enemyAt = at;
        rr += dr;
        cc += dc;
      }
    }
    return out;
  }

  function simulateCapture(board, move, piece, taken = []) {
    const next = board.map((p) => (p ? { ...p } : null));
    next[move.from] = null;
    const moved = { ...piece };
    promote(moved, move.to);
    next[move.to] = moved;
    return { board: next, piece: moved, taken: [...taken, move.capture] };
  }

  function maxFurther(board, pos, piece, taken, memo) {
    const key =
      board
        .map((p) =>
          p
            ? p.side === LIGHT
              ? p.king
                ? "L"
                : "l"
              : p.king
                ? "D"
                : "d"
            : ".",
        )
        .join("") +
      "|" +
      pos +
      "|" +
      (piece.king ? "K" : "M") +
      "|" +
      [...taken].sort((a, b) => a - b).join(",");
    if (memo.has(key)) return memo.get(key);
    let best = 0;
    for (const move of captureMoves(board, pos, piece, taken)) {
      const sim = simulateCapture(board, move, piece, taken);
      best = Math.max(
        best,
        1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo),
      );
    }
    memo.set(key, best);
    return best;
  }

  function maximumForSide(game) {
    let best = 0;
    const memo = new Map();
    game.board.forEach((piece, pos) => {
      if (!piece || piece.side !== game.side) return;
      for (const move of captureMoves(game.board, pos, piece, [])) {
        const sim = simulateCapture(game.board, move, piece, []);
        best = Math.max(
          best,
          1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo),
        );
      }
    });
    return best;
  }

  function quietMoves(game, pos, piece) {
    const [r, c] = rowCol(pos),
      out = [];
    if (piece.king) {
      for (const [dr, dc] of DIRS) {
        let rr = r + dr,
          cc = c + dc;
        while (inside(rr, cc) && !game.board[index(rr, cc)]) {
          out.push({ from: pos, to: index(rr, cc), capture: null });
          rr += dr;
          cc += dc;
        }
      }
    } else {
      const dr = forward(piece.side);
      for (const dc of [-1, 1]) {
        const rr = r + dr,
          cc = c + dc;
        if (inside(rr, cc) && !game.board[index(rr, cc)])
          out.push({ from: pos, to: index(rr, cc), capture: null });
      }
    }
    return out;
  }

  function legalMoves(game) {
    if (!game || game.gameOver) return [];
    const board = game.board;
    if (game.chain) {
      const pos = game.chain.pos,
        piece = board[pos],
        memo = new Map(),
        out = [];
      for (const move of captureMoves(board, pos, piece, game.chain.taken)) {
        const sim = simulateCapture(board, move, piece, game.chain.taken);
        if (
          1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo) ===
          game.chain.remaining
        )
          out.push(move);
      }
      return out;
    }
    const best = maximumForSide(game);
    if (best > 0) {
      const out = [],
        memo = new Map();
      board.forEach((piece, pos) => {
        if (!piece || piece.side !== game.side) return;
        for (const move of captureMoves(board, pos, piece, [])) {
          const sim = simulateCapture(board, move, piece, []);
          if (
            1 + maxFurther(sim.board, move.to, sim.piece, sim.taken, memo) ===
            best
          )
            out.push(move);
        }
      });
      return out;
    }
    const out = [];
    board.forEach((piece, pos) => {
      if (piece && piece.side === game.side)
        out.push(...quietMoves(game, pos, piece));
    });
    return out;
  }

  function finishLocalTurn(captureCount, taken, path, manAdvanced) {
    for (const at of taken) state.board[at] = null;
    state.quietTurns =
      captureCount > 0 || manAdvanced ? 0 : state.quietTurns + 1;
    state.history.push({
      side: state.side,
      path: deepCopy(path),
      captures: captureCount,
    });
    if (state.history.length > 80) state.history.shift();
    const mover = state.side;
    state.side = mover === LIGHT ? DARK : LIGHT;
    state.chain = null;
    let light = 0,
      dark = 0;
    for (const piece of state.board)
      if (piece) {
        if (piece.side === LIGHT) light++;
        else dark++;
      }
    if (!light || !dark)
      state.result = {
        type: "win",
        winner: light ? LIGHT : DARK,
        reason: "all-pieces-captured",
      };
    else if (legalMoves(state).length === 0)
      state.result = {
        type: "win",
        winner: mover,
        reason: "opponent-has-no-legal-move",
      };
    else if (state.quietTurns >= 40)
      state.result = { type: "draw", winner: null, reason: "40-quiet-turns" };
    state.gameOver = !!state.result;
    if (turnSnapshot) {
      undoStack.push(turnSnapshot);
      turnSnapshot = null;
    }
    selected = -1;
    selectedMoves = [];
    if (state.gameOver) recordLocalResult();
    renderLocal();
    if (mode === "ai" && !state.gameOver && state.side !== humanSide)
      setTimeout(aiTurn, 540);
  }

  function applyLocalMove(move) {
    if (!turnSnapshot) turnSnapshot = deepCopy(state);
    const piece = state.board[move.from];
    const [fr] = rowCol(move.from),
      [tr] = rowCol(move.to);
    const wasKing = piece.king;
    const advanced = !wasKing && tr - fr === forward(piece.side);
    const previous = state.chain;
    const targetRemaining = previous
      ? previous.remaining
      : maximumForSide(state);
    const taken = previous ? [...previous.taken] : [];
    const path = previous ? deepCopy(previous.path) : [];
    const count = previous ? previous.count : 0;
    const manAdvanced = (previous ? previous.manAdvanced : false) || advanced;
    state.board[move.from] = null;
    const moved = { ...piece };
    promote(moved, move.to);
    state.board[move.to] = moved;
    path.push({
      from: move.from,
      to: move.to,
      capture: move.capture,
      promoted: !wasKing && moved.king,
    });
    if (move.capture !== null) {
      taken.push(move.capture);
      const newCount = count + 1,
        remaining = targetRemaining - 1;
      if (remaining > 0) {
        state.chain = {
          pos: move.to,
          taken,
          remaining,
          path,
          count: newCount,
          manAdvanced,
        };
        selected = move.to;
        selectedMoves = legalMoves(state);
        playClickSound(true);
        renderLocal();
        return;
      }
      playClickSound(true);
      finishLocalTurn(newCount, taken, path, manAdvanced);
      return;
    }
    playClickSound(false);
    finishLocalTurn(0, [], path, manAdvanced);
  }

  function beginLocalGame(nextMode = "local", side = LIGHT, level = "calm") {
    mode = nextMode;
    humanSide = side;
    aiLevel = level;
    state = initialState();
    selected = -1;
    selectedMoves = [];
    turnSnapshot = null;
    undoStack = [];
    countedResult = false;
    flipped = nextMode === "ai" && side === DARK;
    $("homeScreen").hidden = true;
    $("gameScreen").hidden = false;
    $("roomChip").hidden = true;
    $("onlineStatusPanel").hidden = true;
    $("leaveButton").hidden = true;
    $("undoButton").hidden = false;
    $("undoButton").disabled = true;
    $("lightName").textContent =
      nextMode === "ai" && side === LIGHT
        ? "YOU"
        : nextMode === "ai"
          ? "COMPUTER"
          : "LIGHT";
    $("darkName").textContent =
      nextMode === "ai" && side === DARK
        ? "YOU"
        : nextMode === "ai"
          ? "COMPUTER"
          : "DARK";
    $("statusText").textContent =
      nextMode === "ai" ? "FRIENDLY GAME" : "LOCAL TABLE";
    renderLocal();
    if (nextMode === "ai" && state.side !== humanSide) setTimeout(aiTurn, 650);
  }

  function aiTurn() {
    if (mode !== "ai" || !state || state.gameOver || state.side === humanSide)
      return;
    let options;
    if (state.chain) options = legalMoves(state);
    else options = legalMoves(state);
    if (!options.length) return;
    const scored = options
      .map((move) => {
        const piece = state.board[move.from];
        let score = Math.random() * (aiLevel === "sharp" ? 1.5 : 4);
        const [r, c] = rowCol(move.to);
        score += (3.5 - Math.abs(3.5 - c)) * 0.18;
        if (
          !piece.king &&
          ((piece.side === LIGHT && r === 0) ||
            (piece.side === DARK && r === 7))
        )
          score += 5;
        if (move.capture !== null) score += aiLevel === "sharp" ? 5 : 2;
        return { move, score };
      })
      .sort((a, b) => b.score - a.score);
    const pick =
      aiLevel === "sharp"
        ? scored[0].move
        : scored[Math.floor(Math.random() * Math.min(3, scored.length))].move;
    applyLocalMove(pick);
  }

  function updateCounts(game) {
    const counts = { light: 0, dark: 0 };
    for (const p of game.board) if (p) counts[p.side]++;
    $("lightCount").textContent = counts.light;
    $("darkCount").textContent = counts.dark;
    $("lightCaptured").innerHTML = Array.from(
      { length: Math.max(0, 12 - counts.light) },
      () => '<i class="cap-light"></i>',
    ).join("");
    $("darkCaptured").innerHTML = Array.from(
      { length: Math.max(0, 12 - counts.dark) },
      () => '<i class="cap-dark"></i>',
    ).join("");
    $("quietCount").textContent = `${game.quietTurns || 0} / 40`;
    $("quietFill").style.width =
      `${Math.min(100, (game.quietTurns || 0) * 2.5)}%`;
    $("turnNumber").textContent = String(
      (game.history || []).length + 1,
    ).padStart(2, "0");
    $("historyCount").textContent = String(
      (game.history || []).length,
    ).padStart(2, "0");
  }

  function renderBoard(game, moves, canMove) {
    const target = $("gameBoard");
    const destinations = new Map();
    for (const move of moves || [])
      destinations.set(
        Number(move.to),
        move.capture !== null && move.capture !== undefined,
      );
    target.innerHTML = "";
    const order = Array.from({ length: 64 }, (_, i) => i);
    if (flipped) order.reverse();
    for (const pos of order) {
      const [r, c] = rowCol(pos),
        cell = document.createElement("button");
      cell.type = "button";
      cell.className = "sq " + ((r + c) % 2 ? "dark" : "light");
      cell.dataset.pos = String(pos);
      cell.setAttribute("role", "gridcell");
      const piece = game.board[pos];
      cell.setAttribute(
        "aria-label",
        `${positionName(pos)}${piece ? `, ${piece.side} ${piece.king ? "dama" : "man"}` : ""}${destinations.has(pos) ? ", legal destination" : ""}`,
      );
      if ((r + c) % 2 === 0) cell.disabled = true;
      if (pos === selected || (game.chain && pos === game.chain.pos))
        cell.classList.add("selected");
      if (destinations.has(pos))
        cell.classList.add(destinations.get(pos) ? "capture-target" : "legal");
      if (
        game.lastMove &&
        (pos === game.lastMove.from || pos === game.lastMove.to)
      )
        cell.classList.add("last");
      if ((r + c) % 2 === 1) {
        const rank = document.createElement("span");
        rank.className = "coord rank";
        rank.textContent = String(8 - r);
        cell.appendChild(rank);
        const file = document.createElement("span");
        file.className = "coord file";
        file.textContent = String.fromCharCode(97 + c);
        cell.appendChild(file);
      }
      if (piece) {
        const man = document.createElement("span");
        man.className =
          "piece " + (piece.side === LIGHT ? "light-piece" : "dark-piece");
        if (piece.king) {
          const crown = document.createElement("span");
          crown.className = "crown";
          crown.textContent = "♛";
          man.appendChild(crown);
        }
        cell.appendChild(man);
      }
      cell.addEventListener("click", () => handleBoardClick(pos, canMove));
      target.appendChild(cell);
    }
  }

  function renderHistory(items) {
    const target = $("moveHistory");
    if (!items || !items.length) {
      target.innerHTML = '<p class="muted-copy">The first move is yours.</p>';
      return;
    }
    target.innerHTML = items
      .slice(-12)
      .reverse()
      .map((turn, j) => {
        const notation = (turn.path || [])
          .map(
            (s) =>
              `${positionName(Number(s.from))}${s.capture !== null && s.capture !== undefined ? "×" : "–"}${positionName(Number(s.to))}${s.promoted ? " ♛" : ""}`,
          )
          .join(" ");
        return `<div class="move-row"><small>${items.length - j}.</small><b>${escapeHtml(notation)}</b><small>${turn.side === LIGHT ? "LIGHT" : "DARK"}${turn.captures ? ` · ×${turn.captures}` : ""}</small></div>`;
      })
      .join("");
  }

  function renderLocal() {
    if (!state) return;
    const moves = legalMoves(state);
    renderBoard(state, selected >= 0 ? selectedMoves : [], true);
    updateCounts(state);
    renderHistory(state.history);
    $("turnTitle").textContent = state.gameOver
      ? "GAME OVER"
      : `${state.side === LIGHT ? "LIGHT" : "DARK"} TO MOVE`;
    $("turnSubtitle").textContent = state.chain
      ? `Capture chain · ${state.chain.count} taken`
      : selected >= 0
        ? "Choose a highlighted square"
        : mode === "ai"
          ? state.side === humanSide
            ? "Your move"
            : "Computer thinking…"
          : "Choose a piece";
    const mandatory = moves.some((m) => m.capture !== null);
    $("statusText").textContent = state.gameOver
      ? resultLabel(state.result)
      : state.chain
        ? `CHAIN · ${state.chain.remaining} LEFT`
        : mandatory
          ? `FORCED CAPTURE · ${maximumForSide(state)} MAX`
          : mode === "ai"
            ? "FRIENDLY GAME"
            : "LOCAL TABLE";
    $("turnBadge")
      .querySelector(".player-token")
      .classList.toggle("dark", state.side === DARK);
    $("undoButton").disabled =
      state.gameOver || (!turnSnapshot && undoStack.length === 0);
    if (mode === "ai" && state.side !== humanSide && !state.gameOver)
      setTimeout(() => {
        if (mode === "ai" && state.side !== humanSide) aiTurn();
      }, 150);
  }

  function handleBoardClick(pos, canMove) {
    if (mode === "online") {
      handleOnlineBoardClick(pos);
      return;
    }
    if (!state || state.gameOver) return;
    if (mode === "ai" && state.side !== humanSide) return;
    if (selected >= 0) {
      const move = selectedMoves.find((m) => Number(m.to) === pos);
      if (move) {
        applyLocalMove(move);
        return;
      }
    }
    const piece = state.board[pos];
    if (piece && piece.side === state.side && canMove) {
      selected = pos;
      selectedMoves = legalMoves(state).filter((m) => Number(m.from) === pos);
      renderLocal();
      return;
    }
    if (state.chain) {
      toast("Continue the capture chain with the same piece.");
      return;
    }
    selected = -1;
    selectedMoves = [];
    renderLocal();
  }

  function undoLocal() {
    if (mode === "online" || !state || state.gameOver) return;
    if (state.chain && turnSnapshot) {
      state = deepCopy(turnSnapshot);
      turnSnapshot = null;
      selected = -1;
      selectedMoves = [];
      renderLocal();
      toast("Capture turn undone.");
      return;
    }
    const previous = undoStack.pop();
    if (previous) {
      state = deepCopy(previous);
      turnSnapshot = null;
      selected = -1;
      selectedMoves = [];
      renderLocal();
      toast("Last turn undone.");
    }
  }

  function recordLocalResult() {
    if (countedResult || !state.result) return;
    countedResult = true;
    const key = "dama-local-record";
    let record = { wins: 0, losses: 0, draws: 0 };
    try {
      record = { ...record, ...JSON.parse(localStorage.getItem(key) || "{}") };
    } catch (_e) {}
    if (state.result.type === "draw") record.draws++;
    else if (state.result.winner === humanSide) record.wins++;
    else record.losses++;
    localStorage.setItem(key, JSON.stringify(record));
  }

  function resultLabel(result) {
    if (!result) return "GAME OVER";
    if (result.type === "draw") return "TABLA · DRAW";
    const winner = result.winner === LIGHT ? "LIGHT" : "DARK";
    return `${winner} WINS · ${String(result.reason || "")
      .replaceAll("-", " ")
      .toUpperCase()}`;
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }
  function showModal(id) {
    const el = $(id);
    if (el) {
      el.hidden = false;
      document.body.style.overflow = "hidden";
    }
  }
  function closeModal(el) {
    if (el?.id === "onlineModal" && matchmakingQueued) {
      clearInterval(matchTimer);
      matchmakingQueued = false;
      api("leave", "POST", {}).catch(() => {});
    }
    if (el?.id === "onlineModal" && privateRoomWaiting) {
      clearInterval(onlineTimer);
      privateRoomWaiting = false;
      const code = onlineCode;
      onlineCode = "";
      api("leave", "POST", { code }).catch(() => {});
    }
    if (el) el.hidden = true;
    if (!document.querySelector(".modal-backdrop:not([hidden])"))
      document.body.style.overflow = "";
  }
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2300);
  }
  function playClickSound(capture) {
    if (!moveSound) return;
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      const ctx = new Audio();
      const oscillator = ctx.createOscillator(),
        gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = capture ? 210 : 330;
      gain.gain.setValueAtTime(0.025, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.09);
      oscillator.onended = () => ctx.close();
    } catch (_e) {}
  }

  async function ensureBootstrap() {
    if (csrf) return;
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        const response = await fetch("/api.php?action=bootstrap", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        const data = await response.json();
        if (!response.ok || data.ok === false || !data.csrf)
          throw new Error(data.error || "Online service is unavailable.");
        csrf = data.csrf;
        boot.nickname = data.nickname || boot.nickname || "Guest";
        const requestedRoom = new URLSearchParams(window.location.search).get(
          "room",
        );
        boot.room = /^[A-Z0-9]{6}$/i.test(requestedRoom || "")
          ? requestedRoom.toUpperCase()
          : null;
        if (boot.room) $("joinCode").value = boot.room;
      })().catch((error) => {
        bootstrapPromise = null;
        throw error;
      });
    }
    return bootstrapPromise;
  }

  async function api(action, method = "GET", body = null) {
    if (method === "POST") await ensureBootstrap();
    const url = `/api.php?action=${encodeURIComponent(action)}`;
    const options = {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    };
    if (method === "POST") {
      options.headers["Content-Type"] = "application/json";
      options.headers["X-CSRF-Token"] = csrf;
      options.body = JSON.stringify(body || {});
    }
    const response = await fetch(url, options);
    let data;
    try {
      data = await response.json();
    } catch (_e) {
      throw new Error("The server returned an unreadable response.");
    }
    if (!response.ok || data.ok === false)
      throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function openOnline() {
    $("nicknameInput").value =
      boot.nickname || localStorage.getItem("dama-name") || "Guest";
    $("lobbyMessage").textContent = "";
    $("inviteBlock").hidden = true;
    showModal("onlineModal");
    if (boot.room) $("joinCode").value = boot.room;
  }

  async function saveNickname() {
    const nickname = $("nicknameInput").value.trim();
    if (!nickname) {
      toast("Choose a table name first.");
      return;
    }
    try {
      const result = await api("set_name", "POST", { nickname });
      boot.nickname = result.nickname;
      localStorage.setItem("dama-name", result.nickname);
      toast(`Playing as ${result.nickname}.`);
    } catch (error) {
      toast(error.message);
    }
  }

  async function quickMatch() {
    if (queueInFlight) return;
    queueInFlight = true;
    $("lobbyMessage").textContent = "Looking for an opponent…";
    try {
      await saveNickname();
      const result = await api("quick_match", "POST", {});
      if (result.status === "queued") {
        matchmakingQueued = true;
        $("lobbyMessage").textContent =
          "You’re in the queue. Keep this window open — we’ll seat you when a player arrives.";
        startMatchPolling();
      } else if (result.code) await enterOnlineGame(result);
    } catch (error) {
      $("lobbyMessage").textContent = error.message;
    } finally {
      queueInFlight = false;
    }
  }

  function startMatchPolling() {
    clearInterval(matchTimer);
    matchTimer = setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const result = await api("quick_match", "POST", {});
        if (
          result.status === "active" ||
          result.status === "finished" ||
          result.code
        ) {
          matchmakingQueued = false;
          clearInterval(matchTimer);
          await enterOnlineGame(result);
        } else if (result.status === "idle") {
          $("lobbyMessage").textContent =
            "The queue timed out. Try again when you’re ready.";
          matchmakingQueued = false;
          clearInterval(matchTimer);
        }
      } catch (error) {
        $("lobbyMessage").textContent = error.message;
        matchmakingQueued = false;
        clearInterval(matchTimer);
      } finally {
        pollInFlight = false;
      }
    }, 1800);
  }

  async function createRoom() {
    clearInterval(matchTimer);
    matchmakingQueued = false;
    $("lobbyMessage").textContent = "Setting the table…";
    try {
      await saveNickname();
      const result = await api("create_room", "POST", {});
      onlineCode = result.code;
      privateRoomWaiting = true;
      $("inviteCode").textContent = onlineCode;
      $("inviteBlock").hidden = false;
      $("lobbyMessage").textContent =
        "Private table ready. Send your code to a friend; the game starts when they join.";
      startRoomPolling();
    } catch (error) {
      $("lobbyMessage").textContent = error.message;
    }
  }

  async function joinRoom(event) {
    clearInterval(matchTimer);
    matchmakingQueued = false;
    event.preventDefault();
    const code = $("joinCode").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      $("lobbyMessage").textContent = "Enter a six-character room code.";
      return;
    }
    $("lobbyMessage").textContent = "Joining the table…";
    try {
      await saveNickname();
      const result = await api("join_room", "POST", { code });
      privateRoomWaiting = false;
      onlineCode = result.code;
      await enterOnlineGame(result);
    } catch (error) {
      $("lobbyMessage").textContent = error.message;
    }
  }

  function startRoomPolling() {
    clearInterval(onlineTimer);
    onlineTimer = setInterval(async () => {
      if (!onlineCode || pollInFlight) return;
      pollInFlight = true;
      try {
        const result = await api(`room&code=${encodeURIComponent(onlineCode)}`);
        if (result.status === "active" || result.status === "finished") {
          clearInterval(onlineTimer);
          await enterOnlineGame(result);
        } else {
          $("lobbyMessage").textContent = "Waiting for a friend to join…";
        }
      } catch (error) {
        $("lobbyMessage").textContent = error.message;
        clearInterval(onlineTimer);
      } finally {
        pollInFlight = false;
      }
    }, 1800);
  }

  async function enterOnlineGame(data) {
    if (!data.code) {
      toast("The room was not found.");
      return;
    }
    matchmakingQueued = false;
    privateRoomWaiting = false;
    clearInterval(matchTimer);
    clearInterval(onlineTimer);
    onlineCode = data.code;
    onlineData = data;
    mode = "online";
    state = null;
    selected = -1;
    selectedMoves = [];
    flipped = data.viewerSide === DARK;
    $("homeScreen").hidden = true;
    $("gameScreen").hidden = false;
    closeModal($("onlineModal"));
    $("roomChip").hidden = false;
    $("roomCodeLabel").textContent = onlineCode;
    $("onlineStatusPanel").hidden = false;
    $("leaveButton").hidden = false;
    $("undoButton").hidden = true;
    $("lightName").textContent = (data.lightName || "LIGHT").toUpperCase();
    $("darkName").textContent = (data.darkName || "DARK").toUpperCase();
    updateOnlineView(data);
    clearInterval(onlineTimer);
    onlineTimer = setInterval(pollRoom, 1700);
  }

  async function pollRoom() {
    if (!onlineCode || pollInFlight) return;
    pollInFlight = true;
    try {
      const data = await api(`room&code=${encodeURIComponent(onlineCode)}`);
      updateOnlineView(data);
    } catch (error) {
      $("connectionStatus").textContent = "Reconnecting…";
      if (error.message.includes("Room not found")) toast(error.message);
    } finally {
      pollInFlight = false;
    }
  }

  function updateOnlineView(data) {
    onlineData = data;
    $("roomCodeLabel").textContent = data.code || onlineCode;
    $("lightName").textContent = (data.lightName || "LIGHT").toUpperCase();
    $("darkName").textContent = (data.darkName || "DARK").toUpperCase();
    if (data.status === "waiting") {
      $("onlinePanelTitle").textContent = "Waiting for opponent";
      $("onlinePanelText").textContent =
        `Share room ${data.code} with a friend. The first move begins when they join.`;
      $("connectionStatus").textContent = "Table is open";
      $("turnTitle").textContent = "WAITING FOR PLAYER";
      $("turnSubtitle").textContent = `Room ${data.code} · Light will open`;
      $("statusText").textContent = "PRIVATE TABLE";
    } else {
      $("onlinePanelTitle").textContent =
        data.status === "finished" ? "Game complete" : "Online match";
      $("onlinePanelText").textContent =
        data.status === "finished"
          ? resultLabel(data.state.result)
          : "Moves sync automatically with your opponent.";
      $("connectionStatus").textContent = "Connected · live updates";
      if (data.state) {
        renderOnline(data);
      }
    }
  }

  function renderOnline(data) {
    const game = data.state,
      moves = data.legal || [];
    const canMove = data.viewerSide === game.side && data.status === "active";
    const visibleMoves = selected >= 0 ? selectedMoves : [];
    renderBoard(game, visibleMoves, canMove);
    updateCounts(game);
    renderHistory(game.history || []);
    $("turnTitle").textContent = game.gameOver
      ? "GAME OVER"
      : `${game.side === LIGHT ? "LIGHT" : "DARK"} TO MOVE`;
    $("turnSubtitle").textContent = game.gameOver
      ? resultLabel(game.result)
      : game.side === data.viewerSide
        ? "Your move"
        : `${game.side === LIGHT ? data.lightName : data.darkName} is thinking…`;
    $("turnBadge")
      .querySelector(".player-token")
      .classList.toggle("dark", game.side === DARK);
    const mandatory = moves.some(
      (m) => m.capture !== null && m.capture !== undefined,
    );
    $("statusText").textContent = game.gameOver
      ? resultLabel(game.result)
      : mandatory
        ? "FORCED CAPTURE"
        : game.side === data.viewerSide
          ? "YOUR TURN"
          : "OPPONENT’S TURN";
    $("onlinePanelTitle").textContent = game.gameOver
      ? "Game complete"
      : "Online match";
    $("onlinePanelText").textContent = game.gameOver
      ? resultLabel(game.result)
      : `Playing ${data.viewerSide === LIGHT ? "Light" : "Dark"} · room ${data.code}`;
    $("connectionStatus").textContent = "Connected · live updates";
    selectedMoves =
      selected >= 0 ? moves.filter((m) => Number(m.from) === selected) : [];
  }

  async function handleOnlineBoardClick(pos) {
    if (
      !onlineData ||
      onlineData.status !== "active" ||
      onlineData.viewerSide !== onlineData.state.side
    )
      return;
    const move = selectedMoves.find((m) => Number(m.to) === pos);
    if (move) {
      try {
        const result = await api("move", "POST", {
          code: onlineCode,
          from: Number(move.from),
          to: Number(move.to),
          revision: Number(onlineData.revision),
        });
        selected = -1;
        selectedMoves = [];
        updateOnlineView(result);
        playClickSound(move.capture !== null && move.capture !== undefined);
      } catch (error) {
        selected = -1;
        selectedMoves = [];
        toast(error.message);
        await pollRoom();
      }
      return;
    }
    const piece = onlineData.state.board[pos];
    if (piece && piece.side === onlineData.viewerSide) {
      selected = pos;
      selectedMoves = (onlineData.legal || []).filter(
        (m) => Number(m.from) === pos,
      );
      renderOnline(onlineData);
      return;
    }
    selected = -1;
    selectedMoves = [];
    renderOnline(onlineData);
  }

  async function copyRoomLink() {
    if (!onlineCode) return;
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("room", onlineCode);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast("Invite link copied.");
    } catch (_e) {
      toast(`Share room code ${onlineCode} with your friend.`);
    }
  }

  async function leaveGame() {
    if (mode === "online") {
      const finished = onlineData?.status === "finished";
      if (
        !window.confirm(
          finished
            ? "Return to the main menu?"
            : "Leave this online game? Leaving an active match counts as a forfeit.",
        )
      )
        return;
      try {
        await api("leave", "POST", { code: onlineCode });
      } catch (_e) {}
      clearInterval(onlineTimer);
      clearInterval(matchTimer);
      onlineData = null;
      onlineCode = "";
      matchmakingQueued = false;
      privateRoomWaiting = false;
    }
    $("gameScreen").hidden = true;
    $("homeScreen").hidden = false;
    mode = "local";
    selected = -1;
    selectedMoves = [];
    closeModal($("onlineModal"));
  }

  async function loadStats() {
    const local = { wins: 0, losses: 0, draws: 0 };
    try {
      Object.assign(
        local,
        JSON.parse(localStorage.getItem("dama-local-record") || "{}"),
      );
    } catch (_e) {}
    $("localRecord").textContent =
      `${local.wins} wins · ${local.losses} losses · ${local.draws} draws`;
    $("statsMessage").textContent = "";
    try {
      const response = await api("stats");
      const s = response.stats || {};
      const games = Number(s.games_played || 0),
        wins = Number(s.wins || 0),
        draws = Number(s.draws || 0);
      $("statGames").textContent = games;
      $("statWins").textContent = wins;
      $("statDraws").textContent = draws;
      $("statWinRate").textContent = games
        ? `${Math.round((wins / games) * 100)}%`
        : "—";
      $("statsSubtitle").textContent =
        `${s.nickname || boot.nickname || "Guest"} · online guest record`;
    } catch (error) {
      $("statsMessage").textContent =
        "Online record appears after the database is connected. Your local practice record is saved on this device.";
      $("statGames").textContent = "—";
      $("statWins").textContent = "—";
      $("statDraws").textContent = "—";
      $("statWinRate").textContent = "—";
    }
  }

  function showHome() {
    if (mode === "online") {
      leaveGame();
      return;
    }
    $("gameScreen").hidden = true;
    $("homeScreen").hidden = false;
    mode = "local";
  }

  document.querySelectorAll("[data-open]").forEach((button) =>
    button.addEventListener("click", () => {
      const id = button.dataset.open;
      if (id === "onlineModal") openOnline();
      else if (id === "statsModal") {
        showModal(id);
        loadStats();
      } else showModal(id);
    }),
  );
  document
    .querySelectorAll("[data-close]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        closeModal(button.closest(".modal-backdrop")),
      ),
    );
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) =>
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal(backdrop);
    }),
  );
  document
    .querySelector('[data-action="two-player"]')
    .addEventListener("click", () => beginLocalGame("local", LIGHT));
  $("startSingle").addEventListener("click", () => {
    closeModal($("singleModal"));
    beginLocalGame("ai", $("humanSide").value, $("aiLevel").value);
  });
  $("backHome").addEventListener("click", showHome);
  $("undoButton").addEventListener("click", undoLocal);
  $("flipButton").addEventListener("click", () => {
    flipped = !flipped;
    if (mode === "online" && onlineData) renderOnline(onlineData);
    else renderLocal();
  });
  $("leaveButton").addEventListener("click", leaveGame);
  $("quickMatch").addEventListener("click", quickMatch);
  $("createRoom").addEventListener("click", createRoom);
  $("joinRoomForm").addEventListener("submit", joinRoom);
  $("saveName").addEventListener("click", saveNickname);
  $("copyRoom").addEventListener("click", copyRoomLink);
  $("copyInvite").addEventListener("click", copyRoomLink);
  $("soundSetting").checked = moveSound;
  $("soundSetting").addEventListener("change", (event) => {
    moveSound = event.target.checked;
    localStorage.setItem("dama-sound", moveSound ? "on" : "off");
  });
  $("motionSetting").checked =
    localStorage.getItem("dama-motion") === "reduced";
  if ($("motionSetting").checked) document.body.classList.add("reduced-motion");
  $("motionSetting").addEventListener("change", (event) => {
    document.body.classList.toggle("reduced-motion", event.target.checked);
    localStorage.setItem(
      "dama-motion",
      event.target.checked ? "reduced" : "full",
    );
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      document
        .querySelectorAll(".modal-backdrop:not([hidden])")
        .forEach(closeModal);
    if (event.key.toLowerCase() === "u") undoLocal();
  });

  // Render a minimal local board only after the player chooses a game mode.
  // Board generation uses the same geometry/rules as the server-validated online client.
  const requestedRoom = new URLSearchParams(window.location.search).get("room");
  boot.room = /^[A-Z0-9]{6}$/i.test(requestedRoom || "")
    ? requestedRoom.toUpperCase()
    : null;
  if (boot.room) $("joinCode").value = boot.room;
  ensureBootstrap().catch(() => {});
})();
