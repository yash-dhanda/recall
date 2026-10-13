/**
 * Wire types for the Recall HTTP API.
 *
 * These mirror `docs/CONTRACT.md` exactly. Where a field is marked OPTIONAL /
 * ADDITIVE it is not promised by the contract; the client uses it when the
 * server sends it and degrades gracefully when it does not.
 */

export type CardKind = "qa" | "cloze";

/** 1 = again, 2 = hard, 3 = good, 4 = easy. */
export type Grade = 1 | 2 | 3 | 4;

/** One subject's assessment weight split, in marks out of 100. */
export interface SubjectScheme {
  attendance: number;
  ca: number;
  mte: number;
  ete: number;
}

/**
 * OPTIONAL / ADDITIVE. Real LPU subject facts, carried by GET /api/topics
 * items once the database has been seeded with the programme registry
 * (`recall.lpu`). An unseeded database sends null, and every consumer must
 * degrade to code + label alone.
 */
export interface TopicMeta {
  full_name: string;
  credits: number;
  /** The six syllabus units, in order. MTE covers 1–3; ETE covers all six. */
  units: string[];
  scheme: SubjectScheme;
  ca_policy: string;
  /** INT108 and CSE326 carry no mid-term at LPU; offering one is an error. */
  mte_exists: boolean;
  exam_format: string;
  /**
   * OPTIONAL / ADDITIVE. False when the weight split above is a placeholder
   * rather than a sourced fact — MEC103's units are researched but its
   * CA/MTE/ETE split is not confirmed. The UI must say so: a wrong exam
   * structure presented as fact is worse than an absent one.
   */
  scheme_confirmed?: boolean;
}

/** GET /api/topics */
export interface Topic {
  id: number;
  code: string;
  label: string;
  due: number;
  new: number;
  active: number;
  pending: number;
  /** OPTIONAL / ADDITIVE. See TopicMeta. */
  meta?: TopicMeta | null;
}

/**
 * Where a card came from. 'upload' is grounded in a verbatim quote from a file
 * the student uploaded; 'knowledge' was written from the model's own knowledge
 * of a syllabus unit, with no source to check it against. The UI must show the
 * difference — the two carry very different warranties.
 */
export type CardOrigin = "upload" | "knowledge";

export interface QueueCard {
  id: number;
  kind: CardKind;
  question: string;
  answer: string;
  cloze_text: string | null;
  topic_code: string;
  page_ref: string;
  is_new: boolean;
  /** OPTIONAL / ADDITIVE: absent on servers older than knowledge mode. */
  origin?: CardOrigin;
  /**
   * OPTIONAL / ADDITIVE. The worked explanation, shown AFTER the answer is
   * revealed. Null on every card written before this field existed.
   */
  detail?: string | null;
  /**
   * OPTIONAL / ADDITIVE. Present in `card_state` server-side. When the API
   * includes them the grade buttons show exact intervals; otherwise they show
   * estimates, marked with a leading "≈".
   */
  stability?: number | null;
  difficulty?: number | null;
  /** OPTIONAL / ADDITIVE. Days since the last review, for the same purpose. */
  elapsed_days?: number | null;
}

/** GET /api/queue */
export interface QueueResponse {
  cards: QueueCard[];
  due_remaining: number;
  new_remaining: number;
  cap_reached: boolean;
}

/** POST /api/review */
export interface ReviewRequest {
  card_id: number;
  grade: Grade;
}

export interface ReviewResponse {
  card_id: number;
  interval_days: number;
  due_at: string;
  stability: number;
  difficulty: number;
}

export interface PendingCard {
  id: number;
  kind: CardKind;
  question: string;
  answer: string;
  cloze_text: string | null;
  topic_code: string;
  page_ref: string;
  source_filename: string;
  /** OPTIONAL / ADDITIVE: absent on servers older than knowledge mode. */
  origin?: CardOrigin;
  /** OPTIONAL / ADDITIVE. The worked explanation, shown after the answer. */
  detail?: string | null;
}

/** GET /api/pending */
export interface PendingResponse {
  cards: PendingCard[];
  total: number;
}

export type DecideAction = "approve" | "reject";

/** POST /api/pending/decide */
export interface DecideRequest {
  ids: number[];
  action: DecideAction;
}

