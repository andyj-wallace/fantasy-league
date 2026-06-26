"use client";

import { useState, type FormEvent } from "react";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";

export default function CreateLeaguePage() {
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const response = await fetch(`${getApiBaseUrl()}/leagues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        commissionerUserId: formData.get("commissionerUserId"),
      }),
    });
    setResult(await response.text());
  }

  return (
    <main>
      <h1>Create League</h1>
      <form onSubmit={handleSubmit}>
        <input name="name" placeholder="League name" />
        <input name="commissionerUserId" placeholder="Commissioner user ID" />
        <button type="submit">Create</button>
      </form>
      {result && <pre>{result}</pre>}
    </main>
  );
}
