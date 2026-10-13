# Recall — internal contract

Frozen interface between the pipeline, the scheduler, the API and the web client.
Agents build against this. Do not change a signature here without updating every consumer.

## Core dataclasses (already implemented)

```python
# recall.ingest.chunk
@dataclass(frozen=True)
class Chunk:
    ordinal: int
    text: str
    page_ref: str          # "p4" or "p4-p6"

# recall.generate.generate
@dataclass(frozen=True)
class Candidate:
    kind: str              # "qa" | "cloze"
    question: str
    answer: str
    cloze_text: str | None # contains {{c1::...}} when kind == "cloze"

# recall.llm.client
@dataclass(frozen=True)
class LlmResponse:
    content: str
    prompt_tokens: int
    completion_tokens: int
```

`recall.db.connect(db_path) -> sqlite3.Connection` (row_factory=Row, foreign_keys ON)
`recall.db.init_db(conn) -> None`
`recall.config.load_config(env=None) -> Config`

Schema lives in `src/recall/schema.sql`. Read it before writing queries.

## Scheduler — `recall.schedule.fsrs`

```python
DEFAULT_PARAMS: tuple[float, ...]        # FSRS-4.5, 17 weights

@dataclass(frozen=True)
class MemoryState:
    stability: float                     # days until p(recall) == 0.9
    difficulty: float                    # 1.0 .. 10.0

def retrievability(elapsed_days: float, stability: float) -> float
def initial_state(grade: int, params=DEFAULT_PARAMS) -> MemoryState
def next_state(state: MemoryState, grade: int, elapsed_days: float,
               params=DEFAULT_PARAMS) -> MemoryState
def interval_days(stability: float, desired_retention: float) -> float
```

Grades: 1=again, 2=hard, 3=good, 4=easy.

## Authentication

Open registration — no invite code, no email verification. A session is an
HttpOnly, Secure, SameSite=Lax cookie (`recall_session`) holding an opaque
token valid for 10 days; the server stores only its SHA-256 hash
(`sessions` table). The expiry is fixed rather than sliding — refreshing it
per request would turn every read in the app into a database write. Every
route below `## HTTP API` requires this cookie and resolves it to a
`user_id` via `Depends(get_current_user)` — a request with no cookie, or an
expired/unknown one, gets `401 {"detail": "..."}`.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/auth/register` | `{name, email, password}` (password ≥ 8 chars) | `{id, name, email}` + sets the session cookie. Also seeds the full LPU topic catalog and default settings for the new account — a signup is immediately usable. `422` on a taken name/email. |
| POST | `/api/auth/login` | `{email, password}` | `{id, name, email}` + sets the session cookie. `401` for either an unknown email or a wrong password — deliberately the same error, to avoid an account-enumeration oracle. |
| POST | `/api/auth/logout` | — | `{ok: true}`, clears the cookie and deletes the session row. |
| GET | `/api/auth/me` | — | `{id, name, email}` for the current session, or `401`. |

## HTTP API — FastAPI, mounted at `/api`

Every table and query is scoped by `user_id`, resolved per-request from the
session cookie above — this is a real multi-user app, not a single-owner one
with a placeholder constant.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/topics` | — | `[{id, code, label, due, new, active, pending}]` |
| GET | `/api/queue` | `?topic=&limit=` | `{cards: [QueueCard], due_remaining, new_remaining, cap_reached}` |
| POST | `/api/review` | `{card_id, grade}` | `{card_id, interval_days, due_at, stability, difficulty}` |
| GET | `/api/pending` | `?limit=&offset=&topic=` | `{cards: [PendingCard], total}` |
| POST | `/api/pending/decide` | `{ids: [int], action: "approve"\|"reject"}` | `{updated}` |
| POST | `/api/cards/{id}/suspend` | — | `{ok, card_id, state}` — drops a card out of the queue and every paper without deleting it, so reviews already recorded against it still count toward the scheduler fit. `404` when the card is not yours. |
| GET | `/api/settings` | — | `{new_cards_per_day, daily_review_cap, desired_retention}` |
| PUT | `/api/settings` | any subset | full settings |
| GET | `/api/stats` | — | `{today: {reviewed, again, streak}, by_topic: [...], last_14_days: [{date, count}], totals: {active, pending, sources}}` |
| GET | `/api/study-plan` | — | `[{topic_code, due, new, active, units_cover, weakest_unit, units: [{number, name, active, due, mastery}], action: {kind, unit}, advice}]` |
| GET | `/api/sources` | — | `[{id, filename, topic_code, added_at, accepted, rejected, cost_estimate}]` |

```
QueueCard   = {id, kind, question, answer, cloze_text, topic_code, page_ref, is_new,
               stability, difficulty, elapsed_days, origin}
              stability/difficulty are null for new cards. They travel with the card so
              the client can price each grade button exactly rather than estimating.
PendingCard = {id, kind, question, answer, cloze_text, topic_code, page_ref,
               source_filename, origin}
origin      = "upload" | "knowledge"
              "upload"    — grounded: a verbatim quote from an uploaded file was
                            checked, in Python, before the card was kept.
              "knowledge" — written from the model's own knowledge of a syllabus
                            unit. No source exists to check it against, so the
                            grounding and closed-book gates did not run.
              The client MUST show the difference. The violet "AI" mark cannot
              carry it: every card in the app is model-authored, so that mark is
              true of both. A second, uncoloured "no source" mark carries it.
```

Queue ordering: due cards first (oldest due first), then new cards up to
`new_cards_per_day` minus new cards already introduced today. Total capped by
`daily_review_cap`. `cap_reached` is true when the cap truncated the queue.

