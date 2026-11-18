extends Node2D
## Play-mode HUD: the player's health as a row of pips, the items they hold (icon or color, and count) under it,
## the weapons in their loadout slots (with ammo counts) under those, and a titled health
## bar for every enemy alive in the current room whose spawn asks for one
## (spawn.healthBar), stacked in spawn order from the top.

var player: Node2D = null
## main.gd (the current room and its enemies: main._run.current_room(), main._world).
var main: Node = null

const BAR_WIDTH := 360.0
const BAR_HEIGHT := 10.0
const BAR_GAP := 40.0
const BAR_TOP := 30.0
## The held items row, under the health pips.
const ITEM_TOP := 46.0
const ITEM_SIZE := 22.0
## The weapon rows (loadout slots holding a weapon, with their ammo), under the items.
const WEAPON_TOP := 86.0


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
	_draw_items(font)
	_draw_weapons(font)
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


## [{id, count, icon}] for the items the player holds, in the game's item order (the items row; `icon`: drawn with its picture).
func held_items() -> Array:
	if main == null or main._run == null or not main._run.active:
		return []
	var held: Dictionary = main._run.events.items
	var out := []
	for item in main._project.get("world", {}).get("items", []):
		var count := int(held.get(item.id, 0))
		if count > 0:
			out.append({"id": str(item.id), "count": count, "icon": _icon(item) != null})
	return out


func _icon(item: Dictionary) -> Texture2D:
	var ref = item.get("icon")
	var texture = main._textures.get(str(ref)) if ref != null else null
	return texture if texture is Texture2D else null


## The held items under the health pips: each its icon (or a swatch of its color) and its count.
func _draw_items(font: Font) -> void:
	var items := {}
	for item in main._project.get("world", {}).get("items", []):
		items[str(item.id)] = item
	var x := 18.0
	for held in held_items():
		var item: Dictionary = items[held.id]
		var box := Rect2(x, ITEM_TOP, ITEM_SIZE, ITEM_SIZE)
		var icon := _icon(item)
		if icon != null:
			var size := Vector2(icon.get_width(), icon.get_height()) * (ITEM_SIZE / maxf(icon.get_width(), icon.get_height()))
			draw_texture_rect(icon, Rect2(box.get_center() - size / 2.0, size), false)
		else:
			draw_rect(box.grow(-3.0), Color(str(item.get("color", "#e8c547"))))
			draw_rect(box.grow(-3.0), Color("#e8e3d3", 0.6), false, 1.0)
		var label := "×%d" % held.count
		var at := Vector2(x + ITEM_SIZE + 3.0, ITEM_TOP + ITEM_SIZE - 6.0)
		draw_string_outline(font, at, label, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, 3, Color(0, 0, 0, 0.7))
		draw_string(font, at, label, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color("#e8e3d3"))
		x += ITEM_SIZE + 12.0 + font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, 13).x


## Each loadout slot holding a weapon: "Label: Name", and the ammo its attacks spend (held count).
func _draw_weapons(font: Font) -> void:
	if player == null or not "arsenal" in player or player.arsenal == null:
		return
	var y := WEAPON_TOP
	for row in player.arsenal.hud_rows():
		var text := "%s: %s" % [row.label, row.name]
		for item in row.ammo:
			text += "  %s ×%d" % [item, row.ammo[item]]
		draw_string_outline(font, Vector2(18.0, y), text, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, 3, Color(0, 0, 0, 0.7))
		draw_string(font, Vector2(18.0, y), text, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color("#e8e3d3"))
		y += 18.0
