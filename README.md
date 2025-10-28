# Sentinel Labeler Platform

Integrated Flask-based system for:
- **Sentinel Polygon & Mask Labeling**
- **Polygon Navigator (QA tool)**
- **Super-Resolution (EDSR-based)**
- Shared user auth, admin panel, and templates.

---

## 🚀 Quick Setup

### 1️⃣ Clone the repo
```bash
git clone https://github.com/alibardestani/Sentinel-Labeler.git
cd Sentinel-Labeler

### 2️⃣ Create & activate virtual environment

python3 -m venv .venv
source .venv/bin/activate   # (Windows: .venv\Scripts\activate)

### 3️⃣ Install dependencies

pip install --upgrade pip
pip install -r requirements.txt

💡 Local dev / laptop:
	•	You do NOT need torch.
	•	Super-Resolution runs in mock mode.

💡 GPU server:

pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install super-image



⸻

### 🗄 Create MySQL database

CREATE DATABASE sen2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sen2user'@'localhost' IDENTIFIED BY 'yourpass';
GRANT ALL PRIVILEGES ON sen2.* TO 'sen2user'@'localhost';
FLUSH PRIVILEGES;


⸻

### ⚙️ Create .env in project root

# Flask
SECRET_KEY=change-this
SQLALCHEMY_DATABASE_URI=mysql+pymysql://sen2user:yourpass@127.0.0.1:3306/sen2?charset=utf8mb4
FLASK_PORT=5001
DEBUG=1

# SuperRes runtime mode
# local-mock  = mock model, no torch required
# local       = real model on local machine
# remote      = real model on GPU server
ENV_MODE=local-mock

# Disable heavy ML deps for local dev
DISABLE_TORCH=1

# For GPU server, use:
# ENV_MODE=remote
# DISABLE_TORCH=0
# CKPT_PATH_EDSR_16=/home/ubuntu/models/edsr_base/best_model_checkpoint.pt
# CKPT_PATH_EDSR_8=/home/ubuntu/models/edsr_base_8_block/best_model_checkpoint.pt


⸻

### 🗃 Initialize database tables

flask db upgrade
# or just run once (app does a DB sanity check on startup):
python app.py


⸻

### ▶️ Run the app

python app.py

Now open in browser:
	•	🛰 Main app → http://localhost:5001/
	•	🧩 Polygon Navigator → http://localhost:5001/polygon-navigator/
	•	⚡ Super-Resolution → http://localhost:5001/superres/

If you’re not logged in, you’ll be redirected to /login.

⸻

### 🧠 Modes recap

Mode	torch needed?	Behavior
local-mock	no	Fake SR preview (dev mode)
local	yes	Real model locally (CPU/GPU)
remote	yes	Real model on production server
colab	yes	Notebook / Colab usage

Set mode using ENV_MODE in .env.

⸻

### 📂 Folder structure

Sentinel-Labeler/
├── app.py                      # Flask entrypoint
├── config.py                   # global settings
├── models.py                   # SQLAlchemy models (User, etc.)
├── requirements.txt
├── migrations/                 # Flask-Migrate / Alembic
├── routes/                     # auth, pages, polygons, admin, api...
├── services/                   # helpers (e.g. polygon bootstrap)
├── templates/                  # shared base.html, etc.
├── static/                     # shared js/css/img
│
├── polygon_navigator_app/
│   ├── __init__.py
│   ├── routes.py               # /polygon-navigator/
│   ├── templates/polygon_navigator/index.html
│   ├── static/polygon_navigator/script.js
│   └── output/                 # exported shapefiles
│
├── superres_app/
│   ├── __init__.py             # DISABLE_TORCH flag / blueprint export
│   ├── routes.py               # /superres/
│   ├── config.py               # ENV_MODE, checkpoint paths
│   ├── models.py               # MockModel + real EDSR loader
│   ├── data.py                 # image/tensor utils (torch-optional)
│   ├── processing.py           # inference orchestration
│   ├── templates/superres/index.html
│   ├── static/superres/superres.js
│   ├── assets/examples_npy/lr/*.npy
│   ├── assets/examples_npy/hr/*.npy
│   └── models/
│       ├── edsr_base/best_model_checkpoint.pt
│       └── edsr_base_8_block/best_model_checkpoint.pt
│
└── README.md


⸻

### ✅ Commands Cheat Sheet

Task	Command
Clone repo	git clone https://github.com/alibardestani/Sentinel-Labeler.git
Enter project	cd Sentinel-Labeler
Create venv	python3 -m venv .venv && source .venv/bin/activate
Install deps	pip install -r requirements.txt
Create DB	run SQL snippet above
Create .env	copy the example in this README
Run migrations	flask db upgrade or python app.py once
Launch app	python app.py
Open UI	http://localhost:5001/


⸻

### 👥 Repo

https://github.com/alibardestani/Sentinel-Labeler