All errors: `{"detail": "..."}` with a real HTTP status. Never 200 with an error body.

## Web client — Next.js, `web/`

Talks only to the paths above via `NEXT_PUBLIC_API_BASE` (default `http://localhost:8000`).

### Design brief — read this twice

The failure mode to avoid is a page that looks generated. Concretely, **do not** use:
purple/indigo/violet gradients, glassmorphism, blurred coloured blobs, a centred hero
with a gradient headline, emoji in headings or buttons, `rounded-2xl` everywhere, soft
drop shadows on every surface, "✨" anything, or stock shadcn defaults left untouched.

Build instead:

- **Reference points:** Anki's density, Linear's restraint, a good terminal's calm. This
  is a tool someone opens every morning for four years, not a landing page.
- **Palette:** near-monochrome. A paper-white / near-black base with one accent used
  sparingly for the primary action and nothing else. Grade buttons are the exception and
  earn colour because they carry meaning. Dark mode is a real design, not an inversion.
- **Type:** one family, real hierarchy through weight and size, not colour. Card text is
  large and comfortable — it is the thing being read. UI chrome is small and quiet.
- **Density:** the dashboard is dense and factual. Numbers first, no giant stat cards
  with icons. A person should see today's load in one glance without scrolling.
- **Radius and shadow:** small radii (2–6px), borders instead of shadows. Flat surfaces.
- **Motion:** almost none. A card flip and a queue advance, both under 150ms. No
  page-load animations, no staggered fade-ins.
- **The review screen is the product.** It should be nearly empty: the question, plenty
  of space, the answer on reveal, four grade buttons, a thin progress indicator. No nav,
  no sidebar, no breadcrumbs. Everything that is not the card is a distraction.
- **Keyboard first.** Space reveals, 1–4 grade, Esc exits, `?` shows shortcuts. The
  mouse must work, but the keyboard is the intended path and shortcuts are visible on
  the buttons themselves.
- **Every card shows its source** (topic code + page ref) in small quiet text. Provenance
  is a feature.
- Empty states say what to do next, in a plain sentence, with no illustration.

Screens: `/` dashboard, `/review` focus mode, `/approve` bulk triage of pending cards,
`/settings`, `/sources`.

### What to study next

`GET /api/study-plan` answers the question the dashboard could not: not "how many
are due" but "what do I do". One entry per subject, and one `action` — a ladder,
not a score, because a recommendation offering three options is the report it
was meant to replace.

The rungs, first match wins: nothing in the deck → write some; anything due →
review it; anything never seen → meet it; a unit with no cards → write for it;
the weakest unit → sit a unit paper on it, or write more first if it is too thin
to examine. The order of the first three is load-bearing: putting empty units
above `new` told you to generate on a subject built from PDFs — where no card
belongs to a unit, so every unit reads as empty — while unmet cards sat in the
deck.

`mastery` is `1 - mean(assembly.weakness)`, computed by calling that function
rather than by a second copy of its formula. A never-reviewed unit sits at 0.5,
so a fresh deck does not read as weak merely for being new.

**`units_cover`** is how many of a subject's `active` cards the per-unit view can
account for. Only knowledge-mode cards carry a unit; an uploaded PDF is chunked
by page and a page maps to no unit. When it is 0 the endpoint declines to speak
about units at all, and the client says so — "unit 4 is your weakest" drawn from
three of forty cards is a guess wearing a fact's clothing.

Never a paid call. The web client prefetches on route intent, so a GET that
spent money would spend it on a hover.

---

## Test mode

Sit a paper of a fixed mark total, then feed the results back into the scheduler.
This is the "test me and adjust the difficulty" loop: what you get wrong comes back sooner.

### Marks per card (computed at assembly, not stored on the card)

| Card | Marks |
|---|---|
| cloze | 1 |
| qa, answer <= 4 words | 1 |
| qa, answer <= 12 words | 2 |
| qa, longer | 5 |

### Papers

| kind | target | time limit | notes |
|---|---|---|---|
| `class30` | 30 marks | 45 min | a sessional / MST |
| `endterm100` | 100 marks | 180 min | a full end-term paper |
| `fullday` | every active card | none | marathon, resumable across sittings |

Assembly is stratified across topics in proportion to each topic's active cards, and
within a topic prefers weak cards (high difficulty, low stability, due or overdue) while
still including some strong ones so a paper is not purely punishment. Greedy fill to hit
the target exactly; if the deck cannot reach the target, the paper is short and says so.

**A paper is not yesterday's paper.** Ranking is by `assembly.priority`, which is
`weakness` minus a penalty for having been asked recently. The penalty is waived
entirely for a question you got **wrong** or **skipped** — those are the ones worth
asking again — halved for a partial, and applied in full to one you answered correctly
or one still sitting on a paper you have not submitted. It decays to nothing over ten
days.

It is a penalty and never an exclusion: on a deck with room, four papers in a row repeat
nothing; on a deck with nothing else to offer, the question comes back rather than the
paper coming up short. The strong-end sample is drawn by `weakness` alone, with recently
asked cards sorted last — drawing it from the tail of the priority order would make the
"not purely punishment" rule the very thing that handed yesterday's questions back.

### Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/tests` | `{kind, topic_code?, units?}` | `{test_id, kind, topic_code, units, total_marks, time_limit_s, questions: [TestQuestion]}` |
| GET | `/api/tests/{id}` | — | same shape, plus recorded verdicts, for resuming |
| POST | `/api/tests/{id}/answer` | `{ordinal, verdict, seconds}` | `{ok: true}` |
| POST | `/api/tests/{id}/submit` | — | `TestResult` |
| DELETE | `/api/tests/{id}` | — | `{ok: true}`. Closes an unfinished paper. **409** if it has already been submitted — that is a graded result, not clutter — and **404** for a paper that is not yours, which reads identically to one that does not exist. |
| GET | `/api/tests` | — | `[{id, kind, started_at, submitted_at, obtained_marks, total_marks, duration_s, topic_code, units}]` |

**`units`** is a list of **0-based** syllabus unit indices — the paper was
scoped to those units — or `null` for one drawn from the whole subject.
Scoping requires a `topic_code`: "unit 3" means nothing across five courses
that each have one. An index outside the subject's unit list is refused (422)
rather than clamped.

A unit-scoped paper draws only from cards whose unit is actually **known**,
which means knowledge-mode cards: their chunk is the per-unit chunk of the
topic's synthetic knowledge source and its `ordinal` is the unit index. Cards
from an uploaded PDF are chunked by page, and a page maps to no unit, so they
are left out of a unit paper rather than claimed for a unit nobody checked.

**`asked_before`** is how a question went the last time it appeared on a
DIFFERENT paper, or `null` the first time — `"open"` when it is also on a paper
you have not submitted. Papers avoid repeats, so a repeat is deliberate and the
screen must say which reason applies; an unexplained repeat reads as a broken
generator. The paper also carries **`fresh`** and **`repeats`**, which sum to the
question count.

It is computed on read rather than stored on `test_questions`, because that table
is still copied by a positional `INSERT INTO test_questions_new SELECT *` in
`db.py`'s dormant repair path — adding a column there arms a migration that fires
years later on somebody's damaged database.

**`submitted_at`** is the honest answer to "is this paper finished".
`duration_s` was only ever a proxy for it and is wrong in one real case: a
paper submitted having answered nothing records `duration_s = 0`, which reads
as falsy and left the paper looking permanently unfinished.

```
TestQuestion = {ordinal, card_id, kind, question, answer, cloze_text, marks,
                topic_code, page_ref, verdict, detail, origin, asked_before}
verdict      = "correct" | "partial" | "wrong" | "skipped" | null
asked_before = verdict | "open" | null
TestResult   = {obtained_marks, total_marks, percent, duration_s,
                by_topic: [{topic_code, obtained, total}],
                wrong: [TestQuestion], partial: [TestQuestion]}
```

`partial` is only offered for questions worth 2 marks or more, and scores half.

### Feedback into the scheduler

On submit, every **answered** question records a real review through the normal
scheduling path, so stability and difficulty update exactly as they would in daily
review. Skipped questions record nothing — not attempting a question is not evidence
about memory. Grade mapping: `wrong -> 1 (again)`, `partial -> 2 (hard)`,
`correct -> 3 (good)`. Grade 4 is never inferred: "easy" is a claim only the person
reviewing can make, and a test does not ask.

---

## Yash Made Test — the curated MCQ bank

A second test mode, switched from the top of `/test` (**Recall | Yash Made
Test**, remembered per browser). Recall's test mode grades cards the app
generated; this one sits a **hand-curated bank** of multiple-choice questions
written per subject and unit from the lecture decks, the same for every user.
Every attempt draws a fresh sample and shuffles both the questions and each
question's options, so two sittings never look the same; the answer is
revealed one question at a time, in green or red, with a teaching note.

A sitting is chosen along three axes — which units, **which difficulty**, and
**how many questions** — and all three together are what a leaderboard is keyed
by. Two more choices say how it is sat and what it draws from: the **mode**
(`practice`, the reveal-as-you-go sitting above, or `exam`, timed and sealed
until submit) and the **source** (`bank`, or `mistakes` — only the questions
you last got wrong). Both default to what every attempt before them was:
practice, from the bank.

### The bank is shared — the one deliberate exception to the user_id rule

`mcq_questions` has **no `user_id`**. It is course content, like the LPU
registry in `lpu.py`, not something a user owns; every user reads the same
rows. Everything a user *does* with it — attempts and answers — is scoped by
`user_id` exactly as the rest of the app is, and a route that reaches an
attempt without `WHERE user_id = ?` is a leak.

The bank lives in the repo as JSON under `src/recall/mcq/bank/` (one file per
subject-unit, `{subject_code, unit, questions: [...]}`) and is **seeded on
every boot** by `seed_mcq_bank(conn)` — from the container entrypoint next to
`seed_topics`, and from the app lifespan after `init_db`, so a local dev
database has it too. Seeding upserts on the stable `key`
(`CSE111-U1-042`), so editing a question's text in the JSON fixes it in place
without orphaning the attempts that already used it; a question removed from
the JSON is **retired** (`active = 0`), never deleted, for the same reason.

