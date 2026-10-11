/**
 * Fixture backend, enabled with NEXT_PUBLIC_MOCK=1.
 *
 * Not a stub: it holds mutable state for the lifetime of the tab, so grading a
 * card removes it from the queue (grade 1 pushes it back), approving pending
 * cards drains the triage list, and settings changes stick. That is what makes
 * it useful for building against while the Python API is being written.
 *
 * The numbers are meant to look like a real second-semester deck in week
 * eleven, not like a fresh install: 1,240 active cards, a 21-day streak, a
 * daily cap that today's load actually collides with.
 */

import type {
  CardKind,
  DecideAction,
  DecideResponse,
  Explanation,
  GenerateResponse,
  Grade,
  Lesson,
  LessonBody,
  LessonIndexEntry,
  LessonPage,
  LessonStatus,
  McqAttempt,
  McqAttemptSummary,
  McqDifficulty,
  McqDifficultyScore,
  McqFeedback,
  McqKind,
  McqLeaderboardRow,
  McqLength,
  McqMissed,
  McqResult,
  McqSubject,
  McqTopicScore,
  PendingCard,
  PendingResponse,
  QueueCard,
  QueueResponse,
  ReviewResponse,
  Settings,
  Source,
  Stats,
  StudyPlanEntry,
  TestKind,
  TestPaper,
  TestQuestion,
  TestResult,
  TestSummary,
  Topic,
  TopicMeta,
  UploadResponse,
  Verdict,
} from "./types";
import { initialState, intervalDays, nextState } from "./fsrs";
import { ApiError } from "./http";
import { marksFor, scoreFor } from "./marks";

/* --- deck ---------------------------------------------------------------- */

interface Seed {
  t: string;
  k: CardKind;
  p: string;
  q: string;
  a: string;
  c?: string;
  src: string;
}

const MATHS_SRC = "maths-unit3-calculus-notes.pdf";
const MATHS_SRC2 = "maths-unit4-linear-algebra.pdf";
const CSE_SRC = "cse111-pointers-and-memory.pdf";
const CSE_SRC2 = "cse111-lecture-09-arrays.pdf";
const INT108_SRC = "int108-python-lectures-05-08.pdf";
const INT335_SRC = "int335-shell-scripting-lab.pdf";
const INT335_SRC2 = "int335-filesystems-permissions.pdf";
const HTML_SRC = "html-semantics-and-forms.pdf";

const ACTIVE_SEEDS: Seed[] = [
  // --- MATHS ---
  {
    t: "MTH165",
    k: "qa",
    p: "p31",
    q: "State Rolle's theorem.",
    a: "If f is continuous on [a, b], differentiable on (a, b), and f(a) = f(b), then there is at least one c in (a, b) with f′(c) = 0.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p34",
    q: "Maclaurin series for e^x",
    a: "1 + x + x²/2! + x³/3! + …",
    c: "The Maclaurin series for e^x is {{c1::1 + x + x²/2! + x³/3! + …}}, and it converges for every real x.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p37",
    q: "What does a non-zero Wronskian at a point tell you about a set of solutions?",
    a: "That they are linearly independent on the interval. A zero Wronskian alone does not prove dependence unless the functions solve the same linear ODE.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p29",
    q: "Indeterminate forms for L'Hôpital",
    a: "0/0 and ∞/∞",
    c: "L'Hôpital's rule may only be applied when the limit has the indeterminate form {{c1::0/0}} or {{c2::∞/∞}}.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p42",
    q: "Give the integrating factor for dy/dx + P(x)·y = Q(x).",
    a: "μ(x) = e^(∫P(x)dx). Multiplying through makes the left side the exact derivative (μy)′.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p12",
    q: "For any matrix, how do row rank and column rank relate?",
    a: "They are always equal. That common value is the rank.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p14",
    q: "Invertibility and the determinant",
    a: "≠ 0",
    c: "A square matrix A is invertible if and only if det(A) {{c1::≠ 0}}.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p18-p19",
    q: "What is the geometric meaning of an eigenvector of A?",
    a: "A non-zero vector whose direction A leaves unchanged. A only scales it, by the eigenvalue λ.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p22",
    q: "State the Cauchy–Schwarz inequality for real vectors.",
    a: "|⟨u, v⟩| ≤ ‖u‖·‖v‖, with equality exactly when u and v are linearly dependent.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p27",
    q: "Derivative of arctan",
    a: "1/(1 + x²)",
    c: "d/dx arctan(x) = {{c1::1/(1 + x²)}}.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p45",
    q: "What is the trace of a square matrix, and what does it equal?",
    a: "The sum of the diagonal entries. It equals the sum of the eigenvalues counted with algebraic multiplicity.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p39",
    q: "When is a power series Σaₙ(x − a)ⁿ absolutely convergent?",
    a: "For |x − a| < R, where the radius R satisfies 1/R = lim sup |aₙ|^(1/n). Behaviour at |x − a| = R must be checked separately.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p16",
    q: "Rank–nullity",
    a: "rank(A) + nullity(A) = n",
    c: "For a linear map on an n-dimensional space, {{c1::rank(A) + nullity(A) = n}}.",
    src: MATHS_SRC2,
  },

  // --- CSE111 ---
  {
    t: "CSE111",
    k: "qa",
    p: "p7",
    q: "What is sizeof(char) in C, and why?",
    a: "Exactly 1, by definition. The standard defines a byte as the size of a char, whatever number of bits that is on the platform.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "cloze",
    p: "p11",
    q: "malloc failure",
    a: "NULL",
    c: "malloc returns {{c1::NULL}} when it cannot satisfy the request, so the result must be checked before it is dereferenced.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p14",
    q: 'What is the difference between char *s = "hi"; and char s[] = "hi";?',
    a: "The first points at a string literal, which lives in read-only storage — writing through it is undefined behaviour. The second copies the literal into a mutable array the function owns.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p9",
    q: "Why does an array decay to a pointer when passed to a function?",
    a: "C passes everything by value. The array expression converts to a pointer to its first element, so the length is lost and must be passed separately.",
    src: CSE_SRC2,
  },
  {
    t: "CSE111",
    k: "cloze",
    p: "p21",
    q: "static at file scope",
    a: "internal linkage",
    c: "Applying static to a file-scope function gives it {{c1::internal linkage}}, so no other translation unit can refer to it.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p16",
    q: "What does int *p[10] declare?",
    a: "An array of 10 pointers to int. A pointer to an array of 10 ints would be int (*p)[10] — [] binds tighter than *.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p24",
    q: "Define undefined behaviour and give one everyday example.",
    a: "Behaviour on which the standard places no requirements at all — the compiler may assume it never happens. Example: reading an uninitialised local, or indexing one past the end of an array.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "cloze",
    p: "p5",
    q: "Post- vs pre-increment",
    a: "before / after",
    c: "x++ evaluates to the value {{c1::before}} the increment; ++x evaluates to the value {{c2::after}} it.",
    src: CSE_SRC2,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p28",
    q: "How do you free a 2-D array built as an array of row pointers?",
    a: "Free every row pointer first, then free the array of pointers. Freeing the outer block first loses the addresses of the rows.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p12",
    q: "What is the difference between the stack and the heap for a C program?",
    a: "Stack memory is allocated and released automatically with the enclosing call frame. Heap memory comes from malloc and lives until the program frees it.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "cloze",
    p: "p19",
    q: "Dangling pointer",
    a: "freed",
    c: "A dangling pointer is one that still holds the address of memory that has already been {{c1::freed}}; using it is undefined behaviour.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p31",
    q: "Why is gets() removed from the C standard library?",
    a: "It has no way to bound the write, so any input longer than the buffer overflows it. fgets, which takes a size, replaces it.",
    src: CSE_SRC2,
  },

  // --- INT108 ---
  {
    t: "INT108",
    k: "qa",
    p: "p8",
    q: "What does [x*x for x in r if x % 2] build?",
    a: "A new list holding the squares of the odd elements of r, built eagerly. A generator expression with parentheses would build it lazily instead.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "cloze",
    p: "p15",
    q: "Mutable default arguments",
    a: "once, when the function is defined",
    c: "Python evaluates default arguments {{c1::once, when the function is defined}}, which is why a mutable default such as [] is shared across every call.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p6",
    q: "What is the difference between is and ==?",
    a: "is compares identity — whether both names refer to the same object. == compares value through __eq__.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p27",
    q: "What exactly does the GIL prevent?",
    a: "More than one thread executing Python bytecode at a time in CPython. Threads still overlap during I/O and inside C extensions that release it.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "cloze",
    p: "p11",
    q: "Reverse slice",
    a: "a reversed copy",
    c: "a[::-1] returns {{c1::a reversed copy}} of the sequence, leaving the original untouched.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p18",
    q: "Why can a tuple be a dict key when a list cannot?",
    a: "Keys must be hashable. A tuple of hashable items is hashable; a list is mutable, so its hash would change and it is deliberately unhashable.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "cloze",
    p: "p22",
    q: "What makes a function a generator",
    a: "yield",
    c: "A function becomes a generator as soon as its body contains a {{c1::yield}}; calling it returns an iterator and runs none of the body.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p13",
    q: "What does with open(p) as f: guarantee?",
    a: "That the file is closed when the block exits, including when it exits by exception. That is the context manager protocol, not anything special about files.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p20",
    q: "What does dict.items() return in Python 3?",
    a: "A dict_items view — a live window on the dictionary, not a copied list. It reflects later mutations.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p24",
    q: "How does collections.defaultdict differ from dict?",
    a: "A missing key is created by calling the factory instead of raising KeyError. Plain lookup of an absent key therefore mutates the dictionary.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "cloze",
    p: "p9",
    q: "Shallow vs deep copy",
    a: "the same nested objects",
    c: "A shallow copy of a list creates a new outer list that still refers to {{c1::the same nested objects}}; copy.deepcopy walks the whole structure.",
    src: INT108_SRC,
  },

  // --- INT335 ---
  {
    t: "INT335",
    k: "qa",
    p: "p4",
    q: "What do the permission bits 755 mean on a directory?",
    a: "Owner may read, write and traverse; group and others may read and traverse. On a directory the execute bit is permission to enter it, not to run it.",
    src: INT335_SRC2,
  },
  {
    t: "INT335",
    k: "cloze",
    p: "p7",
    q: "Where file metadata lives",
    a: "inode",
    c: "A file's metadata lives in its {{c1::inode}}; the name is only a directory entry pointing at that number.",
    src: INT335_SRC2,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p9",
    q: "What is the difference between a hard link and a symbolic link?",
    a: "A hard link is a second directory entry for the same inode, so it cannot cross filesystems and keeps the data alive. A symlink stores a path and breaks if the target moves.",
    src: INT335_SRC2,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p16",
    q: "What does 2>&1 do, and why does its position matter?",
    a: "It points fd 2 at whatever fd 1 refers to at that moment. Written before a > redirect it copies the old destination, which is why > f 2>&1 and 2>&1 > f differ.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "cloze",
    p: "p18",
    q: "Pipeline exit status",
    a: "the last command",
    c: "The exit status of a pipeline is by default the status of {{c1::the last command}}, unless set -o pipefail is in force.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p12",
    q: "What happens to a process whose parent exits first?",
    a: "It is re-parented to init/systemd (PID 1), which reaps it. It becomes an orphan, not a zombie.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "cloze",
    p: "p6",
    q: "chmod u+s",
    a: "setuid",
    c: "chmod u+s sets the {{c1::setuid}} bit, so the program runs with the privileges of the file's owner rather than the caller's.",
    src: INT335_SRC2,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p21",
    q: "Why must cd be a shell builtin rather than a program?",
    a: "It has to change the working directory of the shell process itself. A child process cannot alter its parent's state.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p26",
    q: "What does systemctl enable do that systemctl start does not?",
    a: "enable writes the symlinks that make the unit start at boot. start only runs it right now, and the two are independent.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p14",
    q: "What is the difference between $* and $@ inside double quotes?",
    a: '"$*" joins every argument into one word separated by the first character of IFS. "$@" expands to one word per argument, which is almost always what you want.',
    src: INT335_SRC,
  },

  // --- HTML ---
  {
    t: "CSE326",
    k: "qa",
    p: "p3",
    q: "When should you reach for <section> instead of <div>?",
    a: "When the group is a real part of the document outline and would carry a heading. <div> has no meaning and should be the fallback, not the default.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "cloze",
    p: "p12",
    q: "Which box-sizing includes padding and border",
    a: "border-box",
    c: "With box-sizing: {{c1::border-box}}, the width you declare already includes the padding and the border.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p8",
    q: "What alt text does a purely decorative image need?",
    a: 'An empty one: alt="". That tells assistive technology to skip it. Omitting the attribute entirely makes some readers announce the filename instead.',
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p17",
    q: "What does the shorthand flex: 1 expand to?",
    a: "flex-grow: 1; flex-shrink: 1; flex-basis: 0%. The zero basis is what makes items share space equally rather than by content width.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "cloze",
    p: "p6",
    q: "Associating a label with an input",
    a: "the for attribute to the input's id",
    c: "A <label> is tied to its control either by wrapping it or by matching {{c1::the for attribute to the input's id}}.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p7",
    q: "Why must a form control carry a name attribute?",
    a: "Without a name the control's value is simply not included in the submitted form data, however it is labelled or styled.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "cloze",
    p: "p14",
    q: "Default position value",
    a: "static",
    c: "The initial value of position is {{c1::static}}, and a static box ignores top, right, bottom and left entirely.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p15",
    q: "How do display: none and visibility: hidden differ?",
    a: "display: none removes the box from layout altogether. visibility: hidden keeps the space it occupied. Neither is exposed to assistive technology.",
    src: HTML_SRC,
  },
];

