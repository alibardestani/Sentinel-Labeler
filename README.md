# Sentinel Labeler – Phase 1

دو جریان کاری:
1) **Polygon**: رسم/ویرایش چندضلعی‌ها روی پس‌زمینه (Esri + اورلی PNG در صورت داشتن `s2_rgb.tif`).
2) **Mask**: اصلاح ماسک با قلم (PNG تک‌کانالهٔ lossless).

## نصب
```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

پیکربندی
	•	فایل config.py را باز کنید و مسیر S2_JP2_DIR را در صورت داشتن فایل‌های Sentinel‑2 JP2 تنظیم کنید.
	•	اگر S2_JP2_DIR خالی باشد، برنامه تصویر output/rgb_quicklook.png را اگر باشد استفاده می‌کند؛ در غیراینصورت یک placeholder می‌سازد.

اجرا

python app.py

اگر پورت 5000 اشغال بود، پورت را در app.py به 5050 تغییر دهید.

استفاده
	•	برو به http://127.0.0.1:5000/polygon:
	•	پس‌زمینه:
	•	اگر s2_rgb.tif موجود باشد، مرز جغرافیایی از آن استخراج می‌شود و اورلی rgb_quicklook.png روی Esri World Imagery می‌افتد (مختصات واقعی).
	•	در غیر این‌صورت فقط نمای Esri با یک view پیش‌فرض نمایش داده می‌شود.
	•	رسم با ابزار Polygon و «ذخیره پولیگان‌ها»: خروجی output/polygons.geojson و output/polygons.shp.
	•	برو به http://127.0.0.1:5000/mask:
	•	ابزار قلم/جابجایی/زوم + اندازه و شکل قلم (بالای صفحه).
	•	ذخیرهٔ ماسک → output/mask.png (۸ بیت تک‌کاناله، lossless، مقادیر کلاس بدون تغییر).
	•	دکمهٔ Pre-label:
	•	انتخاب «KMeans روی RGB» یا «Otsu» و اجرای خودکار؛ نتیجه به output/mask.png ذخیره می‌شود و به صفحهٔ Mask هدایت می‌شوید.

نکات
	•	برای ژئورفرنس دقیق اورلی، وجود output/s2_rgb.tif لازم است (از JP2 ساخته می‌شود). اگر نمی‌خواهید از JP2 استفاده کنید، فقط output/rgb_quicklook.png را دستی قرار دهید و نمای Esri بدون اورلی جغرافیایی کار می‌کند.
	•	ماسک به‌صورت lossless ذخیره می‌شود (PNG تک‌کاناله). هیچ رندر/فشرده‌سازی مخربی انجام نمی‌شود.
	•	بیشتر منطق در بک‌اند پایتون است؛ JS حداقلی نگه داشته شده است.

---

> آماده‌ام این ساختار را بیشتر هم توسعه بدهم (افزودن NDVI prelabel، COG output، میان‌بُرهای کیبورد، snapping برای پولیگان‌ها، یا احراز هویت چندکاربره).