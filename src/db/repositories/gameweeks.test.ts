import { describe, expect, it } from "vitest";

/**
 * The repository layer's first test. Every other test file in this repo mocks the
 * `db/repositories` barrel; this one goes the other way and asserts what the repository would
 * actually send to Postgres — without needing Postgres. Drizzle builds SQL lazily, so `.toSQL()`
 * returns `{ sql, params }` with every parameter already passed through its column encoder.
 *
 * What is pinned here is the encoding of `deadline_at` in
 * `buildInsertOrTightenDeadlineStatement`. That single statement writes the column twice — once
 * through Drizzle's typed INSERT and once inside an ON CONFLICT ... DO UPDATE `sql` template —
 * and the two paths do NOT encode a `Date` the same way unless the template value is explicitly
 * wrapped in `sql.param` with the column as its encoder:
 *
 *   - typed INSERT  -> PgTimestamp.mapToDriverValue -> value.toISOString() -> UTC. Correct.
 *   - bare Date in a `sql` template -> no encoder applies (Drizzle only encodes Column / SQL /
 *     Param / SQLWrapper chunks) -> node-postgres's prepareValue serialises it from LOCAL
 *     wall-clock components plus an offset, e.g. "2026-07-01T12:30:00.000+01:00" on BST.
 *
 * `gameweeks.deadline_at` is `timestamp` WITHOUT time zone, so Postgres casts that literal and
 * discards the offset — the local hour is stored, and reads re-append +0000. The result is a
 * silent drift equal to the writing process's UTC offset, invisible on a UTC machine or a fresh
 * seed. The `LEAST` comparison is wrong before the write even happens: with the candidate shifted
 * later, a genuinely earlier kickoff never tightens the stored deadline.
 *
 * A dummy DATABASE_URL is set before the dynamic imports below because `db/client.ts` constructs
 * a `pg.Pool` at module load. A Pool does not open a socket until a query actually runs, and
 * `.toSQL()` never runs one, so nothing connects.
 */

process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused?sslmode=disable";

const { buildInsertOrTightenDeadlineStatement } = await import("./gameweeks");

/** A deadline whose UTC hour differs from its local hour anywhere east or west of Greenwich, so
 * an unencoded Date is visibly not this string. */
const CANDIDATE_DEADLINE_AT = new Date("2026-07-01T11:30:00.000Z");
const CANDIDATE_DEADLINE_AT_AS_UTC_ISO_STRING = "2026-07-01T11:30:00.000Z";

/** The compiled statement writes `deadline_at` twice: `$3` in the VALUES list and `$5` in the
 * conflict-update `LEAST(...)`. Locate each by position rather than by value, so a regression that
 * changes the encoding still resolves the same two parameters. */
function compileStatementParameters(): { insertParameter: unknown; conflictUpdateParameter: unknown } {
  const compiled = buildInsertOrTightenDeadlineStatement(3, CANDIDATE_DEADLINE_AT).toSQL();
  const [, , insertParameter, , conflictUpdateParameter] = compiled.params;
  return { insertParameter, conflictUpdateParameter };
}

describe("buildInsertOrTightenDeadlineStatement", () => {
  it("compiles to one INSERT ... ON CONFLICT DO UPDATE that sets deadline_at with LEAST", () => {
    const compiled = buildInsertOrTightenDeadlineStatement(3, CANDIDATE_DEADLINE_AT).toSQL();
    expect(compiled.sql).toContain('on conflict ("number") do update set');
    expect(compiled.sql).toContain('LEAST("gameweeks"."deadline_at", $5)');
    expect(compiled.params).toHaveLength(5);
  });

  it("encodes the INSERT path's deadline_at as a UTC ISO-8601 string", () => {
    const { insertParameter } = compileStatementParameters();
    expect(insertParameter).toBe(CANDIDATE_DEADLINE_AT_AS_UTC_ISO_STRING);
  });

  it("encodes the conflict-update path's deadline_at as the same UTC ISO-8601 string", () => {
    const { conflictUpdateParameter } = compileStatementParameters();
    // A raw Date here means no column encoder was applied and node-postgres will fall back to
    // local wall-clock serialisation — see this file's header.
    expect(conflictUpdateParameter).not.toBeInstanceOf(Date);
    expect(conflictUpdateParameter).toBe(CANDIDATE_DEADLINE_AT_AS_UTC_ISO_STRING);
  });

  it("sends byte-identical values down both write paths, so LEAST compares like with like", () => {
    const { insertParameter, conflictUpdateParameter } = compileStatementParameters();
    expect(conflictUpdateParameter).toBe(insertParameter);
  });
});
