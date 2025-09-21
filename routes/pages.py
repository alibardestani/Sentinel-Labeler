# routes/pages.py
from __future__ import annotations

from functools import wraps
from flask import Blueprint, render_template, redirect, url_for, session, request
from models import AssignedTile

pages_bp = Blueprint("pages_bp", __name__)

# ---- helpers ----
def login_required(view):
    @wraps(view)
    def _w(*a, **kw):
        if not session.get("user_id"):
            # کاربر لاگین نیست → بفرست به لاگین و next=مسیر فعلی
            return redirect(url_for("auth_bp.login", next=request.path))
        return view(*a, **kw)
    return _w

def _user_has_any_assignment() -> bool:
    """بررسی می‌کند کاربر جاری (غیر ادمین) حداقل یک Scene/Tile تخصیص داده شده دارد یا نه."""
    uid = session.get("user_id")
    if not uid:
        return False
    # سریع‌تر از count(): فقط وجود رکورد را چک کن
    return AssignedTile.query.filter_by(user_id=uid).first() is not None


# ---- pages ----
@pages_bp.get("/")
@login_required
def home():
    # می‌تونی بعداً بر اساس نقش روتینگ بهتری بسازی؛ فعلا می‌بریم به brush
    return redirect(url_for("pages_bp.brush"))

@pages_bp.get("/brush")
@login_required
def brush():
    # ادمین همیشه دسترسی دارد
    if not session.get("is_admin"):
        if not _user_has_any_assignment():
            # کاربر عادی ولی هیچ صحنه‌ای ندارد → صفحه‌ی عدم دسترسی
            return redirect(url_for("pages_bp.no_access"))
    return render_template("brush.html")

@pages_bp.get("/polygon")
@login_required
def polygon():
    if not session.get("is_admin"):
        if not _user_has_any_assignment():
            return redirect(url_for("pages_bp.no_access"))
    return render_template("polygon.html")

@pages_bp.get("/no-access")
@login_required
def no_access():
    # یک تمپلیت ساده که پیام «دسترسی ندارید/چیزی به شما تخصیص داده نشده» را نشان می‌دهد
    # می‌تونی از همین‌جا لینک «تماس با ادمین» یا «خروج» هم بگذاری
    return render_template("no_access.html")