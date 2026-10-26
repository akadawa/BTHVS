--[[
Multiplayer Co-op manager for Browser Theme Hospital
Handles room sync, remote cursors/pings, shared game speed, and co-op level transitions.
]]

corsixth.require("class")

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
  self.mode = "freebuild"
  self.level = "demo"
  self.seed = 12345
  self.rejoin = false
  self.remote_cursors = {}
  self.last_cursor_send = 0
  self.internal_speed_change = false
  self.clicked = false
  self.last_sync_time = 0
  self.font = nil
  self.hooks_installed = false
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
  self.name = sess.name or "Dr. Spieler"
  self.players = sess.players or {}
  self.host_id = sess.host
  self.is_host = (self.id == self.host_id)
  self.mode = sess.mode or "freebuild"
  self.level = sess.level or "demo"
  self.seed = sess.seed or 12345
  self.rejoin = sess.rejoin or false
  self.active = true

  print("================================================================")
  print(string.format("Multiplayer initialized: Room %s | ID %d | Host: %s | Mode: %s",
    self.code, self.id, tostring(self.is_host), self.mode))
  print("================================================================")

  -- Seed random generator deterministically across all peers
  math.randomseed(self.seed)

  -- Free build mode setting
  self.app.config.free_build_mode = (self.mode == "freebuild")

  self.web.call("ui.banner", "oKoop-Modus: Raum " .. self.code)
  self.web.call("ui.sync", "oSync")
  return true
end

function Multiplayer:installHooks()
  if self.hooks_installed then return end
  self.hooks_installed = true
  local mp = self

  local World = _G["World"] or corsixth.require("world")
  local UIEditRoom = _G["UIEditRoom"] or corsixth.require("dialogs.edit_room")

  -- Hook World:setSpeed to broadcast speed changes to peers
  if World and World.setSpeed then
    local orig_setSpeed = World.setSpeed
    World.setSpeed = function(world_self, speed)
      local res = orig_setSpeed(world_self, speed)
      if mp.active and not mp.internal_speed_change then
        mp.web.call("net.send", "all|speed:" .. tostring(speed))
      end
      return res
    end
  end

  -- Hook UIEditRoom:confirm so that when a room is finished, all peers get synced
  if UIEditRoom and UIEditRoom.confirm then
    local orig_confirm = UIEditRoom.confirm
    UIEditRoom.confirm = function(edit_self, force)
      local was_objects_phase = (edit_self.phase == "objects")
      local res = orig_confirm(edit_self, force)
      if mp.active and was_objects_phase and edit_self.closed_cleanly then
        if mp.is_host then
          TheApp:save("/tmp/snapshot_out.sav")
          mp.web.call("snap.send", "all|/tmp/snapshot_out.sav|room")
        else
          mp.web.call("net.send", mp.host_id .. "|room_built")
        end
      end
      return res
    end
  end
end

function Multiplayer:getPlayer(pid)
  for _, p in ipairs(self.players) do
    if p.id == pid then return p end
  end
  return nil
end

function Multiplayer:start()
  if not self.active then return false end

  self:installHooks()

  if self.rejoin then
    print("Multiplayer: Rejoining active game, requesting state snapshot...")
    self.web.call("net.send", self.host_id .. "|request_sync")
    self.web.call("ui.banner", "wLade Spielstand vom Host ...")
    return true
  end

  -- Start new game
  print("Multiplayer: Starting game (Level: " .. tostring(self.level) .. ", Mode: " .. self.mode .. ")")
  local success = false
  local err_prefix = _S and _S.errors and _S.errors.load_level_prefix or "Error: "

  if self.level == "demo" or self.app.using_demo_files then
    success = self.app:loadLevel(1, "full", nil, nil, nil, nil, err_prefix, nil)
  else
    local level_path = self.app:getFullPath("Levels", self.level .. ".level")
    local map_path = self.app:getFullPath("Levels", self.level .. ".map")
    local lfs = require("lfs")
    if lfs.attributes(level_path, "mode") == "file" then
      success = self.app:loadLevel(level_path, nil, self.level, map_path, nil, nil, err_prefix, nil)
    else
      success = self.app:loadLevel(1, "full", nil, nil, nil, nil, err_prefix, nil)
    end
  end

  if success and self.app.world then
    if self.mode == "freebuild" then
      self.app.world.free_build_mode = true
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        hosp.balance = 500000
      end
    end
    self.app.world:setSpeed("Normal")
  end

  return true
end

function Multiplayer:onTick()
  if not self.active then return end

  -- 1. Poll incoming messages
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

  -- 2. Send local cursor position periodically (~80ms)
  if self.app.ui and self.app.world and self.app.world.map then
    local now = self.web.now()
    if now - self.last_cursor_send > 80 then
      self.last_cursor_send = now
      local cx, cy = self.app.ui.cursor_x, self.app.ui.cursor_y
      if cx and cy then
        local wx, wy = self.app.ui:ScreenToWorld(cx, cy)
        if wx and wy and wx > 0 and wy > 0 then
          local click_flag = self.clicked and "1" or "0"
          self.clicked = false
          self.web.call("net.send", string.format("all|cur:%d,%d,%s", math.floor(wx), math.floor(wy), click_flag))
        end
      end
    end
  end
