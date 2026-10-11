"""Open registration: sign up, log in, log out, and who-am-I.

No email verification, no forgot-password flow, no CAPTCHA, and deliberately
no per-IP rate limiting either — open signup with no invite code is a
deliberate choice (mirrors the owner's other project), none of the above
would protect the one resource that's actually scarce here (DeepSeek spend,
guarded by a per-user daily cost cap at generation time instead), and the
audience this actually ships to is LPU students, who are disproportionately
likely to share one outbound IP on hostel/campus WiFi — a per-IP limiter
would lock out an entire building over a handful of students signing up at
once, not just an attacker. Argon2's own cost is what actually blunts
scripted credential stuffing.
"""

import os

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field

from recall.api.deps import (
    SESSION_COOKIE,
    SESSION_TTL_DAYS,
    create_session,
    get_conn,
    get_current_user,
    hash_token,
)
from recall.auth import DuplicateAccount, create_user, normalize_email, verify_password
from recall import github_auth
from recall.google_auth import (
    GoogleAuthError, client_id, user_for_google, user_for_identity, verify_id_token,
)

router = APIRouter(tags=["auth"])


def _cookie_secure() -> bool:
    return os.environ.get("RECALL_COOKIE_SECURE", "1") != "0"


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        max_age=60 * 60 * 24 * SESSION_TTL_DAYS,
        path="/",
        # No `domain=` — leaving it unset scopes the cookie to the exact
        # host. The same edge also serves other, unrelated apps on sibling
        # subdomains; an explicit parent-domain cookie would leak into them.
    )


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


def _public_user(conn, user_id: int) -> dict:
    row = conn.execute(
        "SELECT id, name, email FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    return {"id": row["id"], "name": row["name"], "email": row["email"]}


@router.post("/api/auth/register")
def register(body: RegisterIn, response: Response, conn=Depends(get_conn)):
    try:
        user_id = create_user(conn, name=body.name, email=body.email,
                              password=body.password)
    except DuplicateAccount as exc:
        raise HTTPException(status_code=422,
                            detail="that name or email is already taken") from exc
    token = create_session(conn, user_id)
    _set_session_cookie(response, token)
    return _public_user(conn, user_id)


@router.post("/api/auth/login")
def login(body: LoginIn, response: Response, conn=Depends(get_conn)):
    email = normalize_email(body.email)
    row = conn.execute(
        "SELECT id, password_hash FROM users WHERE email = ?", (email,)
    ).fetchone()
    # Never distinguish "no such account" from "wrong password" — that split
    # is a free user-enumeration oracle.
    if row is None or row["password_hash"] is None or not verify_password(
        body.password, row["password_hash"]
    ):
        raise HTTPException(status_code=401, detail="invalid email or password")
    token = create_session(conn, row["id"])
    _set_session_cookie(response, token)
    return _public_user(conn, row["id"])


class GoogleIn(BaseModel):
    credential: str = Field(min_length=10, max_length=4096)


@router.get("/api/auth/providers")
def providers():
    """Which social sign-ins this deployment has switched on. Served at runtime
    so the web image needs no build-time key. The Google client id is public."""
    return {"google_client_id": client_id(), "github": github_auth.configured()}


@router.post("/api/auth/google")
def google_login(body: GoogleIn, response: Response, conn=Depends(get_conn)):
    try:
        info = verify_id_token(body.credential)
    except GoogleAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    user_id = user_for_google(conn, info)
    token = create_session(conn, user_id)
    _set_session_cookie(response, token)
    return _public_user(conn, user_id)


_STATE_COOKIE = "recall_gh_state"


def _callback_url(request: Request) -> str:
    base = os.environ.get("RECALL_PUBLIC_URL", "").rstrip("/") or str(request.base_url).rstrip("/")
    return f"{base}/api/auth/github/callback"


@router.get("/api/auth/github/start")
def github_start(request: Request):
    if not github_auth.configured():
        raise HTTPException(status_code=404, detail="GitHub sign-in is not configured")
    state = github_auth.new_state()
    resp = RedirectResponse(github_auth.authorize_url(state, _callback_url(request)))
    resp.set_cookie(_STATE_COOKIE, state, httponly=True, secure=_cookie_secure(),
                    samesite="lax", max_age=600, path="/api/auth/github")
    return resp


@router.get("/api/auth/github/callback")
def github_callback(request: Request, code: str = "", state: str = "",
                    conn=Depends(get_conn)):
    saved = request.cookies.get(_STATE_COOKIE, "")
    if not github_auth.configured() or not code or not saved or saved != state:
        return RedirectResponse("/login?error=github", status_code=303)
    try:
        email, name = github_auth.fetch_identity(code, _callback_url(request))
    except github_auth.GithubAuthError:
        return RedirectResponse("/login?error=github", status_code=303)
    user_id = user_for_identity(conn, email, name)
    resp = RedirectResponse("/", status_code=303)
    _set_session_cookie(resp, create_session(conn, user_id))
    resp.delete_cookie(_STATE_COOKIE, path="/api/auth/github")
    return resp


@router.post("/api/auth/logout")
def logout(response: Response, conn=Depends(get_conn),
          recall_session: str | None = Cookie(default=None)):
    if recall_session:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?",
                     (hash_token(recall_session),))
        conn.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
def me(user_id: int = Depends(get_current_user), conn=Depends(get_conn)):
    return _public_user(conn, user_id)
