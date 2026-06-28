"use client";

import { useState, type FormEvent } from "react";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredUserId } from "@/app/lib/auth";

export default function JoinLeaguePage() {
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userId = getStoredUserId();
    if (!userId) {
      setResult("Not logged in — visit /login first.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const response = await fetch(`${getApiBaseUrl()}/leagues/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: formData.get("inviteCode"),
        userId,
      }),
    });
    setResult(await response.text());
  }

  return (
    <main>
      <h1>Join League</h1>
      <form onSubmit={handleSubmit}>
        <input name="inviteCode" placeholder="Invite code" />
        <button type="submit">Join</button>
      </form>
      {result && <pre>{result}</pre>}
    </main>
  );
}
