extends Node
## World play: the run through the game's rooms. Tracks the current room,
## where the player entered it, the last safe ground, visited rooms and
## abilities, and walks the player through doors. main.gd builds the rooms
## (`_build_room`). Runs after the world each physics frame
## (process_physics_priority), so it sees where the player ended up.
##
## Game logic is handlers (events.gd): this file fires the run's events
## (gameStarted, roomEntered, roomSettled, playerDied, hazardTouched,
## enemyKilled, roomCleared) and implements the run's effects (respawn, heal,
## damage, back to safe ground, saving) for events.gd. The game rules arrive
## as handlers too (core events/rules.ts), so nothing here decides what an
## event does.

const EventsScript := preload("res://scripts/events.gd")
const TILE := 32.0
const OPPOSITE := {"left": "right", "right": "left", "top": "bottom", "bottom": "top"}
## Going up through a top door: at least this rise (px) in the room above, to clear its floor.
const UP_CARRY := 3.0 * TILE  # core world.ts DOOR_UP_CARRY: the traversal checker assumes the same
const SAVE_PREFIX := "anomaly-save:"

## Saves when there is no browser storage (headless runs), for the whole process.
static var _memory_store := {}

var main: Node = null
var events = null
var active := false
## Set while gameplay is paused (a modal is open): no doors, no timers.
var paused := false
var room_id := ""
## Where the player comes back on respawn at "entry": where they entered the
## room, moved to the first ground they stood on there (entering mid-air or from below).
var entry := Vector2.ZERO
var abilities: Array = []
var visited: Array = []

var _rooms := {}
var _world_handlers: Array = []
var _start := {}
var _origin := {}
var _settled := false
var _safe := Vector2.ZERO
var _hazard := false
var _save_key := ""


func _init() -> void:
	process_physics_priority = 100
	events = EventsScript.new(self)


## Start a run from a play message's `world` ({room, x, y, abilities, continue}). Returns a problem or "".
func start(project: Dictionary, start: Dictionary) -> String:
	var world: Dictionary = project.get("world", {})
	_rooms = {}
	for room in world.get("rooms", []):
		_rooms[room.id] = room
	_world_handlers = world.get("handlers", [])
	_start = world.get("start") if typeof(world.get("start")) == TYPE_DICTIONARY else {}
	_save_key = SAVE_PREFIX + str(project.get("id", ""))
	var problem := _check_start(start)
	if problem != "":
		return problem
	events.reset()
	abilities = start.get("abilities", []).duplicate()
	visited = []
	_origin = {"room": str(start.room), "at": Vector2(start.x, start.y)}
	var from := _origin
	if start.get("continue", false):
		var saved := load_run()
		if not saved.is_empty():
			from = saved
	active = true
	paused = false
	room_id = from.room
	events.fire({"type": "gameStarted"})
	_enter(from.room, from.at, null)
	events.flush()
	return ""


func stop() -> void:
	active = false
	paused = false
	room_id = ""
	events.reset()


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


# --- what events.gd reads ------------------------------------------------------------

func current_room() -> Dictionary:
	return _rooms.get(room_id, {})


func world_handlers() -> Array:
	return _world_handlers


## A prop takes part (drawn, solid, fires and answers events) unless hidden or destroyed.
func prop_present(prop: Dictionary) -> bool:
	var props = main._props
	if props != null and is_instance_valid(props):
		return props.is_present(prop)
	return events.holds(prop.get("visible", true))


func player_feet() -> Vector2:
	return main._player.position if _player_ok() else entry


func _player_ok() -> bool:
	return main._player != null and is_instance_valid(main._player)


# --- events ----------------------------------------------------------------------------

## The player died (main.gd, deferred, so the room can be rebuilt).
func on_player_died() -> void:
	events.fire({"type": "playerDied"})
	events.flush()


## The player touched a hazard tile (player.gd signal; handled after the frame's movement).
func on_hazard_touched() -> void:
	_hazard = true


## An enemy died (enemy.gd signal, mid-frame: handled after the frame's movement).
func on_enemy_killed(spawn_id: String, character_id: String) -> void:
	events.fire({"type": "enemyKilled", "spawn": spawn_id, "character": character_id})
	var alive: bool = main._world != null and main._world.get_children().any(func(c): return c is CharacterBody2D and "dead" in c and not c.dead and c != main._player)
	if not alive:
		events.fire({"type": "roomCleared"})


