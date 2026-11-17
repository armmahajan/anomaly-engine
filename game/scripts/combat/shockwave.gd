extends Node2D
## A slam's shockwave: runs along the ground from the landing spot (origin at
## its foot) until it has covered `reach` px, meets a wall or the ground ends.
## Low enough to jump over.

const Attack := preload("res://scripts/combat/attack.gd")
const WIDTH := 24.0

var direction := 1.0
var speed := 500.0
var reach := 400.0
var height := 28.0
var damage := 1
var knockback := 0.0
var color := Color.WHITE
var player: Node2D = null
var _traveled := 0.0


func _ready() -> void:
	z_index = 2


func _physics_process(delta: float) -> void:
	var step := speed * delta
	position.x += direction * step
	_traveled += step
	var wall := Attack.solid_at(self, position + Vector2(direction * WIDTH / 2.0, -height / 2.0))
	var ground := Attack.solid_at(self, position + Vector2(0.0, 4.0))
	if _traveled >= reach or wall or not ground:
		queue_free()
		return
	Attack.hurt(player, rect(), position.x - direction, direction, damage, knockback)
	queue_redraw()


func rect() -> Rect2:
	return Rect2(position.x - WIDTH / 2.0, position.y - height, WIDTH, height)


func _draw() -> void:
	var fade := clampf(1.0 - _traveled / maxf(reach, 1.0), 0.3, 1.0)
	var back := -direction * WIDTH / 2.0
	var front := direction * WIDTH / 2.0
	draw_colored_polygon(PackedVector2Array([Vector2(back, 0), Vector2(back * 0.3, -height), Vector2(front, 0)]), Color(color, fade))
