extends RefCounted
## True once the state's action reports it has finished.

const PARAMS := {}


static func check(actor, _params: Dictionary) -> bool:
	return actor.action_done
