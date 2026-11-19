extends CharacterBody2D
## Generic enemy: runs whatever behavior state machine the project defines.
## No enemy-specific code lives here; primitives do the work
## (see res://primitives/registry.gd). Origin is at the feet.

const Registry := preload("res://primitives/registry.gd")
const CharacterArt := preload("res://scripts/art/character_art.gd")
const Attack := preload("res://scripts/combat/attack.gd")
const WeaponRunner := preload("res://scripts/combat/weapon_runner.gd")
const WeaponView := preload("res://scripts/art/weapon_view.gd")
const LookView := preload("res://scripts/art/look_view.gd")

## The sword (or anything else) brought its health to 0.
signal killed

var character_id := ""
var spawn_id := ""
## The current attack action's phase ("windup", "active", "recovery"; "" otherwise): attack
## primitives set it, and the art picks clips by it (character_art.gd).
var phase := ""
## Current behavior state id (reported to the studio).
var behavior_state := ""

# --- actor API used by primitives ---
var facing := 1.0
var home := Vector2.ZERO
var state_time := 0.0
var player: Node2D = null
var flying := false
## Scratch space for the current state's action and conditions; cleared on entering a state.
var memory := {}
## Set by an action when it has finished (see the actionDone condition).
var action_done := false
var shaking := false
## Seeded per run by main.gd, so random choices replay identically.
var rng := RandomNumberGenerator.new()
## Index of the transition being checked (interrupts are offset by 100).
var current_transition := 0
var health := 0
var max_health := 0
## Hit by the player's sword since entering the current state (see wasHit).
var was_hit := false
var dead := false
## Set by slam's windup: hang in the air (no gravity) this frame.
var hold_air := false
## Its summons (summon primitive), alive or not.
var summons: Array = []
## The weapon attack it is making (useWeapon: combat/weapon_runner.gd, the player's code), or null.
var weapon_runner = null
## Its looks (core art/animation.ts: its behavior state's look, setLook, dissolve): art/look_view.gd.
var look: Node2D = null

const FLASH_TIME := 0.1
const RECOIL_SPEED := 260.0
const RECOIL_TIME := 0.1

# --- death: harmless and still at once; its death clip (or the fallback pop), linger, fade, gone.
## Defaults of the character's `death` (core DEATH_DEFAULTS).
const DEATH_LINGER := 0.6
const DEATH_FADE := 0.4
## The fallback without a death clip: a pop, a white flash, then it shrinks, flattens and darkens.
const DEATH_POP_TIME := 0.35
## A death clip longer than this is held from here (the body still lingers and fades).
const DEATH_CLIP_MAX := 3.0
## The killing blow throws the body up (px/s) and along the push; it slides to a stop.
const DEATH_HOP := 220.0
const DEATH_FRICTION := 900.0
const DEATH_FLASH := 0.12

var _states: Dictionary = {}
var _interrupts: Array = []
var _entered := false
var _knockback := 0.0
var _contact_damage := 1
var _armor := 0.0
var _bounds := {}
var _summoned := 0
## A shown attack hitbox (strike): {rect (local), live, color} or null.
var _attack = null
## Teleporting: gone (untouchable, harmless) until appear(); the marker is where it will be.
var _hidden := false
var _marker := Vector2.ZERO
var _marker_color := Color.WHITE
var _flash := 0.0
var _recoil := Vector2.ZERO
var _recoil_time := 0.0
var _gravity := 0.0
var _size := Vector2.ZERO
var _color := Color.WHITE
var _tint = null  # Color or null
var _kill_y := 0.0
var _asset := {}
var _rig: Node2D = null
## Without a rig: the box it is drawn as (a child, so looks can tint, scale and dissolve it).
var _box: Node2D = null
var _preview_clip := ""
## Seconds since the killing hit, and how its death runs: the death clip's (or the fallback's)
## length, then linger, then fade. `gone` once it has faded out (hidden, out of play).
var death_time := 0.0
var gone := false
var _death_clip := false
var _death_anim := DEATH_POP_TIME
var _death_linger := DEATH_LINGER
var _death_fade := DEATH_FADE
## The project's weapons by id, and how this enemy's held weapon is shown (weapon_view.gd).
var _weapons := {}
var _weapon_view: Node2D = null
var _shown_weapon := ""
var _clip_posed := false
## A clip a playAnimation plays (core art/animation.ts; "" = none), what follows it ("idle" | "hold"),
## and whether it ended and is held on its last frame.
var _anim_clip := ""
var _anim_then := "idle"
var _anim_held := false


