extends Node2D
## Characters-mode stage: one character's rig, large and centred on a neutral
## backdrop, with clip/time/speed control, a bone overlay and an onion skin
## (the design image drawn behind the rig, aligned to it). Message: `stage`
## with mode "character" (packages/core/src/protocol.ts).

const CharacterArt := preload("res://scripts/art/character_art.gd")
const WeaponView := preload("res://scripts/art/weapon_view.gd")
const RenderService := preload("res://scripts/art/render_service.gd")

var _camera: Camera2D
var _backdrop: ColorRect
## Rig and onion skin, flipped together.
var _holder: Node2D
var _rig: Node2D = null
var _onion: Sprite2D
var _floor: Line2D
var _key := ""  # what the rig was built from (character + revision)
var _bounds := Rect2(-20, -40, 40, 40)
var _onion_image := ""
var _message: Label
## The held weapon (stage.weapon), its attack (whose phases follow the clip's time), and what it was built from.
var _weapon: Node2D = null
var _attack := {}
var _weapon_key := ""


func _ready() -> void:
	var back := CanvasLayer.new()
	back.layer = -1
	_backdrop = ColorRect.new()
	_backdrop.set_anchors_preset(Control.PRESET_FULL_RECT)
	var shader := Shader.new()
	shader.code = """
shader_type canvas_item;
void fragment() {
	float v = smoothstep(1.1, 0.2, length(UV - vec2(0.5, 0.62)));
	COLOR = vec4(mix(vec3(0.07, 0.08, 0.1), vec3(0.2, 0.22, 0.26), v), 1.0);
}
"""
	var mat := ShaderMaterial.new()
	mat.shader = shader
	_backdrop.material = mat
	back.add_child(_backdrop)
	_message = Label.new()
	_message.set_anchors_preset(Control.PRESET_CENTER)
	_message.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_message.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	_message.visible = false
	back.add_child(_message)
	add_child(back)

	_holder = Node2D.new()
	add_child(_holder)
	_onion = Sprite2D.new()
	_onion.centered = false
	_onion.visible = false
	_holder.add_child(_onion)
	_floor = Line2D.new()
	_floor.width = 1.0
	_floor.default_color = Color(1, 1, 1, 0.18)
	_floor.points = PackedVector2Array([Vector2(-2000, 0), Vector2(2000, 0)])
	add_child(_floor)
	_camera = Camera2D.new()
	add_child(_camera)
	get_viewport().size_changed.connect(_fit)


## Apply a `stage` message. Rebuilds the rig only when the character or project changed.
func apply(project: Dictionary, stage: Dictionary) -> String:
	var character_id := str(stage.get("characterId", ""))
	var character = null
	for c in project.get("characters", []):
		if c.get("id") == character_id:
			character = c
	if character == null:
		return "no character '%s'" % character_id
	var art: Dictionary = project.get("art", {})
	var asset := CharacterArt.asset_for(character, art)
	var key := "%s@%s" % [character_id, project.get("revision", 0)]
	if key != _key:
		_key = key
		if _rig != null:
			_rig.queue_free()
			_rig = null
		_weapon_key = ""
		if asset.is_empty():
			_say("%s has no rig yet." % character.get("name", character_id))
			return ""
		_rig = CharacterArt.make_view(asset, art)
		_holder.add_child(_rig)
		_bounds = _rest_bounds(asset.rig)
		_place_onion(asset)
		_fit()
	if _rig == null:
		return ""
	_say("")

	var clip = stage.get("clip")
	var time = stage.get("time")
	_rig.speed = float(stage.get("speed", 1.0))
	_rig.show_bones = bool(stage.get("bones", false))
	_holder.scale.x = -1.0 if bool(stage.get("flip", false)) else 1.0
	_rig.play(str(clip) if clip != null else "")
	_rig.manual_time = time != null
	_hold(project, stage.get("weapon"))
	if time != null:
		_rig.pose_at(float(time))

	# onion.image: base64 PNG to load, "" to clear, null to keep the current one (it is sent once, not per frame).
	var onion = stage.get("onion", {})
	var image = onion.get("image") if typeof(onion) == TYPE_DICTIONARY else null
	if image != null and str(image) == "":
		_onion.texture = null
		_onion_image = ""
	elif image != null and str(image) != _onion_image:
		_onion_image = str(image)
		var img := Image.new()
		if img.load_png_from_buffer(Marshalls.base64_to_raw(_onion_image)) == OK:
			_onion.texture = ImageTexture.create_from_image(img)
			_place_onion(asset)
	var alpha := float(onion.get("alpha", 0.0)) if typeof(onion) == TYPE_DICTIONARY else 0.0
	_onion.visible = _onion.texture != null and alpha > 0.0
	_onion.modulate = Color(1, 1, 1, alpha)
	return ""