const PENDING_SEEDS: Seed[] = [
  {
    t: "MTH165",
    k: "qa",
    p: "p47",
    q: "State the mean value theorem.",
    a: "If f is continuous on [a, b] and differentiable on (a, b), some c in (a, b) satisfies f′(c) = (f(b) − f(a))/(b − a).",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p48",
    q: "Second derivative test",
    a: "a local minimum",
    c: "If f′(c) = 0 and f″(c) > 0, then c is {{c1::a local minimum}}.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p50",
    q: "What is the determinant of a triangular matrix?",
    a: "The product of the diagonal entries.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p51",
    q: "What is the sum of a convergent geometric series Σarⁿ from n = 0?",
    a: "a/(1 − r) for |r| < 1.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p52",
    q: "Orthogonal matrix inverse",
    a: "its transpose",
    c: "For an orthogonal matrix Q, the inverse equals {{c1::its transpose}}.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p53",
    q: "When is an improper integral said to converge?",
    a: "When the limit defining it exists and is finite.",
    src: MATHS_SRC,
  },
  {
    t: "MTH165",
    k: "qa",
    p: "p55",
    q: "What does it mean for a matrix to be positive definite?",
    a: "xᵀAx > 0 for every non-zero x. Equivalently, every eigenvalue of a symmetric A is positive.",
    src: MATHS_SRC2,
  },
  {
    t: "MTH165",
    k: "cloze",
    p: "p56",
    q: "Integration by parts",
    a: "∫u dv = uv − ∫v du",
    c: "Integration by parts states {{c1::∫u dv = uv − ∫v du}}.",
    src: MATHS_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p33",
    q: "What is the difference between calloc and malloc?",
    a: "calloc takes a count and a size, and zeroes the memory it returns. malloc leaves the contents indeterminate.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "cloze",
    p: "p34",
    q: "realloc failure",
    a: "the original block is left untouched",
    c: "If realloc fails it returns NULL and {{c1::the original block is left untouched}}, so assigning the result straight back over the old pointer leaks it.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p36",
    q: "Why is strcpy considered unsafe?",
    a: "It copies until the terminating NUL with no knowledge of the destination size, so a longer source overflows the buffer.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p37",
    q: "What is a struct's padding, and why does the compiler insert it?",
    a: "Unused bytes added between members so each one lands on its required alignment boundary. It is why sizeof(struct) can exceed the sum of the members.",
    src: CSE_SRC2,
  },
  {
    t: "CSE111",
    k: "cloze",
    p: "p38",
    q: "const char * vs char * const",
    a: "the pointed-to characters",
    c: "In const char *p, the const protects {{c1::the pointed-to characters}}; in char * const p it protects the pointer itself.",
    src: CSE_SRC,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p40",
    q: "What does the preprocessor do with #include?",
    a: "It textually substitutes the contents of the named file before compilation proper begins.",
    src: CSE_SRC2,
  },
  {
    t: "CSE111",
    k: "qa",
    p: "p41",
    q: "Why should a macro's parameters be parenthesised in its body?",
    a: "Because the macro expands as text, so an unparenthesised argument binds by the surrounding operator precedence and silently changes the meaning.",
    src: CSE_SRC2,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p29",
    q: "What is the difference between append and extend on a list?",
    a: "append adds its argument as one element. extend iterates the argument and adds each item.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "cloze",
    p: "p30",
    q: "What *args collects",
    a: "a tuple",
    c: "In a function signature, *args collects the extra positional arguments into {{c1::a tuple}} and **kwargs collects keyword arguments into a dict.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p31",
    q: "What does the __name__ == \"__main__\" guard actually do?",
    a: "It runs the block only when the file is executed as a script, not when it is imported, because __name__ is the module name on import.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p32",
    q: "How does a set differ from a list in Python?",
    a: "A set is unordered, holds only hashable items, deduplicates, and tests membership in roughly constant time rather than linear.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "cloze",
    p: "p33",
    q: "Decorator syntax",
    a: "f = decorator(f)",
    c: "Writing @decorator above a function definition is shorthand for {{c1::f = decorator(f)}} immediately after it.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p35",
    q: "What does enumerate give you that range(len(x)) does not?",
    a: "The index and the item together, without a second lookup, and it works on any iterable rather than only on sequences.",
    src: INT108_SRC,
  },
  {
    t: "INT108",
    k: "qa",
    p: "p36",
    q: "Why is str immutable in Python?",
    a: "So strings can be hashed and interned safely and shared freely. Every apparent mutation builds a new string.",
    src: INT108_SRC,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p28",
    q: "What does chmod -R differ from chmod in?",
    a: "-R descends into directories and applies the change to everything underneath, which is how directories accidentally lose their traverse bit.",
    src: INT335_SRC2,
  },
  {
    t: "INT335",
    k: "cloze",
    p: "p29",
    q: "Sticky bit on /tmp",
    a: "only the owner of a file may delete it",
    c: "The sticky bit on a world-writable directory such as /tmp means {{c1::only the owner of a file may delete it}}.",
    src: INT335_SRC2,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p31",
    q: "What is the difference between > and >> in the shell?",
    a: "> truncates the target file before writing; >> appends to it.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p32",
    q: "What does the shell do with an unquoted variable containing spaces?",
    a: "It word-splits the expansion and then glob-expands each word, which is why almost every expansion should be quoted.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "cloze",
    p: "p33",
    q: "Signal that cannot be caught",
    a: "SIGKILL",
    c: "{{c1::SIGKILL}} cannot be caught, blocked, or ignored by the receiving process.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p35",
    q: "What is the purpose of a shebang line?",
    a: "It tells the kernel which interpreter to hand the file to when it is executed directly.",
    src: INT335_SRC,
  },
  {
    t: "INT335",
    k: "qa",
    p: "p37",
    q: "What does set -e do, and what is its main trap?",
    a: "It aborts the script when a command exits non-zero. It does not fire for commands in conditionals or, by default, in the middle of a pipeline.",
    src: INT335_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p19",
    q: "What is the purpose of the viewport meta tag?",
    a: "It stops mobile browsers rendering at a fake ~980px width and then scaling down, so CSS pixels match device-independent pixels.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "cloze",
    p: "p21",
    q: "Landmark element for primary content",
    a: "<main>",
    c: "The {{c1::<main>}} element marks the primary content of the document, and there should be exactly one per page.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p22",
    q: "Why should heading levels not skip?",
    a: "Screen reader users navigate by heading level, and a jump from h2 to h4 makes the outline read as if a section is missing.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p24",
    q: "What is the difference between <button> and a <div> with a click handler?",
    a: "<button> is focusable, fires on Enter and Space, is announced as a button, and participates in forms. A div does none of that without extra work.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "cloze",
    p: "p26",
    q: "Which CSS units are relative to the root font size",
    a: "rem",
    c: "{{c1::rem}} units are relative to the root element's font size, while em units are relative to the element's own.",
    src: HTML_SRC,
  },
  {
    t: "CSE326",
    k: "qa",
    p: "p27",
    q: "What does the defer attribute on a script do?",
    a: "It downloads the script in parallel and runs it after parsing completes, in document order. async runs it as soon as it lands, in any order.",
    src: HTML_SRC,
  },
];

/* --- state --------------------------------------------------------------- */

/**
 * The real LPU Semester-1 registry, mirroring `src/recall/lpu.py` verbatim.
 * Schemes genuinely differ per subject — INT108 and CSE326 carry NO mid-term,
 * so `createTest` refuses an mte40 for them exactly as the server does.
 *
 * NEXT_PUBLIC_MOCK_NO_META=1 withholds all of it (topics come back with
 * `meta: null`), which is what an unseeded database looks like — the flag
 * exists so the client's fallback path can be exercised against the fixture.
 */
const NO_META = process.env.NEXT_PUBLIC_MOCK_NO_META === "1";

const LPU_META: Record<string, TopicMeta> = {
  MTH165: {
    full_name: "Mathematics for Engineers",
    credits: 4,
    units: [
      "Linear Algebra",
      "Differential Calculus and Its Applications",
      "Fundamentals of Integral Calculus",
      "Multivariate Functions",
      "Multivariate Integrals",
      "Fourier Series",
    ],
    scheme: { attendance: 5, ca: 25, mte: 20, ete: 50 },
    ca_policy:
      "CT1 units 1-2 · CT2 real-time applications (unit 4) · CT3 cumulative over the CA1+CA2 syllabus — 30 marks each",
    mte_exists: true,
    exam_format: "mixed",
  },
  CSE111: {
    full_name: "Orientation to Computing",
    credits: 2,
    units: [
      "Computer Languages",
      "Computer Fundamentals",
      "Computer Hardware",
      "Number Systems",
      "Version Control",
      "Modern AI Trends and Tools",
    ],
    scheme: { attendance: 5, ca: 95, mte: 0, ete: 0 },
    ca_policy: "CA-driven low-credit course; unit-wise MCQ + subjective practice",
    mte_exists: false,
    exam_format: "mcq",
  },
  INT108: {
    full_name: "Python Programming",
    credits: 4,
    units: [
      "Environment, Variables, Expressions and Statements",
      "Conditional and Iterative Statements",
      "Strings, Lists, Tuples and Dictionaries",
      "Functions and Recursion",
      "Classes, Objects and OOP Terminology",
      "Files, Exceptions and Regular Expressions",
    ],
    scheme: { attendance: 5, ca: 50, mte: 0, ete: 45 },
    ca_policy: "Best 3 of 4 · code-based tests + programming practice",
    mte_exists: false,
    exam_format: "practical",
  },
  INT335: {
    full_name: "Design Thinking",
    credits: 3,
    units: [
      "Foundations of Learning, Creativity and Design Thinking",
      "Empathy, Observation and Problem Identification",
      "Ideation and Creative Problem Solving",
      "Product Design and Prototyping",
      "Testing, Validation and Customer Experience",
      "Innovation Project, Re-Design and Product Presentation",
    ],
    scheme: { attendance: 5, ca: 25, mte: 20, ete: 50 },
    ca_policy: "Best 2 of 3 · MCQ test, group project, situation assignment",
    mte_exists: true,
    exam_format: "mcq",
  },
  CSE326: {
    full_name: "Internet Programming",
    credits: 2,
    units: [
      "HTML Fundamentals",
      "Semantic HTML and Forms",
      "Cascading Style Sheets",
      "JavaScript Fundamentals",
      "Interactive Web Development",
      "Web Application Development and Deployment",
    ],
    scheme: { attendance: 5, ca: 45, mte: 0, ete: 50 },
    ca_policy: "Best 2 of 3 · project, MCQ test, BYOD practical + viva",
    mte_exists: false,
    exam_format: "mixed",
  },
};

function metaFor(code: string): TopicMeta | null {
  return NO_META ? null : (LPU_META[code] ?? null);
}

/** In code order, exactly as the server's `ORDER BY t.code` returns them. */
const TOPIC_META: { code: string; label: string }[] = [
  { code: "CSE111", label: "Orientation to Computing" },
  { code: "CSE326", label: "Internet Programming" },
  { code: "INT108", label: "Python Programming" },
  { code: "INT335", label: "Design Thinking" },
  { code: "MTH165", label: "Mathematics for Engineers" },
];

/** Deterministic jitter, so the fixture is identical on every render. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface MockCard extends QueueCard {
  source_filename: string;
}

function buildQueue(): MockCard[] {
  const rand = lcg(20260904);
  return ACTIVE_SEEDS.map((s, i) => {
    // First six of the deck are the day's new cards; the rest are due reviews
    // with a plausible spread of maturity.
    const isNew = i % 9 === 4 && i < 50;
    const stability = isNew ? null : Number((1.5 + rand() * 90).toFixed(2));
    const difficulty = isNew ? null : Number((2.4 + rand() * 6).toFixed(2));
    const elapsed =
      stability === null ? null : Number((stability * (0.8 + rand() * 0.7)).toFixed(2));
    return {
      id: 1000 + i,
      kind: s.k,
      question: s.q,
      answer: s.a,
      cloze_text: s.c ?? null,
      topic_code: s.t,
      page_ref: s.p,
      is_new: isNew,
      stability,
      difficulty,
      elapsed_days: elapsed,
      source_filename: s.src,
    };
  });
}

interface MockState {
  queue: MockCard[];
  pending: PendingCard[];
  settings: Settings;
  reviewedToday: number;
  againToday: number;
  streak: number;
  reviewedByTopic: Record<string, number>;
  gradedIds: Set<number>;
}

let state: MockState | null = null;

function store(): MockState {
  if (state) return state;
  state = {
    queue: buildQueue(),
    pending: PENDING_SEEDS.map((s, i) => ({
      id: 5000 + i,
      kind: s.k,
      question: s.q,
      answer: s.a,
      cloze_text: s.c ?? null,
      topic_code: s.t,
      page_ref: s.p,
      source_filename: s.src,
    })),
    settings: {
      new_cards_per_day: 15,
      daily_review_cap: 140,
      desired_retention: 0.9,
    },
    reviewedToday: 63,
    againToday: 9,
    streak: 21,
    reviewedByTopic: {
      MTH165: 24,
      CSE111: 15,
      INT108: 11,
      INT335: 8,
      CSE326: 5,
    },
    gradedIds: new Set(),
  };
  return state;
}

/* Counts the dashboard shows. The queue the mock actually serves is a slice of
   a larger backlog, exactly as the real endpoint's `limit` implies. */
const BACKLOG = {
  MTH165: { due: 31, new: 4, active: 402, pending: 8 },
  CSE111: { due: 22, new: 3, active: 286, pending: 8 },
  INT108: { due: 17, new: 2, active: 241, pending: 7 },
  INT335: { due: 9, new: 2, active: 183, pending: 7 },
  CSE326: { due: 5, new: 1, active: 128, pending: 5 },
} as const;

const delay = (ms = 130) => new Promise((r) => setTimeout(r, ms));

