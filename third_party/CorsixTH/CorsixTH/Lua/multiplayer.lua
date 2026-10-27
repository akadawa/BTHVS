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
  self.patient_treat_results = {}
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
  local Hospital = _G["Hospital"] or corsixth.require("hospital")
  local UIBankManager = _G["UIBankManager"] or corsixth.require("dialogs.fullscreen.bank_manager")
  local UIResearch = _G["UIResearch"] or corsixth.require("dialogs.fullscreen.research_policy")
  local UICasebook = _G["UICasebook"] or corsixth.require("dialogs.fullscreen.drug_casebook")
  local UIPolicy = _G["UIPolicy"] or corsixth.require("dialogs.fullscreen.hospital_policy")
  local UIStaffManagement = _G["UIStaffManagement"] or corsixth.require("dialogs.fullscreen.staff_management")
  local Patient = _G["Patient"] or corsixth.require("entities.humanoids.patient")
  local Machine = _G["Machine"] or corsixth.require("entities.machine")

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

  -- Host-authoritative patient treatment outcome (cure vs death)
  if Patient and Patient.isTreatmentEffective then
    local orig_isTreatmentEffective = Patient.isTreatmentEffective
    Patient.isTreatmentEffective = function(p_self)
      if not mp.active then return orig_isTreatmentEffective(p_self) end
      if mp.is_host then
        local eff = orig_isTreatmentEffective(p_self)
        if p_self.id then
          mp.web.call("net.send", string.format("all|treatres:%d,%s", p_self.id, eff and "1" or "0"))
        end
        return eff
      else
        if p_self.id and mp.patient_treat_results[p_self.id] ~= nil then
          local eff = mp.patient_treat_results[p_self.id]
          mp.patient_treat_results[p_self.id] = nil
          return eff
        end
        return orig_isTreatmentEffective(p_self)
      end
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

    if UIEditRoom.abortRoom then
      local orig_abortRoom = UIEditRoom.abortRoom
      UIEditRoom.abortRoom = function(edit_self)
        local was_paid = edit_self.paid
        local had_room = (edit_self.room ~= nil)
        local r_name = "Raum"
        if edit_self.room and edit_self.room.room_info and edit_self.room.room_info.name then
          r_name = clean_name(edit_self.room.room_info.name)
        elseif edit_self.room_type and edit_self.room_type.name then
          r_name = clean_name(edit_self.room_type.name)
        elseif edit_self.title_text then
          r_name = clean_name(edit_self.title_text)
        end
        local res = orig_abortRoom(edit_self)
        if mp.active and (was_paid or had_room) and not mp.internal_action then
          TheApp:save("/tmp/snapshot_out.sav")
          mp.web.call("snap.send", "all|/tmp/snapshot_out.sav|room_deleted")
          mp.web.call("ui.banner", "wRaum abgerissen: " .. r_name)
          local p_name = clean_name(mp.name)
          local payload = string.format("demolish|%s|%s", p_name, r_name)
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

  -- 6. Hook Hospital:purchasePlot to synchronize land buying
  if Hospital and Hospital.purchasePlot then
    local orig_purchasePlot = Hospital.purchasePlot
    Hospital.purchasePlot = function(hosp_self, plot_number)
      local res = orig_purchasePlot(hosp_self, plot_number)
      if res and mp.active and not mp.internal_action then
        mp.web.call("net.send", string.format("all|plot:%d", plot_number))
        local p_name = clean_name(mp.name)
        local cost = hosp_self.world and hosp_self.world.map and hosp_self.world.map:getParcelPrice(plot_number) or 0
        local payload = string.format("land|%s|%d|%d", p_name, plot_number, cost)
        mp.web.call("hist.record", payload)
        mp.web.call("net.send", "all|hist:" .. payload)
        mp.web.call("ui.banner", "oGrundstueck #" .. tostring(plot_number) .. " erworben")
      end
      return res
    end
  end

  -- 7. Hook UIBankManager for loans and repayments
  if UIBankManager then
    if UIBankManager.increaseLoan then
      local orig_incLoan = UIBankManager.increaseLoan
      UIBankManager.increaseLoan = function(bm_self)
        local prev_loan = bm_self.ui.hospital.loan
        local res = orig_incLoan(bm_self)
        local cur_loan = bm_self.ui.hospital.loan
        if mp.active and not mp.internal_action and cur_loan > prev_loan then
          local diff = cur_loan - prev_loan
          mp.web.call("net.send", string.format("all|loan:%d,%d", cur_loan, bm_self.ui.hospital.balance))
          local p_name = clean_name(mp.name)
          local payload = string.format("loan|%s|%d", p_name, diff)
          mp.web.call("hist.record", payload)
          mp.web.call("net.send", "all|hist:" .. payload)
        end
        return res
      end
    end
    if UIBankManager.decreaseLoan then
      local orig_decLoan = UIBankManager.decreaseLoan
      UIBankManager.decreaseLoan = function(bm_self)
        local prev_loan = bm_self.ui.hospital.loan
        local res = orig_decLoan(bm_self)
        local cur_loan = bm_self.ui.hospital.loan
        if mp.active and not mp.internal_action and cur_loan < prev_loan then
          local diff = prev_loan - cur_loan
          mp.web.call("net.send", string.format("all|loan:%d,%d", cur_loan, bm_self.ui.hospital.balance))
          local p_name = clean_name(mp.name)
          local payload = string.format("repayloan|%s|%d", p_name, diff)
          mp.web.call("hist.record", payload)
          mp.web.call("net.send", "all|hist:" .. payload)
        end
        return res
      end
    end
  end

  -- 8. Hook UIResearch:adjustResearch for shared research department distribution
  if UIResearch and UIResearch.adjustResearch then
    local orig_adjustResearch = UIResearch.adjustResearch
    UIResearch.adjustResearch = function(r_self, area, mode)
      local res = orig_adjustResearch(r_self, area, mode)
      if mp.active and not mp.internal_action and r_self.research and r_self.research.research_policy then
        local pol = r_self.research.research_policy
        local c = pol.cure and pol.cure.frac or 0
        local d = pol.diagnosis and pol.diagnosis.frac or 0
        local dr = pol.drugs and pol.drugs.frac or 0
        local im = pol.improvements and pol.improvements.frac or 0
        local sp = pol.specialisation and pol.specialisation.frac or 0
        mp.web.call("net.send", string.format("all|respol:%.2f,%.2f,%.2f,%.2f,%.2f", c, d, dr, im, sp))
      end
      return res
    end
  end

  -- 9. Hook Hospital:setDiseasePrice & UICasebook for disease treatment pricing & concentrated research
  if Hospital then
    Hospital.setDiseasePrice = function(hosp_self, disease_id, price)
      if hosp_self.disease_casebook and hosp_self.disease_casebook[disease_id] then
        hosp_self.disease_casebook[disease_id].price = tonumber(price) or 1.0
        if mp.active and not mp.internal_action then
          mp.web.call("net.send", string.format("all|price:%s,%.2f", disease_id, hosp_self.disease_casebook[disease_id].price))
        end
        return true
      end
      return false
    end
  end

  if UICasebook then
    if UICasebook.increasePay then
      local orig_incPay = UICasebook.increasePay
      UICasebook.increasePay = function(cb_self)
        local res = orig_incPay(cb_self)
        if mp.active and not mp.internal_action and cb_self.selected_disease and cb_self.casebook then
          local p = cb_self.casebook[cb_self.selected_disease].price
          mp.web.call("net.send", string.format("all|price:%s,%.2f", cb_self.selected_disease, p))
        end
        return res
      end
    end
    if UICasebook.decreasePay then
      local orig_decPay = UICasebook.decreasePay
      UICasebook.decreasePay = function(cb_self)
        local res = orig_decPay(cb_self)
        if mp.active and not mp.internal_action and cb_self.selected_disease and cb_self.casebook then
          local p = cb_self.casebook[cb_self.selected_disease].price
          mp.web.call("net.send", string.format("all|price:%s,%.2f", cb_self.selected_disease, p))
        end
        return res
      end
    end
    if UICasebook.concentrateResearch then
      local orig_conc = UICasebook.concentrateResearch
      UICasebook.concentrateResearch = function(cb_self)
        local res = orig_conc(cb_self)
        if mp.active and not mp.internal_action and cb_self.selected_disease then
          mp.web.call("net.send", "all|concresearch:" .. tostring(cb_self.selected_disease))
        end
        return res
      end
    end
  end

  -- 10. Hook UIPolicy:close for shared hospital policy sliders
  if UIPolicy and UIPolicy.close then
    local orig_polClose = UIPolicy.close
    UIPolicy.close = function(pol_self)
      local res = orig_polClose(pol_self)
      if mp.active and not mp.internal_action and pol_self.hospital and pol_self.hospital.policies then
        local p = pol_self.hospital.policies
        local gc = p["guess_cure"] or 0.1
        local sh = p["send_home"] or 0.1
        local sp = p["stop_procedure"] or 1.0
        local sl = p["staff_leave"] or 0.1
        mp.web.call("net.send", string.format("all|policies:%.2f,%.2f,%.2f,%.2f", gc, sh, sp, sl))
      end
      return res
    end
  end

  -- 11. Hook Staff:increaseWage and UIStaffManagement:payBonus
  if Staff and Staff.increaseWage then
    local orig_incWage = Staff.increaseWage
    Staff.increaseWage = function(s_self, amount)
      local res = orig_incWage(s_self, amount)
      if mp.active and not mp.internal_action and s_self.id then
        mp.web.call("net.send", string.format("all|staffwage:%d,%d", s_self.id, amount))
      end
      return res
    end
  end
  if UIStaffManagement and UIStaffManagement.payBonus then
    local orig_payBonus = UIStaffManagement.payBonus
    UIStaffManagement.payBonus = function(sm_self)
      local cat = sm_self.staff_members and sm_self.staff_members[sm_self.category]
      local member = cat and cat[sm_self.selected_staff]
      local mid = member and member.id
      local res = orig_payBonus(sm_self)
      if mp.active and not mp.internal_action and mid then
        mp.web.call("net.send", string.format("all|staffbonus:%d", mid))
      end
      return res
    end
  end

  -- 12. Hook World:makeAvailableStaff so candidate staff pool is 1:1 identical every month
  if World and World.makeAvailableStaff then
    local orig_makeStaff = World.makeAvailableStaff
    World.makeAvailableStaff = function(world_self, month)
      if not mp.active then
        return orig_makeStaff(world_self, month)
      end
      if mp.is_host then
        orig_makeStaff(world_self, month)
        local lines = {}
        local cats = {"Doctor", "Nurse", "Handyman", "Receptionist"}
        for _, cat in ipairs(cats) do
          local pool = world_self.available_staff and world_self.available_staff[cat] or {}
          local cand_strs = {}
          for _, prof in ipairs(pool) do
            local is_psy = (type(prof.is_psychiatrist) == "number" and prof.is_psychiatrist >= 1.0 or prof.is_psychiatrist == true) and 1 or 0
            local is_sur = (type(prof.is_surgeon) == "number" and prof.is_surgeon >= 1.0 or prof.is_surgeon == true) and 1 or 0
            local is_res = (type(prof.is_researcher) == "number" and prof.is_researcher >= 1.0 or prof.is_researcher == true) and 1 or 0
            table.insert(cand_strs, string.format("%s/%d/%.2f/%d/%d/%d/%d/%d/%d",
              clean_name(prof.name),
              prof.wage or 100,
              prof.skill or 0.5,
              prof.layer5 or 2,
              is_psy, is_sur, is_res,
              prof.is_junior and 1 or 0,
              prof.is_consultant and 1 or 0
            ))
          end
          table.insert(lines, cat .. ":" .. table.concat(cand_strs, ";"))
        end
        mp.web.call("net.send", "all|staffpool:" .. table.concat(lines, "#"))
      else
        if mp.internal_action then
          orig_makeStaff(world_self, month)
        end
      end
    end
  end

  -- 13. Hook Hospital:createEmergency to make emergency generation host-authoritative
  if Hospital and Hospital.createEmergency then
    local orig_createEmergency = Hospital.createEmergency
    Hospital.createEmergency = function(hosp_self, emergency)
      if not mp.active then
        return orig_createEmergency(hosp_self, emergency)
      end
      if mp.is_host then
        local res = orig_createEmergency(hosp_self, emergency)
        if hosp_self.emergency and not mp.internal_action then
          local em = hosp_self.emergency
          local did = em.disease and em.disease.id or ""
          mp.web.call("net.send", string.format("all|emerg:%s,%d,%d,%.2f", did, em.victims or 3, em.bonus or 1000, em.percentage or 0.75))
        end
        return res
      else
        if mp.internal_action or emergency then
          return orig_createEmergency(hosp_self, emergency)
        end
        return nil
      end
    end
  end

  -- 14. Hook UIFax:choice for shared decisions (patient triage, emergencies, etc.)
  if UIFax and UIFax.choice then
    local orig_faxChoice = UIFax.choice
    UIFax.choice = function(fax_self, choice_number)
      local choices = fax_self.message and fax_self.message.choices
      local choice_str = choices and choices[choice_number] and choices[choice_number].choice or ""
      local target_id = (fax_self.owner and fax_self.owner.id) or 0
      local res = orig_faxChoice(fax_self, choice_number)
      if mp.active and not mp.internal_action and choice_str ~= "" then
        mp.web.call("net.send", string.format("all|faxchoice:%s,%d", choice_str, target_id))
      end
      return res
    end
  end

  -- 15. Hook Machine:replaceMachine and calculateIsMachineMustExplode
  if Machine then
    if Machine.replaceMachine then
      local orig_replaceMachine = Machine.replaceMachine
      Machine.replaceMachine = function(mach_self, cost)
        local tx = mach_self.tile_x
        local ty = mach_self.tile_y
        local m_name = mach_self.object_type and clean_name(mach_self.object_type.name) or "Maschine"
        local res = orig_replaceMachine(mach_self, cost)
        if mp.active and not mp.internal_action and tx and ty then
          mp.web.call("net.send", string.format("all|replacemach:%d,%d,%d", tx, ty, cost))
          local p_name = clean_name(mp.name)
          local payload = string.format("replace|%s|%s|%d", p_name, m_name, cost)
          mp.web.call("hist.record", payload)
          mp.web.call("net.send", "all|hist:" .. payload)
        end
        return res
      end
    end
    if Machine.calculateIsMachineMustExplode then
      local orig_calcExplode = Machine.calculateIsMachineMustExplode
      Machine.calculateIsMachineMustExplode = function(mach_self, room)
        if mp.active and not mp.is_host then
          return false
        end
        local must = orig_calcExplode(mach_self, room)
        if mp.active and mp.is_host and must and mach_self.tile_x and mach_self.tile_y then
          mp.web.call("net.send", string.format("all|explodemach:%d,%d", mach_self.tile_x, mach_self.tile_y))
        end
        return must
      end
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

  -- 3. Host periodically syncs authoritative bank balance, reputation and in-game date (~2s)
  if self.is_host and (now - self.last_balance_send > 2000) then
    self.last_balance_send = now
    if self.app.world and self.app.world.ui and self.app.world.ui.hospital then
      local hosp = self.app.world.ui.hospital
      local bal = hosp.balance
      local rep = hosp.reputation or 500
      local d = self.app.world.game_date
      if d then
        self.web.call("net.send", string.format("all|syncstate:%d,%d,%d,%d,%d,%d", bal, rep, d:year(), d:monthOfYear(), d:dayOfMonth(), d:hourOfDay()))
      else
        self.web.call("net.send", string.format("all|syncstate:%d,%d,1997,1,1,1", bal, rep))
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

  -- State synchronization (balance, reputation and calendar date)
  if data:sub(1, 10) == "syncstate:" then
    local bal, rep, y, m, d, h = data:match("syncstate:(%-?%d+),(%d+),(%d+),(%d+),(%d+),(%d+)")
    if not rep then
      bal, y, m, d, h = data:match("syncstate:(%-?%d+),(%d+),(%d+),(%d+),(%d+)")
    end
    if bal and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        hosp.balance = tonumber(bal)
        if rep then hosp.reputation = tonumber(rep) end
      end
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

  -- Authoritative treatment outcome (cure vs death) from host
  if data:sub(1, 9) == "treatres:" then
    local pid, flag = data:match("treatres:(%d+),([01])")
    if pid and flag then
      self.patient_treat_results[tonumber(pid)] = (flag == "1")
    end
    return
  end

  -- Plot purchase replication
  if data:sub(1, 5) == "plot:" then
    local plot_no = tonumber(data:sub(6))
    if plot_no and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        self.internal_action = true
        self.app.world:setPlotOwner(plot_no, hosp:getPlayerIndex())
        table.insert(hosp.ownedPlots, plot_no)
        if self.app.world.ui and self.app.world.ui.applyTransparency then
          self.app.world.ui:applyTransparency()
        end
        local cost = hosp.world and hosp.world.map and hosp.world.map:getParcelPrice(plot_no) or 0
        hosp:spendMoney(cost, _S and _S.transactions and _S.transactions.buy_land or "Land", cost)
        self.internal_action = false
      end
    end
    return
  end

  -- Loan & balance sync from bank manager
  if data:sub(1, 5) == "loan:" then
    local loan, bal = data:match("loan:(%d+),(%-?%d+)")
    if loan and bal and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        hosp.loan = tonumber(loan)
        hosp.balance = tonumber(bal)
      end
    end
    return
  end

  -- Research policy replication
  if data:sub(1, 7) == "respol:" then
    local c, d, dr, im, sp = data:match("respol:([%d%.]+),([%d%.]+),([%d%.]+),([%d%.]+),([%d%.]+)")
    if c and d and dr and im and sp and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp and hosp.research and hosp.research.research_policy then
        local pol = hosp.research.research_policy
        if pol.cure then pol.cure.frac = tonumber(c) end
        if pol.diagnosis then pol.diagnosis.frac = tonumber(d) end
        if pol.drugs then pol.drugs.frac = tonumber(dr) end
        if pol.improvements then pol.improvements.frac = tonumber(im) end
        if pol.specialisation then pol.specialisation.frac = tonumber(sp) end
        pol.global = tonumber(c) + tonumber(d) + tonumber(dr) + tonumber(im) + tonumber(sp)
      end
    end
    return
  end

  -- Disease price adjustment
  if data:sub(1, 6) == "price:" then
    local did, pr = data:match("price:([^,]+),([%d%.]+)")
    if did and pr and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp and hosp.disease_casebook and hosp.disease_casebook[did] then
        hosp.disease_casebook[did].price = tonumber(pr)
      end
    end
    return
  end

  -- Concentrate research on a disease
  if data:sub(1, 13) == "concresearch:" then
    local did = data:sub(14)
    if did and did ~= "" and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp and hosp.research and hosp.research.concentrateResearch then
        hosp.research:concentrateResearch(did)
      end
    end
    return
  end

  -- Hospital policy sliders replication
  if data:sub(1, 9) == "policies:" then
    local gc, sh, sp, sl = data:match("policies:([%d%.]+),([%d%.]+),([%d%.]+),([%d%.]+)")
    if gc and sh and sp and sl and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp and hosp.policies then
        hosp.policies["guess_cure"] = tonumber(gc)
        hosp.policies["send_home"] = tonumber(sh)
        hosp.policies["stop_procedure"] = tonumber(sp)
        hosp.policies["staff_leave"] = tonumber(sl)
      end
    end
    return
  end

  -- Staff wage increase and bonus
  if data:sub(1, 10) == "staffwage:" then
    local sid, amt = data:match("staffwage:(%d+),(%d+)")
    if sid and amt and self.app.world and self.app.world.entities then
      sid, amt = tonumber(sid), tonumber(amt)
      for _, e in ipairs(self.app.world.entities) do
        if e.id == sid and e.increaseWage then
          self.internal_action = true
          e:increaseWage(amt)
          self.internal_action = false
          break
        end
      end
    end
    return
  end
  if data:sub(1, 11) == "staffbonus:" then
    local sid = tonumber(data:sub(12))
    if sid and self.app.world and self.app.world.entities then
      for _, e in ipairs(self.app.world.entities) do
        if e.id == sid then
          if e.changeAttribute then e:changeAttribute("happiness", 0.5) end
          local hosp = self.app.world:getLocalPlayerHospital()
          if hosp and e.profile and e.profile.wage then
            hosp:spendMoney(math.floor(e.profile.wage * 0.1), _S and _S.transactions and _S.transactions.personal_bonus or "Bonus")
          end
          break
        end
      end
    end
    return
  end

  -- Authoritative monthly staff candidate pool from host
  if data:sub(1, 10) == "staffpool:" then
    local payload = data:sub(11)
    if self.app.world then
      local StaffProfile = _G["StaffProfile"] or corsixth.require("staff_profile")
      self.app.world.available_staff = self.app.world.available_staff or {}
      for cat_chunk in payload:gmatch("([^#]+)") do
        local colon = cat_chunk:find(":")
        if colon then
          local cat = cat_chunk:sub(1, colon - 1)
          local list_str = cat_chunk:sub(colon + 1)
          local new_pool = {}
          if list_str ~= "" then
            for cand in list_str:gmatch("([^;]+)") do
              local name, wage, skill, l5, psy, sur, resr, jun, cons = cand:match("([^/]+)/(%d+)/([%d%.]+)/(%d+)/([01])/([01])/([01])/([01])/([01])")
              if name and wage and skill then
                local prof = StaffProfile(self.app.world, cat)
                prof.name = clean_name(name)
                prof.wage = tonumber(wage) or 100
                prof.skill = tonumber(skill) or 0.5
                prof.layer5 = tonumber(l5) or 2
                prof.is_psychiatrist = (psy == "1") and 1.0 or 0.0
                prof.is_surgeon = (sur == "1") and 1.0 or 0.0
                prof.is_researcher = (resr == "1") and 1.0 or 0.0
                prof.is_junior = (jun == "1")
                prof.is_consultant = (cons == "1")
                table.insert(new_pool, prof)
              end
            end
          end
          self.app.world.available_staff[cat] = new_pool
        end
      end
    end
    return
  end

  -- Authoritative emergency replication from host
  if data:sub(1, 6) == "emerg:" then
    local did, victims, bonus, perc = data:match("emerg:([^,]+),(%d+),(%d+),([%d%.]+)")
    if did and victims and bonus and perc and self.app.world then
      local hosp = self.app.world:getLocalPlayerHospital()
      if hosp then
        local disease = TheApp.diseases and TheApp.diseases[did]
        if not disease and self.app.world.available_diseases then
          for _, d in ipairs(self.app.world.available_diseases) do
            if d.id == did then disease = d break end
          end
        end
        if disease then
          self.internal_action = true
          hosp:createEmergency({
            disease = disease,
            victims = tonumber(victims) or 3,
            bonus = tonumber(bonus) or 1000,
            percentage = tonumber(perc) or 0.75,
            killed_emergency_patients = 0,
            cured_emergency_patients = 0,
          })
          self.internal_action = false
        end
      end
    end
    return
  end

  -- Fax / patient triage decision replication
  if data:sub(1, 10) == "faxchoice:" then
    local choice, tid = data:match("faxchoice:([^,]+),(%d+)")
    if choice and tid and self.app.world then
      tid = tonumber(tid)
      local hosp = self.app.world:getLocalPlayerHospital()
      if tid > 0 and self.app.world.entities then
        for _, e in ipairs(self.app.world.entities) do
          if e.id == tid then
            self.internal_action = true
            if e.setMood then e:setMood("patient_wait", "deactivate") end
            e.message_callback = nil
            if choice == "send_home" then
              if e.goHome then e:goHome("kicked") end
            elseif choice == "wait" then
              e.waiting = 60
            elseif choice == "guess_cure" then
              if e.setDiagnosed then e:setDiagnosed() end
              local SeekRoomAction = _G["SeekRoomAction"] or corsixth.require("humanoid_actions.seek_room")
              if e.agreesToPay and e.disease and e:agreesToPay(e.disease.id) then
                if SeekRoomAction and e.disease.treatment_rooms and e.disease.treatment_rooms[1] then
                  e:setNextAction(SeekRoomAction(e.disease.treatment_rooms[1]):enableTreatmentRoom())
                end
              elseif e.goHome and e.disease then
                e:goHome("over_priced", e.disease.id)
              end
            elseif choice == "research" then
              if e.unregisterCallbacks then e:unregisterCallbacks() end
              if e.setMood then e:setMood("idea", "activate") end
              local SeekRoomAction = _G["SeekRoomAction"] or corsixth.require("humanoid_actions.seek_room")
              if SeekRoomAction then e:setNextAction(SeekRoomAction("research")) end
            end
            if hosp and hosp.removeMessage then hosp:removeMessage(e) end
            self.internal_action = false
            break
          end
        end
      elseif tid == 0 and hosp then
        self.internal_action = true
        if choice == "accept_emergency" then
          if hosp.emergency then hosp.emergency.status = "accepted" end
        elseif choice == "refuse_emergency" then
          hosp.emergency = nil
        end
        local UIFax = _G["UIFax"]
        if self.app.ui and UIFax then
          local win = self.app.ui:getWindow(UIFax)
          if win then win:close() end
        end
        self.internal_action = false
      end
    end
    return
  end

  -- Machine replacement replication
  if data:sub(1, 12) == "replacemach:" then
    local x, y, cost = data:match("replacemach:(%d+),(%d+),(%d+)")
    if x and y and cost and self.app.world then
      x, y, cost = tonumber(x), tonumber(y), tonumber(cost)
      local mach = self.app.world:getObject(x, y, "machine")
      if mach and mach.replaceMachine then
        self.internal_action = true
        mach:replaceMachine(cost)
        self.internal_action = false
      end
    end
    return
  end

  -- Authoritative machine explosion from host
  if data:sub(1, 11) == "explodemach:" then
    local x, y = data:match("explodemach:(%d+),(%d+)")
    if x and y and self.app.world then
      x, y = tonumber(x), tonumber(y)
      local mach = self.app.world:getObject(x, y, "machine")
      if mach and mach.explodeMachine then
        self.internal_action = true
        mach:explodeMachine(mach:getRoom())
        self.internal_action = false
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