func setup(character: Dictionary, bounds: Dictionary, spawn: Vector2, art: Dictionary = {}) -> void:
	character_id = character.id
	_states = character.behavior.states
	_interrupts = character.behavior.get("interrupts", [])
	behavior_state = character.behavior.initial
	flying = character.get("movement", "ground") == "flying"
	_knockback = float(character.stats.knockback)
	_contact_damage = int(character.stats.get("contactDamage", 1))
	_armor = clampf(float(character.stats.get("armor", 0.0)), 0.0, 1.0)
	_bounds = bounds
	max_health = int(character.stats.get("health", 3))
	health = max_health
	_size = Vector2(character.size.width, character.size.height)
	_color = Color(character.color)
	_gravity = float(bounds.gravity)
	_kill_y = float(bounds.height) + 400.0
	home = spawn
	position = spawn
	var death = character.get("death")
	if typeof(death) == TYPE_DICTIONARY:
		_death_linger = maxf(0.0, float(death.get("linger", DEATH_LINGER)))
		_death_fade = maxf(0.05, float(death.get("fade", DEATH_FADE)))

	collision_layer = 4
	collision_mask = 1 | preload("res://scripts/level.gd").ENEMY_BOUNDS_LAYER  # world, and the room's edges (doorways are for the player)

	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = _size
	shape.shape = box
	shape.position = Vector2(0, -_size.y / 2.0)
	add_child(shape)

	_asset = CharacterArt.asset_for(character, art)
	if not _asset.is_empty():
		_rig = CharacterArt.make_view(_asset, art)
		_rig.emit_markers = true
		_rig.marker.connect(_on_marker)
		add_child(_rig)
		_update_rig()
	var weapons = bounds.get("weapons")
	if typeof(weapons) == TYPE_DICTIONARY:
		for w in weapons.get("list", []):
			_weapons[str(w.id)] = w
	_weapon_view = WeaponView.new()
	add_child(_weapon_view)
	# Hold its weapon from the start (the first useWeapon in its behavior), not only once it first attacks.
	var held := _first_wielded_weapon(character)
	if not held.is_empty():
		_shown_weapon = str(held.id)
		_weapon_view.set_weapon(held, _rig)
	if _rig == null:
		_box = Node2D.new()
		_box.draw.connect(_draw_box)
		add_child(_box)
	_setup_look(art)


## Its look view: the rig (or box) it is drawn as, its body's rectangle, afterimages as rig copies.
func _setup_look(art: Dictionary) -> void:
	look = LookView.new()
	add_child(look)
	move_child(look, 0)
	var drawn: Node2D = _rig if _rig != null else _box
	look.setup(drawn, drawn, func(): return Rect2(Vector2(-_size.x / 2.0, -_size.y), _size))
	look.base_color = _color
	look.extras = [_weapon_view]
	if _rig != null:
		var asset := _asset
		look.ghost_maker = func(): return CharacterArt.make_view(asset, art)
	else:
		look.own_scale = true


func _physics_process(delta: float) -> void:
	if dead:
		_dying(delta)
		return
	if not _entered:
		_enter(behavior_state)

	var action: Dictionary = _states[behavior_state].action
	if flying:
		velocity.y = 0.0
	Registry.ACTIONS[action.type].tick(self, action, delta)
	if _recoil_time > 0.0:
		_recoil_time -= delta
		velocity.x = _recoil.x
		if flying:
			velocity.y = _recoil.y
	if _flash > 0.0:
		_flash -= delta
		if _flash <= 0.0:
			queue_redraw()

	if not flying and not is_on_floor() and not hold_air and not _hidden:
		velocity.y += _gravity * delta
	move_and_slide()
	state_time += delta

	_touch_player()
	_check_transitions()
	_update_rig()
	if _box != null:
		_box.queue_redraw()

	if shaking or _hidden or _attack != null:
		queue_redraw()
	if position.y > _kill_y:
		position = home
		velocity = Vector2.ZERO


