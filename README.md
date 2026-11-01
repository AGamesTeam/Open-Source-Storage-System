# Open Source Storage System

**Self-hosted data storage for Roblox games.** Run your own storage server and use it from your game in place of Roblox DataStores, with no per-key size limits and no shared request budget. Your data stays on your own machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

> **Status: alpha (v0.1).** The server and Roblox module work, but the API may still change before 1.0. Test it before trusting it with a live game, and keep backups.

---

## Why?

Roblox DataStores are fine for small amounts of player data, but they get in the way once a game grows:

- **Size limits.** Each key is capped, so large inventories, building saves or world data have to be split across many keys by hand.
- **Request budgets.** Read and write limits scale with player count, and heavy games hit throttling.
- **Little control.** You can't query your data, back it up the way you want, or open it in your own tools.

Open Source Storage System (OSSS) gives you a storage server you host yourself, plus a Luau module that works like the DataStore API you already know. You keep your existing code patterns and get your own database underneath.

## How it works

```
┌──────────────────┐   HTTPS + API key    ┌─────────────────────┐      ┌──────────────┐
│  Roblox server   │ ───────────────────▶ │   OSSS server       │ ───▶ │   SQLite     │
│  (OSSS module)   │ ◀─────────────────── │   (your machine)    │ ◀─── │   database   │
└──────────────────┘        JSON          └─────────────────────┘      └──────────────┘
```

1. You run the **OSSS server** on your own PC, a home server or a cheap VPS.
2. Your game uses the **OSSS Luau module**, which sends requests to that server through `HttpService`.
3. The server checks your **API key**, then reads or writes data in its database.

## Features

- [x] **Familiar API:** `GetAsync`, `SetAsync`, `UpdateAsync`, `RemoveAsync`, `IncrementAsync` and `ListKeysAsync`, all shaped like Roblox DataStores
- [x] **Large values:** store big tables in one key, up to a limit you choose (16 MB by default)
- [x] **Safe updates:** `UpdateAsync` uses versioning, so two servers can't overwrite each other's changes
- [x] **Session locking:** stop a player's data from being saved by two servers at once
- [x] **API key auth:** works with Roblox Secrets, so keys never sit in your scripts
- [x] **Batching:** up to 100 reads and writes in one HTTP request
- [x] **Easy self-hosting:** one command with Docker, no dependencies with Node.js
- [ ] Caching in the Luau module
- [ ] Built-in backup and export commands
- [ ] Migration helper to move data off Roblox DataStores
- [ ] Admin dashboard to browse your data

## Quick start

**1. Start the server** (needs [Docker](https://docs.docker.com/get-docker/)):

```bash
git clone https://github.com/AGamesTeam/Open-Source-Storage-System
cd Open-Source-Storage-System/server
cp .env.example .env
docker compose run --rm osss node scripts/gen-key.ts
```

Put the printed key in `.env` as `OSSS_API_KEYS=...`, then run `docker compose up -d`. No Docker? See [self-hosting](docs/self-hosting.md) for running it with Node.js.

**2. Give it a public HTTPS address.** Roblox can't reach `localhost`. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is a free way to do this from your own PC. See [self-hosting](docs/self-hosting.md#2-let-roblox-reach-it).

**3. Add the module to your game.** Paste [`roblox/OSSS.luau`](roblox/OSSS.luau) into a ModuleScript named `OSSS` in `ServerScriptService`, turn on **Allow HTTP Requests**, and add your key as a secret named `OSSS_API_KEY`. See [using OSSS in Roblox](docs/roblox.md).

**4. Use it:**

```lua
local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")
local OSSS = require(ServerScriptService.OSSS)

local storage = OSSS.new({
	url = "https://storage.example.com",
	apiKey = HttpService:GetSecret("OSSS_API_KEY"),
})

local playerData = storage:GetDataStore("PlayerData")

game.Players.PlayerAdded:Connect(function(player)
	local ok, data = pcall(function()
		return playerData:GetAsync(tostring(player.UserId))
	end)
	-- ...
end)

-- Change data without overwriting another server's write
playerData:UpdateAsync("1234", function(old)
	old = old or { coins = 0 }
	old.coins += 100
	return old
end)
```

## Docs

- [Self-hosting](docs/self-hosting.md): running the server, HTTPS, settings and backups
- [Using OSSS in Roblox](docs/roblox.md): setup, every method, and a full player data example with session locking
- [HTTP API](docs/api.md): for calling the server from other tools

## Things to know before you self-host

- **Roblox needs to reach your server over the internet.** Use a VPS, or a tunnel such as Cloudflare Tunnel.
- **Use HTTPS.** Your API key is sent with every request.
- **HttpService has its own limit.** Each Roblox server can only make a set number of HTTP requests per minute. Save every minute or so instead of on every change, and use `BatchAsync`.
- **You are responsible for your data.** If your server goes down, so does your game's storage. Keep backups.

## Project layout

```
server/    The self-hosted storage server (Node.js + SQLite)
roblox/    The Luau module you add to your game
docs/      Guides for setup, the Roblox module and the HTTP API
```

## Contributing

Ideas, bug reports and pull requests are welcome. [Open an issue](https://github.com/AGamesTeam/Open-Source-Storage-System/issues) with the features you need, or the problems you've had with DataStores.

To work on the server:

```bash
cd server
npm install
npm test
npm run typecheck
```

## License

OSSS is released under the [MIT License](LICENSE). You can use it in any game, free or paid, and change it however you like.

*Not affiliated with or endorsed by Roblox Corporation.*