/** Strip the fixture-only field so the shape matches the contract exactly. */
function toQueueCard(c: MockCard): QueueCard {
  return {
    id: c.id,
    kind: c.kind,
    question: c.question,
    answer: c.answer,
    cloze_text: c.cloze_text,
    topic_code: c.topic_code,
    page_ref: c.page_ref,
    is_new: c.is_new,
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
  };
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/* --- endpoints ----------------------------------------------------------- */

export async function getTopics(): Promise<Topic[]> {
  await delay();
  const s = store();
  return TOPIC_META.map((t, i) => {
    const b = BACKLOG[t.code as keyof typeof BACKLOG];
    const servedDue = s.queue.filter(
      (c) => c.topic_code === t.code && !c.is_new,
    ).length;
    const servedNew = s.queue.filter(
      (c) => c.topic_code === t.code && c.is_new,
    ).length;
    const pending = s.pending.filter((c) => c.topic_code === t.code).length;
    return {
      id: i + 1,
      code: t.code,
      label: t.label,
      due: Math.max(servedDue, Math.min(b.due, servedDue + 20)),
      new: Math.min(b.new, servedNew + 2),
      active: b.active,
      pending,
      meta: metaFor(t.code),
    };
  });
}

export async function getQueue(
  topic?: string,
  limit?: number,
): Promise<QueueResponse> {
  await delay();
  const s = store();
  const pool = topic
    ? s.queue.filter((c) => c.topic_code === topic)
    : s.queue.slice();

  const slotsLeft = Math.max(
    0,
    s.settings.daily_review_cap - s.reviewedToday,
  );
  const wanted = topic
    ? pool.length
    : Object.values(BACKLOG).reduce((n, b) => n + b.due + b.new, 0);

  const take = Math.min(pool.length, limit ?? 50, slotsLeft);
  const cards = pool.slice(0, take);

  const totalDue = Object.values(BACKLOG).reduce((n, b) => n + b.due, 0);
  const totalNew = Object.values(BACKLOG).reduce((n, b) => n + b.new, 0);
  const servedDue = cards.filter((c) => !c.is_new).length;
  const servedNew = cards.filter((c) => c.is_new).length;

  return {
    cards: cards.map(toQueueCard),
    due_remaining: topic
      ? Math.max(0, pool.filter((c) => !c.is_new).length - servedDue)
      : Math.max(0, Math.min(totalDue, slotsLeft) - servedDue),
    new_remaining: topic
      ? Math.max(0, pool.filter((c) => c.is_new).length - servedNew)
      : Math.max(0, totalNew - servedNew),
    cap_reached: !topic && wanted > slotsLeft,
  };
}

export async function postReview(
  cardId: number,
  grade: Grade,
): Promise<ReviewResponse> {
  await delay(70);
  const s = store();
  const idx = s.queue.findIndex((c) => c.id === cardId);
  const card = idx >= 0 ? s.queue[idx] : null;

  const prior =
    card && card.stability != null && card.difficulty != null
      ? { stability: card.stability, difficulty: card.difficulty }
      : null;
  const elapsed = card?.elapsed_days ?? 0;

  const next = prior
    ? nextState(prior, grade, elapsed)
    : initialState(grade);
  const days = intervalDays(next.stability, s.settings.desired_retention);

  if (idx >= 0) {
    // Grade 1 sends the card back to the end of the queue, as a real
    // scheduler's relearning step would.
    const [removed] = s.queue.splice(idx, 1);
    if (grade === 1) {
      s.queue.push({
        ...removed,
        is_new: false,
        stability: next.stability,
        difficulty: next.difficulty,
        elapsed_days: 0,
      });
      s.againToday += 1;
    }
    if (!s.gradedIds.has(cardId)) {
      s.gradedIds.add(cardId);
      s.reviewedToday += 1;
      s.reviewedByTopic[removed.topic_code] =
        (s.reviewedByTopic[removed.topic_code] ?? 0) + 1;
    }
  }

  const due = new Date();
  due.setTime(due.getTime() + days * 86400000);

  return {
    card_id: cardId,
    interval_days: Number(days.toFixed(4)),
    due_at: due.toISOString(),
    stability: Number(next.stability.toFixed(4)),
    difficulty: Number(next.difficulty.toFixed(4)),
  };
}

export async function getPending(
  limit = 50,
  offset = 0,
  topic?: string,
): Promise<PendingResponse> {
  await delay();
  const s = store();
  const pool = topic
    ? s.pending.filter((c) => c.topic_code === topic)
    : s.pending;
  return { cards: pool.slice(offset, offset + limit), total: pool.length };
}

export async function postDecide(
  ids: number[],
  _action: DecideAction,
): Promise<DecideResponse> {
  await delay(180);
  const s = store();
  const before = s.pending.length;
  s.pending = s.pending.filter((c) => !ids.includes(c.id));
  void _action;
  return { updated: before - s.pending.length };
}

export async function getSettings(): Promise<Settings> {
  await delay(80);
  return { ...store().settings };
}

export async function putSettings(patch: Partial<Settings>): Promise<Settings> {
  await delay(160);
  const s = store();
  s.settings = { ...s.settings, ...patch };
  return { ...s.settings };
}

export async function getStats(): Promise<Stats> {
  await delay();
  const s = store();
  const counts = [58, 71, 44, 0, 96, 82, 63, 77, 51, 88, 34, 69, 74];
  const last14 = counts.map((count, i) => ({
    date: isoDay(i - 13),
    count,
  }));
  last14.push({ date: isoDay(0), count: s.reviewedToday });

  return {
    today: {
      reviewed: s.reviewedToday,
      again: s.againToday,
      streak: s.streak,
    },
    by_topic: TOPIC_META.map((t, i) => {
      const b = BACKLOG[t.code as keyof typeof BACKLOG];
      return {
        id: i + 1,
        code: t.code,
        label: t.label,
        due: b?.due ?? 0,
        new: b?.new ?? 0,
        active: b?.active ?? 0,
        pending: b?.pending ?? 0,
        reviewed: s.reviewedByTopic[t.code] ?? 0,
        meta: metaFor(t.code),
      };
    }),
    last_14_days: last14,
    totals: {
      active: Object.values(BACKLOG).reduce((n, b) => n + b.active, 0),
      pending: s.pending.length,
      sources: SOURCES.length + uploaded.length,
    },
  };
}

const SOURCES: Omit<Source, "added_at">[] = [
  {
    id: 1,
    filename: MATHS_SRC,
    topic_code: "MTH165",
    accepted: 84,
    rejected: 11,
    cost_estimate: 0.0412,
  },
  {
    id: 2,
    filename: MATHS_SRC2,
    topic_code: "MTH165",
    accepted: 61,
    rejected: 7,
    cost_estimate: 0.0298,
  },
  {
    id: 3,
    filename: CSE_SRC,
    topic_code: "CSE111",
    accepted: 73,
    rejected: 19,
    cost_estimate: 0.0367,
  },
  {
    id: 4,
    filename: CSE_SRC2,
    topic_code: "CSE111",
    accepted: 48,
    rejected: 6,
    cost_estimate: 0.0221,
  },
  {
    id: 5,
    filename: INT108_SRC,
    topic_code: "INT108",
    accepted: 96,
    rejected: 14,
    cost_estimate: 0.0503,
  },
  {
    id: 6,
    filename: "int108-lab-manual-week-06.pdf",
    topic_code: "INT108",
    accepted: 39,
    rejected: 22,
    cost_estimate: 0.0187,
  },
  {
    id: 7,
    filename: INT335_SRC,
    topic_code: "INT335",
    accepted: 67,
    rejected: 9,
    cost_estimate: 0.0341,
  },
  {
    id: 8,
    filename: INT335_SRC2,
    topic_code: "INT335",
    accepted: 52,
    rejected: 5,
    cost_estimate: 0.0264,
  },
  {
    id: 9,
    filename: HTML_SRC,
    topic_code: "CSE326",
    accepted: 58,
    rejected: 12,
    cost_estimate: 0.0289,
  },
  {
    id: 10,
    filename: "html-css-layout-workshop.pdf",
    topic_code: "CSE326",
    accepted: 44,
    rejected: 8,
    cost_estimate: 0.0213,
  },
  {
    id: 11,
    filename: "maths-tutorial-sheet-07.pdf",
    topic_code: "MTH165",
    accepted: 27,
    rejected: 31,
    cost_estimate: 0.0154,
  },
  {
    id: 12,
    filename: "cse111-midterm-revision.md",
    topic_code: "CSE111",
    accepted: 19,
    rejected: 2,
    cost_estimate: 0.0071,
  },
];

const SOURCE_AGE_DAYS = [2, 5, 6, 9, 12, 14, 18, 21, 24, 27, 33, 41];

/** Anything uploaded during this tab's lifetime, newest first. */
const uploaded: Source[] = [];

export async function getSources(): Promise<Source[]> {
  await delay();
  return [
    ...uploaded,
    ...SOURCES.map((s, i) => ({
      ...s,
      added_at: isoDay(-SOURCE_AGE_DAYS[i]),
    })),
  ];
}

/* --- test mode ----------------------------------------------------------- */

const PAPERS: Record<TestKind, { target: number | null; limit: number | null }> =
  {
    class30: { target: 30, limit: 45 * 60 },
    // LPU MTE: units 1–3, marked out of 40, 90 minutes.
    mte40: { target: 40, limit: 90 * 60 },
    endterm100: { target: 100, limit: 180 * 60 },
    fullday: { target: null, limit: null },
  };

interface MockTest {
  id: number;
  kind: TestKind;
  started_at: string;
  startedMs: number;
  time_limit_s: number | null;
  /** The one subject the paper was restricted to, or null for a fullday
   *  paper, which spans every subject. */
  topic_code: string | null;
  /** 0-based unit indices the paper was scoped to, or null for the whole
   *  subject. */
  units: number[] | null;
  questions: TestQuestion[];
  seconds: Record<number, number>;
  submitted: boolean;
  obtained: number;
  duration_s: number | null;
}

const tests = new Map<number, MockTest>();
let nextTestId = 41;

/**
 * Weak first: high difficulty, low stability. A brand-new card has no state, so
 * it sits mid-table rather than pretending to be either.
 */
function weakness(c: MockCard): number {
  const d = c.difficulty ?? 5.5;
  const s = c.stability ?? 1;
  return d / Math.log2(2 + s);
}

/**
 * Assembly, per the contract: stratified across topics in proportion to their
 * active cards, weak cards preferred but not exclusively, greedy fill to hit
 * the target exactly. Returns fewer marks than asked for when the deck cannot
 * reach the target — the caller says so rather than padding.
 */
function assemble(pool: MockCard[], target: number | null): TestQuestion[] {
  const byTopic = new Map<string, MockCard[]>();
  for (const c of pool) {
    const list = byTopic.get(c.topic_code) ?? [];
    list.push(c);
    byTopic.set(c.topic_code, list);
  }

  // Within a topic: weakest first, but every fourth pick comes off the strong
  // end so a paper is not purely punishment.
  const ordered = new Map<string, MockCard[]>();
  for (const [code, cards] of byTopic) {
    const sorted = [...cards].sort((a, b) => weakness(b) - weakness(a));
    const out: MockCard[] = [];
    let head = 0;
    let tail = sorted.length - 1;
    while (head <= tail) {
      out.push(sorted[head++]);
      if (out.length % 4 === 0 && head <= tail) out.push(sorted[tail--]);
    }
    ordered.set(code, out);
  }

  // Round-robin weighted by each topic's share, which is stratification.
  const taken = new Map<string, number>();
  const draw: MockCard[] = [];
  const total = pool.length;
  for (let n = 0; n < total; n++) {
    let best: string | null = null;
    let bestRatio = Infinity;
    for (const [code, cards] of ordered) {
      const used = taken.get(code) ?? 0;
      if (used >= cards.length) continue;
      const ratio = used / (cards.length / total);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = code;
      }
    }
    if (best === null) break;
    const used = taken.get(best) ?? 0;
    draw.push(ordered.get(best)![used]);
    taken.set(best, used + 1);
  }

  const questions: TestQuestion[] = [];
  let marks = 0;
  for (const c of draw) {
    const m = marksFor(c.kind, c.answer);
    if (target !== null) {
      if (marks >= target) break;
      if (marks + m > target) continue; // too big for the gap left; keep filling
    }
    marks += m;
    questions.push({
      ordinal: questions.length + 1,
      card_id: c.id,
      kind: c.kind,
      question: c.question,
      answer: c.answer,
      cloze_text: c.cloze_text,
      marks: m,
      topic_code: c.topic_code,
      page_ref: c.page_ref,
      verdict: null,
    });
  }
  return questions;
}

export async function createTest(
  kind: TestKind,
  topicCode?: string,
  /** 1-based, as the sitPaper endpoint takes them. Stored 0-based, as the
   *  server stores them. */
  units?: number[],
): Promise<TestPaper> {
  await delay(320);
  const s = store();

  // Subjects without a mid-term at LPU must not offer one: same check, same
  // message shape as testmode.service.create_test on the server.
  if (kind === "mte40" && topicCode) {
    const meta = metaFor(topicCode);
    if (meta && meta.mte_exists === false) {
      throw new ApiError(
        422,
        "/api/tests",
        `${topicCode} has no MTE at LPU (${meta.ca_policy})`,
      );
    }
  }

  const pool = topicCode
    ? s.queue.filter((c) => c.topic_code === topicCode)
    : s.queue.slice();

  const paper = PAPERS[kind];
  const questions = assemble(pool, paper.target);
  const id = nextTestId++;
  const now = Date.now();

  tests.set(id, {
    id,
    kind,
    started_at: new Date(now).toISOString(),
    startedMs: now,
    time_limit_s: paper.limit,
    topic_code: topicCode ?? null,
    units: units?.length ? [...new Set(units.map((u) => u - 1))].sort() : null,
    questions,
    seconds: {},
    submitted: false,
    obtained: 0,
    duration_s: null,
  });

  return toPaper(tests.get(id)!);
}

function toPaper(t: MockTest): TestPaper {
  return {
    test_id: t.id,
    kind: t.kind,
    total_marks: t.questions.reduce((n, q) => n + q.marks, 0),
    time_limit_s: t.time_limit_s,
    questions: t.questions.map((q) => ({ ...q })),
  };
}

export async function getTest(id: number): Promise<TestPaper> {
  await delay();
  seedPast();
  const t = tests.get(id);
  if (!t) throw new ApiError(404, `/api/tests/${id}`, "No such test.");
  return toPaper(t);
}

export async function postAnswer(
  id: number,
  ordinal: number,
  verdict: Verdict,
  seconds: number,
): Promise<{ ok: true }> {
  await delay(60);
  const t = tests.get(id);
  if (!t) throw new ApiError(404, `/api/tests/${id}/answer`, "No such test.");
  const q = t.questions.find((x) => x.ordinal === ordinal);
  if (!q) {
    throw new ApiError(
      404,
      `/api/tests/${id}/answer`,
      `This paper has no question ${ordinal}.`,
    );
  }
  if (verdict === "partial" && q.marks < 2) {
    throw new ApiError(
      422,
      `/api/tests/${id}/answer`,
      "Partial credit needs a question worth 2 marks or more.",
    );
  }
  q.verdict = verdict;
  t.seconds[ordinal] = seconds;
  return { ok: true };
}

export async function submitTest(id: number): Promise<TestResult> {
  await delay(360);
  const t = tests.get(id);
  if (!t) throw new ApiError(404, `/api/tests/${id}/submit`, "No such test.");

  const totals = new Map<string, { obtained: number; total: number }>();
  let obtained = 0;
  for (const q of t.questions) {
    const got = scoreFor(q.verdict, q.marks);
    obtained += got;
    const row = totals.get(q.topic_code) ?? { obtained: 0, total: 0 };
    row.obtained += got;
    row.total += q.marks;
    totals.set(q.topic_code, row);
  }

  const total = t.questions.reduce((n, q) => n + q.marks, 0);
  const duration = Math.max(1, Math.round((Date.now() - t.startedMs) / 1000));

  t.submitted = true;
  t.obtained = obtained;
  t.duration_s = duration;

  return {
    obtained_marks: obtained,
    total_marks: total,
    percent: total > 0 ? Number(((obtained / total) * 100).toFixed(1)) : 0,
    duration_s: duration,
    by_topic: [...totals.entries()].map(([topic_code, r]) => ({
      topic_code,
      obtained: r.obtained,
      total: r.total,
    })),
    wrong: t.questions.filter((q) => q.verdict === "wrong").map((q) => ({ ...q })),
    partial: t.questions
      .filter((q) => q.verdict === "partial")
      .map((q) => ({ ...q })),
  };
}

