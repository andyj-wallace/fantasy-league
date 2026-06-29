"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { setStoredSession } from "@/app/lib/auth";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
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
    if (!response.ok) {
      setError(body.message ?? "Login failed — try again.");
      return;
    }
    setStoredSession({ userId: body.userId, token: body.token });
    router.push("/");
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
      {error && <p>{error}</p>}
    </main>
  );
}
