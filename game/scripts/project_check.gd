extends RefCounted
## Defensive structural check of an incoming project. The studio validates
## the full schema (Zod) before sending; this only guarantees the runtime
## never crashes on a bad message. Returns "" when OK, else a reason.

const Registry := preload("res://primitives/registry.gd")


static func check(project: Variant) -> String:
	if typeof(project) != TYPE_DICTIONARY:
		return "project must be an object"
	if not _is_num(project, "revision"):
		return "project.revision must be a number"
	if typeof(project.get("characters")) != TYPE_ARRAY:
		return "project.characters must be an array"
	if typeof(project.get("world")) != TYPE_DICTIONARY:
		return "project.world must be an object"

	var ids := {}
	var players := 0
	for c in project.characters:
		var problem := _check_character(c)
		if problem != "":
			return problem
		ids[c.id] = c.kind
		if c.kind == "player":
			players += 1
	if players != 1:
		return "a project needs exactly one player character"

	var world: Dictionary = project.world
	if not _is_num(world, "gravity"):
		return "world.gravity must be a number"
	for key in ["backgroundColor", "platformColor"]:
		if not _is_color(world.get(key)):
			return "world.%s must be a #rrggbb color" % key
	var test = world.get("playtest")
	if test != null:
		if typeof(test) != TYPE_DICTIONARY or typeof(test.get("room")) != TYPE_STRING or not _all_num(test, ["x", "y"]):
			return "world.playtest needs a room and numeric x, y"
		for ability in test.get("abilities", []):
			if typeof(ability) != TYPE_STRING:
				return "world.playtest.abilities must hold ability names"
	return _check_world(world, ids)


## World rooms: derived geometry, doors and enemy spawns.
static func _check_world(world: Variant, ids: Dictionary) -> String:
	if world == null:
		return ""
	if typeof(world) != TYPE_DICTIONARY or typeof(world.get("rooms", [])) != TYPE_ARRAY:
		return "world.rooms must be an array"
	var problem := _check_handlers(world.get("handlers", []), "world")
	if problem != "":
		return problem
	for room in world.get("rooms", []):
		if typeof(room) != TYPE_DICTIONARY or typeof(room.get("id")) != TYPE_STRING or not _all_num(room, ["width", "height"]):
			return "every world room needs an id and numeric width, height (send core toRuntimeProject)"
		for key in ["solids", "doors", "spawns"]:
			if typeof(room.get(key)) != TYPE_ARRAY:
				return "room '%s' needs a %s array" % [room.id, key]
		problem = check_solids(room.solids)
		if problem != "":
			return problem
		problem = _check_handlers(room.get("handlers", []), "room '%s'" % room.id)
		if problem != "":
			return problem
		for prop in room.get("props", []):
			if typeof(prop) != TYPE_DICTIONARY or typeof(prop.get("id")) != TYPE_STRING or not _all_num(prop, ["x", "y", "width", "height"]):
				return "room '%s' has a malformed prop" % room.id
			problem = _check_handlers(prop.get("handlers", []), "prop '%s'" % prop.id)
			if problem != "":
				return problem
		for door in room.doors:
			if typeof(door) != TYPE_DICTIONARY or not door.get("side") in ["left", "right", "top", "bottom"] or not _all_num(door, ["offset", "size"]):
				return "room '%s' has a malformed door" % room.id
		for spawn in room.spawns:
			if typeof(spawn) != TYPE_DICTIONARY or not _all_num(spawn, ["x", "y"]) or ids.get(spawn.get("characterId")) != "enemy":
				return "room '%s' spawns must be enemies with numeric x, y" % room.id
			problem = _check_handlers(spawn.get("handlers", []), "spawn '%s'" % spawn.get("id"))
			if problem != "":
				return problem
	return ""


## Handlers: {on: {type}, when: [...], do: [{type, ...}]} (core events/events.ts validates the details).
static func _check_handlers(handlers: Variant, where: String) -> String:
	if typeof(handlers) != TYPE_ARRAY:
		return "%s handlers must be an array" % where
	for h in handlers:
		if typeof(h) != TYPE_DICTIONARY or typeof(h.get("on")) != TYPE_DICTIONARY or typeof(h.on.get("type")) != TYPE_STRING:
			return "%s has a handler without an event" % where
		if typeof(h.get("when", [])) != TYPE_ARRAY or typeof(h.get("do")) != TYPE_ARRAY:
			return "%s handler for %s needs when and do lists" % [where, h.on.type]
		for effect in h.do:
			if typeof(effect) != TYPE_DICTIONARY or typeof(effect.get("type")) != TYPE_STRING:
				return "%s handler for %s has an effect without a type" % [where, h.on.type]
	return ""