/**
 * Two finished papers from earlier in the term.
 *
 * They are entries in the same map a live paper lives in, not summary rows, so
 * `GET /api/tests/{id}` answers for them exactly as the server does: the paper
 * comes back with its verdicts, and the client can see it was already
 * submitted rather than offering to sit it again.
 */
const PAST: { id: number; kind: TestKind; startedAt: string; duration: number; seed: number }[] =
  [
    {
      id: 39,
      kind: "class30",
      startedAt: `${isoDay(-9)}T09:12:00+05:30`,
      duration: 1985,
      seed: 7,
    },
    {
      id: 40,
      kind: "endterm100",
      startedAt: `${isoDay(-3)}T14:05:00+05:30`,
      duration: 8760,
      seed: 13,
    },
  ];

let seeded = false;

function seedPast() {
  if (seeded) return;
  seeded = true;
  const s = store();
  for (const p of PAST) {
    const questions = assemble(s.queue.slice(), PAPERS[p.kind].target);
    // Deterministic, and roughly the shape of a real attempt: mostly right,
    // a handful missed, one or two never attempted.
    const rand = lcg(p.seed);
    let obtained = 0;
    for (const q of questions) {
      const r = rand();
      const verdict: Verdict =
        r < 0.17 ? "wrong" : r < 0.3 && q.marks >= 2 ? "partial" : r < 0.34 ? "skipped" : "correct";
      q.verdict = verdict;
      obtained += scoreFor(verdict, q.marks);
    }
    tests.set(p.id, {
      id: p.id,
      kind: p.kind,
      started_at: p.startedAt,
      startedMs: Date.parse(p.startedAt),
      time_limit_s: PAPERS[p.kind].limit,
      // The seeded history is all all-subject papers; a fixture that named a
      // subject it had not actually filtered to would be a lie on screen.
      topic_code: null,
      units: null,
      questions,
      seconds: {},
      submitted: true,
      obtained,
      duration_s: p.duration,
    });
  }
}

export async function getTests(): Promise<TestSummary[]> {
  await delay();
  seedPast();
  // Newest first, exactly as a server ordering by started_at desc would.
  return [...tests.values()]
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      started_at: t.started_at,
      obtained_marks: t.obtained,
      total_marks: t.questions.reduce((n, q) => n + q.marks, 0),
      duration_s: t.duration_s,
      submitted_at: t.submitted ? t.started_at : null,
      topic_code: t.topic_code,
      units: t.units,
    }))
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

/** DELETE /api/tests/{id}. Same two refusals as the server: 404 for a paper
 *  that is not there, 409 for one already submitted. */
export async function abandonTest(id: number): Promise<{ ok: true }> {
  await delay();
  seedPast();
  const t = tests.get(id);
  if (!t) throw new ApiError(404, `/api/tests/${id}`, `no test ${id}`);
  if (t.submitted) {
    throw new ApiError(
      409,
      `/api/tests/${id}`,
      "cannot close a paper that has already been submitted",
    );
  }
  tests.delete(id);
  return { ok: true };
}

/* --- teaching ------------------------------------------------------------ */

const explained = new Set<number>();

/**
 * The real endpoint quotes the card's own source chunk and refuses when it
 * cannot. The fixture builds a chunk around the card's answer and quotes a
 * verbatim slice of it, so the screen renders exactly what a grounded
 * explanation renders.
 */
export async function postExplain(cardId: number): Promise<Explanation> {
  await delay(explained.has(cardId) ? 120 : 900);
  const s = store();
  const card =
    s.queue.find((c) => c.id === cardId) ??
    [...tests.values()]
      .flatMap((t) => t.questions)
      .find((q) => q.card_id === cardId);

  if (!card) {
    throw new ApiError(404, "/api/teach/explain", "No such card.");
  }

  const answer = card.answer.trim();
  const firstSentence = answer.split(/(?<=\.)\s/)[0] ?? answer;
  const marks = marksFor(card.kind, answer);

  const wasCached = explained.has(cardId);
  explained.add(cardId);

  return {
    explanation: [
      answer,
      `The source states this directly, so the mark is for reproducing the condition exactly rather than paraphrasing it. ${
        marks >= 2
          ? "On a question worth this much the working carries the marks, not the final line — write the reason down."
          : "This is a one-mark recall question: the examiner wants the exact term, nothing around it."
      }`,
      `Most common mistake: stating the conclusion without the condition it depends on. If you wrote something close but left out the qualifier, that is the half you lost.`,
    ].join("\n\n"),
    source_quote: firstSentence,
    page_ref: card.page_ref,
    topic_code: card.topic_code,
    cached: wasCached,
  };
}

/* --- upload -------------------------------------------------------------- */

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export async function uploadSource(
  file: File,
  topicCode: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  // Enough ticks that the bar visibly moves, as it would on a phone.
  for (let i = 1; i <= 10; i++) {
    if (signal?.aborted) throw new ApiError(0, "/api/sources/upload", "Upload cancelled.");
    await delay(70);
    onProgress?.(i / 10);
  }
  await delay(240);
  if (signal?.aborted) throw new ApiError(0, "/api/sources/upload", "Upload cancelled.");

  const isImage = IMAGE_EXT.test(file.name);
  // A page of printed text is roughly 2 kB of characters; a phone photo of one
  // is a couple of hundred kB of JPEG. That ratio is why OCR output always
  // looks sparse next to the file it came from.
  const textChars = isImage
    ? Math.max(40, Math.round(file.size / 900))
    : Math.max(120, Math.round(file.size / 3.2));
  const chunks = Math.max(1, Math.round(textChars / 1400));

  const id = 100 + uploaded.length;
  uploaded.unshift({
    id,
    filename: file.name,
    topic_code: topicCode,
    added_at: isoDay(0),
    accepted: 0,
    rejected: 0,
    cost_estimate: 0,
  });

  return {
    source_id: id,
    filename: file.name,
    kind: isImage ? "image" : file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "text",
    chunks,
    text_chars: textChars,
    warning: isImage
      ? "Only " +
        textChars +
        " characters came out of this image. Tesseract runs on the CPU and reads printed slides and textbook pages well, but handwriting badly. Check the generated cards carefully, or retake the photo straight-on in better light."
      : null,
  };
}

export async function generateCards(sourceId: number): Promise<GenerateResponse> {
  await delay(1500);
  const src = uploaded.find((s) => s.id === sourceId);
  const chunks = Math.max(1, Math.round((src ? 6 : 4) + (sourceId % 5)));
  const accepted = chunks * 3 + 2;
  const rejected = Math.round(accepted * 0.22);

  if (src) {
    src.accepted = accepted;
    src.rejected = rejected;
    src.cost_estimate = Number((chunks * 0.0042).toFixed(4));
  }

  const s = store();
  // Generated cards land in the triage queue, which is where the flow goes next.
  for (let i = 0; i < Math.min(accepted, 6); i++) {
    const seed = PENDING_SEEDS[i % PENDING_SEEDS.length];
    s.pending.unshift({
      id: 9000 + s.pending.length + i,
      kind: seed.k,
      question: seed.q,
      answer: seed.a,
      cloze_text: seed.c ?? null,
      topic_code: src?.topic_code ?? seed.t,
      page_ref: seed.p,
      source_filename: src?.filename ?? seed.src,
    });
  }

  return {
    accepted,
    rejected,
    cost_usd: Number((chunks * 0.0042).toFixed(4)),
    stopped_early: chunks > 9,
  };
}

/* --- auth ------------------------------------------------------------------
 * The fixture is single-tab, single-session already, so "auth" here is just
 * a boolean the tab remembers — good enough to exercise /login and the
 * AppShell gate without a real backend. */

const MOCK_USER = { id: 1, name: "yash", email: "yash@example.com" };
let mockSignedIn = true; // MOCK mode starts logged in, matching the rest of the fixture

export async function getMe(): Promise<typeof MOCK_USER> {
  await delay();
  if (!mockSignedIn) throw new ApiError(401, "/api/auth/me", "not authenticated");
  return MOCK_USER;
}

export async function postRegister(
  name: string,
  email: string,
  password: string,
): Promise<typeof MOCK_USER> {
  await delay(300);
  // Mirrors the server's own rule, so the fixture exercises the error path
  // rather than only the happy one.
  if (password.length < 8) {
    throw new ApiError(422, "/api/auth/register", "Password must be at least 8 characters.");
  }
  mockSignedIn = true;
  return { ...MOCK_USER, name, email };
}

export async function postLogin(
  email: string,
  password: string,
): Promise<typeof MOCK_USER> {
  await delay(300);
  if (!password) {
    throw new ApiError(401, "/api/auth/login", "invalid email or password");
  }
  mockSignedIn = true;
  return { ...MOCK_USER, email };
}

export async function postLogout(): Promise<{ ok: true }> {
  await delay();
  mockSignedIn = false;
  return { ok: true };
}

export async function generateFromKnowledge(
  topicCode: string,
  unit: number,
  count = 12,
): Promise<GenerateResponse> {
  await delay(1200);
  const accepted = Math.max(1, count - 3);
  const rejected = 3;
  const s = store();
  for (let i = 0; i < Math.min(accepted, 5); i++) {
    s.pending.unshift({
      id: 9500 + s.pending.length + i,
      kind: "qa",
      question: `${topicCode} unit ${unit} — generated question ${i + 1}?`,
      answer: "A generated answer from the model's own knowledge.",
      cloze_text: null,
      topic_code: topicCode,
      page_ref: `Unit ${unit}`,
      source_filename: "AI knowledge (no upload)",
      origin: "knowledge",
    });
  }
  return { accepted, rejected, cost_usd: 0.0018, stopped_early: false };
}


export async function getStudyPlan(): Promise<StudyPlanEntry[]> {
  await delay(120);
  const topics = await getTopics();
  return topics.map((t) => {
    const units = (t.meta?.units ?? []).map((name, i) => ({
      number: i + 1,
      name,
      active: i < 2 ? 6 : 0,
      due: i === 0 ? 3 : 0,
      mastery: i === 0 ? 0.41 : i === 1 ? 0.78 : 0,
    }));
    const cover = units.reduce((n, u) => n + u.active, 0);
    return {
      topic_code: t.code,
      due: t.due,
      new: t.new,
      active: t.active,
      units_cover: cover,
      weakest_unit: cover ? 1 : null,
      units,
      action: t.due
        ? { kind: "review" as const, unit: null }
        : { kind: "sit" as const, unit: 1 },
      advice: t.due
        ? `${t.due} due \u2014 review before anything else`
        : "unit 1 is your weakest \u2014 sit a test on it",
    };
  });
}

/* --- lessons -------------------------------------------------------------
   Three written lessons and nothing else, which is what the live database
   actually looks like: a handful of units written by hand over SSH and five
   subjects' worth of syllabus that nobody has got to yet. Both warranties are
   represented on purpose — MTH165 unit 1 is fully grounded, MTH165 unit 2 and
   INT335 unit 1 are not — because the whole point of the screen is that those
   two must not look the same. */

interface StoredLesson {
  id: number;
  status: LessonStatus;
  /** Verbatim, in the pipeline's own words, one sentence per line. */
  notes: string[];
  created_at: string;
  body: LessonBody;
}

