extends RefCounted
## Run toward the player.

const PARAMS := {"speed": "number"}


static func enter(_actor, _params: Dictionary) -> void:
	pass


static func tick(actor, params: Dictionary, _delta: float) -> void:
	var target = actor.player_position()
	if target == null or absf(target.x - actor.position.x) < 4.0:
		actor.velocity.x = 0.0
		return
	actor.face(signf(target.x - actor.position.x))
	actor.velocity.x = actor.facing * float(params.speed)
