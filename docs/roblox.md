# Using OSSS in your Roblox game

## Setup

1. **Add the module.** Create a ModuleScript called `OSSS` in `ServerScriptService` and paste in the contents of [`roblox/OSSS.luau`](../roblox/OSSS.luau). If you use Rojo, sync that file instead.
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
| `store:GetAsync(key)` | `value, info` | `value` is `nil` if nothing is stored. `info` has `version` and `updatedAt`. |
| `store:SetAsync(key, value)` | `version` | Replaces the value. |
| `store:UpdateAsync(key, transform)` | `newValue, info` | Safe against other servers writing at the same time. Return `nil` from `transform` to cancel. |
| `store:RemoveAsync(key)` | `oldValue` | |
| `store:IncrementAsync(key, delta?)` | `newNumber` | Starts from 0. `delta` defaults to 1. |
| `store:ListKeysAsync(prefix?, pageSize?, cursor?)` | `keys, nextCursor` | `nextCursor` is `nil` on the last page. |
| `store:LockAsync(key, ttlSeconds?)` | `ok, ownerJobId` | Session lock. See below. |
| `store:UnlockAsync(key)` | `released` | |
| `storage:BatchAsync(operations)` | `results` | Up to 100 operations in one request. |

Values can be anything `HttpService:JSONEncode` handles: tables, strings, numbers and booleans. Like DataStores, you can't store Instances, Vector3s or other Roblox types directly. Convert them to tables first.

## Player data with session locking

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
