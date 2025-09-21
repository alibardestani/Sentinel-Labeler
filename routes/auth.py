# routes/auth.py
from flask import Blueprint, request, session, redirect, url_for, render_template, jsonify
from werkzeug.security import check_password_hash
from models import User

auth_bp = Blueprint("auth_bp", __name__)

def _is_safe_url(target: str) -> bool:
    # اگر نیاز داری همون is_safe_url قبلی رو اینجا بیار
    return True

@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        if session.get("user_id"):
            next_url = request.args.get("next") or url_for("pages_bp.polygon")
            return redirect(next_url)
        return render_template("login.html")

    data = request.get_json(silent=True) or request.form
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    u = User.query.filter_by(email=email).first()
    if u and check_password_hash(u.password, password):
        session["user_id"] = u.id
        session["email"] = u.email
        session["is_admin"] = bool(u.is_admin)
        if request.is_json: return jsonify(ok=True)
        next_url = data.get("next") or request.args.get("next") or url_for("pages_bp.polygon")
        return redirect(next_url)

    if request.is_json:
        return jsonify(ok=False, error="invalid credentials"), 401
    return render_template("login.html", error="Invalid email or password"), 401

@auth_bp.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth_bp.login"))