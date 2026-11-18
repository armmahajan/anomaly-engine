extends Node2D
## Draws one character rig and plays its clips. Pure data in, pixels out:
## every rig the AI writes is drawn by this one script.
## Contract: packages/core/src/art/rig.ts and clip.ts. Origin = feet.
##
## Geometry is built once in rest-pose space (with a few "boil" variants of
## slightly wobbled outlines for a hand-drawn look); each frame only bone
## transforms are evaluated and applied.

const Geo := preload("res://scripts/art/rig_geometry.gd")

const BOIL_VARIANTS := 3
const BOIL_FPS := 8.0
## Halo layers: [growth as a fraction of the part's size, alpha].
const GLOW_LAYERS := [[0.18, 0.28], [0.4, 0.13], [0.7, 0.06]]

## Problems found while building (bad shapes are skipped, not fatal).
var warnings: Array[String] = []
## Freeze time (render service sets poses explicitly).
var manual_time := false
## Playback rate (stage previews).
var speed := 1.0
## Draw bones and pivots on top (stage previews).
var show_bones := false:
	set(value):
		show_bones = value
		queue_redraw()
## Cutout rigs: decoded images by file ref. Unset, the view looks for its source in the nearest
## ancestor's `_textures` (main.gd, filled by the studio's `images` message), until it arrives.
var textures := {}

var _bones := {}  # id -> {parent, pivot}
var _bone_order: Array[String] = []
var _parts: Array = []  # built parts, sorted by z
var _clips := {}
var _clip_id := ""
var _clip: Dictionary = {}
var _time := 0.0
var _boil := 0
var _boil_timer := 0.0
var _boil_amount := 0.0
var _pose := {}  # bone id -> Transform2D (bone-local rest offset -> rig space)
var _hidden := {}
## Cutout rigs: the source image's ref and placement (rig = (image px - anchor) * scale), its texture once found.
var _source := {}
var _texture: Texture2D = null


func setup(rig: Dictionary, direction: Dictionary, clips: Dictionary) -> void:
	_clips = clips if typeof(clips) == TYPE_DICTIONARY else {}
	_boil_amount = clampf(float(direction.get("boil", 0.0)), 0.0, 1.0)
	var ink_color := Color(str(direction.get("ink", "#15151c")))
	var ink_width := float(direction.get("inkWidth", 2.5))
	var source = rig.get("source")
	_source = source if typeof(source) == TYPE_DICTIONARY and typeof(source.get("anchor")) == TYPE_ARRAY else {}
	# A cutout's source is drawn several times smaller than its pixels: sample its mipmaps
	# (the shared textures have them) so edges don't shimmer as pieces turn.
	if not _source.is_empty():
		texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	_build_bones(rig.get("bones", []))
	_build_parts(rig.get("parts", []), ink_color, ink_width)
	_evaluate()
	queue_redraw()


## Play a clip by name ("" or unknown = rest pose). Same clip again = keep going.
func play(clip_id: String, restart := false) -> void:
	if clip_id == _clip_id and not restart:
		return
	_clip_id = clip_id
	_clip = _clips.get(clip_id, {}) if _clips.has(clip_id) else {}
	_time = 0.0


func has_clip(clip_id: String) -> bool:
	return _clips.has(clip_id)


func current_clip() -> String:
	return _clip_id


## Seconds a clip lasts (0 when there is no such clip).
func clip_duration(clip_id: String) -> float:
	return float(_clips.get(clip_id, {}).get("duration", 0.0)) if _clips.has(clip_id) else 0.0


## Pose at `seconds` into the current clip, with a given boil frame (render service).
func pose_at(seconds: float, boil_frame := 0) -> void:
	_time = seconds
	_boil = boil_frame % BOIL_VARIANTS
	_evaluate()
	queue_redraw()


