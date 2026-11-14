extends RefCounted

const PARAMS := {"distance": "number"}


static func check(actor, params: Dictionary) -> bool:
	return actor.distance_to_player() > float(params.distance)
