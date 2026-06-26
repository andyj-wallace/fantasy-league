# Live-match polling budget

Back-of-envelope numbers behind the Live-Match Polling Strategy in
[`Fantasy League Architecture.txt`](../Fantasy%20League%20Architecture.txt). The football data
provider caps us at **100 requests/day**, excluding the provider's own account/quota-status
endpoint (free to call, used as the live throttle signal).

## Fixed costs per matchday

- Reserve: discovery (~1/gameweek) + injuries (1/day) + misc buffer (3) = **5 calls** off the top
- Live-tracking budget remaining: **95 calls**
- Confirmation pass (post-`MATCH_COMPLETED`, once per fixture): **2 calls/fixture**
- Per in-play round: 1 broad live-list call (shared across all fixtures) + 2 calls × number of
  fixtures still live — detail calls (`events` + `players`) don't batch across fixtures
- Live window per fixture: ~110 min (90 + stoppage + halftime; no extra time in league play)

## Formula

```
rounds   = floor( (95 − 2×F) / (1 + 2×F) )
interval = 110 / rounds
```

where `F` = fixtures concurrently live.

## Scenarios

| Scenario | F | Confirmation reserve | Left for rounds | Round cost | Rounds | Interval | Total calls used |
|---|---|---|---|---|---|---|---|
| Busiest realistic (Sat 3pm blackout) | 7 | 14 | 81 | 15 | 5 | **~22 min** | 94 / 100 |
| Typical day | 3 | 6 | 89 | 7 | 12 | **~9 min** | 95 / 100 |
| Light day | 1 | 2 | 93 | 3 | 31 | **~3.5 min** (practically floored ~5–10 min — no point outpacing the provider's own 15s–1min update cycle) | well under cap |
| Absolute floor (all 10 PL fixtures hypothetically simultaneous — never actually happens) | 10 | 20 | 75 | 21 | 3 | ~37 min | 88 / 100 |

## Open correction

The original worked example in the architecture doc estimated "~15–18 min" for the 7-fixture
case. That didn't carve out the confirmation-pass cost first. Once those 14 calls are reserved
up front, the real number is closer to **~22 min** — still comfortably under budget (94/100),
but coarser than what's currently written there.

## Known risk: confirmation passes owed across kickoff slots

A confirmation pass for an earlier kickoff slot (e.g. 15:00 fixtures, confirming ~16:50–17:05)
can land while a *later* slot (17:30 kickoff) is still mid-match and drawing from the same
shrinking daily pool. The adaptive scheduler needs to treat "confirmation passes already owed
today" as pre-reserved budget, not just look at raw remaining quota — otherwise it can
over-spend on early rounds and come up short for confirmations owed later in the day.
