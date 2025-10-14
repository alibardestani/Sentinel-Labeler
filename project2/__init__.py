from __future__ import annotations

import os
import json
from pathlib import Path
from functools import lru_cache
from typing import Tuple

from flask import Blueprint, render_template, jsonify, request, url_for
import geopandas as gpd
import numpy as np
from shapely.geometry import mapping, shape
from pyproj import Transformer
from PIL import Image

import rasterio
from rasterio.windows import from_bounds
from rasterio.warp import transform_geom
from rasterio.features import rasterize
from scipy.ndimage import binary_erosion

# ---- Local module
from .S2reader import SentinelProductReader

# ================== PATHS ==================
PKG_DIR    = Path(__file__).resolve().parent            # .../project2
ROOT_DIR   = PKG_DIR.parent                             # adjust if package layout differs
DATA_DIR   = ROOT_DIR / "data"
POLY_DIR   = DATA_DIR / "polygons"
SCENES_DIR = DATA_DIR / "scenes"                        # preferred for *.SAFE.zip
SEN2_DIR   = DATA_DIR / "sen2"                          # legacy path
CACHE_DIR  = PKG_DIR / "static" / "rgb_cache"           # served under /project2/static/rgb_cache
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ================== BLUEPRINT ==================
project2_bp = Blueprint(
    "project2_bp",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/project2/static",
    url_prefix="/project2",
)

# ================== DATA LOADING ==================
def _empty_gdf() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"index": [], "status": [], "status_reviewed": [], "code": []},
        geometry=gpd.GeoSeries([], crs="EPSG:4326"),
    )

@lru_cache(maxsize=1)
def load_gdf() -> gpd.GeoDataFrame:
    shp = POLY_DIR / "polygons_stats_dedup_medium_size_with_status.shp"
    if not shp.exists():
        print(f"[project2] ⚠️ Shapefile not found: {shp}")
        return _empty_gdf()

    gdf = gpd.read_file(shp)

    # ensure geometry column / cleanup
    try:
        gdf.set_geometry("geometry", inplace=True, crs=gdf.crs)
    except Exception:
        pass

    gdf = gdf[~gdf["geometry"].isna()].copy()
    try:
        if hasattr(gdf.geometry, "is_empty"):
            gdf = gdf[~gdf.geometry.is_empty].copy()
        invalid_mask = ~gdf.geometry.is_valid
        if invalid_mask.any():
            gdf.loc[invalid_mask, "geometry"] = gdf.loc[invalid_mask, "geometry"].buffer(0)
            gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    except Exception as e:
        print("[project2] geometry validity check failed:", e)

    # keep your previous filter behavior
    try:
        gdf = gdf[gdf["status"] != "Unknown"].copy()
    except Exception:
        pass

    if "status_reviewed" not in gdf.columns:
        gdf["status_reviewed"] = "Pending"
    if "index" not in gdf.columns:
        gdf["index"] = list(range(len(gdf)))
    if "code" not in gdf.columns:
        gdf["code"] = gdf["index"].astype(str)

    return gdf

def serialize_polygons(gdf: gpd.GeoDataFrame) -> dict:
    feats = []
    for i, row in gdf.iterrows():
        geom = row.geometry
        if geom is None:
            continue
        try:
            if geom.is_empty:
                continue
        except Exception:
            pass

        props = {}
        for k in gdf.columns:
            if k == "geometry":
                continue
            v = row.get(k)
            if isinstance(v, float) and str(v) == "nan":
                v = None
            props[k] = v
        props["index"] = int(props.get("index", i) or i)

        try:
            geojson_geom = mapping(geom)
        except Exception as e:
            print("[project2] mapping() failed at row", i, ":", e)
            continue

        feats.append({"type": "Feature", "geometry": geojson_geom, "properties": props})

    return {"type": "FeatureCollection", "features": feats}

# ================== HELPERS ==================
def _iter_scene_zips() -> list[Path]:
    """Look for scene archives in both data/scenes and data/sen2 (compat)."""
    zips: list[Path] = []
    if SCENES_DIR.exists():
        zips.extend(SCENES_DIR.glob("*.zip"))
    if SEN2_DIR.exists():
        zips.extend(SEN2_DIR.glob("*.zip"))
    return zips

