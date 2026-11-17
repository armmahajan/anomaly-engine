extends SceneTree
## Headless probe for the play view (see game/test/depth.test.ts): like simulate.gd, and each sample
## also has `camera` (run_state) and `view` (the dressing's WorldView.describe(): planes, layer
## offsets, particles), plus `scales`: each background plane's physical px per image px on a
## window `windowHeight` physical px tall.
##   godot --headless --fixed-fps 60 --path game --script res://tests/view_probe.gd -- in.json out.json
## in.json: {"windowHeight", "scenarios": [{"project", "world"?, "frames", "samples", "input", "edit"?,
##           "textures": {ref: [w, h]}}]}  (`edit`: sample edit mode instead of playing)

const ACTIONS := ["move_left", "move_right", "jump", "attack", "aim_up", "aim_down", "dash", "interact", "map"]


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	root.size = Vector2i(1920, 1080)  # a 16:9 window (headless starts square): the view is 960x540
	var results := []
	for scenario in input.scenarios:
		results.append(await _simulate(scenario, float(input.get("windowHeight", 1890))))
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify({"results": results}))
	quit()


func _simulate(scenario: Dictionary, window_height: float) -> Dictionary:
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	for ref in scenario.get("textures", {}):
		var size: Array = scenario.textures[ref]
		var image := Image.create(int(size[0]), int(size[1]), false, Image.FORMAT_RGBA8)
		image.fill(Color(0.6, 0.5, 0.4))
		main._textures[str(ref)] = ImageTexture.create_from_image(image)
	main.handle_message({"type": "load", "project": scenario.project})
	if not scenario.get("edit", false):
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
			var sample: Dictionary = main.run_state()
			var view = main._dressing_view
			var shown: bool = view != null and is_instance_valid(view)
			sample.merge({
				"frame": frame,
				"view": view.describe() if shown else null,
				"scales": view.plane_scales(window_height) if shown else {},
			}, true)
			samples.append(sample)
		await process_frame
	for action in ACTIONS:
		Input.action_release(action)
	Input.flush_buffered_events()
	var error: String = main.last_error
	main.queue_free()
	await process_frame
	return {"error": error, "samples": samples}
