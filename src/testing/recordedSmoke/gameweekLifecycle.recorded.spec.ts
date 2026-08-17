import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "playwright/test";
import { advanceScenarioToCheckpoint } from "./advanceScenarioToCheckpoint";
import {
  EXPECTED_ALPHA_BUDGET,
  EXPECTED_BANKED_TRANSFERS,
  EXPECTED_GAMEWEEK_1_GOALS_TIEBREAKER,
  EXPECTED_GAMEWEEK_1_TEAM_TOTALS,
} from "./gameweekLifecycleScenario";
import { checkpointScreenshotsDirectory } from "./recordedSmokeArtifactPaths";
import { loadSeededScenarioEntities, type SeededScenarioEntities } from "./seedGameweekLifecycleScenario";

/**
 * The recorded gameweek-lifecycle walkthrough. One serial test so the run produces a single
 * continuous video; each checkpoint advances the scenario through the real worker pipeline
 * (see advanceScenarioToCheckpoint), reloads the UI, asserts what a user would see, and captures
 * a named screenshot into artifacts/recorded-smoke/checkpoints/.
 */

const API_BASE_URL = "http://localhost:3101";

mkdirSync(checkpointScreenshotsDirectory, { recursive: true });

function statTileValue(overlay: Locator, label: string): Locator {
  return overlay.locator(".stat-tile").filter({ hasText: label }).locator(".stat-tile-value");
}

/** The roster row for one player. The name cell renders as a tap-target button; matching on that
 * button (not row text) matters because other rows' collapsed transfer pickers repeat player
 * names as plain option text. */
function rosterRow(overlay: Locator, playerName: string): Locator {
  return overlay.locator("tbody tr").filter({ has: overlay.page().getByRole("button", { name: playerName, exact: true }) });
}

async function openLeaguePage(page: Page, entities: SeededScenarioEntities): Promise<void> {
  await page.goto(`/leagues?leagueId=${entities.leagueId}`);
  await expect(page.getByRole("heading", { name: "Recorded Smoke League" })).toBeVisible();
}

async function openAlphaTransfersPanel(page: Page, entities: SeededScenarioEntities): Promise<Locator> {
  await page.goto(`/leagues?leagueId=${entities.leagueId}&panel=transfers&teamId=${entities.alphaTeamId}`);
  const overlay = page.locator(".overlay-surface");
  await expect(overlay.getByRole("heading", { name: "Transfers" })).toBeVisible();
  await expect(overlay.locator("tbody tr")).toHaveCount(16);
  return overlay;
}

async function captureCheckpointScreenshot(page: Page, fileName: string): Promise<void> {
  await page.screenshot({ path: path.join(checkpointScreenshotsDirectory, fileName) });
}

/**
 * Drives one TransferPicker: open, search, pick, confirm.
 *
 * The Confirm press dispatches a click event on the button instead of a coordinate-based click.
 * The roster table's auto layout with the picker's width-100% search input inside a cell is
 * bistable: any style invalidation (the focus change a mousedown causes, for instance) can
 * re-solve the column widths ~4px differently, re-wrapping the lock-context text and shifting
 * every row ~19px — so a real mouse press can land mousedown on the button and mouseup beside
 * it, and the browser then dispatches the click on their common ancestor, silently swallowing
 * the press. Real users can hit this too — see the recorded-smoke notes in
 * docs/testing/README.md. dispatchEvent targets the button itself, immune to the layout shift,
 * while still exercising the exact React handler a user's click runs.
 */
