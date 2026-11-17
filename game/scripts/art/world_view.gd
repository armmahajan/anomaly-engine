extends Node2D
## Draws a world scene (packages/core/src/art/world.ts) from a biome kit:
## painted background planes, parallax layers, textured ground, placed pieces
## tinted and softened by depth, 2D lights, fog between layers, light shafts,
## particles at several depths and a vignette. All the depth is built here, for
## free; the kit only supplies a few painted images.
##
## Parallax works on both axes. Background planes are drawn across the view
## (screen space): they stand on its bottom edge, scroll at their depth and sink
## as the camera climbs. Layers of placed pieces scroll at their factor (SCROLL);
## a piece is seen where it was placed when the camera looks at it (x: centred on
## it; y: as near as the camera gets). The front layer frames the view: it
## scrolls past horizontally and keeps to the view's top and bottom edges.

const LAYER_ORDER := ["far", "mid", "back", "play", "front"]
## How fast each layer scrolls relative to the camera (1 = with the world).
const SCROLL := {"far": 0.12, "mid": 0.38, "back": 0.72, "play": 1.0, "front": 1.35}
## How much each layer is tinted toward the fog color.
const FOG_TINT := {"far": 0.0, "mid": 0.5, "back": 0.35, "play": 0.0, "front": 0.0}
## Softness (image px) of placed pieces by layer: distant ones blur. (Front silhouettes stay unshaded: their
## color and fade are their modulate, which a canvas shader doesn't see on its own.)
const DEPTH_BLUR := {"far": 2.0, "mid": 1.2, "back": 0.0, "play": 0.0, "front": 0.0}
## A standing piece in the play layer sinks this share of its drawn height into its surface (px bounds).
const CONTACT_SINK := 0.05
const CONTACT_SINK_MIN := 4.0
const CONTACT_SINK_MAX := 12.0
## Fog never gets thicker than this per layer, whatever the scene asks (too much hides the backdrop).
const FOG_MAX := {"mid": 0.42, "back": 0.32, "play": 0.22}
## With layered planes (which carry their own haze and mist), less fog in front of them, so their depth shows.
const FOG_MAX_LAYERED := {"mid": 0.2, "back": 0.24, "play": 0.18}
## Far and mid layers live on their own canvas, untouched by the scene's darkness (they are distant and hazy).
const DISTANT := ["far", "mid"]
## A kit without planes: its one backdrop, drawn as before (sharp, the view's height, scrolling with the far layer).
const LEGACY_PLANE := {"name": "backdrop", "depth": 0.12, "span": 1.0, "opaque": true, "blur": 0.0, "haze": 0.0, "mist": 0.0}
## Particles at each depth: the layer, its share of the amount, size and opacity (front ones are big, soft and few).
const PARTICLE_DEPTHS := [
	{"layer": "mid", "share": 0.25, "size": 0.55, "alpha": 0.45},
	{"layer": "back", "share": 0.25, "size": 0.8, "alpha": 0.65},
	{"layer": "play", "share": 0.4, "size": 1.0, "alpha": 0.85},
	{"layer": "front", "share": 0.1, "size": 7.0, "alpha": 0.16},
]
## How each kind of particle moves and looks (sizes in room px at the play layer).
const PARTICLES := {
	"dust": {"direction": Vector2(0.3, -1), "spread": 60.0, "gravity": Vector2(0, -4), "speed": [4.0, 14.0], "size": [3.0, 6.0], "lifetime": 9.0, "add": true, "color": "#ffe2b0"},
	"embers": {"direction": Vector2(0.15, -1), "spread": 25.0, "gravity": Vector2(0, -16), "speed": [16.0, 42.0], "size": [3.0, 6.5], "lifetime": 6.0, "add": true, "color": "#ff9a4a"},
	"spores": {"direction": Vector2(0, -1), "spread": 180.0, "gravity": Vector2(0, -2), "speed": [3.0, 9.0], "size": [4.0, 8.0], "lifetime": 12.0, "add": true, "color": "#b8f0a0"},
	"snow": {"direction": Vector2(0.2, 1), "spread": 20.0, "gravity": Vector2(0, 6), "speed": [18.0, 36.0], "size": [4.0, 8.0], "lifetime": 10.0, "add": false, "color": "#f2f6ff"},
	"ash": {"direction": Vector2(0.25, 1), "spread": 35.0, "gravity": Vector2(0, 3), "speed": [8.0, 18.0], "size": [4.0, 9.0], "lifetime": 12.0, "add": false, "color": "#9a9590"},
}
const Terrain := preload("res://scripts/terrain.gd")

const FOG_SHADER := """
shader_type canvas_item;
uniform vec4 fog_color : source_color;
uniform float density = 0.4;
uniform float speed = 0.02;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
// 4 octaves, no domain warp: fog covers the whole screen several times over, so keep it cheap.
float fbm(vec2 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void fragment() {
	vec2 p = UV * vec2(6.0, 2.0) + vec2(TIME * speed, TIME * speed * 0.3);
	float n = fbm(p);
	float low = smoothstep(0.15, 1.0, UV.y);  // thicker near the ground
	COLOR = vec4(fog_color.rgb, clamp(density * (0.35 + 0.9 * n) * (0.45 + 0.75 * low), 0.0, 1.0));
}
"""

