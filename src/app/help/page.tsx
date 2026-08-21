import { Fragment } from "react";
import type { Metadata } from "next";

/** The public rules-and-how-to page, linked from the header on every screen and — along with the
 * signed-out landing page — one of the only two screens that works without an account. Every
 * figure here is the V1 ruleset as the code actually implements it: the point table mirrors
 * workers/calculatePlayerScores.ts and the limits mirror domain/constants.ts, so a rules change
 * has to land here too or this page starts lying to managers. */

export const metadata: Metadata = { title: "Help" };

/** Rendered in the position columns where a scoring event can't apply to that position at all. */
const NOT_APPLICABLE = "—";

const gettingStartedSteps = [
  "Create a league, or join one with an invite code from a friend",
  "Build a 16-man squad within the £110M budget",
  "Pick your starting XI, formation, captain and vice-captain",
  "Watch the leaderboard as each gameweek is scored",
];

const leagueFacts = [
  { label: "Competition", value: "Premier League" },
  { label: "Leagues", value: "Private, invite code only" },
  { label: "Managers per league", value: "Up to 50" },
  { label: "Cost", value: "Free" },
  { label: "Join cutoff", value: "Gameweek 25" },
];

const squadFacts = [
  { label: "Budget", value: "£110M" },
  { label: "Squad size", value: "16 (11 starters, 5 bench)" },
  { label: "Goalkeepers", value: "Exactly 2" },
  { label: "Players from one club", value: "Maximum 3" },
];

const transferFacts = [
  { label: "Free transfers", value: "2 per gameweek" },
  { label: "Banking limit", value: "8 saved up" },
  { label: "Extra transfers", value: "-10 points each" },
  { label: "Postponed matches", value: "1 extra free transfer per affected club" },
];

const scoringRows = [
  { action: "Playing in a match", gk: "+1", def: "+1", mid: "+1", fwd: "+1" },
  { action: "Scoring a goal", gk: "+10", def: "+8", mid: "+6", fwd: "+4" },
  { action: "Assisting a goal", gk: "+3", def: "+3", mid: "+3", fwd: "+3" },
  { action: "Clean sheet", gk: "+4", def: "+4", mid: NOT_APPLICABLE, fwd: NOT_APPLICABLE },
  { action: "Every 3 saves", gk: "+1", def: NOT_APPLICABLE, mid: NOT_APPLICABLE, fwd: NOT_APPLICABLE },
  { action: "Winning a penalty", gk: "+2", def: "+2", mid: "+2", fwd: "+2" },
  { action: "Yellow card", gk: "-1", def: "-1", mid: "-1", fwd: "-1" },
  { action: "Red card", gk: "-2", def: "-2", mid: "-2", fwd: "-2" },
  { action: "Own goal", gk: "-2", def: "-2", mid: "-2", fwd: "-2" },
  { action: "Conceding a penalty", gk: "-1", def: "-1", mid: "-1", fwd: "-1" },
];

const goalTimingBrackets = [
  { label: "Up to 75 minutes", value: "5 points" },
  { label: "76 to 80 minutes", value: "6 points" },
  { label: "81 to 85 minutes", value: "8 points" },
  { label: "86 to 90 minutes", value: "10 points" },
  { label: "After 90 minutes", value: "13 points" },
];

const tiebreakers = [
  "Most goals scored by the players in your squad",
  "Most free transfers still banked",
  "Least money spent on your squad",
  "Still level, and the managers share the same position",
];

const commonQuestions = [
  {
    question: "What if my captain doesn't play?",
    answer:
      "Your vice-captain scores double instead. That swap only happens automatically if you haven't reassigned the captaincy yourself before your captain's match kicks off. If neither of them plays, nobody in your team scores double that gameweek.",
  },
  {
    question: "Do bench players substitute in?",
    answer:
      "No, there are no automatic substitutions. All 16 of your players score into your total, starters and bench alike, so a starter who doesn't play simply contributes nothing rather than being replaced.",
  },
];

/** The page's recurring device: a block of fixed rules as label/value pairs. `.detail-list` lays
 * the dt/dd pairs out as a two-column grid itself, so each pair goes in bare rather than wrapped. */
