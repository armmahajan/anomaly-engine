extends CharacterBody2D
## Generic enemy: runs whatever behavior state machine the project defines.
## No enemy-specific code lives here; primitives do the work
## (see res://primitives/registry.gd). Origin is at the feet.

const Registry := preload("res://primitives/registry.gd")
const CharacterArt := preload("res://scripts/art/character_art.gd")
const Attack := preload("res://scripts/combat/attack.gd")

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

const FLASH_TIME := 0.1
const RECOIL_SPEED := 260.0
const RECOIL_TIME := 0.1

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
var _preview_clip := ""


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

	collision_layer = 4
	collision_mask = 1  # world only

	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = _size
	shape.shape = box
	shape.position = Vector2(0, -_size.y / 2.0)
	add_child(shape)

	_asset = CharacterArt.asset_for(character, art)
	if not _asset.is_empty():
		_rig = CharacterArt.make_view(_asset, art)
		add_child(_rig)
		_update_rig()


func _physics_process(delta: float) -> void:
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
	if _hidden:
		appear(false)
	var action: Dictionary = _states[state_id].action
	Registry.ACTIONS[action.type].enter(self, action)


func _touch_player() -> void:
	if player == null or _hidden or (_knockback <= 0.0 and _contact_damage <= 0) or not rect().intersects(player.rect()):
		return
	var direction := signf(player.position.x - position.x)
	player.hit(direction if direction != 0.0 else facing, _knockback, _contact_damage)


## Struck by the player's sword: flash, get pushed along `push`, maybe die.
func take_hit(damage: int, push: Vector2) -> void:
	if dead or _hidden:
		return
	health = maxi(0, health - damage)
	was_hit = true
	_flash = FLASH_TIME
	# Armor resists the push, not the damage.
	_recoil = push * RECOIL_SPEED * (1.0 - _armor)
	_recoil_time = RECOIL_TIME
	queue_redraw()
	if health == 0:
		dead = true
		visible = false
		collision_layer = 0
		set_physics_process(false)
		show_attack(null)
		killed.emit()


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


## Teleport: vanish, marking where it will appear.
func vanish(at: Vector2, color: Color) -> void:
	_hidden = true
	_marker = at
	_marker_color = color
	velocity = Vector2.ZERO
	if _rig != null:
		_rig.visible = false
	queue_redraw()


## Reappear: at the marker, or where it vanished when `move` is false.
func appear(move := true) -> void:
	_hidden = false
	if move:
		position = _marker
	velocity = Vector2.ZERO
	if _rig != null:
		_rig.visible = true
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


func _update_rig() -> void:
	if _rig == null:
		return
	_rig.scale.x = facing
	# Same feedback as the box: shake in place, flash white when struck, tint while telegraphing.
	_rig.position.x = ((2.0 if int(state_time * 30.0) % 2 == 0 else -2.0) if shaking else 0.0)
	if _flash > 0.0:
		_rig.modulate = Color(2.5, 2.5, 2.5)
	elif _tint != null:
		_rig.modulate = Color.WHITE.lerp(_tint, 0.65)
	else:
		_rig.modulate = Color.WHITE
	if _preview_clip != "":
		_rig.play(_preview_clip)
		return
	if _flash > 0.0 and _rig.has_clip("hurt"):
		_rig.play("hurt")
		return
	var state = _states.get(behavior_state)
	var action_type: String = str(state.action.type) if state != null else ""
	_rig.play(CharacterArt.clip_for_state(_asset, _rig, behavior_state, action_type, flying, phase))


func _draw() -> void:
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
		return
	if _rig != null:
		return
	var offset := Vector2((2.0 if int(state_time * 30.0) % 2 == 0 else -2.0) if shaking else 0.0, 0.0)
	var body = Color.WHITE if _flash > 0.0 else (_tint if _tint != null else _color)
	draw_rect(Rect2(offset + Vector2(-_size.x / 2.0, -_size.y), _size), body)
	draw_rect(Rect2(offset + Vector2(facing * _size.x * 0.25 - 3.0, -_size.y * 0.75), Vector2(6.0, 6.0)), Color("#ffd27a"))
