/** The shared "data is on its way" placeholder — pages must never render a blank screen while
 * loading (a smoke-test finding), so anything async shows this instead of returning null. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <main>
      <p aria-busy="true">{label}</p>
    </main>
  );
}
