# services/model.py
from __future__ import annotations
from pathlib import Path
import json
import numpy as np
from PIL import Image
from config import settings
from services.progress import set_progress
from services.s2 import _jp2, _read_band_l2a  # از کد خودت استفاده می‌کنیم

# تلاش برای ONNX؛ اگر نصب نیست، بعداً پلن B: torch
try:
    import onnxruntime as ort
except Exception:
    ort = None

_session = None  # onnxruntime.InferenceSession | None

def _load_sidecar_if_any(model_path: Path):
    """اگر model.onnx.json کنار مدل باشد، متادیتا را بخوان و روی settings اعمال کن."""
    meta_path = model_path.with_suffix(model_path.suffix + ".json")
    if not meta_path.exists():
        return
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        # کلیدهای شناخته‌شده را override کن
        for k in ["MODEL_BANDS","MODEL_INPUT_SIZE","MODEL_OVERLAP",
                  "MODEL_NUM_CLASSES","MODEL_MEAN","MODEL_STD"]:
            if k in meta:
                setattr(settings, k, meta[k])
    except Exception as e:
        print("[WARN] sidecar meta load failed:", e)

def load_model(path: Path | None = None):
    """بارگذاری مدل ONNX (CPU/GPU)."""
    global _session
    model_path = Path(path or settings.ACTIVE_MODEL_PATH)
    if not model_path or not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    _load_sidecar_if_any(model_path)

    if settings.MODEL_TYPE.lower() == "onnx":
        if ort is None:
            raise RuntimeError("onnxruntime is not installed. Try: pip install onnxruntime (or onnxruntime-silicon on mac).")
        providers = ort.get_available_providers()
        # ترجیح CUDA اگر موجود است
        ordered = ["CUDAExecutionProvider","CPUExecutionProvider"] if "CUDAExecutionProvider" in providers else ["CPUExecutionProvider"]
        sess_opts = ort.SessionOptions()
        sess_opts.intra_op_num_threads = 0
        _session = ort.InferenceSession(str(model_path), sess_options=sess_opts, providers=ordered)
        return {"path": str(model_path), "providers": _session.get_providers()}
    else:
        # پلن B: PyTorch (اختیاری)
        raise NotImplementedError("Only ONNX is implemented in this file. Set MODEL_TYPE='onnx'.")

def model_info():
    if _session is None:
        return {"loaded": False}
    return {
        "loaded": True,
        "providers": _session.get_providers(),
        "input": [i.name for i in _session.get_inputs()],
        "output": [o.name for o in _session.get_outputs()],
        "bands": settings.MODEL_BANDS,
        "num_classes": settings.MODEL_NUM_CLASSES,
        "tile_size": settings.MODEL_INPUT_SIZE,
        "overlap": settings.MODEL_OVERLAP,
    }

def _read_scl_mask_if_enabled(HW):
    """اختیاری: اگر USE_SCL_MASK=True باشد، SCL را بخوان و ماسک بدها بساز (True=بد)."""
    if not getattr(settings, "USE_SCL_MASK", False):
        return None
    try:
        p_scl = _jp2("*_SCL_20m.jp2")  # 20m resolution
        import rasterio
        with rasterio.open(p_scl) as src:
            scl = src.read(1)
        # به 10m resample کن اگر backdrop/باندها 10m هستند
        # ساده: nearest با PIL
        H, W = HW
        scl_img = Image.fromarray(scl.astype(np.uint8), mode="L").resize((W, H), Image.NEAREST)
        scl = np.array(scl_img, dtype=np.uint8)
        bads = set(getattr(settings, "SCL_BAD_CLASSES", []))
        bad_mask = np.isin(scl, list(bads))
        return bad_mask  # True=بد
    except Exception as e:
        print("[WARN] SCL mask load failed:", e)
        return None

def _stack_required_bands() -> np.ndarray:
    """خواندن باندهای مورد نیاز مدل به صورت reflectance و استک (H,W,C) + نرمال‌سازی."""
    bands = []
    for bcode in settings.MODEL_BANDS:
        path = _jp2(f"*_{bcode}_10m.jp2")
        a = _read_band_l2a(path)   # float32 reflectance + NaN روی بدها
        bands.append(a)
    arr = np.stack(bands, axis=-1)              # (H,W,C)
    arr = np.nan_to_num(arr, nan=0.0)           # NaN→0
    mean = np.array(settings.MODEL_MEAN, dtype=np.float32).reshape(1,1,-1)
    std  = np.array(settings.MODEL_STD,  dtype=np.float32).reshape(1,1,-1)
    arr = (arr - mean) / (std + 1e-6)
    return arr.astype(np.float32)               # (H,W,C)

