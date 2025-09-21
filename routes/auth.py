# routes/auth.py
from __future__ import annotations
from flask import (
    Blueprint, request, session, redirect, url_for,
    render_template, jsonify
)
from werkzeug.security import check_password_hash
from models import User, AssignedTile
from routes.guards import is_safe_url  # از گارد مشترک استفاده می‌کنیم

auth_bp = Blueprint("auth_bp", __name__)

# -------- Helpers --------
def _default_after_login_for(u: User) -> str:
    """
    مقصد پیش‌فرض پس از لاگین:
      - ادمین: صفحه‌ی Brush
      - کاربر عادی بدون تخصیص: no_access
      - کاربر عادی با تخصیص: Brush
    """
    if u.is_admin:
        return url_for("pages_bp.brush")

    has_any = AssignedTile.query.filter_by(user_id=u.id).first()
    if not has_any:
        return url_for("pages_bp.no_access")

    return url_for("pages_bp.brush")


# -------- Routes --------
@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    # ---------- GET ----------
    if request.method == "GET":
        # اگر از قبل لاگین بود:
        uid = session.get("user_id")
        if uid:
            nxt = request.args.get("next")
            if nxt and is_safe_url(nxt):
                return redirect(nxt)

            u = User.query.get(uid)
            if u:
                return redirect(_default_after_login_for(u))

            # اگر سشن خراب بود (کاربر در DB پیدا نشد)
            session.clear()

        # در غیراینصورت فرم لاگین را نشان بده
        return render_template("login.html")

    # ---------- POST ----------
    data = request.get_json(silent=True) or request.form
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    u = User.query.filter_by(email=email).first()

    if u and check_password_hash(u.password, password):
        # موفق: سشن را ست می‌کنیم (توجه: is_admin در گارد از DB چک می‌شود)
        session["user_id"] = u.id
        session["email"] = u.email
        session["is_admin"] = bool(u.is_admin)  # فقط برای نمایش در هدر/تمپلیت

        # اگر درخواست JSON بود، پاسخ JSON با مقصد مناسب بده
        if request.is_json:
            return jsonify(ok=True, redirect_to=_default_after_login_for(u))

        # اگر next معتبر بود برو همانجا، وگرنه مقصد پیش‌فرض
        nxt = data.get("next") or request.args.get("next")
        if nxt and is_safe_url(nxt):
            return redirect(nxt)
        return redirect(_default_after_login_for(u))

    # لاگین ناموفق
    if request.is_json:
        return jsonify(ok=False, error="invalid credentials"), 401
    return render_template("login.html", error="Invalid email or password"), 401


@auth_bp.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth_bp.login"))