export interface DecideResponse {
  updated: number;
}

/** GET / PUT /api/settings */
export interface Settings {
  new_cards_per_day: number;
  daily_review_cap: number;
  desired_retention: number;
}

export type SettingsPatch = Partial<Settings>;

/**
 * `by_topic` is left open in the contract (`[...]`). Typed permissively so a
 * server that returns a richer row does not break the client, and every
 * consumer treats the fields as optional.
 */
export interface StatsTopic {
  id: number;
  code: string;
  label: string;
  due: number;
  new: number;
  active: number;
  pending: number;
  /** Not returned by the API today; kept optional for older mock fixtures. */
  reviewed?: number | null;
  /** OPTIONAL / ADDITIVE. See TopicMeta. */
  meta?: TopicMeta | null;
}

export interface StatsDay {
  date: string;
  count: number;
}

/** GET /api/stats */
export interface Stats {
  today: { reviewed: number; again: number; streak: number };
  by_topic: StatsTopic[];
  last_14_days: StatsDay[];
  totals: { active: number; pending: number; sources: number };
}

/** GET /api/sources */
export interface Source {
  id: number;
  filename: string;
  topic_code: string;
  added_at: string;
  accepted: number;
  rejected: number;
  cost_estimate: number;
}

/* --- test mode ----------------------------------------------------------- */

/**
 * `mte40` is the LPU mid-term: 40 marks, 90 minutes, units 1–3. The server
 * refuses it (422) for a topic whose meta says `mte_exists: false`.
 */
export type TestKind = "class30" | "mte40" | "endterm100" | "fullday";

/** What the person claims about their own answer. `null` = not attempted yet. */
export type Verdict = "correct" | "partial" | "wrong" | "skipped";

export interface TestQuestion {
  ordinal: number;
  card_id: number;
  kind: CardKind;
  question: string;
  answer: string;
  cloze_text: string | null;
  marks: number;
  topic_code: string;
  page_ref: string;
  verdict: Verdict | null;
  /** OPTIONAL / ADDITIVE. The worked steps, shown once the answer is out. */
  detail?: string | null;
  /** OPTIONAL / ADDITIVE: absent on servers older than knowledge mode. */
  origin?: CardOrigin;
  /**
   * OPTIONAL / ADDITIVE. How this question went the last time it was asked on
   * a DIFFERENT paper, or null/absent if this is the first time. `"open"`
   * means it is also sitting on a paper you have not submitted.
   *
   * Papers avoid repeating questions, so a repeat is deliberate — it came back
   * because you got it wrong, or because the deck had nothing else to offer.
   * Render the reason: an unexplained repeat reads as a broken generator.
   */
  asked_before?: Verdict | "open" | null;
}

/** One syllabus unit as the deck actually stands. `mastery` is 1 - mean
 *  weakness, 0..1; a never-reviewed unit sits at 0.5 rather than at either end. */
export interface StudyUnit {
  number: number;
  name: string;
  active: number;
  due: number;
  mastery: number;
}

/**
 * GET /api/study-plan — the single next action for one subject.
 *
 * `units_cover` is how many of the subject's `active` cards the per-unit view
 * can actually account for. Cards from an uploaded PDF are chunked by page and
 * belong to no syllabus unit, so on a PDF-built subject this is 0 and the
 * unit-level fields say nothing. Render that honestly rather than showing a
 * confident "unit 4 is weakest" derived from three of forty cards.
 */
export interface StudyPlanEntry {
  topic_code: string;
  due: number;
  new: number;
  active: number;
  units_cover: number;
  weakest_unit: number | null;
  units: StudyUnit[];
  action: {
    kind: "review" | "generate" | "sit" | "clear";
    unit: number | null;
  };
  advice: string;
}

