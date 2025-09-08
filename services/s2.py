# services/s2.py
from __future__ import annotations
from pathlib import Path
from typing import Tuple, Optional, Callable

import numpy as np
from PIL import Image
import rasterio
from pyproj import Transformer
import rasterio as rio
from rasterio.warp import transform_bounds

from config import settings
from services.progress import reset as progress_reset, set_progress
from Library.S2reader import SentinelProductReader


from pathlib import Path
import zipfile, shutil, tempfile

def _ensure_safe_root(pathlike) -> Path:
    p = Path(pathlike)
    if p.suffix.lower() == ".zip":
        extract_dir = settings.SCENES_DIR / "scene"
        if extract_dir.exists():
            shutil.rmtree(extract_dir)
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(p, "r") as zf:
            zf.extractall(extract_dir)
        safes = list(extract_dir.glob("*.SAFE"))
        if not safes:
            raise RuntimeError("SAFE folder not found after unzip")
        return safes[0]
    if p.is_dir() and p.name.endswith(".SAFE"):
        return p
    raise RuntimeError("Input must be a .SAFE directory or a .zip file")

def _find_r10m_dir(safe_root: Path) -> Path:
    safe_root = Path(safe_root)
    granule_dir = safe_root / "GRANULE"
    candidates = list(granule_dir.glob("*/IMG_DATA/R10m"))
    if not candidates:
        raise FileNotFoundError("R10m not found under SAFE/GRANULE/*/IMG_DATA/R10m")
    return candidates[0]

def _find_band(jp2_dir: Path, suffix: str) -> Path:
    for p in sorted(jp2_dir.glob(f"*_{suffix}_10m.jp2")):
        name = p.name
        if name.startswith("._"):
            continue
        try:
            if not p.is_file():
                continue
            if p.stat().st_size < 1024:  
                continue
        except Exception:
            continue
        return p
    raise FileNotFoundError(f"{suffix} not found in {jp2_dir} (filtered ._ and tiny files)")

def _infer_tilecode(r10m: Path) -> str:
    anyjp2 = next((p for p in r10m.glob("*_10m.jp2")), None)
    if not anyjp2:
        raise RuntimeError("No *_10m.jp2 found in R10m")
    parts = anyjp2.name.split("_")
    return "_".join(parts[0:2]) 

def _band_path(r10m: Path, tilecode: str, band: str) -> Path:
    cand = list(r10m.glob(f"{tilecode}_{band}_10m.jp2"))
    if not cand:
        cand = list(r10m.glob(f"*_{band}_10m.jp2"))
    if not cand:
        raise FileNotFoundError(f"{band}_10m.jp2 not found")
    return cand[0]

def _build_rgb_geotiff():
    r10m = Path(settings.S2_JP2_DIR)
    tilecode = _infer_tilecode(r10m)
    pR = _band_path(r10m, tilecode, "B04")
    pG = _band_path(r10m, tilecode, "B03")
    pB = _band_path(r10m, tilecode, "B02")

    with rio.open(pR) as srcR, rio.open(pG) as srcG, rio.open(pB) as srcB:
        profile = srcR.profile.copy()  
        profile.update(
            count=3,
            compress="deflate",
            predictor=2,
            tiled=True,
            blockxsize=min(1024, srcR.width),
            blockysize=min(1024, srcR.height),
        )
        r = srcR.read(1)
        g = srcG.read(1)
        b = srcB.read(1)
        for arr in (r, g, b):  
            np.clip(arr, 0, 10000, out=arr)

        settings.S2_RGB_TIF.parent.mkdir(parents=True, exist_ok=True)
        with rio.open(settings.S2_RGB_TIF, "w", **profile) as dst:
            dst.write(r, 1)
            dst.write(g, 2)
            dst.write(b, 3)


