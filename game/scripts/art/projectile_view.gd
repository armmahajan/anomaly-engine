extends Node2D
## One projectile of a weapon attack (weapon.ts WeaponProjectile): its sprite pointing right (about
## two and a half times its hit size long), else a coloured shape: a bright core, a soft glow and a
## short streak behind. The mechanics move it; rotate the node (or call set_velocity) to point it
## along its flight. Made by WeaponView.make_projectile().

var _file := ""
var _given := {}
var _texture: Texture2D = null
var _size := 12.0
var _color := Color.WHITE


func setup(projectile: Dictionary, images := {}) -> void:
	var sprite = projectile.get("sprite")
	_file = str(sprite) if sprite != null else ""
	_given = images
	_size = clampf(float(projectile.get("size", 12.0)), 1.0, 200.0)
	_color = Color(str(projectile.get("color", "#ffffff")))
	queue_redraw()


func _process(_delta: float) -> void:
	# Its image may arrive after it was made (the studio sends images once): look again until then.
	if _file != "" and _texture == null:
		queue_redraw()


## Point it along its flight.
func set_velocity(velocity: Vector2) -> void:
	if velocity.length() > 1.0:
		rotation = velocity.angle()


## An image by file ref: given, else from the nearest ancestor that keeps decoded images (main.gd).
static func find_texture(node: Node, file: String, given: Dictionary) -> Texture2D:
	if file == "":
		return null
	var found = given.get(file)
	var at := node.get_parent()
	while found == null and at != null:
		if "_textures" in at and typeof(at.get("_textures")) == TYPE_DICTIONARY:
			found = at.get("_textures").get(file)
		at = at.get_parent()
	return found if found is Texture2D else null


func _draw() -> void:
	if _file != "" and _texture == null:
		_texture = find_texture(self, _file, _given)
	if _texture != null:
		var size := _texture.get_size()
		var k := maxf(8.0, _size * 2.5) / maxf(size.x, 1.0)
		draw_set_transform(Vector2.ZERO, 0.0, Vector2(k, k))
		draw_texture(_texture, -size / 2.0)
		draw_set_transform(Vector2.ZERO)
		return
	var r := _size
	draw_colored_polygon(PackedVector2Array([Vector2(0, -r * 0.45), Vector2(-r * 2.6, 0), Vector2(0, r * 0.45)]), Color(_color, 0.35))
	draw_circle(Vector2.ZERO, r, Color(_color, 0.25))
	draw_circle(Vector2.ZERO, r * 0.6, _color)
	draw_circle(Vector2.ZERO, r * 0.3, _color.lerp(Color.WHITE, 0.6))


# --- object art (core art/animation.ts ProjectileArt) ------------------------------------------
# Projectiles with a look's `art` (weapon projectiles, the enemy shoot action) are drawn as an
# object (object_view.gd) pointing right: `charge` while charging, `fly` in flight (null = idle),
# and `burst` shown as an effect where it breaks. Without art they draw as they always did.

const ObjectView := preload("res://scripts/art/object_view.gd")


## An ObjectView child of `node` for `art` ({object, charge, fly, burst}) playing its `part` clip, or
## null (no art, or no such object: the projectile keeps its usual drawing). Its markers fire as
## from "effect:<object>".
static func object_for(node: Node2D, art: Variant, part: String) -> Node2D:
	if typeof(art) != TYPE_DICTIONARY:
		return null
	var main := ObjectView.main_of(node)
	var all_art = main._project.get("art", {}) if main != null else {}
	var asset := ObjectView.find_asset(all_art, str(art.get("object", "")))
	if asset.is_empty():
		return null
	var view = ObjectView.new()
	view.setup(asset, all_art, "idle")
	var object := str(art.object)
	view.marker.connect(func(marker_name: String, _clip: String): main._run.events.marker(marker_name, {"source": "effect:" + object}))
	node.add_child(view)
	play_part(view, art, part)
	return view


## Play the art's `part` clip (charge, fly) as the projectile's usual, looping clip (null = idle).
static func play_part(view: Node2D, art: Variant, part: String) -> void:
	var clip = art.get(part) if typeof(art) == TYPE_DICTIONARY else null
	view.play_loop(str(clip) if clip != null and view.has_clip(str(clip)) else "idle")


## A projectile with art broke at `at` (room px): its `burst` clip plays there as an effect.
static func burst(node: Node, art: Variant, at: Vector2, angle := 0.0) -> void:
	if typeof(art) != TYPE_DICTIONARY or art.get("burst") == null:
		return
	var main := ObjectView.main_of(node)
	if main != null and main._fx != null:
		main._fx.spawn_object(str(art.object), str(art.burst), at, 1.0, "front", angle)
