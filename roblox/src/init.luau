--[[
	Open Source Storage System (OSSS) client for Roblox
	https://github.com/AGamesTeam/Open-Source-Storage-System

	Put this ModuleScript in ServerScriptService, named OSSS. It only works on the server,
	and needs "Allow HTTP Requests" turned on in Game Settings > Security.

		local OSSS = require(ServerScriptService.OSSS)
		local storage = OSSS.new({
			url = "https://storage.example.com",
			apiKey = HttpService:GetSecret("OSSS_API_KEY"),
		})
		local playerData = storage:GetDataStore("PlayerData")

	Like Roblox DataStores, every method yields and can error, so wrap calls in pcall.

	MIT License. Copyright (c) 2026 AGamesTeam
]]

local HttpService = game:GetService("HttpService")

export type Config = {
	-- Address of your OSSS server, for example "https://storage.example.com".
	url: string,
	-- Your API key. Use HttpService:GetSecret so it never sits in a script.
	apiKey: string | Secret,
	-- How many times to retry a request that failed to reach the server. Default 3.
	maxRetries: number?,
	-- How many times UpdateAsync retries when another server wrote first. Default 10.
	updateRetries: number?,
	-- Seconds to remember values read or written by this server, so repeat GetAsync
	-- calls don't use an HTTP request. Default 0 (off). Other servers' writes won't
	-- show up until the cached value expires, so keep this short.
	cacheSeconds: number?,
}

export type GetOptions = {
	-- Set to false to skip the cache and always ask the server.
	useCache: boolean?,
}

export type SortedEntry = {
	key: string,
	value: number,
}

export type KeyInfo = {
	version: number,
	updatedAt: number,
}

-- Identifies this server for session locks. JobId is empty in Studio, so fall back to a GUID.
local SERVER_ID = if game.JobId ~= "" then game.JobId else HttpService:GenerateGUID(false)

local CACHE_SWEEP_SECONDS = 60

local OSSS = {}
OSSS.__index = OSSS
OSSS.version = "0.1.0"

local DataStore = {}
DataStore.__index = DataStore

local function toInfo(data): KeyInfo
	return { version = data.version, updatedAt = data.updatedAt }
end

-- Cached tables are copied in and out so game code can't change the cached version by accident.
local function deepCopy(value)
	if type(value) ~= "table" then
		return value
	end
	local copy = {}
	for k, v in value do
		copy[deepCopy(k)] = deepCopy(v)
	end
	return copy
end

local function fail(what: string, status: number, data): never
	local message = if type(data) == "table" and data.message then data.message else "unexpected response"
	error(string.format("[OSSS] %s failed (HTTP %d): %s", what, status, message), 0)
end

function OSSS.new(config: Config)
	assert(type(config) == "table", "[OSSS] OSSS.new expects a config table")
	assert(type(config.url) == "string", "[OSSS] config.url must be a string")
	assert(config.apiKey ~= nil, "[OSSS] config.apiKey is required")

	local auth
	if type(config.apiKey) == "string" then
		auth = "Bearer " .. config.apiKey
	else
		auth = (config.apiKey :: any):AddPrefix("Bearer ")
	end

	local self = setmetatable({}, OSSS)
	self._baseUrl = string.gsub(config.url, "/+$", "")
	self._auth = auth
	self._maxRetries = config.maxRetries or 3
	self._updateRetries = config.updateRetries or 10
	self._cacheSeconds = config.cacheSeconds or 0
	self._stores = {}
	return self
end

--[[
	Sends one request and returns the status code and decoded JSON body.
	Requests that can't reach the server, or get a 5xx back, are retried with backoff
	when `retry` is true. Only safe-to-repeat requests should set it.
]]
function OSSS:_request(method: string, path: string, body: any?, retry: boolean): (number, any)
	local request = {
		Url = self._baseUrl .. path,
		Method = method,
		Headers = {
			["Authorization"] = self._auth,
			["Content-Type"] = "application/json",
			["OSSS-Lock-Owner"] = SERVER_ID,
		},
		Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
	}

	local attempts = if retry then self._maxRetries + 1 else 1
	local lastError = "no attempts made"
	for attempt = 1, attempts do
		local ok, response = pcall(HttpService.RequestAsync, HttpService, request)
		if ok then
			local data = nil
			if response.Body ~= "" then
				local decoded, result = pcall(HttpService.JSONDecode, HttpService, response.Body)
				if decoded then
					data = result
				end
			end
			if response.StatusCode < 500 then
				return response.StatusCode, data
			end
			lastError = string.format(
				"server error %d: %s",
				response.StatusCode,
				if type(data) == "table" and data.message then data.message else response.StatusMessage
			)
		else
			lastError = tostring(response)
		end
		if attempt < attempts then
			task.wait(2 ^ (attempt - 1))
		end
	end
	error(string.format("[OSSS] %s %s failed: %s", method, path, lastError), 0)
