--[[
	OSSS clicker demo.

	Builds a big button in the world. Clicking it adds to your "Clicks" leaderstat, which
	is saved to your OSSS server. A board shows the all-time top 10 from the database.

	Setup:
	1. Put the OSSS ModuleScript in ServerScriptService (see docs/roblox.md).
	2. Turn on Game Settings > Security > Allow HTTP Requests (the place must be published).
	3. Put this in ServerScriptService as a Script, set URL and API_KEY below, and press Play.
	4. Click the green button. Open your server's /dashboard to watch PlayerData and
	   ClickLeaderboard update.

	Your clicks are saved every few seconds and when you leave, so they're still there next time.

	Before publishing for real players, don't keep the key in a script. Add it as a Roblox Secret
	named OSSS_API_KEY and use:
		local API_KEY = game:GetService("HttpService"):GetSecret("OSSS_API_KEY")
]]

local URL = "https://storage.example.com" -- your OSSS server's address
local API_KEY = "PASTE_YOUR_KEY_HERE" -- for quick Studio testing only. For a real game, see the note above.

local SAVE_EVERY = 5 -- seconds between saves, if something changed
local LOCK_SECONDS = 120 -- how long a session lock lasts before it needs renewing
local LOCK_RENEW_EVERY = 30
local BOARD_REFRESH_EVERY = 10
local CLICK_COOLDOWN = 0.1 -- stops auto-clickers from spamming

local Players = game:GetService("Players")
local ServerScriptService = game:GetService("ServerScriptService")
local TweenService = game:GetService("TweenService")
local OSSS = require(ServerScriptService:WaitForChild("OSSS"))

if API_KEY == "PASTE_YOUR_KEY_HERE" then
	error("[Clicker] Paste your API key into the API_KEY line at the top of this script first.")
end

local storage = OSSS.new({ url = URL, apiKey = API_KEY })
local playerData = storage:GetDataStore("PlayerData")
local clickBoard = storage:GetDataStore("ClickLeaderboard")

type Session = {
	data: { clicks: number },
	dirty: boolean,
	lastClick: number,
	clicksValue: IntValue,
}

local sessions: { [Player]: Session } = {}

-- World ---------------------------------------------------------------------

