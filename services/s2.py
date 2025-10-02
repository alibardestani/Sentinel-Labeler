# /Volumes/Work/Sen2/V4/services/s2.py
from __future__ import annotations

import json
import os
import re
import time
import zipfile
import hashlib
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Tuple, Optional, List, Dict

import numpy as np
from PIL import Image
import rasterio
from rasterio.warp import transform_bounds
from rasterio.crs import CRS

from config import settings
from services.progress import reset as progress_reset, set_progress
from Library.S2reader import SentinelProductReader  # ← use the shared reader

# ---------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------

def tiles_root() -> Path:
    return settings.OUTPUT_DIR / "temp_tiles"

# ---------------------------------------------------------------------
# Scene discovery
# ---------------------------------------------------------------------

@dataclass
class SceneItem:
    id: str
    name: str
    kind: str         # 'zip' or 'SAFE'
    path: str
    tile: Optional[str]
    date: Optional[str]
    size_mb: float

def _scene_id_for_path(p: Path) -> str:
    return hashlib.sha1(str(p.resolve()).encode("utf-8")).hexdigest()[:12]

def _guess_tile_and_date_from_name(name: str) -> tuple[Optional[str], Optional[str]]:
    m_tile = re.search(r'_T([0-9A-Z]{5})', name)
    m_date = re.search(r'_(20[0-9]{6})T', name)
    tile = ('T' + m_tile.group(1)) if m_tile else None
    date = None
    if m_date:
        yyyymmdd = m_date.group(1)
        date = f"{yyyymmdd[0:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}"
    return tile, date

def list_s2_scenes() -> List[SceneItem]:
    out: List[SceneItem] = []
    root = settings.SCENES_DIR
    root.mkdir(parents=True, exist_ok=True)
    for p in sorted(root.iterdir()):
        if p.name.startswith('.'):
            continue
        if p.suffix.lower() == '.zip' or (p.is_dir() and p.name.endswith('.SAFE')):
            kind = 'zip' if p.suffix.lower() == '.zip' else 'SAFE'
            try:
                size_mb = round(p.stat().st_size / (1024 * 1024), 1) if p.is_file() else 0.0
            except Exception:
                size_mb = 0.0
            tile, date = _guess_tile_and_date_from_name(p.name)
            out.append(SceneItem(
                id=_scene_id_for_path(p),
                name=p.name,
                kind=kind,
                path=str(p.resolve()),
                tile=tile,
                date=date,
                size_mb=size_mb
            ))
    return out

def get_scene_by_id(scene_id: str) -> Optional[SceneItem]:
    for it in list_s2_scenes():
        if it.id == scene_id:
            return it
    return None

# ---------------------------------------------------------------------
# Selected scene persistence
# ---------------------------------------------------------------------

def _selected_scene_file() -> Path:
    try:
        p = getattr(settings, "SELECTED_SCENE_FILE")
        if p is not None:
            return Path(p)
    except Exception:
        pass
    out = Path(getattr(settings, "OUTPUT_DIR"))
    out.mkdir(parents=True, exist_ok=True)
    return out / "selected_scene.json"

def _persist_selected_scene(scene: SceneItem) -> None:
    f = _selected_scene_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(asdict(scene), ensure_ascii=False, indent=2), encoding="utf-8")

def _load_selected_scene() -> Optional[SceneItem]:
    f = _selected_scene_file()
    if not f.exists():
        return None
    try:
        j = json.loads(f.read_text(encoding="utf-8"))
        return SceneItem(**j)
    except Exception:
        return None

# ---------------------------------------------------------------------
# Bounds & quicklook helpers
# ---------------------------------------------------------------------

def s2_bounds_wgs84_from_tif(tif_path: Path) -> Dict[str, float]:
    """Compute WGS84 bounds from the GeoTIFF, applying optional alignment offsets."""
    dx_m = dy_m = 0.0
    if settings.ALIGN_OFFSET_FILE.exists():
        try:
            j = json.loads(settings.ALIGN_OFFSET_FILE.read_text())
            dx_m = float(j.get("dx_m", 0.0))
            dy_m = float(j.get("dy_m", 0.0))
        except Exception:
            pass

    with rasterio.open(tif_path) as src:
        if src.crs is None:
            raise ValueError("TIFF has no CRS")
        l, b, r, t = src.bounds
        if src.crs.to_epsg() != 4326:
            l, b, r, t = transform_bounds(src.crs, CRS.from_epsg(4326), l, b, r, t, densify_pts=21)

    lat_m = 111320.0
    lon_m = lat_m * np.cos(np.deg2rad((t + b) / 2.0))
    dlon = dx_m / max(1e-6, lon_m)
    dlat = dy_m / lat_m
    return {"lon_min": l + dlon, "lat_min": b + dlat, "lon_max": r + dlon, "lat_max": t + dlat}

def _linear_stretch01(arr: np.ndarray) -> np.ndarray:
    arr = arr.astype(np.float32)
    amin = float(np.nanmin(arr))
    amax = float(np.nanmax(arr))
    if not np.isfinite(amin) or not np.isfinite(amax) or (amax - amin) < 1e-6:
        return np.zeros_like(arr, dtype=np.float32)
    return (arr - amin) / (amax - amin)

