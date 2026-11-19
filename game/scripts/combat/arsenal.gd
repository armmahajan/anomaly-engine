extends RefCounted
## The player's weapons in play (player.gd owns one): which weapon each loadout slot holds (the
## run's, world_runtime.gd), which attack a press, a release after holding, or a combo picks,
## buffered presses, cooldowns, ammo and cycling. The attack itself runs in weapon_runner.gd, the
## same code an enemy's useWeapon runs. A slot with no weapon does nothing here (an empty attack
## slot is the player's built-in attack, in player.gd).
##
## Timing is in physics frames (`_tick`, one per update):
## - A press while an attack is on is buffered for the player's jump-buffer frames and starts the
##   first frame the player is free.
## - When an attack with a combo `next` ends, its window opens for `window` s: a press (or a
##   buffered one) in it makes the next attack; after it, a press starts over (the trigger's pick).
## - An attack's cooldown runs from its end; a press during it is ignored (like the built-in attack).
## - A hold attack starts when the button is released after being held at least `hold` s; a tap
##   attack of the same weapon still starts on the press.

const Runner := preload("res://scripts/combat/weapon_runner.gd")
const SLOT_ACTIONS := ["attack", "alt_attack", "special_attack"]

## Weapon id -> weapon (project.weapons.list).
var weapons := {}
## project.weapons.loadout: {slots, cycle}.
var loadout := {"slots": [], "cycle": false}
## world_runtime.gd while a run is on (the slots, the items ammo is spent from); null otherwise.
var run = null
## The attack being made (weapon_runner.gd), or null.
var runner = null
## The player's weapon view (weapon_view.gd).
var view: Node2D = null
## The way the player faces for the attack being made when it was aimed with the mouse (it turns
## toward the aim: 1 right, -1 left); 0 = the way it faced (key aims).
var turn := 0.0
var buffer_frames := 7

var _tick := 0
var _held := {}
var _buffer := {}
var _combo := {}
var _cooldowns := {}


func setup(project_weapons: Variant, buffer: int) -> void:
	weapons = {}
	if typeof(project_weapons) == TYPE_DICTIONARY:
		for w in project_weapons.get("list", []):
			weapons[str(w.id)] = w
		var given = project_weapons.get("loadout")
		if typeof(given) == TYPE_DICTIONARY:
			loadout = given
	buffer_frames = maxi(1, buffer)


## The weapon in the slot bound to `action` ({} = none): the run's slots, else the loadout's start.
func weapon_for(action: String) -> Dictionary:
	var id := ""
	if run != null and run.active:
		id = run.weapon_in(action)
	else:
		for slot in loadout.get("slots", []):
			if str(slot.action) == action and slot.get("start") != null:
				id = str(slot.start)
	return weapons.get(id, {})


func busy() -> bool:
	return runner != null


## Stop the attack being made (the player was hurt).
func cancel() -> void:
	if runner != null and view != null:
		view.set_phase(runner.attack, "", runner.aim, 1.0)
	runner = null
	_buffer = {}


## This frame's presses (from the player's physics step, while it has control, before it moves).
## `blocked`: the built-in attack is swinging. The aim is the player's (player.gd attack_aim):
## {name, vector, mouse}.
func update(player, airborne: bool, blocked: bool) -> void:
	_tick += 1
	if bool(loadout.get("cycle", false)) and Input.is_action_just_pressed("weapon_cycle") and runner == null and run != null and run.active:
		run.cycle_weapon()
	var aim: Dictionary = player.attack_aim()
	if runner == null and not blocked and not _buffer.is_empty():
		if _tick >= int(_buffer.until) or _try(player, str(_buffer.action), float(_buffer.held), aim, airborne):
			_buffer = {}
	for action in SLOT_ACTIONS:
		var weapon := weapon_for(action)
		if weapon.is_empty():
			_held.erase(action)
			continue
		if Input.is_action_just_pressed(action):
			_held[action] = 1
			_request(player, action, -1.0, aim, airborne, blocked)
		elif Input.is_action_pressed(action) and _held.has(action):
			_held[action] += 1
		if Input.is_action_just_released(action) and _held.has(action):
			var held := float(_held[action]) / float(Runner.FPS)
			_held.erase(action)
			if _has_hold(weapon):
				_request(player, action, held, aim, airborne, blocked)