func _check_transitions() -> void:
	for i in _interrupts.size():
		var interrupt: Dictionary = _interrupts[i]
		if interrupt.to != behavior_state and _holds(interrupt, 100 + i):
			_enter(interrupt.to)
			return
	var transitions: Array = _states[behavior_state].transitions
	for i in transitions.size():
		if _holds(transitions[i], i):
			_enter(transitions[i].to)
			return


func _holds(transition: Dictionary, index: int) -> bool:
	var conditions: Array = [transition.when] + transition.get("and", [])
	for j in conditions.size():
		current_transition = index * 10 + j
		if not Registry.CONDITIONS[conditions[j].type].check(self, conditions[j]):
			return false
	return true


func _enter(state_id: String) -> void:
	behavior_state = state_id
	state_time = 0.0
	_entered = true
	memory = {}
	phase = ""
	was_hit = false
	action_done = false
	shaking = false
	hold_air = false
	set_tint(null)
	show_attack(null)
	stop_weapon()
	if _hidden:
		appear(false)
	var action: Dictionary = _states[state_id].action
	Registry.ACTIONS[action.type].enter(self, action)
	if look != null:
		look.set_state_look(_states[state_id].get("look"))
	var main := _main()
	if main != null and main._mode == "play" and main._run.active:
		main._run.events.state_entered(spawn_id, character_id, state_id)


func _touch_player() -> void:
	if player == null or _hidden or (_knockback <= 0.0 and _contact_damage <= 0) or not rect().intersects(player.rect()):
		return
	var direction := signf(player.position.x - position.x)
	player.hit(direction if direction != 0.0 else facing, _knockback, _contact_damage)


## Struck by the player's sword (or weapon): flash, get pushed along `push` at `speed` px/s, maybe die.
func take_hit(damage: int, push: Vector2, speed := RECOIL_SPEED) -> void:
	if dead or _hidden:
		return
	health = maxi(0, health - damage)
	was_hit = true
	_flash = FLASH_TIME
	# Armor resists the push, not the damage.
	_recoil = push * speed * (1.0 - _armor)
	_recoil_time = RECOIL_TIME
	queue_redraw()
	if health == 0:
		_die(push)
		killed.emit()


## The killing hit: harmless and out of the fight at once (nothing touches, acts or can be hit;
## `dead` is what the room, the HUD and the sword go by), then the body plays out its death.
func _die(push: Vector2) -> void:
	dead = true
	_anim_clip = ""
	collision_layer = 0
	show_attack(null)
	stop_weapon()
	shaking = false
	hold_air = false
	phase = ""
	set_tint(null)
	if look != null:
		look.set_state_look(null)
	_recoil_time = 0.0
	_flash = DEATH_FLASH
	death_time = 0.0
	var resist := 1.0 - _armor
	velocity = Vector2(push.x * RECOIL_SPEED * resist, -DEATH_HOP * resist)
	_death_clip = _rig != null and _rig.has_clip("death")
	_death_anim = clampf(_rig.clip_duration("death"), 0.05, DEATH_CLIP_MAX) if _death_clip else DEATH_POP_TIME
	if _rig != null:
		_rig.position = Vector2.ZERO
		_rig.manual_time = true  # posed by death_time, so a hit-stop freezes the body too
		if _death_clip:
			_rig.play("death", true)
		elif _rig.has_clip("hurt"):
			_rig.play("hurt", true)
	if not _death_clip:
		_burst(14)
	_update_rig()
	queue_redraw()


