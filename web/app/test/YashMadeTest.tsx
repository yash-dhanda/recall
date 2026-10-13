"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AnimatedNumber, Reveal, Skeleton } from "@/components/rich";
import { EmptyState, ErrorState, Panel, TopicCode } from "@/components/ui";
import {
  abandonMcqAttempt,
  createMcqAttempt,
  errorMessage,
  getMcqAttempts,
  getMcqLeaderboard,
  getMcqMistakes,
  getMcqSubjects,
} from "@/lib/api";
import { daysAgo, formatDuration, mediumDate, plural } from "@/lib/format";
import type {
  McqAttemptSummary,
  McqDifficulty,
  McqLength,
  McqMistakeSummary,
  McqMode,
  McqSource,
  McqSubject,
} from "@/lib/types";
import { useResource } from "@/lib/useResource";
import m from "./mcq/[id]/mcq.module.css";
import s from "./yashMadeTest.module.css";

/** Length is free choice now: any whole number in this range, or "full". */
const MIN_COUNT = 5;
const MAX_COUNT = 200;

/** The quick presets. The number box below them reaches everything else. */
const LENGTH_PRESETS: McqLength[] = [10, 20, 30, 60, "full"];

/** The ladder, in order. `null` is Mixed — a draw across all four, which is
 *  its own selection and its own board, not a merge of them. */
const DIFFICULTIES: McqDifficulty[] = ["easy", "medium", "hard", "max", "hardest"];

const DIFFICULTY_LABEL: Record<McqDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  max: "Max",
  hardest: "Hardest",
};

/** An exam's clock: one minute per question drawn. The server sets it; this
 *  is only what the picker prints before the draw. */
const EXAM_SECONDS_PER_QUESTION = 60;

const MODE_LABEL: Record<McqMode, string> = {
  practice: "Practice",
  exam: "Exam",
};

/** mm:ss, or h:mm:ss for a paper over an hour. */
function clockText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * How many pending mistakes a selection holds. The server splits a subject's
 * mistakes by unit and by tier separately, not as a cross-tab, so with a tier
 * AND a subset of units chosen the count is only known to lie in a range:
 * never more than either split allows, never fewer than the tier's mistakes
 * that cannot be in the units left out. `low === high` is an exact count —
 * which it is for Mixed, and for a tier across every unit that has any.
 */
function mistakesIn(
  summary: McqMistakeSummary | null,
  units: number[],
  difficulty: McqDifficulty | null,
): { low: number; high: number } {
  if (!summary) return { low: 0, high: 0 };
  const inUnits = units.reduce(
    (n, u) => n + (summary.by_unit[String(u)] ?? 0),
    0,
  );
  if (difficulty === null) return { low: inUnits, high: inUnits };
  const tier = summary.by_difficulty[difficulty] ?? 0;
  const outside = Math.max(0, summary.total - inUnits);
  return {
    low: Math.max(0, tier - outside),
    high: Math.min(inUnits, tier),
  };
}

/** "7", or "up to 7" when the count is a bound rather than a fact. */
function upTo(n: number, exact: boolean): string {
  return exact ? String(n) : `up to ${n}`;
}

/** Where the last subject chosen is remembered, per browser. */
const SUBJECT_KEY = "recall.mcq.subject";

function readStoredSubject(): string | null {
  try {
    return localStorage.getItem(SUBJECT_KEY);
  } catch {
    return null; // private mode, storage disabled, or the server render
  }
}

function storeSubject(code: string): void {
  try {
    localStorage.setItem(SUBJECT_KEY, code);
  } catch {
    /* ignore — remembering is a courtesy, not a requirement */
  }
}

function forgetSubject(): void {
  try {
    localStorage.removeItem(SUBJECT_KEY);
  } catch {
    /* ignore — as above */
  }
}

/** Every active question the subject holds, across all its units. */
function subjectTotal(subject: McqSubject): number {
  return subject.units.reduce((n, u) => n + u.count, 0);
}

/** The units of a subject that have questions — its default selection. */
function unitsWithMaterial(subject: McqSubject): number[] {
  return subject.units.filter((u) => u.count > 0).map((u) => u.unit);
}

/**
 * How a unit selection splits down the ladder. `null` when the server sends
 * no breakdown at all — an older server — in which case every tier stays
 * offered and the draw is simply whatever it holds.
 */
function tierCountsOf(
  subject: McqSubject | null,
  units: number[],
): Record<McqDifficulty, number> | null {
  const out: Record<McqDifficulty, number> = {
    easy: 0,
    medium: 0,
    hard: 0,
    max: 0,
    hardest: 0,
  };
  let known = false;
  for (const u of subject?.units ?? []) {
    if (!units.includes(u.unit) || !u.difficulties) continue;
    known = true;
    for (const d of DIFFICULTIES) out[d] += u.difficulties[d] ?? 0;
  }
  return known ? out : null;
}

function lengthLabel(length: McqLength): string {
  return length === "full" ? "Full" : String(length);
}

function difficultyLabel(difficulty: McqDifficulty | null): string {
  return difficulty === null ? "Mixed" : DIFFICULTY_LABEL[difficulty];
}

function unitList(units: number[]): string {
  if (units.length === 0) return "no units";
  return `${plural(units.length, "unit")} ${units.join(", ")}`;
}

