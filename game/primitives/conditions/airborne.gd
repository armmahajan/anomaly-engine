extends RefCounted

const PARAMS := {}


static func check(actor, _params: Dictionary) -> bool:
	return not actor.is_on_floor()
