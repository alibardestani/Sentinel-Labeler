# app.py
from __future__ import annotations

from pathlib import Path
from functools import wraps
from urllib.parse import urlparse, urljoin

from flask import (
    Flask, render_template, redirect, url_for,
    request, session, jsonify, send_file, abort, flash
)
from werkzeug.security import generate_password_hash, check_password_hash
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate

from config import settings
from routes.api import api_bp
from services.polygons_bootstrap import ensure_geojson_from_shapefile

# ---- DB models ----
from models import db, User, AssignedTile  # مطمئن شو models.py طبق اسکیمای قبلی ساخته شده

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SECRET_KEY"] = "change-this-in-prod-please"

# برای دسترسی در قالب‌ها/بلوپرینت‌ها
app.config.update(
    OUTPUT_DIR=str(settings.OUTPUT_DIR),
    S2_RGB_TIF=str(settings.S2_RGB_TIF),
)

# ------------------- Database: MySQL (MAMP via PyMySQL) -------------------
# اگر از PyMySQL استفاده می‌کنی:
app.config["SQLALCHEMY_DATABASE_URI"] = (
    "mysql+pymysql://root:root@localhost/sen2"
    "?unix_socket=/Applications/MAMP/tmp/mysql/mysql.sock"
    "&charset=utf8mb4"
)
# اگر ترجیح می‌دهی mysqlclient (mysqldb) استفاده کنی، فقط خط بالا را با این عوض کن:
# app.config["SQLALCHEMY_DATABASE_URI"] = (
#     "mysql+mysqldb://root:root@localhost/sen2"
#     "?unix_socket=/Applications/MAMP/tmp/mysql/mysql.sock&charset=utf8mb4"
# )

app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_pre_ping": True,
    "pool_recycle": 1800,
}

db.init_app(app)
migrate = Migrate(app, db)

# ---- Filesystem constants ----
MASK_ROOT = Path("masks")

# -------------- helpers --------------
def is_safe_url(target: str) -> bool:
    if not target:
        return False
    ref_url = urlparse(request.host_url)
    test_url = urlparse(urljoin(request.host_url, target))
    return (test_url.scheme in ("http", "https") and ref_url.netloc == test_url.netloc)

def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login", next=request.path))
        return fn(*args, **kwargs)
    return wrapper

def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        uid = session.get("user_id")
        if not uid:
            return redirect(url_for("login", next=request.path))
        u = User.query.get(uid)
        if not (u and u.is_admin):
            return abort(403)
        return fn(*args, **kwargs)
    return wrapper

# -------------- auth --------------
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        if session.get("user_id"):
            next_url = request.args.get("next") or url_for("polygon")
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
        if request.is_json:
            return jsonify(ok=True)
        next_url = data.get("next") or request.args.get("next") or url_for("polygon")
        if not is_safe_url(next_url):
            next_url = url_for("polygon")
        return redirect(next_url)

    if request.is_json:
        return jsonify(ok=False, error="invalid credentials"), 401
    return render_template("login.html", error="Invalid email or password"), 401

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

# -------------- pages --------------
@app.route("/")
def index():
    if session.get("user_id"):
        return redirect(url_for("polygon"))
    return redirect(url_for("login"))

@app.route("/polygon")
@login_required
def polygon():
    return render_template("polygon.html")

@app.route("/brush")
@login_required
def brush():
    return render_template("brush.html")

# -------------- Admin Dashboard --------------

@app.route("/admin", methods=["GET"])
@admin_required
def admin_home():
    users = User.query.order_by(User.created_at.desc()).all()
    # لیست تخصیص‌ها برای جدول پایین
    tiles = (
        db.session.query(AssignedTile, User)
        .join(User, User.id == AssignedTile.user_id)
        .order_by(AssignedTile.created_at.desc())
        .all()
    )
    return render_template("admin.html", users=users, tiles=tiles)

