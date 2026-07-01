# Testing Utilities

This directory contains seed scripts and test data generators for the fantasy league MVP.

## Seed Scripts

### `seed6GameweekSmokeTest.ts`

Generates a complete 6-gameweek smoke test season with:
- 20 realistic players across all positions (GK, DEF, MID, FWD)
- 6 gameweeks of fixtures with proper deadlines
- Player match statistics for gameweeks 1–3
- Price changes and injury events
- Full scoring pipeline validation

**Run:**
```bash
npx tsx src/testing/seed6GameweekSmokeTest.ts
```

**Duration:** ~1–2 seconds (idempotent, safe to re-run)

**Output:**
- 20 Player records
- 6 Gameweek records
- 12 Match records with statistics
- Standings and team scores calculated for GW1–3

## What's Included

- **Players**: Aaron Ramsdale, Alisson, Ederson, Tomiyasu, van Dijk, Dias, White, TAA, Walker, Odegaard, Salah, Foden, Saka, Diaz, Silva, Havertz, Nunez, Haaland, Jesus, Bellingham
- **Events**: GW3 price updates (Salah +0.5M, Haaland +0.5M), GW3 injury (Salah hamstring)
- **Test Coverage**: Squad builder (16-player roster, budget constraints), transfers (price changes, injuries), scoring, standings

## Related Documentation

See `/docs/testing/` for detailed findings:
- `SMOKE_TEST_FINDINGS.md` — Complete UX gap analysis from smoke testing
- `SEED_DATA_REPORT.md` — Inventory of all seeded data
- `TEST_DATA_QUICK_START.md` — Step-by-step testing checklist
- `OBSTACLES_AND_FINDINGS.md` — Issues encountered during seeding
- `FINAL_SUMMARY.txt` — Execution log
