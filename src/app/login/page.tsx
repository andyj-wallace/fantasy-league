"use client";

import { useState, type FormEvent } from "react";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { setStoredSession } from "@/app/lib/auth";

export default function LoginPage() {
  const [result, setResult] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const response = await fetch(`${getApiBaseUrl()}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email"),
        displayName: formData.get("displayName"),
      }),
    });
    const body = await response.json();
    if (response.ok) setStoredSession({ userId: body.userId, token: body.token });
    setResult(JSON.stringify(body));
  }

  return (
    <main>
      <h1>Login</h1>
      <p>Stub screen — no real credential check yet; an unknown email creates a new account.</p>
      <form onSubmit={handleSubmit}>
        <input name="email" type="email" placeholder="Email" required />
        <input name="displayName" placeholder="Display name (only used the first time)" />
        <button type="submit">Continue</button>
      </form>
      {result && <pre>{result}</pre>}
    </main>
  );
}