const RAY_SHADER := """
shader_type canvas_item;
render_mode blend_add;
uniform vec4 ray_color : source_color;
uniform float alpha = 0.3;
void fragment() {
	float edge = smoothstep(0.0, 0.35, UV.x) * smoothstep(1.0, 0.65, UV.x);
	float fall = mix(1.0, 0.0, UV.y);
	float flicker = 0.85 + 0.15 * sin(TIME * 0.7 + UV.x * 6.0);
	COLOR = vec4(ray_color.rgb, alpha * edge * fall * flicker);
}
"""

## A soft sample of the texture: `blur` image px wide (a ring of taps on a coarser mip), alpha-weighted.
const SOFT_SAMPLE := """
vec4 soft_sample(sampler2D tex, vec2 uv, vec2 texel, float radius) {
	if (radius < 0.05) {
		return texture(tex, uv);
	}
	float lod = log2(max(radius, 1.0));
	vec4 c = textureLod(tex, uv, lod);
	vec3 rgb = c.rgb * c.a * 0.2;
	float a = c.a * 0.2;
	for (int i = 0; i < 8; i++) {
		float t = float(i) * 0.785398 + 0.39;
		vec4 s = textureLod(tex, uv + vec2(cos(t), sin(t)) * texel * radius, lod);
		rgb += s.rgb * s.a * 0.1;
		a += s.a * 0.1;
	}
	return vec4(rgb / max(a, 0.0001), a);
}
"""

## Atmospheric perspective: soften a sprite, wash it toward the fog color and flatten its contrast.
## (Fragment COLOR already holds the texture times the modulate; `tint` is the modulate alone.
## Unblurred pieces keep the look they always had: texture x COLOR.)
const DEPTH_SHADER := """
shader_type canvas_item;
uniform vec4 fog_color : source_color;
uniform float amount = 0.5;
uniform float blur = 0.0;
varying vec4 tint;
%s
void vertex() { tint = COLOR; }
void fragment() {
	vec4 c;
	if (blur < 0.05) {
		c = texture(TEXTURE, UV) * COLOR;
	} else {
		vec4 s = soft_sample(TEXTURE, UV, TEXTURE_PIXEL_SIZE, blur);
		c = s * s * tint;  // as texture x COLOR (which holds the texture once more): the same tone, softened
	}
	float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
	vec3 muted = mix(c.rgb, vec3(luma), amount * 0.6);
	COLOR = vec4(mix(muted, fog_color.rgb, amount), c.a);
}
""" % SOFT_SAMPLE

## A background plane: softened by `blur`, hazed toward the fog, with mist thickening toward its base.
const PLANE_SHADER := """
shader_type canvas_item;
uniform vec4 fog_color : source_color;
uniform float haze = 0.0;
uniform float mist = 0.0;
uniform float blur = 0.0;
varying vec4 tint;
%s
void vertex() { tint = COLOR; }
void fragment() {
	vec4 c = soft_sample(TEXTURE, UV, TEXTURE_PIXEL_SIZE, blur) * tint;
	float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
	vec3 muted = mix(c.rgb, vec3(luma), haze * 0.5);
	float fog = clamp(haze + mist * smoothstep(0.4, 1.0, UV.y), 0.0, 1.0);
	COLOR = vec4(mix(muted, fog_color.rgb, fog), c.a);
}
""" % SOFT_SAMPLE

const VIGNETTE_SHADER := """
shader_type canvas_item;
uniform vec4 tint : source_color;
void fragment() {
	vec2 d = UV - 0.5;
	float v = smoothstep(0.35, 0.85, length(d * vec2(1.15, 1.0)));
	COLOR = vec4(tint.rgb, v * 0.75);
}
"""

## Centre of the view the layers are parallaxed against (set by the owner each frame).
var focus := Vector2.ZERO
## Height (room px) of the view the room is played in; 0 = the room's own height (the whole room
## fits, as in the Worlds stage and renders). Pieces line up for this view.
var view_height := 0.0
## Draw only the far planes beyond the room's edges, fogged (rooms in the game): everything placed
## is clipped to the room, so a room smaller than the view sits in its own distance.
var frame_room := false
## Draw the vignette (off when dressing the arena, so the HUD stays clean).
var vignette := true
## Write each placement's id on it (renders for the AI reviewer, which names pieces to fix).
var labels := false
var warnings: Array[String] = []

var _scene: Dictionary = {}
var _textures: Dictionary = {}
var _layers := {}
var _pieces := {}
var _ambient := Color.WHITE
var _distant_canvas: CanvasLayer = null
var _plane_canvas: CanvasLayer = null
var _ambient_node: CanvasModulate = null
var _width := 2400.0
var _height := 720.0
## Background planes: {sprite, plane}.
var _planes: Array = []
## Editing support: placed sprites (meta "placement", "layer"), fog rects, lights and halos.
var _sprites: Array[Sprite2D] = []
var _fogs: Array[CanvasItem] = []
var _glows: Array[Node] = []
## Particle emitters by depth (meta "layer").
var _particles: Array[CPUParticles2D] = []
## The scene's own lights (play layer): {at: Vector2, nodes: [light, halo]}.
var _scene_lights: Array = []
var _explode := {}  # layer -> vertical offset while exploded
var _alpha_cache := {}  # texture rid -> Image
var _highlight: Line2D = null
var _terrain: Node2D = null


## base64 images (PNG/JPEG/WebP) -> textures, keyed the same way.
static func textures_from(images: Variant) -> Dictionary:
	var out := {}
	if typeof(images) != TYPE_DICTIONARY:
		return out
	for key in images:
		var bytes := Marshalls.base64_to_raw(str(images[key]))
		var image := Image.new()
		var ok := image.load_png_from_buffer(bytes)
		if ok != OK:
			ok = image.load_webp_from_buffer(bytes)
		if ok != OK:
			ok = image.load_jpg_from_buffer(bytes)
		if ok == OK:
			if image.detect_alpha() != Image.ALPHA_NONE:
				image.fix_alpha_edges()  # transparent pixels take their neighbours' color: no dark fringes when softened or shrunk
			image.generate_mipmaps()
			out[str(key)] = ImageTexture.create_from_image(image)
	return out


