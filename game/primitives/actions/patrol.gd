extends RefCounted
## Walk back and forth around the spawn point. Done each time it turns around.

const PARAMS := {"speed": "number", "distance": "number", "turnAtLedge": "bool", "turnAtWall": "bool"}


static func enter(_actor, _params: Dictionary) -> void:
	pass


static func tick(actor, params: Dictionary, _delta: float) -> void:
	var half: float = float(params.distance) / 2.0
	var turn := 0.0
	if params.turnAtWall and actor.is_on_wall() and signf(actor.get_wall_normal().x) != actor.facing:
		turn = signf(actor.get_wall_normal().x)
	elif params.turnAtLedge and actor.ledge_ahead():
		turn = -actor.facing
	elif actor.position.x >= actor.home.x + half and actor.facing > 0.0:
		turn = -1.0
	elif actor.position.x <= actor.home.x - half and actor.facing < 0.0:
		turn = 1.0
	if turn != 0.0:
		actor.face(turn)
		actor.action_done = true
	actor.velocity.x = actor.facing * float(params.speed)
