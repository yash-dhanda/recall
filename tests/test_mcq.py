"""Yash Made Test: the curated MCQ bank, end to end.

The bank under test is tests/fixtures/mcq — twelve questions over three topics
in unit 1, four in unit 2 — never src/recall/mcq/bank, so these tests describe
a bank they control and do not break when a real question is written.

The fixture's tiers are deliberate and the tests lean on them:

    unit 1 (12)  easy 4  medium 3  hard 3  max 2
    unit 2 (4)   easy 2  medium 1  hard 1  max 0

Unit 2 carrying no `max` is what lets a test ask for a tier that has nothing
and get a 422 rather than an empty sitting.
"""

import json
import random
import shutil
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from recall.api.app import create_app, get_conn
from recall.api.deps import get_current_user
from recall.db import connect, init_db
from recall.mcq import bank, registry, service
from recall.mcq.bank import load_bank, load_questions, validate_question
from recall.mcq.seed import seed_mcq_bank
from recall.mcq.service import McqConflict

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "mcq"

OWNER, INTRUDER = 1, 2

#: The fixture bank keyed by question text, so a test can work out which shown
#: option is the right one without ever reading the attempt's stored order.
BY_TEXT = {q["question"]: q for q in load_questions(FIXTURES)}


# --- helpers ---------------------------------------------------------------

def make_db(path: str, bank_dir: Path = FIXTURES) -> None:
    conn = connect(path)
    init_db(conn)
    for uid, name in ((OWNER, "owner"), (INTRUDER, "intruder")):
        conn.execute("INSERT INTO users (id, name) VALUES (?,?)", (uid, name))
        conn.execute("INSERT INTO settings (user_id) VALUES (?)", (uid,))
    conn.commit()
    seed_mcq_bank(conn, bank_dir)
    conn.close()


@pytest.fixture
def db_path(tmp_path):
    path = str(tmp_path / "mcq.db")
    make_db(path)
    return path


def client_as(db_path: str, user_id: int) -> TestClient:
    # The real app, wired as it ships: if app.py ever stops including the mcq
    # router these tests must fail rather than quietly mount it themselves.
    app = create_app()

    def override():
        conn = connect(db_path)
        try:
            yield conn
        finally:
            conn.close()

    app.dependency_overrides[get_conn] = override
    app.dependency_overrides[get_current_user] = lambda: user_id
    return TestClient(app)


@pytest.fixture
def client(db_path):
    return client_as(db_path, OWNER)


def start(client: TestClient, units=(1,), length="full",
          difficulty=None) -> dict:
    body = {"subject_code": "CSE111", "units": list(units), "length": length}
    if difficulty is not None:
        body["difficulty"] = difficulty
    r = client.post("/api/mcq/attempts", json=body)
    assert r.status_code == 200, r.text
    return r.json()


#: What each fixture unit holds per tier. Written out rather than counted from
#: the files so a test fails when the fixture changes under it.
TIERS = {1: {"easy": 4, "medium": 3, "hard": 3, "max": 2, "hardest": 0},
         2: {"easy": 2, "medium": 1, "hard": 1, "max": 0, "hardest": 0}}


def correct_shown(question: dict) -> int:
    """Which SHOWN option is the right one, read from the fixture file."""
    source = BY_TEXT[question["question"]]
    return question["options"].index(source["options"][source["correct"]])


def wrong_shown(question: dict) -> int:
    return next(i for i in range(4) if i != correct_shown(question))


def a_question(**overrides) -> dict:
    """A valid question dict, before whatever the caller breaks about it."""
    question = {
        "key": "X-1", "topic": "Linux", "kind": "recall", "difficulty": "easy",
        "q": "Which command prints the working directory?",
        "options": ["pwd", "ls", "cd", "mkdir"],
        "correct": 0,
        "explain": "pwd prints the absolute path of the current directory.",
        "why_wrong": ["", "ls lists contents.", "cd changes directory.",
                      "mkdir makes one."],
    }
    question.update(overrides)
    return question


# --- the loader ------------------------------------------------------------

def test_a_valid_question_passes():
    validate_question(a_question())


@pytest.mark.parametrize("overrides,reason", [
    ({"options": ["a", "b", "c"]}, "exactly 4 options"),
    ({"correct": 4}, "correct must be 0-3"),
    ({"correct": -1}, "correct must be 0-3"),
    ({"why_wrong": ["", "b", "c"]}, "exactly 4 why_wrong"),
    ({"correct": 1}, "correct option"),                # why_wrong[1] is not ""
    ({"why_wrong": ["", "b", "   ", "d"]}, "why_wrong[2] is blank"),
    ({"kind": "trivia"}, "kind must be one of"),
    ({"difficulty": "brutal"}, "difficulty must be one of"),
    ({"difficulty": None}, "difficulty must be one of"),
    ({"difficulty": "Easy"}, "difficulty must be one of"),
    ({"q": "  "}, "q must be a non-empty string"),
    ({"explain": ""}, "explain must be a non-empty string"),
    ({"topic": ""}, "topic must be a non-empty string"),
])
def test_validation_names_the_key_and_the_reason(overrides, reason):
    with pytest.raises(ValueError) as exc:
        validate_question(a_question(**overrides))
    message = str(exc.value)
    assert "X-1" in message, message
    assert reason in message, message


def test_a_question_with_no_difficulty_is_refused_by_key():
    """The field is required and the loader invents nothing. The column's
    DEFAULT is for migrating a live database, not for a file someone forgot to
    label — an unlabelled question would quietly join the 'medium' tier."""
    question = a_question()
    del question["difficulty"]
    with pytest.raises(ValueError) as exc:
        validate_question(question)
    assert "X-1" in str(exc.value)
    assert "difficulty must be one of easy, medium, hard, max" in str(exc.value)


def test_the_ladder_is_the_registrys():
    assert registry.DIFFICULTIES == ("easy", "medium", "hard", "max", "hardest")
    assert bank.DIFFICULTIES == registry.DIFFICULTIES


def test_a_question_with_no_key_is_refused_by_position():
    question = a_question()
    del question["key"]
    with pytest.raises(ValueError, match="has no key"):
        validate_question(question, where="f.json question 3")


def test_duplicate_keys_across_files_are_refused(tmp_path):
    """The key is what an attempt stores and what the seeder upserts on, so
    two files sharing one would overwrite each other on every boot."""
    for name, unit in (("a.json", 1), ("b.json", 2)):
        (tmp_path / name).write_text(json.dumps({
            "subject_code": "CSE111", "unit": unit, "unit_label": "u",
            "questions": [a_question(key="CSE111-DUP")],
        }))
    with pytest.raises(ValueError) as exc:
        load_bank(tmp_path)
    assert "CSE111-DUP" in str(exc.value)
    assert "duplicate key" in str(exc.value)


def test_a_missing_bank_directory_is_zero_questions_not_an_error(tmp_path):
    assert load_bank(tmp_path / "nothing-here") == []


def test_an_empty_bank_directory_is_zero_questions(tmp_path):
    assert load_bank(tmp_path) == []


def test_underscore_keys_are_ignored():
    files = load_bank(FIXTURES)
    assert len(files) == 2
    assert all("_note" not in q for f in files for q in f.questions)


def test_the_file_shapes_question_text_from_q():
    unit1 = next(f for f in load_bank(FIXTURES) if f.unit == 1)
    assert len(unit1.questions) == 12
    assert all(q["question"] and "q" not in q for q in unit1.questions)
    assert unit1.subject_code == "CSE111"


# --- seeding ---------------------------------------------------------------

def test_seeding_twice_changes_nothing(tmp_path):
    path = str(tmp_path / "seed.db")
    conn = connect(path)
    init_db(conn)
    first = seed_mcq_bank(conn, FIXTURES)
    second = seed_mcq_bank(conn, FIXTURES)
    assert first == second
    assert first == {"files": 2, "questions": 16, "retired": 0, "active": 16,
                     "unreachable": 0}
    ids =[r["id"] for r in conn.execute("SELECT id FROM mcq_questions ORDER BY id")]
    assert len(ids) == 16, "upsert on key, never a second row for one question"
    conn.close()


def test_editing_a_question_fixes_it_in_place(tmp_path):
    """The row id must survive an edit: attempts store it."""
    bank_dir = tmp_path / "bank"
    shutil.copytree(FIXTURES, bank_dir)
    path = str(tmp_path / "edit.db")
    conn = connect(path)
    init_db(conn)
    seed_mcq_bank(conn, bank_dir)
    before = conn.execute(
        "SELECT id, question FROM mcq_questions WHERE key = 'CSE111-U2-002'"
    ).fetchone()

    data = json.loads((bank_dir / "cse111_unit2.json").read_text())
    for q in data["questions"]:
        if q["key"] == "CSE111-U2-002":
            q["q"] = "How many bits does one byte hold?"
    (bank_dir / "cse111_unit2.json").write_text(json.dumps(data))
    seed_mcq_bank(conn, bank_dir)

    after = conn.execute(
        "SELECT id, question FROM mcq_questions WHERE key = 'CSE111-U2-002'"
    ).fetchone()
    assert after["id"] == before["id"]
    assert after["question"] != before["question"]
    conn.close()


def test_a_question_removed_from_the_json_is_retired_not_deleted(tmp_path):
    """And an attempt that already drew it stays readable and gradable — which
    is the whole reason retirement exists instead of a DELETE."""
    bank_dir = tmp_path / "bank"
    shutil.copytree(FIXTURES, bank_dir)
    path = str(tmp_path / "retire.db")
    make_db(path, bank_dir)

    client = client_as(path, OWNER)
    attempt = start(client, units=[1], length="full")
    assert attempt["total"] == 12

    dropped = BY_TEXT["Which Linux command prints the full path of the "
                      "directory you are currently in?"]
    held = next(q for q in attempt["questions"]
                if q["question"] == dropped["question"])

    data = json.loads((bank_dir / "cse111_unit1.json").read_text())
    data["questions"] = [q for q in data["questions"]
                         if q["key"] != dropped["key"]]
    (bank_dir / "cse111_unit1.json").write_text(json.dumps(data))

    conn = connect(path)
    counts = seed_mcq_bank(conn, bank_dir)
    assert counts["retired"] == 1
    row = conn.execute("SELECT active FROM mcq_questions WHERE key = ?",
                       (dropped["key"],)).fetchone()
    assert row["active"] == 0
    # Seeding again retires nothing more: it is already off.
    assert seed_mcq_bank(conn, bank_dir)["retired"] == 0
    conn.close()

    resumed = client.get(f"/api/mcq/attempts/{attempt['attempt_id']}").json()
    assert resumed["total"] == 12, "a retired question stays on its attempt"
    r = client.post(f"/api/mcq/attempts/{attempt['attempt_id']}/answer",
                    json={"position": held["position"],
                          "chosen": correct_shown(held)})
    assert r.status_code == 200, r.text
    assert r.json()["is_correct"] is True

    # And it is out of the draw from now on.
    fresh = start(client, units=[1], length="full")
    assert fresh["total"] == 11


def test_retirement_does_not_reach_units_the_files_do_not_cover(tmp_path):
    """Seeding from a directory holding only unit 1 says nothing about unit 2."""
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    shutil.copy(FIXTURES / "cse111_unit1.json", bank_dir)
    path = str(tmp_path / "partial.db")
    make_db(path)                       # full bank first
    conn = connect(path)
    seed_mcq_bank(conn, bank_dir)
    live = conn.execute(
        "SELECT COUNT(*) AS n FROM mcq_questions WHERE unit = 2 AND active = 1"
    ).fetchone()["n"]
    conn.close()
    assert live == 4


def test_a_retired_question_comes_back_if_it_returns_to_the_json(tmp_path):
    bank_dir = tmp_path / "bank"
    shutil.copytree(FIXTURES, bank_dir)
    path = str(tmp_path / "revive.db")
    make_db(path, bank_dir)
    data = json.loads((bank_dir / "cse111_unit2.json").read_text())
    kept = [q for q in data["questions"] if q["key"] != "CSE111-U2-004"]
    (bank_dir / "cse111_unit2.json").write_text(
        json.dumps({**data, "questions": kept}))
    conn = connect(path)
    seed_mcq_bank(conn, bank_dir)
    shutil.copy(FIXTURES / "cse111_unit2.json", bank_dir)
    seed_mcq_bank(conn, bank_dir)
    row = conn.execute("SELECT active FROM mcq_questions WHERE key = ?",
                       ("CSE111-U2-004",)).fetchone()
    conn.close()
    assert row["active"] == 1


# --- subjects --------------------------------------------------------------

def test_subjects_lists_every_unit_with_its_live_count(client):
    body = client.get("/api/mcq/subjects").json()
    # All eight registered; CSE111 first because it is the one with questions.
    assert len(body) == 8
    assert body[0]["subject_code"] == "CSE111"
    subject = body[0]
    assert subject["label"] == "Orientation to Computing"
    assert subject["lengths"] == [30, 60, "full"]
    assert subject["difficulties"] == ["easy", "medium", "hard", "max", "hardest"]
    assert (subject["length_min"], subject["length_max"]) == (5, 200)
    assert [(u["unit"], u["count"]) for u in subject["units"]] == [(1, 12), (2, 4)]
    assert subject["units"][0]["label"].startswith("Computational Thinking")


def test_subjects_breaks_every_unit_down_by_tier(client):
    """The picker greys out a tier with nothing in it, so the counts have to be
    real and every tier has to be present even at zero."""
    units = client.get("/api/mcq/subjects").json()[0]["units"]
    assert {u["unit"]: u["difficulties"] for u in units} == TIERS
    for unit in units:
        assert sum(unit["difficulties"].values()) == unit["count"]
        assert list(unit["difficulties"]) == ["easy", "medium", "hard", "max", "hardest"]


def test_a_unit_with_no_questions_still_appears_with_a_count_of_zero(tmp_path):
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    shutil.copy(FIXTURES / "cse111_unit1.json", bank_dir)
    path = str(tmp_path / "unit1only.db")
    make_db(path, bank_dir)
    units = client_as(path, OWNER).get("/api/mcq/subjects").json()[0]["units"]
    assert [(u["unit"], u["count"]) for u in units] == [(1, 12), (2, 0)]
    assert units[1]["difficulties"] == {"easy": 0, "medium": 0, "hard": 0,
                                        "max": 0, "hardest": 0}


# --- creating an attempt ---------------------------------------------------

def test_asking_for_thirty_from_a_bank_of_twelve_draws_twelve(client):
    attempt = start(client, units=[1], length=30)
    assert attempt["total"] == 12
    assert len(attempt["questions"]) == 12
    assert attempt["length"] == 30
    assert attempt["units"] == [1]
    assert attempt["submitted_at"] is None


def test_a_fresh_attempt_never_carries_the_answer(client):
    r = client.post("/api/mcq/attempts", json={
        "subject_code": "CSE111", "units": [1, 2], "length": "full"})
    assert "why_wrong" not in r.text
    assert "correct_index" not in r.text
    for question in r.json()["questions"]:
        assert set(question) == {"position", "topic", "kind", "difficulty",
                                 "question", "code", "options_mono",
                                 "options", "answer"}
        assert question["answer"] is None


def test_every_option_order_is_a_real_permutation(client):
    for question in start(client, units=[1, 2])["questions"]:
        source = BY_TEXT[question["question"]]
        assert len(question["options"]) == 4
        assert sorted(question["options"]) == sorted(source["options"])


def test_two_seeds_give_two_different_sittings(db_path):
    conn = connect(db_path)
    one = service.create_attempt(conn, OWNER, "CSE111", [1], 30,
                                 rng=random.Random(1))
    two = service.create_attempt(conn, OWNER, "CSE111", [1], 30,
                                 rng=random.Random(2))
    conn.close()
    texts_one = [q["question"] for q in one["questions"]]
    texts_two = [q["question"] for q in two["questions"]]
    options_one = [q["options"] for q in one["questions"]]
    assert sorted(texts_one) == sorted(texts_two), "same pool, both times"
    assert (texts_one, options_one) != (
        texts_two, [q["options"] for q in two["questions"]])


