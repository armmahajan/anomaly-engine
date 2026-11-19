extends Node2D
## Looks (core art/animation.ts Look) on one thing that is drawn: an enemy, the player, a prop, the
## character stage's rig. The host adds it as its first child and says what is drawn:
##   - `root`: the node holding the drawing (a rig, a box, an object view), moved into a CanvasGroup
##     while an aura shows or the opacity is below 1 (so overlapping parts don't show through);
##   - `paint`: the canvas item that draws it (often the same node): its `self_modulate` carries tint,
##     brightness and opacity (the host's own `modulate`, its hit flash or blink, is left alone, and
##     while the host says `flashing` the flash wins), its material the dissolve;
##   - `body`: a Callable giving the body's rectangle (host-local px), where emitters emit and
##     plain afterimages are drawn;
##   - `ghost_maker` (optional): a Callable making a copy of the drawing for afterimages (rigs: a rig
##     view of the same asset, posed like `paint` each time); without one, afterimages are rectangles.
## Scale: `scale_factor()`; the host multiplies the scale it gives its drawing by it, or with
## `own_scale` this view scales `root` itself.
##
## Two layers: the behavior state's look (set_state_look, fading 0.15 s) under the last setLook
## (set_look / clear_look, with its own fade and an optional time limit). A field the setLook doesn't
## set shows the state's. Dissolve (a noise threshold with a bright edge) is separate: `out` stays
## invisible until `in`. Everything is visual: nothing here touches gameplay.

const Particles := preload("res://scripts/art/particles.gd")
const STATE_FADE := 0.15

static var _body_shader: Shader = null
static var _group_shader: Shader = null

var root: Node2D = null
var paint: CanvasItem = null
var body := Callable()
var ghost_maker := Callable()
var own_scale := false
## The host's hit flash is showing: the look's tint and brightness step aside.
var flashing := false
## Colour of plain (rectangle) afterimages without their own colour.
var base_color := Color.WHITE
## Extra canvas items that dissolve with the drawing (e.g. a held weapon): their alpha follows it.
var extras: Array = []

## Layers, oldest first: {look, kind ("state" | "set"), weight, goal, rate (per s), left (s; < 0 = no limit), particles}.
var _layers: Array = []
var _time := 0.0
var _scale := 1.0
var _base_scale := Vector2.ONE
var _group: CanvasGroup = null
var _grouped := false
var _material: ShaderMaterial = null
var _dissolve := 0.0
var _dissolve_goal := 0.0
var _dissolve_rate := 2.5
var _dissolve_color := Color.WHITE
## Afterimages: their holder, [{node, transform, age, life, alpha}], spare copies, and the time to the next.
var _ghosts: Node2D = null
var _ghost_list: Array = []
var _ghost_spare: Array = []
var _ghost_timer := 0.0


func setup(root_node: Node2D, paint_item: CanvasItem, body_rect: Callable) -> void:
	root = root_node
	paint = paint_item
	body = body_rect
	_base_scale = root.scale if root != null else Vector2.ONE
	# Afterimages, the aura's group and particles are drawn behind the host's own drawing (its
	# attack boxes, a sword swing); particles go above the drawing by z.
	show_behind_parent = true
	_ghosts = Node2D.new()
	add_child(_ghosts)


# --- the layers ----------------------------------------------------------------------------

## setLook: put `look` on (fading in over `fade` s), replacing the last setLook (which fades out);
## `seconds` (null = no limit) later it fades out by itself.
func set_look(look: Dictionary, seconds: Variant = null, fade := 0.2) -> void:
	for layer in _layers:
		if layer.kind == "set":
			_leave(layer, fade)
	_add("set", look, fade, float(seconds) if seconds != null else -1.0)


## clearLook: the setLook fades out over `fade` s.
func clear_look(fade := 0.2) -> void:
	for layer in _layers:
		if layer.kind == "set":
			_leave(layer, fade)