def save_quicklook_png_from_tif_native(tif_path: Path) -> Path:
    """Save an 8-bit PNG quicklook from the first 3 bands of the (RGB) GeoTIFF at native size."""
    out_png = settings.BACKDROP_IMAGE
    out_png.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(tif_path) as src:
        r = src.read(1)
        g = src.read(2)
        b = src.read(3)
    r8 = (_linear_stretch01(r) * 255).round().astype(np.uint8)
    g8 = (_linear_stretch01(g) * 255).round().astype(np.uint8)
    b8 = (_linear_stretch01(b) * 255).round().astype(np.uint8)
    im = Image.fromarray(np.dstack([r8, g8, b8]), mode="RGB")
    tmp_png = out_png.with_suffix(".tmp.png")
    im.save(str(tmp_png), format="PNG")
    # ensure written
    for _ in range(5):
        if tmp_png.exists() and tmp_png.stat().st_size > 0:
            break
        time.sleep(0.2)
    os.replace(str(tmp_png), str(out_png))
    return out_png

# ---------------------------------------------------------------------
# Tile slicing (for front-end grid overlay)
# ---------------------------------------------------------------------

def slice_png_to_grid(png_path: Path, scene_id: str, rows: int = 3, cols: int = 3) -> dict:
    out_dir = tiles_root() / scene_id
    out_dir.mkdir(parents=True, exist_ok=True)
    im = Image.open(png_path).convert("RGBA")
    W, H = im.size
    w = W // cols
    h = H // rows
    tiles = []
    for r in range(rows):
        for c in range(cols):
            x0 = c * w
            y0 = r * h
            x1 = W if c == cols - 1 else (c + 1) * w
            y1 = H if r == rows - 1 else (r + 1) * h
            crop = im.crop((x0, y0, x1, y1))
            name = f"tile_{r}_{c}.png"
            crop.save(out_dir / name, optimize=False)
            tiles.append({
                "r": r, "c": c, "w": x1 - x0, "h": y1 - y0,
                "name": name, "path": str((out_dir / name).resolve())
            })
    return {"W": W, "H": H, "rows": rows, "cols": cols, "tiles": tiles, "dir": str(out_dir.resolve())}

def get_tile_path(scene_id: str, r: int, c: int) -> Path:
    p = tiles_root() / scene_id / f"tile_{r}_{c}.png"
    if not p.exists():
        raise FileNotFoundError(str(p))
    return p

# ---------------------------------------------------------------------
# Scene selection workflow (ZIP → ESRI-aligned RGB GeoTIFF → quicklook + tiles)
# ---------------------------------------------------------------------

def select_scene_by_id(scene_id: str) -> dict:
    item = get_scene_by_id(scene_id)
    if not item:
        raise RuntimeError("Scene not found")

    progress_reset()
    set_progress("selecting", 5, "Selecting scene")

    p = Path(item.path)

    if item.kind == "zip":
        # Build ESRI-aligned RGB GeoTIFF using the shared reader
        set_progress("build_rgb", 25, "Building aligned RGB GeoTIFF")
        out_tif = settings.S2_RGB_TIF
        out_tif.parent.mkdir(parents=True, exist_ok=True)
        rdr = SentinelProductReader(str(p))
        # You can switch to export_esri_aligned_rgba_tif if you want alpha edges later.
        rdr.export_esri_aligned_rgb_tif(str(out_tif), resolution=10)
        tif_path = out_tif
    else:
        # SAFE directory preparation is application-specific (handled by settings hooks)
        set_progress("prepare_safe", 25, "Preparing SAFE")
        settings.set_r10m_dir(p)          # ensures settings.S2_RGB_TIF points to a valid RGB
        tif_path = settings.S2_RGB_TIF

    set_progress("quicklook", 55, "Saving native quicklook")
    png_path = save_quicklook_png_from_tif_native(tif_path)

    set_progress("grid", 70, "Slicing 3×3 tiles")
    grid_meta = slice_png_to_grid(png_path, scene_id=item.id, rows=3, cols=3)

    set_progress("bounds", 85, "Computing bounds")
    bounds = s2_bounds_wgs84_from_tif(tif_path)

    W, H = Image.open(png_path).size
    _persist_selected_scene(item)

    set_progress("done", 100, "Ready")

    return {
        "scene": asdict(item),
        "backdrop_size": [W, H],
        "bounds_wgs84": bounds,
        "quicklook_png": str(png_path),
        "grid": grid_meta
    }

# ---------------------------------------------------------------------
# Public helpers used by API
# ---------------------------------------------------------------------

def s2_bounds_wgs84() -> Optional[dict]:
    try:
        b = s2_bounds_wgs84_from_tif(settings.S2_RGB_TIF)
        l, btm, r, t = b["lon_min"], b["lat_min"], b["lon_max"], b["lat_max"]
        return {
            "lon_min": float(l), "lat_min": float(btm),
            "lon_max": float(r), "lat_max": float(t),
            "lon_ctr": float((l + r) / 2.0),
            "lat_ctr": float((btm + t) / 2.0),
        }
    except Exception:
        return None

def ensure_backdrop() -> None:
    p = settings.BACKDROP_IMAGE
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        return
    try:
        tif = Path(settings.S2_RGB_TIF)
        if tif.exists():
            save_quicklook_png_from_tif_native(tif)  # builds native-size quicklook (no downscale)
            if p.exists():
                return
    except Exception:
        pass
    Image.new("RGB", (2048, 2048), (30, 30, 30)).save(p)

def backdrop_meta() -> tuple[int, int]:
    p = settings.BACKDROP_IMAGE
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        ensure_backdrop()
    with Image.open(p) as im:
        w, h = im.size
    return int(w), int(h)

def current_selected_scene() -> Optional[SceneItem]:
    return _load_selected_scene()