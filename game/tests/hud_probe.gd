extends SceneTree
## Headless probe for game/test/hud.test.ts: how many health pips fit in a row beside the boss bars.
##   godot --headless --path game --script res://tests/hud_probe.gd -- out.json


func _initialize() -> void:
	var hud = load("res://scripts/hud.gd")
	var out := {}
	for width in [640, 960, 1280, 1920]:
		out[str(width)] = hud.pips_per_row(float(width))
	var file := FileAccess.open(OS.get_cmdline_user_args()[0], FileAccess.WRITE)
	file.store_string(JSON.stringify(out))
	file.close()
	quit()
