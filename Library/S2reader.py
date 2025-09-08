from __future__ import annotations
import time
"""
Sentinel-2 product reader utilities.

This module provides a single public class, `SentinelProductReader`, that reads
bands and masks from a *zipped* Sentinel-2 Level-2A product (SAFE format).

Key features:
- Read bands directly from the ZIP without unpacking.
- Resolve correct resolution (10 m / 20 m / 60 m) of each band using file names.
- Build a valid/invalid binary mask from the Scene Classification Layer (SCL).
- Stack multiple bands to a common grid with configurable resampling.

Dependencies: rasterio, numpy
"""

from dataclasses import dataclass
from typing import Dict, Iterable, List, Literal, Optional, Sequence, Tuple
import os
import re
import zipfile

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject


SCL_CODE_MEANINGS: Dict[int, str] = {
    # From Sentinel-2 L2A Scene Classification Layer (SCL)
    # 0: NO_DATA may appear in some products; often 0 is not used and nodata is 0.
    1: "Saturated/Defective",
    2: "Dark features / Shadows",
    3: "Cloud shadows",
    4: "Vegetation",
    5: "Bare soils",
    6: "Water",
    7: "Unclassified",
    8: "Cloud medium probability",
    9: "Cloud high probability",
    10: "Thin cirrus",
    11: "Snow or ice",
}


def _resampling_from_str(name: str) -> Resampling:
    """Map a human-friendly name to a rasterio.Resampling enum.

    Supported names: "nearest", "bilinear", "cubic", "average", "mode", "max",
    "min", "med", "q1", "q3".
    """
    name = name.lower()
    mapping = {
        "nearest": Resampling.nearest,
        "bilinear": Resampling.bilinear,
        "cubic": Resampling.cubic,
        "average": Resampling.average,
        "mode": Resampling.mode,
        "max": Resampling.max,
        "min": Resampling.min,
        "med": Resampling.med,
        "q1": Resampling.q1,
        "q3": Resampling.q3,
    }
    if name not in mapping:
        raise ValueError(f"Unsupported resampling '{name}'. Supported: {', '.join(mapping)}")
    return mapping[name]


@dataclass
class BandRef:
    band: str  # e.g., "B02"
    res_m: int  # 10, 20, 60
    path_in_zip: str  # internal path (.jp2) inside the ZIP


