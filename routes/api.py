# routes/api.py  (یا هر فایلی که blueprint را تعریف کرده)
from __future__ import annotations
import json
from pathlib import Path
from flask import Blueprint, jsonify, make_response, request, send_from_directory, current_app
import numpy as np
from models import db, User, AssignedTile
from flask import session
from services.polygons import load_polygons_dict
from services.s2 import current_selected_scene, tiles_root
from config import settings
from services.masks import load_mask, mask_bytes, save_mask_bytes
from services.polygons import load_polygons_text  # فقط این
from services.progress import get_progress
from services.s2 import (
    backdrop_meta,
    ensure_backdrop,
    s2_bounds_wgs84,
    list_s2_scenes,
    select_scene_by_id,
    current_selected_scene,
    tiles_root,
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

# --- فقط همین روت برای پولیگان‌ها باقی بماند ---
@api_bp.get("/polygons")
def api_polygons_get():
    txt = load_polygons_text()
    if txt:
        return current_app.response_class(
            response=txt,
            status=200,
            mimetype="application/json"
        )
    # اگر چیزی نبود، خالی بده (FeatureCollection خالی)
    return jsonify({"type": "FeatureCollection", "features": []})

from flask import Blueprint, request, jsonify
from pathlib import Path
import time


# --- بقیه APIها بدون تغییر ---
from io import BytesIO
from PIL import Image

@api_bp.get("/grid/meta")
def api_grid_meta():
    rows = int(request.args.get("rows", 3))
    cols = int(request.args.get("cols", 3))
    ensure_backdrop()
    im = Image.open(settings.BACKDROP_IMAGE)
    W, H = im.size
    b = s2_bounds_wgs84() or {}
    return jsonify({
        "rows": rows, "cols": cols,
        "image_width": W, "image_height": H,
        "tile_pixel_w": W // cols, "tile_pixel_h": H // rows,
        "bounds_wgs84": b
    })
from flask import abort, session

@api_bp.get("/grid/tile")
def api_grid_tile():
    scene_id = request.args.get("scene_id", "")
    if not scene_id:
        return jsonify({"error": "scene_id required"}), 400
    if not user_can_access_scene(scene_id):
        return abort(403)

    r = int(request.args.get("r", 0))
    c = int(request.args.get("c", 0))
    fn = tiles_root() / scene_id / f"tile_{r}_{c}.png"
    if not fn.exists():
        return jsonify({"error": "tile not found"}), 404
    resp = make_response(fn.read_bytes())
    resp.headers["Content-Type"] = "image/png"
    resp.headers["Cache-Control"] = "public, max-age=3600, immutable"
    return resp

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
    if session.get("is_admin"):
        items = [s.__dict__ for s in list_s2_scenes()]
        return jsonify({"ok": True, "items": items})

    uid = session.get("user_id")
    q = db.session.query(AssignedTile.scene_id, AssignedTile.scene_name).filter_by(user_id=uid).all()
    assigned_ids = {row.scene_id for row in q}
    if not assigned_ids:
        return jsonify({"ok": True, "items": []})

    all_items = {s.id: s for s in list_s2_scenes()}
    items = []
    for sid in assigned_ids:
        meta = all_items.get(sid)
        if meta:
            items.append(meta.__dict__)
        else:
            items.append({"id": sid, "name": sid})
    return jsonify({"ok": True, "items": items})

@api_bp.post("/scenes/select")
def api_scenes_select():
    j = request.get_json(silent=True) or {}
    scene_id = j.get("scene_id")
    if not scene_id:
        return jsonify({"ok": False, "error": "scene_id missing"}), 400
    if not user_can_access_scene(scene_id):
        return abort(403)
    try:
        meta = select_scene_by_id(scene_id)
        return jsonify({"ok": True, "meta": meta})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@api_bp.get("/scenes/current")
def api_scenes_current():
    it = current_selected_scene()
    return jsonify({"ok": True, "scene": (it.__dict__ if it else None)})



# routes/api.py

@api_bp.get("/my_tiles")
def api_my_tiles():
    uid = session.get("user_id")
    if not uid:
        return jsonify({"ok": False, "error": "unauthorized"}), 401

    rows = (
        AssignedTile.query
        .filter_by(user_id=uid)
        .order_by(AssignedTile.created_at.desc())
        .all()
    )
    items = []
    for t in rows:
        items.append({
            "id": t.id,
            "scene_id": t.scene_id,
            "scene_name": t.scene_name,
            "label": t.label,
            "assigned_at": t.created_at.isoformat() if getattr(t, "created_at", None) else None
            # اگر فیلدهای r,c,rows,cols ندارید، اصلاً ارسال نکنید
        })
    return jsonify({"ok": True, "items": items})



@api_bp.get("/grid/list")
def api_grid_list():
    sel = current_selected_scene()
    scene_id = request.args.get("scene_id") or (sel.id if sel else "")
    if not scene_id:
        return jsonify({"ok": False, "error": "scene_id missing"}), 400
    if not user_can_access_scene(scene_id):
        return abort(403)

    d = tiles_root() / scene_id
    if not d.exists():
        return jsonify({"ok": False, "error": "tiles not found"}), 404

    items = []
    for r in range(3):
        for c in range(3):
            fn = d / f"tile_{r}_{c}.png"
            if fn.exists():
                with Image.open(fn) as im:
                    w, h = im.size
                items.append({
                    "r": r, "c": c, "w": w, "h": h,
                    "url": f"/api/grid/tile?scene_id={scene_id}&r={r}&c={c}"
                })

    return jsonify({"ok": True, "rows": 3, "cols": 3, "items": items, "scene_id": scene_id})


def user_can_access_scene(scene_id: str) -> bool:
    if not scene_id:
        return False
    # ادمین دسترسی کامل دارد
    if session.get("is_admin"):
        return True
    uid = session.get("user_id")
    if not uid:
        return False
    return db.session.query(AssignedTile.id).filter_by(user_id=uid, scene_id=scene_id).first() is not None