extends CharacterBody2D
## Player controller. All tuning values come from the project spec.
## Origin is at the feet (bottom-centre), matching spawn coordinates.

## A sword hit connected (main.gd freezes the world briefly: hit-stop).
signal landed_hit
signal died

var character_id := ""
var spawn_id := ""
var camera: Camera2D
## "slash_<direction>" while swinging, "hurt" while invulnerable, else null (reported to the studio).
var behavior_state = null
var health := 0
var max_health := 0
## Set by main.gd: everything the sword can hit.
var enemies: Array = []

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


func setup(character: Dictionary, sandbox: Dictionary, spawn: Vector2) -> void:
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
	_size = Vector2(character.size.width, character.size.height)
	_color = Color(character.color)
	_gravity = float(sandbox.gravity)
	_spawn = spawn
	_kill_y = float(sandbox.height) + 400.0
	position = spawn

	collision_layer = 2
	collision_mask = 1  # world only; characters pass through each other for now

	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = _size
	shape.shape = box
	shape.position = Vector2(0, -_size.y / 2.0)
	add_child(shape)

	camera = Camera2D.new()
	camera.position = Vector2(0, -_size.y / 2.0)
	camera.limit_left = 0
	camera.limit_top = 0
	camera.limit_right = int(sandbox.width)
	camera.limit_bottom = int(sandbox.height)
	camera.position_smoothing_enabled = true
	camera.position_smoothing_speed = 8.0
	add_child(camera)


func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += _gravity * delta

	_invulnerable = maxf(0.0, _invulnerable - delta)
	_stun = maxf(0.0, _stun - delta)
	_cooldown = maxf(0.0, _cooldown - delta)
	_recoil = maxf(0.0, _recoil - delta)
	if _slash != "":
		_slash_time -= delta
		if _slash_time <= 0.0:
			_slash = ""
			queue_redraw()

	if _stun > 0.0:
		# Knocked back: no control until the stun wears off.
		velocity.x = move_toward(velocity.x, 0.0, STUN_FRICTION * delta)
	else:
		var direction := Input.get_axis("move_left", "move_right")
		velocity.x = direction * _run_speed
		if direction != 0.0 and signf(direction) != _facing:
			_facing = signf(direction)
			queue_redraw()
		if _recoil > 0.0:
			velocity.x = _recoil_direction * RECOIL_SPEED

		if Input.is_action_just_pressed("jump") and is_on_floor():
			velocity.y = -_jump_velocity
		if Input.is_action_just_released("jump") and velocity.y < 0.0:
			velocity.y *= 0.5  # short hop when jump is released early
		if Input.is_action_just_pressed("attack") and _cooldown <= 0.0:
			_start_slash()

	move_and_slide()
	if _slash != "":
		_strike()

	var shown = ("slash_" + _slash) if _slash != "" else ("hurt" if _invulnerable > 0.0 else null)
	if shown != behavior_state or _invulnerable > 0.0:
		queue_redraw()  # blink while invulnerable
	behavior_state = shown

	if position.y > _kill_y:
		position = _spawn
		velocity = Vector2.ZERO


func _start_slash() -> void:
	if Input.is_action_pressed("aim_up"):
		_slash = "up"
	elif Input.is_action_pressed("aim_down") and not is_on_floor():
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
	if not landed:
		return
	match _slash:
		"down":
			velocity.y = -_pogo_velocity
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


## Called by enemies on contact. Ignored while invulnerable.
func hit(direction: float, knockback: float, damage: int) -> void:
	if _invulnerable > 0.0 or health <= 0:
		return
	health = maxi(0, health - damage)
	velocity = Vector2(direction * knockback, -knockback * 0.45)
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
	draw_rect(Rect2(-_size.x / 2.0, -_size.y, _size.x, _size.y), color)
	draw_rect(Rect2(_facing * _size.x * 0.18 - 3.0, -_size.y * 0.8, 6.0, 6.0), Color.BLACK)
	if _slash != "":
		var area := slash_rect()
		area.position -= position
		draw_rect(area, Color(1, 1, 1, 0.35))
		draw_rect(area, Color(1, 1, 1, 0.9), false, 2.0)
