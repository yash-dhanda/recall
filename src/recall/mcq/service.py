"""Yash Made Test service: draw an attempt, reveal one answer, score it.

Every function takes the connection first and `user_id` second, like
`recall.testmode.service`, and raises `LookupError` for "no such thing" (404),
`ValueError` for "that is not a legal move" (422) and `McqConflict` for "legal,
but not now" (409). The routes translate; nothing here knows about HTTP.

**The shuffle is stored, never recomputed.** An attempt draws its questions
once and shuffles each question's four options once, and both results live on
the attempt row. `option_orders_json[i]` is a permutation of 0..3 where
`order[shown] = stored`, so:

    shown_options  = [stored_options[j] for j in order]
    stored_choice  = order[chosen]
    correct_index  = order.index(stored_correct)

Everything on the wire — `chosen`, `correct_index` — is a position in the
SHOWN order, which is the only order the client has ever seen. Recomputing a
shuffle would make an attempt ungradable the moment the seed changed.

**Unanswered scores zero and still counts.** "Finish & see score" halfway
through is allowed; `total` stays the number of questions drawn, so 12/30 after
twelve questions reads as 12/30 and not as 12/12. Nothing here touches the
scheduler: these are not cards.

**An exam is sealed until it is submitted.** Practice reveals each answer on
the click and the first click is final. An exam records the click, lets it be
changed, and says nothing about correctness — not in the answer response and
not in GET of the attempt — until submit, when the result reveals everything
at once. Every path that shapes an open exam goes through `_sealed`, so there
is one place that decides, and the clock that closes the paper is `clock()`.

**"Practise my mistakes" is a pool, not a list.** A question is in it when the
most recent answer this user was SHOWN the verdict for was wrong: practice
answers are shown on the click, exam answers at submit, and an open exam has
shown nothing. The pool is recomputed from the answers every time it is read,
so answering a question right takes it out, and nothing has to be kept in step.
"""

import json
import random
import sqlite3
from datetime import datetime, timedelta, timezone

from recall.api.scheduling import iso, utc_now
from recall.mcq.registry import (DIFFICULTIES, EXAM_GRACE_S,
                                 EXAM_SECONDS_PER_QUESTION, LENGTH_MAX,
                                 LENGTH_MIN, LENGTHS, MCQ_SUBJECTS, MCQ_UNITS,
                                 MODES, SOURCES)

N_OPTIONS = 4


def clock() -> datetime:
    """Now, as an aware UTC datetime. The ONLY source of "now" in this module.

    Exam mode made time load-bearing — an answer at 30:31 of a 30:00 paper is
    refused — so every stamp and every deadline check reads this one function,
    and a test freezes it with `monkeypatch.setattr(service, "clock", ...)`
    instead of sleeping.
    """
    return utc_now()


#: Columns of one bank question, in the order the shaping helpers expect.
_Q_COLUMNS = ("id, topic, kind, difficulty, question, code, options_mono,"
              " options_json, correct, explain, why_wrong_json")


class McqConflict(Exception):
    """A move that is legal in general but not now.

    Answering a position that already has an answer, or touching a submitted
    attempt. Separate from ValueError because the HTTP answer differs: 409
    ("you already did that") rather than 422 ("that was never valid"), and the
    client shows the recorded answer instead of an error.
    """


def canonical_units(units) -> list[int]:
    """The selection's identity: sorted, deduplicated integers.

    Units [2, 1] and [1, 2] are one selection, so they must produce one
    `units_json` — otherwise they would be two different leaderboards for the
    same sitting. Canonicalised here, once, and used for the stored column,
    the leaderboard lookup and the wire shape alike.
    """
    try:
        return sorted({int(u) for u in units})
    except (TypeError, ValueError) as exc:
        raise ValueError("units must be a list of unit numbers") from exc


def _length_key(length) -> str:
    """The `length` column: '5'..'200' or 'full'."""
    return "full" if length == "full" else str(int(length))


def _length_out(stored: str):
    """The stored length back on the wire as an int or "full"."""
    return stored if stored == "full" else int(stored)


def _validate_length(length):
    """"full", or a whole number in 5..200. Anything else is a ValueError.

    Free choice rather than three presets: a student revising one unit the
    night before wants twelve questions, and being told to sit thirty is how a
    revision tool stops being opened. The range is a range and not a list, so
    the message names the bounds — "length must be 5-200 or 'full'" tells you
    what to type; a rejected list of legal values does not.

    `bool` is refused explicitly because `True` is an `int` in Python and
    `min(True, available)` is a one-question attempt nobody asked for.
    """
    if length == "full":
        return "full"
    if isinstance(length, bool) or not isinstance(length, int):
        raise ValueError(f"length must be a whole number {LENGTH_MIN}-"
                         f"{LENGTH_MAX} or 'full', got {length!r}")
    if not LENGTH_MIN <= length <= LENGTH_MAX:
        raise ValueError(f"length must be {LENGTH_MIN}-{LENGTH_MAX} or 'full',"
                         f" got {length!r}")
    return length


def _validate_difficulty(difficulty):
    """One of the four tiers, or None for Mixed.

    None is not "unset": it is the Mixed selection, drawn across the whole
    ladder, and it is its own leaderboard rather than a merge of the four.
    """
    if difficulty is None or difficulty in DIFFICULTIES:
        return difficulty
    printable = ", ".join(DIFFICULTIES)
    raise ValueError(f"difficulty must be one of {printable}, or omitted for"
                     f" Mixed, got {difficulty!r}")