/** "3 days ago" while it is still recent, the date once it is not. A sitting
 *  from this morning and one from March are read in different units. */
function relativeDate(value: string): string {
  const days = daysAgo(value);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return mediumDate(value);
}

/* --- the controls --------------------------------------------------------- */

/**
 * The mark beside a control that is chosen: a square where several may be
 * chosen, a dot where exactly one may be. It is the half of "chosen" that is
 * not colour — the accent alone never carries the meaning.
 */
function Mark({ round, on }: { round?: boolean; on: boolean }) {
  return (
    <span
      className={`${s.mark} ${round ? s.markRound : ""}`}
      aria-hidden="true"
    >
      {on ? <span className={s.markDot} /> : null}
    </span>
  );
}

/**
 * One subject: its code, its name, and how much of it is written. The first
 * step of building a paper, drawn in the same object language as the units
 * under it. A subject with nothing in the bank yet stays on the list, visibly
 * disabled and saying why — the same rule the units follow — rather than
 * vanishing and leaving the student to wonder whether it exists.
 */
function SubjectCard({
  subject,
  on,
  onClick,
}: {
  subject: McqSubject;
  on: boolean;
  onClick: () => void;
}) {
  const total = subjectTotal(subject);
  const note =
    total === 0 ? "waiting for material" : `${total} ${plural(total, "question")}`;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${subject.subject_code} — ${subject.label} — ${note}`}
      disabled={total === 0}
      onClick={onClick}
      className={`${s.press} ${s.subject} ${on ? s.on : ""}`}
    >
      <Mark round on={on} />
      <span className={s.subjectBody}>
        <span className={s.subjectCode}>{subject.subject_code}</span>
        <span className={s.subjectName}>{subject.label}</span>
        <span className={s.unitNote}>{note}</span>
      </span>
    </button>
  );
}

/**
 * One unit. A unit that cannot be chosen says why on its own line rather than
 * vanishing: a unit with no questions yet is waiting for material, not
 * missing from the course.
 */
function UnitCard({
  on,
  disabled,
  onClick,
  title,
  note,
  wide,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  note: string;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${title} — ${note}`}
      disabled={disabled}
      onClick={onClick}
      className={`${s.press} ${s.unit} ${on ? s.on : ""} ${wide ? s.wide : ""}`}
    >
      <Mark on={on} />
      <span className={s.unitBody}>
        <span className={s.unitName}>{title}</span>
        <span className={s.unitNote}>{note}</span>
      </span>
    </button>
  );
}

/**
 * One of two ways to do something — how to sit the paper, or where to draw it
 * from. A round mark, because exactly one is chosen; otherwise the unit card's
 * object language, so the builder reads as one instrument.
 */
function ChoiceCard({
  on,
  disabled,
  onClick,
  title,
  note,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  note: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label ?? `${title} — ${note}`}
      disabled={disabled}
      onClick={onClick}
      className={`${s.press} ${s.unit} ${on ? s.on : ""}`}
    >
      <Mark round on={on} />
      <span className={s.unitBody}>
        <span className={s.unitName}>{title}</span>
        <span className={s.choiceNote}>{note}</span>
      </span>
    </button>
  );
}

/**
 * The count under a rung. Five rungs share one row at every width, so the
 * rung can be as narrow as 52px — where "544 questions" bleeds through the
 * card edge. The number is its own span and the word is its own span, and
 * the stylesheet drops the word when the rung it sits in is too narrow to
 * hold it. The button's aria-label always carries the whole sentence.
 */
function TierNote({ n }: { n: number }) {
  return (
    <>
      {n}
      <span className={s.tierWord}> {plural(n, "question")}</span>
    </>
  );
}

/** One rung of the ladder — Mixed included, because Mixed is a rung and not
 *  the absence of one. */
function TierCard({
  on,
  disabled,
  onClick,
  title,
  note,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  note: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`${s.press} ${s.tier} ${on ? s.on : ""}`}
    >
      <Mark round on={on} />
      <span className={s.tierName}>{title}</span>
      <span className={s.tierNote}>{note}</span>
    </button>
  );
}

/* --- one row of history --------------------------------------------------- */

/**
 * A sitting you already have: resume it, review it, or drop it.
 *
 * A submitted attempt links to its own result screen, which is the review
 * sheet — every question missed, with the teaching note and why the option
 * picked was wrong. Without the link that sheet is reachable exactly once,
 * in the seconds after finishing, and the whole point of the mode is that
 * you go back to it.
 */
