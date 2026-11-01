# Self-hosting the OSSS server

The server is a small Node.js app that stores everything in a single SQLite file. It has no runtime dependencies.

## 1. Run it

### Option A: Docker (recommended)

You need [Docker](https://docs.docker.com/get-docker/).

```bash
cd server
cp .env.example .env
docker compose run --rm osss node scripts/gen-key.ts
```

That prints a new API key. Paste it into `.env` as `OSSS_API_KEYS=...`, then start the server:

```bash
docker compose up -d
```

The data lives in the `osss-data` Docker volume, so it survives restarts and updates.

### Option B: Node.js

You need [Node.js](https://nodejs.org/) 22.18 or newer.

```bash
cd server
cp .env.example .env
npm run gen-key
```

Paste the key into `.env` as `OSSS_API_KEYS=...`, then:

```bash
npm start
```

Check it's running by opening <http://localhost:8787/health>. You should see `{"ok":true}`.

## 2. Let Roblox reach it

Roblox game servers run in Roblox's data centers, so they **can't** reach `localhost` or anything on your home network. You need a public HTTPS address. Pick one:

| Option | Good for | Notes |
| --- | --- | --- |
| **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)** | Hosting from your own PC | Free, gives you HTTPS, no port forwarding. Point the tunnel at `http://localhost:8787`. |
| **A VPS** (Hetzner, DigitalOcean, etc.) | Live games | Put a reverse proxy like [Caddy](https://caddyserver.com/) in front of it for automatic HTTPS. |
| **Port forwarding** | Testing only | You'd still need HTTPS on top. Not recommended. |

Whichever you pick, **use HTTPS**. Your API key is sent with every request.

## 3. Settings

All settings are environment variables. Put them in `server/.env`.

| Variable | Default | What it does |
| --- | --- | --- |
| `OSSS_API_KEYS` | *(required)* | One or more API keys, separated by commas. Each must be at least 32 characters. |
| `OSSS_HOST` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` if only a tunnel or proxy on the same machine should connect. |
| `OSSS_PORT` | `8787` | Port to listen on. |
| `OSSS_DB_PATH` | `data/osss.db` | Where the database file is stored. |
| `OSSS_MAX_BODY_BYTES` | `16777216` (16 MB) | Largest request the server accepts. |

Using several keys lets you rotate them: add the new key, update your game, then remove the old one.

## 4. Backups

Everything is in the SQLite file at `OSSS_DB_PATH`. The safest way to back it up while the server runs is with the [`sqlite3`](https://sqlite.org/cli.html) tool:

```bash
sqlite3 data/osss.db ".backup backups/osss-$(date +%F).db"
```

Or stop the server and copy the file, along with any `osss.db-wal` file next to it.

## Updating

```bash
git pull
cd server
docker compose up -d --build   # Docker
npm start                       # or Node.js (restart it)
```
