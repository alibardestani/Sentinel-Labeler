# routes/api.py
from __future__ import annotations

from pathlib import Path
import json
import math
import os
import shutil
import tempfile , traceback,  time
import zipfile
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
    abort,
)
from werkzeug.utils import secure_filename

from config import settings
from services import model as model_srv
from services.masks import load_mask, mask_bytes, save_mask_bytes
from services.polygons import save_polygons_fc
from services.progress import get_progress, reset, set_progress
from services.s2 import (
    backdrop_meta,
    ensure_backdrop,
    prelabel,
    s2_bounds_wgs84,
    set_s2_scene_dir_and_rebuild,
    build_rgb_esri_aligned_tif_from_zip,
    save_quicklook_png_from_tif,
    s2_bounds_wgs84_from_tif,
)

api_bp = Blueprint("api", __name__)

# ------------------------------------------------------------------------------
# Static-like: serve files from OUTPUT_DIR
# ------------------------------------------------------------------------------

@api_bp.route("/output/<path:filename>")
def output_files(filename):
    return send_from_directory(settings.OUTPUT_DIR, filename)
# ------------------------------------------------------------------------------
# Backdrop / Meta
# ------------------------------------------------------------------------------
@api_bp.route("/backdrop_meta")
def api_backdrop_meta():
    w, h = backdrop_meta()
    return jsonify({"width": int(w), "height": int(h)})

# ------------------------------------------------------------------------------
# Alignment offset (in meters) — persisted to output/align_offset.json
# ------------------------------------------------------------------------------
ALIGN_OFFSET_FILE = settings.ALIGN_OFFSET_FILE

def _load_align_offset_m() -> Tuple[float, float]:
    try:
        if ALIGN_OFFSET_FILE.exists():
            j = json.loads(ALIGN_OFFSET_FILE.read_text(encoding="utf-8"))
            return float(j.get("dx_m", 0.0)), float(j.get("dy_m", 0.0))
    except Exception:
        pass
    return 0.0, 0.0

def _save_align_offset_m(dx_m: float, dy_m: float) -> None:
    ALIGN_OFFSET_FILE.parent.mkdir(parents=True, exist_ok=True)
    ALIGN_OFFSET_FILE.write_text(
        json.dumps({"dx_m": dx_m, "dy_m": dy_m}, ensure_ascii=False),
        encoding="utf-8",
    )

def _apply_offset_to_bounds(
    lat_min: float,
    lon_min: float,
    lat_max: float,
    lon_max: float,
    dx_m: float,
    dy_m: float,
) -> Tuple[float, float, float, float]:
    # 1°lat ≈ 111,320 m و 1°lon ≈ 111,320 * cos(lat_c) m
    lat_c = 0.5 * (lat_min + lat_max)
    dlat = dy_m / 111_320.0
    dlon = dx_m / (111_320.0 * max(1e-6, math.cos(math.radians(lat_c))))
    return (lat_min + dlat, lon_min + dlon, lat_max + dlat, lon_max + dlon)

@api_bp.route("/align_offset", methods=["GET", "POST"])
def align_offset():
    f = settings.ALIGN_OFFSET_FILE
    f.parent.mkdir(parents=True, exist_ok=True)

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        dx = float(data.get("dx_m", 0.0))
        dy = float(data.get("dy_m", 0.0))
        f.write_text(json.dumps({"dx_m": dx, "dy_m": dy}, ensure_ascii=False))
        return jsonify(ok=True, dx_m=dx, dy_m=dy)

    if f.exists():
        try:
            j = json.loads(f.read_text())
            return jsonify(j)
        except Exception:
            pass
    return jsonify({"dx_m": 0.0, "dy_m": 0.0})

# ------------------------------------------------------------------------------
# S2 bounds (WGS84) + alignment offset
# ------------------------------------------------------------------------------
@api_bp.route("/s2_bounds_wgs84", methods=["GET"])
def api_s2_bounds_wgs84():
    from services.s2 import s2_bounds_wgs84_from_tif
    b = s2_bounds_wgs84_from_tif(settings.S2_RGB_TIF)
    return jsonify(b)

# ------------------------------------------------------------------------------
# Polygons
# ------------------------------------------------------------------------------
@api_bp.route("/polygons", methods=["GET"])
def api_polygons_get():
    p = settings.POLYGONS_GEOJSON
    if p.exists():
        return send_from_directory(p.parent, p.name)
    return jsonify({"type": "FeatureCollection", "features": []})

@api_bp.route("/save_polygons", methods=["POST"])
def api_save_polygons():
    fc = request.get_json(force=True, silent=True)
    ok, msg = save_polygons_fc(fc)
    if not ok:
        return jsonify({"error": msg}), 400
    return jsonify({"ok": True})

