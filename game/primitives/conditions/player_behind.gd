extends RefCounted

const PARAMS := {}


static func check(actor, _params: Dictionary) -> bool:
	return actor.player != null and signf(actor.player.position.x - actor.position.x) == -actor.facing
