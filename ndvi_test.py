# ndvi_test.py
from pathlib import Path
import numpy as np
from PIL import Image
import rasterio

S2_JP2_DIR: Path = Path(r"/Users/ali/Downloads/FilesManualGroundTruth (1)/S2C_MSIL2A_20250607T070641_N0511_R106_T39RXN_20250607T105318.SAFE/GRANULE/L2A_T39RXN_A003937_20250607T071857/IMG_DATA/R10m")

def find(glob):
    for p in S2_JP2_DIR.glob(glob):
        return p
    raise FileNotFoundError(glob)

with rasterio.open(find("*_B04_10m.jp2")) as src:
    red = src.read(1).astype(np.float32)
    nod = src.nodata
    if nod is not None: red[red==nod]=np.nan

with rasterio.open(find("*_B08_10m.jp2")) as src:
    nir = src.read(1).astype(np.float32)
    nod = src.nodata
    if nod is not None: nir[nir==nod]=np.nan

den = nir + red
ndvi = (nir - red) / np.where(den == 0, np.nan, den)
ndvi = np.clip(ndvi, -1, 1)

print("NDVI stats:", np.nanmin(ndvi), np.nanmax(ndvi), np.nanmean(ndvi))

vis = ((ndvi + 1) * 127.5).astype(np.uint8)
Image.fromarray(vis, mode='L').save("ndvi_gray_test.png")
thr = 0.3
mask = (ndvi >= thr).astype(np.uint8)*255
Image.fromarray(mask, mode='L').save("ndvi_mask_test.png")
print("NZ:", int((mask>0).sum()))