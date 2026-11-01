--[[
	Helpers for moving data from Roblox DataStores to OSSS.
	Put this ModuleScript inside the OSSS ModuleScript, so it's at OSSS.Migrate.

	There are two ways to move:

	1. Gradually, as players join (easiest, no downtime):

		local Migrate = require(ServerScriptService.OSSS.Migrate)
		local oldStore = DataStoreService:GetDataStore("PlayerData")
		local data = Migrate.getWithFallback(playerData, oldStore, tostring(player.UserId))

	2. All at once, by copying every key (run from Studio with API access, or a private server):

		Migrate.copyAll({
			from = DataStoreService:GetDataStore("PlayerData"),
			to = playerData,
		})

	Neither one deletes anything from the Roblox DataStore, so you can always go back.

	MIT License. Copyright (c) 2026 AGamesTeam
]]

local DataStoreService = game:GetService("DataStoreService")

local BATCH_SIZE = 50

export type CopyOptions = {
	-- The Roblox DataStore to copy from.
	from: DataStore,
	-- The OSSS store to copy into, from storage:GetDataStore(name).
	to: any,
	-- Only copy keys starting with this.
	prefix: string?,
	-- Replace keys that already exist in OSSS. Default false, which skips them.
	overwrite: boolean?,
	-- Called after each batch with running totals.
	onProgress: ((copied: number, skipped: number, failed: number) -> ())?,
}

export type CopyResult = {
	copied: number,
	skipped: number,
	failed: { string },
}

local Migrate = {}

local function waitForBudget(requestType: Enum.DataStoreRequestType)
	while DataStoreService:GetRequestBudgetForRequestType(requestType) < 1 do
		task.wait(1)
	end
end

--[[
	Reads key from OSSS. If it isn't there yet, reads it from the Roblox DataStore and
	saves it to OSSS, then returns it. If two servers do this at the same time, the
	first copy wins and the second server gets that value back.
]]
function Migrate.getWithFallback(osssStore, dataStore: DataStore, key: string): (any, any)
	local value, info = osssStore:GetAsync(key)
	if value ~= nil then
		return value, info
	end

	waitForBudget(Enum.DataStoreRequestType.GetAsync)
	local oldValue = dataStore:GetAsync(key)
	if oldValue == nil then
		return nil, nil
	end

	return osssStore:UpdateAsync(key, function(current)
		if current ~= nil then
			return current
		end
		return oldValue
	end)
end

--[[
	Copies every key from a Roblox DataStore into an OSSS store. It goes as fast as
	your DataStore request budget allows, and writes to OSSS in batches.
	Keys locked by a live game server are reported in `failed`. Run it again to retry them.
]]
function Migrate.copyAll(options: CopyOptions): CopyResult
	assert(options.from, "[OSSS] Migrate.copyAll needs `from` (a Roblox DataStore)")
	assert(options.to and options.to._client, "[OSSS] Migrate.copyAll needs `to` (an OSSS store)")

	local client = options.to._client
	local storeName = options.to.Name
	local result: CopyResult = { copied = 0, skipped = 0, failed = {} }

	local function flush(batch: { { [string]: any } })
		if #batch == 0 then
			return
		end
		local results = client:BatchAsync(batch)
		for i, item in results do
			if item.ok then
				result.copied += 1
			elseif item.error == "version_conflict" then
				result.skipped += 1
			else
				table.insert(result.failed, batch[i].key)
				warn(string.format("[OSSS] Couldn't copy key %s: %s", batch[i].key, tostring(item.message)))
			end
		end
		table.clear(batch)
		if options.onProgress then
			options.onProgress(result.copied, result.skipped, #result.failed)
		end
	end

	waitForBudget(Enum.DataStoreRequestType.ListAsync)
	local pages = options.from:ListKeysAsync(options.prefix, BATCH_SIZE)
	local batch = {}

	while true do
		for _, keyInfo in pages:GetCurrentPage() do
			local key = keyInfo.KeyName
			waitForBudget(Enum.DataStoreRequestType.GetAsync)
			local ok, value = pcall(options.from.GetAsync, options.from, key)
			if not ok then
				table.insert(result.failed, key)
				warn(string.format("[OSSS] Couldn't read key %s from the DataStore: %s", key, tostring(value)))
			elseif value ~= nil then
				table.insert(batch, {
					op = "set",
					store = storeName,
					key = key,
					value = value,
					ifVersion = if options.overwrite then nil else 0,
				})
				if #batch >= BATCH_SIZE then
					flush(batch)
				end
			end
		end

		if pages.IsFinished then
			break
		end
		waitForBudget(Enum.DataStoreRequestType.ListAsync)
		pages:AdvanceToNextPageAsync()
	end

	flush(batch)
	return result
end

return Migrate
