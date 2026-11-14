extends RefCounted
## Stand still.

const PARAMS := {}


static func enter(_actor, _params: Dictionary) -> void:
	pass


static func tick(actor, _params: Dictionary, _delta: float) -> void:
	actor.velocity.x = 0.0
