// ---------------------------
// Polygon Navigator Frontend
// ---------------------------

// Create Leaflet map in the new container #pn-map
// We use Esri World Imagery like in your original code
const map = L.map("pn-map").setView([20, 0], 2);

L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, " +
      "Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
    maxZoom: 19,
  }
).addTo(map);

// Globals in this page
let geoLayer = null;     // The full L.geoJSON layer of all polygons
let layerList = [];      // Array of each individual polygon layer (for navigation)
let currentIndex = -1;   // Which polygon is selected/highlighted

// UI elements from template
const fileInput = document.getElementById("shpZip");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const saveBtn = document.getElementById("saveBtn");
const position = document.getElementById("position");
const saveLink = document.getElementById("saveLink");

// ---------------------------
// Helpers for styling / state
// ---------------------------

function qualityColor(q) {
  // Map quality to fill color.
  // Colors are chosen to be visible on dark basemap.
  if (q === "excellent") return "#17a34a";   // green
  if (q === "acceptable") return "#f59e0b"; // amber
  if (q === "bad") return "#ef4444";        // red
  return "#6b7280";                         // default gray / None
}

function baseStyle(feature) {
  // Feature-level style based on its 'quality' property
  const q =
    feature.properties && feature.properties.quality
      ? String(feature.properties.quality)
      : null;

  return {
    color: "#111827", // dark stroke
    weight: 1,
    fillColor: qualityColor(q),
    fillOpacity: 0.4,
  };
}

function highlightStyle() {
  // Extra style when a polygon is "active" in navigation
  return {
    color: "#0ea5e9", // cyan-ish outline
    weight: 3,
    fillOpacity: 0.5,
  };
}

// Build tooltip table from feature properties
function buildTooltip(props) {
  let rows = "";
  Object.keys(props || {}).forEach((k) => {
    let v = props[k];
    if (v === null || v === undefined) v = "None";
    rows += `<tr><td><b>${k}</b></td><td>${String(v)}</td></tr>`;
  });
  return `<table class="prop">${rows}</table>`;
}

// Update the tooltip of a single layer when its props change
function refreshLayerTooltip(layer) {
  if (!layer || !layer.feature) return;
  const tt = buildTooltip(layer.feature.properties || {});
  // Leaflet: setTooltipContent only exists on bound tooltip
  if (layer.getTooltip && layer.getTooltip()) {
    layer.setTooltipContent(tt);
  } else {
    // If somehow tooltip wasn't bound yet, bind now.
    layer.bindTooltip(tt, { sticky: true });
  }
}

// Popup for setting quality
function openQualityPopup(latlng, layer) {
  const currentQ =
    (layer.feature.properties && layer.feature.properties.quality) || "None";

  const html = `
    <div class="popup-actions" style="font-size:12px;line-height:1.4;color:#e7ecf3;">
      <div style="margin-bottom:6px;">
        Current:
        <span style="
          display:inline-block;
          padding:2px 6px;
          border-radius:999px;
          border:1px solid #23304a;
          background:#0f1626;
          font-size:11px;
          color:#e7ecf3;
        ">${currentQ}</span>
      </div>
      <button class="btn" data-q="excellent">Excellent</button>
      <button class="btn" data-q="acceptable">Acceptable</button>
      <button class="btn" data-q="bad">Bad</button>
      <button class="btn" data-q="None">Clear</button>
    </div>
  `;

  const popup = L.popup()
    .setLatLng(latlng)
    .setContent(html)
    .openOn(map);

  // After popup is in DOM, wire buttons
  setTimeout(() => {
    document.querySelectorAll(".popup-actions button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const val = e.target.getAttribute("data-q");

        // Update model
        layer.feature.properties.quality = val === "None" ? null : val;

        // Re-style polygon
        layer.setStyle(baseStyle(layer.feature));

        // Update tooltip to reflect new quality
        refreshLayerTooltip(layer);

        // Keep highlight if it's the active polygon
        const idx = layerList.indexOf(layer);
        if (idx === currentIndex) {
          layer.setStyle({
            ...baseStyle(layer.feature),
            ...highlightStyle(),
          });
        }

        map.closePopup();
      });
    });
  }, 0);
}

// Enable/disable the nav + save buttons based on whether we have data
function enableNavButtons(enabled) {
  prevBtn.disabled = !enabled;
  nextBtn.disabled = !enabled;
  saveBtn.disabled = !enabled;
}

// Show "X / Y" in the UI
function updatePosition() {
  const total = layerList.length;
  const shown = total === 0 ? 0 : currentIndex + 1;
  position.textContent = `${shown} / ${total}`;
}

