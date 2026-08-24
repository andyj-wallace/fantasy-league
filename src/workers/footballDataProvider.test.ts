import { describe, expect, it } from "vitest";
import { StubFootballDataProvider } from "./footballDataProvider";

/**
 * The stub is the default provider wherever no real data source is configured (tests, local runs
 * without an API key), so its "answer nothing" contract is load-bearing: a caller must get an
 * empty result rather than an undefined or a thrown error.
 */
describe("StubFootballDataProvider.fetchFixturesByExternalIds", () => {
  it("answers a targeted reconciliation lookup with no fixtures at all", async () => {
    // Exercised directly rather than through a subclass: liveMatchPolling's tests override this
    // method, so nothing there would notice if the base implementation stopped returning [].
    // A tick that gets [] simply leaves the matches unresolved for the next tick.
    const provider = new StubFootballDataProvider();

    await expect(provider.fetchFixturesByExternalIds(["1557367", "1557368"])).resolves.toEqual([]);
  });

  it("answers an empty id list the same way, without special-casing it", async () => {
    const provider = new StubFootballDataProvider();

    await expect(provider.fetchFixturesByExternalIds([])).resolves.toEqual([]);
  });
});
