extends RefCounted
## Flash during the windup, then call `count` enemies of another character
## beside itself, never more than `max` of its summons alive. Done after.

const Attack := preload("res://scripts/combat/attack.gd")
const PARAMS := {"character": "id", "count": "number", "max": "number", "windup": "number", "color": "color"}


static func enter(actor, _params: Dictionary) -> void:
	actor.face_player()
	Attack.set_phase(actor, "windup")


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity.x = 0.0
	if actor.action_done:
		Attack.after_instant(actor)
		return
	if actor.state_time < float(params.windup):
		Attack.set_phase(actor, "windup")
		Attack.warn(actor, params.color)
		return
	Attack.unwarn(actor)
	actor.summon(str(params.character), int(params.count), int(params.max))
	actor.memory.at = actor.state_time
	Attack.set_phase(actor, "active")
	actor.action_done = true
