extends Node2D
## Draws one character rig and plays its clips. Pure data in, pixels out:
## every rig the AI writes is drawn by this one script.
## Contract: packages/core/src/art/rig.ts and clip.ts. Origin = feet.
##
## Geometry is built once in rest-pose space (with a few "boil" variants of
## slightly wobbled outlines for a hand-drawn look) and triangulated there once;
## each frame only bone transforms are evaluated and applied to the vertices,
## which are drawn with the rest pose's triangles (a pose that folds or
## collapses a part can't fail triangulation). Mesh parts (layered rigs) come
## with their own triangles.

const Geo := preload("res://scripts/art/rig_geometry.gd")

const BOIL_VARIANTS := 3
const BOIL_FPS := 8.0
## Halo layers: [growth as a fraction of the part's size, alpha].
const GLOW_LAYERS := [[0.18, 0.28], [0.4, 0.13], [0.7, 0.06]]
## A clip's look glow (clip.ts LookTrack): the part's silhouette scaled about its centre, [scale, alpha at glow 1].
const LOOK_GLOW_LAYERS := [[1.06, 0.34], [1.14, 0.22], [1.24, 0.14], [1.36, 0.08], [1.5, 0.05]]
## Crossfade into a clip without its own blendIn (seconds; core clip.ts DEFAULT_BLEND_IN).
const DEFAULT_BLEND_IN := 0.12
## Springs (rig.ts Bone.spring) step at this fixed rate whatever the frame rate.
const SPRING_STEP := 1.0 / 120.0
## A spring bone turns at most this far from where the clip puts it (radians, 75°).
const SPRING_MAX_TURN := 1.309
## pose_at moving back, or forward more than this, starts the springs again (settled), warmed up over
## SPRING_WARMUP seconds of the clip so a render or a scrubbed stage shows them in their swing.
const SPRING_JUMP := 0.25
const SPRING_WARMUP := 1.5
## Ease constants (core art/motion.ts easeAt).
const EASE_C1 := 1.70158
const EASE_C3 := EASE_C1 + 1.0
const EASE_C4 := TAU / 3.0
const EASE_N1 := 7.5625
const EASE_D1 := 2.75
## Draws a textured layer as its silhouette in the vertex colour (tint overlays and glow halos on
## image and mesh parts), told apart by texture coordinates moved by +8 (normal draws are 0..1).
const SILHOUETTE_SHADER := """
shader_type canvas_item;
varying vec4 vcolor;
varying float silhouette;
void vertex() {
	vcolor = COLOR;
	silhouette = UV.x > 4.0 ? 1.0 : 0.0;
}
void fragment() {
	if (silhouette > 0.5) {
		COLOR = vec4(vcolor.rgb, vcolor.a * texture(TEXTURE, UV - vec2(8.0)).a);
	}
}
"""
static var _silhouette_material: ShaderMaterial = null

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
		# The overlay is only repainted while bones show: hide it here, or turning bones off leaves it up.
		if _bone_overlay != null:
			_bone_overlay.visible = value
		queue_redraw()
## Decoded images by file ref (a cutout's source, part textures). Unset, the view looks for them
## in the nearest ancestor's `_textures` (main.gd, filled by the studio's `images` message), until they arrive.
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
## Cutout rigs: the source image's ref and placement (rig = (image px - anchor) * scale).
var _source := {}
## Images found so far, by file ref.
var _found := {}
## Where weapons are held (rig.grips): id -> {bone, at (rest, rig space), angle (radians)}.
var _grips := {}
## The rest pose's bounds (parts), for holding a weapon in front of a rig without a grip.
var _rest_bounds := Rect2(-12, -40, 24, 40)
## Grip id -> the bone at the top of the arm holding it ("" = none: a grip on the body or the root).
var _shoulders := {}
## A turn toward a mouse aim added to a shoulder's rotation on every pose (radians; "" = none).
var _turn_bone := ""
var _turn := 0.0

## Crossfade into the next clip (clip.blendIn) from the pose before it. Off for stages posed by time.
var crossfade := true
## The pose being faded from (bone -> channels [rot, x, y, sx, sy]) and its looks; empty = none.
var _blend_from := {}
var _blend_looks := {}
var _blend_in := 0.0
## The last pose's channels (after IK and crossfade, before the aim turn and springs).
var _channels := {}
## The current looks (clip.looks): part id ("" = every part) -> look; empty = none.
var _looks := {}
## Spring bones: id -> {k, c, reach (rest offset from the pivot to what it carries), length,
## x (the lagging point, rig space), v, prev (the target at the last step), live}.
var _springs := {}
var _spring_order: Array[String] = []
## Seconds not yet stepped (less than one SPRING_STEP).
var _spring_acc := 0.0

## Emitted after every pose is evaluated (the weapon view follows the grip with no frame of lag).
signal posed
## The playing clip crossed one of its markers (core art/clip.ts Clip.markers): once per pass of the
## clip, in time order. Only while `emit_markers` is on (the owner routes them as events: events.gd marker).
signal marker(marker_name: String, clip: String)

## Fire `marker` as clips play (characters and objects in a room; never stages or renders). Who
## listens decides whether the run is playing.
var emit_markers := false
## Clip time (seconds, unwrapped: loops keep counting) up to which markers were fired.
var _marked := -1.0
## The current clip's markers, by time: [[t (0..1), name, index]].
var _markers: Array = []


func setup(rig: Dictionary, direction: Dictionary, clips: Dictionary) -> void:
	_clips = clips if typeof(clips) == TYPE_DICTIONARY else {}
	_boil_amount = clampf(float(direction.get("boil", 0.0)), 0.0, 1.0)
	var ink_color := Color(str(direction.get("ink", "#15151c")))
	var ink_width := float(direction.get("inkWidth", 2.5))
	var source = rig.get("source")
	_source = source if typeof(source) == TYPE_DICTIONARY and typeof(source.get("anchor")) == TYPE_ARRAY else {}
	_build_bones(rig.get("bones", []))
	_build_parts(rig.get("parts", []), ink_color, ink_width)
	_build_grips(rig.get("grips", []))
	_find_shoulders(rig.get("parts", []))
	_rest_bounds = rest_bounds_of(rig)
	_build_springs(rig.get("bones", []), rig.get("parts", []))
	_blend_from = {}
	_blend_looks = {}
	_channels = {}
	_looks = {}
	# Images (a cutout's source, part textures) are drawn several times smaller than their pixels:
	# sample their mipmaps (the shared textures have them) so edges don't shimmer as pieces turn.
	if _parts.any(func(part): return part.tex_file != ""):
		texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	_evaluate()
	queue_redraw()


