"""Google sign-in: verify a Google ID token and turn it into a local account.

The browser gets an ID token from Google Identity Services and posts it here.
Google's own `tokeninfo` endpoint checks the signature and expiry, so no
crypto or extra dependency lives in this repo; what this module adds is the
checks Google leaves to the relying party — audience, issuer, verified email.

Accounts link by verified email. Google has proven the address, so a person
who signed up with a password and later uses Google lands in the same account.
No schema change: a Google-only account is a user with a NULL password_hash,
which password login already refuses.
"""

import os
import re
import sqlite3
from datetime import datetime, timezone

import httpx

from recall.auth import normalize_email
from recall.seed import seed_topics

TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
_ISSUERS = ("accounts.google.com", "https://accounts.google.com")


class GoogleAuthError(Exception):
    """The token is invalid, for someone else, or has an unverified email."""


def client_id() -> str | None:
    return os.environ.get("GOOGLE_CLIENT_ID", "").strip() or None


def verify_id_token(credential: str, *, http: httpx.Client | None = None) -> dict:
    cid = client_id()
    if cid is None:
        raise GoogleAuthError("Google sign-in is not configured")
    owns = http is None
    http = http or httpx.Client(timeout=8)
    try:
        resp = http.get(TOKENINFO_URL, params={"id_token": credential})
    except httpx.HTTPError as exc:
        raise GoogleAuthError("could not reach Google") from exc
    finally:
        if owns:
            http.close()
    if resp.status_code != 200:
        raise GoogleAuthError("Google rejected the sign-in")
    info = resp.json()
    if info.get("aud") != cid:
        raise GoogleAuthError("token was issued for a different app")
    if info.get("iss") not in _ISSUERS:
        raise GoogleAuthError("unexpected token issuer")
    if str(info.get("email_verified")).lower() != "true" or not info.get("email"):
        raise GoogleAuthError("Google account has no verified email")
    return info


def _unique_name(conn: sqlite3.Connection, wanted: str, email: str) -> str:
    base = re.sub(r"\s+", " ", wanted).strip()[:90] or email.split("@")[0]
    name, n = base, 1
    while conn.execute("SELECT 1 FROM users WHERE name = ?", (name,)).fetchone():
        n += 1
        name = f"{base} {n}"
    return name


def user_for_google(conn: sqlite3.Connection, info: dict) -> int:
    """The local user id for a verified Google identity, creating it if new."""
    return user_for_identity(conn, info["email"], info.get("name", ""))


def user_for_identity(conn: sqlite3.Connection, raw_email: str, name: str) -> int:
    """Same for any provider that has verified the email (Google, GitHub)."""
    email = normalize_email(raw_email)
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row is not None:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO users (name, email, password_hash, created_at)"
        " VALUES (?,?,?,?)",
        (_unique_name(conn, name, email), email, None,
         datetime.now(timezone.utc).isoformat()),
    )
    user_id = cur.lastrowid
    conn.execute("INSERT OR IGNORE INTO settings (user_id) VALUES (?)", (user_id,))
    seed_topics(conn, user_id=user_id)
    conn.commit()
    return user_id
