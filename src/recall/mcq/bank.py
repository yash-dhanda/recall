"""Reading the curated bank off disk, and refusing a malformed question.

The bank is JSON in the repository — one file per subject-unit under
`src/recall/mcq/bank/` — because a question is prose someone wrote and edited,
and prose belongs in a reviewable diff rather than in a table only SQL can see.
`recall.mcq.seed` is what puts it into the database.

Every rule below is enforced HERE, in Python, and nowhere in the schema: the
tables carry no CHECK constraints for the same reason `lessons` does not (see
the note above it in schema.sql), and a constraint would in any case only fire
at seed time, on the server, with a message nobody writing questions would see.
A ValueError here names the question's key and what is wrong with it, which is
the one thing the person fixing the file needs.
"""

import json
from dataclasses import dataclass
from pathlib import Path

# The four tiers live in the registry, next to the units and the lengths, and
# are re-exported here because this is where they are ENFORCED. `difficulty` is
# required on every question and has no default: a bank where some questions
# carry a tier and some do not cannot be filtered honestly — "Easy, 30
# questions" would silently mean "easy, plus everything nobody labelled". The
# column's DEFAULT in schema.sql exists only so a live database migrates.
from recall.mcq.registry import DIFFICULTIES

#: Where a question lives on the shelf. `recall` is "do you know this";
#: `situation` is "here is a case, what applies".
KINDS = ("recall", "situation")

#: Exactly four options, always. Four is what the option grid, the shuffle and
#: the `why_wrong` array all assume, so a file with three is a bug and not a
#: shorter question.
N_OPTIONS = 4

#: The bank that ships with the package. May be absent or empty — that is zero
#: questions, not an error; the picker then shows every unit as waiting for
#: material.
BANK_DIR = Path(__file__).resolve().parent / "bank"

#: Keys a file may carry for its own bookkeeping — notes to whoever edits it
#: next. Anything starting with "_" is ignored rather than rejected.
_REQUIRED_FILE_KEYS = ("subject_code", "unit", "questions")


@dataclass(frozen=True)
class BankFile:
    """One subject-unit file, validated, with its questions normalised.

    `questions` are dicts in the shape the seeder writes: the file's `q` has
    become `question`, and each one carries the subject and unit of the file
    it came from, so the seeder never has to look back up at the file.
    """

    path: Path
    subject_code: str
    unit: int
    unit_label: str
    questions: list[dict]


def _fail(key: object, reason: str) -> ValueError:
    return ValueError(f"mcq question {key!r}: {reason}")


def _as_read(option: str, mono: bool) -> str:
    """An option as a reader tells it apart from its neighbours.

    Prose is folded on case and whitespace: "Git Hub" and "git  hub" read as
    one answer. Monospace options are code, output and values, shown exactly
    as written on a pre-wrap line, and folding them would refuse real
    questions: `True` and `true` are different Python, and `a  b` against
    `a b` is the whole point of a `sep=` question. So only what that line
    cannot show is folded there — trailing whitespace, and a tab against the
    spaces it renders as (tab-size 4, as the screen sets it).
    """
    if not mono:
        return " ".join(option.split()).casefold()
    lines = [line.expandtabs(4).rstrip() for line in option.splitlines()]
    return "\n".join(lines).rstrip("\n")


