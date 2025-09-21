# migrations/versions/c5fbaeeaa1a8_...py
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c5fbaeeaa1a8'
down_revision = '995270f5d3e8'
branch_labels = None
depends_on = None

def upgrade():
    # 1) ابتدا NULLها را پر کن تا ALTER به NOT NULL گیر نده
    op.execute("UPDATE `user` SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL")
    op.execute("UPDATE `assigned_tile` SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL")

    # 2) اصلاح ستون‌های user
    with op.batch_alter_table('user', schema=None) as batch_op:
        # بولین ادمین: NOT NULL + default 0 (Tinyint(1) در MySQL)
        batch_op.alter_column(
            'is_admin',
            existing_type=sa.Boolean(),
            nullable=False,
            server_default=sa.text('0')
        )
        # created_at: NOT NULL + default now (برای راضی کردن MySQL)
        batch_op.alter_column(
            'created_at',
            existing_type=sa.DateTime(),
            nullable=False,
            server_default=sa.text('CURRENT_TIMESTAMP')
        )

    # 3) اصلاح ستون‌های assigned_tile
    with op.batch_alter_table('assigned_tile', schema=None) as batch_op:
        batch_op.alter_column(
            'created_at',
            existing_type=sa.DateTime(),
            nullable=False,
            server_default=sa.text('CURRENT_TIMESTAMP')
        )

    # اگر نمی‌خوای server_default روی created_atها دائمی بمونه،
    # می‌تونی همین‌جا یا در یک مایگریشن بعدی، default را برداری:
    # with op.batch_alter_table('user') as b:
    #     b.alter_column('created_at', server_default=None)
    # with op.batch_alter_table('assigned_tile') as b:
    #     b.alter_column('created_at', server_default=None)


def downgrade():
    # اگر downgrade لازم شد، محدودیت‌ها را شُل کن
    with op.batch_alter_table('assigned_tile', schema=None) as batch_op:
        batch_op.alter_column(
            'created_at',
            existing_type=sa.DateTime(),
            nullable=True,
            server_default=None
        )

    with op.batch_alter_table('user', schema=None) as batch_op:
        batch_op.alter_column(
            'created_at',
            existing_type=sa.DateTime(),
            nullable=True,
            server_default=None
        )
        batch_op.alter_column(
            'is_admin',
            existing_type=sa.Boolean(),
            nullable=True,
            server_default=None
        )