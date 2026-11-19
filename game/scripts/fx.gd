extends Node
## Feedback effects any handler can run (events.gd registry): shake, flash,
## hitStop, slowMotion. Shake and flash fade in real time (_process); slow
## motion counts physics frames and runs the room on only a `scale` share of
## them (the rest are hit-stop frames), so every step the room takes is the
## normal fixed step: headless simulations stay deterministic and the player
## still moves exactly as the movement model says.
##
## The animation effects (core art/animation.ts) live here too: playAnimation (a clip on a prop, a
## spawn or the player) and spawnEffect (an object shown once at a place, under the room, so a new
## room drops it), and spawn_object for projectile bursts. The look effects too (setLook, clearLook,
## dissolve on a target's art/look_view.gd; emit: art/particles.gd at a place; cameraZoom on the
## play camera).

const ObjectView := preload("res://scripts/art/object_view.gd")
const Particles := preload("res://scripts/art/particles.gd")
## Group of the room's live effects (spawnEffect, bursts): the runtime state's `effects`.
const EFFECTS_GROUP := "anim_effects"

var main: Node = null

var _shake := 0.0
var _shake_time := 0.0
var _shake_left := 0.0
var _flash_time := 0.0
var _flash_left := 0.0
var _flash_color := Color.WHITE
var _zoom_amount := 1.0
var _zoom_time := 0.0
var _zoom_left := 0.0
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
	events.register("playAnimation", _play_animation)
	events.register("spawnEffect", _spawn_effect)
	events.register("setLook", _set_look)
	events.register("clearLook", _clear_look)
	events.register("emit", _emit)
	events.register("dissolve", _dissolve)
	events.register("cameraZoom", func(e, _c): camera_zoom(float(e.get("amount", 1.15)), float(e.get("seconds", 0.3))))


# --- looks (core art/animation.ts Look; art/look_view.gd) ------------------------------------

## The look view of an animation target (self, player, prop, spawn) in the current room, or null.
func look_of(target: Variant, context: Dictionary) -> Node:
	if typeof(target) != TYPE_DICTIONARY:
		return null
	var kind := str(target.get("kind", "self"))
	if kind == "self":
		if typeof(context.get("prop")) == TYPE_DICTIONARY:
			return look_of({"kind": "prop", "prop": context.prop.id}, {})
		if typeof(context.get("spawn")) == TYPE_DICTIONARY:
			return look_of({"kind": "spawn", "spawn": context.spawn.id}, {})
		return null
	match kind:
		"player":
			if _alive(main._player):
				return main._player.look
		"prop":
			if main._props != null and is_instance_valid(main._props):
				return main._props.look_of(str(target.get("prop", "")))
		"spawn":
			var enemy := enemy_for(str(target.get("spawn", "")))
			if enemy != null:
				return enemy.look
	return null


## setLook {target, look, seconds, fade}: replaces the target's last setLook.
func _set_look(effect: Dictionary, context: Dictionary) -> void:
	var view := look_of(effect.get("target", {"kind": "self"}), context)
	if view != null and typeof(effect.get("look")) == TYPE_DICTIONARY:
		view.set_look(effect.look, effect.get("seconds"), float(effect.get("fade", 0.2)))


func _clear_look(effect: Dictionary, context: Dictionary) -> void:
	var view := look_of(effect.get("target", {"kind": "self"}), context)
	if view != null:
		view.clear_look(float(effect.get("fade", 0.2)))


func _dissolve(effect: Dictionary, context: Dictionary) -> void:
	var view := look_of(effect.get("target", {"kind": "self"}), context)
	if view != null:
		view.dissolve(str(effect.get("to", "out")), float(effect.get("seconds", 0.4)), Color(str(effect.get("color", "#ffffff"))))