def _validate_mode(mode) -> str:
    """'practice' or 'exam'; None is practice, the sitting that existed first.

    An empty string is refused rather than read as the default, for the same
    reason an empty difficulty in a JSON body is: a body can say null, so ""
    is a client bug and stays loud.
    """
    if mode is None:
        return MODES[0]
    if mode in MODES:
        return mode
    raise ValueError(f"mode must be one of {', '.join(MODES)}, got {mode!r}")


def _validate_source(source) -> str:
    """'bank' or 'mistakes'; None is the bank."""
    if source is None:
        return SOURCES[0]
    if source in SOURCES:
        return source
    raise ValueError(
        f"source must be one of {', '.join(SOURCES)}, got {source!r}")


def _validate_selection(subject_code: str, units, length,
                        difficulty=None) -> tuple[list[int], str, str | None]:
    info = MCQ_UNITS.get(subject_code)
    if info is None:
        known = ", ".join(sorted(MCQ_UNITS)) or "none"
        raise ValueError(f"no subject {subject_code!r}; the bank covers {known}")
    length = _validate_length(length)
    difficulty = _validate_difficulty(difficulty)
    cleaned = canonical_units(units)
    if not cleaned:
        raise ValueError("choose at least one unit")
    bad = [u for u in cleaned if u not in info["units"]]
    if bad:
        have = ", ".join(str(u) for u in sorted(info["units"]))
        raise ValueError(
            f"{subject_code} has units {have}; got "
            f"{', '.join(str(u) for u in bad)}")
    return cleaned, _length_key(length), difficulty


def list_subjects(conn) -> list[dict]:
    """Every subject in the registry, each unit with its live question count.

    Driven by MCQ_UNITS rather than by what is in the table, so a unit nobody
    has written questions for yet appears with `count: 0` — "waiting for
    material" is information, and a unit that silently vanished from the picker
    would look like a unit that does not exist. A subject with no questions at
    all is listed the same way, every unit at 0.

    Ordered by what can be sat: subjects holding questions first, most
    questions first, then the ones still waiting. The picker opens on the
    first entry, and with six subjects of which one has a bank, registry order
    would open it on Mathematics — a subject it then refuses to start. Ties,
    and the waiting subjects among themselves, fall back to MCQ_SUBJECTS — the
    semester's order — so the list does not reshuffle every time one question
    lands. That tuple and not the dict's iteration order: a dict's order is
    only the order its keys happened to be inserted in, and a key removed and
    put back goes to the end.
    """
    out = []
    totals = []
    for code, info in MCQ_UNITS.items():
        counts: dict[int, int] = {}
        tiers: dict[int, dict[str, int]] = {}
        for row in conn.execute(
                "SELECT unit, difficulty, COUNT(*) AS n FROM mcq_questions"
                " WHERE subject_code = ? AND active = 1"
                " GROUP BY unit, difficulty", (code,)):
            unit = row["unit"]
            counts[unit] = counts.get(unit, 0) + row["n"]
            bucket = tiers.setdefault(unit, {d: 0 for d in DIFFICULTIES})
            # A row carrying a tier the registry no longer lists is counted in
            # the unit total and in no tier: the picker must not offer a button
            # for a tier that does not exist, and hiding the question from the
            # total would make the numbers on the screen disagree with the draw.
            if row["difficulty"] in bucket:
                bucket[row["difficulty"]] = row["n"]
        out.append({
            "subject_code": code,
            "label": info["label"],
            "units": [{"unit": unit, "label": label,
                       "count": counts.get(unit, 0),
                       # Per tier, so the picker can grey out "max" on a unit
                       # nobody has written one for and print real numbers next
                       # to the tiers it does offer. Always all four keys —
                       # a missing key and a zero would read the same to a
                       # client and only one of them is true.
                       "difficulties": tiers.get(
                           unit, {d: 0 for d in DIFFICULTIES})}
                      for unit, label in sorted(info["units"].items())],
            "lengths": list(LENGTHS),
            "difficulties": list(DIFFICULTIES),
            "length_min": LENGTH_MIN,
            "length_max": LENGTH_MAX,
        })
        # Counted over the registry's units only, the same units the picker
        # prints: a stray row under a unit the registry does not declare
        # cannot be sat, so it must not lift its subject up the list.
        totals.append(sum(counts.get(unit, 0) for unit in info["units"]))
    semester = {code: i for i, code in enumerate(MCQ_SUBJECTS)}
    order = sorted(range(len(out)), key=lambda i: (
        -totals[i], semester.get(out[i]["subject_code"], len(semester))))
    return [out[i] for i in order]


#: The ids of every question whose most recent REVEALED answer by one user was
#: wrong. One parameter: the user_id.
#:
#: "Revealed" is when the student was shown the verdict. A practice answer is
#: revealed on the click, so it is ordered by its own `answered_at`; an exam
#: answer is revealed when the paper is submitted, so it is ordered by the
#: attempt's `submitted_at`, and an exam that is still open has revealed
#: nothing and contributes nothing — its answers are not yet evidence of
#: anything the student was told. Ties on the stamp fall to the later row.
#:
#: Only answer rows are read, so a question the student never answered is
#: never in the pool: not attempting is not evidence of not knowing. And it is
#: computed from the answers on every read, never stored, so a later right
#: answer takes a question out with nothing to keep in step.
#:
#: Stamps compare as strings, which is sound because every writer stores the
#: same aware-UTC ISO form (see recall.api.scheduling).
_PENDING_MISTAKES = """
SELECT question_id FROM (
  SELECT ans.question_id, ans.is_correct,
         ROW_NUMBER() OVER (
           PARTITION BY ans.question_id
           ORDER BY CASE WHEN a.mode = 'exam' THEN a.submitted_at
                         ELSE ans.answered_at END DESC,
                    ans.id DESC) AS latest
    FROM mcq_answers ans JOIN mcq_attempts a ON a.id = ans.attempt_id
   WHERE a.user_id = ? AND (a.mode <> 'exam' OR a.submitted_at IS NOT NULL)
) WHERE latest = 1 AND is_correct = 0
"""


