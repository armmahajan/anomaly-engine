import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, projectRevision, resetProject } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

test("the narrative director drafts the wiki; the creator reviews, edits and extends it", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  const article = page.getByTestId("wiki-article");
  const sidebarPage = (id: string) => page.getByTestId(`wiki-page-${id}`);
  const review = page.getByRole("button", { name: /Needs review/ });

  await page.getByRole("tab", { name: "Wiki" }).click();
  await expect(page.getByTestId("chat-narrative").getByRole("heading")).toHaveText("Director");
  await expect(page.getByRole("heading", { name: "Your game's wiki" })).toBeVisible();

  // The director drafts a skeleton from a pitch, as drafts.
  await page.getByLabel("Message").fill("A flooded kingdom; the player is the last lamplighter.");
  await page.getByLabel("Message").press("Enter");
  const reply = page.getByTestId("chat-reply").last();
  await expect(reply).toContainText("Who is the antagonist?");
  await expect(reply).toContainText("drafted page overview");
  await expect(review).toHaveText("Needs review (4)");
  await expect(page.getByRole("tab", { name: "Wiki" })).toContainText("4");
  await expect(page.getByRole("heading", { name: "Deity" })).toBeVisible();

  // The overview shows first; links navigate; missing links are flagged.
  await expect(article.getByRole("heading", { level: 1 })).toHaveText("Drowned Lamp");
  await expect(article).toContainText("Draft by the director");
  await article.getByRole("button", { name: "the last lamplighter" }).click();
  await expect(article.getByRole("heading", { level: 1 })).toHaveText("The Lamplighter");
  await expect(article.getByRole("button", { name: "Wanderer →" })).toBeVisible();
  await expect(page.getByTestId("wiki-gaps")).toContainText("links to [[charger_lore]], which doesn't exist");
  await expect(page.getByTestId("wiki-gaps")).toContainText("Crawler (enemy) is in the game but has no wiki page.");

  // Accept one draft; edit another by hand, which makes it canon.
  await article.getByRole("button", { name: "Accept" }).click();
  await expect(article.getByText("Canon", { exact: true })).toBeVisible();
  await expect(review).toHaveText("Needs review (3)");
  await sidebarPage("drowned_city").click();
  await article.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Summary").fill("Streets under black, singing water.");
  await page.getByRole("button", { name: "Save as canon" }).click();
  await expect(article).toContainText("Streets under black, singing water.");
  await expect(article.getByText("Canon", { exact: true })).toBeVisible();
  await expect(article.locator(".wiki-link.missing")).toHaveText("Chargers");

  // A page of a brand-new kind gets its own group.
  await page.getByRole("button", { name: "+ Page" }).click();
  await page.getByLabel("Title").fill("The Hollow Bell");
  await page.getByLabel("Kind").fill("relic");
  await page.getByLabel("Body").fill("Rung once by [[hero]].");
  await page.getByRole("button", { name: "Save as canon" }).click();
  await expect(page.getByRole("heading", { name: "Relic" })).toBeVisible();
  await expect(article.getByRole("heading", { level: 1 })).toHaveText("The Hollow Bell");
  await article.getByRole("button", { name: "The Lamplighter" }).click();
  await expect(article.getByText("Linked from:")).toContainText("The Hollow Bell");

  // Discarding a draft is one undoable step.
  await sidebarPage("the_tide").click();
  await article.getByRole("button", { name: "Discard" }).click();
  await expect(sidebarPage("the_tide")).toHaveCount(0);
  await page.getByRole("button", { name: "↶ Undo" }).click();
  await expect(sidebarPage("the_tide")).toBeVisible();

  // A gap turns into a pre-filled page for the in-game character.
  await page.getByTestId("wiki-gaps").getByRole("listitem").filter({ hasText: "Crawler" }).getByRole("button", { name: "Write page" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Crawler");
  await expect(page.getByLabel("In-game character")).toHaveValue("crawler");
  await page.getByLabel("role value").fill("vermin of the drowned streets");
  await page.getByRole("button", { name: "Save as canon" }).click();
  await expect(article.getByRole("heading", { level: 1 })).toHaveText("Crawler");
  await expect(page.getByTestId("wiki-gaps")).not.toContainText("Crawler (enemy)");

  // The arena keeps its own chat; characters link to their wiki pages.
  await article.getByRole("button", { name: "Crawler →" }).click();
  await expect(page.getByTestId("chat-build").getByRole("heading")).toHaveText("Build assistant");
  await expect(page.getByTestId("chat-reply")).toHaveCount(0);
  await page.getByTestId("character-player").click();
  await page.getByRole("button", { name: "Wiki page →" }).click();
  await expect(article.getByRole("heading", { level: 1 })).toHaveText("The Lamplighter");
  await expect(page.getByTestId("chat-reply")).toHaveCount(1);

  expect(consoleErrors).toEqual([]);
});

test("opening the wiki stops a playtest", async ({ page }) => {
  await openStudio(page);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
  await page.getByRole("tab", { name: "Wiki" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Editing");
  await page.getByRole("tab", { name: "Arena" }).click();
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByTestId("runtime-status")).toHaveText("Playing");
});
