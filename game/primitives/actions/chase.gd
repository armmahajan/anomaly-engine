extends RefCounted
## Move toward the player: horizontally on the ground, in 2D when flying.

const PARAMS := {"speed": "number", "stopDistance": "number"}


static func enter(_actor, _params: Dictionary) -> void:
	pass


static func tick(actor, params: Dictionary, _delta: float) -> void:
	var target = actor.player_position()
	var stop: float = maxf(4.0, float(params.stopDistance))
	if target == null:
		actor.velocity.x = 0.0
		return
	if actor.flying:
		var to: Vector2 = target - actor.center()
		if to.length() <= stop:
			actor.velocity = Vector2.ZERO
			return
		actor.face(signf(to.x))
		actor.velocity = to.normalized() * float(params.speed)
		return
	var dx: float = target.x - actor.position.x
	if absf(dx) <= stop:
		actor.velocity.x = 0.0
		return
	actor.face(signf(dx))
	actor.velocity.x = actor.facing * float(params.speed)
