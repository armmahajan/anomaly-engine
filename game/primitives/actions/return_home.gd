extends RefCounted
## Go back to the spawn point (2D when flying). Done on arrival.

const PARAMS := {"speed": "number"}
const ARRIVED := 4.0


static func enter(_actor, _params: Dictionary) -> void:
	pass


static func tick(actor, params: Dictionary, delta: float) -> void:
	var speed := float(params.speed)
	if actor.flying:
		var to: Vector2 = actor.home - actor.position
		if to.length() <= ARRIVED:
			actor.velocity = Vector2.ZERO
			actor.action_done = true
			return
		actor.face(signf(to.x))
		actor.velocity = to.normalized() * minf(speed, to.length() / delta)
		return
	var dx: float = actor.home.x - actor.position.x
	if absf(dx) <= ARRIVED:
		actor.velocity.x = 0.0
		actor.action_done = true
		return
	actor.face(signf(dx))
	actor.velocity.x = actor.facing * minf(speed, absf(dx) / delta)
