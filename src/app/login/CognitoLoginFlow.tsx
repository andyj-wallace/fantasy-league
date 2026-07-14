"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  confirmCognitoPasswordReset,
  confirmCognitoSignUp,
  loginWithCognito,
  requestCognitoPasswordReset,
  resendCognitoConfirmationCode,
  signUpWithCognito,
  validateHandleFormat,
} from "@/app/lib/cognitoAuth";
import { getValidatedLoginRedirectTarget } from "@/app/lib/loginRedirect";

type CognitoLoginStep = "signIn" | "signUp" | "confirmSignUp" | "resetPassword";

/** Turns Cognito's error objects into the message a manager should see — Cognito's own messages
 * are mostly fine ("Incorrect username or password."), so pass them through with a fallback. */
function describeCognitoError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong — try again.";
}

/**
 * The handle + email + password flow against the Cognito user pool (active only in Cognito-mode
 * builds — see cognitoAuth.ts). Users pick a unique handle at sign-up (the Cognito username) and
 * can log in with either the handle or their verified email; the display name is collected as
 * Cognito's standard `name` attribute, which the API's CognitoAuthProvider reads when it creates
 * the internal User on first login. Pre-verification steps (confirmation code, resend) address
 * the account by handle, since Cognito only activates the email alias after verification.
 *
 * Each step's <form> carries a distinct `key` so React remounts a fresh, empty form when the
 * step changes instead of reconciling the uncontrolled inputs by position — without it, the
 * masked sign-in password node gets reused as the sign-up Display-name text field and reveals
 * the typed password in plain text.
 */