## Zoom that fits the room's height into the view.
static func fit_zoom(scene: Dictionary, view: Vector2) -> float:
	return view.y / float(scene.get("height", 720))


## Point `camera` at room x (clamped to the room) and parallax `world` against it.
static func aim(camera: Camera2D, world: Node2D, scene: Dictionary, view: Vector2, x: float) -> void:
	var zoom := fit_zoom(scene, view)
	var half := view.x / zoom / 2.0
	var cx := clampf(x, half, maxf(half, float(scene.get("width", 2400)) - half))
	camera.zoom = Vector2(zoom, zoom)
	camera.position = Vector2(cx, float(scene.get("height", 720)) / 2.0)
	camera.force_update_scroll()
	world.focus = camera.position
	world._update_layers()


## `textures`: FileRef -> Texture2D. `view_size`: the most of the room's surroundings any view shows (room px).
func build(scene: Dictionary, textures: Dictionary, view_size: Vector2) -> void:
	_scene = scene
	_textures = textures
	for p in scene.get("pieces", []):
		_pieces[p.id] = p
	var palette: Dictionary = scene.get("palette", {})
	var fog := Color(str(palette.get("fog", "#33465a")))
	_width = float(scene.get("width", 2400))
	_height = float(scene.get("height", 720))
	var width := _width
	var height := _height
	if focus == Vector2.ZERO:
		focus = Vector2(width, height) / 2.0

	_ambient = Color(str(palette.get("ambient", "#8090a0")))
	var ambient := CanvasModulate.new()
	ambient.color = _ambient
	add_child(ambient)
	_ambient_node = ambient
	_plane_canvas = CanvasLayer.new()
	_plane_canvas.name = "Planes"
	_plane_canvas.layer = -2
	add_child(_plane_canvas)
	_distant_canvas = CanvasLayer.new()
	_distant_canvas.layer = -1
	_distant_canvas.follow_viewport_enabled = true
	add_child(_distant_canvas)
	if frame_room:
		_add_outside(fog)

	# Art is drawn smaller than its source (a 1024 px backdrop fills a ~450 px room): sample the
	# mipmaps, or it aliases into jagged, shimmering pixels.
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	for layer in LAYER_ORDER:
		var node := Node2D.new()
		node.name = layer
		node.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS  # distant layers sit under a CanvasLayer: no inheritance
		var parent: Node = _distant_canvas if layer in DISTANT else self
		if frame_room:
			parent = _room_frame(parent, layer)
		parent.add_child(node)
		_layers[layer] = node
		if layer != "far" and layer != "front":
			var cap: float = (FOG_MAX_LAYERED if typeof(scene.get("backgrounds")) == TYPE_ARRAY and not scene.backgrounds.is_empty() else FOG_MAX)[layer]
			_add_fog(node, layer, fog, minf(float(scene.get("fog", {}).get(layer, 0.3)), cap), width, height, view_size)

	_build_planes(fog)
	_build_ground(palette)
	for placement in scene.get("placements", []):
		_place(placement, fog, palette)
	for light in scene.get("lights", []):
		_add_light(light)
	for ray in scene.get("rays", []):
		_add_ray(ray, Color(str(palette.get("light", "#ffd9a0"))), height)
	_add_particles(scene.get("dust", {}), view_size)
	if vignette:
		_add_vignette(Color(str(palette.get("shadow", "#05070a"))))
	# Characters (z 0) walk between the room's layers: back and play behind them, front in front.
	_layers["back"].z_index = -20
	_layers["play"].z_index = -10
	_layers["front"].z_index = 20
	_update_layers()


func _process(_delta: float) -> void:
	_update_layers()


func _update_layers() -> void:
	for layer in _layers:
		var f: float = SCROLL[layer]
		var node: Node2D = _layers[layer]
		node.position.x = focus.x * (1.0 - f)
		# The front layer keeps to the view vertically; the others scroll at their factor.
		node.position.y = (focus.y if layer == "front" else focus.y * (1.0 - f)) + _explode.get(layer, 0.0)
	_update_planes()


## Height (room px) of the view the pieces line up for.
func _view_h() -> float:
	return view_height if view_height > 0.0 else _height


## Where the camera's centre can be, top to bottom (one point when the room is no taller than the view).
func _camera_range() -> Vector2:
	var half := _view_h() / 2.0
	if _height <= half * 2.0:
		return Vector2(_height / 2.0, _height / 2.0)
	return Vector2(half, _height - half)


## Local y offset in `layer` for something placed at room y around `at_y`: it shows at its room y
## when the camera's centre is as near `at_y` as it gets (layers scroll by focus.y * (1 - f)).
func _align_y(layer: String, at_y: float) -> float:
	var reach := _camera_range()
	return -clampf(at_y, reach.x, reach.y) * (1.0 - SCROLL[layer])


# --- background planes -------------------------------------------------------------------

