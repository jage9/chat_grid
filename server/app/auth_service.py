"""Account and session persistence service for websocket authentication."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import logging
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError


SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
ARGON2_TIME_COST = 3
ARGON2_MEMORY_COST = 65536
ARGON2_PARALLELISM = 1
ARGON2_HASH_LEN = 32
ARGON2_SALT_LEN = 16
USERNAME_PATTERN = re.compile(r"^[a-z0-9_-]+$")
LOGGER = logging.getLogger("chgrid.server.auth")


def _build_dummy_password_hash(password_hasher: PasswordHasher) -> str:
    """Build one deterministic Argon2id hash used to equalize login miss timing."""

    return password_hasher.hash("chgrid_dummy_password")


@dataclass(frozen=True)
class AuthUser:
    """Authenticated account identity details."""

    id: str
    username: str
    role: str
    status: str
    email: str | None
    last_nickname: str | None
    last_x: int | None
    last_y: int | None


@dataclass(frozen=True)
class AuthSession:
    """Session validation result with user identity."""

    session_id: str
    token: str
    user: AuthUser


class AuthError(ValueError):
    """Raised when authentication input or policy checks fail."""


class AuthService:
    """Manages account registration, login, and rolling session validation."""

    def __init__(
        self,
        db_path: Path,
        token_hash_secret: str,
        password_min_length: int,
        password_max_length: int,
        username_min_length: int,
        username_max_length: int,
    ):
        """Initialize auth database connection and schema."""

        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.password_min_length = max(1, int(password_min_length))
        self.password_max_length = max(self.password_min_length, int(password_max_length))
        self.username_min_length = max(1, int(username_min_length))
        self.username_max_length = max(self.username_min_length, int(username_max_length))
        secret = token_hash_secret.strip()
        if not secret:
            raise AuthError("CHGRID_AUTH_SECRET is required when auth is enabled.")
        self._token_secret = secret.encode("utf-8")
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn_lock = threading.RLock()
        self._password_hasher = PasswordHasher(
            time_cost=ARGON2_TIME_COST,
            memory_cost=ARGON2_MEMORY_COST,
            parallelism=ARGON2_PARALLELISM,
            hash_len=ARGON2_HASH_LEN,
            salt_len=ARGON2_SALT_LEN,
        )
        self._dummy_password_hash = _build_dummy_password_hash(self._password_hasher)
        self._ensure_schema()

    def close(self) -> None:
        """Close the underlying SQLite connection."""

        with self._conn_lock:
            self._conn.close()

    def bootstrap_admin(self, username: str, password: str, email: str | None = None) -> AuthUser:
        """Create the first admin account, or fail if one already exists."""

        if self.has_admin():
            raise AuthError("An admin account already exists.")
        created = self.register(username, password, email=email, role="admin")
        return created.user

    def has_admin(self) -> bool:
        """Return True when at least one admin account exists."""

        existing = self._db_fetchone("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1")
        return existing is not None

    def register(
        self,
        username: str,
        password: str,
        *,
        email: str | None = None,
        role: str = "user",
    ) -> AuthSession:
        """Register an account and issue a session token."""

        with self._conn_lock:
            normalized_username = self._normalize_username(username)
            try:
                self._validate_username(normalized_username)
                self._validate_password(password)
                normalized_email = self._normalize_email(email)
                if role not in {"user", "admin"}:
                    raise AuthError("role must be user or admin.")
                now_ms = self.now_ms()
                password_hash = self._hash_password(password)
                self._db_execute(
                    """
                    INSERT INTO users (
                        username, password_hash, email, role, status, created_at_ms, updated_at_ms, last_login_at_ms
                    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
                    """,
                    (normalized_username, password_hash, normalized_email, role, now_ms, now_ms, now_ms),
                )
                self._db_commit()
            except sqlite3.IntegrityError as exc:
                message = str(exc).lower()
                if "users.username" in message:
                    LOGGER.warning("register rejected username_taken username=%s", normalized_username)
                    raise AuthError("Username is already taken.") from exc
                if "users.email" in message:
                    LOGGER.warning("register rejected email_taken username=%s", normalized_username)
                    raise AuthError("Email is already in use.") from exc
                LOGGER.exception("register sqlite integrity failure username=%s", normalized_username)
                raise AuthError("Registration failed due to a database constraint.") from exc
            except AuthError as exc:
                LOGGER.warning("register rejected username=%s reason=%s", normalized_username, str(exc))
                raise
            except Exception as exc:
                LOGGER.exception("register unexpected failure username=%s", normalized_username)
                raise AuthError("Registration failed due to a server error.") from exc
            user = self._get_user_by_username(normalized_username)
            if user is None:
                LOGGER.error("register created user missing username=%s", normalized_username)
                raise AuthError("Failed to load newly created user.")
            self._db_execute(
                """
                INSERT OR IGNORE INTO user_state (user_id, last_nickname, last_x, last_y, updated_at_ms)
                VALUES (?, ?, NULL, NULL, ?)
                """,
                (int(user.id), user.username, now_ms),
            )
            self._db_commit()
            user = AuthUser(
                id=user.id,
                username=user.username,
                role=user.role,
                status=user.status,
                email=user.email,
                last_nickname=user.username,
                last_x=user.last_x,
                last_y=user.last_y,
            )
            return self._create_session(user)

    def login(self, username: str, password: str) -> AuthSession:
        """Authenticate credentials and issue a fresh session."""

        with self._conn_lock:
            normalized_username = self._normalize_username(username)
            user_row = self._db_fetchone(
                """
                SELECT
                    u.id,
                    u.username,
                    u.password_hash,
                    u.email,
                    u.role,
                    u.status,
                    us.last_nickname,
                    us.last_x,
                    us.last_y
                FROM users u
                LEFT JOIN user_state us ON us.user_id = u.id
                WHERE u.username = ?
                """,
                (normalized_username,),
            )
            if user_row is None:
                # Keep response timing aligned with existing-user password checks.
                self._verify_password(password, self._dummy_password_hash)
                raise AuthError("Invalid username or password.")
            if user_row["status"] != "active":
                raise AuthError("Account is disabled.")
            if not self._verify_password(password, user_row["password_hash"]):
                raise AuthError("Invalid username or password.")
            if self._password_hasher.check_needs_rehash(user_row["password_hash"]):
                self._db_execute(
                    "UPDATE users SET password_hash = ?, updated_at_ms = ? WHERE id = ?",
                    (self._hash_password(password), self.now_ms(), user_row["id"]),
                )
            user = self._row_to_user(user_row)
            if not user.last_nickname:
                self.set_last_nickname(user.id, user.username)
                user = AuthUser(
                    id=user.id,
                    username=user.username,
                    role=user.role,
                    status=user.status,
                    email=user.email,
                    last_nickname=user.username,
                    last_x=user.last_x,
                    last_y=user.last_y,
                )
            now_ms = self.now_ms()
            self._db_execute(
                "UPDATE users SET last_login_at_ms = ?, updated_at_ms = ? WHERE id = ?",
                (now_ms, now_ms, user.id),
            )
            self._db_commit()
            return self._create_session(user)

    def resume(self, token: str) -> AuthSession:
        """Validate a session token and apply rolling expiry."""

        with self._conn_lock:
            cleaned = token.strip()
            if not cleaned:
                raise AuthError("Missing session token.")
            token_hash = self._hash_token(cleaned)
            row = self._db_fetchone(
                """
                SELECT s.id AS session_id, s.user_id, s.expires_at_ms, s.revoked_at_ms,
                       u.username, u.role, u.status, u.email, us.last_nickname, us.last_x, us.last_y
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                LEFT JOIN user_state us ON us.user_id = u.id
                WHERE s.token_hash = ?
                """,
                (token_hash,),
            )
            if row is None:
                raise AuthError("Invalid session.")
            if row["revoked_at_ms"] is not None:
                raise AuthError("Session has been revoked.")
            now_ms = self.now_ms()
            if int(row["expires_at_ms"]) <= now_ms:
                self._db_execute("UPDATE sessions SET revoked_at_ms = ? WHERE id = ?", (now_ms, row["session_id"]))
                self._db_commit()
                raise AuthError("Session has expired.")
            if row["status"] != "active":
                raise AuthError("Account is disabled.")
            new_expiry = now_ms + SESSION_TTL_MS
            self._db_execute(
                "UPDATE sessions SET last_seen_at_ms = ?, expires_at_ms = ? WHERE id = ?",
                (now_ms, new_expiry, row["session_id"]),
            )
            self._db_commit()
            user = AuthUser(
                id=str(row["user_id"]),
                username=row["username"],
                role=row["role"],
                status=row["status"],
                email=row["email"],
                last_nickname=row["last_nickname"],
                last_x=row["last_x"] if "last_x" in row.keys() else None,
                last_y=row["last_y"] if "last_y" in row.keys() else None,
            )
            if not user.last_nickname:
                self.set_last_nickname(user.id, user.username)
                user = AuthUser(
                    id=user.id,
                    username=user.username,
                    role=user.role,
                    status=user.status,
                    email=user.email,
                    last_nickname=user.username,
                    last_x=user.last_x,
                    last_y=user.last_y,
                )
            return AuthSession(session_id=row["session_id"], token=cleaned, user=user)

    def revoke(self, token: str) -> None:
        """Revoke a session token if it exists."""

        cleaned = token.strip()
        if not cleaned:
            return
        token_hash = self._hash_token(cleaned)
        self._db_execute(
            "UPDATE sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL",
            (self.now_ms(), token_hash),
        )
        self._db_commit()

    def set_last_nickname(self, user_id: str, nickname: str) -> None:
        """Persist the most recent nickname for one user."""

        cleaned = nickname.strip()
        if not cleaned:
            return
        try:
            user_id_value = int(user_id)
        except (TypeError, ValueError):
            return
        try:
            self._db_execute(
                """
                INSERT INTO user_state (user_id, last_nickname, last_x, last_y, updated_at_ms)
                VALUES (?, ?, NULL, NULL, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    last_nickname = excluded.last_nickname,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (user_id_value, cleaned, self.now_ms()),
            )
            self._db_commit()
        except sqlite3.IntegrityError:
            self._db_rollback()

    def set_last_position(self, user_id: str, x: int, y: int) -> None:
        """Persist last known world position for one user."""

        try:
            user_id_value = int(user_id)
        except (TypeError, ValueError):
            return
        try:
            self._db_execute(
                """
                INSERT INTO user_state (user_id, last_nickname, last_x, last_y, updated_at_ms)
                VALUES (?, NULL, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    last_x = excluded.last_x,
                    last_y = excluded.last_y,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (user_id_value, int(x), int(y), self.now_ms()),
            )
            self._db_commit()
        except sqlite3.IntegrityError:
            self._db_rollback()

    @staticmethod
    def now_ms() -> int:
        """Return unix epoch timestamp in milliseconds."""

        return int(time.time() * 1000)

    def _ensure_schema(self) -> None:
        """Create required auth tables and indexes when missing."""

        with self._conn_lock:
            self._db_execute("PRAGMA foreign_keys = ON")
            self._db_execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                email TEXT UNIQUE,
                role TEXT NOT NULL CHECK(role IN ('user', 'admin')) DEFAULT 'user',
                status TEXT NOT NULL CHECK(status IN ('active', 'disabled')) DEFAULT 'active',
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                last_login_at_ms INTEGER
            )
            """
        )
            self._db_execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at_ms INTEGER NOT NULL,
                last_seen_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                revoked_at_ms INTEGER,
                ip TEXT,
                user_agent TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
            self._db_execute(
            """
            CREATE TABLE IF NOT EXISTS user_state (
                user_id INTEGER PRIMARY KEY,
                last_nickname TEXT,
                last_x INTEGER,
                last_y INTEGER,
                updated_at_ms INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
            """
        )
            self._db_execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")
            self._db_execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL"
            )
            self._db_execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
            self._db_execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at_ms)")
            self._db_execute("CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)")
            self._db_execute("CREATE INDEX IF NOT EXISTS idx_user_state_updated ON user_state(updated_at_ms)")
            self._db_commit()

    def _create_session(self, user: AuthUser) -> AuthSession:
        """Issue and persist a new session token for a user."""

        token = secrets.token_urlsafe(48)
        token_hash = self._hash_token(token)
        now_ms = self.now_ms()
        expires_at_ms = now_ms + SESSION_TTL_MS
        self._db_execute(
            """
            INSERT INTO sessions (user_id, token_hash, created_at_ms, last_seen_at_ms, expires_at_ms, revoked_at_ms, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
            """,
            (user.id, token_hash, now_ms, now_ms, expires_at_ms),
        )
        row = self._db_fetchone("SELECT last_insert_rowid() AS id")
        if row is None:
            raise AuthError("Failed to create session.")
        session_id = str(row["id"])
        self._db_commit()
        return AuthSession(session_id=session_id, token=token, user=user)

    def _get_user_by_username(self, username: str) -> AuthUser | None:
        """Fetch one user by normalized username."""

        row = self._db_fetchone(
            """
            SELECT
                u.id,
                u.username,
                u.role,
                u.status,
                u.email,
                us.last_nickname,
                us.last_x,
                us.last_y
            FROM users u
            LEFT JOIN user_state us ON us.user_id = u.id
            WHERE u.username = ?
            """,
            (username,),
        )
        if row is None:
            return None
        return self._row_to_user(row)

    def _db_execute(self, sql: str, params: tuple | None = None) -> sqlite3.Cursor:
        """Run one SQL statement with a thread-safe connection lock."""

        with self._conn_lock:
            return self._conn.execute(sql, params or ())

    def _db_fetchone(self, sql: str, params: tuple | None = None) -> sqlite3.Row | None:
        """Run one query and fetch a single row with connection locking."""

        with self._conn_lock:
            return self._conn.execute(sql, params or ()).fetchone()

    def _db_commit(self) -> None:
        """Commit pending DB writes with connection locking."""

        with self._conn_lock:
            self._conn.commit()

    def _db_rollback(self) -> None:
        """Rollback pending DB writes with connection locking."""

        with self._conn_lock:
            self._conn.rollback()

    @staticmethod
    def _row_to_user(row: sqlite3.Row) -> AuthUser:
        """Convert a DB row into AuthUser."""

        return AuthUser(
            id=str(row["id"]),
            username=row["username"],
            role=row["role"],
            status=row["status"],
            email=row["email"],
            last_nickname=row["last_nickname"] if "last_nickname" in row.keys() else None,
            last_x=row["last_x"] if "last_x" in row.keys() else None,
            last_y=row["last_y"] if "last_y" in row.keys() else None,
        )

    @staticmethod
    def _normalize_username(username: str) -> str:
        """Normalize username into canonical stored form."""

        return username.strip().lower()

    @staticmethod
    def _normalize_email(email: str | None) -> str | None:
        """Normalize optional email and collapse blanks to None."""

        if email is None:
            return None
        cleaned = email.strip().lower()
        return cleaned or None

    def _validate_username(self, username: str) -> None:
        """Validate username against length and character policy."""

        if not (self.username_min_length <= len(username) <= self.username_max_length):
            raise AuthError(
                f"Username must be between {self.username_min_length} and {self.username_max_length} characters."
            )
        if USERNAME_PATTERN.fullmatch(username) is None:
            raise AuthError("Username may include lowercase letters, numbers, underscores, and dashes only.")

    def _validate_password(self, password: str) -> None:
        """Validate password length policy."""

        if not (self.password_min_length <= len(password) <= self.password_max_length):
            raise AuthError(
                f"Password must be between {self.password_min_length} and {self.password_max_length} characters."
            )

    def _hash_password(self, password: str) -> str:
        """Hash a password using Argon2id."""

        return self._password_hasher.hash(password)

    def _verify_password(self, password: str, stored: str) -> bool:
        """Verify plaintext password against stored Argon2id hash."""

        try:
            return bool(self._password_hasher.verify(stored, password))
        except (VerifyMismatchError, InvalidHashError, VerificationError):
            return False

    def _hash_token(self, token: str) -> str:
        """Hash a session token with server secret before persistence."""

        return hmac.new(self._token_secret, token.encode("utf-8"), hashlib.sha256).hexdigest()