func _process(delta: float) -> void:
	if manual_time:
		return
	_time += delta * speed
	if _boil_amount > 0.0:
		_boil_timer += delta
		if _boil_timer >= 1.0 / BOIL_FPS:
			_boil_timer = 0.0
			_boil = (_boil + 1) % BOIL_VARIANTS
	_evaluate()
	queue_redraw()


# --- build -------------------------------------------------------------------

func _build_bones(raw: Variant) -> void:
	_bones.clear()
	_bone_order.clear()
	if typeof(raw) != TYPE_ARRAY:
		warnings.append("rig has no bones")
		return
	for b in raw:
		if typeof(b) != TYPE_DICTIONARY or typeof(b.get("id")) != TYPE_STRING or typeof(b.get("pivot")) != TYPE_ARRAY:
			warnings.append("skipped a malformed bone")
			continue
		_bones[b.id] = {"parent": b.get("parent"), "pivot": Geo.v(b.pivot)}
	# Parents before children (rigs are validated acyclic; guard anyway).
	var placed := {}
	for _pass in _bones.size():
		for id in _bones:
			if placed.has(id):
				continue
			var parent = _bones[id].parent
			if parent == null or not _bones.has(parent) or placed.has(parent):
				placed[id] = true
				_bone_order.append(id)


func _build_parts(raw: Variant, ink_color: Color, ink_width: float) -> void:
	_parts.clear()
	if typeof(raw) != TYPE_ARRAY:
		warnings.append("rig has no parts")
		return
	var seed_value := 0
	for p in raw:
		seed_value += 1
		if typeof(p) != TYPE_DICTIONARY or typeof(p.get("shape")) != TYPE_DICTIONARY:
			warnings.append("skipped a malformed part")
			continue
		var bone := str(p.get("bone", ""))
		if not _bones.has(bone):
			warnings.append("part '%s' uses unknown bone '%s'" % [p.get("id"), bone])
			continue
		var bend := str(p.get("bendTo", ""))
		var part := {
			"id": str(p.get("id", "")),
			"bone": bone,
			"bend": bend if _bones.has(bend) and bend != bone else "",
			"z": int(p.get("z", 0)),
			"variants": [],
		}
		var opacity := clampf(float(p.get("opacity", 1.0)), 0.0, 1.0)
		if str(p.shape.get("type", "")) == "image":
			if _build_image_part(part, p.shape, opacity):
				_parts.append(part)
			continue
		var fill := Color(str(p.get("fill", "#888888")))
		fill.a *= opacity
		var shade = p.get("shade")
		var ink := float(p.get("ink", 1.0)) * ink_width
		var glow := bool(p.get("glow", false))
		var rng := RandomNumberGenerator.new()
		for variant in BOIL_VARIANTS:
			rng.seed = seed_value * 7919 + variant
			var wobble := _boil_amount * 0.8 if variant > 0 else 0.0
			var outline := _shape_outline(p.shape, rng, wobble)
			if outline.size() < 3:
				break
			var fills: Array = Geo.clean(outline)
			if fills.is_empty():
				warnings.append("part '%s' has an outline that can't be filled (does it cross itself?)" % part.id)
				break
			var layers := []  # [polygon, colors]
			if glow:
				var extent := _extent(outline)
				for g in GLOW_LAYERS:
					for poly in Geo.grow(outline, maxf(0.5, extent * g[0])):
						layers.append([poly, _flat(poly, Color(fill, fill.a * g[1]))])
			if ink > 0.0:
				var ink_c := Color(ink_color, ink_color.a * opacity)
				for poly in Geo.grow(outline, ink):
					layers.append([poly, _flat(poly, ink_c)])
			for poly in fills:
				layers.append([poly, _shaded(poly, fill, shade, opacity)])
			part.variants.append(_with_weights(layers, part))
		if part.variants.is_empty():
			continue
		_parts.append(part)
	_parts.sort_custom(func(a, b): return a.z < b.z)


