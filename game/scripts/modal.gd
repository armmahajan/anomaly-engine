extends CanvasLayer
## Modals: screens over the game with a title, text, an optional image and
## buttons that run effects (events.gd); gameplay pauses while one is open
## (main.set_paused). Also the optional map screen (map_view.gd). Implements
## the showModal, endGame and revealMap effects. Which screens a game has
## (and when) is data: handlers and buttons that show modals.

const MapView := preload("res://scripts/map_view.gd")
const WIDTH := 600.0
## Keys: left/right or up/down choose, Enter / Space / Z press.
const PREV := ["move_left", "aim_up", "ui_left", "ui_up"]
const NEXT := ["move_right", "aim_down", "ui_right", "ui_down"]
const ACCEPT := ["jump", "ui_accept"]
## Gameplay waits until these are let go after a modal closes, so its press doesn't carry into play.
const HELD := ["jump", "attack", "dash"]

var main: Node = null
## Waiting to open: [{id, end}] (`end`: the run ends when it closes).
var _queue: Array = []
## The open modal ({id, end, modal}), or {}.
var _open := {}
var _previewing := false
var _selected := 0
var _opened_frame := -1
var _resume := false
var _map_open := false
## Rooms revealed on the map (revealMap), saved with the run.
var _revealed := {}
var _panel: Control = null
var _buttons: Array = []
var _map: Control = null


func setup(main_node: Node) -> void:
	main = main_node
	layer = 3  # above the HUD (2) and room frames (1)
	process_physics_priority = -100  # before the world: pausing holds this very frame


func register(events) -> void:
	events.register("showModal", func(effect, _context): _enqueue(str(effect.modal), false))
	events.register("endGame", _effect_end_game)
	events.register("revealMap", _effect_reveal_map)


## Edit mode: show a modal of the loaded project (null = close it). Its buttons only close it.
func preview(modal_id) -> void:
	_hide_modal()
	_previewing = false
	if modal_id != null and not _modal(str(modal_id)).is_empty():
		_previewing = true
		_open_modal({"id": str(modal_id), "end": false})


## The open (or previewed) modal's id, or null.
func current():
	return _open.id if not _open.is_empty() else null


func map_open() -> bool:
	return _map_open


## Stop / a new run: close everything, forget revealed rooms.
func reset() -> void:
	_queue = []
	_hide_modal()
	_previewing = false
	_set_map(false)
	_resume = false
	_revealed = {}


func save_data() -> Dictionary:
	return {"revealed": _revealed.keys()}


func load_data(data: Dictionary) -> void:
	_revealed = {}
	for id in data.get("revealed", []):
		_revealed[str(id)] = true


## For tests: what is on screen.
func describe() -> Dictionary:
	var shown = null
	if not _open.is_empty():
		var modal: Dictionary = _open.modal
		shown = {
			"id": _open.id, "title": modal.get("title", ""), "body": modal.get("body", ""),
			"buttons": _buttons.map(func(b): return b.text), "selected": _selected,
			"image": _panel.find_child("Image", true, false) != null,
		}
	return {"modal": shown, "queued": _queue.map(func(q): return q.id), "map": _map.describe() if _map_open else null}


# --- effects -----------------------------------------------------------------------

func _enqueue(id: String, end: bool) -> void:
	if _previewing:
		preview(null)
	_queue.append({"id": id, "end": end})
	_show_next()


func _effect_end_game(effect: Dictionary, _context: Dictionary) -> void:
	if effect.get("modal") != null:
		_enqueue(str(effect.modal), true)
	else:
		# Not mid-flush: the run starts over once the current effects are done.
		main.set_paused(true)
		_end_run.call_deferred()


func _effect_reveal_map(effect: Dictionary, _context: Dictionary) -> void:
	var rooms = effect.get("rooms")
	if typeof(rooms) != TYPE_ARRAY:
		rooms = main._project.get("world", {}).get("rooms", []).map(func(r): return r.id)
	for id in rooms:
		_revealed[str(id)] = true


## The game ends: a fresh run from the same start (its gameStarted handlers run again).
func _end_run() -> void:
	if not main._run.active:
		return
	_queue = []
	_hide_modal()
	_set_map(false)
	_revealed = {}
	main._run.restart()
	_after_close()


# --- modals --------------------------------------------------------------------------

func _modal(id: String) -> Dictionary:
	for modal in main._project.get("world", {}).get("modals", []):
		if modal.id == id:
			return modal
	return {}


func _show_next() -> void:
	while _open.is_empty() and not _queue.is_empty():
		var next: Dictionary = _queue.pop_front()
		if not _modal(next.id).is_empty():
			_set_map(false)
			_open_modal(next)
			if not _previewing:
				main.set_paused(true)


func _open_modal(entry: Dictionary) -> void:
	var modal := _modal(entry.id)
	_open = entry.merged({"modal": modal})
	_selected = 0
	_opened_frame = Engine.get_physics_frames()
	_resume = false
	_build(modal)


## Press button `i`: run its effects (not in a preview), close the modal, then the next one or back to play.
func _press(i: int) -> void:
	if _open.is_empty():
		return
	var entry := _open
	var buttons: Array = entry.modal.get("buttons", [])
	_hide_modal()
	if _previewing:
		_previewing = false
		return
	var effects: Array = buttons[i].get("do", []) if i < buttons.size() else []
	var events = main._run.events
	events.run_effects(effects, {"room": main._run.room_id})
	if entry.end:
		_end_run()
		return
	events.flush()
	_show_next()
	_after_close()


func _after_close() -> void:
	if _open.is_empty() and not _map_open:
		_resume = true  # in _physics_process, once the keys are let go


