const API_BASE = (window.PROJECT2_BASE || "/project2");
const SHOW_ON_MAP = false;
const PIXEL_PERFECT = true;
const STATUS_OPTIONS = ["No changed","Change <30%","Change 30–50%","Change >50%"];

let map, polygonsLayer, selectedLayer = null;
let canvas, ctx;
let selectedIndex = null;
let selectedCode  = null;
let selectedFeature = null;
let lastDraw = null;

function ensureCanvas() {
  if (!canvas) {
    canvas = document.getElementById("rgbCanvas");
    if (!canvas) return false;
    ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
  }
  return true;
}

function fitCanvasToContainer() {
  const container = document.getElementById("canvasContainer") || canvas?.parentElement;
  const w = (container?.clientWidth || 600);
  const h = (container?.clientHeight || 400);
  if (!canvas) return;
  canvas.width = w;
  canvas.height = h;
}

function drawImageToCanvas(imageUrl, maskUrl = null, polygonUTM = null, bbox = null) {
  if (!ensureCanvas()) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = function () {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (PIXEL_PERFECT) {
      canvas.width = iw;
      canvas.height = ih;
      ctx.clearRect(0, 0, iw, ih);
      ctx.drawImage(img, 0, 0);
      if (maskUrl) {
        const m = new Image();
        m.crossOrigin = "anonymous";
        m.onload = () => ctx.drawImage(m, 0, 0);
        m.src = maskUrl;
      }
      if (polygonUTM && bbox) {
        const { minx, miny, maxx, maxy } = bbox;
        const spanX = (maxx - minx) || 1e-6;
        const spanY = (maxy - miny) || 1e-6;
        ctx.strokeStyle = "rgba(0,255,0,0.9)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const rings =
          Array.isArray(polygonUTM[0]?.[0]?.[0]) ? polygonUTM[0] :
          Array.isArray(polygonUTM[0]?.[0])      ? polygonUTM :
          [polygonUTM];
        for (const ring of rings) {
          let first = true;
          for (const pt of ring) {
            const x = ((pt[0] - minx) / spanX) * iw;
            const y = ((maxy - pt[1]) / spanY) * ih;
            if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
          }
          ctx.closePath();
        }
        ctx.stroke();
      }
    } else {
      const container = document.getElementById("canvasContainer") || canvas.parentElement;
      const cw = (container?.clientWidth || 600);
      const ch = (container?.clientHeight || 400);
      canvas.width = cw; canvas.height = ch;
      const arImg = iw / ih, arCan = cw / ch;
      let dw, dh, dx, dy;
      if (arImg > arCan) { dw = cw; dh = Math.round(cw / arImg); dx = 0; dy = Math.round((ch - dh) / 2); }
      else { dh = ch; dw = Math.round(ch * arImg); dy = 0; dx = Math.round((cw - dw) / 2); }
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(img, dx, dy, dw, dh);
      if (maskUrl) {
        const m = new Image();
        m.crossOrigin = "anonymous";
        m.onload = () => ctx.drawImage(m, dx, dy, dw, dh);
        m.src = maskUrl;
      }
      if (polygonUTM && bbox) {
        const { minx, miny, maxx, maxy } = bbox;
        const spanX = (maxx - minx) || 1e-6;
        const spanY = (maxy - miny) || 1e-6;
        ctx.strokeStyle = "rgba(0,255,0,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        const rings =
          Array.isArray(polygonUTM[0]?.[0]?.[0]) ? polygonUTM[0] :
          Array.isArray(polygonUTM[0]?.[0])      ? polygonUTM :
          [polygonUTM];
        for (const ring of rings) {
          let first = true;
          for (const pt of ring) {
            const x = ((pt[0] - minx) / spanX) * dw + dx;
            const y = ((maxy - pt[1]) / spanY) * dh + dy;
            if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
          }
          ctx.closePath();
        }
        ctx.stroke();
      }
    }
    lastDraw = { src: imageUrl, mask: maskUrl, poly: polygonUTM, bbox };
  };
  img.src = imageUrl;
}

window.drawImageToCanvas = drawImageToCanvas;

function setStatusLabels(props) {
  const stEl = document.getElementById("statusText");
  const rvEl = document.getElementById("statusReviewedText");
  if (stEl) stEl.textContent = props?.status ?? "Unknown";
  if (rvEl) rvEl.textContent = props?.status_reviewed ?? "Pending";
}

function refreshTooltip(layer, props) {
  const txt =
    `Code: ${props.code ?? "N/A"}<br>` +
    `Status: ${props.status ?? "Unknown"}<br>` +
    `Reviewed: ${props.status_reviewed ?? "Pending"}`;
  layer.unbindTooltip();
  layer.bindTooltip(txt);
}

function highlight(layer) {
  if (selectedLayer && selectedLayer !== layer) {
    polygonsLayer.resetStyle(selectedLayer);
  }
  selectedLayer = layer;
  layer.setStyle({ color: "#20c997", weight: 3, opacity: 1, fillOpacity: 0.2 });
}

