extends Node2D
## A weapon's projectile (weapon_runner.gd fires them, for the player and for enemies alike):
## flies, falls with `gravity`, breaks on a solid or when its lifetime runs out, and hits what its
## wielder hits (never the wielder itself), each thing once, passing through `pierce` of them.
## Like an enemy's shot (projectile.gd), but its wielder's targets. Mirrors weaponModel.ts
## projectilePath: it starts moving on the frame after it is fired.
##
## Its look (core art/animation.ts ProjectileLook): it leaves from `look_origin` (wielder space,
## facing right); with `appear: windup` it is made at the start of the windup and sits `charging`
## there (following its wielder, harmless) until the attack fires (`launch`); with object `art` it is
## drawn as that object (charge, then fly; burst plays as an effect where it breaks).

const Attack := preload("res://scripts/combat/attack.gd")
const Runner := preload("res://scripts/combat/weapon_runner.gd")
const ProjectileView := preload("res://scripts/art/projectile_view.gd")

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
## The look's art ({object, charge, fly, burst}) or null, and where it leaves from (wielder space).
var art = null
var look_origin := Vector2.ZERO
## Charging at its origin through the windup: follows its wielder, hits nothing, doesn't age.
var charging := false

var _hits: Array = []
var _landed := 0
var _born := -1
var _view: Node2D = null
var _owner_id := ""


func _ready() -> void:
	z_index = 2
	add_to_group("projectiles")
	if wielder != null and "spawn_id" in wielder:
		_owner_id = str(wielder.spawn_id)
	_view = ProjectileView.object_for(self, art, "charge" if charging else "fly")
	if charging:
		_follow()
		return
	origin = position
	_born = Engine.get_physics_frames()
	rotation = velocity.angle()


## Leave the wielder (the attack fires): fly at `v` from where it is now, from the next frame.
func launch(v: Vector2) -> void:
	charging = false
	velocity = v
	origin = position
	_born = Engine.get_physics_frames()
	rotation = velocity.angle()
	if _view != null:
		_view.scale.x = absf(_view.scale.x)
		ProjectileView.play_part(_view, art, "fly")


func _physics_process(delta: float) -> void:
	if charging:
		if wielder == null or not is_instance_valid(wielder):
			queue_free()
			return
		_follow()
		return
	if Engine.get_physics_frames() == _born:
		return
	velocity.y += gravity * delta
	position += velocity * delta
	life -= delta
	rotation = velocity.angle()
	if life <= 0.0 or Attack.solid_at(self, position):
		_break()
		return
	if wielder == null or not is_instance_valid(wielder):
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
				_break()
				return


## At its origin on the wielder, mirrored when it faces left.
func _follow() -> void:
	var facing: float = wielder.facing_sign()
	position = wielder.center() + Vector2(look_origin.x * facing, look_origin.y)
	rotation = 0.0
	if _view != null:
		_view.scale.x = absf(_view.scale.x) * (-1.0 if facing < 0.0 else 1.0)


## Gone: its burst (art) plays where it broke.
func _break() -> void:
	ProjectileView.burst(self, art, position, rotation)
	queue_free()


func rect() -> Rect2:
	return Rect2(position - Vector2(radius, radius), Vector2(radius, radius) * 2.0)


## The runtime state's projectiles entry.
func describe() -> Dictionary:
	return {"x": position.x, "y": position.y, "charging": charging, "object": str(art.object) if typeof(art) == TYPE_DICTIONARY else null, "owner": _owner_id}


func _draw() -> void:
	if _view != null:
		return
	if texture != null:
		draw_texture(texture, -texture.get_size() / 2.0)
		return
	draw_circle(Vector2.ZERO, radius, color)
	draw_circle(Vector2.ZERO, radius * 0.45, color.lightened(0.5))
