"""keep original behavior; do NOT add columns here

Revision ID: a3fc0f30f521
Revises: 15247460a23e
"""
from alembic import op

revision = 'a3fc0f30f521'
down_revision = '15247460a23e'
branch_labels = None
depends_on = None

def upgrade():
    # If Alembic originally dropped an index on polygon, you can keep it.
    # Otherwise, this can be an empty upgrade.
    pass

def downgrade():
    # Likewise, empty or restore the original polygon index if you had one.
    pass