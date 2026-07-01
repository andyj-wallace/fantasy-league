# Fantasy League 6-Gameweek Smoke Test Findings

**Date**: 2026-07-01  
**Test Scope**: Critical path (league creation → squad builder → gameweek progression → scoring visibility)  
**Season Duration**: 6 gameweeks (Jul 1 – Aug 5, 2026)  
**Focus**: Navigation difficulty, missing user awareness mechanisms, missing status indicators  

---

## Executive Summary

The app has a solid skeleton UI with functional CRUD operations for leagues, squad building, and standings display. However, it is **missing critical context layers** that tell users where they are in the season timeline, when actions are required, and what changes have occurred. Users will be confused about:
- Which gameweek they're currently in
- When matches are played and why players are locked
- Whether scores have been calculated and from which gameweek
- When transfer windows open/close
- Why the standings changed

This is a **high-priority UX gap** before launch. The backend scoring logic works correctly (validated via seed data), but the frontend never tells users about it.

---

## Test Data Created (Agent 1)

✅ **Status: READY FOR TESTING**

### Players (20 total)
- **3 Goalkeepers**: Aaron Ramsdale (4.5M), Alisson (5.5M), Ederson (5.0M)
- **6 Defenders**: Tomiyasu (5.0M → 4.9M), van Dijk (5.5M), Dias (5.0M), White (4.5M), TAA (6.5M), Walker (5.0M)
- **6 Midfielders**: Odegaard (7.5M), Salah (13.0M → 13.5M), Foden (8.5M), Saka (7.5M), Diaz (7.0M), Silva (8.0M)
- **5 Forwards**: Havertz (7.5M), Nunez (8.0M), Haaland (12.0M → 12.5M), Jesus (6.5M), Bellingham (7.0M)

### Seasons Structure
- **6 Gameweeks** across 6 weeks (Jul 1 – Aug 5, 2026)
- **12 Matches** total (2 per gameweek)
- **Gameweek 1–3**: Completed with full player statistics
- **Gameweek 4–6**: Scheduled (ready for future scoring)
- **Realistic deadlines**: Wednesdays 11:30 UTC

### Player Match Statistics
- 42 total match performances across GW1–3
- Realistic data: goals, assists, saves, yellow/red cards, varied minutes
- Clean sheets, multiple scorers, injury scenarios tested

### Notable Events
- **GW3 Price Updates**: Salah +0.5M, Haaland +0.5M, Tomiyasu -0.1M
- **GW3 Injury**: Mohamed Salah marked OUT (hamstring) — plays full 90 in first match, unavailable in second

### How to Seed
```bash
npx tsx src/seed6GameweekSmokeTest.ts
```
- Duration: 1–2 seconds
- Idempotent: Safe to re-run
- File: `/src/seed6GameweekSmokeTest.ts` (438 lines)

### Obstacles Noted
- **TypeScript type mismatch** (resolved): Match interface expected `number | null`
- **No API seed endpoint**: Worked around with direct database repos; recommend `/api/internal/seed` for future
- **Gameweek status** remains UPCOMING by design (intentional)

---

## Squad Builder & League Creation Flow (Agent 2)

### What Works ✅

1. **League Creation → Squad Builder Pipeline**
   - Create league with invite code
   - Automatic team creation for creator
   - Redirect to squad builder immediately
   - Invite code clearly visible and copyable with WhatsApp share

2. **Squad Builder Completeness**
   - Comprehensive player discovery with filters (name, position, club, max price)
   - Budget display with remaining budget in stat tiles
   - Squad composition validation (16 players, 2 GK, max 3 per club)
   - Formation selection (4-3-3, etc.) with real-time slot feedback
   - Starting XI vs Bench with drag-to-move buttons
   - Captaincy limited to starting XI players
   - Formation-aware validation prevents invalid lineups
   - Specific error messages on constraint violations

3. **Form Validations**
   - Add/remove player shows inline error with tooltip (e.g., "£5.5M exceeds remaining budget")
   - Formation slot limits enforced
   - Captain/vice-captain must be different
   - Save button provides success/error feedback

### Navigation & Clarity Issues ❌

1. **Share Link Discovery is Hidden**
   - Invite code only appears on league page (after squad builder completion)
   - Create league page doesn't mention "you'll get a shareable link after creation"
   - First-time user might not know where to find share link
   - **Impact**: Users struggle to share league with friends

2. **No Explicit "Next Steps" After Squad Save**
   - Squad builder doesn't redirect after successful save
   - No breadcrumb, "back to league" link, or "done" state visible
   - **Impact**: User unsure if the process is complete or what to do next

3. **Missing "Incomplete Squad" Status on Home Page**
   - Home page shows teams with remaining budget
   - Doesn't indicate whether squad/lineup has been set
   - **Impact**: Can't see at a glance which teams need squad setup

