--[[
Versus / Rival Hospital Multiplayer Manager for Browser Theme Hospital (CorsixTH v0.70.2)
Each player manages their own hospital in real-time, racing to complete the match goals.
]]

corsixth.require("class")

local function clean_name(s)
  if not s then return "Player" end
  s = tostring(s)
  s = s:gsub("<LocalisedString>%s*Current value:%s*", "")
  s = s:gsub("<LocalisedString>", "")
  s = s:gsub("Current value:%s*", "")
  s = s:match("^%s*(.-)%s*$")
  if not s or s == "" then return "Player" end
  return s
end

class "Multiplayer"

function Multiplayer:Multiplayer(app)
  self.app = app
  self.active = false
  self.session = nil
  self.id = nil
  self.code = nil
  self.name = "Player"
  self.players = {}
  self.host_id = nil
  self.is_host = false
  self.goal = "money_50k"
  self.level = "demo"
  self.seed = 12345
  self.rejoin = false
  self.sim_started = false
  self.match_end_paused = false
  self.internal_speed_change = false
  self.last_stats_send = 0
  self.last_force_send = 0
  self.last_payload = nil
  self.hooks_installed = false
  self.font = nil
end

function Multiplayer:init()
  local ok, web = pcall(require, "web")
  if not ok or not web or not web.call then
    return false
  end
  self.web = web
  local sess_str = web.call("mp.session")
  if not sess_str or sess_str == "" then
    return false
  end
  local loader = load(sess_str)
  if not loader then
    print("Multiplayer: Failed to parse mp.session string: " .. tostring(sess_str))
    return false
  end
  local sess = loader()
  if not sess or not sess.code then
    return false
  end

  self.session = sess
  self.id = sess.id
  self.code = sess.code
  self.name = clean_name(sess.name or "Player")
  self.players = sess.players or {}
  self.host_id = sess.host
  self.is_host = (self.id == self.host_id)
  self.goal = sess.goal or "money_50k"
  self.level = sess.level or "demo"
  self.seed = sess.seed or 12345
  self.rejoin = sess.rejoin or false
  self.active = true

  print("================================================================")
  print(string.format("Versus Multiplayer initialized: Room %s | ID %d | Host: %s | Goal: %s",
    self.code, self.id, tostring(self.is_host), self.goal))
  print("================================================================")

  -- Deterministic RNG seed for identical starting layout and prices
  math.randomseed(self.seed)

  -- Always keep real economy active and allow local actions even while paused
  self.app.config.free_build_mode = false
  self.app.config.allow_user_actions_while_paused = true

  self.web.call("ui.banner", "oVersus Match: Room " .. self.code)
  self.web.call("ui.sync", "oSync")
  return true
end

function Multiplayer:installHooks()
  if self.hooks_installed then return end
  self.hooks_installed = true
  local mp = self

  local World = _G["World"] or corsixth.require("world")
  local UIStaffRise = _G["UIStaffRise"] or corsixth.require("dialogs.staff_rise")

  -- Disable staff rise pause dialog interrupting the game loop in multiplayer
  if UIStaffRise then
    UIStaffRise.mustPause = function() return false end
  end

  -- Prevent local faxes, annual reports, or dialogs from forcing global match pause
  if World then
    local orig_mustPause = World.mustPause
    World.mustPause = function(world_self)
      if mp.active then return false end
      return orig_mustPause and orig_mustPause(world_self) or false
    end

    local orig_mustPauseWindowAdd = World.mustPauseWindowAdd
    World.mustPauseWindowAdd = function(world_self)
      if mp.active then return end
      if orig_mustPauseWindowAdd then return orig_mustPauseWindowAdd(world_self) end
    end

    local orig_mustPauseWindowRemoved = World.mustPauseWindowRemoved
    World.mustPauseWindowRemoved = function(world_self)
      if mp.active then return end
      if orig_mustPauseWindowRemoved then return orig_mustPauseWindowRemoved(world_self) end
    end
  end

  -- Synchronize game speed between competitors so the race is fair
  if World and World.setSpeed then
    local orig_setSpeed = World.setSpeed
    World.setSpeed = function(world_self, speed)
      -- BTHVS: Game speed can only be "Normal" or "Pause"
      if speed ~= "Pause" and speed ~= "Normal" then
        speed = "Normal"
      end
      if mp.match_end_paused then
        speed = "Pause"
      end
      local res = orig_setSpeed(world_self, speed)
      -- Always guarantee user actions remain allowed and blue pause filter stays off in MP
      world_self.user_actions_allowed = true
      if world_self.updateScreenBlueFilter then
        world_self:updateScreenBlueFilter()
      end
      if mp.active and not mp.internal_speed_change then
        mp.web.call("net.send", "all|speed:" .. tostring(speed))
      end
      return res
    end
  end
