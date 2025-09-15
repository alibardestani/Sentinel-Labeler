from __future__ import annotations
import os

from pathlib import Path
from typing import Tuple, Optional, List, Dict
import json
import numpy as np
from PIL import Image
import rasterio
from rasterio.warp import transform_bounds
from rasterio.crs import CRS
from typing import List, Dict, Optional, Tuple, Callable
from services.progress import reset as progress_reset, set_progress

import time
from config import settings

# اگر این‌ها را نداری، از همین فایل‌ات استفاده کن:
from dataclasses import dataclass, asdict
import zipfile
import re

@dataclass
class SceneItem:
    id: str
    name: str
    kind: str     # "zip" | "SAFE"
    path: str
    tile: Optional[str]
    date: Optional[str]
    size_mb: float

def _scene_id_for_path(p: Path) -> str:
    import hashlib
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
                size_mb = round(p.stat().st_size / (1024*1024), 1) if p.is_file() else 0.0
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

def _persist_selected_scene(scene: SceneItem) -> None:
    settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    settings.SELECTED_SCENE_FILE.write_text(json.dumps(asdict(scene), ensure_ascii=False))

def _load_selected_scene() -> Optional[SceneItem]:
    if not settings.SELECTED_SCENE_FILE.exists():
        return None
    try:
        j = json.loads(settings.SELECTED_SCENE_FILE.read_text())
        return SceneItem(**j)
    except Exception:
        return None

def current_selected_scene() -> Optional[SceneItem]:
    return _load_selected_scene()

def _meters_to_deg_at_lat(dx_m: float, dy_m: float, lat_deg: float) -> Tuple[float, float]:
    lat_m = 111320.0
    lon_m = lat_m * np.cos(np.deg2rad(lat_deg))
    dlon = dx_m / max(1e-6, lon_m)
    dlat = dy_m / lat_m
    return dlon, dlat

def _apply_align_offset(bounds4326: Tuple[float,float,float,float]) -> Dict[str,float]:
    dx_m = dy_m = 0.0
    if settings.ALIGN_OFFSET_FILE.exists():
        try:
            j = json.loads(settings.ALIGN_OFFSET_FILE.read_text())
            dx_m = float(j.get("dx_m", 0.0))
            dy_m = float(j.get("dy_m", 0.0))
        except Exception:
            pass
    l, b, r, t = bounds4326
    lat_mid = (t + b) / 2.0
    dlon, dlat = _meters_to_deg_at_lat(dx_m, dy_m, lat_mid)
    return {
        "lon_min": l + dlon,
        "lat_min": b + dlat,
        "lon_max": r + dlon,
        "lat_max": t + dlat,
    }

def _zip_find_r10m_b04(zip_path: Path) -> Optional[str]:
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        # ترجیح B04 در R10m؛ اگر نبود، TCI_10m هم قابل استفاده است
        prefs = [
            re.compile(r".*/IMG_DATA/R10m/.*_B04_10m\.jp2$", re.I),
            re.compile(r".*/IMG_DATA/R10m/.*_TCI_10m\.jp2$", re.I),
        ]
        for rx in prefs:
            for n in names:
                if rx.search(n):
                    return n
    return None

def _bounds_from_any_r10m(scene_path: Path) -> Optional[Tuple[float,float,float,float]]:
    try:
        if scene_path.suffix.lower() == ".zip":
            inner = _zip_find_r10m_b04(scene_path)
            if not inner:
                return None
            vsipath = f"zip://{scene_path}!{inner}"
            with rasterio.open(vsipath) as src:
                src_crs = src.crs
                if src_crs is None:
                    return None
                l, b, r, t = src.bounds
                if src_crs.to_epsg() != 4326:
                    l, b, r, t = transform_bounds(src_crs, CRS.from_epsg(4326), l, b, r, t, densify_pts=21)
                return (l, b, r, t)
        else:
            cand = list(scene_path.glob("GRANULE/*/IMG_DATA/R10m/*_B04_10m.jp2")) or \
                   list(scene_path.glob("GRANULE/*/IMG_DATA/R10m/*_TCI_10m.jp2"))
            if not cand:
                return None
            with rasterio.open(cand[0]) as src:
                src_crs = src.crs
                if src_crs is None:
                    return None
                l, b, r, t = src.bounds
                if src_crs.to_epsg() != 4326:
                    l, b, r, t = transform_bounds(src_crs, CRS.from_epsg(4326), l, b, r, t, densify_pts=21)
                return (l, b, r, t)
    except Exception:
        return None

def s2_bounds_wgs84_from_tif(tif_path: Path) -> Dict[str, float]:
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

    lat_mid = (t + b) / 2.0
    dlon, dlat = _meters_to_deg_at_lat(dx_m, dy_m, lat_mid)
    return {
        "lon_min": l + dlon,
        "lat_min": b + dlat,
        "lon_max": r + dlon,
        "lat_max": t + dlat,
    }
    
    

def _linear_stretch01(arr: np.ndarray) -> np.ndarray:
    arr = arr.astype(np.float32)
    amin = float(np.nanmin(arr))
    amax = float(np.nanmax(arr))
    if not np.isfinite(amin) or not np.isfinite(amax) or (amax - amin) < 1e-6:
        return np.zeros_like(arr, dtype=np.float32)
    return (arr - amin) / (amax - amin)




