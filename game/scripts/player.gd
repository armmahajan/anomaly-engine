extends CharacterBody2D
## Player controller. All tuning values come from the project spec.
## Origin is at the feet (bottom-centre), matching spawn coordinates.

## A sword hit connected (main.gd freezes the world briefly: hit-stop).
signal landed_hit
signal died
## A ground pound smashed a breakable platform (main.gd clears what stood on it).
signal smashed(rect: Rect2)
## Ran into (or landed on) a hazard tile this frame (world play applies the game's hazard rule).
signal touched_hazard

var character_id := ""
var spawn_id := ""
## The play camera (play_camera.gd).
var camera = null
## "slash_<direction>" while swinging, "hurt" while invulnerable, else null (reported to the studio).
var behavior_state = null
var health := 0
var max_health := 0
## Set by main.gd: everything the sword can hit.
var enemies: Array = []
## Other things the sword can strike (props): each has rect() and struck(damage, push) -> bool
## (true = a landed hit: a downward strike bounces, a forward one recoils).
var targets: Array = []

const INVULNERABLE_TIME := 0.7
const STUN_TIME := 0.25
const STUN_FRICTION := 1400.0
const SLASH_TIME := 0.12
const RECOIL_SPEED := 220.0
const RECOIL_TIME := 0.08

var _run_speed := 0.0
var _jump_velocity := 0.0
var _attack_damage := 1
var _attack_reach := 56.0
var _attack_cooldown := 0.35
var _pogo_velocity := 620.0
var _gravity := 0.0
var _max_fall := 1100.0
var _size := Vector2.ZERO
var _color := Color.WHITE
var _spawn := Vector2.ZERO
var _kill_y := 0.0
var _facing := 1.0
var _invulnerable := 0.0
var _stun := 0.0
var _slash := ""
var _slash_time := 0.0
var _cooldown := 0.0
var _slash_hits: Array = []
var _recoil := 0.0
var _recoil_direction := 0.0
var _rig: Node2D = null
var _preview_clip := ""

const CharacterArt := preload("res://scripts/art/character_art.gd")
const PlayCamera := preload("res://scripts/play_camera.gd")

# Movement. Mirrors packages/core/src/movement/simulate.ts `step` line for
# line (game/test/movement.test.ts compares the two); counters are in frames.
const FPS := 60
const JUMP_CUT := 0.5
const WALL_COYOTE_FRAMES := 6
const POUND_RECOVERY_FRAMES := 9
var _has := {}
var _tuning := {}
var _coyote_frames := 0
var _buffer_frames := 0
var _dash_length := 1
var _dash_speed := 0.0
var _dash_cooldown_frames := 0
var _kick_length := 0
var _air_jump_count := 0
var _coyote := 0
var _buffer := 0
var _air_jumps := 0
var _air_dashes := 0
var _dash_frames := 0
var _dash_dir := 1.0
var _dash_cooldown := 0
var _kick_frames := 0
var _kick_dir := 0.0
var _wall_frames := 0
var _wall_normal := 0.0
var _pounding := false
var _pound_recover := 0
## Solid rectangles to collide with, set by main.gd: {x, y, w, h, kind, group, body}.
var solids: Array = []
# Position and velocity in 64-bit floats (Vector2 is 32-bit); mirrored to position/velocity.
var _px := 0.0
var _py := 0.0
var _vx := 0.0
var _vy := 0.0
var _on_floor := false
var _on_wall := false
var _floor_solid = null
var _gliding := false
var _sliding := false
var _dashing := false
var _touched_hazard := false


static func _frames(seconds: float) -> int:
	return maxi(0, roundi(seconds * FPS))


