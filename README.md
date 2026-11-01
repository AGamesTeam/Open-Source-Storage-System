# Open Source Storage System

**Self-hosted data storage for Roblox games.** Run your own storage server and use it from your game in place of Roblox DataStores, with no per-key size limits and no shared request budget. Your data stays on your own machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: early development](https://img.shields.io/badge/status-early%20development-orange)

> **Status:** This project is in early development. The design below describes what is being built; the APIs may change before the first release. Watch or star the repo to follow along.

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
│  Roblox server   │ ───────────────────▶ │   OSSS server       │ ───▶ │   Database   │
│  (OSSS module)   │ ◀─────────────────── │   (your machine)    │ ◀─── │              │
└──────────────────┘        JSON          └─────────────────────┘      └──────────────┘
```

1. You run the **OSSS server** on your own PC, a home server or a cheap VPS.
2. Your game uses the **OSSS Luau module**, which sends requests to that server through `HttpService`.
3. The server checks your **API key**, then reads or writes data in its database.

## Planned features

- [ ] **Familiar API:** `GetAsync`, `SetAsync`, `UpdateAsync`, `RemoveAsync` and `IncrementAsync`, all shaped like Roblox DataStores
- [ ] **Large values:** store big tables without splitting them up yourself
- [ ] **Safe updates:** `UpdateAsync` with versioning, so two servers can't overwrite each other's changes
- [ ] **Session locking:** stop a player's data from loading on two servers at once
- [ ] **API key auth:** keep keys in Roblox Secrets, never in your scripts
- [ ] **Batching and caching:** fit more work into Roblox's HTTP request limit
- [ ] **Easy self-hosting:** one command with Docker, or a single binary
- [ ] **Backups and export:** your data in a format you control
- [ ] **Migration helper:** move existing data off Roblox DataStores

## Planned usage

This is the intended API. It is not available yet.

```lua
local ServerScriptService = game:GetService("ServerScriptService")
local HttpService = game:GetService("HttpService")
local OSSS = require(ServerScriptService.OSSS)

local storage = OSSS.new({
	url = "https://storage.example.com",
	apiKey = HttpService:GetSecret("OSSS_API_KEY"),
})

local playerData = storage:GetDataStore("PlayerData")

game.Players.PlayerAdded:Connect(function(player)
	local data = playerData:GetAsync(tostring(player.UserId)) or { coins = 0 }
	-- ...
end)

-- Change data without overwriting another server's write
playerData:UpdateAsync("1234", function(old)
	old = old or { coins = 0 }
	old.coins += 100
	return old
end)
```

## Things to know before you self-host

- **Roblox needs to reach your server over the internet.** Roblox game servers can't connect to `localhost` or your home network. Use a VPS, open a port, or run a tunnel such as [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).
- **Use HTTPS.** Your API key is sent with every request, so don't send it over plain HTTP.
- **Turn on HTTP requests.** In Studio, open *Game Settings → Security* and enable **Allow HTTP Requests**.
- **HttpService has its own limit.** Each Roblox server can only make a set number of HTTP requests per minute. OSSS will batch and cache requests to stay under it.
- **You are responsible for your data.** If your server goes down, so does your game's storage. Keep backups.

## Project layout

Planned layout as the code lands:

```
server/    The self-hosted storage server
roblox/    The Luau module you add to your game
docs/      Guides for setup, the API and hosting
```

## Contributing

Ideas, bug reports and pull requests are welcome. Since the project is early, the best way to help right now is to [open an issue](https://github.com/AGamesTeam/Open-Source-Storage-System/issues) with the features you need, or the problems you've had with DataStores.

## License

OSSS is released under the [MIT License](LICENSE). You can use it in any game, free or paid, and change it however you like.

*Not affiliated with or endorsed by Roblox Corporation.*
