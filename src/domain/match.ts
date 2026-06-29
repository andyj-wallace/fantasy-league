import type { MatchStatus } from "./shared";

/** A real-world Premier League fixture, imported from the football data provider. */
export interface Match {
  id: string;
  /** The football data provider's fixture ID; null until the importer first sees this fixture. */
  externalId: string | null;
  gameweekId: string;
  homeClub: string;
  awayClub: string;
  kickoffAt: Date;
  status: MatchStatus;
  /** Present once the match reaches COMPLETED. */
  finalHomeScore: number | null;
  finalAwayScore: number | null;
}