function updateField(field, value) {
  if (selectedIndex === null && !selectedCode) return;
  const body = { field, value };
  if (selectedCode !== null && selectedCode !== undefined) body.code = String(selectedCode);
  else body.id = selectedIndex;
  fetch(`${API_BASE}/update_status`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  })
    .then(r => r.json())
    .then(d => {
      if (!d.success) { alert(d.error || "Update failed"); return; }
      if (selectedFeature && selectedLayer) {
        selectedFeature.properties[field] = value;
        setStatusLabels(selectedFeature.properties);
        refreshTooltip(selectedLayer, selectedFeature.properties);
      }
    })
    .catch(err => console.error("updateField error:", err));
}


function showContextMenu(e, feature, layer) {
// remove any existing
document.getElementById("contextMenu")?.remove();


const menu = document.createElement("div");
menu.id = "contextMenu";
menu.style.position = "absolute";
menu.style.top = (e.originalEvent?.clientY || e.clientY) + "px";
menu.style.left = (e.originalEvent?.clientX || e.clientX) + "px";
menu.style.background = "#222";
menu.style.color = "#fff";
menu.style.borderRadius = "8px";
menu.style.padding = "8px";
menu.style.font = "14px sans-serif";
menu.style.zIndex = 99999;
menu.style.minWidth = "220px";
menu.style.boxShadow = "0 6px 18px rgba(0,0,0,0.3)";


const title = document.createElement("div");
title.textContent = "Set status_reviewed";
title.style.fontWeight = "700";
title.style.marginBottom = "6px";
title.style.opacity = "0.9";
menu.appendChild(title);


// گزینه‌ها فقط برای status_reviewed
STATUS_OPTIONS.forEach(opt => {
const item = document.createElement("div");
item.textContent = opt;
item.style.padding = "4px 6px";
item.style.cursor = "pointer";
item.onmouseenter = () => item.style.background = "#333";
item.onmouseleave = () => item.style.background = "transparent";
item.onclick = () => {
updateField("status_rev", opt);
menu.remove();
};
menu.appendChild(item);
});


document.body.appendChild(menu);
setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

function initMap() {
  map = L.map("map").setView([32.5, 54.3], 6);
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "© Esri — World Imagery" }
  ).addTo(map);

  const data = window.polygonsData;
  if (!data || !data.features || data.features.length === 0) return;

  polygonsLayer = L.geoJSON(data, {
    style: f => ({
      color: f.properties.status_checked === "Reviewed" ? "#20c997" : "#ff8c00",
      weight: 2,
      opacity: 0.9,
      fillOpacity: 0.12
    }),
    onEachFeature: (feature, layer) => {
      refreshTooltip(layer, feature.properties);
      layer.on("click", function () {
        selectedIndex = feature.properties.index;
        selectedCode  = feature.properties.code;
        selectedFeature = feature;
        highlight(layer);
        const b = layer.getBounds();
        try { map.fitBounds(b, { padding: [20, 20] }); } catch (e) {}
        fetch(`${API_BASE}/get_polygon_rgb/${selectedIndex}`)
          .then(r => r.json())
          .then(d => {
            if (d.error) { alert(d.error); return; }
            drawImageToCanvas(d.image_path, d.mask_path || null, d.polygon_utm || null, d.bbox || null);
            setStatusLabels(feature.properties);
            if (SHOW_ON_MAP && d.bbox_wgs84) {
              const bounds = L.latLngBounds(d.bbox_wgs84);
              L.imageOverlay(d.image_path, bounds).addTo(map);
              if (d.mask_path) L.imageOverlay(d.mask_path, bounds, { opacity: 1, zIndex: 600 }).addTo(map);
              map.fitBounds(bounds, { padding: [20, 20] });
            }
          })
          .catch(err => console.error("Fetch error:", err));
      });
      layer.on("contextmenu", function (evt) {
        selectedIndex = feature.properties.index;
        selectedCode  = feature.properties.code;
        selectedFeature = feature;
        showContextMenu(evt, feature);
      });
    }
  }).addTo(map);

  try { map.fitBounds(polygonsLayer.getBounds()); } catch (e) {}
}

function initSaveButton() {
  const btn = document.getElementById("saveBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    fetch(`${API_BASE}/save_all`, { method: "POST" })
      .then(r => r.json())
      .then(d => d.success ? alert("✅ Saved shapefile.") : alert(d.error || "❌ Save failed."))
      .catch(err => alert("❌ Save error: " + err));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initMap();
  ensureCanvas();
  initSaveButton();
  window.addEventListener("resize", () => {
    if (!PIXEL_PERFECT) {
      fitCanvasToContainer();
      if (lastDraw) drawImageToCanvas(lastDraw.src, lastDraw.mask, lastDraw.poly, lastDraw.bbox);
    }
  });
});