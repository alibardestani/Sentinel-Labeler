from __future__ import annotations

from flask import Blueprint, render_template, jsonify, request, url_for
from pathlib import Path
import os, json
from functools import lru_cache

import geopandas as gpd
import numpy as np
from shapely.geometry import mapping, shape
import rasterio
from rasterio.windows import from_bounds
from rasterio.warp import transform_geom
from pyproj import Transformer
from PIL import Image

# ---- Local modules (from your moved project2) ----
from .S2reader import SentinelProductReader

# ================== PATHS ==================
PKG_DIR    = Path(__file__).resolve().parent             # .../V4/project2
ROOT_DIR   = PKG_DIR.parent                               # .../V4    ✅ (important)
DATA_DIR   = ROOT_DIR / "data"                            # .../V4/data
POLY_DIR   = DATA_DIR / "polygons"
SCENES_DIR = DATA_DIR / "scenes"                          # put *.SAFE.zip here
CACHE_DIR  = PKG_DIR / "static" / "rgb_cache"            # served under /project2/static/rgb_cache
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

# ================== DATA ==================
def _empty_gdf() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"index": [], "status": [], "status_checked": [], "status_reviewed": [], "code": []},
        geometry=gpd.GeoSeries([], crs="EPSG:4326"),
    )

@lru_cache(maxsize=1)
def load_gdf() -> gpd.GeoDataFrame:
    shp = POLY_DIR / "polygons_stats_dedup_medium_size_with_status.shp"
    if not shp.exists():
        print(f"[project2] ⚠️ Shapefile not found: {shp}")
        return _empty_gdf()

    gdf = gpd.read_file(shp)

    # --- Clean geometry: drop None/empty, try to fix invalid via buffer(0) ---
    if "geometry" not in gdf.columns:
        return _empty_gdf()

    # Convert to proper GeoSeries if needed
    try:
        gdf.set_geometry("geometry", inplace=True, crs=gdf.crs)
    except Exception:
        pass

    # Drop None
    gdf = gdf[~gdf["geometry"].isna()].copy()

    # Drop empty (e.g., GEOMETRYCOLLECTION EMPTY)
    if hasattr(gdf.geometry, "is_empty"):
        gdf = gdf[~gdf.geometry.is_empty].copy()

    # Fix invalid geometries (buffer(0) trick)
    try:
        invalid_mask = ~gdf.geometry.is_valid
        if invalid_mask.any():
            gdf.loc[invalid_mask, "geometry"] = gdf.loc[invalid_mask, "geometry"].buffer(0)
            # drop any that still failed/fell apart
            gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    except Exception as e:
        print("[project2] geometry validity check failed:", e)

    # (Optional) filter out Unknown only AFTER cleaning;
    # comment this out while testing if it hides everything.
    try:
        gdf = gdf[gdf["status"] != "Unknown"].copy()
    except Exception:
        pass

    if "status_checked" not in gdf.columns:
        gdf["status_checked"] = "Not Reviewed"
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
        # Sometimes shapely returns empty geometry even after cleaning
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
            # still unsafe geometry → skip
            print("[project2] mapping() failed at row", i, ":", e)
            continue

        feats.append({"type": "Feature", "geometry": geojson_geom, "properties": props})

    return {"type": "FeatureCollection", "features": feats}

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

@project2_bp.route("/generate_all_pngs", methods=["GET"])
def generate_all_pngs():
    ok, msg = _generate_all_pngs_fast()
    return jsonify({"success": ok, "message": msg})

def _png_name_for_row(gdf, idx):
    code = str(gdf.iloc[idx].get("code")) if "code" in gdf.columns else None
    if code and code.strip().lower() != "nan":
        return f"{code}.png", f"{code}.meta.json"
    return f"{idx}.png", f"{idx}.meta.json"

@project2_bp.route("/get_polygon_rgb/<int:idx>")
def get_polygon_rgb(idx: int):
    gdf = load_gdf()
    if gdf.empty:
        return jsonify({"error": "Shapefile not loaded"}), 404
    if idx < 0 or idx >= len(gdf):
        return jsonify({"error": "index out of range"}), 404

    # NEW: check geometry exists
    geom = gdf.iloc[idx].geometry
    if geom is None:
        return jsonify({"error": "Geometry is None for this feature"}), 400
    try:
        if geom.is_empty:
            return jsonify({"error": "Geometry is empty for this feature"}), 400
    except Exception:
        pass

    png_name, meta_name = _png_name_for_row(gdf, idx)
    img_path = CACHE_DIR / png_name
    if not img_path.exists():
        return jsonify({"error": f"No PNG found for {png_name}"}), 404

    if not img_path.exists():
        return jsonify({"error": f"No PNG found for {png_name}"}), 404

    meta_path = CACHE_DIR / meta_name
    bbox = polygon_utm = epsg = None
    if meta_path.exists():
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        bbox = meta.get("bbox_utm")
        polygon_utm = meta.get("polygon_utm")
        epsg = meta.get("epsg")

    # Optional WGS84 bounds (not required for canvas)
    bbox_wgs84 = None
    if bbox and epsg:
        try:
            tr = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
            sw_lon, sw_lat = tr.transform(bbox["minx"], bbox["miny"])
            ne_lon, ne_lat = tr.transform(bbox["maxx"], bbox["maxy"])
            bbox_wgs84 = [[sw_lat, sw_lon], [ne_lat, ne_lon]]
        except Exception:
            pass

    web_path = url_for("project2_bp.static", filename=f"rgb_cache/{img_path.name}")
    return jsonify({
        "image_path": web_path,
        "bbox": bbox,
        "polygon_utm": polygon_utm,
        "bbox_wgs84": bbox_wgs84,
        "index": idx
    })

