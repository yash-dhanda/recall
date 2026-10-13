"""Yash Made Test routes. Thin over recall.mcq.service — logic lives there.

Three exception types, three statuses, and no fourth way of saying no:
`LookupError` -> 404 (including somebody else's attempt, which must be
indistinguishable from an id that never existed), `ValueError` -> 422,
`McqConflict` -> 409. Nothing here returns 200 with an error in the body.
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from recall.api.deps import get_conn, get_current_user
from recall.mcq import service
from recall.mcq.service import McqConflict

router = APIRouter(tags=["mcq"])


class AttemptIn(BaseModel):
    subject_code: str
    #: Unit numbers as printed on the deck, 1-based. Order is irrelevant —
    #: the service canonicalises them, so [2,1] and [1,2] are one selection
    #: and therefore one leaderboard.
    units: list[int]
    #: Any whole number 5-200, or "full". Validated in the service rather than
    #: by a constrained type so the 422 body names the range instead of
    #: printing a union, and so the range lives in one place — the registry.
    length: int | Literal["full"]
    #: "easy" | "medium" | "hard" | "max", or absent/null for Mixed. Not a
    #: Literal for the same reason as `length`, and optional because Mixed is
    #: the default sitting — the one a student who has not thought about tiers
    #: gets, and the one every attempt drawn before the ladder existed was.
    difficulty: str | None = None
    #: "practice" | "exam"; absent/null is practice. Validated in the service
    #: for the same reason as `difficulty`, so a bad value is a 422 that names
    #: the choices rather than a pydantic union dump.
    mode: str | None = None
    #: "bank" | "mistakes"; absent/null is the bank.
    source: str | None = None


class AnswerIn(BaseModel):
    #: 1-based, into the attempt's own question list.
    position: int = Field(ge=1)
    #: 0-3 in the SHOWN option order — the only order the client has seen.
    chosen: int = Field(ge=0)


def _units_param(units: str) -> list[int]:
    """`units=1,2` from the query string. 422 on anything else."""
    try:
        return [int(part) for part in units.split(",") if part.strip()]
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"units must be comma-separated numbers, got {units!r}",
        ) from exc


def _length_param(length: str):
    """`length=45` or `length=full` from the query string.

    Only the SHAPE is decided here — "is this a number at all". Whether the
    number is in range is the service's call, so the query string and the JSON
    body cannot drift into two different answers about what 4 means.
    """
    return length if length == "full" else _int_or_422(length)


def _int_or_422(length: str) -> int:
    try:
        return int(length)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"length must be a whole number or 'full', got {length!r}",
        ) from exc


def _mode_param(mode: str | None) -> str | None:
    """`mode=exam`, or absent/empty for the practice board — the same rule,
    for the same reason, as an empty `difficulty=` meaning Mixed."""
    return mode or None


def _difficulty_param(difficulty: str | None) -> str | None:
    """`difficulty=hard`, or absent/empty for the Mixed board.

    An EMPTY value is the same as an absent one. A query string is built by
    string concatenation on the way out — the client's own `qs()` drops `""`
    exactly as it drops `undefined`, and a hand-typed or bookmarked
    `...&length=30&difficulty=` is the ordinary shape of "no tier chosen". 422
    there would tell a student their Mixed board does not exist.
    """
    return difficulty or None


@router.get("/api/mcq/subjects")
def subjects(user_id: int = Depends(get_current_user), conn=Depends(get_conn)):
    """The picker: every subject and unit in the registry, with live counts."""
    return service.list_subjects(conn)


@router.post("/api/mcq/attempts")
def create_attempt(body: AttemptIn, user_id: int = Depends(get_current_user),
                   conn=Depends(get_conn)):
    try:
        return service.create_attempt(conn, user_id, body.subject_code,
                                      body.units, body.length,
                                      body.difficulty, mode=body.mode,
                                      source=body.source)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/api/mcq/mistakes")
def mistakes(user_id: int = Depends(get_current_user), conn=Depends(get_conn)):
    """This user's pending mistakes per subject, for "Practise my mistakes
    (N)". Yours only: the pool is built from your own answers."""
    return service.mistakes_summary(conn, user_id)


@router.get("/api/mcq/attempts")
def list_attempts(user_id: int = Depends(get_current_user),
                  conn=Depends(get_conn)):
    return service.list_attempts(conn, user_id)


@router.get("/api/mcq/leaderboard")
def leaderboard(subject_code: str,
                units: str = Query(..., description="comma-separated, e.g. 1,2"),
                length: str = Query(..., description="5-200 or full"),
                difficulty: str | None = Query(
                    None, description="easy|medium|hard|max; omit for Mixed"),
                mode: str | None = Query(
                    None, description="practice|exam; omit for practice"),
                user_id: int = Depends(get_current_user),
                conn=Depends(get_conn)):
    """One board per (subject, units, length, difficulty, mode). Omitting
    difficulty asks for the MIXED board, not for all of them at once — there is
    no board that merges the tiers, because nobody ever sat it. Omitting mode
    asks for the practice board; exam scores rank only against exam scores."""
    try:
        return service.leaderboard(conn, subject_code, _units_param(units),
                                   _length_param(length),
                                   _difficulty_param(difficulty),
                                   mode=_mode_param(mode))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/api/mcq/attempts/{attempt_id}")
def get_attempt(attempt_id: int, user_id: int = Depends(get_current_user),
                conn=Depends(get_conn)):
    try:
        return service.get_attempt(conn, user_id, attempt_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/api/mcq/attempts/{attempt_id}/answer")
def answer_attempt(attempt_id: int, body: AnswerIn,
                   user_id: int = Depends(get_current_user),
                   conn=Depends(get_conn)):
    """Practice: record one answer and reveal it. A second answer to the same
    position is 409, never an overwrite — the first click is the answer.

    Exam: record or change the choice and reveal nothing — `{position, chosen,
    answered}` only. 409 once time is up (limit + grace) or once submitted."""
    try:
        return service.answer_attempt(conn, user_id, attempt_id, body.position,
                                      body.chosen)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except McqConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/api/mcq/attempts/{attempt_id}/submit")
def submit_attempt(attempt_id: int, user_id: int = Depends(get_current_user),
                   conn=Depends(get_conn)):
    """Close and score. Submitting twice returns the stored result unchanged.
    Never refused on time: an expired exam can always be closed and read."""
    try:
        return service.submit_attempt(conn, user_id, attempt_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/api/mcq/attempts/{attempt_id}")
def abandon_attempt(attempt_id: int, user_id: int = Depends(get_current_user),
                    conn=Depends(get_conn)):
    """Throw away an unfinished sitting. A submitted one is refused with 409 —
    that is a graded result, not clutter."""
    try:
        service.abandon_attempt(conn, user_id, attempt_id)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except McqConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}
