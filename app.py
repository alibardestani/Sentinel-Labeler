# app.py
from __future__ import annotations

import os
from flask import Flask, session
from flask_migrate import Migrate
from dotenv import load_dotenv  # <-- make sure python-dotenv is installed

from models import db, User
from config import settings
from project2 import project2_bp


def create_app() -> Flask:
    # Load .env (only needs to run once; harmless if called multiple times)
    load_dotenv()

    app = Flask(__name__, static_folder="static", template_folder="templates")

    # ---- Secrets & DB from env ----
    # .env example:
    # SECRET_KEY=change-this-in-prod-please
    # SQLALCHEMY_DATABASE_URI=mysql+pymysql://user:pass@host/db?charset=utf8mb4
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "please-change-me")

    db_uri = os.getenv(
        "SQLALCHEMY_DATABASE_URI",
        "mysql+pymysql://root@localhost:3306/sen2?charset=utf8mb4"
    )

    # ---- App Config ----
    app.config.update(
        OUTPUT_DIR=str(settings.OUTPUT_DIR),
        S2_RGB_TIF=str(settings.S2_RGB_TIF),
        SQLALCHEMY_DATABASE_URI=db_uri,
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={
            "pool_pre_ping": True,
            "pool_recycle": 1800,
        },
    )

    # ---- DB ----
    db.init_app(app)
    Migrate(app, db)

    # ---- Blueprints from main app ----
    from routes.api import api_bp
    from routes.masks_api import bp_masks
    from routes.polygons_api import bp_polygons
    from routes.auth import auth_bp
    from routes.pages import pages_bp
    from routes.admin import admin_bp

    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(bp_masks, url_prefix="/api/masks")
    app.register_blueprint(bp_polygons, url_prefix="/api/polygons")
    app.register_blueprint(auth_bp)          # /login, /logout
    app.register_blueprint(pages_bp)         # /, /brush, /polygon, /no-access
    app.register_blueprint(admin_bp, url_prefix="/admin")
    app.register_blueprint(project2_bp)

    # ---- Polygon Navigator mini-app blueprint ----
    from polygon_navigator_app import polygon_navigator_bp
    app.register_blueprint(polygon_navigator_bp)
    # now it's available at /polygon-navigator/ ...

    # ---- Context Processor (inject_current_user) ----
    @app.context_processor
    def inject_current_user():
        uid = session.get("user_id")
        u = User.query.get(uid) if uid else None
        return {
            "current_user": u,
            "is_admin": bool(getattr(u, "is_admin", False)) if u else False,
        }

    # ---- sanity checks + polygons bootstrap ----
    from services.polygons_bootstrap import ensure_geojson_from_shapefile
    with app.app_context():
        try:
            db.session.execute(db.text("SELECT 1"))
            print("MySQL connection OK ✅")
        except Exception as e:
            print("MySQL connection ERROR ❌", e)

        try:
            ensure_geojson_from_shapefile()
        except Exception as e:
            print("[polygons] bootstrap failed:", e)

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5001, debug=False)