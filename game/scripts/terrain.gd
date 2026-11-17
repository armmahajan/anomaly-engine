extends Node2D
## Level terrain: a tile grid (packages/core/src/world/tiles.ts) drawn as one
## continuous mass. Every cell is filled with one material sampled in world
## space and shaded by its distance (in tiles) from the nearest exposed edge;
## rims, side edges and undersides follow exposed edges only, so nothing is
## drawn between two solid cells, and nothing outside solid cells. Drawn as
## two triangle batches (textured fill, then overlays), rebuilt on change.

const TILE := 32.0
const EMPTY := 46  # .
const SOLID := 35  # #
const LEDGE := 61  # =
const ONEWAY := 45  # -
const HAZARD := 94  # ^
const BREAKABLE := 37  # %
const KINDS := {46: "empty", 35: "solid", 61: "ledge", 45: "oneway", 94: "hazard", 37: "breakable"}

## Shading deepens over this many tiles from an exposed edge.
const DEPTH_TILES := 3
const RIM := 4.0
const RIM_GLOW := 7.0
const SIDE := 2.0
const UNDER := 10.0
const BEVEL := 5.0
const SPIKE := 13.0
const BOARD := 7.0

## Style keys (all optional): texture (Texture2D or null), texture_size (world px per texture
## tile), color (fill, or the texture's tint), shade (darkening at full depth), rim, edge (side
## edges), under (underside darkness), hazard, spike, breakable (tint), glaze (overlay on
## breakables), crack, oneway.
const DEFAULT_STYLE := {
	"texture": null,
	"texture_size": 220.0,
	"color": Color("#4a5470"),
	"shade": 0.5,
	"rim": Color("#9aa6c4"),
	"edge": Color(0.75, 0.8, 0.95, 0.3),
	"under": 0.45,
	"hazard": Color("#b0413e"),
	"spike": Color("#e6d6c3"),
	"breakable": Color("#8a7a62"),
	"glaze": Color(1, 1, 1, 0),
	"crack": Color(0.08, 0.06, 0.05, 0.9),
	"oneway": Color("#8a94b0"),
}

var _cols := 0
var _rows := 0
var _cells := PackedByteArray()
var _ledge := 20.0
var _origin := Vector2.ZERO
var _style := {}
var _fill := {}
var _over := {}
var _info := {}


## `rows`: grid rows top to bottom (". # = - ^ %"); `origin`: world position of cell (0, 0).
func build(rows: Array, ledge_thickness: int, style: Dictionary = {}, origin := Vector2.ZERO) -> void:
	_rows = rows.size()
	_cols = str(rows[0]).length() if _rows > 0 else 0
	_cells.resize(_cols * _rows)
	_cells.fill(EMPTY)
	for r in _rows:
		var bytes := str(rows[r]).to_ascii_buffer()
		for c in mini(_cols, bytes.size()):
			_cells[r * _cols + c] = bytes[c]
	_ledge = clampf(float(ledge_thickness), 4.0, TILE)
	_origin = origin
	_style = DEFAULT_STYLE.duplicate()
	_style.merge(style, true)
	texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
	_compose()


## Remove every cell whose centre is inside `rect` (world px), e.g. a smashed breakable area.
func clear_rect(rect: Rect2) -> void:
	var changed := false
	var from := ((rect.position - _origin) / TILE).floor()
	var to := ((rect.end - _origin) / TILE).ceil()
	for r in range(maxi(0, int(from.y)), mini(_rows, int(to.y))):
		for c in range(maxi(0, int(from.x)), mini(_cols, int(to.x))):
			if _cells[r * _cols + c] != EMPTY and rect.has_point(_origin + (Vector2(c, r) + Vector2(0.5, 0.5)) * TILE):
				_cells[r * _cols + c] = EMPTY
				changed = true
	if changed:
		_compose()


## What is drawn, for tests: filled cells [col, row, kind], rims [col, row] (exposed tops),
## edges [col, row, side] (left, right, bottom; underside for a plank's), spikes [col, row, side], and
## the bounds of every drawn shape [x, y, w, h, tag] in world px.
func describe() -> Dictionary:
	return _info.merged({"cols": _cols, "rows": _rows, "ledge": _ledge, "origin": [_origin.x, _origin.y]})