## The held weapon: rebuilt when the weapon, the rig or the project changes; with an attack, its
## phase follows the playing clip's time (the trail shows during its active window).
func _hold(project: Dictionary, held: Variant) -> void:
	var id := str(held.get("id", "")) if typeof(held) == TYPE_DICTIONARY else ""
	var weapon := {}
	for w in project.get("weapons", {}).get("list", []):
		if typeof(w) == TYPE_DICTIONARY and str(w.get("id", "")) == id:
			weapon = w
	var key := "%s@%s" % [id, _key]
	if weapon.is_empty():
		if _weapon != null:
			_weapon.queue_free()
			_weapon = null
		_weapon_key = ""
		_attack = {}
		return
	if key != _weapon_key or _weapon == null:
		_weapon_key = key
		if _weapon != null:
			_weapon.queue_free()
		_weapon = WeaponView.new()
		_holder.add_child(_weapon)
		_weapon.set_weapon(weapon, _rig)
	_attack = RenderService._attack_of(weapon, held.get("attack"))
	if _attack.is_empty():
		_weapon.set_phase({}, "", Vector2.RIGHT, 1.0)


func _process(_delta: float) -> void:
	if _weapon == null or _rig == null or _attack.is_empty():
		return
	var phase := RenderService.phase_at(_attack, _rig.clip_time())
	if phase != _weapon._phase:
		_weapon.set_phase(_attack, phase, Vector2.RIGHT, 1.0)


## A note in the middle of the stage ("" hides it).
func _say(text: String) -> void:
	_message.text = text
	_message.visible = text != ""
	_message.reset_size()
	_message.position = (get_viewport_rect().size - _message.size) / 2.0


func current_time() -> float:
	return _rig.clip_time() if _rig != null else 0.0


## Line the design image up with the rig: the rig was traced in the design's pixels (asset.preview.frame).
func _place_onion(asset: Dictionary) -> void:
	if _onion.texture == null:
		return
	var preview = asset.get("preview")
	var frame = preview.get("frame") if typeof(preview) == TYPE_DICTIONARY else null
	var size := _onion.texture.get_size()
	if typeof(frame) == TYPE_DICTIONARY:
		var s := float(frame.scale)
		var anchor := Vector2(float(frame.anchor[0]), float(frame.anchor[1]))
		_onion.scale = Vector2(s, s)
		_onion.position = -anchor * s
	else:
		# No recorded frame (older rigs): fit the image's height to the rig's.
		var s := _bounds.size.y * 1.3 / size.y
		_onion.scale = Vector2(s, s)
		_onion.position = Vector2(-size.x * s / 2.0, -size.y * s * 0.9)


func _rest_bounds(rig: Dictionary) -> Rect2:
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for part in rig.get("parts", []):
		var shape: Dictionary = part.get("shape", {})
		var pts: Array = shape.get("points", [])
		if str(shape.get("type")) == "ellipse":
			var c = shape.get("center", [0, 0])
			var r := maxf(float(shape.get("rx", 0)), float(shape.get("ry", 0)))
			pts = [[float(c[0]) - r, float(c[1]) - r], [float(c[0]) + r, float(c[1]) + r]]
		for p in pts:
			lo = lo.min(Vector2(float(p[0]), float(p[1])))
			hi = hi.max(Vector2(float(p[0]), float(p[1])))
	if lo.x == INF:
		return Rect2(-20, -40, 40, 40)
	return Rect2(lo, hi - lo)


## Zoom so the rig fills about 60% of the view, feet a little below centre.
func _fit() -> void:
	if not is_inside_tree():
		return
	var view := get_viewport_rect().size
	var size := _bounds.size.max(Vector2(8, 8))
	var zoom := minf(view.x * 0.55 / size.x, view.y * 0.6 / size.y)
	_camera.zoom = Vector2(zoom, zoom)
	_camera.position = _bounds.get_center() + Vector2(0, size.y * 0.08)
	_camera.make_current()
