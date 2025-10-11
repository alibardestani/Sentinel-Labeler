// Base path for API calls (blueprint). Injected by the template; fallback to "/project2".
const API_BASE = (window.PROJECT2_BASE || "/project2");

const STATUS_OPTIONS = ["No changed","Change <30%","Change 30–50%","Change >50%"];

let map, polygonsLayer;
let canvas, ctx;
let selectedId = null;
let selectedFeature = null;
let lastDraw = null;

// Canvas sizing
function fitCanvas() {
  const container = document.getElementById("canvasContainer") || canvas.parentElement;
  const w = container.clientWidth || 600;
  const h = container.clientHeight || 400;
  canvas.width = w; canvas.height = h;
}

// Draw the PNG + polygon outline (in bbox space) into the canvas
function drawImageToCanvas(imageUrl, polygonUTM, bbox) {
  const img = new Image();
  img.onload = function () {
    fitCanvas();
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const cw = canvas.width, ch = canvas.height;
    const arImg = iw / ih, arCan = cw / ch;
    let dw, dh, dx, dy;
    if (arImg > arCan) { dw = cw; dh = cw / arImg; dx = 0; dy = (ch - dh) / 2; }
    else { dh = ch; dw = ch * arImg; dy = 0; dx = (cw - dw) / 2; }

    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, dx, dy, dw, dh);

    if (polygonUTM && bbox) {
      const { minx, miny, maxx, maxy } = bbox;
      const spanX = (maxx - minx) || 1e-6;
      const spanY = (maxy - miny) || 1e-6;
      ctx.strokeStyle = "rgba(0,255,0,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      // Polygon/MultiPolygon tolerant
      const rings =
        Array.isArray(polygonUTM[0]?.[0]?.[0]) ? polygonUTM[0][0] :
        Array.isArray(polygonUTM[0]?.[0])      ? polygonUTM[0] :
        polygonUTM;

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

    lastDraw = { src: imageUrl, poly: polygonUTM, bbox };
  };
  img.src = imageUrl;
}

// Status labels
function setStatusLabels(props) {
  const stEl = document.getElementById("statusText");
  const rvEl = document.getElementById("statusReviewedText");
  if (stEl) stEl.textContent = props.status ?? "Unknown";
  if (rvEl) rvEl.textContent = props.status_reviewed ?? "Pending";
}

// Status update (POST)
function updateField(field, value) {
  if (selectedId === null) return;
  fetch(`${API_BASE}/update_status`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ id: selectedId, field: field, value: value })
  })
  .then(r => r.json())
  .then(d => {
    if (!d.success) { alert("Update failed"); return; }
    if (selectedFeature) {
      selectedFeature.properties[field] = value;
      setStatusLabels(selectedFeature.properties);
    }
  })
  .catch(err => console.error("updateField error:", err));
}

// Right-click context menu (status + reviewed)
function showContextMenu(e, feature, layer) {
  document.getElementById("contextMenu")?.remove();
  const menu = document.createElement("div");
  menu.id = "contextMenu";
  const y = (e.originalEvent?.clientY || e.clientY) + "px";
  const x = (e.originalEvent?.clientX || e.clientX) + "px";
  Object.assign(menu.style, {
    position: "absolute", top: y, left: x, background: "#222", color: "#fff",
    borderRadius: "8px", padding: "8px", font: "14px sans-serif", zIndex: 99999,
    minWidth: "220px", boxShadow: "0 6px 18px rgba(0,0,0,0.3)"
  });

  const addSec = (title, field) => {
    const hdr = document.createElement("div");
    hdr.textContent = title; hdr.style.margin = "6px 0 4px"; hdr.style.fontWeight = "600";
    menu.appendChild(hdr);
    STATUS_OPTIONS.forEach(opt => {
      const item = document.createElement("div");
      item.textContent = opt; item.style.padding = "4px 6px"; item.style.cursor = "pointer";
      item.onmouseenter = () => item.style.background = "#333";
      item.onmouseleave = () => item.style.background = "transparent";
      item.onclick = () => { updateField(field, opt); menu.remove(); };
      menu.appendChild(item);
    });
  };

  const title = document.createElement("div");
  title.textContent = "Set status / reviewed"; title.style.fontWeight = "700";
  title.style.marginBottom = "6px"; title.style.opacity = "0.9";
  menu.appendChild(title);

  addSec("Status:", "status");
  addSec("Reviewed:", "status_reviewed");

  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

// Map + polygons
function initMap() {
  map = L.map("map").setView([32.5, 54.3], 6);
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "© Esri — World Imagery" }
  ).addTo(map);

  const data = window.polygonsData;
  if (!data || !data.features || data.features.length === 0) {
    console.warn("⚠️ polygons data is empty or missing.");
    return;
  }

  polygonsLayer = L.geoJSON(data, {
    style: f => ({
      color: f.properties.status_checked === "Reviewed" ? "#20c997" : "#ff8c00",
      weight: 2, opacity: 0.9, fillOpacity: 0.12
    }),
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(
        `Code: ${feature.properties.code ?? "N/A"}<br>` +
        `Status: ${feature.properties.status ?? "Unknown"}<br>` +
        `Reviewed: ${feature.properties.status_reviewed ?? "Pending"}`
      );

      layer.on("click", function () {
        selectedId = feature.properties.index;
        selectedFeature = feature;
        fetch(`${API_BASE}/get_polygon_rgb/${selectedId}`)
          .then(r => r.json())
          .then(d => {
            if (d.error) { alert(d.error); return; }
            drawImageToCanvas(d.image_path, d.polygon_utm, d.bbox);
            setStatusLabels(feature.properties);
          })
          .catch(err => console.error("Fetch error:", err));
      });

      layer.on("contextmenu", function (evt) {
        selectedId = feature.properties.index;
        selectedFeature = feature;
        showContextMenu(evt, feature, layer);
      });
    }
  }).addTo(map);

  try { map.fitBounds(polygonsLayer.getBounds()); } catch (e) {}
}

// Canvas init
function initCanvas() {
  canvas = document.getElementById("rgbCanvas");
  ctx = canvas.getContext("2d");
  fitCanvas();
  window.addEventListener("resize", () => {
    fitCanvas();
    if (lastDraw) drawImageToCanvas(lastDraw.src, lastDraw.poly, lastDraw.bbox);
  });
}

// Save button
function initSaveButton() {
  const btn = document.getElementById("saveBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    fetch(`${API_BASE}/save_all`, { method: "POST" })
      .then(r => r.json())
      .then(d => d.success ? alert("✅ Saved") : alert("❌ Save failed"))
      .catch(err => alert("❌ Save error: " + err));
  });
}

// Boot
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initCanvas();
  initSaveButton();
});