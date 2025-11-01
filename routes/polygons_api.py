# routes/polygons_api.py
from __future__ import annotations

import io
import os
import json
import zipfile
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from flask import Blueprint, jsonify, request, session
from werkzeug.utils import secure_filename

from models_polygons import Polygon, PolygonSet
from models import db, PolygonAssignment
from routes.guards import login_required, admin_required  # make sure you have these

# Geo stack
import geopandas as gpd

polygons_api = Blueprint("polygons_api", __name__, url_prefix="/api/polygons")

# --- Optional legacy bootstrap support (non-fatal if missing) -----------------
try:
    from services.polygons_bootstrap import ensure_geojson_from_shapefile, load_geojson_dict
except Exception:
    def ensure_geojson_from_shapefile(*args, **kwargs):
        return None
    def load_geojson_dict(*args, **kwargs):
        return None


# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------

def _to_epsg4326(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Ensure gdf is EPSG:4326; if unknown CRS, leave as-is."""
    try:
        if gdf.crs and gdf.crs.to_string() != "EPSG:4326":
            return gdf.to_crs("EPSG:4326")
    except Exception:
        pass
    return gdf


def _feature_from_row(idx: int, row) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Convert a GeoPandas row to (geometry_dict, properties_dict).
    Returns GeoJSON-like geometry and a properties dict (without 'geometry').
    """
    props = {k: v for k, v in row.items() if k != "geometry"}
    # Normalize numpy/pandas types for JSON safety
    for k, v in list(props.items()):
        if hasattr(v, "item"):  # numpy scalar
            try:
                props[k] = v.item()
            except Exception:
                pass
    # Build geometry as a dict
    try:
        geom_dict = json.loads(row.geometry.to_json())
    except Exception:
        # fallback for exotic geometry types
        geom_dict = json.loads(gpd.GeoSeries([row.geometry]).to_json())["features"][0]["geometry"]
    return geom_dict, props


def _read_shapefile_zip_to_features(file_bytes: bytes) -> List[Dict[str, Any]]:
    """
    Read a ZIP containing a shapefile into a list of GeoJSON Features
    (geometry as dict, properties as dict). Reprojects to EPSG:4326.
    """
    with tempfile.TemporaryDirectory() as td:
        zip_path = os.path.join(td, "upload.zip")
        Path(zip_path).write_bytes(file_bytes)

        with zipfile.ZipFile(zip_path, "r") as z:
            z.extractall(td)

        # find .shp
        shp_candidates: List[str] = []
        for root, _, files in os.walk(td):
            for nm in files:
                if nm.lower().endswith(".shp"):
                    shp_candidates.append(os.path.join(root, nm))
        if not shp_candidates:
            raise ValueError("ZIP has no .shp file")

        shp_path = shp_candidates[0]
        gdf = gpd.read_file(shp_path)
        gdf = _to_epsg4326(gdf)

    features: List[Dict[str, Any]] = []
    for i, row in gdf.iterrows():
        geom, props = _feature_from_row(i, row)
        # Choose an external id if present (id/ID/fid/FID), else index
        ext_id = str(props.get("id") or props.get("ID") or props.get("fid") or props.get("FID") or i)
        features.append({
            "type": "Feature",
            "id": ext_id,
            "geometry": geom,
            "properties": props
        })
    return features


def _read_geojson_bytes_to_features(file_bytes: bytes) -> List[Dict[str, Any]]:
    """
    Parse a (multi) Feature GeoJSON into a list of Features with dict geometry.
    Does not reproject (assumes EPSG:4326).
    """
    gj = json.loads(file_bytes.decode("utf-8"))
    if isinstance(gj, dict) and gj.get("type") == "FeatureCollection":
        feats = gj.get("features") or []
    elif isinstance(gj, dict) and gj.get("type") == "Feature":
        feats = [gj]
    else:
        raise ValueError("Invalid GeoJSON: expected Feature or FeatureCollection")
    # basic normalization
    out: List[Dict[str, Any]] = []
    for i, ft in enumerate(feats):
        if not isinstance(ft, dict) or ft.get("type") != "Feature":
            continue
        geom = ft.get("geometry")
        if not geom:
            continue
        props = ft.get("properties") or {}
        ext_id = ft.get("id") or props.get("id") or props.get("ID") or i
        out.append({
            "type": "Feature",
            "id": str(ext_id),
            "geometry": geom,
            "properties": props
        })
    return out


def _ingest_features_as_set(
    set_name: str,
    source_filename: str,
    uploader_id: int,
    features: List[Dict[str, Any]],
) -> Tuple[int, int]:
    """
    Create a PolygonSet and bulk insert Polygons. Returns (set_id, inserted_count).
    """
    pset = PolygonSet(name=set_name, source_filename=source_filename, uploaded_by=uploader_id)
    db.session.add(pset)
    db.session.flush()  # allocate id

    records = []
    for idx, ft in enumerate(features):
        geom = ft.get("geometry")
        props = ft.get("properties") or {}
        ext_id = str(ft.get("id") or props.get("id") or props.get("ID") or idx)

        # remove internal props if any
        clean_props = {k: v for k, v in props.items() if not str(k).startswith("_")}
        # sanity check geometry
        if not isinstance(geom, dict) or "type" not in geom or "coordinates" not in geom:
            # skip invalid geometry silently (or raise)
            continue

        records.append(dict(
            set_id=pset.id,
            ext_id=ext_id,
            properties=clean_props,
            geometry_geojson=geom
        ))

    if records:
        db.session.bulk_insert_mappings(Polygon, records)
    pset.feature_count = len(records)
    db.session.commit()
    return pset.id, pset.feature_count


# ------------------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------------------

@polygons_api.get("/")
def get_polygons_legacy():
    """
    Legacy endpoint to return the current file-based GeoJSON, if your
    services.polygons_bootstrap module is present. Safe no-op otherwise.
    """
    try:
        ensure_geojson_from_shapefile()
        gj = load_geojson_dict()
        if not gj:
            return jsonify(ok=False, error="no polygons"), 404
        return jsonify(gj)
    except Exception as e:
        return jsonify(ok=False, error=f"bootstrap failure: {e}"), 500


@polygons_api.post("/upload")
@admin_required
def upload_polygons():
    """
    Admin-only upload:
      - Accepts .zip (shapefile) or .geojson/.json
      - Converts to EPSG:4326 (for shapefile)
      - Ingests into DB as a new PolygonSet + Polygons
    Returns: { ok, set_id, inserted, name }
    """
    f = request.files.get("file")
    if not f:
        return jsonify(ok=False, error="file missing"), 400

    filename = secure_filename(f.filename or "upload")
    file_bytes = f.read()
    if not file_bytes:
        return jsonify(ok=False, error="empty file"), 400

    set_name = (request.form.get("name") or os.path.splitext(filename)[0]).strip() or "uploaded_polygons"
    uploader_id = session.get("user_id")  # admin

    try:
        if filename.lower().endswith(".zip"):
            features = _read_shapefile_zip_to_features(file_bytes)
        elif filename.lower().endswith((".geojson", ".json")):
            features = _read_geojson_bytes_to_features(file_bytes)
        else:
            return jsonify(ok=False, error="unsupported file type (zip/geojson)"), 400

        set_id, inserted = _ingest_features_as_set(set_name, filename, uploader_id, features)
        return jsonify(ok=True, set_id=set_id, inserted=inserted, name=set_name), 201

    except zipfile.BadZipFile:
        return jsonify(ok=False, error="bad zip"), 400
    except ValueError as ve:
        return jsonify(ok=False, error=str(ve)), 400
    except Exception as e:
        db.session.rollback()
        return jsonify(ok=False, error=f"ingest failed: {e}"), 500


@polygons_api.get("/mine")
@login_required
def my_polygons():
    """
    Return only polygons assigned to the current user as a FeatureCollection.
    """
    uid = session["user_id"]
    rows = (
        db.session.query(Polygon, PolygonAssignment)
        .join(PolygonAssignment, PolygonAssignment.polygon_id == Polygon.id)
        .filter(PolygonAssignment.user_id == uid)
        .all()
    )

    features: List[Dict[str, Any]] = []
    for poly, assign in rows:
        features.append({
            "type": "Feature",
            "id": poly.id,
            "geometry": poly.geometry_geojson,
            "properties": {
                **(poly.properties or {}),
                "_polygon_id": poly.id,
                "_assignment_id": assign.id,
                "_status": assign.status,
                "_set_id": poly.set_id,
            }
        })
    return jsonify({"type": "FeatureCollection", "features": features})


@polygons_api.post("/save")  # autosave whole collection or a single feature
@login_required
def save_polygons():
    """
    Accept {"type":"Feature", ...} or {"type":"FeatureCollection","features":[...]}.
    Update geometry/properties of polygons assigned to the current user.
    Stamps assignment: status->'edited' (if queued/in_progress), last_editor_id/last_edit_at.
    """
    uid = session["user_id"]
    payload = request.get_json(silent=True)
    if not payload:
        return jsonify(error="no JSON"), 400

    if payload.get("type") == "FeatureCollection":
        features = payload.get("features") or []
    elif payload.get("type") == "Feature":
        features = [payload]
    else:
        return jsonify(error="invalid payload: expected Feature or FeatureCollection"), 400

    now = datetime.utcnow()
    updated = 0

    for ft in features:
        if not isinstance(ft, dict) or ft.get("type") != "Feature":
            continue
        props = ft.get("properties") or {}
        poly_id = props.get("_polygon_id") or ft.get("id")
        if not poly_id:
            continue

        # Ensure the user is assigned to this polygon
        assign = (
            PolygonAssignment.query
            .filter_by(user_id=uid, polygon_id=poly_id)
            .first()
        )
        if not assign:
            # skip silently (or return 403 for first violation)
            continue

        poly = Polygon.query.get(poly_id)
        if not poly:
            continue

        # Update geometry if present
        if "geometry" in ft and ft["geometry"]:
            geom = ft["geometry"]
            # light validation
            if isinstance(geom, dict) and "type" in geom and "coordinates" in geom:
                poly.geometry_geojson = geom

        # Update properties (exclude our internal fields)
        clean_props = {k: v for k, v in (props or {}).items() if not str(k).startswith("_")}
        poly.properties = clean_props

        # Update assignment audit
        if assign.status in ("queued", "in_progress"):
            assign.status = "edited"
        assign.last_editor_id = uid
        assign.last_edit_at = now

        updated += 1

    if updated:
        db.session.commit()

    return jsonify(status="ok", updated=updated)