## A grid rebuilt from collision rectangles (core gridToSolids output), for callers without
## the grid: {rows, ledge, origin}. Exact for tile-aligned solids; the grid ends at the last solid.
static func rows_from_solids(solids: Array) -> Dictionary:
	var chars := {"solid": "#", "ledge": "=", "oneway": "-", "hazard": "^", "breakable": "%"}
	var lo := Vector2.ZERO
	var hi := Vector2.ZERO
	var ledge := 20
	for s in solids:
		lo = lo.min(Vector2(s.x, s.y))
		hi = hi.max(Vector2(s.x + s.width, s.y + s.height))
	lo = (lo / TILE).floor() * TILE
	var cols := int(ceil((hi.x - lo.x) / TILE))
	var rows := []
	for r in int(ceil((hi.y - lo.y) / TILE)):
		rows.append(".".repeat(cols))
	for s in solids:
		var kind := str(s.get("kind", "solid"))
		var thin: bool = kind == "ledge" or kind == "oneway"
		if thin:
			ledge = int(s.height)
		# The cells it mostly covers (thin: in the row holding its top).
		var rect := Rect2(float(s.x) - lo.x, float(s.y) - lo.y, s.width, s.height)
		var r0 := int(floor(rect.position.y / TILE)) if thin else roundi(rect.position.y / TILE)
		var r1 := r0 + 1 if thin else roundi(rect.end.y / TILE)
		for r in range(maxi(0, r0), mini(rows.size(), r1)):
			var row: String = rows[r]
			for c in range(maxi(0, roundi(rect.position.x / TILE)), mini(cols, roundi(rect.end.x / TILE))):
				row[c] = chars.get(kind, "#")
			rows[r] = row
	return {"rows": rows, "ledge": ledge, "origin": lo}


func _draw() -> void:
	var tex: Texture2D = _style.texture
	for batch in [_fill, _over]:
		if batch.points.is_empty():
			continue
		var rid := tex.get_rid() if batch == _fill and tex != null else RID()
		var uvs: PackedVector2Array = batch.uvs if rid.is_valid() else PackedVector2Array()
		RenderingServer.canvas_item_add_triangle_array(get_canvas_item(), batch.indices, batch.points, batch.colors, uvs, PackedInt32Array(), PackedFloat32Array(), rid)


# --- composing ---------------------------------------------------------------

func _compose() -> void:
	_fill = _batch()
	_over = _batch()
	_info = {"cells": [], "rims": [], "edges": [], "spikes": [], "shapes": []}
	var depth := _depths()
	var w := _cols + 1
	for r in _rows:
		# Runs of alike cells (same kind and exposure, shading constant along the row: floors,
		# ceilings, the inside of a mass) are drawn as one wide strip.
		var run := -1
		var key := []
		for c in _cols + 1:
			var k := _cells[r * _cols + c] if c < _cols else EMPTY
			var cell_key := []
			if (k == SOLID or k == BREAKABLE) and not _exposed(c - 1, r) and not _exposed(c + 1, r):
				var d00 := depth[r * w + c]
				var d01 := depth[(r + 1) * w + c]
				if d00 == depth[r * w + c + 1] and d01 == depth[(r + 1) * w + c + 1]:
					cell_key = [k, _exposed(c, r - 1), _exposed(c, r + 1), d00, d01]
			if run >= 0 and cell_key != key:
				_strip(run, c - run, r, key)
				run = -1
			if k == EMPTY:
				continue
			_info.cells.append([c, r, KINDS.get(k, "solid")])
			if not cell_key.is_empty():
				if run < 0:
					run = c
					key = cell_key
				if k == BREAKABLE:
					_cracks(c, r, _origin + Vector2(c, r) * TILE)
			elif k == LEDGE or k == ONEWAY:
				_thin_cell(c, r, k)
			elif k == HAZARD:
				_hazard_cell(c, r, depth)
			else:
				_full_cell(c, r, k, depth)
	queue_redraw()


