extends Node2D
## A weapon's projectile (weapon_runner.gd fires them, for the player and for enemies alike):
## flies, falls with `gravity`, breaks on a solid or when its lifetime runs out, and hits what its
## wielder hits (never the wielder itself), each thing once, passing through `pierce` of them.
## Like an enemy's shot (projectile.gd), but its wielder's targets. Mirrors weaponModel.ts
## projectilePath: it starts moving on the frame after it is fired.

const Attack := preload("res://scripts/combat/attack.gd")
const Runner := preload("res://scripts/combat/weapon_runner.gd")

var velocity := Vector2.ZERO
var gravity := 0.0
var life := 1.2
var radius := 12.0
var pierce := 0
var color := Color.WHITE
var texture: Texture2D = null
var damage := 1
var knockback := 0.0
## Who fired it (player.gd or enemy.gd) and the attack it belongs to (weapon_runner.gd).
var wielder: Node2D = null
var runner = null
## Where it was fired from (tests read how far it flew).
var origin := Vector2.ZERO

var _hits: Array = []
var _landed := 0
var _born := -1


func _ready() -> void:
	z_index = 2
	origin = position
	_born = Engine.get_physics_frames()
	rotation = velocity.angle()


func _physics_process(delta: float) -> void:
	if Engine.get_physics_frames() == _born:
		return
	velocity.y += gravity * delta
	position += velocity * delta
	life -= delta
	rotation = velocity.angle()
	if life <= 0.0 or Attack.solid_at(self, position) or wielder == null or not is_instance_valid(wielder):
		queue_free()
		return
	for target in wielder.weapon_targets():
		if target in _hits or not is_instance_valid(target):
			continue
		if not Runner.circle_hits_rect(position, radius, target.rect()):
			continue
		_hits.append(target)
		if Runner.strike(target, damage, velocity.normalized(), knockback, position.x - velocity.x, signf(velocity.x)):
			runner.projectile_landed(wielder, position)
			_landed += 1
			if _landed > pierce:
				queue_free()
				return


func rect() -> Rect2:
	return Rect2(position - Vector2(radius, radius), Vector2(radius, radius) * 2.0)


func _draw() -> void:
	if texture != null:
		draw_texture(texture, -texture.get_size() / 2.0)
		return
	draw_circle(Vector2.ZERO, radius, color)
	draw_circle(Vector2.ZERO, radius * 0.45, color.lightened(0.5))
