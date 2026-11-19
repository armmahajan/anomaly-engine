extends Node2D
## What a wielder's weapon looks like (CONTRACT, weapons target phase 0): the mechanics (player.gd,
## enemy.gd) create one per wielder and call set_weapon / set_phase / hit_at / tip_global; this
## draws them: the held sprite at the rig's `hand` grip on the current pose (turning with the grip's
## bone; the sprite is drawn pointing right, so its +x follows the grip's direction), the trail
## behind the tip during the active window, hit sparks. Contract:
## packages/core/src/combat/weapon.ts (WeaponArt) and art/rig.ts (Grip).
##
## Add it to the wielder after the RigView (it draws over the body). Everything is drawn in code
## from the weapon's data: a weapon without a sprite is a simple shape in its trail colour; a rig
## without a grip holds it in front of the body at chest height; no rig at all (a coloured box),
## in front of the box. make_projectile() gives the look of an attack's projectiles.

const ProjectileView := preload("res://scripts/art/projectile_view.gd")

## Images by file ref (renders pass them); unset, the nearest ancestor's `_textures` (main.gd) is used.
var textures := {}
## Freeze the clock (render service: it sets times with at_time).
var manual_time := false

var _weapon := {}
var _rig: Node = null
var _sprite_file := ""
var _texture: Texture2D = null
var _grip_px := Vector2.ZERO
var _tip_px := Vector2.ZERO
var _scale := 1.0
## Grip to tip, game px.
var _length := 22.0
var _trail_color := Color.WHITE
var _trail_width := 10.0
var _trail_seconds := 0.12
var _spark_color := Color("#fff2b0")
var _phase := ""
var _facing := 1.0
var _clock := 0.0
## Tip positions while active: [global point, clock].
var _trail: Array = []
## Hit sparks: [global point, clock, seed].
var _sparks: Array = []
## The grip frame, global: origin at the hand, x axis along the held weapon.
var _hold := Transform2D.IDENTITY
## The turn toward a mouse aim (radians, wielder space), and whether the rig turns the arm for it.
var _aim_turn := 0.0
var _rig_turns := false

const SPARK_SECONDS := 0.28
const SPARK_RAYS := 7
const INK := Color("#15151c")


## The weapon to show (a project weapon dictionary) or {} for none (the built-in attack). `rig_view`
## is the wielder's RigView (or null for a coloured box), to find the grip on its pose each frame.
func set_weapon(weapon: Dictionary, rig_view: Node) -> void:
	if _rig != null and is_instance_valid(_rig) and _rig.has_signal("posed") and _rig.posed.is_connected(_follow):
		_rig.posed.disconnect(_follow)
	_weapon = weapon if typeof(weapon) == TYPE_DICTIONARY else {}
	_rig = rig_view
	_trail.clear()
	var art: Dictionary = _weapon.get("art", {}) if typeof(_weapon.get("art")) == TYPE_DICTIONARY else {}
	var sprite = art.get("sprite")
	_sprite_file = str(sprite) if sprite != null else ""
	_texture = null
	_grip_px = _vec(art.get("grip"), Vector2.ZERO)
	_tip_px = _vec(art.get("tip"), Vector2.ZERO)
	_scale = clampf(float(art.get("scale", 1.0)), 0.01, 20.0)
	var trail: Dictionary = art.get("trail", {}) if typeof(art.get("trail")) == TYPE_DICTIONARY else {}
	_trail_color = Color(str(trail.get("color", "#ffffff")))
	_trail_width = float(trail.get("width", 10.0))
	_trail_seconds = float(trail.get("seconds", 0.12))
	_spark_color = Color(str(art.get("spark", "#fff2b0")))
	var span := _tip_px - _grip_px
	_length = span.length() * _scale if _sprite_file != "" and span.length() > 0.5 else held_length(_weapon)
	visible = not _weapon.is_empty()
	if _rig != null and _rig.has_signal("posed"):
		_rig.posed.connect(_follow)
	_follow()


## An attack's phase changed: "windup", "active", "recovery" or "" (idle). `attack` is the attack
## dictionary, `aim` the unit aim vector (wielder space, facing right), `facing` 1 or -1.
func set_phase(_attack: Dictionary, phase: String, _aim: Vector2, facing: float) -> void:
	if phase == "active" and _phase != "active":
		_trail.clear()
	_phase = phase
	_facing = -1.0 if facing < 0.0 else 1.0
	_follow()


