extends Node2D
## Worlds-mode stage: one room drawn by WorldView, with a free camera (drag
## empty space to pan, wheel to zoom), click to select a piece and drag to
## move it. Moves are reported to the studio (worldMove), which saves them
## as ordinary undoable operations; the stage never edits the project.

const WorldView := preload("res://scripts/art/world_view.gd")

## Sends a runtime->studio message (main.gd's _send).
var send: Callable

var _view: Node2D = null
var _camera: Camera2D
var _scene: Dictionary = {}
var _scene_key := ""
var _zoom_factor := 1.0
var _editable := true
var _selected := ""

var _drag_sprite: Sprite2D = null
var _drag_offset := Vector2.ZERO
var _drag_start := Vector2.ZERO
var _panning := false
var _pan_from := Vector2.ZERO
var _moved := false
## A piece was just dropped: the next stage message rebuilds even if the scene is unchanged
## (the studio may have snapped it back to where it was).
var _dropped := false


func _ready() -> void:
	_camera = Camera2D.new()
	add_child(_camera)
	_camera.make_current()
	get_viewport().size_changed.connect(func(): _aim(_camera.position.x))


## Apply a `stage` message (mode "world"). Rebuilds only when the scene changed; keeps the camera.
func apply(stage: Dictionary, textures: Dictionary) -> void:
	var scene = stage.get("scene")
	if typeof(scene) != TYPE_DICTIONARY:
		return
	var key := JSON.stringify(scene)
	var first := _view == null
	if key != _scene_key or _dropped:
		_dropped = false
		_scene_key = key
		_scene = scene
		var x := _camera.position.x if not first else 0.0
		if _view != null:
			_view.queue_free()
		_view = WorldView.new()
		add_child(_view)
		var view_size := get_viewport_rect().size
		_view.build(scene, textures, view_size / WorldView.fit_zoom(scene, view_size) * 1.6)
		_aim(x)
	_editable = bool(stage.get("editable", true))
	_view.set_options(stage.get("hidden", []), bool(stage.get("fog", true)), bool(stage.get("lights", true)), bool(stage.get("exploded", false)))
	_selected = str(stage.get("selected")) if stage.get("selected") != null else ""
	_view.select(_selected)
	_camera.make_current()


func _aim(x: float) -> void:
	if _view == null:
		return
	var view := get_viewport_rect().size
	var zoom := WorldView.fit_zoom(_scene, view) * _zoom_factor
	var half := view.x / zoom / 2.0
	var width := float(_scene.get("width", 2400))
	var height := float(_scene.get("height", 720))
	_camera.zoom = Vector2(zoom, zoom)
	_camera.position = Vector2(clampf(x, half, maxf(half, width - half)), height / 2.0 if _zoom_factor <= 1.0 else clampf(_camera.position.y, height * 0.25, height * 0.75))
	_camera.force_update_scroll()
	_view.focus = _camera.position
	_view._update_layers()


func _unhandled_input(event: InputEvent) -> void:
	if _view == null or not is_visible_in_tree():
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_WHEEL_UP or mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			if mb.pressed:
				_zoom_factor = clampf(_zoom_factor * (1.12 if mb.button_index == MOUSE_BUTTON_WHEEL_UP else 1.0 / 1.12), 1.0, 3.0)
				_aim(_camera.position.x)
			return
		if mb.button_index != MOUSE_BUTTON_LEFT:
			return
		var at := get_global_mouse_position()
		if mb.pressed:
			_moved = false
			_drag_start = mb.position
			var picked: String = _view.pick(at)
			if picked != "" and _editable:
				_drag_sprite = _view.sprite_for(picked)
				_drag_offset = _drag_sprite.position - _drag_sprite.get_parent().to_local(at)
			else:
				_panning = true
				_pan_from = mb.position
			if picked != _selected:
				_selected = picked
				_view.select(picked)
				send.call({"type": "worldPick", "placementId": picked if picked != "" else null})
		else:
			if _drag_sprite != null and _moved:
				var p: Vector2 = _view.room_position(_drag_sprite)
				_dropped = true
				send.call({"type": "worldMove", "placementId": str(_drag_sprite.get_meta("placement")), "x": snappedf(p.x, 1.0), "y": snappedf(p.y, 1.0), "free": mb.alt_pressed})
			elif _panning and _moved:
				send.call({"type": "worldCamera", "x": _camera.position.x})
			_drag_sprite = null
			_panning = false
	elif event is InputEventMouseMotion:
		var mm := event as InputEventMouseMotion
		if mm.position.distance_to(_drag_start) > 3.0:
			_moved = true
		if _drag_sprite != null:
			_drag_sprite.position = _drag_sprite.get_parent().to_local(get_global_mouse_position()) + _drag_offset
		elif _panning:
			var delta := (mm.position - _pan_from) / _camera.zoom.x
			_pan_from = mm.position
			_aim(_camera.position.x - delta.x)


## Room x at the centre of the view (for placing new pieces).
func camera_x() -> float:
	return _camera.position.x
