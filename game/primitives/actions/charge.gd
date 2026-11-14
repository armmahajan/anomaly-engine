extends RefCounted
## Rush in the direction of the player at the moment the state starts.

const PARAMS := {"speed": "number"}


static func enter(actor, _params: Dictionary) -> void:
	actor.face_player()


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity.x = actor.facing * float(params.speed)