func setup(character: Dictionary, bounds: Dictionary, spawn: Vector2, art: Dictionary = {}) -> void:
	character_id = character.id
	var stats: Dictionary = character.stats
	_run_speed = float(stats.runSpeed)
	_jump_velocity = float(stats.jumpVelocity)
	max_health = int(stats.get("health", 5))
	health = max_health
	_attack_damage = int(stats.get("attackDamage", 1))
	_attack_reach = float(stats.get("attackReach", 56))
	_attack_cooldown = float(stats.get("attackCooldown", 0.35))
	_pogo_velocity = float(stats.get("pogoVelocity", 620))
	_max_fall = float(stats.get("maxFallSpeed", 1100))
	_coyote_frames = _frames(float(stats.get("coyoteTime", 0.1)))
	_buffer_frames = _frames(float(stats.get("jumpBuffer", 0.12)))
	_size = Vector2(character.size.width, character.size.height)
	_color = Color(character.color)
	_gravity = float(bounds.gravity)
	_spawn = spawn
	_kill_y = float(bounds.height) + 400.0
	position = spawn
	_px = spawn.x
	_py = spawn.y

	_tuning = character.get("abilities", {})
	for ability in bounds.get("playerAbilities", []):
		_has[str(ability)] = true
	var dash: Dictionary = _tuning.get("dash", {})
	_dash_length = maxi(1, _frames(float(dash.get("duration", 0.2))))
	_dash_speed = float(dash.get("distance", 220)) / (_dash_length / float(FPS))
	_dash_cooldown_frames = maxi(_dash_length, _frames(float(dash.get("cooldown", 0.45))))
	_kick_length = _frames(float(_tune("wallJump", "kickTime", 0.16)))
	_air_jump_count = int(_tune("doubleJump", "jumps", 1)) if _has.has("double_jump") else 0

	collision_layer = 2
	collision_mask = 1  # world only; characters pass through each other for now

	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = _size
	shape.shape = box
	shape.position = Vector2(0, -_size.y / 2.0)
	add_child(shape)

	var asset := CharacterArt.asset_for(character, art)
	if not asset.is_empty():
		_rig = CharacterArt.make_view(asset, art)
		_rig.show_behind_parent = true  # the sword swing (drawn by the player) stays on top
		add_child(_rig)
		_update_rig()

	camera = PlayCamera.new()
	camera.target = self
	camera.rows = float(bounds.get("viewRows", 14))
	camera.room_size = Vector2(float(bounds.width), float(bounds.height))
	add_child(camera)


func _tune(ability: String, key: String, fallback: float) -> float:
	return float(_tuning.get(ability, {}).get(key, fallback))


