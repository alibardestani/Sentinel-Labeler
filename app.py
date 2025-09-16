# app.py
from __future__ import annotations

from pathlib import Path
from functools import wraps
from urllib.parse import urlparse, urljoin

from flask import (
    Flask, render_template, redirect, url_for,
    request, session, jsonify, send_file, abort
)
from services.polygons_bootstrap import ensure_geojson_from_shapefile


from config import settings
from routes.api import api_bp

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SECRET_KEY"] = "change-this-in-prod-please"
app.config.update(
    OUTPUT_DIR=str(settings.OUTPUT_DIR),
    S2_RGB_TIF=str(settings.S2_RGB_TIF),
)

app.register_blueprint(api_bp)

MASK_ROOT = Path("masks")

DEMO_EMAIL = "demo@example.com"
DEMO_PASS = "demo1234"


def is_safe_url(target: str) -> bool:
    if not target:
        return False
    ref_url = urlparse(request.host_url)
    test_url = urlparse(urljoin(request.host_url, target))
    return (test_url.scheme in ("http", "https") and ref_url.netloc == test_url.netloc)


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("login", next=request.path))
        return fn(*args, **kwargs)
    return wrapper


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        if session.get("user"):
            next_url = request.args.get("next") or url_for("polygon")
            return redirect(next_url)
        return render_template("login.html")

    data = request.get_json(silent=True) or request.form
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if email == DEMO_EMAIL and password == DEMO_PASS:
        session["user"] = email
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


@app.route("/")
def index():
    if session.get("user"):
        return redirect(url_for("polygon"))
    return redirect(url_for("login"))


@app.route("/polygon")
@login_required
def polygon():
    return render_template("polygon.html")


@app.route("/brush")
def brush():
    return render_template("brush.html")


@app.post("/api/masks/save")
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


if __name__ == "__main__":
    ensure_geojson_from_shapefile()
    app.run(host="127.0.0.1", port=5000, debug=True)