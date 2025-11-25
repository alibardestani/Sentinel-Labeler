// polygon_navigator_app/static/polygon_navigator/script.js
// ---------------------------------
// Polygon Navigator Frontend (DB)
// ---------------------------------

// Create the Leaflet map
const map = L.map("pn-map").setView([20, 0], 2);

L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution:
      "Tiles © Esri — sources: Esri, i-cubed, USDA, USGS, AEX, GeoEye, " +
      "Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
    maxZoom: 19,
  }
).addTo(map);

//_______________________________________________________________________
function updateLabeledBadge() {
  const { labeled, total } = computeProgress();
  document.getElementById("labeledCount").textContent = `Labeled: ${labeled}`;
}
//__________________________________________________________________________

// Globals
let geoLayer = null; // L.geoJSON layer with all assigned polygons
let layerList = []; // Flat list of individual polygon layers
let currentIndex = -1; // Currently selected polygon index

// UI elements
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const saveBtn = document.getElementById("saveBtn");
const position = document.getElementById("position");
const saveLink = document.getElementById("saveLink");

// ---------------------------
// Helpers (style / tooltip)
// ---------------------------
function qualityColor(q) {
  if (q === "excellent") return "#17a34a"; // green
  if (q === "acceptable") return "#f59e0b"; // amber
  if (q === "bad") return "#ef4444"; // red
  return "#6b7280"; // gray / null
}

function baseStyle(feature) {
  const q = feature?.properties?.quality ?? null;
  return {
    color: "#111827", // stroke
    weight: 1,
    fillColor: qualityColor(q),
    fillOpacity: 0.4,
  };
}

function highlightStyle() {
  return { color: "#0ea5e9", weight: 3, fillOpacity: 0.5 };
}

function buildTooltip(props) {
  let rows = "";
  Object.keys(props || {}).forEach((k) => {
    let v = props[k];
    if (v === null || v === undefined) v = "None";
    rows += `<tr><td><b>${k}</b></td><td>${String(v)}</td></tr>`;
  });
  return `<table class="prop">${rows}</table>`;
}

function refreshLayerTooltip(layer) {
  if (!layer?.feature) return;
  const html = buildTooltip(layer.feature.properties || {});
  if (layer.getTooltip && layer.getTooltip()) {
    layer.setTooltipContent(html);
  } else {
    layer.bindTooltip(html, { sticky: true });
  }
}

// ---------------------------
// Quality popup on right-click
// ---------------------------
function openQualityPopup(latlng, layer) {
  const currentQ = layer?.feature?.properties?.quality ?? "None";
  const html = `
    <div class="popup-actions" style="font-size:12px;line-height:1.4;color:#e7ecf3;">
      <div style="margin-bottom:6px;">
        Current:
        <span style="
          display:inline-block;padding:2px 6px;border-radius:999px;
          border:1px solid #23304a;background:#0f1626;font-size:11px;color:#e7ecf3;
        ">${currentQ}</span>
      </div>
      <button class="btn" data-q="excellent">Excellent</button>
      <button class="btn" data-q="acceptable">Acceptable</button>
      <button class="btn" data-q="bad">Bad</button>
      <button class="btn" data-q="None">Clear</button>
    </div>
  `;

  L.popup().setLatLng(latlng).setContent(html).openOn(map);

  // Wire popup buttons after it renders
  setTimeout(() => {
    document.querySelectorAll(".popup-actions button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const val = e.target.getAttribute("data-q");
        layer.feature.properties.quality = val === "None" ? null : val;

        updateLabeledBadge();

        // Re-style + refresh tooltip
        layer.setStyle(baseStyle(layer.feature));
        refreshLayerTooltip(layer);

        // If it's the active polygon, keep highlight
        if (layerList[currentIndex] === layer) {
          layer.setStyle({ ...baseStyle(layer.feature), ...highlightStyle() });
        }
        map.closePopup();
      });
    });
  }, 0);
}

// ---------------------------
// Navigation helpers
// ---------------------------
function enableNavButtons(enabled) {
  prevBtn.disabled = !enabled;
  nextBtn.disabled = !enabled;
  saveBtn.disabled = !enabled;
}

function updatePosition() {
  const total = layerList.length;
  position.textContent =
    total === 0 ? "0 / 0" : `${currentIndex + 1} / ${total}`;
}

