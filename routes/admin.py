# routes/admin.py
from flask import Blueprint, render_template, redirect, url_for, session, request, abort, flash
from werkzeug.security import generate_password_hash
from models import db, User, AssignedTile

admin_bp = Blueprint("admin_bp", __name__, template_folder="../templates")

def admin_required(view):
    from functools import wraps
    @wraps(view)
    def wrapped(*args, **kwargs):
        uid = session.get("user_id")
        if not uid:
            return redirect(url_for("auth_bp.login", next=request.path))
        u = User.query.get(uid)
        if not (u and u.is_admin):
            return abort(403)
        return view(*args, **kwargs)
    return wrapped

@admin_bp.get("/")
@admin_required
def home():
    users = User.query.order_by(User.created_at.desc()).all()
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
    is_admin = bool(request.form.get("is_admin"))
    if not (email and password):
        flash("Email/Password required", "error"); return redirect(url_for("admin_bp.home"))
    if User.query.filter_by(email=email).first():
        flash("Email already exists", "error"); return redirect(url_for("admin_bp.home"))
    u = User(email=email, password=generate_password_hash(password), is_admin=is_admin)
    db.session.add(u); db.session.commit()
    flash("User created", "ok"); return redirect(url_for("admin_bp.home"))

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

    at = AssignedTile(user_id=user_id, scene_id=scene_id, scene_name=scene_name or scene_id, label=label)
    db.session.add(at); db.session.commit()
    flash("Tile assigned", "ok")
    return redirect(url_for("admin_bp.home"))