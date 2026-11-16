extends RefCounted
## Flyers float in place, bobbing up and down. Ground characters stand still.

const PARAMS := {"amplitude": "number", "period": "number"}
const MAX_SPEED := 600.0


static func enter(actor, _params: Dictionary) -> void:
	actor.memory.anchor = actor.position.y


static func tick(actor, params: Dictionary, delta: float) -> void:
	actor.velocity.x = 0.0
	if not actor.flying:
		return
	var phase: float = TAU * actor.state_time / float(params.period)
	var target: float = actor.memory.anchor + float(params.amplitude) * sin(phase)
	actor.velocity.y = clampf((target - actor.position.y) / delta, -MAX_SPEED, MAX_SPEED)
