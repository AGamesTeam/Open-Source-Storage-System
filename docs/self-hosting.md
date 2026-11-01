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

Check it's running by opening <http://localhost:8787/health>. You should see `{"ok":true}`. The [dashboard](#dashboard) is at <http://localhost:8787/dashboard>.

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
| `OSSS_API_KEYS` | *(required unless you use a keys file)* | One or more admin API keys, separated by commas. Each must be at least 32 characters. |
| `OSSS_KEYS_FILE` | | Path to a JSON file of [limited-access keys](#limited-access-keys). |
| `OSSS_HOST` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` if only a tunnel or proxy on the same machine should connect. |
| `OSSS_PORT` | `8787` | Port to listen on. |
| `OSSS_DB_PATH` | `data/osss.db` | Where the database file is stored. |
| `OSSS_MAX_BODY_BYTES` | `16777216` (16 MB) | Largest request the server accepts. |
| `OSSS_BACKUP_INTERVAL_HOURS` | `0` (off) | Make an automatic backup every this many hours. |
| `OSSS_BACKUP_DIR` | `backups` | Where backups go. In Docker it's `/data/backups`, inside the data volume. |
| `OSSS_BACKUP_KEEP` | `14` | How many automatic backups to keep. Older ones are deleted. `0` keeps all of them. |

Using several keys lets you rotate them: add the new key, update your game, then remove the old one.

## Limited-access keys

Keys in `OSSS_API_KEYS` are **admin** keys: they can do everything. To give a tool less access, such as a Discord bot that only shows a leaderboard, list its key in a JSON file and point `OSSS_KEYS_FILE` at it. See [`server/keys.example.json`](../server/keys.example.json):

```json
[
  { "name": "game", "key": "...", "access": "write" },
  { "name": "discord-bot", "key": "...", "access": "read", "stores": ["Leaderboard", "Stats"] }
]
```

| `access` | Can do |
| --- | --- |
| `read` | Read values, list keys and stores, view leaderboards and locks |
| `write` | Everything `read` can, plus write, delete, increment and lock |
| `admin` | Everything `write` can, plus force-unlock stuck locks |

Leave out `stores` to allow every store. A key with `stores` can't see or touch any other store. Requests it isn't allowed to make get a `403`.

Your game only needs a `write` key. Keep admin keys for yourself and the dashboard.

## Dashboard

Open `/dashboard` on your server, for example <http://localhost:8787/dashboard>, and paste in an API key. From there you can browse stores, search keys, view and edit values, delete keys, and see or clear session locks.

Edits from the dashboard use the same version checks as your game, so you can't overwrite a change you haven't seen. Keys locked by a live game server can't be edited until the lock is released. Admin keys can force-unlock them, but only do that if you're sure the server holding the lock is gone.

The dashboard only keeps your key for the browser tab you're using. Closing the tab forgets it.

## 4. Backups

Everything is in the SQLite file at `OSSS_DB_PATH`.

**Automatic backups:** set `OSSS_BACKUP_INTERVAL_HOURS=24` to save a backup every day. The server keeps the newest `OSSS_BACKUP_KEEP` backups.

**Manual backup:** safe to run while the server is running.

```bash
npm run backup                                                # Node.js
docker compose exec osss node scripts/backup.ts               # Docker
```

**Export to JSON:** writes every value as one JSON object per line, for use in other tools or spreadsheets.

```bash
npm run export -- my-export.jsonl                                         # Node.js
docker compose exec osss node scripts/export.ts /data/my-export.jsonl     # Docker
```

**Restoring a backup:** stop the server, delete `osss.db-wal` and `osss.db-shm` if they exist, copy the backup over `osss.db`, then start the server again.

Keep at least some backups on a different machine or drive. A backup on the same disk won't help if the disk dies.

## Updating

```bash
git pull
cd server
docker compose up -d --build   # Docker
npm start                       # or Node.js (restart it)
```