def validate_question(question: dict, *, where: str = "") -> None:
    """Raise ValueError naming the key and the reason, or return None.

    Order matters: `correct` is checked before it is used to index
    `why_wrong`, so a question with a correct index of 9 gets told about the
    index rather than about an array element that was never going to exist.
    """
    prefix = f"{where}: " if where else ""
    key = question.get("key")
    if not isinstance(key, str) or not key.strip():
        raise ValueError(f"{prefix}a question has no key")

    for field in ("q", "explain", "topic"):
        value = question.get(field)
        if not isinstance(value, str) or not value.strip():
            raise _fail(key, f"{field} must be a non-empty string")

    kind = question.get("kind")
    if kind not in KINDS:
        raise _fail(key, f"kind must be one of {', '.join(KINDS)}, got {kind!r}")

    difficulty = question.get("difficulty")
    if difficulty not in DIFFICULTIES:
        raise _fail(key, f"difficulty must be one of {', '.join(DIFFICULTIES)},"
                         f" got {difficulty!r}")

    options = question.get("options")
    if not isinstance(options, list) or len(options) != N_OPTIONS:
        n = len(options) if isinstance(options, list) else "none"
        raise _fail(key, f"needs exactly {N_OPTIONS} options, got {n}")
    for i, option in enumerate(options):
        if not isinstance(option, str) or not option.strip():
            raise _fail(key, f"option {i} is blank")
    # Two options that read the same make a question unanswerable, and the
    # failure is silent and cruel: `is_correct` compares POSITIONS, so a
    # student who picks the duplicate of the right answer is marked wrong
    # while looking at the words that were right. Compared the way a reader
    # compares them — see _as_read: prose folded on case and whitespace,
    # monospace options as written.
    mono = question.get("options_mono") is True
    seen_options: dict[str, int] = {}
    for i, option in enumerate(options):
        folded = _as_read(option, mono)
        if folded in seen_options:
            raise _fail(key, f"options {seen_options[folded]} and {i} are the "
                             f"same answer ({option!r})")
        seen_options[folded] = i

    # The `hardest` tier exists to take the length tell away: students had
    # learned to click the longest option. Equal length is checked on the text
    # as written, so a file cannot claim the tier without meeting it.
    if difficulty == "hardest" and len({len(option) for option in options}) != 1:
        raise _fail(key, "hardest needs all four options the same length, got "
                         f"{[len(option) for option in options]}")

    correct = question.get("correct")
    if not isinstance(correct, int) or isinstance(correct, bool) \
            or not 0 <= correct < N_OPTIONS:
        raise _fail(key, f"correct must be 0-{N_OPTIONS - 1}, got {correct!r}")

    why_wrong = question.get("why_wrong")
    if not isinstance(why_wrong, list) or len(why_wrong) != N_OPTIONS:
        n = len(why_wrong) if isinstance(why_wrong, list) else "none"
        raise _fail(key, f"needs exactly {N_OPTIONS} why_wrong entries, got {n}")
    for i, note in enumerate(why_wrong):
        if not isinstance(note, str):
            raise _fail(key, f"why_wrong[{i}] must be a string")
    # The correct option's note is the empty string, deliberately: the reveal
    # prints why_wrong[chosen] verbatim, so a note there would tell someone who
    # got it RIGHT why their answer was wrong.
    if why_wrong[correct] != "":
        raise _fail(key, f"why_wrong[{correct}] is the correct option, so it "
                         "must be \"\"")
    for i, note in enumerate(why_wrong):
        if i != correct and not note.strip():
            raise _fail(key, f"why_wrong[{i}] is blank; every wrong option "
                             "needs a reason")

    # `code` is optional: absent or "" is a question with no snippet. When it
    # is there it is kept EXACTLY as typed — never stripped, never re-indented
    # — because in Python the indentation is the program, and a snippet that
    # lost its leading spaces asks about code nobody wrote. A value that is
    # nothing but whitespace is refused rather than treated as "no snippet":
    # it is a paste that went wrong, and the question would otherwise render
    # an empty code block above text that says "what does this print".
    code = question.get("code", "")
    if not isinstance(code, str):
        raise _fail(key, f"code must be a string, got {code!r}")
    if code and not code.strip():
        raise _fail(key, "code is only whitespace; leave it out or \"\" when "
                         "the question has no snippet")

    # `options_mono` is optional and defaults to false. A real boolean only:
    # 1, "true" and null are what a hand-edited file produces by accident, and
    # a flag that decides whether "print(x)" keeps its spacing on screen must
    # not be guessed at from truthiness.
    options_mono = question.get("options_mono", False)
    if not isinstance(options_mono, bool):
        raise _fail(key, "options_mono must be true or false, got "
                         f"{options_mono!r}")


