"""The `hardest` tier: max-level questions whose four options are EXACTLY the
same length, so the longest answer is never the tell."""

import glob
import json
from pathlib import Path

import pytest

from recall.mcq.bank import validate_question

BANK = Path(__file__).resolve().parent.parent / "src" / "recall" / "mcq" / "bank"


def _q(options):
    return {"key": "T-1", "topic": "t", "kind": "recall", "difficulty": "hardest",
            "q": "Which?", "code": "", "options": options, "options_mono": False,
            "correct": 0, "explain": "e", "why_wrong": ["", "a", "b", "c"]}


def test_equal_length_options_are_accepted():
    validate_question(_q(["aaaa", "bbbb", "cccc", "dddd"]))


def test_unequal_length_options_are_refused():
    with pytest.raises(ValueError, match="same length"):
        validate_question(_q(["aaaa", "bbbbb", "cccc", "dddd"]))


def test_every_hardest_question_in_the_bank_has_equal_length_options():
    seen = 0
    for path in glob.glob(str(BANK / "*.json")):
        for q in json.load(open(path))["questions"]:
            if q["difficulty"] == "hardest":
                seen += 1
                assert len({len(o) for o in q["options"]}) == 1, q["key"]
    assert seen > 0
