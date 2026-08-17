"""The migration must produce the same schema the models describe.

Without this, `alembic upgrade head` on the droplet can drift from what the code
expects and the mismatch only shows up as a runtime error in production.
"""

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app.database import Base
from tests.conftest import TEST_DB_URL, _admin_url

MIGRATION_DB = "watts_migration_test"


def _url_for(db_name: str) -> str:
    return TEST_DB_URL.rsplit("/", 1)[0] + "/" + db_name


@pytest.fixture(scope="module")
def migrated_engine():
    with psycopg.connect(_admin_url(), autocommit=True) as conn:
        conn.execute(f'drop database if exists "{MIGRATION_DB}" with (force)')
        conn.execute(f'create database "{MIGRATION_DB}"')

    config = Config("alembic.ini")
    config.set_main_option("script_location", "migrations")
    config.set_main_option("sqlalchemy.url", _url_for(MIGRATION_DB))
    command.upgrade(config, "head")

    engine = create_engine(_url_for(MIGRATION_DB))
    yield engine, config
    engine.dispose()
    # Dropped again for the same reason conftest drops the test database: the
    # only database left standing on a dev machine is watts_dev.
    with psycopg.connect(_admin_url(), autocommit=True) as conn:
        conn.execute(f'drop database if exists "{MIGRATION_DB}" with (force)')


def test_migration_creates_every_table_the_models_declare(migrated_engine):
    engine, _ = migrated_engine
    tables = set(inspect(engine).get_table_names())
    assert set(Base.metadata.tables) <= tables


def test_migration_columns_match_the_models(migrated_engine):
    engine, _ = migrated_engine
    inspector = inspect(engine)
    for table_name, table in Base.metadata.tables.items():
        actual = {c["name"] for c in inspector.get_columns(table_name)}
        expected = {c.name for c in table.columns}
        assert expected == actual, f"{table_name}: model has {expected - actual}, database has {actual - expected}"


def test_migration_primary_keys_match_the_models(migrated_engine):
    """(user_id, id) on the syncable tables is a security property, not a detail."""
    engine, _ = migrated_engine
    inspector = inspect(engine)
    for table_name, table in Base.metadata.tables.items():
        actual = set(inspector.get_pk_constraint(table_name)["constrained_columns"])
        expected = {c.name for c in table.primary_key.columns}
        assert expected == actual, f"{table_name} primary key differs"


def test_the_shared_sequence_exists(migrated_engine):
    engine, _ = migrated_engine
    with engine.connect() as conn:
        assert conn.execute(text("select nextval('record_seq')")).scalar() >= 1


def test_downgrade_then_upgrade_is_clean(migrated_engine):
    """A failed release has to be reversible."""
    engine, config = migrated_engine
    command.downgrade(config, "base")
    with engine.connect() as conn:
        remaining = set(inspect(conn).get_table_names())
    assert not (set(Base.metadata.tables) & remaining)

    command.upgrade(config, "head")
    with engine.connect() as conn:
        assert set(Base.metadata.tables) <= set(inspect(conn).get_table_names())