## Outside the grid the level carries on (solid), so its border shows no edges.
func _at(c: int, r: int) -> int:
	if c < 0 or r < 0 or c >= _cols or r >= _rows:
		return SOLID
	return _cells[r * _cols + c]


func _full(k: int) -> bool:
	return k == SOLID or k == HAZARD or k == BREAKABLE


## An edge is exposed when the cell across it is empty or thin.
func _exposed(c: int, r: int) -> bool:
	return not _full(_at(c, r))


## Distance in tiles from each cell corner to the nearest exposed corner (two-pass chamfer, so
## shading follows the mass smoothly), capped at DEPTH_TILES.
func _depths() -> PackedFloat32Array:
	var w := _cols + 1
	var h := _rows + 1
	# Solidity with a one-cell solid border: corner (i, j) touches solid[j..j+1][i..i+1].
	var sw := _cols + 2
	var solid := PackedByteArray()
	solid.resize(sw * (_rows + 2))
	solid.fill(1)
	for r in _rows:
		for c in _cols:
			solid[(r + 1) * sw + c + 1] = 1 if _full(_cells[r * _cols + c]) else 0
	var d := PackedFloat32Array()
	d.resize(w * h)
	for j in h:
		for i in w:
			var a := j * sw + i
			d[j * w + i] = DEPTH_TILES if solid[a] + solid[a + 1] + solid[a + sw] + solid[a + sw + 1] == 4 else 0.0
	const DIAG := 1.41421
	for j in h:
		for i in w:
			var v := j * w + i
			var best := d[v]
			if best == 0.0:
				continue
			if i > 0:
				best = minf(best, d[v - 1] + 1.0)
			if j > 0:
				best = minf(best, d[v - w] + 1.0)
				if i > 0:
					best = minf(best, d[v - w - 1] + DIAG)
				if i < w - 1:
					best = minf(best, d[v - w + 1] + DIAG)
			d[v] = best
	for j in range(h - 1, -1, -1):
		for i in range(w - 1, -1, -1):
			var v := j * w + i
			var best := d[v]
			if best == 0.0:
				continue
			if i < w - 1:
				best = minf(best, d[v + 1] + 1.0)
			if j < h - 1:
				best = minf(best, d[v + w] + 1.0)
				if i < w - 1:
					best = minf(best, d[v + w + 1] + DIAG)
				if i > 0:
					best = minf(best, d[v + w - 1] + DIAG)
			d[v] = best
	return d


## `n` alike full cells from (c, r): one fill, glaze, rim and underside for all of them.
func _strip(c: int, n: int, r: int, key: Array) -> void:
	var p := _origin + Vector2(c, r) * TILE
	var rect := _rect(Rect2(p, Vector2(n * TILE, TILE)))
	var tint: Color = _style.breakable if key[0] == BREAKABLE else _style.color
	var top := _dim(tint, 1.0 - _style.shade * smoothstep(0.0, 1.0, key[3] / DEPTH_TILES))
	var bottom := _dim(tint, 1.0 - _style.shade * smoothstep(0.0, 1.0, key[4] / DEPTH_TILES))
	_add(_fill, rect, PackedColorArray([top, top, bottom, bottom]), "fill")
	if key[0] == BREAKABLE:
		_band(rect, Rect2(p, Vector2(n * TILE, TILE)), _style.glaze, _style.glaze, "glaze")
	_edges(rect, p, c, r, key[1], key[2], false, false, TILE, n)


func _full_cell(c: int, r: int, k: int, depth: PackedFloat32Array) -> void:
	var p := _origin + Vector2(c, r) * TILE
	var up := _exposed(c, r - 1)
	var down := _exposed(c, r + 1)
	var left := _exposed(c - 1, r)
	var right := _exposed(c + 1, r)
	var shape := _bevelled(Rect2(p, Vector2(TILE, TILE)), up and left, up and right, down and right, down and left)
	var tint: Color = _style.breakable if k == BREAKABLE else _style.color
	var fan := _fan(shape, p + Vector2(TILE, TILE) / 2.0)
	_add(_fill, fan, _shaded(fan, p, c, r, depth, tint), "fill")
	if k == BREAKABLE:
		_band(shape, Rect2(p, Vector2(TILE, TILE)), _style.glaze, _style.glaze, "glaze")
	_edges(shape, p, c, r, up, down, left, right, TILE)
	if k == BREAKABLE:
		_cracks(c, r, p)