## Play a clip by name ("" or unknown = rest pose). Same clip again = keep going.
func play(clip_id: String, restart := false) -> void:
	if clip_id == _clip_id and not restart:
		return
	var had_clip := not _clip.is_empty()
	_clip_id = clip_id
	_clip = _clips.get(clip_id, {}) if _clips.has(clip_id) else {}
	_time = 0.0
	# Crossfade from the pose shown now (a clip was playing; a view just built starts clean).
	var blend := clampf(float(_clip.get("blendIn", DEFAULT_BLEND_IN)), 0.0, 1.0)
	if crossfade and had_clip and blend > 0.0 and not _channels.is_empty():
		_blend_from = _channels.duplicate(true)
		_blend_looks = _looks.duplicate(true)
		_blend_in = blend
	else:
		_blend_from = {}
		_blend_looks = {}
		_blend_in = 0.0
	_marked = -1.0
	_markers = []
	for m in _clip.get("markers", []):
		if typeof(m) == TYPE_DICTIONARY and m.has("name"):
			_markers.append([clampf(float(m.get("t", 0.0)), 0.0, 1.0), str(m.name), _markers.size()])
	# By time, then as listed (core interpret.ts clipMarkers sorts the same way).
	_markers.sort_custom(func(a, b): return a[0] < b[0] or (a[0] == b[0] and a[2] < b[2]))


func has_clip(clip_id: String) -> bool:
	return _clips.has(clip_id)


func current_clip() -> String:
	return _clip_id


## Seconds a clip lasts (0 when there is no such clip).
func clip_duration(clip_id: String) -> float:
	return float(_clips.get(clip_id, {}).get("duration", 0.0)) if _clips.has(clip_id) else 0.0


## A clip's own data ({} when there is no such clip).
func clip_data(clip_id: String) -> Dictionary:
	return _clips.get(clip_id, {}) if _clips.has(clip_id) else {}


## The current clip doesn't loop and has played to its end (false with no clip).
func clip_ended() -> bool:
	return not _clip.is_empty() and not bool(_clip.get("loop", true)) and _time >= maxf(float(_clip.get("duration", 1.0)), 0.01)


## Pose at `seconds` into the current clip, with a given boil frame (render service).
## Going back in time starts a new pass (its markers fire again from the start).
func pose_at(seconds: float, boil_frame := 0) -> void:
	if seconds < _marked:
		_marked = -1.0
	var step := seconds - _time
	_time = seconds
	_boil = boil_frame % BOIL_VARIANTS
	if not _springs.is_empty() and (step < 0.0 or step > SPRING_JUMP or not _springs_live()):
		_warm_springs()
		step = 0.0
	_evaluate(step)
	_fire_markers()
	queue_redraw()


func _process(delta: float) -> void:
	if manual_time:
		return
	_time += delta * speed
	_fire_markers()
	if _boil_amount > 0.0:
		_boil_timer += delta
		if _boil_timer >= 1.0 / BOIL_FPS:
			_boil_timer = 0.0
			_boil = (_boil + 1) % BOIL_VARIANTS
	_evaluate(delta * speed)
	queue_redraw()


## Fire the markers crossed since the last check, in time order: (marked, time] of the clip's
## unwrapped time (a looping clip passes each marker once per loop).
func _fire_markers() -> void:
	if not emit_markers or _markers.is_empty():
		_marked = maxf(_marked, _time)
		return
	if _time <= _marked:
		return
	var duration := maxf(float(_clip.get("duration", 1.0)), 0.01)
	var loops := bool(_clip.get("loop", true))
	var clip := _clip_id
	var from := _marked
	_marked = _time
	var first := floori(maxf(from, 0.0) / duration) if loops else 0
	var last := floori(_time / duration) if loops else 0
	for k in range(first, mini(last, first + 3) + 1):  # at most a few passes in one step
		for m in _markers:
			var at: float = (k + m[0]) * duration
			if at > from and at <= _time:
				marker.emit(m[1], clip)
				if _clip_id != clip:
					return  # a handler switched clips: the rest of this one doesn't play


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
	# Parts by id with their boil seed, so a part clipped to another can rebuild that one's outline.
	var by_id := {}
	for i in raw.size():
		var q = raw[i]
		if typeof(q) == TYPE_DICTIONARY and typeof(q.get("shape")) == TYPE_DICTIONARY:
			by_id[str(q.get("id", ""))] = [q, i + 1]
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
			"tex_file": "",
			"tex_norm": false,
		}
		var opacity := clampf(float(p.get("opacity", 1.0)), 0.0, 1.0)
		if str(p.shape.get("type", "")) == "image":
			if _build_image_part(part, p.shape, opacity):
				_parts.append(part)
			continue
		if str(p.shape.get("type", "")) == "mesh":
			if _build_mesh_part(part, p, opacity):
				_parts.append(part)
			continue
		var fill := Color(str(p.get("fill", "#888888")))
		fill.a *= opacity
		var shade = p.get("shade")
		var ink := float(p.get("ink", 1.0)) * ink_width
		var glow := bool(p.get("glow", false))
		# Clipped parts (detail shapes) are drawn only inside another part on the same bone(s).
		var clip_to := str(p.get("clipTo", ""))
		var clip: Array = []
		if clip_to != "":
			var target = by_id.get(clip_to)
			if target == null or str(target[0].get("bone", "")) != bone or str(target[0].get("bendTo", "")) != str(p.get("bendTo", "")) or str(target[0].shape.get("type", "")) in ["image", "mesh"]:
				warnings.append("part '%s' clips to '%s', which is not a vector part on the same bone (drawn unclipped)" % [part.id, clip_to])
			else:
				clip = target
		var texture := _texture_mapping(p.get("texture"), part.id)
		if not texture.is_empty():
			part.tex_file = texture.file
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
			var inside: Array = []
			if not clip.is_empty():
				var clip_rng := RandomNumberGenerator.new()
				clip_rng.seed = int(clip[1]) * 7919 + variant
				inside = Geo.clean(_shape_outline(clip[0].shape, clip_rng, wobble))
			var layers := []  # [polygon, colors, bend weights, texture px]
			if glow:
				var extent := _extent(outline)
				for g in GLOW_LAYERS:
					for poly in _clipped(Geo.grow(outline, maxf(0.5, extent * g[0])), inside):
						layers.append(_layer(poly, _flat(poly, Color(fill, fill.a * g[1])), PackedVector2Array(), "glow"))
			if ink > 0.0:
				var ink_c := Color(ink_color, ink_color.a * opacity)
				for poly in _clipped(Geo.grow(outline, ink), inside):
					layers.append(_layer(poly, _flat(poly, ink_c), PackedVector2Array(), "ink"))
			var shapes := _clipped(fills, inside)
			for poly in shapes:
				layers.append(_layer(poly, _shaded(poly, fill, shade, opacity), PackedVector2Array(), "fill"))
			# The texture: the same polygons again, over the fill, with texture coordinates (image px).
			if not texture.is_empty():
				var tint := Color(1, 1, 1, opacity * float(texture.opacity))
				for poly in shapes:
					var uv := PackedVector2Array()
					for q in poly:
						uv.append(texture.uv_origin + (q - texture.rect_origin) * texture.per_px)
					layers.append(_layer(poly, _flat(poly, tint), uv, "tex"))
			part.variants.append(_with_weights(_triangulated(layers, part), part))
		if part.variants.is_empty():
			continue
		_parts.append(part)
	_parts.sort_custom(func(a, b): return a.z < b.z)


