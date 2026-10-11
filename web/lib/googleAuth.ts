import { API_BASE, ApiError } from "@/lib/http";
import type { AuthUser } from "@/lib/types";

export interface Providers {
  google_client_id: string | null;
  github: boolean;
}

/** Which social sign-ins the server has switched on. Off on any failure. */
export async function getProviders(): Promise<Providers> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/providers`, { credentials: "include" });
    if (res.ok) return (await res.json()) as Providers;
  } catch {}
  return { google_client_id: null, github: false };
}

/** Where the "Continue with GitHub" button sends the browser. */
export const GITHUB_START = `${API_BASE}/api/auth/github/start`;

/** POST /api/auth/google — exchanges a Google ID token for a session cookie. */
export async function postGoogleLogin(credential: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/api/auth/google`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!res.ok) {
    let detail = "Google sign-in failed.";
    try {
      detail = ((await res.json()) as { detail?: string }).detail ?? detail;
    } catch {}
    throw new ApiError(res.status, "/api/auth/google", detail);
  }
  return (await res.json()) as AuthUser;
}
