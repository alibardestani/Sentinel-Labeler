# scripts/create_admin.py
from werkzeug.security import generate_password_hash
from app import app, db, User

email = "admin@example.com"
password = "admin1234"

with app.app_context():
    if not User.query.filter_by(email=email).first():
        u = User(email=email, password=generate_password_hash(password), is_admin=True)
        db.session.add(u)
        db.session.commit()
        print("Admin created.")
    else:
        print("Admin already exists.")