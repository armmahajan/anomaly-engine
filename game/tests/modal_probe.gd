extends SceneTree
## Headless modal and map probe (see game/test/modals.test.ts): like simulate.gd,
## and each sample also has `screen` (modal.gd describe(): the open modal, the queue, the map).
##   godot --headless --fixed-fps 60 --path game --script res://tests/modal_probe.gd -- in.json out.json
## in.json:  {"scenarios": [{"project", "world"?, "frames", "samples", "input", "textures"?: [ref], "preview"?: modal id}]}
##            (`preview`: stay in edit mode and preview that modal instead of playing)
## out.json: {"results": [{"error", "samples": [{"frame", "room", "visited", "screen", ...main.run_state()}]}]}

const ACTIONS := ["move_left", "move_right", "jump", "attack", "aim_up", "aim_down", "dash", "interact", "map"]


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
	for ref in scenario.get("textures", []):
		var image := Image.create(64, 32, false, Image.FORMAT_RGBA8)
		image.fill(Color(0.5, 0.5, 0.5))
		main._textures[str(ref)] = ImageTexture.create_from_image(image)
	main.handle_message({"type": "load", "project": scenario.project})
	if scenario.has("preview"):
		main.handle_message({"type": "previewModal", "modalId": scenario.preview})
	else:
		var play := {"type": "play", "seed": 1}
		if scenario.has("world"):
			play.world = scenario.world
		main.handle_message(play)
	var samples := []
	var wanted: Array = scenario.get("samples", [])
	for frame in range(int(scenario.frames) + 1):
		for press in scenario.get("input", []):
			if frame == int(press.from) or frame == int(press.to):
				var event := InputEventAction.new()
				event.action = press.action
				event.pressed = frame == int(press.from)
				event.strength = 1.0 if event.pressed else 0.0
				Input.parse_input_event(event)
		if float(frame) in wanted or frame in wanted:
			var run: Node = main._run
			var sample: Dictionary = main.run_state()
			sample.merge({"frame": frame, "room": run.room_id if run.active else null, "visited": run.visited.duplicate(), "screen": main._modals.describe()}, true)
			samples.append(sample)
		await physics_frame
	for action in ACTIONS:
		Input.action_release(action)
	Input.flush_buffered_events()
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "samples": samples}
