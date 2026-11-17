extends Node2D
## Play-mode HUD: the player's health as a row of pips, and a titled health
## bar for every enemy alive in the current room whose spawn asks for one
## (spawn.healthBar), stacked in spawn order from the top.

var player: Node2D = null
## main.gd (the current room and its enemies: main._run.current_room(), main._world).
var main: Node = null

const BAR_WIDTH := 360.0
const BAR_HEIGHT := 10.0
const BAR_GAP := 40.0
const BAR_TOP := 30.0


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
	var font := ThemeDB.fallback_font
	var bars := _bars()
	for i in bars.size():
		var enemy: Node = bars[i].enemy
		var left := (get_viewport_rect().size.x - BAR_WIDTH) / 2.0
		var top := BAR_TOP + i * BAR_GAP
		draw_string(font, Vector2(left, top - 4.0), bars[i].title, HORIZONTAL_ALIGNMENT_CENTER, BAR_WIDTH, 14, Color("#e8e3d3"))
		var frame := Rect2(left, top, BAR_WIDTH, BAR_HEIGHT)
		draw_rect(frame.grow(2.0), Color(0, 0, 0, 0.6))
		var share := float(enemy.health) / maxf(1.0, float(enemy.max_health))
		draw_rect(Rect2(frame.position, Vector2(BAR_WIDTH * share, BAR_HEIGHT)), Color("#c0504d"))
		draw_rect(frame, Color("#e8e3d3", 0.7), false, 1.0)


## Spawn ids of the enemy health bars on screen, top first.
func health_bars() -> Array:
	return _bars().map(func(bar): return bar.enemy.spawn_id)


## [{enemy, title}] for each living enemy of the current room whose spawn has a health bar.
func _bars() -> Array:
	if main == null or main._run == null or not main._run.active or main._world == null:
		return []
	var enemies := {}
	for child in main._world.get_children():
		if child is CharacterBody2D and "dead" in child and not child.dead and child != main._player:
			enemies[child.spawn_id] = child
	var out := []
	for spawn in main._run.current_room().get("spawns", []):
		var bar = spawn.get("healthBar")
		if typeof(bar) == TYPE_DICTIONARY and enemies.has(spawn.id):
			out.append({"enemy": enemies[spawn.id], "title": str(bar.get("title", ""))})
	return out
