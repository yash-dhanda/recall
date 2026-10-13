/**
 * The only place in the app that knows a network exists.
 *
 * One function per endpoint in docs/CONTRACT.md, every one of them typed.
 * NEXT_PUBLIC_MOCK=1 swaps the whole surface for lib/mock.ts, which is how the
 * client is developed and verified while the Python API is being written.
 */

import * as mock from "./mock";
import type {
  AuthUser,
  DecideAction,
  DecideResponse,
  Explanation,
  GenerateResponse,
  Grade,
  LessonIndexEntry,
  LessonPage,
  McqAttempt,
  McqAttemptSummary,
  McqDifficulty,
  McqExamAnswer,
  McqFeedback,
  McqLeaderboardRow,
  McqLength,
  McqMistakeSummary,
  McqMode,
  McqResult,
  McqSource,
  McqSubject,
  PendingResponse,
  QueueResponse,
  ReviewResponse,
  Settings,
  SettingsPatch,
  Source,
  Stats,
  StudyPlanEntry,
  TestKind,
  TestPaper,
  TestResult,
  TestSummary,
  Topic,
  UploadResponse,
  Verdict,
} from "./types";

import { API_BASE, ApiError, errorMessage, MOCK } from "./http";
import { invalidate } from "./cache";

// Re-exported so this stays the one module the rest of the app imports from.
export { API_BASE, ApiError, errorMessage, MOCK };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Any write makes every cached read suspect. Invalidating the lot is blunt
  // and correct: there are four cached keys in the whole app, they are cheap
  // to refetch, and the alternative — a hand-maintained map from endpoint to
  // the screens it affects — is a stale-data bug waiting to be written.
  const writes = !!init?.method && init.method.toUpperCase() !== "GET";

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      // The session cookie has to ride along. In production the page and the
      // API share one origin, where fetch's default ("same-origin") would
      // already send it; this exists for local dev, where the frontend and
      // backend are on different ports and the default silently drops it.
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, path, `Could not reach the API at ${API_BASE}.`);
  }

  if (writes && res.ok) invalidate();

  if (!res.ok) {
    // The contract promises {"detail": "..."} on every error.
    let detail = res.statusText || "Request failed";
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* a non-JSON error body is still an error */
    }
    throw new ApiError(res.status, path, detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/* --- auth ---------------------------------------------------------------- */

/** GET /api/auth/me — 401 when there is no valid session. */
export function getMe(): Promise<AuthUser> {
  if (MOCK) return mock.getMe();
  return request<AuthUser>("/api/auth/me");
}

/** POST /api/auth/register — 422 when the name or email is taken. */
export function postRegister(
  name: string,
  email: string,
  password: string,
): Promise<AuthUser> {
  if (MOCK) return mock.postRegister(name, email, password);
  return request<AuthUser>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
}

/** POST /api/auth/login — 401 for a wrong password OR an unknown email. */
export function postLogin(email: string, password: string): Promise<AuthUser> {
  if (MOCK) return mock.postLogin(email, password);
  return request<AuthUser>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

/** POST /api/auth/logout */
export function postLogout(): Promise<{ ok: true }> {
  if (MOCK) return mock.postLogout();
  return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

/* --- endpoints ----------------------------------------------------------- */

/** GET /api/topics */
export function getTopics(): Promise<Topic[]> {
  if (MOCK) return mock.getTopics();
  return request<Topic[]>("/api/topics");
}

/** GET /api/queue?topic=&limit= */
export function getQueue(
  topic?: string,
  limit?: number,
): Promise<QueueResponse> {
  if (MOCK) return mock.getQueue(topic, limit);
  return request<QueueResponse>(`/api/queue${qs({ topic, limit })}`);
}

/** POST /api/review */
export function postReview(
  cardId: number,
  grade: Grade,
): Promise<ReviewResponse> {
  if (MOCK) return mock.postReview(cardId, grade);
  return request<ReviewResponse>("/api/review", {
    method: "POST",
    body: JSON.stringify({ card_id: cardId, grade }),
  });
}

/** GET /api/pending?limit=&offset=&topic= */
export function getPending(
  limit = 50,
  offset = 0,
  topic?: string,
): Promise<PendingResponse> {
  if (MOCK) return mock.getPending(limit, offset, topic);
  return request<PendingResponse>(`/api/pending${qs({ limit, offset, topic })}`);
}

/** POST /api/pending/decide — one request per action, whatever the batch size. */
export function postDecide(
  ids: number[],
  action: DecideAction,
): Promise<DecideResponse> {
  if (MOCK) return mock.postDecide(ids, action);
  return request<DecideResponse>("/api/pending/decide", {
    method: "POST",
    body: JSON.stringify({ ids, action }),
  });
}

/** GET /api/settings */
export function getSettings(): Promise<Settings> {
  if (MOCK) return mock.getSettings();
  return request<Settings>("/api/settings");
}

/** PUT /api/settings — accepts any subset, returns the full settings. */
export function putSettings(patch: SettingsPatch): Promise<Settings> {
  if (MOCK) return mock.putSettings(patch);
  return request<Settings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** GET /api/stats */
export function getStats(): Promise<Stats> {
  if (MOCK) return mock.getStats();
  return request<Stats>("/api/stats");
}

/** GET /api/study-plan — what to do next, per subject. Never spends money. */
export function getStudyPlan(): Promise<StudyPlanEntry[]> {
  if (MOCK) return mock.getStudyPlan();
  return request<StudyPlanEntry[]>("/api/study-plan");
}

/** GET /api/sources */
export function getSources(): Promise<Source[]> {
  if (MOCK) return mock.getSources();
  return request<Source[]>("/api/sources");
}

/* --- test mode ----------------------------------------------------------- */

/** POST /api/tests — assembles a paper and starts the clock. */
export function createTest(
  kind: TestKind,
  topicCode?: string,
): Promise<TestPaper> {
  if (MOCK) return mock.createTest(kind, topicCode);
  return request<TestPaper>("/api/tests", {
    method: "POST",
    body: JSON.stringify({ kind, topic_code: topicCode }),
  });
}

/** GET /api/tests/{id} — the same paper with its recorded verdicts, for resuming. */
export function getTest(id: number): Promise<TestPaper> {
  if (MOCK) return mock.getTest(id);
  return request<TestPaper>(`/api/tests/${id}`);
}

/** POST /api/tests/{id}/answer — one call per verdict, so a closed tab loses nothing. */
export function postAnswer(
  id: number,
  ordinal: number,
  verdict: Verdict,
  seconds: number,
): Promise<{ ok: true }> {
  if (MOCK) return mock.postAnswer(id, ordinal, verdict, seconds);
  return request<{ ok: true }>(`/api/tests/${id}/answer`, {
    method: "POST",
    body: JSON.stringify({ ordinal, verdict, seconds }),
  });
}

/** POST /api/tests/{id}/submit — scores the paper and feeds the scheduler. */
export function submitTest(id: number): Promise<TestResult> {
  if (MOCK) return mock.submitTest(id);
  return request<TestResult>(`/api/tests/${id}/submit`, { method: "POST" });
}

/**
 * POST /api/topics/{code}/paper — sit a real paper for a subject, generating
 * whatever the deck cannot cover first.
 *
 * The difference from createTest: that one assembles from what exists and
 * returns an empty paper when the deck is empty. This one fills the gap, so
 * "no questions" stops being a possible outcome. Costs money, and 429s when
 * the day's budget is spent.
 */
export function sitPaper(
  topicCode: string,
  kind: TestKind,
  /** 1-based syllabus unit numbers — "we did units 2 and 3 in class". Omit
   *  for the paper kind's own coverage. This endpoint speaks in the numbers
   *  printed on a timetable; POST /api/tests takes 0-based indices. */
  units?: number[],
): Promise<TestPaper> {
  if (MOCK) return mock.createTest(kind, topicCode, units);
  return request<TestPaper>(
    `/api/topics/${encodeURIComponent(topicCode)}/paper`,
    {
      method: "POST",
      body: JSON.stringify(units?.length ? { kind, units } : { kind }),
    },
  );
}

/** GET /api/tests */
export function getTests(): Promise<TestSummary[]> {
  if (MOCK) return mock.getTests();
  return request<TestSummary[]>("/api/tests");
}

/** DELETE /api/tests/{id} — close an open paper without sitting it. 409 if
 *  it has already been submitted: that is a graded result, not clutter. */
export function abandonTest(id: number): Promise<{ ok: true }> {
  if (MOCK) return mock.abandonTest(id);
  return request<{ ok: true }>(`/api/tests/${id}`, { method: "DELETE" });
}

/* --- Yash Made Test ------------------------------------------------------ */
/*
 * A second test mode over a hand-curated MCQ bank. The bank itself is shared
 * course content — every user reads the same questions — but everything a
 * user does with it (attempts, answers, the leaderboard row it earns) is
 * scoped to them by the server, exactly like the rest of the app.
 */

/**
 * The fixture backend never goes through `request`, so it never invalidates
 * the read cache the way a real write does. The MCQ writes route through this
 * in mock mode so the picker's attempts list and mistakes count are as fresh
 * after a sitting offline as they are against the server.
 */
function mockWrite<T>(p: Promise<T>): Promise<T> {
  return p.then((v) => {
    invalidate();
    return v;
  });
}

/** True when an answer carries its verdict: a practice answer, or any answer
 *  of a submitted exam. An open exam's answers never do — they are
 *  McqExamAnswer, the choice alone. */
export function isRevealed(
  answer: McqFeedback | McqExamAnswer | null | undefined,
): answer is McqFeedback {
  return !!answer && "is_correct" in answer;
}

/** GET /api/mcq/subjects — every subject in the registry, with a per-unit
 *  count of active questions. A unit with 0 still comes back: it is waiting
 *  for material, not missing. */
export function getMcqSubjects(): Promise<McqSubject[]> {
  if (MOCK) return mock.getMcqSubjects();
  return request<McqSubject[]>("/api/mcq/subjects");
}

/**
 * POST /api/mcq/attempts — draw a fresh sample and shuffle it.
 *
 * 422 for an unknown subject, a unit the registry does not have, a bad
 * length, or a selection that holds no questions at all — and, for
 * `source: "mistakes"`, a selection in which this user has no mistakes to
 * practise yet.
 */
export function createMcqAttempt(
  subjectCode: string,
  /** Unit numbers as printed on the deck, 1-based. */
  units: number[],
  /** Any whole number 5–200, or "full". The server draws min(length,
   *  available), so an over-large number is a shorter attempt, not a 422. */
  length: McqLength,
  /** One rung of the ladder, or null for Mixed — a draw across all four,
   *  which is its own selection and its own board. */
  difficulty: McqDifficulty | null = null,
  /** "practice" reveals every answer on the click; "exam" is timed at a
   *  minute per question drawn and reveals nothing until submit. */
  mode: McqMode = "practice",
  /** "bank" is the ordinary draw; "mistakes" draws only from this user's
   *  pending mistakes in the same selection, and is never ranked. */
  source: McqSource = "bank",
): Promise<McqAttempt> {
  if (MOCK)
    return mockWrite(
      mock.createMcqAttempt(subjectCode, units, length, difficulty, mode, source),
    );
  return request<McqAttempt>("/api/mcq/attempts", {
    method: "POST",
    body: JSON.stringify({
      subject_code: subjectCode,
      units,
      length,
      difficulty,
      mode,
      source,
    }),
  });
}

/** GET /api/mcq/mistakes — this user's pending mistakes, per subject, for
 *  "Practise my mistakes (N)". Subjects with none are not listed. */
export function getMcqMistakes(): Promise<McqMistakeSummary[]> {
  if (MOCK) return mock.getMcqMistakes();
  return request<McqMistakeSummary[]>("/api/mcq/mistakes");
}

/** GET /api/mcq/attempts/{id} — the same draw with its recorded answers, for
 *  resuming. Someone else's attempt is a 404, identical to a missing one. */
export function getMcqAttempt(id: number): Promise<McqAttempt> {
  if (MOCK) return mock.getMcqAttempt(id);
  return request<McqAttempt>(`/api/mcq/attempts/${id}`);
}

/**
 * POST /api/mcq/attempts/{id}/answer on a PRACTICE attempt — one call per
 * question, and the first click is the answer: a second answer to the same
 * position is a 409, never an overwrite. `chosen` is a position in the shown
 * option order. An exam attempt goes through `postMcqExamAnswer` instead.
 */
export function postMcqAnswer(
  id: number,
  position: number,
  chosen: number,
): Promise<McqFeedback> {
  if (MOCK) return mockWrite(mock.postMcqAnswer(id, position, chosen));
  return request<McqFeedback>(`/api/mcq/attempts/${id}/answer`, {
    method: "POST",
    body: JSON.stringify({ position, chosen }),
  });
}

/**
 * POST /api/mcq/attempts/{id}/answer on an EXAM attempt — record or change
 * the choice. The answer can be changed until submit, and the response says
 * nothing about correctness: `{position, chosen, answered}` only.
 *
 * The object handed back is rebuilt from those three fields, so even a server
 * that sent more could not put a verdict into the sitting's state. 409 once
 * the clock plus its grace has run out, or once the paper is submitted — the
 * sitting submits on either.
 */
export async function postMcqExamAnswer(
  id: number,
  position: number,
  chosen: number,
): Promise<McqExamAnswer> {
  const raw: McqExamAnswer = MOCK
    ? await mockWrite(mock.postMcqExamAnswer(id, position, chosen))
    : await request<McqExamAnswer>(`/api/mcq/attempts/${id}/answer`, {
        method: "POST",
        body: JSON.stringify({ position, chosen }),
      });
  return { position: raw.position, chosen: raw.chosen, answered: raw.answered };
}

/** POST /api/mcq/attempts/{id}/submit — closes the attempt and scores it.
 *  Idempotent: a submitted attempt hands back the result it already stored,
 *  which is what makes reopening a finished attempt safe. Never refused on
 *  time, so an exam whose clock has run out can always be closed. */
export function submitMcqAttempt(id: number): Promise<McqResult> {
  if (MOCK) return mockWrite(mock.submitMcqAttempt(id));
  return request<McqResult>(`/api/mcq/attempts/${id}/submit`, {
    method: "POST",
  });
}

/** DELETE /api/mcq/attempts/{id} — drop an open attempt. 409 once it has
 *  been submitted: that is a result, not clutter. */
export function abandonMcqAttempt(id: number): Promise<{ ok: true }> {
  if (MOCK) return mockWrite(mock.abandonMcqAttempt(id));
  return request<{ ok: true }>(`/api/mcq/attempts/${id}`, { method: "DELETE" });
}

/** GET /api/mcq/attempts — mine only, newest first. */
export function getMcqAttempts(): Promise<McqAttemptSummary[]> {
  if (MOCK) return mock.getMcqAttempts();
  return request<McqAttemptSummary[]>("/api/mcq/attempts");
}

/** GET /api/mcq/leaderboard — one row per user, their best submitted attempt
 *  for exactly this subject + units + length + difficulty + mode.
 *  `difficulty` is sent only when a tier is chosen; its absence IS the Mixed
 *  board, which is a board of its own rather than the four tiers merged.
 *  `mode` picks the practice or the exam board — the two never share one. A
 *  "mistakes" sitting is on neither, so there is no source parameter. */
export function getMcqLeaderboard(
  subjectCode: string,
  units: number[],
  length: McqLength,
  difficulty: McqDifficulty | null = null,
  mode: McqMode = "practice",
): Promise<McqLeaderboardRow[]> {
  if (MOCK)
    return mock.getMcqLeaderboard(subjectCode, units, length, difficulty, mode);
  return request<McqLeaderboardRow[]>(
    `/api/mcq/leaderboard${qs({
      subject_code: subjectCode,
      units: units.join(","),
      length: String(length),
      difficulty: difficulty ?? undefined,
      mode,
    })}`,
  );
}

/* --- teaching ------------------------------------------------------------ */

/**
 * GET /api/teach/lessons — which syllabus units have a written lesson.
 *
 * A pure read. Lessons are written offline by `recall lessons <TOPIC>
 * --unit N` because each one costs money and takes a minute or two; nothing
 * on this path can start one. That is what makes it safe for the shell to
 * fire on route intent — a hover must never turn into a paid call.
 */
export function getLessonIndex(): Promise<LessonIndexEntry[]> {
  if (MOCK) return mock.getLessonIndex();
  return request<LessonIndexEntry[]>("/api/teach/lessons");
}

/**
 * GET /api/teach/lessons/{topic}/{unit} — one stored lesson, or null.
 *
 * 200 with `lesson: null` when nothing has been written for the unit: that is
 * a state, not an error, and the unit name comes back either way. 404 for an
 * unknown topic, 422 for a unit outside the syllabus. Also a pure read.
 */
export function getLesson(
  topicCode: string,
  unit: number,
): Promise<LessonPage> {
  if (MOCK) return mock.getLesson(topicCode, unit);
  return request<LessonPage>(
    `/api/teach/lessons/${encodeURIComponent(topicCode)}/${unit}`,
  );
}

/** POST /api/teach/explain — 422 when the model could not cite its source. */
export function postExplain(cardId: number): Promise<Explanation> {
  if (MOCK) return mock.postExplain(cardId);
  return request<Explanation>("/api/teach/explain", {
    method: "POST",
    body: JSON.stringify({ card_id: cardId }),
  });
}

/* --- upload -------------------------------------------------------------- */

export const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".txt",
  ".md",
];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/sources/upload.
 *
 * XMLHttpRequest rather than fetch: this is the one request in the app whose
 * progress matters, and fetch cannot report upload progress. A phone on a
 * tunnelled connection pushing a 20 MB scan needs the bar to move.
 */
export function uploadSource(
  file: File,
  topicCode: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  if (MOCK) return mock.uploadSource(file, topicCode, onProgress, signal);

  const path = "/api/sources/upload";
  return new Promise<UploadResponse>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("topic_code", topicCode);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${path}`);
    // Same reason as request()'s credentials: "include" — the session cookie
    // has to survive local dev's cross-port setup.
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });

    xhr.addEventListener("load", () => {
      // The bytes are gone; anything left is the server thinking.
      onProgress?.(1);
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText) as unknown;
      } catch {
        /* a non-JSON body is still a response */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        // This upload path bypasses `request`, so it has to drop the read
        // cache itself — a new source changes every screen that counts cards.
        invalidate();
        resolve(body as UploadResponse);
        return;
      }
      const detail = (body as { detail?: unknown } | null)?.detail;
      reject(
        new ApiError(
          xhr.status,
          path,
          typeof detail === "string" ? detail : xhr.statusText || "Upload failed",
        ),
      );
    });

    xhr.addEventListener("error", () =>
      reject(new ApiError(0, path, `Could not reach the API at ${API_BASE}.`)),
    );
    xhr.addEventListener("abort", () =>
      reject(new ApiError(0, path, "Upload cancelled.")),
    );

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}

/** POST /api/sources/{id}/generate — the step that spends money. */
export function generateCards(sourceId: number): Promise<GenerateResponse> {
  if (MOCK) return mock.generateCards(sourceId);
  return request<GenerateResponse>(`/api/sources/${sourceId}/generate`, {
    method: "POST",
  });
}

/**
 * POST /api/topics/{code}/generate — cards for one syllabus unit with nothing
 * uploaded. Same response shape as generateCards; also spends money, and 429s
 * when the account is over its daily cap.
 */
export function generateFromKnowledge(
  topicCode: string,
  unit: number,
  count?: number,
): Promise<GenerateResponse> {
  if (MOCK) return mock.generateFromKnowledge(topicCode, unit, count);
  return request<GenerateResponse>(
    `/api/topics/${encodeURIComponent(topicCode)}/generate`,
    { method: "POST", body: JSON.stringify({ unit, ...(count ? { count } : {}) }) },
  );
}