@project2_bp.route("/update_status", methods=["POST"])
def update_status():
    gdf = load_gdf()
    if gdf.empty:
        return jsonify({"success": False, "error": "Shapefile not loaded"})

    data  = request.get_json(force=True)
    idx   = int(data["id"])
    field = data.get("field", "status_reviewed")
    value = data.get("value")

    if idx < 0 or idx >= len(gdf):
        return jsonify({"success": False, "error": "Index out of range"})

    if field not in gdf.columns:
        gdf[field] = None
    gdf.at[idx, field] = value
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

    # NEW: clear cache so the next GET reloads clean data
    load_gdf.cache_clear()

    return jsonify({"success": True})

# ================== PNG GENERATOR ==================
def _generate_all_pngs_fast():
    """
    Build RGB crops + meta for all polygons from each *.zip in data/scenes/.
    PNG/meta names use column 'code' (fallback to index).
    """
    if not SCENES_DIR.exists():
        return False, f"Scenes dir not found: {SCENES_DIR}"
    zip_files = list(SCENES_DIR.glob("*.zip"))
    if not zip_files:
        return False, f"No Sentinel ZIP files in {SCENES_DIR}"

    gdf = load_gdf()
    if gdf.empty:
        return False, "Shapefile missing or empty"

    for z in zip_files:
        print(f"\n📦 Reading Sentinel ZIP: {z.name}")
        try:
            rdr = SentinelProductReader(str(z))
            bands = ["B04", "B03", "B02"]
            stack, profile = rdr.stack_bands(
                bands=bands,
                band_res={b: 10 for b in bands},
                align_to=10,
                resampling="bilinear",
            )
            profile.update(driver="GTiff", count=3, dtype="uint16")
            epsg = int(profile["crs"].to_epsg()) if profile.get("crs") else None
            transform = profile["transform"]
        except Exception as e:
            print(f"❌ Failed reading {z.name}: {e}")
            continue

        with rasterio.io.MemoryFile() as mem:
            with mem.open(**profile) as ds:
                ds.write(stack)

                for idx, row in gdf.iterrows():
                    # Skip missing/empty geometry
                    geom = row.get("geometry")
                    if geom is None:
                        continue
                    try:
                      if geom.is_empty:
                          continue
                    except Exception:
                        pass
                  
                    if row.get("status") == "Unknown":
                        continue

                    code = str(row.get("code") or idx)
                    out_png       = CACHE_DIR / f"{code}.png"
                    out_png_idx   = CACHE_DIR / f"{idx}.png"         # fallback
                    meta_path     = CACHE_DIR / f"{code}.meta.json"
                    meta_path_idx = CACHE_DIR / f"{idx}.meta.json"   # fallback

                    if out_png.exists():
                        continue

                    polygon = row.geometry
                    try:
                        if profile.get("crs"):
                            try:
                                poly_proj = transform_geom("EPSG:4326", profile["crs"], polygon.__geo_interface__)
                            except Exception:
                                poly_proj = polygon.__geo_interface__
                        else:
                            poly_proj = polygon.__geo_interface__

                        # square crop around polygon bbox (+20% padding)
                        minx, miny, maxx, maxy = shape(poly_proj).bounds
                        width  = maxx - minx
                        height = maxy - miny
                        pad = 0.2 * max(width, height)
                        cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
                        L = max(width, height) / 2 + pad
                        square_bounds = (cx - L, cy - L, cx + L, cy + L)

                        # meta (what viewer.js needs)
                        meta = {
                            "code": code,
                            "epsg": epsg,
                            "bbox_utm": {
                                "minx": square_bounds[0], "miny": square_bounds[1],
                                "maxx": square_bounds[2], "maxy": square_bounds[3]
                            },
                            "polygon_utm": poly_proj["coordinates"],
                        }
                        with open(meta_path, "w", encoding="utf-8") as f:
                            json.dump(meta, f, ensure_ascii=False, indent=2)
                        with open(meta_path_idx, "w", encoding="utf-8") as f:
                            json.dump(meta, f, ensure_ascii=False, indent=2)

                        # crop and stretch
                        window = from_bounds(*square_bounds, transform=transform)
                        img = ds.read(window=window)
                        if img.size == 0 or img.shape[1] == 0 or img.shape[2] == 0:
                            print(f"⚠️ Empty crop for {code}, skipping…")
                            continue

                        img = np.clip(img, np.percentile(img, 2), np.percentile(img, 98))
                        img = img - img.min()
                        denom = img.max() if img.max() != 0 else 1.0
                        img = (img / denom * 255).astype(np.uint8)
                        img = np.transpose(img, (1, 2, 0))  # CHW→HWC

                        Image.fromarray(img).save(out_png, format="PNG")
                        Image.fromarray(img).save(out_png_idx, format="PNG")
                        print(f"🟢 Saved PNG/meta for {code}")

                    except Exception as e:
                        print(f"⚠️ Failed for {code}: {e}")
                        continue

    return True, "All PNGs generated"