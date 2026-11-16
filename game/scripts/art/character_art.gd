extends RefCounted
## Connects characters to their art: builds the RigView for a character's
## appearance and picks which clip plays. Mirrors ACTION_CLIP_SLOTS in
## packages/core/src/art/clip.ts.

const RigView := preload("res://scripts/art/rig_view.gd")

const ACTION_CLIP_SLOTS := {
	"patrol": ["walk", "run"],
	"wait": ["idle"],
	"chase": ["run", "walk"],
	"charge": ["attack", "run"],
	"telegraph": ["windup"],
	"retreat": ["walk", "run"],
	"returnHome": ["walk"],
	"jump": ["jump"],
	"hover": ["fly"],
}


## The character's art asset, or {} when it is drawn as a box.
static func asset_for(character: Dictionary, art: Variant) -> Dictionary:
	var asset_id = character.get("appearance")
	if asset_id == null or typeof(art) != TYPE_DICTIONARY:
		return {}
	for asset in art.get("assets", []):
		if typeof(asset) == TYPE_DICTIONARY and asset.get("id") == asset_id and typeof(asset.get("rig")) == TYPE_DICTIONARY:
			return asset
	return {}


## A RigView for the asset (not yet added to the tree).
static func make_view(asset: Dictionary, art: Dictionary) -> Node2D:
	var view = RigView.new()
	view.setup(asset.rig, art.get("direction", {}), asset.get("clips", {}))
	# Keep animating in edit mode, when the world itself is frozen.
	view.process_mode = Node.PROCESS_MODE_ALWAYS
	return view


## First existing clip for a behavior state: explicit mapping, then the action's slots, then idle.
static func clip_for_state(asset: Dictionary, view: Node2D, state_id: String, action_type: String) -> String:
	var mapped = asset.get("stateClips", {}).get(state_id)
	if mapped != null and view.has_clip(str(mapped)):
		return str(mapped)
	return first_clip(view, ACTION_CLIP_SLOTS.get(action_type, []))


static func first_clip(view: Node2D, slots: Array) -> String:
	for slot in slots:
		if view.has_clip(slot):
			return slot
	return "idle" if view.has_clip("idle") else ""
