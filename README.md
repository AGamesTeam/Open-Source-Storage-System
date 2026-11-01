# Open Source Storage System

**Self-hosted data storage for Roblox games.** Run your own storage server and use it from your game in place of Roblox DataStores. Your data stays on your own machine, with bigger values, your own limits, and full access from outside Roblox.

[![CI](https://github.com/AGamesTeam/Open-Source-Storage-System/actions/workflows/ci.yml/badge.svg)](https://github.com/AGamesTeam/Open-Source-Storage-System/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)

> **Status: alpha (v0.1).** The server, dashboard and Roblox module work, but the API may still change before 1.0. Test it before trusting it with a live game, and keep backups.

---

## Why use it?

Roblox DataStores are great for getting started, but they get in the way once a game grows:

- **Size limits.** Each key has a size cap (about 4 MB), so big building saves or world data have to be split across many keys by hand.
- **Request budgets.** Read and write limits scale with player count, and busy games get throttled.
- **Locked inside one experience.** Each game has its own DataStores. Sharing data between your games is hard.
- **Little control.** You can't query your data, open it in your own tools, or back it up the way you want.

Open Source Storage System (OSSS) gives you a storage server you host yourself, plus a Luau module that works like the DataStore API you already know. You keep your existing code patterns and get your own database underneath.

## Who it's for

**🏗️ Building and sandbox games.** Player plots, bases and custom worlds can be huge. Save a whole build as one value instead of splitting it across dozens of keys and stitching it back together.

**🌐 Several games sharing data.** Running a hub game and some minigames, or a series of games? Point them all at the same server and they share one inventory, currency or progression system. DataStores can't do that.

**🤖 Discord bots, websites and admin tools.** Anything that can send an HTTP request can read your game's data. Show a live leaderboard on your website, or let a Discord bot look up player stats, using a [read-only key](docs/self-hosting.md#limited-access-keys) that can't change anything.

**🛠️ Live ops and support.** A player lost their items? Open the [dashboard](docs/self-hosting.md#dashboard), find their key, and fix it in a few seconds, without writing a script or publishing an update.

**📈 Busy games that get throttled.** OSSS has no per-key write cooldown and no budget tied to player count. You batch up to 100 operations into one request, so a few HTTP calls a minute can cover a whole server.

**🏆 Leaderboards.** Any store of numbers works as a leaderboard, with paging and value ranges, like an OrderedDataStore that you can also read from outside Roblox.

**📊 Studios that want their data.** Everything lives in one SQLite file you own. Export it to JSON, open it with any SQLite tool, run your own analytics, or keep it as long as you like.

**🎓 Learning and prototyping.** Run it on your own PC in a minute, see every value in the dashboard, and learn how game backends work.

## How it compares

| | Roblox DataStores | **OSSS** | Hosted database (Firebase, Supabase, etc.) |
| --- | --- | --- | --- |
| **Cost** | Free | Free, plus your hosting (a free tunnel or a few dollars a month for a VPS) | Free tiers, then usually paid as you grow |
| **Setup** | None | About 10 minutes | Build your own Roblox wrapper and auth |
| **Max value size** | About 4 MB per key | You choose (16 MB default) | Varies |
| **Rate limits** | Per server, scales with players | Only Roblox's HTTP limit, with batching to stretch it | The provider's limits |
| **Feels like DataStores in Luau** | ✅ | ✅ | ❌ |
| **Session locking built in** | ❌ (you build it, or use a library) | ✅ | ❌ |
| **Share data between experiences** | ❌ | ✅ | ✅ |
| **Access from outside Roblox** | Through Open Cloud | ✅ Direct HTTP API with scoped keys | ✅ |
| **Admin dashboard** | Creator Dashboard data store manager | ✅ Built in | ✅ |
| **Who keeps it online** | Roblox | You | The provider |
| **Backups** | Roblox keeps version history | Built-in automatic backups, kept where you choose | The provider |

### When *not* to use it

Be honest with yourself before switching:

- **Your game is small and DataStores are working fine.** They're free and need no upkeep. Stick with them.
- **You can't keep a server online.** If your OSSS server goes down, your game can't load or save data until it's back.
- **You don't want to manage backups and updates.** With OSSS, that's your job.

## How it works

```
┌──────────────────┐   HTTPS + API key    ┌─────────────────────┐      ┌──────────────┐
│  Roblox server   │ ───────────────────▶ │   OSSS server       │ ───▶ │   SQLite     │
│  (OSSS module)   │ ◀─────────────────── │   (your machine)    │ ◀─── │   database   │
└──────────────────┘        JSON          └─────────────────────┘      └──────────────┘
                                                    ▲
                            Dashboard, bots, sites ─┘
```

1. You run the **OSSS server** on your own PC, a home server or a cheap VPS.
2. Your game uses the **OSSS Luau module**, which sends requests to that server through `HttpService`.
3. The server checks the **API key**, then reads or writes data in its database.

## Features

- [x] **Familiar API:** `GetAsync`, `SetAsync`, `UpdateAsync`, `RemoveAsync`, `IncrementAsync` and `ListKeysAsync`, all shaped like Roblox DataStores
- [x] **Large values:** store big tables in one key, up to a limit you choose
- [x] **Safe updates:** `UpdateAsync` uses versioning, so two servers can't overwrite each other's changes
- [x] **Session locking:** stop a player's data from being saved by two servers at once
- [x] **Leaderboards:** `GetSortedAsync` with paging and value ranges
- [x] **Batching:** up to 100 reads and writes in one HTTP request
- [x] **Caching:** optional, so repeat reads don't use HTTP requests
- [x] **Admin dashboard:** browse, search, edit and delete data, and clear stuck locks
- [x] **Limited-access keys:** read-only or store-restricted keys for bots and tools
- [x] **Backups and export:** automatic backups, plus export to JSON
- [x] **Migration helper:** move data off Roblox DataStores gradually or all at once
- [x] **Easy self-hosting:** one command with Docker, or Node.js with no dependencies
- [x] **Install your way:** copy and paste, Rojo, or Wally
- [ ] Postgres support for very large or multi-server setups
- [ ] Example place file

## Quick start

**1. Start the server** (needs [Docker](https://docs.docker.com/get-docker/)):

```bash
git clone https://github.com/AGamesTeam/Open-Source-Storage-System
cd Open-Source-Storage-System/server
cp .env.example .env
docker compose run --rm osss node scripts/gen-key.ts
```

Put the printed key in `.env` as `OSSS_API_KEYS=...`, then run `docker compose up -d`. Open <http://localhost:8787/dashboard> to see your data. No Docker? See [self-hosting](docs/self-hosting.md) for running it with Node.js.

**2. Give it a public HTTPS address.** Roblox can't reach `localhost`. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is a free way to do this from your own PC. See [self-hosting](docs/self-hosting.md#2-let-roblox-reach-it).

**3. Add the module to your game.** Paste [`roblox/src/init.luau`](roblox/src/init.luau) into a ModuleScript named `OSSS` in `ServerScriptService` (or use [Rojo or Wally](docs/roblox.md#setup)). Turn on **Allow HTTP Requests**, and add your key as a secret named `OSSS_API_KEY`.

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

- [Self-hosting](docs/self-hosting.md): running the server, HTTPS, settings, limited-access keys, the dashboard and backups
- [Using OSSS in Roblox](docs/roblox.md): setup, every method, player data with session locking, caching, leaderboards, and moving from DataStores
- [HTTP API](docs/api.md): for calling the server from bots, websites and other tools

## Things to know before you self-host

- **Roblox needs to reach your server over the internet.** Use a VPS, or a tunnel such as Cloudflare Tunnel.
- **Use HTTPS.** Your API key is sent with every request.
- **HttpService has its own limit.** Each Roblox server can only make a set number of HTTP requests per minute. Save every minute or so instead of on every change, and use `BatchAsync`.
- **You are responsible for your data.** If your server goes down, so does your game's storage. Turn on automatic backups and keep copies somewhere else.

## Project layout

```
server/    The self-hosted storage server and dashboard (Node.js + SQLite)
roblox/    The Luau module you add to your game
docs/      Guides for setup, the Roblox module and the HTTP API
```

## Contributing

Ideas, bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started, or [open an issue](https://github.com/AGamesTeam/Open-Source-Storage-System/issues/new/choose). Found a security problem? Please [report it privately](SECURITY.md).

## License

OSSS is released under the [MIT License](LICENSE). You can use it in any game, free or paid, and change it however you like.

*Not affiliated with or endorsed by Roblox Corporation.*