## A hit landed at `global_point` (spark, using the weapon's spark colour).
func hit_at(global_point: Vector2) -> void:
	_sparks.append([global_point, _clock, randi()])
	queue_redraw()


## The tip of the held weapon in global coordinates (for hit shapes that follow the art), or null
## when there is no sprite: the mechanics then use the attack's own shape.
func tip_global() -> Variant:
	if _weapon.is_empty() or _sprite_file == "":
		return null
	return _hold * _tip_local()


## The tip in the grip's frame: the sprite (drawn pointing right, along the grip's direction) puts
## it where its art says; without a sprite, `_length` ahead of the hand.
func _tip_local() -> Vector2:
	if _sprite_file != "" and (_tip_px - _grip_px).length() > 0.5:
		return (_tip_px - _grip_px) * _scale
	return Vector2(_length, 0.0)


## The hand holding it, global (also without a sprite).
func grip_global() -> Vector2:
	return _hold.origin


## The way the held weapon points, global (a unit vector along the grip's x axis).
func pointing_global() -> Vector2:
	return _hold.x.normalized()


## Turn toward a mouse aim (radians, wielder space: + turns down): the rig turns the arm holding the
## weapon (rig_view.gd set_aim_turn), so the hand carries the weapon round; a rig without an arm for
## its grip, or no rig, turns the weapon itself about the hand.
func set_aim_turn(radians: float) -> void:
	if is_equal_approx(radians, _aim_turn):
		return
	_aim_turn = radians
	_rig_turns = false
	if _rig != null and is_instance_valid(_rig) and _rig.has_method("set_aim_turn"):
		_rig_turns = _rig.set_aim_turn("hand", radians)
	_follow()


## Render service: the clock (trail and spark ages) at `seconds`.
func at_time(seconds: float) -> void:
	_clock = seconds


## How long a weapon looks in the hand, game px, without a sprite: from its longest melee reach,
## else a short one. Mirrors heldLength in packages/art/src/weapons.ts.
static func held_length(weapon: Dictionary) -> float:
	var reach := 0.0
	for attack in weapon.get("attacks", []):
		var shape = attack.get("shape") if typeof(attack) == TYPE_DICTIONARY else null
		if typeof(shape) != TYPE_DICTIONARY:
			continue
		match str(shape.get("type", "")):
			"arc":
				reach = maxf(reach, float(shape.get("radius", 0)))
			"thrust":
				reach = maxf(reach, float(shape.get("length", 0)))
			"box":
				reach = maxf(reach, float(shape.get("width", 0)))
	return roundf(clampf(reach * 0.55, 16.0, 90.0)) if reach > 0.0 else 22.0


## A node that draws one projectile of an attack (its `shape.projectile`): its sprite pointing right,
## else a coloured shape. Rotate it (or call set_velocity) to point it along its flight.
static func make_projectile(projectile: Dictionary, images := {}) -> Node2D:
	var view = ProjectileView.new()
	view.setup(projectile, images)
	return view


func _process(delta: float) -> void:
	if not manual_time:
		_clock += delta
	if _rig == null or not is_instance_valid(_rig):
		_follow()
	elif not _trail.is_empty() or not _sparks.is_empty():
		queue_redraw()


## Put the weapon at the grip on the rig's current pose (called whenever the rig is posed).
func _follow() -> void:
	if _weapon.is_empty():
		return
	var turn := 0.0 if _rig_turns else _aim_turn
	if _rig != null and is_instance_valid(_rig) and _rig.has_method("grip_transform"):
		var grip = _rig.grip_transform("hand")
		var held: Transform2D = grip if grip != null else _rig.front_transform()
		if turn != 0.0:
			# About the hand, in the rig's (facing right) space.
			held = Transform2D(held.x.rotated(turn), held.y.rotated(turn), held.origin)
		_hold = _rig.get_global_transform() * held
	else:
		# A coloured box: in front of it at chest height, facing the way it faces.
		var parent := get_parent() as Node2D
		var size := Vector2(24, 40)
		if parent != null and "_size" in parent and typeof(parent.get("_size")) == TYPE_VECTOR2:
			size = parent.get("_size")
		if parent != null and parent.has_method("facing_sign"):
			_facing = -1.0 if parent.facing_sign() < 0.0 else 1.0
		var base := parent.get_global_transform() if parent != null else Transform2D.IDENTITY
		_hold = base * Transform2D(0.0, Vector2(_facing, 1.0), 0.0, Vector2(_facing * size.x * 0.35, -size.y * 0.55)) * Transform2D(turn, Vector2.ZERO)
	if _phase == "active":
		_trail.append([_hold * _tip_local(), _clock])
	queue_redraw()


