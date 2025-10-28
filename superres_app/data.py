# /Volumes/Work/Sen2/V4/superres_app/data.py

from __future__ import annotations

import io
from pathlib import Path
from typing import List, Any, Union

import numpy as np
from numpy.typing import NDArray
import requests
from PIL import Image

from . import DISABLE_TORCH
from .config import (
    Config,
    LR_MAX_PER_CHANNEL,
    HR_MAX_PER_CHANNEL,
)

# -----------------------------------------------------------------------------
# Optional torch / torchvision imports
# We don't want the whole app to die on a machine without torch,
# because we still want to test the Flask UI.
# -----------------------------------------------------------------------------

if not DISABLE_TORCH:
    try:
        import torch
        from torchvision.transforms import ToTensor, ToPILImage
        _TORCH_AVAILABLE = True
    except Exception as e:
        print(f"[superres_app] ⚠️ Torch import failed ({e}). Falling back to mock mode.")
        torch = None           # type: ignore
        ToTensor = None        # type: ignore
        ToPILImage = None      # type: ignore
        _TORCH_AVAILABLE = False
else:
    print("[superres_app] ⚠️ Torch disabled — running in lightweight UI mode.")
    torch = None               # type: ignore
    ToTensor = None            # type: ignore
    ToPILImage = None          # type: ignore
    _TORCH_AVAILABLE = False


def _require_torch(fn_name: str) -> None:
    """
    Helper: raise a nice error if torch-dependent code is called
    when torch is not available (e.g. on your Mac with DISABLE_TORCH=1).
    """
    if not _TORCH_AVAILABLE or torch is None:
        raise RuntimeError(
            f"{fn_name} requires PyTorch, but torch is not available on this system. "
            "This is expected in UI-only / mock mode. "
            "Run on a server with torch installed for real inference."
        )


# -----------------------------------------------------------------------------
# Image loading / adaptation
# -----------------------------------------------------------------------------

def load_adapt_image(image_path: Union[str, Path, io.BytesIO, Any]) -> np.ndarray:
    """
    Load an RGB image and convert it to the BGR uint16 format used by the
    original training pipeline.

    Steps:
    - read image (PIL)
    - convert to RGB
    - if uint8 [0..255], upscale to uint16 [0..65535]
    - reorder channels RGB -> BGR
    """

    # PIL can read both file-like objects and paths.
    if hasattr(image_path, "read") and not isinstance(image_path, (str, Path)):
        img_pil = Image.open(image_path).convert("RGB")
    else:
        img_pil = Image.open(image_path).convert("RGB")

    img_np_rgb = np.array(img_pil)

    # If image is 8-bit, rescale to a 16-bit-style dynamic range.
    if img_np_rgb.dtype == np.uint8:
        img_np_rgb = (img_np_rgb.astype(np.float32) / 255.0) * 65535.0

    # force uint16
    img_np_uint16_rgb = img_np_rgb.astype(np.uint16)

    # Swap RGB -> BGR
    img_np_uint16_bgr = img_np_uint16_rgb[..., ::-1].copy()

    return img_np_uint16_bgr


def load_img_as_np(img_src: Union[str, Path, io.BytesIO, Any]) -> np.ndarray:
    """
    General loader used by process_image_for_app().
    Handles:
      - URL (http/https)
      - local path / .npy files
      - uploaded file-like objects (Flask FileStorage)
    Returns:
      np.ndarray (H,W,C) in uint8 or uint16 RGB.
    """

    try:
        # Case 1: URL
        if isinstance(img_src, str) and img_src.startswith(("http://", "https://")):
            response = requests.get(img_src, stream=True)
            response.raise_for_status()
            img = Image.open(response.raw).convert("RGB")
            return np.array(img)

        # Case 2: Local path (string or Path)
        elif isinstance(img_src, (str, Path)):
            img_path = Path(img_src)
            if not img_path.exists() or not img_path.is_file():
                raise FileNotFoundError(f"Image file not found at: {img_path}")

            if img_path.suffix.lower() == ".npy":
                # assume already H,W,C style numeric array
                return np.load(img_path)

            img = Image.open(img_path).convert("RGB")
            return np.array(img)

        # Case 3: File-like upload (Flask's FileStorage etc.)
        elif hasattr(img_src, "read"):
            img = Image.open(img_src).convert("RGB")
            return np.array(img)

        else:
            raise TypeError("Unsupported image source type for load_img_as_np().")

    except Exception as e:
        raise IOError(f"Failed to load image from source: {e}")


