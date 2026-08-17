"""password reset codes

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-16
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "password_resets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # HMAC-SHA256 of the code, keyed with WATTS_SECRET_KEY. Never the code.
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    # Serves both lookups: the newest live code for a user, and the count of
    # requests in the last hour that caps how much mail one account can attract.
    op.create_index("ix_password_resets_user_created", "password_resets", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_password_resets_user_created", table_name="password_resets")
    op.drop_table("password_resets")