## Cutout piece: the source image inside a polygon. One variant (no boil), no outline or fill;
## texture coordinates are the polygon's image px (normalized once the image is known).
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
	part.image = true
	part.tex_file = str(_source.get("file", ""))
	for poly in fills:
		var px := PackedVector2Array()
		for q in poly:
			px.append(q / scale + anchor)
		layers.append(_layer(poly, _flat(poly, Color(1, 1, 1, opacity)), px, "image"))
	part.variants.append(_with_weights(_triangulated(layers, part), part))
	return true


## Layered rigs: the part's texture on its own triangle mesh (vertices = points then inner, uv in
## the texture's px, optional weights toward bendTo, else weighted like vector parts). One variant
## (no boil), no fill, outline or glow; like a cutout piece it shows nothing until its texture arrives.
func _build_mesh_part(part: Dictionary, p: Dictionary, opacity: float) -> bool:
	var shape: Dictionary = p.shape
	var raw_texture = p.get("texture")
	var file := str(raw_texture.get("file", "")) if typeof(raw_texture) == TYPE_DICTIONARY else ""
	if file == "":
		warnings.append("mesh part '%s' needs a texture (not drawn)" % part.id)
		return false
	var verts := Geo.to_points(shape.get("points", []))
	verts.append_array(Geo.to_points(shape.get("inner", [])))
	var n := verts.size()
	var uv := Geo.to_points(shape.get("uv", []))
	var raw_tris = shape.get("triangles", [])
	var tris := PackedInt32Array()
	var bad: bool = typeof(raw_tris) != TYPE_ARRAY or raw_tris.size() < 3 or raw_tris.size() % 3 != 0 or uv.size() != n
	if not bad:
		for t in raw_tris:
			var i := int(t)
			if i < 0 or i >= n:
				bad = true
				break
			tris.append(i)
	if bad:
		warnings.append("mesh part '%s' has malformed triangles or uv (not drawn)" % part.id)
		return false
	var tint := Color(1, 1, 1, opacity * clampf(float(raw_texture.get("opacity", 1.0)), 0.0, 1.0))
	var layer := [verts, _flat(verts, tint), PackedFloat32Array(), uv, tris, "mesh"]
	part.image = true
	part.tex_file = file
	_with_weights([layer], part)
	var raw_weights = shape.get("weights")
	if part.bend != "" and typeof(raw_weights) == TYPE_ARRAY and raw_weights.size() == n:
		var w := PackedFloat32Array()
		for x in raw_weights:
			w.append(clampf(float(x), 0.0, 1.0))
		layer[2] = w
	part.variants.append([layer])
	return true


## A part texture's mapping (rig rest pose -> image px), or {} when it has none or it is malformed.
func _texture_mapping(raw: Variant, part_id: String) -> Dictionary:
	if typeof(raw) != TYPE_DICTIONARY:
		return {}
	var rect = raw.get("rect")
	var uv = raw.get("uv")
	if typeof(rect) != TYPE_ARRAY or typeof(uv) != TYPE_ARRAY or rect.size() < 4 or uv.size() < 4 or float(rect[2]) <= 0.0 or float(rect[3]) <= 0.0:
		warnings.append("part '%s' has a malformed texture (drawn without it)" % part_id)
		return {}
	return {
		"file": str(raw.get("file", "")),
		"rect_origin": Vector2(float(rect[0]), float(rect[1])),
		"uv_origin": Vector2(float(uv[0]), float(uv[1])),
		"per_px": Vector2(float(uv[2]) / float(rect[2]), float(uv[3]) / float(rect[3])),
		"opacity": clampf(float(raw.get("opacity", 1.0)), 0.0, 1.0),
	}


## An image by file ref: given, else from the nearest ancestor that keeps decoded images.
## The first time a part's image is found, its texture coordinates are normalized to it.
func _image_for(part: Dictionary) -> Texture2D:
	var file: String = part.tex_file
	var found = _found.get(file)
	if found == null:
		found = textures.get(file)
		var node := get_parent()
		while found == null and node != null:
			if "_textures" in node and typeof(node.get("_textures")) == TYPE_DICTIONARY:
				found = node.get("_textures").get(file)
			node = node.get_parent()
		if not found is Texture2D:
			return null
		_found[file] = found
	if not part.tex_norm:
		var size: Vector2 = (found as Texture2D).get_size()
		for layers in part.variants:
			for layer in layers:
				var px: PackedVector2Array = layer[3]
				for i in px.size():
					px[i] = px[i] / size
				layer[3] = px
		part.tex_norm = true
	return found


## Every image a rig's parts draw, by file ref (render service: which ones were not sent).
func image_files() -> Array:
	var out := []
	for part in _parts:
		if part.tex_file != "" and not part.tex_file in out:
			out.append(part.tex_file)
	return out


## A drawn layer: [polygon (rest pose), colors, bend weights, texture px, triangle indices, kind
## (glow, ink, fill, tex, image or mesh)].
func _layer(poly: PackedVector2Array, colors: PackedColorArray, uv := PackedVector2Array(), kind := "fill") -> Array:
	return [poly, colors, PackedFloat32Array(), uv, PackedInt32Array(), kind]


## `layers` with their triangles, computed once on the rest outline; a polygon that can't be
## triangulated is left out (with a warning) instead of failing on every frame.
func _triangulated(layers: Array, part: Dictionary) -> Array:
	var out := []
	var dropped := 0
	for layer in layers:
		var tris := Geometry2D.triangulate_polygon(layer[0])
		if tris.is_empty():
			dropped += 1
			continue
		layer[4] = tris
		out.append(layer)
	if dropped > 0:
		warnings.append("part '%s': %d polygon(s) can't be triangulated (not drawn)" % [part.id, dropped])
	return out


## `polys` cut to the inside of `inside` (no clipping when `inside` is empty).
func _clipped(polys: Array, inside: Array) -> Array:
	if inside.is_empty():
		return polys
	var out := []
	for a in polys:
		for b in inside:
			# Two simple polygons intersect in simple pieces (no holes).
			for piece in Geometry2D.intersect_polygons(a, b):
				if not Geometry2D.triangulate_polygon(piece).is_empty():
					out.append(piece)
	return out


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
		layer[2] = w
	return layers


# --- animate -----------------------------------------------------------------

