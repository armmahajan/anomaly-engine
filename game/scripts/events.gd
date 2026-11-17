extends RefCounted
## The game-logic engine (core events/events.ts is the contract). Handlers
## ({on, when, do}) on the world, the current room, its props and its spawns
## react to events; conditions read the run's flags, items, abilities and
## visited rooms; effects run in order.
##
## Events are queued (`fire`) and handled by `flush`, which world_runtime.gd
## calls where rebuilding the room is safe (after the world's physics step).
## Effects are a registry: the run's own (flags, items, health, respawn,
## saving, timers) live here; others register theirs (modal.gd, fx.gd).

signal changed  ## flags, items or abilities changed (props re-check their conditions)

var run: Node = null  ## world_runtime.gd
var flags := {}
var items := {}
## {room, x, y} or {} (none yet).
var checkpoint := {}
## timer id -> seconds left.
var timers := {}

var _effects := {}
var _queue: Array = []
var _flushing := false

const MAX_EVENTS_PER_FLUSH := 200


func _init(world_run: Node) -> void:
	run = world_run
	for type in ["setFlag", "giveItem", "takeItem", "grantAbility", "heal", "damage", "respawn", "returnToSafeGround", "setCheckpoint", "saveRun", "startTimer"]:
		register(type, Callable(self, "_effect_" + type))


## Add (or replace) an effect: `callable(effect: Dictionary, context: Dictionary)`.
func register(type: String, callable: Callable) -> void:
	_effects[type] = callable


func effect_types() -> Array:
	return _effects.keys()


func reset() -> void:
	flags = {}
	items = {}
	checkpoint = {}
	timers = {}
	_queue = []


## Queue an event: {type, room?, spawn?, character?, prop?, timer?}. Handled on the next flush.
func fire(event: Dictionary) -> void:
	if not event.has("room"):
		event.room = run.room_id
	_queue.append(event)


func flush() -> void:
	if _flushing:
		return
	_flushing = true
	var handled := 0
	while not _queue.is_empty() and handled < MAX_EVENTS_PER_FLUSH and run.active:
		var event: Dictionary = _queue.pop_front()
		handled += 1
		# Conditions are judged when the event happens, before any of its handlers run
		# (so "with the item: open" and "without it: say it's locked" never both fire).
		var ready := _handlers_for(event).filter(func(found): return found.handler.get("when", []).all(holds))
		for found in ready:
			run_effects(found.handler.get("do", []), found.context)
	if handled >= MAX_EVENTS_PER_FLUSH:
		push_warning("[events] more than %d events in one frame; the rest were dropped" % MAX_EVENTS_PER_FLUSH)
		_queue.clear()
	_flushing = false


## Every handler that answers `event`, with the context its effects run in.
func _handlers_for(event: Dictionary) -> Array:
	var out := []
	var room: Dictionary = run.current_room()
	var here := {"room": run.room_id}
	for handler in run.world_handlers():
		if _matches(handler.on, event, {}):
			out.append({"handler": handler, "context": here})
	if room.is_empty() or event.get("room", run.room_id) != run.room_id:
		return out
	for handler in room.get("handlers", []):
		if _matches(handler.on, event, {"room": room.id}):
			out.append({"handler": handler, "context": here})
	for prop in room.get("props", []):
		if not run.prop_present(prop):
			continue
		for handler in prop.get("handlers", []):
			if _matches(handler.on, event, {"room": room.id, "prop": prop.id}):
				out.append({"handler": handler, "context": {"room": run.room_id, "prop": prop}})
	for spawn in room.get("spawns", []):
		for handler in spawn.get("handlers", []):
			if _matches(handler.on, event, {"room": room.id, "spawn": spawn.id}):
				out.append({"handler": handler, "context": {"room": run.room_id, "spawn": spawn}})
	return out