def test_the_same_seed_gives_the_same_sitting(db_path):
    conn = connect(db_path)
    one = service.create_attempt(conn, OWNER, "CSE111", [1], 30,
                                 rng=random.Random(7))
    two = service.create_attempt(conn, OWNER, "CSE111", [1], 30,
                                 rng=random.Random(7))
    conn.close()
    assert [(q["question"], q["options"]) for q in one["questions"]] == \
           [(q["question"], q["options"]) for q in two["questions"]]


def test_two_units_pool_both_files(client):
    attempt = start(client, units=[1, 2], length="full")
    assert attempt["total"] == 16
    topics = {q["topic"] for q in attempt["questions"]}
    assert "Number Systems" in topics
    assert "Linux" in topics


def test_units_are_a_set_not_a_sequence(client):
    """[2,1] and [1,2] are one selection, so they are one leaderboard."""
    assert start(client, units=[2, 1])["units"] == [1, 2]
    assert start(client, units=[1, 1, 2])["units"] == [1, 2]


@pytest.mark.parametrize("body", [
    {"subject_code": "NOPE", "units": [1], "length": 30},
    {"subject_code": "CSE111", "units": [9], "length": 30},
    {"subject_code": "CSE111", "units": [], "length": 30},
    {"subject_code": "CSE111", "units": [1], "length": 4},
    {"subject_code": "CSE111", "units": [1], "length": 201},
    {"subject_code": "CSE111", "units": [1], "length": 0},
    {"subject_code": "CSE111", "units": [1], "length": -1},
    {"subject_code": "CSE111", "units": [1], "length": "half"},
    {"subject_code": "CSE111", "units": [1], "length": 30,
     "difficulty": "brutal"},
    {"subject_code": "CSE111", "units": [1], "length": 30, "difficulty": "Easy"},
])
def test_an_impossible_selection_is_422(client, body):
    r = client.post("/api/mcq/attempts", json=body)
    assert r.status_code == 422, r.text
    assert "detail" in r.json()


def test_a_selection_with_no_questions_is_422(tmp_path):
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    shutil.copy(FIXTURES / "cse111_unit1.json", bank_dir)
    path = str(tmp_path / "unit1only.db")
    make_db(path, bank_dir)
    r = client_as(path, OWNER).post("/api/mcq/attempts", json={
        "subject_code": "CSE111", "units": [2], "length": 30})
    assert r.status_code == 422
    assert "no questions yet" in r.json()["detail"]


# --- answering -------------------------------------------------------------

def test_a_right_answer_reveals_in_shown_order_with_no_scolding(client):
    attempt = start(client, units=[1])
    question = attempt["questions"][0]
    shown = correct_shown(question)
    body = client.post(f"/api/mcq/attempts/{attempt['attempt_id']}/answer",
                       json={"position": question["position"], "chosen": shown}
                       ).json()
    assert body["is_correct"] is True
    assert body["chosen"] == shown
    assert body["correct_index"] == shown
    assert question["options"][body["correct_index"]] == \
        BY_TEXT[question["question"]]["options"][
            BY_TEXT[question["question"]]["correct"]]
    assert body["why_wrong"] == ""
    assert body["explain"] == BY_TEXT[question["question"]]["explain"]
    assert (body["answered"], body["correct_so_far"]) == (1, 1)


def test_a_wrong_answer_gets_the_note_for_the_option_it_picked(client):
    attempt = start(client, units=[1])
    question = attempt["questions"][0]
    source = BY_TEXT[question["question"]]
    picked = wrong_shown(question)
    body = client.post(f"/api/mcq/attempts/{attempt['attempt_id']}/answer",
                       json={"position": question["position"], "chosen": picked}
                       ).json()
    assert body["is_correct"] is False
    assert body["correct_index"] == correct_shown(question)
    expected = source["why_wrong"][source["options"].index(
        question["options"][picked])]
    assert body["why_wrong"] == expected != ""
    assert (body["answered"], body["correct_so_far"]) == (1, 0)


def test_the_running_totals_climb(client):
    attempt = start(client, units=[1])
    aid = attempt["attempt_id"]
    seen = []
    for question in attempt["questions"][:3]:
        seen.append(client.post(
            f"/api/mcq/attempts/{aid}/answer",
            json={"position": question["position"],
                  "chosen": correct_shown(question)}).json())
    assert [s["answered"] for s in seen] == [1, 2, 3]
    assert [s["correct_so_far"] for s in seen] == [1, 2, 3]


def test_the_first_click_is_the_answer(client):
    attempt = start(client, units=[1])
    aid, question = attempt["attempt_id"], attempt["questions"][0]
    first = client.post(f"/api/mcq/attempts/{aid}/answer",
                        json={"position": question["position"],
                              "chosen": wrong_shown(question)})
    assert first.status_code == 200
    second = client.post(f"/api/mcq/attempts/{aid}/answer",
                         json={"position": question["position"],
                               "chosen": correct_shown(question)})
    assert second.status_code == 409
    assert "already answered" in second.json()["detail"]
    stored = client.get(f"/api/mcq/attempts/{aid}").json()["questions"][
        question["position"] - 1]["answer"]
    assert stored["is_correct"] is False, "a 409 must not rewrite the answer"


