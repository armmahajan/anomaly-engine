extends Node2D
## The props of one room (agent D): generic rectangles that are drawn, can be
## solid (in the player's `solids` and as bodies for enemies), fire touch /
## interact / hit / destroyed (events.gd) and follow the run's flags and items
## through their `solid` and `visible` conditions. main.gd adds one per built
## room (also in edit mode and on the Rooms stage, with no player).
##
## Phase 0 stub: the contract below is what main.gd and world_runtime.gd call.

var main: Node = null
var room: Dictionary = {}
## The player's collision list for this room (dicts like level.gd's); solid props add theirs.
var solids: Array = []
## The player in this room, or null (edit stages).
var player: Node = null


func setup(main_node: Node, room_data: Dictionary, room_solids: Array, room_player: Node) -> void:
	main = main_node
	room = room_data
	solids = room_solids
	player = room_player


## Whether a prop takes part: drawn, solid, fires and answers events. Hidden (and destroyed) props don't.
func is_present(prop: Dictionary) -> bool:
	return main._run.events.holds(prop.get("visible", true))


## Flags, items or abilities changed: re-check every prop's solid and visible.
func refresh() -> void:
	pass


## [{id, visible, solid}] for the runtime's state.
func state() -> Array:
	var events = main._run.events
	return room.get("props", []).map(func(p): return {"id": p.id, "visible": is_present(p), "solid": is_present(p) and events.holds(p.get("solid", false))})