function goToIndex(idx) {
  if (idx < 0 || idx >= layerList.length) return;

  // reset previous highlight
  if (currentIndex >= 0 && currentIndex < layerList.length) {
    const prev = layerList[currentIndex];
    prev.setStyle(baseStyle(prev.feature));
  }

  currentIndex = idx;
  const layer = layerList[currentIndex];

  // highlight selected
  layer.setStyle({ ...baseStyle(layer.feature), ...highlightStyle() });

  // zoom to it
  if (layer.getBounds) {
    map.fitBounds(layer.getBounds(), { maxZoom: 15, padding: [30, 30] });
  }
  updatePosition();
}

function computeProgress() {
  let labeled = 0;
  let total = layerList.length;

  layerList.forEach((layer) => {
    const q = layer?.feature?.properties?.quality ?? null;
    if (q) labeled += 1;
  });

  return { labeled, total, remaining: total - labeled };
}

// ---------------------------
// Buttons
// ---------------------------
prevBtn.addEventListener("click", () => {
  if (layerList.length === 0) return;
  const next = (currentIndex - 1 + layerList.length) % layerList.length;
  goToIndex(next);
});

nextBtn.addEventListener("click", () => {
  if (layerList.length === 0) return;
  const next = (currentIndex + 1) % layerList.length;
  goToIndex(next);
});

saveBtn.addEventListener("click", async () => {
  if (!geoLayer) return;

  // Full FeatureCollection (including ids injected by backend)
  const fc = geoLayer.toGeoJSON();

  try {
    const res = await fetch("/api/polygons/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // same-origin cookies (Flask session) are sent by default
      body: JSON.stringify(fc),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === "ok") {
      const { labeled, total, remaining } = computeProgress();

      updateLabeledBadge();

      saveLink.innerHTML = `
        Saved ${data.updated} feature(s).<br>
        <b>${labeled}</b> labeled / <b>${total}</b> total
        — <b>${remaining}</b> remaining
      `;
    } else {
      saveLink.textContent = `Save failed: ${
        data.error || res.statusText || "Unknown error"
      }`;
    }
  } catch (err) {
    saveLink.textContent = `Save failed: ${err?.message || String(err)}`;
  }
});

// ---------------------------
// Load polygons from backend
// ---------------------------
async function loadAssignedFromServer() {
  const res = await fetch("/api/polygons/mine", { method: "GET" });
  if (!res.ok) throw new Error("Failed to load assigned polygons");
  const gj = await res.json();

  // remove previous layer
  if (geoLayer) map.removeLayer(geoLayer);
  layerList = [];

  geoLayer = L.geoJSON(gj, {
    style: baseStyle,
    onEachFeature: (feature, layer) => {
      layer.bindTooltip(buildTooltip(feature.properties || {}), {
        sticky: true,
      });

      // keep layer for navigation
      layerList.push(layer);

      // right-click to edit quality
      layer.on("contextmenu", (ev) => openQualityPopup(ev.latlng, layer));

      // subtle hover
      layer.on("mouseover", () => {
        layer.setStyle({ ...baseStyle(feature), weight: 2 });
      });
      layer.on("mouseout", () => {
        if (layerList[currentIndex] === layer) {
          layer.setStyle({ ...baseStyle(feature), ...highlightStyle() });
        } else {
          layer.setStyle(baseStyle(feature));
        }
      });
    },
  }).addTo(map);

  // zoom to extent
  try {
    map.fitBounds(geoLayer.getBounds(), { padding: [30, 30] });
  } catch (_) {}

  if (layerList.length > 0) {
    // Show initial progress for this user
    const { labeled, total, remaining } = computeProgress();

    updateLabeledBadge();

    saveLink.innerHTML = `
        <b>${labeled}</b> labeled / <b>${total}</b> total
        — <b>${remaining}</b> remaining
      `;
    updateLabeledBadge();

    enableNavButtons(true);
    goToIndex(0);
  } else {
    enableNavButtons(false);
    currentIndex = -1;
    updatePosition();
    saveLink.textContent = "No polygons assigned.";
  }
}

// Initial load
(async function init() {
  try {
    await loadAssignedFromServer();
  } catch (err) {
    console.error("[Navigator] load error:", err);
    enableNavButtons(false);
    currentIndex = -1;
    updatePosition();
  }
})();

document.getElementById("downloadBtn").addEventListener("click", () => {
  window.location.href = "/polygon-navigator/download-csv";
});