def _normalise(question: dict, subject_code: str, unit: int,
               unit_label: str) -> dict:
    """The question as the database stores it: `q` becomes `question`, and the
    two optional fields are filled in — `code` as "" and `options_mono` as
    False — so nothing downstream has to know they were optional."""
    return {
        "key": question["key"].strip(),
        "subject_code": subject_code,
        "unit": unit,
        "unit_label": unit_label,
        "topic": question["topic"].strip(),
        "kind": question["kind"],
        "difficulty": question["difficulty"],
        "question": question["q"].strip(),
        # Byte for byte, deliberately unstripped: see validate_question.
        "code": question.get("code", ""),
        "options_mono": question.get("options_mono", False),
        "options": list(question["options"]),
        "correct": int(question["correct"]),
        "explain": question["explain"].strip(),
        "why_wrong": list(question["why_wrong"]),
    }


def load_file(path: Path) -> BankFile:
    """One bank file, validated. Top-level keys starting with "_" are ignored."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name}: not valid JSON ({exc})") from exc
    if not isinstance(raw, dict):
        raise ValueError(f"{path.name}: top level must be an object")

    data = {k: v for k, v in raw.items() if not k.startswith("_")}
    missing = [k for k in _REQUIRED_FILE_KEYS if k not in data]
    if missing:
        raise ValueError(f"{path.name}: missing {', '.join(missing)}")

    subject_code = data["subject_code"]
    if not isinstance(subject_code, str) or not subject_code.strip():
        raise ValueError(f"{path.name}: subject_code must be a non-empty string")
    unit = data["unit"]
    if not isinstance(unit, int) or isinstance(unit, bool):
        raise ValueError(f"{path.name}: unit must be an integer")
    unit_label = data.get("unit_label") or ""
    if not isinstance(unit_label, str):
        raise ValueError(f"{path.name}: unit_label must be a string")

    questions = data["questions"]
    if not isinstance(questions, list):
        raise ValueError(f"{path.name}: questions must be a list")

    out = []
    for i, question in enumerate(questions):
        if not isinstance(question, dict):
            raise ValueError(f"{path.name}: question {i} is not an object")
        validate_question(question, where=f"{path.name} question {i}")
        out.append(_normalise(question, subject_code.strip(), unit,
                              unit_label.strip()))
    return BankFile(path=path, subject_code=subject_code.strip(), unit=unit,
                    unit_label=unit_label.strip(), questions=out)


def load_bank(bank_dir: Path | str | None = None) -> list[BankFile]:
    """Every *.json in the bank directory, sorted by filename.

    A missing or empty directory is zero files, not an error: the bank is
    written over time and the app has to boot before the first question
    exists.

    Keys are unique across the WHOLE bank, not per file: the key is what a
    question is upserted on and what an attempt stores, so two files sharing
    one would silently overwrite each other on every boot.
    """
    directory = Path(bank_dir) if bank_dir is not None else BANK_DIR
    if not directory.is_dir():
        return []

    files = [load_file(p) for p in sorted(directory.glob("*.json"))]
    seen: dict[str, str] = {}
    for bank_file in files:
        for question in bank_file.questions:
            key = question["key"]
            if key in seen:
                raise _fail(key, f"duplicate key, already used in {seen[key]}")
            seen[key] = bank_file.path.name
    return files


def load_questions(bank_dir: Path | str | None = None) -> list[dict]:
    """Every question in the bank, flattened. Convenience over `load_bank`."""
    return [q for f in load_bank(bank_dir) for q in f.questions]


__all__ = ["BANK_DIR", "DIFFICULTIES", "KINDS", "N_OPTIONS", "BankFile", "load_bank",
           "load_file", "load_questions", "validate_question"]