function FactList({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <dl className="detail-list">
      {facts.map((fact) => (
        <Fragment key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export default function HelpPage() {
  return (
    <main>
      <h1>How to play</h1>
      <p>
        Everything you need to run a team: how leagues work, how to build a squad, when you can
        make transfers, and exactly how points are scored.
      </p>

      <h2>Getting started</h2>
      <ol className="steps">
        {gettingStartedSteps.map((step, index) => (
          <li key={step} className="step">
            <span className="step-number">{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <h2>Leagues</h2>
      <FactList facts={leagueFacts} />
      <p>
        Whoever creates a league runs it. They can rename it, share or regenerate the invite code,
        and remove a manager, and they can lock the settings once the season is underway. Scoring
        starts from the gameweek after you join, so joining midway through a season never awards
        you points for matches already played.
      </p>

      <h2>Building your squad</h2>
      <FactList facts={squadFacts} />
      <p>
        Your starting XI has to fit one of seven formations: 3-4-3, 3-5-2, 4-3-3, 4-4-2, 4-5-1,
        5-3-2 or 5-4-1. Whichever you pick, you always start exactly one goalkeeper, and your
        remaining ten outfield places follow the shape you chose.
      </p>
      <div className="msg msg-info">
        Player prices are recalculated monthly and your budget moves with them. The availability
        badge on a player card is there for information only, so an injured player can still be
        bought, sold or picked whenever you like.
      </div>

      <h2>Transfers</h2>
      <FactList facts={transferFacts} />
      <p>
        Transfers are unlimited before the season starts and during the mid-season break. After
        that you get two free each gameweek, and any you don't use carry over. Postponed matches
        earn you an extra free transfer for each club affected, not for each player, but the total
        you can bank is capped at eight however you earn them.
      </p>
      <div className="msg msg-info">
        Players lock one at a time, at the kickoff of their own match, rather than all at once. A
        player whose match hasn't started can still be transferred, benched or given the armband,
        even if the rest of your team is already locked.
      </div>

      <h2>Scoring</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">GK</th>
              <th scope="col">DEF</th>
              <th scope="col">MID</th>
              <th scope="col">FWD</th>
            </tr>
          </thead>
          <tbody>
            {scoringRows.map((row) => (
              <tr key={row.action}>
                <td>{row.action}</td>
                <td>{row.gk}</td>
                <td>{row.def}</td>
                <td>{row.mid}</td>
                <td>{row.fwd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        A clean sheet only pays a goalkeeper or a defender, and only if they actually played.
        Saves are counted in threes across the whole match, so five saves earn a point and six
        earn two.
      </p>

      <h3>Captaincy</h3>
      <p>
        Your captain scores double. Your vice-captain is the backup, and picks up the double only
        if your captain doesn't play, as long as you haven't changed the captaincy yourself before
        kickoff.
      </p>

      <h3>Match-defining goals</h3>
      <div className="card">
        <p>
          Goals that actually win or level a match earn bonus points for the scorer and whoever
          assisted. Goals that put a team behind for good cost points from the goalkeeper and
          defenders who started that match for the losing side, or from whoever put through their
          own net.
        </p>
        <p>
          The later the goal, the bigger the swing, and added time counts toward the minute. A
          goal in the 93rd minute is treated as a goal after 90.
        </p>
        <FactList facts={goalTimingBrackets} />
      </div>

      <h2>The leaderboard</h2>
      <p>
        Scores are worked out as matches finish and the standings are stored ready to read, with a
        timestamp showing when they were last updated. On a busy afternoon with several matches
        running at once, they can take a little longer to settle.
      </p>
      <p>When two managers finish level on points, these are checked in order until the tie breaks.</p>
      <ol className="steps">
        {tiebreakers.map((tiebreaker, index) => (
          <li key={tiebreaker} className="step">
            <span className="step-number">{index + 1}</span>
            <span>{tiebreaker}</span>
          </li>
        ))}
      </ol>

      <h2>Common questions</h2>
      <section className="feature-grid">
        {commonQuestions.map((entry) => (
          <div key={entry.question} className="feature-card">
            <h3 className="feature-title">{entry.question}</h3>
            <p>{entry.answer}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
