# /Volumes/Work/Sen2/V4/superres_app/config.py

from __future__ import annotations

import os
import sys
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional
from dotenv import load_dotenv

# ------------------
# Modes we support
# ------------------
EnvModeType = Literal["colab", "colab-vm", "remote", "local", "local-mock"]

# Per-channel max values used to normalize LR / HR Sentinel chips
LR_MAX_PER_CHANNEL = [8683.0, 9235.0, 11554.0]
HR_MAX_PER_CHANNEL = [11557.0, 11554.0, 12518.0]


@dataclass(frozen=True)
class Config:
    """
    Runtime configuration for super-resolution inference.

    env_mode:
        "local-mock"  -> dev / CPU / maybe fake weights
        "local"       -> real local inference (CPU or GPU)
        "remote"      -> prod server / GPU box
        "colab*"      -> colab notebook style

    model_16_block_ckpt_override / model_8_block_ckpt_override:
        If provided (via .env), these take priority over the defaults.
    """

    env_mode: EnvModeType
    model_16_block_ckpt_override: Optional[Path] = field(default=None)
    model_8_block_ckpt_override: Optional[Path] = field(default=None)

    # Derived fields (set in __post_init__, not passed in)
    project_root: Path = field(init=False)
    assets_dir: Path = field(init=False)
    example_lr_dir: Path = field(init=False)
    example_hr_dir: Path = field(init=False)

    # We'll still define these to keep compatibility with your old code,
    # but we'll set them to local paths inside the repo instead of $HOME/datasets/...
    base_dir: Path = field(init=False)
    finetune_dir: Path = field(init=False)

    # Final resolved checkpoint paths
    model_16_block_ckpt: Path = field(init=False)
    model_8_block_ckpt: Path = field(init=False)

    def __post_init__(self) -> None:
        """
        Figure out where assets, examples, and finetuned weights actually live.
        We assume everything is inside the Flask project under superres_app/.
        """

        # superres_app/config.py -> parent is superres_app
        superres_dir = Path(__file__).resolve().parent

        # The full Flask project root (V4)
        project_root = superres_dir.parent

        # We'll keep your old field names base_dir/finetune_dir, but now
        # they point into our repo instead of ~/datasets/... etc.
        #
        # You can change this if you store data somewhere else on disk.
        #
        # If you had "datasets/sen2venus/finetune" before, we replicate
        # that layout under superres_app/models or any path you prefer.
        #
        # I’ll assume you copy or mount your final checkpoints into:
        #   superres_app/models/
        # and example chips into:
        #   superres_app/assets/examples_npy/{lr,hr}
        #
        # If you want a different layout, just edit these few lines.
        object.__setattr__(self, "project_root", project_root)

        # Directory with example .npy tiles (lr/ and hr/)
        assets_dir = superres_dir / "assets"
        object.__setattr__(self, "assets_dir", assets_dir)
        object.__setattr__(self, "example_lr_dir", assets_dir / "examples_npy" / "lr")
        object.__setattr__(self, "example_hr_dir", assets_dir / "examples_npy" / "hr")

        # Directory that holds fine-tuned model weights.
        #
        # In your original repo you referenced:
        #   ~/datasets/sen2venus/finetune/edsr_base/best_model_checkpoint.pt
        #
        # We'll assume you've copied those final checkpoints into:
        #   superres_app/models/edsr_base/best_model_checkpoint.pt
        #   superres_app/models/edsr_base_8_block/best_model_checkpoint.pt
        #
        models_root = superres_dir / "models"
        object.__setattr__(self, "base_dir", models_root)  # legacy compat
        object.__setattr__(self, "finetune_dir", models_root)

        # ---- Resolve checkpoint paths ----
        if self.model_16_block_ckpt_override:
            model_16_ckpt = self.model_16_block_ckpt_override
        else:
            model_16_ckpt = (
                models_root / "edsr_base" / "best_model_checkpoint.pt"
            )

        if self.model_8_block_ckpt_override:
            model_8_ckpt = self.model_8_block_ckpt_override
        else:
            model_8_ckpt = (
                models_root / "edsr_base_8_block" / "best_model_checkpoint.pt"
            )

        object.__setattr__(self, "model_16_block_ckpt", model_16_ckpt)
        object.__setattr__(self, "model_8_block_ckpt", model_8_ckpt)

    def validate_for_inference(self, model_arch: str):
        """
        Sanity-checks that we actually have the files we need.
        Call this before running inference in production if you want.
        """
        paths_to_check = {
            "assets_dir": self.assets_dir,
        }

        if model_arch == "EDSR_16":
            paths_to_check["16-block checkpoint"] = self.model_16_block_ckpt
        elif model_arch == "EDSR_8":
            paths_to_check["8-block checkpoint"] = self.model_8_block_ckpt

        missing = [
            f"{name} ({path})"
            for name, path in paths_to_check.items()
            if not path.exists()
        ]
        if missing:
            raise FileNotFoundError(
                "Missing required paths/files for inference: " + ", ".join(missing)
            )


def setup_environment(env_mode: EnvModeType) -> None:
    """
    This was mainly for Colab auto-install. We keep it for completeness,
    but you probably won't call this from Flask.
    """
    if env_mode is None:
        if "google.colab" in sys.modules:
            env_mode = "colab"
        else:
            env_mode = "local"

    # Auto-install on Colab only
    if env_mode.startswith("colab"):
        packages = ["super-image", "python-dotenv"]
        try:
            for package in packages:
                __import__(package)
        except ImportError:
            print("Installing external packages in Colab...")
            subprocess.run(
                ["pip", "install", "--quiet"] + packages,
                check=True
            )

        from google.colab import drive  # type: ignore
        drive.mount("/content/drive", force_remount=True)


def create_config(env_mode: EnvModeType) -> Config:
    """
    Build a Config object for inference.

    - We load .env so we can let ops override checkpoint paths via:
        CKPT_PATH_EDSR_16=/abs/path/to/16block.pt
        CKPT_PATH_EDSR_8=/abs/path/to/8block.pt

    - env_mode you pass from the UI:
        "local-mock"  -> dev mode (CPU ok, maybe fake/faster model)
        "remote"      -> real model on GPU server
    """
    # Fallback logic if not provided
    if env_mode is None:
        env_mode = "colab" if "google.colab" in sys.modules else "local"

    load_dotenv()  # pull in .env from project root

    ckpt_16_env = os.getenv("CKPT_PATH_EDSR_16")
    ckpt_8_env = os.getenv("CKPT_PATH_EDSR_8")

    ckpt_16_path = Path(ckpt_16_env) if ckpt_16_env else None
    ckpt_8_path = Path(ckpt_8_env) if ckpt_8_env else None

    cfg = Config(
        env_mode=env_mode,
        model_16_block_ckpt_override=ckpt_16_path,
        model_8_block_ckpt_override=ckpt_8_path,
    )

    return cfg