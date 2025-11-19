from __future__ import annotations

from flask import Blueprint, render_template, session, redirect, url_for, Response
import csv
import io
from app import db
from sqlalchemy import text

polygon_navigator_bp = Blueprint(
    "polygon_navigator",
    __name__,
    url_prefix="/polygon-navigator",
    template_folder="templates",
    static_folder="static",
    static_url_path="/polygon-navigator-static",
)

def require_login():
    if "user_id" not in session:
        return redirect(url_for("auth_bp.login", next=url_for("polygon_navigator.index")))
    return None



@polygon_navigator_bp.get("/download-csv")
def download_csv():
    import io, csv, json
    user_id = session.get("user_id")

    rows = db.session.execute(text("""
        SELECT p.id, p.properties
        FROM polygon p
        JOIN polygon_assignment a ON a.polygon_id = p.id
        WHERE a.user_id = :uid
    """), {"uid": user_id}).fetchall()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["polygon_id", "quality"])

    for row in rows:
        raw = row.properties or "{}"

        try:
            props = json.loads(raw)
        except:
            props = {}

        q = props.get("quality", None)
        writer.writerow([row.id, q or "null"])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=polygon_labels.csv"}
    )


@polygon_navigator_bp.route("/", methods=["GET"])
def index():
    needs_login = require_login()
    if needs_login:
        return needs_login
    return render_template("polygon_navigator/index.html")
