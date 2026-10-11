"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useState, type ReactNode } from "react";
import { AnimatedNumber, ProgressRing, Reveal } from "@/components/rich";
import { ErrorState, Panel } from "@/components/ui";
import { createMcqAttempt, errorMessage } from "@/lib/api";
import { formatDuration, plural } from "@/lib/format";
import type { McqAttempt, McqDifficulty, McqResult } from "@/lib/types";
import s from "./mcq.module.css";

const LETTERS = ["A", "B", "C", "D"];

/** The ladder, in order — how a difficulty breakdown is always printed. */
const DIFFICULTY_ORDER: McqDifficulty[] = ["easy", "medium", "hard", "max", "hardest"];

/** One line, and it has to be worth reading: what to do next, not praise. */
function verdict(percent: number): string {
  if (percent >= 80) return "Ready.";
  if (percent >= 60) return "Solid — revisit the weak topics.";
  return "Go back to the material for the topics below.";
}

/** A bar earns its colour: good at 80%, hard at 50%, again below. */
function toneFor(ratio: number): string {
  if (ratio >= 0.8) return "var(--g-good)";
  if (ratio >= 0.5) return "var(--g-hard)";
  return "var(--g-again)";
}

/**
 * Blank lines at either end go, and Windows line endings become plain ones.
 * Nothing else is touched: the first line keeps its indentation, every
 * interior space and tab stays where it was typed, because in Python that
 * whitespace is the program.
 */
function tidyCode(code: string): string {
  return code
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");
}

/** The option text's class: prose in --k-face, or code kept as written. */
export function optionTextClass(mono: boolean | undefined): string {
  return mono ? `${s.optionText} ${s.optionTextMono}` : s.optionText;
}

/**
 * The program a question is about, drawn identically on the sitting and on
 * the review sheet — the review is the same object as the question, so the
 * code a student got wrong is the code they read again.
 *
 * Verbatim in a monospace block that scrolls sideways inside itself and never
 * wraps. It is focusable because it can scroll: a keyboard user has to be
 * able to reach the end of a long line, and a region nobody can focus is one
 * nobody without a pointer can read. `data-mcq-code` is how the sitting's
 * keyboard handler knows to leave the arrow keys to the block — while the
 * block overflows; one that fits lets them move between questions.
 *
 * Renders nothing for a question without code — absent, null and "" alike.
 */
export function McqCode({
  code,
  label = "Code",
}: {
  code: string | null | undefined;
  label?: string;
}) {
  const text = code ? tidyCode(code) : "";
  if (text.trim() === "") return null;
  return (
    <pre
      className={s.codeBlock}
      role="region"
      aria-label={label}
      tabIndex={0}
      data-mcq-code=""
    >
      <code>{text}</code>
    </pre>
  );
}

/**
 * The other face of a sitting: what the attempt scored, where it was weak,
 * and the sheet to re-read before the next one.
 *
 * It borrows the sitting's stylesheet rather than restating it — a wrong
 * answer is drawn here exactly as it was drawn the moment it was given, so
 * the review is the same object as the question, seen again.
 */
