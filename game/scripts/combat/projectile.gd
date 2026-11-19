extends Node2D
## An enemy's shot (the shoot primitive): flies, falls with `gravity`, breaks
## on a solid, on the player (hurting them) or when its lifetime runs out.
## A pogo shot is one of the player's sword targets: a downward strike
## bounces off it and breaks it.
##
## Its look (core art/animation.ts ProjectileLook): with `appear: windup` it is made at the start of
## the windup and sits `charging` at its origin on the shooter (following it, harmless) until the
## shot fires (`launch`); with object `art` it is drawn as that object (charge, then fly; burst plays
## as an effect where it breaks), else as today's coloured ball.

const Attack := preload("res://scripts/combat/attack.gd")
const ProjectileView := preload("res://scripts/art/projectile_view.gd")
const RADIUS := 8.0

var velocity := Vector2.ZERO
var gravity := 0.0
var life := 3.0
var damage := 1
var knockback := 0.0
var pogo := false
var color := Color.WHITE
var player: Node2D = null
## Who shot it (enemy.gd; its spawn id is the state's `owner`) and the look's art ({object, charge,
## fly, burst} or null).
var shooter: Node2D = null
var art = null
## Charging: at `look_origin` (shooter space, facing right) on its shooter until launched; harmless.
var charging := false
var look_origin := Vector2.ZERO
## The shooter's state memory when it started charging: a new state (an interrupt) drops the shot.
var charge_memory = null

var _view: Node2D = null
var _owner_id := ""


func _ready() -> void:
	z_index = 2
	add_to_group("projectiles")
	if shooter != null and "spawn_id" in shooter:
		_owner_id = str(shooter.spawn_id)
	_view = ProjectileView.object_for(self, art, "charge" if charging else "fly")
	if charging:
		_follow()
	if pogo and player != null:
		player.targets.append(self)


func _exit_tree() -> void:
	if player != null and is_instance_valid(player):
		player.targets.erase(self)


## Leave the shooter: fly at `v` from where it is now.
func launch(v: Vector2) -> void:
	charging = false
	velocity = v
	_follow_flight()
	if _view != null:
		ProjectileView.play_part(_view, art, "fly")


func _physics_process(delta: float) -> void:
	if charging:
		if shooter == null or not is_instance_valid(shooter) or shooter.dead or not is_same(shooter.memory, charge_memory):
			queue_free()
			return
		_follow()
		return
	velocity.y += gravity * delta
	position += velocity * delta
	life -= delta
	_follow_flight()
	if life <= 0.0 or Attack.solid_at(self, position):
		_break()
	elif Attack.hurt(player, rect(), position.x - velocity.x, signf(velocity.x), damage, knockback):
		_break()


## At its origin on the shooter, mirrored when it faces left.
func _follow() -> void:
	var facing: float = shooter.facing
	position = shooter.center() + Vector2(look_origin.x * facing, look_origin.y)
	if _view != null:
		_view.rotation = 0.0
		_view.scale.x = absf(_view.scale.x) * (-1.0 if facing < 0.0 else 1.0)


func _follow_flight() -> void:
	if _view != null:
		_view.scale.x = absf(_view.scale.x)
		if velocity.length() > 1.0:
			_view.rotation = velocity.angle()


## Gone: its burst (art) plays where it broke.
func _break() -> void:
	ProjectileView.burst(self, art, position, _view.rotation if _view != null else 0.0)
	queue_free()


func rect() -> Rect2:
	return Rect2(position - Vector2(RADIUS, RADIUS), Vector2(RADIUS, RADIUS) * 2.0)


## Player sword target: only a pogo shot answers, and only to a downward strike (not while charging).
func struck(_damage: int, push: Vector2) -> bool:
	if not pogo or charging or push != Vector2.DOWN or is_queued_for_deletion():
		return false
	queue_free()
	return true


## The runtime state's projectiles entry.
func describe() -> Dictionary:
	return {"x": position.x, "y": position.y, "charging": charging, "object": str(art.object) if typeof(art) == TYPE_DICTIONARY else null, "owner": _owner_id}


func _draw() -> void:
	if _view != null:
		return
	draw_circle(Vector2.ZERO, RADIUS, color)
	draw_circle(Vector2.ZERO, RADIUS * 0.45, Color.WHITE if pogo else color.lightened(0.5))