## The behavior state's look ({} or null = none), faded in and out over STATE_FADE.
func set_state_look(look: Variant) -> void:
	for layer in _layers:
		if layer.kind == "state":
			_leave(layer, STATE_FADE)
	if typeof(look) == TYPE_DICTIONARY and not look.is_empty():
		_add("state", look, STATE_FADE, -1.0)


## dissolve: out (to invisible, until in) or in, over `seconds`, with a bright edge of `color`.
func dissolve(to: String, seconds := 0.4, color := Color.WHITE) -> void:
	_dissolve_goal = 1.0 if to == "out" else 0.0
	_dissolve_rate = 1.0 / maxf(seconds, 0.01)
	_dissolve_color = color
	_apply_dissolve()


## Leaving the room: every look and dissolve ends at once (a thing carried into the next room starts plain).
func reset() -> void:
	for layer in _layers:
		_leave(layer, 0.0)
	_layers = []
	_dissolve = 0.0
	_dissolve_goal = 0.0
	_apply_dissolve()
	for g in _ghost_list:
		g.node.visible = false
		_ghost_spare.append(g.node)
	_ghost_list = []
	_evaluate()


func _add(kind: String, look: Dictionary, fade: float, seconds: float) -> void:
	var layer := {"look": look, "kind": kind, "weight": 0.0 if fade > 0.0 else 1.0, "goal": 1.0, "rate": 1.0 / maxf(fade, 0.001), "left": seconds, "particles": null}
	if typeof(look.get("emitter")) == TYPE_DICTIONARY:
		var particles = Particles.new()
		particles.z_index = 1
		var rect: Rect2 = body.call() if body.is_valid() else Rect2(-8, -16, 16, 16)
		particles.position = rect.get_center()
		add_child(particles)
		particles.setup(look.emitter, rect.size * 0.8, -1.0)
		layer.particles = particles
	_layers.append(layer)
	_evaluate()


func _leave(layer: Dictionary, fade: float) -> void:
	if layer.goal == 0.0:
		return
	layer.goal = 0.0
	layer.rate = 1.0 / maxf(fade, 0.001)
	if fade <= 0.0:
		layer.weight = 0.0
	if layer.particles != null and is_instance_valid(layer.particles):
		layer.particles.stop()


func _process(delta: float) -> void:
	_time += delta
	var changed := false
	for layer in _layers:
		if layer.left > 0.0:
			layer.left -= delta
			if layer.left <= 0.0:
				_leave(layer, 1.0 / layer.rate)
		if layer.weight != layer.goal:
			layer.weight = move_toward(layer.weight, layer.goal, layer.rate * delta)
			changed = true
	var before := _layers.size()
	_layers = _layers.filter(func(layer): return layer.goal > 0.0 or layer.weight > 0.0)
	if changed or before != _layers.size() or not _layers.is_empty():
		_evaluate()
	if _dissolve != _dissolve_goal:
		_dissolve = move_toward(_dissolve, _dissolve_goal, _dissolve_rate * delta)
		_apply_dissolve()
	_update_ghosts(delta)


# --- showing it ------------------------------------------------------------------------------

