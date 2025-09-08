# services/polygons.py
from __future__ import annotations
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple

import geopandas as gpd
from pyproj import CRS, Geod
from shapely.geometry import shape as shape_from_geojson
from shapely.geometry.base import BaseGeometry

from config import settings

# ژئودتیک WGS84 برای محاسبات مساحت/محیط
_GEOD = Geod(ellps="WGS84")

# کلیدهای ممکن برای «Fruit Type»
_FRUIT_KEYS = [
    "Fruit Type", "fruit type", "FruitType", "fruitType",
    "fruit_type", "FRUIT_TYPE", "FRUITTYPE"
]


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #

def _to_gdf_fc_any_crs(fc: dict) -> gpd.GeoDataFrame:
    """
    هر FeatureCollection را به GeoDataFrame تبدیل می‌کند.
    اگر CRS موجود نبود، WGS84 ست می‌شود؛ سپس به EPSG:4326 تبدیل می‌کنیم.
    """
    gdf = gpd.GeoDataFrame.from_features(fc)
    if gdf.empty:
        return gdf

    # تلاش برای یافتن CRS از فیلد crs در GeoJSON (در صورت وجود)
    crs_obj = None
    try:
        if 'crs' in fc and fc['crs'] and 'properties' in fc['crs']:
            name = fc['crs']['properties'].get('name')
            if name:
                crs_obj = CRS.from_user_input(name)
    except Exception:
        crs_obj = None

    if gdf.crs is None:
        if crs_obj is not None:
            gdf.set_crs(crs_obj, inplace=True)
        else:
            # پیش‌فرض: WGS84
            gdf.set_crs(epsg=4326, inplace=True)

    # نرمال‌سازی به WGS84
    try:
        gdf = gdf.to_crs(epsg=4326)
    except Exception:
        # اگر تبدیل شکست خورد، همان CRS را نگه داریم تا از خطا عبور کند
        pass
    return gdf


def _make_valid(geom: BaseGeometry) -> BaseGeometry:
    """
    هندسه‌ی معتبر. ابتدا از shapely.make_valid (Shapely 2+) استفاده می‌کنیم؛
    اگر نبود/شکست خورد، از buffer(0) به عنوان fallback.
    """
    try:
        from shapely import make_valid  # Shapely 2.x
        vg = make_valid(geom)
        if vg.is_valid:
            return vg
    except Exception:
        pass
    try:
        bg = geom.buffer(0)
        if bg.is_valid:
            return bg
    except Exception:
        pass
    return geom  # اگر نشد همان را برگردان


def _geodesic_metrics(geom: BaseGeometry) -> Tuple[float, float]:
    """
    مساحت (m^2) و محیط (m) ژئودتیک روی WGS84.
    فقط Polygon/MultiPolygon هدف اصلی‌اند؛ برای انواع دیگر تلاش محافظه‌کارانه.
    """
    if geom.is_empty:
        return 0.0, 0.0

    def _ring_area_perimeter(xy: List[Tuple[float, float]]) -> Tuple[float, float]:
        lons = [pt[0] for pt in xy]
        lats = [pt[1] for pt in xy]
        area, perim = _GEOD.polygon_area_perimeter(lons, lats)
        # area ممکن است منفی شود (جهت/اورینتیشن)، قدرمطلق بگیریم
        return abs(area), perim

    area_total = 0.0
    length_total = 0.0

    gt = geom.geom_type
    if gt == "Polygon":
        # بیرونی
        a, p = _ring_area_perimeter(list(geom.exterior.coords))
        area_total += a
        length_total += p
        # حفره‌ها
        for r in geom.interiors:
            a_h, p_h = _ring_area_perimeter(list(r.coords))
            area_total -= a_h
            length_total += p_h

    elif gt == "MultiPolygon":
        for poly in geom.geoms:
            a, p = _geodesic_metrics(poly)
            area_total += a
            length_total += p

    else:
        # برای خطوط/نقاط: فقط تلاش برای محیط تقریبی
        try:
            coords = list(geom.coords)
            if len(coords) >= 2:
                lons = [c[0] for c in coords]
                lats = [c[1] for c in coords]
                _, perim = _GEOD.polygon_area_perimeter(lons, lats)
                length_total += perim
        except Exception:
            pass

    return float(area_total), float(length_total)