def _linear_stretch(a: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(a, (2, 98))
    if hi <= lo:
        lo, hi = float(a.min()), float(max(a.max(), 1))
    a = np.clip((a - lo) / (hi - lo + 1e-9), 0, 1)
    return (a * 255).astype(np.uint8)


def _save_quicklook_from_tif(max_dim: int = 4096) -> None:
    with rasterio.open(settings.S2_RGB_TIF) as src:
        r, g, b = src.read(1), src.read(2), src.read(3)

    r8 = _linear_stretch(r)
    g8 = _linear_stretch(g)
    b8 = _linear_stretch(b)

    img = np.dstack([r8, g8, b8]).astype(np.uint8)

    im = Image.fromarray(img, mode="RGB")
    W, H = im.size

    if max(W, H) > max_dim:
        scale = max_dim / float(max(W, H))
        new_size = (int(W * scale), int(H * scale))
        im = im.resize(new_size, Image.Resampling.BILINEAR)

    settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = settings.BACKDROP_IMAGE.with_suffix(".tmp.png")
    im.save(tmp)
    tmp.replace(settings.BACKDROP_IMAGE)


def ensure_backdrop() -> None:
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


def backdrop_meta() -> Tuple[int, int]:
    im = Image.open(settings.BACKDROP_IMAGE).convert('RGB')
    return im.size  # (w, h)


def s2_bounds_wgs84() -> Optional[dict]:
    if not settings.S2_RGB_TIF.exists():
        return None
    with rasterio.open(settings.S2_RGB_TIF) as src:
        bounds = src.bounds
        crs = src.crs
    t = Transformer.from_crs(crs, 4326, always_xy=True)
    lon_min, lat_min = t.transform(bounds.left, bounds.bottom)
    lon_max, lat_max = t.transform(bounds.right, bounds.top)
    return {
        'lon_min': float(lon_min), 'lat_min': float(lat_min),
        'lon_max': float(lon_max), 'lat_max': float(lat_max),
        'lon_ctr': float((lon_min + lon_max) / 2.0),
        'lat_ctr': float((lat_min + lat_max) / 2.0),
    }


def set_s2_scene_dir_and_rebuild(safe_root_or_zip):
    
    progress_reset()
    set_progress("scene_detect", 3, "یافتن مسیر R10m")

    safe_root = _ensure_safe_root(safe_root_or_zip)      # ← این خط مشکل str/Path را حل می‌کند
    r10m = _find_r10m_dir(safe_root)
    settings.S2_JP2_DIR = Path(r10m)

    set_progress("build_rgb", 12, "ساخت GeoTIFF RGB")
    _build_rgb_geotiff()           # مطمئن شو از settings.S2_JP2_DIR استفاده می‌کند و CRS/transform را کپی می‌کند

    set_progress("quicklook", 22, "ساخت Quicklook")
    _save_quicklook_from_tif()

    set_progress("reset_mask", 26, "ریست ماسک به ابعاد بک‌دراپ")
    W, H = Image.open(settings.BACKDROP_IMAGE).size
    Image.fromarray(np.zeros((H, W), np.uint8), 'L').save(settings.MASK_PNG, optimize=False)

    set_progress("bounds", 30, "محاسبه‌ی مرزها")
    meta = {
        "scene_root": str(safe_root),
        "jp2_r10m": str(r10m),
        "backdrop_size": (W, H),
        "bounds_wgs84": s2_bounds_wgs84(),
    }
    set_progress("done", 100, "صحنه تنظیم شد")
    return meta

# ---------------------------------------------------------------------------
# NDVI helpers (L2A: offset/scale) + KMeans tools
# ---------------------------------------------------------------------------

def _read_band_l2a(path: Path) -> np.ndarray:
    """
    تبدیل DN → بازتاب (تقریب BOA): (DN + BOA_ADD_OFFSET)/BOA_QUANT
    و ماسک کردن NoData/Saturated
    """
    with rasterio.open(path) as src:
        dn = src.read(1).astype(np.float32)
        nod = src.nodata
    bad0, bad1 = settings.BAD_DN_VALUES
    bad = (dn == bad0) | (dn == bad1)
    if nod is not None:
        bad |= (dn == float(nod))
    refl = (dn + settings.BOA_ADD_OFFSET) / settings.BOA_QUANT
    refl[bad] = np.nan
    return np.clip(refl, -0.2, 1.2)


def _jp2(glob_pat: str) -> Path:
    for p in settings.S2_JP2_DIR.glob(glob_pat):
        return p
    raise FileNotFoundError(f"JP2 not found: {glob_pat} in {settings.S2_JP2_DIR}")


def _compute_ndvi() -> Tuple[np.ndarray, int, int]:
    """
    محاسبه‌ی NDVI از باندهای 10m (B04,B08) با درنظر گرفتن offset/scale.
    """
    if not settings.S2_JP2_DIR or not settings.S2_JP2_DIR.exists():
        raise RuntimeError("S2_JP2_DIR is not set or doesn't exist.")
    p_red = _jp2("*_B04_10m.jp2")
    p_nir = _jp2("*_B08_10m.jp2")
    red = _read_band_l2a(p_red)
    nir = _read_band_l2a(p_nir)
    if red.shape != nir.shape:
        raise RuntimeError(f"Shape mismatch: {red.shape} vs {nir.shape}")
    den = nir + red
    ndvi = (nir - red) / np.where(den == 0, np.nan, den)
    ndvi = np.clip(ndvi, -1.0, 1.0).astype(np.float32)
    h, w = ndvi.shape
    return ndvi, w, h


def _kmeans_mask_from_rgb(
    arr_rgb: np.ndarray,
    n_clusters: int = 2,
    fit_max_side: int = 2048,
    batch_size: int = 16384,
    max_iter: int = 100,
    random_state: int = 0,
    predict_chunk_px: int = 10_000_000,
    ndvi_for_label: np.ndarray | None = None,
    progress_cb: Optional[Callable] = None,
    progress_range: tuple[float, float] = (10.0, 85.0)
) -> np.ndarray:
    """
    MiniBatchKMeans روی RGB با:
      - fit روی نسخه‌ی کوچک‌شده
      - predict قطعه‌ای روی کل تصویر
      - انتخاب خوشه‌ی گیاهی با NDVI (اختیاری) یا روشنایی مرکز
    """
    try:
        from sklearn.cluster import MiniBatchKMeans
    except ImportError:
        if progress_cb:
            try:
                progress_cb("kmeans_error", 100.0, "Scikit-learn نصب نیست")
            except TypeError:
                progress_cb("kmeans_error", 100.0)
        raise

    H, W = arr_rgb.shape[:2]
    p0, p1 = map(float, progress_range)
    if p1 < p0:
        p0, p1 = p1, p0

    def _emit(phase: str, frac: float, detail: str = ""):
        frac = max(0.0, min(1.0, float(frac)))
        pct = p0 + (p1 - p0) * frac
        if progress_cb:
            try:
                progress_cb(phase, pct, detail)
            except TypeError:
                progress_cb(phase, pct)

    # 1) Fit
    _emit("kmeans_prepare", 0.00, "آماده‌سازی داده برای fit")
    img = Image.fromarray(arr_rgb.astype(np.uint8), mode='RGB')
    if max(H, W) > fit_max_side:
        scale = fit_max_side / float(max(H, W))
        fit_size = (int(W * scale), int(H * scale))
        img_fit = img.resize(fit_size, Image.BILINEAR)
    else:
        img_fit = img

    X_fit = np.asarray(img_fit, dtype=np.float32).reshape(-1, 3) / 255.0
    _emit("kmeans_fit", 0.10, f"تعداد نمونه fit: {X_fit.shape[0]:,}")

    km = MiniBatchKMeans(
        n_clusters=n_clusters,
        batch_size=batch_size,
        n_init='auto',
        max_iter=max_iter,
        random_state=random_state,
        verbose=0,
    )
    km.fit(X_fit)
    _emit("kmeans_fit", 0.30, "fit تمام شد")

    # 2) Predict روی کل تصویر (chunked)
    X_full = arr_rgb.reshape(-1, 3).astype(np.float32) / 255.0
    y_full = np.empty(X_full.shape[0], dtype=np.int32)
    N = X_full.shape[0]
    _emit("kmeans_predict", 0.35, f"شروع predict روی {N:,} پیکسل")

    start = 0
    while start < N:
        end = min(N, start + predict_chunk_px)
        y_full[start:end] = km.predict(X_full[start:end])
        start = end
        frac = start / N
        sub = 0.35 + 0.50 * frac
        _emit("kmeans_predict", sub, f"پیش‌بینی: {start:,}/{N:,}")

    y_full = y_full.reshape(H, W)
    _emit("kmeans_predict", 0.85, "predict تمام شد")

    # 3) تعیین خوشه‌ی گیاهی
    if ndvi_for_label is not None:
        _emit("kmeans_label", 0.90, "برچسب‌گذاری خوشه‌ها با NDVI")
        rng = np.random.default_rng(0)
        take = min(H * W // 100, 200_000)
        idx = rng.choice(H * W, size=take, replace=False)
        cl = y_full.reshape(-1)[idx]
        nv = ndvi_for_label.reshape(-1)[idx]
        means = []
        for k in range(n_clusters):
            sel = (cl == k)
            m = float(np.nanmean(nv[sel])) if np.any(sel) else -1e9
            means.append(m)
        veg_cluster = int(np.argmax(means))
    else:
        _emit("kmeans_label", 0.90, "برچسب‌گذاری با روشنایی مرکز خوشه")
        centers = km.cluster_centers_
        brightness = centers.mean(axis=1)
        veg_cluster = int(np.argmin(brightness))  # فرض: تیره‌تر=گیاهی

    mask = (y_full == veg_cluster).astype(np.uint8)
    _emit("kmeans_done", 1.00, "KMeans به پایان رسید")
    return mask


# ---------------------------------------------------------------------------
# main entry: prelabel
# ---------------------------------------------------------------------------

def prelabel(method: str, **kwargs):
    """
    روش‌ها:
      - kmeans_rgb: خوشه‌بندی روی Quicklook RGB
      - otsu_gray: اوتسو روی Gray از Quicklook
      - ndvi_otsu: اوتسو روی NDVI
      - ndvi_thresh: آستانه ثابت روی NDVI (ndvi_threshold=...)
    خروجی: (ok:bool, msg:str)
    """
    progress_reset()
    set_progress("starting", 2, "شروع پردازش")
    ensure_backdrop()

    # --- Quicklook-based ---
    if method in ('kmeans_rgb', 'otsu_gray'):
        set_progress("load_quicklook", 5, "لود تصویر بک‌دراپ")
        img = Image.open(settings.BACKDROP_IMAGE).convert('RGB')
        arr = np.array(img, dtype=np.uint8)

        if method == 'kmeans_rgb':
            set_progress("kmeans_fit", 10, "آماده‌سازی KMeans (MiniBatch)")

            ndvi_for_label = None  # اگر بخواهی: ndvi_for_label, _ , _ = _compute_ndvi()

            mask = _kmeans_mask_from_rgb(
                arr_rgb=arr,
                n_clusters=2,
                fit_max_side=2048,
                batch_size=16384,
                max_iter=100,
                random_state=0,
                predict_chunk_px=10_000_000,
                ndvi_for_label=ndvi_for_label,
                progress_cb=lambda phase, p, detail=None: set_progress(phase, p, detail),
            )

        else:  # otsu_gray
            set_progress("otsu_hist", 20, "محاسبه‌ی هیستوگرام سطح خاکستری")
            gray = (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]).astype(np.uint8)

            hist, _ = np.histogram(gray, bins=256, range=(0, 255))
            total = int(hist.sum()); sumB = 0.0; wB = 0.0
            maximum = 0.0; sum1 = float(np.dot(np.arange(256), hist))
            threshold = 0
            for t in range(256):
                wB += hist[t]
                if wB == 0:
                    continue
                wF = total - wB
                if wF == 0:
                    break
                sumB += t * hist[t]
                mB = sumB / wB
                mF = (sum1 - sumB) / wF
                between = wB * wF * (mB - mF) ** 2
                if between >= maximum:
                    threshold = t; maximum = between
                if t % 16 == 0:
                    frac = t / 255.0
                    set_progress("otsu_threshold", 20 + frac * 20)

            mask = (gray <= threshold).astype(np.uint8)

        set_progress("save_mask", 85, "ذخیره ماسک و اوورلی")
        Image.fromarray(mask, mode='L').save(settings.MASK_PNG, optimize=False)
        from services.masks import write_mask_overlay
        try:
            write_mask_overlay(mask)
        except Exception as e:
            print("[WARN] write_mask_overlay failed:", e)

        set_progress("done", 100, "پایان")
        return True, 'ok'

    # --- NDVI-based ---
    elif method in ('ndvi_otsu', 'ndvi_thresh'):
        try:
            set_progress("read_bands", 8, "خواندن باندها (L2A)")
            ndvi, w_ndvi, h_ndvi = _compute_ndvi()
            set_progress("ndvi_computed", 35, "محاسبه NDVI")
        except Exception as e:
            set_progress("error", 100, f"NDVI failed: {e}")
            return False, f'NDVI failed: {e}'

        ndvi_vis = np.nan_to_num(ndvi, nan=-1.0, posinf=1.0, neginf=-1.0)
        ndvi_u8 = ((ndvi_vis + 1.0) * 127.5).astype(np.uint8)
        Image.fromarray(ndvi_u8, mode='L').save(settings.OUTPUT_DIR / "ndvi_preview.png")

        if method == 'ndvi_otsu':
            set_progress("otsu_on_ndvi", 45, "آستانه‌گذاری اوتسو روی NDVI")
            hist, _ = np.histogram(ndvi_u8, bins=256, range=(0, 255))
            total = int(hist.sum()); sumB = 0.0; wB = 0.0
            maximum = 0.0; sum1 = float(np.dot(np.arange(256), hist))
            threshold_idx = 0
            for t in range(256):
                wB += hist[t]
                if wB == 0:
                    continue
                wF = total - wB
                if wF == 0:
                    break
                sumB += t * hist[t]
                mB = sumB / wB
                mF = (sum1 - sumB) / wF
                between = wB * wF * (mB - mF) ** 2
                if between >= maximum:
                    threshold_idx = t; maximum = between
                if t % 16 == 0:
                    set_progress("otsu_on_ndvi", 45 + (t / 255.0) * 10)
            thr = (threshold_idx / 255.0) * 2.0 - 1.0
        else:
            thr = float(kwargs.get('ndvi_threshold', getattr(settings, 'NDVI_DEFAULT_THRESHOLD', 0.2)))
            set_progress("thresholding", 55, f"آستانه ثابت NDVI={thr:.2f}")

        mask = (ndvi >= thr).astype(np.uint8)
        set_progress("mask_ready", 65, "ماسک ساخته شد")

        Image.fromarray((mask * 255).astype(np.uint8), mode='L').save(settings.OUTPUT_DIR / "mask_vis_debug.png")

        if settings.BACKDROP_IMAGE.exists():
            W, H = Image.open(settings.BACKDROP_IMAGE).size
            if (w_ndvi, h_ndvi) != (W, H):
                set_progress("resize", 75, "هم‌اندازه‌سازی با بک‌دراپ")
                mask = np.array(Image.fromarray(mask, mode='L').resize((W, H), Image.NEAREST))

        set_progress("save", 85, "ذخیره mask.png و overlay")
        Image.fromarray(mask, mode='L').save(settings.MASK_PNG, optimize=False)
        from services.masks import write_mask_overlay
        try:
            write_mask_overlay(mask)
        except Exception as e:
            print("[WARN] write_mask_overlay failed:", e)

        set_progress("done", 100, "پایان")
        return True, 'ok'

    else:
        set_progress("error", 100, "روش نامعتبر")
        return False, 'unknown method'
    
def _linear_stretch01(x: np.ndarray, low=2, high=98) -> np.ndarray:
    lo = np.nanpercentile(x, low)
    hi = np.nanpercentile(x, high)
    den = max(1e-6, (hi - lo))
    y = (x - lo) / den
    return np.clip(y, 0.0, 1.0)

def build_rgb_esri_aligned_tif_from_zip(zip_path: Path) -> Path:
    rdr = SentinelProductReader(str(zip_path))
    out_tif = settings.S2_RGB_TIF

    rdr.export_esri_aligned_rgb_tif(str(out_tif), resolution=10)
    return out_tif

def save_quicklook_png_from_tif(tif_path: Path, max_dim: int = 4096) -> Path:
    with rasterio.open(tif_path) as src:
        r, g, b = src.read(1), src.read(2), src.read(3)
    if r.dtype != np.uint8:
        r8 = (_linear_stretch01(r) * 255).round().astype(np.uint8)
        g8 = (_linear_stretch01(g) * 255).round().astype(np.uint8)
        b8 = (_linear_stretch01(b) * 255).round().astype(np.uint8)
    else:
        r8, g8, b8 = r, g, b

    img = np.dstack([r8, g8, b8])
    im = Image.fromarray(img)
    W, H = im.size
    if max(W, H) > max_dim:
        s = max_dim / float(max(W, H))
        im = im.resize((int(W*s), int(H*s)), Image.BILINEAR)

    out_png = settings.BACKDROP_IMAGE
    tmp = out_png.with_suffix(".tmp.png")
    out_png.parent.mkdir(parents=True, exist_ok=True)
    im.save(tmp)
    tmp.replace(out_png)
    return out_png

def _meters_to_deg_at_lat(dx_m: float, dy_m: float, lat_deg: float) -> Tuple[float, float]:
    lat_m = 111320.0
    lon_m = lat_m * np.cos(np.deg2rad(lat_deg))
    dlon = dx_m / max(1e-6, lon_m)
    dlat = dy_m / lat_m
    return dlon, dlat


def s2_bounds_wgs84_from_tif(tif_path: Path) -> Dict[str, float]:
    dx_m = dy_m = 0.0
    if settings.ALIGN_OFFSET_FILE.exists():
        import json
        try:
            j = json.loads(settings.ALIGN_OFFSET_FILE.read_text())
            dx_m = float(j.get("dx_m", 0.0))
            dy_m = float(j.get("dy_m", 0.0))
        except Exception:
            pass

    with rasterio.open(tif_path) as src:
        if src.crs is None:
            raise ValueError("TIFF has no CRS")
        if src.crs.to_epsg() != 4326:
            # ایمن: تبدیل به 4326
            l, b, r, t = transform_bounds(src.crs, CRS.from_epsg(4326), *src.bounds, densify_pts=21)
        else:
            l, b, r, t = src.bounds

    lat_mid = (t + b) / 2.0
    dlon, dlat = _meters_to_deg_at_lat(dx_m, dy_m, lat_mid)
    return {
        "lon_min": l + dlon,
        "lat_min": b + dlat,
        "lon_max": r + dlon,
        "lat_max": t + dlat,
    }