def save_quicklook_png_from_tif(tif_path: Path, max_dim: int = 4096) -> Path:
    out_png = settings.BACKDROP_IMAGE
    out_dir = out_png.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    with rasterio.open(tif_path) as src:
        r, g, b = src.read(1), src.read(2), src.read(3)

    r8 = (_linear_stretch01(r) * 255).round().astype(np.uint8)
    g8 = (_linear_stretch01(g) * 255).round().astype(np.uint8)
    b8 = (_linear_stretch01(b) * 255).round().astype(np.uint8)

    im = Image.fromarray(np.dstack([r8, g8, b8]))
    W, H = im.size
    if max(W, H) > max_dim:
        s = max_dim / float(max(W, H))
        im = im.resize((int(W * s), int(H * s)), Image.BILINEAR)

    tmp_png = out_dir / (out_png.stem + ".tmp.png")
    im.save(str(tmp_png), format="PNG")

    # تا ۵ بار، با تأخیر ۰.۲ ثانیه، چک کنیم فایل موقت ساخته شده
    for _ in range(5):
        if tmp_png.exists() and tmp_png.stat().st_size > 0:
            break
        time.sleep(0.2)

    if not tmp_png.exists():
        raise RuntimeError(f"quicklook temp not written: {tmp_png}")

    os.replace(str(tmp_png), str(out_png))
    return out_png

def build_rgb_esri_aligned_tif_from_zip(zip_path: Path) -> Path:
    from Library.S2reader import SentinelProductReader
    rdr = SentinelProductReader(str(zip_path))
    out_tif = settings.S2_RGB_TIF
    out_tif.parent.mkdir(parents=True, exist_ok=True)
    rdr.export_esri_aligned_rgb_tif(str(out_tif), resolution=10)
    return out_tif

def select_scene_by_id(scene_id: str) -> dict:
    item = get_scene_by_id(scene_id)
    if not item:
        raise RuntimeError("Scene not found")

    progress_reset()
    set_progress("selecting", 3, "Selecting scene")

    p = Path(item.path)
    if item.kind == "zip":
        set_progress("build_rgb", 15, "Building aligned RGB GeoTIFF")
        tif_path = build_rgb_esri_aligned_tif_from_zip(p)
    else:
        set_progress("prepare_safe", 15, "Preparing SAFE")
        settings.set_r10m_dir(p)
        tif_path = settings.S2_RGB_TIF

    set_progress("quicklook", 55, "Saving quicklook")
    png_path = save_quicklook_png_from_tif(tif_path, max_dim=4096)

    set_progress("bounds", 75, "Computing bounds")
    bounds = s2_bounds_wgs84_from_tif(tif_path)

    W, H = Image.open(png_path).size
    Image.fromarray(np.zeros((H, W), np.uint8), "L").save(settings.MASK_PNG, optimize=False)

    _persist_selected_scene(item)
    set_progress("done", 100, "Ready")

    return {
        "scene": asdict(item),
        "backdrop_size": [W, H],
        "bounds_wgs84": bounds,
        "rgb_tif": str(tif_path),
        "quicklook_png": str(png_path),
    }
    
    
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


# -----------------------------------------------------------------------------
# Backdrop ensure (optional; handy if something expects BACKDROP_IMAGE to exist)
# -----------------------------------------------------------------------------
def ensure_backdrop() -> None:
    """اگر BACKDROP_IMAGE موجود نباشد، در صورت وجود JP2، TIF و Quicklook را می‌سازد؛
    در غیر این صورت یک تصویر سادهٔ خاکستری ایجاد می‌کند."""
    if settings.BACKDROP_IMAGE.exists():
        return
    try:
        if settings.S2_JP2_DIR and settings.S2_JP2_DIR.exists():
            _build_rgb_geotiff()
            _save_quicklook_from_tif()
    except Exception as e:
        print('[WARN] Quicklook build failed:', e)
    if not settings.BACKDROP_IMAGE.exists():
        Image.new('RGB', (2048, 2048), (30, 30, 30)).save(settings.BACKDROP_IMAGE)
        
        

def backdrop_meta() -> tuple[int, int]:
    p = settings.BACKDROP_IMAGE
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (2048, 2048), (30, 30, 30)).save(p)
    with Image.open(p) as im:
        w, h = im.size
    return int(w), int(h)


def _selected_scene_file() -> Path:
    try:
        p = getattr(settings, "SELECTED_SCENE_FILE")
        if p is not None:
            return Path(p)
    except Exception:
        pass
    # fallback امن
    out = Path(getattr(settings, "OUTPUT_DIR"))
    out.mkdir(parents=True, exist_ok=True)
    return out / "selected_scene.json"


def _persist_selected_scene(scene: "SceneItem") -> None:
    f = _selected_scene_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(asdict(scene), ensure_ascii=False, indent=2), encoding="utf-8")

def _load_selected_scene() -> Optional["SceneItem"]:
    f = _selected_scene_file()
    if not f.exists():
        return None
    try:
        j = json.loads(f.read_text(encoding="utf-8"))
        return SceneItem(**j)
    except Exception:
        return None