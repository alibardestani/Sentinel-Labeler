# app.py
from __future__ import annotations

from flask import Flask, session
from flask_migrate import Migrate
from models import db, User
from config import settings


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config["SECRET_KEY"] = "change-this-in-prod-please"

    # ---- Config ----
    app.config.update(
        OUTPUT_DIR=str(settings.OUTPUT_DIR),
        S2_RGB_TIF=str(settings.S2_RGB_TIF),
        SQLALCHEMY_DATABASE_URI=(
            "mysql+pymysql://root:root@localhost/sen2"
            "?unix_socket=/Applications/MAMP/tmp/mysql/mysql.sock"
            "&charset=utf8mb4"
        ),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True, "pool_recycle": 1800},
    )

    # ---- DB ----
    db.init_app(app)
    Migrate(app, db)

    # ---- Blueprints ----
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

    # ---- Context Processor (جهت دسترسی به کاربر در تمام قالب‌ها) ----
    @app.context_processor
    def inject_current_user():
        uid = session.get("user_id")
        u = User.query.get(uid) if uid else None
        return {
            "current_user": u,
            "is_admin": bool(getattr(u, "is_admin", False)) if u else False,
        }

    # ---- (اختیاری) sanity checks و Bootstrap پلیگان‌ها ----
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
    app.run(host="127.0.0.1", port=5000, debug=True)