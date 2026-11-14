extends RefCounted
## Stand still, face the player and flash: a readable warning before an attack.

const PARAMS := {"color": "color"}
const FLASH_PERIOD := 0.16


static func enter(actor, _params: Dictionary) -> void:
	actor.face_player()


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity.x = 0.0
	var lit := fmod(actor.state_time, FLASH_PERIOD) < FLASH_PERIOD / 2.0
	actor.set_tint(Color(params.color) if lit else null)
