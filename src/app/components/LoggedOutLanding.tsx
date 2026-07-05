import Link from "next/link";

/** The landing view for signed-out visitors. The app's only public page, so it does the
 * explaining the app can't do once you're in: what the game is, and how to start. Copy is
 * grounded in the real V1 rules (£110M budget, 16-man squad, 2 free transfers/GW, captain 2×). */

const features = [
  {
    title: "Build your squad",
    body: "Pick 16 players on a £110M budget, choose one of seven formations, and hand the armband to a captain who scores double.",
  },
  {
    title: "Make your moves",
    body: "Two free transfers every gameweek, with unused ones carrying over. React to form, injuries and fixtures before the deadline locks your players.",
  },
  {
    title: "Climb the table",
    body: "Scores update automatically after every match — no spreadsheets. Goals, assists, clean sheets and cards all count.",
  },
  {
    title: "Play with friends",
    body: "Spin up a private league, share the invite code, and settle who really knows football over a full season.",
  },
];

const steps = [
  "Create a league, or join one with an invite code",
  "Build your 16-man squad within the £110M budget",
  "Set your lineup, formation, captain and vice-captain",
  "Watch the leaderboard as each gameweek is scored",
];

export function LoggedOutLanding() {
  return (
    <main>
      <section className="landing-hero">
        <span className="landing-eyebrow">Private Fantasy Premier League</span>
        <h1 className="landing-title">Draft your squad. Outsmart your mates.</h1>
        <p className="landing-lede">
          Build a 16-man squad on a £110M budget, make your transfers each gameweek, and battle your friends
          up the table all season long.
        </p>
        <div className="landing-cta">
          <Link href="/login" className="btn-hero">Log in or sign up</Link>
          <span className="landing-cta-note">Free to play · invite-only leagues</span>
        </div>
      </section>

      <section className="feature-grid">
        {features.map((feature) => (
          <div key={feature.title} className="feature-card">
            <h2 className="feature-title">{feature.title}</h2>
            <p>{feature.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-steps-section">
        <h2 className="landing-steps-heading">How it works</h2>
        <ol className="steps">
          {steps.map((step, index) => (
            <li key={step} className="step">
              <span className="step-number">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