/** POST /api/tests and GET /api/tests/{id} */
export interface TestPaper {
  test_id: number;
  kind: TestKind;
  /** OPTIONAL / ADDITIVE. 0-based syllabus unit indices the paper was scoped
   *  to, or null for one drawn from the whole subject. */
  units?: number[] | null;
  total_marks: number;
  /** null (or 0) for `fullday`, which has no limit. */
  time_limit_s: number | null;
  /**
   * OPTIONAL / ADDITIVE. The marks the paper was ASKED for, against
   * `total_marks`, which is what the deck could actually fill. They differ
   * when the deck runs out, and `short` says so — without these a 50-mark
   * paper reads as a full 100-mark end term on screen.
   */
  target_marks?: number | null;
  short?: boolean;
  note?: string | null;
  /**
   * OPTIONAL / ADDITIVE. How many questions are new to you and how many have
   * been asked before. `fresh + repeats === questions.length`.
   */
  fresh?: number;
  repeats?: number;
  questions: TestQuestion[];
}

export interface TestTopicScore {
  topic_code: string;
  obtained: number;
  total: number;
}

/** POST /api/tests/{id}/submit */
export interface TestResult {
  obtained_marks: number;
  total_marks: number;
  /**
   * The contract does not fix the scale (0–1 or 0–100), so nothing in the
   * client reads it — every percentage on screen is derived from
   * obtained_marks / total_marks, which cannot disagree with the marks printed
   * beside it.
   */
  percent: number;
  duration_s: number;
  by_topic: TestTopicScore[];
  wrong: TestQuestion[];
  partial: TestQuestion[];
}

/** GET /api/tests */
export interface TestSummary {
  id: number;
  kind: TestKind;
  started_at: string;
  obtained_marks: number;
  total_marks: number;
  /**
   * OPTIONAL / ADDITIVE null: a paper that has been started but not submitted
   * has no duration yet. The client treats null or 0 as "still open" and offers
   * to resume it.
   */
  duration_s: number | null;
  /**
   * OPTIONAL / ADDITIVE. When the paper was submitted, or null while it is
   * still open. This is the honest answer to "is it finished"; duration_s was
   * only ever a proxy for it, and a proxy that is wrong for a paper submitted
   * with nothing answered — that records duration_s = 0, which reads as
   * falsy and left the paper in the unfinished list forever.
   */
  submitted_at?: string | null;
  /** The one subject a class30/mte40/endterm100 paper was restricted to, or
   *  null for a fullday paper (which spans every subject) or on a server
   *  older than this field. */
  topic_code: string | null;
  /** OPTIONAL / ADDITIVE. 0-based syllabus unit indices the paper was scoped
   *  to, or null for one drawn from the whole subject. */
  units?: number[] | null;
}

/* --- teaching ------------------------------------------------------------ */

/** POST /api/teach/explain */
export interface Explanation {
  explanation: string;
  source_quote: string;
  page_ref: string;
  topic_code: string;
  cached: boolean;
}

/* --- lessons ------------------------------------------------------------- */

/**
 * How much of a written lesson Python was actually able to check.
 *
 * `grounded` — at least half the sections carry a quote found VERBATIM in the
 * student's own uploaded course material, verified in Python. A real warranty.
 * `unverified` — written and checked for structure and notation, but not
 * anchored to anything: most of it is the model's own knowledge.
 * `draft` — legacy rows written before the gate existed. The UI renders these
 * exactly like `unverified`, because that is what they are.
 *
 * The two must never look the same on screen. See app/learn/Warranty.tsx.
 */
export type LessonStatus = "grounded" | "unverified" | "draft";

/** One passage of the lesson. */
export interface LessonSection {
  heading: string;
  body: string;
  /**
   * OPTIONAL / ADDITIVE. A quote the pipeline found word for word in the
   * corpus. Absent means the section was written from the model's own
   * knowledge — the reader marks it "model only" and shows no quote block.
   * Anything the checker could not match verbatim was dropped before the
   * lesson was stored, so a quote that IS here is one Python confirmed.
   */
  quote?: string;
  /**
   * OPTIONAL / ADDITIVE. Where the quote came from, e.g.
   * "[1] ncert-matrices.pdf p12". A quote shown without any attribution is
   * the exact failure the grounding gate exists to prevent, so the reader
   * falls back to "your course material" rather than rendering the quote
   * bare.
   */
  source?: string;
}

/** A derivation, shown in full. The steps are never hidden behind a control. */
export interface LessonWorked {
  question: string;
  steps: string[];
  answer: string;
}

/** A retrieval-practice question; `why` says what it is testing. */
export interface LessonCheck {
  question: string;
  answer: string;
  why: string;
}

