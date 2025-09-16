# services/polygons.py
from __future__ import annotations
import json
import shutil
import subprocess
from pathlib import Path
from typing import Optional
from datetime import datetime

from config import settings

def _latest_mtime(p: Path) -> float:
    """بالاترین زمان ویرایش بین فایل‌های shapefile را برمی‌گرداند."""
    exts = (".shp", ".shx", ".dbf", ".prj", ".cpg")
    mt = 0.0
    for ext in exts:
        f = next(p.glob(f"*{ext}"), None) if p.is_dir() else (p if p.suffix.lower()==ext else None)
        if f and f.exists():
            mt = max(mt, f.stat().st_mtime)
    return mt

def _find_shp(base: Path) -> Optional[Path]:
    if base.is_file() and base.suffix.lower() == ".shp":
        return base
    if base.is_dir():
        shp = next(base.glob("*.shp"), None)
        return shp
    return None

def _ensure_outdir():
    settings.POLYGONS_OUT_DIR.mkdir(parents=True, exist_ok=True)

def _ogr2ogr_available() -> bool:
    return shutil.which("ogr2ogr") is not None

def _build_with_ogr2ogr(shp: Path, out_geojson: Path):
    cmd = [
        "ogr2ogr",
        "-t_srs", "EPSG:4326",
        "-f", "GeoJSON",
        str(out_geojson),
        str(shp),
    ]
    subprocess.run(cmd, check=True)

def _build_with_geopandas(shp: Path, out_geojson: Path):
    import geopandas as gpd
    gdf = gpd.read_file(shp)
    # اگر CRS ندارد ولی فایل .prj کنار آن هست، gpd معمولاً تشخیص می‌دهد.
    # برای اطمینان اگر crs نبود، به همان شکل ادامه می‌دهیم.
    try:
        if gdf.crs and str(gdf.crs).upper() not in ("EPSG:4326", "WGS84"):
            gdf = gdf.to_crs("EPSG:4326")
    except Exception:
        # اگر crs نامعتبر بود، بدون تغییر ادامه بده (به امید اینکه همین الان WGS84 باشد)
        pass
    out_geojson.write_text(gdf.to_json(), encoding="utf-8")

def ensure_polygons_geojson() -> Optional[Path]:
    """
    اگر current.geojson وجود ندارد یا قدیمی‌تر از Shapefile است،
    آن را از Shapefile می‌سازد. مسیر GeoJSON را برمی‌گرداند، وگرنه None.
    """
    _ensure_outdir()
    shp = _find_shp(settings.POLYGONS_SHP_DIR)
    if not shp:
        return settings.POLYGONS_GEOJSON if settings.POLYGONS_GEOJSON.exists() else None

    shp_mtime = _latest_mtime(settings.POLYGONS_SHP_DIR)
    gj = settings.POLYGONS_GEOJSON

    needs_build = True
    if gj.exists():
        needs_build = (gj.stat().st_mtime < shp_mtime)

    if needs_build:
        if gj.exists():
            gj.unlink(missing_ok=True)
        if _ogr2ogr_available():
            _build_with_ogr2ogr(shp, gj)
        else:
            _build_with_geopandas(shp, gj)

    return gj if gj.exists() else None

def load_polygons_text() -> Optional[str]:
    """
    GeoJSON را به‌صورت متن برمی‌گرداند. اگر نبود، تلاش می‌کند بسازد.
    """
    gj = settings.POLYGONS_GEOJSON
    if not gj.exists():
        gj = ensure_polygons_geojson()
    if gj and gj.exists():
        return gj.read_text(encoding="utf-8")
    return None


