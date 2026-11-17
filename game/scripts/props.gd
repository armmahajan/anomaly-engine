extends Node2D
## The props of one room: generic rectangles that are drawn, can be solid (in
## the player's `solids` and as bodies for enemies), fire touch / interact /
## hit / destroyed (events.gd) and follow the run's flags and items through
## their `solid` and `visible` conditions. main.gd adds one per built room
## (also in edit mode and on the Rooms stage, with no player).

const Level := preload("res://scripts/level.gd")
## Edit stages draw every prop; those that depend on the run are faded.
const FADED := 0.45
## Shown above a prop the player can interact with when it has no prompt of its own (drawn as an arrow).
const DEFAULT_PROMPT := "↑"
const PROMPT_SIZE := 14
## Art is stretched at most this much one way to fill a prop's rectangle.
const MAX_STRETCH := 1.5

var main: Node = null
var room: Dictionary = {}
## The player's collision list for this room (dicts like level.gd's); solid props add theirs.
var solids: Array = []
## The player in this room, or null (edit stages).
var player: Node = null

var _props := {}  ## id -> prop
var _views := {}  ## id -> PropView (also the player's sword target for that prop)
var _solid := {}  ## id -> its entry in `solids` (with its body)
var _waiting := {}  ## id -> true: should be solid, but the player is inside it; solid once they step out
var _touching := {}  ## id -> true while the player overlaps it
var _hits := {}  ## id -> sword hits taken this visit
var _dying := {}  ## id -> true: out of health; gone once the run has handled its destroyed event
var _gone := {}  ## id -> true: destroyed this visit


func setup(main_node: Node, room_data: Dictionary, room_solids: Array, room_player: Node) -> void:
	main = main_node
	room = room_data
	solids = room_solids
	player = room_player
	# After the player moves (0), before the run handles the frame's events (world_runtime.gd, 100).
	process_physics_priority = 1
	for prop in room.get("props", []):
		var id := str(prop.id)
		var view := PropView.new()
		view.props = self
		view.prop = prop
		add_child(view)
		_props[id] = prop
		_views[id] = view
		if player != null:
			player.targets.append(view)
	if player != null and player.get_parent() == get_parent():
		get_parent().move_child(self, player.get_index())  # drawn behind the characters
	refresh()


func _exit_tree() -> void:
	if player != null and is_instance_valid(player):
		for view in _views.values():
			player.targets.erase(view)


## Whether a prop takes part: drawn, solid, fires and answers events. Hidden (and destroyed) props don't.
func is_present(prop: Dictionary) -> bool:
	return not _gone.has(str(prop.id)) and main._run.events.holds(prop.get("visible", true))


## Flags, items or abilities changed: re-check every prop's solid and visible.
func refresh() -> void:
	var live := _live()
	for id in _props:
		var prop: Dictionary = _props[id]
		var present := is_present(prop)
		_views[id].visible = present or not live
		if not present:
			_touching.erase(id)
		var solid: bool = present and main._run.events.holds(prop.get("solid", false))
		if solid and not _solid.has(id):
			if _player_inside(prop):
				_waiting[id] = true
			else:
				_add_solid(id)
		elif not solid:
			_waiting.erase(id)
			_remove_solid(id)


## [{id, visible, solid, prompt?}] for the runtime's state (`prompt`: the text shown above it now).
func state() -> Array:
	var out := []
	for id in _props:
		var entry := {"id": id, "visible": is_present(_props[id]), "solid": _solid.has(id)}
		if _views[id].prompting:
			entry.prompt = _prompt_text(_props[id])
		out.append(entry)
	return out


## For tests: what each prop looks like now: {id, shown, art (the kit piece drawn, or null), rect (room px, where it is drawn)}.
func drawing() -> Array:
	var out := []
	for id in _props:
		var view: PropView = _views[id]
		var at: Rect2 = view.art_rect() if view._texture != null else Rect2(Vector2.ZERO, rect_of(_props[id]).size)
		at.position += view.position
		out.append({
			"id": id, "shown": view.is_visible_in_tree(),
			"art": _props[id].art.piece if view._texture != null else null,
			"rect": [at.position.x, at.position.y, at.size.x, at.size.y],
		})
	return out


func _live() -> bool:
	return player != null and is_instance_valid(player) and main._run.active


func _physics_process(_delta: float) -> void:
	if not _live() or main._mode != "play":
		return
	var events = main._run.events
	var body: Rect2 = player.rect()
	for id in _waiting.keys():
		if not body.intersects(rect_of(_props[id])):
			_waiting.erase(id)
			_add_solid(id)
	var interact := Input.is_action_just_pressed("interact")
	for id in _props:
		var prop: Dictionary = _props[id]
		var view: PropView = _views[id]
		var over := is_present(prop) and body.intersects(rect_of(prop), true)  # touching its edge counts (standing on it)
		if over and not _touching.has(id):
			_touching[id] = true
			events.fire({"type": "touch", "prop": id})
		elif not over:
			_touching.erase(id)
		var can_interact := over and _answers(prop, "interact")
		if can_interact != view.prompting:
			view.prompting = can_interact
			view.prompt_mark.queue_redraw()
		if can_interact and interact:
			events.fire({"type": "interact", "prop": id})


## The player's sword reached a prop. True for a landed hit (a downward one bounces the player).
func strike(prop: Dictionary, push: Vector2) -> bool:
	var id := str(prop.id)
	if not _live() or not is_present(prop) or _dying.has(id):
		return false
	var events = main._run.events
	events.fire({"type": "hit", "prop": id})
	var health = prop.get("health")
	if health != null:
		_hits[id] = int(_hits.get(id, 0)) + 1
		if _hits[id] >= int(health):
			_dying[id] = true
			events.fire({"type": "destroyed", "prop": id})
			# Deferred: the run handles the frame's events first, and only answers props that are present.
			_destroy.call_deferred(id)
	var bounce := bool(prop.get("bounce", false))
	if push.y > 0.0:
		return bounce
	return bounce or health != null or _answers(prop, "hit")