def mistakes_summary(conn, user_id: int) -> list[dict]:
    """This user's pending mistakes per subject: what "Practise my mistakes (N)"
    prints on the picker.

    Counted the way a draw would find them — active questions only, in a unit
    the registry declares, since those are the only ones `create_attempt` can
    reach — so the number on the button is never one the sitting then refuses.
    Subjects in semester order; a subject with nothing pending is omitted.
    `by_unit` lists every registry unit of the subject, 0 included, and
    `by_difficulty` all four tiers: a missing key and a zero would read the
    same, and only one of them is true.
    """
    counts: dict[tuple[str, int, str], int] = {}
    for row in conn.execute(
            "SELECT subject_code, unit, difficulty, COUNT(*) AS n"
            " FROM mcq_questions WHERE active = 1"
            f" AND id IN ({_PENDING_MISTAKES})"
            " GROUP BY subject_code, unit, difficulty", (user_id,)):
        key = (row["subject_code"], row["unit"], row["difficulty"])
        counts[key] = row["n"]

    out = []
    for code in MCQ_SUBJECTS:
        units = MCQ_UNITS.get(code, {}).get("units", {})
        by_unit = {unit: 0 for unit in sorted(units)}
        by_difficulty = {d: 0 for d in DIFFICULTIES}
        for (subject, unit, tier), n in counts.items():
            if subject != code or unit not in units:
                continue
            by_unit[unit] += n
            # A tier the registry no longer lists counts toward its unit and
            # the total, as it does on the subject picker, and toward no tier.
            if tier in by_difficulty:
                by_difficulty[tier] += n
        total = sum(by_unit.values())
        if total:
            out.append({"subject_code": code, "total": total,
                        "by_unit": by_unit, "by_difficulty": by_difficulty})
    return out


def _sealed(row) -> bool:
    """True while nothing about correctness may leave the server: an exam that
    has not been submitted. The one test every exam path asks."""
    return row["mode"] == "exam" and row["submitted_at"] is None


def _deadline(row) -> datetime | None:
    """When an exam's clock runs out, before the grace. None for practice."""
    if row["time_limit_s"] is None:
        return None
    return _parse(row["started_at"]) + timedelta(seconds=row["time_limit_s"])


def _attempt_row(conn, user_id: int, attempt_id: int):
    """The attempt, or LookupError.

    `user_id` in the WHERE clause is the whole isolation story for this
    feature: somebody else's attempt is missing, in exactly the same words as
    an id that never existed. Answering the two differently would turn this
    route into an oracle for how many attempts other accounts have sat.
    """
    row = conn.execute(
        "SELECT * FROM mcq_attempts WHERE id = ? AND user_id = ?",
        (attempt_id, user_id)).fetchone()
    if row is None:
        raise LookupError(f"no attempt {attempt_id}")
    return row


def _questions_by_id(conn, ids: list[int]) -> dict[int, dict]:
    """The drawn questions, retired ones included.

    `active` is deliberately not filtered here: an attempt that already drew a
    question must stay readable and gradable after that question is retired
    from the bank. `active` gates the DRAW, not the replay.
    """
    if not ids:
        return {}
    holes = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT {_Q_COLUMNS} FROM mcq_questions WHERE id IN ({holes})",
        tuple(ids)).fetchall()
    return {row["id"]: dict(row) for row in rows}


def _presentation(question: dict) -> dict:
    """How the question is SHOWN, beyond its words: the snippet and whether the
    options are code. Both go out before the question is answered — neither
    says which option is right — so this is shared by the attempt payload and
    the review sheet, and one of them can never quietly lose it.

    `code` is null rather than "" when there is none, so a client tests one
    thing; when there is one it is exactly the string in the JSON file, which
    is what keeps a Python snippet's indentation alive to the screen.
    """
    return {"code": question["code"] or None,
            "options_mono": bool(question["options_mono"])}


def _shown_options(question: dict, order: list[int]) -> list[str]:
    stored = json.loads(question["options_json"])
    return [stored[j] for j in order]


def _shown_correct(question: dict, order: list[int]) -> int:
    return order.index(int(question["correct"]))


def _why_wrong(question: dict, order: list[int], chosen: int) -> str:
    """The note for the option that was picked; "" when it was the right one.

    Indexed by the STORED position the shown choice maps to, which is why the
    permutation has to be stored rather than reapplied: the notes are written
    against the options as they sit in the JSON file.
    """
    notes = json.loads(question["why_wrong_json"])
    return notes[order[chosen]]


def _answer_rows(conn, attempt_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT position, chosen, is_correct FROM mcq_answers"
        " WHERE attempt_id = ? ORDER BY id", (attempt_id,)).fetchall()


