extends CharacterBody2D
## Generic enemy: runs whatever behavior state machine the project defines.
## No enemy-specific code lives here; primitives do the work
## (see res://primitives/registry.gd). Origin is at the feet.

const Registry := preload("res://primitives/registry.gd")

var character_id := ""
var spawn_id := ""
## Current behavior state id (reported to the studio).
var behavior_state := ""

# --- actor API used by primitives ---
var facing := 1.0
var home := Vector2.ZERO
var state_time := 0.0
var player: Node2D = null

var _states: Dictionary = {}
var _entered := false
var _knockback := 0.0
var _gravity := 0.0
var _size := Vector2.ZERO
var _color := Color.WHITE
var _tint = null  # Color or null
var _kill_y := 0.0


func setup(character: Dictionary, sandbox: Dictionary, spawn: Vector2) -> void:
	character_id = character.id
	_states = character.behavior.states
	behavior_state = character.behavior.initial
	_knockback = float(character.stats.knockback)
	_size = Vector2(character.size.width, character.size.height)
	_color = Color(character.color)
	_gravity = float(sandbox.gravity)
	_kill_y = float(sandbox.height) + 400.0
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


func _physics_process(delta: float) -> void:
	if not _entered:
		_enter(behavior_state)

	var action: Dictionary = _states[behavior_state].action
	Registry.ACTIONS[action.type].tick(self, action, delta)

	if not is_on_floor():
		velocity.y += _gravity * delta
	move_and_slide()
	state_time += delta

	_touch_player()
	_check_transitions()

	if position.y > _kill_y:
		position = home
		velocity = Vector2.ZERO


func _check_transitions() -> void:
	for transition in _states[behavior_state].transitions:
		var condition: Dictionary = transition.when
		if Registry.CONDITIONS[condition.type].check(self, condition):
			_enter(transition.to)
			return


func _enter(state_id: String) -> void:
	behavior_state = state_id
	state_time = 0.0
	_entered = true
	set_tint(null)
	var action: Dictionary = _states[state_id].action
	Registry.ACTIONS[action.type].enter(self, action)


func _touch_player() -> void:
	if player == null or _knockback <= 0.0 or not rect().intersects(player.rect()):
		return
	var direction := signf(player.position.x - position.x)
	player.hit(direction if direction != 0.0 else facing, _knockback)


# --- actor API ---

func rect() -> Rect2:
	return Rect2(position.x - _size.x / 2.0, position.y - _size.y, _size.x, _size.y)


func center() -> Vector2:
	return position - Vector2(0, _size.y / 2.0)


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


func _draw() -> void:
	draw_rect(Rect2(-_size.x / 2.0, -_size.y, _size.x, _size.y), _tint if _tint != null else _color)
	draw_rect(Rect2(facing * _size.x * 0.25 - 3.0, -_size.y * 0.75, 6.0, 6.0), Color("#ffd27a"))
