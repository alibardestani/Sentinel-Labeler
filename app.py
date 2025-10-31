# /Volumes/Work/Sen2/V4/app.py
from __future__ import annotations

import os
from flask import Flask, session
from flask_migrate import Migrate
from dotenv import load_dotenv

from models import db, User
from config import settings

def create_app() -> Flask:
    load_dotenv()
    app = Flask(__name__, static_folder="static", template_folder="templates")

    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "please-change-me")
    db_uri = os.getenv(
        "SQLALCHEMY_DATABASE_URI",
        "mysql+pymysql://root@localhost:3306/sen2?charset=utf8mb4",
    )
    app.config.update(
        OUTPUT_DIR=str(getattr(settings, "OUTPUT_DIR", "")),
        S2_RGB_TIF=str(getattr(settings, "S2_RGB_TIF", "")),
        SQLALCHEMY_DATABASE_URI=db_uri,
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True, "pool_recycle": 1800},
    )

    db.init_app(app)
    Migrate(app, db)  # registers `flask db` commands

    # --- Core blueprints (must exist) ---
    from routes.api import api_bp
    from routes.masks_api import bp_masks
    from routes.polygons_api import polygons_api
    from routes.auth import auth_bp
    from routes.pages import pages_bp
    from routes.admin import admin_bp
    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(bp_masks, url_prefix="/api/masks")
    app.register_blueprint(polygons_api)  # has own prefix inside file
    app.register_blueprint(auth_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(admin_bp, url_prefix="/admin")

    # --- Optional blueprints (don’t crash app if missing) ---
    try:
        from project2 import project2_bp
        app.register_blueprint(project2_bp)
    except Exception as e:
        print("[project2] optional import skipped:", e)

    try:
        from polygon_navigator_app import polygon_navigator_bp
        app.register_blueprint(polygon_navigator_bp, url_prefix="/polygon-navigator")
    except Exception as e:
        print("[polygon_navigator] optional import skipped:", e)

    try:
        from superres_app import superres_bp
        app.register_blueprint(superres_bp, url_prefix="/superres")
    except Exception as e:
        print("[superres_app] optional import skipped:", e)

    @app.context_processor
    def inject_current_user():
        uid = session.get("user_id")
        u = User.query.get(uid) if uid else None
        return {
            "current_user": u,
            "is_admin": bool(getattr(u, "is_admin", False)) if u else False
        }

    # Optional bootstrap
    try:
        from services.polygons_bootstrap import ensure_geojson_from_shapefile
    except Exception as e:
        print("[bootstrap] polygons_bootstrap import skipped:", e)
        ensure_geojson_from_shapefile = None

    with app.app_context():
        try:
            db.session.execute(db.text("SELECT 1"))
            print("MySQL connection OK ✅")
        except Exception as e:
            print("MySQL connection ERROR ❌", e)

        if ensure_geojson_from_shapefile:
            try:
                ensure_geojson_from_shapefile()
            except Exception as e:
                print("[polygons] bootstrap failed:", e)

    return app


if __name__ == "__main__":
    app = create_app()
    port = int(os.getenv("FLASK_PORT", "5001"))
    debug = bool(int(os.getenv("DEBUG", "0")))
    app.run(host="0.0.0.0", port=port, debug=debug)