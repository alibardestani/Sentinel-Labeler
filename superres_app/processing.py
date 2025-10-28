# /Volumes/Work/Sen2/V4/superres_app/processing.py

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Any, Optional, Union
from pathlib import Path

from .config import Config   # <- local import
from . import data, models   # <- local package imports

# Optional: PSNR / SSIM metrics
try:
    from super_image.utils.metrics import compute_metrics
    from super_image.trainer_utils import EvalPrediction
except ImportError:
    # We keep graceful fallback so dev can run without installing heavy deps
    print(
        "Warning: 'super_image' not found. PSNR/SSIM calculation will be unavailable."
    )

    def compute_metrics(*args, **kwargs):
        return {"psnr": 0.0, "ssim": 0.0}


@dataclass
class ProcessResult:
    """
    Output of a single super-resolution run.
    images:
        dict[str, PIL.Image or np.ndarray-like displayable thing]
        keys may include: 'lr', 'bicubic', 'sr', and maybe 'hr'
    metrics:
        dict[str, {psnr: float, ssim: float}] or None
    input_source_name:
        filename or label for UI
    """
    images: Dict[str, Any]
    metrics: Optional[Dict[str, Any]] = None
    input_source_name: str = "Image"


def process_image_for_app(
    config: Config,
    model_arch: str,
    lr_path: Union[str, Any, Path],
    hr_path: Optional[str] = None,
) -> ProcessResult:
    """
    High-level pipeline. This is what routes.py will call.

    Args:
        config:
            superres_app.config.Config object. Must include env_mode and paths
            (e.g. where to find weights, examples).
        model_arch:
            "EDSR_16", "EDSR_8", etc. Passed to models.load_super_resolution_model
        lr_path:
            can be:
              - Path (or str path) to a low-res chip on disk
              - file-like object from an upload (werkzeug FileStorage in Flask)
              - URL (http://...)
        hr_path:
            Optional path to ground-truth HR chip. If provided, we compute metrics.

    Returns:
        ProcessResult with:
            - images["lr"], images["bicubic"], images["sr"], and maybe images["hr"]
            - metrics["sr"], metrics["bicubic"] if hr available
    """

    # Figure out a nice display name for UI
    if hasattr(lr_path, "filename"):  # Flask FileStorage
        input_name = lr_path.filename
    elif hasattr(lr_path, "name"):
        # could be Path, or werkzeug FileStorage (.name sometimes exists),
        # or something with .name attr.
        input_name = Path(getattr(lr_path, "name")).name  # type: ignore
    else:
        input_name = Path(str(lr_path)).name

    print(
        f"[superres_app] Processing image '{input_name}' "
        f"with model '{model_arch}' in mode '{config.env_mode}'"
    )

    # 1. Load / normalize LR image
    lr_image_np = data.load_img_as_np(img_src=lr_path)
    lr_tensor = data.adapt_np_as_tensor(img_raw_np=lr_image_np, is_lr=True)

    # Optionally load HR for evaluation mode
    hr_tensor = None
    if hr_path:
        hr_image_np = data.load_img_as_np(img_src=hr_path)
        hr_tensor = data.adapt_np_as_tensor(img_raw_np=hr_image_np, is_lr=False)

    # 2. Load the selected SR model
    model, device = models.load_super_resolution_model(
        config=config,
        model_arch=model_arch,
        env_mode=config.env_mode,
    )

    # 3. Run inference
    sr_tensor = models.run_inference(model, lr_tensor, device)
    bicubic_tensor = models.run_bicubic_interpolation(lr_tensor)

    # 4. Compute metrics if we have GT (Evaluation Mode)
    result_metrics = None
    if hr_tensor is not None:
        hr_batch = hr_tensor.unsqueeze(0).to(device)
        # Assume uniform scale across spatial dims
        # (hr H / lr H == hr W / lr W)
        scale = hr_tensor.shape[1] // lr_tensor.shape[1]

        sr_metrics = compute_metrics(
            EvalPrediction(
                predictions=sr_tensor.unsqueeze(0).to(device),
                labels=hr_batch,  # type: ignore
            ),
            scale=scale,
        )
        bicubic_metrics = compute_metrics(
            EvalPrediction(
                predictions=bicubic_tensor.unsqueeze(0).to(device),
                labels=hr_batch,  # type: ignore
            ),
            scale=scale,
        )

        result_metrics = {
            "sr": sr_metrics,
            "bicubic": bicubic_metrics,
        }

    # 5. Convert tensors → displayable image arrays for front-end
    # data.visualize_tensor() returns a NumPy float array (H,W,3) in [0..1]
    # Our /superres/run route will convert those to base64 PNG.
    result_images = {
        "lr": data.visualize_tensor(lr_tensor),
        "sr": data.visualize_tensor(sr_tensor),
        "bicubic": data.visualize_tensor(bicubic_tensor),
    }
    if hr_tensor is not None:
        result_images["hr"] = data.visualize_tensor(hr_tensor)

    return ProcessResult(
        images=result_images,
        metrics=result_metrics,
        input_source_name=input_name,
    )