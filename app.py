# app.py
from __future__ import annotations

import os
from flask import Flask, session
from flask_migrate import Migrate
from dotenv import load_dotenv  # requires python-dotenv

from models import db, User
from config import settings
from project2 import project2_bp


def create_app() -> Flask:
    # Load environment variables from .env (root of project)
    load_dotenv()

    app = Flask(__name__, static_folder="static", template_folder="templates")

    # ---- Secrets & DB from env ----
    # .env should define:
    #   SECRET_KEY=...
    #   SQLALCHEMY_DATABASE_URI=...
    #
    # SECRET_KEY is required for session cookies / login. We fall back to a dummy
    # but please override this in production.
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "please-change-me")

    db_uri = os.getenv(
        "SQLALCHEMY_DATABASE_URI",
        "mysql+pymysql://root@localhost:3306/sen2?charset=utf8mb4",
    )

    # ---- Core App Config ----
    # Some of these come from your existing config/settings module.
    # We assume `settings.OUTPUT_DIR` and `settings.S2_RGB_TIF` are Path-like.
    app.config.update(
        OUTPUT_DIR=str(getattr(settings, "OUTPUT_DIR", "")),
        S2_RGB_TIF=str(getattr(settings, "S2_RGB_TIF", "")),
        SQLALCHEMY_DATABASE_URI=db_uri,
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={
            "pool_pre_ping": True,
            "pool_recycle": 1800,
        },
    )

    # ---- DB init ----
    db.init_app(app)
    Migrate(app, db)

    # ---- Blueprints: main app ----
    from routes.api import api_bp
    from routes.masks_api import bp_masks
    from routes.polygons_api import bp_polygons
    from routes.auth import auth_bp
    from routes.pages import pages_bp
    from routes.admin import admin_bp

    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(bp_masks, url_prefix="/api/masks")
    app.register_blueprint(bp_polygons, url_prefix="/api/polygons")
    app.register_blueprint(auth_bp)                 # /login, /logout
    app.register_blueprint(pages_bp)                # /, /brush, /polygon, /no-access
    app.register_blueprint(admin_bp, url_prefix="/admin")
    app.register_blueprint(project2_bp)             # /compare or whatever project2 routes expose

    # ---- Polygon Navigator mini-app ----
    # available at /polygon-navigator/...
    from polygon_navigator_app import polygon_navigator_bp
    app.register_blueprint(polygon_navigator_bp)

    # ---- Super Resolution mini-app ----
    # available at /superres/...
    from superres_app import superres_bp
    app.register_blueprint(superres_bp)

    # ---- Context Processor: inject_current_user into all templates ----
    @app.context_processor
    def inject_current_user():
        uid = session.get("user_id")
        u = User.query.get(uid) if uid else None
        return {
            "current_user": u,
            "is_admin": bool(getattr(u, "is_admin", False)) if u else False,
        }

    # ---- Sanity checks + bootstrap polygons ----
    # This runs once on startup, inside an app context.
    from services.polygons_bootstrap import ensure_geojson_from_shapefile

    with app.app_context():
        # DB connectivity check
        try:
            db.session.execute(db.text("SELECT 1"))
            print("MySQL connection OK ✅")
        except Exception as e:
            print("MySQL connection ERROR ❌", e)

        # Ensure polygons GeoJSON is initialized
        try:
            ensure_geojson_from_shapefile()
        except Exception as e:
            print("[polygons] bootstrap failed:", e)

    return app


if __name__ == "__main__":
    app = create_app()
    # You can also expose HOST / PORT / DEBUG via env if you like:
    # e.g. FLASK_PORT=8000 DEBUG=1
    port = int(os.getenv("FLASK_PORT", "5001"))
    debug = bool(int(os.getenv("DEBUG", "0")))
    app.run(host="0.0.0.0", port=port, debug=debug)