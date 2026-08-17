"""rider profile sync: settings

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One row per user, keyed by user_id alone: unlike workouts and activities
    # the id does not come from the client, so there is nothing to collide.
    op.create_table(
        "settings",
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("settings", postgresql.JSONB(), nullable=False, server_default="{}"),
        # Drawn from the same sequence as workouts and activities, so the client
        # still carries a single cursor.
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("client_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("settings")
