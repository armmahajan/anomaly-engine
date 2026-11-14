extends RefCounted
## True once the actor has spent `seconds` in its current state.

const PARAMS := {"seconds": "number"}


static func check(actor, params: Dictionary) -> bool:
	return actor.state_time >= float(params.seconds)