@api_bp.route("/polygons/upload", methods=["POST"])
def api_polygons_upload():
    f = request.files.get("file")
    if not f:
        try:
            fc = request.get_json(force=True)
            ok, msg = save_polygons_fc(fc)
            return jsonify({"ok": True}) if ok else (jsonify({"error": msg}), 400)
        except Exception as e:
            return jsonify({"error": f"no file and invalid body: {e}"}), 400

    filename = secure_filename(f.filename or "upload")
    name = filename.lower()

    try:
        if name.endswith((".geojson", ".json")):
            data = json.loads(f.stream.read().decode("utf-8"))
            ok, msg = save_polygons_fc(data)
            return jsonify({"ok": True}) if ok else (jsonify({"error": msg}), 400)
        elif name.endswith(".zip"):
            with tempfile.TemporaryDirectory() as tmpd:
                tmp_zip = Path(tmpd) / filename
                f.save(tmp_zip)
                gdf = gpd.read_file(tmp_zip)
                fc = json.loads(gdf.to_json())
                ok, msg = save_polygons_fc(fc)
                return jsonify({"ok": True}) if ok else (jsonify({"error": msg}), 400)
        else:
            return jsonify({"error": "Unsupported file type. Use .geojson/.json or .zip (shapefile)."}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ------------------------------------------------------------------------------
# Mask raw / save / stats
# ------------------------------------------------------------------------------
@api_bp.route("/mask_raw")
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
    raw = request.get_data()
    w, h = backdrop_meta()
    ok, msg = save_mask_bytes(raw, w, h)
    if not ok:
        return jsonify({"error": msg}), 400
    return jsonify({"ok": True})

@api_bp.route("/mask_stats")
def mask_stats():
    w, h = backdrop_meta()
    m = load_mask(w, h)
    vals, cnts = np.unique(m, return_counts=True)
    return jsonify({"width": w, "height": h, "counts": {int(v): int(c) for v, c in zip(vals, cnts)}})

# ------------------------------------------------------------------------------
# Prelabel
# ------------------------------------------------------------------------------
@api_bp.route("/prelabel", methods=["POST"])
def api_prelabel():
    reset()
    set_progress("starting", 2, "شروع پیش‌برچسب‌گذاری")

    body = request.get_json(force=True, silent=True) or {}
    method = (body.get("method") or "kmeans_rgb").strip()

    kwargs: dict = {}
    if method == "ndvi_thresh":
        try:
            kwargs["ndvi_threshold"] = float(body.get("ndvi_threshold", settings.NDVI_DEFAULT_THRESHOLD))
        except Exception:
            kwargs["ndvi_threshold"] = settings.NDVI_DEFAULT_THRESHOLD

    ok, msg = prelabel(method, **kwargs)
    if not ok:
        set_progress("error", 100, str(msg))
        return jsonify({"error": msg}), 400

    set_progress("done", 100, "اتمام پیش‌برچسب‌گذاری")
    return jsonify({"ok": True})

@api_bp.route("/progress")
def api_progress():
    return jsonify(get_progress())

# ------------------------------------------------------------------------------
# Model endpoints
# ------------------------------------------------------------------------------
@api_bp.route("/model_info")
def api_model_info():
    try:
        info = model_srv.model_info()
        return jsonify(info)
    except Exception as e:
        return jsonify({"loaded": False, "error": str(e)}), 500

@api_bp.route("/model_upload", methods=["POST"])
def api_model_upload():
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

# ------------------------------------------------------------------------------
# Sentinel-2 SAFE ZIP upload → rebuild quicklook/GeoTIFF (SAFE extraction)
# ------------------------------------------------------------------------------

def _is_bad_zip_member(name: str) -> bool:
    if name.startswith("__MACOSX/"):
        return True
    base = os.path.basename(name)
    if base.startswith("._"):
        return True
    return False

def _find_safe_root(dest_dir: Path) -> Path:
    safes = sorted([p for p in dest_dir.rglob("*") if p.is_dir() and p.suffix.lower() == ".safe"])
    return safes[0] if safes else dest_dir


@api_bp.route("/upload_safe_zip", methods=["POST"])
def upload_safe_zip():
    try:
        f = request.files.get("file")
        if not f:
            return jsonify(ok=False, error="no file"), 400

        t0 = time.time()
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        f.save(tmp.name)
        current_app.logger.info(
            "[upload] saved zip to %s (%.1f KB)",
            tmp.name, Path(tmp.name).stat().st_size/1024
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

@api_bp.route("/api/output/<path:fname>", methods=["GET"])
def api_output(fname):
    base = settings.OUTPUT_DIR
    p = (base / fname).resolve()
    if not str(p).startswith(str(base.resolve())):
        abort(403)
    if not p.exists():
        abort(404)
    return send_from_directory(base, fname)