## After the killing hit: fall and slide to a stop, play the death (clip or fallback), linger, fade, gone.
func _dying(delta: float) -> void:
	death_time += delta
	if _flash > 0.0:
		_flash -= delta
	velocity.x = move_toward(velocity.x, 0.0, DEATH_FRICTION * delta)
	if not is_on_floor():
		velocity.y += _gravity * delta  # flyers drop too
	move_and_slide()
	var fading := death_time - _death_anim - _death_linger
	if fading >= _death_fade or position.y > _kill_y:
		_remove_body()
		return
	if fading >= 0.0 and fading < delta and _death_clip:
		_burst(8)  # the drawn body dissolves as it fades
	modulate.a = 1.0 - clampf(fading / _death_fade, 0.0, 1.0)
	_update_rig()
	queue_redraw()
	if _box != null:
		_box.queue_redraw()


## Faded out: hidden and out of play (it stays listed as a dead entity until the room is rebuilt).
func _remove_body() -> void:
	gone = true
	visible = false
	velocity = Vector2.ZERO
	collision_mask = 0
	set_physics_process(false)


## Particles from its middle (the feedback effects' burst), in its body color.
func _burst(count: int) -> void:
	var main := _main()
	if main != null and main._fx != null:
		main._fx.burst(get_parent(), center(), _color, count, hash(spawn_id))


## The fallback death without a death clip, `death_time` in: [scale, darkening 0..1].
## A quick pop bigger, then it flattens and shrinks onto its feet and darkens.
func _fallback_pose() -> Array:
	var t := clampf(death_time / DEATH_POP_TIME, 0.0, 1.0)
	if t < 0.3:
		var k := t / 0.3
		return [Vector2.ONE.lerp(Vector2(1.18, 1.18), k), 0.0]
	var k := ease((t - 0.3) / 0.7, 0.5)
	return [Vector2(1.18, 1.18).lerp(Vector2(0.8, 0.35), k), k]


# --- actor API ---

func rect() -> Rect2:
	if _hidden:
		return Rect2(-1e6, -1e6, 0.0, 0.0)  # nothing can touch it
	return Rect2(position.x - _size.x / 2.0, position.y - _size.y, _size.x, _size.y)


func center() -> Vector2:
	return position - Vector2(0, _size.y / 2.0)


func gravity() -> float:
	return _gravity


func size() -> Vector2:
	return _size


## How hard its touch and attacks throw the player (the knockback stat).
func knockback() -> float:
	return _knockback


## Show an attack hitbox (world rect; null hides it): outlined while warning, filled while it hurts.
func show_attack(box, live := false, color := Color.WHITE) -> void:
	var shown = null if box == null else {"rect": Rect2(box.position - position, box.size), "live": live, "color": color}
	if shown != _attack:
		_attack = shown
		queue_redraw()


# --- wielding weapons (useWeapon; the wielder API of combat/weapon_runner.gd) ------------------

## Start an attack of a weapon: `attack_id` (null = its first), aimed as authored ("facing") or, for
## thrusts and projectiles, at the player ("player"). False when there is no such weapon or attack.
func start_weapon(weapon_id: String, attack_id, aim_mode: String) -> bool:
	var weapon: Dictionary = _weapons.get(weapon_id, {})
	var attack := {}
	for a in weapon.get("attacks", []):
		if attack_id == null or str(a.id) == str(attack_id):
			attack = a
			break
	if attack.is_empty():
		return false
	var aim := Vector2.RIGHT
	var shape := str(attack.shape.type)
	if aim_mode == "player" and player != null and shape in ["thrust", "projectile"]:
		var to: Vector2 = player.center() - center()
		if to.length() > 0.001:
			aim = Vector2(to.x * facing, to.y).normalized()
	weapon_runner = WeaponRunner.new(weapon, attack, aim)
	weapon_runner.view = _weapon_view
	if str(weapon.id) != _shown_weapon:
		_shown_weapon = str(weapon.id)
		_weapon_view.set_weapon(weapon, _rig)
	return true


## This frame of the weapon attack (its lunge, its hits); false once it is over. The windup flashes
## like any attack's warning.
func step_weapon() -> bool:
	if weapon_runner == null:
		return false
	var now: String = weapon_runner.current_phase()
	phase = now
	if now == "windup":
		Attack.warn(self, str(weapon_runner.weapon.get("art", {}).get("spark", "#fff2b0")))
	else:
		Attack.unwarn(self)
	var lunge: float = weapon_runner.lunge_now()
	if lunge > 0.0:
		velocity.x = facing * lunge
	if weapon_runner.step(self):
		return true
	phase = ""
	weapon_runner = null
	return false