export function McqResultView({
  result,
  attempt,
}: {
  result: McqResult;
  attempt: McqAttempt;
}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [retaking, setRetaking] = useState(false);
  const [retakeError, setRetakeError] = useState<string | null>(null);

  const ratio = result.total > 0 ? result.score / result.total : 0;
  const percent = Math.round(100 * ratio);

  const retake = useCallback(() => {
    if (retaking) return;
    setRetaking(true);
    setRetakeError(null);
    createMcqAttempt(
      attempt.subject_code,
      attempt.units,
      attempt.length,
      attempt.difficulty,
    )
      .then((a) => router.push(`/test/mcq/${a.attempt_id}`))
      .catch((err: unknown) => {
        setRetakeError(errorMessage(err));
        setRetaking(false);
      });
  }, [attempt, retaking, router]);

  /**
   * Ladder order, and only the tiers this attempt drew. A single-tier attempt
   * gets no breakdown at all: one full-width row would restate the score it
   * is sitting under.
   */
  const byDifficulty = [...(result.by_difficulty ?? [])]
    .filter((d) => d.total > 0)
    .sort(
      (a, b) =>
        DIFFICULTY_ORDER.indexOf(a.difficulty) -
        DIFFICULTY_ORDER.indexOf(b.difficulty),
    );
  const showDifficulty = byDifficulty.length > 1;

  /** Weakest first: the top of this list is where the next hour goes. */
  const byTopic = [...result.by_topic].sort(
    (a, b) => a.correct / Math.max(1, a.total) - b.correct / Math.max(1, b.total),
  );
  const pair = showDifficulty && byTopic.length > 0;

  return (
    <main className={s.screen}>
      <div className={`${s.column} pb-10`}>
        <p className="label">Yash Made Test · result</p>

        {/* --- the summary moment ------------------------------------------ */}

        <Reveal>
          <section className="elev-2 rounded-md px-4 py-4 sm:px-5 sm:py-5 mt-2.5">
            <div className={s.chipRow}>
              <span className={s.chip}>{attempt.subject_code}</span>
              <span className={s.chipMuted}>
                {plural(attempt.units.length, "unit")}{" "}
                {attempt.units.join(", ")}
              </span>
              <span className={s.chipMuted}>{attempt.difficulty ?? "mixed"}</span>
            </div>

            <div className="flex items-center gap-4 sm:gap-6 mt-4">
              <div className="min-w-0">
                <h1 className="k-display tnum-display">
                  <AnimatedNumber value={result.score} />
                  <span className="text-fg-3 font-normal"> / {result.total}</span>
                </h1>
                <p className="text-[14.5px] font-medium leading-snug mt-2 max-w-prose">
                  {verdict(percent)}
                </p>
              </div>

              <ProgressRing
                value={ratio}
                size={88}
                thickness={6}
                color={toneFor(ratio)}
                label={`${percent} percent`}
                className="ml-auto"
              >
                <span className="tnum text-[17px] font-semibold">{percent}%</span>
              </ProgressRing>
            </div>

            {result.answered < result.total && (
              <p className="text-[12.5px] leading-[1.6] text-fg-2 mt-4 pl-3 border-l-2 border-l-line-strong max-w-prose">
                You answered {result.answered} of {result.total}. The{" "}
                {result.total - result.answered} you left score 0 — the total is
                what the attempt drew, so this is an honest {result.score}/
                {result.total}.
              </p>
            )}

            {/* Provenance: what was drawn, how long it took, where it lands. */}
            <div className="telemetry flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11.5px] text-fg-3 mt-4 pt-3 border-t border-line">
              <span>
                <span className="tnum text-fg-2">
                  {formatDuration(result.duration_s * 1000)}
                </span>{" "}
                spent
              </span>
              <span>
                <span className="tnum text-fg-2">{result.answered}</span> of{" "}
                <span className="tnum">{result.total}</span> answered
              </span>
              {result.rank && (
                <span className="sm:ml-auto text-fg-2">
                  #<span className="tnum">{result.rank.position}</span> of{" "}
                  <span className="tnum">{result.rank.of}</span> on this board
                </span>
              )}
            </div>
          </section>
        </Reveal>

        {/* --- where it went: the long list, and the short ladder ----------- */}

        {(byTopic.length > 0 || showDifficulty) && (
          <Reveal index={1}>
            <div
              className={`mt-5 ${
                pair
                  ? "grid gap-4 items-start md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
                  : ""
              }`}
            >
              {byTopic.length > 0 && (
                <Panel
                  title="Topics — weakest first"
                  aside={`${byTopic.length} ${plural(byTopic.length, "topic")}`}
                >
                  {byTopic.map((t) => (
                    <BreakdownRow
                      key={t.topic}
                      correct={t.correct}
                      total={t.total}
                      reduced={reduced}
                      /* Wraps, never truncates. This list is the answer to
                         "what do I study next", and in the narrower of the
                         two columns 36% is 135px — enough to turn "Phishing
                         & Social Engineering" into "Phishing & Social…",
                         which names nothing. Two lines cost a few pixels of
                         row; an ellipsis costs the topic. */
                      label={
                        <span className="text-[13px] font-medium leading-snug w-[36%] shrink-0">
                          {t.topic}
                        </span>
                      }
                    />
                  ))}
                </Panel>
              )}

              {showDifficulty && (
                <Panel
                  title="Difficulty ladder"
                  aside={`${byDifficulty.length} ${plural(byDifficulty.length, "tier")}`}
                >
                  {byDifficulty.map((d) => (
                    <BreakdownRow
                      key={d.difficulty}
                      correct={d.correct}
                      total={d.total}
                      reduced={reduced}
                      label={
                        <span className="w-[36%] shrink-0">
                          <span className={s.chipMuted}>{d.difficulty}</span>
                        </span>
                      }
                    />
                  ))}
                </Panel>
              )}
            </div>
          </Reveal>
        )}

        {/* --- the revision sheet ------------------------------------------- */}

        {result.missed.length === 0 ? (
          <Reveal index={2}>
            <section className="elev-1 rounded-md px-4 py-5 mt-6 max-w-prose">
              <p className="text-[14.5px] font-medium">
                Nothing missed. Every question was right.
              </p>
              <p className="text-[13px] leading-[1.6] text-fg-2 mt-1.5">
                Retake it later — the draw and the options are shuffled again,
                so it is the material you are remembering, not the layout.
              </p>
            </section>
          </Reveal>
        ) : (
          <section className="mt-8">
            <Reveal index={2}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="text-[17px] font-semibold">What to fix</h2>
                <p className="telemetry text-[11.5px] text-fg-3">
                  <span className="tnum">{result.missed.length}</span>{" "}
                  {plural(result.missed.length, "question")} wrong or unanswered
                </p>
              </div>
            </Reveal>

            <ul className="grid gap-3 mt-4">
              {result.missed.map((m) => (
                <li
                  key={m.position}
                  className="elev-1 rounded-md px-3.5 py-3.5 sm:px-4 sm:py-4"
                >
                  <div className={s.chipRow}>
                    <span className="telemetry tnum text-[11px] text-fg-3">
                      Q{m.position}
                    </span>
                    <span className={s.chip}>{m.topic}</span>
                    {m.chosen === null ? (
                      <span className={s.chipAgain}>unanswered</span>
                    ) : null}
                  </div>

                  <p className="k-text text-[15.5px] font-medium leading-[1.45] mt-2.5 max-w-[70ch]">
                    {m.question}
                  </p>

                  <McqCode
                    code={m.code}
                    label={`Code for question ${m.position}`}
                  />

                  {/* The same four rows the sitting drew, frozen at the verdict:
                      what was picked, what was right, and the rest stepped back. */}
                  <div
                    className={s.optionList}
                    role="group"
                    aria-label={`Options for question ${m.position}`}
                  >
                    {m.options.map((option, i) => {
                      const isCorrect = i === m.correct_index;
                      const isChosenWrong = !isCorrect && m.chosen === i;
                      const state = isCorrect
                        ? s.isCorrect
                        : isChosenWrong
                          ? s.isWrong
                          : s.isDimmed;
                      const mark = isCorrect
                        ? "correct"
                        : isChosenWrong
                          ? "your pick"
                          : null;

                      return (
                        <button
                          key={i}
                          type="button"
                          disabled
                          aria-label={`${LETTERS[i]}. ${option}${
                            mark
                              ? ` — ${
                                  mark === "correct"
                                    ? "correct answer"
                                    : "your answer, wrong"
                                }`
                              : ""
                          }`}
                          className={`${s.option} ${state}`}
                        >
                          <span className={s.optionLetter} aria-hidden="true">
                            {LETTERS[i]}
                          </span>
                          <span className={optionTextClass(m.options_mono)}>
                            {option}
                          </span>
                          {mark ? (
                            <span className={s.optionMark} aria-hidden="true">
                              {mark}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-3.5 pt-3 border-t border-line">
                    <p className={s.teach}>{m.explain}</p>

                    {m.chosen !== null && m.why_wrong ? (
                      <div className={s.whyWrong}>
                        <p className={s.whyWrongLabel}>
                          Why {LETTERS[m.chosen]} is wrong
                        </p>
                        <p className={s.whyWrongText}>{m.why_wrong}</p>
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* --- again ------------------------------------------------------- */}

        {retakeError && (
          <div className="mt-6">
            <ErrorState message={retakeError} onRetry={retake} />
          </div>
        )}

        <div className={`${s.actions} mt-8`}>
          <motion.button
            type="button"
            onClick={retake}
            disabled={retaking}
            whileTap={reduced ? undefined : { scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            className="accent-grad glow-accent-hover inline-flex items-center h-11 px-4 rounded-sm
              text-[13px] font-semibold border border-accent
              disabled:opacity-40 disabled:pointer-events-none"
          >
            {retaking ? "Shuffling…" : "Retake (reshuffled)"}
          </motion.button>

          <Link
            href="/test"
            className="inline-flex items-center h-11 px-4 rounded-sm text-[13px] font-medium
              border border-line bg-surface text-fg-2 hover:border-line-strong
              hover:bg-surface-hover hover:text-fg transition-colors duration-[90ms]"
          >
            Back to Test
          </Link>

          <p className="text-[12px] text-fg-3">
            A retake draws the same selection, reshuffled.
          </p>
        </div>
      </div>
    </main>
  );
}

/* --- one line of a breakdown ---------------------------------------------- */

/**
 * Label, proportion, fraction. The bar carries the tone and the fraction
 * carries the fact, so the row still reads with the colour taken away.
 *
 * The label is a slot rather than a string: the topic list sets its label in
 * the interface face, and the ladder wears the shared tier chip — which is
 * what stops two lists of bars from reading as the same list twice.
 */
function BreakdownRow({
  label,
  correct,
  total,
  reduced,
}: {
  label: ReactNode;
  correct: number;
  total: number;
  reduced: boolean | null;
}) {
  const ratio = total > 0 ? correct / total : 0;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b border-line last:border-b-0">
      {label}
      <span
        className="block h-1.5 flex-1 min-w-[2.5rem] rounded-xs bg-line overflow-hidden"
        aria-hidden="true"
      >
        <motion.span
          className="block h-full"
          style={{ background: toneFor(ratio) }}
          initial={reduced ? false : { width: 0 }}
          animate={{ width: `${Math.round(ratio * 100)}%` }}
          transition={
            reduced ? { duration: 0 } : { type: "spring", duration: 0.7, bounce: 0 }
          }
        />
      </span>
      <span className="telemetry tnum text-[11.5px] text-fg-2 shrink-0 w-[3.25rem] text-right">
        {correct}/{total}
      </span>
    </div>
  );
}