end

--[[
	Returns the store object for name. Calling it again with the same name returns the
	same object, so they share a cache. Stores are created on the server the first time
	you write to them.
]]
function OSSS:GetDataStore(name: string)
	assert(type(name) == "string" and name ~= "", "[OSSS] GetDataStore expects a store name")
	local existing = self._stores[name]
	if existing then
		return existing
	end

	local store = setmetatable({}, DataStore)
	store.Name = name
	store._client = self
	store._storePath = "/v1/stores/" .. HttpService:UrlEncode(name)
	store._path = store._storePath .. "/keys"
	store._cache = {}
	store._nextSweep = 0
	self._stores[name] = store
	return store
end

--[[
	Runs up to 100 operations in one HTTP request, to save on Roblox's HTTP request limit.
	Each operation is a table such as:
		{ op = "get", store = "PlayerData", key = "123" }
		{ op = "set", store = "PlayerData", key = "123", value = data, ifVersion = 4 }
		{ op = "remove", store = "PlayerData", key = "123" }
		{ op = "increment", store = "Stats", key = "visits", delta = 1 }
	Returns a list of results in the same order. Each has `ok`, and either the result
	fields (value, version, updatedAt) or `error` and `message`.
]]
function OSSS:BatchAsync(operations: { { [string]: any } }): { { [string]: any } }
	local status, data = self:_request("POST", "/v1/batch", { operations = operations }, false)
	if status ~= 200 then
		fail("BatchAsync", status, data)
	end
	return data.results
end

function DataStore:_keyPath(key: string): string
	assert(type(key) == "string" and key ~= "", "[OSSS] key must be a non-empty string")
	return self._path .. "/" .. HttpService:UrlEncode(key)
end

function DataStore:_remember(key: string, value: any, info: KeyInfo?)
	local seconds = self._client._cacheSeconds
	if seconds <= 0 then
		return
	end

	local now = os.clock()
	if now >= self._nextSweep then
		for cachedKey, entry in self._cache do
			if entry.expires <= now then
				self._cache[cachedKey] = nil
			end
		end
		self._nextSweep = now + CACHE_SWEEP_SECONDS
	end
	self._cache[key] = { value = deepCopy(value), info = info, expires = now + seconds }
end

-- Forgets cached values for key, or for every key if none is given.
function DataStore:ClearCache(key: string?)
	if key then
		self._cache[key] = nil
	else
		table.clear(self._cache)
	end
end

-- Returns the value stored at key (or nil), and its KeyInfo.
function DataStore:GetAsync(key: string, options: GetOptions?): (any, KeyInfo?)
	local path = self:_keyPath(key)
	if not (options and options.useCache == false) then
		local cached = self._cache[key]
		if cached and cached.expires > os.clock() then
			return deepCopy(cached.value), if cached.info then table.clone(cached.info) else nil
		end
	end

	local status, data = self._client:_request("GET", path, nil, true)
	if status == 404 then
		self:_remember(key, nil, nil)
		return nil, nil
	end
	if status ~= 200 then
		fail("GetAsync", status, data)
	end
	local info = toInfo(data)
	self:_remember(key, data.value, info)
	return data.value, info
end

-- Stores value at key, replacing what was there. Returns the new version number.
function DataStore:SetAsync(key: string, value: any): number
	assert(value ~= nil, "[OSSS] SetAsync can't store nil. Use RemoveAsync instead.")
	local status, data = self._client:_request("PUT", self:_keyPath(key), { value = value }, true)
	if status ~= 200 then
		fail("SetAsync", status, data)
	end
	self:_remember(key, value, toInfo(data))
	return data.version
end

