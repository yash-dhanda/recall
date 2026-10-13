import sqlite3
from importlib import resources


def connect(db_path: str) -> sqlite3.Connection:
    # check_same_thread=False because FastAPI runs a sync dependency's setup and
    # its teardown on DIFFERENT threadpool threads, so the connection is opened in
    # one thread and closed in another. Safe here: every request gets its own
    # connection and uses it sequentially, so no connection is ever shared between
    # concurrent threads. Without this, a page that fires several requests at once
    # 500s on most of them.
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # Open registration is the first thing that makes concurrent writers a
    # real scenario (one implicit user never contended). Without this, a
    # second request landing mid-write gets "database is locked" instead of
    # just waiting the ~instant it takes the first to finish.
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    # Repair BEFORE the schema script: a table whose foreign key dangles at a
    # dropped table makes even CREATE INDEX IF NOT EXISTS fail, because SQLite
    # re-parses the referencing table's definition on the way.
    _repair_dangling_test_questions(conn)
    sql = resources.files("recall").joinpath("schema.sql").read_text()
    conn.executescript(sql)
    _migrate(conn)
    conn.commit()


def _repair_dangling_test_questions(conn: sqlite3.Connection) -> None:
    """Fix databases the earlier, wrong-order tests rebuild damaged.

    That migration renamed the OLD tests table away, which rewrote
    test_questions' foreign key to "tests_old" — then dropped tests_old.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='test_questions'"
    ).fetchone()
    if not (row and "tests_old" in (row["sql"] or "")):
        return
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("""CREATE TABLE test_questions_new (
          id        INTEGER PRIMARY KEY,
          test_id   INTEGER NOT NULL REFERENCES tests(id),
          card_id   INTEGER NOT NULL REFERENCES cards(id),
          ordinal   INTEGER NOT NULL,
          marks     INTEGER NOT NULL,
          verdict   TEXT CHECK (verdict IN ('correct','partial','wrong','skipped')),
          seconds   INTEGER,
          UNIQUE(test_id, ordinal)
        )""")
        conn.execute("INSERT INTO test_questions_new SELECT * FROM test_questions")
        conn.execute("DROP TABLE test_questions")
        conn.execute("ALTER TABLE test_questions_new RENAME TO test_questions")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_test_questions_test ON test_questions(test_id)"
        )
        conn.commit()
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring a pre-existing database up to the current schema.

    schema.sql is CREATE IF NOT EXISTS, so it never alters live tables; the
    deltas that need real migration live here, each one idempotent.
    """
    # topics.meta (2026-09-05, LPU subject metadata)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(topics)").fetchall()}
    if cols and "meta" not in cols:
        conn.execute("ALTER TABLE topics ADD COLUMN meta TEXT")

    # cards.origin (2026-09-07, knowledge mode). SQLite cannot add a CHECK to
    # an EXISTING column, but it can add a NEW column that carries one, so this
    # needs no table rebuild — unlike the tests.kind change below. The DEFAULT
    # backfills every existing row as 'upload', which is exactly what they are.
    card_cols = {r["name"] for r in conn.execute("PRAGMA table_info(cards)").fetchall()}
    if card_cols and "origin" not in card_cols:
        conn.execute(
            "ALTER TABLE cards ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload'"
            " CHECK (origin IN ('upload','knowledge'))"
        )
    if card_cols:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cards_origin ON cards(origin)")

    # cards.detail (2026-09-07): the worked explanation shown after the answer.
    if card_cols and "detail" not in card_cols:
        conn.execute("ALTER TABLE cards ADD COLUMN detail TEXT")

    # tests.units_json (2026-09-08): which syllabus units a paper was scoped
    # to, as a JSON array of 0-based indices, or NULL for a paper that drew
    # from the whole subject. Stored rather than derived because the paper is
    # materialised into test_questions at creation — after that, nothing about
    # the rows says what the scope had been, and "Unit 3 test" is the label a
    # resumed paper has to be able to show.
    test_cols = {r["name"] for r in conn.execute("PRAGMA table_info(tests)").fetchall()}
    if test_cols and "units_json" not in test_cols:
        conn.execute("ALTER TABLE tests ADD COLUMN units_json TEXT")

    # users.email/password_hash/created_at (2026-09-07, open registration).
    # No CHECK constraint on any of these, so a plain ADD COLUMN is legal SQL
    # — unlike the tests.kind CHECK below, this needs no table rebuild.
    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if user_cols and "email" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN email TEXT")
        conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
        conn.execute("ALTER TABLE users ADD COLUMN created_at TEXT")
    # Unconditional and idempotent: covers both a database that just gained
    # the email column above and a fresh one where schema.sql's CREATE TABLE
    # already had it — schema.sql itself can't create this index, since it
    # runs before the ALTER above on any pre-existing database (see the
    # comment on the users table there).
    if user_cols:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")

    # mcq_questions.difficulty / mcq_attempts.difficulty (2026-09-21, the
    # Yash Made Test difficulty ladder). The live database has real attempts in
    # it, so this is ADD COLUMN and not a rebuild: neither column carries a
    # CHECK — the four tiers are validated in recall.mcq.bank — so plain ALTERs
    # are legal SQL here and nothing has to be copied.
    #
    # The DEFAULT on the questions column backfills every existing row as
    # 'medium', which is the honest reading of a bank written before the ladder
    # existed; re-seeding then overwrites each row with the tier its JSON now
    # declares. The attempts column is deliberately NULLable with no default:
    # NULL means Mixed, and every attempt that predates the ladder genuinely
    # drew across all of it.
    mcqq_cols = {r["name"] for r in
                 conn.execute("PRAGMA table_info(mcq_questions)").fetchall()}
    if mcqq_cols and "difficulty" not in mcqq_cols:
        conn.execute("ALTER TABLE mcq_questions ADD COLUMN difficulty TEXT"
                     " NOT NULL DEFAULT 'medium'")
    # Unconditional and idempotent, and it cannot live in schema.sql: that
    # script runs before the ALTER above, so on any pre-existing database the
    # column does not exist yet when it executes.
    if mcqq_cols:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mcq_questions_difficulty"
                     " ON mcq_questions(subject_code, unit, difficulty)")
    mcqa_cols = {r["name"] for r in
                 conn.execute("PRAGMA table_info(mcq_attempts)").fetchall()}
    if mcqa_cols and "difficulty" not in mcqa_cols:
        conn.execute("ALTER TABLE mcq_attempts ADD COLUMN difficulty TEXT")

    # mcq_questions.code / mcq_questions.options_mono (2026-09-23, code
    # questions for INT108 and CSE326). Same recipe as difficulty above and for
    # the same reason — the live table holds the CSE111 bank and real attempts
    # point at its row ids, so it gains columns and is never rebuilt. Neither
    # carries a CHECK. `code` is NULL for every existing row, which is exactly
    # what a question with no snippet is; `options_mono` backfills 0, prose,
    # which every CSE111 option is. Re-seeding then writes whatever the JSON
    # declares. `mcqq_cols` was read before the difficulty ALTER, which is fine:
    # that ALTER adds neither of these.
    if mcqq_cols and "code" not in mcqq_cols:
        conn.execute("ALTER TABLE mcq_questions ADD COLUMN code TEXT")
    if mcqq_cols and "options_mono" not in mcqq_cols:
        conn.execute("ALTER TABLE mcq_questions ADD COLUMN options_mono INTEGER"
                     " NOT NULL DEFAULT 0")

    # mcq_attempts.mode / .source / .time_limit_s (2026-09-23, exam mode and
    # "practise my mistakes"). The live table holds real users' attempts, so
    # ADD COLUMN and never a rebuild; none carries a CHECK — the values are
    # validated in recall.mcq.service against registry.MODES and SOURCES. The
    # two DEFAULTs backfill every existing row as a practice sitting drawn from
    # the bank, which is exactly what each one was, so every old attempt stays
    # on the board it was already on. time_limit_s is NULL for all of them: a
    # practice sitting has no clock. `mcqa_cols` was read before the
    # difficulty ALTER above, which adds none of these.
    if mcqa_cols and "mode" not in mcqa_cols:
        conn.execute("ALTER TABLE mcq_attempts ADD COLUMN mode TEXT"
                     " NOT NULL DEFAULT 'practice'")
    if mcqa_cols and "source" not in mcqa_cols:
        conn.execute("ALTER TABLE mcq_attempts ADD COLUMN source TEXT"
                     " NOT NULL DEFAULT 'bank'")
    if mcqa_cols and "time_limit_s" not in mcqa_cols:
        conn.execute("ALTER TABLE mcq_attempts ADD COLUMN time_limit_s INTEGER")

    # tests.kind CHECK gained 'mte40'. SQLite cannot alter a CHECK, so rebuild —
    # and the ORDER MATTERS: renaming the OLD table away rewrites every foreign
    # key that pointed at it (test_questions ended up referencing "tests_old"),
    # so the new table is built under a temp name and renamed INTO place last,
    # per the documented 12-step recipe.
    _TESTS_DDL = """(
                  id             INTEGER PRIMARY KEY,
                  user_id        INTEGER NOT NULL REFERENCES users(id),
                  kind           TEXT NOT NULL CHECK (kind IN ('class30','mte40','endterm100','fullday')),
                  topic_id       INTEGER REFERENCES topics(id),
                  target_marks   INTEGER NOT NULL,
                  total_marks    INTEGER NOT NULL,
                  time_limit_s   INTEGER,
                  started_at     TEXT NOT NULL,
                  submitted_at   TEXT,
                  duration_s     INTEGER,
                  obtained_marks REAL,
                  units_json     TEXT
                )"""
    # Named columns, not SELECT *. The positional form broke the moment a
    # column was added above this block: the old table had 12 columns and this
    # DDL declared 11, and SQLite refused mid-migration. Naming them means the
    # next ADD COLUMN is free.
    _TESTS_COLS = (
        "id, user_id, kind, topic_id, target_marks, total_marks,"
        " time_limit_s, started_at, submitted_at, duration_s, obtained_marks,"
        " units_json"
    )
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tests'"
    ).fetchone()
    if row and "mte40" not in (row["sql"] or ""):
        # `PRAGMA foreign_keys` is a NO-OP inside a transaction, and the
        # sqlite3 module has already opened one by the time we get here. So
        # both the OFF and the ON below did nothing at all — measured: the
        # connection came in with enforcement on and left with it off,
        # because the no-op OFF was followed by a DDL statement that
        # implicitly committed and THEN let a later pragma take effect. Commit
        # first so each toggle is outside a transaction and actually lands,
        # and restore what was there rather than assuming it was on.
        was_on = conn.execute("PRAGMA foreign_keys").fetchone()[0]
        conn.commit()
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            # A previous run killed between CREATE and RENAME leaves this
            # table behind, and every later migration then dies on "table
            # tests_new already exists" — a half-finished migration that
            # bricks the next one is worse than the problem it was fixing.
            conn.execute("DROP TABLE IF EXISTS tests_new")
            conn.execute(f"CREATE TABLE tests_new {_TESTS_DDL}")
            conn.execute(
                f"INSERT INTO tests_new ({_TESTS_COLS})"
                f" SELECT {_TESTS_COLS} FROM tests")
            conn.execute("DROP TABLE tests")
            conn.execute("ALTER TABLE tests_new RENAME TO tests")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_tests_user ON tests(user_id, started_at)"
            )
            conn.commit()
        finally:
            conn.commit()
            conn.execute(f"PRAGMA foreign_keys = {'ON' if was_on else 'OFF'}")