def _tile_slices(H, W, tile, overlap):
    """ژنراتور بازه‌های تایل با همپوشانی: (y0,y1,x0,x1)."""
    stride = tile - overlap
    y = 0
    while y < H:
        x = 0
        y1 = min(y + tile, H); y0 = max(0, y1 - tile)
        while x < W:
            x1 = min(x + tile, W); x0 = max(0, x1 - tile)
            yield (y0,y1,x0,x1)
            x += stride
        y += stride

def run_model_inference():
    """استنتاج مدل روی صحنه فعلی و ذخیره به mask.png + overlay."""
    if _session is None:
        load_model()

    set_progress("model_prepare", 2, "آماده‌سازی ورودی مدل")
    arr = _stack_required_bands()          # (H,W,C)
    H, W, C = arr.shape

    # اختیاری: ماسک SCL برای حذف ابر و سایه
    bad_mask = _read_scl_mask_if_enabled((H, W))  # True=بد

    tile  = int(settings.MODEL_INPUT_SIZE)
    ov    = int(settings.MODEL_OVERLAP)
    ncls  = int(settings.MODEL_NUM_CLASSES)

    logits_sum = np.zeros((ncls, H, W), dtype=np.float32)
    weight_sum = np.zeros((H, W), dtype=np.float32)

    tiles = list(_tile_slices(H, W, tile, ov))
    T = len(tiles)
    set_progress("model_tiling", 8, f"{T} تایل برای استنتاج")

    batch = int(getattr(settings, "MODEL_BATCH_TILES", 8))
    inp_name = _session.get_inputs()[0].name
    out_name = _session.get_outputs()[0].name

    done = 0
    for i in range(0, T, batch):
        chunk = tiles[i:i+batch]
        batch_imgs = []
        coords = []
        for (y0,y1,x0,x1) in chunk:
            tile_img = arr[y0:y1, x0:x1, :]          # (th,tw,C)
            th, tw, _ = tile_img.shape
            if th != tile or tw != tile:
                pad = np.zeros((tile, tile, C), dtype=np.float32)
                pad[:th, :tw, :] = tile_img
                tile_img = pad
            # CHW
            tile_img = np.transpose(tile_img, (2,0,1))  # (C,tile,tile)
            batch_imgs.append(tile_img)
            coords.append((y0,y1,x0,x1, th, tw))

        x = np.stack(batch_imgs, axis=0)  # (B,C,tile,tile)
        y = _session.run([out_name], {inp_name: x})[0]  # (B, ncls, tile, tile)

        for bi, (y0,y1,x0,x1, th, tw) in enumerate(coords):
            logit = y[bi, :, :th, :tw]     # (ncls, th, tw)
            logits_sum[:, y0:y1, x0:x1] += logit
            weight_sum[y0:y1, x0:x1]     += 1.0

        done += len(chunk)
        frac = done / T
        set_progress("model_infer", 8 + 75*frac, f"تایل‌ها: {done:,}/{T:,}")

    # softmax + argmax
    set_progress("model_post", 85, "پس‌پردازش خروجی")
    weight_sum = np.maximum(weight_sum, 1e-6)
    logits_mean = logits_sum / weight_sum  # (ncls,H,W)

    # اگر bad_mask داریم: logits کلاس «پس‌زمینه» را در این نواحی تقویت کن
    if bad_mask is not None and ncls >= 1:
        bg_cls = 0
        logits_mean[bg_cls][bad_mask] += 5.0  # هارد پنالتی روی ابر/سایه

    m = logits_mean - logits_mean.max(axis=0, keepdims=True)
    ex = np.exp(m)
    prob = ex / np.maximum(ex.sum(axis=0, keepdims=True), 1e-6)  # (ncls,H,W)
    pred = np.argmax(prob, axis=0).astype(np.uint8)              # (H,W)

    # resize به اندازه‌ی backdrop (در صورت نیاز)
    set_progress("model_save", 92, "ذخیره ماسک")
    if settings.BACKDROP_IMAGE.exists():
        Wb, Hb = Image.open(settings.BACKDROP_IMAGE).size
        if (W, H) != (Wb, Hb):
            pred = np.array(Image.fromarray(pred, mode='L').resize((Wb, Hb), Image.NEAREST))

    Image.fromarray(pred, mode='L').save(settings.MASK_PNG, optimize=False)

    # اوورلی
    try:
        from services.masks import write_mask_overlay
        write_mask_overlay(pred)
    except Exception as e:
        print("[WARN] overlay failed:", e)

    nz = int((pred>0).sum())
    set_progress("done", 100, f"پایان (پیکسل غیرصفر: {nz:,})")
    return True, "ok"