## Leaving the state (or dying) ends the attack (a projectile still charging at its origin goes with it).
func stop_weapon() -> void:
	if weapon_runner != null:
		weapon_runner.drop()
	if weapon_runner != null and _weapon_view != null:
		_weapon_view.set_phase(weapon_runner.attack, "", weapon_runner.aim, facing)
	weapon_runner = null


func facing_sign() -> float:
	return facing


func weapon_targets() -> Array:
	return [player] if player != null and is_instance_valid(player) else []


func weapon_solids() -> Array:
	return []


func weapon_landed(attack: Dictionary, _point: Vector2, first: bool, _bounce: bool) -> void:
	if first:
		weapon_fired(attack)
	var main := _main()
	if main == null:
		return
	var stop := WeaponRunner.frames(float(attack.get("hitStop", 0.05)))
	if stop > 0:
		main.hit_stop(stop)
	var strength := float(attack.get("shake", 0.0))
	if strength > 0.0 and main._fx != null:
		main._fx.shake(strength, 0.2)


## Pushed back against its facing (recoil), when it hits or fires.
func weapon_fired(attack: Dictionary) -> void:
	var speed := float(attack.get("movement", {}).get("recoil", 0.0))
	if speed > 0.0:
		_recoil = Vector2(-facing * speed, 0.0)
		_recoil_time = RECOIL_TIME


func weapon_texture(ref) -> Texture2D:
	var main := _main()
	var texture = main._textures.get(str(ref)) if main != null and ref != null else null
	return texture if texture is Texture2D else null


## Teleport: vanish, marking where it will appear.
func vanish(at: Vector2, color: Color) -> void:
	_hidden = true
	_marker = at
	_marker_color = color
	velocity = Vector2.ZERO
	if _rig != null:
		_rig.visible = false
	if _weapon_view != null:
		_weapon_view.visible = false  # its weapon vanishes with it
	queue_redraw()


## Reappear: at the marker, or where it vanished when `move` is false.
func appear(move := true) -> void:
	_hidden = false
	if move:
		position = _marker
	velocity = Vector2.ZERO
	if _rig != null:
		_rig.visible = true
	if _weapon_view != null:
		_weapon_view.show_held()  # back in hand, at the new spot
	queue_redraw()


## `spot` (feet) kept inside the room and out of solids, else where it stands now.
func free_spot(spot: Vector2) -> Vector2:
	var half := _size.x / 2.0
	spot.x = clampf(spot.x, half, maxf(half, float(_bounds.get("width", spot.x + half)) - half))
	var body := Rect2(spot - Vector2(half, _size.y), _size).grow(-2.0)
	for corner in [body.position, body.end, Vector2(body.position.x, body.end.y), Vector2(body.end.x, body.position.y)]:
		if Attack.solid_at(self, corner):
			return position
	return spot


## Call up to `count` enemies of `character_id` beside itself, keeping at most `cap` of them alive.
func summon(character_id: String, count: int, cap: int) -> void:
	summons = summons.filter(func(s): return is_instance_valid(s) and not s.dead)
	var main := _main()
	if main == null:
		return
	var character = null
	for c in main._project.characters:
		if c.id == character_id and c.kind == "enemy":
			character = c
	if character == null:
		return
	for i in mini(count, cap - summons.size()):
		var side := facing if i % 2 == 0 else -facing
		var gap := (_size.x + float(character.size.width)) / 2.0 + 8.0
		var spot := free_spot(position + Vector2(side * gap * (floorf(i / 2.0) + 1.0), 0.0))
		var minion: CharacterBody2D = get_script().new()
		minion.setup(character, _bounds, spot, main._project.get("art", {}))
		minion.spawn_id = "%s/%d" % [spawn_id, _summoned]
		minion.player = player
		minion.rng.seed = rng.randi()
		_summoned += 1
		get_parent().add_child(minion)
		if player != null:
			player.enemies.append(minion)
			if main._run.active:
				minion.killed.connect(main._run.on_enemy_killed.bind(minion.spawn_id, str(character.id)))
		summons.append(minion)


