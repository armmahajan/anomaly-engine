extends Node
## World play: the run through the game's rooms. Tracks the current room,
## where the player entered it, the last safe ground, visited rooms and
## abilities, and walks the player through doors. main.gd builds the rooms
## (`_build_room`). Runs after the world each physics frame
## (process_physics_priority), so it sees where the player ended up.
##
## Split in three: events (player died, room entered, hazard touched, ...),
## the game's rules (which today decide what each event does, from
## world.rules), and effects: small, independent actions (respawn at a point,
## restore health, apply damage, return to safe ground, save the run) that
## rules call and, later, event bindings can call directly.

const TILE := 32.0
const OPPOSITE := {"left": "right", "right": "left", "top": "bottom", "bottom": "top"}
## Going up through a top door: at least this rise (px) in the room above, to clear its floor.
const UP_CARRY := 3.0 * TILE  # core world.ts DOOR_UP_CARRY: the traversal checker assumes the same
const SAVE_PREFIX := "anomaly-save:"

var main: Node = null
var active := false
var room_id := ""
## Where the player comes back on death (onDeath "room"): where they entered the
## room, moved to the first ground they stood on there (entering mid-air or from below).
var entry := Vector2.ZERO
var abilities: Array = []
var visited: Array = []

var _rooms := {}
var _rules := {}
var _origin := {}
var _settled := false
var _safe := Vector2.ZERO
var _hazard := false
var _save_key := ""


func _init() -> void:
	process_physics_priority = 100


## Start a run from a play message's `world` ({room, x, y, abilities, continue}). Returns a problem or "".
func start(project: Dictionary, start: Dictionary) -> String:
	var world: Dictionary = project.get("world", {})
	_rooms = {}
	for room in world.get("rooms", []):
		_rooms[room.id] = room
	_rules = world.get("rules", {})
	_save_key = SAVE_PREFIX + str(project.get("id", ""))
	var problem := _check_start(start)
	if problem != "":
		return problem
	abilities = start.get("abilities", []).duplicate()
	visited = []
	_origin = {"room": str(start.room), "at": Vector2(start.x, start.y)}
	var from := _origin
	if start.get("continue", false) and _rule("save") == "room":
		var saved := load_run()
		if not saved.is_empty():
			from = saved
	active = true
	_enter(from.room, from.at, null)
	return ""


func stop() -> void:
	active = false
	room_id = ""


func _check_start(start: Dictionary) -> String:
	if not _rooms.has(start.get("room")):
		return "no room '%s' (known: %s)" % [start.get("room"), ", ".join(_rooms.keys())]
	for key in ["x", "y"]:
		if not (typeof(start.get(key)) in [TYPE_INT, TYPE_FLOAT]):
			return "world start needs numeric x and y"
	var list = start.get("abilities", [])
	if typeof(list) != TYPE_ARRAY or list.any(func(a): return typeof(a) != TYPE_STRING):
		return "world start abilities must be a list of ability names"
	return ""


func _rule(key: String) -> String:
	return str(_rules.get(key, {"onDeath": "room", "save": "room"}.get(key, "")))


# --- events: the game's rules decide what they do ----------------------------------

## The player died (main.gd, deferred): rules.onDeath picks where they come back.
func on_player_died() -> void:
	if _rule("onDeath") == "start":
		var start = main._project.get("world", {}).get("start")
		if typeof(start) == TYPE_DICTIONARY and _rooms.has(start.get("room")):
			respawn_at(str(start.room), Vector2(start.x, start.y))
		else:
			respawn_at(_origin.room, _origin.at)
	else:
		respawn_at(room_id, entry)
	restore_health()


## The player touched a hazard tile (player.gd signal; handled after the frame's movement).
func on_hazard_touched() -> void:
	_hazard = true


func _on_hazard(player: Node) -> void:
	apply_damage(int(_rules.get("hazardDamage", 1)))
	if player.health > 0:  # else died: main restarts the run
		return_to_safe_ground()


func _on_room_entered() -> void:
	if _rule("save") == "room":
		save_run()


## The player first stood on safe ground in this room: that becomes its respawn point.
func _on_entry_settled() -> void:
	if _rule("save") == "room":
		save_run()


# --- effects -------------------------------------------------------------------------

## Rebuild a room (its enemies respawn) with a fresh player at `at`, keeping the player's health.
func respawn_at(id: String, at: Vector2) -> void:
	var health: int = main._player.health if main._player != null and is_instance_valid(main._player) else -1
	_enter(id, at, null)
	if health >= 0:
		main._player.health = health


func restore_health() -> void:
	main._player.health = main._player.max_health


## Hurt the player (no knockback); ignored while invulnerable. At 0 health they die.
func apply_damage(amount: int) -> void:
	if amount > 0:
		main._player.hit(0.0, 0.0, amount)


## Put the player back, standing still, on the last ground they stood safely on.
func return_to_safe_ground() -> void:
	var player: Node = main._player
	player._dash_frames = 0
	player._pounding = false
	_place(player, _safe, Vector2.ZERO)


