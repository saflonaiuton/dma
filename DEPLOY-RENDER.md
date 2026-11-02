# Deploy Filipino Dama to Render

This version uses Render's native Node.js Web Service. The site is served from `public/`, and `index.js` handles the API and PostgreSQL database. Render's Web Services accept Git-connected apps and forward HTTP traffic to the port in `PORT`; this server binds to `0.0.0.0` and uses that value. [Render Web Services](https://render.com/docs/web-services)

## 1. Upload the project to GitHub

Create a GitHub repository and upload the contents of this `my-website` folder to the repository root. Make sure `index.js`, `package.json`, `package-lock.json`, and `public/` are at the root level. Do not upload a `.env` file with real credentials; `.env.example` is only a template.

## 2. Create a PostgreSQL database

In Render, choose **New → PostgreSQL** and select a region. Use that same region for the web service. From the database's **Connect** menu, copy its **Internal Database URL**; Render recommends internal connections for services in the same region. [Create and connect to Render Postgres](https://render.com/docs/postgresql-creating-connecting)

Choose the database plan deliberately. Render's Free Postgres is limited to 1 GB, has no backups, and expires 30 days after creation. Use it for testing only if losing its data at expiration is acceptable. Review Render's displayed price before selecting a paid plan. [Render free-instance limits](https://render.com/docs/free)

## 3. Create the Node Web Service

Choose **New → Web Service**, connect the repository, and choose the branch. Use the repository root as the Root Directory, then set:

- **Runtime:** Node
- **Build command:** `npm ci`
- **Start command:** `npm start`
- **Health check path:** `/healthz`

Choose a region matching the PostgreSQL database and a compute plan. Render supports native Node services; the app listens on the `PORT` environment variable. [Render Web Services](https://render.com/docs/web-services)

## 4. Add environment variables

In the Web Service's **Environment** settings, add:

```text
DATABASE_URL = [the database's Internal Database URL]
SESSION_SECRET = [a long random secret]
NODE_ENV = production
APP_HTTPS_ONLY = 1
```

Generate a secret locally with `openssl rand -hex 48`. Keep the same `SESSION_SECRET` between deploys so signed browser cookies remain valid. The session records themselves are stored in PostgreSQL.

The app creates the player, game, matchmaking, and session tables as needed. No PHP, Dockerfile, or manual SQL import is required for this Node version.

## 5. Deploy and test

Click **Create Web Service** and wait for the first deploy. Open the Render URL and test **Single Player** and **Two Players**. To test online play, open two separate browser sessions, create a private room in one, and join its six-character code in the other. Quick matchmaking needs two players online at the same time.

## Free-plan behavior

Render Free web services spin down after 15 minutes without inbound requests and may take about a minute to wake. Free Render Postgres expires 30 days after creation and has no backups. For a game and online records you need to retain, select paid service/database plans after reviewing the costs in Render. [Render free-instance limits](https://render.com/docs/free)
