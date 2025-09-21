# models.py
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.sql import func
from sqlalchemy import text

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = "user"

    id         = db.Column(db.Integer, primary_key=True)
    email      = db.Column(db.String(255), unique=True, index=True, nullable=False)
    password   = db.Column(db.String(255), nullable=False)

    # نکته مهم برای MySQL: server_default=text('0') تا ستون به صورت TINYINT(1) NOT NULL DEFAULT 0 ساخته شود.
    # مقدار default پایتونی هم می‌تونی بذاری، ولی برای ساخت اسکیمای DB همین server_default حیاتی‌تره.
    is_admin   = db.Column(db.Boolean, nullable=False, server_default=text('0'))

    # اگر timezone=True با MySQL استفاده می‌کنی، گاهی ناسازگاری پیش میاد. ساده نگه می‌داریم:
    created_at = db.Column(db.DateTime, nullable=False, server_default=func.now())

    # نمایش خوانا (اختیاری)
    def __repr__(self) -> str:
        return f"<User id={self.id} email={self.email} is_admin={bool(self.is_admin)}>"


class AssignedTile(db.Model):
    __tablename__ = "assigned_tile"

    id         = db.Column(db.Integer, primary_key=True)

    user_id    = db.Column(
        db.Integer,
        db.ForeignKey("user.id", ondelete="CASCADE"),
        nullable=False,
        index=True
    )

    # همان scene_id که از /api/scenes/list می‌آید
    scene_id   = db.Column(db.String(64), nullable=False, index=True)

    # برای نمایش بهتر در ادمین
    scene_name = db.Column(db.String(512), nullable=True)

    # برچسب اختیاری
    label      = db.Column(db.String(255), nullable=True)

    created_at = db.Column(db.DateTime, nullable=False, server_default=func.now())

    # رابطه
    user = db.relationship("User", backref="assigned_tiles", lazy=True)

    def __repr__(self) -> str:
        return f"<AssignedTile id={self.id} user_id={self.user_id} scene_id={self.scene_id}>"