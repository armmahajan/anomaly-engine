extends RefCounted

const PARAMS := {"margin": "number"}


static func check(actor, params: Dictionary) -> bool:
	return actor.player != null and absf(actor.player.center().y - actor.center().y) <= float(params.margin)
