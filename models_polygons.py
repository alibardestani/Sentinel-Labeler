# /Volumes/Work/Sen2/V4/models_polygons.py
from __future__ import annotations
from datetime import datetime
from sqlalchemy import (
    String, Integer, JSON, DateTime, Enum, ForeignKey, UniqueConstraint
)
from sqlalchemy.orm import relationship, Mapped, mapped_column

# ✅ Use relative import to avoid duplicate module loading
from models import db


# ============================================================
# PolygonSet  → each admin upload (ZIP/GeoJSON)
# ============================================================
class PolygonSet(db.Model):
    __tablename__ = "polygon_set"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    source_filename: Mapped[str | None] = mapped_column(String(256))
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("user.id"), nullable=False)
    feature_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    uploader = relationship("User")
    polygons = relationship("Polygon", cascade="all, delete-orphan",
                            back_populates="polygon_set") 


# ============================================================
# Polygon  → single feature geometry + attributes
# ============================================================
class Polygon(db.Model):
    __tablename__ = "polygon"

    id: Mapped[int] = mapped_column(primary_key=True)
    set_id: Mapped[int] = mapped_column(
        ForeignKey("polygon_set.id", ondelete="CASCADE"), index=True
    )
    ext_id: Mapped[str | None] = mapped_column(String(128))
    properties: Mapped[dict | None] = mapped_column(JSON)
    geometry_geojson: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    polygon_set = relationship("PolygonSet")
    assignments = relationship("PolygonAssignment", cascade="all, delete-orphan",
                               back_populates="polygon")  

# models.py (excerpt)
from datetime import datetime

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import (
    Enum, String, DateTime, ForeignKey, UniqueConstraint, Index, func
)
from sqlalchemy.orm import relationship

db = SQLAlchemy()

# ------------------------------------------------------------
# PolygonAssignment → which user can edit which polygon
# ------------------------------------------------------------
class PolygonAssignment(db.Model):
    __tablename__ = "polygon_assignment"

    id = db.Column(db.Integer, primary_key=True)

    polygon_id = db.Column(
        db.Integer,
        db.ForeignKey("polygon.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id = db.Column(
        db.Integer,
        db.ForeignKey("user.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Keep the same enum set you already use in DB
    status = db.Column(
        Enum(
            "queued",
            "in_progress",
            "edited",
            "submitted",
            "approved",
            "rejected",
            name="polygon_assignment_status",  # keep name stable
        ),
        nullable=False,
        default="queued",
    )

    last_editor_id = db.Column(db.Integer, db.ForeignKey("user.id"))
    last_edit_at   = db.Column(DateTime)

    # Server-side creation timestamp (leave as-is if you already had it)
    created_at     = db.Column(
        DateTime,
        nullable=False,
        server_default=func.current_timestamp()
    )

    # NEW FIELDS (match your migration: both nullable)
    label   = db.Column(String(255))
    quality = db.Column(String(32))  # keep String(32) to match the DB migration

    # Relationships
    user         = relationship("User", foreign_keys=[user_id])
    last_editor  = relationship("User", foreign_keys=[last_editor_id])
    polygon      = relationship("Polygon", back_populates="assignments")

    __table_args__ = (
        # prevent duplicate assignment of same polygon to same user
        UniqueConstraint("polygon_id", "user_id", name="uq_polygon_user"),
        # helpful composite index for dashboard queries
        Index("ix_polygon_assignment_user_status", "user_id", "status"),
    )

    def __repr__(self) -> str:
        return (
            f"<PolygonAssignment id={self.id} polygon_id={self.polygon_id} "
            f"user_id={self.user_id} status={self.status} "
            f"label={self.label!r} quality={self.quality!r}>"
        )