func _physics_process(delta: float) -> void:
	_invulnerable = maxf(0.0, _invulnerable - delta)
	_stun = maxf(0.0, _stun - delta)
	_cooldown = maxf(0.0, _cooldown - delta)
	_recoil = maxf(0.0, _recoil - delta)
	if _slash != "":
		_slash_time -= delta
		if _slash_time <= 0.0:
			_slash = ""
			queue_redraw()

	var direction := Input.get_axis("move_left", "move_right")
	var on_floor := _on_floor
	_buffer = maxi(0, _buffer - 1)
	_dash_cooldown = maxi(0, _dash_cooldown - 1)
	_kick_frames = maxi(0, _kick_frames - 1)
	_wall_frames = maxi(0, _wall_frames - 1)
	_pound_recover = maxi(0, _pound_recover - 1)
	if on_floor:
		_coyote = _coyote_frames
		_air_jumps = _air_jump_count
		_air_dashes = 1
	else:
		_coyote = maxi(0, _coyote - 1)
	_gliding = false
	_sliding = false
	_dashing = false

	if _stun > 0.0:
		# Knocked back: no control until the stun wears off.
		if not on_floor:
			_vy = minf(_vy + _gravity * delta, _max_fall)
		_vx = move_toward(_vx, 0.0, STUN_FRICTION * delta)
	elif _dash_frames > 0:
		_vx = _dash_dir * _dash_speed
		_vy = 0.0
		_dash_frames -= 1
		_dashing = true
	elif _pounding:
		_vx = 0.0
		_vy = _tune("groundPound", "speed", 1400)
	else:
		if not on_floor:
			_vy = minf(_vy + _gravity * delta, _max_fall)
		if _pound_recover > 0:
			_vx = 0.0
		elif _kick_frames > 0:
			_vx = _kick_dir * _tune("wallJump", "kickSpeed", 340)
		else:
			_vx = direction * _run_speed
			if direction != 0.0 and signf(direction) != _facing:
				_facing = signf(direction)
				queue_redraw()
		if _recoil > 0.0:
			_vx = _recoil_direction * RECOIL_SPEED
		_jump(on_floor)
		if Input.is_action_just_released("jump") and _vy < 0.0:
			_vy *= JUMP_CUT  # short hop when jump is released early
		var glide_fall := _tune("glide", "fallSpeed", 110)
		if _has.has("glide") and Input.is_action_pressed("jump") and not _pounding and _vy > glide_fall:
			_vy = glide_fall
			_gliding = true
		var slide := _tune("wallJump", "slideSpeed", 150)
		if _has.has("wall_jump") and not on_floor and _on_wall and direction == -_wall_normal and _vy > slide:
			_vy = slide
			_sliding = true
		if _has.has("dash") and Input.is_action_just_pressed("dash") and _dash_cooldown == 0 and (on_floor or _air_dashes > 0) and not _pounding:
			_dash_dir = signf(direction) if direction != 0.0 else _facing
			_facing = _dash_dir
			_dash_frames = _dash_length - 1
			_dashing = true
			_vx = _dash_dir * _dash_speed
			_vy = 0.0
			_dash_cooldown = _dash_cooldown_frames
			_kick_frames = 0
			if not on_floor:
				_air_dashes -= 1
		if Input.is_action_just_pressed("attack") and _cooldown <= 0.0:
			_start_slash()

	_move(delta)
	if _touched_hazard:
		_touched_hazard = false
		touched_hazard.emit()
	if _on_floor and _pounding:
		if not _smash_floor():
			_pounding = false
			_pound_recover = POUND_RECOVERY_FRAMES
	if not _on_floor and _on_wall and _has.has("wall_jump") and direction == -_wall_normal:
		_wall_frames = WALL_COYOTE_FRAMES
		_air_jumps = _air_jump_count
		_air_dashes = 1
	if _slash != "":
		_strike()
	velocity = Vector2(_vx, _vy)

	var shown = _shown_state()
	if shown != behavior_state or _invulnerable > 0.0 or _dashing:
		queue_redraw()  # blink while invulnerable
	behavior_state = shown

	if _py > _kill_y:
		_px = _spawn.x
		_py = _spawn.y
		_vx = 0.0
		_vy = 0.0
		position = _spawn
		velocity = Vector2.ZERO
	_update_rig()


## Edit-mode clip preview ("" = follow movement).
func set_preview_clip(clip: String) -> void:
	_preview_clip = clip
	_update_rig()


func _update_rig() -> void:
	if _rig == null:
		return
	_rig.scale.x = _facing
	var blinking := _invulnerable > 0.0 and fmod(_invulnerable, 0.14) < 0.07
	_rig.modulate = Color(1, 0.45, 0.45, 0.6) if blinking else Color.WHITE
	var slots: Array
	if _preview_clip != "":
		slots = [_preview_clip]
	elif _slash != "":
		slots = ["slash_" + _slash, "attack"]
	elif _stun > 0.0:
		slots = ["hurt"]
	elif not _on_floor:
		slots = ["jump"] if velocity.y < 0.0 else ["fall", "jump"]
	elif absf(velocity.x) > 1.0:
		slots = ["run", "walk"]
	else:
		slots = ["idle"]
	_rig.play(CharacterArt.first_clip(_rig, slots))


## Ground jump (with coyote time and buffering), wall jump, ground pound or mid-air jump.
func _jump(on_floor: bool) -> void:
	var pressed := Input.is_action_just_pressed("jump")
	if pressed:
		_buffer = _buffer_frames
	if _buffer == 0:
		return
	if on_floor or _coyote > 0:
		_vy = -_jump_velocity
		_buffer = 0
		_coyote = 0
	elif _has.has("wall_jump") and _wall_frames > 0:
		_vy = -_tune("wallJump", "velocity", 700)
		_kick_frames = _kick_length
		_kick_dir = _wall_normal
		_vx = _kick_dir * _tune("wallJump", "kickSpeed", 340)
		_facing = _kick_dir
		_buffer = 0
		_wall_frames = 0
		_air_jumps = _air_jump_count
		_air_dashes = 1
	elif pressed and _has.has("ground_pound") and Input.is_action_pressed("aim_down"):
		_pounding = true
		_vx = 0.0
		_vy = _tune("groundPound", "speed", 1400)
		_buffer = 0
	elif pressed and _air_jumps > 0:
		_vy = -_tune("doubleJump", "velocity", 680)
		_air_jumps -= 1
		_buffer = 0


