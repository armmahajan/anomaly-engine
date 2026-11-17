extends SceneTree
## Headless probe for game/test/combat_primitives.test.ts: what run_state()
## doesn't report (camera shake, screen flash, sword targets).
##   godot --headless --fixed-fps 60 --path game --script res://test/combat_probe.gd -- in.json out.json
## in.json: {"project"} with an enemy spawn "target_1" whose handlers run effects when it dies.

const Projectile := preload("res://scripts/combat/projectile.gd")


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	var input = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	var main: Node = load("res://main.tscn").instantiate()
	root.add_child(main)
	main.handle_message({"type": "load", "project": input.project})
	main.handle_message({"type": "play", "seed": 1})
	for i in 5:
		await physics_frame
	var out := {"error": main.last_error, "frames": []}
	var target: Node = null
	for child in main._world.get_children():
		if child is CharacterBody2D and child.spawn_id == "target_1":
			target = child
	target.take_hit(999, Vector2.RIGHT)
	for i in 40:
		await physics_frame
		await process_frame
		var camera: Camera2D = main._player.camera
		out.frames.append({
			"fx": main._fx.state(),
			"cameraOffset": camera.offset.length(),
			"flashAlpha": main._fx._flash_rect.color.a if main._fx._flash_rect.visible else 0.0,
			"flags": main._run.events.flags.keys(),
		})
	main.handle_message({"type": "stop"})
	await process_frame
	out.afterStop = {"fx": main._fx.state(), "flashVisible": main._fx._flash_rect.visible}
	out.flashLayer = main._fx._flash_layer.layer
	out.flashAboveHud = main._fx._flash_layer.get_index() > main._hud.get_parent().get_index()

	# Sword targets: a pogo shot answers only a downward strike; it leaves the player's targets when freed.
	main.handle_message({"type": "play", "seed": 1})
	await physics_frame
	var shot: Node2D = Projectile.new()
	shot.pogo = true
	shot.velocity = Vector2.ZERO
	shot.position = Vector2(800, 300)
	shot.player = main._player
	main._world.add_child(shot)
	var plain: Node2D = Projectile.new()
	plain.player = main._player
	plain.position = Vector2(900, 300)
	main._world.add_child(plain)
	out.targets = {
		"pogoListed": shot in main._player.targets,
		"count": main._player.targets.size(),
		"plainListed": plain in main._player.targets,
		"side": shot.struck(1, Vector2.RIGHT),
		"plainDown": plain.struck(1, Vector2.DOWN),
		"down": shot.struck(1, Vector2.DOWN),
	}
	await process_frame
	await physics_frame
	out.targets.afterFree = main._player.targets.size()
	FileAccess.open(args[1], FileAccess.WRITE).store_string(JSON.stringify(out))
	main.queue_free()
	quit()