A question is: `key`, `subject_code`, `unit` (the number printed on the deck,
1-based), `topic` (a short group label such as `Linux`), `kind`
(`recall` | `situation`), `difficulty` (the ladder below), `question`,
optionally `code` and `options_mono` (below), `options` (exactly 4),
`correct` (0–3 in the stored order), `explain` (2–4 sentences teaching the
point), `why_wrong` (exactly 4 strings aligned with `options`; the correct
one's entry is `""`).
No CHECK constraints on any of these tables — validate in Python.

### Code questions

The Python (INT108) and web (CSE326) banks are full of "what does this print"
questions, and a question used to be one string rendered in a proportional
serif — which collapses whitespace. In Python the whitespace is the program:
a snippet whose indentation was flattened is a different program, and the
question would mark the student wrong for reading correctly what they were
shown. So a question may carry two more fields, both optional in the JSON:

- `code` — the snippet, **exactly as typed**: leading spaces, tabs, blank
  lines, trailing whitespace and the final newline all survive loader, table
  and wire byte for byte. The loader never strips it. Absent or `""` means no
  snippet. A value that is only whitespace is **refused**, naming the key: it
  is a paste that went wrong, and it would render an empty code block under
  "what does this print". A non-string is refused too.
- `options_mono` — `true` when the four options are code, program output,
  values, expressions, tags or selectors and must be shown in monospace
  exactly as written; absent means `false` (prose). A real JSON boolean only:
  `1`, `"true"` and `null` are refused, naming the key, rather than guessed
  at from truthiness.

Neither field says which option is right, so **both are sent with the
question before it is answered** — on a fresh attempt, on a resumed one, and
again on the review sheet (`missed`). The pre-answer payload still carries no
`correct_index`, no `why_wrong` and no `explain`; adding a field next to the
options is exactly where one could leak, and a test sits on it.

On the wire `code` is a string or **`null`** — never `""` — so a client tests
one thing; `options_mono` is always a boolean. In `mcq_questions` they are
`code TEXT` (NULL for no snippet, the same spelling a migrated row has) and
`options_mono INTEGER NOT NULL DEFAULT 0`. The live table already held the
CSE111 bank and real attempts pointing at its row ids, so both columns arrive
through `_migrate()`'s guarded `ALTER TABLE ... ADD COLUMN`, exactly as
`difficulty` did — never a rebuild. Existing rows become "no snippet, prose
options", which is what every CSE111 question is; re-seeding upserts both
fields on the stable key like every other.

Every existing rule still holds on a code question — four options, no
duplicate answers, a `""` note on the correct option. The duplicate check
compares options the way they are read. Prose options are folded on case and
whitespace, exactly as before. Monospace options are compared as written,
because `True` and `true` are different Python and `a  b` is not `a b`. Only
what a monospace line cannot show is folded: trailing whitespace, and a tab
against the spaces it renders as (tab-size 4). So `True`/`true` may be two
options when `options_mono` is `true`, and `x`/`x  ` still may not.

### The difficulty ladder

`difficulty` is **required on every question** and is one of exactly:

| tier | what it asks of you |
|---|---|
| `easy` | one fact, recalled directly — it is in the material as stated |
| `medium` | telling neighbours apart: which-is-NOT, ordering, the near miss |
| `hard` | applying the idea to a short realistic scenario |
| `max` | the hardest **fair** tier: trap-adjacent, two concepts joined, or a precise exception |

`max` is hard, never unfair — no trickery, nothing off-syllabus, no question
whose only difficulty is that it is badly worded. A student who knows the unit
cold can get every `max` question right.

The field has no default in the loader: a bank where some questions carry a
tier and some do not cannot be filtered honestly, because "Easy, 30 questions"
would quietly mean "easy, plus everything nobody labelled". `mcq_questions`
*does* carry `DEFAULT 'medium'`, and that is a **migration tool only** — it is
what the live database's existing rows became when the column was added, so
nothing had to be rewritten while real attempts were in flight. Re-seeding then
stamps each row with the tier its JSON declares.

### Six subjects, and where their units come from

Unit labels and which units exist per subject live in
`recall.mcq.registry.MCQ_UNITS`, so a unit that has no questions yet still
appears on the picker with a count of 0 and a "waiting for material" note
rather than vanishing. The registry lists **all six** Semester-1 subjects —
MTH165, CSE111, INT108, INT335, MEC103, CSE326 — whether or not a single
question has been written for them: a subject with no bank files is listed
with every unit at 0, and asking to sit it is the ordinary 422 for a
selection with no questions. The picker shows the whole semester, including
what is still being written.

**Five of the six are derived from `recall.lpu`, not retyped.** Their label is
`SUBJECTS[code]["full_name"]` and their units are `SUBJECTS[code]["units"]`
numbered 1..6, computed at import. `lpu.py` is where the syllabus lives — read
off LPU's own Session 2026-27 PDFs and corrected against them — and a second
hand-typed copy of the same unit names would drift from it the first time
either was fixed. Fix a unit name there and the picker follows.

**CSE111 is the exception, and it is written out on purpose.** Its bank was
written against the photographed CA1 syllabus, whose two units — "Computational
Thinking & Computing Environment" and "Version Control & Cyber Security
Basics" — are not `lpu.py`'s seven. Every question in the live bank carries
those unit numbers, so deriving CSE111 would renumber all of them.

`GET /api/mcq/subjects` returns the subjects **that hold questions first, most
questions first, then the ones still waiting**, because the picker opens on
the first entry and registry order would open it on Mathematics — a subject it
then refuses to start. Ties, and the waiting subjects among themselves, keep
the semester order in `registry.MCQ_SUBJECTS`. Only questions in a unit the
registry declares count toward that order: a stray file under a unit that
does not exist cannot be sat, so it must not lift its subject up the list.

### Sitting an attempt

`length` is **any whole number from 5 to 200**, or `"full"` (every active
question in the selection). The picker offers 30 / 60 / full as one-tap
presets, but the number is free: a student revising one unit the night before
wants twelve questions, and being told to sit thirty is how a revision tool
stops being opened. Five is the floor because a shorter sitting is a coin toss
the leaderboard would rank as a result; 200 is the ceiling because it is the
size of the bank. Outside that range is **422 naming the range**, not a
silently clamped attempt.

`difficulty` is one of the four tiers, or **absent for Mixed**, which draws
across all of them. A tier that has no questions for the chosen units is 422
naming the tier — "unit 2 has no questions yet" would be a lie when unit 2 has
forty of them and none is a `max`.

The attempt draws `min(count, available)` active questions from the chosen
units **and tier**, **without replacement**, shuffled;
each question's four options are independently shuffled and the permutation is
stored on the attempt, so the client only ever sees the shown order and
`chosen` / `correct_index` are always positions in that shown order. The
stored `question_ids_json` + `option_orders_json` are what make an attempt
resumable and gradable later without recomputing anything.

Asking for more than exists is a **shorter attempt, never an error**: 200 `max`
questions out of two is a two-question sitting. What was *asked for* is what is
stored in `length`, because that is what the leaderboard is keyed by — two
students who both asked for 30 out of a bank of 12 sat the same paper.

### A selection is four things

`(subject_code, units, length, difficulty)`. That tuple is the leaderboard key.
Easy/30 and Hard/30 are different boards, exactly as units `[1]` and `[1,2]`
already were: 26/30 on Easy and 26/30 on Max are not the same achievement, and
one board holding both would rank the student who picked the gentler paper
above the one who did not.

**Mixed is its own board, not a merge of the four.** A merged board would rank
sittings nobody sat against each other. Mixed is stored as `NULL`, so every
query that matches it uses `difficulty IS ?` and never `= ?` — `NULL = NULL` is
not true in SQLite, and the equality form would leave the Mixed board empty for
ever while every tier board worked, which looks like "nobody has sat Mixed yet"
rather than like a bug.

Ranking a **stored** attempt reads that attempt's own stored selection and
re-validates nothing against the registry — the rule that kept attempts alive
when a unit left `MCQ_UNITS` covers `difficulty` too.

Mixed is spelt differently in the two places it can be asked for, because the
two can express different things. In a **JSON body**, Mixed is `null` or the
key left out; an empty string there is a client bug and stays a loud 422. In
the **query string**, which has no way to write null at all, an empty
`difficulty=` *is* how "no tier chosen" is written, and it means Mixed — a
bookmarked board URL must not 422 because a `<select>` serialised its blank
option.

In **practice**, answering is one call per question, idempotent by refusal: a
second answer to the same position is **409**, never overwritten — the first
click is the answer. An answered question is revealed immediately: correct or not, which
option was right, the explanation, and the `why_wrong` note for the option
that was picked (empty when it was right).

Submitting closes the attempt with the same guarded
`UPDATE ... WHERE submitted_at IS NULL` idiom as `/api/tests/{id}/submit`;
the loser of a race re-reads the stored result. **Unanswered questions score
0** — "Finish & see score" mid-way is allowed and the total stays the number
of questions drawn, so a 12/30 read after twelve questions is an honest 12/30.
Nothing here feeds the scheduler: these are not cards.

### Exam mode — the paper that does not teach until it is over

The real CA is timed and you learn your score at the end. Practice mode
teaches mid-paper — every click is marked and explained — which is how it
teaches, and exactly why it cannot tell a student where they stand: by
question twenty they have been told nineteen answers. `mode: "exam"` is the
sitting that can.

- **Timed.** `time_limit_s` is **60 seconds per question drawn** — 30
  questions is 30:00, and 30 asked for out of a unit of 12 is 12:00, because
  the clock belongs to the paper the student actually has. It is stored on the
  attempt at creation; practice attempts carry `null`.
- **Sealed until submit.** Answering an open exam records the choice and
  returns `{position, chosen, answered}` — **nothing else**: no `is_correct`,
  no `correct_index`, no `explain`, no `why_wrong`, no running score. GET of
  the attempt carries each question's recorded choice in that same shape and
  no feedback of any kind; the history list has `score: null` like any open
  sitting.
- **Answers can change until submit.** The same `UNIQUE(attempt_id,
  position)` that makes a second practice click a 409 is, for an exam, the
  target of an upsert: the last choice is the one graded, and there is still
  one row per position.
- **The clock is enforced by the server.** An answer after `started_at +
  time_limit_s` plus a **30-second grace** is **409** ("time is up") — the
  grace covers a request in flight at 29:59, not a paused tab. Submitting is
  never refused on time: an expired paper can always be closed and read.
  An exam's `duration_s` stops at the limit plus the grace, because nothing
  could be answered after that.
- **Submit reveals everything at once** — the same full `McqResult` as
  practice, and from then on GET of the attempt carries full `McqFeedback`
  like any submitted sitting.

**Why sealing is the whole feature.** Because an exam answer can be changed,
any verdict that leaves the server before submit is an oracle: click option A,
read the verdict, click B, read again, and keep the one the server liked. A
single `is_correct` in one response — or in GET of the attempt, which is the
second door onto the same rows — turns every exam into four free guesses per
question, and a score that means nothing on the board it is ranked on. So the
sealed shape is built by its own query that never selects `is_correct`, not by
dropping fields from the practice one, and the tests assert on the raw JSON
that none of `correct`, `correct_index`, `is_correct`, `explain` or
`why_wrong` — nor any explanation's text — appears before submit.

**Boards split by mode.** A practice score was earned with every answer
explained on the way and no clock; an exam score was not. Ranking one against
the other would reward whichever paper was easier to sit. So a board is a
selection **sat one way**: `mode` joins the key, `?mode=exam` asks for the exam
board, and absent (or empty, like `difficulty=`) is practice — which is where
every attempt drawn before exams existed already is, by the column's default.
A submit ranks the attempt on the board of its **own stored** mode.

The migration is three guarded `ALTER TABLE mcq_attempts ADD COLUMN`s in
`_migrate()` — `mode TEXT NOT NULL DEFAULT 'practice'`, `source TEXT NOT NULL
DEFAULT 'bank'`, `time_limit_s INTEGER` — never a rebuild: the live table holds
real users' attempts, and the defaults make every one of them exactly what it
was, readable, gradable and on the board it was already on.

### Practise my mistakes

`source: "mistakes"` draws only from the questions this student currently has
wrong. The pool is **every question whose most recent revealed answer by this
user was wrong**:

- An answer counts once its correctness has been **revealed** to the student —
  on the click in practice, at submit in an exam. An open exam has revealed
  nothing, so its answers are not evidence either way: they neither add a
  mistake nor clear one.
- "Most recent" is by the moment of the reveal: a practice answer's own time,
  an exam answer's submit time.
- Answer a pooled question right later — in a mistakes sitting or any other —
  and it **leaves the pool**. The list shrinks as the student learns, which is
  the point. It is computed from the answers on every read and never stored, so
  there is nothing to keep in step.
- **Unanswered questions never enter it.** Not attempting is not evidence of
  not knowing.
- Only active questions, in units the registry declares — the ones a draw can
  reach. Abandoning a sitting deletes its answers, and they leave the history
  with it.

It is filtered by subject, units and difficulty exactly like a normal
selection, still shuffled, still `min(length, available)`, and it combines
with either mode. An empty pool for the selection is **422** saying there are
no mistakes to practise in that selection yet — not "no questions", which
would be false when the bank holds forty of them.

**A mistakes sitting is never on any board**, in either mode. Every student's
pool is different, and the same student's is different next week, so two
mistakes sittings with the same subject, units and length are not the same
paper; ranking them would compare nothing. `submit` gives it `rank: null`,
and the board query admits `source = 'bank'` only.

`GET /api/mcq/mistakes` is the per-subject summary the picker needs to print
"Practise my mistakes (N)": this user's pending count per subject, by unit and
by tier. Mine only — it is built from my own answers — and subjects with
nothing pending are omitted.

### Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/mcq/subjects` | — | `[McqSubject]` — every subject in `MCQ_UNITS`, each unit with its `count` of active questions and a per-tier breakdown; subjects with questions first (most first), then the rest in semester order |
| POST | `/api/mcq/attempts` | `{subject_code, units: [1], length, difficulty?, mode?, source?}` | `McqAttempt`. **422** for an unknown subject, a unit not in the registry, a length outside 5–200, an unknown difficulty, mode or source, a selection with zero questions, or (`source: "mistakes"`) an empty mistakes pool |
| GET | `/api/mcq/attempts/{id}` | — | `McqAttempt` with recorded answers, for resuming. **404** if not yours |
| POST | `/api/mcq/attempts/{id}/answer` | `{position, chosen}` | Practice: `McqFeedback`; **409** if that position is already answered. Exam: `McqExamChoice`, and re-answering overwrites; **409** once time is up (limit + 30 s). Both: **409** once submitted, **422** if position or chosen is out of range |
| POST | `/api/mcq/attempts/{id}/submit` | — | `McqResult` — never refused on time |
| DELETE | `/api/mcq/attempts/{id}` | — | `{ok: true}`. **409** once submitted, **404** if not yours |
| GET | `/api/mcq/attempts` | — | `[McqAttemptSummary]`, newest first, mine only |
| GET | `/api/mcq/mistakes` | — | `[McqMistakes]` — my pending mistakes per subject, semester order, subjects with none omitted |
| GET | `/api/mcq/leaderboard?subject_code=&units=1,2&length=30&difficulty=hard&mode=exam` | — | `[McqLeaderboardRow]` — each user's **best submitted** bank attempt for exactly that selection and mode, ranked by percent then shorter duration, top 25. Omitting `difficulty` — or sending it **empty** — asks for the **Mixed** board, not for all of them; omitting `mode` (or empty) asks for **practice**. Mistakes sittings are on no board |

```
McqLength         = number (5-200) | "full"
McqDifficulty     = "easy" | "medium" | "hard" | "max"
McqMode           = "practice" | "exam"             // absent/null = practice
McqSource         = "bank" | "mistakes"             // absent/null = bank
McqTierCounts     = {easy, medium, hard, max}       // always all four keys
McqSubject        = {subject_code, label,
                     units: [{unit, label, count, difficulties: McqTierCounts}],
                     lengths: [30, 60, "full"],     // presets, not the limit
                     difficulties: ["easy","medium","hard","max"],
                     length_min: 5, length_max: 200}
McqQuestion       = {position, topic, kind, difficulty, question,
                     code: string | null,          // exact snippet; null = none
                     options_mono: boolean,        // options are code: monospace
                     options: [string ×4],                        // shown order
                     answer: McqFeedback       // practice, or a submitted exam
                           | McqExamChoice     // an exam not yet submitted
                           | null}             // unanswered
McqAttempt        = {attempt_id, subject_code, units, length,
                     difficulty: McqDifficulty | null,   // null = Mixed
                     mode: McqMode, source: McqSource,
                     time_limit_s: number | null,  // exam: 60 × total; practice: null
                     seconds_left: number | null,  // open exam: server's count, ≥ 0
                     total, started_at, submitted_at, questions: [McqQuestion]}
McqExamChoice     = {position, chosen, answered}   // NOTHING else, ever
McqFeedback       = {position, chosen, correct_index, is_correct,
                     explain, why_wrong,            // why_wrong is "" when correct
                     answered, correct_so_far}
McqResult         = {attempt_id, score, total, answered, percent, duration_s,
                     by_topic: [{topic, correct, total}],
                     by_difficulty: [{difficulty, correct, total}],  // ladder order
                     missed: [{position, topic, question, code, options_mono,
                               options, chosen | null,
                               correct_index, explain, why_wrong}],
                     rank: {position, of} | null}    // on its own mode's board; null for mistakes
McqAttemptSummary = {id, subject_code, units, length,
                     difficulty: McqDifficulty | null,
                     mode: McqMode, source: McqSource,
                     time_limit_s: number | null,
                     total, answered, score,
                     started_at, submitted_at, duration_s}
McqLeaderboardRow = {user_id, name, score, total, percent, duration_s, submitted_at}
McqMistakes       = {subject_code, total,
                     by_unit: {"1": n, ...},       // every registry unit, 0 included
                     by_difficulty: McqTierCounts} // always all four keys
```

`McqExamChoice.answered` is how many positions of the attempt hold a choice
now. `seconds_left` excludes the grace and is `null` for practice and for a
submitted paper; it is there so a phone whose clock is wrong still counts down
the server's time. `by_unit` keys are unit numbers as JSON object keys, which
is to say strings.

`percent` is `round(100 * score / total)`; the client still derives what it
prints from `score` and `total`. `missed` lists every question that was
answered wrongly **or not answered at all** (`chosen: null`), in attempt order,
so the result screen doubles as the review sheet.

`by_difficulty` follows `by_topic`'s honesty rule — every question **drawn**,
answered or not, so a tier you skipped reads as 0 out of its real count — and
is returned in ladder order (`easy`, `medium`, `hard`, `max`) so a student
reads the sitting as a climb. Tiers the attempt never drew are **omitted
entirely**: a single-tier sitting reports one row, and a Mixed sitting that
happened to draw no `max` question does not report `0/0 max` as though it had
been sat. It sums to `score` over `total`, like `by_topic`.

`McqSubject.difficulties` per unit is what lets the picker grey out a tier
nobody has written yet and print real numbers beside the ones it offers. All
four keys are always present: a missing key and a zero would read the same to a
client, and only one of them is true.

## Teaching: explain what you got wrong

After a test (or a lapse in daily review), you can ask for an explanation of a card you
missed. The explanation is **grounded in the card's own source chunk** — the same text
the card was generated from — so it teaches your syllabus rather than the model's
general knowledge.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/teach/explain` | `{card_id}` | `{explanation, source_quote, page_ref, topic_code, cached}` |

Rules:
- The explanation must cite a verbatim quote from the chunk, verified in Python exactly
  as the groundedness gate does. An explanation that cannot cite its source is not
  returned; the endpoint returns 422 with a plain reason instead of a confident guess.
- Explanations are **cached in the database** keyed by card id. They cost money and the
  same card gets missed repeatedly; regenerating each time is waste.
- Explanations are prose for a first-year student: what the answer is, why, and the one
  distinction most likely to have caused the mistake. No preamble, no encouragement.

## Reading a lesson

A lesson is a unit's worth of teaching — a `why`, three to five sections, exactly two
worked examples with their derivations, and a short self-check — written offline by
`recall lessons <TOPIC> --unit N` and stored in `lessons`. **Writing one is never
reachable over HTTP.** It takes a minute or two, costs money against the $1.00 per-user
daily cap, and has no resume path.

Reading one is two GETs, and they are the reason the feature exists at all: until they
landed the only way to see a lesson was `docker exec ... python -m recall.cli
lesson-show` over SSH, which is the `card_explanations` failure from the other
end — the one teaching feature that shipped has zero rows because it sits behind a
button nobody presses.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/teach/lessons` | — | `[{topic_code, full_name, written, units: [{number, name, lesson}]}]` |
| GET | `/api/teach/lessons/{topic_code}/{unit}` | `unit` is **1-based** | `{topic_code, full_name, unit_number, unit_name, lesson}` |

```
lesson (index)  = null | {id, status, created_at}
lesson (reader) = null | {id, status, notes, created_at,
                          cited_sections, section_count, body}
status          = "grounded" | "unverified" | "draft"
                  "grounded"   — at least half the sections carry a quote Python found
                                 VERBATIM in the uploaded course material. A warranty.
                  "unverified" — written, and checked for structure and notation, but
                                 anchored to nothing. Most of it is the model's own
                                 knowledge.
                  "draft"      — legacy; read it as "unverified".
notes           = the pipeline's own sentences, one per line in the column, split into a
                  list here so the client never string-splits prose. `[]` when null.
body            = {why, sections: [{heading, body, quote?, source?}],
                   worked: [{question, steps: [str], answer}] (exactly 2),
                   check:  [{question, answer, why}]}
```

Rules:
- **Neither route may cost money.** No `Depends(get_llm)`, no `DeepSeekClient` reachable
  from either, ever. `web/lib/resources.ts::prefetchFor` fires on route *intent*, so a
  paid GET here bills the owner for a hover. Neither route writes either — no cache row,
  no view counter, no commit.
- **A unit with nothing written is a 200 with `lesson: null`**, not a 404. It is a state,
  not an error — it mirrors `latest_lesson` returning None — and the client needs
  `unit_name` in hand to print `recall lessons MTH165 --unit 3` in its empty state, which
  a 404 body cannot carry. There is no "write this lesson" button anywhere, for the
  reason in the first paragraph.
- `404` for a topic that is not yours, which is the same 404 an unknown code gets:
  answering the two differently would make this route an oracle for what other accounts
  study. `422` for a topic carrying no syllabus units, or a unit past the end of one.
- **Ownership reaches lessons through `sources.user_id`.** `chunks` carries no user_id,
  so that join is the only column that can refuse a chunk; `topics.user_id` is applied
  as a second, independent gate on the same request. The index reproduces
  `latest_lesson`'s selection rule exactly — same synthetic knowledge source, same
  `unit_key` match, same newest-id-wins — so the list and the page it links to can never
  disagree about which lesson is current.
- The index lists **every** syllabus unit, written or not: "MTH165 unit 4 has nothing" is
  information a student wants. Topics with no `meta.units` are omitted entirely — nothing
  can be written for them. A stored lesson whose unit name matches no current syllabus
  unit is dropped rather than filed under a neighbour, which is the `_unit_chunk_id`
  ordinal bug arriving from the index side.
- `cited_sections` / `section_count` count sections carrying a non-empty `quote`. This is
  **not** a re-verification and does not call `check_grounding`: `drop_bad_citations`
  already removed every quote that failed before the lesson was stored, so a stored quote
  is by construction one Python found verbatim. Counting is honest and free; re-checking
  would need the corpus on a read path and would become a second, drifting definition of
  "verified". These two numbers are what the client's coverage meter and its
  one-sentence warranty are built from, so no client ever parses `notes` to decide what
  to show.

## Image and file upload

Uploading is how notes get in from a phone, so this must work on a small screen over a
tunnelled connection.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/sources/upload` | multipart: `file`, `topic_code` | `{source_id, filename, kind, chunks, text_chars, warning?}` |
| POST | `/api/sources/{id}/generate` | — | `{accepted, rejected, cost_usd, stopped_early}` |

Upload **extracts text and creates chunks only** — it never calls the paid API, so it is
fast and free and works before any key exists. Card generation is a separate, explicit
step because it costs money and takes time.

Accepted: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.txt`, `.md`. Max 25 MB.

**OCR honesty:** images go through Tesseract on CPU. Printed slides, textbook pages and
screenshots work well. **Handwriting works badly** — that is a real limitation of
CPU OCR, not a bug, and the response carries a `warning` when extracted text looks too
sparse for the image size. OCR sits behind a single `extract_text_from_image(path)`
function so a vision-capable API can replace it later without touching anything else.

## Knowledge mode — cards with nothing uploaded

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/topics/{code}/generate` | `{unit, count?}` (`unit` is 1-based; `count` ≤ 25, default 12) | `{accepted, rejected, cost_usd, stopped_early}` — the same shape as upload generation |
| POST | `/api/topics/{code}/paper` | `{kind, units?}` | A full `TestPaper`, plus `generated: {cards, rejected, cost_usd, unit_numbers, deck_already_covered_it}`. Works out which units the paper draws from (MTE → units 1-3, class test → 1-2, ETE → all), generates only the shortfall, then assembles normally. This is what the subject chips on `/test` call: `POST /api/tests` assembles from what exists and hands back an empty paper when the deck is empty, which is the "This paper has no questions" dead end. Pass `units` — **1-based** here, the numbers a student reads off a timetable, unlike the 0-based indices `POST /api/tests` takes — to examine only what was covered in class; the marks target is then spread across just those units, so asking for one unit gets a paper's worth of it. |

Writes cards for one syllabus unit from the model's own knowledge, for the case
where the student has uploaded nothing. `422` when the topic carries no unit
metadata or the unit number is past the end of the syllabus; `404` when the
topic is not yours; `429` when the account is over its daily spend cap.

**What is deliberately given up.** The upload path runs five gates; this path
runs three. `check_grounded` cannot run — there is no passage to quote — and
`check_closed_book` is meaningless here, since its whole job is to reject cards
answerable without a source, which is what these are by construction.
`check_answerable`, `check_atomic` and semantic dedup all still run.

**Where a surviving card lands depends on how thoroughly it was checked**
(`pipeline.keep_state`). An upload-grounded card cleared five gates including
a Python-verified verbatim quote, so it goes straight into rotation
(`state = 'active'`) — making someone read thirty verified cards before they
can study is judgement exercised at the moment they have the least
information, and a bad one is caught in review anyway: graded `again`,
surfaced as a leech, suspended with one press
(`POST /api/cards/{id}/suspend`).

A knowledge-mode card cleared three, and the two it skipped are exactly the
ones that check it against reality. It lands `active` all the same — **there is
no approval queue**, and `pipeline.keep_state` returns `'active'`
unconditionally. This paragraph claimed otherwise for months, which is worse
than claiming nothing: it named a gate nobody was keeping.

What carries the weight instead is the `no source` mark on screen, review
itself (graded `again` → leech → one-press suspend), and — where the unit has
corpus material loaded — a lesson whose every claim is quoted verbatim from it
and checked in Python.

Dedup for this path is seeded with the questions already on the unit. Uploaded
chunks generate exactly once, so repeats are impossible there; this button can
be pressed all day against the same unit, and without the seed a second press
would re-add what the first one wrote.

The chunk foreign key is satisfied by a synthetic per-topic source
(`sources.kind = 'knowledge'`) and one chunk per unit, not by a nullable
`chunk_id`: seven read paths inner-join `chunks`, so a null there would
silently drop these cards from the review queue, test assembly, teaching, the
CLI and the Anki export.

## Spend limits

`RECALL_MAX_COST_USD` caps a single generation run. That was sufficient while
one person owned the instance. With open registration it is not — nothing
bounded how many runs one account started — so
`RECALL_MAX_COST_USD_PER_USER_PER_DAY` (default `1.00`) caps what one account
may spend in a UTC day, tracked in `usage_daily` and checked at the top of
**both** generation endpoints before any paid call. Over the cap is `429`.
