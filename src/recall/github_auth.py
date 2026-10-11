"""GitHub sign-in: the OAuth authorization-code flow, server side.

GitHub has no ID token, so the server does the exchange: send the browser to
GitHub with a random `state`, get a `code` back, swap it for an access token,
then read the account's emails. Only a primary, VERIFIED email is accepted, and
accounts link by that email exactly as Google's do. The client secret never
reaches the browser.
"""

import os
import secrets
import urllib.parse

from recall.netio import request_json

AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
TOKEN_URL = "https://github.com/login/oauth/access_token"
API = "https://api.github.com"


class GithubAuthError(Exception):
    """The code is invalid, or the account has no verified email."""


def configured() -> bool:
    return bool(os.environ.get("GITHUB_CLIENT_ID") and os.environ.get("GITHUB_CLIENT_SECRET"))


def new_state() -> str:
    return secrets.token_urlsafe(24)


def authorize_url(state: str, redirect_uri: str) -> str:
    q = urllib.parse.urlencode({"client_id": os.environ["GITHUB_CLIENT_ID"],
                           "redirect_uri": redirect_uri, "scope": "read:user user:email",
                           "state": state})
    return f"{AUTHORIZE_URL}?{q}"


def fetch_identity(code: str, redirect_uri: str, *, fetch=request_json) -> tuple[str, str]:
    """(verified primary email, display name) for the account that authorised."""
    try:
        status, tok = fetch(TOKEN_URL, headers={"Accept": "application/json"}, form={
            "client_id": os.environ["GITHUB_CLIENT_ID"],
            "client_secret": os.environ["GITHUB_CLIENT_SECRET"],
            "code": code, "redirect_uri": redirect_uri})
        access = tok.get("access_token") if status == 200 and isinstance(tok, dict) else None
        if not access:
            raise GithubAuthError("GitHub rejected the sign-in")
        auth = {"Authorization": f"Bearer {access}", "Accept": "application/vnd.github+json",
                "User-Agent": "recall"}
        e_status, emails = fetch(f"{API}/user/emails", headers=auth)
        u_status, info = fetch(f"{API}/user", headers=auth)
    except OSError as exc:
        raise GithubAuthError("could not reach GitHub") from exc
    if e_status != 200 or u_status != 200 or not isinstance(emails, list) or not isinstance(info, dict):
        raise GithubAuthError("could not read the GitHub account")
    primary = next((e["email"] for e in emails if e.get("primary") and e.get("verified")), None)
    if not primary:
        raise GithubAuthError("GitHub account has no verified primary email")
    return primary, info.get("name") or info.get("login") or ""