func _hazard_cell(c: int, r: int, depth: PackedFloat32Array) -> void:
	var p := _origin + Vector2(c, r) * TILE
	var open := {"top": _exposed(c, r - 1), "bottom": _exposed(c, r + 1), "left": _exposed(c - 1, r), "right": _exposed(c + 1, r)}
	# Spikes point up or down out of strips, sideways only out of walls.
	if open.top or open.bottom:
		open.left = false
		open.right = false
	var inner := Rect2(p, Vector2(TILE, TILE))
	inner = inner.grow_individual(-SPIKE if open.left else 0.0, -SPIKE if open.top else 0.0, -SPIKE if open.right else 0.0, -SPIKE if open.bottom else 0.0)
	var fan := _fan(_rect(inner), inner.get_center())
	_add(_fill, fan, _shaded(fan, p, c, r, depth, _style.hazard), "fill")
	var spike: Color = _style.spike
	for side in open:
		if not open[side]:
			continue
		_info.spikes.append([c, r, side])
		# Base along the inner rect, tips on the cell edge, pointing out.
		var vertical: bool = side == "left" or side == "right"
		var a := inner.position.y if vertical else inner.position.x
		var b := inner.end.y if vertical else inner.end.x
		var n := maxi(1, roundi((b - a) / 11.0))
		var step := (b - a) / n
		for i in n:
			var s0 := a + i * step
			var base: Array
			var tip: Vector2
			match side:
				"top":
					base = [Vector2(s0, inner.position.y), Vector2(s0 + step, inner.position.y)]
					tip = Vector2(s0 + step / 2.0, p.y)
				"bottom":
					base = [Vector2(s0 + step, inner.end.y), Vector2(s0, inner.end.y)]
					tip = Vector2(s0 + step / 2.0, p.y + TILE)
				"left":
					base = [Vector2(inner.position.x, s0 + step), Vector2(inner.position.x, s0)]
					tip = Vector2(p.x, s0 + step / 2.0)
				_:
					base = [Vector2(inner.end.x, s0), Vector2(inner.end.x, s0 + step)]
					tip = Vector2(p.x + TILE, s0 + step / 2.0)
			var dark := spike.darkened(0.45)
			_add(_over, PackedVector2Array([base[0], tip, base[1]]), PackedColorArray([dark, spike, dark]), "spike")


func _thin_cell(c: int, r: int, k: int) -> void:
	var p := _origin + Vector2(c, r) * TILE
	var up := _exposed(c, r - 1)
	var left := _at(c - 1, r) == EMPTY
	var right := _at(c + 1, r) == EMPTY
	if k == LEDGE:
		var bevel := minf(BEVEL, _ledge / 3.0)
		var plank := _bevelled(Rect2(p, Vector2(TILE, _ledge)), false, false, right, left, bevel)
		var tint: Color = _style.color
		var low := _dim(tint, 1.0 - _style.shade * 0.5)
		_add(_fill, plank, _gradient(plank, p.y, _ledge, tint, low), "fill")
		_edges(plank, p, c, r, up, true, left, right, _ledge)
		return
	# One-way: a light board on posts, with a dashed rim: clearly something you can jump through.
	var tint: Color = _style.oneway
	var board := _rect(Rect2(p, Vector2(TILE, minf(BOARD, _ledge))))
	_add(_fill, board, _gradient(board, p.y, BOARD, tint, _dim(tint, 0.8)), "fill")
	for x in ([6.0, 22.0] if _ledge > BOARD else []):
		var post := _rect(Rect2(p + Vector2(x, BOARD), Vector2(4.0, _ledge - BOARD)))
		_add(_fill, post, _gradient(post, p.y + BOARD, _ledge - BOARD, _dim(tint, 0.75), _dim(tint, 0.45)), "fill")
	if up:
		_info.rims.append([c, r])
		for i in 4:
			_add(_over, _rect(Rect2(p + Vector2(i * 8.0 + 1.0, 0.0), Vector2(6.0, 3.0))), _flat(4, _style.rim), "rim")


