extends RefCounted
## True when no platform blocks the line to the player.

const PARAMS := {}


static func check(actor, _params: Dictionary) -> bool:
	return actor.can_see_player()