## `on` (a handler's event pattern) matches `event`; `scope` pins fields for scoped handlers.
func _matches(on: Dictionary, event: Dictionary, scope: Dictionary) -> bool:
	if on.get("type") != event.get("type"):
		return false
	# Prop events only reach the prop they are about.
	if event.has("prop") and scope.get("prop") != event.prop:
		return false
	for key in ["room", "spawn", "character", "timer"]:
		var wanted = on.get(key, scope.get(key))
		if wanted != null and event.has(key) and event[key] != wanted:
			return false
		if wanted != null and not event.has(key) and key != "room":
			return false
	return true


func holds(condition) -> bool:
	if typeof(condition) == TYPE_BOOL:
		return condition
	match str(condition.get("type")):
		"flag":
			return flags.has(str(condition.flag)) == bool(condition.get("is", true))
		"item":
			return int(items.get(str(condition.item), 0)) >= int(condition.get("atLeast", 1))
		"ability":
			return str(condition.ability) in run.abilities
		"visited":
			return str(condition.room) in run.visited
		"all":
			return condition.of.all(holds)
		"any":
			return condition.of.any(holds)
		"not":
			return not holds(condition.of)
	push_warning("[events] unknown condition " + str(condition.get("type")))
	return false


func run_effects(effects: Array, context: Dictionary) -> void:
	for effect in effects:
		var callable: Callable = _effects.get(str(effect.get("type")), Callable())
		if callable.is_valid():
			callable.call(effect, context)
		else:
			push_warning("[events] no effect " + str(effect.get("type")))


## Advance timers (seconds of game time); fire the ones that run out.
func tick(delta: float) -> void:
	for id in timers.keys():
		timers[id] -= delta
		if timers[id] <= 0.0:
			timers.erase(id)
			fire({"type": "timer", "timer": id, "room": run.room_id})


# --- the run's own effects -------------------------------------------------------------

func _effect_setFlag(effect: Dictionary, _context: Dictionary) -> void:
	if bool(effect.get("value", true)):
		flags[str(effect.flag)] = true
	else:
		flags.erase(str(effect.flag))
	changed.emit()


func _effect_giveItem(effect: Dictionary, _context: Dictionary) -> void:
	var id := str(effect.item)
	items[id] = int(items.get(id, 0)) + int(effect.get("count", 1))
	changed.emit()


func _effect_takeItem(effect: Dictionary, _context: Dictionary) -> void:
	var id := str(effect.item)
	var left := int(items.get(id, 0)) - int(effect.get("count", 1))
	if left > 0:
		items[id] = left
	else:
		items.erase(id)
	changed.emit()


func _effect_grantAbility(effect: Dictionary, _context: Dictionary) -> void:
	run.grant_ability(str(effect.ability))
	changed.emit()


func _effect_heal(effect: Dictionary, _context: Dictionary) -> void:
	run.heal(effect.get("amount"))


func _effect_damage(effect: Dictionary, _context: Dictionary) -> void:
	run.apply_damage(int(effect.amount))


func _effect_respawn(effect: Dictionary, _context: Dictionary) -> void:
	run.respawn(str(effect.get("at", "entry")))


func _effect_returnToSafeGround(_effect: Dictionary, _context: Dictionary) -> void:
	run.return_to_safe_ground()


func _effect_setCheckpoint(effect: Dictionary, context: Dictionary) -> void:
	if effect.has("room"):
		checkpoint = {"room": str(effect.room), "x": float(effect.x), "y": float(effect.y)}
		return
	var at: Vector2 = run.player_feet()
	var prop = context.get("prop")
	# A prop's checkpoint is standing at its middle, on the ground under it.
	if typeof(prop) == TYPE_DICTIONARY:
		at = Vector2(float(prop.x) + float(prop.width) / 2.0, at.y)
	checkpoint = {"room": run.room_id, "x": at.x, "y": at.y}


func _effect_saveRun(_effect: Dictionary, _context: Dictionary) -> void:
	run.save_run()


func _effect_startTimer(effect: Dictionary, _context: Dictionary) -> void:
	timers[str(effect.timer)] = float(effect.seconds)