4. **Formation Selection Before Roster Completion**
   - User must choose formation before moving players to Starting XI
   - Might pick formation then realize they can't fill all slots
   - Formation change clears all starting assignments
   - **Impact**: Requires rework if user changes formation strategy

### Missing Feedback & Prompts ❌

1. **No Confirmation Step Before Final Save**
   - Saves immediately on button click
   - No preview of final squad, total cost, or confirmation dialog
   - Success message only appears after save (could fail with API error)
   - **Impact**: Users might accidentally save incomplete squads

2. **No "Squad Complete" Success State**
   - Page doesn't change or provide clear visual feedback after save
   - Message "Squad and lineup saved." is subtle and easily missed
   - **Impact**: User uncertainty about whether save succeeded

3. **Budget Constraint Not Obvious During Player Discovery**
   - Budget display in stat tiles, separate from player table
   - Browsing 700+ players requires scrolling up to check remaining budget
   - No inline visual indicator (e.g., "remaining: £2.5M" next to player rows)
   - **Impact**: Users waste time checking budget repeatedly

4. **No Guidance for First-Time Users**
   - Squad builder assumes user knows formation syntax ("4-3-3")
   - No tooltips on formation names explaining composition
   - "Player Discovery" heading doesn't explain these are ALL available players
   - **Impact**: New users confused by formation notation and player count

5. **Player Availability Status Not Visible in Squad Builder**
   - Code checks `isClubLocked` on save, but UI doesn't show locked players
   - User builds valid squad only to hit error on save: "GK One is locked — match has started"
   - No upcoming match schedule or kickoff times displayed
   - **Impact**: Users hit errors they don't understand; can't plan ahead

6. **No Help Text for Formation & Captaincy**
   - Formation slot requirements shown only after selection
   - No description of what captain/vice-captain do (2x multiplier, fallback bonus)
   - **Impact**: New users don't understand captaincy impact on scoring

---

## Gameweek Progression & Season Visibility (Agent 3)

### Critical Visibility Gaps ❌

#### 1. No Gameweek Indicator Anywhere
- **Current State**: League standings page shows ranked teams but no indication of which gameweek (GW1, GW2, etc.)
- **Missing**: Gameweek number never displayed in UI
- **Where Needed**: League page header, standings table, transfers page, squad builder
- **Data Available**: API has `gameweekId` and `calculatedAt`, but not human-readable gameweek number
- **Impact**: User can't tell if viewing Gameweek 1 or Gameweek 8 standings

#### 2. No Match Schedule or Fixture Visibility
- **Current State**: Zero pages showing upcoming, live, or completed matches
- **Missing Pages**: No `/matches`, `/fixtures`, `/gameweek/[number]`, or `/schedule`
- **Data Exists**: Database has matches table with status (SCHEDULED, IN_PROGRESS, COMPLETED, POSTPONED), kickoff times, scores
- **User Can't See**:
  - When matches are played (kickoff times)
  - Which players are locked (lock at match kickoff)
  - Which matches are completed vs pending
  - Live match updates
- **Impact**: User blindsided when players suddenly lock; can't plan transfers around match schedule

#### 3. No Clear "Scores Have Been Calculated" Indicator
- **Current State**: Players show `totalFantasyPoints` but no explanation of:
  - Which gameweek those points are from
  - When they were last updated
  - Whether final or provisional
- **What Exists**: Standings page shows `calculatedAt` timestamp, but:
  - Only shown if standings exist for at least one team
  - Single timestamp for entire standings (not per-gameweek)
  - No explanation of what "updated" means
- **Missing**: Per-player score timestamps, "scores calculated for GW3" messaging
- **Impact**: User unsure if scores are current or stale

#### 4. No Player Lock Status Context
- **Current State**: Transfers page shows "Locked" badge (red) / "Available" badge (green)
- **Missing Context**:
  - Why they're locked (their match has started)
  - When the match started (kickoff time)
  - Which match they're playing (e.g., "Arsenal vs Chelsea")
  - Upcoming player locks (pre-match warning)
- **Impact**: User frustrated by "Locked" badge with no explanation

#### 5. Transfer Window Timing is Opaque
- **Current State**: Transfers page shows "Free transfers: 0/8" but doesn't explain:
  - Is a gameweek active right now?
  - When does the transfer window close (gameweek deadline)?
  - When do free transfers reset next week?
- **Data Available**: Gameweek `deadlineAt` exists but never displayed
- **Impact**: User unsure if they're in a time-limited window or can wait

#### 6. No "Gameweek Completed" Status Messaging
- **Current State**: When gameweek ends and matches complete:
  - No notification to user
  - No "Gameweek 1 is complete — scores finalized" banner
  - No explanation of what happens next (free transfers awarded, lineups lock, etc.)