## Pose the current clip at `_time`: tracks and motions, then IK, then the crossfade from the pose
## before, then the aim turn and springs (advanced by `step` seconds; 0 = not moved on).
func _evaluate(step := 0.0) -> void:
	var t := _normalized_time()
	var channels := _clip_channels(_clip, t)
	var looks := _clip_looks(_clip, t)
	if not _blend_from.is_empty() or not _blend_looks.is_empty():
		var w := clampf(_time / _blend_in, 0.0, 1.0) if _blend_in > 0.0 else 1.0
		if w >= 1.0:
			_blend_from = {}
			_blend_looks = {}
		else:
			for id in channels:
				var from = _blend_from.get(id)
				if from == null:
					continue
				var c: Array = channels[id]
				c[0] = from[0] + wrapf(c[0] - from[0], -180.0, 180.0) * w
				for k in range(1, 5):
					c[k] = lerpf(from[k], c[k], w)
			looks = _blend_look_sets(_blend_looks, looks, w)
	_channels = channels
	_looks = looks
	_hidden.clear()
	if not _clip.is_empty():
		for vis in _clip.get("visibility", []):
			if not _visible_at(vis.get("keys", []), t):
				_hidden[str(vis.get("part", ""))] = true
	var steps := 0
	if step > 0.0 and not _springs.is_empty():
		_spring_acc += step
		steps = int(floor(_spring_acc / SPRING_STEP))
		_spring_acc -= steps * SPRING_STEP
		steps = mini(steps, 120)
	_pose = _build_pose(channels, steps)
	_update_material()
	posed.emit()


## A clip's channels at normalized time t: bone -> [rot, x, y, sx, sy] from its tracks and motions,
## then its IK.
func _clip_channels(clip: Dictionary, t: float) -> Dictionary:
	var duration := float(clip.get("duration", 1.0))
	var channels := {}
	for id in _bone_order:
		channels[id] = [0.0, 0.0, 0.0, 1.0, 1.0]
	if not clip.is_empty():
		for track in clip.get("tracks", []):
			var bone = track.get("bone")
			if channels.has(bone):
				_apply_track(channels[bone], track, t)
		for motion in clip.get("motions", []):
			var bone = motion.get("bone")
			if channels.has(bone):
				_apply_motion(channels[bone], motion, t, duration)
		var ik = clip.get("ik")
		if typeof(ik) == TYPE_ARRAY and not ik.is_empty():
			_solve_ik(channels, ik, t)
	return channels


## Bone poses from channels (bone-local offset from its pivot -> rig space), with the aim turn and,
## on spring bones, the spring's lag (stepped `steps` times first).
func _build_pose(channels: Dictionary, steps := 0) -> Dictionary:
	var pose := {}
	for id in _bone_order:
		var bone: Dictionary = _bones[id]
		var c: Array = channels[id]
		var parent = bone.parent
		var rot: float = c[0]
		if id == _turn_bone:
			rot += rad_to_deg(_turn)
		var base: Transform2D
		var has_parent: bool = parent != null and pose.has(parent)
		if has_parent:
			var parent_pivot: Vector2 = _bones[parent].pivot
			base = pose[parent] * Transform2D(0.0, bone.pivot - parent_pivot)
		else:
			base = Transform2D(0.0, bone.pivot)
		if has_parent and _springs.has(id):
			rot += rad_to_deg(_spring_turn(_springs[id], base, steps))
		pose[id] = base * Transform2D(deg_to_rad(rot), Vector2(c[3], c[4]), 0.0, Vector2(c[1], c[2]))
	return pose


## Bone poses from channels alone (no turn, no springs): what IK solves on.
func _pose_from(channels: Dictionary) -> Dictionary:
	var pose := {}
	for id in _bone_order:
		var bone: Dictionary = _bones[id]
		var c: Array = channels[id]
		var parent = bone.parent
		var local := Transform2D(deg_to_rad(c[0]), Vector2(c[3], c[4]), 0.0, Vector2(c[1], c[2]))
		if parent != null and pose.has(parent):
			var parent_pivot: Vector2 = _bones[parent].pivot
			pose[id] = pose[parent] * Transform2D(0.0, bone.pivot - parent_pivot) * local
		else:
			pose[id] = Transform2D(0.0, bone.pivot) * local
	return pose


# --- IK (core art/motion.ts solveIk) -----------------------------------------------------------

## Each IK track turns its upper bone (bone's parent) and `bone` so the tip's pivot reaches the
## target (straight toward it when out of reach), then turns the tip to the angle it has without
## those two rotations (its own track still turns it). Tracks whose bones don't fit the rig are
## skipped (lint: clip_bad_ik).
func _solve_ik(channels: Dictionary, tracks: Array, t: float) -> void:
	for track in tracks:
		if typeof(track) != TYPE_DICTIONARY:
			continue
		var lower := str(track.get("bone", ""))
		var tip := str(track.get("tip", ""))
		if not _bones.has(lower) or not _bones.has(tip) or _bones[tip].parent != lower:
			continue
		var upper = _bones[lower].parent
		if upper == null or not _bones.has(upper):
			continue
		var at := _key_values(track.get("keys", []), t, str(track.get("ease", "smooth")))
		if at.size() < 2:
			continue
		var target := Vector2(at[0], at[1])
		var cw := str(track.get("bend", "cw")) != "ccw"
		# The tip keeps the angle it has with the limb's two rotations left out (they are overridden):
		# a planted foot stays level with the hips unless its own track turns it.
		var unturned := channels.duplicate()
		unturned[upper] = [0.0, channels[upper][1], channels[upper][2], channels[upper][3], channels[upper][4]]
		unturned[lower] = [0.0, channels[lower][1], channels[lower][2], channels[lower][3], channels[lower][4]]
		var tip_angle0: float = (_pose_from(unturned)[tip] as Transform2D).x.angle()
		var poses := _pose_from(channels)
		for _pass in 2:
			var s: Vector2 = poses[upper].origin
			var e: Vector2 = poses[lower].origin
			var w: Vector2 = poses[tip].origin
			var l1 := s.distance_to(e)
			var l2 := e.distance_to(w)
			if l1 < 1e-6 or l2 < 1e-6:
				break
			var solved := two_bone(s, l1, l2, target, cw, (w - s).angle())
			var grand = _bones[upper].parent
			var sign1 := _det_sign(poses[grand] if grand != null and poses.has(grand) else Transform2D.IDENTITY)
			channels[upper][0] += rad_to_deg(sign1 * wrapf(float(solved[0]) - (e - s).angle(), -PI, PI))
			poses = _pose_from(channels)
			var e2: Vector2 = poses[lower].origin
			var w2: Vector2 = poses[tip].origin
			var sign2 := _det_sign(poses[upper])
			channels[lower][0] += rad_to_deg(sign2 * wrapf(((solved[1] as Vector2) - e2).angle() - (w2 - e2).angle(), -PI, PI))
			poses = _pose_from(channels)
		var sign3 := _det_sign(poses[lower])
		channels[tip][0] += rad_to_deg(sign3 * wrapf(tip_angle0 - (poses[tip] as Transform2D).x.angle(), -PI, PI))