local function makeButton(onClick: (Player) -> ())
	local model = Instance.new("Model")
	model.Name = "OSSSClickButton"

	local base = Instance.new("Part")
	base.Name = "Base"
	base.Anchored = true
	base.Size = Vector3.new(8, 1, 8)
	base.Position = Vector3.new(0, 0.5, -12)
	base.Color = Color3.fromRGB(45, 45, 50)
	base.Material = Enum.Material.Metal
	base.Parent = model

	local button = Instance.new("Part")
	button.Name = "Button"
	button.Anchored = true
	button.Shape = Enum.PartType.Cylinder
	button.Size = Vector3.new(1, 6, 6) -- cylinders are round along their X axis
	button.CFrame = CFrame.new(0, 1.5, -12) * CFrame.Angles(0, 0, math.rad(90))
	button.Color = Color3.fromRGB(46, 204, 113)
	button.Material = Enum.Material.Neon
	button.Parent = model

	local clickDetector = Instance.new("ClickDetector")
	clickDetector.MaxActivationDistance = 40
	clickDetector.Parent = button

	local billboard = Instance.new("BillboardGui")
	billboard.Size = UDim2.fromOffset(220, 60)
	billboard.StudsOffsetWorldSpace = Vector3.new(0, 4, 0)
	billboard.AlwaysOnTop = true
	billboard.Parent = button

	local label = Instance.new("TextLabel")
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Text = "Click me! +1"
	label.TextScaled = true
	label.Font = Enum.Font.GothamBold
	label.TextColor3 = Color3.new(1, 1, 1)
	label.TextStrokeTransparency = 0.4
	label.Parent = billboard

	local upCFrame = button.CFrame
	local downCFrame = upCFrame - Vector3.new(0, 0.35, 0)
	local pressInfo = TweenInfo.new(0.06, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
	local releaseInfo = TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

	clickDetector.MouseClick:Connect(function(player)
		onClick(player)
		local press = TweenService:Create(button, pressInfo, { CFrame = downCFrame })
		press.Completed:Once(function()
			TweenService:Create(button, releaseInfo, { CFrame = upCFrame }):Play()
		end)
		press:Play()
	end)

	model.Parent = workspace
end

-- Returns a function that shows a list of { name, clicks } rows on the board.
local function makeBoard()
	local board = Instance.new("Part")
	board.Name = "OSSSLeaderboard"
	board.Anchored = true
	board.Size = Vector3.new(12, 14, 0.5)
	board.Position = Vector3.new(0, 7, -24)
	board.Color = Color3.fromRGB(25, 27, 33)
	board.Parent = workspace

	local gui = Instance.new("SurfaceGui")
	gui.Face = Enum.NormalId.Back -- the side facing the spawn
	gui.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
	gui.PixelsPerStud = 40
	gui.Parent = board

	local padding = Instance.new("UIPadding")
	padding.PaddingTop = UDim.new(0, 20)
	padding.PaddingLeft = UDim.new(0, 24)
	padding.PaddingRight = UDim.new(0, 24)
	padding.Parent = gui

	local layout = Instance.new("UIListLayout")
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 6)
	layout.Parent = gui

	local function addLabel(order: number, height: number, color: Color3): TextLabel
		local label = Instance.new("TextLabel")
		label.LayoutOrder = order
		label.Size = UDim2.new(1, 0, 0, height)
		label.BackgroundTransparency = 1
		label.Font = Enum.Font.GothamBold
		label.TextScaled = true
		label.TextXAlignment = Enum.TextXAlignment.Left
		label.TextColor3 = color
		label.Text = ""
		label.Parent = gui
		return label
	end

	addLabel(0, 60, Color3.fromRGB(46, 204, 113)).Text = "🏆 All-time clicks"
	local subtitle = addLabel(1, 26, Color3.fromRGB(150, 155, 165))
	subtitle.Text = "Loading from OSSS..."

	local rows = {}
	for i = 1, 10 do
		rows[i] = addLabel(i + 1, 36, Color3.new(1, 1, 1))
	end

	return function(entries)
		for i, row in rows do
			local entry = entries[i]
			row.Text = if entry then string.format("%d. %s: %d", i, entry.name, entry.clicks) else ""
		end
		subtitle.Text = if #entries == 0
			then "No clicks yet. Be the first!"
			else "Saved in your own database · updates every " .. BOARD_REFRESH_EVERY .. "s"
	end
end

-- Data ----------------------------------------------------------------------

local function loadPlayer(player: Player)
	local key = tostring(player.UserId)

	-- Take the session lock, so no other server can save this player's data while they're here.
	local locked = false
	for _ = 1, 10 do
		local otherServer
		locked, otherServer = playerData:LockAsync(key, LOCK_SECONDS)
		if locked then
			break
		end
		print(string.format("[Clicker] %s's data is still open on server %s, waiting...", player.Name, tostring(otherServer)))
		task.wait(3)
	end
	if not locked then
		player:Kick("Your data is still saving on another server. Please rejoin in a minute.")
		return
	end
	if not player.Parent then
		-- They left while we were loading.
		playerData:UnlockAsync(key)
		return
	end

	local data = playerData:GetAsync(key, { useCache = false }) or {}
	data.clicks = data.clicks or 0

	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	local clicksValue = Instance.new("IntValue")
	clicksValue.Name = "Clicks"
	clicksValue.Value = data.clicks
	clicksValue.Parent = leaderstats
	leaderstats.Parent = player

	sessions[player] = { data = data, dirty = false, lastClick = 0, clicksValue = clicksValue }
	print(string.format("[Clicker] Loaded %s with %d clicks", player.Name, data.clicks))
end