func _draw() -> void:
	if _weapon.is_empty():
		return
	var to_local := get_global_transform().affine_inverse()
	_draw_trail(to_local)
	var hold := to_local * _hold
	if _sprite_file != "" and _texture == null:
		_texture = ProjectileView.find_texture(self, _sprite_file, textures)
	if _texture != null and (_tip_px - _grip_px).length() > 0.5:
		draw_set_transform_matrix(hold * Transform2D(0.0, Vector2(_scale, _scale), 0.0, Vector2.ZERO) * Transform2D(0.0, -_grip_px))
		draw_texture(_texture, Vector2.ZERO)
	else:
		draw_set_transform_matrix(hold)
		_draw_shape()
	draw_set_transform_matrix(Transform2D.IDENTITY)
	_draw_sparks(to_local)


## No sprite (yet): a simple tapered shape in the trail's colour, grip at the origin, pointing +x.
func _draw_shape() -> void:
	var l := _length
	var w := maxf(1.6, l * 0.075)
	var body := _trail_color.lerp(Color(0.78, 0.8, 0.84), 0.45)
	var handle := PackedVector2Array([Vector2(-l * 0.1, -w * 0.6), Vector2(l * 0.16, -w * 0.6), Vector2(l * 0.16, w * 0.6), Vector2(-l * 0.1, w * 0.6)])
	var blade := PackedVector2Array([Vector2(l * 0.16, -w * 1.1), Vector2(l * 0.86, -w * 0.9), Vector2(l, 0.0), Vector2(l * 0.86, w * 0.9), Vector2(l * 0.16, w * 1.1)])
	for poly in [handle, blade]:
		var closed: PackedVector2Array = poly.duplicate()
		closed.append(poly[0])
		draw_colored_polygon(poly, Color(0.25, 0.2, 0.18) if poly == handle else body)
		draw_polyline(closed, INK, 1.0)


func _draw_trail(to_local: Transform2D) -> void:
	if _trail_width <= 0.0 or _trail_seconds <= 0.0:
		_trail.clear()
		return
	var live: Array = []
	for p in _trail:
		if _clock - float(p[1]) <= _trail_seconds:
			live.append(p)
	_trail = live
	for i in range(1, _trail.size()):
		var a: Array = _trail[i - 1]
		var b: Array = _trail[i]
		var k := 1.0 - clampf((_clock - float(b[1])) / _trail_seconds, 0.0, 1.0)
		var color := Color(_trail_color, _trail_color.a * 0.85 * k)
		draw_line(to_local * (a[0] as Vector2), to_local * (b[0] as Vector2), color, maxf(1.0, _trail_width * k), true)


func _draw_sparks(to_local: Transform2D) -> void:
	var live: Array = []
	for s in _sparks:
		var age := _clock - float(s[1])
		if age > SPARK_SECONDS or age < 0.0:
			continue
		live.append(s)
		var k := age / SPARK_SECONDS
		var at := to_local * (s[0] as Vector2)
		var rng := RandomNumberGenerator.new()
		rng.seed = int(s[2])
		var color := Color(_spark_color, _spark_color.a * (1.0 - k))
		draw_circle(at, 6.0 * (1.0 - k) + 1.0, Color(color, color.a * 0.6))
		for r in SPARK_RAYS:
			var dir := Vector2.from_angle(TAU * (float(r) + rng.randf_range(-0.3, 0.3)) / SPARK_RAYS)
			var reach := rng.randf_range(10.0, 18.0)
			draw_line(at + dir * reach * k * 0.6, at + dir * reach * (0.35 + k), color, 2.0 * (1.0 - k) + 0.5, true)
	_sparks = live


static func _vec(raw: Variant, fallback: Vector2) -> Vector2:
	if typeof(raw) == TYPE_ARRAY and raw.size() >= 2:
		return Vector2(float(raw[0]), float(raw[1]))
	return fallback