def test_two_answers_in_flight_together_settle_on_one(db_path):
    """UNIQUE(attempt_id, position) is what makes the 409 true under a race,
    not a read-then-write check that both threads can pass."""
    conn = connect(db_path)
    attempt = service.create_attempt(conn, OWNER, "CSE111", [1], 30,
                                     rng=random.Random(3))
    conn.close()
    aid = attempt["attempt_id"]
    question = attempt["questions"][0]

    barrier = threading.Barrier(4)
    accepted, conflicts, errors = [], [], []

    def answer(choice: int):
        own = connect(db_path)
        try:
            barrier.wait()
            accepted.append(service.answer_attempt(own, OWNER, aid, 1, choice))
        except McqConflict:
            conflicts.append(choice)
        except Exception as exc:  # reported, not swallowed
            errors.append(repr(exc))
        finally:
            own.close()

    threads = [threading.Thread(target=answer, args=(correct_shown(question),))
               for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len(accepted) == 1
    assert len(conflicts) == 3
    conn = connect(db_path)
    n = conn.execute("SELECT COUNT(*) AS n FROM mcq_answers WHERE attempt_id = ?",
                     (aid,)).fetchone()["n"]
    conn.close()
    assert n == 1


@pytest.mark.parametrize("payload", [
    {"position": 0, "chosen": 0},
    {"position": 99, "chosen": 0},
    {"position": 1, "chosen": 4},
    {"position": 1, "chosen": -1},
])
def test_an_out_of_range_answer_is_422(client, payload):
    attempt = start(client, units=[1])
    r = client.post(f"/api/mcq/attempts/{attempt['attempt_id']}/answer",
                    json=payload)
    assert r.status_code == 422, r.text


def test_answering_a_submitted_attempt_is_409(client):
    attempt = start(client, units=[1])
    aid = attempt["attempt_id"]
    client.post(f"/api/mcq/attempts/{aid}/submit")
    r = client.post(f"/api/mcq/attempts/{aid}/answer",
                    json={"position": 1, "chosen": 0})
    assert r.status_code == 409
    assert "submitted" in r.json()["detail"]


def test_answering_an_attempt_that_does_not_exist_is_404(client):
    r = client.post("/api/mcq/attempts/9999/answer",
                    json={"position": 1, "chosen": 0})
    assert r.status_code == 404


# --- submitting ------------------------------------------------------------

def sit(client: TestClient, attempt: dict, right: int, wrong: int) -> dict:
    """Answer `right` questions correctly and `wrong` wrongly; skip the rest."""
    aid = attempt["attempt_id"]
    questions = attempt["questions"]
    for question in questions[:right]:
        client.post(f"/api/mcq/attempts/{aid}/answer",
                    json={"position": question["position"],
                          "chosen": correct_shown(question)})
    for question in questions[right:right + wrong]:
        client.post(f"/api/mcq/attempts/{aid}/answer",
                    json={"position": question["position"],
                          "chosen": wrong_shown(question)})
    return client.post(f"/api/mcq/attempts/{aid}/submit").json()


def test_submitting_halfway_is_an_honest_score(client):
    attempt = start(client, units=[1], length="full")
    result = sit(client, attempt, right=5, wrong=2)
    assert result["total"] == 12, "total is what was drawn, not what was answered"
    assert result["answered"] == 7
    assert result["score"] == 5
    assert result["percent"] == round(100 * 5 / 12)
    assert result["duration_s"] >= 0


def test_by_difficulty_covers_every_tier_drawn_and_no_other(client):
    """Ladder order, tiers the attempt drew only, and it sums to the score —
    the same honesty rule by_topic follows, read down the ladder instead."""
    attempt = start(client, units=[1], length="full")
    result = sit(client, attempt, right=5, wrong=2)
    assert [t["difficulty"] for t in result["by_difficulty"]] == \
        ["easy", "medium", "hard", "max"], "the fixture bank has no hardest"
    assert {t["difficulty"]: t["total"] for t in result["by_difficulty"]} == \
        {k: v for k, v in TIERS[1].items() if k != "hardest"}
    assert sum(t["total"] for t in result["by_difficulty"]) == result["total"]
    assert sum(t["correct"] for t in result["by_difficulty"]) == result["score"]


def test_by_difficulty_omits_a_tier_the_attempt_never_drew(client):
    attempt = start(client, units=[2], length="full")
    result = sit(client, attempt, right=2, wrong=1)
    assert [t["difficulty"] for t in result["by_difficulty"]] == \
        ["easy", "medium", "hard"], "no 0/0 max for a tier nobody sat"
    assert sum(t["correct"] for t in result["by_difficulty"]) == result["score"]


def test_a_single_tier_sitting_reports_only_that_tier(client):
    result = sit(client, start(client, units=[1], difficulty="hard"),
                 right=2, wrong=1)
    assert result["by_difficulty"] == [{"difficulty": "hard", "correct": 2,
                                        "total": 3}]


def test_by_topic_covers_every_question_drawn(client):
    attempt = start(client, units=[1], length="full")
    result = sit(client, attempt, right=4, wrong=1)
    assert sum(t["total"] for t in result["by_topic"]) == 12
    assert sum(t["correct"] for t in result["by_topic"]) == result["score"]
    assert {t["topic"] for t in result["by_topic"]} == {
        "Computational Thinking", "Operating Systems", "Linux"}
    assert [t["topic"] for t in result["by_topic"]] == sorted(
        t["topic"] for t in result["by_topic"])


def test_missed_lists_the_wrong_and_the_unanswered_in_attempt_order(client):
    attempt = start(client, units=[1], length="full")
    result = sit(client, attempt, right=3, wrong=2)
    positions = [m["position"] for m in result["missed"]]
    assert positions == sorted(positions)
    assert len(result["missed"]) == 12 - 3

    answered_wrong = [m for m in result["missed"] if m["chosen"] is not None]
    assert len(answered_wrong) == 2
    for missed in answered_wrong:
        assert missed["why_wrong"] != ""
        assert missed["options"][missed["correct_index"]] == \
            BY_TEXT[missed["question"]]["options"][
                BY_TEXT[missed["question"]]["correct"]]

    unanswered = [m for m in result["missed"] if m["chosen"] is None]
    assert len(unanswered) == 7
    for missed in unanswered:
        assert missed["why_wrong"] == "", "nothing was picked to explain"
        assert missed["explain"]


def test_submitting_twice_returns_the_same_result(client):
    attempt = start(client, units=[1], length="full")
    first = sit(client, attempt, right=4, wrong=1)
    second = client.post(
        f"/api/mcq/attempts/{attempt['attempt_id']}/submit").json()
    assert first == second


def test_two_submits_in_flight_together_do_not_double_anything(db_path):
    conn = connect(db_path)
    attempt = service.create_attempt(conn, OWNER, "CSE111", [1], 30,
                                     rng=random.Random(11))
    aid = attempt["attempt_id"]
    for question in attempt["questions"][:4]:
        service.answer_attempt(conn, OWNER, aid, question["position"],
                               correct_shown(question))
    conn.close()

    barrier = threading.Barrier(4)
    results, errors = [], []

    def submit():
        own = connect(db_path)
        try:
            barrier.wait()
            results.append(service.submit_attempt(own, OWNER, aid))
        except Exception as exc:  # reported, not swallowed
            errors.append(repr(exc))
        finally:
            own.close()

    threads = [threading.Thread(target=submit) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len(results) == 4
    assert {r["score"] for r in results} == {4}
    assert {r["duration_s"] for r in results} == {results[0]["duration_s"]}
    conn = connect(db_path)
    row = conn.execute("SELECT submitted_at, score FROM mcq_attempts WHERE id = ?",
                       (aid,)).fetchone()
    n = conn.execute("SELECT COUNT(*) AS n FROM mcq_answers WHERE attempt_id = ?",
                     (aid,)).fetchone()["n"]
    conn.close()
    assert row["score"] == 4 and row["submitted_at"] is not None
    assert n == 4, "answers are not re-recorded by a second submit"


def test_a_sitting_nobody_answered_has_no_rank(client):
    attempt = start(client, units=[1])
    result = client.post(
        f"/api/mcq/attempts/{attempt['attempt_id']}/submit").json()
    assert result["answered"] == 0
    assert result["score"] == 0
    assert result["rank"] is None


def test_submitting_an_attempt_that_does_not_exist_is_404(client):
    assert client.post("/api/mcq/attempts/9999/submit").status_code == 404


# --- abandoning ------------------------------------------------------------

def test_abandoning_an_open_attempt_removes_it(client):
    attempt = start(client, units=[1])
    aid = attempt["attempt_id"]
    client.post(f"/api/mcq/attempts/{aid}/answer",
                json={"position": 1, "chosen": 0})
    r = client.delete(f"/api/mcq/attempts/{aid}")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert client.get(f"/api/mcq/attempts/{aid}").status_code == 404
    assert client.get("/api/mcq/attempts").json() == []


def test_abandoning_a_submitted_attempt_is_409(client):
    attempt = start(client, units=[1])
    aid = attempt["attempt_id"]
    client.post(f"/api/mcq/attempts/{aid}/submit")
    r = client.delete(f"/api/mcq/attempts/{aid}")
    assert r.status_code == 409
    assert client.get(f"/api/mcq/attempts/{aid}").status_code == 200


def test_abandoning_an_attempt_that_does_not_exist_is_404(client):
    assert client.delete("/api/mcq/attempts/9999").status_code == 404


# --- history ---------------------------------------------------------------

def test_history_is_newest_first_and_open_attempts_have_no_score(client):
    older = start(client, units=[1])
    sit(client, older, right=3, wrong=1)
    newer = start(client, units=[1, 2])

    rows = client.get("/api/mcq/attempts").json()
    assert [r["id"] for r in rows] == [newer["attempt_id"], older["attempt_id"]]
    assert rows[0]["score"] is None and rows[0]["submitted_at"] is None
    assert rows[0]["answered"] == 0 and rows[0]["units"] == [1, 2]
    assert rows[1]["score"] == 3 and rows[1]["answered"] == 4
    assert rows[1]["total"] == 12 and rows[1]["length"] == "full"


# --- isolation -------------------------------------------------------------

def test_another_users_attempt_is_missing_not_forbidden(db_path):
    """404 identical to an id that never existed: answering the two
    differently would make this route an oracle for other accounts."""
    owner = client_as(db_path, OWNER)
    intruder = client_as(db_path, INTRUDER)
    attempt = start(owner, units=[1])
    aid = attempt["attempt_id"]

    assert intruder.get(f"/api/mcq/attempts/{aid}").status_code == 404
    assert intruder.post(f"/api/mcq/attempts/{aid}/answer",
                         json={"position": 1, "chosen": 0}).status_code == 404
    assert intruder.post(f"/api/mcq/attempts/{aid}/submit").status_code == 404
    assert intruder.delete(f"/api/mcq/attempts/{aid}").status_code == 404
    # Word for word what an id that never existed gets, so the message itself
    # does not leak that this one does.
    assert intruder.get(f"/api/mcq/attempts/{aid}").json()["detail"] == \
        f"no attempt {aid}"
    assert intruder.get("/api/mcq/attempts/9999").json()["detail"] == \
        "no attempt 9999"

    # None of that touched the owner's attempt.
    assert owner.get(f"/api/mcq/attempts/{aid}").status_code == 200
    conn = connect(db_path)
    n = conn.execute("SELECT COUNT(*) AS n FROM mcq_answers").fetchone()["n"]
    conn.close()
    assert n == 0


def test_history_shows_only_your_own_attempts(db_path):
    owner = client_as(db_path, OWNER)
    intruder = client_as(db_path, INTRUDER)
    start(owner, units=[1])
    start(owner, units=[2])
    mine = start(intruder, units=[1])

    assert len(owner.get("/api/mcq/attempts").json()) == 2
    theirs = intruder.get("/api/mcq/attempts").json()
    assert [r["id"] for r in theirs] == [mine["attempt_id"]]


# --- the leaderboard -------------------------------------------------------

def board(client: TestClient, units="1", length="full",
          difficulty=None) -> list[dict]:
    params = {"subject_code": "CSE111", "units": units, "length": length}
    if difficulty is not None:
        params["difficulty"] = difficulty
    r = client.get("/api/mcq/leaderboard", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def set_duration(db_path: str, attempt_id: int, seconds: int) -> None:
    """Duration is wall clock, so a test that wants to compare two has to say
    what they were."""
    conn = connect(db_path)
    conn.execute("UPDATE mcq_attempts SET duration_s = ? WHERE id = ?",
                 (seconds, attempt_id))
    conn.commit()
    conn.close()


def test_the_board_ranks_by_percent_then_by_the_shorter_sitting(db_path):
    owner, intruder = client_as(db_path, OWNER), client_as(db_path, INTRUDER)
    a = start(owner, units=[1], length="full")
    sit(owner, a, right=6, wrong=0)
    set_duration(db_path, a["attempt_id"], 600)
    b = start(intruder, units=[1], length="full")
    sit(intruder, b, right=6, wrong=0)
    set_duration(db_path, b["attempt_id"], 120)

    rows = board(owner)
    assert [r["user_id"] for r in rows] == [INTRUDER, OWNER]
    assert [r["name"] for r in rows] == ["intruder", "owner"]
    assert all(r["score"] == 6 and r["total"] == 12 for r in rows)
    assert all(r["percent"] == 50 for r in rows)
    assert [r["duration_s"] for r in rows] == [120, 600]


def test_the_board_keeps_each_users_best_attempt_only(db_path):
    owner = client_as(db_path, OWNER)
    for right in (3, 9, 5):
        sit(owner, start(owner, units=[1], length="full"), right=right, wrong=0)
    rows = board(owner)
    assert len(rows) == 1
    assert rows[0]["score"] == 9


def test_different_selections_are_different_boards(db_path):
    owner = client_as(db_path, OWNER)
    sit(owner, start(owner, units=[1], length="full"), right=6, wrong=0)
    sit(owner, start(owner, units=[1, 2], length="full"), right=2, wrong=0)

    one = board(owner, units="1")
    both = board(owner, units="1,2")
    assert [r["total"] for r in one] == [12]
    assert [r["total"] for r in both] == [16]
    assert board(owner, units="2") == []
    assert board(owner, units="1", length="30") == []


def test_a_reversed_unit_list_is_the_same_board(db_path):
    owner = client_as(db_path, OWNER)
    sit(owner, start(owner, units=[2, 1], length="full"), right=4, wrong=0)
    assert len(board(owner, units="1,2")) == 1
    assert len(board(owner, units="2,1")) == 1


def test_an_open_attempt_is_not_on_the_board(db_path):
    owner = client_as(db_path, OWNER)
    attempt = start(owner, units=[1], length="full")
    owner.post(f"/api/mcq/attempts/{attempt['attempt_id']}/answer",
               json={"position": 1,
                     "chosen": correct_shown(attempt["questions"][0])})
    assert board(owner) == []


def test_the_submit_result_says_where_you_landed(db_path):
    owner, intruder = client_as(db_path, OWNER), client_as(db_path, INTRUDER)
    first = sit(owner, start(owner, units=[1], length="full"), right=9, wrong=0)
    assert first["rank"] == {"position": 1, "of": 1}
    second = sit(intruder, start(intruder, units=[1], length="full"),
                 right=4, wrong=1)
    assert second["rank"] == {"position": 2, "of": 2}
    assert sit(owner, start(owner, units=[1], length="full"),
               right=2, wrong=0)["rank"] == {"position": 1, "of": 2}, \
        "the board holds your best, so a worse sitting does not demote you"


@pytest.mark.parametrize("params", [
    {"subject_code": "NOPE", "units": "1", "length": "full"},
    {"subject_code": "CSE111", "units": "9", "length": "full"},
    {"subject_code": "CSE111", "units": "one", "length": "full"},
    {"subject_code": "CSE111", "units": "1", "length": "4"},
    {"subject_code": "CSE111", "units": "1", "length": "201"},
    {"subject_code": "CSE111", "units": "1", "length": "half"},
    {"subject_code": "CSE111", "units": "1", "length": "full",
     "difficulty": "brutal"},
])
def test_a_nonsense_board_request_is_422(client, params):
    r = client.get("/api/mcq/leaderboard", params=params)
    assert r.status_code == 422, r.text


def test_the_board_is_capped(db_path):
    conn = connect(db_path)
    for uid in range(3, 33):
        conn.execute("INSERT INTO users (id, name) VALUES (?,?)", (uid, f"u{uid}"))
        attempt = service.create_attempt(conn, uid, "CSE111", [1], "full",
                                         rng=random.Random(uid))
        service.answer_attempt(
            conn, uid, attempt["attempt_id"], 1,
            correct_shown(attempt["questions"][0]))
        service.submit_attempt(conn, uid, attempt["attempt_id"])
    rows = service.leaderboard(conn, "CSE111", [1], "full")
    conn.close()
    assert len(rows) == 25


# --- the router is really mounted -----------------------------------------

def test_every_contract_path_is_on_the_app():
    paths = create_app().openapi()["paths"]
    for path in ("/api/mcq/subjects", "/api/mcq/attempts",
                 "/api/mcq/attempts/{attempt_id}",
                 "/api/mcq/attempts/{attempt_id}/answer",
                 "/api/mcq/attempts/{attempt_id}/submit",
                 "/api/mcq/leaderboard"):
        assert path in paths, path


def test_the_shipped_bank_directory_is_readable():
    """It may be empty or absent — that is zero questions, not a boot failure."""
    assert isinstance(load_bank(bank.BANK_DIR), list)


# --- review pass: trying to break it ---------------------------------------

def bank_copy(tmp_path) -> Path:
    """A writable copy of the fixture bank, so a test can edit it mid-flight."""
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    for name in ("cse111_unit1.json", "cse111_unit2.json"):
        shutil.copy(FIXTURES / name, bank_dir)
    return bank_dir


def drop_key(bank_dir: Path, filename: str, key: str) -> None:
    path = bank_dir / filename
    data = json.loads(path.read_text())
    data["questions"] = [q for q in data["questions"] if q["key"] != key]
    path.write_text(json.dumps(data))


def test_a_question_retired_mid_attempt_is_still_answerable_and_gradable(tmp_path):
    """`active` gates the DRAW, not the replay: a sitting already holding a
    question must stay answerable and gradable after the JSON drops it."""
    bank_dir = bank_copy(tmp_path)
    path = str(tmp_path / "retire.db")
    make_db(path, bank_dir)
    client = client_as(path, OWNER)
    attempt = start(client, units=[1], length="full")
    aid = attempt["attempt_id"]
    doomed = attempt["questions"][0]
    key = BY_TEXT[doomed["question"]]["key"]

    drop_key(bank_dir, "cse111_unit1.json", key)
    conn = connect(path)
    counts = seed_mcq_bank(conn, bank_dir)
    conn.close()
    assert counts["retired"] == 1

    resumed = client.get(f"/api/mcq/attempts/{aid}").json()
    assert len(resumed["questions"]) == 12, "a retired question is not dropped"
    assert resumed["questions"][0]["question"] == doomed["question"]

    reveal = client.post(f"/api/mcq/attempts/{aid}/answer", json={
        "position": 1, "chosen": correct_shown(doomed)})
    assert reveal.status_code == 200, reveal.text
    assert reveal.json()["is_correct"] is True

    result = client.post(f"/api/mcq/attempts/{aid}/submit").json()
    assert result["total"] == 12 and result["score"] == 1
    assert sum(t["total"] for t in result["by_topic"]) == 12
    assert len(result["missed"]) == 11

    fresh = start(client, units=[1], length="full")
    assert fresh["total"] == 11, "only new draws exclude a retired question"
    assert doomed["question"] not in {q["question"] for q in fresh["questions"]}


def test_a_reversed_unit_list_at_creation_reaches_the_one_board(db_path):
    """[2,1] must be stored, ranked and looked up as [1,2] — one paper, one
    board, whichever way the picker happened to hand the units over."""
    owner = client_as(db_path, OWNER)
    result = sit(owner, start(owner, units=[2, 1], length="full"),
                 right=4, wrong=0)
    assert result["rank"] == {"position": 1, "of": 1}
    conn = connect(db_path)
    stored = conn.execute("SELECT units_json FROM mcq_attempts").fetchone()
    conn.close()
    assert stored["units_json"] == json.dumps([1, 2])
    for units in ("1,2", "2,1", "2,1,2"):
        assert len(board(owner, units=units)) == 1, units


def test_full_across_two_units_draws_every_active_question_once(client):
    attempt = start(client, units=[1, 2], length="full")
    assert attempt["length"] == "full"
    assert attempt["total"] == 16 and len(attempt["questions"]) == 16
    texts = [q["question"] for q in attempt["questions"]]
    assert len(set(texts)) == 16, "drawn without replacement"
    assert set(texts) == set(BY_TEXT)
    assert [q["position"] for q in attempt["questions"]] == list(range(1, 17))


def test_two_http_answers_to_the_first_question_settle_on_one(db_path):
    """The 409 has to hold through the route, not only in the service."""
    owner = client_as(db_path, OWNER)
    attempt = start(owner, units=[1], length="full")
    aid = attempt["attempt_id"]
    shown = correct_shown(attempt["questions"][0])

    barrier = threading.Barrier(2)
    codes: list[int] = []

    def answer():
        own = client_as(db_path, OWNER)
        barrier.wait()
        codes.append(own.post(f"/api/mcq/attempts/{aid}/answer",
                              json={"position": 1, "chosen": shown}).status_code)

    threads = [threading.Thread(target=answer) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(codes) == [200, 409]


def test_a_note_on_the_correct_option_is_refused_by_key(tmp_path):
    """The message has to name the key: the person fixing the file is looking
    at a thousand lines of JSON, not at a stack trace."""
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    (bank_dir / "bad.json").write_text(json.dumps({
        "subject_code": "CSE111", "unit": 1,
        "questions": [a_question(key="CSE111-U1-777",
                                 why_wrong=["it is not", "ls lists contents.",
                                            "cd changes directory.",
                                            "mkdir makes one."])],
    }))
    with pytest.raises(ValueError) as exc:
        load_bank(bank_dir)
    assert "CSE111-U1-777" in str(exc.value)
    assert "why_wrong[0]" in str(exc.value)


def test_an_absent_bank_directory_seeds_nothing_and_raises_nothing(tmp_path):
    path = str(tmp_path / "empty.db")
    conn = connect(path)
    init_db(conn)
    counts = seed_mcq_bank(conn, tmp_path / "not-here")
    conn.close()
    assert counts == {"files": 0, "questions": 0, "retired": 0, "active": 0,
                      "unreachable": 0}
    body = client_as(path, OWNER).get("/api/mcq/subjects").json()
    cse111 = next(s for s in body if s["subject_code"] == "CSE111")
    assert [u["count"] for u in cse111["units"]] == [0, 0]
    assert all(u["count"] == 0 for s in body for u in s["units"])


def test_every_contract_operation_is_on_the_app():
    """Eight operations, not six paths: DELETE and the two GETs on
    /api/mcq/attempts are separate rows in the contract's table."""
    paths = create_app().openapi()["paths"]
    wanted = {
        ("get", "/api/mcq/subjects"),
        ("post", "/api/mcq/attempts"),
        ("get", "/api/mcq/attempts"),
        ("get", "/api/mcq/attempts/{attempt_id}"),
        ("post", "/api/mcq/attempts/{attempt_id}/answer"),
        ("post", "/api/mcq/attempts/{attempt_id}/submit"),
        ("delete", "/api/mcq/attempts/{attempt_id}"),
        ("get", "/api/mcq/leaderboard"),
    }
    have = {(method, path) for path, ops in paths.items() for method in ops}
    assert wanted <= have, wanted - have


def test_the_lifespan_seeds_the_bank(tmp_path, monkeypatch):
    """A local dev database started by hand has to get the bank too — the
    entrypoint only covers the container."""
    from recall.api import app as app_module

    seen: list[str] = []
    real = app_module.seed_mcq_bank
    monkeypatch.setattr(app_module, "seed_mcq_bank",
                        lambda conn, *a, **k: seen.append("called") or real(conn))
    monkeypatch.setenv("RECALL_DB", str(tmp_path / "boot.db"))
    with TestClient(app_module.create_app()):
        pass
    assert seen == ["called"]


def test_the_container_entrypoint_seeds_the_bank():
    text = (Path(__file__).resolve().parents[1]
            / "ops" / "vps" / "entrypoint.sh").read_text()
    assert "from recall.mcq.seed import seed_mcq_bank" in text
    assert "seed_mcq_bank(conn)" in text


def test_an_empty_board_is_an_empty_list_not_a_404(client):
    r = client.get("/api/mcq/leaderboard", params={
        "subject_code": "CSE111", "units": "1,2", "length": "60"})
    assert r.status_code == 200 and r.json() == []


def test_no_attempt_or_answer_is_reached_without_its_owner(db_path):
    """Every service entry point, called with the wrong user_id, is a
    LookupError and leaves the rows alone."""
    conn = connect(db_path)
    attempt = service.create_attempt(conn, OWNER, "CSE111", [1], "full",
                                     rng=random.Random(5))
    aid = attempt["attempt_id"]
    service.answer_attempt(conn, OWNER, aid, 1,
                           correct_shown(attempt["questions"][0]))
    for call in (lambda: service.get_attempt(conn, INTRUDER, aid),
                 lambda: service.answer_attempt(conn, INTRUDER, aid, 2, 0),
                 lambda: service.submit_attempt(conn, INTRUDER, aid),
                 lambda: service.abandon_attempt(conn, INTRUDER, aid)):
        with pytest.raises(LookupError):
            call()
    assert conn.execute(
        "SELECT COUNT(*) AS n FROM mcq_answers WHERE attempt_id = ?",
        (aid,)).fetchone()["n"] == 1
    assert service.list_attempts(conn, INTRUDER) == []
    assert len(service.list_attempts(conn, OWNER)) == 1
    conn.close()


def test_submitting_survives_a_unit_leaving_the_registry(db_path, monkeypatch):
    """MCQ_UNITS is code and it changes as units get written and renamed. An
    attempt drawn before such an edit must still submit: ranking it re-checked
    the selection against the registry, so dropping one unit turned every open
    attempt covering it into a 500 with the sitting unrecoverable."""
    owner = client_as(db_path, OWNER)
    attempt = start(owner, units=[1, 2], length="full")
    aid = attempt["attempt_id"]
    owner.post(f"/api/mcq/attempts/{aid}/answer", json={
        "position": 1, "chosen": correct_shown(attempt["questions"][0])})

    units = registry.MCQ_UNITS["CSE111"]["units"]
    monkeypatch.setitem(registry.MCQ_UNITS["CSE111"], "units", {1: units[1]})

    r = owner.post(f"/api/mcq/attempts/{aid}/submit")
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["score"] == 1 and result["total"] == 16
    assert result["rank"] == {"position": 1, "of": 1}
    assert owner.get(f"/api/mcq/attempts/{aid}").status_code == 200
    assert [row["id"] for row in owner.get("/api/mcq/attempts").json()] == [aid]


def test_a_subject_leaving_the_registry_does_not_strand_its_attempts(db_path,
                                                                     monkeypatch):
    owner = client_as(db_path, OWNER)
    attempt = start(owner, units=[1], length=30)
    aid = attempt["attempt_id"]
    owner.post(f"/api/mcq/attempts/{aid}/answer", json={
        "position": 1, "chosen": correct_shown(attempt["questions"][0])})
    monkeypatch.delitem(registry.MCQ_UNITS, "CSE111")
    r = owner.post(f"/api/mcq/attempts/{aid}/submit")
    assert r.status_code == 200, r.text
    assert r.json()["rank"] == {"position": 1, "of": 1}


def test_a_board_a_user_asks_for_is_still_validated(client):
    """The split that fixed the above must not stop validating the front door."""
    r = client.get("/api/mcq/leaderboard", params={
        "subject_code": "CSE111", "units": "9", "length": "full"})
    assert r.status_code == 422


@pytest.mark.parametrize("options,reason", [
    (["pwd", "ls", "pwd", "mkdir"], "options 0 and 2"),
    (["pwd", "ls", "cd", " LS "], "options 1 and 3"),
])
def test_two_options_that_read_the_same_are_refused(options, reason):
    """`is_correct` compares positions, so a duplicate of the right answer
    marks a student wrong for reading the words that were right."""
    with pytest.raises(ValueError) as exc:
        validate_question(a_question(options=options))
    assert "X-1" in str(exc.value) and reason in str(exc.value)


def test_the_fixture_bank_has_no_duplicate_options():
    assert len(load_questions(FIXTURES)) == 16


def test_seeding_counts_questions_no_picker_can_reach(tmp_path):
    """A file named for a subject or unit the registry does not declare seeds
    fine and is then reachable by nobody. It must not take the boot down — the
    entrypoint runs under `set -e` — but it must not be silent either."""
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    # A subject the registry has never heard of. (This used to be CSE326,
    # until CSE326 joined the registry and became reachable.)
    (bank_dir / "xyz101_unit1.json").write_text(json.dumps({
        "subject_code": "XYZ101", "unit": 1,
        "questions": [a_question(key="XYZ101-U1-001")],
    }))
    (bank_dir / "cse111_unit9.json").write_text(json.dumps({
        "subject_code": "CSE111", "unit": 9,
        "questions": [a_question(key="CSE111-U9-001")],
    }))
    shutil.copy(FIXTURES / "cse111_unit1.json", bank_dir)

    path = str(tmp_path / "stray.db")
    conn = connect(path)
    init_db(conn)
    counts = seed_mcq_bank(conn, bank_dir)
    conn.close()
    assert counts["questions"] == 14 and counts["unreachable"] == 2

    body = client_as(path, OWNER).get("/api/mcq/subjects").json()
    assert "XYZ101" not in {s["subject_code"] for s in body}
    assert body[0]["subject_code"] == "CSE111"
    assert [(u["unit"], u["count"]) for u in body[0]["units"]] == [(1, 12), (2, 0)]


def test_a_wired_up_bank_reaches_everything_it_seeds(tmp_path):
    conn = connect(str(tmp_path / "ok.db"))
    init_db(conn)
    counts = seed_mcq_bank(conn, FIXTURES)
    conn.close()
    assert counts["unreachable"] == 0


# --- difficulty ------------------------------------------------------------

def tiers_of(attempt: dict) -> list[str]:
    return [q["difficulty"] for q in attempt["questions"]]


@pytest.mark.parametrize("tier", ["easy", "medium", "hard", "max"])
def test_a_tier_draws_only_that_tier(client, tier):
    attempt = start(client, units=[1], length="full", difficulty=tier)
    assert attempt["difficulty"] == tier
    assert attempt["total"] == TIERS[1][tier]
    assert set(tiers_of(attempt)) == {tier}


def test_mixed_draws_across_the_whole_ladder(client):
    """Mixed is the absence of a filter, not a fifth tier on the questions."""
    attempt = start(client, units=[1], length="full")
    assert attempt["difficulty"] is None
    assert attempt["total"] == 12
    from collections import Counter
    assert Counter(tiers_of(attempt)) == Counter(
        {t: n for t, n in TIERS[1].items() if n})


def test_a_tier_with_nothing_in_it_is_422_naming_the_tier(client):
    """Unit 2 has no max question. "unit 2 has no questions yet" would be a
    lie — it has four — so the message names the tier that is empty."""
    r = client.post("/api/mcq/attempts", json={
        "subject_code": "CSE111", "units": [2], "length": 30,
        "difficulty": "max"})
    assert r.status_code == 422, r.text
    assert "no max questions yet" in r.json()["detail"]


def test_a_tier_pools_across_the_units_asked_for(client):
    """Unit 2 alone has no max; units 1 and 2 together have unit 1's two."""
    attempt = start(client, units=[1, 2], length="full", difficulty="max")
    assert attempt["total"] == 2
    assert set(tiers_of(attempt)) == {"max"}


def test_an_unknown_tier_never_reaches_the_pool(client):
    r = client.post("/api/mcq/attempts", json={
        "subject_code": "CSE111", "units": [1], "length": 30,
        "difficulty": "impossible"})
    assert r.status_code == 422
    assert "difficulty must be one of easy, medium, hard, max" in \
        r.json()["detail"]


def test_a_null_difficulty_on_the_wire_is_mixed(client):
    r = client.post("/api/mcq/attempts", json={
        "subject_code": "CSE111", "units": [1], "length": 30,
        "difficulty": None})
    assert r.status_code == 200, r.text
    assert r.json()["difficulty"] is None


def test_the_attempt_stores_its_tier_and_history_shows_it(client):
    hard = start(client, units=[1], length=5, difficulty="hard")
    mixed = start(client, units=[1], length=5)
    rows = {r["id"]: r for r in client.get("/api/mcq/attempts").json()}
    assert rows[hard["attempt_id"]]["difficulty"] == "hard"
    assert rows[mixed["attempt_id"]]["difficulty"] is None
    assert rows[hard["attempt_id"]]["length"] == 5


def test_a_resumed_attempt_still_knows_its_tier(client):
    attempt = start(client, units=[1], length="full", difficulty="easy")
    resumed = client.get(f"/api/mcq/attempts/{attempt['attempt_id']}").json()
    assert resumed["difficulty"] == "easy"
    assert resumed["total"] == 4


# --- free-choice length ----------------------------------------------------

@pytest.mark.parametrize("length,drawn", [(5, 5), (7, 7), (12, 12), (200, 12),
                                          ("full", 12)])
def test_a_length_in_range_draws_min_of_what_was_asked_and_what_exists(
        client, length, drawn):
    attempt = start(client, units=[1], length=length)
    assert attempt["length"] == length
    assert attempt["total"] == drawn == len(attempt["questions"])


@pytest.mark.parametrize("length", [4, 0, -1, 201, 1000])
def test_a_length_outside_the_range_is_422_naming_the_range(client, length):
    r = client.post("/api/mcq/attempts", json={
        "subject_code": "CSE111", "units": [1], "length": length})
    assert r.status_code == 422, r.text
    assert "5-200" in r.json()["detail"], r.text


def test_a_length_above_what_the_tier_holds_shrinks_the_draw(client):
    """Asking for 200 max questions out of two is a two-question sitting, not
    an error: the student asked for as many as there are."""
    attempt = start(client, units=[1], length=200, difficulty="max")
    assert attempt["total"] == 2
    assert attempt["length"] == 200, "what was ASKED for is what is stored"


def test_a_length_that_is_not_a_whole_number_is_422(client):
    for length in ("half", 12.5, True):
        r = client.post("/api/mcq/attempts", json={
            "subject_code": "CSE111", "units": [1], "length": length})
        assert r.status_code == 422, (length, r.text)


def test_the_service_refuses_a_bool_length_outright(db_path):
    """`True` is an int in Python and min(True, n) is a one-question sitting."""
    conn = connect(db_path)
    with pytest.raises(ValueError, match="5-200"):
        service.create_attempt(conn, OWNER, "CSE111", [1], True)
    conn.close()


# --- one board per (subject, units, length, difficulty) --------------------

def test_two_tiers_at_the_same_length_are_two_boards(db_path):
    """26/30 on Easy and 26/30 on Max are not the same achievement."""
    owner = client_as(db_path, OWNER)
    sit(owner, start(owner, units=[1], length=5, difficulty="easy"),
        right=4, wrong=0)
    sit(owner, start(owner, units=[1], length=5, difficulty="hard"),
        right=1, wrong=0)

    easy = board(owner, units="1", length="5", difficulty="easy")
    hard = board(owner, units="1", length="5", difficulty="hard")
    assert [r["score"] for r in easy] == [4]
    assert [r["score"] for r in hard] == [1]
    assert board(owner, units="1", length="5", difficulty="medium") == []


def test_mixed_is_its_own_board_and_not_a_merge(db_path):
    """NULL = NULL is never true in SQLite, so the Mixed board has to be
    matched with IS — otherwise it is empty for ever and looks unsat."""
    owner = client_as(db_path, OWNER)
    sit(owner, start(owner, units=[1], length=5), right=3, wrong=0)
    sit(owner, start(owner, units=[1], length=5, difficulty="easy"),
        right=4, wrong=0)

    mixed = board(owner, units="1", length="5")
    assert [r["score"] for r in mixed] == [3], "mixed sees only mixed sittings"
    assert [r["score"] for r in board(owner, units="1", length="5",
                                      difficulty="easy")] == [4]


def test_the_rank_a_submit_reports_is_the_rank_of_its_own_board(db_path):
    owner, intruder = client_as(db_path, OWNER), client_as(db_path, INTRUDER)
    mine = sit(owner, start(owner, units=[1], length=5, difficulty="hard"),
               right=3, wrong=0)
    assert mine["rank"] == {"position": 1, "of": 1}
    # A better sitting on a DIFFERENT board does not touch that board.
    theirs = sit(intruder, start(intruder, units=[1], length=5,
                                 difficulty="easy"), right=4, wrong=0)
    assert theirs["rank"] == {"position": 1, "of": 1}
    assert len(board(owner, units="1", length="5", difficulty="hard")) == 1


def test_a_stored_attempt_still_ranks_after_the_ladder_changes(db_path,
                                                               monkeypatch):
    """The rule that saved attempts when a UNIT left the registry covers the
    ladder too: ranking a stored attempt reads its own stored selection and
    re-validates nothing."""
    owner = client_as(db_path, OWNER)
    attempt = start(owner, units=[1], length=5, difficulty="max")
    aid = attempt["attempt_id"]
    owner.post(f"/api/mcq/attempts/{aid}/answer", json={
        "position": 1, "chosen": correct_shown(attempt["questions"][0])})

    monkeypatch.setattr(registry, "DIFFICULTIES", ("easy", "medium", "hard"))
    monkeypatch.setattr(service, "DIFFICULTIES", ("easy", "medium", "hard"))

    r = owner.post(f"/api/mcq/attempts/{aid}/submit")
    assert r.status_code == 200, r.text
    assert r.json()["rank"] == {"position": 1, "of": 1}
    assert owner.get(f"/api/mcq/attempts/{aid}").status_code == 200


# --- migrating a live database ---------------------------------------------

_OLD_QUESTIONS_DDL = """CREATE TABLE mcq_questions (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, subject_code TEXT NOT NULL,
  unit INTEGER NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL,
  question TEXT NOT NULL, options_json TEXT NOT NULL, correct INTEGER NOT NULL,
  explain TEXT NOT NULL, why_wrong_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT)"""

_OLD_ATTEMPTS_DDL = """CREATE TABLE mcq_attempts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, subject_code TEXT NOT NULL,
  units_json TEXT NOT NULL, length TEXT NOT NULL,
  question_ids_json TEXT NOT NULL, option_orders_json TEXT NOT NULL,
  total INTEGER NOT NULL, started_at TEXT NOT NULL, submitted_at TEXT,
  duration_s INTEGER, score INTEGER)"""


def test_a_live_database_gains_the_columns_without_losing_a_row(tmp_path):
    """The live site has real attempts in it. schema.sql is CREATE IF NOT
    EXISTS and never alters a table that already exists, so the columns arrive
    through _migrate's ALTERs — and every existing row survives them."""
    path = str(tmp_path / "old.db")
    conn = connect(path)
    conn.execute(_OLD_QUESTIONS_DDL)
    conn.execute(_OLD_ATTEMPTS_DDL)
    conn.execute(
        "INSERT INTO mcq_questions (key, subject_code, unit, topic, kind,"
        " question, options_json, correct, explain, why_wrong_json)"
        " VALUES ('OLD-1','CSE111',1,'Linux','recall','q?',"
        " '[\"a\",\"b\",\"c\",\"d\"]',0,'because','[\"\",\"x\",\"y\",\"z\"]')")
    conn.execute(
        "INSERT INTO mcq_attempts (user_id, subject_code, units_json, length,"
        " question_ids_json, option_orders_json, total, started_at, score,"
        " submitted_at, duration_s)"
        " VALUES (1,'CSE111','[1]','30','[1]','[[0,1,2,3]]',1,"
        " '2026-09-01T00:00:00+00:00',1,'2026-09-01T00:05:00+00:00',300)")
    conn.commit()

    init_db(conn)                      # the migration under test

    qcols = {r["name"] for r in
             conn.execute("PRAGMA table_info(mcq_questions)")}
    acols = {r["name"] for r in
             conn.execute("PRAGMA table_info(mcq_attempts)")}
    assert "difficulty" in qcols and "difficulty" in acols
    indexes = {r["name"] for r in
               conn.execute("PRAGMA index_list(mcq_questions)")}
    assert "idx_mcq_questions_difficulty" in indexes

    question = conn.execute(
        "SELECT * FROM mcq_questions WHERE key = 'OLD-1'").fetchone()
    assert question["difficulty"] == "medium", "backfilled, not nulled"
    attempt = conn.execute("SELECT * FROM mcq_attempts").fetchone()
    assert attempt["difficulty"] is None, "an old sitting was Mixed"
    assert attempt["score"] == 1 and attempt["total"] == 1

    init_db(conn)                      # idempotent
    assert conn.execute(
        "SELECT COUNT(*) AS n FROM mcq_attempts").fetchone()["n"] == 1
    conn.close()


def test_an_old_attempt_still_submits_and_ranks_after_the_migration(tmp_path):
    """A sitting that was open when the ladder landed must finish normally,
    on the Mixed board, with no difficulty of its own."""
    path = str(tmp_path / "live.db")
    make_db(path)
    conn = connect(path)
    attempt = service.create_attempt(conn, OWNER, "CSE111", [1], 30,
                                     rng=random.Random(4))
    aid = attempt["attempt_id"]
    # Exactly what a pre-ladder row looks like: NULL difficulty.
    conn.execute("UPDATE mcq_attempts SET difficulty = NULL WHERE id = ?", (aid,))
    conn.commit()
    service.answer_attempt(conn, OWNER, aid, 1,
                           correct_shown(attempt["questions"][0]))
    result = service.submit_attempt(conn, OWNER, aid)
    assert result["rank"] == {"position": 1, "of": 1}
    assert service.list_attempts(conn, OWNER)[0]["difficulty"] is None
    assert service.leaderboard(conn, "CSE111", [1], 30) != []
    assert service.leaderboard(conn, "CSE111", [1], 30, "easy") == []
    conn.close()


def test_a_migrated_database_still_grades_the_answers_it_already_held(tmp_path):
    """The stronger form of the migration test: the pre-ladder rows here are
    not just an attempt but an attempt WITH RECORDED ANSWERS, and the assertion
    is not that the columns appeared — it is that the sitting still grades.

    A migration that kept the rows but made them ungradable would pass the
    column check and still have destroyed the live site's history.
    """
    path = str(tmp_path / "old.db")
    conn = connect(path)
    conn.execute(_OLD_QUESTIONS_DDL)
    conn.execute(_OLD_ATTEMPTS_DDL)
    conn.execute("""CREATE TABLE mcq_answers (
      id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL,
      position INTEGER NOT NULL, question_id INTEGER NOT NULL,
      chosen INTEGER NOT NULL, is_correct INTEGER NOT NULL,
      answered_at TEXT NOT NULL, UNIQUE(attempt_id, position))""")
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO users (id, name) VALUES (1, 'owner')")
    # Four real fixture questions, inserted the OLD way: no difficulty column.
    source = [q for q in load_questions(FIXTURES) if q["unit"] == 1][:4]
    for q in source:
        conn.execute(
            "INSERT INTO mcq_questions (key, subject_code, unit, topic, kind,"
            " question, options_json, correct, explain, why_wrong_json)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (q["key"], q["subject_code"], q["unit"], q["topic"], q["kind"],
             q["question"], json.dumps(q["options"]), q["correct"],
             q["explain"], json.dumps(q["why_wrong"])))
    ids = [r["id"] for r in conn.execute("SELECT id FROM mcq_questions ORDER BY id")]
    orders = [[0, 1, 2, 3]] * len(ids)   # identity, so `correct` is the shown index
    cur = conn.execute(
        "INSERT INTO mcq_attempts (user_id, subject_code, units_json, length,"
        " question_ids_json, option_orders_json, total, started_at)"
        " VALUES (1,'CSE111','[1]','30',?,?,?, '2026-09-01T00:00:00+00:00')",
        (json.dumps(ids), json.dumps(orders), len(ids)))
    aid = int(cur.lastrowid)
    # Two of the four answered before the migration: one right, one wrong.
    for position in (1, 2):
        q = source[position - 1]
        chosen = q["correct"] if position == 1 else (q["correct"] + 1) % 4
        conn.execute(
            "INSERT INTO mcq_answers (attempt_id, position, question_id,"
            " chosen, is_correct, answered_at) VALUES (?,?,?,?,?,?)",
            (aid, position, ids[position - 1], chosen,
             1 if position == 1 else 0, "2026-09-01T00:01:00+00:00"))
    conn.commit()

    init_db(conn)                       # the migration
    seed_mcq_bank(conn, FIXTURES)       # and the boot seed that follows it

    assert conn.execute(
        "SELECT COUNT(*) AS n FROM mcq_answers").fetchone()["n"] == 2

    # Reading it back: the recorded reveals survived, and re-seeding stamped
    # each question with the tier its JSON declares rather than leaving the
    # migration's 'medium' backfill behind.
    resumed = service.get_attempt(conn, 1, aid)
    assert resumed["difficulty"] is None, "a pre-ladder sitting was Mixed"
    assert [q["difficulty"] for q in resumed["questions"]] == \
        [q["difficulty"] for q in source]
    assert resumed["questions"][0]["answer"]["is_correct"] is True
    assert resumed["questions"][1]["answer"]["is_correct"] is False

    # And grading it: the two unanswered still count against the full draw.
    result = service.submit_attempt(conn, 1, aid)
    assert (result["score"], result["total"], result["answered"]) == (1, 4, 2)
    assert len(result["missed"]) == 3, "the unanswered are missed too"
    assert sum(t["total"] for t in result["by_difficulty"]) == result["total"]
    assert sum(t["correct"] for t in result["by_difficulty"]) == result["score"]
    assert [t["difficulty"] for t in result["by_difficulty"]] == \
        [d for d in registry.DIFFICULTIES
         if d in {q["difficulty"] for q in source}]
    # It lands on the Mixed board for its stored length, and on no tier board.
    assert len(service.leaderboard(conn, "CSE111", [1], 30)) == 1
    for tier in registry.DIFFICULTIES:
        assert service.leaderboard(conn, "CSE111", [1], 30, tier) == []
    conn.close()


def test_an_empty_difficulty_in_the_query_string_is_the_mixed_board(db_path):
    """`?...&length=5&difficulty=` must be the Mixed board, not a 422.

    A query string cannot express null, so an empty value there is how "no
    tier chosen" is spelt — the client's own qs() already drops `""` exactly as
    it drops `undefined`, and a hand-typed or bookmarked URL keeps the bare
    `difficulty=`. Answering that with "difficulty must be one of..." tells a
    student their Mixed board does not exist.
    """
    owner = client_as(db_path, OWNER)
    sit(owner, start(owner, units=[1], length=5), right=3, wrong=0)
    sit(owner, start(owner, units=[1], length=5, difficulty="easy"),
        right=4, wrong=0)

    r = owner.get("/api/mcq/leaderboard", params={
        "subject_code": "CSE111", "units": "1", "length": "5",
        "difficulty": ""})
    assert r.status_code == 200, r.text
    assert [row["score"] for row in r.json()] == [3], \
        "empty means Mixed, and Mixed does not swallow the easy sitting"
    assert r.json() == board(owner, units="1", length="5")


def test_an_empty_difficulty_in_a_json_body_is_still_422(client):
    """The query string has no way to say null; a JSON body does. So `""`
    there is a client bug and stays loud rather than being guessed at."""
    r = client.post("/api/mcq/attempts", json={
        "subject_code": "CSE111", "units": [1], "length": 5, "difficulty": ""})
    assert r.status_code == 422, r.text
    assert "difficulty must be one of" in r.json()["detail"]


# --- code questions: `code` and `options_mono` -----------------------------
#
# tests/fixtures/mcq/code holds INT108 unit 2 (four questions, two of them
# "What does this print?" with indented snippets — spaces and a blank line in
# one, tabs in the other) and CSE326 unit 1 (one HTML question). It is a
# subdirectory so the CSE111 bank above keeps its counts: load_bank does not
# recurse.

CODE_FIXTURES = FIXTURES / "code"

#: The code fixture keyed by (question text, snippet). Text alone is not a key
#: here — two questions both ask "What does this print?", as a real Python
#: bank will over and over — so nothing below may identify a question by it.
CODE_BY = {(q["question"], q["code"]): q for q in load_questions(CODE_FIXTURES)}

LEAKS = {"correct", "correct_index", "why_wrong", "explain"}


def source_of(question: dict) -> dict:
    """The fixture question behind a question on the wire."""
    return CODE_BY[(question["question"], question["code"] or "")]


def code_correct_shown(question: dict) -> int:
    source = source_of(question)
    return question["options"].index(source["options"][source["correct"]])


def keys_anywhere(value) -> set:
    """Every dict key at any depth — for asserting what a payload never holds."""
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in keys_anywhere(v)}
    if isinstance(value, list):
        return {k for v in value for k in keys_anywhere(v)}
    return set()


def combined_bank(tmp_path) -> Path:
    """The CSE111 fixture and the code fixture in one directory."""
    bank_dir = tmp_path / "combined"
    bank_dir.mkdir()
    for path in [*FIXTURES.glob("*.json"), *CODE_FIXTURES.glob("*.json")]:
        shutil.copy(path, bank_dir)
    return bank_dir


@pytest.fixture
def code_db(tmp_path):
    path = str(tmp_path / "code.db")
    make_db(path, combined_bank(tmp_path))
    return path


def start_code(client: TestClient, subject="INT108", units=(2,),
               length="full") -> dict:
    r = client.post("/api/mcq/attempts", json={
        "subject_code": subject, "units": list(units), "length": length})
    assert r.status_code == 200, r.text
    return r.json()


def test_the_code_fixture_loads_and_fills_the_defaults():
    by_key = {q["key"]: q for q in load_questions(CODE_FIXTURES)}
    assert len(by_key) == 5
    assert by_key["INT108-U2-002"]["code"].startswith("for i in range(3):\n\t")
    assert by_key["INT108-U2-003"]["code"] == ""            # absent -> ""
    assert by_key["INT108-U2-003"]["options_mono"] is True
    assert by_key["INT108-U2-004"]["code"] == ""
    assert by_key["INT108-U2-004"]["options_mono"] is False  # absent -> False
    # And the CSE111 bank, written before either field existed, still loads
    # with both defaulted rather than refused.
    assert all(q["code"] == "" and q["options_mono"] is False
               for q in load_questions(FIXTURES))


@pytest.mark.parametrize("overrides", [
    {"code": ""},
    {"code": "print(1)"},
    {"code": "  indented = True\n"},
    {"options_mono": True},
    {"options_mono": False},
    {"code": "x = 1\n", "options_mono": True},
])
def test_both_fields_are_accepted_when_well_formed(overrides):
    validate_question(a_question(**overrides))


@pytest.mark.parametrize("overrides,reason", [
    ({"code": 42}, "code must be a string"),
    ({"code": None}, "code must be a string"),
    ({"code": ["print(1)"]}, "code must be a string"),
    ({"code": True}, "code must be a string"),
    ({"code": "   "}, "code is only whitespace"),
    ({"code": "\n\t\n  \n"}, "code is only whitespace"),
    ({"options_mono": "true"}, "options_mono must be true or false"),
    ({"options_mono": 1}, "options_mono must be true or false"),
    ({"options_mono": 0}, "options_mono must be true or false"),
    ({"options_mono": None}, "options_mono must be true or false"),
])
def test_a_malformed_code_field_is_refused_by_key(overrides, reason):
    with pytest.raises(ValueError) as exc:
        validate_question(a_question(**overrides))
    message = str(exc.value)
    assert "X-1" in message, message
    assert reason in message, message


def test_the_existing_rules_still_hold_on_a_code_question():
    """The new fields loosen nothing: a code question with three options, or
    a note on its correct option, is refused exactly as before."""
    for overrides, reason in (
            ({"options": ["1", "2", "3"]}, "exactly 4 options"),
            ({"correct": 1}, "correct option"),
            ({"options": ["1", "2", "1", "3"]}, "options 0 and 2")):
        with pytest.raises(ValueError, match=reason):
            validate_question(a_question(code="print(1)\n", options_mono=True,
                                         **overrides))


def test_code_and_options_mono_round_trip_through_the_seed(tmp_path):
    bank_dir = combined_bank(tmp_path)
    path = str(tmp_path / "seed.db")
    make_db(path, bank_dir)
    conn = connect(path)
    rows = {r["key"]: r for r in conn.execute(
        "SELECT key, code, options_mono FROM mcq_questions")}
    for q in load_questions(CODE_FIXTURES):
        row = rows[q["key"]]
        assert row["code"] == (q["code"] or None), q["key"]
        assert row["options_mono"] == (1 if q["options_mono"] else 0), q["key"]
    # A CSE111 row: no snippet is NULL, never "", and prose options are 0.
    assert rows["CSE111-U2-001"]["code"] is None
    assert rows["CSE111-U2-001"]["options_mono"] == 0

    # Both are upserted on the key like every other field: editing them in
    # the JSON changes the row in place, and removing the snippet nulls it.
    before = conn.execute("SELECT id FROM mcq_questions WHERE key = ?",
                          ("INT108-U2-001",)).fetchone()["id"]
    target = bank_dir / "int108_unit2.json"
    data = json.loads(target.read_text())
    for q in data["questions"]:
        if q["key"] == "INT108-U2-001":
            del q["code"]
            q["options_mono"] = False
        if q["key"] == "INT108-U2-004":
            q["code"] = "if False:\n    print('never')\n"
    target.write_text(json.dumps(data))
    seed_mcq_bank(conn, bank_dir)
    after = {r["key"]: r for r in conn.execute(
        "SELECT id, key, code, options_mono FROM mcq_questions")}
    conn.close()
    assert after["INT108-U2-001"]["id"] == before
    assert after["INT108-U2-001"]["code"] is None
    assert after["INT108-U2-001"]["options_mono"] == 0
    assert after["INT108-U2-004"]["code"] == "if False:\n    print('never')\n"


def test_a_snippet_survives_byte_for_byte(tmp_path):
    """Leading spaces on the FIRST line, tabs, blank lines, a line of only
    spaces, trailing whitespace and the final newline: everything str.strip()
    or a whitespace-collapsing renderer would eat. In Python the indentation is
    the program, so any change here makes the question wrong."""
    snippet = ("  first = 1\n"
               "\tif first:\n"
               "\t\tprint(first)   \n"
               "\n"
               "    \n"
               "  \t mixed = [\n"
               "        1,  2,\n"
               "  ]\n"
               "\n")
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    (bank_dir / "int108_unit1.json").write_text(json.dumps({
        "subject_code": "INT108", "unit": 1,
        "questions": [a_question(key="INT108-U1-900", code=snippet,
                                 options_mono=True)],
    }))
    path = str(tmp_path / "bytes.db")
    make_db(path, bank_dir)

    conn = connect(path)
    stored = conn.execute("SELECT code FROM mcq_questions").fetchone()["code"]
    conn.close()
    assert stored.encode("utf-8") == snippet.encode("utf-8")

    client = client_as(path, OWNER)
    attempt = start_code(client, units=(1,))
    assert attempt["questions"][0]["code"].encode("utf-8") == \
        snippet.encode("utf-8")
    resumed = client.get(f"/api/mcq/attempts/{attempt['attempt_id']}").json()
    assert resumed["questions"][0]["code"] == snippet
    missed = client.post(
        f"/api/mcq/attempts/{attempt['attempt_id']}/submit").json()["missed"]
    assert missed[0]["code"] == snippet


def test_a_code_attempt_carries_both_fields_and_no_answer(code_db):
    """Both fields go out BEFORE the question is answered — neither reveals
    anything — and adding them must not have let the answer out with them."""
    client = client_as(code_db, OWNER)
    r = client.post("/api/mcq/attempts", json={
        "subject_code": "INT108", "units": [2], "length": "full"})
    assert r.status_code == 200, r.text
    assert "why_wrong" not in r.text
    assert "correct_index" not in r.text
    assert not keys_anywhere(r.json()) & LEAKS, keys_anywhere(r.json()) & LEAKS

    questions = r.json()["questions"]
    assert len(questions) == 4
    for question in questions:
        assert set(question) == {"position", "topic", "kind", "difficulty",
                                 "question", "code", "options_mono",
                                 "options", "answer"}
        assert question["answer"] is None
        source = source_of(question)
        assert question["code"] == (source["code"] or None)
        assert question["options_mono"] is source["options_mono"]
        assert sorted(question["options"]) == sorted(source["options"])
    by_code = {q["code"] for q in questions}
    assert None in by_code, "a question with no snippet sends null, not \"\""
    assert "" not in by_code


def test_a_prose_question_sends_null_code_and_false_mono(client):
    for question in start(client, units=[1, 2])["questions"]:
        assert question["code"] is None
        assert question["options_mono"] is False


def test_a_resumed_code_attempt_keeps_both_fields(code_db):
    client = client_as(code_db, OWNER)
    attempt = start_code(client)
    aid = attempt["attempt_id"]
    first = attempt["questions"][0]
    reveal = client.post(f"/api/mcq/attempts/{aid}/answer", json={
        "position": 1, "chosen": code_correct_shown(first)}).json()
    assert reveal["is_correct"] is True

    resumed = client.get(f"/api/mcq/attempts/{aid}").json()
    assert [(q["code"], q["options_mono"], q["options"])
            for q in resumed["questions"]] == \
        [(q["code"], q["options_mono"], q["options"])
         for q in attempt["questions"]]
    assert resumed["questions"][0]["answer"]["is_correct"] is True
    # The unanswered questions on a resumed attempt still hold no answer.
    assert not keys_anywhere(resumed["questions"][1:]) & LEAKS


def test_the_review_sheet_carries_both_fields(code_db):
    """McqMissed is where a student rereads the snippet they got wrong."""
    client = client_as(code_db, OWNER)
    attempt = start_code(client)
    aid = attempt["attempt_id"]
    first = attempt["questions"][0]
    wrong = next(i for i in range(4) if i != code_correct_shown(first))
    client.post(f"/api/mcq/attempts/{aid}/answer",
                json={"position": 1, "chosen": wrong})
    result = client.post(f"/api/mcq/attempts/{aid}/submit").json()
    assert result["score"] == 0 and len(result["missed"]) == 4
    shown = {q["position"]: q for q in attempt["questions"]}
    for missed in result["missed"]:
        question = shown[missed["position"]]
        assert missed["code"] == question["code"]
        assert missed["options_mono"] is question["options_mono"]
        assert missed["options"] == question["options"]
    assert result["missed"][0]["chosen"] == wrong


def test_an_html_question_keeps_its_markup(code_db):
    client = client_as(code_db, OWNER)
    question = start_code(client, subject="CSE326", units=(1,))["questions"][0]
    assert question["code"] == "<ul>\n  <li>One</li>\n  <li>Two</li>\n</ul>\n"
    assert question["options_mono"] is True
    assert "<ol>" in question["options"]


# --- migrating a database that has the ladder but not the code columns -----

#: mcq_questions exactly as the live database holds it today: the difficulty
#: ladder has landed, `code` and `options_mono` have not.
_LADDER_QUESTIONS_DDL = """CREATE TABLE mcq_questions (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, subject_code TEXT NOT NULL,
  unit INTEGER NOT NULL, topic TEXT NOT NULL, kind TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  question TEXT NOT NULL, options_json TEXT NOT NULL, correct INTEGER NOT NULL,
  explain TEXT NOT NULL, why_wrong_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT)"""


def test_a_database_without_the_code_columns_migrates_and_still_grades(
        tmp_path):
    """The live table holds the CSE111 bank and real attempts that point at
    its row ids. The two columns arrive by ALTER — never a rebuild — every row
    keeps its id, and a sitting with answers already recorded still resumes
    and grades."""
    path = str(tmp_path / "ladder.db")
    conn = connect(path)
    conn.execute(_LADDER_QUESTIONS_DDL)
    conn.execute("""CREATE TABLE mcq_attempts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
      subject_code TEXT NOT NULL, units_json TEXT NOT NULL,
      length TEXT NOT NULL, difficulty TEXT,
      question_ids_json TEXT NOT NULL, option_orders_json TEXT NOT NULL,
      total INTEGER NOT NULL, started_at TEXT NOT NULL, submitted_at TEXT,
      duration_s INTEGER, score INTEGER)""")
    conn.execute("""CREATE TABLE mcq_answers (
      id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL,
      position INTEGER NOT NULL, question_id INTEGER NOT NULL,
      chosen INTEGER NOT NULL, is_correct INTEGER NOT NULL,
      answered_at TEXT NOT NULL, UNIQUE(attempt_id, position))""")
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO users (id, name) VALUES (1, 'owner')")
    source = [q for q in load_questions(FIXTURES) if q["unit"] == 1][:4]
    for q in source:
        conn.execute(
            "INSERT INTO mcq_questions (key, subject_code, unit, topic, kind,"
            " difficulty, question, options_json, correct, explain,"
            " why_wrong_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (q["key"], q["subject_code"], q["unit"], q["topic"], q["kind"],
             q["difficulty"], q["question"], json.dumps(q["options"]),
             q["correct"], q["explain"], json.dumps(q["why_wrong"])))
    ids_before = {r["key"]: r["id"] for r in
                  conn.execute("SELECT id, key FROM mcq_questions")}
    ids = [ids_before[q["key"]] for q in source]
    cur = conn.execute(
        "INSERT INTO mcq_attempts (user_id, subject_code, units_json, length,"
        " difficulty, question_ids_json, option_orders_json, total,"
        " started_at) VALUES (1,'CSE111','[1]','30','easy',?,?,?,"
        " '2026-09-22T00:00:00+00:00')",
        (json.dumps(ids), json.dumps([[0, 1, 2, 3]] * 4), 4))
    aid = int(cur.lastrowid)
    for position in (1, 2):                  # one right, one wrong
        q = source[position - 1]
        chosen = q["correct"] if position == 1 else (q["correct"] + 1) % 4
        conn.execute(
            "INSERT INTO mcq_answers (attempt_id, position, question_id,"
            " chosen, is_correct, answered_at) VALUES (?,?,?,?,?,?)",
            (aid, position, ids[position - 1], chosen,
             1 if position == 1 else 0, "2026-09-22T00:01:00+00:00"))
    conn.commit()

    init_db(conn)                            # the migration under test
    init_db(conn)                            # and it is idempotent

    cols = {r["name"]: r for r in
            conn.execute("PRAGMA table_info(mcq_questions)")}
    assert "code" in cols and "options_mono" in cols
    assert cols["options_mono"]["notnull"] == 1
    rows = conn.execute("SELECT key, id, code, options_mono FROM mcq_questions"
                        ).fetchall()
    assert {r["key"]: r["id"] for r in rows} == ids_before, "no rebuild"
    assert all(r["code"] is None and r["options_mono"] == 0 for r in rows)

    # Resumes before any re-seed: the backfilled rows are well-formed.
    resumed = service.get_attempt(conn, 1, aid)
    assert [(q["code"], q["options_mono"]) for q in resumed["questions"]] == \
        [(None, False)] * 4
    assert resumed["questions"][0]["answer"]["is_correct"] is True
    assert resumed["questions"][1]["answer"]["is_correct"] is False

    # The boot seed that follows the migration, with the code bank alongside.
    seed_mcq_bank(conn, combined_bank(tmp_path))
    assert {r["key"]: r["id"] for r in conn.execute(
        "SELECT id, key FROM mcq_questions WHERE subject_code = 'CSE111'"
        " AND key IN (%s)" % ",".join("?" * 4), [q["key"] for q in source])} \
        == ids_before
    result = service.submit_attempt(conn, 1, aid)
    assert (result["score"], result["total"], result["answered"]) == (1, 4, 2)
    assert len(result["missed"]) == 3
    assert all(m["code"] is None and m["options_mono"] is False
               for m in result["missed"])

    # And a code question drawn on the migrated database arrives intact.
    fresh = service.create_attempt(conn, 1, "INT108", [2], "full",
                                   rng=random.Random(3))
    assert {q["code"] for q in fresh["questions"]} == \
        {q["code"] or None for q in load_questions(CODE_FIXTURES)
         if q["subject_code"] == "INT108"}
    conn.close()


# --- six subjects ----------------------------------------------------------

SIX = ("MTH165", "CSE111", "INT108", "INT335", "MEC103", "CSE326", "EVS", "PHY")


def test_the_registry_lists_all_six_subjects():
    from recall.lpu import SUBJECTS
    assert registry.MCQ_SUBJECTS == SIX
    # EVS and PHY are not on the Sem-1 timetable in lpu.py; the other six are.
    assert set(registry.MCQ_UNITS) == set(SIX)
    assert set(SIX) - {"EVS", "PHY"} == set(SUBJECTS)


def test_the_order_does_not_depend_on_dict_insertion(db_path, monkeypatch):
    """A registry key removed and put back lands at the END of the dict — which
    is exactly what monkeypatch.delitem does on teardown. The waiting subjects
    must still come out in the semester's order."""
    entry = registry.MCQ_UNITS["MTH165"]
    monkeypatch.delitem(registry.MCQ_UNITS, "MTH165")
    monkeypatch.setitem(registry.MCQ_UNITS, "MTH165", entry)
    assert list(registry.MCQ_UNITS)[-1] == "MTH165"
    assert subject_order(db_path) == ["CSE111", "MTH165", "INT108", "INT335",
                                      "MEC103", "CSE326", "EVS", "PHY"]


def test_cse111_keeps_its_own_ca1_units():
    """CSE111's bank follows the photographed CA1 syllabus, not lpu.py's seven
    units; deriving it would renumber every question in the live bank."""
    assert registry.MCQ_UNITS["CSE111"] == {
        "label": "Orientation to Computing",
        "units": {
            1: "Computational Thinking & Computing Environment",
            2: "Version Control & Cyber Security Basics",
        },
    }


@pytest.mark.parametrize("code", [c for c in SIX if c not in ("CSE111", "EVS", "PHY")])
def test_the_other_five_are_derived_from_lpu(code):
    from recall.lpu import SUBJECTS
    entry = registry.MCQ_UNITS[code]
    assert entry["label"] == SUBJECTS[code]["full_name"]
    assert entry["units"] == dict(enumerate(SUBJECTS[code]["units"], start=1))
    assert sorted(entry["units"]) == [1, 2, 3, 4, 5, 6]


def test_a_subject_with_no_bank_files_is_listed_with_every_count_zero(client):
    from recall.lpu import SUBJECTS
    body = {s["subject_code"]: s for s in
            client.get("/api/mcq/subjects").json()}
    assert set(body) == set(SIX)
    zero = {"easy": 0, "medium": 0, "hard": 0, "max": 0, "hardest": 0}
    assert [u["unit"] for u in body["EVS"]["units"]] == [1, 2, 3]
    assert [u["unit"] for u in body["PHY"]["units"]] == [1, 2, 3]
    for code in SIX:
        if code in ("CSE111", "EVS", "PHY"):
            continue
        subject = body[code]
        assert subject["label"] == SUBJECTS[code]["full_name"]
        assert [u["unit"] for u in subject["units"]] == [1, 2, 3, 4, 5, 6]
        assert [u["label"] for u in subject["units"]] == SUBJECTS[code]["units"]
        assert all(u["count"] == 0 and u["difficulties"] == zero
                   for u in subject["units"]), code
        # The sitting controls are the same for every subject.
        assert subject["lengths"] == [30, 60, "full"]
        assert subject["difficulties"] == ["easy", "medium", "hard", "max", "hardest"]


@pytest.mark.parametrize("body,needle", [
    ({"subject_code": "MTH165", "units": [1], "length": 30},
     "have no questions yet"),
    ({"subject_code": "MEC103", "units": [1, 2, 3, 4, 5, 6], "length": "full"},
     "have no questions yet"),
    ({"subject_code": "INT108", "units": [1], "length": 5,
      "difficulty": "easy"}, "have no easy questions yet"),
    ({"subject_code": "INT335", "units": [7], "length": 30},
     "INT335 has units 1, 2, 3, 4, 5, 6"),
])
def test_a_subject_with_no_questions_cannot_be_started(client, body, needle):
    r = client.post("/api/mcq/attempts", json=body)
    assert r.status_code == 422, r.text
    assert needle in r.json()["detail"], r.text


def subject_order(path: str) -> list[str]:
    return [s["subject_code"] for s in
            client_as(path, OWNER).get("/api/mcq/subjects").json()]


def test_subjects_with_questions_come_first(db_path):
    # CSE111 holds the only questions; the rest wait in registry order.
    assert subject_order(db_path) == ["CSE111", "MTH165", "INT108", "INT335",
                                      "MEC103", "CSE326", "EVS", "PHY"]


def test_subjects_are_ordered_by_how_many_questions_they_hold(tmp_path):
    only_code = str(tmp_path / "code_only.db")
    make_db(only_code, CODE_FIXTURES)
    # INT108 (4) then CSE326 (1) — CSE326 jumps MTH165, CSE111, INT335 and
    # MEC103, which all come before it in the registry but hold nothing.
    assert subject_order(only_code) == ["INT108", "CSE326", "MTH165",
                                        "CSE111", "INT335", "MEC103", "EVS", "PHY"]

    both = str(tmp_path / "both.db")
    make_db(both, combined_bank(tmp_path))
    assert subject_order(both) == ["CSE111", "INT108", "CSE326", "MTH165",
                                   "INT335", "MEC103", "EVS", "PHY"]


def test_a_tie_keeps_registry_order(tmp_path):
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    for code in ("CSE326", "MTH165"):
        (bank_dir / f"{code.lower()}_unit1.json").write_text(json.dumps({
            "subject_code": code, "unit": 1,
            "questions": [a_question(key=f"{code}-U1-001")]}))
    path = str(tmp_path / "tie.db")
    make_db(path, bank_dir)
    assert subject_order(path)[:2] == ["MTH165", "CSE326"]


def test_questions_nobody_can_sit_do_not_lift_a_subject(tmp_path):
    """Three questions under a unit CSE326 does not have are counted
    `unreachable` by the seed and cannot be drawn, so they must not put CSE326
    above a subject with one question somebody can actually sit — nor above
    the subjects still waiting."""
    bank_dir = tmp_path / "bank"
    bank_dir.mkdir()
    (bank_dir / "cse326_unit9.json").write_text(json.dumps({
        "subject_code": "CSE326", "unit": 9,
        "questions": [a_question(key=f"CSE326-U9-00{i}") for i in range(3)]}))
    (bank_dir / "mec103_unit1.json").write_text(json.dumps({
        "subject_code": "MEC103", "unit": 1,
        "questions": [a_question(key="MEC103-U1-001")]}))
    path = str(tmp_path / "stray.db")
    make_db(path, bank_dir)
    assert subject_order(path) == ["MEC103", "MTH165", "CSE111", "INT108",
                                   "INT335", "CSE326", "EVS", "PHY"]


def test_retired_questions_do_not_count_toward_the_order(tmp_path):
    bank_dir = tmp_path / "bank"
    shutil.copytree(CODE_FIXTURES, bank_dir)
    path = str(tmp_path / "retired.db")
    make_db(path, bank_dir)
    assert subject_order(path)[0] == "INT108"
    data = json.loads((bank_dir / "int108_unit2.json").read_text())
    (bank_dir / "int108_unit2.json").write_text(
        json.dumps({**data, "questions": []}))
    conn = connect(path)
    assert seed_mcq_bank(conn, bank_dir)["retired"] == 4
    conn.close()
    assert subject_order(path)[0] == "CSE326"


# --- duplicate options, read the way the screen shows them -----------------

def four_wrong_notes(correct: int = 0) -> list[str]:
    return ["" if i == correct else f"not option {i}" for i in range(4)]


@pytest.mark.parametrize("options", [
    ["True", "true", "TRUE", "1"],               # Python is case-sensitive
    ["a  b", "a b", "ab", "a\nb"],               # print(..., sep="  ")
    ["   5", "5", "0005", "5.0"],                # f"{5:4}" keeps its padding
    ["<P>", "<p>", "<br>", "<hr>"],
])
def test_monospace_options_that_differ_as_written_are_accepted(options):
    validate_question(a_question(options=options, options_mono=True,
                                 why_wrong=four_wrong_notes()))


@pytest.mark.parametrize("options,reason", [
    (["True", "true", "TRUE", "1"], "options 0 and 1"),
    (["a  b", "a b", "ab", "c"], "options 0 and 1"),
])
def test_prose_options_are_still_folded_on_case_and_space(options, reason):
    """The prose rule is unchanged: without options_mono these read as one."""
    with pytest.raises(ValueError, match=reason):
        validate_question(a_question(options=options,
                                     why_wrong=four_wrong_notes()))


@pytest.mark.parametrize("options,reason", [
    (["x", "x  ", "y", "z"], "options 0 and 1"),          # trailing: invisible
    (["x\n", "x", "y", "z"], "options 0 and 1"),
    (["a\tb", "a   b", "y", "z"], "options 0 and 1"),     # tab-size 4
    (["if x:\n    y", "if x:  \n    y\n", "y", "z"], "options 0 and 1"),
])
def test_monospace_options_the_screen_cannot_tell_apart_are_refused(
        options, reason):
    with pytest.raises(ValueError, match=reason):
        validate_question(a_question(options=options, options_mono=True,
                                     why_wrong=four_wrong_notes()))


# --- migrating the database exactly as HEAD's schema left it ---------------

#: schema.sql as it stood before `code` and `options_mono` existed — the
#: schema the live database was built by. Hand-typed DDL tests the recipe;
#: this tests the recipe against the real table, its indexes and every other
#: table init_db has to walk past on the way.
_SCHEMA_BEFORE_CODE = (Path(__file__).resolve().parent / "fixtures"
                       / "schema_before_code_columns.sql")

_PRE_CODE_INSERT = (
    "INSERT INTO mcq_questions (key, subject_code, unit, topic, kind,"
    " difficulty, question, options_json, correct, explain, why_wrong_json,"
    " active, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)")


def test_the_real_pre_code_schema_migrates_and_its_attempts_still_work(
        tmp_path):
    path = str(tmp_path / "live.db")
    conn = connect(path)
    conn.executescript(_SCHEMA_BEFORE_CODE.read_text())
    assert "code" not in {r["name"] for r in
                          conn.execute("PRAGMA table_info(mcq_questions)")}
    for uid, name in ((OWNER, "owner"), (INTRUDER, "rival")):
        conn.execute("INSERT INTO users (id, name) VALUES (?,?)", (uid, name))
        conn.execute("INSERT INTO settings (user_id) VALUES (?)", (uid,))
    # The bank as the old seed wrote it: no code, no options_mono.
    for q in load_questions(FIXTURES):
        conn.execute(_PRE_CODE_INSERT, (
            q["key"], q["subject_code"], q["unit"], q["topic"], q["kind"],
            q["difficulty"], q["question"], json.dumps(q["options"]),
            q["correct"], q["explain"], json.dumps(q["why_wrong"]),
            "2026-09-22T00:00:00+00:00"))
    before = [dict(r) for r in conn.execute(
        "SELECT * FROM mcq_questions ORDER BY id")]
    by_id = {r["id"]: r for r in before}
    ids = [r["id"] for r in before if r["unit"] == 1][:6]
    orders = [[3, 1, 0, 2], [0, 1, 2, 3], [2, 3, 1, 0],
              [1, 0, 3, 2], [0, 2, 1, 3], [3, 2, 1, 0]]

    def sitting(user_id, submitted):
        cur = conn.execute(
            "INSERT INTO mcq_attempts (user_id, subject_code, units_json,"
            " length, difficulty, question_ids_json, option_orders_json,"
            " total, started_at, submitted_at, duration_s, score)"
            " VALUES (?,'CSE111','[1]','30',NULL,?,?,6,"
            " '2026-09-22T00:00:00+00:00',?,?,?)",
            (user_id, json.dumps(ids), json.dumps(orders),
             "2026-09-22T00:09:00+00:00" if submitted else None,
             540 if submitted else None, 1 if submitted else None))
        return int(cur.lastrowid)

    def record(aid, position, chosen):
        order = orders[position - 1]
        right = order[chosen] == by_id[ids[position - 1]]["correct"]
        conn.execute(
            "INSERT INTO mcq_answers (attempt_id, position, question_id,"
            " chosen, is_correct, answered_at) VALUES (?,?,?,?,?,?)",
            (aid, position, ids[position - 1], chosen, 1 if right else 0,
             "2026-09-22T00:01:00+00:00"))
        return right

    rival = sitting(INTRUDER, submitted=True)
    record(rival, 1, orders[0].index(by_id[ids[0]]["correct"]))  # 1 of 6
    mine = sitting(OWNER, submitted=False)
    right_one = orders[0].index(by_id[ids[0]]["correct"])
    right_two = orders[1].index(by_id[ids[1]]["correct"])
    assert record(mine, 1, right_one) is True
    assert record(mine, 2, (right_two + 1) % 4) is False
    conn.commit()

    init_db(conn)                            # the migration under test
    init_db(conn)                            # idempotent

    cols = {r["name"]: r for r in
            conn.execute("PRAGMA table_info(mcq_questions)")}
    assert cols["options_mono"]["notnull"] == 1
    assert "code" in cols
    after = [dict(r) for r in conn.execute(
        "SELECT * FROM mcq_questions ORDER BY id")]
    assert [{k: r[k] for k in before[0]} for r in after] == before
    assert all(r["code"] is None and r["options_mono"] == 0 for r in after)
    assert conn.execute("SELECT COUNT(*) AS n FROM mcq_answers"
                        ).fetchone()["n"] == 3

    report = seed_mcq_bank(conn, combined_bank(tmp_path))  # the boot seed
    assert report["retired"] == 0
    assert {r["key"]: r["id"] for r in conn.execute(
        "SELECT id, key FROM mcq_questions WHERE subject_code = 'CSE111'")} \
        == {r["key"]: r["id"] for r in before}

    resumed = service.get_attempt(conn, OWNER, mine)
    assert [q["answer"]["is_correct"] if q["answer"] else None
            for q in resumed["questions"]] == [True, False, None, None, None,
                                               None]
    for q in resumed["questions"]:
        assert (q["code"], q["options_mono"]) == (None, False)
    assert not keys_anywhere(resumed["questions"][2:]) & LEAKS
    with pytest.raises(LookupError):
        service.get_attempt(conn, INTRUDER, mine)

    service.answer_attempt(conn, OWNER, mine, 3,
                           orders[2].index(by_id[ids[2]]["correct"]))
    result = service.submit_attempt(conn, OWNER, mine)
    assert (result["score"], result["total"], result["answered"]) == (2, 6, 3)
    assert result["rank"] == {"position": 1, "of": 2}
    board = service.leaderboard(conn, "CSE111", [1], 30)
    assert [(row["name"], row["score"]) for row in board] == \
        [("owner", 2), ("rival", 1)]
    conn.close()


# --- round 2: exam mode and "practise my mistakes" -------------------------
#
# Time is frozen, never slept on: `service.clock` is the module's one source
# of "now", and `frozen` swaps it for a clock the test moves by hand.

T0 = datetime(2026, 9, 23, 10, 0, 0, tzinfo=timezone.utc)


class FrozenClock:
    def __init__(self, at: datetime):
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def tick(self, seconds: float) -> None:
        self.at += timedelta(seconds=seconds)


@pytest.fixture
def frozen(monkeypatch) -> FrozenClock:
    clock = FrozenClock(T0)
    monkeypatch.setattr(service, "clock", clock)
    return clock


#: Keys that carry a verdict. None may appear in an exam before submit — as a
#: key anywhere in the JSON, checked on the raw response text.
VERDICT_KEYS = ("correct", "correct_index", "is_correct", "correct_so_far",
                "explain", "why_wrong")


def assert_sealed(text: str) -> None:
    """Nothing in this raw JSON says what is right. Checks the keys, and the
    teaching text itself, so a leak under a new name is caught too."""
    for key in VERDICT_KEYS:
        assert f'"{key}":' not in text, f"{key} leaked: {text[:300]}"
    for source in BY_TEXT.values():
        assert json.dumps(source["explain"]) not in text, "an explain leaked"
        for note in source["why_wrong"]:
            if note:
                assert json.dumps(note) not in text, "a why_wrong leaked"


def key_of(question: dict) -> str:
    return BY_TEXT[question["question"]]["key"]


def by_key(attempt: dict) -> dict:
    return {key_of(q): q for q in attempt["questions"]}


def answer_key(client: TestClient, attempt: dict, key: str, right: bool):
    question = by_key(attempt)[key]
    return client.post(
        f"/api/mcq/attempts/{attempt['attempt_id']}/answer",
        json={"position": question["position"],
              "chosen": correct_shown(question) if right
              else wrong_shown(question)})


def begin(client: TestClient, units=(1, 2), length="full", difficulty=None,
          mode=None, source=None):
    body = {"subject_code": "CSE111", "units": list(units), "length": length}
    for name, value in (("difficulty", difficulty), ("mode", mode),
                        ("source", source)):
        if value is not None:
            body[name] = value
    return client.post("/api/mcq/attempts", json=body)


def exam(client: TestClient, **kwargs) -> dict:
    r = begin(client, mode="exam", **kwargs)
    assert r.status_code == 200, r.text
    return r.json()


def practice(client: TestClient, **kwargs) -> dict:
    r = begin(client, **kwargs)
    assert r.status_code == 200, r.text
    return r.json()


def submit(client: TestClient, attempt: dict) -> dict:
    r = client.post(f"/api/mcq/attempts/{attempt['attempt_id']}/submit")
    assert r.status_code == 200, r.text
    return r.json()


def pending(client: TestClient) -> dict:
    r = client.get("/api/mcq/mistakes")
    assert r.status_code == 200, r.text
    return {row["subject_code"]: row for row in r.json()}


def pool_keys(client: TestClient, **kwargs) -> set | None:
    """The keys a mistakes sitting draws with length "full", or None on the
    422 an empty pool is."""
    r = begin(client, source="mistakes", **kwargs)
    if r.status_code == 422:
        assert "no mistakes to practise" in r.json()["detail"], r.text
        return None
    assert r.status_code == 200, r.text
    return {key_of(q) for q in r.json()["questions"]}


# exam mode --------------------------------------------------------------

def test_an_exam_carries_a_minute_per_question_drawn(client, frozen):
    attempt = exam(client, units=[1], length=30)       # 30 asked, 12 exist
    assert (attempt["mode"], attempt["source"]) == ("exam", "bank")
    assert attempt["total"] == 12
    assert attempt["time_limit_s"] == 12 * registry.EXAM_SECONDS_PER_QUESTION
    assert attempt["seconds_left"] == 720
    frozen.tick(100)
    again = client.get(f"/api/mcq/attempts/{attempt['attempt_id']}").json()
    assert again["seconds_left"] == 620
    assert_sealed(json.dumps(attempt))

    plain = practice(client, units=[1], length=5)
    assert (plain["mode"], plain["source"]) == ("practice", "bank")
    assert plain["time_limit_s"] is None and plain["seconds_left"] is None


def test_an_exam_answer_says_what_was_chosen_and_nothing_else(client, frozen):
    attempt = exam(client, units=[1])
    for right, key in ((False, "CSE111-U1-001"), (True, "CSE111-U1-002")):
        r = answer_key(client, attempt, key, right)
        assert r.status_code == 200, r.text
        assert_sealed(r.text)
        question = by_key(attempt)[key]
        assert set(r.json()) == {"position", "chosen", "answered"}
        assert r.json()["position"] == question["position"]


def test_an_open_exam_read_back_reveals_nothing(client, frozen):
    attempt = exam(client, units=[1, 2])
    aid = attempt["attempt_id"]
    answer_key(client, attempt, "CSE111-U1-001", right=False)
    answer_key(client, attempt, "CSE111-U1-005", right=True)
    answer_key(client, attempt, "CSE111-U2-002", right=False)

    r = client.get(f"/api/mcq/attempts/{aid}")
    assert r.status_code == 200
    assert_sealed(r.text)
    answers = {key_of(q): q["answer"] for q in r.json()["questions"]}
    wanted = by_key(attempt)["CSE111-U1-005"]
    assert answers["CSE111-U1-005"] == {
        "position": wanted["position"], "chosen": correct_shown(wanted),
        "answered": 3}
    assert sum(a is not None for a in answers.values()) == 3

    # The history list is not a side door either: no score while it is open.
    row = client.get("/api/mcq/attempts").json()[0]
    assert (row["mode"], row["score"], row["answered"]) == ("exam", None, 3)
    assert_sealed(json.dumps(row))

    # Nor is the time running out: an expired, unsubmitted paper is sealed.
    frozen.tick(60 * 60 * 5)
    r = client.get(f"/api/mcq/attempts/{aid}")
    assert_sealed(r.text)
    assert r.json()["seconds_left"] == 0


def test_an_exam_answer_can_change_and_the_last_one_is_graded(client, frozen):
    attempt = exam(client, units=[1])
    aid = attempt["attempt_id"]
    # Right then wrong, and wrong then right: only the last choice counts.
    for right in (True, False):
        assert answer_key(client, attempt, "CSE111-U1-001", right).status_code == 200
    for right in (False, False, True):
        r = answer_key(client, attempt, "CSE111-U1-002", right)
        assert r.status_code == 200 and r.json()["answered"] == 2

    result = submit(client, attempt)
    assert (result["score"], result["answered"]) == (1, 2)
    graded = client.get(f"/api/mcq/attempts/{aid}").json()
    answers = {key_of(q): q["answer"] for q in graded["questions"]}
    assert answers["CSE111-U1-001"]["is_correct"] is False
    assert answers["CSE111-U1-002"]["is_correct"] is True


def test_one_row_per_position_however_often_it_changes(db_path, frozen):
    conn = connect(db_path)
    attempt = service.create_attempt(conn, OWNER, "CSE111", [1], "full",
                                     mode="exam", rng=random.Random(2))
    aid = attempt["attempt_id"]
    for chosen in (0, 1, 2, 3, 1):
        out = service.answer_attempt(conn, OWNER, aid, 1, chosen)
        assert out == {"position": 1, "chosen": chosen, "answered": 1}
    rows = conn.execute("SELECT chosen FROM mcq_answers WHERE attempt_id = ?",
                        (aid,)).fetchall()
    assert [r["chosen"] for r in rows] == [1]
    conn.close()


def test_an_exam_submit_reveals_everything_at_once(client, frozen):
    attempt = exam(client, units=[1])
    aid = attempt["attempt_id"]
    answer_key(client, attempt, "CSE111-U1-001", right=True)
    answer_key(client, attempt, "CSE111-U1-002", right=False)
    frozen.tick(90)
    result = submit(client, attempt)
    assert (result["score"], result["total"], result["answered"]) == (1, 12, 2)
    assert result["duration_s"] == 90
    assert len(result["missed"]) == 11
    missed = {BY_TEXT[m["question"]]["key"]: m for m in result["missed"]}
    wrong = missed["CSE111-U1-002"]
    source = BY_TEXT[wrong["question"]]
    assert wrong["options"][wrong["correct_index"]] == \
        source["options"][source["correct"]]
    assert wrong["explain"] == source["explain"] and wrong["why_wrong"]
    assert result["rank"] == {"position": 1, "of": 1}

    graded = client.get(f"/api/mcq/attempts/{aid}").json()
    feedback = by_key(graded)["CSE111-U1-001"]["answer"]
    assert feedback["is_correct"] is True and "correct_index" in feedback
    assert graded["seconds_left"] is None


def test_answers_after_the_limit_and_grace_are_409_but_submit_works(
        client, frozen):
    attempt = exam(client, units=[1])                  # 12 questions, 12:00
    aid = attempt["attempt_id"]
    answer_key(client, attempt, "CSE111-U1-001", right=True)

    frozen.tick(720 + registry.EXAM_GRACE_S)           # the last legal second
    assert answer_key(client, attempt, "CSE111-U1-002", True).status_code == 200
    frozen.tick(1)
    r = answer_key(client, attempt, "CSE111-U1-005", right=True)
    assert r.status_code == 409 and "time is up" in r.json()["detail"]
    # Changing an answer already given is refused the same way.
    r = answer_key(client, attempt, "CSE111-U1-001", right=False)
    assert r.status_code == 409 and "time is up" in r.json()["detail"]

    frozen.tick(60 * 60 * 9)                           # the tab left overnight
    result = submit(client, attempt)
    assert (result["score"], result["answered"]) == (2, 2)
    assert result["duration_s"] == 720 + registry.EXAM_GRACE_S, \
        "the clock stopped when answering did"
    r = answer_key(client, attempt, "CSE111-U1-005", right=True)
    assert r.status_code == 409 and "submitted" in r.json()["detail"]


def test_a_practice_sitting_has_no_clock(client, frozen):
    attempt = practice(client, units=[1])
    frozen.tick(60 * 60 * 24)
    r = answer_key(client, attempt, "CSE111-U1-001", right=True)
    assert r.status_code == 200 and r.json()["is_correct"] is True
    assert answer_key(client, attempt, "CSE111-U1-001",
                      right=True).status_code == 409, "first click still final"


@pytest.mark.parametrize("field,value", [
    ("mode", "quiz"), ("mode", ""), ("mode", "Exam"),
    ("source", "wrong"), ("source", ""),
])
def test_an_unknown_mode_or_source_is_422_naming_the_choices(client, field,
                                                             value):
    r = begin(client, units=[1], **{field: value})
    assert r.status_code == 422, r.text
    assert f"{field} must be one of" in r.json()["detail"]


def test_history_carries_mode_source_and_clock(client, frozen):
    practice(client, units=[1], length=5)
    frozen.tick(1)
    exam(client, units=[1], length=5)
    rows = client.get("/api/mcq/attempts").json()
    assert [(r["mode"], r["source"], r["time_limit_s"]) for r in rows] == \
        [("exam", "bank", 300), ("practice", "bank", None)]


# boards -----------------------------------------------------------------

def test_practice_and_exam_are_separate_boards(db_path, frozen):
    owner, rival = client_as(db_path, OWNER), client_as(db_path, INTRUDER)
    mine = practice(owner, units=[1], length=5)
    for q in mine["questions"]:
        owner.post(f"/api/mcq/attempts/{mine['attempt_id']}/answer",
                   json={"position": q["position"], "chosen": correct_shown(q)})
    assert submit(owner, mine)["rank"] == {"position": 1, "of": 1}

    theirs = exam(rival, units=[1], length=5)
    first = theirs["questions"][0]
    rival.post(f"/api/mcq/attempts/{theirs['attempt_id']}/answer",
               json={"position": 1, "chosen": correct_shown(first)})
    assert submit(rival, theirs)["rank"] == {"position": 1, "of": 1}, \
        "ranked on the exam board, where it is alone"

    params = {"subject_code": "CSE111", "units": "1", "length": "5"}
    names = lambda r: [row["name"] for row in r.json()]  # noqa: E731
    assert names(owner.get("/api/mcq/leaderboard", params=params)) == ["owner"]
    assert names(owner.get("/api/mcq/leaderboard",
                           params={**params, "mode": ""})) == ["owner"]
    assert names(owner.get("/api/mcq/leaderboard",
                           params={**params, "mode": "exam"})) == ["intruder"]
    r = owner.get("/api/mcq/leaderboard", params={**params, "mode": "timed"})
    assert r.status_code == 422 and "mode must be one of" in r.json()["detail"]


def test_a_mistakes_sitting_is_on_no_board(client, frozen):
    miss = practice(client, units=[1])                  # 12, all wrong
    for q in miss["questions"]:
        client.post(f"/api/mcq/attempts/{miss['attempt_id']}/answer",
                    json={"position": q["position"], "chosen": wrong_shown(q)})
    submit(client, miss)
    frozen.tick(5)
    ordinary = practice(client, units=[1], length=5)    # the same selection
    first = ordinary["questions"][0]
    client.post(f"/api/mcq/attempts/{ordinary['attempt_id']}/answer",
                json={"position": 1, "chosen": wrong_shown(first)})
    assert submit(client, ordinary)["rank"] == {"position": 1, "of": 1}
    frozen.tick(5)
    for mode in ("practice", "exam"):
        r = begin(client, units=[1], length=5, source="mistakes", mode=mode)
        assert r.status_code == 200, r.text
        sitting = r.json()
        assert sitting["source"] == "mistakes"
        for q in sitting["questions"]:
            client.post(f"/api/mcq/attempts/{sitting['attempt_id']}/answer",
                        json={"position": q["position"],
                              "chosen": correct_shown(q)})
        result = submit(client, sitting)
        assert result["score"] == 5 and result["rank"] is None
        frozen.tick(5)
    for mode in ("practice", "exam"):
        rows = client.get("/api/mcq/leaderboard", params={
            "subject_code": "CSE111", "units": "1", "length": "5",
            "mode": mode}).json()
        assert [row["score"] for row in rows] == \
            ([0] if mode == "practice" else []), \
            "only the ordinary bank sitting is ranked, and only on its board"


# practise my mistakes ---------------------------------------------------

def test_a_wrong_answer_enters_the_pool_and_a_right_one_takes_it_out(
        client, frozen):
    assert pending(client) == {}
    assert pool_keys(client) is None, "nothing answered, nothing to practise"

    attempt = practice(client)                          # all 16, unanswered
    answer_key(client, attempt, "CSE111-U1-001", right=False)
    answer_key(client, attempt, "CSE111-U1-002", right=True)
    frozen.tick(1)
    assert pool_keys(client) == {"CSE111-U1-001"}, \
        "14 unanswered never enter; the right answer never did"
    assert pending(client)["CSE111"]["total"] == 1

    frozen.tick(60)
    retry = practice(client, units=[1], source="mistakes")
    assert [key_of(q) for q in retry["questions"]] == ["CSE111-U1-001"]
    assert answer_key(client, retry, "CSE111-U1-001", True).status_code == 200
    assert pool_keys(client) is None
    assert pending(client) == {}

    frozen.tick(60)                                     # and back in again
    again = practice(client, units=[1])
    answer_key(client, again, "CSE111-U1-001", right=False)
    assert pool_keys(client) == {"CSE111-U1-001"}


def test_an_unsubmitted_exam_answer_is_not_evidence_either_way(client, frozen):
    paper = exam(client)
    answer_key(client, paper, "CSE111-U1-003", right=False)
    assert pool_keys(client) is None, "an open exam has revealed nothing"
    assert pending(client) == {}

    # A practice mistake is not cleared by a right answer nobody was shown.
    frozen.tick(10)
    drill = practice(client, units=[1])
    answer_key(client, drill, "CSE111-U1-004", right=False)
    frozen.tick(10)
    answer_key(client, paper, "CSE111-U1-004", right=True)
    assert pool_keys(client) == {"CSE111-U1-004"}

    frozen.tick(10)
    submit(client, paper)                               # now both are revealed
    assert pool_keys(client) == {"CSE111-U1-003"}


def test_the_most_recently_revealed_answer_decides(client, frozen):
    """An exam answer is revealed at submit, not when it was clicked. Wrong in
    an exam at t1, right in practice at t2, the exam submitted at t3: the
    student last LEARNT they were wrong, so the question is pending."""
    paper = exam(client, units=[1])
    answer_key(client, paper, "CSE111-U1-006", right=False)
    frozen.tick(10)
    drill = practice(client, units=[1])
    answer_key(client, drill, "CSE111-U1-006", right=True)
    frozen.tick(10)
    submit(client, paper)
    assert pool_keys(client) == {"CSE111-U1-006"}


def test_the_pool_is_filtered_like_any_selection(client, frozen):
    attempt = practice(client)
    wrong = ("CSE111-U1-001", "CSE111-U1-009", "CSE111-U1-003",
             "CSE111-U1-004", "CSE111-U2-001", "CSE111-U2-004")
    for key in wrong:
        answer_key(client, attempt, key, right=False)
    answer_key(client, attempt, "CSE111-U1-010", right=True)
    frozen.tick(1)

    summary = pending(client)
    assert set(summary) == {"CSE111"}, "subjects with nothing are omitted"
    assert summary["CSE111"] == {
        "subject_code": "CSE111", "total": 6,
        "by_unit": {"1": 4, "2": 2},
        "by_difficulty": {"easy": 3, "medium": 0, "hard": 2, "max": 1, "hardest": 0}}

    assert pool_keys(client) == set(wrong)
    assert pool_keys(client, units=[2]) == {"CSE111-U2-001", "CSE111-U2-004"}
    assert pool_keys(client, units=[1], difficulty="easy") == \
        {"CSE111-U1-001", "CSE111-U1-009"}
    assert pool_keys(client, difficulty="hard") == \
        {"CSE111-U1-003", "CSE111-U2-004"}
    assert pool_keys(client, units=[1], difficulty="medium") is None
    assert pool_keys(client, units=[2], difficulty="max") is None

    # Still min(length, available), and still shuffled per attempt.
    r = begin(client, length=5, source="mistakes")
    assert r.status_code == 200 and r.json()["total"] == 5
    assert r.json()["length"] == 5

    r = client.post("/api/mcq/attempts", json={
        "subject_code": "INT108", "units": [1], "length": 30,
        "source": "mistakes"})
    assert r.status_code == 422
    assert "no mistakes to practise in that selection yet" in r.json()["detail"]


def test_the_pool_and_its_summary_are_yours_alone(db_path, frozen):
    owner, rival = client_as(db_path, OWNER), client_as(db_path, INTRUDER)
    attempt = practice(owner, units=[1])
    answer_key(owner, attempt, "CSE111-U1-007", right=False)
    answer_key(owner, attempt, "CSE111-U1-008", right=False)
    theirs = practice(rival, units=[1])
    answer_key(rival, theirs, "CSE111-U1-011", right=False)
    answer_key(rival, theirs, "CSE111-U1-007", right=True)
    frozen.tick(1)

    assert pending(owner)["CSE111"]["total"] == 2
    assert pending(rival)["CSE111"]["total"] == 1
    assert pool_keys(owner) == {"CSE111-U1-007", "CSE111-U1-008"}, \
        "the rival's right answer does not clear the owner's mistake"
    assert pool_keys(rival) == {"CSE111-U1-011"}

    conn = connect(db_path)
    conn.execute("INSERT INTO users (id, name) VALUES (3, 'newcomer')")
    conn.commit()
    conn.close()
    newcomer = client_as(db_path, 3)
    assert pending(newcomer) == {}
    assert pool_keys(newcomer) is None


def test_a_retired_question_leaves_the_pool(tmp_path, frozen):
    bank_dir = bank_copy(tmp_path)
    path = str(tmp_path / "retire.db")
    make_db(path, bank_dir)
    client = client_as(path, OWNER)
    attempt = practice(client, units=[1])
    answer_key(client, attempt, "CSE111-U1-001", right=False)
    answer_key(client, attempt, "CSE111-U1-002", right=False)
    drop_key(bank_dir, "cse111_unit1.json", "CSE111-U1-002")
    conn = connect(path)
    seed_mcq_bank(conn, bank_dir)
    conn.close()
    assert pool_keys(client) == {"CSE111-U1-001"}
    assert pending(client)["CSE111"]["total"] == 1


def test_the_mistakes_route_is_on_the_app():
    paths = create_app().openapi()["paths"]
    assert "get" in paths["/api/mcq/mistakes"]


# the live database --------------------------------------------------------

#: The schema exactly as it stood before exam mode and mistakes: difficulty
#: and code questions landed, mode/source/time_limit_s had not.
_SCHEMA_BEFORE_EXAM = (Path(__file__).resolve().parent / "fixtures"
                       / "schema_before_exam_mode.sql")


def test_the_pre_exam_schema_migrates_and_every_old_attempt_still_works(
        tmp_path, frozen):
    path = str(tmp_path / "live.db")
    conn = connect(path)
    conn.executescript(_SCHEMA_BEFORE_EXAM.read_text())
    assert "mode" not in {r["name"] for r in
                          conn.execute("PRAGMA table_info(mcq_attempts)")}
    for uid, name in ((OWNER, "owner"), (INTRUDER, "rival")):
        conn.execute("INSERT INTO users (id, name) VALUES (?,?)", (uid, name))
        conn.execute("INSERT INTO settings (user_id) VALUES (?)", (uid,))
    for q in load_questions(FIXTURES):
        conn.execute(_PRE_CODE_INSERT, (
            q["key"], q["subject_code"], q["unit"], q["topic"], q["kind"],
            q["difficulty"], q["question"], json.dumps(q["options"]),
            q["correct"], q["explain"], json.dumps(q["why_wrong"]),
            "2026-09-22T00:00:00+00:00"))
    by_id = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM mcq_questions")}
    ids = [i for i, r in sorted(by_id.items()) if r["unit"] == 1][:5]
    orders = [[3, 1, 0, 2], [0, 1, 2, 3], [2, 3, 1, 0], [1, 0, 3, 2],
              [0, 2, 1, 3]]

    def right(position):
        return orders[position - 1].index(by_id[ids[position - 1]]["correct"])

    def sitting(user_id, difficulty, submitted, score):
        cur = conn.execute(
            "INSERT INTO mcq_attempts (user_id, subject_code, units_json,"
            " length, difficulty, question_ids_json, option_orders_json,"
            " total, started_at, submitted_at, duration_s, score)"
            " VALUES (?,'CSE111','[1]','5',?,?,?,5,"
            " '2026-09-22T00:00:00+00:00',?,?,?)",
            (user_id, difficulty, json.dumps(ids), json.dumps(orders),
             "2026-09-22T00:04:00+00:00" if submitted else None,
             240 if submitted else None, score))
        return int(cur.lastrowid)

    def record(aid, position, chosen, at="2026-09-22T00:01:00+00:00"):
        is_right = chosen == right(position)
        conn.execute(
            "INSERT INTO mcq_answers (attempt_id, position, question_id,"
            " chosen, is_correct, answered_at) VALUES (?,?,?,?,?,?)",
            (aid, position, ids[position - 1], chosen, 1 if is_right else 0,
             at))

    rival = sitting(INTRUDER, None, submitted=True, score=1)
    record(rival, 1, right(1))
    tiered = sitting(INTRUDER, "easy", submitted=True, score=0)
    mine = sitting(OWNER, None, submitted=False, score=None)
    record(mine, 1, right(1))
    record(mine, 2, (right(2) + 1) % 4)
    conn.commit()
    attempts_before = [dict(r) for r in conn.execute(
        "SELECT * FROM mcq_attempts ORDER BY id")]

    init_db(conn)                                  # the migration under test
    init_db(conn)                                  # idempotent

    cols = {r["name"]: r for r in conn.execute("PRAGMA table_info(mcq_attempts)")}
    assert cols["mode"]["notnull"] == 1 and cols["source"]["notnull"] == 1
    assert cols["time_limit_s"]["notnull"] == 0
    after = [dict(r) for r in conn.execute("SELECT * FROM mcq_attempts ORDER BY id")]
    assert [{k: r[k] for k in attempts_before[0]} for r in after] == \
        attempts_before, "no rebuild: every row and id kept"
    assert {(r["mode"], r["source"], r["time_limit_s"]) for r in after} == \
        {("practice", "bank", None)}
    assert seed_mcq_bank(conn, FIXTURES)["retired"] == 0   # the boot seed

    # Readable: the open sitting resumes with its reveals, as practice.
    resumed = service.get_attempt(conn, OWNER, mine)
    assert (resumed["mode"], resumed["source"]) == ("practice", "bank")
    assert [q["answer"]["is_correct"] if q["answer"] else None
            for q in resumed["questions"]] == [True, False, None, None, None]
    assert resumed["questions"][1]["answer"]["correct_index"] == right(2)
    with pytest.raises(McqConflict):              # still the first click
        service.answer_attempt(conn, OWNER, mine, 2, right(2))

    # Its pre-migration wrong answer was revealed, so it is a mistake now.
    assert service.mistakes_summary(conn, OWNER)[0]["total"] == 1
    assert service.mistakes_summary(conn, INTRUDER) == []

    # Gradable and ranked on the practice board, never on the exam one.
    service.answer_attempt(conn, OWNER, mine, 3, right(3))
    result = service.submit_attempt(conn, OWNER, mine)
    assert (result["score"], result["total"], result["answered"]) == (2, 5, 3)
    assert result["rank"] == {"position": 1, "of": 2}
    board = service.leaderboard(conn, "CSE111", [1], 5)
    assert [(row["name"], row["score"]) for row in board] == \
        [("owner", 2), ("rival", 1)]
    assert service.leaderboard(conn, "CSE111", [1], 5, mode="exam") == []
    assert [row["score"] for row in service.leaderboard(
        conn, "CSE111", [1], 5, "easy")] == [0]
    # And an old submitted sitting re-submits to the result it already had.
    assert service.submit_attempt(conn, INTRUDER, rival)["score"] == 1
    assert service.submit_attempt(conn, INTRUDER, tiered)["rank"] is None
    history = service.list_attempts(conn, INTRUDER)
    assert {(h["mode"], h["source"], h["time_limit_s"]) for h in history} == \
        {("practice", "bank", None)}
    conn.close()