## Rim on an exposed top, a fine line on exposed sides, darkness along an exposed underside.
func _edges(shape: PackedVector2Array, p: Vector2, c: int, r: int, up: bool, down: bool, left: bool, right: bool, height: float, n := 1) -> void:
	var rim: Color = _style.rim
	var edge: Color = _style.edge
	var width := n * TILE
	if up:
		for i in n:
			_info.rims.append([c + i, r])
		_band(shape, Rect2(p, Vector2(width, RIM)), rim, rim, "rim")
		_band(shape, Rect2(p + Vector2(0, RIM), Vector2(width, RIM_GLOW)), Color(rim, rim.a * 0.3), Color(rim, 0.0), "rim")
	var top := RIM if up else 0.0
	if left:
		_info.edges.append([c, r, "left"])
		_band(shape, Rect2(p + Vector2(0, top), Vector2(SIDE, height - top)), edge, edge, "edge")
	if right:
		_info.edges.append([c, r, "right"])
		_band(shape, Rect2(p + Vector2(TILE - SIDE, top), Vector2(SIDE, height - top)), edge, edge, "edge")
	if down:
		for i in n:
			_info.edges.append([c + i, r, "bottom" if height >= TILE else "underside"])
		var band := minf(UNDER, height * 0.45)
		_band(shape, Rect2(p + Vector2(0, height - band), Vector2(width, band)), Color(0, 0, 0, 0), Color(0, 0, 0, _style.under), "edge")


## Cracks through a breakable cell. Where a crack crosses an edge is decided by the edge, so
## cracks run on into the next breakable cell.
func _cracks(c: int, r: int, p: Vector2) -> void:
	var color: Color = _style.crack
	var j := hash(Vector2i(c, r))
	var centre := p + Vector2(TILE, TILE) / 2.0 + Vector2((j % 13) - 6, ((j >> 5) % 13) - 6)
	var ends := []
	for side in [["h", c, r, false], ["h", c, r + 1, false], ["v", c, r, true], ["v", c + 1, r, true]]:
		var h := hash(side.slice(0, 3))
		if h % 5 < 2:
			continue
		var t := 0.2 + 0.6 * float((h >> 7) % 100) / 100.0
		var at := _origin + Vector2(side[1], side[2]) * TILE
		ends.append(at + (Vector2(0, t * TILE) if side[3] else Vector2(t * TILE, 0)))
	if ends.is_empty():
		ends = [centre + Vector2(-7, -4), centre + Vector2(6, 5)]
	for e in ends:
		var bend := centre.lerp(e, 0.5) + Vector2(((j >> 9) % 7) - 3, ((j >> 12) % 7) - 3)
		_line(centre, bend, 2.0, color, p)
		_line(bend, e, 1.5, color, p)


# --- geometry ------------------------------------------------------------------

func _batch() -> Dictionary:
	return {"points": PackedVector2Array(), "colors": PackedColorArray(), "uvs": PackedVector2Array(), "indices": PackedInt32Array()}


## A convex polygon, fan-triangulated into a batch.
func _add(batch: Dictionary, poly: PackedVector2Array, colors: PackedColorArray, tag: String) -> void:
	if poly.size() < 3:
		return
	var base: int = batch.points.size()
	var scale: float = _style.texture_size
	for i in poly.size():
		batch.points.append(poly[i])
		batch.colors.append(colors[i])
		batch.uvs.append(poly[i] / scale)
		if i >= 2:
			batch.indices.append_array([base, base + i - 1, base + i])
	var lo := poly[0]
	var hi := poly[0]
	for v in poly:
		lo = lo.min(v)
		hi = hi.max(v)
	_info.shapes.append([lo.x, lo.y, hi.x - lo.x, hi.y - lo.y, tag])


