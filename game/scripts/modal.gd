extends CanvasLayer
## Modals (agent E): screens over the game with a title, text, an optional
## image and buttons that run effects (events.gd); gameplay pauses while one
## is open (main.set_paused). Also the optional map screen. Implements the
## showModal, endGame and revealMap effects.
##
## Phase 0 stub: the contract below is what main.gd calls.

var main: Node = null


func setup(main_node: Node) -> void:
	main = main_node
	layer = 3  # above the HUD (2) and room frames (1)


func register(events) -> void:
	for type in ["showModal", "endGame", "revealMap"]:
		events.register(type, _not_yet.bind(type))


func _not_yet(_effect: Dictionary, _context: Dictionary, type: String) -> void:
	push_warning("[modal] effect %s is not implemented yet" % type)


## Edit mode: show a modal of the loaded project (null = close it).
func preview(_modal_id) -> void:
	pass


## The open modal's id, or null.
func current():
	return null


func map_open() -> bool:
	return false


## Stop / a new run: close everything, forget revealed rooms.
func reset() -> void:
	pass
