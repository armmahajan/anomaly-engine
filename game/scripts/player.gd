extends CharacterBody2D
## Player controller. All tuning values come from the project spec.
## Origin is at the feet (bottom-centre), matching spawn coordinates.

## A sword hit connected (main.gd freezes the world briefly: hit-stop).
signal landed_hit
## A weapon attack landed a hit: freeze the world `frames` physics frames, shake the camera `shake` px.
signal weapon_hit(frames: int, shake: float)
signal died
## A ground pound smashed a breakable platform (main.gd clears what stood on it).
signal smashed(rect: Rect2)
## Ran into (or landed on) a hazard tile this frame (world play applies the game's hazard rule).
signal touched_hazard

var character_id := ""
var spawn_id := ""
## A weapon attack's phase ("windup", "active", "recovery"; "" otherwise), reported like an enemy's.
var phase := ""
## The play camera (play_camera.gd).
var camera = null
## "slash_<direction>" while swinging (the built-in attack), "attack:<id>" while making a weapon attack,
## "hurt" while invulnerable, else null (reported to the studio).
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
var _recoil_speed := RECOIL_SPEED
## The weapons (combat/arsenal.gd): loadout slots, picking attacks, combos, ammo. Its attacks run in
## combat/weapon_runner.gd. An empty attack slot leaves the built-in attack (above) as it was.
var arsenal = null
var _weapon_view: Node2D = null
var _shown_weapon := ""
## The rig is posed by an attack's own clip (manual time) until the attack ends.
var _clip_posed := false
## A clip a playAnimation plays (core art/animation.ts; "" = none), what follows it ("idle" | "hold"),
## and whether it ended and is held on its last frame.
var _anim_clip := ""
var _anim_then := "idle"
var _anim_held := false
## How attacks aim (project controls.aim): "mouse" (toward the cursor, the aim keys winning while
## held) or "keys" (only the aim keys: up, forward, down).
var aim_mode := "mouse"
## Where the cursor is (main.gd: mouse_world() -> room point, or null while the mouse isn't in use).
var pointer = null
## The way the built-in swing faces when it was aimed with the mouse (toward the cursor); 0 = as the player faces.
var _slash_turn := 0.0

const CharacterArt := preload("res://scripts/art/character_art.gd")
const PlayCamera := preload("res://scripts/play_camera.gd")
const Arsenal := preload("res://scripts/combat/arsenal.gd")
const WeaponRunner := preload("res://scripts/combat/weapon_runner.gd")
const WeaponView := preload("res://scripts/art/weapon_view.gd")

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
		_rig.emit_markers = true
		_rig.marker.connect(_on_marker)
		add_child(_rig)
		_update_rig()

	arsenal = Arsenal.new()
	arsenal.setup(bounds.get("weapons"), _buffer_frames)
	_weapon_view = WeaponView.new()
	add_child(_weapon_view)
	arsenal.view = _weapon_view
	_show_weapon()

	camera = PlayCamera.new()
	camera.target = self
	camera.rows = float(bounds.get("viewRows", 14))
	camera.room_size = Vector2(float(bounds.width), float(bounds.height))
	add_child(camera)


func _tune(ability: String, key: String, fallback: float) -> float:
	return float(_tuning.get(ability, {}).get(key, fallback))


## A move key pressed since the last physics frame (-1, 1), or 0: a tap released before the frame ran
## isn't held when the frame reads the keys, but it still turns and moves the player for one frame.
var _tap_dir := 0.0


func _input(event: InputEvent) -> void:
	if event.is_action_pressed("move_left"):
		_tap_dir = -1.0
	elif event.is_action_pressed("move_right"):
		_tap_dir = 1.0


