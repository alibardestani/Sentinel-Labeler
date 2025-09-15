# services/polygons.py
from __future__ import annotations
import json
from pathlib import Path
from typing import Tuple, Optional, List
import geopandas as gpd

from config import settings
from services.s2 import current_selected_scene

POLY_DIR = settings.OUTPUT_DIR / "polygons"

def _scene_id() -> Optional[str]:
    sc = current_selected_scene()
    return sc.id if sc else None

def _geojson_candidates(scene_id: Optional[str]) -> List[Path]:
    cands: List[Path] = []
    if scene_id:
        cands += [
            POLY_DIR / f"{scene_id}.geojson",
            POLY_DIR / f"{scene_id}.json",
        ]
    cands += [
        POLY_DIR / "subset.geojson",
        POLY_DIR / "polygons.geojson",
        settings.POLYGONS_GEOJSON,  # بکاپ قدیمی
    ]
    return cands

def _shapefile_stems(scene_id: Optional[str]) -> List[str]:
    stems: List[str] = []
    if scene_id:
        stems += [scene_id]
    stems += ["subset", "polygons"]
    return stems

def _find_any_shapefile(scene_id: Optional[str]) -> Optional[Path]:
    stems = _shapefile_stems(scene_id)
    for st in stems:
        shp = POLY_DIR / f"{st}.shp"
        if shp.exists():
            return shp
    shp_files = list(POLY_DIR.glob("*.shp"))
    if len(shp_files) == 1:
        return shp_files[0]
    if scene_id:
        for p in shp_files:
            if scene_id in p.stem:
                return p
    return shp_files[0] if shp_files else None

def load_polygons_text() -> Optional[str]:
    POLY_DIR.mkdir(parents=True, exist_ok=True)
    sid = _scene_id()

    for p in _geojson_candidates(sid):
        if p and p.exists():
            try:
                return p.read_text(encoding="utf-8")
            except Exception:
                pass

    shp = _find_any_shapefile(sid)
    if shp and shp.exists():
        try:
            gdf = gpd.read_file(shp)
            if not gdf.empty and gdf.crs is not None:
                try:
                    gdf = gdf.to_crs(epsg=4326)
                except Exception:
                    pass
            return gdf.to_json()
        except Exception:
            return None

    return None

def _output_geojson_path(scene_id: Optional[str]) -> Path:
    POLY_DIR.mkdir(parents=True, exist_ok=True)
    if scene_id:
        return POLY_DIR / f"{scene_id}.geojson"
    return POLY_DIR / "polygons.geojson"

def save_polygons_fc(fc: dict) -> Tuple[bool, str]:
    try:
        if not fc or fc.get("type") != "FeatureCollection":
            return False, "invalid geojson"
        sid = _scene_id()
        outp = _output_geojson_path(sid)
        outp.parent.mkdir(parents=True, exist_ok=True)
        tmp = outp.with_suffix(outp.suffix + ".tmp")
        tmp.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
        tmp.replace(outp)
        return True, "ok"
    except Exception as e:
        return False, str(e)