static func _det_sign(xf: Transform2D) -> float:
	return -1.0 if xf.determinant() < 0.0 else 1.0


## Two bones of lengths l1, l2 from `s` reaching for `target`: [the upper bone's angle, where the tip
## lands] (the target, or the nearest point the limb reaches on the line to it). cw puts the joint
## clockwise of the line (a right-facing knee in front). `fallback`: the direction when the target is on `s`.
static func two_bone(s: Vector2, l1: float, l2: float, target: Vector2, cw: bool, fallback := PI / 2.0) -> Array:
	var v := target - s
	var d := v.length()
	var base := v.angle() if d > 1e-6 else fallback
	var dc := minf(maxf(d, absf(l1 - l2) + 1e-6), l1 + l2)
	var cos_a := clampf((l1 * l1 + dc * dc - l2 * l2) / (2.0 * l1 * dc), -1.0, 1.0)
	var a := acos(cos_a)
	return [base - a if cw else base + a, s + Vector2(cos(base), sin(base)) * dc]


# --- springs (rig.ts Bone.spring) --------------------------------------------------------------

## Spring bones: what each carries (its child pivots' middle, else the farthest point of its parts)
## sets its reach; stiffness sets how fast it swings (0.5..8 Hz), damping how soon it settles.
func _build_springs(raw_bones: Variant, raw_parts: Variant) -> void:
	_springs.clear()
	_spring_acc = 0.0
	if typeof(raw_bones) != TYPE_ARRAY:
		return
	for b in raw_bones:
		if typeof(b) != TYPE_DICTIONARY or typeof(b.get("spring")) != TYPE_DICTIONARY or not _bones.has(str(b.get("id", ""))):
			continue
		var id := str(b.id)
		if _bones[id].parent == null:
			continue
		var pivot: Vector2 = _bones[id].pivot
		var reach := Vector2.ZERO
		var children := 0
		for other in _bones:
			if _bones[other].parent == id:
				reach += (_bones[other].pivot as Vector2) - pivot
				children += 1
		if children > 0:
			reach /= children
		elif typeof(raw_parts) == TYPE_ARRAY:
			for p in raw_parts:
				if typeof(p) != TYPE_DICTIONARY or str(p.get("bone", "")) != id or typeof(p.get("shape")) != TYPE_DICTIONARY:
					continue
				var pts: Array = p.shape.get("points", [])
				if str(p.shape.get("type", "")) == "ellipse":
					pts = [p.shape.get("center", [0, 0])]
				for q in pts:
					var off := Vector2(float(q[0]), float(q[1])) - pivot
					if off.length() > reach.length():
						reach = off
		if reach.length() < 4.0:
			reach = Vector2(0.0, 8.0)
		var spring: Dictionary = b.spring
		var omega := TAU * (0.5 + 7.5 * clampf(float(spring.get("stiffness", 0.3)), 0.01, 1.0))
		var zeta := maxf(clampf(float(spring.get("damping", 0.5)), 0.0, 1.0), 0.04)
		_springs[id] = {"k": omega * omega, "c": 2.0 * zeta * omega, "reach": reach, "length": reach.length(), "x": Vector2.ZERO, "v": Vector2.ZERO, "prev": Vector2.ZERO, "live": false}


func _springs_live() -> bool:
	for s in _springs.values():
		if not s.live:
			return false
	return true


## The turn (radians, in the bone's own frame) a spring adds: a point carried at `reach` from the
## pivot is pulled toward where the parent's motion puts it (`base`: the parent's pose at this bone's
## pivot, without the bone's own channels) and lags behind; the turn is the angle between them.
## `steps` fixed steps move it on, the target moving evenly from where it was at the last step.
func _spring_turn(s: Dictionary, base: Transform2D, steps: int) -> float:
	var target: Vector2 = base * (s.reach as Vector2)
	var pivot: Vector2 = base.origin
	if not s.live:
		s.x = target
		s.v = Vector2.ZERO
		s.prev = target
		s.live = true
	elif steps > 0:
		var x: Vector2 = s.x
		var v: Vector2 = s.v
		var from: Vector2 = s.prev
		var k: float = s.k
		var c: float = s.c
		for i in steps:
			var goal := from.lerp(target, float(i + 1) / steps)
			v += ((goal - x) * k - v * c) * SPRING_STEP
			x += v * SPRING_STEP
		# Big jumps (a snap, a jump cut) can't fling it: it stays within two reaches of the target.
		var limit: float = 2.0 * s.length
		if x.distance_to(target) > limit:
			x = target + (x - target).normalized() * limit
			v *= 0.5
		s.x = x
		s.v = v
		s.prev = target
	var turn := wrapf((s.x - pivot).angle() - (target - pivot).angle(), -PI, PI)
	turn = clampf(turn, -SPRING_MAX_TURN, SPRING_MAX_TURN)
	return turn * _det_sign(base)


## Start the springs again on the current clip: settled where it was SPRING_WARMUP s ago (a looping
## clip) or at its start, then run up to now, so a posed frame shows them in their swing.
func _warm_springs() -> void:
	for s in _springs.values():
		s.live = false
	_spring_acc = 0.0
	if _clip.is_empty():
		_build_pose(_clip_channels(_clip, 0.0), 0)
		return
	var duration := maxf(float(_clip.get("duration", 1.0)), 0.01)
	var loops := bool(_clip.get("loop", true))
	var start := _time - SPRING_WARMUP if loops else 0.0
	var frames := int(ceil(maxf(_time - start, 0.0) * 60.0))
	for i in frames + 1:
		var at := start + (_time - start) * (float(i) / frames if frames > 0 else 1.0)
		var t := fposmod(at, duration) / duration if loops else clampf(at / duration, 0.0, 1.0)
		var steps := 0
		if i > 0:
			_spring_acc += (_time - start) / frames
			steps = int(floor(_spring_acc / SPRING_STEP))
			_spring_acc -= steps * SPRING_STEP
		_build_pose(_clip_channels(_clip, t), steps)


# --- eases (core art/motion.ts easeAt) ---------------------------------------------------------

