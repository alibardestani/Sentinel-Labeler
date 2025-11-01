# routes/admin.py
from __future__ import annotations
from functools import wraps
import os, io, zipfile, tempfile, json
import geopandas as gpd

from flask import (
    Blueprint, render_template, redirect, url_for,
    session, request, abort, flash, current_app
)
from werkzeug.security import generate_password_hash
from models_polygons import PolygonSet, Polygon


from models import db, User, AssignedTile
from models import PolygonAssignment
from routes.guards import admin_required

# اگر templates در روت پروژه است، نیازی به template_folder نیست
admin_bp = Blueprint("admin_bp", __name__)

def _as_bool(v: str | None) -> bool:
    """تبدیل ورودی‌های فرم به بولین (checkbox)"""
    return str(v).strip().lower() in ("1", "true", "on", "yes")

@admin_bp.get("/")
@admin_required
def home():
    # لیست کاربران
    users = User.query.order_by(User.created_at.desc()).all()

    # لیست انتساب‌ها (AssignedTile) به همراه اطلاعات کاربر
    tiles = (
        db.session.query(AssignedTile, User)
        .join(User, User.id == AssignedTile.user_id)
        .order_by(AssignedTile.created_at.desc())
        .all()
    )
    return render_template("admin.html", users=users, tiles=tiles)

@admin_bp.post("/users/create")
@admin_required
def users_create():
    email = (request.form.get("email") or "").strip().lower()
    password = request.form.get("password") or ""
    is_admin = _as_bool(request.form.get("is_admin"))

    if not (email and password):
        flash("Email/Password required", "error")
        return redirect(url_for("admin_bp.home"))

    if User.query.filter_by(email=email).first():
        flash("Email already exists", "error")
        return redirect(url_for("admin_bp.home"))

    u = User(email=email, password=generate_password_hash(password), is_admin=is_admin)
    db.session.add(u)
    db.session.commit()
    flash("User created", "ok")
    return redirect(url_for("admin_bp.home"))

@admin_bp.post("/tiles/assign")
@admin_required
def tiles_assign():
    user_id = int(request.form.get("user_id") or 0)
    scene_id = (request.form.get("scene_id") or "").strip()
    scene_name = (request.form.get("scene_name") or "").strip()
    label = (request.form.get("label") or "").strip()

    if not (user_id and scene_id):
        flash("user_id/scene_id required", "error")
        return redirect(url_for("admin_bp.home"))

    at = AssignedTile(
        user_id=user_id,
        scene_id=scene_id,
        scene_name=scene_name or scene_id,
        label=label or None,
    )
    db.session.add(at)
    db.session.commit()
    flash("Tile assigned", "ok")
    return redirect(url_for("admin_bp.home"))

# --- اختیاری: لاگ دیباگ برای اطمینان از وضعیت دسترسی ---
@admin_bp.before_request
def _debug_admin_gate():
    if not current_app.debug:
        return
    uid = session.get("user_id")
    if uid:
        u = User.query.get(uid)
        current_app.logger.debug(
            "[admin] uid=%s email=%s is_admin=%s",
            uid,
            getattr(u, "email", None),
            bool(getattr(u, "is_admin", False)),
        )
            
@admin_bp.get("/polygons")
@admin_required
def polygons_page():
    sets = PolygonSet.query.order_by(PolygonSet.created_at.desc()).all()
    return render_template("admin_polygons.html", sets=sets)

@admin_bp.post("/polygons/upload")
@admin_required
def polygons_upload():
    if "file" not in request.files:
        flash("No file", "error")
        return redirect(url_for("admin_bp.polygons_page"))

    f = request.files["file"]
    if not f.filename.lower().endswith(".zip"):
        flash("Please upload ZIP containing .shp", "error")
        return redirect(url_for("admin_bp.polygons_page"))

    set_name = (request.form.get("name") or os.path.splitext(f.filename)[0]).strip() or "uploaded_polygons"
    uploader_id = session.get("user_id")

    with tempfile.TemporaryDirectory() as td:
        zip_path = os.path.join(td, "upload.zip")
        f.save(zip_path)
        with zipfile.ZipFile(zip_path, "r") as z:
            z.extractall(td)

        shp_candidates = []
        for root, _, files in os.walk(td):
            for nm in files:
                if nm.lower().endswith(".shp"):
                    shp_candidates.append(os.path.join(root, nm))
        if not shp_candidates:
            flash("No .shp file inside ZIP", "error")
            return redirect(url_for("admin_bp.polygons_page"))

        shp_path = shp_candidates[0]
        gdf = gpd.read_file(shp_path)

    # Reproject to EPSG:4326 for web
    try:
        if gdf.crs and gdf.crs.to_string() != "EPSG:4326":
            gdf = gdf.to_crs("EPSG:4326")
    except Exception:
        pass

    # Create PolygonSet
    pset = PolygonSet(name=set_name, source_filename=f.filename, uploaded_by=uploader_id)
    db.session.add(pset)
    db.session.flush()  # get pset.id

    # Bulk insert polygons
    records = []
    for idx, row in gdf.iterrows():
        props = {k: v for k, v in row.items() if k != "geometry"}
        geom = json.loads(row.geometry.to_json()) if hasattr(row.geometry, "to_json") else json.loads(gpd.GeoSeries([row.geometry]).to_json())["features"][0]["geometry"]
        records.append(dict(set_id=pset.id, ext_id=str(props.get("id") or props.get("ID") or idx), properties=props, geometry_geojson=geom))
    db.session.bulk_insert_mappings(Polygon, records)
    pset.feature_count = len(records)
    db.session.commit()

    flash(f"Uploaded set '{set_name}' with {len(records)} polygons.", "ok")
    return redirect(url_for("admin_bp.polygons_page"))


@admin_bp.post("/polygons/assign_batch")
@admin_required
def polygons_assign_batch():
    set_id = int(request.form.get("set_id") or 0)
    user_id = int(request.form.get("user_id") or 0)
    offset = int(request.form.get("offset") or 0)
    limit  = int(request.form.get("limit") or 0)

    if not (set_id and user_id and limit > 0):
        flash("set_id/user_id/limit required", "error")
        return redirect(url_for("admin_bp.polygons_page"))

    # Pick polygons from this set not yet assigned to this user
    q = (
        db.session.query(Polygon.id)
        .filter(Polygon.set_id == set_id)
        .order_by(Polygon.id.asc())
        .offset(offset)
        .limit(limit)
    )
    polygon_ids = [pid for (pid,) in q.all()]
    if not polygon_ids:
        flash("No polygons selected for batch (check offset/limit).", "error")
        return redirect(url_for("admin_bp.polygons_page"))

    # Avoid duplicates (unique constraint will guard; better to pre-check)
    existing = set(
        pid for (pid,) in
        db.session.query(PolygonAssignment.polygon_id)
        .filter(PolygonAssignment.user_id == user_id, PolygonAssignment.polygon_id.in_(polygon_ids))
        .all()
    )
    to_create = [dict(polygon_id=pid, user_id=user_id, status="queued") for pid in polygon_ids if pid not in existing]
    if to_create:
        db.session.bulk_insert_mappings(PolygonAssignment, to_create)
        db.session.commit()
        flash(f"Assigned {len(to_create)} polygons (set {set_id}) to user {user_id}.", "ok")
    else:
        flash("All chosen polygons already assigned to this user.", "error")

    return redirect(url_for("admin_bp.polygons_page"))