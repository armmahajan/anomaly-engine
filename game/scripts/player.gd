extends CharacterBody2D
## Player controller. All tuning values come from the project spec.
## Origin is at the feet (bottom-centre), matching spawn coordinates.

var character_id := ""
var spawn_id := ""
var camera: Camera2D
## "hurt" while recovering from a hit (reported to the studio), else null.
var behavior_state = null

const INVULNERABLE_TIME := 0.7
const STUN_TIME := 0.25
const STUN_FRICTION := 1400.0

var _run_speed := 0.0
var _jump_velocity := 0.0
var _gravity := 0.0
var _size := Vector2.ZERO
var _color := Color.WHITE
var _spawn := Vector2.ZERO
var _kill_y := 0.0
var _facing := 1.0
var _invulnerable := 0.0
var _stun := 0.0


func setup(character: Dictionary, sandbox: Dictionary, spawn: Vector2) -> void:
	character_id = character.id
	_run_speed = float(character.stats.runSpeed)
	_jump_velocity = float(character.stats.jumpVelocity)
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
	var was_hurt := behavior_state != null
	behavior_state = "hurt" if _invulnerable > 0.0 else null
	if was_hurt or behavior_state != null:
		queue_redraw()  # blink while invulnerable

	if _stun > 0.0:
		# Knocked back: no control until the stun wears off.
		velocity.x = move_toward(velocity.x, 0.0, STUN_FRICTION * delta)
	else:
		var direction := Input.get_axis("move_left", "move_right")
		velocity.x = direction * _run_speed
		if direction != 0.0 and signf(direction) != _facing:
			_facing = signf(direction)
			queue_redraw()

		if Input.is_action_just_pressed("jump") and is_on_floor():
			velocity.y = -_jump_velocity
		if Input.is_action_just_released("jump") and velocity.y < 0.0:
			velocity.y *= 0.5  # short hop when jump is released early

	move_and_slide()

	if position.y > _kill_y:
		position = _spawn
		velocity = Vector2.ZERO


## Called by enemies on contact. Ignored while invulnerable.
func hit(direction: float, knockback: float) -> void:
	if _invulnerable > 0.0:
		return
	velocity = Vector2(direction * knockback, -knockback * 0.45)
	_invulnerable = INVULNERABLE_TIME
	_stun = STUN_TIME
	behavior_state = "hurt"
	queue_redraw()


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
