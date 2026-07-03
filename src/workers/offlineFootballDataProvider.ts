import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiFootballEnvelope } from "./apiFootballProvider";
import { ApiFootballProvider } from "./apiFootballProvider";

/** Where `npm run record:fixtures` writes recorded response envelopes and this provider reads
 * them. Resolved from the working directory because every consumer (npm scripts, vitest) runs
 * from the repo root — the offline provider is a dev/test tool, never deployed. */
export const RECORDED_FIXTURES_DIRECTORY_PATH = join(process.cwd(), "src", "workers", "__fixtures__");

/**
 * Deterministic file name for one recorded API-Football request: the path with slashes flattened,
 * plus the query params sorted by key — so the recorder and the offline provider always agree on
 * where a given request's envelope lives (e.g. `fixtures_players__fixture=1035045.json`).
 */
export function buildRecordedFixtureFileName(path: string, params: Record<string, string | number>): string {
  const flattenedPath = path.replace(/\//g, "_");
  const sortedParamPairs = Object.entries(params)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return sortedParamPairs ? `${flattenedPath}__${sortedParamPairs}.json` : `${flattenedPath}.json`;
}

/**
 * The Strategy-2 dev/test provider (see docs/remaining-gaps-todo.md): a FootballDataProvider that
 * replays response envelopes recorded once from the real API (`npm run record:fixtures`) instead
 * of touching the network. It extends ApiFootballProvider and substitutes only the HTTP entry
 * point, so every parsing/mapping code path — status codes, own-goal attribution, position labels
 * — is the real one, which is exactly what the import-layer regression tests need to exercise.
 */
export class OfflineFootballDataProvider extends ApiFootballProvider {
  constructor(
    seasonYear: number = Number(process.env.FOOTBALL_DATA_SEASON_YEAR ?? 2024),
    private readonly fixturesDirectoryPath: string = RECORDED_FIXTURES_DIRECTORY_PATH,
  ) {
    super("https://offline.invalid", "offline-provider-uses-no-key", seasonYear);
    // Recorded seasons are fully covered by definition — there is no live coverage flag to sync.
    this.setCurrentSeason(seasonYear, { fixturePlayerStats: true, injuries: true });
  }

  protected override async request<T>(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<ApiFootballEnvelope<T>> {
    const recordedFilePath = join(this.fixturesDirectoryPath, buildRecordedFixtureFileName(path, params));
    let recordedEnvelopeJson: string;
    try {
      recordedEnvelopeJson = await readFile(recordedFilePath, "utf8");
    } catch {
      throw new Error(
        `No recorded fixture for "${path}" with params ${JSON.stringify(params)} — expected ${recordedFilePath}. ` +
          `Record it once with \`npm run record:fixtures\` (see docs/remaining-gaps-todo.md, Strategy 2).`,
      );
    }
    return JSON.parse(recordedEnvelopeJson) as ApiFootballEnvelope<T>;
  }
}