def _feedback_by_position(conn, attempt_id: int, ids: list[int],
                          orders: list[list[int]],
                          questions: dict[int, dict]) -> dict[int, dict]:
    """Every recorded answer as an McqFeedback, keyed by position.

    `answered` and `correct_so_far` are the running totals AS OF that answer,
    rebuilt by walking the answers in the order they were recorded (id order).
    A resumed attempt therefore shows the same numbers the reveal showed at the
    time, rather than today's totals stamped onto yesterday's clicks.
    """
    out: dict[int, dict] = {}
    answered = correct_so_far = 0
    for row in _answer_rows(conn, attempt_id):
        position = row["position"]
        answered += 1
        correct_so_far += 1 if row["is_correct"] else 0
        question = questions.get(ids[position - 1])
        if question is None:          # a question row that vanished entirely
            continue
        order = orders[position - 1]
        chosen = row["chosen"]
        out[position] = {
            "position": position,
            "chosen": chosen,
            "correct_index": _shown_correct(question, order),
            "is_correct": bool(row["is_correct"]),
            "explain": question["explain"],
            "why_wrong": _why_wrong(question, order, chosen),
            "answered": answered,
            "correct_so_far": correct_so_far,
        }
    return out


def _sealed_by_position(conn, attempt_id: int) -> dict[int, dict]:
    """An open exam's recorded choices, keyed by position, with NOTHING else.

    `{position, chosen, answered}` — the same shape the exam answer endpoint
    returns, where `answered` is how many positions hold a choice now. No
    correctness, no correct index, no explanation, no note: a GET of the
    attempt is a second door onto the answers, and a student who could read
    `is_correct` here could probe all four options through it by changing the
    answer and re-reading. Built from its own query that never selects
    `is_correct`, so there is no field to forget to drop.
    """
    rows = conn.execute(
        "SELECT position, chosen FROM mcq_answers WHERE attempt_id = ?"
        " ORDER BY position", (attempt_id,)).fetchall()
    return {r["position"]: {"position": r["position"], "chosen": r["chosen"],
                            "answered": len(rows)} for r in rows}


def _seconds_left(row) -> int | None:
    """Whole seconds until an open exam's clock runs out (grace not included,
    and never below 0); None for practice and for a submitted paper. Sent so a
    client whose own clock is wrong still counts down the server's time."""
    deadline = _deadline(row)
    if deadline is None or row["submitted_at"] is not None:
        return None
    return max(0, int((deadline - clock()).total_seconds()))


def _attempt_shape(conn, row) -> dict:
    ids = json.loads(row["question_ids_json"])
    orders = json.loads(row["option_orders_json"])
    questions = _questions_by_id(conn, ids)
    if _sealed(row):
        feedback = _sealed_by_position(conn, row["id"])
    else:
        feedback = _feedback_by_position(conn, row["id"], ids, orders,
                                         questions)

    out_questions = []
    for position, (qid, order) in enumerate(zip(ids, orders), start=1):
        question = questions.get(qid)
        if question is None:
            continue
        out_questions.append({
            "position": position,
            "topic": question["topic"],
            "kind": question["kind"],
            "difficulty": question["difficulty"],
            "question": question["question"],
            **_presentation(question),
            "options": _shown_options(question, order),
            "answer": feedback.get(position),
        })
    return {
        "attempt_id": row["id"],
        "subject_code": row["subject_code"],
        "units": json.loads(row["units_json"]),
        "length": _length_out(row["length"]),
        "difficulty": row["difficulty"],
        "mode": row["mode"],
        "source": row["source"],
        "time_limit_s": row["time_limit_s"],
        "seconds_left": _seconds_left(row),
        "total": row["total"],
        "started_at": row["started_at"],
        "submitted_at": row["submitted_at"],
        "questions": out_questions,
    }


