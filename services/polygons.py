# services/polygons.py
from __future__ import annotations
from pathlib import Path
import json
from config import settings

OUT = Path(settings.POLYGONS_GEOJSON)

def load_polygons_dict() -> dict:
    """GeoJSON را به‌صورت dict برمی‌گرداند. اگر نبود، FeatureCollection خالی می‌دهد."""
    if not OUT.exists():
        return {"type": "FeatureCollection", "features": []}
    with OUT.open("r", encoding="utf-8") as f:
        return json.load(f)

def load_polygons_text() -> str:
    """برای سازگاری با کدهای قدیمی که متن JSON می‌خواستند."""
    return json.dumps(load_polygons_dict(), ensure_ascii=False)