// Jump to a polygon by index and zoom/highlight it
function goToIndex(idx) {
  if (idx < 0 || idx >= layerList.length) return;

  // Reset previous highlight to base style
  if (currentIndex >= 0 && currentIndex < layerList.length) {
    const oldLayer = layerList[currentIndex];
    oldLayer.setStyle(baseStyle(oldLayer.feature));
  }

  // Update index
  currentIndex = idx;
  const layer = layerList[currentIndex];

  // Highlight selected
  layer.setStyle({
    ...baseStyle(layer.feature),
    ...highlightStyle(),
  });

  // Zoom to it
  if (layer.getBounds) {
    map.fitBounds(layer.getBounds(), { maxZoom: 15, padding: [30, 30] });
  }

  updatePosition();
}

// --------------------------------
// Button / UI event wiring
// --------------------------------

// Previous polygon
prevBtn.addEventListener("click", () => {
  if (layerList.length === 0) return;
  const next = (currentIndex - 1 + layerList.length) % layerList.length;
  goToIndex(next);
});

// Next polygon
nextBtn.addEventListener("click", () => {
  if (layerList.length === 0) return;
  const next = (currentIndex + 1) % layerList.length;
  goToIndex(next);
});

// Save shapefile with updated qualities
saveBtn.addEventListener("click", async () => {
  if (!geoLayer) return;

  // Build full FeatureCollection (GeoJSON) from current layer
  const fc = geoLayer.toGeoJSON();

  // POST to server blueprint endpoint
  const res = await fetch("/polygon-navigator/save_shapefile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fc),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    saveLink.textContent = "Save failed: bad server response.";
    return;
  }

  if (data.status === "saved") {
    // Server returns a download URL like /polygon-navigator/download/...
    saveLink.innerHTML = `
      <a href="${data.shapefile_zip}"
         target="_blank"
         class="btn"
         style="display:inline-block;margin-top:6px;">
         Download saved shapefile
      </a>`;
  } else {
    saveLink.textContent =
      "Save failed: " + (data.message || "Unknown error");
  }
});

// Upload shapefile ZIP -> send to server -> reload data
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);

  // POST to /polygon-navigator/upload_shapefile
  const res = await fetch("/polygon-navigator/upload_shapefile", {
    method: "POST",
    body: formData,
  });

  const data = await res.json();
  if (data.status !== "ok") {
    alert("Upload error: " + (data.message || "Unknown"));
    return;
  }

  // After upload, load the data from /polygon-navigator/data
  await loadAndRenderServerData();

  // Clear previous save message
  saveLink.textContent = "";
});

// --------------------------------
// Data loading / rendering
// --------------------------------

async function loadAndRenderServerData() {
  // GET /polygon-navigator/data
  const gj = await fetch("/polygon-navigator/data").then((r) => r.json());

  // Remove existing layer if any
  if (geoLayer) {
    map.removeLayer(geoLayer);
  }

  layerList = [];

  // Build new Leaflet GeoJSON layer
  geoLayer = L.geoJSON(gj, {
    style: baseStyle,
    onEachFeature: function (feature, layer) {
      // Tooltip with all properties
      const tt = buildTooltip(feature.properties || {});
      layer.bindTooltip(tt, { sticky: true });

      // Keep for navigation
      layerList.push(layer);

      // Right-click to open popup for editing quality
      layer.on("contextmenu", (ev) => {
        openQualityPopup(ev.latlng, layer);
      });

      // Hover styling: subtle weight bump
      layer.on("mouseover", () => {
        layer.setStyle({
          ...baseStyle(feature),
          weight: 2,
        });
      });
      layer.on("mouseout", () => {
        // Restore either highlighted style or base style
        const idx = layerList.indexOf(layer);
        if (idx === currentIndex) {
          layer.setStyle({
            ...baseStyle(feature),
            ...highlightStyle(),
          });
        } else {
          layer.setStyle(baseStyle(feature));
        }
      });
    },
  }).addTo(map);

  // Zoom map to everything we loaded
  try {
    map.fitBounds(geoLayer.getBounds(), { padding: [30, 30] });
  } catch (err) {
    // If there's nothing valid to zoom to (empty geometry), ignore
  }

  // Now that we have data, enable nav controls and go to first polygon
  if (layerList.length > 0) {
    enableNavButtons(true);
    goToIndex(0);
  } else {
    enableNavButtons(false);
    currentIndex = -1;
    updatePosition();
  }
}

// --------------------------------
// Initial load on page open
// --------------------------------

// If server already has CURRENT_GDF in memory from a previous session,
// we'll load it automatically so user doesn't have to upload again.
(async function init() {
  try {
    await loadAndRenderServerData();
  } catch (err) {
    // If /polygon-navigator/data failed or empty, that's fine.
    enableNavButtons(false);
    currentIndex = -1;
    updatePosition();
  }
})();