static func _check_character(c: Variant) -> String:
	if typeof(c) != TYPE_DICTIONARY or typeof(c.get("id")) != TYPE_STRING:
		return "every character needs a string id"
	if not _is_color(c.get("color")):
		return "character '%s' needs a #rrggbb color" % c.id
	if typeof(c.get("size")) != TYPE_DICTIONARY or not _all_num(c.size, ["width", "height"]):
		return "character '%s' needs a numeric size" % c.id
	if typeof(c.get("stats")) != TYPE_DICTIONARY:
		return "character '%s' needs stats" % c.id
	match c.get("kind"):
		"player":
			var needed := ["runSpeed", "jumpVelocity", "health", "attackDamage", "attackReach", "attackCooldown", "pogoVelocity", "maxFallSpeed", "coyoteTime", "jumpBuffer"]
			if not _all_num(c.stats, needed):
				return "player '%s' needs numeric %s" % [c.id, ", ".join(needed)]
			var abilities = c.get("abilities", {})
			if typeof(abilities) != TYPE_DICTIONARY:
				return "player '%s' abilities must be an object" % c.id
			for ability in abilities:
				if typeof(abilities[ability]) != TYPE_DICTIONARY or not _all_num(abilities[ability], abilities[ability].keys()):
					return "player '%s' ability '%s' needs numeric tuning" % [c.id, ability]
		"enemy":
			if not _all_num(c.stats, ["knockback", "health", "contactDamage"]):
				return "enemy '%s' needs numeric knockback, health and contactDamage" % c.id
			if c.stats.has("armor") and not _is_num(c.stats, "armor"):
				return "enemy '%s' armor must be a number" % c.id
			var death = c.get("death")
			if death != null and (typeof(death) != TYPE_DICTIONARY or not _all_num(death, death.keys())):
				return "enemy '%s' death needs numeric linger and fade" % c.id
			if not c.get("movement", "ground") in ["ground", "flying"]:
				return "enemy '%s' has an unknown movement type" % c.id
			return _check_behavior(c.id, c.get("behavior"))
		_:
			return "character '%s' has unknown kind" % c.id
	return ""


static func _is_num(d: Dictionary, key: String) -> bool:
	var t := typeof(d.get(key))
	return t == TYPE_INT or t == TYPE_FLOAT


static func _all_num(d: Dictionary, keys: Array) -> bool:
	for key in keys:
		if not _is_num(d, key):
			return false
	return true


static func _is_color(v: Variant) -> bool:
	return typeof(v) == TYPE_STRING and v.length() == 7 and v.begins_with("#") and v.substr(1).is_valid_hex_number()


static func _check_behavior(id: String, behavior: Variant) -> String:
	if typeof(behavior) != TYPE_DICTIONARY or typeof(behavior.get("states")) != TYPE_DICTIONARY:
		return "enemy '%s' needs a behavior with states" % id
	var states: Dictionary = behavior.states
	if not states.has(behavior.get("initial")):
		return "enemy '%s' behavior has no initial state '%s'" % [id, behavior.get("initial")]
	for interrupt in behavior.get("interrupts", []):
		if typeof(interrupt) != TYPE_DICTIONARY or not states.has(interrupt.get("to")):
			return "enemy '%s' has an interrupt to an unknown state" % id
		var bad := _check_conditions("enemy '%s' interrupt" % id, interrupt)
		if bad != "":
			return bad
	for state_id in states:
		var state = states[state_id]
		var where := "enemy '%s' state '%s'" % [id, state_id]
		if typeof(state) != TYPE_DICTIONARY or typeof(state.get("transitions")) != TYPE_ARRAY:
			return "%s needs an action and transitions" % where
		var problem := _check_primitive(where + " action", state.get("action"), Registry.ACTIONS)
		if problem != "":
			return problem
		for transition in state.transitions:
			if typeof(transition) != TYPE_DICTIONARY or not states.has(transition.get("to")):
				return "%s has a transition to an unknown state" % where
			problem = _check_conditions(where + " transition", transition)
			if problem != "":
				return problem
	return ""


static func _check_conditions(where: String, transition: Dictionary) -> String:
	var extra = transition.get("and", [])
	if typeof(extra) != TYPE_ARRAY:
		return "%s has a malformed 'and' list" % where
	for condition in [transition.get("when")] + extra:
		var problem := _check_primitive(where + " condition", condition, Registry.CONDITIONS)
		if problem != "":
			return problem
	return ""


static func _check_primitive(where: String, primitive: Variant, registry: Dictionary) -> String:
	if typeof(primitive) != TYPE_DICTIONARY or not registry.has(primitive.get("type")):
		return "%s has an unknown type" % where
	var params: Dictionary = registry[primitive.type].PARAMS
	for param in params:
		if not _valid_param(params[param], primitive.get(param)):
			return "%s (%s) needs a valid '%s'" % [where, primitive.type, param]
	return ""


static func _valid_param(kind: String, value: Variant) -> bool:
	match kind:
		"number":
			return typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT
		"bool":
			return typeof(value) == TYPE_BOOL
		"color":
			return _is_color(value)
		"id":
			return typeof(value) == TYPE_STRING and value != ""
		"id?":
			return value == null or (typeof(value) == TYPE_STRING and value != "")
		"object":
			return typeof(value) == TYPE_DICTIONARY
	if kind.begins_with("enum:"):
		return typeof(value) == TYPE_STRING and value in kind.substr(5).split("|")
	return false


## Solids derived from a tile grid (core gridToSolids): numeric rectangles with a known kind.
static func check_solids(solids: Array) -> String:
	for rect in solids:
		if typeof(rect) != TYPE_DICTIONARY or not _all_num(rect, ["x", "y", "width", "height"]):
			return "every solid needs numeric x, y, width, height"
		if not str(rect.get("kind", "")) in ["solid", "ledge", "oneway", "hazard", "breakable"]:
			return "solid kind must be solid, ledge, oneway, hazard or breakable"
	return ""
