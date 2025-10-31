"""add label+quality to polygon_assignment

Revision ID: dad73896e507
Revises: a3fc0f30f521
"""
from alembic import op
import sqlalchemy as sa

revision = "dad73896e507"
down_revision = "a3fc0f30f521"
branch_labels = None
depends_on = None

def upgrade():
    op.add_column("polygon_assignment", sa.Column("label", sa.String(length=255), nullable=True))
    op.add_column("polygon_assignment", sa.Column("quality", sa.String(length=32), nullable=True))

    # optional helper index; safe to keep
    op.create_index(
        "ix_polygon_assignment_user_status",
        "polygon_assignment",
        ["user_id", "status"],
        unique=False,
    )

def downgrade():
    op.drop_index("ix_polygon_assignment_user_status", table_name="polygon_assignment")
    op.drop_column("polygon_assignment", "quality")
    op.drop_column("polygon_assignment", "label")