function AttemptRow({
  attempt,
  onDropped,
}: {
  attempt: McqAttemptSummary;
  onDropped: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = attempt.submitted_at === null;

  const drop = useCallback(() => {
    setBusy(true);
    setError(null);
    abandonMcqAttempt(attempt.id)
      .then(onDropped)
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
        setConfirming(false);
      });
  }, [attempt.id, onDropped]);

  const score = attempt.score ?? 0;
  const wrong = Math.max(0, attempt.answered - score);
  const share = (n: number) => (attempt.total > 0 ? (100 * n) / attempt.total : 0);
  const percent = attempt.total > 0 ? Math.round(share(score)) : 0;

  return (
    <li className={s.attemptRow}>
      <span className={s.attemptMeta}>
        {/* The same chip row the result sheet opens with: the subject in the
            bordered chip, everything narrowing it in the muted one. An
            unboxed TopicCode here left one bold code standing beside three
            boxed chips, which is the row reading in two idioms at once. */}
        <span className={m.chip}>{attempt.subject_code}</span>
        <span className={m.chipMuted}>{unitList(attempt.units)}</span>
        <span className={m.chipMuted}>{difficultyLabel(attempt.difficulty)}</span>
        <span className={m.chipMuted}>{lengthLabel(attempt.length)}</span>
        {/* Only what differs from the default sitting is named, so a row of
            ordinary practice reads exactly as it always has. */}
        {attempt.mode === "exam" ? <span className={m.chipMuted}>exam</span> : null}
        {attempt.source === "mistakes" ? (
          <span className={m.chipMuted}>my mistakes</span>
        ) : null}
      </span>

      {open ? (
        <span className={s.attemptScore}>
          <span className={m.chip}>open</span>
          <span className={s.scoreText}>
            {attempt.answered}/{attempt.total} answered
          </span>
        </span>
      ) : (
        <span className={s.attemptScore}>
          {/* The sitting screen's own bar, filled the same way: what was
              right, what was wrong, and the rest of the draw left as track. */}
          <span className={s.scoreBar}>
            <span className={m.progressBar} aria-hidden="true">
              <span className={m.barGood} style={{ width: `${share(score)}%` }} />
              <span className={m.barWrong} style={{ width: `${share(wrong)}%` }} />
            </span>
          </span>
          <span className={s.scoreText}>
            {score}/{attempt.total}
            <span className={s.scorePercent}>{percent}%</span>
          </span>
        </span>
      )}

      <span className={s.attemptDate}>{relativeDate(attempt.started_at)}</span>

      <span className={s.attemptActions}>
        {error && <span className={s.rowError}>{error}</span>}
        {confirming ? (
          <>
            <span className={s.rowAction}>Discard it?</span>
            <button
              onClick={drop}
              disabled={busy}
              className={`link ${s.rowAction} ${s.danger} disabled:opacity-50`}
            >
              {busy ? "dropping…" : "Yes, drop"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className={`link ${s.rowAction} text-fg-3 disabled:opacity-50`}
            >
              Keep
            </button>
          </>
        ) : open ? (
          <>
            <Link href={`/test/mcq/${attempt.id}`} className={`link ${s.rowAction}`}>
              Resume
            </Link>
            <button
              onClick={() => setConfirming(true)}
              className={`link ${s.rowAction} text-fg-3`}
            >
              Drop
            </button>
          </>
        ) : (
          <Link href={`/test/mcq/${attempt.id}`} className={`link ${s.rowAction}`}>
            Review
          </Link>
        )}
      </span>
    </li>
  );
}

/* --- the picker ----------------------------------------------------------- */