## A small camera shake (a slam landing), through the feedback effects.
func shake_screen(strength: float, seconds: float) -> void:
	var main := _main()
	if main != null and main._fx != null:
		main._fx.shake(strength, seconds)


## main.gd: enemies live under its world (or a Rooms-stage view).
func _main() -> Node:
	var world := get_parent()
	var main: Node = world.get_parent() if world != null else null
	return main if main != null and "_project" in main else null


## True when standing on the ground with nothing solid just ahead.
func ledge_ahead() -> bool:
	if not is_on_floor():
		return false
	var from := position + Vector2(facing * (_size.x / 2.0 + 4.0), -4.0)
	var query := PhysicsRayQueryParameters2D.create(from, from + Vector2(0, 24), 1)
	return get_world_2d().direct_space_state.intersect_ray(query).is_empty()


func can_see_player() -> bool:
	if player == null:
		return false
	var query := PhysicsRayQueryParameters2D.create(center(), player.center(), 1)
	return get_world_2d().direct_space_state.intersect_ray(query).is_empty()


func player_position():
	return player.center() if player != null else null


func distance_to_player() -> float:
	return center().distance_to(player.center()) if player != null else INF


func face(direction: float) -> void:
	if direction != 0.0 and direction != facing:
		facing = direction
		queue_redraw()


func face_player() -> void:
	if player != null:
		face(signf(player.position.x - position.x))


func set_tint(tint) -> void:
	if tint != _tint:
		_tint = tint
		queue_redraw()


## Edit-mode clip preview ("" = follow the behavior).
func set_preview_clip(clip: String) -> void:
	_preview_clip = clip
	_update_rig()


# --- animation in play (core art/animation.ts) -------------------------------------------------

## playAnimation: play `clip` from its start over whatever the behavior plays, then go back to the
## usual clips ("idle") or hold its last frame ("hold"). False (ignored) without such a clip.
func play_animation(clip: String, then := "idle") -> bool:
	if _rig == null or dead or not _rig.has_clip(clip):
		return false
	_anim_clip = clip
	_anim_then = then
	_anim_held = false
	if _clip_posed:
		_rig.manual_time = false
		_clip_posed = false
	_rig.play(clip, true)
	return true


## The clip a playAnimation is playing (until it ends), else null (state: entities[].playing).
func anim_playing() -> Variant:
	return _anim_clip if _anim_clip != "" and not _anim_held else null


## Any clip it plays crossed a marker: a `marker` event from this spawn.
func _on_marker(marker_name: String, _clip: String) -> void:
	var main := _main()
	if main != null and main._mode == "play" and main._run.active:
		main._run.events.marker(marker_name, {"source": "spawn:" + spawn_id, "spawn": spawn_id})


func _update_rig() -> void:
	if _rig == null:
		return
	if dead:
		_update_dying_rig()
		return
	_rig.scale = Vector2(facing, 1.0) * (look.scale_factor() if look != null else 1.0)
	# Same feedback as the box: shake in place, flash white when struck, tint while telegraphing.
	_rig.position.x = ((2.0 if int(state_time * 30.0) % 2 == 0 else -2.0) if shaking else 0.0)
	if look != null:
		look.flashing = _flash > 0.0
	if _flash > 0.0:
		_rig.modulate = Color(2.5, 2.5, 2.5)
	elif _tint != null:
		_rig.modulate = Color.WHITE.lerp(_tint, 0.65)
	else:
		_rig.modulate = Color.WHITE
	if _preview_clip != "":
		_rig.play(_preview_clip)
		return
	if _anim_clip != "":
		_rig.play(_anim_clip)
		if _rig.clip_ended() and not _anim_held:
			if _anim_then == "hold":
				_anim_held = true
			else:
				_anim_clip = ""
		if _anim_clip != "":
			return
	var mapped = _asset.get("stateClips", {}).get(behavior_state)
	if weapon_runner != null and not (mapped != null and _rig.has_clip(str(mapped))):
		_clip_posed = weapon_runner.pose_rig(_rig, CharacterArt.first_clip)
		return
	if _clip_posed:
		_rig.manual_time = false
		_clip_posed = false
	if _flash > 0.0 and _rig.has_clip("hurt"):
		_rig.play("hurt")
		return
	var state = _states.get(behavior_state)
	var action_type: String = str(state.action.type) if state != null else ""
	_rig.play(CharacterArt.clip_for_state(_asset, _rig, behavior_state, action_type, flying, phase))


