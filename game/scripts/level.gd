extends RefCounted
## Level geometry: the runtime's solids (core gridToSolids, sent with the
## project) become static bodies for enemies and line of sight, and the
## player's own collision list (player.gd `solids`). The grid is drawn as one
## terrain (terrain.gd), unless a biome dressing draws it.

const Terrain := preload("res://scripts/terrain.gd")
const HAZARD_COLOR := Color("#b0413e")
## Collision layer of the room's edges for enemies: doorways are for the player, so an
## enemy charging or patrolling into one meets a wall there (and turns, stops, hit_wall).
const ENEMY_BOUNDS_LAYER := 8
const BOUNDS_THICKNESS := 64.0


## Add a body per solid under `parent`, and a "Terrain" node drawing `grid` ({rows}; rebuilt
## from the solids when absent) unless `dressed` (a biome draws the ground then).
## Returns the player's solids: [{x, y, w, h, kind, group, body}].
static func build(parent: Node2D, solids: Array, color: Color, dressed: bool, grid: Variant = null, ledge_thickness := 20) -> Array:
	var out := []
	for s in solids:
		var kind := str(s.get("kind", "solid"))
		var body := _make_body(s, kind)
		parent.add_child(body)
		out.append({"x": float(s.x), "y": float(s.y), "w": float(s.width), "h": float(s.height), "kind": kind, "group": s.get("group"), "body": body})
	if not dressed:
		var terrain: Node2D = Terrain.new()
		terrain.name = "Terrain"
		parent.add_child(terrain)
		if typeof(grid) == TYPE_DICTIONARY and typeof(grid.get("rows")) == TYPE_ARRAY:
			terrain.build(grid.rows, ledge_thickness, plain_style(color))
		else:
			var rebuilt := Terrain.rows_from_solids(solids)
			terrain.build(rebuilt.rows, rebuilt.ledge, plain_style(color), rebuilt.origin)
	return out


## Walls just outside the room's left, right and top edges that only enemies collide with
## (the bottom stays open: an enemy that falls into a pit is sent home, as before).
static func add_enemy_bounds(parent: Node2D, width: float, height: float) -> void:
	var t := BOUNDS_THICKNESS
	for r in [Rect2(-t, -t, t, height + 2.0 * t), Rect2(width, -t, t, height + 2.0 * t), Rect2(0.0, -t, width, t)]:
		var body := _make_body({"x": r.position.x, "y": r.position.y, "width": r.size.x, "height": r.size.y}, "solid")
		body.name = "EnemyBounds"
		body.collision_layer = ENEMY_BOUNDS_LAYER
		parent.add_child(body)


## The undressed look: flat colors from the platform color.
static func plain_style(color: Color) -> Dictionary:
	return {
		"color": color,
		"shade": 0.35,
		"rim": color.lightened(0.45),
		"edge": Color(color.lightened(0.3), 0.6),
		"hazard": HAZARD_COLOR.darkened(0.2),
		"spike": Color("#e6d6c3"),
		"breakable": color.lerp(Color("#a08860"), 0.55),
		"oneway": color.lightened(0.3),
	}


## A smashed area (world px): clear it from the plain terrain under `parent`, if any.
static func clear(parent: Node, rect: Rect2) -> void:
	var terrain := parent.get_node_or_null("Terrain")
	if terrain != null:
		terrain.clear_rect(rect)


static func _make_body(s: Dictionary, kind: String) -> StaticBody2D:
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
	return body
