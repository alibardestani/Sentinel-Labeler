# routes/guards.py
from __future__ import annotations
from functools import wraps
from urllib.parse import urlparse, urljoin

from flask import request, session, redirect, url_for, abort
from models import User, AssignedTile, db


def is_safe_url(target: str) -> bool:
    """اجازه می‌ده فقط به URLهای همین دامنه ریدایرکت کنیم."""
    if not target:
        return False
    ref_url = urlparse(request.host_url)
    test_url = urlparse(urljoin(request.host_url, target))
    return (test_url.scheme in ("http", "https") and ref_url.netloc == test_url.netloc)


def login_required(view):
    """اگر لاگین نباشه می‌فرستیمش به لاگین، وگرنه ویو اجرا می‌شه."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("auth_bp.login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    """
    فقط ادمین اجازه‌ی عبور دارد.
    نکته: حتماً از دیتابیس می‌خوانیم (session منبعِ حقیقت نیست).
    """
    @wraps(view)
    def wrapped(*args, **kwargs):
        uid = session.get("user_id")
        if not uid:
            return redirect(url_for("auth_bp.login", next=request.path))
        u = User.query.get(uid)
        if not (u and bool(u.is_admin)):
            return abort(403)
        return view(*args, **kwargs)
    return wrapped


def user_can_access_scene(user_id: int, scene_id: str) -> bool:
    """
    ادمین همیشه دسترسی دارد؛ کاربر عادی فقط اگر AssignedTile با همان scene_id داشته باشد.
    """
    if not user_id or not scene_id:
        return False
    u = User.query.get(user_id)
    if not u:
        return False
    if u.is_admin:
        return True
    return db.session.query(AssignedTile.id)\
        .filter(AssignedTile.user_id == user_id, AssignedTile.scene_id == scene_id)\
        .first() is not None


def require_scene_access(param: str = "scene_id"):
    """
    دکوریتور اختیاری: scene_id را از فرم/کوئری می‌خواند و دسترسی کاربر را چک می‌کند.
    """
    def deco(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            uid = session.get("user_id")
            if not uid:
                return redirect(url_for("auth_bp.login", next=request.path))
            scene_id = request.values.get(param, "")  # از args یا form
            if not user_can_access_scene(uid, scene_id):
                return abort(403)
            return view(*args, **kwargs)
        return wrapped
    return deco