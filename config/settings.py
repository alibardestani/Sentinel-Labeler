# config/settings.py
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

OUTPUT_DIR = BASE_DIR / "data" / "output"
SCENES_DIR = BASE_DIR / "data" / "scenes"
MODELS_DIR = BASE_DIR / "data" / "models"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
SCENES_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

SELECTED_SCENE_FILE = OUTPUT_DIR / "selected_scene.json"

S2_RGB_TIF      = OUTPUT_DIR / "rgb.tif"
BACKDROP_IMAGE  = OUTPUT_DIR / "rgb_quicklook.png"
ALIGN_OFFSET_FILE = OUTPUT_DIR / "align_offset.json"

MASK_PNG         = OUTPUT_DIR / "mask.png"

POLYGONS_SHP_DIR = BASE_DIR / "data/polygons/shp"
POLYGONS_OUT_DIR = BASE_DIR / "output/polygons"
POLYGONS_GEOJSON = POLYGONS_OUT_DIR / "current.geojson"