def _png_and_meta_names(code_or_idx: str | int) -> Tuple[Path, Path, Path]:
    code = str(code_or_idx)
    return (CACHE_DIR / f"{code}.png",
            CACHE_DIR / f"{code}.meta.json",
            CACHE_DIR / f"{code}_mask.png")

def _normalize_image(img: np.ndarray) -> np.ndarray:
    # img is CHW uint16/float; robust percentile stretch
    img = np.clip(img, np.percentile(img, 2), np.percentile(img, 98))
    img = img - img.min()
    denom = img.max() if img.max() != 0 else 1.0
    img = (img / denom * 255).astype(np.uint8)
    return np.transpose(img, (1, 2, 0))  # CHW→HWC

# ================== ROUTES ==================
@project2_bp.route("/")
def index():
    gdf = load_gdf()
    polygons = serialize_polygons(gdf) if not gdf.empty else {"type": "FeatureCollection", "features": []}
    return render_template(
        "project2/index.html",
        polygons_json=json.dumps(polygons, ensure_ascii=False),
        shapefile_missing=gdf.empty,
    )

# ---- GENERATORS ----
@project2_bp.route("/generate_all_pngs", methods=["GET"])
def generate_all_pngs():
    ok, msg = _generate_all_pngs_fast(create_masks=False)
    return jsonify({"success": ok, "message": msg})

@project2_bp.route("/generate_all_pngs_with_masks", methods=["GET"])
def generate_all_pngs_with_masks():
    ok, msg = _generate_all_pngs_fast(create_masks=True)
    return jsonify({"success": ok, "message": msg})

@project2_bp.route("/generate_all_tifs", methods=["GET"])
def generate_all_tifs():
    zips = _iter_scene_zips()
    if not zips:
        return jsonify({"success": False, "message": f"No Sentinel ZIP files in {SCENES_DIR} or {SEN2_DIR}."})

    gdf = load_gdf()
    if gdf.empty:
        return jsonify({"success": False, "message": "Shapefile missing or empty"})

    created = 0
    for z in zips:
        print(f"📦 Processing Sentinel ZIP: {z.name}")
        rdr = SentinelProductReader(str(z))
        for _, row in gdf.iterrows():
            if row.get("status") == "Unknown":
                continue
            code = str(row.get("code"))
            polygon = row.geometry
            out_tif = CACHE_DIR / f"{code}.tif"
            if out_tif.exists():
                continue
            try:
                rdr.get_tif_from_polygon(zip_path=str(z), polygon=polygon, out_tif=str(out_tif))
                created += 1
            except Exception as e:
                print(f"⚠️ TIF failed for {code} with {z.name}: {e}")

    return jsonify({"success": True, "message": f"Created {created} TIFs in {CACHE_DIR}."})

# ---- GET image by index (image+meta+mask if present) ----
@project2_bp.route("/get_polygon_rgb/<int:idx>")
def get_polygon_rgb_by_index(idx: int):
    gdf = load_gdf()
    if gdf.empty:
        return jsonify({"error": "Shapefile not loaded"}), 404
    if idx < 0 or idx >= len(gdf):
        return jsonify({"error": "index out of range"}), 404

    geom = gdf.iloc[idx].geometry
    if geom is None or getattr(geom, "is_empty", False):
        return jsonify({"error": "Invalid geometry for this feature"}), 400

    code = str(gdf.iloc[idx].get("code") or idx)
    img_path, meta_path, mask_path = _png_and_meta_names(code)

    if not img_path.exists():
        # fallback to idx-named file if present
        img_path, meta_path, mask_path = _png_and_meta_names(idx)
        if not img_path.exists():
            return jsonify({"error": f"No PNG found for {code}"}), 404

    bbox = polygon_utm = epsg = None
    if meta_path.exists():
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        bbox = meta.get("bbox_utm")
        polygon_utm = meta.get("polygon_utm")
        epsg = meta.get("epsg")

    bbox_wgs84 = None
    if bbox and epsg:
        try:
            tr = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
            sw_lon, sw_lat = tr.transform(bbox["minx"], bbox["miny"])
            ne_lon, ne_lat = tr.transform(bbox["maxx"], bbox["maxy"])
            bbox_wgs84 = [[sw_lat, sw_lon], [ne_lat, ne_lon]]
        except Exception:
            pass

    web_img = url_for("project2_bp.static", filename=f"rgb_cache/{img_path.name}")
    web_mask = url_for("project2_bp.static", filename=f"rgb_cache/{Path(mask_path).name}") if Path(mask_path).exists() else None

    resp = {"image_path": web_img, "bbox": bbox, "polygon_utm": polygon_utm, "bbox_wgs84": bbox_wgs84, "index": idx}
    if web_mask:
        resp["mask_path"] = web_mask
    return jsonify(resp)

