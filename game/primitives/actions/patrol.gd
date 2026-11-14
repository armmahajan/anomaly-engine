extends RefCounted
## Walk back and forth around the spawn point, turning at walls.

const PARAMS := {"speed": "number", "distance": "number"}


static func enter(_actor, _params: Dictionary) -> void:
	pass


static func tick(actor, params: Dictionary, _delta: float) -> void:
	var half: float = float(params.distance) / 2.0
	if actor.is_on_wall():
		actor.face(signf(actor.get_wall_normal().x))
	if actor.position.x >= actor.home.x + half:
		actor.face(-1.0)
	elif actor.position.x <= actor.home.x - half:
		actor.face(1.0)
	actor.velocity.x = actor.facing * float(params.speed)
