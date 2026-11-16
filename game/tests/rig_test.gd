extends SceneTree
## Headless check of the rig renderer's data path (no pixels: headless Godot
## can't draw). Usage:
##   godot --headless --path game --script res://tests/rig_test.gd -- <rig.json>
## where rig.json is {"rig":…, "clips":…, "direction":…}. Exits non-zero on failure.

const RigView := preload("res://scripts/art/rig_view.gd")


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		_fail("usage: -- <rig.json>")
		return
	var data = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	if typeof(data) != TYPE_DICTIONARY:
		_fail("could not read %s" % args[0])
		return
	var view = RigView.new()
	view.manual_time = true
	view.setup(data.rig, data.direction, data.clips)
	if not view.warnings.is_empty():
		_fail("warnings: %s" % ", ".join(view.warnings))
		return
	print("parts built: %d of %d" % [view._parts.size(), data.rig.parts.size()])
	if view._parts.size() != data.rig.parts.size():
		_fail("some parts were skipped")
		return
	for clip_id in data.clips:
		view.play(clip_id, true)
		view.pose_at(0.0)
		var first: Dictionary = view._pose.duplicate()
		var moved := false
		for i in range(1, 9):
			view.pose_at(i * 0.07)
			for bone in view._pose:
				if not view._pose[bone].is_equal_approx(first.get(bone, Transform2D.IDENTITY)):
					moved = true
		print("clip %s: %s" % [clip_id, "moves" if moved else "STILL"])
		if not moved:
			_fail("clip %s does not move any bone" % clip_id)
			return
	print("OK")
	view.free()
	quit(0)


func _fail(message: String) -> void:
	printerr("FAIL: ", message)
	quit(1)
