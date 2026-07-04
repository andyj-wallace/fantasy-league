"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { setStoredSession } from "@/app/lib/auth";
import { isCognitoAuthEnabled } from "@/app/lib/cognitoAuth";
import { CognitoLoginFlow } from "./CognitoLoginFlow";

type LoginStep = "email" | "displayName";

/** Cognito-mode builds (NEXT_PUBLIC_COGNITO_* set — the standard setup, local dev included) get
 * the real handle+email+password flow; unsetting those vars falls back to the passwordless
 * email login against the signed-token provider, for offline work and scripts. */
export default function LoginPage() {
  return (
    <main className="login-screen">
      <div className="login-panel">
        <SessionExpiredNotice />
        {isCognitoAuthEnabled() ? <CognitoLoginFlow /> : <PasswordlessDevLoginFlow />}
      </div>
    </main>
  );
}

/** Shown when authedFetch got a 401 and redirected here with ?expired=1 — tells the user why
 * they're suddenly looking at the login screen. Read via window.location (not useSearchParams)
 * to avoid needing a Suspense boundary for this one flag under static prerendering. */
function SessionExpiredNotice() {
  const [wasRedirectedAfterExpiry, setWasRedirectedAfterExpiry] = useState(false);
  useEffect(() => {
    setWasRedirectedAfterExpiry(new URLSearchParams(window.location.search).get("expired") === "1");
  }, []);
  if (!wasRedirectedAfterExpiry) return null;
  return (
    <p className="msg msg-info" style={{ marginBottom: "1rem" }}>
      Your session expired — please log in again.
    </p>
  );
}

function PasswordlessDevLoginFlow() {
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
    } catch {
      setError("Could not reach the server — make sure the API is running and try again.");
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
    } catch {
      setError("Could not reach the server — make sure the API is running and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step === "displayName") {
    return (
      <>
        <h1>Welcome!</h1>
        <div className="card">
          <p style={{ marginTop: 0 }}>We haven't seen {email} before — what should we call you?</p>
          <form className="form-stack" onSubmit={handleDisplayNameSubmit}>
            <input name="displayName" placeholder="Display name" required autoFocus />
            <button className="btn-primary" type="submit" disabled={isSubmitting}>
              Create account
            </button>
          </form>
          {error && <p className="msg msg-error" style={{ marginTop: "0.75rem" }}>{error}</p>}
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Login</h1>
      <div className="card">
        <form className="form-stack" onSubmit={handleEmailSubmit}>
          <input name="email" type="email" placeholder="Email" required autoFocus />
          <button className="btn-primary" type="submit" disabled={isSubmitting}>
            Continue
          </button>
        </form>
        {error && <p className="msg msg-error" style={{ marginTop: "0.75rem" }}>{error}</p>}
      </div>
    </>
  );
}
