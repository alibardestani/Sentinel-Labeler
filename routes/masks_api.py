# routes/masks_api.py
from __future__ import annotations
from pathlib import Path
from datetime import datetime
import time

from flask import Blueprint, request, jsonify, current_app, abort, session
from werkzeug.utils import secure_filename

from routes.guards import login_required, user_can_access_scene

bp_masks = Blueprint("bp_masks", __name__)

def _safe(v: str, default="x") -> str:
    if v is None:
        v = default
    v = str(v)
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in v)

def _ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True); return p

def _output_root() -> Path:
    cfg = current_app.config.get("OUTPUT_DIR")
    root = Path(cfg) if cfg else (Path.cwd() / "output")
    return _ensure_dir(root)

# --------- Main endpoint: /api/masks/save_tile_png ----------
@bp_masks.post("/save_tile_png")
@login_required
def save_tile_png():
    """
    ذخیره PNG ماسک تایل:
      form-data:
        - scene_id: str (الزامی)
        - r: int
        - c: int
        - x,y,w,h (اختیاری متادیتا)
        - file: Blob PNG (الزامی)
    مسیر ذخیره: <OUTPUT_DIR>/masks/<scene_id>/r<r>_c<c>/scene-<scene_id>_r<r>_c<c>__x.._y.._w.._h.._<ts>.png
    """
    f = request.files.get("file")
    if not f:
        return jsonify(ok=False, error="no file"), 400

    scene_id = _safe(request.form.get("scene_id", ""))
    if not scene_id:
        return jsonify(ok=False, error="scene_id missing"), 400

    # دسترسی
    uid = session.get("user_id")
    if not user_can_access_scene(uid, scene_id):
        return abort(403)

    r = _safe(request.form.get("r", "0"))
    c = _safe(request.form.get("c", "0"))
    x = request.form.get("x", "")
    y = request.form.get("y", "")
    w = request.form.get("w", "")
    h = request.form.get("h", "")

    root = _output_root()
    out_dir = _ensure_dir(root / "masks" / scene_id / f"r{r}_c{c}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    meta = f"__x{x}_y{y}_w{w}_h{h}" if all([x != "", y != "", w != "", h != ""]) else ""
    fname = secure_filename(f"scene-{scene_id}_r{r}_c{c}{meta}_{ts}.png")
    abs_path = out_dir / fname
    f.save(abs_path)

    return jsonify(ok=True, path=str(abs_path), rel=str(abs_path.relative_to(root)))

# --------- Legacy compatibility: /api/masks/save ----------
@bp_masks.post("/save")
@login_required
def save_polygon_mask_legacy():
    tile_id = request.args.get("tile_id", "")
    uid = request.args.get("uid", "")
    f = request.files.get("file")
    if not (tile_id and uid and f):
        return jsonify(ok=False, error="missing tile_id/uid/file"), 400

    scene_id = _safe(request.args.get("scene_id", ""))
    if not scene_id:
        return jsonify(ok=False, error="scene_id missing"), 400

    # دسترسی
    user_id = session.get("user_id")
    if not user_can_access_scene(user_id, scene_id):
        return abort(403)

    r = _safe(request.args.get("r", "0"))
    c = _safe(request.args.get("c", "0"))

    root = _output_root()
    out_dir = _ensure_dir(root / "masks_poly" / scene_id / tile_id / f"r{r}_c{c}")
    fname = secure_filename(f"poly-{_safe(uid)}_{time.strftime('%Y%m%d_%H%M%S')}.png")
    abs_path = out_dir / fname
    f.save(abs_path)
    return jsonify(ok=True, path=str(abs_path))

# --------- Legacy get (می‌تونی بعداً کامل کنی) ----------
@bp_masks.get("/get")
@login_required
def get_polygon_mask_legacy():
    return abort(404)