async function transferPlayerOut(row: Locator, position: string, replacementName: string): Promise<void> {
  await row.getByText("Transfer out").click();
  await row.getByPlaceholder(`Search replacement ${position}s by name`).fill(replacementName);
  const replacementRadio = row.getByRole("radio");
  await replacementRadio.check();
  await expect(replacementRadio).toBeChecked();
  const confirmButton = row.getByRole("button", { name: "Confirm" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.dispatchEvent("click");
}

test("a gameweek spread across four days: per-kickoff locks, transfers, a postponement, a cross-gameweek kickoff, and final standings", async ({
  page,
  request,
}) => {
  const entities = await loadSeededScenarioEntities();
  const playerId = (externalId: string): string => {
    const id = entities.playerIdsByExternalId.get(externalId);
    if (!id) throw new Error(`Unknown scenario player ${externalId}`);
    return id;
  };

  // Surface browser-side failures (console errors, unhandled rejections) in the test output —
  // the transfer flow has no catch-all UI error state, so these are the only trail some bugs leave.
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[browser console.error] ${message.text()}`);
  });
  page.on("pageerror", (error) => console.log(`[browser pageerror] ${String(error)}`));

  // The stub auth provider accepts `stub.<userId>` outright, so the browser session is seeded
  // directly instead of walking the login flow at every checkpoint.
  await page.addInitScript(
    (session: { userId: string; token: string }) => {
      window.localStorage.setItem("userId", session.userId);
      window.localStorage.setItem("token", session.token);
    },
    { userId: entities.alexUserId, token: `stub.${entities.alexUserId}` },
  );

  await test.step("warm up the dev-server routes so recordings show real state changes, not compiles", async () => {
    await openLeaguePage(page, entities);
    await page.goto(`/leagues?leagueId=${entities.leagueId}&panel=transfers&teamId=${entities.alphaTeamId}`);
    await expect(page.locator(".overlay-surface").getByRole("heading", { name: "Transfers" })).toBeVisible();
  });

  await test.step("A — pre-gameweek: everything scheduled, nobody locked", async () => {
    await advanceScenarioToCheckpoint("A");
    await openLeaguePage(page, entities);

    const banner = page.locator("main .gameweek-banner");
    await expect(banner).toContainText("Gameweek 1");
    await expect(banner.getByText("Upcoming")).toBeVisible();
    await expect(banner).not.toContainText("Deadline passed");
    await expect(page.locator("header.app-header").getByText("GW 1", { exact: true })).toBeVisible();

    const fixtureRows = page.locator(".fixture-list li");
    await expect(fixtureRows).toHaveCount(4);
    await expect(fixtureRows.filter({ hasText: "Arsenal v Chelsea" })).toBeVisible();
    await expect(fixtureRows.filter({ hasText: "Spurs v Newcastle" })).toBeVisible();
    // The early GW2 fixture exists but belongs to next gameweek, so it must not be listed here.
    await expect(fixtureRows.filter({ hasText: "Aston Villa v Spurs" })).toHaveCount(0);

    await expect(page.getByText(/No standings yet/)).toBeVisible();
    await captureCheckpointScreenshot(page, "A-1-league-pre-gameweek.png");

    const overlay = await openAlphaTransfersPanel(page, entities);
    await expect(overlay.getByText("Available", { exact: true })).toHaveCount(16);
    await expect(overlay.getByText("Locked", { exact: true })).toHaveCount(0);
    await expect(statTileValue(overlay, "Free transfers")).toHaveText(String(EXPECTED_BANKED_TRANSFERS.alphaAtA));
    await expect(statTileValue(overlay, "Budget")).toHaveText(`£${EXPECTED_ALPHA_BUDGET.atA}M`);
    await captureCheckpointScreenshot(page, "A-2-transfers-all-available.png");
  });

  await test.step("B — Friday kickoff: only that match's clubs lock; others still transfer", async () => {
    await advanceScenarioToCheckpoint("B");
    await openLeaguePage(page, entities);
    await expect(page.locator(".fixture-list li").filter({ hasText: "Arsenal v Chelsea" }).getByText("Live")).toBeVisible();
    await captureCheckpointScreenshot(page, "B-1-friday-match-live.png");

    const overlay = await openAlphaTransfersPanel(page, entities);
    // The gameweek deadline (90 min before Friday's kickoff) has passed, yet locking stays
    // per-club: exactly the two Friday clubs' players are locked.
    await expect(overlay.getByText(/Deadline passed/)).toBeVisible();
    await expect(overlay.getByText("Locked", { exact: true })).toHaveCount(4); // both Arsenal + both Chelsea players

    const lockedArsenalRow = rosterRow(overlay, "Arsenal DEF 1");
    await expect(lockedArsenalRow.getByText("Locked", { exact: true })).toBeVisible();
    await expect(lockedArsenalRow.getByText(/kicked off/)).toBeVisible();
    await expect(lockedArsenalRow.locator("details.transfer-picker")).toHaveCount(0); // no transfer control at all

    const unlockedLiverpoolRow = rosterRow(overlay, "Liverpool FWD 1");
    await expect(unlockedLiverpoolRow.getByText("Available", { exact: true })).toBeVisible();
    await expect(unlockedLiverpoolRow.getByText(/Locks /)).toBeVisible();
    await captureCheckpointScreenshot(page, "B-2-locks-follow-kickoffs.png");

    // Server-side rule: a locked player is rejected even when the UI is bypassed.
    const rejectedTransfer = await request.post(`${API_BASE_URL}/teams/${entities.alphaTeamId}/transfers`, {
      headers: { authorization: `Bearer stub.${entities.alexUserId}` },
      data: { playerOutId: playerId("recsmoke-arsenal-def-1"), playerInId: playerId("recsmoke-villa-def-2") },
    });
    expect(rejectedTransfer.status()).toBe(400);
    expect(((await rejectedTransfer.json()) as { message?: string }).message).toContain("Arsenal DEF 1 is locked");

    // ...while an unlocked player still transfers normally through the UI.
    await transferPlayerOut(unlockedLiverpoolRow, "FWD", "Brighton FWD 1");
    await expect(overlay.getByText("Transfer confirmed: Liverpool FWD 1 → Brighton FWD 1.")).toBeVisible();
    await expect(rosterRow(overlay, "Brighton FWD 1")).toBeVisible();
    await expect(statTileValue(overlay, "Free transfers")).toHaveText(
      String(EXPECTED_BANKED_TRANSFERS.alphaAfterTransferAtB),
    );
    await expect(statTileValue(overlay, "Budget")).toHaveText(`£${EXPECTED_ALPHA_BUDGET.afterTransferB}M`);
    await expect(overlay.locator("ul.squad-list li")).toHaveCount(1);
    await captureCheckpointScreenshot(page, "B-3-unlocked-transfer-confirmed.png");
  });

  await test.step("C — Saturday full time: scores visible, no standings until the gameweek completes", async () => {
    await advanceScenarioToCheckpoint("C");
    await openLeaguePage(page, entities);

    const fridayFixture = page.locator(".fixture-list li").filter({ hasText: "Arsenal v Chelsea" });
    await expect(fridayFixture.getByText("Full time")).toBeVisible();
    await expect(fridayFixture).toContainText("2–0");
    const saturdayFixture = page.locator(".fixture-list li").filter({ hasText: "Liverpool v Man City" });
    await expect(saturdayFixture.getByText("Full time")).toBeVisible();
    await expect(saturdayFixture).toContainText("1–1");
    // Precompute-on-completion by design: mid-gameweek there is still nothing to rank.
    await expect(page.getByText(/No standings yet/)).toBeVisible();
    await captureCheckpointScreenshot(page, "C-1-saturday-full-time.png");

    const overlay = await openAlphaTransfersPanel(page, entities);
    const playedManCityRow = rosterRow(overlay, "Man City DEF 1");
    await expect(playedManCityRow.getByText("Locked", { exact: true })).toBeVisible();
    await expect(playedManCityRow.getByText(/played/)).toBeVisible(); // stays locked after full time
    await expect(rosterRow(overlay, "Spurs DEF 1").getByText("Available", { exact: true })).toBeVisible();
    await expect(overlay.getByText("Locked", { exact: true })).toHaveCount(7); // Arsenal/Chelsea/Man City pairs + captain Liverpool MID 1
    await captureCheckpointScreenshot(page, "C-2-locks-accumulate.png");
  });

  await test.step("D — Sunday: postponement awards transfers; the early GW2 kickoff locks nobody", async () => {
    await advanceScenarioToCheckpoint("D");
    await openLeaguePage(page, entities);
    await expect(page.locator(".fixture-list li").filter({ hasText: "Spurs v Newcastle" }).getByText("Postponed")).toBeVisible();
    // The GW2 fixture played this morning still isn't part of GW1's list.
    await expect(page.locator(".fixture-list li").filter({ hasText: "Aston Villa v Spurs" })).toHaveCount(0);
    await captureCheckpointScreenshot(page, "D-1-postponement-announced.png");

    const overlay = await openAlphaTransfersPanel(page, entities);
    // +1 banked transfer per affected club; Alpha rosters players from both postponed clubs.
    await expect(statTileValue(overlay, "Free transfers")).toHaveText(
      String(EXPECTED_BANKED_TRANSFERS.alphaAfterPostponementAtD),
    );

    // Postponed before kickoff, so the postponed clubs are transferable...
    const postponedSpursRow = rosterRow(overlay, "Spurs MID 1");
    await expect(postponedSpursRow.getByText("Available", { exact: true })).toBeVisible();
    await expect(postponedSpursRow.getByText(/postponed/)).toBeVisible();
    // ...and the clubs of the already-played GW2 fixture stay unlocked for GW1: locks derive
    // from gameweek membership, not from how close a kickoff is on the calendar.
    await expect(rosterRow(overlay, "Villa MID 1").getByText("Available", { exact: true })).toBeVisible();
    await expect(rosterRow(overlay, "Villa FWD 1").getByText("Available", { exact: true })).toBeVisible();

    // Spend the postponement award on the now-idle bench midfielder.
    await transferPlayerOut(postponedSpursRow, "MID", "Newcastle MID 1");
    await expect(overlay.getByText("Transfer confirmed: Spurs MID 1 → Newcastle MID 1.")).toBeVisible();
    await expect(statTileValue(overlay, "Free transfers")).toHaveText(
      String(EXPECTED_BANKED_TRANSFERS.alphaAfterTransferAtD),
    );
    await expect(statTileValue(overlay, "Budget")).toHaveText(`£${EXPECTED_ALPHA_BUDGET.afterTransferD}M`);
    await expect(overlay.locator("ul.squad-list li")).toHaveCount(2);
    await captureCheckpointScreenshot(page, "D-2-postponement-award-spent.png");
  });

  await test.step("E — Monday done, but the postponed match holds Gameweek 1 open", async () => {
    await advanceScenarioToCheckpoint("E");
    await openLeaguePage(page, entities);

    const mondayFixture = page.locator(".fixture-list li").filter({ hasText: "Aston Villa v Brighton" });
    await expect(mondayFixture.getByText("Full time")).toBeVisible();
    await expect(mondayFixture).toContainText("3–1");
    await expect(page.locator(".fixture-list li").filter({ hasText: "Spurs v Newcastle" }).getByText("Postponed")).toBeVisible();
    // Every playable match is done, yet the gameweek cannot complete around the postponed one.
    await expect(page.locator("main .gameweek-banner")).toContainText("Gameweek 1");
    await expect(page.getByText(/No standings yet/)).toBeVisible();
    await captureCheckpointScreenshot(page, "E-1-gameweek-held-open.png");

    const overlay = await openAlphaTransfersPanel(page, entities);
    // Documented quirk, asserted as-is: the postponed fixture keeps its original kickoff until
    // rescheduled, and isClubLocked only compares kickoffAt to now — so once that original time
    // passes, the postponed clubs read as locked again, labelled "kicked off" for a match that
    // never actually kicked off. See the recorded-smoke findings note in docs/testing/README.md.
    const relockedSpursRow = rosterRow(overlay, "Spurs DEF 1");
    await expect(relockedSpursRow.getByText("Locked", { exact: true })).toBeVisible();
    await expect(relockedSpursRow.getByText(/kicked off/)).toBeVisible();
    await captureCheckpointScreenshot(page, "E-2-postponed-club-relocked-quirk.png");
  });

  await test.step("F — postponed match replayed Wednesday: Gameweek 1 completes and standings finalize", async () => {
    await advanceScenarioToCheckpoint("F");
    await openLeaguePage(page, entities);

    // The completion cascade advanced the current gameweek...
    await expect(page.locator("header.app-header").getByText("GW 2", { exact: true })).toBeVisible();
    await expect(page.locator("main .gameweek-banner")).toContainText("Gameweek 2");
    // ...so the fixtures list now shows GW2: the early Sunday match and next Saturday's.
    const fixtureRows = page.locator(".fixture-list li");
    await expect(fixtureRows).toHaveCount(2);
    const earlyGameweek2Fixture = fixtureRows.filter({ hasText: "Aston Villa v Spurs" });
    await expect(earlyGameweek2Fixture.getByText("Full time")).toBeVisible();
    await expect(earlyGameweek2Fixture).toContainText("2–1");
    await expect(fixtureRows.filter({ hasText: "Chelsea v Man City" })).toBeVisible();

    // Standings are final and match the hand-computed expectations — Alpha's total includes the
    // vice-captain 2x fallback (captain never featured), and the goals tiebreaker excludes the
    // GW2 goals scored in the early fixture.
    await expect(page.getByRole("heading", { name: "Standings — after Gameweek 1" })).toBeVisible();
    await expect(page.getByText("Final for this gameweek.")).toBeVisible();
    const standingsRows = page.locator("main tbody tr");
    await expect(standingsRows).toHaveCount(2);
    const alphaCells = standingsRows.nth(0).locator("td");
    await expect(alphaCells.nth(0)).toHaveText("1");
    await expect(alphaCells.nth(1)).toHaveText("Alpha XI");
    await expect(alphaCells.nth(2)).toHaveText("Alex Manager");
    await expect(alphaCells.nth(3)).toHaveText(String(EXPECTED_GAMEWEEK_1_TEAM_TOTALS.alphaXI));
    await expect(alphaCells.nth(4)).toHaveText(String(EXPECTED_GAMEWEEK_1_GOALS_TIEBREAKER.alphaXI));
    await expect(alphaCells.nth(5)).toHaveText(String(EXPECTED_BANKED_TRANSFERS.alphaAtF));
    await expect(alphaCells.nth(6)).toHaveText("£72M");
    const bravoCells = standingsRows.nth(1).locator("td");
    await expect(bravoCells.nth(0)).toHaveText("2");
    await expect(bravoCells.nth(1)).toHaveText("Bravo XI");
    await expect(bravoCells.nth(2)).toHaveText("Riley Rival");
    await expect(bravoCells.nth(3)).toHaveText(String(EXPECTED_GAMEWEEK_1_TEAM_TOTALS.bravoXI));
    await expect(bravoCells.nth(4)).toHaveText(String(EXPECTED_GAMEWEEK_1_GOALS_TIEBREAKER.bravoXI));
    await expect(bravoCells.nth(5)).toHaveText(String(EXPECTED_BANKED_TRANSFERS.bravoAtF));
    await expect(bravoCells.nth(6)).toHaveText("£70.5M");
    await captureCheckpointScreenshot(page, "F-1-standings-final.png");

    const overlay = await openAlphaTransfersPanel(page, entities);
    await expect(overlay.locator(".gameweek-banner strong")).toHaveText("Gameweek 2");
    await expect(statTileValue(overlay, "Free transfers")).toHaveText(String(EXPECTED_BANKED_TRANSFERS.alphaAtF));
    // Locks now derive from Gameweek 2: the early Sunday fixture's clubs are locked for it...
    await expect(overlay.getByText("Locked", { exact: true })).toHaveCount(3); // both Villa players + Spurs DEF 1
    await expect(rosterRow(overlay, "Villa MID 1").getByText("Locked", { exact: true })).toBeVisible();
    await expect(rosterRow(overlay, "Spurs DEF 1").getByText("Locked", { exact: true })).toBeVisible();
    // ...a club with a GW2 fixture still to come shows when it locks...
    const chelseaRow = rosterRow(overlay, "Chelsea GK 1");
    await expect(chelseaRow.getByText("Available", { exact: true })).toBeVisible();
    await expect(chelseaRow.getByText(/Locks /)).toBeVisible();
    // ...and clubs without a GW2 fixture are simply available again.
    await expect(rosterRow(overlay, "Arsenal DEF 1").getByText("Available", { exact: true })).toBeVisible();
    // The per-gameweek transfer history reset with the new gameweek.
    await expect(overlay.getByText("No transfers made this gameweek yet.")).toBeVisible();
    await captureCheckpointScreenshot(page, "F-2-gameweek-2-locks.png");
  });
});
