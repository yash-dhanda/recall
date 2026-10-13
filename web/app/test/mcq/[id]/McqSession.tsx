"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/rich";
import { ErrorState, Kbd, Loading } from "@/components/ui";
import {
  ApiError,
  errorMessage,
  getMcqAttempt,
  isRevealed,
  postMcqAnswer,
  postMcqExamAnswer,
  submitMcqAttempt,
} from "@/lib/api";
import { plural } from "@/lib/format";
import { hasModifier, isTypingTarget } from "@/lib/keys";
import type { McqAttempt, McqFeedback, McqResult } from "@/lib/types";
import { McqCode, McqResultView, optionTextClass } from "./McqResultView";
import s from "./mcq.module.css";

const LETTERS = ["A", "B", "C", "D"];

/**
 * Past this many questions the segmented strip stops being one tick per
 * question and becomes a continuous bar with counts. Sixty is where a tick
 * still reads on a phone; the presets are 10/20/30/60, so every preset but
 * Full keeps its ticks.
 */
const TICK_LIMIT = 60;

/** What the strip shows for one drawn question. */
type TickState = "correct" | "wrong" | "pending";

/** Feedback for every position the server has already revealed. An open
 *  exam's answers carry no verdict and are never read as feedback. */
function recorded(attempt: McqAttempt): Record<number, McqFeedback> {
  const out: Record<number, McqFeedback> = {};
  for (const q of attempt.questions) {
    if (isRevealed(q.answer)) out[q.position] = q.answer;
  }
  return out;
}

/**
 * The clock turns amber when a fifth of the paper's time is left and the
 * wrong-red at a twentieth — the same thresholds as Recall's own exam screen.
 * Colour and weight only: a countdown that pulses is an invigilator tapping
 * the desk.
 */
const WARN_FRACTION = 0.2;
const DANGER_FRACTION = 0.05;

