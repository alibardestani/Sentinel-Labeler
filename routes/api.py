# routes/api.py
from __future__ import annotations

from pathlib import Path
import json
import math
import os
import tempfile
import traceback
import time

from typing import Tuple

import geopandas as gpd
import numpy as np
from flask import (
    Blueprint,
    current_app,
    jsonify,
    make_response,
    request,
    send_from_directory,
)

from werkzeug.utils import secure_filename

from config import settings

# --- service layer imports (طبق پروژه‌ی شما) ---
from services import model as model_srv
from services.masks import load_mask, mask_bytes, save_mask_bytes
from services.polygons import save_polygons_fc
from services.progress import get_progress, reset, set_progress
from services.s2 import (
    backdrop_meta,
    ensure_backdrop,
    prelabel,
    s2_bounds_wgs84,
    set_s2_scene_dir_and_rebuild,  # اگر استفاده نمی‌کنی می‌تونی حذفش کنی
    build_rgb_esri_aligned_tif_from_zip,
    save_quicklook_png_from_tif,
    s2_bounds_wgs84_from_tif,
)

api_bp = Blueprint("api", __name__)

# =========================================================
# Static-like files under OUTPUT_DIR (e.g., quicklook png)
#  -> exposed at:  /api/output/<filename>
# =========================================================
@api_bp.route("/output/<path:filename>", methods=["GET"])
def output_files(filename: str):
    return send_from_directory(settings.OUTPUT_DIR, filename, conditional=True)

# =========================================================
# Backdrop / Meta
# =========================================================
@api_bp.route("/backdrop_meta", methods=["GET"])
def api_backdrop_meta():
    w, h = backdrop_meta()
    return jsonify({"width": int(w), "height": int(h)})

# =========================================================
# Alignment offset (persisted)
# =========================================================
ALIGN_OFFSET_FILE = settings.ALIGN_OFFSET_FILE

@api_bp.route("/align_offset", methods=["GET", "POST"])
def align_offset():
    """GET returns current dx_m/dy_m; POST sets them."""
    f = ALIGN_OFFSET_FILE
    f.parent.mkdir(parents=True, exist_ok=True)

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        dx = float(data.get("dx_m", 0.0))
        dy = float(data.get("dy_m", 0.0))
        f.write_text(json.dumps({"dx_m": dx, "dy_m": dy}, ensure_ascii=False), encoding="utf-8")
        return jsonify(ok=True, dx_m=dx, dy_m=dy)

    if f.exists():
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
            return jsonify(j)
        except Exception:
            pass
    return jsonify({"dx_m": 0.0, "dy_m": 0.0})

# =========================================================
# S2 bounds (WGS84) + (offset handled in s2 module if needed)
# =========================================================
@api_bp.route("/s2_bounds_wgs84", methods=["GET"])
def api_s2_bounds_wgs84():
    b = s2_bounds_wgs84_from_tif(settings.S2_RGB_TIF)
    return jsonify(b)

# =========================================================
# Polygons
# =========================================================
@api_bp.route("/polygons", methods=["GET"])
def api_polygons_get():
    """Return saved polygons (GeoJSON FeatureCollection) or empty FC."""
    p = settings.POLYGONS_GEOJSON
    if p.exists():
        return send_from_directory(p.parent, p.name, conditional=True)
    return jsonify({"type": "FeatureCollection", "features": []})

@api_bp.route("/save_polygons", methods=["POST"])
def api_save_polygons():
    """Save polygons from FeatureCollection JSON body."""
    fc = request.get_json(force=True, silent=True)
    ok, msg = save_polygons_fc(fc)
    if not ok:
        return jsonify({"error": msg}), 400
    return jsonify({"ok": True})

@api_bp.route("/polygons/upload", methods=["POST"])
def api_polygons_upload():
    """
    Accept .geojson/.json or .zip (shapefile) and persist polygons.
    Also supports raw JSON body (no file) as FC.
    """
    f = request.files.get("file")
    if not f:
        # Try JSON body
        try:
            fc = request.get_json(force=True)
            ok, msg = save_polygons_fc(fc)
            return (jsonify({"ok": True}) if ok else (jsonify({"error": msg}), 400))
        except Exception as e:
            return jsonify({"error": f"no file and invalid body: {e}"}), 400

    filename = secure_filename(f.filename or "upload")
    name = filename.lower()

    try:
        if name.endswith((".geojson", ".json")):
            data = json.loads(f.stream.read().decode("utf-8"))
            ok, msg = save_polygons_fc(data)
            return (jsonify({"ok": True}) if ok else (jsonify({"error": msg}), 400))

        elif name.endswith(".zip"):
            with tempfile.TemporaryDirectory() as tmpd:
                tmp_zip = Path(tmpd) / filename
                f.save(tmp_zip)
                gdf = gpd.read_file(tmp_zip)  # requires fiona/ogr
                fc = json.loads(gdf.to_json())
                ok, msg = save_polygons_fc(fc)
                return (jsonify({"ok": True}) if ok else (jsonify({"error": msg}), 400))

        return jsonify({"error": "Unsupported file type. Use .geojson/.json or .zip (shapefile)."}), 400

    except Exception as e:
        return jsonify({"error": str(e)}), 500

# =========================================================
# Mask (raw/save/stats)
# =========================================================
@api_bp.route("/mask_raw", methods=["GET"])
def api_mask_raw():
    ensure_backdrop()
    w, h = backdrop_meta()
    b = mask_bytes(w, h)
    resp = make_response(b)
    resp.headers["Content-Type"] = "application/octet-stream"
    resp.headers["Cache-Control"] = "no-store"
    return resp