static func ease_at(ease: String, u: float) -> float:
	match ease:
		"smooth":
			return smoothstep(0.0, 1.0, u)
		"step":
			return 0.0
		"overshoot":
			var o := u - 1.0
			return 1.0 + EASE_C3 * o * o * o + EASE_C1 * o * o
		"anticipate":
			return EASE_C3 * u * u * u - EASE_C1 * u * u
		"elastic":
			if u <= 0.0:
				return 0.0
			if u >= 1.0:
				return 1.0
			return pow(2.0, -10.0 * u) * sin((u * 10.0 - 0.75) * EASE_C4) + 1.0
		"bounce":
			if u < 1.0 / EASE_D1:
				return EASE_N1 * u * u
			if u < 2.0 / EASE_D1:
				var b := u - 1.5 / EASE_D1
				return EASE_N1 * b * b + 0.75
			if u < 2.5 / EASE_D1:
				var b := u - 2.25 / EASE_D1
				return EASE_N1 * b * b + 0.9375
			var b := u - 2.625 / EASE_D1
			return EASE_N1 * b * b + 0.984375
	return u


## Keyed values ([t, v...] keys) at t: the first key's before it, the last's after it, eased between.
static func _key_values(keys: Array, t: float, ease: String) -> PackedFloat64Array:
	var out := PackedFloat64Array()
	if keys.is_empty() or typeof(keys[0]) != TYPE_ARRAY:
		return out
	var last: Array = keys[keys.size() - 1]
	var k0: Array = keys[0]
	var k1: Array = keys[0]
	var u := 0.0
	if t >= float(last[0]):
		k0 = last
		k1 = last
	else:
		for i in range(keys.size() - 1):
			if t >= float(keys[i][0]) and t < float(keys[i + 1][0]):
				k0 = keys[i]
				k1 = keys[i + 1]
				u = ease_at(ease, (t - float(k0[0])) / maxf(float(k1[0]) - float(k0[0]), 0.0001))
				break
	for j in range(1, mini(k0.size(), k1.size())):
		out.append(lerpf(float(k0[j]), float(k1[j]), u))
	return out


# --- looks (clip.ts LookTrack) -----------------------------------------------------------------

## A clip's looks at t: part id ("" = every part) -> {opacity, brightness, glow, glow_color, tint,
## tint_color}. Tracks on the same thing combine: opacity and brightness multiply, glow and tint
## take the strongest.
func _clip_looks(clip: Dictionary, t: float) -> Dictionary:
	var out := {}
	var tracks = clip.get("looks")
	if typeof(tracks) != TYPE_ARRAY:
		return out
	for track in tracks:
		if typeof(track) != TYPE_DICTIONARY:
			continue
		var at := _key_values(track.get("keys", []), t, str(track.get("ease", "smooth")))
		if at.is_empty():
			continue
		var part = track.get("part")
		var key := str(part) if part != null else ""
		if not out.has(key):
			out[key] = _no_look()
		var look: Dictionary = out[key]
		var color := Color(str(track.get("color", "#ffffff")))
		var value: float = at[0]
		match str(track.get("property", "")):
			"opacity":
				look.opacity *= clampf(value, 0.0, 1.0)
			"brightness":
				look.brightness *= clampf(value, 0.0, 4.0)
			"glow":
				if value > look.glow:
					look.glow = clampf(value, 0.0, 1.0)
					look.glow_color = color
			"tint":
				if value > look.tint:
					look.tint = clampf(value, 0.0, 1.0)
					look.tint_color = color
	return out


static func _no_look() -> Dictionary:
	return {"opacity": 1.0, "brightness": 1.0, "glow": 0.0, "glow_color": Color.WHITE, "tint": 0.0, "tint_color": Color.WHITE}


## Looks part way (w) from `a` to `b`.
static func _blend_look_sets(a: Dictionary, b: Dictionary, w: float) -> Dictionary:
	var out := {}
	for key in a.keys() + b.keys():
		if out.has(key):
			continue
		var x: Dictionary = a.get(key, _no_look())
		var y: Dictionary = b.get(key, _no_look())
		out[key] = {
			"opacity": lerpf(x.opacity, y.opacity, w),
			"brightness": lerpf(x.brightness, y.brightness, w),
			"glow": lerpf(x.glow, y.glow, w),
			"glow_color": (x.glow_color as Color).lerp(y.glow_color, w) if x.glow > 0.0 and y.glow > 0.0 else (y.glow_color if y.glow > 0.0 else x.glow_color),
			"tint": lerpf(x.tint, y.tint, w),
			"tint_color": (x.tint_color as Color).lerp(y.tint_color, w) if x.tint > 0.0 and y.tint > 0.0 else (y.tint_color if y.tint > 0.0 else x.tint_color),
		}
	return out


## A part's look: the whole rig's combined with its own; null when it is drawn as it is.
func _look_for(part_id: String) -> Variant:
	if _looks.is_empty():
		return null
	var all = _looks.get("")
	var own = _looks.get(part_id)
	if all == null and own == null:
		return null
	var look: Dictionary
	if all == null or own == null:
		look = all if own == null else own
	else:
		look = {
			"opacity": all.opacity * own.opacity,
			"brightness": all.brightness * own.brightness,
			"glow": maxf(all.glow, own.glow),
			"glow_color": own.glow_color if own.glow >= all.glow else all.glow_color,
			"tint": maxf(all.tint, own.tint),
			"tint_color": own.tint_color if own.tint >= all.tint else all.tint_color,
		}
	if look.opacity >= 1.0 and look.brightness == 1.0 and look.glow <= 0.0 and look.tint <= 0.0:
		return null
	return look


## Tints and glows on image and mesh layers draw silhouettes, which need this view's material (only
## while they show, and never over a material something else gave it, e.g. a dissolve).
func _update_material() -> void:
	var wanted := false
	for key in _looks:
		var look: Dictionary = _looks[key]
		if look.glow > 0.0 or look.tint > 0.0:
			wanted = true
			break
	if wanted and material == null:
		if _silhouette_material == null:
			var shader := Shader.new()
			shader.code = SILHOUETTE_SHADER
			_silhouette_material = ShaderMaterial.new()
			_silhouette_material.shader = shader
		material = _silhouette_material
	elif not wanted and material != null and material == _silhouette_material:
		material = null


# --- grips (where weapons are held) ----------------------------------------------

func _build_grips(raw: Variant) -> void:
	_grips.clear()
	if typeof(raw) != TYPE_ARRAY:
		return
	for g in raw:
		if typeof(g) != TYPE_DICTIONARY or typeof(g.get("at")) != TYPE_ARRAY:
			continue
		var bone := str(g.get("bone", ""))
		if not _bones.has(bone):
			warnings.append("grip '%s' is on unknown bone '%s'" % [g.get("id"), bone])
			continue
		_grips[str(g.get("id", "hand"))] = {"bone": bone, "at": Geo.v(g.at), "angle": deg_to_rad(float(g.get("angle", 0.0)))}


func has_grip(id := "hand") -> bool:
	return _grips.has(id)


