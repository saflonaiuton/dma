# Filipino Dama — Node/Render edition

This project uses the requested structure: `public/index.html` for the homepage, `index.js` for the Node/Express API and server, and `package.json` for dependencies and start scripts. The static assets are in `public/assets/`.

The online backend runs on Node.js and PostgreSQL. It supports private rooms, quick matchmaking, server-validated moves using the Filipino Dama rules, guest statistics, CSRF protection, and PostgreSQL-backed browser sessions. The schema is created automatically at server startup when `DATABASE_URL` is set.

## Project tree

```text
my-website/
├── public/
│   ├── index.html
│   └── assets/
│       ├── dama-hero.webp
│       ├── game.js
│       └── site.css
├── index.js
├── package.json
├── package-lock.json
├── .env.example
└── README.md
```

## Run locally

Use Node.js 20 or newer and a PostgreSQL database. Copy `.env.example` to `.env` if you use a local environment loader, or export its values in your shell. Never commit real credentials.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. Render supplies `PORT` automatically. When `DATABASE_URL` is not configured, the homepage and local game modes still load, while online play requires a database.

## Render setup

Follow [DEPLOY-RENDER.md](DEPLOY-RENDER.md). Create a Node Web Service from this repository with build command `npm ci` and start command `npm start`. Create a PostgreSQL database in the same region and set the web service's `DATABASE_URL` to its internal connection URL. Also set a persistent random `SESSION_SECRET`, `NODE_ENV=production`, and `APP_HTTPS_ONLY=1`.

## Free-plan note

Render Free web services spin down after 15 minutes without requests. Free Render Postgres is limited to 1 GB, has no backups, and expires after 30 days, so use it for testing rather than data you need to keep. Review the plan and costs shown in Render before selecting a paid service. [Render free-instance limits](https://render.com/docs/free)