- **Impact**: User doesn't realize gameweek ended; may miss transfer window

#### 7. Standings Page Messaging is Confusing
- **Current State**: Shows "No standings yet — these appear once a gameweek's matches have been scored."
- **Missing**: When standings DO appear, no message explaining they're final or which gameweek they represent
- **Impact**: Implicit rather than explicit communication; user must infer meaning

### Missing Status Indicators Table

| What Users Need | Where It Should Appear | Current Status |
|---|---|---|
| Current gameweek number | League page header, standings table, transfers page | ❌ Missing |
| Gameweek deadline / transfer window close time | Transfers page, squad builder, transfers list | ❌ Missing |
| Match schedule for the gameweek | Dedicated page or sidebar | ❌ No page exists |
| Which matches are live / completed | Matches page (doesn't exist) | ❌ Missing |
| Why players are locked (match kickoff time) | Transfers page locked badge, squad builder | ❌ Context missing |
| When scores were calculated per gameweek | Player cards, standings, transfers | ❌ Missing |
| Gameweek status (Upcoming / In Progress / Completed) | League page, sidebar, header | ❌ Missing |
| Free transfers available next gameweek | Transfers page | ❌ Missing |
| Which gameweek's standings we're viewing | Standings table header | ❌ Missing |

### Where Users Will Get Confused

1. **Season Progress Confusion**
   - User joins league, builds squad, days pass, returns to app
   - Standings show different teams at top
   - **User question**: "Am I looking at Gameweek 1 or Gameweek 5?"
   - **Current answer**: No way to know

2. **Player Scoring Confusion**
   - Player shows 44 total points
   - **User question**: "Is this one gameweek or cumulative? From which season?"
   - **Current answer**: App doesn't say

3. **Transfer Timing Confusion**
   - See "0/8 free transfers" available
   - **User question**: "Did I use all 8 this season? Or all 2 from this gameweek? What's next?"
   - **Current answer**: Page doesn't explain

4. **Locked Players Confusion**
   - Defender shows "Locked" badge
   - **User question**: "Is the match in progress? Already finished? Why can't I transfer?"
   - **Current answer**: Only the badge, no context

5. **Standings Update Confusion**
   - Standings show "Last updated 2026-07-01 05:08:54"
   - **User question**: "Are scores finalized? Recalculated constantly? Is this the last ANY score changed?"
   - **Current answer**: Timestamp is ambiguous without explanation

### Related Code Locations

- **League standings page**: `src/app/leagues/[leagueId]/page.tsx` (lines 128–169)
- **Transfers page**: `src/app/teams/[teamId]/transfers/page.tsx` (isLocked badges)
- **Squad builder**: `src/app/teams/[teamId]/squad-builder/page.tsx`
- **API standings endpoint**: `src/api/handlers/leaderboard/getLeagueStandings.ts`
- **Gameweek domain**: `src/domain/gameweek.ts` (has number, status, deadlineAt — not exposed to UI)
- **Match/fixture pages**: None exist in `/src/app`

---

## Summary: High-Priority UX Gaps

### Navigation (Medium Priority)
- [ ] Share link discovery (hidden on league page)
- [ ] No "next steps" after squad save
- [ ] No "incomplete squad" indicator on home page
- [ ] Formation selection workflow (rework on change)

### Feedback & Onboarding (Medium Priority)
- [ ] No confirmation step before save
- [ ] No "squad complete" success state
- [ ] Budget not shown inline during player discovery
- [ ] No first-time user guidance (formation, captaincy, constraints)
- [ ] Player availability status not visible in squad builder
- [ ] No help text for formation/captaincy

### Season Awareness (High Priority) ⚠️
- [ ] **No gameweek indicator anywhere in UI**
- [ ] **No match schedule / fixture visibility**
- [ ] **No "scores calculated" messaging**
- [ ] **No player lock status context**
- [ ] **Transfer window timing opaque**
- [ ] **No "gameweek completed" notifications**
- [ ] **Standings page messaging confusing**

---

## How to Run the Smoke Test

1. **Seed the test data:**
   ```bash
   npx tsx src/seed6GameweekSmokeTest.ts
   ```

2. **Start the dev server:**
   ```bash
   npm run dev
   ```

3. **Follow the critical path:**
   - Go to home page, click "Create League"
   - Fill in league name, click "Create"
   - Review invite code and share options
   - Click "Build Squad"
   - Pick 16 players (budget 100.0M), set formation, choose captain
   - Save squad
   - Go back to league page, view standings
   - View transfers page, try a transfer
   - Note all navigation friction, missing context, and UI gaps

---

## Notes

- All findings are **observation-based**, not fixes
- Backend scoring logic validated and working correctly
- Frontend skeleton UI is functional but lacks context layers
- **This is a critical UX gap before production launch**