func _physics_process(delta: float) -> void:
	_invulnerable = maxf(0.0, _invulnerable - delta)
	_stun = maxf(0.0, _stun - delta)
	_cooldown = maxf(0.0, _cooldown - delta)
	_recoil = maxf(0.0, _recoil - delta)
	if _slash != "":
		_slash_time -= delta
		if _slash_time <= 0.0:
			_slash = ""
			_slash_turn = 0.0
			queue_redraw()

	var direction := Input.get_axis("move_left", "move_right")
	# A direction tapped between two frames (pressed and released before this one) still counts once.
	if direction == 0.0 and _tap_dir != 0.0:
		direction = _tap_dir
	_tap_dir = 0.0
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
			# A weapon attack keeps the way it faces until it ends.
			if direction != 0.0 and signf(direction) != _facing and not arsenal.busy():
				_facing = signf(direction)
				queue_redraw()
		var lunge: float = arsenal.runner.lunge_now() if arsenal.busy() else 0.0
		if lunge > 0.0:
			_vx = facing_sign() * lunge
		if _recoil > 0.0:
			_vx = _recoil_direction * _recoil_speed
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
		# The built-in attack, when the attack slot holds no weapon (projects without weapons: always).
		var built_in: bool = arsenal.weapon_for("attack").is_empty()
		if built_in and Input.is_action_just_pressed("attack") and _cooldown <= 0.0 and not arsenal.busy():
			_start_slash()
		arsenal.update(self, not on_floor, _slash != "")

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
	arsenal.after_move(self)
	phase = arsenal.runner.phase if arsenal.busy() else ""
	_show_weapon()
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
	var attacking: bool = arsenal != null and arsenal.busy() and _preview_clip == ""
	# The arm (or, without one, the held weapon) turns toward a mouse aim; set before posing.
	if _weapon_view != null:
		_weapon_view.set_aim_turn(_aim_turn() if attacking else 0.0)
	if _rig == null:
		return
	_rig.scale.x = facing_sign()
	var blinking := _invulnerable > 0.0 and fmod(_invulnerable, 0.14) < 0.07
	_rig.modulate = Color(1, 0.45, 0.45, 0.6) if blinking else Color.WHITE
	if _anim_clip != "" and _preview_clip == "":
		if _clip_posed:
			_rig.manual_time = false
			_clip_posed = false
		_rig.play(_anim_clip)
		if _rig.clip_ended() and not _anim_held:
			if _anim_then == "hold":
				_anim_held = true
			else:
				_anim_clip = ""
		if _anim_clip != "":
			return
	if attacking:
		_clip_posed = arsenal.runner.pose_rig(_rig, CharacterArt.first_clip)
		return
	if _clip_posed:
		_rig.manual_time = false
		_clip_posed = false
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


## playAnimation: play `clip` from its start over the movement's clips, then go back to them ("idle")
## or hold its last frame ("hold"). False (ignored) without art or such a clip.
func play_animation(clip: String, then := "idle") -> bool:
	if _rig == null or not _rig.has_clip(clip):
		return false
	_anim_clip = clip
	_anim_then = then
	_anim_held = false
	if _clip_posed:
		_rig.manual_time = false
		_clip_posed = false
	_rig.play(clip, true)
	return true


## The clip a playAnimation is playing (until it ends), else null (state: playerPlaying).
func anim_playing() -> Variant:
	return _anim_clip if _anim_clip != "" and not _anim_held else null


## Any clip the player's art plays crossed a marker: a `marker` event from the player.
func _on_marker(marker_name: String, _clip: String) -> void:
	var main = pointer
	if main != null and is_instance_valid(main) and "_run" in main and main._mode == "play" and main._run.active:
		main._run.events.marker(marker_name, {"source": "player", "player": true})


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
	if arsenal != null and arsenal.busy():
		return "attack:" + str(arsenal.runner.attack.id)
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


## The built-in swing: up, down (in the air) or forward, by the aim keys; aimed with the mouse, by the
## cursor's bucket (weapon_runner.gd aim_bucket), turned toward the cursor for the swing.
func _start_slash() -> void:
	_slash_turn = 0.0
	var aim := attack_aim()
	if bool(aim.mouse):
		var bucket := str(aim.name)
		_slash = "up" if bucket == "up" else ("down" if bucket == "down" and not _on_floor else "forward")
		var to: Vector2 = aim.vector
		_slash_turn = signf(to.x) if absf(to.x) > 1e-6 else _facing
	elif Input.is_action_pressed("aim_up"):
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
		var push := Vector2(facing_sign(), 0.0)
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
		var push := Vector2(facing_sign(), 0.0) if _slash == "forward" else (Vector2.UP if _slash == "up" else Vector2.DOWN)
		if target.struck(_attack_damage, push):
			landed = true
	if not landed:
		return
	match _slash:
		"down":
			_vy = -_pogo_velocity
		"forward":
			_recoil = RECOIL_TIME
			_recoil_direction = -facing_sign()
			_recoil_speed = RECOIL_SPEED
	landed_hit.emit()


func slash_rect() -> Rect2:
	var wide := _size.x + 24.0
	match _slash:
		"up":
			return Rect2(position.x - wide / 2.0, position.y - _size.y - _attack_reach, wide, _attack_reach)
		"down":
			return Rect2(position.x - wide / 2.0, position.y, wide, _attack_reach)
	var x := position.x + _size.x / 2.0 if facing_sign() > 0.0 else position.x - _size.x / 2.0 - _attack_reach
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
	arsenal.cancel()
	_vx = direction * knockback
	_vy = -knockback * 0.45
	_invulnerable = INVULNERABLE_TIME
	_stun = STUN_TIME if knockback > 0.0 else 0.0
	queue_redraw()
	if health == 0:
		died.emit()


func rect() -> Rect2:
	return Rect2(position.x - _size.x / 2.0, position.y - _size.y, _size.x, _size.y)


## Whether a hit now would hurt (not invulnerable, alive).
func can_be_hurt() -> bool:
	return _invulnerable <= 0.0 and health > 0