/** mm:ss — h:mm:ss only for a paper over an hour (a 200-question exam). */
function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Where an open exam's clock stands, fixed at the moment the attempt was read.
 *
 * `seconds_left` is measured by the server, so a phone whose own clock is
 * minutes out still counts down the server's time; `started_at +
 * time_limit_s` is the fallback. Either way it comes from the attempt, never
 * from when this page happened to open — a reload does not restart the paper.
 */
interface ExamClock {
  /** Epoch ms at which the limit is reached, on this device's clock. */
  deadline: number | null;
  /** Epoch ms when the attempt was read — the countdown's first "now". */
  readAt: number;
}

function examClock(a: McqAttempt, readAt: number): ExamClock {
  if (typeof a.seconds_left === "number") {
    return { deadline: readAt + a.seconds_left * 1000, readAt };
  }
  const started = Date.parse(a.started_at);
  if (a.time_limit_s && !Number.isNaN(started)) {
    return { deadline: started + a.time_limit_s * 1000, readAt };
  }
  return { deadline: null, readAt };
}

/**
 * One question at a time, revealed the moment it is answered.
 *
 * Deliberately lighter than the exam screen: no clock, no question palette,
 * no mark-for-review. This test is for learning the material, so the reveal
 * and the note under it are the whole interaction — the first click is the
 * answer and the server refuses a second, which is what makes the score
 * honest.
 *
 * That is PRACTICE. An attempt sat in exam mode loads here and is then handed
 * to <ExamSitting> below, which has the clock and the palette and reveals
 * nothing until the paper is submitted.
 */
export function McqSession({ id }: { id: number }) {
  const reduced = useReducedMotion();

  const [attempt, setAttempt] = useState<McqAttempt | null>(null);
  const [answers, setAnswers] = useState<Record<number, McqFeedback>>({});
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [busy, setBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<McqResult | null>(null);
  /** An open exam's clock, anchored when the attempt was read. */
  const [examAnchor, setExamAnchor] = useState<ExamClock | null>(null);
  /** True when an exam was collected by its clock rather than submitted. */
  const [timedOut, setTimedOut] = useState(false);

  /** A submitted attempt is scored once on open; the server hands back what
   *  it stored rather than re-scoring, so this is safe — but asking twice
   *  would still be a wasted round trip on the slowest link in the app. */
  const askedResult = useRef(false);

  useEffect(() => {
    let live = true;
    getMcqAttempt(id)
      .then((a) => {
        if (!live) return;
        setAttempt(a);
        setAnswers(recorded(a));
        setExamAnchor(
          a.mode === "exam" && a.submitted_at === null
            ? examClock(a, Date.now())
            : null,
        );
        const open = a.questions.findIndex((q) => !q.answer);
        setIdx(open >= 0 ? open : 0);
        setLoadError(null);

        if (a.submitted_at !== null && !askedResult.current) {
          askedResult.current = true;
          submitMcqAttempt(id)
            .then((r) => {
              if (live) setResult(r);
            })
            .catch((err: unknown) => {
              if (live) setLoadError(errorMessage(err));
            });
        }
      })
      .catch((err: unknown) => {
        if (live) setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id, reloadNonce]);

  /** An exam is sat by <ExamSitting>; nothing in this component may answer
   *  one, because the practice path reads every answer as a reveal. */
  const exam = attempt?.mode === "exam";

  const questions = useMemo(() => attempt?.questions ?? [], [attempt]);
  const total = questions.length;
  const question = questions[idx] ?? null;
  const feedback = question ? (answers[question.position] ?? null) : null;

  const answeredCount = Object.keys(answers).length;
  const correctCount = Object.values(answers).filter((f) => f.is_correct).length;

  /** One entry per drawn question, in draw order — what the strip paints. */
  const ticks = useMemo<TickState[]>(
    () =>
      questions.map((q) => {
        const fb = answers[q.position];
        if (!fb) return "pending";
        return fb.is_correct ? "correct" : "wrong";
      }),
    [questions, answers],
  );

  const goNext = useCallback(() => {
    setIdx((i) => Math.min(i + 1, Math.max(0, total - 1)));
  }, [total]);

  const goPrev = useCallback(() => {
    setIdx((i) => Math.max(0, i - 1));
  }, []);

  const answer = useCallback(
    (chosen: number) => {
      if (!question || result || busy || exam) return;
      if (answers[question.position]) return;
      const position = question.position;
      setBusy(true);
      setAnswerError(null);
      postMcqAnswer(id, position, chosen)
        .then((fb) => {
          setAnswers((prev) => ({ ...prev, [position]: fb }));
        })
        .catch((err: unknown) => {
          // 409 means this position was already answered — another tab, or a
          // double click that beat the guard. The server's record wins, so
          // re-read the attempt and carry on from what it says.
          if (err instanceof ApiError && err.status === 409) {
            return getMcqAttempt(id)
              .then((a) => {
                setAttempt(a);
                setAnswers(recorded(a));
              })
              .catch((again: unknown) => {
                setAnswerError(errorMessage(again));
              });
          }
          setAnswerError(errorMessage(err));
        })
        .finally(() => setBusy(false));
    },
    [id, question, answers, result, busy, exam],
  );

  const finish = useCallback(() => {
    if (!attempt || result || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    askedResult.current = true;
    submitMcqAttempt(id)
      .then(setResult)
      .catch((err: unknown) => {
        setSubmitError(errorMessage(err));
        setSubmitting(false);
      });
  }, [id, attempt, result, submitting]);

  useEffect(() => {
    if (result || !question || exam) return;
    function onKey(e: KeyboardEvent) {
      // Never while the focus is in a field: the picker has a number box, and
      // "typing 3 answers question 3" is the classic bug on this screen.
      if (isTypingTarget(e) || hasModifier(e)) return;
      // The arrow keys belong to a focused code block that is wider than its
      // box: they are how a keyboard reaches the end of a long line. A block
      // that fits has nothing to scroll, and swallowing the keys there would
      // leave them doing nothing at all — so they move between questions,
      // as they do everywhere else.
      if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        e.target instanceof Element
      ) {
        const block = e.target.closest("[data-mcq-code]");
        if (block && block.scrollWidth > block.clientWidth) return;
      }
      const revealed = !!(question && answers[question.position]);

      // One character only. `"1234".indexOf(e.key)` is 0 for an empty key —
      // and a key CAN arrive empty (synthetic events, some IME and remote
      // keyboards) — which would silently lock in option A on a question the
      // user never answered, and the server refuses to take it back.
      if (!revealed && e.key.length === 1) {
        const n = "1234".indexOf(e.key);
        if (n >= 0) {
          e.preventDefault();
          answer(n);
          return;
        }
        const letter = "abcd".indexOf(e.key.toLowerCase());
        if (letter >= 0) {
          e.preventDefault();
          answer(letter);
          return;
        }
      }

      if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
        return;
      }
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        finish();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer, answers, exam, finish, goNext, goPrev, question, result]);

  /* --- states ---------------------------------------------------------- */

  if (loading) {
    // Shaped like the sitting it stands in for — strip, chips, question,
    // four options — so nothing jumps when the attempt arrives.
    return (
      <main className={s.screen}>
        <header className={s.column}>
          <Skeleton className="h-3 w-44" />
          <Skeleton className="h-1.5 w-full mt-3" />
        </header>
        <div className={s.stage}>
          <div className={`${s.column} ${s.card}`} aria-hidden="true">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-full mt-4" />
            <Skeleton className="h-7 w-2/3 mt-2" />
            <div className="grid gap-2 mt-6">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[3.25rem] w-full" />
              ))}
            </div>
          </div>
        </div>
        <p className="telemetry text-[11px] text-fg-3" role="status">
          Opening the test&hellip;
        </p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className={s.screen}>
        <div className={s.stage}>
          <div className={s.column}>
            <ErrorState
              message={loadError}
              onRetry={() => {
                setLoading(true);
                setLoadError(null);
                // The score request is what usually failed here, and the guard
                // that stops it being asked twice would otherwise stop the retry
                // asking at all — leaving "Reading your score" on screen forever.
                askedResult.current = false;
                setReloadNonce((n) => n + 1);
              }}
            />
            <div className="mt-4 text-[13px]">
              <Link href="/test" className="link">
                Back to Test
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (result && attempt) {
    return (
      <McqResultView result={result} attempt={attempt} timedOut={timedOut} />
    );
  }

  if (attempt && attempt.submitted_at !== null) {
    // Submitted, and the score is still on its way back.
    return (
      <main className={s.screen}>
        <div className={s.stage}>
          <div className={s.column}>
            <Loading label="Reading your score" />
          </div>
        </div>
      </main>
    );
  }

  if (!attempt || !question) {
    return (
      <main className={s.screen}>
        <div className={s.stage}>
          <div className={s.column}>
            <p className="text-[15px]">This attempt has no questions.</p>
            <div className="mt-4 text-[13px]">
              <Link href="/test" className="link">
                Back to Test
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (exam) {
    return (
      <ExamSitting
        // A fresh read of the attempt is a fresh sitting state.
        key={`${attempt.attempt_id}:${reloadNonce}`}
        attempt={attempt}
        anchor={examAnchor ?? { deadline: null, readAt: 0 }}
        onResult={(r, byClock) => {
          askedResult.current = true;
          setTimedOut(byClock);
          setResult(r);
        }}
      />
    );
  }

  const chosen = feedback?.chosen ?? null;
  const correctIndex = feedback?.correct_index ?? null;
  const answered = feedback !== null;
  const onLast = idx >= total - 1;

  return (
    <main className={s.screen}>
      {/* --- where you are ------------------------------------------------ */}

      <header className={s.column}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
          <p className="telemetry text-[11.5px] text-fg-3">
            <span className="font-semibold tracking-[0.06em] text-fg-2">
              {attempt.subject_code}
            </span>
            <span className="mx-1.5">·</span>
            <span className="tnum font-medium text-fg">Q{idx + 1}</span>
            <span className="tnum"> / {total}</span>
            <span className="mx-1.5">·</span>
            <span className="tnum">{correctCount}</span> correct
          </p>
          <Link
            href="/test"
            className="text-[11.5px] text-fg-3 hover:text-fg-2 transition-colors duration-[90ms]"
          >
            leave — every answer is saved
          </Link>
        </div>

        <ProgressStrip ticks={ticks} current={idx} />
      </header>

      {/* --- the question -------------------------------------------------- */}

      <div className={s.stage}>
        <motion.article
          key={question.position}
          className={`${s.column} ${s.card}`}
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
        >
          <div className={s.chipRow}>
            <span className={s.chip}>{question.topic}</span>
            <span className={s.chipMuted}>{question.difficulty}</span>
            {question.kind === "situation" ? (
              <span className={s.chipMuted}>scenario</span>
            ) : null}
          </div>

          <h1 className={`k-question ${s.question}`}>{question.question}</h1>

          {/* The program the question is about, verbatim — between the
              question and the options, where it is read. */}
          <McqCode code={question.code} />

          {/* --- the options ----------------------------------------------- */}

          <div className={s.optionList} role="group" aria-label="Options">
            {question.options.map((option, i) => {
              const isCorrect = correctIndex !== null && i === correctIndex;
              const isChosenWrong = chosen === i && !feedback?.is_correct;
              const state = !answered
                ? ""
                : isCorrect
                  ? s.isCorrect
                  : isChosenWrong
                    ? s.isWrong
                    : s.isDimmed;
              const mark = !answered
                ? null
                : isCorrect
                  ? "correct"
                  : isChosenWrong
                    ? "your pick"
                    : null;

              return (
                <motion.button
                  key={i}
                  type="button"
                  disabled={answered || busy}
                  onClick={() => answer(i)}
                  whileTap={reduced || answered ? undefined : { scale: 0.995 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  aria-label={`${LETTERS[i]}. ${option}${
                    mark ? ` — ${mark === "correct" ? "correct answer" : "your answer, wrong"}` : ""
                  }`}
                  className={`${s.option} ${state}`}
                >
                  <span className={s.optionLetter} aria-hidden="true">
                    {LETTERS[i]}
                  </span>
                  <span className={optionTextClass(question.options_mono)}>
                    {option}
                  </span>
                  {mark ? (
                    <span className={s.optionMark} aria-hidden="true">
                      {mark}
                    </span>
                  ) : null}
                </motion.button>
              );
            })}
          </div>

          {answerError && (
            <div className="mt-3">
              <ErrorState message={answerError} />
            </div>
          )}

          {/* --- the reveal ------------------------------------------------- */}

          {/* The slot is always mounted so the live region exists before the
              answer lands; only its contents animate in. */}
          <div className={s.revealSlot} role="status" aria-live="polite">
            {feedback && (
              <div className={s.reveal}>
                <p
                  className={`${s.verdictLine} ${
                    feedback.is_correct ? s.isCorrect : s.isWrong
                  }`}
                >
                  {feedback.is_correct
                    ? "Correct."
                    : `Not quite — you picked ${LETTERS[feedback.chosen]}.`}
                  {!feedback.is_correct && (
                    <span className={s.verdictAside}>
                      {LETTERS[feedback.correct_index]} was right.
                    </span>
                  )}
                </p>

                <p className={s.teach}>{feedback.explain}</p>

                {!feedback.is_correct && feedback.why_wrong ? (
                  <div className={s.whyWrong}>
                    <p className={s.whyWrongLabel}>
                      Why {LETTERS[feedback.chosen]} is wrong
                    </p>
                    <p className={s.whyWrongText}>{feedback.why_wrong}</p>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* --- the keyboard, on the screen -------------------------------- */}

          <div className={s.hint}>
            <span className={s.hintGroup}>
              <Kbd>1</Kbd>
              <span aria-hidden="true">–</span>
              <Kbd>4</Kbd>
            </span>
            <span>or</span>
            <span className={s.hintGroup}>
              <Kbd>a</Kbd>
              <span aria-hidden="true">–</span>
              <Kbd>d</Kbd>
            </span>
            <span>answer</span>
            <span className={s.hintSep} aria-hidden="true">
              ·
            </span>
            <span className={s.hintGroup}>
              <Kbd>&crarr;</Kbd>
              <span>next</span>
            </span>
            <span className={s.hintSep} aria-hidden="true">
              ·
            </span>
            <span className={s.hintGroup}>
              <Kbd>f</Kbd>
              <span>finish</span>
            </span>
          </div>
        </motion.article>
      </div>

      {/* --- moving on ------------------------------------------------------ */}

      <footer className={`${s.column} ${s.actionsDock}`}>
        {submitError && (
          <div className="mb-3">
            <ErrorState message={submitError} onRetry={finish} />
          </div>
        )}

        <div className={s.actions}>
          {!onLast ? (
            <motion.button
              onClick={goNext}
              whileTap={reduced ? undefined : { scale: 0.98 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              /* The accent only arrives once the question is answered: before
                 that it would out-shout the options, which are the control
                 that matters. */
              className={
                answered
                  ? "accent-grad glow-accent-hover inline-flex items-center gap-2.5 h-11 px-4 rounded-sm text-[13px] font-semibold border border-accent"
                  : "inline-flex items-center gap-2.5 h-11 px-4 rounded-sm text-[13px] font-medium border border-line bg-surface text-fg-2 hover:border-line-strong hover:bg-surface-hover hover:text-fg transition-colors duration-[90ms]"
              }
            >
              Next question
              <Kbd>&crarr;</Kbd>
            </motion.button>
          ) : null}

          <button
            onClick={finish}
            disabled={submitting}
            className={`inline-flex items-center gap-2 h-11 px-4 rounded-sm text-[13px]
              font-medium border bg-surface transition-colors duration-[90ms]
              disabled:opacity-50 disabled:pointer-events-none ${
                answered && onLast
                  ? "border-accent text-accent hover:bg-accent-quiet"
                  : "border-line hover:border-line-strong hover:bg-surface-hover"
              }`}
          >
            {submitting
              ? "Scoring…"
              : `Finish & see score (${answeredCount} answered)`}
            <Kbd>f</Kbd>
          </button>

          {answeredCount < total && (
            <p className="text-[12px] text-fg-3">
              Unanswered questions score 0, out of all {total}.
            </p>
          )}
        </div>
      </footer>
    </main>
  );
}

/* --- the strip ------------------------------------------------------------ */

/**
 * One tick per drawn question, filling with the verdict colours as they are
 * answered and marked in the accent where you are standing. Past TICK_LIMIT
 * the ticks would be slivers, so it collapses to one continuous bar with the
 * counts spelled out beside it — the same information, still readable.
 *
 * Presentational: the ticks are not buttons, because nothing on this screen
 * jumps to an arbitrary question. The wrapper carries the progress semantics.
 */
function ProgressStrip({
  ticks,
  current,
}: {
  ticks: TickState[];
  current: number;
}) {
  const total = ticks.length;
  const correct = ticks.filter((t) => t === "correct").length;
  const wrong = ticks.filter((t) => t === "wrong").length;
  const answered = correct + wrong;

  const semantics = {
    role: "progressbar" as const,
    "aria-valuemin": 0,
    "aria-valuemax": total,
    "aria-valuenow": answered,
    "aria-label": "Questions answered",
    "aria-valuetext": `${answered} of ${total} answered, ${correct} correct`,
  };

  if (total > TICK_LIMIT) {
    const pct = (n: number) => (total > 0 ? (100 * n) / total : 0);
    return (
      <div>
        <div className={s.progressBar} {...semantics}>
          <span
            className={s.barGood}
            style={{ width: `${pct(correct)}%` }}
            aria-hidden="true"
          />
          <span
            className={s.barWrong}
            style={{ width: `${pct(wrong)}%` }}
            aria-hidden="true"
          />
          <span
            className={s.barCursor}
            style={{ left: `calc(${pct(current + 0.5)}% - 1px)` }}
            aria-hidden="true"
          />
        </div>
        <p className="telemetry text-[11px] text-fg-3 mt-1.5">
          <span className="tnum" style={{ color: "var(--g-good)" }}>
            {correct}
          </span>{" "}
          right
          <span className="mx-1.5">·</span>
          <span className="tnum" style={{ color: "var(--g-again)" }}>
            {wrong}
          </span>{" "}
          wrong
          <span className="mx-1.5">·</span>
          <span className="tnum">{total - answered}</span> to go
        </p>
      </div>
    );
  }

  return (
    <div className={s.progressStrip} {...semantics}>
      {ticks.map((t, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`${s.tick} ${
            t === "correct"
              ? s.tickCorrect
              : t === "wrong"
                ? s.tickWrong
                : s.tickPending
          } ${i === current ? s.tickCurrent : ""}`}
        />
      ))}
    </div>
  );
}

/* --- exam mode ------------------------------------------------------------ */

/**
 * An exam: timed, every question reachable from the palette, answers
 * changeable until submit, and not one word about correctness until then.
 *
 * The sealed property is the server's — an open exam's answer response and
 * its GET carry the choice and nothing else — and this component is built so
 * it could not show a verdict even if one arrived: it holds choices as bare
 * numbers, reads only `chosen` off a recorded answer, and never renders the
 * reveal. The result screen reveals everything at once.
 *
 * Answers go to the server one at a time, in the order they were clicked,
 * so the last choice made is the one stored. A choice superseded before its
 * turn is never sent at all, and submitting waits for the queue to drain.
 */
function ExamSitting({
  attempt,
  anchor,
  onResult,
}: {
  attempt: McqAttempt;
  anchor: ExamClock;
  /** `byClock` is true when the paper was collected by its clock. */
  onResult: (result: McqResult, byClock: boolean) => void;
}) {
  const id = attempt.attempt_id;
  const reduced = useReducedMotion();
  const questions = attempt.questions;
  const total = questions.length;

  /** Position -> chosen option, shown order. Read off the recorded answers by
   *  `chosen` ALONE: whatever else an answer object holds is not looked at. */
  const [choices, setChoices] = useState<Record<number, number>>(() => {
    const out: Record<number, number> = {};
    for (const q of questions) {
      if (q.answer && typeof q.answer.chosen === "number") {
        out[q.position] = q.answer.chosen;
      }
    }
    return out;
  });
  const [idx, setIdx] = useState(() => {
    const open = questions.findIndex((q) => !q.answer);
    return open >= 0 ? open : 0;
  });
  const [now, setNow] = useState(anchor.readAt);
  const [inFlight, setInFlight] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /** The answer queue: each post waits for the one before it. */
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** Per position, the sequence number of the newest click. */
  const latest = useRef<Record<number, number>>({});
  const seq = useRef(0);
  /** Per position, the choice the server last confirmed. */
  const saved = useRef<Record<number, number>>({ ...choices });
  /** One submit at a time; cleared again only if the submit fails. */
  const submittingRef = useRef(false);
  /** The clock collects the paper once, ever — a failed auto-submit is
   *  retried by hand, never by the next tick. */
  const autoFired = useRef(false);

  const deadline = anchor.deadline;
  const limitMs = (attempt.time_limit_s ?? 0) * 1000;
  const remainingMs =
    deadline === null ? null : Math.min(limitMs || Infinity, deadline - now);
  const timeUp = remainingMs !== null && remainingMs <= 0;
  const frac =
    remainingMs !== null && limitMs > 0
      ? Math.max(0, Math.min(1, remainingMs / limitMs))
      : null;
  const danger = frac !== null && frac <= DANGER_FRACTION;
  const warn = frac !== null && frac <= WARN_FRACTION;

  /** Nothing more can be chosen: the paper is going in, or its time is up. */
  const closed = submitting || timeUp;

  const question = questions[idx] ?? questions[0];
  const chosen = choices[question.position] ?? null;
  const answeredCount = Object.keys(choices).length;
  const onLast = idx >= total - 1;

  const finish = useCallback(
    (byClock: boolean) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setConfirming(false);
      setSubmitError(null);
      // After every answer already clicked has landed: the server takes an
      // answer until the limit plus its grace, so the last click counts.
      chain.current
        .then(() => submitMcqAttempt(id))
        .then((r) => onResult(r, byClock))
        .catch((err: unknown) => {
          submittingRef.current = false;
          setSubmitting(false);
          setSubmitError(errorMessage(err));
        });
    },
    [id, onResult],
  );

  // The clock, and the one thing it does: at zero it collects the paper as
  // it stands, exactly once. A paper opened after its time already ran out
  // is collected on the first tick.
  useEffect(() => {
    if (deadline === null || submitting) return;
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= deadline && !autoFired.current) {
        autoFired.current = true;
        finish(true);
      }
    }, 250);
    return () => clearInterval(t);
  }, [deadline, submitting, finish]);

  const choose = useCallback(
    (option: number) => {
      if (closed) return;
      const position = question.position;
      if (choices[position] === option) return;
      setChoices((prev) => ({ ...prev, [position]: option }));
      setSaveError(null);

      const mine = ++seq.current;
      latest.current[position] = mine;
      setInFlight((n) => n + 1);
      chain.current = chain.current
        .then(async () => {
          // Superseded before its turn: the newer click will say it.
          if (latest.current[position] !== mine) return;
          const res = await postMcqExamAnswer(id, position, option);
          saved.current[position] = res.chosen;
        })
        .catch((err: unknown) => {
          // 409: the time is up (limit plus grace) or the paper was closed
          // elsewhere. Either way nothing more can be answered — collect it.
          if (err instanceof ApiError && err.status === 409) {
            finish(/time/i.test(err.message) || Date.now() >= (deadline ?? Infinity));
            return;
          }
          if (latest.current[position] !== mine) return;
          // Put the palette and the option back to what the server holds, so
          // the screen never claims an answer that was not recorded.
          setChoices((prev) => {
            const next = { ...prev };
            const was = saved.current[position];
            if (was === undefined) delete next[position];
            else next[position] = was;
            return next;
          });
          setSaveError(
            `Question ${position}: your answer was not saved — ${errorMessage(err)}. Choose it again.`,
          );
        })
        .finally(() => setInFlight((n) => n - 1));
    },
    [closed, question.position, choices, id, finish, deadline],
  );

  const goTo = useCallback(
    (i: number) => setIdx(Math.max(0, Math.min(total - 1, i))),
    [total],
  );

  // The keyboard: 1-4 or a-d choose (and change), the arrows and Enter move,
  // f asks to submit. Never from a field, never with a modifier, and never
  // from inside the code block — a focused snippet keeps every key to itself.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e) || hasModifier(e)) return;
      if (e.target instanceof Element && e.target.closest("[data-mcq-code]")) {
        return;
      }

      if (confirming) {
        if (e.key === "Escape") {
          e.preventDefault();
          setConfirming(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          finish(deadline !== null && Date.now() >= deadline);
        }
        return;
      }

      // One character only: an empty key would otherwise match index 0.
      if (e.key.length === 1) {
        const n = "1234".indexOf(e.key);
        const letter = "abcd".indexOf(e.key.toLowerCase());
        const option = n >= 0 ? n : letter;
        if (option >= 0) {
          e.preventDefault();
          choose(option);
          return;
        }
      }

      if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        goTo(idx + 1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(idx - 1);
        return;
      }
      if (e.key.toLowerCase() === "f" && !submittingRef.current) {
        e.preventDefault();
        setConfirming(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, choose, deadline, finish, goTo, idx]);

  const clockClass = `${s.clock} ${danger ? s.clockDanger : warn ? s.clockWarn : ""}`;
  const timeWord = danger
    ? "almost out of time"
    : warn
      ? "a fifth of the time left"
      : "time left";

  return (
    <main className={s.screen}>
      {/* --- the invigilator's line ----------------------------------------- */}

      <header className={s.column}>
        <div className={s.examBar}>
          <p className="telemetry text-[11.5px] text-fg-3">
            <span className="font-semibold tracking-[0.06em] text-fg-2">
              {attempt.subject_code}
            </span>
            <span className="mx-1.5">·</span>
            <span className="font-semibold tracking-[0.06em] text-fg-2">
              EXAM
            </span>
            <span className="mx-1.5">·</span>
            <span className="tnum font-medium text-fg">Q{idx + 1}</span>
            <span className="tnum"> / {total}</span>
            <span className="mx-1.5">·</span>
            <span className="tnum">{answeredCount}</span> answered
          </p>

          {remainingMs !== null ? (
            <span
              className={clockClass}
              role="timer"
              aria-live="off"
              aria-label={`${clock(remainingMs)} ${timeWord}`}
              title={`${clock(remainingMs)} left of ${clock(limitMs)}`}
            >
              <span className={s.clockLabel} aria-hidden="true">
                {timeUp ? "time" : "left"}
              </span>
              <span aria-hidden="true">{clock(remainingMs)}</span>
            </span>
          ) : null}
        </div>

        <ExamPalette
          questions={questions.map((q) => q.position)}
          choices={choices}
          current={idx}
          onJump={goTo}
        />

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mt-1">
          <p className={s.paletteLegend}>
            <span className={s.legendItem}>
              <span className={`${s.swatch} ${s.swatchAnswered}`} aria-hidden="true" />
              <span className="tnum">{answeredCount}</span> answered
            </span>
            <span className={s.legendItem}>
              <span className={s.swatch} aria-hidden="true" />
              <span className="tnum">{total - answeredCount}</span> unanswered
            </span>
          </p>
          <Link
            href="/test"
            className="text-[11.5px] text-fg-3 hover:text-fg-2 transition-colors duration-[90ms]"
          >
            leave — answers are saved, the clock keeps running
          </Link>
        </div>

        {/* Crossing a threshold is said once, politely; the clock itself is
            not a live region — reading every second aloud is noise. */}
        <p className="sr-only" role="status" aria-live="polite">
          {timeUp
            ? "Time is up. The paper is being collected."
            : danger
              ? "Almost out of time."
              : warn
                ? "A fifth of the time is left."
                : ""}
        </p>
      </header>

      {/* --- the question -------------------------------------------------- */}

      <div className={s.stage}>
        <motion.article
          key={question.position}
          className={`${s.column} ${s.card}`}
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
        >
          <div className={s.chipRow}>
            <span className={s.chip}>{question.topic}</span>
            <span className={s.chipMuted}>{question.difficulty}</span>
            {question.kind === "situation" ? (
              <span className={s.chipMuted}>scenario</span>
            ) : null}
          </div>

          <h1 className={`k-question ${s.question}`}>{question.question}</h1>

          <McqCode code={question.code} />

          <div
            className={s.optionList}
            role="group"
            aria-label={`Options for question ${question.position}`}
          >
            {question.options.map((option, i) => {
              const on = chosen === i;
              return (
                <motion.button
                  key={i}
                  type="button"
                  disabled={closed}
                  aria-pressed={on}
                  onClick={() => choose(i)}
                  whileTap={reduced || closed ? undefined : { scale: 0.995 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  aria-label={`${LETTERS[i]}. ${option}${on ? " — your answer" : ""}`}
                  className={`${s.option} ${on ? s.isChosen : ""}`}
                >
                  <span className={s.optionLetter} aria-hidden="true">
                    {LETTERS[i]}
                  </span>
                  <span className={optionTextClass(question.options_mono)}>
                    {option}
                  </span>
                  {on ? (
                    <span className={s.optionMark} aria-hidden="true">
                      your answer
                    </span>
                  ) : null}
                </motion.button>
              );
            })}
          </div>

          {/* Saved, saving, or how to change it — never a verdict. */}
          <p className={s.examStatus} role="status" aria-live="polite">
            {timeUp
              ? "Time is up — the paper is being collected as it stands."
              : chosen === null
                ? "Choose one. You can change it until you submit."
                : inFlight > 0
                  ? "Saving…"
                  : `${LETTERS[chosen]} saved. You can change it until you submit.`}
          </p>

          {saveError && (
            <div className="mt-2">
              <ErrorState message={saveError} />
            </div>
          )}

          <div className={s.hint}>
            <span className={s.hintGroup}>
              <Kbd>1</Kbd>
              <span aria-hidden="true">–</span>
              <Kbd>4</Kbd>
            </span>
            <span>or</span>
            <span className={s.hintGroup}>
              <Kbd>a</Kbd>
              <span aria-hidden="true">–</span>
              <Kbd>d</Kbd>
            </span>
            <span>choose or change</span>
            <span className={s.hintSep} aria-hidden="true">
              ·
            </span>
            <span className={s.hintGroup}>
              <Kbd>&larr;</Kbd>
              <Kbd>&rarr;</Kbd>
              <span>move</span>
            </span>
            <span className={s.hintSep} aria-hidden="true">
              ·
            </span>
            <span className={s.hintGroup}>
              <Kbd>f</Kbd>
              <span>submit</span>
            </span>
          </div>
        </motion.article>
      </div>

      {/* --- moving on, and handing it in ----------------------------------- */}

      <footer className={`${s.column} ${s.actionsDock}`}>
        {submitError && (
          <div className="mb-3">
            <ErrorState message={submitError} onRetry={() => finish(timeUp)} />
          </div>
        )}

        <div className={s.actions}>
          {!onLast ? (
            <motion.button
              onClick={() => goTo(idx + 1)}
              whileTap={reduced ? undefined : { scale: 0.98 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className={
                chosen !== null
                  ? "accent-grad glow-accent-hover inline-flex items-center gap-2.5 h-11 px-4 rounded-sm text-[13px] font-semibold border border-accent"
                  : "inline-flex items-center gap-2.5 h-11 px-4 rounded-sm text-[13px] font-medium border border-line bg-surface text-fg-2 hover:border-line-strong hover:bg-surface-hover hover:text-fg transition-colors duration-[90ms]"
              }
            >
              Next question
              <Kbd>&crarr;</Kbd>
            </motion.button>
          ) : null}

          <button
            onClick={() => setConfirming(true)}
            disabled={submitting}
            className={`inline-flex items-center gap-2 h-11 px-4 rounded-sm text-[13px]
              font-medium border bg-surface transition-colors duration-[90ms]
              disabled:opacity-50 disabled:pointer-events-none ${
                onLast || answeredCount === total
                  ? "border-accent text-accent hover:bg-accent-quiet"
                  : "border-line hover:border-line-strong hover:bg-surface-hover"
              }`}
          >
            {submitting
              ? "Collecting…"
              : `Submit exam (${answeredCount} of ${total} answered)`}
            <Kbd>f</Kbd>
          </button>

          <p className="text-[12px] text-fg-3">
            Nothing is marked until you submit. Unanswered questions score 0.
          </p>
        </div>
      </footer>

      {confirming && (
        <ExamSubmitConfirm
          answered={answeredCount}
          total={total}
          remainingMs={remainingMs}
          saving={inFlight > 0}
          onCancel={() => setConfirming(false)}
          onSubmit={() => finish(timeUp)}
        />
      )}
    </main>
  );
}

/**
 * Every question as a cell to jump to: answered or not, and where you are.
 * Nothing here knows a verdict — there is none to know until submit.
 */
function ExamPalette({
  questions,
  choices,
  current,
  onJump,
}: {
  /** Positions, in draw order. */
  questions: number[];
  choices: Record<number, number>;
  /** Index into `questions`. */
  current: number;
  onJump: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  // Keep the current cell in view inside the palette's own scroller — by
  // moving that box only. scrollIntoView would scroll the page as well, and
  // an arrow key must never yank the question out from under the student.
  useEffect(() => {
    const el = box.current;
    const cell = el?.children[current] as HTMLElement | undefined;
    if (!el || !cell) return;
    const left = cell.offsetLeft - el.offsetLeft;
    const top = cell.offsetTop - el.offsetTop;
    if (left < el.scrollLeft) el.scrollLeft = left - 4;
    else if (left + cell.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = left + cell.offsetWidth - el.clientWidth + 4;
    }
    if (top < el.scrollTop) el.scrollTop = top - 2;
    else if (top + cell.offsetHeight > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + cell.offsetHeight - el.clientHeight + 2;
    }
  }, [current]);

  return (
    <div
      ref={box}
      className={s.palette}
      role="group"
      aria-label="Question palette"
    >
      {questions.map((position, i) => {
        const answered = choices[position] !== undefined;
        const isCurrent = i === current;
        return (
          <button
            key={position}
            type="button"
            onClick={() => onJump(i)}
            aria-current={isCurrent ? "true" : undefined}
            aria-label={`Question ${position}, ${answered ? "answered" : "unanswered"}`}
            className={`${s.paletteCell} ${answered ? s.paletteAnswered : ""} ${
              isCurrent ? s.paletteCurrent : ""
            }`}
          >
            {position}
          </button>
        );
      })}
    </div>
  );
}

/** "Submit this exam?" — what is answered, what is not, and that it is final. */
function ExamSubmitConfirm({
  answered,
  total,
  remainingMs,
  saving,
  onCancel,
  onSubmit,
}: {
  answered: number;
  total: number;
  remainingMs: number | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const left = total - answered;

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <motion.div
      className={s.dialogBackdrop}
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <motion.div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcq-submit-title"
        initial={reduced ? false : { opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.9 }}
        className={`glass ${s.dialog}`}
      >
        <header className="px-3 h-9 border-b border-line bg-sunken flex items-center">
          <h2 id="mcq-submit-title" className="label">
            Submit this exam
          </h2>
        </header>

        <div className="px-3.5 py-3">
          <p className="text-[15px] font-semibold">
            You have answered <span className="tnum">{answered}</span> of{" "}
            <span className="tnum">{total}</span>.
          </p>

          <dl className={`${s.dialogRows} mt-2.5`}>
            <dt>Answered</dt>
            <dd>
              {answered} of {total}
            </dd>
            <dt>Unanswered — score 0</dt>
            <dd>{left}</dd>
            {remainingMs !== null && (
              <>
                <dt>Still on the clock</dt>
                <dd>{clock(remainingMs)}</dd>
              </>
            )}
          </dl>

          <p className="text-[12.5px] text-fg-2 mt-3 pt-2.5 border-t border-line leading-snug">
            {left > 0 ? (
              <>
                <span className="font-semibold text-fg">
                  {left} {plural(left, "question")} unanswered
                </span>{" "}
                will score 0.{" "}
              </>
            ) : null}
            Your score, and every answer with its explanation, appear once you
            submit. Nothing can be changed after that.
            {saving ? " Your last answer is still saving — it goes in first." : ""}
          </p>
        </div>

        <footer className="px-3.5 py-2.5 border-t border-line flex flex-wrap items-center gap-2">
          <motion.button
            onClick={onSubmit}
            whileTap={reduced ? undefined : { scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            className="accent-grad glow-accent-hover inline-flex items-center gap-2.5 h-9 px-4
              rounded-sm text-[13px] font-semibold border border-accent"
          >
            Submit and see the result
            <Kbd>&crarr;</Kbd>
          </motion.button>
          <button
            onClick={onCancel}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-sm text-[13px] font-medium
              border border-line bg-surface hover:border-line-strong hover:bg-surface-hover
              transition-colors duration-[90ms]"
          >
            Keep going
            <Kbd>Esc</Kbd>
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