@app.post("/admin/users/create")
@admin_required
def admin_users_create():
    email = (request.form.get("email") or "").strip().lower()
    password = request.form.get("password") or ""
    is_admin = bool(request.form.get("is_admin"))
    if not (email and password):
        flash("Email/Password required", "error"); return redirect(url_for("admin_home"))
    if User.query.filter_by(email=email).first():
        flash("Email already exists", "error"); return redirect(url_for("admin_home"))
    u = User(email=email, password=generate_password_hash(password), is_admin=is_admin)
    db.session.add(u); db.session.commit()
    flash("User created", "ok"); return redirect(url_for("admin_home"))

@app.post("/admin/tiles/assign")
@admin_required
def admin_tiles_assign():
    # فقط user_id + scene_id (و اختیاری scene_name/label)
    user_id = int(request.form.get("user_id") or 0)
    scene_id = (request.form.get("scene_id") or "").strip()
    scene_name = (request.form.get("scene_name") or "").strip()
    label = (request.form.get("label") or "").strip()

    if not (user_id and scene_id):
        flash("user_id/scene_id required", "error")
        return redirect(url_for("admin_home"))

    at = AssignedTile(user_id=user_id, scene_id=scene_id, scene_name=scene_name or scene_id, label=label)
    db.session.add(at); db.session.commit()
    flash("Tile assigned", "ok")
    return redirect(url_for("admin_home"))

# -------- API: لیست تایل‌های قابل‌دسترسی کاربر جاری --------
@app.get("/api/my_tiles")
@login_required
def api_my_tiles():
    uid = session.get("user_id")
    rows = AssignedTile.query.filter_by(user_id=uid).order_by(AssignedTile.created_at.desc()).all()
    out = []
    for t in rows:
        out.append({
            "id": t.id,
            "scene_id": t.scene_id,
            "scene_name": t.scene_name,
            "label": t.label,
            "assigned_at": t.created_at.isoformat() if t.created_at else None
        })
    return jsonify({"ok": True, "items": out})
# -------------- masks (per-tile/per-uid) --------------
@app.post("/api/masks/save")
@login_required
def api_masks_save():
    tile_id = request.args.get("tile_id", "")
    uid = request.args.get("uid", "")
    f = request.files.get("file")
    if not (tile_id and uid and f):
        return {"error": "missing tile_id/uid/file"}, 400

    safe_tile = "".join(c if c.isalnum() or c in "._-|" else "_" for c in tile_id)[:128]
    safe_uid = "".join(c if c.isalnum() or c in "._-|" else "_" for c in uid)[:128]

    outdir = MASK_ROOT / safe_tile
    outdir.mkdir(parents=True, exist_ok=True)
    outpath = outdir / f"{safe_uid}.png"
    f.save(outpath)
    return {"ok": True, "path": str(outpath)}

@app.get("/api/masks/get")
@login_required
def api_masks_get():
    tile_id = request.args.get("tile_id", "")
    uid = request.args.get("uid", "")
    if not (tile_id and uid):
        return abort(400)

    safe_tile = "".join(c if c.isalnum() or c in "._-|" else "_" for c in tile_id)[:128]
    safe_uid = "".join(c if c.isalnum() or c in "._-|" else "_" for c in uid)[:128]
    path = MASK_ROOT / safe_tile / f"{safe_uid}.png"
    if not path.exists():
        return abort(404)
    return send_file(path, mimetype="image/png")

# ------------------- Blueprints -------------------
app.register_blueprint(api_bp)

# ------------------- Boot & Sanity -------------------
with app.app_context():
    # تست اتصال (اختیاری ولی مفید)
    try:
        db.session.execute(db.text("SELECT 1"))
        print("MySQL connection OK ✅")
    except Exception as e:
        print("MySQL connection ERROR ❌", e)

if __name__ == "__main__":
    ensure_geojson_from_shapefile()
    app.run(host="127.0.0.1", port=5000, debug=True)