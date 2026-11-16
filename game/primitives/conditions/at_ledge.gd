extends RefCounted
## True when standing on the ground with nothing solid just ahead.

const PARAMS := {}


static func check(actor, _params: Dictionary) -> bool:
	return actor.ledge_ahead()