/** `lessons.body_json`, parsed. */
export interface LessonBody {
  /** Two sentences: what this unit lets you do, and how it is examined. */
  why: string;
  /**
   * OPTIONAL / ADDITIVE on all three. A legacy `draft` row predates the
   * structure check and may carry none of them; every block renders only
   * when its array is non-empty, and the page is still readable without it.
   */
  sections?: LessonSection[];
  worked?: LessonWorked[];
  check?: LessonCheck[];
}

/** A stored lesson, as GET /api/teach/lessons/{topic}/{unit} returns it. */
export interface Lesson {
  id: number;
  status: LessonStatus;
  /**
   * What the checks recorded, one plain sentence per line — how much is
   * grounded, which citations were dropped as paraphrase, what the
   * re-derivation saw. Already split by the server so the client never has
   * to string-split prose. Empty when the pipeline recorded nothing.
   */
  notes: string[];
  created_at: string;
  /** Sections carrying a non-empty quote, counted server-side in Python. */
  cited_sections: number;
  section_count: number;
  body: LessonBody;
}

/** One syllabus unit on the index. `lesson` is null when nothing is written. */
export interface LessonIndexUnit {
  /** 1-based, the number printed on a timetable. */
  number: number;
  name: string;
  lesson: {
    id: number;
    status: LessonStatus;
    created_at: string;
  } | null;
}

/** GET /api/teach/lessons — one entry per subject with syllabus units. */
export interface LessonIndexEntry {
  topic_code: string;
  full_name: string;
  /** How many of `units` have a lesson. Convenience; derivable from `units`. */
  written: number;
  units: LessonIndexUnit[];
}

/**
 * GET /api/teach/lessons/{topic}/{unit}.
 *
 * 200 in both cases. `lesson: null` is a state, not an error — the unit name
 * still comes back so the screen can name what is missing and print the exact
 * command that writes it.
 */
export interface LessonPage {
  topic_code: string;
  full_name: string;
  unit_number: number;
  unit_name: string;
  lesson: Lesson | null;
}

/* --- upload -------------------------------------------------------------- */

/** POST /api/sources/upload */
export interface UploadResponse {
  source_id: number;
  filename: string;
  kind: string;
  chunks: number;
  text_chars: number;
  /** Present when OCR output looks too sparse for the image it came from. */
  warning?: string | null;
}

/** POST /api/sources/{id}/generate */
export interface GenerateResponse {
  accepted: number;
  rejected: number;
  cost_usd: number;
  stopped_early: boolean;
}

/* --- auth ---------------------------------------------------------------- */

/** GET /api/auth/me, POST /api/auth/register, POST /api/auth/login */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
}

/* --- Yash Made Test (curated MCQ bank) ----------------------------------- */

/** How many questions an attempt draws: any whole number from 5 to 200, or
 *  `"full"` for every active question in the selection. The server draws
 *  `min(length, available)`, so asking for more than exists is a shorter
 *  attempt, never an error. */
export type McqLength = number | "full";

export type McqKind = "recall" | "situation";

/**
 * How hard a bank question is. The ladder, in order:
 *
 * - `easy`   — direct single-fact recall.
 * - `medium` — distinguishing neighbours: which-is-NOT, ordering.
 * - `hard`   — applying the idea to a short realistic scenario.
 * - `max`    — the hardest fair tier: trap-adjacent scenarios, two concepts
 *              joined, or a precise exception.
 *
 * `null` wherever a difficulty is optional means **Mixed** — drawn across all
 * four tiers — which is its own selection, not a merge of the four.
 */
export type McqDifficulty = "easy" | "medium" | "hard" | "max" | "hardest";

/**
 * How an attempt is sat.
 *
 * - `practice` — each answer is revealed the moment it is clicked, with the
 *   teaching note, and the first click is final. How the bank teaches.
 * - `exam`     — the CA: timed at a minute per question drawn, answers can be
 *   changed until submit, and nothing about correctness leaves the server
 *   before the paper is closed. The result reveals everything at once.
 *
 * Every attempt drawn before exams existed is `practice`. Part of the
 * leaderboard key: exam scores are only comparable with exam scores.
 */
export type McqMode = "practice" | "exam";