export function YashMadeTest() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const subjectsRes = useResource<McqSubject[]>("mcq-subjects", getMcqSubjects);
  const attemptsRes = useResource("mcq-attempts", getMcqAttempts);
  /** This user's pending mistakes per subject. A failure here costs only the
   *  "Practise my mistakes" option — the bank is still sat normally. */
  const mistakesRes = useResource("mcq-mistakes", getMcqMistakes);

  /** The subject this browser last chose, read once. Only ever consulted
   *  after the subject list has arrived from the network, so the server
   *  render — which cannot see localStorage — never disagrees with the
   *  first client render about what is on screen. */
  const [storedSubject] = useState<string | null>(readStoredSubject);

  /** Null until something is actually picked; the default is derived, not
   *  written into state by an effect. */
  const [picked, setPicked] = useState<{
    subject: string;
    units: number[];
  } | null>(null);
  const [length, setLength] = useState<McqLength>(30);
  /** What the number box currently reads. The clamp happens on blur, so
   *  half-typed numbers are allowed to exist while they are being typed. */
  const [countDraft, setCountDraft] = useState("30");
  /** True once the box has actually been TYPED IN since the last commit.
   *  Blur alone must not commit: with "Full" chosen the box still reads the
   *  last number, and tabbing through the picker would otherwise silently
   *  turn a Full sitting into a 30-question one — a different paper and a
   *  different leaderboard, chosen by a focus event. */
  const [countEdited, setCountEdited] = useState(false);
  /** The tier the student picked. What is actually drawn is derived below —
   *  a tier that holds nothing for the units now chosen falls back to Mixed
   *  rather than starting an attempt that cannot exist. */
  const [pickedDifficulty, setPickedDifficulty] = useState<McqDifficulty | null>(
    null,
  );
  /** Practice reveals each answer; an exam is timed and reveals at the end. */
  const [mode, setMode] = useState<McqMode>("practice");
  /** The source the student picked. What is drawn from is derived below: a
   *  mistakes pool that has emptied for this selection falls back to the
   *  bank, the same rule a tier that holds nothing follows. */
  const [pickedSource, setPickedSource] = useState<McqSource>("bank");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const subjects = useMemo(() => subjectsRes.data ?? [], [subjectsRes.data]);

  /** What was picked here; else what this browser chose last time, while it
   *  still has questions; else the first subject that actually has material,
   *  so the picker opens on something startable rather than on an empty one. */
  const subject = useMemo(() => {
    if (subjects.length === 0) return null;
    if (picked) {
      const named = subjects.find((x) => x.subject_code === picked.subject);
      if (named) return named;
    }
    if (storedSubject) {
      const remembered = subjects.find(
        (x) => x.subject_code === storedSubject && subjectTotal(x) > 0,
      );
      if (remembered) return remembered;
    }
    return subjects.find((x) => subjectTotal(x) > 0) ?? subjects[0];
  }, [subjects, picked, storedSubject]);

  /** A remembered subject the bank no longer offers — renamed, retired, or
   *  emptied — is forgotten once the list arrives, rather than lingering in
   *  storage to reappear the day a subject by that name next holds
   *  questions. Storage only: what is on screen is already the fallback.
   *  It reads storage afresh rather than the value read at mount, so a list
   *  that revalidates after a pick checks the pick, not what it replaced. */
  useEffect(() => {
    if (!subjectsRes.data) return;
    const now = readStoredSubject();
    if (now === null) return;
    const live = subjectsRes.data.some(
      (x) => x.subject_code === now && subjectTotal(x) > 0,
    );
    if (!live) forgetSubject();
  }, [subjectsRes.data]);

  /** Every unit that has questions — the "All units" selection, and the
   *  default one. */
  const allUnits = useMemo(
    () => (subject ? unitsWithMaterial(subject) : []),
    [subject],
  );

  const units = useMemo(() => {
    if (picked && subject && picked.subject === subject.subject_code) {
      return picked.units;
    }
    return allUnits;
  }, [picked, subject, allUnits]);

  const available = useMemo(
    () =>
      (subject?.units ?? [])
        .filter((u) => units.includes(u.unit))
        .reduce((n, u) => n + u.count, 0),
    [subject, units],
  );

  /** How the current unit selection splits down the ladder; null from a
   *  server older than the ladder. */
  const tierCounts = useMemo(
    () => tierCountsOf(subject, units),
    [subject, units],
  );

  const countOf = useCallback(
    (d: McqDifficulty | null): number => {
      if (d === null) return available;
      return tierCounts ? tierCounts[d] : available;
    },
    [available, tierCounts],
  );

  /** The tier actually in force: the pick, unless it has emptied under a
   *  change of units, in which case Mixed. Derived, not written by an
   *  effect — the same rule the unit default follows. */
  const difficulty = useMemo(() => {
    if (pickedDifficulty === null) return null;
    return countOf(pickedDifficulty) > 0 ? pickedDifficulty : null;
  }, [pickedDifficulty, countOf]);

  /** This subject's pending mistakes, or null when it has none. */
  const mistakeSummary = useMemo(
    () =>
      (mistakesRes.data ?? []).find(
        (x) => subject !== null && x.subject_code === subject.subject_code,
      ) ?? null,
    [mistakesRes.data, subject],
  );
  const hasMistakes = (mistakeSummary?.total ?? 0) > 0;

  /** Pending mistakes in the current units and tier — a range, see
   *  `mistakesIn`. */
  const mistakes = useMemo(
    () => mistakesIn(mistakeSummary, units, difficulty),
    [mistakeSummary, units, difficulty],
  );
  const mistakesExact = mistakes.low === mistakes.high;

  /** Where the draw comes from, in force: mistakes only while this selection
   *  can hold one. */
  const source: McqSource =
    pickedSource === "mistakes" && mistakes.high > 0 ? "mistakes" : "bank";

  /** Questions the selection holds — units AND tier, from the source in
   *  force. For mistakes this is the upper bound. */
  const bankSelectable = countOf(difficulty);
  const selectable = source === "mistakes" ? mistakes.high : bankSelectable;
  /** False only when the mistakes count is a bound, not a fact. */
  const exact = source === "bank" || mistakesExact;

  /** Presets, plus anything else this subject suggests, "Full" last. */
  const lengths: McqLength[] = useMemo(() => {
    const seen = new Set<string>();
    const out: McqLength[] = [];
    for (const l of [...LENGTH_PRESETS, ...(subject?.lengths ?? [])]) {
      const k = String(l);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    return out.sort((a, b) => {
      if (a === "full") return 1;
      if (b === "full") return -1;
      return a - b;
    });
  }, [subject]);

  /** True when the number box holds something the presets do not offer. */
  const customCount =
    typeof length === "number" && !lengths.some((l) => l === length);

  const pickLength = useCallback((l: McqLength) => {
    setLength(l);
    setCountEdited(false);
    if (l !== "full") setCountDraft(String(l));
  }, []);

  /** Clamp on blur: 5–200, and a number nobody typed is put back. A blur
   *  that follows no typing commits nothing — see `countEdited`. */
  const commitCount = useCallback(() => {
    if (!countEdited) return;
    setCountEdited(false);
    const n = Number.parseInt(countDraft, 10);
    if (!Number.isFinite(n)) {
      setCountDraft(length === "full" ? "" : String(length));
      return;
    }
    const clamped = Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));
    setCountDraft(String(clamped));
    setLength(clamped);
  }, [countDraft, countEdited, length]);

  const setUnits = useCallback(
    (next: number[]) => {
      if (!subject) return;
      setPicked({
        subject: subject.subject_code,
        units: [...next].sort((a, b) => a - b),
      });
    },
    [subject],
  );

  const toggleUnit = useCallback(
    (unit: number) => {
      setUnits(
        units.includes(unit) ? units.filter((u) => u !== unit) : [...units, unit],
      );
    },
    [units, setUnits],
  );

  /**
   * A new subject is a new paper: its units reset to every unit it has
   * material for, and the tier on show carries over only if the new subject
   * holds questions at it — otherwise Mixed. What is written into state is
   * the tier that was ON SCREEN, not a pick that had already quietly fallen
   * back to Mixed, so a switch never brings back a tier the student could
   * not see was still chosen. Choosing the subject already chosen changes
   * nothing: it must not throw away a unit selection.
   */
  const pickSubject = useCallback(
    (next: McqSubject) => {
      if (subject && next.subject_code === subject.subject_code) return;
      const nextUnits = unitsWithMaterial(next);
      setPicked({ subject: next.subject_code, units: nextUnits });
      storeSubject(next.subject_code);
      const counts = tierCountsOf(next, nextUnits);
      setPickedDifficulty(
        difficulty !== null && (counts === null || counts[difficulty] > 0)
          ? difficulty
          : null,
      );
    },
    [subject, difficulty],
  );

  // A selection is subject + units + length + difficulty + mode, and that
  // whole tuple keys the board: Easy/30 and Hard/30 are different boards,
  // Mixed is its own, and exam scores rank only against exam scores. A
  // mistakes sitting has no board at all, so nothing is fetched for one.
  const boardKey =
    subject && source === "bank"
      ? `mcq-board:${subject.subject_code}:${units.join(",")}:${length}:${
          difficulty ?? "mixed"
        }:${mode}`
      : "mcq-board:none";

  const fetchBoard = useCallback(() => {
    if (!subject || units.length === 0 || source !== "bank") {
      return Promise.resolve([]);
    }
    return getMcqLeaderboard(
      subject.subject_code,
      units,
      length,
      difficulty,
      mode,
    );
    // The key carries the selection, so the fetcher is allowed to close over
    // it: useResource refetches whenever the key changes.
  }, [subject, units, length, difficulty, mode, source]);

  const boardRes = useResource(boardKey, fetchBoard);

  const start = useCallback(() => {
    if (!subject || starting || selectable === 0) return;
    setStarting(true);
    setStartError(null);
    createMcqAttempt(
      subject.subject_code,
      units,
      length,
      difficulty,
      mode,
      source,
    )
      .then((a) => router.push(`/test/mcq/${a.attempt_id}`))
      .catch((err: unknown) => {
        setStartError(errorMessage(err));
        setStarting(false);
      });
  }, [
    subject,
    units,
    length,
    difficulty,
    mode,
    source,
    selectable,
    starting,
    router,
  ]);

  const attempts = useMemo(() => attemptsRes.data ?? [], [attemptsRes.data]);
  const drawn = length === "full" ? selectable : Math.min(length, selectable);

  /**
   * Which board rows are yours, worked out from the attempts already on this
   * screen rather than from a round trip for your identity: a submitted
   * attempt of yours for exactly this selection, matched to the row by the
   * instant it was submitted and the score it got. A board row that predates
   * the attempts the server returned simply goes unmarked — quietly, which is
   * the right failure for a decoration.
   */
  const mine = useMemo(() => {
    const keys = new Set<string>();
    if (!subject) return keys;
    for (const a of attempts) {
      if (a.submitted_at === null || a.score === null) continue;
      if (a.subject_code !== subject.subject_code) continue;
      if (a.mode !== mode || a.source !== "bank") continue;
      if (String(a.length) !== String(length)) continue;
      if ((a.difficulty ?? null) !== difficulty) continue;
      if (
        a.units.length !== units.length ||
        !a.units.every((u) => units.includes(u))
      ) {
        continue;
      }
      keys.add(`${a.submitted_at}|${a.score}`);
    }
    return keys;
  }, [attempts, subject, units, length, difficulty, mode]);

  if (subjectsRes.loading && !subjectsRes.data) {
    return (
      <div className={s.wrap} aria-label="Reading the question bank">
        <div className={s.layout}>
          <div className="panel p-4">
            <Skeleton className="h-3 w-40" />
            <div className="grid gap-2 mt-4 sm:grid-cols-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
            <Skeleton className="h-12 w-full mt-2" />
            <Skeleton className="h-11 w-full mt-4" />
            <Skeleton className="h-11 w-44 mt-4" />
          </div>
          <div className="panel p-4">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-full mt-4" />
            <Skeleton className="h-3 w-4/5 mt-2" />
          </div>
        </div>
      </div>
    );
  }

  if (subjectsRes.error && !subjectsRes.data) {
    return (
      <ErrorState message={subjectsRes.error} onRetry={subjectsRes.reload} />
    );
  }

  if (!subject) {
    return (
      <Panel title="Yash Made Test">
        <EmptyState>
          The bank is empty — no subject has questions written for it yet.
        </EmptyState>
      </Panel>
    );
  }

  const allUnitsOn =
    allUnits.length > 0 &&
    units.length === allUnits.length &&
    allUnits.every((u) => units.includes(u));

  const drawLine =
    selectable === 0
      ? "nothing in this selection yet"
      : source === "mistakes"
        ? length === "full"
          ? `full — all ${upTo(selectable, exact)} of your mistakes`
          : length > selectable
            ? `only ${upTo(selectable, exact)} ${plural(selectable, "mistake")} — you will get ${exact ? "" : "up to "}${selectable}`
            : `${drawn} of ${upTo(selectable, exact)} ${plural(selectable, "mistake")} · any number ${MIN_COUNT}–${MAX_COUNT}`
        : length === "full"
          ? `full — all ${selectable} of them`
          : length > selectable
            ? `only ${selectable} available — you will get ${selectable}`
            : `${drawn} of ${selectable} available · any number ${MIN_COUNT}–${MAX_COUNT}`;

  /** What Start says: how many, and — for an exam — how long. The practice
   *  wording from the bank is unchanged. */
  const examClock = clockText(drawn * EXAM_SECONDS_PER_QUESTION);
  const lead = exact ? "" : "up to ";
  const startLabel =
    source === "mistakes"
      ? mode === "exam"
        ? `Start ${lead}${drawn}-question exam of your mistakes · ${examClock}`
        : `Practise ${lead}${drawn} ${plural(drawn, "mistake")}`
      : mode === "exam"
        ? `Start ${drawn}-question${difficulty ? ` ${difficulty}` : ""} exam · ${examClock}`
        : `Start ${drawn}${difficulty ? ` ${difficulty}` : ""} ${plural(
            drawn,
            "question",
          )}`;

  const mistakesTitle = `Practise my mistakes (${upTo(mistakes.high, mistakesExact)})`;

  return (
    <div className={s.wrap}>
      <div className={s.layout}>
        {/* --- the paper being built ------------------------------------- */}

        <section className={`panel ${s.builder}`} aria-label="Build the paper">
          <div className={s.head}>
            {/* The paper's title: whichever subject the first group has
                chosen, restated where the paper begins. */}
            <span className={s.headSubject}>
              <TopicCode code={subject.subject_code} />
              <span className={s.headLabel}>{subject.label}</span>
            </span>
            <span className={s.meta}>
              {available} {plural(available, "question")} in these units
            </span>
          </div>

          {/* --- subject -------------------------------------------------
              The first step, in the same label gutter as the rest. One
              subject is not a choice, so with one the head above is the
              whole story and this group does not appear. */}

          {subjects.length > 1 && (
            <div className={s.group} role="group" aria-labelledby="ymt-subject">
              <h2 id="ymt-subject" className={`label ${s.groupLabel}`}>
                Subject
              </h2>
              <div className={`${s.groupBody} ${s.subjectField}`}>
                <div
                  className={s.subjectGrid}
                  style={
                    {
                      "--subject-cols":
                        subjects.length <= 3
                          ? subjects.length
                          : subjects.length === 4
                            ? 2
                            : 3,
                    } as CSSProperties
                  }
                >
                  {subjects.map((x) => (
                    <SubjectCard
                      key={x.subject_code}
                      subject={x}
                      on={x.subject_code === subject.subject_code}
                      onClick={() => pickSubject(x)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* --- units --------------------------------------------------- */}

          <div className={s.group} role="group" aria-labelledby="ymt-units">
            <h2 id="ymt-units" className={`label ${s.groupLabel}`}>
              Units
            </h2>
            <div className={s.groupBody}>
              <div className={s.unitGrid}>
                {subject.units.map((u) => (
                  <UnitCard
                    key={u.unit}
                    on={units.includes(u.unit)}
                    disabled={u.count === 0}
                    onClick={() => toggleUnit(u.unit)}
                    title={`Unit ${u.unit} — ${u.label}`}
                    note={
                      u.count === 0
                        ? "waiting for material"
                        : `${u.count} ${plural(u.count, "question")}`
                    }
                  />
                ))}
                {allUnits.length > 1 && (
                  <UnitCard
                    wide
                    on={allUnitsOn}
                    onClick={() => setUnits(allUnits)}
                    title="All units"
                    note={`${allUnits.length} units with material · ${available} questions in the selection`}
                  />
                )}
              </div>
            </div>
          </div>

          {/* --- difficulty ---------------------------------------------- */}

          <div className={s.group} role="group" aria-labelledby="ymt-tier">
            <h2 id="ymt-tier" className={`label ${s.groupLabel}`}>
              Tier
            </h2>
            <div className={s.groupBody}>
              <div className={s.ladder}>
                <TierCard
                  on={difficulty === null}
                  onClick={() => setPickedDifficulty(null)}
                  title="Mixed"
                  note={<TierNote n={available} />}
                  label={`Mixed — ${available} ${plural(
                    available,
                    "question",
                  )} across all four tiers`}
                />
                {DIFFICULTIES.map((d) => {
                  const n = countOf(d);
                  return (
                    <TierCard
                      key={d}
                      on={difficulty === d}
                      disabled={n === 0}
                      onClick={() => setPickedDifficulty(d)}
                      title={DIFFICULTY_LABEL[d]}
                      note={n === 0 ? "none yet" : <TierNote n={n} />}
                      label={
                        n === 0
                          ? `${DIFFICULTY_LABEL[d]} — no questions at this tier in these units yet`
                          : `${DIFFICULTY_LABEL[d]} — ${n} ${plural(
                              n,
                              "question",
                            )}`
                      }
                    />
                  );
                })}
              </div>
              <p className={s.note}>
                Easy: straight definitions. Medium: telling similar things
                apart. Hard: work out which idea applies. Max: the tricky ones. Hardest: every option is the same length.
              </p>
            </div>
          </div>

          {/* --- where from ----------------------------------------------
              Only once this subject has mistakes to practise: a student who
              has never answered wrongly has nothing to choose between. */}

          {hasMistakes && (
            <div className={s.group} role="group" aria-labelledby="ymt-source">
              <h2 id="ymt-source" className={`label ${s.groupLabel}`}>
                From
              </h2>
              <div className={s.groupBody}>
                <div className={s.choiceGrid}>
                  <ChoiceCard
                    on={source === "bank"}
                    onClick={() => setPickedSource("bank")}
                    title="The whole bank"
                    note={`${bankSelectable} ${plural(bankSelectable, "question")} in this selection`}
                  />
                  <ChoiceCard
                    on={source === "mistakes"}
                    disabled={mistakes.high === 0}
                    onClick={() => setPickedSource("mistakes")}
                    title={mistakesTitle}
                    note={
                      mistakes.high === 0
                        ? difficulty === null
                          ? "none in these units — pick another unit"
                          : `none at ${difficulty} in these units — pick another tier`
                        : "questions you last got wrong"
                    }
                  />
                </div>
                <p className={s.note}>
                  Your mistakes are every question whose last answer you were
                  shown was wrong. Get one right and it leaves the list;
                  questions you skipped never join it.
                </p>
              </div>
            </div>
          )}

          {/* --- how many ------------------------------------------------ */}

          <div className={s.group} role="group" aria-labelledby="ymt-count">
            <h2 id="ymt-count" className={`label ${s.groupLabel}`}>
              How many
            </h2>
            <div className={s.groupBody}>
              <div className={s.lengthGrid}>
                {lengths.map((l) => {
                  const on = l === length;
                  const short =
                    l !== "full" && selectable > 0 && selectable < Number(l);
                  return (
                    <button
                      key={String(l)}
                      type="button"
                      aria-pressed={on}
                      aria-label={
                        l === "full"
                          ? `Full — every question in the selection, ${selectable} right now`
                          : `${l} questions${
                              short ? `, only ${selectable} available` : ""
                            }`
                      }
                      onClick={() => pickLength(l)}
                      className={`${s.press} ${s.preset} ${on ? s.on : ""}`}
                    >
                      <span className={s.presetHead}>
                        <Mark round on={on} />
                        <span className={s.presetName}>{lengthLabel(l)}</span>
                      </span>
                      {l === "full" ? (
                        <span className={s.presetNote}>all {selectable}</span>
                      ) : short ? (
                        <span className={s.presetNote}>&rarr; {selectable}</span>
                      ) : null}
                    </button>
                  );
                })}

                {/* The free number, as its own full-width row — the same
                    shape "All units" makes above it. */}
                <label
                  className={`${s.field} ${s.wide} ${customCount ? s.on : ""}`}
                >
                  <Mark round on={customCount} />
                  <span className={s.anyLabel}>any number</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN_COUNT}
                    max={MAX_COUNT}
                    step={1}
                    value={countDraft}
                    onChange={(e) => {
                      setCountDraft(e.target.value);
                      setCountEdited(true);
                    }}
                    onBlur={commitCount}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                    aria-label={`How many questions, ${MIN_COUNT} to ${MAX_COUNT}`}
                    className={s.anyInput}
                  />
                  <span className={s.meta}>
                    {MIN_COUNT}&ndash;{MAX_COUNT}
                  </span>
                </label>
              </div>
              <p className={s.meta}>{drawLine}</p>
            </div>
          </div>

          {/* --- how it is sat --------------------------------------------- */}

          <div className={s.group} role="group" aria-labelledby="ymt-mode">
            <h2 id="ymt-mode" className={`label ${s.groupLabel}`}>
              Mode
            </h2>
            <div className={s.groupBody}>
              <div className={s.choiceGrid}>
                <ChoiceCard
                  on={mode === "practice"}
                  onClick={() => setMode("practice")}
                  title="Practice"
                  note="instant answer and explanation after every question"
                />
                <ChoiceCard
                  on={mode === "exam"}
                  onClick={() => setMode("exam")}
                  title="Exam"
                  note="timed, one minute a question, score only at the end"
                />
              </div>
            </div>
          </div>

          {/* --- start ---------------------------------------------------- */}

          {startError && <ErrorState message={startError} />}

          <div className={s.startBar}>
            <motion.button
              onClick={start}
              disabled={starting || selectable === 0}
              whileTap={reduced ? undefined : { scale: 0.98 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className="glow-behind accent-grad glow-accent-hover inline-flex items-center gap-2.5
                h-11 px-4 rounded-sm text-[13px] font-semibold border border-accent
                disabled:opacity-40 disabled:pointer-events-none"
            >
              {starting ? "Shuffling…" : startLabel}
            </motion.button>
            {selectable === 0 ? (
              <p className={s.startNote}>
                {difficulty === null
                  ? "Pick a unit that has questions."
                  : `No ${difficulty} questions in these units yet — pick another tier.`}
              </p>
            ) : mode === "exam" ? (
              <p className={s.startNote}>
                The clock starts at once. Nothing is marked until you submit.
              </p>
            ) : (
              <p className={s.startNote}>
                Nothing here touches your review schedule.
              </p>
            )}
          </div>
        </section>

        {/* --- what is about to be sat, and who has sat it ---------------- */}

        <div className={s.rail}>
          <Reveal>
            <Panel title="The paper" aside={subject.subject_code}>
              <div className={s.summary}>
                <div>
                  <p className={s.drawRow}>
                    <span className={s.drawNumber}>
                      <AnimatedNumber value={drawn} />
                    </span>
                    <span className={s.drawWord}>
                      {plural(drawn, "question")} drawn
                    </span>
                  </p>
                  <p className={`${s.meta} mt-1.5`}>
                    {selectable === 0
                      ? "nothing in this selection yet"
                      : source === "mistakes"
                        ? `drawn from ${upTo(selectable, exact)} of your mistakes`
                        : `drawn from ${selectable} in this selection`}
                  </p>
                </div>

                <dl className={s.spec}>
                  <dt className={`label ${s.specKey}`}>Subject</dt>
                  <dd className={s.specValue}>
                    {subject.subject_code} — {subject.label}
                  </dd>

                  <dt className={`label ${s.specKey}`}>Units</dt>
                  <dd className={s.specValue}>
                    {units.length === 0
                      ? "none chosen"
                      : allUnitsOn
                        ? `all — ${units.join(", ")}`
                        : units.join(", ")}
                  </dd>

                  <dt className={`label ${s.specKey}`}>Tier</dt>
                  <dd className={s.specValue}>{difficultyLabel(difficulty)}</dd>

                  <dt className={`label ${s.specKey}`}>Asked for</dt>
                  <dd className={s.specValue}>
                    {length === "full"
                      ? "Full — everything in the selection"
                      : `${length} ${plural(Number(length), "question")}`}
                  </dd>

                  <dt className={`label ${s.specKey}`}>From</dt>
                  <dd className={s.specValue}>
                    {source === "mistakes"
                      ? "Your mistakes — not ranked"
                      : "The whole bank"}
                  </dd>

                  <dt className={`label ${s.specKey}`}>Mode</dt>
                  <dd className={s.specValue}>
                    {mode === "exam"
                      ? "Exam — score only at the end"
                      : "Practice — answer after every question"}
                  </dd>

                  {mode === "exam" && (
                    <>
                      <dt className={`label ${s.specKey}`}>Time</dt>
                      <dd className={`${s.specValue} tnum`}>
                        {exact ? "" : "up to "}
                        {examClock} — one minute a question
                      </dd>
                    </>
                  )}
                </dl>

                <p className={s.summaryNote}>
                  {mode === "exam"
                    ? "Timed like the CA: nothing is marked until you submit, and you can change an answer until then. At 00:00 the paper is collected as it stands."
                    : "The questions are drawn fresh and the four options are shuffled again every attempt, so two sittings never look the same."}{" "}
                  Unanswered questions score 0 against the whole draw.
                </p>
              </div>
            </Panel>
          </Reveal>

          <Reveal index={1}>
            <Panel
              title="Leaderboard"
              aside={`${subject.subject_code} · ${lengthLabel(length)} · ${difficultyLabel(difficulty)} · ${MODE_LABEL[mode]}`}
            >
              {source === "mistakes" ? (
                <p className={s.boardNote}>
                  Practising your own mistakes isn&rsquo;t ranked — every
                  student&rsquo;s list is different, so there is nothing to
                  compare.
                </p>
              ) : boardRes.error && !boardRes.data ? (
                <ErrorState message={boardRes.error} onRetry={boardRes.reload} />
              ) : boardRes.loading && !boardRes.data ? (
                <div className={s.skeletonRows}>
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-3 w-full" />
                  ))}
                </div>
              ) : (boardRes.data ?? []).length === 0 ? (
                <EmptyState>Nobody has sat this yet — be first.</EmptyState>
              ) : (
                <ul>
                  {(boardRes.data ?? []).map((row, i) => {
                    const yours = mine.has(`${row.submitted_at}|${row.score}`);
                    const percent =
                      row.total > 0
                        ? Math.round((100 * row.score) / row.total)
                        : 0;
                    return (
                      <li
                        key={`${row.user_id}-${row.submitted_at}`}
                        className={`${s.boardRow} ${yours ? s.you : ""}`}
                      >
                        <span className={s.rank}>#{i + 1}</span>
                        <span className={s.nameCell}>
                          <span className={s.name}>{row.name}</span>
                          {yours ? <span className={m.chip}>you</span> : null}
                        </span>
                        <span className={s.boardScore}>
                          {row.score}/{row.total}
                        </span>
                        <span className={s.boardMeta}>
                          {percent}% · {formatDuration(row.duration_s * 1000)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </Reveal>
        </div>
      </div>

      {/* --- what you have already sat ---------------------------------- */}

      <Reveal index={2} className={s.attempts}>
        <Panel
          title="Your attempts"
          aside={attempts.length ? `${attempts.length}` : undefined}
        >
          {attemptsRes.error && !attemptsRes.data ? (
            <ErrorState
              message={attemptsRes.error}
              onRetry={attemptsRes.reload}
            />
          ) : attemptsRes.loading && !attemptsRes.data ? (
            <div className={s.skeletonRows}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
          ) : attempts.length === 0 ? (
            <EmptyState>
              You have not sat this test yet. Pick a unit and press Start —
              nothing here touches your review schedule.
            </EmptyState>
          ) : (
            <ul>
              {attempts.slice(0, 8).map((a) => (
                <AttemptRow
                  key={a.id}
                  attempt={a}
                  onDropped={attemptsRes.reload}
                />
              ))}
            </ul>
          )}
        </Panel>
      </Reveal>
    </div>
  );
}