func _destroy(id: String) -> void:
	_dying.erase(id)
	_gone[id] = true
	refresh()


static func rect_of(prop: Dictionary) -> Rect2:
	return Rect2(float(prop.x), float(prop.y), float(prop.width), float(prop.height))


static func _answers(prop: Dictionary, event: String) -> bool:
	return prop.get("handlers", []).any(func(h): return str(h.get("on", {}).get("type")) == event)


static func _prompt_text(prop: Dictionary) -> String:
	var text = prop.get("prompt")
	return str(text) if text != null and str(text) != "" else DEFAULT_PROMPT


func _player_inside(prop: Dictionary) -> bool:
	return player != null and is_instance_valid(player) and player.rect().intersects(rect_of(prop))


func _add_solid(id: String) -> void:
	var prop: Dictionary = _props[id]
	var body: StaticBody2D = Level._make_body(prop, "solid")
	add_child(body)
	var solid := {"x": float(prop.x), "y": float(prop.y), "w": float(prop.width), "h": float(prop.height), "kind": "solid", "group": null, "body": body}
	solids.append(solid)
	_solid[id] = solid


func _remove_solid(id: String) -> void:
	var solid = _solid.get(id)
	if solid == null:
		return
	solids.erase(solid)
	solid.body.queue_free()
	_solid.erase(id)


## Its art's texture (a biome kit piece the studio has sent), or null.
func _texture_for(prop: Dictionary) -> Texture2D:
	var art = prop.get("art")
	if typeof(art) != TYPE_DICTIONARY:
		return null
	for asset in main._project.get("art", {}).get("assets", []):
		if asset.get("id") == art.get("biome") and typeof(asset.get("kit")) == TYPE_DICTIONARY:
			for piece in asset.kit.get("pieces", []):
				if piece.get("id") == art.get("piece"):
					return main._textures.get(piece.get("file"))
	return null


## One prop: drawn as its color or art, and the player's sword target for it (rect(), struck()).
class PropView extends Node2D:
	var props: Node
	var prop: Dictionary
	var prompting := false
	## Draws the prompt above the characters.
	var prompt_mark := Node2D.new()
	var _texture: Texture2D = null

	func _ready() -> void:
		position = Vector2(float(prop.x), float(prop.y))
		prompt_mark.z_index = 5
		prompt_mark.draw.connect(_draw_prompt)
		add_child(prompt_mark)
		_texture = props._texture_for(prop)
		# Art whose image hasn't arrived yet: look again until it has (also while the room is frozen).
		process_mode = Node.PROCESS_MODE_ALWAYS
		set_process(_texture == null and typeof(prop.get("art")) == TYPE_DICTIONARY)

	func _process(_delta: float) -> void:
		_texture = props._texture_for(prop)
		if _texture != null:
			set_process(false)
			queue_redraw()

	func rect() -> Rect2:
		return props.rect_of(prop)

	func struck(_damage: int, push: Vector2) -> bool:
		return props.strike(prop, push)

	func _draw() -> void:
		var box := Rect2(Vector2.ZERO, Vector2(float(prop.width), float(prop.height)))
		var conditional: bool = typeof(prop.get("visible", true)) != TYPE_BOOL or prop.get("visible", true) != true or typeof(prop.get("solid", false)) != TYPE_BOOL
		var tint := Color(1, 1, 1, FADED if conditional and not props._live() else 1.0)
		if _texture != null:
			draw_texture_rect(_texture, art_rect(), false, tint)
		else:
			draw_rect(box, Color(str(prop.get("color", "#c9a227"))) * tint)

	## Where its art is drawn (prop-local): fitted to the rectangle, stretched at most MAX_STRETCH
	## one way (beyond that it keeps that shape, smaller), standing at the bottom centre. Empty without art.
	func art_rect() -> Rect2:
		if _texture == null:
			return Rect2()
		var w := float(prop.width)
		var h := float(prop.height)
		var sx := w / float(_texture.get_width())
		var sy := h / float(_texture.get_height())
		if sx > sy * MAX_STRETCH:
			sx = sy * MAX_STRETCH
		elif sy > sx * MAX_STRETCH:
			sy = sx * MAX_STRETCH
		var size := Vector2(_texture.get_width() * sx, _texture.get_height() * sy)
		return Rect2(Vector2((w - size.x) / 2.0, h - size.y), size)

	func _draw_prompt() -> void:
		if not prompting:
			return
		var top := Vector2(float(prop.width) / 2.0, -8.0)
		var text: String = props._prompt_text(prop)
		if text == DEFAULT_PROMPT:
			prompt_mark.draw_colored_polygon(PackedVector2Array([top + Vector2(0, -16), top + Vector2(-9, -4), top + Vector2(9, -4)]), Color.WHITE)
			return
		var font := ThemeDB.fallback_font
		var width := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, PROMPT_SIZE).x
		prompt_mark.draw_rect(Rect2(top.x - width / 2.0 - 6.0, top.y - 22.0, width + 12.0, 22.0), Color(0, 0, 0, 0.65))
		prompt_mark.draw_string(font, Vector2(top.x - width / 2.0, top.y - 6.0), text, HORIZONTAL_ALIGNMENT_LEFT, -1, PROMPT_SIZE, Color.WHITE)