## After the player moved: this frame of the attack (its hits); at its end, its cooldown and combo window start.
func after_move(player) -> void:
	if runner == null:
		return
	if runner.step(player):
		return
	var w: Dictionary = runner.weapon
	var a: Dictionary = runner.attack
	_cooldowns["%s/%s" % [w.id, a.id]] = _tick + 1 + runner.cooldown
	var next = a.get("combo", {}).get("next")
	_combo = {} if next == null else {"weapon": str(w.id), "next": str(next), "until": _tick + 1 + Runner.frames(float(a.combo.get("window", 0.35)))}
	runner = null


func _request(player, action: String, held: float, aim: Dictionary, airborne: bool, blocked: bool) -> void:
	if runner != null or blocked:
		_buffer = {"action": action, "held": held, "until": _tick + buffer_frames}
	else:
		_try(player, action, held, aim, airborne)


## Start the attack this press (held < 0) or release picks, if its cooldown is over and the ammo is there.
## A key aim picks by its name and aims as the trigger says (aim_for); a mouse aim picks by its bucket,
## turns the player toward it and aims the shape exactly (weaponModel.ts wielderAim, attackAim).
func _try(player, action: String, held: float, aim: Dictionary, airborne: bool) -> bool:
	var weapon := weapon_for(action)
	if weapon.is_empty():
		return false
	var attack := {}
	if held < 0.0 and not _combo.is_empty() and _combo.weapon == str(weapon.id) and _tick < int(_combo.until):
		attack = _attack(weapon, str(_combo.next))
	if attack.is_empty():
		attack = Runner.pick(weapon, str(aim.name), airborne, held)
	if attack.is_empty():
		return false
	if _tick < int(_cooldowns.get("%s/%s" % [weapon.id, attack.id], 0)):
		return false
	var ammo = attack.get("ammo")
	if typeof(ammo) == TYPE_DICTIONARY:
		var per := int(ammo.get("per", 1))
		if run == null or not run.active or run.item_count(str(ammo.item)) < per:
			return false
		run.spend_item(str(ammo.item), per)
	_combo = {}
	turn = 0.0
	var vector := Runner.aim_for(attack, str(aim.name), airborne)
	if bool(aim.mouse):
		var to: Vector2 = aim.vector
		turn = signf(to.x) if absf(to.x) > 1e-6 else player.facing_sign()
		vector = Vector2(to.x * turn, to.y)
	runner = Runner.new(weapon, attack, vector)
	runner.view = view
	player.weapon_started(runner)
	return true


static func _attack(weapon: Dictionary, id: String) -> Dictionary:
	for a in weapon.get("attacks", []):
		if str(a.id) == id:
			return a
	return {}


static func _has_hold(weapon: Dictionary) -> bool:
	return weapon.get("attacks", []).any(func(a): return float(a.get("trigger", {}).get("hold", 0.0)) > 0.0)


## The HUD's weapon rows: each loadout slot holding a weapon, with the ammo its attacks use (held counts).
func hud_rows() -> Array:
	var out := []
	for slot in loadout.get("slots", []):
		var weapon := weapon_for(str(slot.action))
		if weapon.is_empty():
			continue
		var ammo := {}
		for a in weapon.get("attacks", []):
			if typeof(a.get("ammo")) == TYPE_DICTIONARY:
				var item := str(a.ammo.item)
				ammo[item] = run.item_count(item) if run != null and run.active else 0
		out.append({"slot": str(slot.id), "label": str(slot.get("label", slot.id)), "weapon": str(weapon.id), "name": str(weapon.get("name", weapon.id)), "ammo": ammo})
	return out