# --- wielding weapons (the wielder API of combat/weapon_runner.gd) ---------------------------

func size() -> Vector2:
	return _size


## The way the player faces: movement decides (`_facing`), except that an attack aimed with the
## mouse turns it toward the aim for the attack's duration (then it faces the way it did).
func facing_sign() -> float:
	if arsenal != null and arsenal.busy() and arsenal.turn != 0.0:
		return arsenal.turn
	if _slash != "" and _slash_turn != 0.0:
		return _slash_turn
	return _facing


## The aim attacks go toward: {name: "up" | "down" | "forward", vector: unit (room space, y down),
## mouse: aimed with the mouse}. Held aim keys win; else, with controls.aim "mouse" and the mouse in
## use over the game, toward the cursor (name = its bucket); else forward.
func attack_aim() -> Dictionary:
	if Input.is_action_pressed("aim_up"):
		return {"name": "up", "vector": Vector2.UP, "mouse": false}
	if Input.is_action_pressed("aim_down"):
		return {"name": "down", "vector": Vector2.DOWN, "mouse": false}
	if aim_mode == "mouse" and pointer != null and is_instance_valid(pointer):
		var at = pointer.mouse_world()
		if at != null:
			var to: Vector2 = (at as Vector2) - center()
			if to.length() > 0.5:
				to = to.normalized()
				return {"name": WeaponRunner.aim_bucket(to), "vector": to, "mouse": true}
	return {"name": "forward", "vector": Vector2(facing_sign(), 0.0), "mouse": false}


## The arm's turn toward a mouse aim for the attack being made (radians, wielder space): the aim's
## difference from the way its clip is drawn aiming, blended over its phases. None with key aiming.
func _aim_turn() -> float:
	if aim_mode != "mouse" or not arsenal.busy():
		return 0.0
	var runner = arsenal.runner
	var turn := wrapf(atan2(runner.aim.y, runner.aim.x) - WeaponRunner.authored_angle(runner.attack), -PI, PI)
	return turn * runner.aim_weight()


## Everything a weapon attack of the player's can hit: enemies, then props and pogo shots.
func weapon_targets() -> Array:
	return enemies + targets


func weapon_solids() -> Array:
	return solids


## The runner started an attack (arsenal.gd).
func weapon_started(runner) -> void:
	_show_weapon(runner.weapon)
	queue_redraw()


## A hit landed: hit-stop and shake every hit; the pogo bounce and the recoil once per attack.
func weapon_landed(attack: Dictionary, _point: Vector2, first: bool, bounce: bool) -> void:
	if bounce:
		_vy = -_pogo_velocity
	if first:
		_weapon_recoil(attack, bounce)
	weapon_hit.emit(WeaponRunner.frames(float(attack.get("hitStop", 0.05))), float(attack.get("shake", 0.0)))


## Projectiles left: the recoil.
func weapon_fired(attack: Dictionary) -> void:
	_weapon_recoil(attack, false)


## Pushed back against the aim at the attack's recoil speed (sideways for a while, or up or down at once).
func _weapon_recoil(attack: Dictionary, bounced: bool) -> void:
	var speed := float(attack.get("movement", {}).get("recoil", 0.0))
	if speed <= 0.0 or not arsenal.busy():
		return
	var aim: Vector2 = arsenal.runner.aim
	if absf(aim.x) > 0.3:
		_recoil = RECOIL_TIME
		_recoil_direction = -signf(aim.x) * facing_sign()
		_recoil_speed = speed * absf(aim.x)
	if aim.y < -0.3:
		_vy = maxf(_vy, speed * -aim.y)
	elif aim.y > 0.3 and not bounced:
		_vy = minf(_vy, -speed * aim.y)


func weapon_texture(ref) -> Texture2D:
	var world := get_parent()
	var main: Node = world.get_parent() if world != null else null
	if ref == null or main == null or not "_textures" in main:
		return null
	var texture = main._textures.get(str(ref))
	return texture if texture is Texture2D else null


## Show the weapon being used, else the one in the attack slot ({} = none: the built-in attack).
func _show_weapon(weapon = null) -> void:
	if _weapon_view == null or arsenal == null:
		return
	if weapon == null:
		weapon = arsenal.runner.weapon if arsenal.busy() else arsenal.weapon_for("attack")
	var id := str(weapon.get("id", ""))
	if id != _shown_weapon:
		_shown_weapon = id
		_weapon_view.set_weapon(weapon, _rig)


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
		draw_rect(Rect2(facing_sign() * _size.x * 0.18 - 3.0, -_size.y * 0.8, 6.0, 6.0), Color.BLACK)
	if _slash != "":
		var area := slash_rect()
		area.position -= position
		draw_rect(area, Color(1, 1, 1, 0.35))
		draw_rect(area, Color(1, 1, 1, 0.9), false, 2.0)
