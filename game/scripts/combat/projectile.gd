extends Node2D
## An enemy's shot (the shoot primitive): flies, falls with `gravity`, breaks
## on a solid, on the player (hurting them) or when its lifetime runs out.
## A pogo shot is one of the player's sword targets: a downward strike
## bounces off it and breaks it.

const Attack := preload("res://scripts/combat/attack.gd")
const RADIUS := 8.0

var velocity := Vector2.ZERO
var gravity := 0.0
var life := 3.0
var damage := 1
var knockback := 0.0
var pogo := false
var color := Color.WHITE
var player: Node2D = null


func _ready() -> void:
	z_index = 2
	if pogo and player != null:
		player.targets.append(self)


func _exit_tree() -> void:
	if player != null and is_instance_valid(player):
		player.targets.erase(self)


func _physics_process(delta: float) -> void:
	velocity.y += gravity * delta
	position += velocity * delta
	life -= delta
	if life <= 0.0 or Attack.solid_at(self, position):
		queue_free()
	elif Attack.hurt(player, rect(), position.x - velocity.x, signf(velocity.x), damage, knockback):
		queue_free()


func rect() -> Rect2:
	return Rect2(position - Vector2(RADIUS, RADIUS), Vector2(RADIUS, RADIUS) * 2.0)


## Player sword target: only a pogo shot answers, and only to a downward strike.
func struck(_damage: int, push: Vector2) -> bool:
	if not pogo or push != Vector2.DOWN or is_queued_for_deletion():
		return false
	queue_free()
	return true


func _draw() -> void:
	draw_circle(Vector2.ZERO, RADIUS, color)
	draw_circle(Vector2.ZERO, RADIUS * 0.45, Color.WHITE if pogo else color.lightened(0.5))