## Cutout piece: the source image inside a polygon. One variant (no boil), no outline or fill;
## texture coordinates are the polygon's image px (normalized once the texture is known).
func _build_image_part(part: Dictionary, shape: Dictionary, opacity: float) -> bool:
	if _source.is_empty():
		warnings.append("image part '%s' needs the rig's source image" % part.id)
		return false
	var fills: Array = Geo.clean(Geo.to_points(shape.get("points", [])))
	if fills.is_empty():
		warnings.append("part '%s' has an outline that can't be filled (does it cross itself?)" % part.id)
		return false
	var scale := maxf(float(_source.get("scale", 1.0)), 0.000001)
	var anchor := Geo.v(_source.anchor)
	var layers := []
	part.image_px = []
	for poly in fills:
		var px := PackedVector2Array()
		for q in poly:
			px.append(q / scale + anchor)
		part.image_px.append(px)
		layers.append([poly, _flat(poly, Color(1, 1, 1, opacity))])
	part.variants.append(_with_weights(layers, part))
	return true


## The cutout source's texture: given, else from the nearest ancestor that keeps decoded images.
func _source_texture() -> Texture2D:
	if _texture != null or _source.is_empty():
		return _texture
	var file := str(_source.get("file", ""))
	var found = textures.get(file)
	var node := get_parent()
	while found == null and node != null:
		if "_textures" in node and typeof(node.get("_textures")) == TYPE_DICTIONARY:
			found = node.get("_textures").get(file)
		node = node.get_parent()
	if found is Texture2D:
		_texture = found
		var size: Vector2 = _texture.get_size()
		for part in _parts:
			if part.has("image_px"):
				part.uvs = part.image_px.map(func(px: PackedVector2Array):
					var uv := PackedVector2Array()
					for q in px:
						uv.append(q / size)
					return uv)
	return _texture


func _shape_outline(shape: Dictionary, rng: RandomNumberGenerator, wobble: float) -> PackedVector2Array:
	match str(shape.get("type", "")):
		"blob":
			var pts := _jitter(Geo.to_points(shape.get("points", [])), rng, wobble)
			var sharp := {}
			for i in shape.get("sharp", []):
				sharp[int(i)] = true
			return Geo.curve(pts, true, float(shape.get("smooth", 1.0)), sharp)
		"ellipse":
			var c := Geo.v(shape.get("center", [0, 0]))
			var e := Geo.ellipse(c, float(shape.get("rx", 4)), float(shape.get("ry", 4)), float(shape.get("rotation", 0)))
			return _jitter(e, rng, wobble * 0.5)
		"stroke":
			var line := _jitter(Geo.to_points(shape.get("points", [])), rng, wobble)
			var w := float(shape.get("width", 2))
			var line_smooth := Geo.curve(line, false, float(shape.get("smooth", 1.0)))
			return Geo.stroke(line_smooth, w, float(shape.get("widthEnd", w)))
	return PackedVector2Array()


func _extent(points: PackedVector2Array) -> float:
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for p in points:
		lo = lo.min(p)
		hi = hi.max(p)
	return maxf(hi.x - lo.x, hi.y - lo.y)


func _jitter(points: PackedVector2Array, rng: RandomNumberGenerator, amount: float) -> PackedVector2Array:
	if amount <= 0.0:
		return points
	var out := PackedVector2Array()
	for p in points:
		out.append(p + Vector2(rng.randf_range(-amount, amount), rng.randf_range(-amount, amount)))
	return out


func _flat(poly: PackedVector2Array, color: Color) -> PackedColorArray:
	var colors := PackedColorArray()
	colors.resize(poly.size())
	colors.fill(color)
	return colors


