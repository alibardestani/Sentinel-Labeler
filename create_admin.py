# scripts/create_admin.py
from werkzeug.security import generate_password_hash
from app import create_app, db
from models import User   

app = create_app()

email = "admin@example.com"
password = "admin1234"

with app.app_context():
    if not User.query.filter_by(email=email).first():
        u = User(
            email=email,
            password=generate_password_hash(password),
            is_admin=True
        )
        db.session.add(u)
        db.session.commit()
        print("✅ Admin created.")
    else:
        print("ℹ️ Admin already exists.")