## emit {at, offset, emitter, seconds, layer}: particles at a place for `seconds`; at a target, they
## follow it (and stop when it is gone).
func _emit(effect: Dictionary, context: Dictionary) -> void:
	var world: Node = main._world
	var at = effect.get("at", {"kind": "self"})
	if world == null or not is_instance_valid(world) or typeof(effect.get("emitter")) != TYPE_DICTIONARY or place_of(at, context) == null:
		return
	var particles = Particles.new()
	var offset = effect.get("offset", [0, 0])
	if typeof(offset) == TYPE_ARRAY and offset.size() >= 2:
		particles.offset = Vector2(float(offset[0]), float(offset[1]))
	var pinned := context.duplicate()
	if typeof(at) == TYPE_DICTIONARY and str(at.get("kind", "")) != "point":
		particles.follow = func(): return place_of(at, pinned)
	particles.position = place_of(at, context) + particles.offset
	if str(effect.get("layer", "front")) == "back":
		world.add_child(particles)
		var player = main._player
		if _alive(player) and player.get_parent() == world:
			world.move_child(particles, player.get_index())
	else:
		particles.z_index = 4
		world.add_child(particles)
	particles.setup(effect.emitter, Vector2.ZERO, float(effect.get("seconds", 0.5)))


## Particle systems alive in the current room (emit effects and looks' emitters): state `emitters`.
func emitters_count() -> int:
	var world: Node = main._world
	if world == null or not is_instance_valid(world):
		return 0
	var n := 0
	for node in get_tree().get_nodes_in_group(Particles.GROUP):
		if not node.is_queued_for_deletion() and world.is_ancestor_of(node):
			n += 1
	return n


## Punch the play camera in by `amount` (zoom x), easing back over `seconds` (real time).
func camera_zoom(amount: float, seconds: float) -> void:
	if seconds <= 0.0:
		return
	_zoom_amount = clampf(amount, 0.5, 3.0)
	_zoom_time = seconds
	_zoom_left = seconds


# --- animation ----------------------------------------------------------------------------

## playAnimation {target, clip, then}: the target's art plays the clip (a missing one is ignored).
func _play_animation(effect: Dictionary, context: Dictionary) -> void:
	var clip := str(effect.get("clip", ""))
	var then := str(effect.get("then", "idle"))
	var target = effect.get("target", {"kind": "self"})
	if typeof(target) != TYPE_DICTIONARY:
		return
	var kind := str(target.get("kind", "self"))
	if kind == "self":
		if typeof(context.get("prop")) == TYPE_DICTIONARY:
			kind = "prop"
			target = {"prop": context.prop.id}
		elif typeof(context.get("spawn")) == TYPE_DICTIONARY:
			kind = "spawn"
			target = {"spawn": context.spawn.id}
		else:
			return
	match kind:
		"player":
			if _alive(main._player):
				main._player.play_animation(clip, then)
		"prop":
			if main._props != null and is_instance_valid(main._props):
				main._props.play_animation(str(target.get("prop", "")), clip, then)
		"spawn":
			var enemy := enemy_for(str(target.get("spawn", "")))
			if enemy != null:
				enemy.play_animation(clip, then)


## spawnEffect {object, clip, at, offset, scale, layer}: show the object's clip once at the place
## (a missing object, clip or place: nothing).
func _spawn_effect(effect: Dictionary, context: Dictionary) -> void:
	var at = place_of(effect.get("at", {"kind": "self"}), context)
	if at == null:
		return
	var offset = effect.get("offset", [0, 0])
	if typeof(offset) == TYPE_ARRAY and offset.size() >= 2:
		at += Vector2(float(offset[0]), float(offset[1]))
	spawn_object(str(effect.get("object", "")), str(effect.get("clip", "idle")), at, float(effect.get("scale", 1.0)), str(effect.get("layer", "front")))