def _shorten_columns_for_shp(gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    نام ستون‌ها را برای سازگاری با Shapefile (<=10 کاراکتر) کوتاه می‌کند.
    در صورت تداخل، پسوند عددی می‌زند.
    """
    if gdf.empty:
        return gdf

    rename_map: Dict[str, str] = {}
    existing = set(gdf.columns)
    for col in list(gdf.columns):
        if col == "geometry":
            continue
        if len(col) > 10:
            base = col[:10]
            name = base
            i = 1
            # از برخورد با نام‌های موجود/تولیدشده جلوگیری کنیم
            while name in existing or name in rename_map.values():
                name = (base[:8] + f"{i:02d}")[:10]
                i += 1
            rename_map[col] = name
            existing.add(name)
    return gdf.rename(columns=rename_map) if rename_map else gdf


def _to_list_if_any(v: Any) -> List[str]:
    """
    هر ورودی را به لیست رشته تبدیل می‌کند:
      * list/tuple/set → لیست رشته
      * str با جداکنندهٔ کاما انگلیسی یا فارسی
      * مقدار منفرد → لیست تک‌عضوی
    """
    if v is None:
        return []
    if isinstance(v, (list, tuple, set)):
        out = []
        for x in v:
            if x is None:
                continue
            out.append(str(x).strip())
        return [s for s in out if s != ""]
    s = str(v).strip()
    if s == "":
        return []
    if "," in s:
        return [p.strip() for p in s.split(",") if p.strip()]
    if "،" in s:
        return [p.strip() for p in s.split("،") if p.strip()]
    return [s]


def _extract_label_and_list(props: Dict[str, Any]) -> Tuple[str, List[str], str | None]:
    """
    خروجی:
      - label: رشتهٔ نهایی برای UI/ذخیره
      - labels_list: اگر چندتایی بود (از Fruit Type/label) نگه می‌داریم
      - label_source: نام فیلدی که از آن استخراج شد (برای دیباگ)
    اولویت:
      1) props['label']
      2) هرکدام از کلیدهای «Fruit Type» با نگارش‌های مختلف
    """
    # 1) label مستقیم
    if "label" in props and props["label"] not in (None, ""):
        lst = _to_list_if_any(props["label"])
        if lst:
            return lst[0], lst, "label"

    # 2) Fruit Type (در هر نگارشی)
    for k in _FRUIT_KEYS:
        if k in props and props[k] not in (None, ""):
            lst = _to_list_if_any(props[k])
            if lst:
                return lst[0], lst, k

    return "", [], None


def _ensure_properties(feature: dict, idx: int) -> dict:
    """
    تکمیل/استانداردسازی properties یک feature:
      - uid  (از ورودی؛ وگرنه poly_000001 … یا UUID با تنظیم USE_UUID_UID)
      - label (از label یا Fruit Type)، labels_list (اگر چندتایی بود)، label_source
      - class_id (از LABEL_CLASS_MAP یا پیش‌فرض 1=Vegetation)
      - color (hex)، created_at (UTC ISO)
      - area_m2, perimeter_m (ژئودتیک)
      - centroid_lon/lat, bbox
      - حفظ سایر فیلدهای ورودی کاربر
    """
    props_in = (feature.get("properties") or {}).copy()
    geom = _make_valid(shape_from_geojson(feature.get("geometry")))

    # UID
    use_uuid = bool(getattr(settings, "USE_UUID_UID", False))
    uid = props_in.get("uid")
    if not uid:
        uid = str(uuid.uuid4()) if use_uuid else f"poly_{idx+1:06d}"

    # Label / Label List / Source
    label, labels_list, label_source = _extract_label_and_list(props_in)

    # class_id از ورودی یا نگاشت برچسب‌ها
    cls = props_in.get("class_id")
    if cls is None:
        label_map = getattr(settings, "LABEL_CLASS_MAP", {}) or {}
        # اول: از label تکی
        if label and label in label_map:
            cls = int(label_map[label])
        # اگر نبود و labels_list چندتایی داشتیم، اولین مورد موجود در نگاشت
        if cls is None and labels_list:
            for it in labels_list:
                if it in label_map:
                    cls = int(label_map[it])
                    break
        if cls is None:
            cls = 1  # پیش‌فرض Vegetation

    color = (props_in.get("color") or "#00ff00").lower()

    # متریک‌ها
    area_m2, perimeter_m = _geodesic_metrics(geom)
    c = geom.centroid
    centroid_lon, centroid_lat = float(c.x), float(c.y)
    minx, miny, maxx, maxy = geom.bounds

    # زمان ایجاد
    created_at = props_in.get("created_at") or datetime.now(timezone.utc).isoformat()

    # سایر فیلدها را هم نگه داریم (اما کلیدهای نهایی را overwrite می‌کنیم)
    extras = {k: v for k, v in props_in.items()}

    props_out = {
        **extras,
        "uid": uid,
        "label": label,
        "labels_list": labels_list,      # اگر از Fruit Type چندتایی بود
        "label_source": label_source,    # "Fruit Type"/"label"/None (برای اطلاع)
        "class_id": int(cls),
        "color": color,
        "created_at": created_at,
        "area_m2": float(area_m2),
        "perimeter_m": float(perimeter_m),
        "centroid_lon": centroid_lon,
        "centroid_lat": centroid_lat,
        "bbox": [float(minx), float(miny), float(maxx), float(maxy)],
    }
    return props_out


# --------------------------------------------------------------------------- #
# Public API                                                                  #
# --------------------------------------------------------------------------- #

def save_polygons_fc(fc: dict) -> tuple[bool, str]:
    """
    ذخیره‌ی FeatureCollection (هر CRS):
      1) به GeoDataFrame → CRS=WGS84
      2) اعتبارسنجی هندسه‌ها و محاسبه‌ی متادیتا + نرمال‌سازی برچسب (Fruit Type/label)
      3) ذخیره‌ی GeoJSON غنی‌شده + Shapefile سازگار
    """
    if not fc or fc.get("type") != "FeatureCollection":
        return False, "invalid geojson"

    # اطمینان از وجود دایرکتوری خروجی
    settings.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    gdf = _to_gdf_fc_any_crs(fc)
    if gdf.empty:
        # خروجی خالی هم ذخیره می‌کنیم
        empty_fc = {"type": "FeatureCollection", "features": []}
        settings.POLYGONS_GEOJSON.write_text(json.dumps(empty_fc, ensure_ascii=False), encoding="utf-8")
        try:
            gpd.GeoDataFrame.from_features(empty_fc, crs="EPSG:4326").to_file(
                settings.POLYGONS_SHP, driver="ESRI Shapefile"
            )
        except Exception as e:
            print("[WARN] empty shapefile save failed:", e)
        return True, "ok"

    # اطمینان از معتبر بودن هندسه‌ها
    try:
        gdf["geometry"] = gdf["geometry"].apply(_make_valid)
    except Exception:
        pass

    # بازتبدیل به FeatureCollection (WGS84) برای enrich
    feats = json.loads(gdf.to_json())["features"]
    out_feats = []
    for i, f in enumerate(feats):
        if not f.get("geometry"):
            continue
        f["properties"] = _ensure_properties(f, i)
        out_feats.append(f)

    out_fc = {"type": "FeatureCollection", "features": out_feats}

    # ذخیره GeoJSON
    try:
        settings.POLYGONS_GEOJSON.write_text(json.dumps(out_fc, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        return False, f"failed to write GeoJSON: {e}"

    # ذخیره Shapefile (سازگار با محدودیت نام ستون‌ها)
    try:
        gdf2 = gpd.GeoDataFrame.from_features(out_fc, crs="EPSG:4326")
        if not gdf2.empty:
            gdf2 = _shorten_columns_for_shp(gdf2)
            gdf2.to_file(settings.POLYGONS_SHP, driver="ESRI Shapefile")
    except Exception as e:
        print("[WARN] shapefile save failed:", e)

    return True, "ok"


def load_polygons_as_geojson() -> dict:
    """
    خواندن خروجی ذخیره‌شده به صورت FeatureCollection (GeoJSON).
    اگر موجود نبود، FeatureCollection خالی برمی‌گرداند.
    """
    try:
        if settings.POLYGONS_GEOJSON.exists():
            return json.loads(settings.POLYGONS_GEOJSON.read_text(encoding="utf-8"))
    except Exception as e:
        print("[WARN] load_polygons_as_geojson failed:", e)
    return {"type": "FeatureCollection", "features": []}


def load_polygons_as_gdf() -> gpd.GeoDataFrame:
    """
    خواندن خروجی ذخیره‌شده به صورت GeoDataFrame (EPSG:4326).
    """
    fc = load_polygons_as_geojson()
    return gpd.GeoDataFrame.from_features(fc, crs="EPSG:4326")