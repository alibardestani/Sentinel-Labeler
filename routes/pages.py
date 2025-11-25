# routes/pages.py
from __future__ import annotations
from functools import wraps
from flask import Blueprint, render_template, redirect, url_for, session, request
from sqlalchemy import func
from models import db, User, AssignedTile

pages_bp = Blueprint("pages_bp", __name__)

def login_required(view):
    @wraps(view)
    def _w(*a, **kw):
        if not session.get("user_id"):
            return redirect(url_for("auth_bp.login", next=request.path))
        return view(*a, **kw)
    return _w

def _is_admin() -> bool:
    uid = session.get("user_id")
    if not uid:
        return False
    u = db.session.get(User, uid)
    return bool(getattr(u, "is_admin", False))

# def _user_has_any_assignment() -> bool:
#     uid = session.get("user_id")
#     if not uid:
#         return False
#     return bool(
#         db.session.query(func.count(AssignedTile.id))
#         .filter(AssignedTile.user_id == uid)
#         .scalar()
    # )

@pages_bp.get("/")
@login_required
def home():
    return redirect(url_for("pages_bp.brush"))

@pages_bp.get("/brush")
@login_required
def brush():
#     if not _is_admin() and not _user_has_any_assignment():
#         return redirect(url_for("pages_bp.no_access"))
    return render_template("brush.html")

@pages_bp.get("/polygon")
@login_required
def polygon():
#     if not _is_admin() and not _user_has_any_assignment():
#         return redirect(url_for("pages_bp.no_access"))
    return render_template("polygon.html")

@pages_bp.get("/no-access")
@login_required
def no_access():
    return render_template("no_access.html")