# ---- GET image by code (simple endpoint) ----
@project2_bp.route("/get_polygon_rgb_by_code/<code>")
def get_polygon_rgb_by_code(code: str):
    code = str(code)
    img_path, meta_path, mask_path = _png_and_meta_names(code)
    if not img_path.exists():
        return jsonify({"error": "Image not found"}), 404

    bbox_wgs84 = None
    if meta_path.exists():
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        bbox = meta.get("bbox_utm")
        epsg = meta.get("epsg")
        if bbox and epsg:
            try:
                tr = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
                sw_lon, sw_lat = tr.transform(bbox["minx"], bbox["miny"])
                ne_lon, ne_lat = tr.transform(bbox["maxx"], bbox["maxy"])
                bbox_wgs84 = [[sw_lat, sw_lon], [ne_lat, ne_lon]]
            except Exception:
                pass

    web_img  = url_for("project2_bp.static", filename=f"rgb_cache/{img_path.name}")
    resp = {"image_path": web_img, "bbox_wgs84": bbox_wgs84}

    if Path(mask_path).exists():
        web_mask = url_for("project2_bp.static", filename=f"rgb_cache/{Path(mask_path).name}")
        resp["mask_path"] = web_mask

    return jsonify(resp)

# ---- UPDATE STATUS (by code or id) ----
@project2_bp.route("/update_status", methods=["POST"])
def update_status():
    gdf = load_gdf()
    if gdf.empty:
        return jsonify({"success": False, "error": "Shapefile not loaded"})

    data  = request.get_json(force=True)
    code = data.get("code")  # preferred in new UI
    idx  = data.get("id")    # backward compat with old UI
    field = data.get("field", "status_reviewed")  # unified name
    value = data.get("value")

    if field not in gdf.columns:
        gdf[field] = None

    if code is not None:
        code = str(code)
        mask = gdf["code"].astype(str) == code
        if not mask.any():
            return jsonify({"success": False, "error": f"Code {code} not found in shapefile."})
        gdf.loc[mask, field] = value
        print(f"✅ Updated {field}={value} for code={code}")
    elif idx is not None:
        idx = int(idx)
        if idx < 0 or idx >= len(gdf):
            return jsonify({"success": False, "error": "Index out of range"})
        gdf.at[idx, field] = value
        print(f"✅ Updated {field}={value} for index={idx}")
    else:
        return jsonify({"success": False, "error": "Provide either 'code' or 'id' in body."})

    # Optional immediate persistence:
    # out_base = POLY_DIR / "polygons_stats_dedup_medium_size_with_status"
    # gdf.to_file(out_base.with_suffix(".shp"), driver="ESRI Shapefile", encoding="utf-8")
    return jsonify({"success": True, "field": field, "value": value})

@project2_bp.route("/save_all", methods=["POST"])
def save_all():
    gdf = load_gdf()
    if gdf.empty:
        return jsonify({"success": False, "error": "Shapefile not loaded"})

    out_base = POLY_DIR / "polygons_stats_dedup_medium_size_with_status"
    out_shp  = out_base.with_suffix(".shp")
    POLY_DIR.mkdir(parents=True, exist_ok=True)

    gdf.to_file(out_shp, driver="ESRI Shapefile", encoding="utf-8")
    print(f"✅ Saved shapefile to {out_shp}")

    # Clear cache so next call reloads from disk
    load_gdf.cache_clear()

    return jsonify({"success": True})