## The look as shown now: each field blended from the layers (state under set) by their weights.
func _blend() -> Dictionary:
	var out := {"tint": Color.WHITE, "tintAmount": 0.0, "brightness": 1.0, "opacity": 1.0, "scale": 1.0,
		"aura": Color(1, 1, 1, 1), "auraSize": 0.0, "auraPulse": 0.0, "auraStrength": 0.0}
	var ordered := _layers.filter(func(l): return l.kind == "state") + _layers.filter(func(l): return l.kind == "set")
	for layer in ordered:
		var w: float = layer.weight
		var look: Dictionary = layer.look
		var tint = look.get("tint")
		if typeof(tint) == TYPE_DICTIONARY:
			var color := Color(str(tint.get("color", "#ffffff")))
			out.tint = color if out.tintAmount <= 0.0001 else out.tint.lerp(color, w)
			out.tintAmount = lerpf(out.tintAmount, clampf(float(tint.get("amount", 0.5)), 0.0, 1.0), w)
		for key in ["brightness", "opacity", "scale"]:
			if look.get(key) != null:
				out[key] = lerpf(out[key], float(look[key]), w)
		var aura = look.get("aura")
		if typeof(aura) == TYPE_DICTIONARY:
			var color := Color(str(aura.get("color", "#ffffff")))
			var fresh: bool = out.auraStrength <= 0.0001
			out.aura = color if fresh else out.aura.lerp(color, w)
			out.auraSize = lerpf(float(aura.get("size", 12)) if fresh else out.auraSize, float(aura.get("size", 12)), w)
			out.auraPulse = lerpf(float(aura.get("pulse", 0.3)) if fresh else out.auraPulse, float(aura.get("pulse", 0.3)), w)
			out.auraStrength = lerpf(out.auraStrength, 1.0, w)
	return out


func _evaluate() -> void:
	var b := _blend()
	_scale = clampf(b.scale, 0.25, 4.0)
	if own_scale and root != null:
		root.scale = _base_scale * _scale
	var aura_on: bool = b.auraStrength > 0.001
	var opacity: float = clampf(b.opacity, 0.0, 1.0)
	_set_grouped(aura_on or opacity < 0.999)
	if paint != null and is_instance_valid(paint):
		var rgb := Color.WHITE.lerp(b.tint, b.tintAmount) * maxf(b.brightness, 0.0)
		if flashing:
			rgb = Color.WHITE
		paint.self_modulate = Color(rgb.r, rgb.g, rgb.b, 1.0 if _grouped else opacity)
	if _grouped:
		var mat: ShaderMaterial = _group.material
		var pulse: float = 1.0 - b.auraPulse * 0.5 * (1.0 + sin(_time * TAU * 1.2))
		mat.set_shader_parameter("aura_color", b.aura)
		mat.set_shader_parameter("aura_strength", b.auraStrength * pulse if aura_on else 0.0)
		mat.set_shader_parameter("aura_px", b.auraSize * _screen_scale())
		mat.set_shader_parameter("opacity", opacity)
		_group.fit_margin = b.auraSize * 1.2 + 4.0
		_group.clear_margin = _group.fit_margin


## Screen px per room px here (the camera's zoom and the window's stretch).
func _screen_scale() -> float:
	return absf((get_viewport().get_final_transform() * get_global_transform_with_canvas()).get_scale().y)


## Move `root` into (or out of) the CanvasGroup that draws the aura and the group opacity.
func _set_grouped(on: bool) -> void:
	if on == _grouped or root == null or not is_instance_valid(root):
		return
	if on:
		if _group == null:
			_group = CanvasGroup.new()
			var mat := ShaderMaterial.new()
			mat.shader = _group_shader_code()
			_group.material = mat
			add_child(_group)
		_group.visible = true
		root.reparent(_group, false)
	else:
		var host := get_parent()
		root.reparent(host, false)
		host.move_child(root, get_index() + 1)
		_group.visible = false
	_grouped = on


func _apply_dissolve() -> void:
	if paint == null or not is_instance_valid(paint):
		return
	if _dissolve > 0.0 or _dissolve_goal > 0.0:
		if _material == null:
			_material = ShaderMaterial.new()
			_material.shader = _body_shader_code()
		paint.material = _material
		_material.set_shader_parameter("dissolve", _dissolve)
		_material.set_shader_parameter("edge_color", _dissolve_color)
	elif paint.material == _material and _material != null:
		paint.material = null
	for item in extras:
		if item != null and is_instance_valid(item):
			item.modulate.a = 1.0 - _dissolve


# --- afterimages ----------------------------------------------------------------------------

