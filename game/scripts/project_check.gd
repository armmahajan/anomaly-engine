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
	if typeof(project.get("sandbox")) != TYPE_DICTIONARY:
		return "project.sandbox must be an object"

	var ids := {}
	for c in project.characters:
		var problem := _check_character(c)
		if problem != "":
			return problem
		ids[c.id] = c.kind

	var sandbox: Dictionary = project.sandbox
	for key in ["width", "height", "gravity"]:
		if not _is_num(sandbox, key):
			return "sandbox.%s must be a number" % key
	for key in ["backgroundColor", "platformColor"]:
		if not _is_color(sandbox.get(key)):
			return "sandbox.%s must be a #rrggbb color" % key
	if typeof(sandbox.get("platforms")) != TYPE_ARRAY or typeof(sandbox.get("spawns")) != TYPE_ARRAY:
		return "sandbox.platforms and sandbox.spawns must be arrays"
	for rect in sandbox.platforms:
		if typeof(rect) != TYPE_DICTIONARY or not _all_num(rect, ["x", "y", "width", "height"]):
			return "every platform needs numeric x, y, width, height"

	var players := 0
	for spawn in sandbox.spawns:
		if typeof(spawn) != TYPE_DICTIONARY or not _all_num(spawn, ["x", "y"]) or typeof(spawn.get("id")) != TYPE_STRING:
			return "every spawn needs a string id and numeric x, y"
		var kind = ids.get(spawn.get("characterId"))
		if kind == null:
			return "spawn references unknown character '%s'" % spawn.get("characterId")
		if kind == "player":
			players += 1
	if players != 1:
		return "sandbox needs exactly one player spawn"
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
			if not _all_num(c.stats, ["runSpeed", "jumpVelocity"]):
				return "player '%s' needs runSpeed and jumpVelocity" % c.id
		"enemy":
			if not _all_num(c.stats, ["knockback"]):
				return "enemy '%s' needs a numeric knockback" % c.id
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
			problem = _check_primitive(where + " condition", transition.get("when"), Registry.CONDITIONS)
			if problem != "":
				return problem
	return ""


static func _check_primitive(where: String, primitive: Variant, registry: Dictionary) -> String:
	if typeof(primitive) != TYPE_DICTIONARY or not registry.has(primitive.get("type")):
		return "%s has an unknown type" % where
	var params: Dictionary = registry[primitive.type].PARAMS
	for param in params:
		var ok := _is_num(primitive, param) if params[param] == "number" else _is_color(primitive.get(param))
		if not ok:
			return "%s (%s) needs a valid '%s'" % [where, primitive.type, param]
	return ""
