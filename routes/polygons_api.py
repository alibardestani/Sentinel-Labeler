# routes/polygons_api.py
from __future__ import annotations

from flask import Blueprint, jsonify, request
from werkzeug.utils import secure_filename
from pathlib import Path
import shutil
import zipfile
import io

from services.polygons_bootstrap import ensure_geojson_from_shapefile, load_geojson_dict

bp_polygons = Blueprint("polygons_bp", __name__)

# GET /api/polygons  -> GeoJSON فعلی
@bp_polygons.get("/")
def get_polygons():
    ensure_geojson_from_shapefile()
    gj = load_geojson_dict()
    if not gj:
        return jsonify(ok=False, error="no polygons"), 404
    return jsonify(gj)

# POST /api/polygons/upload  -> آپلود shapefile (zip) یا geojson و بازسازی current.geojson
@bp_polygons.post("/upload")
def upload_polygons():
    f = request.files.get("file")
    if not f:
        return jsonify(ok=False, error="file missing"), 400

    filename = secure_filename(f.filename or "upload")
    data = f.read()

    DATA_DIR = Path("data/polygons")
    SHP_DIR = DATA_DIR / "shp"
    GEOJSON_OUT = Path("output/polygons/current.geojson")
    SHP_DIR.mkdir(parents=True, exist_ok=True)
    GEOJSON_OUT.parent.mkdir(parents=True, exist_ok=True)

    if filename.lower().endswith(".zip"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                # فقط محتویات shapefile را خالی کن: .shp/.shx/.dbf/.prj/.cpg
                members = [m for m in z.namelist() if m.lower().endswith((".shp", ".dbf", ".shx", ".prj", ".cpg"))]
                if not members:
                    return jsonify(ok=False, error="zip has no shapefile parts"), 400
                # پاک‌سازی قبلی
                for p in SHP_DIR.glob("subset.*"):
                    p.unlink(missing_ok=True)
                # استخراج با نام‌های subset.*
                for m in members:
                    ext = Path(m).suffix.lower()
                    with z.open(m) as src, open(SHP_DIR / f"subset{ext}", "wb") as dst:
                        shutil.copyfileobj(src, dst)
        except zipfile.BadZipFile:
            return jsonify(ok=False, error="bad zip"), 400

    elif filename.lower().endswith((".geojson", ".json")):
        # مستقیماً همین را current.geojson می‌کنیم
        GEOJSON_OUT.write_bytes(data)
    else:
        return jsonify(ok=False, error="unsupported file type"), 400

    # بازسازی (اگر zip بود shapefile -> geojson)
    try:
        ensure_geojson_from_shapefile()
    except Exception as e:
        return jsonify(ok=False, error=f"bootstrap failed: {e}"), 500

    return jsonify(ok=True, path=str(GEOJSON_OUT))