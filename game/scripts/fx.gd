extends Node
## Feedback effects any handler can run (events.gd registry): shake, flash,
## hitStop, slowMotion. Shake and flash fade in real time (_process); slow
## motion counts physics frames and runs the room on only a `scale` share of
## them (the rest are hit-stop frames), so every step the room takes is the
## normal fixed step: headless simulations stay deterministic and the player
## still moves exactly as the movement model says.

var main: Node = null

var _shake := 0.0
var _shake_time := 0.0
var _shake_left := 0.0
var _flash_time := 0.0
var _flash_left := 0.0
var _flash_color := Color.WHITE
var _slow_scale := 1.0
var _slow_frames := 0
var _slow_budget := 0.0
var _rng := RandomNumberGenerator.new()
var _flash_layer: CanvasLayer
var _flash_rect: ColorRect


func setup(main_node: Node) -> void:
	main = main_node
	_rng.seed = 1
	_flash_layer = CanvasLayer.new()
	# Same layer as the HUD (2) but added after it, so drawn above it; modals (3) stay on top.
	_flash_layer.layer = 2
	_flash_rect = ColorRect.new()
	_flash_rect.set_anchors_preset(Control.PRESET_FULL_RECT)
	_flash_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_flash_rect.visible = false
	_flash_layer.add_child(_flash_rect)
	main.add_child.call_deferred(_flash_layer)


func register(events) -> void:
	events.register("shake", func(e, _c): shake(float(e.get("strength", 8)), float(e.get("seconds", 0.3))))
	events.register("flash", func(e, _c): flash(Color(str(e.get("color", "#ffffff"))), float(e.get("seconds", 0.2))))
	events.register("hitStop", func(e, _c): main.hit_stop(int(e.get("frames", 6))))
	events.register("slowMotion", func(e, _c): slow_motion(float(e.get("scale", 0.3)), float(e.get("seconds", 0.8))))


## Shake the play camera by up to `strength` px, easing out over `seconds`.
func shake(strength: float, seconds: float) -> void:
	if seconds <= 0.0 or strength < _shake * _shake_left / maxf(_shake_time, 0.001):
		return
	_shake = strength
	_shake_time = seconds
	_shake_left = seconds


## Cover the screen with `color`, fading out over `seconds`.
func flash(color: Color, seconds: float) -> void:
	if seconds <= 0.0:
		return
	_flash_color = color
	_flash_time = seconds
	_flash_left = seconds


## Run the room at `scale` speed for `seconds` (physics frames at 60 per second).
func slow_motion(scale: float, seconds: float) -> void:
	_slow_scale = clampf(scale, 0.05, 1.0)
	_slow_frames = roundi(seconds * Engine.physics_ticks_per_second)
	_slow_budget = 0.0


## A one-off burst of `count` particles flying out from `at` (in `parent`'s space) in `color`,
## e.g. an enemy's death. It lives under `parent` (the room), so a hit-stop freezes it and a
## rebuilt room drops it; `seed` makes it repeatable.
func burst(parent: Node, at: Vector2, color: Color, count := 14, seed := 0) -> void:
	if parent == null:
		return
	var node := Burst.new()
	node.position = at
	node.setup(color, count, seed)
	parent.add_child(node)


class Burst extends Node2D:
	const LIFE := 0.5
	const GRAVITY := 900.0
	var _color := Color.WHITE
	var _parts: Array = []  # [position, velocity, size, life]
	var _time := 0.0

	func setup(color: Color, count: int, seed: int) -> void:
		_color = color.lightened(0.25)
		z_index = 5
		var rng := RandomNumberGenerator.new()
		rng.seed = seed
		for i in count:
			var angle := TAU * (float(i) + rng.randf_range(-0.3, 0.3)) / float(maxi(count, 1))
			var speed := rng.randf_range(120.0, 320.0)
			_parts.append([Vector2.ZERO, Vector2(cos(angle), sin(angle) - 0.4) * speed, rng.randf_range(2.5, 5.0), rng.randf_range(0.6, 1.0) * LIFE])

	func _physics_process(delta: float) -> void:
		_time += delta
		if _time >= LIFE:
			queue_free()
			return
		for p in _parts:
			p[1] = p[1] + Vector2(0.0, GRAVITY * delta)
			p[0] = p[0] + p[1] * delta
		queue_redraw()

	func _draw() -> void:
		for p in _parts:
			var left: float = 1.0 - _time / p[3]
			if left > 0.0:
				var s: float = p[2] * (0.5 + 0.5 * left)
				draw_rect(Rect2(p[0] - Vector2(s, s) / 2.0, Vector2(s, s)), Color(_color, left))


## Stop / a new run: end any shake, flash or slow motion.
func reset() -> void:
	_shake_left = 0.0
	_flash_left = 0.0
	_slow_frames = 0
	_apply_shake()
	_apply_flash()


## What is running now (for headless probes).
func state() -> Dictionary:
	return {"shake": _shake_left, "flash": _flash_left, "slowFrames": _slow_frames, "flashColor": _flash_color.to_html(false)}


func _process(delta: float) -> void:
	if _shake_left > 0.0:
		_shake_left = maxf(0.0, _shake_left - delta)
		_apply_shake()
	if _flash_left > 0.0:
		_flash_left = maxf(0.0, _flash_left - delta)
		_apply_flash()


func _physics_process(_delta: float) -> void:
	if _slow_frames <= 0:
		return
	_slow_frames -= 1
	# The room steps when the budget reaches a whole frame; otherwise this frame is frozen.
	_slow_budget += _slow_scale
	if _slow_budget >= 1.0:
		_slow_budget -= 1.0
	else:
		main.hit_stop(1)


func _camera() -> Camera2D:
	var player = main._player if main != null else null
	return player.camera if player != null and is_instance_valid(player) else null


func _apply_shake() -> void:
	var camera := _camera()
	if camera == null:
		return
	var amount := _shake * _shake_left / maxf(_shake_time, 0.001)
	camera.offset = Vector2(_rng.randf_range(-amount, amount), _rng.randf_range(-amount, amount)) if _shake_left > 0.0 else Vector2.ZERO


func _apply_flash() -> void:
	_flash_rect.visible = _flash_left > 0.0
	_flash_rect.color = Color(_flash_color, _flash_color.a * _flash_left / maxf(_flash_time, 0.001))
