import os
import uuid
from datetime import UTC, datetime

# Must be set before anything imports app.config, which is lru_cached, or
# app.database, which builds the engine at import time.
TEST_DB_URL = os.environ.setdefault(
    "WATTS_DATABASE_URL",
    "postgresql+psycopg://watts:watts@host.docker.internal:5432/watts_test",
)
os.environ.setdefault("WATTS_ENV", "test")
os.environ.setdefault("WATTS_RATE_LIMITS_ENABLED", "false")
os.environ.setdefault("WATTS_CORS_ORIGINS", "")
os.environ.setdefault("WATTS_SPACES_ENDPOINT", "")
os.environ.setdefault("WATTS_SPACES_BUCKET", "")
os.environ.setdefault("WATTS_SPACES_KEY", "")
os.environ.setdefault("WATTS_SPACES_SECRET", "")
os.environ.setdefault("WATTS_SPACES_PREFIX", "")
os.environ.setdefault("WATTS_SECRET_KEY", "test-pepper-not-a-real-secret")
# Left blank on purpose: app.email logs the message instead of sending it, so
# the suite never opens an SMTP connection.
os.environ.setdefault("WATTS_SMTP_HOST", "")

import psycopg  # noqa: E402
import pytest  # noqa: E402
from argon2 import PasswordHasher  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

# argon2 at production cost is ~300 ms per hash, which would make the auth suite
# take minutes. The tests exercise the hashing code path, not its cost
# parameters. This has to happen before app.routers.auth binds DUMMY_HASH.
import app.security as security  # noqa: E402

security.password_hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)
security.DUMMY_HASH = security.password_hasher.hash("placeholder")

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


def _admin_url() -> str:
    return TEST_DB_URL.replace("postgresql+psycopg://", "postgresql://").rsplit("/", 1)[0] + "/postgres"


@pytest.fixture(scope="session", autouse=True)
def database():
    """Create the test database once, then build the schema from the models.

    The migration is verified separately in test_migrations.py; going through the
    metadata here keeps the suite independent of migration ordering.
    """
    db_name = TEST_DB_URL.rsplit("/", 1)[-1]
    with psycopg.connect(_admin_url(), autocommit=True) as conn:
        exists = conn.execute("select 1 from pg_database where datname = %s", (db_name,)).fetchone()
        if not exists:
            conn.execute(f'create database "{db_name}"')

    with engine.begin() as conn:
        conn.execute(text("create extension if not exists citext"))
        conn.execute(text("create sequence if not exists record_seq"))
    # Rebuild from scratch each run, so a schema change never leaves the test
    # database silently out of step with the models.
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
    engine.dispose()
    # Locally there is one database that outlives a command — watts_dev. The
    # suite's is scaffolding, so it goes back out again rather than sitting on
    # the developer's server looking like an environment.
    with psycopg.connect(_admin_url(), autocommit=True) as conn:
        conn.execute(f'drop database if exists "{db_name}" with (force)')


@pytest.fixture(autouse=True)
def clean_tables(database):
    with engine.begin() as conn:
        conn.execute(
            text(
                "truncate table activities, workouts, settings, sessions, password_resets, users "
                "restart identity cascade"
            )
        )
    yield


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def other_client():
    """A second, independent cookie jar, for cross-user isolation tests."""
    with TestClient(app) as test_client:
        yield test_client


class Mailbox:
    """What the app would have put in the rider's inbox."""

    def __init__(self):
        self.codes: list[tuple[str, str]] = []  # (address, code)
        self.notices: list[str] = []  # addresses told their password changed

    @property
    def last_code(self) -> str:
        return self.codes[-1][1]


@pytest.fixture
def mailbox(monkeypatch):
    """Intercept outbound mail.

    The router reaches the senders through the module (`email.send_reset_code`),
    so patching the attribute catches the call. TestClient runs background tasks
    before it hands back the response, so a captured code is available as soon
    as the request returns.
    """
    import app.email as app_email

    box = Mailbox()
    monkeypatch.setattr(app_email, "send_reset_code", lambda to, code, ttl, settings=None: box.codes.append((to, code)))
    monkeypatch.setattr(app_email, "send_password_changed", lambda to, settings=None: box.notices.append(to))
    return box


def register(client, email: str = "rider@example.com", password: str = "correct-horse-battery"):
    response = client.post("/api/auth/register", json={"email": email, "password": password})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def user(client):
    return register(client)


@pytest.fixture
def other_user(other_client):
    return register(other_client, email="rival@example.com")


def workout_payload(workout_id: str | None = None, name: str = "Threshold 2x20", **overrides):
    payload = {
        "id": workout_id or str(uuid.uuid4()),
        "name": name,
        "workout": {"meta": {"name": name}, "intervals": [{"duration": 1200, "steps": []}]},
        "zwo": "<workout_file></workout_file>",
        "client_updated_at": datetime.now(UTC).isoformat(),
    }
    payload.update(overrides)
    return payload


def settings_payload(ftp: int = 250, weight: float = 72, **overrides):
    payload = {
        "settings": {"ftp": ftp, "weight": weight},
        "client_updated_at": datetime.now(UTC).isoformat(),
    }
    payload.update(overrides)
    return payload


def activity_payload(activity_id: str | None = None, name: str = "Tuesday ride", **overrides):
    payload = {
        "id": activity_id or str(uuid.uuid4()),
        "name": name,
        "started_at": datetime.now(UTC).isoformat(),
        "duration_sec": 3600,
        "summary": {"avgPower": 210, "np": 225, "tss": 78, "ftp": 250},
        "client_updated_at": datetime.now(UTC).isoformat(),
    }
    payload.update(overrides)
    return payload