# ================== PNG GENERATOR (FAST) ==================
def _generate_all_pngs_fast(create_masks: bool = False):
    """
    Build RGB crops (+ optional RGBA edge masks) + meta for all polygons
    from each *.zip in data/scenes/ or data/sen2/.
    Filenames use column 'code' (fallback to index is also written).
    """
    zips = _iter_scene_zips()
    if not zips:
        return False, f"No Sentinel ZIP files in {SCENES_DIR} or {SEN2_DIR}"

    gdf = load_gdf()
    if gdf.empty:
        return False, "Shapefile missing or empty"

    for z in zips:
        print(f"\n📦 Reading Sentinel ZIP: {z.name}")
        try:
            rdr = SentinelProductReader(str(z))
            bands = ["B04", "B03", "B02"]  # RGB
            stack, profile = rdr.stack_bands(
                bands=bands,
                band_res={b: 10 for b in bands},
                align_to=10,
                resampling="bilinear",
            )
            profile.update(driver="GTiff", count=3, dtype="uint16")
            epsg = int(profile["crs"].to_epsg()) if profile.get("crs") else None
            transform = profile["transform"]
            crs = profile["crs"]
        except Exception as e:
            print(f"❌ Failed reading {z.name}: {e}")
            continue

        with rasterio.io.MemoryFile() as mem:
            with mem.open(**profile) as ds:
                ds.write(stack)

                for idx, row in gdf.iterrows():
                    geom = row.get("geometry")
                    if geom is None or getattr(geom, "is_empty", False):
                        continue
                    if row.get("status") == "Unknown":
                        continue

                    code = str(row.get("code") or idx)
                    out_png_code, meta_code, out_mask_code = _png_and_meta_names(code)
                    out_png_idx  = CACHE_DIR / f"{idx}.png"
                    meta_idx     = CACHE_DIR / f"{idx}.meta.json"

                    if out_png_code.exists() and (not create_masks or Path(out_mask_code).exists()):
                        continue

                    try:
                        # project polygon to raster CRS
                        if profile.get("crs"):
                            try:
                                poly_proj = transform_geom("EPSG:4326", crs, geom.__geo_interface__)
                            except Exception:
                                poly_proj = geom.__geo_interface__
                        else:
                            poly_proj = geom.__geo_interface__

                        # square crop around polygon bbox (+20% padding)
                        minx, miny, maxx, maxy = shape(poly_proj).bounds
                        width  = maxx - minx
                        height = maxy - miny
                        pad = 0.2 * max(width, height)
                        cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
                        L = max(width, height) / 2 + pad
                        square_bounds = (cx - L, cy - L, cx + L, cy + L)

                        # meta
                        meta = {
                            "code": code,
                            "epsg": epsg,
                            "bbox_utm": {
                                "minx": square_bounds[0], "miny": square_bounds[1],
                                "maxx": square_bounds[2], "maxy": square_bounds[3]
                            },
                            "polygon_utm": poly_proj["coordinates"],
                        }
                        for mp in (meta_code, meta_idx):
                            with open(mp, "w", encoding="utf-8") as f:
                                json.dump(meta, f, ensure_ascii=False, indent=2)

                        # crop + stretch
                        window = from_bounds(*square_bounds, transform=transform)
                        img = ds.read(window=window)
                        if img.size == 0 or img.shape[1] == 0 or img.shape[2] == 0:
                            print(f"⚠️ Empty crop for {code}, skipping…")
                            continue

                        img = _normalize_image(img)
                        Image.fromarray(img).save(out_png_code, format="PNG")
                        Image.fromarray(img).save(out_png_idx,  format="PNG")
                        print(f"🟢 Saved PNG/meta for {code}")

                        # optional RGBA edge mask
                        if create_masks:
                            out_shape = (img.shape[0], img.shape[1])
                            mask = rasterize(
                                [(mapping(shape(poly_proj)), 1)],
                                out_shape=out_shape,
                                transform=ds.window_transform(window),
                                fill=0,
                                dtype=np.uint8,
                            )
                            edge = mask ^ binary_erosion(mask)
                            rgba = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
                            rgba[edge == 1] = [255, 0, 0, 200]
                            Image.fromarray(rgba).save(out_mask_code, format="PNG")

                    except Exception as e:
                        print(f"⚠️ Failed for {code}: {e}")
                        continue

    return True, "All PNGs generated"