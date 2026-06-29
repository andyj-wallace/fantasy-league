"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { setStoredSession } from "@/app/lib/auth";

type LoginStep = "email" | "displayName";

export default function LoginPage() {
  const [step, setStep] = useState<LoginStep>("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  async function completeLogin(emailToLogin: string, displayName?: string) {
    const response = await fetch(`${getApiBaseUrl()}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: emailToLogin, displayName }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.message ?? "Login failed — try again.");
      return;
    }
    setStoredSession({ userId: body.userId, token: body.token });
    router.push("/");
  }

  async function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);
    const submittedEmail = (formData.get("email") as string).trim();
    setEmail(submittedEmail);
    setIsSubmitting(true);

    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/check-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: submittedEmail }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "Could not check that email — try again.");
        return;
      }
      if (body.exists) {
        await completeLogin(submittedEmail);
      } else {
        setStep("displayName");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDisplayNameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);
    setIsSubmitting(true);
    try {
      await completeLogin(email, (formData.get("displayName") as string).trim());
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step === "displayName") {
    return (
      <main>
        <h1>Welcome!</h1>
        <p>We haven't seen {email} before — what should we call you?</p>
        <form onSubmit={handleDisplayNameSubmit}>
          <input name="displayName" placeholder="Display name" required autoFocus />
          <button type="submit" disabled={isSubmitting}>
            Create account
          </button>
        </form>
        {error && <p>{error}</p>}
      </main>
    );
  }

  return (
    <main>
      <h1>Login</h1>
      <form onSubmit={handleEmailSubmit}>
        <input name="email" type="email" placeholder="Email" required autoFocus />
        <button type="submit" disabled={isSubmitting}>
          Continue
        </button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
