# services/polygons_bootstrap.py
from __future__ import annotations
from pathlib import Path
import shutil
import subprocess

from config import settings

def _find_shp(dir_or_file: Path) -> Path | None:
    p = Path(dir_or_file)
    if p.is_file() and p.suffix.lower() == ".shp":
        return p
    if p.is_dir():
        shp = next(p.glob("*.shp"), None)
        return shp
    return None

def _build_with_ogr2ogr(shp: Path, out_geojson: Path) -> bool:
    exe = shutil.which("ogr2ogr") or shutil.which("ogr2ogr.exe")
    if not exe:
        return False
    cmd = [
        exe,
        "-t_srs", "EPSG:4326",
        "-f", "GeoJSON",
        str(out_geojson),
        str(shp),
    ]
    subprocess.run(cmd, check=True)
    return True

def _build_with_geopandas(shp: Path, out_geojson: Path):
    import geopandas as gpd
    gdf = gpd.read_file(shp)
    try:
        if gdf.crs and str(gdf.crs).upper() not in ("EPSG:4326", "WGS84"):
            gdf = gdf.to_crs("EPSG:4326")
    except Exception:
        # اگر CRS خراب/نامشخص بود، به همان حالت ذخیره می‌کنیم
        pass
    out_geojson.write_text(gdf.to_json(), encoding="utf-8")

def ensure_geojson_from_shapefile():
    """
    از Shapefile داخل settings.POLYGONS_SHP_DIR، GeoJSON می‌سازد (EPSG:4326).
    اگر ogr2ogr نبود، به صورت خودکار از geopandas استفاده می‌کند.
    """
    shp = _find_shp(settings.POLYGONS_SHP_DIR)
    out_geojson = settings.POLYGONS_GEOJSON
    out_geojson.parent.mkdir(parents=True, exist_ok=True)

    if not shp or not shp.exists():
        print(f"[polygons] No .shp found in {settings.POLYGONS_SHP_DIR}")
        return

    try:
        used_ogr = _build_with_ogr2ogr(shp, out_geojson)
        if not used_ogr:
            print("[polygons] ogr2ogr not found; falling back to GeoPandas…")
            _build_with_geopandas(shp, out_geojson)
        print(f"[polygons] GeoJSON ready: {out_geojson}")
    except FileNotFoundError as e:
        # حالت خیلی نادر: حتی اگر exe پیدا شد ولی اجرا نشد
        print(f"[polygons] ogr2ogr not runnable ({e}); falling back to GeoPandas…")
        _build_with_geopandas(shp, out_geojson)
        print(f"[polygons] GeoJSON ready: {out_geojson}")
    except Exception as e:
        # اگر geopandas هم نصب نبود یا مشکل خواندن فایل داشت
        raise RuntimeError(f"Failed to build polygons GeoJSON: {e}") from e

