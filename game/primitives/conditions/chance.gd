extends RefCounted
## Rolled once per state entry (per transition), from the actor's seeded RNG.

const PARAMS := {"p": "number"}


static func check(actor, params: Dictionary) -> bool:
	var key := "chance_%d" % actor.current_transition
	if not actor.memory.has(key):
		actor.memory[key] = actor.rng.randf() < float(params.p)
	return actor.memory[key]
