extends SceneTree
## Headless simulator for primitive tests (see game/test/*.test.ts):
##   godot --headless --fixed-fps 60 --path game --script res://tests/simulate.gd -- in.json out.json
## in.json:  {"scenarios": [{"project", "seed", "frames", "samples": [frame...], "input": [{"action", "from", "to"}]}]}
## out.json: {"results": [{"error", "samples": [{"frame", "entities"}]}]}


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var results := []
	for scenario in input.scenarios:
		results.append(await _simulate(scenario))
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify({"results": results}))
	quit()


func _simulate(scenario: Dictionary) -> Dictionary:
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": scenario.project})
	main.handle_message({"type": "play", "seed": scenario.get("seed", 1)})
	var samples := []
	var wanted: Array = scenario.get("samples", [])
	for frame in range(int(scenario.frames) + 1):
		for press in scenario.get("input", []):
			if frame == int(press.from):
				Input.action_press(press.action)
			elif frame == int(press.to):
				Input.action_release(press.action)
		if float(frame) in wanted or frame in wanted:
			samples.append({"frame": frame, "deaths": main._deaths, "entities": main._entity_states()})
		await physics_frame
	for action in ["move_left", "move_right", "jump", "attack", "aim_up", "aim_down"]:
		Input.action_release(action)
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "samples": samples}
