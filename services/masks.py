from __future__ import annotations
import numpy as np
from PIL import Image
from config import settings


def load_mask(w: int, h: int) -> np.ndarray:
    """Load mask.png (uint8), resize to (w,h) with NEAREST; return array (h,w)."""
    if settings.MASK_PNG.exists():
        m = Image.open(settings.MASK_PNG).convert('L')
        if m.size != (w, h):
            m = m.resize((w, h), Image.NEAREST)
        return np.array(m, dtype=np.uint8)
    return np.zeros((h, w), dtype=np.uint8)


def mask_bytes(w:int, h:int) -> bytes:
    """Return raw bytes (h*w) of the resized mask."""
    return load_mask(w, h).tobytes()


def save_mask_bytes(raw: bytes, w:int, h:int):
    """Save raw bytes (h*w) to mask.png as L (uint8)."""
    if not raw:
        return False, 'no data'
    arr = np.frombuffer(raw, dtype=np.uint8)
    if arr.size != w*h:
        return False, f'size mismatch: got {arr.size}, expected {w*h}'
    mask = arr.reshape((h, w))
    Image.fromarray(mask, mode='L').save(settings.MASK_PNG, optimize=False)
    Image.fromarray((mask>0).astype(np.uint8)*255, mode='L')\
     .save(settings.OUTPUT_DIR / 'mask_vis_debug.png', optimize=False)
    return True, 'ok'


def write_mask_overlay(mask: np.ndarray):
    """Create colored RGBA preview: 0=transparent, 1=green, 2=brown."""
    h, w = mask.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    g = (mask == 1)
    rgba[g, 1] = 255; rgba[g, 3] = 170
    b = (mask == 2)
    rgba[b, 0] = 139; rgba[b, 1] = 69; rgba[b, 2] = 19; rgba[b, 3] = 170
    Image.fromarray(rgba, mode='RGBA').save(settings.OUTPUT_DIR / "mask_overlay.png")