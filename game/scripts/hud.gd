extends Node2D
## Play-mode HUD: the player's health as a row of pips.

var player: Node2D = null


func _process(_delta: float) -> void:
	queue_redraw()


func _draw() -> void:
	if player == null:
		return
	for i in player.max_health:
		var at := Vector2(28.0 + i * 26.0, 28.0)
		if i < player.health:
			draw_circle(at, 9.0, Color("#e8e3d3"))
		else:
			draw_arc(at, 9.0, 0.0, TAU, 24, Color("#e8e3d3", 0.45), 2.0)
