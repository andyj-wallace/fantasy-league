import Link from "next/link";

export default function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <p>That page doesn't exist.</p>
      <div className="link-list">
        <Link href="/">Back to your leagues</Link>
      </div>
    </main>
  );
}
