# Backend (Express) — Deploy & Local Run

This folder contains the Express backend for Vasuki Pickles. It supports PostgreSQL (Neon) via `DATABASE_URL` and falls back to local JSON files when `DATABASE_URL` is not set.

## Local development

- Install dependencies in repo root:

```bash
npm install
```

- Start backend only:

```bash
npm start
# or
node backend/server.js
```

- Health: `GET /health` should return `{"status":"ok"}`.

## Environment variables

- `DATABASE_URL` — Neon Postgres connection string (DO NOT COMMIT, add to Render as a secret).
- `JWT_SECRET` — required stable signing secret in production and Vercel/serverless deployments (add as a secret; never commit it).
- `PORT` — optional; default is `3001`.

## Deploy to Render (recommended)

1. In Render dashboard create a new **Web Service** and connect to this GitHub repo.
2. Branch: `main`.
3. Build Command: `npm install`.
4. Start Command: `npm start`.
5. Add Environment Variables in Render settings:
   - `DATABASE_URL` = your Neon Postgres connection string.
6. Choose Node runtime (18+).
7. Deploy and monitor logs. You should see `Connected to PostgreSQL via DATABASE_URL`.

## Render frontend

- Keep frontend on Vercel or any hosted frontend. Update the frontend API base URL to your deployed backend (e.g., `https://ruchira-backend-kv3q.onrender.com`). Ensure CORS allows your frontend domain (the server uses `cors()` by default).

## Smoke test (optional)

- Run the smoke test script to create a product, order, and review against the running backend:

```bash
node backend/test-smoke.js
```
