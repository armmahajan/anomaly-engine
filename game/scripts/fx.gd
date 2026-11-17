extends Node
## Feedback effects any handler can run (agent F): shake, flash, hitStop,
## slowMotion (events.gd registry).
##
## Phase 0 stub: the contract below is what main.gd calls.

var main: Node = null


func setup(main_node: Node) -> void:
	main = main_node


func register(events) -> void:
	for type in ["shake", "flash", "hitStop", "slowMotion"]:
		events.register(type, _not_yet.bind(type))


func _not_yet(_effect: Dictionary, _context: Dictionary, type: String) -> void:
	push_warning("[fx] effect %s is not implemented yet" % type)


## Stop / a new run: end any shake, flash or slow motion.
func reset() -> void:
	pass