func _shaded(poly: PackedVector2Array, fill: Color, shade: Variant, opacity: float) -> PackedColorArray:
	if typeof(shade) != TYPE_DICTIONARY:
		return _flat(poly, fill)
	var to := Color(str(shade.get("color", "#000000")))
	to.a *= opacity
	var dir := Vector2.from_angle(deg_to_rad(float(shade.get("angle", 90))))
	var lo := INF
	var hi := -INF
	for p in poly:
		lo = minf(lo, p.dot(dir))
		hi = maxf(hi, p.dot(dir))
	var span := maxf(hi - lo, 0.001)
	var colors := PackedColorArray()
	for p in poly:
		# Keep the lit half mostly the fill color: shade the far side.
		var t := clampf((p.dot(dir) - lo) / span, 0.0, 1.0)
		colors.append(fill.lerp(to, smoothstep(0.25, 1.0, t)))
	return colors


## Per-vertex weight toward the bend bone (0 = follows `bone`, 1 = follows `bend`).
func _with_weights(layers: Array, part: Dictionary) -> Array:
	if part.bend == "":
		return layers
	var a: Vector2 = _bones[part.bone].pivot
	var d: Vector2 = _bones[part.bend].pivot - a
	var dd := maxf(d.length_squared(), 0.001)
	for layer in layers:
		var w := PackedFloat32Array()
		for p in layer[0]:
			w.append(clampf((p - a).dot(d) / dd, 0.0, 1.0))
		layer.append(w)
	return layers


# --- animate -----------------------------------------------------------------

func _evaluate() -> void:
	var t := _normalized_time()
	var duration := float(_clip.get("duration", 1.0))
	var channels := {}  # bone -> [rot, x, y, sx, sy]
	for id in _bone_order:
		channels[id] = [0.0, 0.0, 0.0, 1.0, 1.0]
	if not _clip.is_empty():
		for track in _clip.get("tracks", []):
			var bone = track.get("bone")
			if channels.has(bone):
				_apply_track(channels[bone], track, t)
		for motion in _clip.get("motions", []):
			var bone = motion.get("bone")
			if channels.has(bone):
				_apply_motion(channels[bone], motion, t, duration)
	_hidden.clear()
	if not _clip.is_empty():
		for vis in _clip.get("visibility", []):
			if not _visible_at(vis.get("keys", []), t):
				_hidden[str(vis.get("part", ""))] = true

	_pose.clear()
	for id in _bone_order:
		var bone: Dictionary = _bones[id]
		var c: Array = channels[id]
		var parent = bone.parent
		var local := Transform2D(deg_to_rad(c[0]), Vector2(c[3], c[4]), 0.0, Vector2(c[1], c[2]))
		if parent != null and _pose.has(parent):
			var parent_pivot: Vector2 = _bones[parent].pivot
			_pose[id] = _pose[parent] * Transform2D(0.0, bone.pivot - parent_pivot) * local
		else:
			_pose[id] = Transform2D(0.0, bone.pivot) * local


func _normalized_time() -> float:
	if _clip.is_empty():
		return 0.0
	var duration := maxf(float(_clip.get("duration", 1.0)), 0.01)
	if bool(_clip.get("loop", true)):
		return fmod(_time, duration) / duration
	return clampf(_time / duration, 0.0, 1.0)


func _apply_track(c: Array, track: Dictionary, t: float) -> void:
	var keys: Array = track.get("keys", [])
	if keys.is_empty():
		return
	var value := float(keys[0][1])
	if t >= float(keys[keys.size() - 1][0]):
		value = float(keys[keys.size() - 1][1])
	else:
		for i in range(keys.size() - 1):
			var k0: Array = keys[i]
			var k1: Array = keys[i + 1]
			if t >= float(k0[0]) and t < float(k1[0]):
				var span := maxf(float(k1[0]) - float(k0[0]), 0.0001)
				var u := (t - float(k0[0])) / span
				match str(track.get("ease", "smooth")):
					"step":
						u = 0.0
					"smooth":
						u = smoothstep(0.0, 1.0, u)
				value = lerpf(float(k0[1]), float(k1[1]), u)
				break
	match str(track.get("property", "")):
		"rotate":
			c[0] += value
		"x":
			c[1] += value
		"y":
			c[2] += value
		"scaleX":
			c[3] *= value
		"scaleY":
			c[4] *= value


