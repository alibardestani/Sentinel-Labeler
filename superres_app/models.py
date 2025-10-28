from __future__ import annotations

import os
from typing import Tuple, Any
from collections import OrderedDict
from PIL import Image, ImageFilter

from .config import Config
from .data import pil_to_tensor, tensor_to_pil

# -----------------------------------------------------------------------------
# 1. Detect runtime mode / availability
# -----------------------------------------------------------------------------

DISABLE_TORCH = os.getenv("DISABLE_TORCH", "0") == "1"

_torch_import_error = None
_super_image_import_error = None

if not DISABLE_TORCH:
    try:
        import torch
        import torch.nn.functional as F
    except Exception as e:
        _torch_import_error = e
        torch = None          # type: ignore
        F = None              # type: ignore

    try:
        from super_image import EdsrModel, EdsrConfig
    except Exception as e:
        _super_image_import_error = e
        EdsrModel = None      # type: ignore
        EdsrConfig = None     # type: ignore
else:
    # User explicitly disabled torch via env
    torch = None              # type: ignore
    F = None                  # type: ignore
    EdsrModel = None          # type: ignore
    EdsrConfig = None         # type: ignore


def _ml_stack_available() -> bool:
    """
    Returns True if we're allowed to run real SR inference:
    - DISABLE_TORCH is not set
    - torch imported ok
    - super_image imported ok
    """
    return (
        not DISABLE_TORCH
        and _torch_import_error is None
        and _super_image_import_error is None
        and torch is not None
        and F is not None
        and EdsrModel is not None
        and EdsrConfig is not None
    )


# -----------------------------------------------------------------------------
# 2. Mock model (always available)
# -----------------------------------------------------------------------------

class MockModel:
    """
    Lightweight fake SR model for dev / demo without GPU / checkpoints.
    Strategy:
      - take LR tensor (C,H,W) in [0,1] (PyTorch-style or mock tensor),
      - convert to PIL,
      - apply a sharpen filter,
      - convert back to "tensor-like".
    """

    def __call__(self, tensor_image: Any) -> Any:
        # tensor_to_pil() expects a torch.Tensor, but on machines without torch
        # we won't actually call the mock with a real tensor in production mode.
        # On UI-dev machines, processing.process_image_for_app() won't call the real
        # pipeline if torch is unavailable. So this mostly runs when torch exists but
        # env_mode='local-mock'.
        pil_image = tensor_to_pil(tensor_image)
        mock_sr_image = pil_image.filter(ImageFilter.SHARPEN)
        return pil_to_tensor(mock_sr_image)


# -----------------------------------------------------------------------------
# 3. Real model loader helpers (only used if ML stack available)
# -----------------------------------------------------------------------------

def _reconcile_state_dict(model, model_state_dict: dict) -> dict:
    """
    Handle DataParallel ('module.') prefix mismatch between checkpoint and model.
    """
    # Is the current model wrapped in DataParallel?
    is_model_parallel = hasattr(torch.nn, "DataParallel") and isinstance(
        model, torch.nn.DataParallel
    )

    # Does the checkpoint have 'module.' prefix?
    first_key = next(iter(model_state_dict))
    is_checkpoint_parallel = first_key.startswith("module.")

    final_state_dict = OrderedDict()

    if is_model_parallel and not is_checkpoint_parallel:
        # model expects 'module.*' keys but checkpoint doesn't have them
        print(
            "[superres_app] Model is parallel, checkpoint is not. "
            "Adding 'module.' prefix to keys..."
        )
        for k, v in model_state_dict.items():
            final_state_dict["module." + k] = v

    elif (not is_model_parallel) and is_checkpoint_parallel:
        # checkpoint has 'module.*' keys but our model is not parallel
        print(
            "[superres_app] Checkpoint is parallel, model is not. "
            "Stripping 'module.' prefix from keys..."
        )
        for k, v in model_state_dict.items():
            final_state_dict[k[7:]] = v

    else:
        # both match
        print("[superres_app] Model/ckpt parallel states match. Loading directly.")
        final_state_dict = model_state_dict

    return final_state_dict


def _instantiate_model_for_arch(model_arch: str):
    """
    Build an uninitialized EDSR model for the requested architecture.
    Uses super_image.EdsrModel / EdsrConfig.
    """
    if model_arch == "EDSR_16":
        model = EdsrModel.from_pretrained(
            "eugenesiow/edsr-base",
            scale=2,
            n_resblocks=16,
        )
    elif model_arch == "EDSR_8":
        cfg8 = EdsrConfig(
            scale=2,
            n_resblocks=8,
        )
        model = EdsrModel(cfg8)
    else:
        raise ValueError(f"Invalid model_arch '{model_arch}'.")
    return model