const MTH165_UNIT1: StoredLesson = {
  id: 12,
  status: "grounded",
  notes: [
    "grounded: 100% of sections (5 of 5) carry a quote found verbatim in 8 passages of your course material",
    "1 citation was dropped as paraphrase: the quote first given for “Eigenvalues and eigenvectors” was close to the uploaded text but not word for word, so the section was re-cited from p22.",
    "worked example 2: the answer is a pair of eigenvectors rather than a single value, so re-solving it could not confirm or contradict it — check this one yourself.",
  ],
  created_at: "2026-08-30T11:04:22+00:00",
  body: {
    why:
      "This unit is the machinery for solving a system of linear equations without guessing: reduce the matrix, read off the rank, and say how many solutions the system has before you have found any of them. LPU examines it as short rank-and-consistency questions in CT1 and as a full row reduction plus one eigenvalue problem in the mid-term.",
    sections: [
      {
        heading: "A matrix is a system of equations, written down",
        body:
          "Every linear system you will be given in this unit has the same three parts: a coefficient matrix A, an unknown column X, and a right-hand side B, so that the whole system is AX = B. Nothing is lost in that rewriting — the rows of A are the equations and the columns are the unknowns — and everything that follows is an operation on the rows that leaves the solution set alone.\nThat is the reason row operations are allowed at all: swapping two equations, scaling one, or adding a multiple of one to another gives you a different-looking system with exactly the same solutions.",
        quote:
          "A matrix is an ordered rectangular array of numbers or functions. The numbers or functions are called the elements or the entries of the matrix.",
        source: "[1] mth165-unit1-linear-algebra.pdf p3",
      },
      {
        heading: "Elementary row operations and echelon form",
        body:
          "There are exactly three elementary row operations: interchange two rows, multiply a row by a non-zero scalar, and add a scalar multiple of one row to another. Applying them in sequence drives the matrix towards row echelon form, where each leading entry sits strictly to the right of the one above it and every all-zero row has sunk to the bottom.\nIn an exam you are marked on the sequence, not the destination. Write the operation you used beside each step (R2 → R2 − 2R1 and so on); a correct final matrix with no working attached loses most of the marks on a ten-mark question.",
        quote:
          "Two matrices are said to be row equivalent if one can be obtained from the other by a finite sequence of elementary row operations.",
        source: "[1] mth165-unit1-linear-algebra.pdf p9",
      },
      {
        heading: "Rank, and the consistency test that follows from it",
        body:
          "The rank of a matrix is the number of non-zero rows once it is in echelon form — equivalently, the order of its largest non-vanishing minor. On its own that is a number; paired with the rank of the augmented matrix it becomes the entire theory of when a system can be solved.\nThree outcomes, and only three. If rank(A) is less than rank([A : B]) the system is inconsistent and has no solution. If the two ranks are equal and match the number of unknowns, there is exactly one solution. If they are equal but smaller than the number of unknowns, the system has infinitely many solutions with (n − r) free parameters.",
        quote:
          "The system AX = B is consistent if and only if the rank of the coefficient matrix A is equal to the rank of the augmented matrix [A : B].",
        source: "[2] mth165-ct1-solved-problems.pdf p4",
      },
      {
        heading: "Finding an inverse by Gauss-Jordan",
        body:
          "Write A and the identity side by side as [A | I] and row reduce until the left block is the identity. Whatever the right block has become is A inverse. If the left block cannot be driven to the identity — a zero row appears — the matrix is singular and has no inverse, which is the same fact as det A = 0 seen from the other side.\nThis is the method to use under time pressure for a 3 × 3 matrix: the adjoint method needs nine cofactors and one determinant, and the arithmetic is where the marks go.",
        quote:
          "If A is reduced to the identity matrix I by a sequence of elementary row operations, then the same sequence of operations applied to I yields the inverse of A.",
        source: "[1] mth165-unit1-linear-algebra.pdf p14",
      },
      {
        heading: "Eigenvalues and eigenvectors",
        body:
          "An eigenvector of A is a non-zero vector whose direction A leaves alone: AX = λX for some scalar λ, the eigenvalue. Rearranged, (A − λI)X = 0 has a non-zero solution only when the matrix A − λI is singular, which is where the characteristic equation comes from.\nTwo checks worth thirty seconds each: the eigenvalues must sum to the trace of A, and their product must equal det A. If either fails, the arithmetic is wrong and there is no point finding eigenvectors for it.",
        quote:
          "The characteristic equation of a square matrix A is |A − λI| = 0, and its roots are called the eigenvalues or characteristic roots of A.",
        source: "[1] mth165-unit1-linear-algebra.pdf p22",
      },
    ],
    worked: [
      {
        question:
          "Test the system x + 2y − z = 3, 3x − y + 2z = 1, 2x − 3y + 3z = −2 for consistency and solve it if it is consistent.",
        steps: [
          "Write the augmented matrix [A : B] = [[1, 2, −1, 3], [3, −1, 2, 1], [2, −3, 3, −2]].",
          "R2 → R2 − 3R1 and R3 → R3 − 2R1, giving [[1, 2, −1, 3], [0, −7, 5, −8], [0, −7, 5, −8]].",
          "R3 → R3 − R2 clears the last row entirely: [[1, 2, −1, 3], [0, −7, 5, −8], [0, 0, 0, 0]].",
          "Both the coefficient matrix and the augmented matrix now have two non-zero rows, so rank(A) = rank([A : B]) = 2. The system is consistent.",
          "Rank 2 against 3 unknowns leaves 3 − 2 = 1 free parameter. Put z = t: from row two, y = (8 + 5t)/7; from row one, x = 3 − 2y + t = (5 − 3t)/7.",
        ],
        answer:
          "Consistent, with infinitely many solutions: x = (5 − 3t)/7, y = (8 + 5t)/7, z = t for any real t.",
      },
      {
        question:
          "Find the eigenvalues and eigenvectors of A = [[4, 1], [2, 3]].",
        steps: [
          "Form A − λI = [[4 − λ, 1], [2, 3 − λ]].",
          "Set the determinant to zero: (4 − λ)(3 − λ) − 2 = 0, so λ² − 7λ + 10 = 0.",
          "Factorise: (λ − 5)(λ − 2) = 0, so λ = 5 and λ = 2. Check: 5 + 2 = 7 = trace A, and 5 × 2 = 10 = det A.",
          "For λ = 5, (A − 5I)X = 0 gives −x + y = 0, so every eigenvector is a multiple of (1, 1).",
          "For λ = 2, (A − 2I)X = 0 gives 2x + y = 0, so every eigenvector is a multiple of (1, −2).",
        ],
        answer:
          "λ = 5 with eigenvector (1, 1), and λ = 2 with eigenvector (1, −2), each up to a non-zero scalar multiple.",
      },
    ],
    check: [
      {
        question:
          "A 3 × 4 system reduces so that rank(A) = 2 and rank([A : B]) = 3. How many solutions does it have?",
        answer: "None. The system is inconsistent.",
        why:
          "That the two ranks must be equal for a solution to exist at all is the first half of the consistency test, and it is the half people skip.",
      },
      {
        question:
          "Why does adding a multiple of one row to another leave the solution set unchanged?",
        answer:
          "Because the new equation is a consequence of the two it was built from, and the original row can be recovered by reversing the operation — so the two systems imply each other.",
        why:
          "Row reduction is only legal because it is reversible. Without that, echelon form would be a different problem, not the same one.",
      },
      {
        question:
          "The eigenvalues of a 2 × 2 matrix are 3 and −1. What are its trace and determinant?",
        answer: "Trace 2, determinant −3.",
        why:
          "The trace and determinant checks cost thirty seconds and catch nearly every arithmetic slip in a characteristic equation.",
      },
    ],
  },
};

const MTH165_UNIT2: StoredLesson = {
  id: 17,
  status: "unverified",
  notes: [
    "unverified: only 1 of 4 sections (25%) carries a quote found verbatim in your course material — the rest is the model's own knowledge",
    "3 citations were dropped as paraphrase: they were close to sentences in the uploaded notes but not word for word, and a near-quote is not a quote.",
    "the uploaded material for this unit is 6 pages of a 40-page chapter, so most of the syllabus has nothing to check against.",
    "worked example 2: the answer is prose rather than a value, so re-solving it cannot confirm or contradict it — read this one yourself.",
  ],
  created_at: "2026-09-02T19:41:07+00:00",
  body: {
    why:
      "This unit turns the derivative from a formula you can compute into a tool that answers questions: where a quantity is largest, how fast an error grows, and what a function looks like near a point you care about. LPU examines it as a mean-value or Taylor question in CT1 and as one full maxima-minima problem in the mid-term.",
    sections: [
      {
        heading: "Rolle's theorem and the mean value theorem",
        body:
          "Rolle's theorem is the special case worth memorising exactly, because every other existence result in this unit is proved from it. Its three conditions are not decoration: continuity on the closed interval, differentiability on the open one, and equal values at the endpoints. Drop any one and the conclusion fails, and examiners set exactly those counterexamples.\nThe mean value theorem removes the third condition and replaces the horizontal tangent with a tangent parallel to the chord. Everything about rates of change over an interval — including the error bounds later in this unit — comes out of it.",
        quote:
          "If f is continuous on [a, b], differentiable on (a, b), and f(a) = f(b), then there exists at least one c in (a, b) such that f′(c) = 0.",
        source: "[1] mth165-unit2-calculus-notes.pdf p7",
      },
      {
        heading: "Taylor and Maclaurin expansions",
        body:
          "A Taylor expansion is a polynomial that agrees with a function in value and in as many derivatives as you keep, at one chosen point. A Maclaurin series is the same thing with that point fixed at zero.\nFor the exam you need four expansions cold — e^x, sin x, cos x, and log(1 + x) — and the habit of writing the remainder term rather than an ellipsis. Marks in this section are usually lost by stopping too early, not by getting a coefficient wrong.",
      },
      {
        heading: "Maxima and minima of a function of one variable",
        body:
          "Stationary points come from f′(x) = 0; classifying them is the part that carries the marks. The second derivative test is fastest when f″ at the stationary point is non-zero: positive means a local minimum, negative a local maximum.\nWhen f″ vanishes the test says nothing at all, and you must fall back on the sign of f′ either side of the point. A candidate written as a maximum on the strength of an inconclusive second derivative is a wrong answer, not a rounding error.",
      },
      {
        heading: "Indeterminate forms and L'Hôpital's rule",
        body:
          "L'Hôpital's rule applies only to the forms 0/0 and ∞/∞. Everything else — 0 × ∞, ∞ − ∞, 1^∞ — has to be rearranged into one of those two first, usually by taking a logarithm or by writing the product as a quotient.\nDifferentiate the numerator and denominator separately. Applying the quotient rule here is the single most common error in this section, and it produces an answer that is wrong in a way that looks like arithmetic.",
      },
    ],
    worked: [
      {
        question:
          "Verify Rolle's theorem for f(x) = x² − 4x + 3 on [1, 3] and find the value of c.",
        steps: [
          "f is a polynomial, so it is continuous on [1, 3] and differentiable on (1, 3). The first two conditions hold everywhere.",
          "f(1) = 1 − 4 + 3 = 0 and f(3) = 9 − 12 + 3 = 0, so f(1) = f(3) and the third condition holds.",
          "Rolle's theorem therefore guarantees at least one c in (1, 3) with f′(c) = 0.",
          "f′(x) = 2x − 4. Setting 2c − 4 = 0 gives c = 2.",
          "c = 2 lies inside (1, 3), so the theorem is verified.",
        ],
        answer: "The theorem holds, with c = 2.",
      },
      {
        question:
          "A student computes lim (x → 0) of (x · cot x) by applying L'Hôpital's rule directly. What is wrong, and what is the limit?",
        steps: [
          "As x → 0, x → 0 and cot x → ∞, so the expression is of the form 0 × ∞.",
          "L'Hôpital's rule applies to 0/0 and ∞/∞ only, so it cannot be used on this expression as written.",
          "Rewrite the product as a quotient: x · cot x = x / tan x, which is 0/0 as x → 0.",
          "Now the rule applies. Differentiating top and bottom separately gives 1 / sec² x.",
          "As x → 0, sec² x → 1, so the limit is 1.",
        ],
        answer:
          "The rule was applied to a 0 × ∞ form, which is not one of its two cases; rewritten as x / tan x it is 0/0 and the limit is 1.",
      },
    ],
    check: [
      {
        question:
          "Rolle's theorem fails for f(x) = |x| on [−1, 1] even though f(−1) = f(1). Which condition is broken?",
        answer:
          "Differentiability on the open interval — f has no derivative at x = 0.",
        why:
          "Checking the conditions one at a time, rather than reciting them, is what the verification questions are actually testing.",
      },
      {
        question:
          "f′(2) = 0 and f″(2) = 0. Is x = 2 a maximum, a minimum, or neither?",
        answer:
          "The second derivative test is inconclusive; you cannot say without examining the sign of f′ on either side of 2.",
        why:
          "An inconclusive test is not permission to guess, and this is where the classification marks are usually dropped.",
      },
      {
        question: "Write the first four terms of the Maclaurin series for e^x.",
        answer: "1 + x + x²/2! + x³/3!",
        why:
          "Four standard expansions are assumed knowledge in this unit; deriving one under exam time costs you the question it was needed for.",
      },
    ],
  },
};

const INT335_UNIT1: StoredLesson = {
  id: 21,
  status: "unverified",
  notes: [
    "unverified: 2 of 5 sections (40%) carry a quote found verbatim in your course material",
    "2 citations were dropped as paraphrase: the uploaded slides state the idea but not in the wording the lesson used.",
    "no course material has been uploaded for units 3 to 6 of this subject, so nothing later in the syllabus can be anchored at all.",
    "worked example 2: the answer is a judgement about a design brief rather than a computable result, so nothing could be re-derived — read this one yourself.",
  ],
  created_at: "2026-09-05T08:12:44+00:00",
  body: {
    why:
      "This unit gives you the vocabulary to describe how a design problem is framed before anyone starts solving it, and the standard five-stage model every later unit refers back to. LPU examines it as definition-and-stage MCQs in the first CA and as one short written question asking you to place a scenario in the right stage.",
    sections: [
      {
        heading: "Design thinking is a process, not a talent",
        body:
          "The claim the whole subject rests on is that good design comes from a repeatable process rather than from inspiration. That is why the syllabus is organised around stages: each one has an output the next one consumes, and skipping a stage shows up as a specific, predictable failure later.\nFor the exam, the useful framing is that design thinking is human-centred (it starts from a person's need rather than a technology), iterative (stages are revisited, not completed once), and bias-to-action (a rough prototype beats another meeting).",
        quote:
          "Design thinking is a human-centred approach to innovation that draws from the designer's toolkit to integrate the needs of people, the possibilities of technology, and the requirements for business success.",
        source: "[1] int335-unit1-intro-slides.pdf p6",
      },
      {
        heading: "The five stages, and what each one hands on",
        body:
          "Empathise produces observations. Define turns those observations into one problem statement. Ideate turns the problem statement into a wide set of candidate solutions. Prototype turns the most promising of those into something testable at the lowest cost that still teaches you something. Test turns the prototype into evidence, which usually sends you back to an earlier stage.\nThe order matters less than the handover: every exam question about a broken project is really a question about which handover did not happen.",
        quote:
          "The five stages of design thinking are Empathise, Define, Ideate, Prototype and Test; they are modes rather than sequential steps and are frequently revisited.",
        source: "[1] int335-unit1-intro-slides.pdf p11",
      },
      {
        heading: "Convergent and divergent thinking",
        body:
          "Divergent thinking widens the set of possibilities; convergent thinking narrows it to one. The double-diamond diagram in your slides is just those two moves performed twice — once on the problem, once on the solution.\nThe practical rule, and the one that gets tested: never do both at once. Judging ideas while generating them is what produces a list of five safe options and no interesting ones.",
      },
      {
        heading: "Creativity, fixation and how it is blocked",
        body:
          "Functional fixedness is the tendency to see an object only in terms of its usual use, and it is the standard example of a creative block in this unit. The others worth naming are premature commitment to a first solution, and confirmation bias when interpreting what a user said.\nEach block has a named counter-technique in the syllabus — analogy, forced association, reframing the question as a 'How might we' — and questions tend to pair a block with its counter.",
      },
      {
        heading: "Learning, unlearning and reflective practice",
        body:
          "The unit closes on the learner rather than the design: the argument is that a designer improves by reflecting on completed cycles, and that unlearning an assumption is as much work as learning a technique.\nThis section is thin in the uploaded slides and is the part of the unit most likely to appear as a two-mark definition question rather than anything longer.",
      },
    ],
    worked: [
      {
        question:
          "A team interviews twelve hostel students about laundry, then immediately builds an app for booking machines. Which stage did they skip, and what is the predictable consequence?",
        steps: [
          "Interviews are the output of the Empathise stage, so that stage was done.",
          "Building the booking app is a Prototype activity — the team jumped from stage one to stage four.",
          "That skips Define, so the twelve interviews were never turned into a single problem statement.",
          "It also skips Ideate, so exactly one solution was ever considered, and it was the first one anybody said out loud.",
          "The predictable consequence: the prototype tests whether the app works, not whether booking was the problem. If the real complaint was drying time, the test will pass and the project will still fail.",
        ],
        answer:
          "Define and Ideate were skipped; the team will end up validating a solution to a problem they never stated.",
      },
        {
        question:
          "Two briefs: 'design a better queue display for the laundry room' and 'help students spend less time waiting for laundry'. Which is the stronger Define output, and why?",
        steps: [
          "A Define output is a problem statement, so the test is whether the brief names a need rather than a thing to build.",
          "The first brief names an artefact — a queue display — so the solution has already been chosen before Ideate begins.",
          "The second names an outcome, waiting less, and leaves the form open.",
          "Divergent thinking needs that openness: the second brief admits scheduling changes, more machines, or a notification, none of which the first brief can reach.",
          "The second is also testable in the Test stage against a measurable outcome, where the first can only be tested for whether the display works.",
        ],
        answer:
          "The second. A problem statement should name the need and leave the form of the solution open; the first has quietly performed Ideate's job and picked one.",
      },
    ],
    check: [
      {
        question: "What is the output of the Define stage?",
        answer:
          "A single problem statement, framed around a user need, that the Ideate stage can generate against.",
        why:
          "Nearly every scenario question in this unit is answered by naming the missing handover between two stages.",
      },
      {
        question:
          "Why should judgement be held back during a divergent session?",
        answer:
          "Because evaluating ideas as they appear suppresses the unusual ones, and the point of diverging is to widen the set before it is narrowed.",
        why:
          "The convergent/divergent distinction is the most frequently examined idea in the unit.",
      },
      {
        question: "Give an example of functional fixedness.",
        answer:
          "Failing to see that a chair can be a step-ladder, because it has been categorised as a thing to sit on.",
        why:
          "Blocks are examined by example, not by definition, so one concrete instance is worth more than the wording.",
      },
    ],
  },
};

