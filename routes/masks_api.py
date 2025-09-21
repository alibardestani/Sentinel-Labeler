# routes/masks_api.py
from __future__ import annotations
from flask import Blueprint, request, jsonify, current_app, send_file, abort
from werkzeug.utils import secure_filename
from pathlib import Path
import time

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

@bp_masks.post("/api/masks/save_tile_png")
def save_tile_png():
    """
    form-data:
      - scene_id (str)
      - r, c, x, y, w, h (اختیاری)
      - file: PNG
    ذخیره در: <OUTPUT_DIR>/masks/<scene_id>/r<r>_c<c>/scene-<scene>_r<c>_c<r>__x.._y.._w.._h.._<ts>.png
    """
    f = request.files.get("file")
    if not f:
        return jsonify(ok=False, error="no file"), 400

    scene_id = _safe(request.form.get("scene_id", "unknown"))
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

# ——— سازگاری با مسیر قدیمی ———

@bp_masks.post("/api/masks/save")
def save_polygon_mask_legacy():
    tile_id = request.args.get("tile_id", "")
    uid = request.args.get("uid", "")
    f = request.files.get("file")
    if not (tile_id and uid and f):
        return jsonify(ok=False, error="missing tile_id/uid/file"), 400

    scene_id = _safe(request.args.get("scene_id", "unknown"))
    r = _safe(request.args.get("r", "0"))
    c = _safe(request.args.get("c", "0"))

    root = _output_root()
    out_dir = _ensure_dir(root / "masks_poly" / scene_id / tile_id / f"r{r}_c{c}")
    fname = secure_filename(f"poly-{_safe(uid)}_{time.strftime('%Y%m%d_%H%M%S')}.png")
    abs_path = out_dir / fname
    f.save(abs_path)
    return jsonify(ok=True, path=str(abs_path))

@bp_masks.get("/api/masks/get")
def get_polygon_mask_legacy():
    # اگر لازم داری واقعاً از فایل‌سیستم بخونی، این را کامل کن.
    return abort(404)