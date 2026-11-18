# Studio UI review (2026-11-18)

Audit of every tab in Claude in Chrome on the creator's Mac (1456x829 viewport) with a real project
(20 wiki pages, 5 regions, 45 rooms, 6 characters). Each item names the area and the owner of the fix.
Status is updated as fixes land; every fix is validated in Chrome.

## A. Chat (owner: chat)
1. The chat column is too narrow (~290 px): long replies wrap every few words; no way to widen it.
2. No way to edit (or retry) a message already sent.
3. Replies end in long raw change lists ("drafted page the_underpass", "createItem", ...) that bury the reply.
4. Token and cost lines under every reply ("329.5k tokens · ~$0.284") are noise now that chat runs on the creator's login.
5. The composer is a small fixed box; no clear Enter-to-send / Shift+Enter hint; Send is easy to miss.
6. It isn't obvious which assistant you're talking to or why it changes between tabs (Build assistant / Director / Architect).
7. User messages are small right-aligned bubbles that are easy to lose among long replies; no timestamps or separation between turns.

## B. App shell, navigation and side panels (owner: shell)
1. Tabs aren't in the creator's order: Playtest comes first, the design tabs (Wiki, Progression, Architect) last.
2. Ten flat tabs with no grouping (design / build / play).
3. "Reset..." and "Example..." sit next to Undo in the toolbar: destructive and rarely used.
4. "rev 54" and the bare green dot are developer jargon.
5. "Untitled Game" can't be renamed from the toolbar.
6. The Live menu ("Live ✓") is cryptic about what it is and what it controls.
7. The side panel beside the chat (the "menu beside the chat") is hard to navigate: long flat lists (45 rooms, 20 wiki pages, every progression item), no search or filter, no collapsible groups, sections scroll away, panel widths are fixed.
8. "Edit mode — press Play to test" floating label and the play controls don't explain what is being played (playtest room vs world).

## C. Worlds vs Rooms (owner: worlds-rooms)
1. "Worlds" are really region art kits ("biomes"), each with its own "rooms" (compositions like "The Underpass 1") that are not the game's rooms on the Rooms tab. Two kinds of "room", one name.
2. Nothing shows which game rooms or regions a biome dresses, or which biome a game room uses.
3. The Worlds side panel mixes kit text, repaint controls, room composition, atmosphere sliders and model ids/costs in one long column.
4. The layer toggles row (Far, Mid, Back, Play, Front, Fog, Lights, Exploded) has no explanation.
5. Rooms: 45 rooms in one flat list, not grouped by region; the world map strip is a few pixels tall.
6. Rooms: the tool row (Empty/Solid/Ledge/...) and the ability checkboxes for "Play from here" are unlabelled as groups.
7. A room's art state (dressed? out of date?) isn't visible in the Rooms list.

## D. Content views (owner: content)
1. Wiki pages show raw markdown: "## Pitch", "- " bullets inline instead of headings and lists.
2. Wiki: "Needs review (20)" and per-page Accept/Discard are easy to miss; no bulk accept.
3. Progression: a small graph at the top and a large empty area below; the graph can't be zoomed or panned.
4. Characters tab: nothing is selected by default, leaving a tiny game preview in a large empty area.
5. Playtest/Characters/Game: the game view is letterboxed with large empty margins.
6. Game tab: the art step list is a long raw list; sections (Check, Art, Rules, Map, ...) have little hierarchy.
7. Architect: the stage list in the side panel is long; the plan view and the run don't fit together on one screen.