/**
 * Where an attempt's questions come from.
 *
 * - `bank`     — the ordinary draw from the selection.
 * - `mistakes` — only questions whose most recent REVEALED answer by this user
 *   was wrong (a practice answer is revealed on the click, an exam answer at
 *   submit; an open exam has revealed nothing). Answer one right later and it
 *   leaves the pool. Never on any leaderboard: every student's pool differs.
 */
export type McqSource = "bank" | "mistakes";

export interface McqUnit {
  /** The unit number printed on the lecture deck, 1-based. */
  unit: number;
  label: string;
  /** Active questions available. 0 means the picker shows the unit as
   *  "waiting for material" and refuses to start it. */
  count: number;
  /**
   * How this unit's `count` splits across the ladder, so the picker can print
   * what each tier holds for the units currently chosen and disable a tier
   * that holds nothing. The server always sends all four keys — a missing key
   * and a zero would read the same, and only one of them is true — but the
   * field stays optional here so a server older than the ladder leaves every
   * tier offered rather than every tier disabled.
   *
   * The name is the wire name: `difficulties`, per CONTRACT.md's McqSubject.
   */
  difficulties?: Record<McqDifficulty, number>;
}

/** GET /api/mcq/subjects */
export interface McqSubject {
  subject_code: string;
  label: string;
  units: McqUnit[];
  /** Suggested presets for the length control. The client may ask for any
   *  whole number from 5 to 200 regardless of what is listed here. */
  lengths: McqLength[];
}

/**
 * The reveal for one answered question. `chosen` and `correct_index` are
 * positions in the SHOWN option order — the client never learns the stored
 * order. `why_wrong` is the note for the option that was picked, and "" when
 * it was right.
 */
export interface McqFeedback {
  position: number;
  chosen: number;
  correct_index: number;
  is_correct: boolean;
  explain: string;
  why_wrong: string;
  /** Running totals for the attempt after this answer. */
  answered: number;
  correct_so_far: number;
}

/**
 * An exam answer, as the server records it before the paper is submitted:
 * what was chosen and how many positions hold a choice — and NOTHING else.
 * No verdict, no correct index, no explanation, no note, no running score.
 *
 * Its own type, not a partial McqFeedback, so a sitting that holds one cannot
 * read correctness from it by accident: there is no field to read.
 *
 * POST /api/mcq/attempts/{id}/answer on an exam, and McqQuestion.answer on an
 * exam that is still open.
 */
export interface McqExamAnswer {
  position: number;
  /** 0-3 in the shown order. Can change until submit. */
  chosen: number;
  /** How many positions of the attempt hold a choice now. */
  answered: number;
}

export interface McqQuestion {
  position: number;
  topic: string;
  kind: McqKind;
  /** Which rung of the ladder this question sits on. Required on the bank,
   *  so every drawn question carries one even in a Mixed attempt. */
  difficulty: McqDifficulty;
  question: string;
  /**
   * OPTIONAL / ADDITIVE. The snippet the question is about — "what does this
   * print" — exactly as typed. Every space, tab and newline is load-bearing
   * (Python's indentation is its syntax), so the client shows it verbatim in
   * a monospace block and never reflows it. Absent, null or "" when the
   * question has none. It gives nothing away, so it is sent with the
   * question before it is answered.
   */
  code?: string | null;
  /**
   * OPTIONAL / ADDITIVE. True when the options are themselves code, program
   * output, values, expressions, tags or selectors, and must be shown in
   * monospace exactly as written — `[1, 2, 3]` and `'abc'` read as a program
   * prints them, spaces kept. Absent means false: prose options.
   */
  options_mono?: boolean;
  /** Exactly four, already shuffled for this attempt. */
  options: string[];
  /**
   * null until answered. A full McqFeedback once the verdict has been
   * revealed — on the click in practice, at submit in an exam. While an exam
   * is still open it is an McqExamAnswer: the choice alone. Tell them apart
   * with `isRevealed` (lib/api.ts), never by reading a field that might not
   * be there.
   */
  answer: McqFeedback | McqExamAnswer | null;
}