def adapt_np_as_tensor(img_raw_np: np.ndarray, is_lr: bool):
    """
    Convert a raw numpy image -> normalized torch tensor (C,H,W) in [0,1].
    Supports uint16 Sentinel-style chips and normal uint8 RGB images.
    Handles LR and HR scaling using different per-channel max arrays.

    Returns:
      torch.Tensor (C,H,W) if torch is available.
    """
    _require_torch("adapt_np_as_tensor")

    orig_dtype = img_raw_np.dtype

    if orig_dtype == np.uint16:
        # Use provided per-channel max LUTs (for Sentinel-style data)
        LR_MAX_TENSOR = torch.tensor(LR_MAX_PER_CHANNEL, dtype=torch.float32).view(
            3, 1, 1
        )
        HR_MAX_TENSOR = torch.tensor(HR_MAX_PER_CHANNEL, dtype=torch.float32).view(
            3, 1, 1
        )
        max_vals = LR_MAX_TENSOR if is_lr else HR_MAX_TENSOR

        # to (C,H,W)
        tensor_bgr = torch.from_numpy(img_raw_np.astype(np.float32)).permute(2, 0, 1)
        normalized_tensor = tensor_bgr / max_vals

    elif orig_dtype == np.uint8:
        # RGB uint8 -> BGR float32 -> normalize /255.0
        if img_raw_np.ndim == 3 and img_raw_np.shape[2] == 3:
            raw_np_bgr = img_raw_np[..., ::-1].copy()
        else:
            raw_np_bgr = img_raw_np

        tensor_bgr = torch.from_numpy(raw_np_bgr.astype(np.float32)).permute(2, 0, 1)
        normalized_tensor = tensor_bgr / 255.0

    else:
        raise TypeError(f"Unsupported input image dtype: {orig_dtype}")

    return torch.clamp(normalized_tensor, 0.0, 1.0)


def load_image(image_source: Union[str, Any]) -> NDArray:
    """
    Legacy helper from Streamlit version.
    Loads a file/URL and returns a uint16 BGR array (H,W,C) based
    on load_adapt_image().
    Kept for compatibility in case you still call this somewhere.
    """
    if hasattr(image_source, "read"):
        try:
            return load_adapt_image(image_source)
        except Exception as e:
            raise IOError(f"Failed to read image from file-like object: {e}")

    elif str(image_source).startswith(("http://", "https://")):
        try:
            response = requests.get(str(image_source), stream=True)
            response.raise_for_status()
            return load_adapt_image(response.raw)  # type: ignore
        except requests.exceptions.RequestException as e:
            raise IOError(f"Failed to download image from URL: {e}")
    else:
        p = Path(str(image_source))
        if not (p.exists() and p.is_file()):
            raise FileNotFoundError(f"Image file not found at: {p}")
        if p.suffix.lower() == ".npy":
            return np.load(p)
        return load_adapt_image(p)


def get_example_image_paths(config: Config) -> List[Path]:
    """
    Return the list of available example LR chips (.npy) so we can list
    them in the dropdown for the Super Res page.
    """
    if not config.example_lr_dir.exists():
        return []
    return sorted(list(config.example_lr_dir.glob("*.npy")))


def pil_to_tensor(image: Image.Image):
    """
    Convert a PIL Image -> torch.FloatTensor (C,H,W) in [0,1].
    Only works if torch is available.
    """
    _require_torch("pil_to_tensor")

    # ToTensor() returns (C,H,W) float32 in [0,1]
    return ToTensor()(image)


def tensor_to_pil(tensor) -> Image.Image:
    """
    Convert a (C,H,W) or (1,C,H,W) tensor -> PIL Image.
    Only works if torch is available.
    """
    _require_torch("tensor_to_pil")

    # ToPILImage() expects (C,H,W) on CPU
    return ToPILImage()(tensor.squeeze(0).cpu())


def normalize_for_inference(raw_bgr_np: np.ndarray, is_lr: bool):
    """
    Old helper: given uint16 BGR array -> normalized torch tensor in [0,1].
    Not currently used in the Flask route, but we keep it around.
    """
    _require_torch("normalize_for_inference")

    tensor_bgr = torch.from_numpy(raw_bgr_np.astype(np.float32)).permute(2, 0, 1)

    LR_MAX_TENSOR = torch.tensor(LR_MAX_PER_CHANNEL, dtype=torch.float32).view(3, 1, 1)
    HR_MAX_TENSOR = torch.tensor(HR_MAX_PER_CHANNEL, dtype=torch.float32).view(3, 1, 1)
    max_vals = LR_MAX_TENSOR if is_lr else HR_MAX_TENSOR

    normalized_tensor = tensor_bgr / max_vals
    return torch.clamp(normalized_tensor, 0.0, 1.0)


def visualize_tensor(tensor) -> np.ndarray:
    """
    Convert a (C,H,W) torch tensor in [0,1] to an HxWx3 float array in [0,1],
    with simple contrast stretching.

    This output is safe to turn into PNGs for the browser.

    NOTE:
    This is only meaningful if we actually ran torch inference.
    In pure mock/no-torch mode, processing.process_image_for_app()
    won't call this with a real tensor; it'll construct placeholder images
    instead.
    """
    _require_torch("visualize_tensor")

    img = tensor.cpu().detach().numpy()  # (C,H,W)

    # percentile stretch per-channel
    vmin = np.percentile(img, 2, axis=(1, 2), keepdims=True)
    vmax = np.percentile(img, 98, axis=(1, 2), keepdims=True)

    img = np.clip(img, vmin, vmax)
    img = (img - vmin) / (vmax - vmin + 1e-6)

    # reorder to (H,W,C)
    img = np.transpose(img, (1, 2, 0))

    # clip safety
    return np.clip(img, 0, 1)