## The kit's planes (back to front), or its one backdrop drawn as before.
func _build_planes(fog: Color) -> void:
	var planes = _scene.get("backgrounds")
	if typeof(planes) != TYPE_ARRAY or planes.is_empty():
		var legacy := LEGACY_PLANE.duplicate()
		legacy.file = _scene.get("backdrop")
		planes = [legacy]
	for plane in planes:
		var tex := _texture(plane.get("file"))
		if tex == null:
			continue
		var sprite := Sprite2D.new()
		sprite.name = "Plane_%s" % plane.get("name", "")
		sprite.texture = tex
		sprite.centered = false
		sprite.region_enabled = true
		sprite.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
		var blur := float(plane.get("blur", 0.0))
		var haze := float(plane.get("haze", 0.0))
		var mist := float(plane.get("mist", 0.0))
		if blur > 0.0 or haze > 0.0 or mist > 0.0:
			var mat := ShaderMaterial.new()
			var shader := Shader.new()
			shader.code = PLANE_SHADER
			mat.shader = shader
			mat.set_shader_parameter("fog_color", fog.lightened(0.12))
			mat.set_shader_parameter("haze", haze)
			mat.set_shader_parameter("mist", mist)
			mat.set_shader_parameter("blur", blur)
			sprite.material = mat
		_plane_canvas.add_child(sprite)
		_planes.append({"sprite": sprite, "plane": plane})


## Lay the planes across the view: each `span` of the view's height, standing on its bottom edge,
## scrolled by depth x the camera's movement on both axes (an opaque plane stops sinking once
## its top reaches the view's top). Screen space, so a plane's size never depends on the room.
func _update_planes() -> void:
	if _planes.is_empty() or not is_inside_tree():
		return
	var viewport := get_viewport()
	var screen := viewport.get_visible_rect().size
	var zoom := viewport.get_canvas_transform().get_scale().x
	if zoom <= 0.0:
		return
	# The lowest the play camera goes; the planes stand on the view's bottom edge there.
	var bottom := maxf(_height - screen.y / zoom / 2.0, _height / 2.0)
	for entry in _planes:
		var sprite: Sprite2D = entry.sprite
		var plane: Dictionary = entry.plane
		var depth := float(plane.get("depth", 0.1))
		var tex_h := float(sprite.texture.get_height())
		var drawn := float(plane.get("span", 1.0)) * screen.y
		var s := drawn / tex_h
		var sink := maxf(0.0, depth * (bottom - focus.y) * zoom)
		if bool(plane.get("opaque", false)):
			sink = minf(sink, maxf(0.0, drawn - screen.y))
		sprite.scale = Vector2(s, s)
		sprite.region_rect = Rect2(depth * focus.x * zoom / s, 0.0, screen.x / s + 2.0, tex_h)
		sprite.position = Vector2(0.0, screen.y + sink - drawn + _explode.get("far", 0.0))


## Physical screen px per image px of each plane on a window `window` physical px tall (for checks).
func plane_scales(window_height: float) -> Dictionary:
	var out := {}
	var screen := get_viewport().get_visible_rect().size
	for entry in _planes:
		var sprite: Sprite2D = entry.sprite
		out[str(entry.plane.get("name", ""))] = sprite.scale.y * window_height / screen.y
	return out


## Planes, particles and layer offsets as drawn now (headless checks; see game/test/depth.test.ts).
func describe() -> Dictionary:
	var planes := []
	for entry in _planes:
		var sprite: Sprite2D = entry.sprite
		planes.append({"name": str(entry.plane.get("name", "")), "x": sprite.region_rect.position.x * sprite.scale.x, "y": sprite.position.y, "height": sprite.texture.get_height() * sprite.scale.y, "blurred": sprite.material != null and float(entry.plane.get("blur", 0.0)) > 0.0})
	var layers := {}
	for layer in _layers:
		layers[layer] = {"x": _layers[layer].position.x, "y": _layers[layer].position.y}
	var particles := []
	for p in _particles:
		particles.append({"layer": str(p.get_meta("layer")), "amount": p.amount, "front": p.get_parent() != null and p.is_visible_in_tree()})
	return {"planes": planes, "layers": layers, "particles": particles, "screen": [get_viewport().get_visible_rect().size.x, get_viewport().get_visible_rect().size.y]}


# --- framing ------------------------------------------------------------------------------

## A container clipping `layer` to the room's rectangle (room coordinates: its canvas follows the camera).
func _room_frame(parent: Node, layer: String) -> Control:
	var clip := Control.new()
	clip.name = "Frame_%s" % layer
	clip.clip_contents = true
	clip.mouse_filter = Control.MOUSE_FILTER_IGNORE
	clip.size = Vector2(_width, _height)
	parent.add_child(clip)
	return clip


## Fog over the planes everywhere outside the room.
func _add_outside(fog: Color) -> void:
	var outside := Node2D.new()
	outside.name = "Outside"
	_distant_canvas.add_child(outside)
	var m := 100000.0
	var color := Color(fog.darkened(0.45), 0.7)
	for r in [Rect2(-m, -m, _width + 2.0 * m, m), Rect2(-m, _height, _width + 2.0 * m, m), Rect2(-m, 0, m, _height), Rect2(_width, 0, m, _height)]:
		var rect := ColorRect.new()
		rect.position = r.position
		rect.size = r.size
		rect.color = color
		rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
		outside.add_child(rect)


# --- editing (Worlds mode) -----------------------------------------------------------