/** POST /api/mcq/attempts and GET /api/mcq/attempts/{id} */
export interface McqAttempt {
  attempt_id: number;
  subject_code: string;
  units: number[];
  length: McqLength;
  /** The tier this attempt was drawn from; `null` is Mixed. Part of the
   *  selection, so it is what a retake repeats and what the board is keyed
   *  by. */
  difficulty: McqDifficulty | null;
  /** How it is sat. Every attempt from before exams existed is "practice". */
  mode: McqMode;
  /** Where its questions came from. "mistakes" is never ranked. */
  source: McqSource;
  /** An exam's clock in seconds — 60 per question DRAWN. null in practice. */
  time_limit_s: number | null;
  /**
   * OPTIONAL / ADDITIVE. Whole seconds left on an open exam's clock, measured
   * by the SERVER when this response was built (grace not included, never
   * below 0); null for practice and once submitted. The countdown anchors on
   * it so a client whose own clock is wrong still counts down the server's
   * time; `started_at + time_limit_s` is the fallback.
   */
  seconds_left?: number | null;
  total: number;
  started_at: string;
  submitted_at: string | null;
  questions: McqQuestion[];
}

export interface McqTopicScore {
  topic: string;
  correct: number;
  total: number;
}

export interface McqDifficultyScore {
  difficulty: McqDifficulty;
  correct: number;
  total: number;
}

/** A question answered wrongly or not at all (`chosen: null`). */
export interface McqMissed {
  position: number;
  topic: string;
  question: string;
  /** OPTIONAL / ADDITIVE. The question's snippet, verbatim, exactly as
   *  McqQuestion.code — the review sheet shows the program it asked about. */
  code?: string | null;
  /** OPTIONAL / ADDITIVE. As McqQuestion.options_mono: the options are code
   *  or output and are shown in monospace, spaces kept. */
  options_mono?: boolean;
  options: string[];
  chosen: number | null;
  correct_index: number;
  explain: string;
  why_wrong: string;
}

/** POST /api/mcq/attempts/{id}/submit */
export interface McqResult {
  attempt_id: number;
  score: number;
  total: number;
  answered: number;
  /** round(100 * score / total). Derive what you print from score/total. */
  percent: number;
  duration_s: number;
  by_topic: McqTopicScore[];
  /**
   * OPTIONAL / ADDITIVE. The same split down the difficulty ladder, over the
   * tiers this attempt actually drew. A Mixed attempt has up to four rows; a
   * single-tier attempt has one, and the client does not print a breakdown
   * that restates the score it is sitting under.
   */
  by_difficulty?: McqDifficultyScore[];
  missed: McqMissed[];
  /** Where this attempt lands on the leaderboard for its selection, or null
   *  when nothing was answered. */
  rank: { position: number; of: number } | null;
}

/** GET /api/mcq/attempts */
export interface McqAttemptSummary {
  id: number;
  subject_code: string;
  units: number[];
  length: McqLength;
  /** The tier it was drawn from; `null` is Mixed. */
  difficulty: McqDifficulty | null;
  mode: McqMode;
  source: McqSource;
  /** An exam's clock in seconds; null in practice. */
  time_limit_s: number | null;
  total: number;
  answered: number;
  /** null while the attempt is still open. */
  score: number | null;
  started_at: string;
  submitted_at: string | null;
  duration_s: number | null;
}

/** GET /api/mcq/leaderboard — one row per user, their best submitted attempt
 *  for exactly this selection: subject + units + length + difficulty + mode.
 *  Easy/30 and Hard/30 are different boards, Mixed is its own, and practice
 *  and exam never share one. A "mistakes" sitting is on no board at all. */
export interface McqLeaderboardRow {
  user_id: number;
  name: string;
  score: number;
  total: number;
  percent: number;
  duration_s: number;
  submitted_at: string;
}

/**
 * GET /api/mcq/mistakes — this user's pending mistakes in one subject: every
 * question whose most recent revealed answer was wrong. Only subjects with at
 * least one are listed.
 *
 * `by_unit` and `by_difficulty` are two separate splits of `total`, not a
 * cross-tab: `by_unit` is keyed by the unit number as a string (a JSON
 * object's keys always are) and lists every unit of the subject, 0 included;
 * `by_difficulty` always carries all four tiers.
 */
export interface McqMistakeSummary {
  subject_code: string;
  total: number;
  by_unit: Record<string, number>;
  by_difficulty: Record<McqDifficulty, number>;
}
