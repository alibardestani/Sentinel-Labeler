# /Volumes/Work/Sen2/V4/app.py
from __future__ import annotations

import os
from flask import Flask, session
from flask_migrate import Migrate
from dotenv import load_dotenv
from sqlalchemy.orm import configure_mappers

from models import db, User, AssignedTile, PolygonAssignment

from config import settings


def create_app() -> Flask:
    load_dotenv()
    app = Flask(__name__, static_folder="static", template_folder="templates")

    # ------------------------------
# LABEL COUNTER (GLOBAL STATE)
# ------------------------------
    # app.label_count = 0

    # def increment_label_count():
    #     app.label_count += 1
    #     return app.label_count


    # --------------------
    # Core configuration
    # --------------------
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "please-change-me")
    # db_uri = os.getenv(
    #     "SQLALCHEMY_DATABASE_URI",
    #     "mysql+pymysql://root@localhost:3306/sen2?charset=utf8mb4",
    # )
    app.config.update(
        OUTPUT_DIR=str(getattr(settings, "OUTPUT_DIR", "")),
        S2_RGB_TIF=str(getattr(settings, "S2_RGB_TIF", "")),


        SQLALCHEMY_DATABASE_URI = "mysql+pymysql://root:@localhost:3306/sen2?charset=utf8mb4",


        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True, "pool_recycle": 1800},
    )

    # --------------------
    # DB + migrations
    # --------------------
    db.init_app(app)
    Migrate(app, db)

    # --------------------
    # Register models FIRST
    # (ensures relationships by string resolve cleanly)
    # --------------------
    import models            # User, AssignedTile, PolygonAssignment
    import models_polygons   # PolygonSet, Polygon
    configure_mappers()

    # --------------------
    # Blueprints
    # --------------------
    # Import AFTER models are registered to avoid circular import timing issues
    from routes.api import api_bp
    from routes.masks_api import bp_masks
    from routes.polygons_api import polygons_api
    from routes.auth import auth_bp
    from routes.pages import pages_bp
    from routes.admin import admin_bp

    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(bp_masks, url_prefix="/api/masks")
    app.register_blueprint(polygons_api)  # has its own url_prefix inside file
    app.register_blueprint(auth_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(admin_bp, url_prefix="/admin")

    # Optional blueprints (don’t crash if missing)
    try:
        from project2 import project2_bp
        app.register_blueprint(project2_bp)
    except Exception as e:
        print("[project2] optional import skipped:", e)

    try:
        from polygon_navigator_app import polygon_navigator_bp
        # polygon_navigator_bp already has url_prefix="/polygon-navigator" internally;
        # passing it again is harmless but we keep it explicit for clarity:
        app.register_blueprint(polygon_navigator_bp, url_prefix="/polygon-navigator")
    except Exception as e:
        print("[polygon_navigator] optional import skipped:", e)

    try:
        from superres_app import superres_bp
        app.register_blueprint(superres_bp, url_prefix="/superres")
    except Exception as e:
        print("[superres_app] optional import skipped:", e)

    # --------------------
    # Template context
    # --------------------
    @app.context_processor
    def inject_current_user():
        uid = session.get("user_id")
        u = User.query.get(uid) if uid else None
        return {
            "current_user": u,
            "is_admin": bool(getattr(u, "is_admin", False)) if u else False,
        }

    # --------------------
    # Optional bootstrap
    # --------------------
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


# if __name__ == "__main__":
#     app = create_app()
#     port = int(os.getenv("FLASK_PORT", "5001"))
#     debug = bool(int(os.getenv("DEBUG", "0")))
#     app.run(host="0.0.0.0", port=port, debug=debug)

if __name__ == "__main__":
    app = create_app()
    app.run(host="127.0.0.1", port=5000, debug=True)