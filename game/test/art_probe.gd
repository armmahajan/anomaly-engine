extends SceneTree
## Headless probe for game/test/art_phases.test.ts: which clip an enemy's rig plays each frame,
## next to its behavior state and attack phase (as run_state() reports them).
##   godot --headless --fixed-fps 60 --path game --script res://test/art_probe.gd -- in.json out.json
## in.json: {"project", "spawn", "frames", "hitAt"?: frame, "hit"?: damage}


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": input.project})
	main.handle_message({"type": "play", "seed": 1})
	await physics_frame
	var enemy: Node = null
	for child in main._world.get_children():
		if child is CharacterBody2D and "spawn_id" in child and child.spawn_id == input.spawn:
			enemy = child
	var out := {"error": main.last_error, "frames": [], "hasRig": enemy != null and enemy._rig != null}
	for frame in int(input.frames):
		if frame == int(input.get("hitAt", -1)):
			enemy.take_hit(int(input.hit), Vector2.ZERO)
		await physics_frame
		var reported = null
		for e in main.run_state().entities:
			if e.spawnId == input.spawn:
				reported = e.phase
		out.frames.append({
			"state": enemy.behavior_state,
			"phase": reported,
			"clip": enemy._rig.current_clip() if enemy._rig != null else "",
		})
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify(out))
	main.queue_free()
	quit()
