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
