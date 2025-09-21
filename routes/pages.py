# routes/pages.py
from flask import Blueprint, render_template, redirect, url_for, session

pages_bp = Blueprint("pages_bp", __name__)

def login_required(view):
    from functools import wraps
    from flask import request
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("auth_bp.login", next=request.path))
        return view(*args, **kwargs)
    return wrapped

@pages_bp.get("/")
def index():
    return redirect(url_for("pages_bp.polygon")) if session.get("user_id") else redirect(url_for("auth_bp.login"))

@pages_bp.get("/polygon")
@login_required
def polygon():
    return render_template("polygon.html")

@pages_bp.get("/brush")
@login_required
def brush():
    return render_template("brush.html")