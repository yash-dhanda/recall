"""One small outbound-HTTP helper for the sign-in providers (stdlib only).

The LLM client is the repo's single place for the project's own HTTP client
library; sign-in needs three plain JSON calls, so it uses urllib and takes its
transport as an argument, which is also how the tests replace the network.
"""

import json
import urllib.error
import urllib.parse
import urllib.request


def request_json(url: str, *, params: dict | None = None, form: dict | None = None,
                 headers: dict | None = None, timeout: float = 8) -> tuple[int, object]:
    """GET (or POST when `form` is given). Returns (status, parsed JSON or None)."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    body = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(url, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None