## Dying: the death clip posed at death_time (held on its last frame), or the fallback pop and
## collapse on whatever clip it had (hurt when there is one); white while the killing flash lasts.
func _update_dying_rig() -> void:
	_rig.position = Vector2.ZERO
	var white := _flash > 0.0
	if look != null:
		look.flashing = white
	if _death_clip:
		_rig.scale = Vector2(facing, 1.0) * (look.scale_factor() if look != null else 1.0)
		_rig.modulate = Color(2.5, 2.5, 2.5) if white else Color.WHITE
		_rig.pose_at(minf(death_time, _death_anim), int(death_time * 8.0))
		return
	var pose := _fallback_pose()
	_rig.scale = Vector2(facing * pose[0].x, pose[0].y)
	_rig.modulate = Color(2.5, 2.5, 2.5) if white else Color.WHITE.lerp(Color(0.35, 0.35, 0.4), pose[1])
	if _rig.current_clip() == "hurt":
		_rig.pose_at(minf(death_time, _rig.clip_duration("hurt")), int(death_time * 8.0))


func _draw() -> void:
	if dead:
		return
	if _attack != null:
		var box: Rect2 = _attack.rect
		var color: Color = _attack.color
		if _attack.live:
			draw_rect(box, Color(color, 0.55))
		draw_rect(box, Color(color, 0.9 if _attack.live else 0.5), false, 2.0)
	if _hidden:
		var pulse := 0.35 + 0.3 * absf(sin(state_time * 12.0))
		var marker := Rect2(_marker - position - Vector2(_size.x / 2.0, _size.y), _size)
		draw_rect(marker, Color(_marker_color, pulse * 0.5))
		draw_rect(marker, Color(_marker_color, pulse + 0.3), false, 2.0)


## Without a rig: the box it is drawn as (the `_box` child; looks tint, scale and dissolve it).
func _draw_box() -> void:
	if look != null:
		look.flashing = _flash > 0.0
	if dead:
		var pose := _fallback_pose()
		_box.draw_set_transform(Vector2.ZERO, 0.0, pose[0])
		var body := Color.WHITE if _flash > 0.0 else _color.lerp(Color(0.1, 0.1, 0.13), pose[1] * 0.6)
		_box.draw_rect(Rect2(Vector2(-_size.x / 2.0, -_size.y), _size), body)
		_box.draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
		return
	if _hidden:
		return
	var offset := Vector2((2.0 if int(state_time * 30.0) % 2 == 0 else -2.0) if shaking else 0.0, 0.0)
	var body = Color.WHITE if _flash > 0.0 else (_tint if _tint != null else _color)
	_box.draw_rect(Rect2(offset + Vector2(-_size.x / 2.0, -_size.y), _size), body)
	_box.draw_rect(Rect2(offset + Vector2(facing * _size.x * 0.25 - 3.0, -_size.y * 0.75), Vector2(6.0, 6.0)), Color("#ffd27a"))


## The weapon this enemy attacks with first (its first useWeapon action, in state order), else {}.
func _first_wielded_weapon(character: Dictionary) -> Dictionary:
	var states = character.get("behavior", {}).get("states", {})
	var initial := str(character.get("behavior", {}).get("initial", ""))
	var order: Array = [initial] if states.has(initial) else []
	for id in states:
		if str(id) != initial:
			order.append(id)
	for id in order:
		var action = states[id].get("action", {})
		if str(action.get("type", "")) == "useWeapon" and _weapons.has(str(action.get("weapon", ""))):
			return _weapons[str(action.get("weapon", ""))]
	return {}