end

function Multiplayer:getPlayer(id)
  for _, p in ipairs(self.players) do
    if p.id == id then return p end
  end
  return nil
end

function Multiplayer:start()
  if not self.active then return false end

  self:installHooks()

  print(string.format("Multiplayer: Starting Versus game (Level: %s, Goal: %s)", tostring(self.level), tostring(self.goal)))
  local success = false
  local err_prefix = _S and _S.errors and _S.errors.load_level_prefix or "Error: "

  local is_custom = false
  local level_path, map_path
  if self.level and self.level ~= "" and self.level ~= "demo" and not self.level:match("^level%d+$") then
    level_path = self.app:getFullPath({"Levels", self.level .. ".level"})
    map_path = self.app:getFullPath({"Levels", self.level .. ".map"})
    local lfs = require("lfs")
    if lfs and level_path and map_path and lfs.attributes(level_path, "mode") == "file" and lfs.attributes(map_path, "mode") == "file" then
      is_custom = true
    end
  end

  if is_custom then
    print("Multiplayer: Loading custom level " .. tostring(self.level) .. " from " .. tostring(level_path))
    success = self.app:loadLevel(level_path, nil, self.level, map_path, nil, nil, err_prefix, nil)
  elseif self.level and self.level:match("^level(%d+)$") and not self.app.using_demo_files then
    local num = tonumber(self.level:match("^level(%d+)$"))
    print("Multiplayer: Loading original campaign level " .. tostring(num))
    success = self.app:loadLevel(num, "full", nil, nil, nil, nil, err_prefix, nil)
  else
    print("Multiplayer: Loading demo / level 1")
    local demo_level = self.app:getFullPath({"Levels", "demo.level"})
    local demo_map = self.app:getFullPath({"Levels", "demo.map"})
    local lfs = require("lfs")
    if lfs and demo_level and demo_map and lfs.attributes(demo_level, "mode") == "file" and lfs.attributes(demo_map, "mode") == "file" then
      success = self.app:loadLevel(demo_level, nil, "demo", demo_map, nil, nil, err_prefix, nil)
    else
      success = self.app:loadLevel(1, "full", nil, nil, nil, nil, err_prefix, nil)
    end
  end

  if not success then
    print("Multiplayer: Failed to load level " .. tostring(self.level) .. ", falling back to level 1")
    self.app:loadLevel(1, "full", nil, nil, nil, nil, err_prefix, nil)
  end

  -- Versus mode: Each player manages their own hospital locally.
  -- Actions are immediately allowed, simulation runs at Normal speed.
  if self.app.world then
    self.app.world.user_actions_allowed = true
    self.internal_speed_change = true
    self.app.world:setSpeed("Normal")
    self.internal_speed_change = false
    if self.app.world.updateScreenBlueFilter then
      self.app.world:updateScreenBlueFilter()
    end
  end

  -- Close any modal information / briefing windows that opened during level load
  if self.app.ui then
    for _, win in ipairs(self.app.ui.windows or {}) do
      if win.modal_class == "information" then
        win:close()
      end
    end
  end

  self.sim_started = true
  -- Signal to server that this client's engine is loaded and ready
  self.web.call("game.ready", "")
  self.web.call("ui.banner", "oMatch started! Build your hospital and complete the goals!")
  return true
end