## Show/hide layers, fog and lighting, and tilt the layers apart to show the depth.
func set_options(hidden: Array, fog: bool, lights: bool, exploded: bool) -> void:
	for layer in _layers:
		_layers[layer].visible = not hidden.has(layer)
	for entry in _planes:
		entry.sprite.visible = not hidden.has("far")
	for f in _fogs:
		f.visible = fog
	for g in _glows:
		if g is PointLight2D:
			g.enabled = lights
		else:
			g.visible = lights
	_ambient_node.visible = lights
	_explode.clear()
	for i in LAYER_ORDER.size():
		var layer: String = LAYER_ORDER[i]
		var node: Node2D = _layers[layer]
		if exploded:
			# Back layers rise and lean away: a staircase that shows how the room is stacked.
			_explode[layer] = (i - 3) * 95.0
			node.skew = deg_to_rad(-14.0) if layer != "play" else 0.0
			node.modulate = Color(1, 1, 1, 0.92)
		else:
			node.skew = 0.0
			node.modulate = Color.WHITE
	_update_layers()


## Show or hide everything, including the parts on their own canvas layers (which ignore the
## parent's visibility) and the scene-wide darkness tint.
func set_shown(shown: bool) -> void:
	visible = shown
	if _distant_canvas != null:
		_distant_canvas.visible = shown
	if _ambient_node != null:
		_ambient_node.visible = shown
	for child in get_children():
		if child is CanvasLayer:
			child.visible = shown


## Foreground silhouettes fade while `point` (the player, global coordinates) is behind them,
## so they frame the view without hiding the player.
func fade_front_around(point: Vector2, delta: float) -> void:
	for sprite in _sprites:
		if sprite.get_meta("layer") != "front":
			continue
		var covers := sprite.get_rect().grow(12.0).has_point(sprite.to_local(point))
		sprite.modulate.a = move_toward(sprite.modulate.a, 0.3 if covers else 1.0, delta * 3.0)


## The placement under a point (global/world coordinates), front-most first; "" if none.
func pick(at: Vector2) -> String:
	for layer in ["front", "play", "back", "mid"]:
		if not _layers[layer].visible:
			continue
		for i in range(_sprites.size() - 1, -1, -1):
			var sprite := _sprites[i]
			if sprite.get_meta("layer") != layer:
				continue
			var local := sprite.to_local(at)
			var rect := sprite.get_rect()
			if not rect.has_point(local):
				continue
			if _opaque_at(sprite.texture, local - rect.position):
				return str(sprite.get_meta("placement"))
	return ""


func sprite_for(placement_id: String) -> Sprite2D:
	for sprite in _sprites:
		if str(sprite.get_meta("placement")) == placement_id:
			return sprite
	return null


## Room position a placed sprite stands for (x as seen when the camera is there; y = its anchor).
func room_position(sprite: Sprite2D) -> Vector2:
	var f: float = SCROLL[str(sprite.get_meta("layer"))]
	return Vector2(sprite.position.x / f, sprite.position.y - float(sprite.get_meta("align_y", 0.0)))


## Lights set on a platform this far (px) above its top belong to what stands there.
const LIGHT_ABOVE := 120.0

## A breakable platform was smashed: standing play pieces resting on its top go with it, and so
## do their glows and any scene light set on the platform for them.
func remove_resting_on(rect: Rect2) -> void:
	var gone := func(nodes: Array) -> void:
		for node in nodes:
			_glows.erase(node)
			node.queue_free()
	for light in _scene_lights.duplicate():
		var at: Vector2 = light.at
		if at.x >= rect.position.x and at.x <= rect.end.x and at.y <= rect.position.y and at.y >= rect.position.y - LIGHT_ABOVE:
			gone.call(light.nodes)
			_scene_lights.erase(light)
	for sprite in _sprites.duplicate():
		if str(sprite.get_meta("layer")) != "play" or sprite.offset.y == 0.0:
			continue  # other layers, and hanging pieces (anchored at their top)
		var at := room_position(sprite)
		if absf(at.y - rect.position.y) > 2.0 or at.x < rect.position.x or at.x > rect.end.x:
			continue
		gone.call(sprite.get_meta("glow", []))
		_sprites.erase(sprite)
		sprite.queue_free()


func layer_node(layer: String) -> Node2D:
	return _layers[layer]


func select(placement_id: String) -> void:
	if _highlight != null:
		_highlight.queue_free()
		_highlight = null
	var sprite := sprite_for(placement_id)
	if sprite == null:
		return
	var r := sprite.get_rect().grow(4.0)
	_highlight = Line2D.new()
	_highlight.points = PackedVector2Array([r.position, Vector2(r.end.x, r.position.y), r.end, Vector2(r.position.x, r.end.y), r.position])
	_highlight.width = 3.0 / maxf(absf(sprite.scale.y), 0.05)
	_highlight.default_color = _emissive(Color("#7aa2f7"), str(sprite.get_meta("layer")))
	var mat := CanvasItemMaterial.new()
	mat.light_mode = CanvasItemMaterial.LIGHT_MODE_UNSHADED
	_highlight.material = mat
	sprite.add_child(_highlight)


func _opaque_at(texture: Texture2D, pixel: Vector2) -> bool:
	var key := texture.get_rid()
	var image: Image = _alpha_cache.get(key)
	if image == null:
		image = texture.get_image()
		if image == null:
			return true
		image.decompress()
		_alpha_cache[key] = image
	var p := Vector2i(clampi(int(pixel.x), 0, image.get_width() - 1), clampi(int(pixel.y), 0, image.get_height() - 1))
	return image.get_pixelv(p).a > 0.15


## Room x -> a layer's local x, so a piece "seen at x" is centred when the camera is at x.
func _local_x(layer: String, x: float) -> float:
	return x * SCROLL[layer]


func _texture(ref) -> Texture2D:
	var t = _textures.get(str(ref))
	if t == null:
		warnings.append("missing image %s" % ref)
	return t


