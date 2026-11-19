extends Node2D
## Code-drawn particles (core art/animation.ts Emitter): the `emit` effect (fx.gd) and a look's
## emitter (look_view.gd). CPUParticles2D (it runs the same on the web export and headless), with
## textures drawn here once per shape: dot, spark (a streak along its flight), ring, smoke, star.
## Particles live in room space (they stay where they were emitted as the emitter moves).
##
## A stream of `rate` per second and a `burst` at the start; it emits for `seconds` (< 0: until
## stop()), then lingers until its last particles die and frees itself. `follow` (optional) returns
## where it is each frame (room px, or null: the thing it follows is gone, so it stops).

## Every live emitter is in this group (runtime state `emitters`).
const GROUP := "anim_emitters"
## Texture size per shape (px); an emitter's `size` is the drawn width.
const BASE := {"dot": 16, "spark": 8, "ring": 32, "smoke": 32, "star": 32}

static var _textures := {}

## Where it is each frame (room px) or null to stop; unset = it stays put (or moves with its parent).
var follow := Callable()
var offset := Vector2.ZERO

var _stream: CPUParticles2D = null
var _burst: CPUParticles2D = null
var _left := -1.0
var _linger := -1.0
var _lifetime := 0.6
var _stopped := false


## Build from an Emitter (core defaults filled in here too). `area`: the emission rectangle, centred on
## this node (zero size = a point). `seconds`: how long it emits (0 = the burst only; < 0 = until stop()).
func setup(emitter: Dictionary, area := Vector2.ZERO, seconds := -1.0) -> void:
	add_to_group(GROUP)
	_lifetime = clampf(float(emitter.get("lifetime", 0.6)), 0.05, 5.0)
	var rate := clampf(float(emitter.get("rate", 20.0)), 0.0, 200.0)
	var burst := clampi(int(emitter.get("burst", 0)), 0, 200)
	if rate > 0.0 and seconds != 0.0:
		_stream = _particles(emitter, area, maxi(1, ceili(rate * _lifetime)))
		_stream.emitting = true
	if burst > 0:
		_burst = _particles(emitter, area, burst)
		_burst.one_shot = true
		_burst.explosiveness = 1.0
		_burst.emitting = true
	_left = seconds
	if seconds == 0.0 or (_stream == null and _burst != null):
		stop()
	elif _stream == null and _burst == null:
		stop()


func _particles(emitter: Dictionary, area: Vector2, amount: int) -> CPUParticles2D:
	var shape := str(emitter.get("shape", "dot"))
	if not BASE.has(shape):
		shape = "dot"
	var p := CPUParticles2D.new()
	p.amount = amount
	p.lifetime = _lifetime
	p.lifetime_randomness = 0.3
	p.local_coords = false
	p.texture = texture_of(shape)
	var size := clampf(float(emitter.get("size", 4.0)), 0.5, 64.0)
	var base := float(BASE[shape])
	p.scale_amount_min = size / base * 0.8
	p.scale_amount_max = size / base * 1.2
	if emitter.get("sizeEnd") != null:
		var ratio := clampf(float(emitter.sizeEnd), 0.0, 64.0) / size
		var curve := Curve.new()
		curve.max_value = maxf(1.0, ratio)
		curve.add_point(Vector2(0.0, 1.0))
		curve.add_point(Vector2(1.0, ratio))
		p.scale_amount_curve = curve
	var direction := deg_to_rad(float(emitter.get("direction", -90.0)))
	p.direction = Vector2(cos(direction), sin(direction))
	p.spread = clampf(float(emitter.get("spread", 360.0)), 0.0, 360.0) / 2.0
	var speed := clampf(float(emitter.get("speed", 80.0)), 0.0, 2000.0)
	p.initial_velocity_min = speed * 0.6
	p.initial_velocity_max = speed
	p.gravity = Vector2(0.0, clampf(float(emitter.get("gravity", 0.0)), -2000.0, 2000.0))
	if shape == "spark":
		p.particle_flag_align_y = true
	else:
		p.angle_min = -180.0 if shape == "star" or shape == "smoke" else 0.0
		p.angle_max = 180.0 if shape == "star" or shape == "smoke" else 0.0
	var start := Color(str(emitter.get("color", "#ffffff")))
	var end := Color(str(emitter.get("colorEnd"))) if emitter.get("colorEnd") != null else start
	var ramp := Gradient.new()
	ramp.set_color(0, start)
	ramp.set_color(1, Color(end, 0.0))
	ramp.add_point(0.6, Color(start.lerp(end, 0.6), 0.85))
	p.color_ramp = ramp
	if area.x > 0.0 or area.y > 0.0:
		p.emission_shape = CPUParticles2D.EMISSION_SHAPE_RECTANGLE
		p.emission_rect_extents = area / 2.0
	if bool(emitter.get("additive", true)):
		var material := CanvasItemMaterial.new()
		material.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
		p.material = material
	add_child(p)
	return p


## Stop emitting; it frees itself once its last particles are gone.
func stop() -> void:
	if _stopped:
		return
	_stopped = true
	if _stream != null:
		_stream.emitting = false
	_linger = _lifetime * 1.3 + 0.05


## Still emitting (not stopped).
func emitting() -> bool:
	return not _stopped


func _process(delta: float) -> void:
	if follow.is_valid():
		var at = follow.call()
		if at == null:
			stop()
		else:
			global_position = at + offset
	if not _stopped and _left > 0.0:
		_left -= delta
		if _left <= 0.0:
			stop()
	if _stopped:
		_linger -= delta
		if _linger <= 0.0:
			queue_free()


## The texture of a shape (white; the colour ramp tints it), drawn once.
static func texture_of(shape: String) -> Texture2D:
	if _textures.has(shape):
		return _textures[shape]
	var size: int = BASE.get(shape, 16)
	var w := size
	var h := size * 3 if shape == "spark" else size
	var image := Image.create(w, h, false, Image.FORMAT_RGBA8)
	for y in h:
		for x in w:
			var u := (float(x) + 0.5) / float(w) * 2.0 - 1.0
			var v := (float(y) + 0.5) / float(h) * 2.0 - 1.0
			var r := sqrt(u * u + v * v)
			var a := 0.0
			match shape:
				"dot":
					a = clampf(1.0 - r, 0.0, 1.0)
					a = a * a * (3.0 - 2.0 * a)
				"spark":
					a = clampf(1.0 - absf(u), 0.0, 1.0) * clampf(1.0 - v * v, 0.0, 1.0)
				"ring":
					a = exp(-pow((r - 0.72) / 0.14, 2.0))
				"smoke":
					a = pow(clampf(1.0 - r, 0.0, 1.0), 1.6) * 0.7
				"star":
					var arms := maxf(exp(-absf(u) * 9.0) * clampf(1.0 - absf(v), 0.0, 1.0), exp(-absf(v) * 9.0) * clampf(1.0 - absf(u), 0.0, 1.0))
					a = clampf(arms + exp(-r * r * 18.0), 0.0, 1.0)
			image.set_pixel(x, y, Color(1, 1, 1, a))
	var texture := ImageTexture.create_from_image(image)
	_textures[shape] = texture
	return texture
