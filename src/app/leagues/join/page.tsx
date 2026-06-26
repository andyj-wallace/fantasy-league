"use client";

import { useState, type FormEvent } from "react";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";

export default function JoinLeaguePage() {
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const response = await fetch(`${getApiBaseUrl()}/leagues/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: formData.get("inviteCode"),
        userId: formData.get("userId"),
      }),
    });
    setResult(await response.text());
  }

  return (
    <main>
      <h1>Join League</h1>
      <form onSubmit={handleSubmit}>
        <input name="inviteCode" placeholder="Invite code" />
        <input name="userId" placeholder="User ID" />
        <button type="submit">Join</button>
      </form>
      {result && <pre>{result}</pre>}
    </main>
  );
}
