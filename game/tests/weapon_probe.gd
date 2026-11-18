extends SceneTree
## Headless check of the held weapon's data path (no pixels): a wielder facing left (scale.x -1)
## with a RigView and a WeaponView, posed through a clip. Usage:
##   godot --headless --path game --script res://tests/weapon_probe.gd -- <in.json>
## where in.json is {"rig":…, "clips":…, "direction":…, "weapon":…, "clip": "<name>"}.
## Prints one line per frame and OK; exits non-zero on failure.

const RigView := preload("res://scripts/art/rig_view.gd")
const WeaponView := preload("res://scripts/art/weapon_view.gd")


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var data = JSON.parse_string(FileAccess.get_file_as_string(args[0])) if not args.is_empty() else null
	if typeof(data) != TYPE_DICTIONARY:
		_fail("usage: -- <in.json>")
		return
	var wielder := Node2D.new()
	wielder.position = Vector2(300, 200)
	root.add_child(wielder)
	var rig = RigView.new()
	rig.manual_time = true
	rig.setup(data.rig, data.direction, data.clips)
	rig.scale.x = -1.0
	wielder.add_child(rig)
	var held = WeaponView.new()
	held.manual_time = true
	wielder.add_child(held)
	held.set_weapon(data.weapon, rig)
	rig.play(str(data.clip))
	var duration: float = rig.clip_duration(str(data.clip))
	var worst := 0.0
	for i in 24:
		rig.pose_at(duration * i / 24.0)
		var want: Vector2 = rig.get_global_transform() * (rig.grip_transform("hand") as Transform2D).origin
		var gap: float = held.grip_global().distance_to(want)
		worst = maxf(worst, gap)
		var tip = held.tip_global()
		if i == 0 and tip != null:
			# At rest the weapon points forward: facing left, its tip is left of the hand.
			if (tip as Vector2).x >= held.grip_global().x:
				_fail("facing left, the tip is not in front (tip %s, hand %s)" % [tip, held.grip_global()])
				return
	print("worst gap: %.3f" % worst)
	if worst > 0.01:
		_fail("the weapon left the hand")
		return
	held.set_weapon({}, rig)
	if held.tip_global() != null or held.visible:
		_fail("no weapon still shows")
		return
	print("OK")
	quit(0)


func _fail(message: String) -> void:
	printerr("FAIL: ", message)
	quit(1)