func _apply_motion(c: Array, m: Dictionary, t: float, duration: float) -> void:
	var cycles := float(m.get("cycles", 1))
	var wave := sin(TAU * (t * cycles + float(m.get("phase", 0.0))))
	var amount := float(m.get("amount", 0.0))
	match str(m.get("type", "")):
		"sway":
			c[0] += float(m.get("degrees", 0.0)) * wave
		"bob":
			c[2] -= amount * wave
		"shift":
			c[1] += amount * wave
		"pulse":
			c[3] *= 1.0 + amount * wave
			c[4] *= 1.0 + amount * wave
		"squash":
			var width := maxf(float(m.get("width", 0.25)), 0.01)
			var d := absf(t - float(m.get("at", 0.5))) / (width * 0.5)
			var k := amount * (0.5 + 0.5 * cos(PI * d)) if d < 1.0 else 0.0
			c[3] *= 1.0 + k
			c[4] *= 1.0 - k
		"shake":
			var frame := floori(t * duration * 30.0)
			c[1] += amount * (fmod(sin(frame * 12.9898) * 43758.5453, 1.0) * 2.0 - 1.0)
			c[2] += amount * (fmod(sin(frame * 78.233) * 12345.678, 1.0) * 2.0 - 1.0)


func _visible_at(keys: Array, t: float) -> bool:
	var visible := true
	for k in keys:
		if typeof(k) == TYPE_ARRAY and k.size() >= 2 and float(k[0]) <= t:
			visible = bool(k[1])
	return visible


# --- draw --------------------------------------------------------------------

## Seconds into the current clip (for the studio's timeline).
func clip_time() -> float:
	return _time


func _draw() -> void:
	if show_bones:
		_draw_bones.call_deferred()
	var texture := _source_texture()
	for part in _parts:
		if _hidden.has(part.id):
			continue
		var image: bool = part.has("image_px")
		if image and texture == null:
			continue  # the source image has not arrived yet
		var layers: Array = part.variants[mini(_boil, part.variants.size() - 1)]
		var base: Vector2 = _bones[part.bone].pivot
		var xf: Transform2D = _pose.get(part.bone, Transform2D.IDENTITY) * Transform2D(0.0, -base)
		var xf2 := xf
		if part.bend != "":
			xf2 = _pose.get(part.bend, Transform2D.IDENTITY) * Transform2D(0.0, -(_bones[part.bend].pivot as Vector2))
		for n in layers.size():
			var layer: Array = layers[n]
			var poly: PackedVector2Array = layer[0]
			var out: PackedVector2Array
			if part.bend == "":
				out = xf * poly
			else:
				var weights: PackedFloat32Array = layer[2]
				out.resize(poly.size())
				for i in poly.size():
					out[i] = (xf * poly[i]).lerp(xf2 * poly[i], weights[i])
			if image:
				draw_polygon(out, layer[1], part.uvs[n], texture)
			else:
				draw_polygon(out, layer[1])


var _bone_overlay: Node2D = null


func _draw_bones() -> void:
	if _bone_overlay == null:
		_bone_overlay = Node2D.new()
		_bone_overlay.z_index = 1
		_bone_overlay.draw.connect(_paint_bones)
		add_child(_bone_overlay)
	_bone_overlay.visible = show_bones
	_bone_overlay.queue_redraw()


func _paint_bones() -> void:
	var width := 1.2 / maxf(absf(global_scale.y), 0.01)
	for id in _bone_order:
		var at: Vector2 = _pose.get(id, Transform2D.IDENTITY).origin
		var parent = _bones[id].parent
		if parent != null and _pose.has(parent):
			_bone_overlay.draw_line(_pose[parent].origin, at, Color(1.0, 0.3, 0.6, 0.85), width * 1.5)
		_bone_overlay.draw_circle(at, width * 2.2, Color(1.0, 0.85, 0.2))
