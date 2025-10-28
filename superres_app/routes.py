# /Volumes/Work/Sen2/V4/superres_app/routes.py

from __future__ import annotations

import io
import base64
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from flask import (
    Blueprint,
    render_template,
    request,
    jsonify,
    session,
    redirect,
    url_for,
)

from . import config, data, processing


superres_bp = Blueprint(
    "superres",
    __name__,
    url_prefix="/superres",
    template_folder="templates",
    static_folder="static",
    static_url_path="/superres-static",
)


def require_login():
    """
    Reuse the same session logic as the rest of your app.

    Your main app sets session['user_id'] on login (I saw that in your context_processor).
    Your auth blueprint is registered as 'auth_bp' in app.py, and login route is auth_bp.login.
    """
    if "user_id" not in session:
        return redirect(url_for("auth_bp.login"))
    return None


def _img_to_base64(img_any: Any) -> str:
    """
    Convert an image-like object to a base64 data URL.

    Supports:
    - NumPy array HxWxC float in [0..1]
    - PIL.Image.Image

    Returns:
        "data:image/png;base64,AAAA..."
    """
    if isinstance(img_any, np.ndarray):
        # Expect float [0..1], shape (H, W, 3)
        arr = np.clip(img_any * 255.0, 0, 255).astype(np.uint8)
        pil_img = Image.fromarray(arr)
    elif isinstance(img_any, Image.Image):
        pil_img = img_any
    else:
        raise TypeError(
            f"Unsupported image type for base64 encoding: {type(img_any)}"
        )

    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")


@superres_bp.route("/", methods=["GET"])
def index():
    """
    Render the Super Resolution page (the UI form + empty result area).
    - We build the dropdown of example LR chips.
    - We pass model options.
    """
    needs_login = require_login()
    if needs_login:
        return needs_login

    # We default to "local-mock" env_mode. You can later expose a toggle in the UI.
    try:
        app_conf = config.create_config(env_mode="local-mock")
    except Exception:
        app_conf = None

    example_items = []
    if app_conf:
        # Get the available .npy LR chips from assets/examples_npy/lr
        example_paths = data.get_example_image_paths(app_conf)
        for p in example_paths:
            example_items.append(
                {
                    "name": p.name,   # visible label
                    "path": str(p),   # absolute/relative path we'll post back
                }
            )

    # Model choices. Matches Streamlit UI intent.
    model_options = [
        {"label": "EDSR 16-Block (High Quality)", "value": "EDSR_16"},
        {"label": "EDSR 8-Block (Fast)",          "value": "EDSR_8"},
    ]

    return render_template(
        "superres/index.html",
        example_items=example_items,
        model_options=model_options,
    )


@superres_bp.route("/run", methods=["POST"])
def run_superres():
    """
    Handle the form submission via fetch() from superres.js.

    Accepts:
    - upload_file    (user-provided LR chip, optional)
    - example_path   (path from dropdown, optional)
    - model_arch     (EDSR_16 or EDSR_8)

    Behavior:
    - If upload_file exists, we run inference on that.
    - Otherwise we fall back to example_path.
    - We try to infer the matching HR chip for metrics:
        replace '/lr/' with '/hr/'
        replace 'lr' with 'hr' in the filename
      If we find it, we compute PSNR/SSIM (Evaluation Mode).
      If not, we just run inference (Inference Mode).
    """
    needs_login = require_login()
    if needs_login:
        return needs_login

    # Build config for this run
    app_conf = config.create_config(env_mode="local-mock")

    model_arch = request.form.get("model_arch", "EDSR_16")
    example_path = request.form.get("example_path", "").strip()

    uploaded_file = request.files.get("upload_file")

    # Decide the LR source and (maybe) HR source
    if uploaded_file and uploaded_file.filename:
        # User uploaded an LR image
        input_lr_path = uploaded_file
        input_hr_path = None  # no ground truth for user uploads
    else:
        # Use one of the built-in example LR chips
        if not example_path:
            return jsonify({"error": "No input provided"}), 400

        lr_path = Path(example_path)

        # Guess corresponding HR chip path (same logic from your Streamlit app)
        guessed_hr = Path(str(lr_path).replace("/lr/", "/hr/"))
        guessed_hr = Path(str(guessed_hr).replace("lr", "hr"))

        input_lr_path = lr_path
        input_hr_path = guessed_hr if guessed_hr.exists() else None

    # Actually run inference + (maybe) evaluation metrics
    try:
        result = processing.process_image_for_app(
            config=app_conf,
            model_arch=model_arch,
            lr_path=input_lr_path,
            hr_path=str(input_hr_path) if input_hr_path else None,
        )
    except Exception as e:
        # Surface model / IO / device errors to the UI
        return jsonify({"error": f"processing failed: {e}"}), 500

    # Build response payload for frontend JS:
    # - input_source_name (filename label)
    # - metrics (PSNR/SSIM dict or null)
    # - images: base64 data URLs for bicubic / sr / lr / hr
    out = {
        "input_source_name": result.input_source_name,
        "metrics": result.metrics,
        "images": {},
    }

    for key, img in result.images.items():
        out["images"][key] = _img_to_base64(img)

    return jsonify(out)