func _physics_process(_delta: float) -> void:
	if _previewing:
		if main._mode == "play":
			preview(null)
		else:
			_navigate()
		return
	if main._mode != "play" or not main._run.active:
		return
	var holding := not _open.is_empty() or _map_open
	if holding:
		# A room rebuilt meanwhile (or play starting) runs again: hold it.
		if not main._run.paused or (main._world != null and main._world.process_mode != Node.PROCESS_MODE_DISABLED):
			main.set_paused(true)
	elif _resume and not HELD.any(func(a): return Input.is_action_pressed(a)):
		_resume = false
		main.set_paused(false)
	if not _open.is_empty():
		_navigate()
	elif Input.is_action_just_pressed("map") and (_map_open or _map_enabled()):
		_set_map(not _map_open)
		if not _map_open:
			_after_close()


func _process(_delta: float) -> void:
	# Its image arrived after it opened (the studio sends images once it has them): show it now.
	if _open.is_empty() or _panel == null or _open.modal.get("image") == null or _panel.find_child("Image", true, false) != null:
		return
	if main._textures.get(str(_open.modal.image)) is Texture2D:
		var selected := _selected
		_buttons = []
		_build(_open.modal)
		_select(selected)


func _navigate() -> void:
	if _open.is_empty() or Engine.get_physics_frames() == _opened_frame:
		return  # the press that opened it is not for it
	var step := 0
	if PREV.any(func(a): return Input.is_action_just_pressed(a)):
		step -= 1
	if NEXT.any(func(a): return Input.is_action_just_pressed(a)):
		step += 1
	if step != 0 and _buttons.size() > 1:
		_select(posmod(_selected + step, _buttons.size()))
	elif ACCEPT.any(func(a): return Input.is_action_just_pressed(a)):
		_press(_selected)


func _hide_modal() -> void:
	_open = {}
	_buttons = []
	if _panel != null:
		_panel.queue_free()
		_panel = null


# --- drawing -------------------------------------------------------------------------

func _build(modal: Dictionary) -> void:
	if _panel != null:
		_panel.queue_free()
	_panel = ColorRect.new()
	_panel.color = Color(0.02, 0.03, 0.05, 0.72)
	_panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(_panel)
	var center := CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	_panel.add_child(center)
	var box := PanelContainer.new()
	box.add_theme_stylebox_override("panel", _style(Color("#1c2233"), Color("#9aa6c4"), 18))
	center.add_child(box)
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 14)
	box.add_child(column)
	if str(modal.get("title", "")) != "":
		column.add_child(_label(str(modal.title), 28, HORIZONTAL_ALIGNMENT_CENTER))
	var texture = main._textures.get(modal.get("image")) if modal.get("image") != null else null
	if texture is Texture2D:
		var image := TextureRect.new()
		image.name = "Image"
		image.texture = texture
		image.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		image.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		image.custom_minimum_size = Vector2(WIDTH, minf(220.0, WIDTH * texture.get_height() / maxf(1.0, texture.get_width())))
		column.add_child(image)
	if str(modal.get("body", "")) != "":
		var body := _label(str(modal.body), 17, HORIZONTAL_ALIGNMENT_LEFT)
		body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		body.custom_minimum_size.x = WIDTH
		column.add_child(body)
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.add_theme_constant_override("separation", 12)
	column.add_child(row)
	var labels: Array = modal.get("buttons", []).map(func(b): return str(b.label))
	if labels.is_empty():
		labels = ["Continue"]
	for i in labels.size():
		var button := Button.new()
		button.text = labels[i]
		button.focus_mode = Control.FOCUS_NONE  # keys are handled here, not by Godot's focus
		button.custom_minimum_size = Vector2(110, 40)
		button.pressed.connect(_press.bind(i))
		button.mouse_entered.connect(_select.bind(i))
		row.add_child(button)
		_buttons.append(button)
	_select(0)


func _select(i: int) -> void:
	_selected = i
	for j in _buttons.size():
		var on: bool = j == i
		var style := _style(Color("#e8c547") if on else Color("#2c3550"), Color("#e8c547") if on else Color("#5a6788"), 8)
		for state in ["normal", "hover", "pressed"]:
			_buttons[j].add_theme_stylebox_override(state, style)
		_buttons[j].add_theme_color_override("font_color", Color("#141824") if on else Color("#e8e3d3"))
		_buttons[j].add_theme_color_override("font_hover_color", Color("#141824") if on else Color("#e8e3d3"))


func _label(text: String, font_size: int, align: HorizontalAlignment) -> Label:
	var label := Label.new()
	label.text = text
	label.horizontal_alignment = align
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", Color("#e8e3d3"))
	return label


func _style(fill: Color, border: Color, margin: int) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = fill
	style.border_color = border
	style.set_border_width_all(2)
	style.set_corner_radius_all(6)
	style.set_content_margin_all(margin)
	return style


# --- the map -------------------------------------------------------------------------

func _map_enabled() -> bool:
	return bool(main._project.get("world", {}).get("map", {}).get("enabled", false))


func _set_map(open: bool) -> void:
	if open == _map_open:
		return
	_map_open = open
	if open:
		if _map == null:
			_map = MapView.new()
			_map.set_anchors_preset(Control.PRESET_FULL_RECT)
			_map.mouse_filter = Control.MOUSE_FILTER_IGNORE
			add_child(_map)
		var known := _revealed.duplicate()
		for id in main._run.visited:
			known[id] = true
		_map.show_rooms(main._project.world.get("rooms", []), known, main._run.room_id)
		_map.visible = true
		main.set_paused(true)
	elif _map != null:
		_map.visible = false
