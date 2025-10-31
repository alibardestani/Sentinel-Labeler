"""polygon

Revision ID: 15247460a23e
Revises: c5fbaeeaa1a8
Create Date: 2025-10-31 23:32:09.680664

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '15247460a23e'
down_revision = 'c5fbaeeaa1a8'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "polygon_set",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("source_filename", sa.String(256), nullable=True),
        sa.Column("uploaded_by", sa.Integer(), sa.ForeignKey("user.id"), nullable=False),
        sa.Column("feature_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )

    op.create_table(
        "polygon",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("set_id", sa.Integer(), sa.ForeignKey("polygon_set.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("ext_id", sa.String(128), nullable=True),                # feature id from shapefile if present
        sa.Column("properties", sa.JSON(), nullable=True),                 # non-geom attrs
        sa.Column("geometry_geojson", sa.JSON(), nullable=False),          # GeoJSON geometry in EPSG:4326
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")),
        sa.Index("ix_polygon_set_ext", "set_id", "ext_id")
    )

    op.create_table(
        "polygon_assignment",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("polygon_id", sa.Integer(), sa.ForeignKey("polygon.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("status", sa.Enum("queued","in_progress","edited","submitted","approved","rejected", name="poly_assign_status"), nullable=False, server_default="queued"),
        sa.Column("last_editor_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=True),
        sa.Column("last_edit_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("polygon_id", "user_id", name="uq_polygon_user")
    )

def downgrade():
    op.drop_table("polygon_assignment")
    op.execute("DROP TYPE IF EXISTS poly_assign_status")
    op.drop_table("polygon")
    op.drop_table("polygon_set")