def _load_real_model_and_weights(
    config: Config,
    model_arch: str,
) -> Tuple["torch.nn.Module", "torch.device"]:
    """
    Instantiate the correct EDSR variant, load trained weights, move to device.
    """

    assert _ml_stack_available(), (
        "Tried to load real model, but torch/super_image stack isn't available."
    )

    print(f"[superres_app] Loading REAL model: {model_arch}")

    # Pick checkpoint path
    if model_arch == "EDSR_16":
        checkpoint_path = config.model_16_block_ckpt
    elif model_arch == "EDSR_8":
        checkpoint_path = config.model_8_block_ckpt
    else:
        raise ValueError(f"Invalid model_arch '{model_arch}'.")

    # fail early if paths are bad
    config.validate_for_inference(model_arch)

    # Instantiate a fresh model
    model = _instantiate_model_for_arch(model_arch)

    # pick device
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Multi-GPU? wrap in DataParallel for compatibility with parallel checkpoints
    if torch.cuda.is_available() and torch.cuda.device_count() > 1:
        print(
            f"[superres_app] Using {torch.cuda.device_count()} GPUs. "
            "Wrapping model in DataParallel."
        )
        model = torch.nn.DataParallel(model)

    model.to(device)

    # load checkpoint
    print(f"[superres_app] Loading checkpoint: {checkpoint_path}")
    checkpoint = torch.load(
        checkpoint_path,
        map_location=device,
        weights_only=True,
    )

    # reconcile state dict and load
    model_state_dict = checkpoint["model_state_dict"]
    final_state_dict = _reconcile_state_dict(model, model_state_dict)
    model.load_state_dict(final_state_dict)

    if "epoch" in checkpoint:
        print(f"[superres_app] Loaded checkpoint epoch {checkpoint['epoch']}.")

    model.eval()
    return model, device


# -----------------------------------------------------------------------------
# 4. Public API called by processing.process_image_for_app()
# -----------------------------------------------------------------------------

def load_super_resolution_model(
    config: Config,
    model_arch: str,
    env_mode: str,
) -> Tuple[Any, Any]:
    """
    Returns (model, device)
    - If DISABLE_TORCH=1 or torch isn't installed, force MockModel on 'cpu'.
    - If env_mode == "local-mock", also force MockModel.
    - Otherwise, load the real model/checkpoint.

    This lets the Flask app boot and render the SuperRes page even on a
    lightweight laptop with no torch installed.
    """

    # hard fallback: torch stack not available OR we explicitly disabled it
    if not _ml_stack_available():
        print("[superres_app] Torch/super_image not available -> using MOCK model.")
        return MockModel(), "cpu"

    # soft fallback: requested mock mode
    if env_mode == "local-mock":
        print("[superres_app] ENV_MODE=local-mock -> using MOCK model.")
        return MockModel(), "cpu"

    # real model path
    return _load_real_model_and_weights(config, model_arch)


def run_inference(
    model: Any,
    image_tensor: Any,
    device: Any,
) -> Any:
    """
    Run SR. Works in both mock and real modes.

    image_tensor is expected to be (C,H,W) float32 [0,1] if using real torch model.
    """

    # Mock path first (no torch required)
    if isinstance(model, MockModel):
        return model(image_tensor)

    # If we got here, we assume real torch model is available.
    # Safety check:
    if not _ml_stack_available():
        raise RuntimeError("Real inference requested but torch/super_image unavailable.")

    model.eval()
    with torch.no_grad():
        # (1,C,H,W) on device
        input_batch = image_tensor.unsqueeze(0).to(device)
        output_batch = model(input_batch)           # (1,C,H',W')
        output_tensor = output_batch.squeeze(0).cpu()  # back to CPU
    return output_tensor


def run_bicubic_interpolation(
    lr_tensor: Any,
    scale_factor: int = 2,
) -> Any:
    """
    Bicubic upsample baseline.
    In mock mode (no torch), we'll just return the same tensor back.
    In real mode, we use torch.nn.functional.interpolate.
    """

    # Mock mode, no torch available
    if not _ml_stack_available() or isinstance(lr_tensor, str):
        # Weird heuristic: in "no torch" mode, lr_tensor won't be a torch.Tensor.
        # We can't upscale it here. Just pretend bicubic == lr.
        # The UI will still render something.
        return lr_tensor

    # real torch path
    c, h, w = lr_tensor.shape
    up = (
        F.interpolate(
            lr_tensor.unsqueeze(0),
            size=(h * scale_factor, w * scale_factor),
            mode="bicubic",
            align_corners=False,
        )
        .squeeze(0)
        .cpu()
    )
    return up