def create_attempt(conn, user_id: int, subject_code: str, units, length,
                   difficulty=None, rng: random.Random | None = None,
                   mode=None, source=None) -> dict:
    """Draw a fresh sitting: `min(length, available)` questions, all shuffled.

    `difficulty` filters the pool to one tier; None is Mixed and draws across
    all of them. Either way the draw is `min(count, available)` without
    replacement, so asking for 200 easy questions out of 40 is a 40-question
    sitting and not an error — the student asked for "as many as you have", and
    refusing that would be refusing to teach.

    `source` picks the pool: 'bank' (None) is every active question in the
    selection; 'mistakes' is only those this user's last revealed answer got
    wrong (`_PENDING_MISTAKES`), filtered by the same subject, units and tier.
    `mode` picks how it is run: 'practice' (None) or 'exam', which puts
    `EXAM_SECONDS_PER_QUESTION` on the clock per question DRAWN — the paper
    the student actually has, not the one they asked for.

    `rng` exists so a test can pass `random.Random(seed)` and get a draw it can
    reason about. Nothing else passes it: two sittings looking different is the
    point of the feature, and an attempt that could be predicted would make the
    leaderboard a lie.
    """
    rng = rng or random.Random()
    cleaned, length_key, difficulty = _validate_selection(
        subject_code, units, length, difficulty)
    mode = _validate_mode(mode)
    source = _validate_source(source)

    holes = ",".join("?" for _ in cleaned)
    tier_clause = " AND difficulty = ?" if difficulty is not None else ""
    tier_params = (difficulty,) if difficulty is not None else ()
    pool_clause = (f" AND id IN ({_PENDING_MISTAKES})"
                   if source == "mistakes" else "")
    pool_params = (user_id,) if source == "mistakes" else ()
    rows = conn.execute(
        f"SELECT id FROM mcq_questions WHERE subject_code = ? AND active = 1"
        f" AND unit IN ({holes}){tier_clause}{pool_clause} ORDER BY id",
        (subject_code, *cleaned, *tier_params, *pool_params)).fetchall()
    if not rows:
        units_text = ", ".join(str(u) for u in cleaned)
        # Names the tier as well as the units: "unit 2 has no questions yet" is
        # wrong and demoralising when unit 2 has forty of them and none is a max.
        tier_text = f" {difficulty}" if difficulty is not None else ""
        where = (f"{subject_code} unit{'s' if len(cleaned) > 1 else ''}"
                 f" {units_text}")
        if source == "mistakes":
            # Not "have no questions": the bank may hold forty of them. What
            # is empty is this student's pool, which is good news or not-yet.
            raise ValueError(
                f"no mistakes to practise in that selection yet ({where}"
                f"{', ' + difficulty if difficulty is not None else ''})")
        raise ValueError(f"{where} have no{tier_text} questions yet")

    available = [row["id"] for row in rows]
    want = len(available) if length == "full" else min(int(length), len(available))
    drawn = rng.sample(available, want)
    orders = []
    for _ in drawn:
        order = list(range(N_OPTIONS))
        rng.shuffle(order)
        orders.append(order)

    time_limit_s = (EXAM_SECONDS_PER_QUESTION * len(drawn)
                    if mode == "exam" else None)
    cur = conn.execute(
        "INSERT INTO mcq_attempts (user_id, subject_code, units_json, length,"
        " difficulty, question_ids_json, option_orders_json, total, started_at,"
        " mode, source, time_limit_s)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (user_id, subject_code, json.dumps(cleaned), length_key, difficulty,
         json.dumps(drawn), json.dumps(orders), len(drawn), iso(clock()),
         mode, source, time_limit_s))
    conn.commit()
    return get_attempt(conn, user_id, int(cur.lastrowid))


def get_attempt(conn, user_id: int, attempt_id: int) -> dict:
    """The attempt as it stands, recorded reveals included — this is resuming."""
    return _attempt_shape(conn, _attempt_row(conn, user_id, attempt_id))


def answer_attempt(conn, user_id: int, attempt_id: int, position: int,
                   chosen: int) -> dict:
    """Record one answer and reveal it. The first click is the answer.

    A second answer to the same position is refused, never overwritten: the
    reveal already told the student what the right option was, so a second
    click is either a double-tap or a retry, and both of those must not be able
    to turn a wrong answer into a right one. `UNIQUE(attempt_id, position)`
    makes that true even for two requests in flight at once — the loser catches
    the IntegrityError here and gets the same 409 as a sequential retry.

    That is PRACTICE. An EXAM goes to `_answer_exam`, which records the choice,
    lets it change, and reveals nothing.

    Both inserts are guarded by `submitted_at IS NULL` in the same statement,
    not only by the read above: a submit landing between that read and this
    write would otherwise score the paper and then have an answer arrive after
    it. The write either lands before the submit's UPDATE, and is scored, or
    after it, and is refused.
    """
    row = _attempt_row(conn, user_id, attempt_id)
    if row["submitted_at"] is not None:
        raise McqConflict(f"attempt {attempt_id} is already submitted")
    if row["mode"] == "exam":
        return _answer_exam(conn, row, position, chosen)

    ids = json.loads(row["question_ids_json"])
    orders = json.loads(row["option_orders_json"])
    if not isinstance(position, int) or not 1 <= position <= len(ids):
        raise ValueError(
            f"position must be 1-{len(ids)} for this attempt, got {position!r}")
    if not isinstance(chosen, int) or not 0 <= chosen < N_OPTIONS:
        raise ValueError(f"chosen must be 0-{N_OPTIONS - 1}, got {chosen!r}")

    question_id = ids[position - 1]
    question = _questions_by_id(conn, [question_id]).get(question_id)
    if question is None:
        raise LookupError(f"attempt {attempt_id} question {position} is missing")

    order = orders[position - 1]
    is_correct = order[chosen] == int(question["correct"])
    try:
        cur = conn.execute(
            "INSERT INTO mcq_answers (attempt_id, position, question_id, chosen,"
            " is_correct, answered_at) SELECT ?,?,?,?,?,?"
            " WHERE EXISTS (SELECT 1 FROM mcq_attempts"
            "               WHERE id = ? AND submitted_at IS NULL)",
            (attempt_id, position, question_id, chosen, 1 if is_correct else 0,
             iso(clock()), attempt_id))
    except sqlite3.IntegrityError as exc:
        raise McqConflict(
            f"question {position} of attempt {attempt_id} is already answered"
        ) from exc
    conn.commit()
    if cur.rowcount != 1:
        raise McqConflict(f"attempt {attempt_id} is already submitted")

    totals = conn.execute(
        "SELECT COUNT(*) AS answered, COALESCE(SUM(is_correct), 0) AS correct"
        " FROM mcq_answers WHERE attempt_id = ?", (attempt_id,)).fetchone()
    return {
        "position": position,
        "chosen": chosen,
        "correct_index": _shown_correct(question, order),
        "is_correct": is_correct,
        "explain": question["explain"],
        "why_wrong": _why_wrong(question, order, chosen),
        "answered": totals["answered"],
        "correct_so_far": totals["correct"],
    }


