extends Control
## The map screen: known rooms (visited or revealed) at their world-map
## position (`at`, in tiles) and size, doors between known rooms as lines,
## the current room highlighted. modal.gd shows it over the paused game.

const TILE := 32.0
const BACK := Color(0.04, 0.05, 0.08, 0.86)
const ROOM := Color("#3a4560")
const EDGE := Color("#9aa6c4")
const HERE := Color("#e8c547")
const LINK := Color("#c8d0e4")

var _rooms: Array = []  ## [{id, name, rect (tiles), current}]
var _links: Array = []  ## [[from (tiles), to (tiles), room a, room b]]


## Lay out `known` (room ids) of `rooms` (runtime rooms), `current` highlighted.
func show_rooms(rooms: Array, known: Dictionary, current: String) -> void:
	_rooms = []
	_links = []
	var by_id := {}
	for room in rooms:
		by_id[room.id] = room
	var seen := {}
	for room in rooms:
		if not known.has(room.id):
			continue
		_rooms.append({"id": room.id, "name": str(room.get("name", room.id)), "rect": _rect(room), "current": room.id == current})
		for door in room.get("doors", []):
			var to = door.get("to")
			if typeof(to) != TYPE_DICTIONARY or not known.has(to.room):
				continue
			var ends := ["%s/%s" % [room.id, door.id], "%s/%s" % [to.room, to.door]]
			ends.sort()
			var key := "|".join(ends)
			if seen.has(key):
				continue  # each link once
			seen[key] = true
			for other in by_id.get(to.room, {}).get("doors", []):
				if other.id == to.door:
					_links.append([_door_point(room, door), _door_point(by_id[to.room], other), str(room.id), str(to.room)])
	queue_redraw()


## What is drawn, for tests: rooms (tile rects), the current room and links between rooms.
func describe() -> Dictionary:
	return {
		"rooms": _rooms.map(func(r): return {"id": r.id, "rect": [r.rect.position.x, r.rect.position.y, r.rect.size.x, r.rect.size.y], "current": r.current}),
		"links": _links.map(func(l): return [l[2], l[3]]),
	}


func _rect(room: Dictionary) -> Rect2:
	var at: Dictionary = room.get("at", {"x": 0, "y": 0})
	return Rect2(float(at.x), float(at.y), float(room.width) / TILE, float(room.height) / TILE)


func _door_point(room: Dictionary, door: Dictionary) -> Vector2:
	var r := _rect(room)
	var along := float(door.offset) + float(door.size) / 2.0
	match str(door.side):
		"left":
			return Vector2(r.position.x, r.position.y + along)
		"right":
			return Vector2(r.end.x, r.position.y + along)
		"top":
			return Vector2(r.position.x + along, r.position.y)
	return Vector2(r.position.x + along, r.end.y)


func _draw() -> void:
	var view := get_viewport_rect().size
	draw_rect(Rect2(Vector2.ZERO, view), BACK)
	var font := ThemeDB.fallback_font
	draw_string(font, Vector2(0, 40), "Map", HORIZONTAL_ALIGNMENT_CENTER, view.x, 24, EDGE)
	if _rooms.is_empty():
		return
	var bounds: Rect2 = _rooms[0].rect
	for r in _rooms:
		bounds = bounds.merge(r.rect)
	var area := Rect2(Vector2(40, 70), view - Vector2(80, 110))
	var zoom := minf(area.size.x / maxf(bounds.size.x, 1.0), area.size.y / maxf(bounds.size.y, 1.0))
	zoom = minf(zoom, 12.0)
	var offset := area.get_center() - bounds.get_center() * zoom
	var to_screen := func(p: Vector2) -> Vector2: return p * zoom + offset
	for r in _rooms:
		var box := Rect2(to_screen.call(r.rect.position), r.rect.size * zoom)
		draw_rect(box, HERE if r.current else ROOM)
		draw_rect(box, EDGE, false, 2.0)
		if box.size.x > 48.0 and box.size.y > 24.0:
			draw_string(font, box.position + Vector2(6, 20), r.name, HORIZONTAL_ALIGNMENT_LEFT, box.size.x - 12.0, 15, Color.BLACK if r.current else EDGE)
	for l in _links:
		draw_line(to_screen.call(l[0]), to_screen.call(l[1]), LINK, 3.0)
		draw_circle(to_screen.call(l[0]), 4.0, LINK)
		draw_circle(to_screen.call(l[1]), 4.0, LINK)