func _update_ghosts(delta: float) -> void:
	# The newest layer with afterimages (a setLook over the state's) says how they are made.
	var config = null
	var strength := 0.0
	for layer in _layers:
		if typeof(layer.look.get("afterimages")) == TYPE_DICTIONARY and layer.goal > 0.0:
			if config == null or layer.kind == "set" or strength == 0.0:
				config = layer.look.afterimages
				strength = layer.weight
	if config != null and root != null and is_instance_valid(root) and root.is_visible_in_tree() and _dissolve < 1.0:
		_ghost_timer -= delta
		if _ghost_timer <= 0.0:
			_ghost_timer = clampf(float(config.get("interval", 0.06)), 0.02, 1.0)
			_drop_ghost(config, strength)
	for g in _ghost_list:
		g.age += delta
		var node: Node2D = g.node
		node.global_transform = g.transform
		node.modulate.a = g.alpha * clampf(1.0 - g.age / g.life, 0.0, 1.0)
	var done := _ghost_list.filter(func(g): return g.age >= g.life)
	for g in done:
		g.node.visible = false
		_ghost_spare.append(g.node)
	_ghost_list = _ghost_list.filter(func(g): return g.age < g.life)


## Leave one afterimage where the drawing is now.
func _drop_ghost(config: Dictionary, strength: float) -> void:
	var count := clampi(int(config.get("count", 4)), 1, 8)
	var node: Node2D = null
	if not _ghost_spare.is_empty():
		node = _ghost_spare.pop_back()
	elif _ghost_list.size() + _ghost_spare.size() < count:
		node = _make_ghost()
	else:
		var oldest = _ghost_list.pop_front()
		node = oldest.node
	if node == null:
		return
	var colored = config.get("color")
	var mat: ShaderMaterial = node.material
	mat.set_shader_parameter("flat_amount", 0.85 if colored != null else 0.0)
	mat.set_shader_parameter("flat_color", Color(str(colored)) if colored != null else base_color)
	var source: CanvasItem = paint if paint != null and paint.has_method("pose_at") else null
	if source != null and node.has_method("pose_at"):
		node.play(source.current_clip(), true)
		node.pose_at(source.clip_time())
		node.self_modulate = paint.self_modulate
	var at: Node2D = source if source != null else root
	var xf: Transform2D = at.global_transform if at != null else global_transform
	node.visible = true
	_ghost_list.append({"node": node, "transform": xf, "age": 0.0, "life": clampf(float(config.get("fade", 0.3)), 0.05, 2.0), "alpha": 0.55 * strength})


func _make_ghost() -> Node2D:
	var node: Node2D = null
	if ghost_maker.is_valid():
		node = ghost_maker.call()
		if node != null and "manual_time" in node:
			node.manual_time = true
	if node == null:
		var rect: Rect2 = body.call() if body.is_valid() else Rect2(-8, -16, 16, 16)
		var box := RectGhost.new()
		box.rect = rect
		box.color = base_color
		node = box
	var mat := ShaderMaterial.new()
	mat.shader = _body_shader_code()
	node.material = mat
	_ghosts.add_child(node)
	return node


class RectGhost extends Node2D:
	var rect := Rect2()
	var color := Color.WHITE

	func _draw() -> void:
		draw_rect(rect, color)


# --- what the runtime reports ------------------------------------------------------------------

## Scale the host gives its drawing on top of its own (1 = none).
func scale_factor() -> float:
	return _scale


## The keys of the look shown now (both layers), sorted, or null with none (state entities[].look).
func keys() -> Variant:
	var out := {}
	for layer in _layers:
		if layer.goal > 0.0:
			for key in layer.look:
				if layer.look[key] != null:
					out[key] = true
	if out.is_empty():
		return null
	var list := out.keys()
	list.sort()
	return list


## Dissolved out (invisible until a dissolve in).
func dissolved() -> bool:
	return _dissolve_goal >= 1.0 and _dissolve >= 1.0