def _answer_exam(conn, row, position: int, chosen: int) -> dict:
    """Record (or change) one exam answer, and reveal NOTHING.

    Returns `{position, chosen, answered}` and nothing else — no is_correct,
    no correct_index, no explain, no why_wrong, no running score. This is the
    security property of exam mode: answers can change until submit, so a
    response that carried any verdict would let a student click all four
    options of a question and keep the one the server liked. `is_correct` is
    still computed and stored — submit grades from it — but it never leaves
    this function.

    Refused with McqConflict (409) once the clock has run out plus
    `EXAM_GRACE_S`: a paused tab must not keep answering a paper whose time is
    up. Submitting is never refused on time, so an expired paper can always be
    closed and read.
    """
    attempt_id = row["id"]
    deadline = _deadline(row)
    if deadline is not None and clock() > deadline + timedelta(
            seconds=EXAM_GRACE_S):
        raise McqConflict(
            f"time is up for attempt {attempt_id}; submit it to see your score")

    ids = json.loads(row["question_ids_json"])
    orders = json.loads(row["option_orders_json"])
    if not isinstance(position, int) or not 1 <= position <= len(ids):
        raise ValueError(
            f"position must be 1-{len(ids)} for this attempt, got {position!r}")
    if not isinstance(chosen, int) or not 0 <= chosen < N_OPTIONS:
        raise ValueError(f"chosen must be 0-{N_OPTIONS - 1}, got {chosen!r}")

    question_id = ids[position - 1]
    question = _questions_by_id(conn, [question_id]).get(question_id)
    if question is None:
        raise LookupError(f"attempt {attempt_id} question {position} is missing")
    is_correct = orders[position - 1][chosen] == int(question["correct"])

    # The upsert is the exam's whole difference at the table: UNIQUE(attempt_id,
    # position) is the conflict target, so a changed mind overwrites the one
    # row rather than adding a second one to grade. `WHERE EXISTS` is the same
    # submitted guard as practice's insert, in the same statement.
    cur = conn.execute(
        "INSERT INTO mcq_answers (attempt_id, position, question_id, chosen,"
        " is_correct, answered_at) SELECT ?,?,?,?,?,?"
        " WHERE EXISTS (SELECT 1 FROM mcq_attempts"
        "               WHERE id = ? AND submitted_at IS NULL)"
        " ON CONFLICT(attempt_id, position) DO UPDATE SET"
        "   chosen = excluded.chosen, is_correct = excluded.is_correct,"
        "   answered_at = excluded.answered_at",
        (attempt_id, position, question_id, chosen, 1 if is_correct else 0,
         iso(clock()), attempt_id))
    conn.commit()
    if cur.rowcount != 1:
        raise McqConflict(f"attempt {attempt_id} is already submitted")

    answered = conn.execute(
        "SELECT COUNT(*) AS n FROM mcq_answers WHERE attempt_id = ?",
        (attempt_id,)).fetchone()["n"]
    return {"position": position, "chosen": chosen, "answered": answered}