## Turn the arm holding grip `id` by `radians` (rig space, + turns down) on top of every pose: the
## shoulder (the top bone of the arm) carries the hand and so the held weapon round. False when the
## grip has no arm (the weapon view turns the weapon instead); 0 clears it.
func set_aim_turn(id: String, radians: float) -> bool:
	var shoulder: String = _shoulders.get(id, "")
	if shoulder == "":
		_turn_bone = ""
		_turn = 0.0
		return false
	_turn_bone = shoulder if radians != 0.0 else ""
	_turn = radians
	return true


## The bone at the top of the arm holding each grip (art/src/weapons.ts armBones): from the grip's bone
## up while the bones are arm bones (named, or carrying a part named, arm / hand / forearm / ...), never
## the root; a grip on a bone not named as an arm turns the path's bone below the body.
func _find_shoulders(parts: Variant) -> void:
	_shoulders.clear()
	var part_names := {}
	if typeof(parts) == TYPE_ARRAY:
		for p in parts:
			if typeof(p) == TYPE_DICTIONARY and p.get("bone") != null:
				part_names.get_or_add(str(p.bone), []).append(str(p.get("id", "")))
	for id in _grips:
		var path: Array = []
		var at = _grips[id].bone
		while at != null and _bones.has(at) and not path.has(at):
			path.append(at)
			at = _bones[at].parent
		var limb := path.slice(0, path.size() - 1)
		if _is_arm_bone(str(path[0]), part_names):
			var n := 1
			while n < limb.size() and _is_arm_bone(str(limb[n]), part_names):
				n += 1
			limb = limb.slice(0, n)
		else:
			limb = limb.slice(0, maxi(1, limb.size() - 1))
		var shoulder: String = str(limb.back()) if not limb.is_empty() else ""
		# A grip on the body itself (not an arm, right under the root): turn the weapon, not the body.
		if shoulder != "" and limb.size() == 1 and not _is_arm_bone(shoulder, part_names) and path.size() <= 2:
			shoulder = ""
		_shoulders[id] = shoulder


static var _arm_word: RegEx = RegEx.create_from_string("^((fore|upper|lower|up|low)?arms?|forearm[lr]?|arm[lr]|hands?|hand[lr]|wrists?|fists?|elbows?|palms?|claws?|paws?|grip)$")
static var _not_arm_word: RegEx = RegEx.create_from_string("^(legs?|foot|feet|thighs?|shins?|knees?|tails?|wings?|ears?|hair|cloak|cape)$")


static func _has_word(id: String, word: RegEx) -> bool:
	for w in RegEx.create_from_string("[a-z]+").search_all(id.to_lower()):
		if word.search(w.get_string()) != null:
			return true
	return false


static func _is_arm_bone(id: String, part_names: Dictionary) -> bool:
	if _has_word(id, _not_arm_word):
		return false
	if _has_word(id, _arm_word):
		return true
	for part in part_names.get(id, []):
		if _has_word(part, _arm_word) and not _has_word(part, _not_arm_word):
			return true
	return false


## A grip on the current pose, in this view's space: the origin is where the hand closes and the
## x axis points the way the held weapon points (it turns and scales with the grip's bone).
## Null when the rig has no such grip.
func grip_transform(id := "hand") -> Variant:
	var g = _grips.get(id)
	if g == null:
		return null
	var pivot: Vector2 = _bones[g.bone].pivot
	return _pose.get(g.bone, Transform2D(0.0, pivot)) * Transform2D(g.angle, g.at - pivot)


## Where a rig without a grip holds a weapon: in front of the body at chest height, pointing
## forward, moving with the root bone.
func front_transform() -> Transform2D:
	var at := Vector2(_rest_bounds.end.x * 0.6, _rest_bounds.position.y + _rest_bounds.size.y * 0.45)
	if _bone_order.is_empty():
		return Transform2D(0.0, at)
	var root: String = _bone_order[0]
	var pivot: Vector2 = _bones[root].pivot
	return _pose.get(root, Transform2D(0.0, pivot)) * Transform2D(0.0, at - pivot)


## The rest pose's bounds (part outlines; ellipses by their larger radius).
static func rest_bounds_of(rig: Dictionary) -> Rect2:
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for part in rig.get("parts", []):
		if typeof(part) != TYPE_DICTIONARY or typeof(part.get("shape")) != TYPE_DICTIONARY:
			continue
		var shape: Dictionary = part.shape
		var pts: Array = shape.get("points", [])
		if str(shape.get("type")) == "ellipse":
			var c = shape.get("center", [0, 0])
			var r := maxf(float(shape.get("rx", 0)), float(shape.get("ry", 0)))
			pts = [[float(c[0]) - r, float(c[1]) - r], [float(c[0]) + r, float(c[1]) + r]]
		for p in pts:
			lo = lo.min(Vector2(float(p[0]), float(p[1])))
			hi = hi.max(Vector2(float(p[0]), float(p[1])))
	if lo.x == INF:
		return Rect2(-12, -40, 24, 40)
	return Rect2(lo, hi - lo)


func _normalized_time() -> float:
	if _clip.is_empty():
		return 0.0
	var duration := maxf(float(_clip.get("duration", 1.0)), 0.01)
	if bool(_clip.get("loop", true)):
		return fmod(_time, duration) / duration
	return clampf(_time / duration, 0.0, 1.0)


func _apply_track(c: Array, track: Dictionary, t: float) -> void:
	var at := _key_values(track.get("keys", []), t, str(track.get("ease", "smooth")))
	if at.is_empty():
		return
	var value: float = at[0]
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
	var canvas := get_canvas_item()
	var no_bones := PackedInt32Array()
	var no_weights := PackedFloat32Array()
	for part in _parts:
		if _hidden.has(part.id):
			continue
		var texture: Texture2D = _image_for(part) if part.tex_file != "" else null
		if part.get("image", false) and texture == null:
			continue  # the source image (or a mesh's layer) has not arrived yet
		var layers: Array = part.variants[mini(_boil, part.variants.size() - 1)]
		var posed := _posed_layers(part, layers)
		var look = _look_for(part.id)
		if look != null:
			_draw_looked(canvas, part, layers, posed, texture, look)
			continue
		for n in layers.size():
			var layer: Array = layers[n]
			var uv: PackedVector2Array = layer[3]
			# The rest pose's triangles over the posed vertices: never triangulated again, so a pose
			# that folds or collapses a part draws what is left of it instead of failing.
			if uv.is_empty():
				RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], posed[n], layer[1])
			elif texture != null:
				RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], posed[n], layer[1], uv, no_bones, no_weights, texture.get_rid())
			# else: a part texture that has not arrived yet (the flat fill shows meanwhile)


