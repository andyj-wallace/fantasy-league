"use client";

/** App-level error boundary — an unexpected render/runtime error shows this instead of a white
 * screen, with a retry that re-renders the failed segment. */
export default function RootError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p className="msg msg-error">An unexpected error occurred. Your data is safe — try again.</p>
      <button className="btn-primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