## Show `object` playing `clip` centred at `at` (room px) in the current room: removed when a clip that
## doesn't loop ends; a looping one stays until the room changes. Its markers fire as from
## "effect:<object>". Returns the view, or null (no such object or clip, no room).
func spawn_object(object: String, clip: String, at: Vector2, scale := 1.0, layer := "front", rotation := 0.0) -> Node2D:
	var world: Node = main._world
	if world == null or not is_instance_valid(world):
		return null
	var art: Dictionary = main._project.get("art", {})
	var asset := ObjectView.find_asset(art, object)
	if asset.is_empty():
		return null
	var view = ObjectView.new()
	view.setup(asset, art, "")
	if not view.has_clip(clip):
		view.free()
		return null
	view.position = at
	view.rotation = rotation
	view.scale = Vector2(scale, scale)
	view.set_meta("object", object)
	view.set_meta("clip", clip)
	view.add_to_group(EFFECTS_GROUP)
	view.marker.connect(func(marker_name: String, _clip: String): main._run.events.marker(marker_name, {"source": "effect:" + object}))
	if view.clip_loops(clip):
		view.play_loop(clip)
	else:
		view.play_once(clip, "hold")
		view.finished.connect(func(_c): view.queue_free())
	if layer == "back":
		world.add_child(view)
		# Behind the characters, like the props.
		var player = main._player
		if _alive(player) and player.get_parent() == world:
			world.move_child(view, player.get_index())
	else:
		view.z_index = 4
		world.add_child(view)
	return view


## The room's live effects: [{object, clip, x, y}] (state `effects`).
func effects_state() -> Array:
	var out := []
	var world: Node = main._world
	if world == null or not is_instance_valid(world):
		return out
	for view in world.get_children():
		if view.is_in_group(EFFECTS_GROUP) and not view.is_queued_for_deletion():
			out.append({"object": str(view.get_meta("object")), "clip": str(view.get_meta("clip")), "x": view.position.x, "y": view.position.y})
	return out


## A place (core EffectPlace: self, player, prop, spawn, point) in room px, or null when it isn't here.
func place_of(at: Variant, context: Dictionary) -> Variant:
	if typeof(at) != TYPE_DICTIONARY:
		return null
	match str(at.get("kind", "self")):
		"self":
			if typeof(context.get("prop")) == TYPE_DICTIONARY:
				return place_of({"kind": "prop", "prop": context.prop.id}, {})
			if typeof(context.get("spawn")) == TYPE_DICTIONARY:
				return place_of({"kind": "spawn", "spawn": context.spawn.id}, {})
		"player":
			if _alive(main._player):
				return main._player.center()
		"prop":
			if main._props != null and is_instance_valid(main._props):
				return main._props.center_of(str(at.get("prop", "")))
		"spawn":
			var enemy := enemy_for(str(at.get("spawn", "")))
			if enemy != null:
				return enemy.center()
		"point":
			return Vector2(float(at.get("x", 0)), float(at.get("y", 0)))
	return null


## The living enemy of a spawn in the current room, or null.
func enemy_for(spawn_id: String) -> Node:
	var world: Node = main._world
	if world == null or not is_instance_valid(world):
		return null
	for child in world.get_children():
		if child is CharacterBody2D and child != main._player and "spawn_id" in child and child.spawn_id == spawn_id and not child.dead:
			return child
	return null


func _alive(node) -> bool:
	return node != null and is_instance_valid(node)


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
	_zoom_left = 0.0
	_slow_frames = 0
	_apply_shake()
	_apply_flash()
	_apply_zoom()


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
	if _zoom_left > 0.0:
		_zoom_left = maxf(0.0, _zoom_left - delta)
		_apply_zoom()


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


## The camera punch: in fast (the first 15% of the time), then eased back to 1.
func _apply_zoom() -> void:
	var camera := _camera()
	if camera == null or not ("punch" in camera):
		return
	var t := 1.0 - _zoom_left / maxf(_zoom_time, 0.001)
	var k := t / 0.15 if t < 0.15 else pow(1.0 - (t - 0.15) / 0.85, 2.0)
	camera.punch = 1.0 + (_zoom_amount - 1.0) * clampf(k, 0.0, 1.0) if _zoom_left > 0.0 else 1.0


func _apply_flash() -> void:
	_flash_rect.visible = _flash_left > 0.0
	_flash_rect.color = Color(_flash_color, _flash_color.a * _flash_left / maxf(_flash_time, 0.001))
