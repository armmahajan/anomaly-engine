extends RefCounted
## Shared by the attack primitives (strike, shoot, leap, slam, summon, teleport):
## the warning look and hurting the player.

const FLASH_PERIOD := 0.16


## The telegraph look: flash `color` (and shake) while an attack winds up.
static func warn(actor, color: String, shake := false) -> void:
	var lit := fmod(actor.state_time, FLASH_PERIOD) < FLASH_PERIOD / 2.0
	actor.set_tint(Color(color) if lit else null)
	actor.shaking = shake


## The windup is over: back to the normal look.
static func unwarn(actor) -> void:
	actor.set_tint(null)
	actor.shaking = false


## Hurt the player if `area` overlaps them, throwing them away from `from_x`
## (player.gd ignores hits while it is invulnerable).
static func hurt(player, area: Rect2, from_x: float, fallback: float, damage: int, knockback: float) -> bool:
	if player == null or not is_instance_valid(player) or player.health <= 0 or not area.intersects(player.rect()):
		return false
	var direction := signf(player.position.x - from_x)
	player.hit(direction if direction != 0.0 else fallback, knockback, damage)
	return true


## True when a world solid (collision layer 1) covers `point`.
static func solid_at(node: Node2D, point: Vector2) -> bool:
	var query := PhysicsPointQueryParameters2D.new()
	query.position = point
	query.collision_mask = 1
	return not node.get_world_2d().direct_space_state.intersect_point(query, 1).is_empty()