## A ground pound landed: smash the breakable area under the feet (every solid of its group).
func _smash_floor() -> bool:
	if _floor_solid == null or str(_floor_solid.kind) != "breakable":
		return false
	var hit = _floor_solid
	for solid in solids.duplicate():
		if solid == hit or (hit.group != null and str(solid.kind) == "breakable" and solid.group == hit.group):
			solids.erase(solid)
			smashed.emit(Rect2(solid.x, solid.y, solid.w, solid.h))
			if solid.body != null:
				solid.body.queue_free()
	_floor_solid = null
	return true


const EPS := 1e-9

## Move by velocity * delta, sliding along solids. A port of simulate.ts `move`
## (not Godot's move_and_slide, whose collision margins make ledges fuzzy), so
## the movement model stays exact.
func _move(delta: float) -> void:
	var was_on_floor := _on_floor
	var hw := _size.x / 2.0
	_on_floor = false
	_on_wall = false
	_floor_solid = null
	var rx := _vx * delta
	var ry := _vy * delta
	for iteration in 4:
		if rx == 0.0 and ry == 0.0:
			break
		var best_t := INF
		var best_axis := ""
		var best_solid = null
		for solid in solids:
			# One-way platforms only catch you falling onto them from above.
			if str(solid.kind) == "oneway" and not (ry > 0.0 and _py <= solid.y + EPS):
				continue
			var sx = _span(_px - hw, _px + hw, rx, solid.x, solid.x + solid.w)
			var sy = _span(_py - _size.y, _py, ry, solid.y, solid.y + solid.h)
			if sx.is_empty() or sy.is_empty():
				continue
			var entry: float = maxf(sx[0], sy[0])
			var exit: float = minf(sx[1], sy[1])
			if entry > exit - EPS or entry < -EPS or entry > 1.0 or (sx[0] < -EPS and sy[0] < -EPS):
				continue
			var axis := "x" if sx[0] > sy[0] else "y"
			if str(solid.kind) == "oneway" and axis == "x":
				continue
			if entry < best_t:
				best_t = entry
				best_axis = axis
				best_solid = solid
		if best_axis == "":
			_px += rx
			_py += ry
			break
		var t := maxf(0.0, best_t)
		if str(best_solid.kind) == "hazard":
			_touched_hazard = true
		_px += rx * t
		_py += ry * t
		if best_axis == "x":
			_on_wall = true
			_wall_normal = -1.0 if rx > 0.0 else 1.0
			_vx = 0.0
			rx = 0.0
			ry *= 1.0 - t
		else:
			if ry > 0.0:
				_on_floor = true
				_floor_solid = best_solid
			_vy = 0.0
			ry = 0.0
			rx *= 1.0 - t
	# Floor snap: stay grounded while walking along a floor.
	if not _on_floor and was_on_floor and _vy >= 0.0:
		for solid in solids:
			if solid.y >= _py - EPS and solid.y <= _py + 1.0 and _px + hw > solid.x + EPS and _px - hw < solid.x + solid.w - EPS:
				_py = solid.y
				_on_floor = true
				_floor_solid = solid
				break
	position = Vector2(_px, _py)


## Entry and exit time of a moving interval against a fixed one; [] if they never overlap.
static func _span(lo: float, hi: float, motion: float, r_lo: float, r_hi: float) -> Array:
	if motion > 0.0:
		return [(r_lo - hi) / motion, (r_hi - lo) / motion]
	if motion < 0.0:
		return [(r_hi - lo) / motion, (r_lo - hi) / motion]
	return [-INF, INF] if hi > r_lo + EPS and lo < r_hi - EPS else []


func _shown_state():
	if _slash != "":
		return "slash_" + _slash
	if _dashing:
		return "dash"
	if _pounding:
		return "ground_pound"
	if _sliding:
		return "wall_slide"
	if _gliding:
		return "glide"
	if _invulnerable > 0.0:
		return "hurt"
	return null