--[[
	Reads the value, passes it to transform, and saves what transform returns.
	If another server changed the value in between, transform runs again with the
	newer value, so no write is ever lost. Return nil from transform to cancel.
	Returns the saved value and its KeyInfo, or nil if cancelled.
]]
function DataStore:UpdateAsync(key: string, transform: (any, KeyInfo?) -> any): (any, KeyInfo?)
	local path = self:_keyPath(key)
	local current, info = self:GetAsync(key)

	for _ = 1, self._client._updateRetries do
		local newValue = transform(current, info)
		if newValue == nil then
			return nil, nil
		end

		local version = if info then info.version else 0
		-- Not retried: if a write landed but the reply was lost, a retry would apply transform twice.
		local status, data = self._client:_request("PUT", path, { value = newValue, ifVersion = version }, false)
		if status == 200 then
			local newInfo = toInfo(data)
			self:_remember(key, newValue, newInfo)
			return newValue, newInfo
		elseif status == 409 and type(data) == "table" and data.error == "version_conflict" then
			if data.current then
				current, info = data.current.value, toInfo(data.current)
			else
				current, info = nil, nil
			end
		else
			fail("UpdateAsync", status, data)
		end
	end

	error("[OSSS] UpdateAsync gave up: too many other servers were writing to key " .. key, 0)
end

-- Deletes key. Returns the value it held, or nil if there was none.
function DataStore:RemoveAsync(key: string): any
	local status, data = self._client:_request("DELETE", self:_keyPath(key), nil, true)
	if status ~= 200 and status ~= 404 then
		fail("RemoveAsync", status, data)
	end
	self._cache[key] = nil
	return if status == 200 then data.value else nil
end

-- Adds delta (default 1) to the number stored at key, starting from 0. Returns the new number.
function DataStore:IncrementAsync(key: string, delta: number?): number
	local status, data = self._client:_request("POST", self:_keyPath(key) .. "/increment", { delta = delta or 1 }, false)
	if status ~= 200 then
		fail("IncrementAsync", status, data)
	end
	self:_remember(key, data.value, toInfo(data))
	return data.value
end

--[[
	Lists keys in this store, sorted, optionally only those starting with prefix.
	Returns a list of keys and a cursor. Pass the cursor back to get the next page;
	it is nil on the last page.
]]
function DataStore:ListKeysAsync(prefix: string?, pageSize: number?, cursor: string?): ({ string }, string?)
	local query = string.format(
		"?prefix=%s&limit=%d&cursor=%s",
		HttpService:UrlEncode(prefix or ""),
		pageSize or 100,
		HttpService:UrlEncode(cursor or "")
	)
	local status, data = self._client:_request("GET", self._path .. query, nil, true)
	if status ~= 200 then
		fail("ListKeysAsync", status, data)
	end
	return data.keys, data.nextCursor
end

--[[
	Returns keys whose value is a number, sorted by that number, for leaderboards.
	Works like OrderedDataStore:GetSortedAsync, but returns a plain list and a cursor
	instead of a pages object. Keys holding non-numbers are skipped.

		local top, cursor = scores:GetSortedAsync(false, 10)
		for rank, entry in top do
			print(rank, entry.key, entry.value)
		end
]]
function DataStore:GetSortedAsync(
	ascending: boolean,
	pageSize: number?,
	minValue: number?,
	maxValue: number?,
	cursor: string?
): ({ SortedEntry }, string?)
	local query = string.format("?order=%s&limit=%d", if ascending then "asc" else "desc", pageSize or 50)
	if minValue then
		query ..= "&min=" .. HttpService:UrlEncode(tostring(minValue))
	end
	if maxValue then
		query ..= "&max=" .. HttpService:UrlEncode(tostring(maxValue))
	end
	if cursor then
		query ..= "&cursor=" .. HttpService:UrlEncode(cursor)
	end
	local status, data = self._client:_request("GET", self._storePath .. "/sorted" .. query, nil, true)
	if status ~= 200 then
		fail("GetSortedAsync", status, data)
	end
	return data.entries, data.nextCursor
end

--[[
	Takes a session lock on key for ttlSeconds (default 300), or renews one this server holds.
	While locked, only this server can write to key. Use it so a player's data can't be
	saved by two servers at once.
	Returns true if this server now holds the lock. Returns false and the other server's
	JobId if someone else holds it.
]]
function DataStore:LockAsync(key: string, ttlSeconds: number?): (boolean, string?)
	local status, data =
		self._client:_request("POST", self:_keyPath(key) .. "/lock", { ttlSeconds = ttlSeconds or 300 }, true)
	if status == 200 then
		return true, nil
	elseif status == 423 then
		return false, data.owner
	end
	fail("LockAsync", status, data)
end

-- Releases this server's lock on key. Returns false if this server didn't hold it.
function DataStore:UnlockAsync(key: string): boolean
	local status, data = self._client:_request("DELETE", self:_keyPath(key) .. "/lock", nil, true)
	if status ~= 200 then
		fail("UnlockAsync", status, data)
	end
	return data.released
end

return OSSS
