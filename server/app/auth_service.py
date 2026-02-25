"""Account and session persistence service for websocket authentication."""

from __future__ import annotations

from dataclasses import dataclass
import base64
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time


SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
SALT_BYTES = 16
PBKDF2_ITERATIONS = 310_000
PBKDF2_DKLEN = 32
USERNAME_PATTERN = re.compile(r"^[a-z0-9_-]+$")


@dataclass(frozen=True)
class AuthUser:
    """Authenticated account identity details."""

    id: str
    username: str
    role: str
    status: str
    email: str | None
    last_nickname: str | None


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
        self._ensure_schema()

    def close(self) -> None:
        """Close the underlying SQLite connection."""

        self._conn.close()

    def bootstrap_admin(self, username: str, password: str, email: str | None = None) -> AuthUser:
        """Create the first admin account, or fail if one already exists."""

        if self.has_admin():
            raise AuthError("An admin account already exists.")
        created = self.register(username, password, email=email, role="admin")
        return created.user

    def has_admin(self) -> bool:
        """Return True when at least one admin account exists."""

        existing = self._conn.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone()
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

        normalized_username = self._normalize_username(username)
        self._validate_username(normalized_username)
        self._validate_password(password)
        normalized_email = self._normalize_email(email)
        if role not in {"user", "admin"}:
            raise AuthError("role must be user or admin.")
        now_ms = self.now_ms()
        password_hash = self._hash_password(password)
        try:
            self._conn.execute(
                """
                INSERT INTO users (
                    username, password_hash, email, role, status, last_nickname, created_at_ms, updated_at_ms, last_login_at_ms
                ) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?)
                """,
                (normalized_username, password_hash, normalized_email, role, now_ms, now_ms, now_ms),
            )
            self._conn.commit()
        except sqlite3.IntegrityError as exc:
            message = str(exc).lower()
            if "users.username" in message:
                raise AuthError("Username is already taken.") from exc
            if "users.email" in message:
                raise AuthError("Email is already in use.") from exc
            raise
        user = self._get_user_by_username(normalized_username)
        if user is None:
            raise AuthError("Failed to load newly created user.")
        return self._create_session(user)

    def login(self, username: str, password: str) -> AuthSession:
        """Authenticate credentials and issue a fresh session."""

        normalized_username = self._normalize_username(username)
        user_row = self._conn.execute(
            """
            SELECT id, username, password_hash, email, role, status, last_nickname
            FROM users
            WHERE username = ?
            """,
            (normalized_username,),
        ).fetchone()
        if user_row is None:
            raise AuthError("Invalid username or password.")
        if user_row["status"] != "active":
            raise AuthError("Account is disabled.")
        if not self._verify_password(password, user_row["password_hash"]):
            raise AuthError("Invalid username or password.")
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
            )
        self._conn.execute(
            "UPDATE users SET last_login_at_ms = ?, updated_at_ms = ? WHERE id = ?",
            (self.now_ms(), self.now_ms(), user.id),
        )
        self._conn.commit()
        return self._create_session(user)

    def resume(self, token: str) -> AuthSession:
        """Validate a session token and apply rolling expiry."""

        cleaned = token.strip()
        if not cleaned:
            raise AuthError("Missing session token.")
        token_hash = self._hash_token(cleaned)
        row = self._conn.execute(
            """
            SELECT s.id AS session_id, s.user_id, s.expires_at_ms, s.revoked_at_ms,
                   u.username, u.role, u.status, u.email, u.last_nickname
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
        if row is None:
            raise AuthError("Invalid session.")
        if row["revoked_at_ms"] is not None:
            raise AuthError("Session has been revoked.")
        now_ms = self.now_ms()
        if int(row["expires_at_ms"]) <= now_ms:
            self._conn.execute("UPDATE sessions SET revoked_at_ms = ? WHERE id = ?", (now_ms, row["session_id"]))
            self._conn.commit()
            raise AuthError("Session has expired.")
        if row["status"] != "active":
            raise AuthError("Account is disabled.")
        new_expiry = now_ms + SESSION_TTL_MS
        self._conn.execute(
            "UPDATE sessions SET last_seen_at_ms = ?, expires_at_ms = ? WHERE id = ?",
            (now_ms, new_expiry, row["session_id"]),
        )
        self._conn.commit()
        user = AuthUser(
            id=str(row["user_id"]),
            username=row["username"],
            role=row["role"],
            status=row["status"],
            email=row["email"],
            last_nickname=row["last_nickname"],
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
            )
        return AuthSession(session_id=row["session_id"], token=cleaned, user=user)

    def revoke(self, token: str) -> None:
        """Revoke a session token if it exists."""

        cleaned = token.strip()
        if not cleaned:
            return
        token_hash = self._hash_token(cleaned)
        self._conn.execute(
            "UPDATE sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL",
            (self.now_ms(), token_hash),
        )
        self._conn.commit()

    def set_last_nickname(self, user_id: str, nickname: str) -> None:
        """Persist the most recent nickname for one user."""

        cleaned = nickname.strip()
        if not cleaned:
            return
        self._conn.execute(
            "UPDATE users SET last_nickname = ?, updated_at_ms = ? WHERE id = ?",
            (cleaned, self.now_ms(), user_id),
        )
        self._conn.commit()

    @staticmethod
    def now_ms() -> int:
        """Return unix epoch timestamp in milliseconds."""

        return int(time.time() * 1000)

    def _ensure_schema(self) -> None:
        """Create required auth tables and indexes when missing."""

        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                email TEXT UNIQUE,
                role TEXT NOT NULL CHECK(role IN ('user', 'admin')) DEFAULT 'user',
                status TEXT NOT NULL CHECK(status IN ('active', 'disabled')) DEFAULT 'active',
                last_nickname TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                last_login_at_ms INTEGER
            )
            """
        )
        self._conn.execute(
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
        self._conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")
        self._conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL"
        )
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at_ms)")
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash)")
        self._conn.commit()

    def _create_session(self, user: AuthUser) -> AuthSession:
        """Issue and persist a new session token for a user."""

        token = secrets.token_urlsafe(48)
        token_hash = self._hash_token(token)
        now_ms = self.now_ms()
        expires_at_ms = now_ms + SESSION_TTL_MS
        self._conn.execute(
            """
            INSERT INTO sessions (user_id, token_hash, created_at_ms, last_seen_at_ms, expires_at_ms, revoked_at_ms, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
            """,
            (user.id, token_hash, now_ms, now_ms, expires_at_ms),
        )
        session_id = str(self._conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        self._conn.commit()
        return AuthSession(session_id=session_id, token=token, user=user)

    def _get_user_by_username(self, username: str) -> AuthUser | None:
        """Fetch one user by normalized username."""

        row = self._conn.execute(
            "SELECT id, username, role, status, email, last_nickname FROM users WHERE username = ?",
            (username,),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_user(row)

    @staticmethod
    def _row_to_user(row: sqlite3.Row) -> AuthUser:
        """Convert a DB row into AuthUser."""

        return AuthUser(
            id=str(row["id"]),
            username=row["username"],
            role=row["role"],
            status=row["status"],
            email=row["email"],
            last_nickname=row["last_nickname"],
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

    @staticmethod
    def _hash_password(password: str) -> str:
        """Hash a password with PBKDF2-HMAC-SHA256 and random salt."""

        salt = os.urandom(SALT_BYTES)
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            PBKDF2_ITERATIONS,
            dklen=PBKDF2_DKLEN,
        )
        salt_b64 = base64.b64encode(salt).decode("ascii")
        digest_b64 = base64.b64encode(digest).decode("ascii")
        return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt_b64}${digest_b64}"

    @staticmethod
    def _verify_password(password: str, stored: str) -> bool:
        """Verify plaintext password against stored PBKDF2 hash."""

        try:
            algo, iterations_raw, salt_b64, digest_b64 = stored.split("$", 3)
        except ValueError:
            return False
        if algo != "pbkdf2_sha256":
            return False
        try:
            salt = base64.b64decode(salt_b64.encode("ascii"))
            expected = base64.b64decode(digest_b64.encode("ascii"))
            computed = hashlib.pbkdf2_hmac(
                "sha256",
                password.encode("utf-8"),
                salt,
                int(iterations_raw),
                dklen=len(expected),
            )
        except (ValueError, TypeError):
            return False
        return hmac.compare_digest(computed, expected)

    def _hash_token(self, token: str) -> str:
        """Hash a session token with server secret before persistence."""

        return hmac.new(self._token_secret, token.encode("utf-8"), hashlib.sha256).hexdigest()