## `rect` clipped to `shape`, colored from c0 to c1 along y (or x).
func _band(shape: PackedVector2Array, rect: Rect2, c0: Color, c1: Color, tag: String, along_x := false) -> void:
	if rect.size.x <= 0.0 or rect.size.y <= 0.0:
		return
	# Bands lie inside their cell: only a bevelled shape (more than 4 corners) needs clipping.
	var polys: Array = Geometry2D.intersect_polygons(shape, _rect(rect)) if shape.size() > 4 else [_rect(rect)]
	for poly in polys:
		var colors := PackedColorArray()
		for v in poly:
			var t: float = (v.x - rect.position.x) / rect.size.x if along_x else (v.y - rect.position.y) / rect.size.y
			colors.append(c0.lerp(c1, clampf(t, 0.0, 1.0)))
		_add(_over, poly, colors, tag)


## A line segment, clipped to its cell.
func _line(a: Vector2, b: Vector2, width: float, color: Color, cell: Vector2) -> void:
	var n := (b - a).orthogonal().normalized() * width / 2.0
	var quad := PackedVector2Array([a - n, b - n, b + n, a + n])
	for poly in Geometry2D.intersect_polygons(_rect(Rect2(cell, Vector2(TILE, TILE))), quad):
		_add(_over, poly, _flat(poly.size(), color), "crack")


## A polygon as a fan around a centre point (fills shade evenly, without a diagonal crease).
func _fan(poly: PackedVector2Array, centre: Vector2) -> PackedVector2Array:
	var out := PackedVector2Array([centre])
	out.append_array(poly)
	out.append(poly[0])
	return out


func _rect(r: Rect2) -> PackedVector2Array:
	return PackedVector2Array([r.position, Vector2(r.end.x, r.position.y), r.end, Vector2(r.position.x, r.end.y)])


## A rect with its outer corners (top-left, top-right, bottom-right, bottom-left) cut.
func _bevelled(r: Rect2, tl: bool, tr: bool, br: bool, bl: bool, size := BEVEL) -> PackedVector2Array:
	var out := PackedVector2Array()
	var corners := [[r.position, tl, Vector2(0, size), Vector2(size, 0)], [Vector2(r.end.x, r.position.y), tr, Vector2(-size, 0), Vector2(0, size)],
		[r.end, br, Vector2(0, -size), Vector2(-size, 0)], [Vector2(r.position.x, r.end.y), bl, Vector2(size, 0), Vector2(0, -size)]]
	for corner in corners:
		if corner[1]:
			out.append(corner[0] + corner[2])
			out.append(corner[0] + corner[3])
		else:
			out.append(corner[0])
	return out


## Vertex colors from the depth at the cell's corners (bilinear).
func _shaded(poly: PackedVector2Array, p: Vector2, c: int, r: int, depth: PackedFloat32Array, tint: Color) -> PackedColorArray:
	var w := _cols + 1
	var d00 := depth[r * w + c]
	var d10 := depth[r * w + c + 1]
	var d01 := depth[(r + 1) * w + c]
	var d11 := depth[(r + 1) * w + c + 1]
	var out := PackedColorArray()
	for v in poly:
		var u := clampf((v.x - p.x) / TILE, 0.0, 1.0)
		var t := clampf((v.y - p.y) / TILE, 0.0, 1.0)
		var d := lerpf(lerpf(d00, d10, u), lerpf(d01, d11, u), t) / DEPTH_TILES
		out.append(_dim(tint, 1.0 - _style.shade * smoothstep(0.0, 1.0, d)))
	return out


func _gradient(poly: PackedVector2Array, y: float, height: float, top: Color, bottom: Color) -> PackedColorArray:
	var out := PackedColorArray()
	for v in poly:
		out.append(top.lerp(bottom, clampf((v.y - y) / maxf(height, 1.0), 0.0, 1.0)))
	return out


func _flat(n: int, color: Color) -> PackedColorArray:
	var out := PackedColorArray()
	out.resize(n)
	out.fill(color)
	return out


func _dim(color: Color, k: float) -> Color:
	return Color(color.r * k, color.g * k, color.b * k, color.a)