## Save the run (room, respawn point, abilities, visited) in this browser. No-op headless.
func save_run() -> void:
	var storage = _storage()
	if storage != null:
		storage.setItem(_save_key, JSON.stringify({"room": room_id, "entry": {"x": entry.x, "y": entry.y}, "abilities": abilities, "visited": visited}))


## The saved run as {room, at}, restoring abilities and visited; {} if none (or its room is gone).
func load_run() -> Dictionary:
	var storage = _storage()
	if storage == null:
		return {}
	var data = JSON.parse_string(str(storage.getItem(_save_key)))
	if typeof(data) != TYPE_DICTIONARY or not _rooms.has(data.get("room")) or typeof(data.get("entry")) != TYPE_DICTIONARY:
		return {}
	if typeof(data.get("abilities")) == TYPE_ARRAY:
		abilities = data.abilities
	if typeof(data.get("visited")) == TYPE_ARRAY:
		visited = data.visited
	return {"room": str(data.room), "at": Vector2(float(data.entry.x), float(data.entry.y))}


func _storage():
	return JavaScriptBridge.get_interface("localStorage") if OS.has_feature("web") else null


# --- the run: rooms, doors, safe ground ------------------------------------------------

## Build a room and put the player in it at `at` (a fresh player unless one is carried through a door).
func _enter(id: String, at: Vector2, carried: Node) -> void:
	room_id = id
	entry = at
	_safe = at
	_settled = false
	_hazard = false
	if not id in visited:
		visited.append(id)
	main._build_room(_rooms[id], at, carried, abilities)
	_on_room_entered()


func _physics_process(_delta: float) -> void:
	if not active or main._mode != "play" or main._player == null or not is_instance_valid(main._player):
		return
	var player: Node = main._player
	if _hazard:
		_hazard = false
		_on_hazard(player)
		return
	if _on_safe_ground(player):
		_safe = player.position
		if not _settled:
			_settled = true
			entry = player.position
			_on_entry_settled()
	_check_doors(player)


## Standing with both feet on ground that can't hurt or vanish.
func _on_safe_ground(player: Node) -> bool:
	var floor = player._floor_solid
	if not player._on_floor or floor == null or not str(floor.kind) in ["solid", "ledge", "oneway"]:
		return false
	var half: float = player._size.x / 2.0
	return floor.x <= player.position.x - half and floor.x + floor.w >= player.position.x + half


func _check_doors(player: Node) -> void:
	var room: Dictionary = _rooms[room_id]
	var at: Vector2 = player.position
	var side := ""
	if at.x < 0.0:
		side = "left"
	elif at.x > float(room.width):
		side = "right"
	elif at.y > float(room.height):
		side = "bottom"
	elif at.y < 0.0:
		side = "top"
	if side == "":
		return
	var size: Vector2 = player._size
	for door in room.doors:
		if door.side != side or typeof(door.get("to")) != TYPE_DICTIONARY:
			continue
		var lo := float(door.offset) * TILE
		var hi := lo + float(door.size) * TILE
		var inside := (at.y > lo and at.y - size.y < hi) if side in ["left", "right"] else (at.x >= lo and at.x <= hi)
		if inside:
			_go_through(player, door, at - (Vector2(0, lo) if side in ["left", "right"] else Vector2(lo, 0)))
			return


## Leave through `door` (`along` = position relative to its opening) into the door it leads to.
func _go_through(player: Node, door: Dictionary, along: Vector2) -> void:
	var target: Dictionary = _rooms.get(door.to.room, {})
	var arrive = null
	for d in target.get("doors", []):
		if d.id == door.to.door:
			arrive = d
	if arrive == null:
		return
	var size: Vector2 = player._size
	var lo := float(arrive.offset) * TILE
	var hi := lo + float(arrive.size) * TILE
	var velocity := Vector2(player._vx, player._vy)
	var at := Vector2.ZERO
	match str(arrive.side):
		"left", "right":
			at.x = size.x / 2.0 + 1.0 if arrive.side == "left" else float(target.width) - size.x / 2.0 - 1.0
			at.y = minf(maxf(lo + along.y, lo + size.y), hi)
		"top", "bottom":
			at.x = clampf(lo + along.x, lo + size.x / 2.0, maxf(lo + size.x / 2.0, hi - size.x / 2.0))
			if arrive.side == "top":
				at.y = size.y + 1.0
			else:
				at.y = float(target.height) - 1.0
				velocity.y = minf(velocity.y, -sqrt(2.0 * float(main._project.sandbox.gravity) * UP_CARRY))
	_enter(str(target.id), at, player)
	_place(player, at, velocity)


func _place(player: Node, at: Vector2, velocity: Vector2) -> void:
	player._px = at.x
	player._py = at.y
	player._vx = velocity.x
	player._vy = velocity.y
	player.position = at
	player.velocity = velocity
	player.camera.reset_smoothing()
