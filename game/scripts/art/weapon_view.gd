extends Node2D
## What a wielder's weapon looks like (CONTRACT, weapons target phase 0): the mechanics (player.gd,
## enemy.gd, owned by W1) create one per wielder and call these; the art agent (W2) draws them:
## the held sprite at the rig's grip, the trail behind the tip during the active window, hit sparks.
## Until then these do nothing, and the game plays the same.

## The weapon to show (a project weapon dictionary) or {} for none (the built-in attack). `rig_view`
## is the wielder's RigView (or null for a coloured box), to find the grip on its pose each frame.
func set_weapon(_weapon: Dictionary, _rig_view: Node) -> void:
	pass

## An attack's phase changed: "windup", "active", "recovery" or "" (idle). `attack` is the attack
## dictionary, `aim` the unit aim vector (wielder space, facing right), `facing` 1 or -1.
func set_phase(_attack: Dictionary, _phase: String, _aim: Vector2, _facing: float) -> void:
	pass

## A hit landed at `global_point` (spark, using the weapon's spark colour).
func hit_at(_global_point: Vector2) -> void:
	pass

## The tip of the held weapon in global coordinates (for hit shapes that follow the art), or null
## when there is no sprite: the mechanics then use the attack's own shape.
func tip_global() -> Variant:
	return null
