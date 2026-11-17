extends RefCounted
## Level geometry: the runtime's solids (core gridToSolids, sent with the
## project) become static bodies for enemies and line of sight, plain
## visuals, and the player's own collision list (player.gd `solids`).

const BREAKABLE_LIGHTEN := 0.25
const HAZARD_COLOR := Color("#b0413e")


## Add a body per solid under `parent`. With `dressed`, a biome draws the
## ground, so only breakable tiles keep a visual (they can disappear).
## Returns the player's solids: [{x, y, w, h, kind, group, body}].
static func build(parent: Node2D, solids: Array, color: Color, dressed: bool) -> Array:
	var out := []
	for s in solids:
		var kind := str(s.get("kind", "solid"))
		var body := _make_body(s, kind, color, dressed and kind != "breakable")
		parent.add_child(body)
		out.append({"x": float(s.x), "y": float(s.y), "w": float(s.width), "h": float(s.height), "kind": kind, "group": s.get("group"), "body": body})
	return out


static func _make_body(s: Dictionary, kind: String, color: Color, hidden: bool) -> StaticBody2D:
	var size := Vector2(s.width, s.height)
	var body := StaticBody2D.new()
	body.position = Vector2(s.x, s.y) + size / 2.0
	body.collision_layer = 1
	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = size
	shape.shape = box
	shape.one_way_collision = kind == "oneway"
	body.add_child(shape)
	if hidden:
		return body
	match kind:
		"breakable":
			color = color.lightened(BREAKABLE_LIGHTEN)
		"hazard":
			color = HAZARD_COLOR
		"oneway":
			color = color.lightened(0.15)
	var visual := ColorRect.new()
	visual.color = color
	visual.position = -size / 2.0
	visual.size = size
	visual.mouse_filter = Control.MOUSE_FILTER_IGNORE
	body.add_child(visual)
	if kind == "breakable":
		for i in range(1, int(size.x / 24.0)):
			var crack := ColorRect.new()
			crack.color = color.darkened(0.45)
			crack.position = Vector2(-size.x / 2.0 + i * 24.0, -size.y / 2.0 + 3.0)
			crack.size = Vector2(2.0, size.y - 6.0)
			crack.mouse_filter = Control.MOUSE_FILTER_IGNORE
			body.add_child(crack)
	return body