/** Topic code → 1-based unit number → the lesson stored for that unit. */
const LESSONS: Record<string, Record<number, StoredLesson>> = {
  MTH165: { 1: MTH165_UNIT1, 2: MTH165_UNIT2 },
  INT335: { 1: INT335_UNIT1 },
};

/** The server counts these in Python over `body["sections"]`; so does this. */
function citedSections(body: LessonBody): number {
  return (body.sections ?? []).filter((s) => (s.quote ?? "").trim() !== "")
    .length;
}

function toLesson(stored: StoredLesson): Lesson {
  return {
    id: stored.id,
    status: stored.status,
    notes: stored.notes,
    created_at: stored.created_at,
    cited_sections: citedSections(stored.body),
    section_count: (stored.body.sections ?? []).length,
    body: stored.body,
  };
}

export async function getLessonIndex(): Promise<LessonIndexEntry[]> {
  await delay(110);
  const entries: LessonIndexEntry[] = [];
  for (const t of TOPIC_META) {
    const meta = metaFor(t.code);
    // A subject with no syllabus on record cannot have a lesson written for
    // it, so it is omitted rather than shown as six empty rows.
    if (!meta || meta.units.length === 0) continue;
    const written = LESSONS[t.code] ?? {};
    entries.push({
      topic_code: t.code,
      full_name: meta.full_name || t.label,
      written: meta.units.filter((_, i) => written[i + 1]).length,
      units: meta.units.map((name, i) => {
        const l = written[i + 1];
        return {
          number: i + 1,
          name,
          lesson: l
            ? { id: l.id, status: l.status, created_at: l.created_at }
            : null,
        };
      }),
    });
  }
  return entries;
}

export async function getLesson(
  topicCode: string,
  unit: number,
): Promise<LessonPage> {
  await delay(180);
  const path = `/api/teach/lessons/${topicCode}/${unit}`;
  const topic = TOPIC_META.find((t) => t.code === topicCode);
  // Same 404 for an unknown code and for someone else's subject: the server
  // gives no existence oracle, and neither does the fixture.
  if (!topic) {
    throw new ApiError(404, path, `no topic '${topicCode}'`);
  }
  const meta = metaFor(topicCode);
  const units = meta?.units ?? [];
  if (units.length === 0) {
    throw new ApiError(422, path, `${topicCode} has no syllabus units on record`);
  }
  if (!Number.isInteger(unit) || unit < 1 || unit > units.length) {
    throw new ApiError(
      422,
      path,
      `${topicCode} has ${units.length} units; there is no unit ${unit}`,
    );
  }
  const stored = (LESSONS[topicCode] ?? {})[unit];
  return {
    topic_code: topicCode,
    full_name: meta?.full_name || topic.label,
    unit_number: unit,
    unit_name: units[unit - 1],
    lesson: stored ? toLesson(stored) : null,
  };
}

/* --- Yash Made Test (curated MCQ bank) ------------------------------------
 *
 * The bank is shared course content, so it is a module constant rather than
 * part of the per-tab `store()`: every user reads these same questions. What IS mutable is everything a user does with them — the
 * attempts below hold their own draw, their own option permutation and their
 * own answers, so a second attempt genuinely looks different from the first.
 */

interface BankQuestion {
  key: string;
  subject_code: string;
  unit: number;
  topic: string;
  kind: McqKind;
  /** Which rung of the ladder. The fixture spreads all four across CSE111
   *  unit 1, and leaves unit 2 without a `max` question on purpose, so the
   *  picker's disabled-tier state is reachable offline. */
  difficulty: McqDifficulty;
  question: string;
  /** A snippet shown verbatim under the question, or absent. Written here as
   *  an array of lines joined with "\n", so the indentation that makes it a
   *  Python program is visible in this file too. */
  code?: string;
  /** True when the options are code or program output, shown monospace. */
  options_mono?: boolean;
  /** Exactly four, in the stored order. */
  options: string[];
  /** Index into `options` as stored, 0–3. */
  correct: number;
  explain: string;
  /** Aligned with `options`; the correct one's entry is "". */
  why_wrong: string[];
}

