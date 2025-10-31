# polygon_navigator_app/routes.py

from __future__ import annotations

from flask import Blueprint, render_template, session, redirect, url_for

# ---- Blueprint definition ----
polygon_navigator_bp = Blueprint(
    "polygon_navigator",
    __name__,
    url_prefix="/polygon-navigator",
    template_folder="templates",
    static_folder="static",
    static_url_path="/polygon-navigator-static",
)

# ---- Auth guard using your session logic ----
def require_login():
    """Redirect to login if user isn't authenticated."""
    if "user_id" not in session:
        # NOTE: 'auth_bp.login' is the endpoint name from your auth blueprint.
        # Also include ?next= so we come back here after login.
        return redirect(url_for("auth_bp.login", next=url_for("polygon_navigator.index")))
    return None

@polygon_navigator_bp.route("/", methods=["GET"])
def index():
    """
    Render the polygon navigator page.
    The frontend JavaScript will:
      - GET  /api/polygons/mine  → load assigned polygons (FeatureCollection)
      - POST /api/polygons/save  → persist quality updates to DB
    """
    needs_login = require_login()
    if needs_login:
        return needs_login
    return render_template("polygon_navigator/index.html")