def submit_attempt(conn, user_id: int, attempt_id: int) -> dict:
    """Close the attempt and score it. Unanswered questions score zero.

    Claiming the attempt is one guarded UPDATE, the same idiom as
    `testmode.service.submit_test`: reading `submitted_at` and then writing it
    would let a double tap over a slow connection have both requests decide
    they were first, and stamp two different durations on one sitting. Exactly
    one sees rowcount 1; the loser reads back what the winner stored. The score
    itself cannot differ between them — answering is refused once submitted —
    but the duration and the submission time can, and a result screen that
    disagrees with the history list is the bug this prevents.

    The score is counted INSIDE that UPDATE, from the answer rows as they
    stand when it runs, and the answers are read back only after it. Exam
    answers can change until submit, and both answer paths refuse a write once
    `submitted_at` is set in the same statement, so every answer either lands
    before this UPDATE and is in the score, or after it and is refused — the
    stored score and the stored answers cannot disagree.

    Submitting an exam is never refused on time: an expired paper can always
    be closed. Its `duration_s` stops at the limit plus the grace, because
    nothing could be answered after that — a tab left open overnight did not
    take nine hours over a thirty-minute paper.
    """
    row = _attempt_row(conn, user_id, attempt_id)
    if row["submitted_at"] is None:
        now = clock()
        duration_s = max(0, int((now - _parse(row["started_at"])
                                 ).total_seconds()))
        if row["mode"] == "exam" and row["time_limit_s"] is not None:
            duration_s = min(duration_s, row["time_limit_s"] + EXAM_GRACE_S)
        conn.execute(
            "UPDATE mcq_attempts SET submitted_at = ?, duration_s = ?,"
            " score = (SELECT COALESCE(SUM(is_correct), 0) FROM mcq_answers"
            "          WHERE attempt_id = mcq_attempts.id)"
            " WHERE id = ? AND submitted_at IS NULL",
            (iso(now), duration_s, attempt_id))
        conn.commit()
    # Whoever won the claim — this call or a concurrent one — the stored row
    # is the result, so every caller reports the same one.
    row = _attempt_row(conn, user_id, attempt_id)
    ids = json.loads(row["question_ids_json"])
    orders = json.loads(row["option_orders_json"])
    questions = _questions_by_id(conn, ids)
    answers = {r["position"]: r for r in _answer_rows(conn, attempt_id)}

    total = row["total"]
    answered = len(answers)
    score = (row["score"] if row["score"] is not None
             else sum(1 for r in answers.values() if r["is_correct"]))
    duration_s = row["duration_s"] or 0

    # by_topic covers every question DRAWN, not every question answered: a
    # topic you skipped entirely scored 0 out of its real count, and reporting
    # it as 0/0 (or omitting it) would hide exactly the gap worth seeing.
    by_topic: dict[str, dict] = {}
    # Same rule as by_topic and for the same reason: every question DRAWN,
    # answered or not. In ladder order, not alphabetically, and tiers the
    # attempt never drew are left out entirely — a Mixed sitting that happened
    # to draw no max question must not report 0/0 max as if it had been sat.
    by_difficulty: dict[str, dict] = {}
    missed: list[dict] = []
    for position, (qid, order) in enumerate(zip(ids, orders), start=1):
        question = questions.get(qid)
        if question is None:
            continue
        bucket = by_topic.setdefault(
            question["topic"], {"topic": question["topic"], "correct": 0,
                                "total": 0})
        bucket["total"] += 1
        tier = by_difficulty.setdefault(
            question["difficulty"], {"difficulty": question["difficulty"],
                                     "correct": 0, "total": 0})
        tier["total"] += 1
        answer = answers.get(position)
        if answer is not None and answer["is_correct"]:
            bucket["correct"] += 1
            tier["correct"] += 1
            continue
        chosen = answer["chosen"] if answer is not None else None
        missed.append({
            "position": position,
            "topic": question["topic"],
            "question": question["question"],
            **_presentation(question),
            "options": _shown_options(question, order),
            "chosen": chosen,
            "correct_index": _shown_correct(question, order),
            "explain": question["explain"],
            # Nothing was picked, so there is no wrong option to explain. The
            # teaching for an unanswered question is `explain`.
            "why_wrong": ("" if chosen is None
                          else _why_wrong(question, order, chosen)),
        })

    return {
        "attempt_id": row["id"],
        "score": score,
        "total": total,
        "answered": answered,
        "percent": round(100 * score / total) if total else 0,
        "duration_s": duration_s,
        "by_topic": [by_topic[t] for t in sorted(by_topic)],
        "by_difficulty": [by_difficulty[d] for d in DIFFICULTIES
                          if d in by_difficulty],
        "missed": missed,
        # A sitting nobody answered is not a leaderboard entry, so it is not
        # given a position on one. Nor is a mistakes sitting: it is on no
        # board at all (see `_board_rows`).
        "rank": (_rank_of(conn, user_id, row["subject_code"],
                          json.loads(row["units_json"]), row["length"],
                          row["difficulty"], row["mode"])
                 if answered and row["source"] == "bank" else None),
    }


def abandon_attempt(conn, user_id: int, attempt_id: int) -> None:
    """Throw away an open attempt. A submitted one is a result, not clutter.

    Deletes the answers explicitly in the same transaction: `mcq_answers` has
    no ON DELETE CASCADE (SQLite would need the pragma and this schema does not
    rely on it), so leaving them would orphan rows for a later query to trip
    over.
    """
    row = _attempt_row(conn, user_id, attempt_id)
    if row["submitted_at"] is not None:
        raise McqConflict(
            f"attempt {attempt_id} has been submitted; it cannot be discarded")
    conn.execute("DELETE FROM mcq_answers WHERE attempt_id = ?", (attempt_id,))
    conn.execute("DELETE FROM mcq_attempts WHERE id = ?", (attempt_id,))
    conn.commit()


def list_attempts(conn, user_id: int) -> list[dict]:
    """This user's sittings, newest first. `score` is null while one is open.

    An open exam's `score` is null like any open sitting, and nothing here is
    derived from `is_correct`, so the history list is not a third door onto a
    sealed paper."""
    rows = conn.execute(
        "SELECT a.id, a.subject_code, a.units_json, a.length, a.difficulty,"
        " a.mode, a.source, a.time_limit_s, a.total, a.score,"
        " a.started_at, a.submitted_at, a.duration_s,"
        " (SELECT COUNT(*) FROM mcq_answers ans WHERE ans.attempt_id = a.id)"
        "   AS answered"
        " FROM mcq_attempts a WHERE a.user_id = ?"
        " ORDER BY a.started_at DESC, a.id DESC", (user_id,)).fetchall()
    return [{
        "id": r["id"],
        "subject_code": r["subject_code"],
        "units": json.loads(r["units_json"]),
        "length": _length_out(r["length"]),
        "difficulty": r["difficulty"],
        "mode": r["mode"],
        "source": r["source"],
        "time_limit_s": r["time_limit_s"],
        "total": r["total"],
        "answered": r["answered"],
        "score": r["score"],
        "started_at": r["started_at"],
        "submitted_at": r["submitted_at"],
        "duration_s": r["duration_s"],
    } for r in rows]