const MCQ_BANK: BankQuestion[] = [
  {
    key: "CSE111-U1-001",
    subject_code: "CSE111",
    unit: 1,
    topic: "Pointers",
    kind: "recall",
    difficulty: "easy",
    question: "What does the unary & operator give you when applied to a variable?",
    options: [
      "The number of bytes the variable occupies",
      "The address of the variable in memory",
      "A copy of the variable's value",
      "The value stored at the variable's address",
    ],
    correct: 1,
    explain:
      "& is the address-of operator: it yields the location of its operand, typed as a pointer to that operand's type. For int x, &x has type int *. It is the only way to obtain a pointer to an object you already have a name for.",
    why_wrong: [
      "That is sizeof, which reports storage in bytes rather than a location.",
      "",
      "Plain assignment copies a value; & never copies anything, it reports where the original lives.",
      "That is the dereference operator *, which goes the other way — from an address to the value at it.",
    ],
  },
  {
    key: "CSE111-U1-002",
    subject_code: "CSE111",
    unit: 1,
    topic: "Pointers",
    kind: "recall",
    difficulty: "medium",
    question: "Given int *p; what is the type of the expression *p?",
    options: ["int *", "void", "int", "char"],
    correct: 2,
    explain:
      "Read a declaration as an assertion about the expression: int *p says the expression *p has type int. Dereferencing strips one level of indirection, so a pointer-to-int dereferences to an int.",
    why_wrong: [
      "int * is the type of p itself, before any dereference.",
      "void appears in void * — a pointer with no target type — which is not what this declaration says.",
      "",
      "Nothing here mentions char; the target type comes from the declaration, not from the size of the value.",
    ],
  },
  {
    key: "CSE111-U1-003",
    subject_code: "CSE111",
    unit: 1,
    topic: "Pointers",
    kind: "situation",
    difficulty: "hard",
    question:
      "You write void swap(int a, int b) to exchange two values, call it, and the caller's variables are unchanged. Why?",
    options: [
      "C passes arguments by value, so the function swapped its own copies",
      "The function needs to be declared before main to take effect",
      "int is too small to swap; the values must be long",
      "The compiler optimised the swap away because it looked pointless",
    ],
    correct: 0,
    explain:
      "Every C argument is passed by value: the function receives copies, and assigning to a parameter changes only the copy. To reach the caller's objects the function must be given their addresses — void swap(int *a, int *b) — and work through *a and *b.",
    why_wrong: [
      "",
      "A missing declaration is a compile-time complaint, not a silent no-op at run time.",
      "Width has nothing to do with it; a long swap by value fails in exactly the same way.",
      "The swap is not dead code inside the function — it really does exchange the copies before they are discarded.",
    ],
  },
  {
    key: "CSE111-U1-004",
    subject_code: "CSE111",
    unit: 1,
    topic: "Pointers",
    kind: "recall",
    difficulty: "medium",
    question:
      "What does a pointer hold immediately after int *p; at block scope, before any assignment?",
    options: [
      "NULL, because C zero-initialises pointers",
      "The address of the next free byte on the stack",
      "Zero, which is safe to test but not to dereference",
      "An indeterminate value — dereferencing it is undefined behaviour",
    ],
    correct: 3,
    explain:
      "Objects with automatic storage duration are not initialised; the pointer holds whatever bit pattern was already on the stack. It is not NULL and cannot be usefully compared against anything. Initialise pointers at their declaration — int *p = NULL; — so a mistake is a predictable crash instead of a silent corruption.",
    why_wrong: [
      "Only objects with static storage duration are zero-initialised; a local pointer is not.",
      "The runtime tracks free stack space itself and never publishes it into your variables.",
      "It is not zero, and a test against NULL on an indeterminate pointer proves nothing.",
      "",
    ],
  },
  {
    key: "CSE111-U1-010",
    subject_code: "CSE111",
    unit: 1,
    topic: "Memory",
    kind: "recall",
    difficulty: "easy",
    question: "Which call returns a heap block obtained from malloc to the allocator?",
    options: ["free(p)", "delete p", "dispose(p)", "p = NULL"],
    correct: 0,
    explain:
      "free() is the counterpart of malloc/calloc/realloc, and takes the same pointer those returned. Every allocation needs exactly one free: none leaks, two is a double free and corrupts the allocator's bookkeeping.",
    why_wrong: [
      "",
      "delete is C++; in C it is not even an operator.",
      "dispose belongs to Pascal, not to the C standard library.",
      "Assigning NULL loses the only handle to the block — that is precisely how a leak is created.",
    ],
  },
  {
    key: "CSE111-U1-011",
    subject_code: "CSE111",
    unit: 1,
    topic: "Memory",
    kind: "recall",
    difficulty: "easy",
    question: "Where does a non-static local int declared inside a function live?",
    options: [
      "In the data segment, for the whole run of the program",
      "On the heap, until something frees it",
      "On the stack, for the duration of that call",
      "In a CPU register, always",
    ],
    correct: 2,
    explain:
      "A non-static local has automatic storage duration: it is created on the stack frame when the call begins and ceases to exist when the call returns. That is why returning the address of a local is a bug — the storage it names is gone before the caller can read it.",
    why_wrong: [
      "That is static storage — what you get by writing static or declaring the variable at file scope.",
      "Heap storage only comes from an explicit allocation call.",
      "",
      "The compiler may keep it in a register, but that is an optimisation, not the storage class the language defines.",
    ],
  },
  {
    key: "CSE111-U1-012",
    subject_code: "CSE111",
    unit: 1,
    topic: "Memory",
    kind: "situation",
    difficulty: "hard",
    question:
      "A long-running program calls malloc in a loop and never calls free. Its memory use climbs all day. What is the defect called?",
    options: [
      "A buffer overflow",
      "A memory leak",
      "A dangling pointer",
      "A stack overflow",
    ],
    correct: 1,
    explain:
      "A leak is allocated memory the program can no longer reach and will never release; the allocator still considers it in use, so the process footprint only grows. It is not a crash — which is what makes it easy to ship and painful to find later.",
    why_wrong: [
      "An overflow writes past the end of a block; nothing here writes out of bounds.",
      "",
      "A dangling pointer is the opposite mistake: the memory is freed and still used.",
      "The stack is untouched here; the growth is entirely on the heap.",
    ],
  },
  {
    key: "CSE111-U1-013",
    subject_code: "CSE111",
    unit: 1,
    topic: "Memory",
    kind: "situation",
    difficulty: "max",
    question:
      "You call free(p) and then read *p a few lines later. It sometimes prints the old value and sometimes garbage. What is p now?",
    options: [
      "A null pointer",
      "A void pointer",
      "A dangling pointer",
      "A const pointer",
    ],
    correct: 2,
    explain:
      "free() does not change p; it only tells the allocator the block may be reused. p still points at that address, so reading through it is undefined behaviour that often appears to work until the allocator hands the block to someone else. Set p = NULL right after freeing so the mistake fails loudly.",
    why_wrong: [
      "free() does not set the pointer to NULL — that is exactly why this bug is possible.",
      "void * describes a pointer with no target type, which has nothing to do with lifetime.",
      "",
      "const constrains what you may write through the pointer, not whether its target still exists.",
    ],
  },
  {
    key: "CSE111-U1-020",
    subject_code: "CSE111",
    unit: 1,
    topic: "Arrays",
    kind: "recall",
    difficulty: "easy",
    question: "For int a[5]; what is the index of the last element?",
    options: ["5", "4", "1", "-1"],
    correct: 1,
    explain:
      "C indexes from zero, so int a[5] holds a[0] through a[4]. The count and the last index differ by one, and mixing them up is the classic off-by-one that writes one element past the end.",
    why_wrong: [
      "a[5] is one past the last element; writing to it is undefined behaviour.",
      "",
      "a[1] is the second element, not the last.",
      "Negative indices are not wrap-around in C; a[-1] reads memory before the array.",
    ],
  },
  {
    key: "CSE111-U1-021",
    subject_code: "CSE111",
    unit: 1,
    topic: "Arrays",
    kind: "recall",
    difficulty: "medium",
    question: "What does an array's name decay to when it is passed to a function?",
    options: [
      "A pointer to its first element",
      "A copy of every element",
      "A reference to the array object",
      "The number of elements it holds",
    ],
    correct: 0,
    explain:
      "In almost every expression an array name converts to a pointer to element zero, and a parameter written int a[] is really int *a. Nothing is copied, which is why a function can modify the caller's array — and why it cannot learn the length on its own.",
    why_wrong: [
      "",
      "C never copies an array on a call; only the pointer is passed.",
      "References are a C++ feature; C has no such type.",
      "The length is not carried anywhere — the caller has to pass it separately.",
    ],
  },
  {
    key: "CSE111-U1-022",
    subject_code: "CSE111",
    unit: 1,
    topic: "Arrays",
    kind: "situation",
    difficulty: "hard",
    question:
      "Inside void f(int arr[]) you print sizeof(arr) and get 8 whatever array the caller passed. Why?",
    options: [
      "sizeof always reports 8 for arrays on a 64-bit machine",
      "The array was truncated to its first two ints when it was passed",
      "The parameter is a pointer, so sizeof measures the pointer, not the array",
      "sizeof cannot be used on a parameter and returns a default",
    ],
    correct: 2,
    explain:
      "int arr[] as a parameter means int *arr, and sizeof on a pointer gives the pointer's own width — 8 bytes on a typical 64-bit build. The length has to travel as a separate argument; sizeof only measures a real array where its declaration is visible.",
    why_wrong: [
      "sizeof on an actual array in scope gives its full size, e.g. 20 for int a[5].",
      "Nothing is truncated; the whole array is still there, the function just cannot measure it.",
      "",
      "sizeof works fine on parameters — it is simply measuring a pointer here.",
    ],
  },
  {
    key: "CSE111-U1-023",
    subject_code: "CSE111",
    unit: 1,
    topic: "Arrays",
    kind: "situation",
    difficulty: "max",
    question:
      "A loop runs for (i = 0; i <= n; i++) over int a[n] and the program crashes only sometimes. What is happening?",
    options: [
      "The loop writes a[n], one past the end, which is undefined behaviour",
      "The comparison should be < but the extra pass is harmless",
      "n is evaluated every iteration, so the loop never ends",
      "Arrays cannot be indexed by a variable in C",
    ],
    correct: 0,
    explain:
      "The last iteration touches a[n], which is outside the array. Out-of-bounds access is undefined behaviour, not a checked error: whether it crashes depends on what happens to sit in that memory, so the same bug can pass every test and fail in the demo. The condition must be i < n.",
    why_wrong: [
      "",
      "An out-of-bounds write is never harmless — it corrupts whatever is next in memory.",
      "Re-evaluating n costs nothing and does not stop the loop from terminating.",
      "Variable indices are entirely normal; the bug is the bound, not the indexing.",
    ],
  },

  /* Unit 2 — easy, easy, medium, hard. No `max` question, deliberately: a
   * tier that holds nothing for the current unit selection must show as
   * disabled rather than vanish, and this is how that is exercised. */
  {
    key: "CSE111-U2-001",
    subject_code: "CSE111",
    unit: 2,
    topic: "Strings",
    kind: "recall",
    difficulty: "easy",
    question: "What marks the end of a string in C?",
    options: [
      "A newline character",
      "A null character, '\\0'",
      "The EOF constant",
      "A space",
    ],
    correct: 1,
    explain:
      "A C string is an array of characters ending in the null character '\\0'. Every library function — strlen, strcpy, printf's %s — walks forward until it finds that byte, which is why a string with no terminator reads off the end of its array.",
    why_wrong: [
      "A newline is ordinary text inside a string; it terminates a line, not the string.",
      "",
      "EOF is a return value from file input, not a byte stored inside a string.",
      "A space is an ordinary character; strings hold spaces all the time.",
    ],
  },
  {
    key: "CSE111-U2-002",
    subject_code: "CSE111",
    unit: 2,
    topic: "Structures",
    kind: "recall",
    difficulty: "easy",
    question: "Which operator reads a member through a pointer to a struct?",
    options: ["->", ".", "::", "&"],
    correct: 0,
    explain:
      "p->x is the member access through a pointer, and is exactly (*p).x written shorter. The dot operator takes a struct value on its left, not a pointer to one.",
    why_wrong: [
      "",
      "The dot needs a struct itself on the left; through a pointer it is a compile error.",
      "C has no :: operator at all — that is C++ scope resolution.",
      "& takes an address; it does not reach inside a struct.",
    ],
  },
  {
    key: "CSE111-U2-010",
    subject_code: "CSE111",
    unit: 2,
    topic: "Files",
    kind: "recall",
    difficulty: "medium",
    question:
      "Which fopen mode opens a file for writing and throws away whatever was in it?",
    options: ['"a"', '"r+"', '"w"', '"r"'],
    correct: 2,
    explain:
      '"w" creates the file if it is missing and truncates it to zero length if it is not — the old contents are gone before you write a byte. "a" appends, "r+" updates in place without truncating, and "r" cannot write at all.',
    why_wrong: [
      '"a" keeps the file and adds to its end; nothing is lost.',
      '"r+" opens for update and leaves the existing bytes where they are.',
      "",
      '"r" is read-only: the first write fails rather than truncating anything.',
    ],
  },
  {
    key: "CSE111-U2-020",
    subject_code: "CSE111",
    unit: 2,
    topic: "Strings",
    kind: "situation",
    difficulty: "hard",
    question:
      'You have char name[8]; and call strcpy(name, "administrator"). It compiles and often appears to work. What actually happened?',
    options: [
      "strcpy stops at 8 characters, so the name is silently truncated",
      "The compiler grows name to fit the literal",
      "Thirteen characters plus a terminator were written past the end of name",
      "Nothing — strcpy allocates a new buffer and returns it",
    ],
    correct: 2,
    explain:
      "strcpy copies until the source's '\\0' and never learns how big the destination is. Fourteen bytes go into an eight-byte array, so six of them land on whatever sits next in memory. It compiles, and it often appears to work, which is exactly what makes it dangerous.",
    why_wrong: [
      "strcpy has no length to stop at; strncpy is the one that takes a bound.",
      "Array sizes are fixed at compile time; nothing grows them at a call site.",
      "",
      "strcpy writes into the buffer you hand it and allocates nothing.",
    ],
  },
  /* --- beyond CSE111 ----------------------------------------------------
   * Enough of four more subjects to reach every state the picker and the
   * sitting have: a Python program whose indentation IS the answer, a line
   * long enough to scroll sideways on a phone, options that are program
   * output, HTML with selector options, and Unicode maths. INT335 and
   * MEC103 have nothing written, so a subject waiting for material is on
   * screen too. MTH165 and INT108 have no `max` question, so switching to
   * them from a Max paper drops back to Mixed.
   */
  {
    key: "INT108-U1-001",
    subject_code: "INT108",
    unit: 1,
    topic: "Operators",
    kind: "recall",
    difficulty: "easy",
    question: "What does this print?",
    code: ["x = 7", "y = 2", "print(x // y, x % y, x / y)"].join("\n"),
    options_mono: true,
    options: ["3 1 3.5", "3.5 1 3", "3 1 3", "3.5 3.5 3.5"],
    correct: 0,
    explain:
      "// is floor division and keeps only the whole part, 3. % is the remainder, 1. / is true division and always gives a float in Python 3, 3.5. print separates its arguments with one space.",
    why_wrong: [
      "",
      "That swaps // and /: // is the one that drops the fraction.",
      "In Python 3, / never truncates — 7 / 2 is 3.5, not 3. That was Python 2's behaviour for two ints.",
      "Only / gives 3.5; // floors and % gives the remainder.",
    ],
  },
  {
    key: "INT108-U2-001",
    subject_code: "INT108",
    unit: 2,
    topic: "Loops",
    kind: "recall",
    difficulty: "medium",
    question: "What does this program print?",
    code: [
      "def f(n):",
      "    total = 0",
      "    for i in range(n):",
      "        if i % 2 == 0:",
      "            total += i",
      "    return total",
      "",
      "print(f(5))",
    ].join("\n"),
    options_mono: true,
    options: ["6", "0", "10", "4"],
    correct: 0,
    explain:
      "range(5) gives 0, 1, 2, 3 and 4, and the if keeps the even ones — 0, 2 and 4 — so total ends at 6. The return is indented to the level of the for, not inside it, so it runs once, after the loop has finished.",
    why_wrong: [
      "",
      "That is what happens if return total is indented under the for: the function returns on the first pass, while total is still 0. Here it sits outside the loop.",
      "10 is 0 + 1 + 2 + 3 + 4, every value range(5) yields; the if i % 2 == 0 skips the odd ones.",
      "4 is 1 + 3, the odd values — i % 2 == 0 is true for even i.",
    ],
  },
  {
    key: "INT108-U3-001",
    subject_code: "INT108",
    unit: 3,
    topic: "Dictionaries",
    kind: "recall",
    difficulty: "hard",
    question: "What does this print?",
    code: [
      'words = ["alpha", "beta", "gamma", "delta"]',
      'result = {w: len(w) for w in words if len(w) > 4 and not w.startswith("d")}',
      "print(result)",
    ].join("\n"),
    options_mono: true,
    options: [
      "{'alpha': 5, 'gamma': 5}",
      "{'alpha': 5, 'gamma': 5, 'delta': 5}",
      "['alpha', 'gamma']",
      "{'beta': 4}",
    ],
    correct: 0,
    explain:
      "A dict comprehension builds a key: value pair for every item that passes its if. beta fails len(w) > 4; delta passes that but fails not w.startswith(\"d\"), and the and needs both. Only alpha and gamma survive, each mapped to its length, 5.",
    why_wrong: [
      "",
      "delta has five letters, but it starts with d, so not w.startswith(\"d\") is False and the and fails.",
      "Braces around a key: value pair build a dict; square brackets would build a list.",
      "beta is the word the len(w) > 4 test removes, not the one it keeps.",
    ],
  },
  {
    // Tab-indented, with a whitespace-only line inside the loop and a line
    // long enough to scroll on a phone: the snippet states the bank's JSON
    // can hold, drawn next to INT108-U3-001 so two long blocks are
    // neighbours in a unit-3 sitting.
    key: "INT108-U3-002",
    subject_code: "INT108",
    unit: 3,
    topic: "Lists",
    kind: "recall",
    difficulty: "medium",
    question: "What does this print?",
    code: [
      "total = 0",
      'for word in ["tab", "indented", "loop", "whitespace"]:',
      "\tif len(word) > 4:",
      "\t\ttotal += len(word)  # only words longer than four letters add their length",
      "\t",
      "\telse:",
      "\t\ttotal -= 1",
      "print(total)",
    ].join("\n"),
    options_mono: true,
    options: ["16", "18", "21", "25"],
    correct: 0,
    explain:
      "tab and loop have at most four letters, so each takes the else branch and subtracts 1. indented (8) and whitespace (10) add their lengths. -1 + 8 - 1 + 10 = 16. The whitespace-only line inside the loop is ignored; the else still belongs to the if.",
    why_wrong: [
      "",
      "18 is 8 + 10 with the else branch skipped: the two short words each subtract 1.",
      "21 counts loop as longer than four letters. len(\"loop\") is 4, and 4 > 4 is False.",
      "25 adds every word's length, as if there were no if at all.",
    ],
  },
  {
    key: "CSE326-U3-001",
    subject_code: "CSE326",
    unit: 3,
    topic: "Selectors",
    kind: "situation",
    difficulty: "medium",
    question: "Given this markup, which selector styles only the About link?",
    code: [
      '<ul class="menu">',
      '  <li><a href="/">Home</a></li>',
      '  <li class="active"><a href="/about">About</a></li>',
      "</ul>",
    ].join("\n"),
    options_mono: true,
    options: [".menu .active a", ".menu a.active", "ul.active a", ".menu > a"],
    correct: 0,
    explain:
      "A space is the descendant combinator: .menu .active a matches an a anywhere inside an element with class active that is itself inside .menu. The class sits on the li, not the a, so the selector has to step through the li to reach the link.",
    why_wrong: [
      "",
      "a.active needs the class on the a itself; here it is on the li around it.",
      "ul.active needs the ul to carry the class active; the ul's class is menu.",
      "> matches direct children only, and each a is a grandchild of the ul — it sits inside an li.",
    ],
  },
  {
    key: "MTH165-U1-001",
    subject_code: "MTH165",
    unit: 1,
    topic: "Matrices",
    kind: "recall",
    difficulty: "medium",
    question: "For A = [[2, 1], [5, 3]], what is A⁻¹?",
    options_mono: true,
    options: [
      "[[3, −1], [−5, 2]]",
      "[[3, 1], [5, 2]]",
      "[[2, −1], [−5, 3]]",
      "[[−3, 1], [5, −2]]",
    ],
    correct: 0,
    explain:
      "For a 2×2 matrix [[a, b], [c, d]], A⁻¹ = (1/det A)·[[d, −b], [−c, a]]: swap the diagonal, negate the other two, divide by the determinant. Here det A = 2·3 − 1·5 = 1, so A⁻¹ = [[3, −1], [−5, 2]]. Check it: A·A⁻¹ = I.",
    why_wrong: [
      "",
      "The diagonal was swapped but the off-diagonal entries kept their signs; b and c are negated.",
      "The off-diagonal entries were negated but a and d were never swapped.",
      "That is the right matrix times −1 — what you get if det A is taken as −1 instead of 1.",
    ],
  },
  {
    key: "MTH165-U2-001",
    subject_code: "MTH165",
    unit: 2,
    topic: "Derivatives",
    kind: "recall",
    difficulty: "easy",
    question: "What is d/dx (x²·√x)?",
    options: ["(5/2)·x√x", "2x · 1/(2√x)", "(5/2)·√x", "(2/7)·x³√x"],
    correct: 0,
    explain:
      "Write it as one power first: x²·√x = x² · x^(1/2) = x^(5/2). The power rule brings the 5/2 down and lowers the power by one, to x^(3/2), which is x√x. So the derivative is (5/2)·x√x.",
    why_wrong: [
      "",
      "That multiplies the two derivatives together. The derivative of a product is not the product of the derivatives — combine the powers, or use the product rule.",
      "The power went down by two instead of one: x^(5/2) differentiates to x^(3/2) = x√x, not x^(1/2).",
      "That is the antiderivative, (2/7)·x^(7/2) — the power went up, not down.",
    ],
  },
];

/** The registry the picker reads: which subjects and units exist at all, so a
 *  unit with no questions yet still appears with a count of 0. */
const MCQ_UNITS: {
  subject_code: string;
  label: string;
  units: { unit: number; label: string }[];
}[] = [
  {
    subject_code: "CSE111",
    label: "Programming in C",
    units: [
      { unit: 1, label: "Pointers, memory and arrays" },
      { unit: 2, label: "Structures, strings and files" },
    ],
  },
  {
    subject_code: "MTH165",
    label: "Mathematics for Engineers",
    units: [
      { unit: 1, label: "Matrix Methods and Linear Systems" },
      { unit: 2, label: "Differential Calculus and Its Applications" },
      { unit: 3, label: "Fundamentals of Integral Calculus" },
    ],
  },
  {
    subject_code: "INT108",
    label: "Python Programming",
    units: [
      { unit: 1, label: "Environment, Variables, Expressions and Statements" },
      { unit: 2, label: "Conditional and Iterative Statements" },
      { unit: 3, label: "Strings, Lists, Tuples and Dictionaries" },
    ],
  },
  {
    // Nothing written yet: on the picker as a subject waiting for material.
    subject_code: "INT335",
    label: "Design Thinking",
    units: [
      { unit: 1, label: "Foundations of Learning, Creativity and Design Thinking" },
      { unit: 2, label: "Empathy, Observation and Problem Identification" },
      { unit: 3, label: "Ideation and Creative Problem Solving" },
    ],
  },
  {
    subject_code: "CSE326",
    label: "Internet Programming",
    units: [
      { unit: 1, label: "HTML Fundamentals" },
      { unit: 2, label: "Semantic HTML and Forms" },
      { unit: 3, label: "Cascading Style Sheets" },
    ],
  },
  {
    // Nothing written yet either.
    subject_code: "MEC103",
    label: "Engineering Graphics",
    units: [
      { unit: 1, label: "Introduction to Engineering Drawing" },
      { unit: 2, label: "Projections of Points, Lines and Planes" },
      { unit: 3, label: "Orthographic Projections" },
    ],
  },
];

/** Presets the picker offers. Length itself is free: any whole number from
 *  MCQ_MIN_LENGTH to MCQ_MAX_LENGTH, or "full". */
