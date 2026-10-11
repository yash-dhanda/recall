import httpx
import pytest

from recall import google_auth as g
from recall.db import connect, init_db


def _client(info, status=200):
    return httpx.Client(transport=httpx.MockTransport(
        lambda req: httpx.Response(status, json=info)))


GOOD = {"aud": "cid", "iss": "https://accounts.google.com",
        "email_verified": "true", "email": "Yash@Gmail.com", "name": "Yash"}


def test_verify_checks_audience_issuer_and_verified_email(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid")
    assert g.verify_id_token("x" * 20, http=_client(GOOD))["email"] == "Yash@Gmail.com"
    for bad in ({**GOOD, "aud": "other"}, {**GOOD, "iss": "evil.com"},
                {**GOOD, "email_verified": "false"}):
        with pytest.raises(g.GoogleAuthError):
            g.verify_id_token("x" * 20, http=_client(bad))
    with pytest.raises(g.GoogleAuthError):
        g.verify_id_token("x" * 20, http=_client({}, status=400))


def test_not_configured_refuses(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    with pytest.raises(g.GoogleAuthError):
        g.verify_id_token("x" * 20)


def test_links_by_email_and_creates_once(tmp_path):
    conn = connect(str(tmp_path / "t.db"))
    init_db(conn)
    first = g.user_for_google(conn, GOOD)
    again = g.user_for_google(conn, {**GOOD, "email": "yash@gmail.com"})
    assert first == again
    other = g.user_for_google(conn, {**GOOD, "email": "b@x.com"})
    names = [r["name"] for r in conn.execute("SELECT name FROM users ORDER BY id")]
    assert other != first and names == ["Yash", "Yash 2"]
    assert conn.execute("SELECT password_hash FROM users WHERE id=?", (first,)).fetchone()[0] is None


def test_github_identity_needs_primary_verified_email(monkeypatch):
    from recall import github_auth as gh
    monkeypatch.setenv("GITHUB_CLIENT_ID", "i"); monkeypatch.setenv("GITHUB_CLIENT_SECRET", "s")

    def handler(req):
        u = str(req.url)
        if "access_token" in u:
            return httpx.Response(200, json={"access_token": "t"})
        if u.endswith("/user/emails"):
            return httpx.Response(200, json=EMAILS)
        return httpx.Response(200, json={"login": "yash-dhanda", "name": None})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    global EMAILS
    EMAILS = [{"email": "a@x.com", "primary": False, "verified": True},
              {"email": "me@x.com", "primary": True, "verified": True}]
    assert gh.fetch_identity("c", "r", http=http) == ("me@x.com", "yash-dhanda")
    EMAILS = [{"email": "me@x.com", "primary": True, "verified": False}]
    with pytest.raises(gh.GithubAuthError):
        gh.fetch_identity("c", "r", http=http)
