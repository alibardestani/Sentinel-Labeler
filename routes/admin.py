# routes/admin.py
from __future__ import annotations
from functools import wraps

from flask import (
    Blueprint, render_template, redirect, url_for,
    session, request, abort, flash, current_app
)
from werkzeug.security import generate_password_hash

from models import db, User, AssignedTile
from routes.guards import admin_required  # گارد مرکزی ادمین

# اگر templates در روت پروژه است، نیازی به template_folder نیست
admin_bp = Blueprint("admin_bp", __name__)

def _as_bool(v: str | None) -> bool:
    """تبدیل ورودی‌های فرم به بولین (checkbox)"""
    return str(v).strip().lower() in ("1", "true", "on", "yes")

@admin_bp.get("/")
@admin_required
def home():
    # لیست کاربران
    users = User.query.order_by(User.created_at.desc()).all()

    # لیست انتساب‌ها (AssignedTile) به همراه اطلاعات کاربر
    tiles = (
        db.session.query(AssignedTile, User)
        .join(User, User.id == AssignedTile.user_id)
        .order_by(AssignedTile.created_at.desc())
        .all()
    )
    return render_template("admin.html", users=users, tiles=tiles)

@admin_bp.post("/users/create")
@admin_required
def users_create():
    email = (request.form.get("email") or "").strip().lower()
    password = request.form.get("password") or ""
    is_admin = _as_bool(request.form.get("is_admin"))

    if not (email and password):
        flash("Email/Password required", "error")
        return redirect(url_for("admin_bp.home"))

    if User.query.filter_by(email=email).first():
        flash("Email already exists", "error")
        return redirect(url_for("admin_bp.home"))

    u = User(email=email, password=generate_password_hash(password), is_admin=is_admin)
    db.session.add(u)
    db.session.commit()
    flash("User created", "ok")
    return redirect(url_for("admin_bp.home"))

@admin_bp.post("/tiles/assign")
@admin_required
def tiles_assign():
    user_id = int(request.form.get("user_id") or 0)
    scene_id = (request.form.get("scene_id") or "").strip()
    scene_name = (request.form.get("scene_name") or "").strip()
    label = (request.form.get("label") or "").strip()

    if not (user_id and scene_id):
        flash("user_id/scene_id required", "error")
        return redirect(url_for("admin_bp.home"))

    at = AssignedTile(
        user_id=user_id,
        scene_id=scene_id,
        scene_name=scene_name or scene_id,
        label=label or None,
    )
    db.session.add(at)
    db.session.commit()
    flash("Tile assigned", "ok")
    return redirect(url_for("admin_bp.home"))

# --- اختیاری: لاگ دیباگ برای اطمینان از وضعیت دسترسی ---
@admin_bp.before_request
def _debug_admin_gate():
    if not current_app.debug:
        return
    uid = session.get("user_id")
    if uid:
        u = User.query.get(uid)
        current_app.logger.debug(
            "[admin] uid=%s email=%s is_admin=%s",
            uid,
            getattr(u, "email", None),
            bool(getattr(u, "is_admin", False)),
        )