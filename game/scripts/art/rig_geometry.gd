extends RefCounted
## Pure geometry for rigs (see packages/core/src/art/rig.ts): turns part
## shapes into polygons in rest-pose rig space. No drawing, no state.

const CURVE_STEPS := 6
const ELLIPSE_STEPS := 28


static func v(p) -> Vector2:
	return Vector2(float(p[0]), float(p[1]))


static func to_points(raw: Array) -> PackedVector2Array:
	var out := PackedVector2Array()
	for p in raw:
		if typeof(p) == TYPE_ARRAY and p.size() >= 2:
			out.append(v(p))
	return out


## Smooth curve through `points` (Hermite with Catmull-Rom tangents scaled by
## `smooth`; indices in `sharp` get zero tangents = corners).
static func curve(points: PackedVector2Array, closed: bool, smooth: float, sharp: Dictionary = {}) -> PackedVector2Array:
	var n := points.size()
	if n < 2 or smooth <= 0.001:
		return points
	var tangents := PackedVector2Array()
	tangents.resize(n)
	for i in n:
		if sharp.has(i):
			tangents[i] = Vector2.ZERO
			continue
		var prev: Vector2
		var next: Vector2
		if closed:
			prev = points[(i - 1 + n) % n]
			next = points[(i + 1) % n]
		else:
			prev = points[max(i - 1, 0)]
			next = points[min(i + 1, n - 1)]
		tangents[i] = (next - prev) * 0.5 * smooth
	var out := PackedVector2Array()
	var segments := n if closed else n - 1
	for i in segments:
		var p0 := points[i]
		var p1 := points[(i + 1) % n]
		var m0 := tangents[i]
		var m1 := tangents[(i + 1) % n]
		for s in CURVE_STEPS:
			var t := float(s) / CURVE_STEPS
			var t2 := t * t
			var t3 := t2 * t
			out.append(
				(2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1
			)
	if not closed:
		out.append(points[n - 1])
	return out


static func ellipse(center: Vector2, rx: float, ry: float, rotation_deg: float) -> PackedVector2Array:
	var out := PackedVector2Array()
	var rot := deg_to_rad(rotation_deg)
	for i in ELLIPSE_STEPS:
		var a := TAU * i / ELLIPSE_STEPS
		out.append(center + Vector2(cos(a) * rx, sin(a) * ry).rotated(rot))
	return out


## Outline polygon of a tapered line along `line`.
static func stroke(line: PackedVector2Array, width: float, width_end: float) -> PackedVector2Array:
	var n := line.size()
	if n < 2:
		return PackedVector2Array()
	var lengths := PackedFloat32Array([0.0])
	for i in range(1, n):
		lengths.append(lengths[i - 1] + line[i].distance_to(line[i - 1]))
	var total := maxf(lengths[n - 1], 0.001)
	var left := PackedVector2Array()
	var right := PackedVector2Array()
	for i in n:
		var dir: Vector2
		if i == 0:
			dir = line[1] - line[0]
		elif i == n - 1:
			dir = line[n - 1] - line[n - 2]
		else:
			dir = line[i + 1] - line[i - 1]
		if dir.length_squared() < 0.000001:
			dir = Vector2.RIGHT
		var normal := dir.normalized().orthogonal()
		var half := lerpf(width, width_end, lengths[i] / total) * 0.5
		half = maxf(half, 0.15)
		left.append(line[i] + normal * half)
		right.append(line[i] - normal * half)
	# Round caps: a few points around each end.
	var out := PackedVector2Array()
	out.append_array(left)
	_cap(out, line[n - 1], line[n - 1] - line[n - 2], maxf(width_end, 0.3) * 0.5)
	right.reverse()
	out.append_array(right)
	_cap(out, line[0], line[0] - line[1], maxf(width, 0.3) * 0.5)
	return out


static func _cap(out: PackedVector2Array, at: Vector2, outward: Vector2, radius: float) -> void:
	if outward.length_squared() < 0.000001:
		return
	var base := outward.normalized().orthogonal()
	for i in range(1, 4):
		var a := PI * i / 4.0
		out.append(at + base.rotated(a) * radius)


## Valid, drawable polygons for `poly` (self-intersections resolved).
static func clean(poly: PackedVector2Array) -> Array:
	if poly.size() < 3:
		return []
	if not Geometry2D.triangulate_polygon(poly).is_empty():
		return [poly]
	# Clipper resolves self-intersections. Any holes it returns are drawn
	# filled too, which is what a self-crossing outline was meant to look like.
	var out := []
	for p in Geometry2D.offset_polygon(poly, 0.01):
		if not Geometry2D.triangulate_polygon(p).is_empty():
			out.append(p)
	return out


## Polygons of `poly` grown by `delta` (outline / glow).
static func grow(poly: PackedVector2Array, delta: float) -> Array:
	var out := []
	for p in Geometry2D.offset_polygon(poly, delta, Geometry2D.JOIN_ROUND):
		if not Geometry2D.triangulate_polygon(p).is_empty():
			out.append(p)
	return out
