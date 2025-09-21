# app.py
from __future__ import annotations
from pathlib import Path
from flask import Flask
from flask_migrate import Migrate
from models import db
from config import settings

def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.config["SECRET_KEY"] = "change-this-in-prod-please"

    # تنظیمات عمومی
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

    # DB
    db.init_app(app)
    Migrate(app, db)

    # بلوپرینت‌ها
    from routes.api import api_bp
    from routes.masks_api import bp_masks
    from routes.auth import auth_bp
    from routes.pages import pages_bp
    from routes.admin import admin_bp

    app.register_blueprint(api_bp)                 # /api/... (قدیمی خودت)
    app.register_blueprint(bp_masks)               # /api/masks/...
    app.register_blueprint(auth_bp)                # /login, /logout
    app.register_blueprint(pages_bp)               # /, /polygon, /brush
    app.register_blueprint(admin_bp, url_prefix="/admin")

    # sanity check
    with app.app_context():
        try:
            db.session.execute(db.text("SELECT 1"))
            print("MySQL connection OK ✅")
        except Exception as e:
            print("MySQL connection ERROR ❌", e)

    return app

if __name__ == "__main__":
    from services.polygons_bootstrap import ensure_geojson_from_shapefile
    ensure_geojson_from_shapefile()
    app = create_app()
    app.run(host="127.0.0.1", port=5000, debug=True)