func _start_slash() -> void:
	if Input.is_action_pressed("aim_up"):
		_slash = "up"
	elif Input.is_action_pressed("aim_down") and not _on_floor:
		_slash = "down"
	else:
		_slash = "forward"
	_slash_time = SLASH_TIME
	_cooldown = _attack_cooldown
	_slash_hits = []
	queue_redraw()


## Hit every enemy the swing overlaps, each at most once per swing.
func _strike() -> void:
	var area := slash_rect()
	var landed := false
	for enemy in enemies:
		if enemy.dead or enemy in _slash_hits or not area.intersects(enemy.rect()):
			continue
		_slash_hits.append(enemy)
		var push := Vector2(_facing, 0.0)
		if _slash == "up":
			push = Vector2.UP
		elif _slash == "down":
			push = Vector2.DOWN
		enemy.take_hit(_attack_damage, push)
		landed = true
	for target in targets:
		if target in _slash_hits or not is_instance_valid(target) or not area.intersects(target.rect()):
			continue
		_slash_hits.append(target)
		var push := Vector2(_facing, 0.0) if _slash == "forward" else (Vector2.UP if _slash == "up" else Vector2.DOWN)
		if target.struck(_attack_damage, push):
			landed = true
	if not landed:
		return
	match _slash:
		"down":
			_vy = -_pogo_velocity
		"forward":
			_recoil = RECOIL_TIME
			_recoil_direction = -_facing
	landed_hit.emit()


func slash_rect() -> Rect2:
	var wide := _size.x + 24.0
	match _slash:
		"up":
			return Rect2(position.x - wide / 2.0, position.y - _size.y - _attack_reach, wide, _attack_reach)
		"down":
			return Rect2(position.x - wide / 2.0, position.y, wide, _attack_reach)
	var x := position.x + _size.x / 2.0 if _facing > 0.0 else position.x - _size.x / 2.0 - _attack_reach
	return Rect2(x, position.y - _size.y, _attack_reach, _size.y)


## Give the player a movement ability mid-run (an effect).
func grant_ability(ability: String) -> void:
	_has[ability] = true
	if ability == "double_jump":
		_air_jump_count = int(_tune("doubleJump", "jumps", 1))


## Called by enemies on contact. Ignored while invulnerable.
func hit(direction: float, knockback: float, damage: int) -> void:
	if _invulnerable > 0.0 or health <= 0:
		return
	health = maxi(0, health - damage)
	_dash_frames = 0
	_pounding = false
	_kick_frames = 0
	_vx = direction * knockback
	_vy = -knockback * 0.45
	_invulnerable = INVULNERABLE_TIME
	_stun = STUN_TIME if knockback > 0.0 else 0.0
	queue_redraw()
	if health == 0:
		died.emit()


func rect() -> Rect2:
	return Rect2(position.x - _size.x / 2.0, position.y - _size.y, _size.x, _size.y)


func center() -> Vector2:
	return position - Vector2(0, _size.y / 2.0)


func _draw() -> void:
	var color := _color
	if _invulnerable > 0.0 and fmod(_invulnerable, 0.14) < 0.07:
		color = Color(1, 0.35, 0.35, 0.55)
	# The placeholder box (and its dash trail) only when the character has no rig; ability cues always.
	if _rig == null:
		if _dashing:
			draw_rect(Rect2(-_size.x / 2.0 - _dash_dir * _size.x, -_size.y * 0.8, _size.x, _size.y * 0.6), Color(color, 0.3))
		draw_rect(Rect2(-_size.x / 2.0, -_size.y, _size.x, _size.y), color)
	if _gliding:
		draw_line(Vector2(-_size.x * 1.2, -_size.y * 0.75), Vector2(_size.x * 1.2, -_size.y * 0.75), Color(color, 0.8), 3.0)
	if _pounding:
		draw_line(Vector2(0, 4), Vector2(0, 18), Color.WHITE, 3.0)
	if _rig == null:
		draw_rect(Rect2(_facing * _size.x * 0.18 - 3.0, -_size.y * 0.8, 6.0, 6.0), Color.BLACK)
	if _slash != "":
		var area := slash_rect()
		area.position -= position
		draw_rect(area, Color(1, 1, 1, 0.35))
		draw_rect(area, Color(1, 1, 1, 0.9), false, 2.0)
