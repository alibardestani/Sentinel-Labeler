# polygon_navigator_app/routes.py

import os
import io
import zipfile
import tempfile
import json
from datetime import datetime

from flask import Blueprint, render_template, request, jsonify, send_file, session, redirect, url_for
import geopandas as gpd

# shapely imports may vary by version
from shapely.geometry import shape, mapping
from shapely import wkb
import shapely

# ---- Blueprint definition ----
polygon_navigator_bp = Blueprint(
    "polygon_navigator",
    __name__,
    url_prefix="/polygon-navigator",  # final URL prefix in main app
    template_folder="templates",
    static_folder="static",
    static_url_path="/polygon-navigator-static"
)

# ---- In-memory store (single-user demo style) ----
CURRENT_GDF = None
CURRENT_CRS = "EPSG:4326"


# ---- Simple auth guard using your session logic ----
def require_login():
    """
    Minimal guard: if user_id not in session, redirect to /login.
    Your main app already sets session['user_id'] on login, based on what you showed.
    If you have a nicer decorator in routes/auth.py, you can import and use that instead.
    """
    if "user_id" not in session:
        return redirect(url_for("auth.login"))  # assuming your auth blueprint exposes 'login' route
    return None


def _ensure_quality_column(gdf):
    if "quality" not in gdf.columns:
        gdf["quality"] = None
    # Normalize values to strings or None
    gdf["quality"] = gdf["quality"].astype(object).where(gdf["quality"].notna(), None)
    return gdf


@polygon_navigator_bp.route("/", methods=["GET"])
def index():
    # auth check
    needs_login = require_login()
    if needs_login:
        return needs_login

    # render namespaced template so we don't collide with other pages
    return render_template("polygon_navigator/index.html")


@polygon_navigator_bp.route("/upload_shapefile", methods=["POST"])
def upload_shapefile():
    """
    Accept a ZIP containing an ESRI Shapefile, read it into GeoPandas,
    transform to EPSG:4326 if needed, ensure a 'quality' column exists,
    and store server-side in memory.
    """
    # auth check
    needs_login = require_login()
    if needs_login:
        return needs_login

    global CURRENT_GDF, CURRENT_CRS

    if "file" not in request.files:
        return jsonify({"status": "error", "message": "No file provided"}), 400

    f = request.files["file"]
    if f.filename == "":
        return jsonify({"status": "error", "message": "Empty filename"}), 400

    # Save uploaded zip to temp and extract
    with tempfile.TemporaryDirectory() as td:
        zip_path = os.path.join(td, "upload.zip")
        f.save(zip_path)

        # Extract zip
        with zipfile.ZipFile(zip_path, "r") as z:
            z.extractall(td)

        # Find the first .shp
        shp_candidates = []
        for root, _, files in os.walk(td):
            for name in files:
                if name.lower().endswith(".shp"):
                    shp_candidates.append(os.path.join(root, name))

        if not shp_candidates:
            return jsonify({"status": "error", "message": "No .shp file found in ZIP"}), 400

        shp_path = shp_candidates[0]

        try:
            gdf = gpd.read_file(shp_path)
        except Exception as e:
            return jsonify({"status": "error", "message": f"Failed to read shapefile: {e}"}), 400

    # Reproject to WGS84 for Leaflet
    try:
        if gdf.crs is not None and gdf.crs.to_string() != "EPSG:4326":
            gdf = gdf.to_crs("EPSG:4326")
    except Exception:
        # If CRS unknown or conversion fails, assume already EPSG:4326
        pass

    gdf = _ensure_quality_column(gdf)

    CURRENT_GDF = gdf
    CURRENT_CRS = gdf.crs.to_string() if gdf.crs is not None else "EPSG:4326"

    # Return summary to frontend
    return jsonify({
        "status": "ok",
        "feature_count": int(len(gdf)),
        "fields": [c for c in gdf.columns if c != "geometry"],
        "crs": CURRENT_CRS
    })


@polygon_navigator_bp.route("/data", methods=["GET"])
def get_geojson():
    # auth check
    needs_login = require_login()
    if needs_login:
        return needs_login

    global CURRENT_GDF
    if CURRENT_GDF is None or CURRENT_GDF.empty:
        return jsonify({"type": "FeatureCollection", "features": []})
    # Ensure quality column exists
    CURRENT_GDF = _ensure_quality_column(CURRENT_GDF)
    # Convert to GeoJSON dict
    fc = json.loads(CURRENT_GDF.to_json())
    return jsonify(fc)


@polygon_navigator_bp.route("/save_shapefile", methods=["POST"])
def save_shapefile():
    """
    Receive full GeoJSON from client (with updated 'quality' values).
    Save as a shapefile with UTF-8 encoding, zip it, and return download URL.
    """
    # auth check
    needs_login = require_login()
    if needs_login:
        return needs_login

    payload = request.get_json(silent=True)
    if not payload:
        return jsonify({"status": "error", "message": "Missing JSON body"}), 400

    try:
        gdf = gpd.GeoDataFrame.from_features(payload["features"], crs="EPSG:4326")
    except Exception as e:
        return jsonify({"status": "error", "message": f"Invalid GeoJSON: {e}"}), 400

    # Ensure quality column exists, fill missing with literal string "None"
    if "quality" not in gdf.columns:
        gdf["quality"] = None

    gdf["quality"] = gdf["quality"].astype(object)
    gdf["quality"] = gdf["quality"].where(gdf["quality"].notna(), "None")

    out_dir = os.path.join("output")
    os.makedirs(out_dir, exist_ok=True)
    stem = "polygons_with_quality"
    shp_path = os.path.join(out_dir, f"{stem}.shp")

    try:
        gdf.to_file(shp_path, encoding="utf-8")
    except Exception as e:
        return jsonify({"status": "error", "message": f"Failed to write shapefile: {e}"}), 500

    # Zip all shapefile components
    sidecars = []
    base = os.path.splitext(shp_path)[0]
    for ext in [".shp", ".shx", ".dbf", ".prj", ".cpg"]:
        p = base + ext
        if os.path.exists(p):
            sidecars.append(p)

    zip_out = os.path.join(out_dir, f"{stem}.zip")
    with zipfile.ZipFile(zip_out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sidecars:
            z.write(p, arcname=os.path.basename(p))

    # We will serve this via a blueprint route below
    return jsonify({
        "status": "saved",
        "shapefile_zip": url_for("polygon_navigator.download_file", filename=f"{stem}.zip")
    })


@polygon_navigator_bp.route("/download/<path:filename>", methods=["GET"])
def download_file(filename):
    # auth check
    needs_login = require_login()
    if needs_login:
        return needs_login

    out_dir = os.path.join("output")
    full_path = os.path.join(out_dir, filename)
    if not os.path.exists(full_path):
        return jsonify({"status": "error", "message": "File not found"}), 404
    return send_file(full_path, as_attachment=True)