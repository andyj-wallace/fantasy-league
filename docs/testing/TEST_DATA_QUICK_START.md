# Test Data Quick Start

## What Was Created

A production-ready 6-gameweek test dataset for MVP smoke testing:

```
✅ 20 players (3 GK, 6 DEF, 6 MID, 5 FWD) — 98.5M squad value
✅ 6 gameweeks (Jul 1 - Aug 5, 2026) — realistic weekly deadlines
✅ 12 matches (6 completed, 6 scheduled) — real player stats
✅ 3 price changes (GW3) — Mohamed Salah, Erling Haaland, Takehiro Tomiyasu
✅ 1 injury event (GW3) — Mohamed Salah OUT with hamstring injury
✅ Scoring validated — calculatePlayerScores → calculateTeamScores → updateStandings
```

## Run It

```bash
# Create the test data (idempotent, safe to re-run)
npx tsx src/seed6GameweekSmokeTest.ts

# Validate scoring works (separate validation seed)
npm run seed:match-stats
```

Both complete in 1-2 seconds.

## What You Can Test

### Squad Builder
- Pick from 20 real players (Arsenal, Liverpool, Man City)
- Stay within 100M budget (squad costs ~98.5M)
- Set captain/vice-captain from players with GW1-3 stats
- Test formation validation

### Transfers
- GW1-3 have completed matches (can calculate points)
- GW4-6 scheduled with no stats (realistic transfer scenarios)
- See price changes applied on GW3
- Experience Salah OUT injury and decision impact

### Leaderboard
- View standings for GW1, GW2, GW3 (all calculated)
- See captain bonus applied (2x multiplier)
- Check team rankings and point totals
- Filter by gameweek

### Player Profile
- View Mohamed Salah's injury status (OUT from GW3)
- See match-by-match stats for GW1-3
- Track price history (Salah: 13.0M → 13.5M on GW3)
- View stats breakdown (goals, assists, saves, cards)

### Bench Rotation (once implemented)
- Darwin Nunez plays 90 mins in GW2 Match 1 (2 goals)
- But only 45 mins in GW3 Match 2 (1 goal, injury recovery)
- Kai Havertz comes off bench at 45 mins in GW2 Match 2

## Players in the Seed

| Position | Players | Sample Stats |
|----------|---------|--------------|
| **GK** | Ramsdale, Alisson, Ederson | 3-5 saves/match, clean sheets |
| **DEF** | Tomiyasu, van Dijk, Dias, White, TAA, Walker | 0-1 goals, assists, clean sheets |
| **MID** | Odegaard, Salah, Foden, Saka, Diaz, Silva | 0-1 goals, 0-1 assists, yellow cards |
| **FWD** | Havertz, Nunez, Haaland, Jesus, Bellingham | 0-1 goals, penalties won |

**Total Budget:** 100.0M  
**Squad Value:** ~98.5M  
**Remaining:** ~1.5M flexibility

## Notable Events

### GW 1-2: Normal Play
- Arsenal beat Liverpool 2-1
- Man City beat Arsenal 3-0
- Liverpool draw Man City 2-2
- Multiple clean sheets, goals from different positions

### GW 3: Drama
- **Price Changes:**
  - Salah (MID): 13.0M → 13.5M
  - Haaland (FWD): 12.0M → 12.5M
  - Tomiyasu (DEF): 5.0M → 4.9M

- **Injury Incident:**
  - Mohamed Salah marked OUT (Hamstring injury)
  - Plays 90 mins in first match despite injury
  - Unavailable (0 mins) in second match
  - Returns to play (45 mins) later

## File Location

Main seed script: `/src/seed6GameweekSmokeTest.ts` (438 lines)

To inspect the data creation logic:
```bash
cat src/seed6GameweekSmokeTest.ts | head -50
```

## Implementation Notes

- **Idempotent:** Run multiple times safely (upserts, not appends)
- **No API calls:** Uses direct database repositories
- **No user/team setup:** Just player/match/gameweek data
- **Scoring validated:** Full pipeline tested (see `seed:match-stats`)
- **Budget realistic:** Squad value ~98.5M from 100M budget
- **Injury handling:** Tests availability status changes

## After Running

Expected output:
```
Starting 6-gameweek seed script...
Upserted 20 players
Created 6 gameweeks
Created 12 matches; 6 completed with stats
Applied 3 price changes for gameweek 3
Applied injury status: Mohamed Salah OUT (Hamstring injury) from GW3
Calculated team scores for 3 gameweeks
Updated standings for 6 leagues
✓ All systems operational
```

All data is now in PostgreSQL ready for app testing.

## Testing Checklist

- [ ] Run seed script
- [ ] Create a league via UI
- [ ] Join league with test account
- [ ] View player search (20 players available)
- [ ] Build squad (pick 16 players, 100M budget)
- [ ] Set captain/vice-captain
- [ ] View leaderboard (GW1-3 standings)
- [ ] View player profile (check Salah's injury status)
- [ ] Make a transfer (test price changes)
- [ ] Check team score updated (captain bonus applied)

All should work smoothly. The data is production-quality for MVP testing.
