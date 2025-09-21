# config.py
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = 2_000_000_000


@dataclass
class Settings:
    # روت پروژه (پدرِ پوشه‌ی config.py)
    BASE_DIR: Path = Path(__file__).resolve().parent

    # پوشه‌های اصلی
    OUTPUT_DIR: Path = field(default_factory=lambda: Path(__file__).resolve().parent / "output")
    SCENES_DIR: Path  = field(default_factory=lambda: Path(__file__).resolve().parent / "data" / "scenes")

    # Sentinel-2
    S2_JP2_DIR: Optional[Path] = None
    S2_BANDS: Dict[str, str] = field(default_factory=lambda: {
        "R": "B04",
        "G": "B03",
        "B": "B02",
        "NIR": "B08",
    })
    BACKDROP_IMAGE: Path = field(init=False)
    S2_RGB_TIF: Path     = field(init=False)

    # ماسک کلی صحنه (در صورت نیاز)
    MASK_PNG: Path = field(init=False)

    # مسیرهای شِیپ‌فایل و خروجی GeoJSON
    POLYGONS_SHP_DIR: Path = field(default_factory=lambda: Path(__file__).resolve().parent / "data" / "polygons" / "shp")
    POLYGONS_OUT_DIR: Path = field(default_factory=lambda: Path(__file__).resolve().parent / "output" / "polygons")
    POLYGONS_GEOJSON: Path = field(init=False)

    # کلاس‌ها
    CLASS_LIST: List[Dict] = field(default_factory=lambda: [
        {"name": "Background",             "id": 0, "color": "#000000"},
        {"name": "پوشش گیاهی پرتراکم",    "id": 1, "color": "#106c2a"},
        {"name": "پوشش گیاهی کم‌تراکم",   "id": 2, "color": "#7dd37a"},
        {"name": "گردو",                   "id": 3, "color": "#8b5a2b"},
        {"name": "پسته",                   "id": 4, "color": "#93c572"},
        {"name": "نخیلات",                 "id": 5, "color": "#1b5e20"},
        {"name": "مرکبات",                 "id": 6, "color": "#ff8c00"},
        {"name": "سیب",                    "id": 7, "color": "#ffd60a"},
    ])
    DEFAULT_BRUSH_SIZE: int = 16
    DEFAULT_BRUSH_SHAPE: str = "circle"

    # سایر پارامترها
    NDVI_DEFAULT_THRESHOLD: float = 0.2
    BOA_ADD_OFFSET: float = -1000.0
    BOA_QUANT: float = 10000.0
    BAD_DN_VALUES: Tuple[int, int] = (0, 65535)

    LABEL_CLASS_MAP: Dict[str, int] = field(default_factory=dict)
    USE_UUID_UID: bool = False

    # مدل
    MODELS_DIR: Path = field(init=False)
    ACTIVE_MODEL_PATH: Path = field(init=False)
    MODEL_TYPE: str = "onnx"
    MODEL_BANDS: List[str] = field(default_factory=lambda: ["B02", "B03", "B04", "B08"])
    MODEL_INPUT_SIZE: int = 256
    MODEL_NUM_CLASSES: int = 3
    MODEL_MEAN: List[float] = field(default_factory=lambda: [0.3, 0.3, 0.3, 0.3])
    MODEL_STD:  List[float] = field(default_factory=lambda: [0.2, 0.2, 0.2, 0.2])
    MODEL_OVERLAP: int = 32
    MODEL_BATCH_TILES: int = 8

    # فایل‌های صحنه و هم‌ترازی
    ALIGN_OFFSET_FILE: Path = field(init=False)
    SELECTED_SCENE_FILE: Path = field(init=False)

    # Tile/Grid/UI
    TILE_GRID_N: int = 3
    QUICKLOOK_MAX_W: int = 2048
    TILE_BLOCK_SIZE: int = 1024

    def __post_init__(self):
        # پوشه‌ها
        self.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        self.SCENES_DIR.mkdir(parents=True, exist_ok=True)

        # پوشه‌ی مدل‌ها
        self.MODELS_DIR = self.OUTPUT_DIR / "models"
        self.MODELS_DIR.mkdir(parents=True, exist_ok=True)

        # مسیرهای خروجی
        self.BACKDROP_IMAGE      = self.OUTPUT_DIR / "rgb_quicklook.png"
        self.S2_RGB_TIF          = self.OUTPUT_DIR / "s2_rgb.tif"
        self.MASK_PNG            = self.OUTPUT_DIR / "mask.png"
        self.ACTIVE_MODEL_PATH   = self.MODELS_DIR / "active.onnx"
        self.ALIGN_OFFSET_FILE   = self.OUTPUT_DIR / "align_offset.json"
        self.SELECTED_SCENE_FILE = self.OUTPUT_DIR / "selected_scene.json"

        # پلی‌گون‌ها
        self.POLYGONS_OUT_DIR.mkdir(parents=True, exist_ok=True)
        self.POLYGONS_GEOJSON = self.POLYGONS_OUT_DIR / "current.geojson"

    @property
    def has_scene(self) -> bool:
        return isinstance(self.S2_JP2_DIR, Path) and self.S2_JP2_DIR.exists()

    def set_r10m_dir(self, p: Path) -> None:
        self.S2_JP2_DIR = Path(p)


settings = Settings()