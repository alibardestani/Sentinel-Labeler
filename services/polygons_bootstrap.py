# services/polygons_bootstrap.py
from __future__ import annotations

from pathlib import Path
import json
import shutil
import subprocess
from typing import Iterable, Optional

# --- Optional settings (falls back to sensible defaults) ---
try:
    from config import settings  # expects: POLYGONS_SHP_DIR, POLYGONS_GEOJSON
    _SHP_DIR_DEFAULT = Path(getattr(settings, "POLYGONS_SHP_DIR", "data/polygons/shp"))
    _GJ_OUT_DEFAULT = Path(getattr(settings, "POLYGONS_GEOJSON", "output/polygons/current.geojson"))
except Exception:
    _SHP_DIR_DEFAULT = Path("data/polygons/shp")
    _GJ_OUT_DEFAULT = Path("output/polygons/current.geojson")

# -------------- internal helpers --------------

def _find_first_shp(dir_or_file: Path) -> Optional[Path]:
    """
    If given a directory, returns first *.shp inside it.
    If given a file, returns it if it endswith .shp.
    """
    p = dir_or_file
    if p.is_file() and p.suffix.lower() == ".shp":
        return p
    if p.is_dir():
        for shp in sorted(p.glob("*.shp")):
            return shp
    return None

def _newest_mtime_in(paths: Iterable[Path]) -> float:
    mt = 0.0
    for p in paths:
        try:
            mt = max(mt, p.stat().st_mtime)
        except FileNotFoundError:
            pass
    return mt

def _ogr2ogr_exe() -> Optional[str]:
    return shutil.which("ogr2ogr") or shutil.which("ogr2ogr.exe")

def _build_with_ogr2ogr(shp: Path, out_geojson: Path) -> None:
    exe = _ogr2ogr_exe()
    if not exe:
        raise FileNotFoundError("ogr2ogr not found on PATH")

    out_geojson.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        exe,
        "-t_srs", "EPSG:4326",   # reproject to WGS84
        "-f", "GeoJSON",
        str(out_geojson),
        str(shp),
    ]
    print(f"[polygons] Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    print(f"[polygons] GeoJSON built by ogr2ogr: {out_geojson}")

def _build_with_geopandas(shp: Path, out_geojson: Path) -> None:
    try:
        import geopandas as gpd
    except Exception as e:
        raise RuntimeError(
            "geopandas not installed. Install with: pip install geopandas shapely pyproj fiona"
        ) from e

    gdf = gpd.read_file(shp)

    # Normalize CRS → EPSG:4326
    try:
        if not gdf.crs:
            # try to infer later; if not, set WGS84 (last resort)
            gdf = gdf.set_crs(epsg=4326, allow_override=True)
        elif str(gdf.crs).upper() not in ("EPSG:4326", "WGS84"):
            gdf = gdf.to_crs(epsg=4326)
    except Exception:
        # tolerate odd/invalid CRS and try to force set
        gdf = gdf.set_crs(epsg=4326, allow_override=True)

    # Ensure uid column
    uid_col = None
    for cand in ("uid", "UID", "id", "ID"):
        if cand in gdf.columns:
            uid_col = cand
            break
    if uid_col != "uid":
        # Create/rename to 'uid'
        if uid_col:
            gdf["uid"] = gdf[uid_col].astype(str)
        else:
            gdf["uid"] = [f"poly_{i+1}" for i in range(len(gdf))]

    # De-duplicate uids if needed
    seen = set()
    fixed = []
    for i, u in enumerate(gdf["uid"].astype(str).tolist(), start=1):
        base = u or f"poly_{i}"
        uu = base
        k = 1
        while uu in seen:
            k += 1
            uu = f"{base}_{k}"
        seen.add(uu)
        fixed.append(uu)
    gdf["uid"] = fixed

    # Keep only whitelisted props (extend as you need)
    keep_cols = ["uid", gdf.geometry.name]
    gdf = gdf[keep_cols]

    out_geojson.parent.mkdir(parents=True, exist_ok=True)
    # Using driver for correctness; avoid .to_json() → write_text for large files
    gdf.to_file(out_geojson, driver="GeoJSON")
    print(f"[polygons] GeoJSON built by GeoPandas: {out_geojson}")

# -------------- public API --------------

def ensure_geojson_from_shapefile(
    dir_or_file: Path | str | None = None,
    out_geojson: Path | str | None = None
) -> Optional[Path]:
    """
    Makes sure GeoJSON exists (and up-to-date) from a Shapefile.

    Priority of inputs:
      - Use provided `dir_or_file` and `out_geojson` if given.
      - Else use values from config.settings (if present).
      - Else fallback to defaults:
            SHP: data/polygons/shp
            GJ : output/polygons/current.geojson

    Strategy:
      1) If out_geojson exists and is newer than newest .shp → reuse.
      2) Else try building with ogr2ogr.
      3) If ogr2ogr not available/fails → build with GeoPandas.

    Returns: Path to GeoJSON on success, or None if no shapefile found.
    Raises: RuntimeError if building fails via both backends.
    """
    shp_root = Path(dir_or_file) if dir_or_file else _SHP_DIR_DEFAULT
    gj_out   = Path(out_geojson) if out_geojson else _GJ_OUT_DEFAULT

    shp = _find_first_shp(shp_root)
    gj_out.parent.mkdir(parents=True, exist_ok=True)

    if not shp or not shp.exists():
        print(f"[polygons] No .shp found in {shp_root}")
        return None

    # Rebuild only if needed
    newest_src_mtime = _newest_mtime_in(list(shp_root.glob("*.shp")) + list(shp_root.glob("*.dbf")) +
                                        list(shp_root.glob("*.shx")) + list(shp_root.glob("*.prj")))
    if gj_out.exists() and gj_out.stat().st_mtime >= newest_src_mtime:
        print(f"[polygons] GeoJSON ready: {gj_out}")
        return gj_out

    # Build (ogr2ogr → fallback to geopandas)
    try:
        _build_with_ogr2ogr(shp, gj_out)
        print(f"[polygons] GeoJSON ready: {gj_out}")
        return gj_out
    except Exception as e_ogr:
        print(f"[polygons] ogr2ogr failed ({e_ogr}); falling back to GeoPandas…")
        try:
            _build_with_geopandas(shp, gj_out)
            print(f"[polygons] GeoJSON ready: {gj_out}")
            return gj_out
        except Exception as e_gpd:
            raise RuntimeError(f"Failed to build polygons GeoJSON via both backends: {e_gpd}") from e_gpd

def load_geojson_dict(out_geojson: Path | str | None = None) -> Optional[dict]:
    """
    Reads the GeoJSON file into a Python dict for API responses.
    Returns None if file does not exist.
    """
    gj_out = Path(out_geojson) if out_geojson else _GJ_OUT_DEFAULT
    if not gj_out.exists():
        return None
    with open(gj_out, "r", encoding="utf-8") as f:
        return json.load(f)