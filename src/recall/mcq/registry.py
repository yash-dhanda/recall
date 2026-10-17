"""Which subjects and units the curated bank covers, and how long a sitting is.

Declared here rather than derived from what happens to be in the bank, so a
unit with nothing written yet still appears on the picker with a count of 0
and a "waiting for material" note. A unit that vanishes from a screen because
nobody has written its questions is indistinguishable, to the student, from a
unit that does not exist. The same holds one level up: a subject with no
questions at all is still listed, every unit at 0, so the picker shows the
student the whole semester and which parts of it are still being written.

The unit numbers are the ones printed on the lecture decks, 1-based.

**Five of the six subjects are derived from `recall.lpu`, not retyped.** That
registry is where the LPU syllabus lives — read off the Session 2026-27 PDFs
and corrected against them — and a second hand-typed copy of the same unit
names here would drift from it the first time either one was fixed. So for
every subject except CSE111 the label is `SUBJECTS[code]["full_name"]` and the
units are `SUBJECTS[code]["units"]` numbered 1..6, computed at import. Fix a
unit name in lpu.py and the picker follows.

**CSE111 is the exception, and it is written out on purpose.** Its MCQ bank
was written against the photographed CA1 syllabus, whose two units are not
lpu.py's seven: "Computational Thinking & Computing Environment" and "Version
Control & Cyber Security Basics" group the course the way the CA was set, and
the 544 questions already in the live bank carry those unit numbers. Deriving
CSE111 from lpu.py would renumber every one of them.
"""

from recall.lpu import SUBJECTS as _LPU_SUBJECTS

#: The subjects the bank covers, in the order recall.lpu lists the semester.
#: Named explicitly rather than taken as "everything in lpu.py": a course added
#: there is a decision about the timetable, not yet one about the bank, and a
#: code that disappears from lpu.py should fail this import loudly rather than
#: quietly drop a subject — and its attempts' labels — off the picker.
MCQ_SUBJECTS: tuple = ("MTH165", "CSE111", "INT108", "INT335", "MEC103",
                       "CSE326", "EVS", "PHY")

#: Subjects whose MCQ units do NOT follow lpu.py. See the module docstring.
_OWN_UNITS: dict[str, dict] = {
    "CSE111": {
        "label": "Orientation to Computing",
        "units": {
            1: "Computational Thinking & Computing Environment",
            2: "Version Control & Cyber Security Basics",
        },
    },
    # INT108 stops at unit 3: the mid-term practice sheet covers units 1-3
    # and the later units (functions, classes, files) are not being sat, so
    # the picker shows only the first three. lpu.py keeps all six.
    "INT108": {
        "label": "Python Programming",
        "units": {
            1: "Environment, Variables, Expressions and Statements",
            2: "Conditional and Iterative Statements",
            3: "Strings, Lists, Tuples and Dictionaries",
        },
    },
    # Not in recall.lpu (not on the Sem-1 timetable), so written out. Unit
    # names are the ones on the course slides.
    "EVS": {
        "label": "Environmental Studies",
        "units": {
            1: "Introduction and Natural Resources",
            2: "Natural Resources and Ecosystem",
            3: "Biodiversity and Conservation",
        },
    },
    # Course code and full title were not on the slides (only the outcomes and
    # the "Contents Before MTE" list), so the code is a placeholder.
    "PHY": {
        "label": "Physics",
        "units": {
            1: "Solid State Physics",
            2: "Fundamentals of Electricity and Devices",
            3: "Introduction to Number System and Logic Gates",
        },
    },
}


def _from_lpu(code: str) -> dict:
    """One subject's entry built from recall.lpu: its full name and its units
    numbered from 1, as the decks print them. A fresh dict every time, so a
    test that edits MCQ_UNITS can never reach back into lpu.SUBJECTS."""
    subject = _LPU_SUBJECTS[code]
    return {
        "label": subject["full_name"],
        "units": {number: name
                  for number, name in enumerate(subject["units"], start=1)},
    }


#: subject_code -> {"label": str, "units": {unit_number: unit_label}}
MCQ_UNITS: dict[str, dict] = {
    code: _OWN_UNITS[code] if code in _OWN_UNITS else _from_lpu(code)
    for code in MCQ_SUBJECTS
}

#: The ladder, hardest last. Order is load-bearing: `by_difficulty` on a result
#: is reported in this order, so a student reads their sitting as a climb
#: rather than as an alphabetical list ("easy, hard, max, medium" is nonsense).
#:
#:   easy   — one fact, stated directly in the material.
#:   medium — telling neighbours apart: which-is-NOT, ordering, the near miss.
#:   hard   — applying the idea to a short realistic scenario.
#:   max    — the hardest FAIR tier: a trap-adjacent scenario, two concepts
#:            joined, or a precise exception. Never a trick, never off-syllabus.
#:   hardest — max-level questions whose four options are EXACTLY the same
#:            length in characters, so the longest answer is never the tell.
#:            Enforced at load by bank.validate_question.
#:   important — the questions a mid-term keeps coming back to: the classic
#:            traps and must-know facts of a unit. Orthogonal to difficulty
#:            (an easy fact can be important), so it is its own tier and its
#:            own selection and board rather than a flag on the others.
DIFFICULTIES: tuple = ("easy", "medium", "hard", "max", "hardest", "important")

#: The lengths the picker offers as one-tap presets. Not the limit: a student
#: may ask for any whole number between LENGTH_MIN and LENGTH_MAX, or "full"
#: for every active question in the selection. Every number is capped at what
#: is available, so asking for 30 out of a bank of 12 is a 12-question attempt
#: and not an error.
LENGTHS: tuple = (30, 60, "full")

#: The free-choice range. Five is the floor because a sitting shorter than that
#: is a coin toss the leaderboard would rank as a result; 200 is the ceiling
#: because it is the size of the bank and a sitting nobody finishes teaches
#: nothing.
LENGTH_MIN = 5
LENGTH_MAX = 200

#: How a sitting is run. `practice` reveals each answer the moment it is
#: clicked, and the first click is final — it is how the bank teaches. `exam`
#: is the CA: timed, answers changeable until submit, and nothing about
#: correctness leaves the server before the paper is closed. First is the
#: default, and it is what every attempt drawn before exams existed was.
MODES: tuple = ("practice", "exam")

#: Where an attempt's questions come from. `bank` is the ordinary draw from the
#: selection; `mistakes` draws only questions this user's most recent revealed
#: answer got wrong. First is the default. A `mistakes` sitting is never ranked:
#: every student's pool is different, so a board of them compares nothing.
SOURCES: tuple = ("bank", "mistakes")

#: An exam's clock: one minute per question actually drawn, so a 30-question
#: paper is 30:00 and a 12-question one — asked for 30 out of a unit of 12 —
#: is 12:00, not a paper with eighteen minutes of nothing in it.
EXAM_SECONDS_PER_QUESTION = 60

#: How long after the limit an answer is still accepted. Covers the request
#: that left the phone at 29:59 and reached the server at 30:02, not a paused
#: tab: past this, answering is refused and only submitting remains.
EXAM_GRACE_S = 30


__all__ = ["MCQ_SUBJECTS", "MCQ_UNITS", "LENGTHS", "LENGTH_MIN", "LENGTH_MAX",
           "DIFFICULTIES", "MODES", "SOURCES", "EXAM_SECONDS_PER_QUESTION",
           "EXAM_GRACE_S"]
