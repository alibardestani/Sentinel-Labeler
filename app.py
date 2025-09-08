from flask import Flask, render_template, redirect, url_for
from config import settings
from routes.api import api_bp  # فقط API روی /api

app = Flask(__name__, static_folder="static", template_folder="templates")

# کانفیگ‌های لازم
app.config.update(
    OUTPUT_DIR=str(settings.OUTPUT_DIR),
    S2_RGB_TIF=str(settings.S2_RGB_TIF),
)

# ثبت API
app.register_blueprint(api_bp, url_prefix="/api")

# --- صفحات وب ---
@app.route("/")
def index():
    return redirect(url_for("polygon"))  # برو به /polygon

@app.route("/polygon")
def polygon():
    # باید فایل templates/polygon.html وجود داشته باشد
    return render_template("polygon.html")

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)