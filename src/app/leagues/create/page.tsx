"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";

export default function CreateLeaguePage() {
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

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
      const response = await authedFetch(`${getApiBaseUrl()}/leagues`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          teamName: formData.get("teamName") || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Could not create league — try again.");
        return;
      }
      router.push(`/teams/squad-builder?teamId=${body.team.id}`);
    } catch {
      setError("Could not create league — check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Create League</h1>
      <div className="card" style={{ maxWidth: 400 }}>
        <form className="form-stack" onSubmit={handleSubmit}>
          <label>
            League name
            <input name="name" placeholder="e.g. Sunday Legends" required />
          </label>
          <label>
            Your team name (optional)
            <input name="teamName" placeholder={'Defaults to "New Team"'} />
          </label>
          <button className="btn-primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create"}
          </button>
        </form>
        <p style={{ marginTop: "0.75rem" }}>
          You'll get an invite code to share with friends after creating.
        </p>
        {error && <p className="msg msg-error" style={{ marginTop: "0.75rem" }}>{error}</p>}
      </div>
    </main>
  );
}
