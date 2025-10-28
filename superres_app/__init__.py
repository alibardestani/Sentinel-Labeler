import os

# Check if we should skip heavy ML deps
DISABLE_TORCH = os.getenv("DISABLE_TORCH", "0") == "1"

# Make this flag available everywhere inside superres_app
__all__ = ["DISABLE_TORCH"]

from .routes import superres_bp