## The scene's tiles as one terrain in the ground texture (breakables cracked, hazards spiked).
## Scenes without tiles fall back to drawing each platform rectangle.
func _build_ground(palette: Dictionary) -> void:
	var tex := _texture(_scene.get("ground"))
	var rim := Color(str(palette.get("fog", "#33465a"))).lightened(0.35)
	var tiles = _scene.get("terrain")
	if typeof(tiles) == TYPE_DICTIONARY and typeof(tiles.get("grid")) == TYPE_DICTIONARY:
		_terrain = Terrain.new()
		_terrain.name = "Terrain"
		_layers["play"].add_child(_terrain)
		var lit := _emissive(rim, "play")
		_terrain.build(tiles.grid.get("rows", []), int(tiles.get("ledgeThickness", 20)), {
			"texture": tex,
			"color": Color(0.62, 0.62, 0.66),  # solid ground sits in shadow; the lit rim carries it
			"shade": 0.55,
			"rim": Color(lit, 0.75),
			"edge": Color(lit, 0.22),
			"under": 0.5,
			"breakable": Color(0.95, 0.78, 0.55),
			"glaze": Color(_emissive(Color(1.0, 0.85, 0.6), "play"), 0.2),
			"crack": Color(0.05, 0.03, 0.02, 0.95),
			"hazard": Color(0.8, 0.32, 0.28),
			"spike": _emissive(Color("#d8c8b4"), "play"),
			"oneway": Color(0.85, 0.85, 0.9),
		})
		return
	for rect in _scene.get("platforms", []):
		var r := Rect2(rect.x, rect.y, rect.width, rect.height)
		if tex != null:
			var sprite := Sprite2D.new()
			sprite.texture = tex
			sprite.centered = false
			sprite.texture_repeat = CanvasItem.TEXTURE_REPEAT_ENABLED
			sprite.region_enabled = true
			var s := 220.0 / tex.get_width()  # one texture tile = 220 world px
			sprite.scale = Vector2(s, s)
			sprite.region_rect = Rect2(Vector2.ZERO, r.size / s)
			sprite.position = r.position
			sprite.modulate = Color(0.62, 0.62, 0.66)  # solid ground sits in shadow; the lit rim carries it
			_layers["play"].add_child(sprite)
		# Shade toward the bottom, and a lit rim on top.
		var shade := TextureRect.new()
		var gradient := Gradient.new()
		gradient.set_color(0, Color(0, 0, 0, 0.0))
		gradient.set_color(0, Color(0, 0, 0, 0.25))
		gradient.set_color(1, Color(0, 0, 0, 0.85))
		var gt := GradientTexture2D.new()
		gt.gradient = gradient
		gt.fill_from = Vector2(0, 0)
		gt.fill_to = Vector2(0, 1)
		shade.texture = gt
		shade.position = r.position
		shade.size = r.size
		shade.stretch_mode = TextureRect.STRETCH_SCALE
		_layers["play"].add_child(shade)
		var edge := ColorRect.new()
		edge.color = Color(_emissive(rim, "play"), 0.5)
		edge.position = r.position
		edge.size = Vector2(r.size.x, 4)
		_layers["play"].add_child(edge)


## A smashed area (world px) leaves the terrain.
func clear_terrain(rect: Rect2) -> void:
	if _terrain != null:
		_terrain.clear_rect(rect)


func _place(placement: Dictionary, fog: Color, palette: Dictionary) -> void:
	var piece = _pieces.get(placement.get("piece"))
	var layer := str(placement.get("layer", "back"))
	if piece == null or not _layers.has(layer):
		warnings.append("skipped placement of %s" % placement.get("piece"))
		return
	var tex := _texture(piece.file)
	if tex == null:
		return
	var sprite := Sprite2D.new()
	sprite.texture = tex
	var s := float(piece.size) / float(piece.height) * float(placement.get("scale", 1.0))
	sprite.scale = Vector2(-s if bool(placement.get("flip", false)) else s, s)
	var hanging := str(piece.kind) == "hanging"
	# Anchor: bottom-centre (top-centre for hanging pieces).
	sprite.centered = false
	sprite.offset = Vector2(-tex.get_width() / 2.0, 0.0 if hanging else -tex.get_height())
	var y := float(placement.y)
	var top_edge := hanging  # front pieces: framing the view's top edge (else its bottom edge)
	if layer == "front":
		# Foreground silhouettes frame the view: they hang from the top or rise from below the bottom edge, never float.
		if hanging:
			y = minf(y, 0.0)
		elif str(piece.kind) == "span":
			top_edge = true  # set below, once its scale is capped: a beam overhead, across the top edge
		else:
			y = maxf(y, _height + 40.0)
		s = minf(s, minf(_height, _view_h()) * 0.42 / float(piece.height))
		sprite.scale = Vector2(-s if bool(placement.get("flip", false)) else s, s)
		if str(piece.kind) == "span":
			y = minf(y, tex.get_height() * s)
	if layer == "play" and not hanging and str(piece.kind) != "span":
		# Painted bases taper or fade at the bottom, and the ground draws a lit rim on its top:
		# sink a standing piece a little into the surface it rests on so it sits, not floats.
		y += clampf(tex.get_height() * s * CONTACT_SINK, CONTACT_SINK_MIN, CONTACT_SINK_MAX)
	var drawn := tex.get_height() * s
	var align := 0.0
	if layer == "front":
		# Kept to the view's top or bottom edge, wherever the camera is (the layer follows the view's centre).
		align = -_view_h() / 2.0 if top_edge else -_height + _view_h() / 2.0
	else:
		align = _align_y(layer, y + drawn / 2.0 if hanging else y - drawn / 2.0)
	sprite.position = Vector2(_local_x(layer, float(placement.x)), y + align)
	sprite.set_meta("placement", str(placement.get("id", "")))
	sprite.set_meta("layer", layer)
	sprite.set_meta("align_y", align)
	_sprites.append(sprite)
	if layer == "front":
		sprite.modulate = Color(str(palette.get("shadow", "#05070a")))
	var tint: float = FOG_TINT[layer]
	var blur: float = DEPTH_BLUR[layer]
	if tint > 0.0 or blur > 0.0:
		var mat := ShaderMaterial.new()
		var shader := Shader.new()
		shader.code = DEPTH_SHADER
		mat.shader = shader
		mat.set_shader_parameter("fog_color", _emissive(fog.lightened(0.18), layer))
		mat.set_shader_parameter("amount", tint)
		mat.set_shader_parameter("blur", blur)
		sprite.material = mat
	_layers[layer].add_child(sprite)
	if labels:
		_add_label(sprite, str(placement.get("id", "")), hanging, layer)
	# Pieces that glow get a light, unless the scene placed one nearby.
	if (str(piece.kind) == "light" or piece.has("glow")) and layer != "front":
		var center := sprite.position + Vector2(0, (tex.get_height() * s * 0.5) if hanging else -tex.get_height() * s * 0.6)
		var glow := _add_light_at(_layers[layer], center, Color(str(piece.get("glow", palette.get("light", "#ffcc80")))), 0.9, maxf(140.0, piece.size * s * 2.6))
		sprite.set_meta("glow", glow)