## A part drawn with a clip's look (clip.ts LookTrack): a glow halo under it (its silhouette scaled
## about its centre, in the glow colour), its colours tinted, brightened and faded. Flat layers take
## the tint in their colours; textured layers are brightened and faded through their vertex colours
## and take the tint as their silhouette drawn over them (the silhouette material; without it, the
## tint multiplies them).
func _draw_looked(canvas: RID, part: Dictionary, layers: Array, posed: Array, texture: Texture2D, look: Dictionary) -> void:
	var no_bones := PackedInt32Array()
	var no_weights := PackedFloat32Array()
	var silhouettes: bool = material != null and material == _silhouette_material
	var opacity: float = look.opacity
	var brightness: float = look.brightness
	var tint: float = look.tint
	var tint_color: Color = look.tint_color
	if look.glow > 0.0:
		# The halo: the outline (ink) where the part has one, else everything it draws.
		var kinds := ["ink"] if layers.any(func(l): return l[5] == "ink") else ["fill", "tex", "image", "mesh"]
		var centre := Vector2.ZERO
		var count := 0
		for n in layers.size():
			if layers[n][5] in kinds:
				for q in posed[n]:
					centre += q
					count += 1
		if count > 0:
			centre /= count
			for g in LOOK_GLOW_LAYERS:
				var halo := Color(look.glow_color, float(g[1]) * float(look.glow) * opacity)
				for n in layers.size():
					var layer: Array = layers[n]
					if not layer[5] in kinds:
						continue
					var grown := PackedVector2Array()
					for q in posed[n]:
						grown.append(centre + (q - centre) * float(g[0]))
					var uv: PackedVector2Array = layer[3]
					if uv.is_empty():
						RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], grown, _alpha_scaled(layer[1], halo))
					elif texture != null:
						if silhouettes:
							RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], grown, _alpha_scaled(layer[1], halo), _moved(uv), no_bones, no_weights, texture.get_rid())
						else:
							RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], grown, _alpha_scaled(layer[1], halo), uv, no_bones, no_weights, texture.get_rid())
	for n in layers.size():
		var layer: Array = layers[n]
		var uv: PackedVector2Array = layer[3]
		var colors := PackedColorArray()
		colors.resize((layer[1] as PackedColorArray).size())
		for i in colors.size():
			var c: Color = layer[1][i]
			if uv.is_empty():
				c = Color(c.lerp(tint_color, tint), c.a)
			elif not silhouettes and tint > 0.0:
				c = Color(c * Color.WHITE.lerp(tint_color, tint), c.a)
			colors[i] = Color(c.r * brightness, c.g * brightness, c.b * brightness, c.a * opacity)
		if uv.is_empty():
			RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], posed[n], colors)
		elif texture != null:
			RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], posed[n], colors, uv, no_bones, no_weights, texture.get_rid())
			if silhouettes and tint > 0.0:
				var over := Color(tint_color, tint * opacity)
				RenderingServer.canvas_item_add_triangle_array(canvas, layer[4], posed[n], _alpha_scaled(layer[1], over), _moved(uv), no_bones, no_weights, texture.get_rid())


## Colours of `color`, each with its alpha times the matching colour's alpha.
static func _alpha_scaled(colors: PackedColorArray, color: Color) -> PackedColorArray:
	var out := PackedColorArray()
	out.resize(colors.size())
	for i in colors.size():
		out[i] = Color(color, color.a * colors[i].a)
	return out


## Texture coordinates moved by +8: drawn as a silhouette by SILHOUETTE_SHADER.
static func _moved(uv: PackedVector2Array) -> PackedVector2Array:
	var out := PackedVector2Array()
	out.resize(uv.size())
	for i in uv.size():
		out[i] = uv[i] + Vector2(8.0, 8.0)
	return out


## A part's layers' vertices on the current pose (rig space): each follows `bone`, or for a part
## that bends, the blend of `bone` and `bendTo` by its weight: the turn from one bone's pose to the
## other's applied partly (that share of the angle, of the scale and of the joint's shift) about the
## joint where they meet, so the outside of a bend keeps its distance from the joint instead of
## cutting the corner (a straight blend of positions). A mirrored or degenerate turn blends positions.
## Mirrored in packages/art/src/layered.ts bendPoint.
func _posed_layers(part: Dictionary, layers: Array) -> Array:
	var base: Vector2 = _bones[part.bone].pivot
	var xf: Transform2D = _pose.get(part.bone, Transform2D.IDENTITY) * Transform2D(0.0, -base)
	var xf2 := xf
	if part.bend != "":
		xf2 = _pose.get(part.bend, Transform2D.IDENTITY) * Transform2D(0.0, -(_bones[part.bend].pivot as Vector2))
	var out := []
	if part.bend == "":
		for layer in layers:
			out.append(xf * (layer[0] as PackedVector2Array))
		return out
	var joint := _joint_between(part.bone, part.bend)
	var j0: Vector2 = xf * joint
	var j1: Vector2 = xf2 * joint
	var la := Transform2D(xf.x, xf.y, Vector2.ZERO)
	var m := Transform2D(xf2.x, xf2.y, Vector2.ZERO) * la.affine_inverse() if absf(la.determinant()) > 1e-9 else Transform2D.IDENTITY
	var turns := absf(la.determinant()) > 1e-9 and m.determinant() > 1e-9
	var angle := atan2(m.x.y, m.x.x) if turns else 0.0
	var k := Transform2D(-angle, Vector2.ZERO) * m  # what is left after the turn: scale and shear
	for layer in layers:
		var poly: PackedVector2Array = layer[0]
		var weights: PackedFloat32Array = layer[2]
		var bent := PackedVector2Array()
		bent.resize(poly.size())
		for i in poly.size():
			var w: float = weights[i]
			var a: Vector2 = xf * poly[i]
			if w <= 0.0:
				bent[i] = a
			elif w >= 1.0:
				bent[i] = xf2 * poly[i]
			elif not turns:
				bent[i] = a.lerp(xf2 * poly[i], w)
			else:
				var kw := Transform2D(Vector2(1, 0).lerp(k.x, w), Vector2(0, 1).lerp(k.y, w), Vector2.ZERO)
				bent[i] = j0.lerp(j1, w) + (Transform2D(angle * w, Vector2.ZERO) * kw).basis_xform(a - j0)
		out.append(bent)
	return out


## Where two bones meet (rest pose): the pivot of whichever is the other's descendant.
func _joint_between(bone: String, other: String) -> Vector2:
	var up = _bones[bone].parent
	var guard := 0
	while up != null and _bones.has(up) and guard < 64:
		if up == other:
			return _bones[bone].pivot
		up = _bones[up].parent
		guard += 1
	return _bones[other].pivot


## Probes and tests: a part's drawn layers on the current pose (boil frame 0), as
## [{points (rig space), indices, uv (texture px; normalized once its texture was found)}].
func posed_mesh(part_id: String) -> Array:
	for part in _parts:
		if part.id != part_id:
			continue
		var layers: Array = part.variants[0]
		var posed := _posed_layers(part, layers)
		var out := []
		for n in layers.size():
			out.append({"points": posed[n], "indices": layers[n][4], "uv": layers[n][3]})
		return out
	return []


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