local function savePlayer(player: Player, release: boolean)
	local session = sessions[player]
	if not session then
		return
	end
	local key = tostring(player.UserId)

	if session.dirty then
		session.dirty = false
		-- One HTTP request saves both the player's data and their leaderboard score.
		local results = storage:BatchAsync({
			{ op = "set", store = playerData.Name, key = key, value = session.data },
			{ op = "set", store = clickBoard.Name, key = key, value = session.data.clicks },
		})
		for _, result in results do
			if not result.ok then
				session.dirty = true
				warn(string.format("[Clicker] Couldn't save %s: %s", player.Name, tostring(result.message)))
			end
		end
		if not session.dirty then
			print(string.format("[Clicker] Saved %s: %d clicks", player.Name, session.data.clicks))
		end
	end

	if release then
		sessions[player] = nil
		playerData:UnlockAsync(key)
	end
end

local function onClick(player: Player)
	local session = sessions[player]
	if not session then
		return
	end
	local now = os.clock()
	if now - session.lastClick < CLICK_COOLDOWN then
		return
	end
	session.lastClick = now
	session.data.clicks += 1
	session.clicksValue.Value = session.data.clicks
	session.dirty = true
end

-- Names for the board. Players in the server are free; others are looked up once and remembered.
local nameCache: { [string]: string } = {}
local function nameFor(key: string): string
	local userId = tonumber(key)
	local online = userId and Players:GetPlayerByUserId(userId)
	if online then
		return online.Name
	end
	if not nameCache[key] then
		local ok, name = pcall(Players.GetNameFromUserIdAsync, Players, userId)
		nameCache[key] = if ok then name else "Player " .. key
	end
	return nameCache[key]
end

-- Start ---------------------------------------------------------------------

makeButton(onClick)
local showBoard = makeBoard()

local function onPlayerAdded(player: Player)
	local ok, err = pcall(loadPlayer, player)
	if not ok then
		warn("[Clicker] Couldn't load " .. player.Name .. ": " .. tostring(err))
		player:Kick("Couldn't load your data. Please rejoin.")
	end
end

Players.PlayerAdded:Connect(onPlayerAdded)
for _, player in Players:GetPlayers() do
	task.spawn(onPlayerAdded, player)
end

Players.PlayerRemoving:Connect(function(player)
	local ok, err = pcall(savePlayer, player, true)
	if not ok then
		warn("[Clicker] Couldn't save " .. player.Name .. " on leave: " .. tostring(err))
	end
end)

-- Autosave.
task.spawn(function()
	while true do
		task.wait(SAVE_EVERY)
		for player in sessions do
			task.spawn(function()
				local ok, err = pcall(savePlayer, player, false)
				if not ok then
					warn("[Clicker] Autosave failed for " .. player.Name .. ": " .. tostring(err))
				end
			end)
		end
	end
end)

-- Keep session locks alive while players are here.
task.spawn(function()
	while true do
		task.wait(LOCK_RENEW_EVERY)
		for player in sessions do
			task.spawn(function()
				local ok, stillOurs = pcall(playerData.LockAsync, playerData, tostring(player.UserId), LOCK_SECONDS)
				if ok and not stillOurs then
					warn("[Clicker] Lost the session lock for " .. player.Name)
				end
			end)
		end
	end
end)

-- Leaderboard.
task.spawn(function()
	while true do
		local ok, top = pcall(clickBoard.GetSortedAsync, clickBoard, false, 10)
		if ok then
			local entries = {}
			for _, entry in top do
				table.insert(entries, { name = nameFor(entry.key), clicks = entry.value })
			end
			showBoard(entries)
		else
			warn("[Clicker] Couldn't load the leaderboard: " .. tostring(top))
		end
		task.wait(BOARD_REFRESH_EVERY)
	end
end)

-- Save everyone when the server shuts down (including pressing Stop in Studio).
game:BindToClose(function()
	local pending = 0
	for player in sessions do
		pending += 1
		task.spawn(function()
			pcall(savePlayer, player, true)
			pending -= 1
		end)
	end
	local deadline = os.clock() + 20
	while pending > 0 and os.clock() < deadline do
		task.wait(0.1)
	end
end)

print("[Clicker] Ready. Click the green button!")