# --- effects (called by events.gd) ------------------------------------------------------

## Back at "entry" (where they entered this room), "start" (the game's start) or "checkpoint" (else the start).
func respawn(at: String) -> void:
	var target := {"room": room_id, "at": entry}
	if at == "checkpoint" and not events.checkpoint.is_empty() and _rooms.has(events.checkpoint.room):
		target = {"room": str(events.checkpoint.room), "at": Vector2(events.checkpoint.x, events.checkpoint.y)}
	elif at in ["start", "checkpoint"]:
		target = {"room": str(_start.room), "at": Vector2(_start.x, _start.y)} if _rooms.has(_start.get("room")) else _origin
	respawn_at(target.room, target.at)


## Rebuild a room (its enemies respawn) with a fresh player at `at`, keeping the player's health.
func respawn_at(id: String, at: Vector2) -> void:
	var health: int = main._player.health if _player_ok() else -1
	_enter(id, at, null)
	if health >= 0:
		main._player.health = health


## Restore `amount` health (null = all of it).
func heal(amount) -> void:
	if not _player_ok():
		return
	var player: Node = main._player
	player.health = player.max_health if amount == null else mini(player.max_health, player.health + int(amount))


## Hurt the player (no knockback); ignored while invulnerable. At 0 health they die.
func apply_damage(amount: int) -> void:
	if amount > 0 and _player_ok():
		main._player.hit(0.0, 0.0, amount)


## Put the player back, standing still, on the last ground they stood safely on (if alive).
func return_to_safe_ground() -> void:
	if not _player_ok() or main._player.health <= 0:
		return
	var player: Node = main._player
	player._dash_frames = 0
	player._pounding = false
	_place(player, _safe, Vector2.ZERO)


func grant_ability(ability: String) -> void:
	if not ability in abilities:
		abilities.append(ability)
	if _player_ok():
		main._player.grant_ability(ability)


## Save the run (room, respawn point, abilities, visited, flags, items, checkpoint) in this browser
## (headless: in memory, for this process).
func save_run() -> void:
	var data := JSON.stringify({
		"room": room_id, "entry": {"x": entry.x, "y": entry.y}, "abilities": abilities, "visited": visited,
		"flags": events.flags.keys(), "items": events.items, "checkpoint": events.checkpoint,
	})
	var storage = _storage()
	if storage != null:
		storage.setItem(_save_key, data)
	else:
		_memory_store[_save_key] = data


## The saved run as {room, at}, restoring the rest; {} if none (or its room is gone).
func load_run() -> Dictionary:
	var storage = _storage()
	var raw = storage.getItem(_save_key) if storage != null else _memory_store.get(_save_key)
	var data = JSON.parse_string(str(raw)) if raw != null else null
	if typeof(data) != TYPE_DICTIONARY or not _rooms.has(data.get("room")) or typeof(data.get("entry")) != TYPE_DICTIONARY:
		return {}
	if typeof(data.get("abilities")) == TYPE_ARRAY:
		abilities = data.abilities
	if typeof(data.get("visited")) == TYPE_ARRAY:
		visited = data.visited
	if typeof(data.get("flags")) == TYPE_ARRAY:
		for flag in data.flags:
			events.flags[str(flag)] = true
	if typeof(data.get("items")) == TYPE_DICTIONARY:
		for item in data.items:
			events.items[str(item)] = int(data.items[item])
	if typeof(data.get("checkpoint")) == TYPE_DICTIONARY:
		events.checkpoint = data.checkpoint
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
	main._send({"type": "roomEntered", "room": id})
	events.fire({"type": "roomEntered"})


func _physics_process(delta: float) -> void:
	if not active or paused or main._mode != "play" or not _player_ok():
		return
	var player: Node = main._player
	if _hazard:
		_hazard = false
		events.fire({"type": "hazardTouched"})
	else:
		if _on_safe_ground(player):
			_safe = player.position
			if not _settled:
				_settled = true
				entry = player.position
				events.fire({"type": "roomSettled"})
		_check_doors(player)
	events.tick(delta)
	events.flush()


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
				velocity.y = minf(velocity.y, -sqrt(2.0 * float(main._project.world.get("gravity", 1800)) * UP_CARRY))
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