## Probes: everything it shows now.
func describe() -> Dictionary:
	var b := _blend()
	var mod: Color = paint.self_modulate if paint != null and is_instance_valid(paint) else Color.WHITE
	var group_mat: ShaderMaterial = _group.material if _group != null else null
	return {
		"keys": keys(), "layers": _layers.map(func(l): return "%s:%.2f" % [l.kind, l.weight]),
		"modulate": [mod.r, mod.g, mod.b, mod.a], "scale": _scale, "grouped": _grouped,
		"aura": float(group_mat.get_shader_parameter("aura_strength")) if _grouped else 0.0,
		"opacity": float(group_mat.get_shader_parameter("opacity")) if _grouped else mod.a,
		"auraColor": b.aura.to_html(false) if b.auraStrength > 0.0 else null,
		"ghosts": _ghost_list.size(),
		"emitters": _layers.filter(func(l): return l.particles != null and is_instance_valid(l.particles) and l.particles.emitting()).size(),
		"dissolve": _dissolve, "dissolved": dissolved(),
		"material": paint != null and is_instance_valid(paint) and paint.material != null,
	}


# --- shaders --------------------------------------------------------------------------------

## The drawing's material: a dissolve (noise threshold, bright edge; drawn-node local coordinates so
## it stays put as the thing moves) and, for afterimages, a flat colour.
static func _body_shader_code() -> Shader:
	if _body_shader == null:
		_body_shader = Shader.new()
		_body_shader.code = """
shader_type canvas_item;
uniform float dissolve = 0.0;
uniform vec4 edge_color : source_color = vec4(1.0);
uniform float flat_amount = 0.0;
uniform vec4 flat_color : source_color = vec4(1.0);
varying vec2 local;
void vertex() { local = VERTEX; }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void fragment() {
	vec4 c = COLOR;
	c.rgb = mix(c.rgb, flat_color.rgb, flat_amount);
	if (dissolve > 0.0) {
		float n = noise(local * 0.14) * 0.6 + noise(local * 0.45) * 0.4;
		float cut = dissolve * 1.2;
		if (n < cut - 0.2) { discard; }
		if (n < cut) { c.rgb = mix(c.rgb, edge_color.rgb * 1.6, 0.9); }
	}
	COLOR = c;
}
"""
	return _body_shader


## The CanvasGroup's: draws the group as it is (the built-in group shader) over a glow sampled
## around its silhouette, at a group opacity.
static func _group_shader_code() -> Shader:
	if _group_shader == null:
		_group_shader = Shader.new()
		_group_shader.code = """
shader_type canvas_item;
render_mode unshaded;
uniform sampler2D screen_texture : hint_screen_texture, repeat_disable, filter_linear;
uniform vec4 aura_color : source_color = vec4(1.0);
uniform float aura_px = 8.0;
uniform float aura_strength = 0.0;
uniform float opacity = 1.0;
void fragment() {
	vec4 c = textureLod(screen_texture, SCREEN_UV, 0.0);
	if (c.a > 0.0001) { c.rgb /= c.a; }
	float glow = 0.0;
	if (aura_strength > 0.001 && aura_px > 0.5) {
		float total = 0.0;
		for (int ring = 1; ring <= 3; ring++) {
			float r = aura_px * float(ring) / 3.0;
			float w = 1.0 - float(ring - 1) * 0.3;
			for (int k = 0; k < 12; k++) {
				float a = 6.2831853 * (float(k) + 0.5 * float(ring)) / 12.0;
				glow += textureLod(screen_texture, SCREEN_UV + vec2(cos(a), sin(a)) * r * SCREEN_PIXEL_SIZE, 0.0).a * w;
				total += w;
			}
		}
		glow = clamp(glow / total * 2.0, 0.0, 1.0);
	}
	float g = glow * aura_strength * aura_color.a * (1.0 - c.a);
	float a = c.a + g;
	vec3 rgb = a > 0.0001 ? (c.rgb * c.a + aura_color.rgb * g) / a : vec3(0.0);
	COLOR *= vec4(rgb, a * opacity);
}
"""
	return _group_shader