export function CognitoLoginFlow() {
  const [step, setStep] = useState<CognitoLoginStep>("signIn");
  /** The handle (always valid) or email (valid once verified) the current flow is acting on. */
  const [accountIdentifier, setAccountIdentifier] = useState("");
  /** Known only after this session's sign-up — lets the confirmation step say where the code went. */
  const [signUpEmail, setSignUpEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  function switchStep(nextStep: CognitoLoginStep) {
    setStep(nextStep);
    setError(null);
    setNotice(null);
  }

  async function runSubmit(action: () => Promise<void>) {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      await action();
    } catch (submitError) {
      setError(describeCognitoError(submitError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSignInSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedIdentifier = (formData.get("identifier") as string).trim();
    setAccountIdentifier(submittedIdentifier);
    await runSubmit(async () => {
      try {
        await loginWithCognito(submittedIdentifier, formData.get("password") as string);
      } catch (loginError) {
        // An account that never finished email verification can't log in — route it to the
        // confirmation-code step instead of dead-ending on the error. (Reachable when they
        // logged in by handle; an unverified email isn't an active alias yet.)
        if ((loginError as { code?: string }).code === "UserNotConfirmedException") {
          await resendCognitoConfirmationCode(submittedIdentifier);
          switchStep("confirmSignUp");
          setNotice("We sent a new confirmation code to your email address.");
          return;
        }
        throw loginError;
      }
      router.push(getValidatedLoginRedirectTarget() ?? "/");
    });
  }

  async function handleSignUpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const handle = (formData.get("handle") as string).trim();
    const email = (formData.get("email") as string).trim();
    const handleFormatError = validateHandleFormat(handle);
    if (handleFormatError) {
      setError(handleFormatError);
      return;
    }
    setAccountIdentifier(handle);
    setSignUpEmail(email);
    await runSubmit(async () => {
      await signUpWithCognito(handle, email, (formData.get("displayName") as string).trim(), formData.get("password") as string);
      switchStep("confirmSignUp");
      setNotice(`We sent a confirmation code to ${email}.`);
    });
  }

  async function handleConfirmSignUpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await runSubmit(async () => {
      await confirmCognitoSignUp(accountIdentifier, (formData.get("confirmationCode") as string).trim());
      switchStep("signIn");
      setNotice("Email confirmed — log in with your username or email, and your password.");
    });
  }

  async function handleResendCode() {
    await runSubmit(async () => {
      await resendCognitoConfirmationCode(accountIdentifier);
      setNotice("We sent a new confirmation code to your email address.");
    });
  }

  async function handleResetPasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedIdentifier = (formData.get("identifier") as string).trim();
    const confirmationCode = (formData.get("confirmationCode") as string).trim();
    setAccountIdentifier(submittedIdentifier);
    await runSubmit(async () => {
      if (!confirmationCode) {
        await requestCognitoPasswordReset(submittedIdentifier);
        setNotice("We sent a reset code to your email address — enter it below with your new password.");
        return;
      }
      await confirmCognitoPasswordReset(submittedIdentifier, confirmationCode, formData.get("newPassword") as string);
      switchStep("signIn");
      setNotice("Password reset — log in with your new password.");
    });
  }

  const messages = (
    <>
      {notice && <p className="msg msg-success" style={{ marginTop: "0.75rem" }}>{notice}</p>}
      {error && <p className="msg msg-error" style={{ marginTop: "0.75rem" }}>{error}</p>}
    </>
  );

  if (step === "signUp") {
    return (
      <>
        <h1>Create account</h1>
        <div className="card">
          <form key="signUp" className="form-stack" onSubmit={handleSignUpSubmit}>
            <input name="handle" placeholder="Username" required autoFocus />
            <input name="displayName" placeholder="Display name" required />
            <input name="email" type="email" placeholder="Email" required />
            <input name="password" type="password" placeholder="Password" required autoComplete="new-password" />
            <button className="btn-primary" type="submit" disabled={isSubmitting}>Sign up</button>
          </form>
          {messages}
          <p style={{ marginBottom: 0 }}>
            <button className="btn-link" onClick={() => switchStep("signIn")}>Already have an account? Log in</button>
          </p>
        </div>
      </>
    );
  }

  if (step === "confirmSignUp") {
    return (
      <>
        <h1>Confirm your email</h1>
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Enter the confirmation code we emailed to {signUpEmail ?? "your email address"}.
          </p>
          <form key="confirmSignUp" className="form-stack" onSubmit={handleConfirmSignUpSubmit}>
            <input name="confirmationCode" inputMode="numeric" placeholder="Confirmation code" required autoFocus />
            <button className="btn-primary" type="submit" disabled={isSubmitting}>Confirm</button>
          </form>
          {messages}
          <p style={{ marginBottom: 0 }}>
            <button className="btn-link" onClick={handleResendCode} disabled={isSubmitting}>Resend code</button>
          </p>
        </div>
      </>
    );
  }

  if (step === "resetPassword") {
    return (
      <>
        <h1>Reset password</h1>
        <div className="card">
          <p style={{ marginTop: 0 }}>Request a reset code, then enter it with your new password.</p>
          <form key="resetPassword" className="form-stack" onSubmit={handleResetPasswordSubmit}>
            <input name="identifier" placeholder="Email or username" defaultValue={accountIdentifier} required />
            <input name="confirmationCode" inputMode="numeric" placeholder="Reset code (leave empty to request one)" />
            <input name="newPassword" type="password" placeholder="New password" autoComplete="new-password" />
            <button className="btn-primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Working…" : "Continue"}
            </button>
          </form>
          {messages}
          <p style={{ marginBottom: 0 }}>
            <button className="btn-link" onClick={() => switchStep("signIn")}>Back to login</button>
          </p>
        </div>
      </>
    );
  }

  return (
    <main>
      <h1>Login</h1>
      <div className="card" style={{ maxWidth: 400 }}>
        <form key="signIn" className="form-stack" onSubmit={handleSignInSubmit}>
          <input name="identifier" placeholder="Email or username" required autoFocus />
          <input name="password" type="password" placeholder="Password" required autoComplete="current-password" />
          <button className="btn-primary" type="submit" disabled={isSubmitting}>Log in</button>
        </form>
        {messages}
        <p>
          <button className="btn-link" onClick={() => switchStep("signUp")}>New here? Create an account</button>
        </p>
        <p style={{ marginBottom: 0 }}>
          <button className="btn-link" onClick={() => switchStep("resetPassword")}>Forgot password?</button>
        </p>
      </div>
    </main>
  );
}
