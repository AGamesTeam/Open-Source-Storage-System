# Using OSSS in your Roblox game

## Setup

1. **Add the module.** Pick one:
   - **Copy and paste:** create a ModuleScript called `OSSS` in `ServerScriptService` and paste in [`roblox/src/init.luau`](../roblox/src/init.luau). If you're moving from DataStores, also add a ModuleScript called `Migrate` *inside* `OSSS` and paste in [`roblox/src/Migrate.luau`](../roblox/src/Migrate.luau).
   - **Wally:** add `OSSS = "agamesteam/osss@0.1.0"` under `[server-dependencies]` in your `wally.toml`, once the package is published.
   - **Rojo:** clone this repo (or add it as a git submodule) and point your project at it: `"OSSS": { "$path": "path/to/Open-Source-Storage-System/roblox/src" }`.
2. **Allow HTTP requests.** In Studio, open *Game Settings → Security* and turn on **Allow HTTP Requests**.
3. **Add your API key as a secret.** On the Creator Dashboard, open your experience, go to *Secrets*, and add a secret named `OSSS_API_KEY` with the key from your server. Set its domain to your server's address. Secrets keep the key out of your scripts, so it can't leak if someone gets a copy of your place.

> Secrets aren't available in Studio by default. For local testing, add the secret in *Game Settings → Security* (Studio), or pass the key as a plain string, but never publish a place with the key in a script.

## Basic use

The API is shaped like Roblox's `DataStoreService`. Every method yields and can error, so wrap calls in `pcall`.

```lua
local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")
local OSSS = require(ServerScriptService.OSSS)

local storage = OSSS.new({
	url = "https://storage.example.com",
	apiKey = HttpService:GetSecret("OSSS_API_KEY"),
})

local playerData = storage:GetDataStore("PlayerData")

local ok, data = pcall(function()
	return playerData:GetAsync("123")
end)
```

## Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `storage:GetDataStore(name)` | `store` | Same name returns the same object. |
| `store:GetAsync(key, options?)` | `value, info` | `value` is `nil` if nothing is stored. `info` has `version` and `updatedAt`. Pass `{ useCache = false }` to skip the [cache](#caching). |
| `store:SetAsync(key, value)` | `version` | Replaces the value. |
| `store:UpdateAsync(key, transform)` | `newValue, info` | Safe against other servers writing at the same time. Return `nil` from `transform` to cancel. |
| `store:RemoveAsync(key)` | `oldValue` | |
| `store:IncrementAsync(key, delta?)` | `newNumber` | Starts from 0. `delta` defaults to 1. |
| `store:ListKeysAsync(prefix?, pageSize?, cursor?)` | `keys, nextCursor` | `nextCursor` is `nil` on the last page. |
| `store:GetSortedAsync(ascending, pageSize?, min?, max?, cursor?)` | `entries, nextCursor` | For [leaderboards](#leaderboards). |
| `store:ClearCache(key?)` | | Forgets cached values for one key, or all of them. |
| `store:LockAsync(key, ttlSeconds?)` | `ok, ownerJobId` | Session lock. See below. |
| `store:UnlockAsync(key)` | `released` | |
| `storage:BatchAsync(operations)` | `results` | Up to 100 operations in one request. |

Values can be anything `HttpService:JSONEncode` handles: tables, strings, numbers and booleans. Like DataStores, you can't store Instances, Vector3s or other Roblox types directly. Convert them to tables first.

## Player data with session locking

> Want to see this running? The [clicker example](../examples/clicker) is a complete game built on this pattern.

A session lock makes sure only one server can save a player's data at a time. It stops data loss when a player rejoins quickly and their old server is still saving.

While a server holds the lock, writes to that key from any other server fail. Locks expire on their own, so a crashed server can't hold one forever. Renew them while the player is in game.

```lua
local Players = game:GetService("Players")

local LOCK_SECONDS = 300
local sessions = {}

local function loadPlayer(player)
	local key = tostring(player.UserId)

	-- Wait for the previous server to finish saving and release the lock.
	local locked = false
	for _ = 1, 10 do
		locked = playerData:LockAsync(key, LOCK_SECONDS)
		if locked then break end
		task.wait(3)
	end
	if not locked then
		player:Kick("Your data is still saving on another server. Please rejoin in a minute.")
		return
	end

	sessions[player] = playerData:GetAsync(key) or { coins = 0 }
end

local function savePlayer(player, release)
	local data = sessions[player]
	if not data then return end
	local key = tostring(player.UserId)
	playerData:SetAsync(key, data)
	if release then
		playerData:UnlockAsync(key)
		sessions[player] = nil
	end
end

Players.PlayerAdded:Connect(function(player)
	local ok, err = pcall(loadPlayer, player)
	if not ok then
		warn(err)
		player:Kick("Couldn't load your data. Please rejoin.")
	end
end)

Players.PlayerRemoving:Connect(function(player)
	local ok, err = pcall(savePlayer, player, true)
	if not ok then warn(err) end
end)

-- Autosave and renew locks every minute.
task.spawn(function()
	while true do
		task.wait(60)
		for player in sessions do
			pcall(function()
				playerData:LockAsync(tostring(player.UserId), LOCK_SECONDS)
				savePlayer(player, false)
			end)
		end
	end
end)

game:BindToClose(function()
	for _, player in Players:GetPlayers() do
		pcall(savePlayer, player, true)
	end
end)
```

## Saving HTTP requests

Each Roblox server can only make a limited number of HTTP requests per minute, and that limit is shared with anything else in your game that uses `HttpService`. To stay under it:

- Keep data in memory and save every minute or so, not on every change.
- Use `BatchAsync` to load or save many keys in a single request.
- Put related data in one key. There's no per-key size cap beyond your server's `OSSS_MAX_BODY_BYTES`.

```lua
local results = storage:BatchAsync({
	{ op = "get", store = "PlayerData", key = "123" },
	{ op = "get", store = "Inventory", key = "123" },
	{ op = "increment", store = "Stats", key = "joins" },
})
```

## Caching

Set `cacheSeconds` to remember values this server has read or written, so repeated `GetAsync` calls for the same key don't each use an HTTP request:

```lua
local storage = OSSS.new({
	url = "https://storage.example.com",
	apiKey = HttpService:GetSecret("OSSS_API_KEY"),
	cacheSeconds = 5,
})
```

The cache is per server. A write from another server won't show up here until the cached value expires, so keep it short, or pass `{ useCache = false }` when you need the latest value. `UpdateAsync` is always safe: if its cached starting value is out of date, the server rejects the write and it retries with the real one.

`BatchAsync` doesn't use the cache.

## Leaderboards

Any store whose values are numbers works as a leaderboard, like an `OrderedDataStore`:

```lua
local wins = storage:GetDataStore("Wins")

-- When someone wins
wins:IncrementAsync(tostring(player.UserId), 1)

-- Top 10, highest first
local top, nextCursor = wins:GetSortedAsync(false, 10)
for rank, entry in top do
	print(rank, entry.key, entry.value)
end

-- The next 10
local more = wins:GetSortedAsync(false, 10, nil, nil, nextCursor)
```

Pass `min` and `max` to only include values in a range. Keys holding something other than a number are left out.

## Moving from Roblox DataStores

The `Migrate` module copies your existing data into OSSS. It never deletes anything from your DataStores, so you can always switch back.

**Option 1: move each player when they join.** Easiest, and needs no downtime. Use it in place of `GetAsync` when loading player data:

```lua
local DataStoreService = game:GetService("DataStoreService")
local Migrate = require(ServerScriptService.OSSS.Migrate)

local oldPlayerData = DataStoreService:GetDataStore("PlayerData")

local data = Migrate.getWithFallback(playerData, oldPlayerData, tostring(player.UserId))
```

It reads from OSSS first. If the player isn't there yet, it copies their data from the DataStore. Players who never come back stay in the DataStore, so you may still want option 2 later.

**Option 2: copy everything at once.** Run it from Studio with *Enable Studio Access to API Services* turned on, or from a private server:

```lua
local result = Migrate.copyAll({
	from = DataStoreService:GetDataStore("PlayerData"),
	to = storage:GetDataStore("PlayerData"),
	onProgress = function(copied, skipped, failed)
		print(("Copied %d, skipped %d, failed %d"):format(copied, skipped, failed))
	end,
})
```

It goes as fast as your DataStore request budget allows. Keys already in OSSS are skipped unless you pass `overwrite = true`. Keys that fail, for example because a live server has them locked, are listed in `result.failed`. Run it again to retry them.

Only the latest version of each key is copied. DataStore version history and metadata aren't.
