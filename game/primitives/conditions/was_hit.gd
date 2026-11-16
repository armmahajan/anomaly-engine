extends RefCounted

const PARAMS := {}


static func check(actor, _params: Dictionary) -> bool:
	return actor.was_hit
