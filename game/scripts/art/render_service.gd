extends Node
## Renders rigs to PNG contact sheets for the AI critic and studio previews
## (message `renderRig`, see packages/core/src/protocol.ts). Uses the same
## RigView as the game, so what the critic sees is what the player sees.

const RigView := preload("res://scripts/art/rig_view.gd")

const MAX_FRAMES := 48
const MAX_CELL := 512

## Renders run one at a time; requests queue up.
var _busy := false
var _queue: Array = []


## `done` receives the reply message (a Dictionary).
func render(request: Dictionary, done: Callable) -> void:
	_queue.append([request, done])
	if not _busy:
		_drain()


func _drain() -> void:
	_busy = true
	while not _queue.is_empty():
		var job: Array = _queue.pop_front()
		var reply: Dictionary = await _render_one(job[0])
		job[1].call(reply)
	_busy = false


func _render_one(request: Dictionary) -> Dictionary:
	var request_id := str(request.get("requestId", ""))
	var rig = request.get("rig")
	if typeof(rig) != TYPE_DICTIONARY:
		return _error(request_id, "rig must be an object")
	var frames: Array = request.get("frames", [{"clip": null, "time": 0.0}])
	if frames.is_empty() or frames.size() > MAX_FRAMES:
		return _error(request_id, "frames must have 1-%d entries" % MAX_FRAMES)
	var cell_size := Vector2i(
		clampi(int(request.get("cellWidth", 256)), 16, MAX_CELL), clampi(int(request.get("cellHeight", 256)), 16, MAX_CELL)
	)
	var columns := clampi(int(request.get("columns", frames.size())), 1, MAX_FRAMES)
	var rows := ceili(float(frames.size()) / columns)
	var direction: Dictionary = request.get("direction", {}) if typeof(request.get("direction")) == TYPE_DICTIONARY else {}
	var clips: Dictionary = request.get("clips", {}) if typeof(request.get("clips")) == TYPE_DICTIONARY else {}
	var background = request.get("background")

	var viewport := SubViewport.new()
	viewport.size = Vector2i(cell_size.x * columns, cell_size.y * rows)
	viewport.transparent_bg = background == null
	viewport.disable_3d = true
	viewport.render_target_update_mode = SubViewport.UPDATE_DISABLED
	add_child(viewport)
	if background != null:
		var bg := ColorRect.new()
		bg.color = Color(str(background))
		bg.size = Vector2(viewport.size)
		viewport.add_child(bg)

	var warnings: Array[String] = []
	var fit := 1.0
	var origin := Vector2.ZERO
	for i in frames.size():
		var frame = frames[i]
		var view = RigView.new()
		view.manual_time = true
		view.setup(rig, direction, clips)
		if i == 0:
			warnings = view.warnings
			var fitted := _fit(rig, cell_size)
			fit = fitted[0]
			origin = fitted[1]
		var clip = frame.get("clip") if typeof(frame) == TYPE_DICTIONARY else null
		view.play(str(clip) if clip != null else "")
		view.pose_at(float(frame.get("time", 0.0)) if typeof(frame) == TYPE_DICTIONARY else 0.0, i)
		var cell := Vector2(i % columns, i / columns) * Vector2(cell_size)
		view.position = cell + origin
		view.scale = Vector2(fit, fit)
		viewport.add_child(view)

	viewport.render_target_update_mode = SubViewport.UPDATE_ONCE
	await RenderingServer.frame_post_draw
	var image := viewport.get_texture().get_image()
	viewport.queue_free()
	if image == null or image.is_empty():
		return _error(request_id, "render produced no image")
	return {
		"type": "rendered",
		"requestId": request_id,
		"png": Marshalls.raw_to_base64(image.save_png_to_buffer()),
		"width": image.get_width(),
		"height": image.get_height(),
		"scale": fit,
		"warnings": warnings,
	}


## Scale and feet position that fit the rig's rest bounds into a cell with a margin.
func _fit(rig: Dictionary, cell: Vector2i) -> Array:
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for part in rig.get("parts", []):
		var shape = part.get("shape") if typeof(part) == TYPE_DICTIONARY else null
		if typeof(shape) != TYPE_DICTIONARY:
			continue
		var pts: Array = shape.get("points", [])
		if str(shape.get("type")) == "ellipse":
			var c = shape.get("center", [0, 0])
			var r := maxf(float(shape.get("rx", 0)), float(shape.get("ry", 0)))
			pts = [[float(c[0]) - r, float(c[1]) - r], [float(c[0]) + r, float(c[1]) + r]]
		for p in pts:
			lo = Vector2(minf(lo.x, float(p[0])), minf(lo.y, float(p[1])))
			hi = Vector2(maxf(hi.x, float(p[0])), maxf(hi.y, float(p[1])))
	if lo.x == INF:
		return [1.0, Vector2(cell.x / 2.0, cell.y * 0.85)]
	var size := (hi - lo).max(Vector2(1, 1))
	var margin := 0.16
	var fit := minf(cell.x * (1.0 - 2 * margin) / size.x, cell.y * (1.0 - 2 * margin) / size.y)
	# Place the bounds' centre at the cell centre.
	var center := (lo + hi) / 2.0
	return [fit, Vector2(cell) / 2.0 - center * fit]


func _error(request_id: String, message: String) -> Dictionary:
	return {"type": "rendered", "requestId": request_id, "error": message}
