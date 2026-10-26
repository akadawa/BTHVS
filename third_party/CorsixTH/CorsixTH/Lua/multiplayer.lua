--[[
Multiplayer Co-op manager for Browser Theme Hospital
Handles room sync, remote cursors/pings, shared game speed, staff/object sync, and shared finances.
]]

corsixth.require("class")

local function clean_name(s)
  if not s then return "Staff" end
  s = tostring(s)
  s = s:gsub("<LocalisedString>%s*Current value:%s*", "")
  s = s:gsub("<LocalisedString>", "")
  s = s:gsub("Current value:%s*", "")
  s = s:match("^%s*(.-)%s*$")
  if not s or s == "" then return "Staff" end
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
  self.mode = "freebuild"
  self.level = "demo"
  self.seed = 12345
  self.rejoin = false
  self.remote_cursors = {}
  self.last_cursor_send = 0
  self.last_balance_send = 0
  self.last_hums_send = 0
  self.sim_started = false
  self.internal_speed_change = false
  self.internal_action = false
  self.pending_snapshot = false
  self.clicked = false
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

  -- Always keep real economy enabled so room building and staff hiring cost money!
  self.app.config.free_build_mode = false

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
  local UIPlaceObjects = _G["UIPlaceObjects"] or corsixth.require("dialogs.place_objects")
  local UIPlaceStaff = _G["UIPlaceStaff"] or corsixth.require("dialogs.place_staff")
  local Staff = _G["Staff"] or corsixth.require("entities.humanoids.staff")
  local Handyman = _G["Handyman"] or corsixth.require("entities.humanoids.staff.handyman")
  local UIStaffRise = _G["UIStaffRise"] or corsixth.require("dialogs.staff_rise")
  local UIFax = _G["UIFax"] or corsixth.require("dialogs.fullscreen.fax")

  -- Ensure all entities created in the world have a unique integer ID
  if World and World.newEntity then
    local orig_newEntity = World.newEntity
    World.newEntity = function(world_self, class_name, animation, mood_marker)
      local entity = orig_newEntity(world_self, class_name, animation, mood_marker)
      if entity and not entity.id then
        world_self.next_entity_id = (world_self.next_entity_id or 1000) + 1
        entity.id = world_self.next_entity_id
      end
      return entity
    end
  end

  -- Prevent modal salary raise and fax dialogs from pausing multiplayer
  if UIStaffRise then
    UIStaffRise.mustPause = function(sr_self)
      if mp.active then return false end
      return true
    end
  end
  if UIFax then
    UIFax.mustPause = function(fax_self)
      if mp.active then return false end
      return true
    end
  end

  -- Prevent system pause in multiplayer
  if World and World.setSystemPause then
    local orig_setSystemPause = World.setSystemPause
    World.setSystemPause = function(world_self, state)
      if mp.active then
        world_self.system_pause = false
        return
      end
      return orig_setSystemPause(world_self, state)
    end
  end

  -- Prevent staff salary raise requests from triggering local strikes in co-op
  if Staff and Staff.requestRaise then
    local orig_requestRaise = Staff.requestRaise
    Staff.requestRaise = function(staff_self)
      if mp.active then
        staff_self.timer_until_raise = nil
        return
      end
      return orig_requestRaise(staff_self)
    end
  end

  -- Host-authoritative patient generation
  if World and World.spawnPatient then
    local orig_spawnPatient = World.spawnPatient
    World.spawnPatient = function(world_self, hospital)
      if not mp.active then
        return orig_spawnPatient(world_self, hospital)
      end
      if mp.is_host then
        mp.internal_action = true
        local patient = orig_spawnPatient(world_self, hospital)
        mp.internal_action = false
        if patient and patient.disease then
          local d_id = tostring(patient.disease.id)
          local sx = patient.tile_x
          local sy = patient.tile_y
          local act = patient.getNextAction and patient:getNextAction()
          if (not sx or not sy) and act and act.point then
            sx = act.point.x
            sy = act.point.y
          end
          sx = sx or 1
          sy = sy or 1
          local p_id = patient.id
          print(string.format("Multiplayer: Host spawned patient %d (disease=%s, sx=%d, sy=%d), broadcasting...", p_id, d_id, sx, sy))
          mp.web.call("net.send", string.format("all|spawnp:%d,%s,%d,%d", p_id, d_id, sx, sy))
        end
        return patient
      else
        if mp.internal_action then
          return orig_spawnPatient(world_self, hospital)
        end
        return nil
      end
    end
  end

  -- Host-authoritative VIP generation
  if World and World.spawnVIP then
    local orig_spawnVIP = World.spawnVIP
    World.spawnVIP = function(world_self, name)
      if not mp.active then return orig_spawnVIP(world_self, name) end
      if mp.is_host then
        local vip = orig_spawnVIP(world_self, name)
        if vip then
          mp.web.call("net.send", string.format("all|spawnvip:%d,%s", vip.id, name or "VIP"))
        end
        return vip
      else
        if mp.internal_action then return orig_spawnVIP(world_self, name) end
        return nil
      end
    end
  end

  -- Host-authoritative handyman task assignment
  if Handyman and Handyman.assignHandymanTask then
    local orig_assignTask = Handyman.assignHandymanTask
    Handyman.assignHandymanTask = function(hm_self, taskIndex, taskType)
      local res = orig_assignTask(hm_self, taskIndex, taskType)
      if mp.active and mp.is_host and not mp.internal_action and hm_self.task then
        local ox = hm_self.task.tile_x or 0
        local oy = hm_self.task.tile_y or 0
        mp.web.call("net.send", string.format("all|hmtask:%d,%s,%d,%d", hm_self.id, taskType, ox, oy))
      end
      return res
    end
  end

  -- 1. Hook World:setSpeed to broadcast speed changes to peers
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

  -- Hook World:loseGame so freebuild mode never loses the game
  if World and World.loseGame then
    local orig_loseGame = World.loseGame
    World.loseGame = function(world_self, player_no, reason, limit)
      if mp.active and mp.mode == "freebuild" then
        return
      end
      return orig_loseGame(world_self, player_no, reason, limit)
    end
  end

  -- 2. Hook UIEditRoom:confirm and close so finished rooms are synced to peers without overwriting the builder
  if UIEditRoom then
    if UIEditRoom.confirm then
      local orig_confirm = UIEditRoom.confirm
      UIEditRoom.confirm = function(edit_self, force)
        local was_objects_phase = (edit_self.phase == "objects")
        local res = orig_confirm(edit_self, force)
        if mp.active and was_objects_phase and edit_self.closed_cleanly then
          -- Save current state containing the new room and broadcast to all peers
          TheApp:save("/tmp/snapshot_out.sav")
          mp.web.call("snap.send", "all|/tmp/snapshot_out.sav|room")
          mp.web.call("ui.banner", "oNeuer Raum fertiggestellt & geteilt!")

          local r_name = "Raum"
          if edit_self.room and edit_self.room.room_info and edit_self.room.room_info.name then
            r_name = clean_name(edit_self.room.room_info.name)
          elseif edit_self.room_type and edit_self.room_type.name then
            r_name = clean_name(edit_self.room_type.name)
          elseif edit_self.title_text then
            r_name = clean_name(edit_self.title_text)
          end
          local r_cost = 0
          if edit_self.ui and edit_self.ui.hospital and edit_self.ui.hospital.research and edit_self.ui.hospital.research.research_progress and edit_self.room and edit_self.room.room_info then
            r_cost = edit_self.ui.hospital.research.research_progress[edit_self.room.room_info].build_cost or 0
          end
          local p_name = clean_name(mp.name)
          local payload = string.format("room|%s|%s|%d", p_name, r_name, r_cost)
          mp.web.call("hist.record", payload)
          mp.web.call("net.send", "all|hist:" .. payload)
        end
        return res
      end
    end

    if UIEditRoom.close then
      local orig_close = UIEditRoom.close
      UIEditRoom.close = function(edit_self)
        local res = orig_close(edit_self)
        if mp.pending_snapshot then
          mp.pending_snapshot = false
          mp:applySnapshot(nil, "pending_room")
        end
        return res
      end
    end
  end

  -- 3. Hook UIPlaceObjects:placeObject for corridor items (benches, plants, drinks, etc.)
  if UIPlaceObjects and UIPlaceObjects.placeObject then
    local orig_placeObject = UIPlaceObjects.placeObject
    UIPlaceObjects.placeObject = function(po_self, dont_close)
      local obj_data = po_self.objects[po_self.active_index]
      local is_corridor = (not po_self.room)
      local obj_id = obj_data and obj_data.object and obj_data.object.id
      local ox = po_self.object_cell_x
      local oy = po_self.object_cell_y
      local orient = po_self.object_orientation

      local res = orig_placeObject(po_self, dont_close)

      if mp.active and is_corridor and obj_id and ox and oy and not mp.internal_action then
        mp.web.call("net.send", string.format("all|obj:%s,%d,%d,%s", obj_id, ox, oy, orient))
        local obj_name = obj_data and obj_data.object and clean_name(obj_data.object.name)
        local cost = 0
        if po_self.ui and po_self.ui.hospital and po_self.ui.hospital.getObjectBuildCost then
          cost = po_self.ui.hospital:getObjectBuildCost(obj_id) or 0
        end
        local label = obj_name or obj_id
        local p_name = clean_name(mp.name)
        local payload = string.format("obj|%s|%s|%d|%d|%d", p_name, label, cost, ox, oy)
        mp.web.call("hist.record", payload)
        mp.web.call("net.send", "all|hist:" .. payload)
      end
      return res
    end
  end

  -- 4. Hook UIPlaceStaff:onMouseUp for hiring new staff and moving existing staff
  if UIPlaceStaff and UIPlaceStaff.onMouseUp then
    local orig_staffMouseUp = UIPlaceStaff.onMouseUp
    UIPlaceStaff.onMouseUp = function(ps_self, button, x, y)
      if ps_self.world.user_actions_allowed and button == "left" then
        local valid = ps_self:_isValidStaffPlacement()
        local is_new_hire = (ps_self.staff == nil and ps_self.profile ~= nil)
        local prof = ps_self.profile
        local tx = ps_self.tile_x
        local ty = ps_self.tile_y
        local existing_staff = ps_self.staff

        local res = orig_staffMouseUp(ps_self, button, x, y)

        if mp.active and valid and not mp.internal_action then
          if is_new_hire and prof then
            local hosp = ps_self.ui and ps_self.ui.hospital or (ps_self.world and ps_self.world:getLocalPlayerHospital())
            local placed_entity_id = (hosp and hosp.staff and hosp.staff[#hosp.staff]) and hosp.staff[#hosp.staff].id or 0
            local is_psy = (type(prof.is_psychiatrist) == "number" and prof.is_psychiatrist >= 1.0 or prof.is_psychiatrist == true) and 1 or 0
            local is_sur = (type(prof.is_surgeon) == "number" and prof.is_surgeon >= 1.0 or prof.is_surgeon == true) and 1 or 0
            local is_res = (type(prof.is_researcher) == "number" and prof.is_researcher >= 1.0 or prof.is_researcher == true) and 1 or 0
            local payload = string.format("hire:%s|%s|%d|%.2f|%d|%d|%d|%d|%d|%d|%d|%d|%d",
              prof.humanoid_class,
              clean_name(prof.name),
              prof.wage or 100,
              prof.skill or 0.5,
              prof.layer5 or 2,
              is_psy,
              is_sur,
              is_res,
              prof.is_junior and 1 or 0,
              prof.is_consultant and 1 or 0,
              tx, ty,
              placed_entity_id)
            mp.web.call("net.send", "all|" .. payload)
            local role_de = prof.humanoid_class == "Doctor" and "Arzt"
              or prof.humanoid_class == "Nurse" and "Krankenschwester"
              or prof.humanoid_class == "Handyman" and "Hausmeister"
              or prof.humanoid_class == "Receptionist" and "Rezeptionistin"
              or prof.humanoid_class
            local sname = clean_name(prof.name)
            local wage = prof.wage or 100
            local p_name = clean_name(mp.name)
            local hist_payload = string.format("hire|%s|%s|%s|%d", p_name, role_de, sname, wage)
            mp.web.call("hist.record", hist_payload)
            mp.web.call("net.send", "all|hist:" .. hist_payload)
          elseif existing_staff and existing_staff.id then
            mp.web.call("net.send", string.format("all|movestaff:%d,%d,%d", existing_staff.id, tx, ty))
          end
        end
        return res
      end
      return orig_staffMouseUp(ps_self, button, x, y)
    end
  end

  -- 5. Hook Staff:fire to replicate staff firing
  if Staff and Staff.fire then
    local orig_fire = Staff.fire
    Staff.fire = function(staff_self)
      local sid = staff_self.id
      local sname = staff_self.profile and clean_name(staff_self.profile.name) or "Personal"
      local res = orig_fire(staff_self)
      if mp.active and sid and not mp.internal_action then
        mp.web.call("net.send", string.format("all|fire:%d|%s", sid, sname))
        local role_de = staff_self.humanoid_class == "Doctor" and "Arzt"
          or staff_self.humanoid_class == "Nurse" and "Krankenschwester"
          or staff_self.humanoid_class == "Handyman" and "Hausmeister"
          or staff_self.humanoid_class == "Receptionist" and "Rezeptionistin"
          or "Personal"
        local p_name = clean_name(mp.name)
        local hist_payload = string.format("fire|%s|%s|%s", p_name, role_de, sname)
        mp.web.call("hist.record", hist_payload)
        mp.web.call("net.send", "all|hist:" .. hist_payload)
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

  -- Check if any player in the session has demo files
  local session_has_demo = false
  if self.players then
    for _, p in ipairs(self.players) do
      if p.demo then session_has_demo = true break end
    end
  end
  if self.app.using_demo_files then session_has_demo = true end

  -- If any participant uses demo, only the demo level is safe and permitted
  if session_has_demo and self.level and self.level ~= "demo" and self.level ~= "" then
    print("Multiplayer: Demo participant detected in session, overriding map to demo")
    self.level = "demo"
  end

  local is_custom = false
  local level_path, map_path
  if self.level and self.level ~= "" and self.level ~= "demo" and not self.level:match("^level%d+$") then
    level_path = self.app:getFullPath({"Levels", self.level .. ".level"})
    map_path = self.app:getFullPath({"Levels", self.level .. ".map"})
    local lfs = require("lfs")
    if lfs.attributes(level_path, "mode") == "file" and lfs.attributes(map_path, "mode") == "file" then
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
    print("Multiplayer: Loading demo level")
    local demo_level = self.app:getFullPath({"Levels", "demo.level"})
    local demo_map = self.app:getFullPath({"Levels", "demo.map"})
    local lfs = require("lfs")
    if lfs.attributes(demo_level, "mode") == "file" and lfs.attributes(demo_map, "mode") == "file" then
      success = self.app:loadLevel(demo_level, nil, "demo", demo_map, nil, nil, err_prefix, nil)
    else
      success = self.app:loadLevel(1, "full", nil, nil, nil, nil, err_prefix, nil)
    end
  end

  if success and self.app.world then
    -- Ensure prices and build costs remain active (not $0 cheat mode)
    self.app.world.free_build_mode = false
    self.app.world.debug_disable_salary_raise = true
    local hosp = self.app.world:getLocalPlayerHospital()
    if self.mode == "freebuild" then
      -- Endlosmodus: Start with generous co-op budget ($200,000) so building costs money without fear of bankruptcy
      if hosp then
        hosp.balance = 200000
      end
    else
      -- Level-Modus: Campaign starting balance (Level 1: $40,000)
    end
    -- In multiplayer, hold game paused until all players have loaded on tick 0
    self.app.world:setSpeed("Pause")
    self.app.world.user_actions_allowed = false
    self.web.call("ui.banner", "wWarte auf Mitspieler …")
    self.web.call("game.ready", "1")
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
  local now = self.web.now()
  if self.app.ui and self.app.world and self.app.world.map then
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

  -- 3. Host periodically syncs authoritative bank balance and in-game date (~2s)
  if self.is_host and (now - self.last_balance_send > 2000) then
    self.last_balance_send = now
    if self.app.world and self.app.world.ui and self.app.world.ui.hospital then
      local bal = self.app.world.ui.hospital.balance
      local d = self.app.world.game_date
      if d then
        self.web.call("net.send", string.format("all|syncstate:%d,%d,%d,%d,%d", bal, d:year(), d:monthOfYear(), d:dayOfMonth(), d:hourOfDay()))
      else
        self.web.call("net.send", "all|balance:" .. tostring(bal))
      end
    end
  end

  -- 4. Host periodically sends humanoid positions (~1500ms)
  if self.is_host and (now - self.last_hums_send > 1500) then
    self.last_hums_send = now
    if self.app.world and self.app.world.entities then
      local parts = {}
      local Humanoid = _G["Humanoid"] or corsixth.require("entities.humanoid")
      for _, e in ipairs(self.app.world.entities) do
        if class.is(e, Humanoid) and e.id and e.tile_x and e.tile_y then
          table.insert(parts, string.format("%d:%d,%d", e.id, e.tile_x, e.tile_y))
        end
      end
      if #parts > 0 then
        self.web.call("net.send", "all|hums:" .. table.concat(parts, ";"))
      end
    end
  end
end

function Multiplayer:onClick()
  self.clicked = true
end

function Multiplayer:applySnapshot(from, meta)
  print("Multiplayer: Applying snapshot (meta=" .. tostring(meta) .. ")")
  local cam_x, cam_y, cam_z
  if self.app.ui then
    cam_x = self.app.ui.screen_offset_x
    cam_y = self.app.ui.screen_offset_y
    cam_z = self.app.ui.zoom_factor or 1
  end
  local ok, err = pcall(function()
    self.app:load("/tmp/snapshot_in.sav")
  end)
  if not ok then
    print("Multiplayer: Error loading snapshot: " .. tostring(err))
    self.web.call("ui.banner", "eFehler beim Synchronisieren")
    return
  end
  if self.app.ui then
    if cam_x then self.app.ui.screen_offset_x = cam_x end
    if cam_y then self.app.ui.screen_offset_y = cam_y end
    self.app.ui.zoom_factor = cam_z or self.app.ui.zoom_factor or 1
  end
  if self.app.world then
    self.app.world.free_build_mode = false
    self.app.world.debug_disable_salary_raise = true
  end
  self.web.call("ui.sync", "oSync")
  self.web.call("ui.banner", "oSpielstand synchronisiert")
end

function Multiplayer:handleMessage(from, data)
  -- 0. Synchronized Start Barrier
  if data == "start_sim" then
    print("Multiplayer: Both engines ready on tick 0! Starting simulation now.")
    self.sim_started = true
    if self.app.world then
      self.app.world.user_actions_allowed = true
      self.internal_speed_change = true
      self.app.world:setSpeed("Normal")
      self.internal_speed_change = false
    end
    self.web.call("ui.banner", "oSpiel gestartet!")
    return
  end

  -- 1. Snapshot received
  if data:sub(1, 9) == "snapshot:" then
    local meta = data:sub(10)
    local UIEditRoom = _G["UIEditRoom"]
    if self.app.ui and UIEditRoom and self.app.ui:getWindow(UIEditRoom) then
      print("Multiplayer: Postponing snapshot load because UIEditRoom is open")
      self.pending_snapshot = true
      self.web.call("ui.banner", "wPartner hat gebaut – Synchronisation nach Raumabschluss")
      return
    end
    self:applySnapshot(from, meta)
    return
  end

  -- 2. Initial sync request (new/rejoining guest asks host)
  if data == "request_sync" then
    if self.is_host then
      print("Multiplayer: Sending state snapshot to " .. tostring(from) .. "...")
      TheApp:save("/tmp/snapshot_out.sav")
      self.web.call("snap.send", tostring(from) .. "|/tmp/snapshot_out.sav|sync")
    end
    return
  end

  -- 3. Corridor object placement
  if data:sub(1, 4) == "obj:" then
    local obj_id, x, y, orient = data:match("obj:([^,]+),(%d+),(%d+),(%w+)")
    if obj_id and x and y and orient and self.app.world then
      x, y = tonumber(x), tonumber(y)
      local hosp = self.app.world:getLocalPlayerHospital()
      local obj_info = self.app.objects and self.app.objects[obj_id]
      if hosp and obj_info and obj_info.orientations and obj_info.orientations[orient] then
        self.internal_action = true
        local footprint = obj_info.orientations[orient].footprint
        self.app.world:prepareFootprintTilesForBuild(footprint, x, y)
        local obj = self.app.world:newObject(obj_id, x, y, orient)
        if obj then
          self.app.world:objectPlaced(obj)
          local cost = hosp:getObjectBuildCost(obj_id)
          hosp:spendMoney(cost, tostring(_S.transactions.buy_object) .. ": " .. tostring(obj_info.name), cost)
          self.web.call("ui.banner", "oPartner platziert: " .. tostring(obj_info.name))
        end
        self.internal_action = false
      end
    end
    return
  end

  -- 4. Staff hiring
  if data:sub(1, 5) == "hire:" then
    print("Multiplayer: Received hire message from " .. tostring(from))
    local parts = {}
    for part in (data:sub(6) .. "|"):gmatch("([^|]*)|") do
      table.insert(parts, part)
    end
    local class_name = parts[1]
    local name = parts[2]
    local wage = tonumber(parts[3]) or 100
    local skill = tonumber(parts[4]) or 0.5
    local layer5 = tonumber(parts[5]) or 2
    local psych = (parts[6] == "1") and 1.0 or 0.0
    local surg = (parts[7] == "1") and 1.0 or 0.0
    local resr = (parts[8] == "1") and 1.0 or 0.0
    local jun = (parts[9] == "1")
    local cons = (parts[10] == "1")
    local tx = tonumber(parts[11])
    local ty = tonumber(parts[12])

    if class_name and tx and ty and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        local StaffProfile = _G["StaffProfile"] or corsixth.require("staff_profile")
        local profile = StaffProfile(self.app.world, class_name)
        profile.name = clean_name(name)
        profile.wage = wage
        profile.skill = skill
        profile.layer5 = layer5
        profile.is_psychiatrist = psych
        profile.is_surgeon = surg
        profile.is_researcher = resr
        profile.is_junior = jun
        profile.is_consultant = cons

        self.internal_action = true
        local entity = self.app.world:newEntity(class_name, 2, 2)
        local entity_id = tonumber(parts[13])
        if entity_id and entity_id > 0 then
          entity.id = entity_id
        end
        entity:setProfile(profile)
        entity:setTile(tx, ty)
        hosp:addStaff(entity)
        entity:setHospital(hosp)
        if self.app.world.available_staff and self.app.world.available_staff[class_name] then
          local pool = self.app.world.available_staff[class_name]
          for idx, cand in ipairs(pool) do
            if clean_name(cand.name) == clean_name(name) then
              table.remove(pool, idx)
              break
            end
          end
        end
        local entity_room = entity:getRoom()
        if entity_room then
          entity_room:onHumanoidEnter(entity)
        else
          entity:onPlaceInCorridor()
        end
        local role_title = "Personal"
        if class_name == "Doctor" then role_title = "Arzt"
        elseif class_name == "Nurse" then role_title = "Krankenschwester"
        elseif class_name == "Handyman" then role_title = "Hausmeister"
        elseif class_name == "Receptionist" then role_title = "Rezeptionistin"
        end
        self.web.call("ui.banner", string.format("oPartner eingestellt: %s (%s)", clean_name(name), role_title))
        self.internal_action = false
      end
    end
    return
  end

  -- Authoritative patient spawn from host
  if data:sub(1, 7) == "spawnp:" then
    local pid, did, sx, sy = data:match("spawnp:(%d+),([^,]+),(%d+),(%d+)")
    if pid and did and sx and sy and self.app.world then
      pid, sx, sy = tonumber(pid), tonumber(sx), tonumber(sy)
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        local disease = nil
        if self.app.diseases and self.app.diseases[did] then
          disease = self.app.diseases[did]
        elseif self.app.world.available_diseases then
          disease = self.app.world.available_diseases[did]
          if not disease then
            for _, d in ipairs(self.app.world.available_diseases) do
              if d.id == did then disease = d break end
            end
          end
        end
        if disease then
          self.internal_action = true
          local patient = self.app.world:newEntity("Patient", 2, 1)
          patient.id = pid
          patient:setDisease(disease)
          local spawn_point = nil
          if self.app.world.spawn_points then
            for _, sp in ipairs(self.app.world.spawn_points) do
              if sp.x == sx and sp.y == sy then
                spawn_point = sp
                break
              end
            end
          end
          if not spawn_point then
            spawn_point = { x = sx, y = sy, direction = "north" }
          end
          local SpawnAction = _G["SpawnAction"] or corsixth.require("humanoid_actions.spawn")
          patient:setNextAction(SpawnAction("spawn", spawn_point))
          patient:setHospital(hosp)
          print(string.format("Multiplayer: Guest spawned replicated patient %d (%s) at (%d,%d)", pid, did, sx, sy))
          self.internal_action = false
        else
          print("Multiplayer: Warning - could not find disease " .. tostring(did) .. " on guest")
        end
      end
    end
    return
  end

  -- Authoritative VIP spawn from host
  if data:sub(1, 9) == "spawnvip:" then
    local vid, name = data:match("spawnvip:(%d+),(.+)")
    if vid and self.app.world then
      vid = tonumber(vid)
      self.internal_action = true
      local vip = self.app.world:spawnVIP(name)
      if vip then vip.id = vid end
      self.internal_action = false
    end
    return
  end

  -- Authoritative Handyman task assignment
  if data:sub(1, 7) == "hmtask:" then
    local hid, taskType, ox, oy = data:match("hmtask:(%d+),([^,]+),(%d+),(%d+)")
    if hid and taskType and ox and oy and self.app.world and self.app.world.entities then
      hid, ox, oy = tonumber(hid), tonumber(ox), tonumber(oy)
      local handyman = nil
      for _, e in ipairs(self.app.world.entities) do
        if e.id == hid and e.humanoid_class == "Handyman" then
          handyman = e
          break
        end
      end
      if handyman then
        if taskType == "watering" then
          local obj = self.app.world:getObject(ox, oy, "plant")
          if obj and obj.createHandymanActions then
            self.internal_action = true
            obj:createHandymanActions(handyman)
            self.internal_action = false
          end
        elseif taskType == "cleaning" then
          local obj = self.app.world:getObject(ox, oy, "litter")
          local WalkAction = _G["WalkAction"] or corsixth.require("humanoid_actions.walk")
          local SweepFloorAction = _G["SweepFloorAction"] or corsixth.require("humanoid_actions.sweep_floor")
          local AnswerCallAction = _G["AnswerCallAction"] or corsixth.require("humanoid_actions.answer_call")
          self.internal_action = true
          if handyman:getRoom() then
            handyman:setNextAction(handyman:getRoom():createLeaveAction())
            handyman:queueAction(WalkAction(ox, oy))
          else
            handyman:setNextAction(WalkAction(ox, oy))
          end
          if obj then
            handyman:queueAction(SweepFloorAction(obj))
          end
          handyman:queueAction(AnswerCallAction())
          self.internal_action = false
        elseif taskType == "repairing" then
          local obj = self.app.world:getObject(ox, oy, "machine")
          if obj and obj.createHandymanActions then
            self.internal_action = true
            obj:createHandymanActions(handyman)
            self.internal_action = false
          end
        end
      end
    end
    return
  end

  -- Humanoid periodic reconciliation
  if data:sub(1, 5) == "hums:" then
    local entries = data:sub(6)
    if self.app.world and self.app.world.entities then
      local local_ents = {}
      for _, e in ipairs(self.app.world.entities) do
        if e.id then local_ents[e.id] = e end
      end
      for item in entries:gmatch("([^;]+)") do
        local id, tx, ty = item:match("(%d+):(%d+),(%d+)")
        if id and tx and ty then
          id, tx, ty = tonumber(id), tonumber(tx), tonumber(ty)
          local e = local_ents[id]
          if e and e.tile_x and e.tile_y then
            local dist = math.abs(e.tile_x - tx) + math.abs(e.tile_y - ty)
            if dist > 2 then
              e:setTile(tx, ty)
            end
          end
        end
      end
    end
    return
  end

  -- State synchronization (balance and calendar date)
  if data:sub(1, 10) == "syncstate:" then
    local bal, y, m, d, h = data:match("syncstate:(%-?%d+),(%d+),(%d+),(%d+),(%d+)")
    if bal and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then hosp.balance = tonumber(bal) end
      if y and m and d and h and self.app.world.game_date then
        y, m, d, h = tonumber(y), tonumber(m), tonumber(d), tonumber(h)
        local cur = self.app.world.game_date
        if cur:year() ~= y or cur:monthOfYear() ~= m or cur:dayOfMonth() ~= d then
          local Date = _G["Date"] or corsixth.require("date")
          if Date then
            self.app.world.game_date = Date(y, m, d, h)
          end
        end
      end
    end
    return
  end

  -- 5. Staff moving (pickup and drop)
  if data:sub(1, 10) == "movestaff:" then
    local sid, tx, ty = data:match("movestaff:(%d+),(%d+),(%d+)")
    if sid and tx and ty and self.app.world and self.app.world.entities then
      sid, tx, ty = tonumber(sid), tonumber(tx), tonumber(ty)
      for _, e in ipairs(self.app.world.entities) do
        if e.id == sid and e.setTile then
          self.internal_action = true
          e:setTile(tx, ty)
          self.internal_action = false
          break
        end
      end
    end
    return
  end

  -- 6. Staff firing
  if data:sub(1, 5) == "fire:" then
    local sid, sname = data:match("fire:(%d+)|?(.*)")
    if sid and self.app.world and self.app.world.entities then
      sid = tonumber(sid)
      for _, e in ipairs(self.app.world.entities) do
        if e.id == sid and e.fire then
          self.internal_action = true
          e:fire()
          self.internal_action = false
          self.web.call("ui.banner", "wEntlassen: " .. (sname ~= "" and sname or "Personal"))
          break
        end
      end
    end
    return
  end

  -- 7. Bank balance sync
  if data:sub(1, 8) == "balance:" then
    local bal = tonumber(data:sub(9))
    if bal and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        hosp.balance = bal
      end
    end
    return
  end

  -- 8. Speed change
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

  -- 9. Cursor position / ping
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

  -- 10. Level transition
  if data:sub(1, 6) == "level:" then
    local next_level = data:sub(7)
    print("Multiplayer: Transitioning to level " .. next_level)
    self.level = next_level
    local err_prefix = _S and _S.errors and _S.errors.load_level_prefix or "Error: "
    self.app:loadLevel(next_level, "full", nil, nil, nil, nil, err_prefix, nil)
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
