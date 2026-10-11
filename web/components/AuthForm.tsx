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
          theme: "filled_black",
          size: "large",
          width: 314,
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
      <div className="w-full max-w-[340px]">
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
          <div ref={googleBtn} className="flex justify-center" />
          {githubOn && (
            <a
              href={GITHUB_START}
              className="mt-2 w-full inline-flex items-center justify-center min-h-[40px]
                px-4 rounded-sm text-[13.5px] font-semibold border border-line
                hover:border-accent transition-colors duration-[90ms]"
            >
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