def leaderboard(conn, subject_code: str, units, length, difficulty=None,
                limit: int = 25, mode=None) -> list[dict]:
    """Each user's best submitted attempt for EXACTLY this selection.

    Exactly: same subject, same canonical units, same length, same difficulty.
    Units [1] and [1, 2] are different boards on purpose — they are different
    papers, and mixing them would rank a twelve-question sitting against a
    twenty-four question one. `canonical_units` is what makes [2, 1] and
    [1, 2] the same board rather than two.

    Difficulty joined the key for the same reason: 26/30 on Easy and 26/30 on
    Max are not the same achievement, and one board holding both would rank the
    student who picked the gentler paper above the one who did not. Mixed is a
    fifth board, never a merge of the four — a merge would be a board nobody
    actually sat.

    `mode` splits every board in two the same way: 'practice' (None, and every
    attempt drawn before exams existed) or 'exam'. A practice score was earned
    with each answer explained on the way and no clock; an exam score was not.
    Ranking one against the other would reward whichever paper was easier to
    sit, not whoever knows more.

    This is the front door: a user naming a selection, so the selection is
    validated against the registry before it is looked up. Ranking an attempt
    that already exists goes through `_board_rows` instead — see the note
    there.

    This is the one cross-user read in the feature, and it is the feature: a
    leaderboard that showed you only yourself would be a history page.
    """
    cleaned, length_key, difficulty = _validate_selection(
        subject_code, units, length, difficulty)
    mode = _validate_mode(mode)
    return _board_rows(conn, subject_code, cleaned, length_key, difficulty,
                       limit, mode)


def _board_rows(conn, subject_code: str, units: list[int], length_key: str,
                difficulty: str | None = None,
                limit: int | None = 25, mode: str = "practice") -> list[dict]:
    """The board for a selection that is already canonical and already legal.

    Split from `leaderboard` so that ranking a STORED attempt never re-checks
    its selection against the registry. MCQ_UNITS is code: units get written,
    renamed and dropped as the course material is, and an attempt drawn before
    such an edit must still submit afterwards. Validating here made
    `submit_attempt` raise ValueError out of a route that only translates
    LookupError, so removing one unit from the registry turned every open
    attempt covering it into a 500 with the sitting unrecoverable.

    Ordered by percent, then by the shorter sitting, then by who got there
    first. Best-per-user is picked in Python from that same ordering, so the
    row shown is by definition the one that would have ranked highest anyway —
    one rule, not two that can disagree.

    `source = 'bank'` is not a filter a caller can turn off. A 'mistakes'
    sitting drew only the questions that student got wrong — a different paper
    for every student, and a different one for the same student next week — so
    it ranks against nothing, on any board.
    """
    # `a.difficulty IS ?` and never `= ?`: Mixed is stored as NULL, and
    # `NULL = NULL` is not true in SQLite, so the equality form would give the
    # Mixed board zero rows for ever while every tier board worked — a bug that
    # looks like "nobody has sat Mixed yet" rather than like a bug.
    rows = conn.execute(
        "SELECT a.user_id, u.name, a.score, a.total, a.duration_s,"
        " a.submitted_at FROM mcq_attempts a JOIN users u ON u.id = a.user_id"
        " WHERE a.subject_code = ? AND a.units_json = ? AND a.length = ?"
        " AND a.difficulty IS ? AND a.mode = ? AND a.source = 'bank'"
        " AND a.submitted_at IS NOT NULL",
        (subject_code, json.dumps(units), length_key, difficulty,
         mode)).fetchall()

    entries = []
    for r in rows:
        total = r["total"] or 0
        score = r["score"] or 0
        entries.append({
            "user_id": r["user_id"],
            "name": r["name"],
            "score": score,
            "total": total,
            "percent": round(100 * score / total) if total else 0,
            "duration_s": r["duration_s"] or 0,
            "submitted_at": r["submitted_at"],
        })
    entries.sort(key=lambda e: (-e["percent"], e["duration_s"],
                                e["submitted_at"] or ""))

    best: list[dict] = []
    seen: set[int] = set()
    for entry in entries:
        if entry["user_id"] in seen:
            continue
        seen.add(entry["user_id"])
        best.append(entry)
    return best[:limit] if limit is not None else best


def _rank_of(conn, user_id: int, subject_code: str, units, length_key: str,
             difficulty: str | None = None, mode: str = "practice"):
    """Where this user's row sits on the board for this selection.

    Takes the attempt's own stored `units_json`, `length` and `difficulty` — a
    selection that exists, therefore one that was legal when it was drawn — and
    goes straight to `_board_rows`. It must not re-validate: see the note
    there. That rule covers difficulty too. A tier dropped from
    `registry.DIFFICULTIES` would otherwise strand every attempt drawn from it
    in exactly the way a dropped unit once stranded attempts covering it.
    And `mode` is the attempt's own stored mode: an exam is ranked on the exam
    board, whatever board the client happens to be showing.

    The board is best-per-user, so this is the position of the user's best
    submitted attempt — which is the attempt just submitted whenever it was
    their best, and otherwise the better one they already had. `of` is how many
    people are on the board, not how many attempts exist.
    """
    rows = _board_rows(conn, subject_code, canonical_units(units), length_key,
                       difficulty, limit=None, mode=mode)
    for position, row in enumerate(rows, start=1):
        if row["user_id"] == user_id:
            return {"position": position, "of": len(rows)}
    return None


def _parse(stamp: str) -> datetime:
    """A stored ISO timestamp back as an aware datetime, tolerating junk.

    Naive stamps are read as UTC: every writer in the app is aware, so a naive
    one is an old row, and guessing local time on a server would make a
    duration wrong by hours rather than by nothing.
    """
    try:
        parsed = datetime.fromisoformat(stamp)
    except (TypeError, ValueError):
        return clock()
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


__all__ = ["McqConflict", "abandon_attempt", "answer_attempt",
           "canonical_units", "clock", "create_attempt", "get_attempt",
           "leaderboard", "list_attempts", "list_subjects", "mistakes_summary",
           "submit_attempt"]
