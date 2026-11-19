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
	_clip_id = clip_id
	_clip = _clips.get(clip_id, {}) if _clips.has(clip_id) else {}
	_time = 0.0
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
	_time = seconds
	_boil = boil_frame % BOIL_VARIANTS
	_evaluate()
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
	_evaluate()
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
			if target == null or str(target[0].get("bone", "")) != bone or str(target[0].get("bendTo", "")) != str(p.get("bendTo", "")) or str(target[0].shape.get("type", "")) == "image":
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
						layers.append(_layer(poly, _flat(poly, Color(fill, fill.a * g[1]))))
			if ink > 0.0:
				var ink_c := Color(ink_color, ink_color.a * opacity)
				for poly in _clipped(Geo.grow(outline, ink), inside):
					layers.append(_layer(poly, _flat(poly, ink_c)))
			var shapes := _clipped(fills, inside)
			for poly in shapes:
				layers.append(_layer(poly, _shaded(poly, fill, shade, opacity)))
			# The texture: the same polygons again, over the fill, with texture coordinates (image px).
			if not texture.is_empty():
				var tint := Color(1, 1, 1, opacity * float(texture.opacity))
				for poly in shapes:
					var uv := PackedVector2Array()
					for q in poly:
						uv.append(texture.uv_origin + (q - texture.rect_origin) * texture.per_px)
					layers.append(_layer(poly, _flat(poly, tint), uv))
			part.variants.append(_with_weights(layers, part))
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
		layers.append(_layer(poly, _flat(poly, Color(1, 1, 1, opacity)), px))
	part.variants.append(_with_weights(layers, part))
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


func _layer(poly: PackedVector2Array, colors: PackedColorArray, uv := PackedVector2Array()) -> Array:
	return [poly, colors, PackedFloat32Array(), uv]


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
	if _turn_bone != "" and channels.has(_turn_bone):
		channels[_turn_bone][0] += rad_to_deg(_turn)
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
	posed.emit()


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
	for part in _parts:
		if _hidden.has(part.id):
			continue
		var texture: Texture2D = _image_for(part) if part.tex_file != "" else null
		if part.get("image", false) and texture == null:
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
			var uv: PackedVector2Array = layer[3]
			if uv.is_empty():
				draw_polygon(out, layer[1])
			elif texture != null:
				draw_polygon(out, layer[1], uv, texture)
			# else: a part texture that has not arrived yet (the flat fill shows meanwhile)


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
