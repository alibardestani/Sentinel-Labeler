# models_polygons.py
from __future__ import annotations
from datetime import datetime
from sqlalchemy import String, Integer, JSON, DateTime, ForeignKey
from sqlalchemy.orm import relationship, Mapped, mapped_column
from models import db  # only db, not PolygonAssignment

class PolygonSet(db.Model):
    __tablename__ = "polygon_set"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    source_filename: Mapped[str | None] = mapped_column(String(256))
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("user.id"), nullable=False)
    feature_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    uploader = relationship("User")
    polygons = relationship("Polygon", cascade="all, delete-orphan", back_populates="polygon_set")

class Polygon(db.Model):
    __tablename__ = "polygon"

    id: Mapped[int] = mapped_column(primary_key=True)
    set_id: Mapped[int] = mapped_column(ForeignKey("polygon_set.id", ondelete="CASCADE"), index=True)
    ext_id: Mapped[str | None] = mapped_column(String(128))
    properties: Mapped[dict | None] = mapped_column(JSON)
    geometry_geojson: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    polygon_set = relationship("PolygonSet")
    # refer by string; resolved when configure_mappers() is called in app.py
    assignments = relationship("PolygonAssignment", cascade="all, delete-orphan", back_populates="polygon")