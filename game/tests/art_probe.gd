extends SceneTree
## Headless probe for game art in play (see game/test/gameArt.test.ts): like simulate.gd, and
## each sample also has `drawn` (props.gd drawing(): each prop's art and where it is drawn),
## `held` (hud.gd held_items(): the HUD's items row) and `screen` (modal.gd describe()).
##   godot --headless --fixed-fps 60 --path game --script res://tests/art_probe.gd -- in.json out.json
## in.json:  {"scenarios": [{"project", "world"?, "frames", "samples", "input",
##            "textures"?: {ref: [w, h]}, "late"?: {frame: {ref: [w, h]}}}]}  (`late`: images that arrive at that frame)

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


func _add_textures(main: Node, sizes: Dictionary) -> void:
	for ref in sizes:
		var image := Image.create(int(sizes[ref][0]), int(sizes[ref][1]), false, Image.FORMAT_RGBA8)
		image.fill(Color(0.6, 0.5, 0.4))
		main._textures[str(ref)] = ImageTexture.create_from_image(image)


func _simulate(scenario: Dictionary) -> Dictionary:
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	_add_textures(main, scenario.get("textures", {}))
	main.handle_message({"type": "load", "project": scenario.project})
	var play := {"type": "play", "seed": 1}
	if scenario.has("world"):
		play.world = scenario.world
	main.handle_message(play)
	var samples := []
	var wanted: Array = scenario.get("samples", [])
	var late: Dictionary = scenario.get("late", {})
	for frame in range(int(scenario.frames) + 1):
		if late.has(str(frame)):
			_add_textures(main, late[str(frame)])
		for press in scenario.get("input", []):
			if frame == int(press.from) or frame == int(press.to):
				var event := InputEventAction.new()
				event.action = press.action
				event.pressed = frame == int(press.from)
				event.strength = 1.0 if event.pressed else 0.0
				Input.parse_input_event(event)
		if float(frame) in wanted or frame in wanted:
			var sample: Dictionary = main.run_state()
			var props = main._props
			sample.merge({
				"frame": frame,
				"drawn": props.drawing() if props != null and is_instance_valid(props) else [],
				"held": main._hud.held_items(),
				"screen": main._modals.describe(),
			}, true)
			samples.append(sample)
		await physics_frame
	for action in ACTIONS:
		Input.action_release(action)
	Input.flush_buffered_events()
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "samples": samples}
