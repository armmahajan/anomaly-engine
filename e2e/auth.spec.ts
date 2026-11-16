import { expect, test } from "@playwright/test";
import { E2E_TOKEN } from "./paths.ts";
import { openStudio } from "./helpers.ts";

// The API is protected by the studio token; the page gets it via the ?token= link.

test("the studio needs its token link; the API rejects anonymous calls", async ({ page, playwright, baseURL }) => {
  // No token: the page explains what to do instead of half-working.
  await page.goto("/");
  await expect(page.getByText("This studio needs its access token")).toBeVisible();

  // Wrong token: still locked out.
  await page.goto("/?token=wrong");
  await expect(page.getByText("This studio needs its access token")).toBeVisible();

  // Right token: redirected to the clean URL and fully working (reload keeps working via the cookie).
  await openStudio(page);
  expect(new URL(page.url()).search).toBe("");
  await page.reload();
  await openStudio(page);

  // A client without the cookie or header gets 401, even for reads.
  const anonymous = await playwright.request.newContext({ baseURL });
  expect((await anonymous.get("/api/project")).status()).toBe(401);
  const edit = await anonymous.post("/api/ops", {
    data: { name: "moveSpawn", input: { spawnId: "charger_1", x: 700 }, baseRevision: 0 },
  });
  expect(edit.status()).toBe(401);
  expect((await anonymous.get("/api/project", { headers: { "x-studio-token": E2E_TOKEN } })).status()).toBe(200);
  await anonymous.dispose();
});
