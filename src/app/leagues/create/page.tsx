"use client";

import { useState, type FormEvent } from "react";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";

export default function CreateLeaguePage() {
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!getStoredToken()) {
      setResult("Not logged in — visit /login first.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const response = await authedFetch(`${getApiBaseUrl()}/leagues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
      }),
    });
    setResult(await response.text());
  }

  return (
    <main>
      <h1>Create League</h1>
      <form onSubmit={handleSubmit}>
        <input name="name" placeholder="League name" />
        <button type="submit">Create</button>
      </form>
      {result && <pre>{result}</pre>}
    </main>
  );
}