end

function Multiplayer:onClick()
  self.clicked = true
end

function Multiplayer:handleMessage(from, data)
  -- Snapshot received
  if data:sub(1, 9) == "snapshot:" then
    local meta = data:sub(10)
    print("Multiplayer: Snapshot received from player " .. tostring(from) .. " (meta=" .. meta .. ")")
    local cam_x, cam_y, cam_z
    if self.app.ui then
      cam_x = self.app.ui.screen_offset_x
      cam_y = self.app.ui.screen_offset_y
      cam_z = self.app.ui.zoom_factor
    end
    self.app:load("/tmp/snapshot_in.sav")
    if self.app.ui and cam_x then
      self.app.ui.screen_offset_x = cam_x
      self.app.ui.screen_offset_y = cam_y
      self.app.ui.zoom_factor = cam_z
    end
    self.web.call("ui.sync", "oSync")
    self.web.call("ui.banner", "oSpielstand synchronisiert")
    return
  end

  -- Sync request (guest asked host for snapshot)
  if data == "request_sync" or data == "room_built" then
    if self.is_host then
      print("Multiplayer: Sending state snapshot to " .. tostring(from) .. "...")
      TheApp:save("/tmp/snapshot_out.sav")
      local target = (data == "room_built") and "all" or tostring(from)
      self.web.call("snap.send", target .. "|/tmp/snapshot_out.sav|sync")
    end
    return
  end

  -- Speed change
  if data:sub(1, 6) == "speed:" then
    local speed_name = data:sub(7)
    if self.app.world and not self.internal_speed_change then
      self.internal_speed_change = true
      self.app.world:setSpeed(speed_name)
      self.internal_speed_change = false
      local p = self:getPlayer(from)
      local name = p and p.name or "Partner"
      self.web.call("ui.banner", "oTempo: " .. speed_name .. " (" .. name .. ")")
    end
    return
  end

  -- Cursor position / ping
  if data:sub(1, 4) == "cur:" then
    local x, y, click = data:match("cur:(%d+),(%d+),(%d+)")
    if x and y then
      local p = self:getPlayer(from)
      self.remote_cursors[from] = {
        wx = tonumber(x),
        wy = tonumber(y),
        click = (click == "1"),
        time = self.web.now(),
        name = p and p.name or "Partner",
      }
    end
    return
  end

  -- Level transition
  if data:sub(1, 6) == "level:" then
    local next_level = data:sub(7)
    print("Multiplayer: Transitioning to level " .. next_level)
    self.level = next_level
    local err_prefix = _S and _S.errors and _S.errors.load_level_prefix or "Error: "
    self.app:loadLevel(next_level, "full", nil, nil, nil, nil, err_prefix, nil)
    return
  end

  -- Peers update
  if data:sub(1, 6) == "peers:" then
    return
  end
end

-- Render remote cursors, teammate nameplates and click pings on screen
function Multiplayer:draw(canvas, ui)
  if not self.active or not ui or not self.web then return end

  if not self.font then
    self.font = self.app.gfx:loadBuiltinFont()
  end

  local now = self.web.now()
  local col_pin = canvas:mapRGB(25, 181, 165)
  local col_white = canvas:mapRGB(255, 255, 255)
  local col_ping = canvas:mapRGB(224, 165, 38)
  local col_bg = canvas:mapRGB(14, 26, 34)

  for pid, c in pairs(self.remote_cursors) do
    if now - c.time < 5000 then
      local sx, sy = ui:WorldToScreen(c.wx, c.wy)
      if sx and sy and sx >= -50 and sx <= self.app.config.width + 50 and
         sy >= -50 and sy <= self.app.config.height + 50 then

        -- Draw cursor pin
        canvas:drawRect(col_pin, sx - 4, sy - 4, 9, 9)
        canvas:drawRect(col_white, sx - 2, sy - 2, 5, 5)

        -- Draw teammate name tag
        if self.font then
          local tag = "[" .. c.name .. "]"
          canvas:drawRect(col_bg, sx + 6, sy - 14, #tag * 7 + 4, 14)
          self.font:draw(canvas, tag, sx + 8, sy - 13)
        end

        -- Draw click ping animation (expanding ring)
        if c.click and (now - c.time < 1200) then
          local elapsed = (now - c.time) / 1200
          local r = math.floor(10 + elapsed * 30)
          canvas:drawRect(col_ping, sx - r, sy - r, r * 2, 2)
          canvas:drawRect(col_ping, sx - r, sy + r - 2, r * 2, 2)
          canvas:drawRect(col_ping, sx - r, sy - r, 2, r * 2)
          canvas:drawRect(col_ping, sx + r - 2, sy - r, 2, r * 2)
        end
      end
    end
  end
end

return Multiplayer
