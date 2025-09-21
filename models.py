# models.py
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.sql import func

db = SQLAlchemy()

class User(db.Model):
    id         = db.Column(db.Integer, primary_key=True)
    email      = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password   = db.Column(db.String(255), nullable=False)
    is_admin   = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), server_default=func.now())

class AssignedTile(db.Model):
    id          = db.Column(db.Integer, primary_key=True)
    user_id     = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    # scene_id همان id ای است که از /api/scenes/list برمی‌گردد (sha1 کوتاه از مسیر)
    scene_id    = db.Column(db.String(64), nullable=False, index=True)
    scene_name  = db.Column(db.String(512), nullable=True)   # برای نمایش بهتر
    label       = db.Column(db.String(255), nullable=True)   # اختیاری؛ مثلا "Tile A"
    created_at  = db.Column(db.DateTime(timezone=True), server_default=func.now())

    user = db.relationship('User', backref='assigned_tiles', lazy=True)