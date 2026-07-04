"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";

export default function JoinLeaguePage() {
  const [error, setError] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const codeFromLink = new URLSearchParams(window.location.search).get("code");
    if (codeFromLink) setInviteCode(codeFromLink);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!getStoredToken()) {
      setError("Not logged in — visit /login first.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    setIsSubmitting(true);
    try {
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
      router.push(`/teams/squad-builder?teamId=${body.team.id}`);
    } catch {
      setError("Could not join league — check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Join League</h1>
      <div className="card" style={{ maxWidth: 400 }}>
        <form className="form-stack" onSubmit={handleSubmit}>
          <label>
            Invite code
            <input
              name="inviteCode"
              placeholder="From your league's share link"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              required
            />
          </label>
          <label>
            Your team name (optional)
            <input name="teamName" placeholder={'Defaults to "New Team"'} />
          </label>
          <button className="btn-primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Joining…" : "Join"}
          </button>
        </form>
        {error && <p className="msg msg-error" style={{ marginTop: "0.75rem" }}>{error}</p>}
      </div>
    </main>
  );
}
