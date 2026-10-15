"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { errorMessage, postLogin, postRegister } from "@/lib/api";
import { GITHUB_START, getProviders, postGoogleLogin } from "@/lib/googleAuth";

/**
 * Sign in and sign up are the same screen with one extra field, so they are
 * one component: the two routes differ only in `mode`. Deliberately plain —
 * this is the one screen a new student sees before any of the product, and
 * it should read as an entrance, not a wall.
 */

const MIN_PASSWORD = 8;

type GoogleIdentity = {
  accounts: {
    id: {
      initialize: (o: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
    };
  };
};

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const reduced = useReducedMotion();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const googleBtn = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [googleOn, setGoogleOn] = useState(false);
  const [githubOn, setGithubOn] = useState(false);

  // Google Identity Services draws its own button into the div. It appears only
  // when the server reports a client id, so a deployment without one is unchanged.
  useEffect(() => {
    let cancelled = false;
    getProviders().then((p) => {
      if (cancelled) return;
      setGithubOn(p.github);
      if (new URLSearchParams(window.location.search).get("error") === "github")
        setError("GitHub sign-in failed. Try again.");
      const clientId = p.google_client_id;
      if (!clientId) return;
      const init = () => {
        const g = (window as unknown as { google?: GoogleIdentity }).google;
        if (!g || !googleBtn.current) return;
        g.accounts.id.initialize({
          client_id: clientId,
          callback: async (r: { credential: string }) => {
            setBusy(true);
            setError(null);
            try {
              await postGoogleLogin(r.credential);
              window.location.replace("/");
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          },
        });
        g.accounts.id.renderButton(googleBtn.current, {
          theme: "outline",
          size: "large",
          width: Math.min(400, card.current?.clientWidth || 340),
          text: "continue_with",
        });
        setGoogleOn(true);
      };
      if ((window as unknown as { google?: GoogleIdentity }).google) return init();
      const tag = document.createElement("script");
      tag.src = "https://accounts.google.com/gsi/client";
      tag.async = true;
      tag.onload = init;
      document.head.appendChild(tag);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signup = mode === "signup";
  const tooShort = signup && password.length > 0 && password.length < MIN_PASSWORD;
  const canSubmit =
    !busy &&
    email.trim().length > 0 &&
    password.length >= (signup ? MIN_PASSWORD : 1) &&
    (!signup || name.trim().length > 0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (signup) await postRegister(name.trim(), email.trim(), password);
      else await postLogin(email.trim(), password);
      // A hard replace, not router.replace: it guarantees the shell remounts
      // and re-reads the session, and leaves no client cache from whoever was
      // signed in before. `replace` so the back button never lands on a dead
      // form.
      window.location.replace("/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="min-h-[100dvh] flex items-center justify-center px-4 py-10">
      <div ref={card} className="w-full max-w-[340px]">
        <div className="text-center">
          <p className="text-[11px] font-bold tracking-[0.16em] text-fg">RECALL</p>
          <h1 className="k-text text-[22px] font-medium mt-3 leading-snug">
            {signup ? "Make an account" : "Welcome back"}
          </h1>
          <p className="text-[12.5px] text-fg-3 mt-1.5 leading-relaxed">
            {signup
              ? "Your deck, your schedule, your papers — kept to your account."
              : "Pick up where your scheduler left off."}
          </p>
        </div>

        <form onSubmit={onSubmit} className="panel mt-5 px-3.5 py-3.5">
          {signup && (
            <Field
              id="name"
              label="Name"
              value={name}
              onChange={setName}
              autoComplete="username"
              autoFocus
            />
          )}
          <Field
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            autoFocus={!signup}
          />
          <Field
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={signup ? "new-password" : "current-password"}
            hint={signup ? `At least ${MIN_PASSWORD} characters.` : undefined}
            hintTone={tooShort ? "warn" : "quiet"}
          />

          {error && (
            <p
              role="alert"
              className="mt-3 px-2.5 py-2 border-l-2 bg-surface text-[12.5px] text-fg"
              style={{ borderLeftColor: "var(--g-again)" }}
            >
              {error}
            </p>
          )}

          <motion.button
            type="submit"
            disabled={!canSubmit}
            whileTap={reduced || !canSubmit ? undefined : { scale: 0.98 }}
            className="accent-grad glow-accent-hover mt-4 w-full inline-flex items-center
              justify-center min-h-[44px] px-4 rounded-sm text-[13.5px] font-semibold
              border border-accent hover:border-accent-hover
              transition-colors duration-[90ms]
              disabled:opacity-40 disabled:pointer-events-none"
          >
            {busy
              ? signup
                ? "Creating…"
                : "Signing in…"
              : signup
                ? "Create account"
                : "Sign in"}
          </motion.button>
        </form>

        <div className={googleOn || githubOn ? "mt-4" : "hidden"}>
          <p className="text-center text-[11px] text-fg-3 mb-2">or</p>
          {/* Google's own button stays on top, invisible, so its click flow is
              untouched; the visible one underneath matches the GitHub button. */}
          <div className={`group relative ${googleOn ? "" : "hidden"}`}>
            <div className={`${SOCIAL_BTN} pointer-events-none group-hover:border-accent`}>
              <GoogleMark />
              Continue with Google
            </div>
            <div
              ref={googleBtn}
              className="absolute inset-0 overflow-hidden opacity-0 [&_iframe]:!w-full"
            />
          </div>
          {githubOn && (
            <a href={GITHUB_START} className={`${SOCIAL_BTN} mt-2 hover:border-accent`}>
              <GitHubMark />
              Continue with GitHub
            </a>
          )}
        </div>

        <p className="text-center text-[12.5px] text-fg-3 mt-4">
          {signup ? "Already have an account? " : "New here? "}
          <Link
            href={signup ? "/login" : "/signup"}
            className="text-fg-2 underline underline-offset-2 hover:text-fg"
          >
            {signup ? "Sign in" : "Create one"}
          </Link>
        </p>
      </div>
    </main>
  );
}

const SOCIAL_BTN =
  "w-full inline-flex items-center justify-center gap-2.5 h-[40px] px-4 rounded-sm " +
  "text-[13.5px] font-semibold bg-surface border border-line text-fg " +
  "transition-colors duration-[90ms]";

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/>
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.8l7.9-6.1z"/>
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.900-5.8l-7.5-5.800c-2.100 1.400-4.8 2.300-8.400 2.300-6.300 0-11.600-4.100-13.500-9.800l-7.900 6.100C6.500 42.6 14.600 48 24 48z"/>
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  autoFocus,
  hint,
  hintTone = "quiet",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  hint?: string;
  hintTone?: "quiet" | "warn";
}) {
  return (
    <div className="mt-2.5 first:mt-0">
      <label htmlFor={id} className="label block">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-2.5 rounded-sm bg-sunken border border-line
          text-[14px] text-fg outline-none
          focus:border-line-strong transition-colors duration-[90ms]"
      />
      {hint && (
        <p
          className="telemetry text-[10.5px] mt-1"
          style={{ color: hintTone === "warn" ? "var(--g-again)" : "var(--fg-3)" }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}
