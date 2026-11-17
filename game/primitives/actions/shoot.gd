extends RefCounted
## Flash during the windup, then fire `count` projectiles in a fan (at the
## player, or at `angle` degrees from facing). Done once fired.

const Attack := preload("res://scripts/combat/attack.gd")
const Projectile := preload("res://scripts/combat/projectile.gd")
const PARAMS := {
	"windup": "number", "count": "number", "spread": "number", "speed": "number", "gravity": "number",
	"aim": "enum:player|angle", "angle": "number", "lifetime": "number", "damage": "number", "pogo": "bool", "color": "color",
}


static func enter(actor, _params: Dictionary) -> void:
	actor.face_player()
	Attack.set_phase(actor, "windup")


static func tick(actor, params: Dictionary, _delta: float) -> void:
	actor.velocity = Vector2(0.0, actor.velocity.y if not actor.flying else 0.0)
	if actor.action_done:
		Attack.after_instant(actor)
		return
	if actor.state_time < float(params.windup):
		Attack.set_phase(actor, "windup")
		Attack.warn(actor, params.color)
		return
	Attack.unwarn(actor)
	actor.face_player()
	var origin: Vector2 = actor.center()
	var heading := deg_to_rad(float(params.angle))
	heading = heading if actor.facing > 0.0 else PI - heading
	if params.aim == "player" and actor.player != null:
		heading = (actor.player.center() - origin).angle()
	var count := int(params.count)
	var spread := deg_to_rad(float(params.spread))
	for i in count:
		var shot: Node2D = Projectile.new()
		var offset := 0.0 if count == 1 else spread * (float(i) / float(count - 1) - 0.5)
		shot.position = origin
		shot.velocity = Vector2.from_angle(heading + offset) * float(params.speed)
		shot.gravity = float(params.gravity)
		shot.life = float(params.lifetime)
		shot.damage = int(params.damage)
		shot.knockback = actor.knockback()
		shot.pogo = bool(params.pogo)
		shot.color = Color(params.color)
		shot.player = actor.player
		actor.get_parent().add_child(shot)
	actor.memory.at = actor.state_time
	Attack.set_phase(actor, "active")
	actor.action_done = true
