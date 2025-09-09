# app.py
from flask import (
    Flask, render_template, redirect, url_for,
    request, session, jsonify
)
from functools import wraps
from urllib.parse import urlparse, urljoin

from config import settings
from routes.api import api_bp  # mounts at /api

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SECRET_KEY"] = "change-this-in-prod-please"
app.config.update(
    OUTPUT_DIR=str(settings.OUTPUT_DIR),
    S2_RGB_TIF=str(settings.S2_RGB_TIF),
)

DEMO_EMAIL = "demo@example.com"
DEMO_PASS  = "demo1234"

def is_safe_url(target: str) -> bool:
    if not target:
        return False
    ref_url = urlparse(request.host_url)
    test_url = urlparse(urljoin(request.host_url, target))
    return (test_url.scheme in ("http", "https")
            and ref_url.netloc == test_url.netloc)

def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("login", next=request.path))
        return fn(*args, **kwargs)
    return wrapper

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
      # اگر قبلا لاگین است، مستقیم بفرستش
      if session.get("user"):
          next_url = request.args.get("next") or url_for("polygon")
          return redirect(next_url)
      return render_template("login.html")

    data = request.get_json(silent=True) or request.form
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if email == DEMO_EMAIL and password == DEMO_PASS:
        session["user"] = email
        if request.is_json:
            return jsonify(ok=True)
        next_url = data.get("next") or request.args.get("next") or url_for("polygon")
        if not is_safe_url(next_url):
            next_url = url_for("polygon")
        return redirect(next_url)

    if request.is_json:
        return jsonify(ok=False, error="invalid credentials"), 401
    return render_template("login.html", error="Invalid email or password"), 401

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

@app.route("/")
def index():
    if session.get("user"):
        return redirect(url_for("polygon"))
    return redirect(url_for("login"))

@app.route("/polygon")
@login_required
def polygon():
    return render_template("polygon.html")

app.register_blueprint(api_bp, url_prefix="/api")

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)