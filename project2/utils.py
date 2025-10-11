from __future__ import annotations
import os, zipfile, geopandas as gpd, numpy as np, rasterio
from shapely.geometry import shape, box

from rasterio.io import DatasetReader

from .S2reader import SentinelProductReader
def load_or_extract_shapefile(zip_path):
    extract_dir = zip_path.replace(".zip", "")
    os.makedirs(os.path.dirname(zip_path), exist_ok=True)
    if not os.path.exists(extract_dir):
        with zipfile.ZipFile(zip_path, "r") as zip_ref:
            zip_ref.extractall(extract_dir)
    shp_files = [f for f in os.listdir(extract_dir) if f.endswith(".shp")]
    if not shp_files:
        raise FileNotFoundError("No shapefile found in zip.")
    return gpd.read_file(os.path.join(extract_dir, shp_files[0]))

def save_shapefile(gdf, zip_path):
    extract_dir = zip_path.replace(".zip", "")
    os.makedirs(extract_dir, exist_ok=True)
    tmp_shp = os.path.join(extract_dir, "polygons.shp")
    gdf.to_file(tmp_shp)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fn in os.listdir(extract_dir):
            if fn.startswith("polygons."):
                zf.write(os.path.join(extract_dir, fn), arcname=fn)

def _first_zip_covering_polygon(sen2_dir, polygon):
    """Pick the first Sentinel ZIP whose B04 bounds intersect polygon bbox."""
    zips = [os.path.join(sen2_dir, f) for f in os.listdir(sen2_dir) if f.lower().endswith(".zip")]
    if not zips:
        raise FileNotFoundError("No Sentinel ZIPs found in data/sen2/")
    for zp in zips:
        try:
            rdr = SentinelProductReader(zp)
            # open native or 10m variant of B04 just to get bounds
            ds, _ = rdr._open_ref("B04", 10)
            with ds:
                left, bottom, right, top = ds.bounds
            if polygon.bounds:
                pxmin, pymin, pxmax, pymax = polygon.bounds
                # quick bbox test
                if not (right < pxmin or left > pxmax or top < pymin or bottom > pymax):
                    return zp
        except Exception:
            continue
    # fallback to first
    return zips[0]

def _percentile_stretch(arr, low=2, high=98):
    p_lo = np.nanpercentile(arr, low)
    p_hi = np.nanpercentile(arr, high)
    denom = max(1e-6, (p_hi - p_lo))
    x = (arr - p_lo) / denom
    return np.clip(x, 0.0, 1.0)

def get_rgb_image(sen2_dir, cache_dir, polygon):
    os.makedirs(cache_dir, exist_ok=True)
    zip_path = _first_zip_covering_polygon(sen2_dir, polygon)
    base_name = os.path.splitext(os.path.basename(zip_path))[0]
    cached_png = os.path.join(cache_dir, f"{base_name}.png")

    if not os.path.exists(cached_png):
        rdr = SentinelProductReader(zip_path)
        bands = ["B04", "B03", "B02"]
        stack, profile = rdr.stack_bands(bands, {b: 10 for b in bands}, align_to=10)
        # Convert reflectance (assumed scaled) to 0..1 and apply stretch per-band
        stack = stack.astype(np.float32) * 0.0001
        r = _percentile_stretch(stack[0]); g = _percentile_stretch(stack[1]); b = _percentile_stretch(stack[2])
        rgb8 = (np.stack([r, g, b], axis=-1) * 255.0 + 0.5).astype(np.uint8)
        # Save PNG with Pillow via rasterio (write RGB PNG)
        import PIL.Image as Image
        Image.fromarray(rgb8, mode="RGB").save(cached_png, format="PNG")
    return cached_png
