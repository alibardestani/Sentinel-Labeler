from __future__ import annotations
import json
import tempfile
from pathlib import Path
from flask import current_app
import geopandas as gpd
import numpy as np
from flask import Blueprint, jsonify, make_response, request, send_from_directory
from werkzeug.utils import secure_filename
from config import settings
from services.masks import load_mask, mask_bytes, save_mask_bytes
from services.polygons import save_polygons_fc, load_polygons_text
from services.progress import get_progress
from services.s2 import (
    backdrop_meta,
    ensure_backdrop,
    s2_bounds_wgs84,
    list_s2_scenes,
    select_scene_by_id,
    current_selected_scene,
)

api_bp = Blueprint("api", __name__, url_prefix="/api")

@api_bp.get("/output/<path:filename>")
def output_files(filename: str):
    return send_from_directory(settings.OUTPUT_DIR, filename, conditional=True)

@api_bp.get("/backdrop_meta")
def api_backdrop_meta():
    w, h = backdrop_meta()
    return jsonify({"width": int(w), "height": int(h)})

@api_bp.route("/align_offset", methods=["GET", "POST"])
def align_offset():
    f = settings.ALIGN_OFFSET_FILE
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

@api_bp.get("/s2_bounds_wgs84")
def api_s2_bounds_wgs84():
    b = s2_bounds_wgs84()
    if not b:
        return ("", 204)
    return jsonify(b)

@api_bp.get("/polygons")
def api_polygons_get():
    from services.polygons import load_polygons_text
    txt = load_polygons_text()
    if txt:
        return current_app.response_class(
            response=txt,
            status=200,
            mimetype="application/json"
        )
    return jsonify({"type": "FeatureCollection", "features": []})

@api_bp.post("/save_polygons")
def api_save_polygons():
    fc = request.get_json(force=True, silent=True)
    ok, msg = save_polygons_fc(fc)
    if not ok:
        return jsonify({"error": msg}), 400
    return jsonify({"ok": True})

@api_bp.post("/polygons/upload")
def api_polygons_upload():
    f = request.files.get("file")
    if not f:
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
                gdf = gpd.read_file(tmp_zip)
                fc = json.loads(gdf.to_json())
                ok, msg = save_polygons_fc(fc)
                return (jsonify({"ok": True}) if ok else (jsonify({"error": msg}), 400))
        return jsonify({"error": "Unsupported file type. Use .geojson/.json or .zip"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@api_bp.get("/mask_raw")
def api_mask_raw():
    ensure_backdrop()
    w, h = backdrop_meta()
    b = mask_bytes(w, h)
    resp = make_response(b)
    resp.headers["Content-Type"] = "application/octet-stream"
    resp.headers["Cache-Control"] = "no-store"
    return resp

@api_bp.post("/save_mask")
def api_save_mask():
    raw = request.get_data()
    w, h = backdrop_meta()
    ok, msg = save_mask_bytes(raw, w, h)
    if not ok:
        return jsonify({"error": msg}), 400
    return jsonify({"ok": True})

@api_bp.get("/mask_stats")
def api_mask_stats():
    w, h = backdrop_meta()
    m = load_mask(w, h)
    vals, cnts = np.unique(m, return_counts=True)
    return jsonify({"width": int(w), "height": int(h), "counts": {int(v): int(c) for v, c in zip(vals, cnts)}})

@api_bp.get("/mask")
def api_get_mask():
    p = settings.MASK_PNG
    if not p.exists():
        return ("", 204)
    return send_from_directory(p.parent, p.name, conditional=True)

@api_bp.get("/progress")
def api_progress():
    return jsonify(get_progress())

@api_bp.get("/scenes/list")
def api_scenes_list():
    items = [s.__dict__ for s in list_s2_scenes()]
    return jsonify({"ok": True, "items": items})

@api_bp.post("/scenes/select")
def api_scenes_select():
    j = request.get_json(silent=True) or {}
    scene_id = j.get("scene_id")
    if not scene_id:
        return jsonify({"ok": False, "error": "scene_id missing"}), 400
    try:
        meta = select_scene_by_id(scene_id)
        return jsonify({"ok": True, "meta": meta})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@api_bp.get("/scenes/current")
def api_scenes_current():
    it = current_selected_scene()
    return jsonify({"ok": True, "scene": (it.__dict__ if it else None)})