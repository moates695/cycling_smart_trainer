"""initial schema: users, sessions, workouts, activities

Revision ID: 0001
Revises:
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # citext gives case insensitive email uniqueness without lower() everywhere.
    op.execute("create extension if not exists citext")

    # One sequence shared by both syncable tables, so a client carries a single
    # integer cursor that orders workouts and activities together.
    op.execute("create sequence if not exists record_seq")

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", postgresql.CITEXT(), nullable=False, unique=True),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("user_agent", sa.Text()),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])

    op.create_table(
        "workouts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # (user_id, id) rather than id alone: ids come from clients, so a global
        # key would let one user's push collide with another user's row.
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False, server_default=""),
        sa.Column("workout", postgresql.JSONB(), nullable=False),
        sa.Column("zwo", sa.Text()),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("client_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_workouts_user_seq", "workouts", ["user_id", "seq"])

    op.create_table(
        "activities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # (user_id, id) rather than id alone: ids come from clients, so a global
        # key would let one user's push collide with another user's row.
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False, server_default=""),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("duration_sec", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("summary", postgresql.JSONB(), nullable=False),
        sa.Column("fit_key", sa.Text()),
        sa.Column("fit_uploaded_at", sa.DateTime(timezone=True)),
        sa.Column("fit_size_bytes", sa.Integer()),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("client_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_activities_user_seq", "activities", ["user_id", "seq"])


def downgrade() -> None:
    op.drop_table("activities")
    op.drop_table("workouts")
    op.drop_table("sessions")
    op.drop_table("users")
    op.execute("drop sequence if exists record_seq")