function Multiplayer:onTick()
  if not self.active then return end

  -- 1. Poll incoming network messages
  while true do
    local raw = self.web.call("net.poll")
    if not raw or raw == "" then break end
    local sep = raw:find("|")
    if sep then
      local from = tonumber(raw:sub(1, sep - 1))
      local data = raw:sub(sep + 1)
      self:handleMessage(from, data)
    end
  end

  -- 2. Periodically send local hospital telemetry (~1000ms, deduplicated if unchanged)
  local now = self.web.now()
  if self.app.world and (now - self.last_stats_send > 1000) then
    self.last_stats_send = now
    local hosp = self.app.world:getLocalPlayerHospital()
    if hosp then
      local bal = math.floor(hosp.balance or 0)
      local rep = math.floor(hosp.reputation or 500)
      local cured = math.floor(hosp.num_cured or 0)
      local deaths = math.floor(hosp.num_deaths or 0)
      local val = math.floor(hosp.value or 0)

      local staff_count = 0
      if hosp.staff then
        for _, s in ipairs(hosp.staff) do
          if not s.fired then staff_count = staff_count + 1 end
        end
      end

      local room_count = 0
      if self.app.world.rooms then
        for _, r in pairs(self.app.world.rooms) do
          if r.built ~= false then room_count = room_count + 1 end
        end
      end

      local payload = string.format("%d,%d,%d,%d,%d,%d,%d", bal, rep, room_count, staff_count, cured, deaths, val)
      if payload ~= self.last_payload then
        self.last_payload = payload
        self.last_force_send = now
        self.web.call("net.send", "all|vstats:" .. payload)
        self.web.call("vs.mystats", payload)
      elseif (now - self.last_force_send > 5000) then
        self.last_force_send = now
        self.web.call("net.send", "all|vstats:" .. payload)
      end
    end
  end
end

function Multiplayer:handleMessage(from, data)
  -- Synchronized start barrier
  if data == "start_sim" then
    print("Multiplayer: Both engines ready on tick 0! Starting Versus match now.")
    self.sim_started = true
    if self.app.world then
      self.app.world.user_actions_allowed = true
      self.internal_speed_change = true
      self.app.world:setSpeed("Normal")
      self.internal_speed_change = false
      if self.app.world.updateScreenBlueFilter then
        self.app.world:updateScreenBlueFilter()
      end
    end
    self.web.call("ui.banner", "oMatch started! Be the first to complete the goals!")
    return
  end

  -- Opponent live stats telemetry
  if data:sub(1, 7) == "vstats:" then
    local payload = data:sub(8)
    self.web.call("vs.oppstats", tostring(from) .. "|" .. payload)
    return
  end

  -- Speed change sync
  if data:sub(1, 6) == "speed:" then
    if self.match_end_paused then
      return
    end
    local speed_name = data:sub(7)
    if speed_name ~= "Pause" and speed_name ~= "Normal" then
      speed_name = "Normal"
    end
    if self.app.world and not self.internal_speed_change then
      self.internal_speed_change = true
      self.app.world:setSpeed(speed_name)
      self.app.world.user_actions_allowed = true
      if self.app.world.updateScreenBlueFilter then
        self.app.world:updateScreenBlueFilter()
      end
      self.internal_speed_change = false
      local p = self:getPlayer(from)
      local name = p and p.name or "Rival"
      if speed_name == "Pause" then
        self.web.call("ui.banner", "wPause (" .. name .. ")")
      else
        self.web.call("ui.banner", "oNormal (" .. name .. ")")
      end
    end
    return
  end

  -- Match victory notification
  if data:sub(1, 4) == "win:" then
    local winner_info = data:sub(5)
    self.web.call("vs.win", winner_info)
    return
  end
end

function Multiplayer:onClick()
  -- Safe no-op for UI mouse interactions
end

function Multiplayer:draw(canvas, ui)
  -- In Versus, each player manages their own hospital independently.
  -- Visual telemetry is rendered smoothly via the HTML/Canvas Quest-Block and HUD overlay.
end

return Multiplayer