const MCQ_LENGTHS: McqLength[] = [10, 20, 30, 60, "full"];
const MCQ_MIN_LENGTH = 5;
const MCQ_MAX_LENGTH = 200;

/** The ladder, in order. */
const MCQ_DIFFICULTIES: McqDifficulty[] = ["easy", "medium", "hard", "max", "hardest"];

interface MockMcqItem {
  position: number;
  q: BankQuestion;
  /** Shown index → stored index. The client only ever sees the shown order. */
  order: number[];
  /** Shown index, or null while unanswered. */
  chosen: number | null;
}

interface MockMcqAttempt {
  id: number;
  subject_code: string;
  units: number[];
  length: McqLength;
  /** null is Mixed — drawn across the whole ladder. */
  difficulty: McqDifficulty | null;
  startedMs: number;
  started_at: string;
  submitted_at: string | null;
  items: MockMcqItem[];
  /** Stored at submit, so a second submit is the same result, not a re-score. */
  result: McqResult | null;
}

const mcqAttempts = new Map<number, MockMcqAttempt>();
let nextMcqAttemptId = 501;

function mcqShuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function mcqPool(
  subjectCode: string,
  units: number[],
  difficulty: McqDifficulty | null,
): BankQuestion[] {
  return MCQ_BANK.filter(
    (q) =>
      q.subject_code === subjectCode &&
      units.includes(q.unit) &&
      (difficulty === null || q.difficulty === difficulty),
  );
}

function mcqShownOptions(item: MockMcqItem): string[] {
  return item.order.map((stored) => item.q.options[stored]);
}

/** Where the right answer sits in the shown order. */
function mcqCorrectShown(item: MockMcqItem): number {
  return item.order.indexOf(item.q.correct);
}

function mcqIsCorrect(item: MockMcqItem): boolean {
  return item.chosen !== null && item.chosen === mcqCorrectShown(item);
}

function mcqFeedback(t: MockMcqAttempt, item: MockMcqItem): McqFeedback | null {
  if (item.chosen === null) return null;
  const correct_index = mcqCorrectShown(item);
  const is_correct = item.chosen === correct_index;
  return {
    position: item.position,
    chosen: item.chosen,
    correct_index,
    is_correct,
    explain: item.q.explain,
    why_wrong: is_correct ? "" : item.q.why_wrong[item.order[item.chosen]],
    answered: t.items.filter((i) => i.chosen !== null).length,
    correct_so_far: t.items.filter(mcqIsCorrect).length,
  };
}

function toMcqAttempt(t: MockMcqAttempt): McqAttempt {
  return {
    attempt_id: t.id,
    subject_code: t.subject_code,
    units: [...t.units],
    length: t.length,
    difficulty: t.difficulty,
    total: t.items.length,
    started_at: t.started_at,
    submitted_at: t.submitted_at,
    questions: t.items.map((item) => ({
      position: item.position,
      topic: item.q.topic,
      kind: item.q.kind,
      difficulty: item.q.difficulty,
      question: item.q.question,
      code: item.q.code ?? null,
      options_mono: item.q.options_mono ?? false,
      options: mcqShownOptions(item),
      answer: mcqFeedback(t, item),
    })),
  };
}

/** A selection is subject + units + length + difficulty, and that tuple is
 *  what a board is keyed by: Easy/30 and Hard/30 are different boards, and
 *  Mixed is its own rather than the four merged. */
function mcqSelectionKey(
  subjectCode: string,
  units: number[],
  length: McqLength,
  difficulty: McqDifficulty | null,
): string {
  return `${subjectCode}|${[...units]
    .sort((a, b) => a - b)
    .join(",")}|${length}|${difficulty ?? "mixed"}`;
}

/**
 * Three classmates who have already sat the CSE111 unit-1 **Mixed** board.
 * Every other selection — every single-tier board included — starts empty, so
 * the "be first" state is reachable in the fixture too.
 */
const MCQ_BOARD: McqLeaderboardRow[] = [
  {
    user_id: 4,
    name: "raghav",
    score: 12,
    total: 12,
    percent: 100,
    duration_s: 486,
    submitted_at: `${isoDay(-4)}T19:40:00+05:30`,
  },
  {
    user_id: 7,
    name: "satyam",
    score: 11,
    total: 12,
    percent: 92,
    duration_s: 402,
    submitted_at: `${isoDay(-6)}T21:12:00+05:30`,
  },
  {
    user_id: 9,
    name: "ishita",
    score: 10,
    total: 12,
    percent: 83,
    duration_s: 655,
    submitted_at: `${isoDay(-2)}T08:05:00+05:30`,
  },
];

function mcqBoardFor(
  subjectCode: string,
  units: number[],
  length: McqLength,
  difficulty: McqDifficulty | null,
): McqLeaderboardRow[] {
  const seeded =
    subjectCode === "CSE111" && units.includes(1) && difficulty === null
      ? MCQ_BOARD
      : [];

  // The user's own best submitted attempt for exactly this selection, which
  // is what the server ranks: one row per user, not one per attempt.
  const key = mcqSelectionKey(subjectCode, units, length, difficulty);
  let mine: McqLeaderboardRow | null = null;
  for (const t of mcqAttempts.values()) {
    if (!t.result || t.submitted_at === null) continue;
    if (
      mcqSelectionKey(t.subject_code, t.units, t.length, t.difficulty) !== key
    )
      continue;
    const row: McqLeaderboardRow = {
      user_id: MOCK_USER.id,
      name: MOCK_USER.name,
      score: t.result.score,
      total: t.result.total,
      percent: t.result.percent,
      duration_s: t.result.duration_s,
      submitted_at: t.submitted_at,
    };
    if (
      !mine ||
      row.percent > mine.percent ||
      (row.percent === mine.percent && row.duration_s < mine.duration_s)
    ) {
      mine = row;
    }
  }

  return [...seeded, ...(mine ? [mine] : [])]
    .sort((a, b) => b.percent - a.percent || a.duration_s - b.duration_s)
    .slice(0, 25);
}

export async function getMcqSubjects(): Promise<McqSubject[]> {
  await delay();
  // CONTRACT.md: subjects that hold questions first, most first; ties and the
  // subjects still waiting keep registry order (Array.sort is stable).
  const held = (code: string) =>
    MCQ_BANK.filter(
      (q) =>
        q.subject_code === code &&
        MCQ_UNITS.some(
          (s) =>
            s.subject_code === code && s.units.some((u) => u.unit === q.unit),
        ),
    ).length;
  const ordered = [...MCQ_UNITS].sort(
    (a, b) => held(b.subject_code) - held(a.subject_code),
  );
  return ordered.map((s) => ({
    subject_code: s.subject_code,
    label: s.label,
    units: s.units.map((u) => {
      const inUnit = MCQ_BANK.filter(
        (q) => q.subject_code === s.subject_code && q.unit === u.unit,
      );
      return {
        unit: u.unit,
        label: u.label,
        count: inUnit.length,
        difficulties: Object.fromEntries(
          MCQ_DIFFICULTIES.map((d) => [
            d,
            inUnit.filter((q) => q.difficulty === d).length,
          ]),
        ) as Record<McqDifficulty, number>,
      };
    }),
    lengths: [...MCQ_LENGTHS],
  }));
}

export async function createMcqAttempt(
  subjectCode: string,
  units: number[],
  length: McqLength,
  difficulty: McqDifficulty | null = null,
): Promise<McqAttempt> {
  await delay(280);
  const path = "/api/mcq/attempts";

  const subject = MCQ_UNITS.find((s) => s.subject_code === subjectCode);
  if (!subject) {
    throw new ApiError(422, path, `no subject '${subjectCode}' in the bank`);
  }
  if (units.length === 0) {
    throw new ApiError(422, path, "pick at least one unit");
  }
  for (const u of units) {
    if (!subject.units.some((x) => x.unit === u)) {
      throw new ApiError(422, path, `${subjectCode} has no unit ${u}`);
    }
  }
  // Free choice, within bounds: any whole number 5–200, or "full". Asking
  // for more than the selection holds is a shorter attempt, not an error.
  if (
    length !== "full" &&
    (!Number.isInteger(length) ||
      length < MCQ_MIN_LENGTH ||
      length > MCQ_MAX_LENGTH)
  ) {
    throw new ApiError(
      422,
      path,
      `length must be "full" or a whole number ${MCQ_MIN_LENGTH}–${MCQ_MAX_LENGTH}, got '${length}'`,
    );
  }
  if (difficulty !== null && !MCQ_DIFFICULTIES.includes(difficulty)) {
    throw new ApiError(422, path, `no such difficulty '${difficulty}'`);
  }

  const pool = mcqPool(subjectCode, units, difficulty);
  if (pool.length === 0) {
    throw new ApiError(
      422,
      path,
      difficulty === null
        ? "those units have no questions yet — they are waiting for material"
        : `those units have no ${difficulty} questions yet`,
    );
  }

  const id = nextMcqAttemptId++;
  const now = Date.now();
  // Seeded per attempt, so two sittings of the same selection genuinely
  // differ — the point of the feature, and the thing a fixture usually fakes.
  const rand = lcg(id * 2654435761 + (now & 0xffff));
  const take = length === "full" ? pool.length : Math.min(length, pool.length);
  const drawn = mcqShuffle(pool, rand).slice(0, take);

  mcqAttempts.set(id, {
    id,
    subject_code: subjectCode,
    units: [...units].sort((a, b) => a - b),
    length,
    difficulty,
    startedMs: now,
    started_at: new Date(now).toISOString(),
    submitted_at: null,
    items: drawn.map((q, i) => ({
      position: i + 1,
      q,
      order: mcqShuffle([0, 1, 2, 3], rand),
      chosen: null,
    })),
    result: null,
  });

  return toMcqAttempt(mcqAttempts.get(id)!);
}

export async function getMcqAttempt(id: number): Promise<McqAttempt> {
  await delay();
  const t = mcqAttempts.get(id);
  if (!t) throw new ApiError(404, `/api/mcq/attempts/${id}`, "no such attempt");
  return toMcqAttempt(t);
}

export async function postMcqAnswer(
  id: number,
  position: number,
  chosen: number,
): Promise<McqFeedback> {
  await delay(70);
  const path = `/api/mcq/attempts/${id}/answer`;
  const t = mcqAttempts.get(id);
  if (!t) throw new ApiError(404, path, "no such attempt");
  if (t.submitted_at !== null) {
    throw new ApiError(409, path, "this attempt has already been submitted");
  }
  const item = t.items.find((i) => i.position === position);
  if (!item) {
    throw new ApiError(422, path, `this attempt has no question ${position}`);
  }
  if (!Number.isInteger(chosen) || chosen < 0 || chosen > 3) {
    throw new ApiError(422, path, `chosen must be 0–3, got ${chosen}`);
  }
  // The first click is the answer: refusal, never an overwrite.
  if (item.chosen !== null) {
    throw new ApiError(409, path, `question ${position} is already answered`);
  }

  item.chosen = chosen;
  return mcqFeedback(t, item)!;
}

export async function submitMcqAttempt(id: number): Promise<McqResult> {
  await delay(300);
  const t = mcqAttempts.get(id);
  if (!t) throw new ApiError(404, `/api/mcq/attempts/${id}/submit`, "no such attempt");
  // Idempotent, like the guarded UPDATE on the server: the loser of the race
  // re-reads the stored result rather than scoring the attempt twice.
  if (t.result) return t.result;

  const total = t.items.length;
  const score = t.items.filter(mcqIsCorrect).length;
  const answered = t.items.filter((i) => i.chosen !== null).length;
  const duration_s = Math.max(1, Math.round((Date.now() - t.startedMs) / 1000));

  const topics = new Map<string, McqTopicScore>();
  for (const item of t.items) {
    const row = topics.get(item.q.topic) ?? {
      topic: item.q.topic,
      correct: 0,
      total: 0,
    };
    row.total += 1;
    if (mcqIsCorrect(item)) row.correct += 1;
    topics.set(item.q.topic, row);
  }

  // Ladder order, and only the tiers this attempt actually drew.
  const by_difficulty: McqDifficultyScore[] = MCQ_DIFFICULTIES.map((d) => {
    const drawn = t.items.filter((i) => i.q.difficulty === d);
    return {
      difficulty: d,
      correct: drawn.filter(mcqIsCorrect).length,
      total: drawn.length,
    };
  }).filter((row) => row.total > 0);

  const missed: McqMissed[] = t.items
    .filter((i) => !mcqIsCorrect(i))
    .map((item) => ({
      position: item.position,
      topic: item.q.topic,
      question: item.q.question,
      code: item.q.code ?? null,
      options_mono: item.q.options_mono ?? false,
      options: mcqShownOptions(item),
      chosen: item.chosen,
      correct_index: mcqCorrectShown(item),
      explain: item.q.explain,
      why_wrong:
        item.chosen === null ? "" : item.q.why_wrong[item.order[item.chosen]],
    }));

  t.submitted_at = new Date().toISOString();
  const result: McqResult = {
    attempt_id: t.id,
    score,
    total,
    answered,
    percent: total > 0 ? Math.round((100 * score) / total) : 0,
    duration_s,
    by_topic: [...topics.values()],
    by_difficulty,
    missed,
    rank: null,
  };
  t.result = result;

  if (answered > 0) {
    const board = mcqBoardFor(t.subject_code, t.units, t.length, t.difficulty);
    const at = board.findIndex(
      (r) => r.user_id === MOCK_USER.id && r.duration_s === duration_s,
    );
    if (at >= 0) result.rank = { position: at + 1, of: board.length };
  }

  return result;
}

export async function abandonMcqAttempt(id: number): Promise<{ ok: true }> {
  await delay();
  const path = `/api/mcq/attempts/${id}`;
  const t = mcqAttempts.get(id);
  if (!t) throw new ApiError(404, path, "no such attempt");
  if (t.submitted_at !== null) {
    throw new ApiError(409, path, "cannot drop an attempt that is already submitted");
  }
  mcqAttempts.delete(id);
  return { ok: true };
}

export async function getMcqAttempts(): Promise<McqAttemptSummary[]> {
  await delay();
  return [...mcqAttempts.values()]
    .map((t) => ({
      id: t.id,
      subject_code: t.subject_code,
      units: [...t.units],
      length: t.length,
      difficulty: t.difficulty,
      total: t.items.length,
      answered: t.items.filter((i) => i.chosen !== null).length,
      score: t.result ? t.result.score : null,
      started_at: t.started_at,
      submitted_at: t.submitted_at,
      duration_s: t.result ? t.result.duration_s : null,
    }))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

export async function getMcqLeaderboard(
  subjectCode: string,
  units: number[],
  length: McqLength,
  difficulty: McqDifficulty | null = null,
): Promise<McqLeaderboardRow[]> {
  await delay();
  return mcqBoardFor(subjectCode, units, length, difficulty);
}
