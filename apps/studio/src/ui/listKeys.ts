import type { KeyboardEvent } from "react";

/**
 * Keyboard navigation for side-panel lists. Items are the buttons of
 * `ul.character-list` rows and anything marked `data-list-item`. With focus on
 * an item, ↑/↓ move to the previous/next visible item (across sections and
 * groups), Home/End to the first/last; Enter or Space opens it (it is a button).
 * From a filter box (`data-list-filter`), ↓ moves into the list.
 *
 * SidePanel puts this on every side panel, so lists using that markup need nothing more.
 */
export const LIST_ITEM_SELECTOR = ".character-list > li > button:first-of-type, [data-list-item]";

export function listItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(LIST_ITEM_SELECTOR)].filter(
    (el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled,
  );
}

export function listKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const target = e.target as HTMLElement;
  const fromFilter = target.matches("[data-list-filter]");
  if (!fromFilter && !target.matches(LIST_ITEM_SELECTOR)) return;
  if (fromFilter && e.key !== "ArrowDown") return;
  const items = listItems(e.currentTarget);
  if (items.length === 0) return;
  const at = fromFilter ? -1 : items.indexOf(target);
  const next =
    e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1)
    : e.key === "ArrowUp" ? Math.max(0, at - 1)
    : e.key === "Home" ? 0
    : e.key === "End" ? items.length - 1
    : null;
  if (next === null) return;
  e.preventDefault();
  items[next]!.focus();
  items[next]!.scrollIntoView({ block: "nearest" });
}