## The placement id over the middle of its piece (kept inside the frame for edge silhouettes).
func _add_label(sprite: Sprite2D, text: String, hanging: bool, layer: String) -> void:
	if text == "":
		return
	var shown := sprite.texture.get_height() * absf(sprite.scale.y)
	var align := float(sprite.get_meta("align_y", 0.0))
	var y := sprite.position.y - align + (shown / 2.0 if hanging else -shown / 2.0)
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 20)
	label.add_theme_color_override("font_color", Color(1.0, 0.93, 0.35))
	label.add_theme_color_override("font_outline_color", Color.BLACK)
	label.add_theme_constant_override("outline_size", 6)
	label.position = Vector2(sprite.position.x - 22.0, clampf(y - 12.0, 8.0, _height - 36.0) + align)
	label.z_index = 100
	_layers[layer].add_child(label)


func _add_light(light: Dictionary) -> void:
	var at := Vector2(light.x, light.y)
	var nodes := _add_light_at(_layers["play"], at, Color(str(light.color)), float(light.get("energy", 1.0)), float(light.get("radius", 220)))
	_scene_lights.append({"at": at, "nodes": nodes})


func _add_light_at(parent: Node2D, at: Vector2, color: Color, energy: float, radius: float) -> Array:
	var tex := _radial_texture()
	var light := PointLight2D.new()
	light.texture = tex
	light.color = color
	light.energy = energy
	light.texture_scale = radius / 128.0
	light.position = at
	parent.add_child(light)
	_glows.append(light)
	# A soft visible halo too (lights only brighten what they touch).
	var halo := Sprite2D.new()
	halo.texture = tex
	halo.modulate = Color(_emissive(color, "play"), 0.4 * energy)
	halo.scale = Vector2.ONE * radius / 256.0
	halo.position = at
	var mat := CanvasItemMaterial.new()
	mat.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	mat.light_mode = CanvasItemMaterial.LIGHT_MODE_UNSHADED
	halo.material = mat
	parent.add_child(halo)
	_glows.append(halo)
	return [light, halo]


var _radial: GradientTexture2D = null


func _radial_texture() -> GradientTexture2D:
	if _radial == null:
		var g := Gradient.new()
		g.set_color(0, Color(1, 1, 1, 1))
		g.set_color(1, Color(1, 1, 1, 0))
		g.add_point(0.35, Color(1, 1, 1, 0.45))
		_radial = GradientTexture2D.new()
		_radial.gradient = g
		_radial.fill = GradientTexture2D.FILL_RADIAL
		_radial.fill_from = Vector2(0.5, 0.5)
		_radial.fill_to = Vector2(1.0, 0.5)
		_radial.width = 256
		_radial.height = 256
	return _radial


func _add_fog(parent: Node2D, layer: String, fog: Color, density: float, width: float, height: float, view_size: Vector2) -> void:
	if density <= 0.0:
		return
	var rect := ColorRect.new()
	var mat := ShaderMaterial.new()
	var shader := Shader.new()
	shader.code = FOG_SHADER
	mat.shader = shader
	mat.set_shader_parameter("fog_color", _emissive(fog.lightened(0.12), layer))
	mat.set_shader_parameter("density", density)
	mat.set_shader_parameter("speed", 0.015 + 0.02 * SCROLL[layer])
	rect.material = mat
	rect.position = Vector2(-view_size.x, _align_y(layer, height / 2.0))
	rect.size = Vector2(view_size.x * 2.0 + width, height)
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(rect)
	# Fog is drawn first in its layer, i.e. between this layer and the one behind it.
	parent.move_child(rect, 0)
	_fogs.append(rect)


