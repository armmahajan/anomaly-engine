extends RefCounted
## Move directly away from the player (2D when flying). Ground characters stop at ledges.

const PARAMS := {"speed": "number"}


static func enter(_actor, _params: Dictionary) -> void:
	pass


static func tick(actor, params: Dictionary, _delta: float) -> void:
	var target = actor.player_position()
	if target == null:
		actor.velocity.x = 0.0
		return
	if actor.flying:
		var away: Vector2 = actor.center() - target
		if away == Vector2.ZERO:
			away = Vector2(-actor.facing, 0.0)
		actor.face(signf(away.x))
		actor.velocity = away.normalized() * float(params.speed)
		return
	var direction := signf(actor.position.x - target.x)
	actor.face(direction if direction != 0.0 else -actor.facing)
	actor.velocity.x = 0.0 if actor.ledge_ahead() else actor.facing * float(params.speed)
