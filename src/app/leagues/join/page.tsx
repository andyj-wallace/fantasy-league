"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";

export default function JoinLeaguePage() {
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!getStoredToken()) {
      setError("Not logged in — visit /login first.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const response = await authedFetch(`${getApiBaseUrl()}/leagues/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: formData.get("inviteCode"),
        teamName: formData.get("teamName") || undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.message ?? "Could not join league — try again.");
      return;
    }
    router.push(`/teams/${body.team.id}/squad-builder`);
  }

  return (
    <main>
      <h1>Join League</h1>
      <form onSubmit={handleSubmit}>
        <input name="inviteCode" placeholder="Invite code" required />
        <input name="teamName" placeholder="Your team name (optional)" />
        <button type="submit">Join</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
