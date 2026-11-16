extends RefCounted

const PARAMS := {"fraction": "number"}


static func check(actor, params: Dictionary) -> bool:
	return actor.health < actor.max_health * float(params.fraction)