func _add_ray(ray: Dictionary, color: Color, height: float) -> void:
	var rect := ColorRect.new()
	var mat := ShaderMaterial.new()
	var shader := Shader.new()
	shader.code = RAY_SHADER
	mat.shader = shader
	mat.set_shader_parameter("ray_color", color)
	mat.set_shader_parameter("alpha", float(ray.get("alpha", 0.3)))
	rect.material = mat
	var w := float(ray.get("width", 200))
	rect.size = Vector2(w, height * 1.1)
	rect.pivot_offset = Vector2(w / 2.0, 0)
	rect.position = Vector2(_local_x("mid", float(ray.x)) - w / 2.0 + CLIP_REACH, 0)
	rect.rotation = deg_to_rad(float(ray.get("angle", 15)))
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_room_clip("mid", height).add_child(rect)
	_glows.append(rect)


## The scene's air: particles of the biome's kind (atmosphere.particles) at several depths,
## from faint specks far off to a few big, soft ones drifting in front of the play layer.
## `dust` (the room's) sets how many and their color.
func _add_particles(dust: Dictionary, view_size: Vector2) -> void:
	var kind := str(_scene.get("atmosphere", {}).get("particles", "dust")) if typeof(_scene.get("atmosphere")) == TYPE_DICTIONARY else "dust"
	var look: Dictionary = PARTICLES.get(kind, {})
	var amount := int(dust.get("amount", 80))
	if look.is_empty() or amount <= 0:
		return
	var color := Color(str(dust.get("color", look.color)))
	var view_h := _view_h()
	var view_w := maxf(view_size.x, view_h * 2.4)  # wide enough for any window shape
	var reach := _camera_range()
	for depth in PARTICLE_DEPTHS:
		var layer: String = depth.layer
		var f: float = SCROLL[layer]
		var count := clampi(roundi(amount * float(depth.share)), 0, 400)
		if layer == "front":
			count = clampi(count, 3, 24)
		if count <= 0:
			continue
		var p := CPUParticles2D.new()
		p.name = "Particles_%s" % layer
		p.amount = count
		p.lifetime = float(look.lifetime)
		p.preprocess = float(look.lifetime)
		p.texture = _radial_texture()
		p.emission_shape = CPUParticles2D.EMISSION_SHAPE_RECTANGLE
		# Cover every place the camera can show in this layer: x scrolls by f, y by f (front: the view).
		var x0 := -view_w / 2.0
		var x1 := _width * f + view_w / 2.0
		var y0 := -view_h / 2.0 if layer == "front" else reach.x * f - view_h / 2.0
		var y1 := view_h / 2.0 if layer == "front" else reach.y * f + view_h / 2.0
		p.emission_rect_extents = Vector2((x1 - x0) / 2.0, (y1 - y0) / 2.0)
		p.position = Vector2((x0 + x1) / 2.0, (y0 + y1) / 2.0)
		p.direction = look.direction
		p.spread = float(look.spread)
		var size: float = depth.size
		p.gravity = look.gravity * size
		p.initial_velocity_min = float(look.speed[0]) * size
		p.initial_velocity_max = float(look.speed[1]) * size
		# The radial texture's visible core is about a third of its 256 px.
		p.scale_amount_min = float(look.size[0]) * size / 90.0
		p.scale_amount_max = float(look.size[1]) * size / 90.0
		var c := color if layer in DISTANT else _emissive(color, layer)
		var a := float(depth.alpha)
		var ramp := Gradient.new()
		ramp.set_color(0, Color(c, 0.0))
		ramp.set_color(1, Color(c, 0.0))
		ramp.add_point(0.3, Color(c, a))
		ramp.add_point(0.7, Color(c, a * 0.7))
		p.color_ramp = ramp
		var mat := CanvasItemMaterial.new()
		mat.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD if bool(look.add) else CanvasItemMaterial.BLEND_MODE_MIX
		mat.light_mode = CanvasItemMaterial.LIGHT_MODE_UNSHADED
		p.material = mat
		p.set_meta("layer", layer)
		_layers[layer].add_child(p)
		_particles.append(p)
		_fogs.append(p)


## How far (px) a room clip reaches left and right of the room's origin.
const CLIP_REACH := 40000.0

## A container in a layer that clips what it holds to the room's height (light shafts lean;
## they should not show above or below the room). Children are offset by CLIP_REACH.
func _room_clip(layer: String, height: float) -> Control:
	var clip: Control = _layers[layer].get_node_or_null("RoomClip")
	if clip == null:
		clip = Control.new()
		clip.name = "RoomClip"
		clip.clip_contents = true
		clip.mouse_filter = Control.MOUSE_FILTER_IGNORE
		clip.position = Vector2(-CLIP_REACH, _align_y(layer, height / 2.0))
		clip.size = Vector2(CLIP_REACH * 2.0, height)
		_layers[layer].add_child(clip)
	return clip


## Colors that should read as light, not lit surfaces: undo the scene's darkness tint (main canvas only).
func _emissive(color: Color, layer: String) -> Color:
	if layer in DISTANT:
		return color
	return Color(
		color.r / maxf(_ambient.r, 0.2), color.g / maxf(_ambient.g, 0.2), color.b / maxf(_ambient.b, 0.2), color.a
	)


func _add_vignette(tint: Color) -> void:
	var layer := CanvasLayer.new()
	layer.layer = 5
	var rect := ColorRect.new()
	var mat := ShaderMaterial.new()
	var shader := Shader.new()
	shader.code = VIGNETTE_SHADER
	mat.shader = shader
	mat.set_shader_parameter("tint", tint)
	rect.material = mat
	rect.set_anchors_preset(Control.PRESET_FULL_RECT)
	rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	layer.add_child(rect)
	add_child(layer)