@api_bp.route("/save_mask", methods=["POST"])
def api_save_mask():
    """POST raw PNG bytes (matching backdrop size) → persist."""
    raw = request.get_data()
    w, h = backdrop_meta()
    ok, msg = save_mask_bytes(raw, w, h)
    if not ok:
        return jsonify({"error": msg}), 400
    return jsonify({"ok": True})

@api_bp.route("/mask_stats", methods=["GET"])
def api_mask_stats():
    w, h = backdrop_meta()
    m = load_mask(w, h)
    vals, cnts = np.unique(m, return_counts=True)
    return jsonify({
        "width": int(w),
        "height": int(h),
        "counts": {int(v): int(c) for v, c in zip(vals, cnts)}
    })

@api_bp.route("/mask", methods=["GET"])
def api_get_mask():
    """Serve saved mask PNG if exists, else 204."""
    p = settings.MASK_PNG
    if not p.exists():
        return ("", 204)
    return send_from_directory(p.parent, p.name, conditional=True)

# =========================================================
# Prelabel
# =========================================================
@api_bp.route("/prelabel", methods=["POST"])
def api_prelabel():
    reset()
    set_progress("starting", 2, "شروع پیش‌برچسب‌گذاری")

    body = request.get_json(force=True, silent=True) or {}
    method = (body.get("method") or "kmeans_rgb").strip()

    kwargs: dict = {}
    if method == "ndvi_thresh":
        try:
            kwargs["ndvi_threshold"] = float(
                body.get("ndvi_threshold", settings.NDVI_DEFAULT_THRESHOLD)
            )
        except Exception:
            kwargs["ndvi_threshold"] = settings.NDVI_DEFAULT_THRESHOLD

    ok, msg = prelabel(method, **kwargs)
    if not ok:
        set_progress("error", 100, str(msg))
        return jsonify({"error": msg}), 400

    set_progress("done", 100, "اتمام پیش‌برچسب‌گذاری")
    return jsonify({"ok": True})

@api_bp.route("/progress", methods=["GET"])
def api_progress():
    return jsonify(get_progress())

# =========================================================
# Model
# =========================================================
@api_bp.route("/model_info", methods=["GET"])
def api_model_info():
    try:
        info = model_srv.model_info()
        return jsonify(info)
    except Exception as e:
        return jsonify({"loaded": False, "error": str(e)}), 500

@api_bp.route("/model_upload", methods=["POST"])
def api_model_upload():
    """Upload .onnx (file) or set existing path via JSON {path: "..."}"""
    f = request.files.get("file")
    if f:
        settings.MODELS_DIR.mkdir(parents=True, exist_ok=True)
        save_path = settings.MODELS_DIR / secure_filename(f.filename)
        f.save(save_path)
        settings.ACTIVE_MODEL_PATH = save_path
    else:
        data = request.get_json(silent=True) or {}
        p = data.get("path")
        if not p:
            return jsonify({"error": "no model file or path supplied"}), 400
        settings.ACTIVE_MODEL_PATH = Path(p)

    info = model_srv.load_model(settings.ACTIVE_MODEL_PATH)
    return jsonify({"ok": True, "info": info})

@api_bp.route("/run_model", methods=["POST"])
def api_run_model():
    try:
        reset()
        set_progress("starting", 1, "شروع استنتاج مدل")
        ok, msg = model_srv.run_model_inference()
        if not ok:
            set_progress("error", 100, str(msg))
            return jsonify({"error": msg}), 400
        set_progress("done", 100, "اتمام استنتاج مدل")
        return jsonify({"ok": True})
    except Exception as e:
        set_progress("error", 100, str(e))
        return jsonify({"error": str(e)}), 500

# =========================================================
# Sentinel-2 SAFE ZIP → rebuild quicklook/GeoTIFF
# =========================================================
def _is_bad_zip_member(name: str) -> bool:
    # اگر بعداً خواستی فایل‌های ناخواسته را فیلتر کنی
    if name.startswith("__MACOSX/"):
        return True
    base = os.path.basename(name)
    if base.startswith("._"):
        return True
    return False

@api_bp.route("/upload_safe_zip", methods=["POST"])
def upload_safe_zip():
    """
    Accepts a SAFE .zip upload, builds aligned GeoTIFF + quicklook PNG,
    returns quicklook URL + bounds.
    """
    try:
        f = request.files.get("file")
        if not f:
            return jsonify(ok=False, error="no file"), 400

        t0 = time.time()
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        f.save(tmp.name)
        current_app.logger.info(
            "[upload] saved zip to %s (%.1f KB)",
            tmp.name, Path(tmp.name).stat().st_size / 1024
        )

        tif_path = build_rgb_esri_aligned_tif_from_zip(Path(tmp.name))
        save_quicklook_png_from_tif(tif_path)
        bounds = s2_bounds_wgs84_from_tif(tif_path)

        current_app.logger.info("[upload] done in %.2fs", time.time() - t0)
        return jsonify(
            ok=True,
            quicklook="/api/output/" + settings.BACKDROP_IMAGE.name,
            bounds=bounds,
        )
    except Exception as e:
        current_app.logger.exception("upload_safe_zip failed")
        return jsonify(ok=False, error=str(e), tb=traceback.format_exc()), 500