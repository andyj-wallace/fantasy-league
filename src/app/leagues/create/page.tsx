"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";

export default function CreateLeaguePage() {
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
  }

  return (
    <main>
      <h1>Create League</h1>
      <div className="card" style={{ maxWidth: 400 }}>
        <form className="form-stack" onSubmit={handleSubmit}>
          <input name="name" placeholder="League name" required />
          <input name="teamName" placeholder="Your team name (optional)" />
          <button className="btn-primary" type="submit">Create</button>
        </form>
        {error && <p className="msg msg-error" style={{ marginTop: "0.75rem" }}>{error}</p>}
      </div>
    </main>
  );
}
