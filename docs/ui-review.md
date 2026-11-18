# Studio UI review (2026-11-18)

Audit of every tab in Claude in Chrome on the creator's Mac (1456x829 viewport) with a real project
(20 wiki pages, 5 regions, 45 rooms, 6 characters). Each item names the area and the owner of the fix.
Every item below is fixed on main and was checked in Chrome on a copy of the project (scripted chat and art).

## A. Chat (owner: chat) — done
1. ~~The chat column is too narrow~~ — wider by default; it resizes from its left edge and remembers the width.
2. ~~No way to edit (or retry) a message~~ — Edit on the latest message and Retry on the latest reply replace that
   exchange (its changes are undone first; when they can't be, it says so and sends as a new message). Every
   earlier message has Reuse, which copies it into the message box.
3. ~~Long raw change lists~~ — folded behind "N changes" and opened on request.
4. ~~Token and cost lines~~ — removed from replies.
5. ~~Small composer~~ — it grows with its text and shows Enter / Shift+Enter hints. Drafts survive a switch of
   assistant.
6. ~~Which assistant~~ — the header names the assistant, says what it does and which tabs it serves, and links the
   others.
7. ~~User messages easy to lose~~ — "You" turns are blocks with a time, and turns are separated.
   Follow-up found in Chrome: the "↓ Latest" pill covered the edit box's Send button (fixed in dc24d1a).

## B. App shell, navigation and side panels (owner: shell) — done
1. ~~Tab order~~ — Wiki, Progression, Architect · Rooms, Scenery, Characters, Game · Playtest.
2. ~~Ungrouped tabs~~ — grouped under Design / Build / Play, with a tooltip per tab and arrow-key moves.
3. ~~Reset / Example beside Undo~~ — moved into the project menu, which asks in the page before acting.
4. ~~"rev 54" and the bare dot~~ — replaced by a "Saved" / offline status.
5. ~~Can't rename the game~~ — rename from the project menu (double-click the name); Undo restores it.
6. ~~Cryptic Live menu~~ — now "Auto-build", with each part explained.
7. ~~Hard-to-navigate side panel~~ — one shared frame. Lists fold by group (remembered), have a filter and arrow
   keys, and the panel resizes.
8. ~~Unclear play controls~~ — "tests Arena ▸" says what ▶ Play plays and can switch it. The stage label reads
   "Editing Arena · ▶ Play to try it".

## C. Worlds vs Rooms (owner: worlds-rooms) — done
1. ~~Two kinds of "room"~~ — Worlds is now **Scenery**: a *look* (a region's art kit) and its *dressings*.
   Rooms are only the game's rooms.
2. ~~No relation shown~~ — each dressing shows the game room it dresses, and each look shows the rooms it dresses.
   A room shows its scenery and links to it. Both sides jump to each other.
3. ~~Cluttered panel~~ — folding sections for Looks, This look, Pieces and Dressings. Model ids sit in a folded
   "last job" line.
4. ~~Unexplained layer toggles~~ — labelled Layers and View groups, with a help mark.
5. ~~Flat room list and tiny map~~ — rooms are grouped by region with counts and a filter by name or scenery.
   The world map is larger, zoomable, and opens a room on click.
6. ~~Unlabelled tool groups~~ — Paint tiles / Place / Play with.
7. ~~No art state~~ — each room shows dressed, needs recompose or plain tiles, with a legend.

## D. Content views (owner: content) — done
1. ~~Raw markdown~~ — the wiki renders headings, lists and emphasis as a readable article.
2. ~~Review easy to miss~~ — a review bar on every draft (Accept / Discard / Skip). The side panel has "Review
   next" and "Accept all…", which asks in the page first.
3. ~~Small graph, empty space~~ — the progression graph fills the pane, fits, pans and zooms, and runs down or
   across.
4. ~~Nothing selected~~ — the player (or the first character) is always selected.
5. ~~Letterboxed game view~~ — the stage hugs the room. The inspector and game settings sit under it.
6. ~~Game tab hierarchy~~ — folding sections, and the art steps summarized in one line that opens.
7. ~~Long stage list~~ — a one-line stage list with "What each does", folding regions, and a run strip above the
   plan.

No browser dialogs remain (window.confirm/alert/prompt): every confirmation is in the page.