class SentinelProductReader:
    """Read Sentinel-2 Level-2A bands and masks directly from a .zip product.

    Parameters
    ----------
    zip_path : str
        Absolute or relative path to the Sentinel-2 SAFE product ZIP file.

    Notes
    -----
    This class inspects the filenames inside the ZIP and builds a quick index of
    available band rasters (JP2) at their native resolutions. It **does not**
    unpack the archive. All I/O uses GDAL's `/vsizip/` virtual file system via
    rasterio.

    Examples
    --------
    >>> BAND_RES = {"B01": 60, "B02": 10, "B03": 10, "B04": 10, "B05": 20,
    ...             "B06": 20, "B07": 20, "B08": 10, "B8A": 20, "B09": 60,
    ...             "B11": 20, "B12": 20}
    >>> BANDS = ["B01","B02","B03","B04","B05","B06","B07","B08","B8A","B09","B11","B12"]
    >>> rdr = SentinelProductReader("S2A_MSIL2A_20240221T083121_N0509_R092_T35RLU_20240221T111234.zip")
    >>> arr, profile = rdr.read_band("B04")  # choose native resolution automatically
    >>> mask = rdr.build_valid_mask(invalid_scl_codes=[0, 1, 3, 8, 9, 10])
    >>> stack, stack_profile = rdr.stack_bands(
    ...     bands=["B04", "B03", "B02"],
    ...     band_res=BAND_RES,
    ...     align_to="min",  # upscale all to finest resolution present
    ...     resampling="bilinear",
    ... )
    """

    def __init__(self, zip_path: str):
        self.zip_path = os.fspath(zip_path)
        if not os.path.exists(self.zip_path):
            raise FileNotFoundError(self.zip_path)
        self._band_index: Dict[Tuple[str, int], BandRef] = {}
        self._scl_path: Optional[str] = None
        self._index_archive()

    # ------------------------- Discovery & Indexing ------------------------- #
    def _index_archive(self) -> None:
        """Scan the ZIP and index band JP2s and the SCL raster.

        A Sentinel-2 L2A ZIP typically contains JP2 files named like:
        ``..._B02_10m.jp2`` or ``..._SCL_20m.jp2`` within GRANULE/.../IMG_DATA/.
        This method builds a mapping (band, res_m) -> BandRef, and stores the SCL
        path if found.
        """
        band_re = re.compile(r"_B(\d{2}|8A)_(10|20|60)m\.jp2$")
        scl_re = re.compile(r"_SCL_(10|20|60)m\.jp2$")
        with zipfile.ZipFile(self.zip_path, "r") as z:
            for name in z.namelist():
                if band_re.search(name):
                    b, res = band_re.search(name).groups()
                    band = f"B{b}"
                    res_m = int(res)
                    self._band_index[(band, res_m)] = BandRef(band, res_m, name)
                elif scl_re.search(name):
                    self._scl_path = name

    # ------------------------------ Utilities ------------------------------ #
    def _vsizip(self, inner: str) -> str:
        return f"/vsizip/{os.path.abspath(self.zip_path)}/{inner}"

    def _open_ref(self, band: str, res_m: Optional[int]) -> Tuple[rasterio.DatasetReader, BandRef]:
        # Pick a JP2 matching the band and resolution; if res is None, pick the
        # *native* (i.e., the one that exists) with the finest resolution.
        candidates = [br for (b, r), br in self._band_index.items() if b == band]
        if not candidates:
            raise ValueError(f"Band {band} not found in {os.path.basename(self.zip_path)}")
        if res_m is not None:
            match = self._band_index.get((band, res_m))
            if match is None:
                avail = sorted({c.res_m for c in candidates})
                raise ValueError(f"Requested {band} at {res_m} m not available. Have: {avail}")
            br = match
        else:
            # choose finest resolution available
            br = sorted(candidates, key=lambda x: x.res_m)[0]
        path = self._vsizip(br.path_in_zip)
        ds = rasterio.open(path)
        return ds, br

    @staticmethod
    def _match_profile(ds: rasterio.DatasetReader) -> dict:
        profile = ds.profile.copy()
        # Some JP2s may not set nodata; allow None
        return profile

    # ------------------------- Public API: Bands ---------------------------- #
    def read_band(self, band: str, resolution: Optional[int] = None) -> Tuple[np.ndarray, dict]:
        """Read a single band as a 2D array from the ZIP.

        Parameters
        ----------
        band : str
            Band identifier such as "B02", "B8A", "B11".
        resolution : int, optional
            Requested native resolution in meters (10, 20, or 60). If omitted,
            the finest available resolution for the band is used.

        Returns
        -------
        array : numpy.ndarray
            2D array of the band (dtype as stored on disk).
        profile : dict
            Raster profile suitable for writing with rasterio (includes CRS,
            transform, width, height, dtype, count=1, etc.).
        """
        with rasterio.Env():
            time_1s = time.time()
            ds, _ = self._open_ref(band, resolution)
            time_1e = time.time()
            print('open ref time:' , time_1e-time_1s)
            with ds:
                arr = ds.read(1)
                profile = self._match_profile(ds)
                crs = ds.crs
                bounds = ds.bounds
        return arr, profile , crs , bounds

    # ----------------------- Public API: Valid Mask ------------------------ #
    def build_valid_mask(
        self,
        invalid_scl_codes: Sequence[int],
        target_resolution: Optional[int] = None,
        resampling: str = "nearest",
        invert: bool = True,
    ) -> Tuple[np.ndarray, dict]:
        """Build a binary mask of valid/invalid pixels from SCL.

        Parameters
        ----------
        invalid_scl_codes : Sequence[int]
            List of SCL class codes considered **invalid** data (e.g., no-data,
            clouds, cloud shadows). The commonly used codes include:

            - 0 : No data (may appear in some products)
            - 1 : Saturated/Defective
            - 3 : Cloud shadows
            - 8 : Cloud medium probability
            - 9 : Cloud high probability
            - 10: Thin cirrus
            - 11: Snow or ice (often excluded for surface reflectance analytics)

            See `SCL_CODE_MEANINGS` for a more complete mapping of codes.
        target_resolution : int, optional
            Desired output resolution in meters. If omitted, the **native SCL**
            resolution is used (commonly 20 m for L2A). If 10 or 60 are given,
            the mask will be resampled using the method below.
        resampling : {"nearest", "bilinear", "cubic", ...}, default "nearest"
            Resampling algorithm when scaling to `target_resolution`. For masks,
            "nearest" is recommended.
        invert : bool, default True
            If True, returns a mask where **True means VALID** (i.e., not in the
            `invalid_scl_codes`). If False, True means INVALID.

        Returns
        -------
        mask : numpy.ndarray of dtype bool
            Binary mask. True = valid (by default) or invalid if `invert=False`.
        profile : dict
            Raster profile aligned to the mask grid and dtype=uint8.
        """
        if self._scl_path is None:
            raise RuntimeError("SCL raster not found in the ZIP product.")

        with rasterio.Env():
            scl_ds = rasterio.open(self._vsizip(self._scl_path))
            with scl_ds:
                scl = scl_ds.read(1)
                base_profile = scl_ds.profile.copy()

                # Build invalid mask based on codes from the SCL raster
                invalid = np.isin(scl, np.array(invalid_scl_codes, dtype=scl.dtype))
                mask_bool = ~invalid if invert else invalid

                out_profile = base_profile

                if target_resolution is not None and target_resolution != self.native_resolution_of_path(self._scl_path):
                    # Need to resample to a different resolution
                    res_enum = _resampling_from_str(resampling)

                    # Compute scaling factor by resolution ratio
                    native_res = self.native_resolution_of_path(self._scl_path)
                    scale = native_res / float(target_resolution)

                    out_height = int(round(scl_ds.height * scale))
                    out_width = int(round(scl_ds.width * scale))
                    out_transform = scl_ds.transform * scl_ds.transform.scale(
                        scl_ds.width / out_width, scl_ds.height / out_height
                    )

                    dest = np.empty((out_height, out_width), dtype=scl.dtype)

                    reproject(
                        source=scl,
                        destination=dest,
                        src_transform=scl_ds.transform,
                        src_crs=scl_ds.crs,
                        dst_transform=out_transform,
                        dst_crs=scl_ds.crs,
                        resampling=res_enum,
                    )

                    invalid = np.isin(dest, np.array(invalid_scl_codes, dtype=dest.dtype))
                    mask_bool = ~invalid if invert else invalid

                    out_profile.update({
                        "height": out_height,
                        "width": out_width,
                        "transform": out_transform,
                        "dtype": "uint8",
                    })
                else:
                    out_profile.update({"dtype": "uint8"})

        return mask_bool.astype(bool), out_profile

    # -------------------------- Public API: Stack -------------------------- #
    def stack_bands(
        self,
        bands: Sequence[str],
        band_res: Dict[str, int],
        align_to: Literal["min", "max", 10, 20, 60] = "min",
        resampling: str = "bilinear",
        force_resample_single: bool = False,
    ) -> Tuple[np.ndarray, dict]:
        """Read and stack bands to a common grid.

        Parameters
        ----------
        bands : sequence of str
            Bands to read and stack (e.g., ["B04", "B03", "B02"]). The output
            is ordered exactly as provided.
        band_res : dict
            Mapping from band name to desired **native** resolution in meters,
            e.g., ``{"B01": 60, "B02": 10, ...}``. This is important because
            some bands exist in multiple resolutions. The mapping tells the
            reader which native resolution JP2 to load for each band.
        align_to : {"min", "max", 10, 20, 60}, default "min"
            Target grid resolution:
            - "min": upscale everything to the **finest** among the inputs (e.g., 10 m).
            - "max": downscale everything to the **coarsest** among the inputs (e.g., 60 m or 20 m).
            - 10/20/60: force this specific output resolution.
        resampling : str, default "bilinear"
            Resampling algorithm used for continuous reflectance bands. Common
            choices are "bilinear" (safe default) or "nearest" (categorical).
        force_resample_single : bool, default False
            If only one band is requested, by default no resampling is performed
            and the band is returned at its native grid. Set True to still force
            resampling to the `align_to` grid.

        Returns
        -------
        stack : numpy.ndarray
            3D array shaped (N, H, W) where N = len(bands).
        profile : dict
            Raster profile describing the common grid (count=N, dtype of input).
        """
        if len(bands) == 0:
            raise ValueError("No bands requested for stacking.")

        # Open all requested bands at their chosen *native* resolutions.
        opened: List[Tuple[str, BandRef, rasterio.DatasetReader, np.ndarray]] = []
        try:
            for b in bands:
                res = band_res.get(b)
                ds, br = self._open_ref(b, res)
                arr = ds.read(1)
                opened.append((b, br, ds, arr))
        finally:
            # We'll close datasets after stacking using their context managers
            pass

        # Determine target output resolution
        native_res_list = [br.res_m for (_, br, _, __) in opened]
        if align_to == "min":
            target_res = min(native_res_list)
        elif align_to == "max":
            target_res = max(native_res_list)
        elif align_to in (10, 20, 60):
            target_res = int(align_to)  # type: ignore[assignment]
        else:
            raise ValueError("align_to must be 'min', 'max', or one of 10, 20, 60")

        # If single band and not forcing, short-circuit
        if len(bands) == 1 and not force_resample_single:
            b, br, ds, arr = opened[0]
            profile = self._match_profile(ds)
            ds.close()
            return np.expand_dims(arr, 0), {**profile, "count": 1}

        # Pick a reference grid: choose the first band whose native resolution
        # equals the target_res; otherwise, resample the first band to target.
        ref_idx = next((i for i, (_, br, _, __) in enumerate(opened) if br.res_m == target_res), 0)
        _, ref_br, ref_ds, ref_arr = opened[ref_idx]
        ref_profile = self._match_profile(ref_ds)

        if ref_br.res_m != target_res:
            # Compute ref grid dimensions/transform by scaling
            scale = ref_br.res_m / float(target_res)
            out_h = int(round(ref_ds.height * scale))
            out_w = int(round(ref_ds.width * scale))
            out_transform = ref_ds.transform * ref_ds.transform.scale(
                ref_ds.width / out_w, ref_ds.height / out_h
            )
            ref_crs = ref_ds.crs
        else:
            out_h, out_w = ref_ds.height, ref_ds.width
            out_transform = ref_ds.transform
            ref_crs = ref_ds.crs

        # Prepare output stack
        stack_dtype = ref_arr.dtype
        stack = np.empty((len(bands), out_h, out_w), dtype=stack_dtype)

        # Resampling setup
        res_enum = _resampling_from_str(resampling)

        # For each band, reproject onto the target grid
        for i, (b, br, ds, arr) in enumerate(opened):
            if br.res_m == target_res and ref_ds.crs == ds.crs and ref_ds.transform == ds.transform:
                # Same grid; fast path
                if arr.shape != (out_h, out_w):
                    dest = np.empty((out_h, out_w), dtype=arr.dtype)
                    reproject(
                        source=arr,
                        destination=dest,
                        src_transform=ds.transform,
                        src_crs=ds.crs,
                        dst_transform=out_transform,
                        dst_crs=ref_crs,
                        resampling=res_enum,
                    )
                    stack[i] = dest
                else:
                    stack[i] = arr
            else:
                dest = np.empty((out_h, out_w), dtype=arr.dtype)
                reproject(
                    source=arr,
                    destination=dest,
                    src_transform=ds.transform,
                    src_crs=ds.crs,
                    dst_transform=out_transform,
                    dst_crs=ref_crs,
                    resampling=res_enum,
                )
                stack[i] = dest
            ds.close()

        profile = {
            **ref_profile,
            "height": out_h,
            "width": out_w,
            "transform": out_transform,
            "crs": ref_crs,
            "count": len(bands),
        }
        return stack, profile

    # ------------------------- Public API: Export --------------------------- #
    def export_esri_aligned_tif(
        self,
        band: str,
        out_tif: str,
        resolution: Optional[int] = None,
    ) -> dict:
        """Export a band to GeoTIFF aligned for ESRI basemaps via EPSG:3857.

        Workflow
        --------
        1) Read the requested band from the ZIP at its chosen *native* resolution.
        2) Reproject from the source UTM CRS to **EPSG:3857** using *nearest* resampling.
        3) Reproject the intermediate raster from **EPSG:3857** to **EPSG:4326**.
        4) Write the final GeoTIFF at EPSG:4326 to `out_tif`.

        Parameters
        ----------
        band : str
            Band identifier such as "B02", "B8A", "B11".
        out_tif : str
            Output file path for the GeoTIFF (will be overwritten if exists).
        resolution : int, optional
            If provided, pick that native resolution variant (10/20/60 m) of the
            band when loading from the ZIP.

        Returns
        -------
        profile : dict
            The raster profile used to write the GeoTIFF (driver, crs, transform, etc.).

        Notes
        -----
        - Nearest-neighbor resampling is used in **both** reprojection steps to
          preserve digital numbers exactly, as often desired when aligning to
          ESRI basemaps.
        - This method only touches a single band. If you need to export a stack,
          use `stack_bands` first and then write manually.
        """
        # Local imports to avoid touching global import section
        from rasterio.warp import calculate_default_transform
        from rasterio.transform import array_bounds
        from rasterio.crs import CRS

        with rasterio.Env():
            ds, _ = self._open_ref(band, resolution)
            with ds:
                src_crs = ds.crs
                if src_crs is None:
                    raise ValueError("Source CRS is missing on the input dataset.")
                src_transform = ds.transform
                src_dtype = ds.dtypes[0]
                # Try to get nodata in a robust way
                src_nodata = getattr(ds, "nodata", None)
                if src_nodata is None:
                    try:
                        vals = ds.nodatavals
                        src_nodata = vals[0] if vals and vals[0] is not None else None
                    except Exception:
                        src_nodata = None

                # ---------------- Step 1: to EPSG:3857 ---------------- #
                crs_3857 = CRS.from_epsg(3857)
                left, bottom, right, top = ds.bounds
                tr_3857, w_3857, h_3857 = calculate_default_transform(
                    src_crs, crs_3857, ds.width, ds.height, left, bottom, right, top
                )
                data_3857 = np.empty((h_3857, w_3857), dtype=src_dtype)
                reproject(
                    source=rasterio.band(ds, 1),
                    destination=data_3857,
                    src_transform=src_transform,
                    src_crs=src_crs,
                    dst_transform=tr_3857,
                    dst_crs=crs_3857,
                    resampling=Resampling.nearest,
                    src_nodata=src_nodata,
                    dst_nodata=src_nodata,
                )

                # ---------------- Step 2: 3857 -> EPSG:4326 ------------- #
                crs_4326 = CRS.from_epsg(4326)
                l2, b2, r2, t2 = array_bounds(h_3857, w_3857, tr_3857)
                tr_4326, w_4326, h_4326 = calculate_default_transform(
                    crs_3857, crs_4326, w_3857, h_3857, l2, b2, r2, t2
                )
                data_4326 = np.empty((h_4326, w_4326), dtype=src_dtype)
                reproject(
                    source=data_3857,
                    destination=data_4326,
                    src_transform=tr_3857,
                    src_crs=crs_3857,
                    dst_transform=tr_4326,
                    dst_crs=crs_4326,
                    resampling=Resampling.nearest,
                    src_nodata=src_nodata,
                    dst_nodata=src_nodata,
                )

            # Prepare output profile and write GeoTIFF
            # (use a copy of the original dataset profile without altering upstream state)
            out_profile = {
                "driver": "GTiff",
                "height": h_4326,
                "width": w_4326,
                "count": 1,
                "dtype": src_dtype,
                "crs": crs_4326,
                "transform": tr_4326,
                "compress": "deflate",
                "predictor": 2 if np.issubdtype(np.dtype(src_dtype), np.floating) else 1,
                "nodata": src_nodata,
            }
            with rasterio.open(out_tif, "w", **out_profile) as dst:
                dst.write(data_4326, 1)

        return out_profile
    
    def export_esri_aligned_rgb_tif(
    self,
    out_tif: str,
    resolution: Optional[int] = None,
    ) -> dict:
        """Export an 8-bit RGB GeoTIFF aligned for ESRI basemaps via EPSG:3857.

        This method builds a natural-color RGB from Sentinel-2 bands:
        R = B04, G = B03, B = B02. It:
            1) reads each band from the ZIP at the requested native resolution
                (if provided; otherwise chooses the finest available per band),
            2) reprojects each band from the UTM source CRS to EPSG:3857 using
                **nearest** resampling onto a shared 3857 grid,
            3) reprojects that RGB from EPSG:3857 to EPSG:4326 (nearest),
            4) applies 2–98% percentile linear stretch **per-band** to produce
                8-bit channels, and
            5) writes a 3-band GeoTIFF in EPSG:4326 (pixel-interleaved, uint8).

        Parameters
        ----------
        out_tif : str
            Output file path for the RGB GeoTIFF (will be overwritten if exists).
        resolution : int, optional
            If given (10/20/60), selects that native resolution variant of each
            band when loading from the ZIP; otherwise the finest available is used.

        Returns
        -------
        profile : dict
            Raster profile used to write the GeoTIFF (driver, crs, transform, etc.).

        Notes
        -----
        - Output is **8-bit** per channel. Stretch uses percentile-based linear
            scaling (2–98%) as implemented in `stretch_band` below.
        - Nearest-neighbor resampling is used in both reprojection steps to keep
            crisp alignment with ESRI basemaps.
        """
        # Local imports to avoid editing global imports
        from rasterio.warp import calculate_default_transform
        from rasterio.transform import array_bounds
        from rasterio.crs import CRS

        # --- Percentile-based linear stretch to [0, 1]; then we'll scale to 0..255
        def stretch_band(band, low_pct=2, high_pct=98):
            p_low = np.nanpercentile(band, low_pct)
            p_high = np.nanpercentile(band, high_pct)
            stretched = (band - p_low) / (p_high - p_low)
            stretched = np.clip(stretched, 0, 1)
            return stretched

        # --- 0) Open R,G,B bands at desired/native resolution
        with rasterio.Env():
            # Red (B04)
            ds_r, _ = self._open_ref("B04", resolution)
            with ds_r:
                r = ds_r.read(1).astype(np.float32)
                src_crs = ds_r.crs
                if src_crs is None:
                    raise ValueError("Source CRS is missing on the input dataset (B04).")
                src_transform = ds_r.transform
                nodata_r = getattr(ds_r, "nodata", None) or (ds_r.nodatavals[0] if ds_r.nodatavals else None)

            # Green (B03)
            ds_g, _ = self._open_ref("B03", resolution)
            with ds_g:
                g = ds_g.read(1).astype(np.float32)
                if ds_g.crs != src_crs:
                    raise ValueError("CRS mismatch between bands (B03 vs B04).")
                nodata_g = getattr(ds_g, "nodata", None) or (ds_g.nodatavals[0] if ds_g.nodatavals else None)

            # Blue (B02)
            ds_b, _ = self._open_ref("B02", resolution)
            with ds_b:
                b = ds_b.read(1).astype(np.float32)
                if ds_b.crs != src_crs:
                    raise ValueError("CRS mismatch between bands (B02 vs B04).")
                nodata_b = getattr(ds_b, "nodata", None) or (ds_b.nodatavals[0] if ds_b.nodatavals else None)

            # --- 1) Reproject to shared EPSG:3857 grid (nearest)
            crs_3857 = CRS.from_epsg(3857)
            H_r, W_r = ds_r.height, ds_r.width
            left, bottom, right, top = ds_r.bounds
            tr_3857, w_3857, h_3857 = calculate_default_transform(
                src_crs, crs_3857, W_r, H_r, left, bottom, right, top
            )

            data_3857 = np.empty((3, h_3857, w_3857), dtype=np.float32)
            # R
            reproject(
                source=r,
                destination=data_3857[0],
                src_transform=src_transform,
                src_crs=src_crs,
                dst_transform=tr_3857,
                dst_crs=crs_3857,
                resampling=Resampling.nearest,
                src_nodata=nodata_r,
                dst_nodata=np.nan,
            )
            # G
            reproject(
                source=g,
                destination=data_3857[1],
                src_transform=ds_g.transform,
                src_crs=ds_g.crs,
                dst_transform=tr_3857,
                dst_crs=crs_3857,
                resampling=Resampling.nearest,
                src_nodata=nodata_g,
                dst_nodata=np.nan,
            )
            # B
            reproject(
                source=b,
                destination=data_3857[2],
                src_transform=ds_b.transform,
                src_crs=ds_b.crs,
                dst_transform=tr_3857,
                dst_crs=crs_3857,
                resampling=Resampling.nearest,
                src_nodata=nodata_b,
                dst_nodata=np.nan,
            )

            # --- 2) Reproject shared 3857 RGB to EPSG:4326 (nearest)
            crs_4326 = CRS.from_epsg(4326)
            l2, b2, r2, t2 = array_bounds(h_3857, w_3857, tr_3857)
            tr_4326, w_4326, h_4326 = calculate_default_transform(
                crs_3857, crs_4326, w_3857, h_3857, l2, b2, r2, t2
            )

            data_4326 = np.empty((3, h_4326, w_4326), dtype=np.float32)
            for i in range(3):
                reproject(
                    source=data_3857[i],
                    destination=data_4326[i],
                    src_transform=tr_3857,
                    src_crs=crs_3857,
                    dst_transform=tr_4326,
                    dst_crs=crs_4326,
                    resampling=Resampling.nearest,
                    src_nodata=np.nan,
                    dst_nodata=np.nan,
                )

        # --- 3) Per-band 2–98% stretch → uint8
        r8 = (stretch_band(data_4326[0]) * 255.0).round().astype(np.uint8)
        g8 = (stretch_band(data_4326[1]) * 255.0).round().astype(np.uint8)
        b8 = (stretch_band(data_4326[2]) * 255.0).round().astype(np.uint8)

        # Replace NaNs (if any survived as cast) to 0 (black)
        r8[np.isnan(data_4326[0])] = 0
        g8[np.isnan(data_4326[1])] = 0
        b8[np.isnan(data_4326[2])] = 0

        rgb8 = np.stack([r8, g8, b8], axis=0)

        # --- 4) Write the RGB GeoTIFF (EPSG:4326, uint8)
        out_profile = {
            "driver": "GTiff",
            "height": h_4326,
            "width": w_4326,
            "count": 3,
            "dtype": "uint8",
            "crs": crs_4326,
            "transform": tr_4326,
            "compress": "deflate",
            "predictor": 1,          # for byte data
            "interleave": "pixel",
            "photometric": "RGB",
            "nodata": 0,
        }
        with rasterio.open(out_tif, "w", **out_profile) as dst:
            dst.write(rgb8, indexes=[1, 2, 3])

        return out_profile
    
    def export_esri_aligned_rgba_tif(
        self,
        out_tif: str,
        resolution: Optional[int] = None,
    ) -> dict:
        """Export an 8-bit RGBA GeoTIFF aligned for ESRI basemaps via EPSG:3857.

        RGBA composition:
          R = B04, G = B03, B = B02, A = valid-data mask (0 outside reprojection footprint).
        Steps:
          1) Read B04/B03/B02 at desired native resolution (if given).
          2) Reproject UTM -> EPSG:3857 (nearest, dst_nodata=NaN).
          3) Reproject 3857 -> EPSG:4326 (nearest, preserve NaN).
          4) Per-band 2–98% percentile linear stretch -> uint8 for RGB.
          5) Alpha = 255 where all three channels are valid, else 0 (transparent).
          6) Write a 4-band GeoTIFF (uint8, EPSG:4326) and set color interpretation
             to (red, green, blue, alpha).

        Parameters
        ----------
        out_tif : str
            Output file path (will be overwritten).
        resolution : int, optional
            10/20/60 to pick a specific native JP2 variant; otherwise uses finest available.

        Returns
        -------
        profile : dict
            Raster profile used to write the GeoTIFF.
        """
        from rasterio.warp import calculate_default_transform
        from rasterio.transform import array_bounds
        from rasterio.crs import CRS
        from rasterio.enums import Resampling, ColorInterp

        def stretch_band(band, low_pct=2, high_pct=98):
            p_low = np.nanpercentile(band, low_pct)
            p_high = np.nanpercentile(band, high_pct)
            stretched = (band - p_low) / max(1e-6, (p_high - p_low))
            return np.clip(stretched, 0, 1)

        with rasterio.Env():
            # --- Read R, G, B at native/desired res
            ds_r, _ = self._open_ref("B04", resolution)
            with ds_r:
                r = ds_r.read(1).astype(np.float32)
                src_crs = ds_r.crs
                if src_crs is None:
                    raise ValueError("Source CRS is missing on B04.")
                src_transform = ds_r.transform
                nodata_r = getattr(ds_r, "nodata", None) or (ds_r.nodatavals[0] if ds_r.nodatavals else None)

            ds_g, _ = self._open_ref("B03", resolution)
            with ds_g:
                g = ds_g.read(1).astype(np.float32)
                if ds_g.crs != src_crs:
                    raise ValueError("CRS mismatch between B03 and B04.")
                nodata_g = getattr(ds_g, "nodata", None) or (ds_g.nodatavals[0] if ds_g.nodatavals else None)

            ds_b, _ = self._open_ref("B02", resolution)
            with ds_b:
                b = ds_b.read(1).astype(np.float32)
                if ds_b.crs != src_crs:
                    raise ValueError("CRS mismatch between B02 and B04.")
                nodata_b = getattr(ds_b, "nodata", None) or (ds_b.nodatavals[0] if ds_b.nodatavals else None)

            # --- UTM -> EPSG:3857 (nearest, dst_nodata=NaN)
            crs_3857 = CRS.from_epsg(3857)
            H, W = ds_r.height, ds_r.width
            left, bottom, right, top = ds_r.bounds
            tr_3857, w_3857, h_3857 = calculate_default_transform(
                src_crs, crs_3857, W, H, left, bottom, right, top
            )
            data_3857 = np.empty((3, h_3857, w_3857), dtype=np.float32)
            rasterio.warp.reproject(
                source=r, destination=data_3857[0],
                src_transform=src_transform, src_crs=src_crs,
                dst_transform=tr_3857,   dst_crs=crs_3857,
                resampling=Resampling.nearest,
                src_nodata=nodata_r, dst_nodata=np.nan
            )
            rasterio.warp.reproject(
                source=g, destination=data_3857[1],
                src_transform=ds_g.transform, src_crs=ds_g.crs,
                dst_transform=tr_3857,       dst_crs=crs_3857,
                resampling=Resampling.nearest,
                src_nodata=nodata_g, dst_nodata=np.nan
            )
            rasterio.warp.reproject(
                source=b, destination=data_3857[2],
                src_transform=ds_b.transform, src_crs=ds_b.crs,
                dst_transform=tr_3857,       dst_crs=crs_3857,
                resampling=Resampling.nearest,
                src_nodata=nodata_b, dst_nodata=np.nan
            )

            # --- 3857 -> EPSG:4326 (nearest)
            crs_4326 = CRS.from_epsg(4326)
            l2, b2, r2, t2 = array_bounds(h_3857, w_3857, tr_3857)
            tr_4326, w_4326, h_4326 = calculate_default_transform(
                crs_3857, crs_4326, w_3857, h_3857, l2, b2, r2, t2
            )
            data_4326 = np.empty((3, h_4326, w_4326), dtype=np.float32)
            for i in range(3):
                rasterio.warp.reproject(
                    source=data_3857[i], destination=data_4326[i],
                    src_transform=tr_3857,  src_crs=crs_3857,
                    dst_transform=tr_4326,  dst_crs=crs_4326,
                    resampling=Resampling.nearest,
                    src_nodata=np.nan, dst_nodata=np.nan
                )

        # --- Alpha: transparent where any channel is NaN (outside/rotated edges)
        valid = (~np.isnan(data_4326[0])) & (~np.isnan(data_4326[1])) & (~np.isnan(data_4326[2]))
        alpha8 = np.where(valid, 255, 0).astype(np.uint8)

        # --- Stretch RGB to uint8
        r8 = (stretch_band(data_4326[0]) * 255.0).round().astype(np.uint8); r8[~valid] = 0
        g8 = (stretch_band(data_4326[1]) * 255.0).round().astype(np.uint8); g8[~valid] = 0
        b8 = (stretch_band(data_4326[2]) * 255.0).round().astype(np.uint8); b8[~valid] = 0

        rgba8 = np.stack([r8, g8, b8, alpha8], axis=0)

        # --- Write RGBA GeoTIFF (no ALPHA creation option; set color interpretation instead)
        out_profile = {
            "driver": "GTiff",
            "height": h_4326,
            "width": w_4326,
            "count": 4,
            "dtype": "uint8",
            "crs": crs_4326,
            "transform": tr_4326,
            "compress": "deflate",
            "predictor": 1,
            "interleave": "pixel",
            "photometric": "RGB",
        }
        with rasterio.open(out_tif, "w", **out_profile) as dst:
            dst.write(rgba8, indexes=[1, 2, 3, 4])
            # Mark bands as RGBA so most software will treat the 4th as alpha:
            dst.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha)

        return out_profile
    
    def export_esri_aligned_rgba_grid_3x3(
        self,
        out_dir: str,
        resolution: Optional[int] = 10,
    ) -> list:
        """Export a 3x3 grid of ESRI-aligned 8-bit **RGBA** GeoTIFF patches.

        Each patch is built from Sentinel-2 natural-color bands (R=B04, G=B03, B=B02)
        and an **alpha** channel so that rotated/expanded areas after reprojection
        are transparent (not black).

        Workflow per patch
        ------------------
        1) Split the full native UTM grid into a 3x3 grid (≈ 10980x10980 → 9× ~3660x3660 @10m).
        2) For each window (patch), read B04/B03/B02.
        3) Reproject UTM  → EPSG:3857 (nearest, dst_nodata = NaN).
        4) Reproject 3857 → EPSG:4326 (nearest, preserve NaN).
        5) Per-band percentile stretch (2–98%) → 8-bit for RGB.
        6) Alpha = 255 where all three channels valid (not NaN), else 0.
        7) Write 4-band GeoTIFF (uint8, EPSG:4326) with color interpretation RGBA.

        Filenames
        ---------
        <TILE_ID>_<idx>.tif  where idx = 1..9 in row-major order (1=top-left).
        Example:  T39RXN_1.tif  ...  T39RXN_9.tif

        Parameters
        ----------
        out_dir : str
            Output directory; will be created if missing.
        resolution : int, optional (default=10)
            Which native resolution variant to read for the bands (10/20/60).
            If None, the finest available per band is used.

        Returns
        -------
        list of str
            Absolute paths of the 9 written RGBA GeoTIFF patches.

        Notes
        -----
        - Each patch is reprojected independently (UTM→3857→4326) to ensure
          ESRI-friendly alignment per patch.
        - Output dtype is uint8. Use your display/stretch preferences if needed.
        """
        from rasterio.windows import Window, bounds as win_bounds, transform as win_transform
        from rasterio.warp import calculate_default_transform
        from rasterio.transform import array_bounds
        from rasterio.crs import CRS
        from rasterio.enums import ColorInterp

        os.makedirs(out_dir, exist_ok=True)

        def _stretch01(arr: np.ndarray, lo=2, hi=98) -> np.ndarray:
            """Percentile stretch to [0..1] with NaN-safety."""
            p_lo = np.nanpercentile(arr, lo)
            p_hi = np.nanpercentile(arr, hi)
            denom = max(1e-6, (p_hi - p_lo))
            x = (arr - p_lo) / denom
            return np.clip(x, 0.0, 1.0)

        # Try to infer tile id like 'T39RXN' from any band path in the ZIP
        tile_id = None
        for (_, _r), br in self._band_index.items():
            m = re.search(r"T\d{2}[A-Z]{3}", br.path_in_zip)
            if m:
                tile_id = m.group(0)
                break
        if not tile_id:
            tile_id = "TILE"

        with rasterio.Env():
            # Open R,G,B at requested native resolution
            ds_r, _ = self._open_ref("B04", resolution)
            ds_g, _ = self._open_ref("B03", resolution)
            ds_b, _ = self._open_ref("B02", resolution)

            with ds_r, ds_g, ds_b:
                if not (ds_r.crs == ds_g.crs == ds_b.crs):
                    raise ValueError("Bands B04/B03/B02 must share the same CRS.")
                src_crs = ds_r.crs
                if src_crs is None:
                    raise ValueError("Source CRS is missing.")

                H, W = ds_r.height, ds_r.width
                row_edges = np.linspace(0, H, 4, dtype=int)  # 0, r1, r2, H
                col_edges = np.linspace(0, W, 4, dtype=int)  # 0, c1, c2, W

                written = []
                idx = 0
                for i in range(3):          # rows (top → bottom)
                    for j in range(3):      # cols (left → right)
                        idx += 1
                        r0, r1 = row_edges[i],   row_edges[i+1]
                        c0, c1 = col_edges[j],   col_edges[j+1]
                        win = Window(col_off=c0, row_off=r0, width=c1 - c0, height=r1 - r0)

                        # Read window per band as float32
                        r = ds_r.read(1, window=win).astype(np.float32)
                        g = ds_g.read(1, window=win).astype(np.float32)
                        b = ds_b.read(1, window=win).astype(np.float32)

                        # Window transform and bounds in UTM
                        w_transform = win_transform(win, ds_r.transform)
                        left, bottom, right, top = win_bounds(win, ds_r.transform)

                        # ---- Step 1: UTM -> EPSG:3857 (nearest; dst_nodata = NaN) ----
                        crs_3857 = CRS.from_epsg(3857)
                        tr_3857, w_3857, h_3857 = calculate_default_transform(
                            src_crs, crs_3857, int(win.width), int(win.height), left, bottom, right, top
                        )
                        pb_3857 = np.empty((3, h_3857, w_3857), dtype=np.float32)
                        reproject(
                            source=r, destination=pb_3857[0],
                            src_transform=w_transform, src_crs=src_crs,
                            dst_transform=tr_3857,   dst_crs=crs_3857,
                            resampling=Resampling.nearest,
                            src_nodata=None, dst_nodata=np.nan
                        )
                        reproject(
                            source=g, destination=pb_3857[1],
                            src_transform=w_transform, src_crs=src_crs,
                            dst_transform=tr_3857,   dst_crs=crs_3857,
                            resampling=Resampling.nearest,
                            src_nodata=None, dst_nodata=np.nan
                        )
                        reproject(
                            source=b, destination=pb_3857[2],
                            src_transform=w_transform, src_crs=src_crs,
                            dst_transform=tr_3857,   dst_crs=crs_3857,
                            resampling=Resampling.nearest,
                            src_nodata=None, dst_nodata=np.nan
                        )

                        # ---- Step 2: 3857 -> EPSG:4326 (nearest; keep NaNs) ----
                        crs_4326 = CRS.from_epsg(4326)
                        l2, b2, r2, t2 = array_bounds(h_3857, w_3857, tr_3857)
                        tr_4326, w_4326, h_4326 = calculate_default_transform(
                            crs_3857, crs_4326, w_3857, h_3857, l2, b2, r2, t2
                        )
                        pb_4326 = np.empty((3, h_4326, w_4326), dtype=np.float32)
                        for k in range(3):
                            reproject(
                                source=pb_3857[k], destination=pb_4326[k],
                                src_transform=tr_3857,  src_crs=crs_3857,
                                dst_transform=tr_4326,  dst_crs=crs_4326,
                                resampling=Resampling.nearest,
                                src_nodata=np.nan, dst_nodata=np.nan
                            )

                        # ---- Alpha & 8-bit conversion ----
                        valid = (~np.isnan(pb_4326[0])) & (~np.isnan(pb_4326[1])) & (~np.isnan(pb_4326[2]))
                        r8 = (_stretch01(pb_4326[0]) * 255.0).round().astype(np.uint8); r8[~valid] = 0
                        g8 = (_stretch01(pb_4326[1]) * 255.0).round().astype(np.uint8); g8[~valid] = 0
                        b8 = (_stretch01(pb_4326[2]) * 255.0).round().astype(np.uint8); b8[~valid] = 0
                        a8 = np.where(valid, 255, 0).astype(np.uint8)

                        rgba8 = np.stack([r8, g8, b8, a8], axis=0)

                        # ---- Write RGBA GeoTIFF (EPSG:4326) ----
                        out_profile = {
                            "driver": "GTiff",
                            "height": h_4326,
                            "width":  w_4326,
                            "count":  4,
                            "dtype": "uint8",
                            "crs":   crs_4326,
                            "transform": tr_4326,
                            "compress": "deflate",
                            "predictor": 1,
                            "interleave": "pixel",
                            "photometric": "RGB",
                        }
                        fname = f"{tile_id}_{idx}.tif"
                        fpath = os.path.abspath(os.path.join(out_dir, fname))
                        with rasterio.open(fpath, "w", **out_profile) as dst:
                            dst.write(rgba8, indexes=[1, 2, 3, 4])
                            # Inform readers that band 4 is alpha:
                            dst.colorinterp = (
                                ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha
                            )

                        written.append(fpath)

        return written

    
    def export_rgba_grid_3x3_from_zip(zip_path: str, out_dir: str, resolution: Optional[int] = 10) -> list:
        """Given a Sentinel-2 L2A ZIP, export a 3x3 grid of ESRI-aligned 8-bit RGBA GeoTIFF patches.

        Usage
        -----
        >>> export_rgba_grid_3x3_from_zip(
        ...     zip_path="S2A_MSIL2A_20240315T083601_..._T39RXN_....zip",
        ...     out_dir="./rgba_patches",
        ...     resolution=10
        ... )
        """
        rdr = SentinelProductReader(zip_path)
        return rdr.export_esri_aligned_rgba_grid_3x3(out_dir=out_dir, resolution=resolution)

    # ------------------------------ Helpers -------------------------------- #
    @staticmethod
    def native_resolution_of_path(path_in_zip: str) -> int:
        """Extract the native resolution in meters from a JP2 filename.

        Examples
        --------
        >>> SentinelProductReader.native_resolution_of_path("..._SCL_20m.jp2")
        20
        """
        m = re.search(r"_(10|20|60)m\.jp2$", path_in_zip)
        if not m:
            raise ValueError(f"Cannot infer resolution from: {path_in_zip}")
        return int(m.group(1))


__all__ = [
    "SentinelProductReader",
    "SCL_CODE_MEANINGS",
]
