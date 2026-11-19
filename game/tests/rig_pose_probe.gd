extends SceneTree
## Headless probe of the rig renderer's posed geometry (see game/test/rigMesh.test.ts): each case's
## rig is built, put in the tree and drawn at every pose (so a bad polygon would print its Godot
## ERROR), and each pose reports every part's drawn layers (posed vertices, triangle indices, uv).
##   godot --headless --path game --script res://tests/rig_pose_probe.gd -- in.json out.json
## in.json: {"cases": [{"rig", "clips"?, "direction"?, "textures"?: {ref: [w, h]}, "crossfade"?: false, "quick"?: false,
##   "poses": [{"clip", "time", "restart"?: true, "continue"?: false}]}]}
##   Each pose plays its clip (restarting it unless restart is false; not at all with continue) and is
##   posed at `time`; crossfade lets clip switches blend (off by default); quick skips drawing and parts.
## out.json: {"cases": [{"warnings", "poses": [{part id: [{"points", "indices", "uv"}], "bones": {id: [x, y, degrees]}}]}]}
## With "timing": {"frames": N, "views": M} instead, it draws M views of each case's rig N frames each
## (cycling its clips) and reports {"usPerFrame"} (the frame cost of drawing the rigs).

const RigView := preload("res://scripts/art/rig_view.gd")


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var view_script: Script = load(args[2]) if args.size() > 2 else RigView
	var out := []
	for c in input.cases:
		if input.has("timing"):
			out.append(await _time(c, input.timing, view_script))
		else:
			out.append(await _probe(c))
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify({"cases": out}))
	quit()


func _textures(c: Dictionary) -> Dictionary:
	var textures := {}
	for ref in c.get("textures", {}):
		var size: Array = c.textures[ref]
		var image := Image.create(int(size[0]), int(size[1]), false, Image.FORMAT_RGBA8)
		image.fill(Color(0.6, 0.5, 0.4))
		image.generate_mipmaps()
		textures[str(ref)] = ImageTexture.create_from_image(image)
	return textures


func _probe(c: Dictionary) -> Dictionary:
	var view = RigView.new()
	view.manual_time = true
	view.textures = _textures(c)
	root.add_child(view)
	view.setup(c.rig, c.get("direction", {}), c.get("clips", {}))
	var poses := []
	view.crossfade = bool(c.get("crossfade", false))
	var quick := bool(c.get("quick", false))
	for pose in c.get("poses", [{"clip": null, "time": 0}]):
		var clip = pose.get("clip")
		if not bool(pose.get("continue", false)):
			view.play(str(clip) if clip != null else "", bool(pose.get("restart", true)))
		view.pose_at(float(pose.get("time", 0.0)))
		if not quick:
			await process_frame
			await process_frame  # drawn
		var bones := {}
		for id in view._bone_order:
			var xf: Transform2D = view._pose[id]
			bones[id] = [xf.origin.x, xf.origin.y, rad_to_deg(xf.x.angle())]
		if quick:
			poses.append({"bones": bones})
			continue
		var parts := {"bones": bones}
		for part in c.rig.parts:
			var layers := []
			for layer in view.posed_mesh(str(part.id)):
				layers.append({"points": _pairs(layer.points), "indices": Array(layer.indices), "uv": _pairs(layer.uv)})
			parts[str(part.id)] = layers
		poses.append(parts)
	var warnings: Array = view.warnings.duplicate()
	view.queue_free()
	await process_frame
	return {"warnings": warnings, "poses": poses}


func _time(c: Dictionary, timing: Dictionary, view_script: Script) -> Dictionary:
	OS.low_processor_usage_mode_sleep_usec = 0  # headless sleeps ~7 ms a frame otherwise (no window draws)
	var views := []
	var textures := _textures(c)
	for i in int(timing.get("views", 20)):
		var view = view_script.new()
		view.manual_time = true
		view.textures = textures
		view.position = Vector2(40 + (i % 10) * 90, 120 + (i / 10) * 120)
		root.add_child(view)
		view.setup(c.rig, c.get("direction", {}), c.get("clips", {}))
		views.append(view)
	var clips: Array = c.get("clips", {}).keys()
	var frames := int(timing.get("frames", 200))
	await process_frame
	await process_frame
	var posing := 0
	var start := Time.get_ticks_usec()
	for f in frames:
		var t := Time.get_ticks_usec()
		for i in views.size():
			var view = views[i]
			if not clips.is_empty():
				view.play(str(clips[(f / 50 + i) % clips.size()]))
			view.pose_at(f * 0.033, f)  # queues a redraw: the views draw in this frame's flush
		posing += Time.get_ticks_usec() - t
		await process_frame
	var total := Time.get_ticks_usec() - start
	for view in views:
		view.queue_free()
	await process_frame
	# Whole frames (pose + draw + the engine's frame) and the posing alone: the draw is the difference.
	return {"usPerFrame": float(total) / frames, "usPosing": float(posing) / frames, "views": views.size()}


func _pairs(points: PackedVector2Array) -> Array:
	var out := []
	for p in points:
		out.append([p.x, p.y])
	return out
