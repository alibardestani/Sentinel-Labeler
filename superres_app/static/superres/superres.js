(function () {
  const formEl = document.getElementById("sr-form");
  const statusEl = document.getElementById("sr-status");
  const outputWrap = document.getElementById("sr-output");
  const modeEl = document.getElementById("sr-mode");
  const imagesWrap = document.getElementById("sr-images");

  formEl.addEventListener("submit", async (ev) => {
    ev.preventDefault();

    statusEl.textContent = "Running inference…";
    outputWrap.style.display = "none";
    imagesWrap.innerHTML = "";

    const formData = new FormData(formEl);

    try {
      const res = await fetch("/superres/run", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (data.error) {
        statusEl.textContent = "Error: " + data.error;
        return;
      }

      // decide mode message based on presence of metrics
      if (data.metrics) {
        modeEl.innerHTML =
          '<span style="color:#4ade80;">Evaluation Mode</span> (Ground Truth available)';
      } else {
        modeEl.innerHTML =
          '<span style="color:#facc15;">Inference Mode</span> (No Ground Truth, metrics unavailable)';
      }

      // Build cards for images
      imagesWrap.innerHTML = "";
      // If metrics exist, show bicubic, sr, hr like the streamlit app
      if (data.metrics) {
        // bicubic
        if (data.images.bicubic) {
          const m = data.metrics.bicubic || {};
          imagesWrap.appendChild(makeImageCard(
            data.images.bicubic,
            `Bicubic`,
            `PSNR: ${fmt(m.psnr)}, SSIM: ${fmt(m.ssim)}`
          ));
        }

        // sr
        if (data.images.sr) {
          const m = data.metrics.sr || {};
          imagesWrap.appendChild(makeImageCard(
            data.images.sr,
            `Super-Resolved`,
            `PSNR: ${fmt(m.psnr)}, SSIM: ${fmt(m.ssim)}`
          ));
        }

        // hr (ground truth)
        if (data.images.hr) {
          imagesWrap.appendChild(makeImageCard(
            data.images.hr,
            `Ground Truth`,
            ``
          ));
        }
      } else {
        // Inference Mode: original lr vs super-res sr
        if (data.images.lr) {
          imagesWrap.appendChild(makeImageCard(
            data.images.lr,
            `Original Input`,
            ``
          ));
        }
        if (data.images.sr) {
          imagesWrap.appendChild(makeImageCard(
            data.images.sr,
            `Super-Resolved Output`,
            ``
          ));
        }
      }

      outputWrap.style.display = "block";
      statusEl.textContent = `Done: ${data.input_source_name}`;

    } catch (err) {
      statusEl.textContent = "Request failed: " + err;
    }
  });

  function makeImageCard(src, title, metricsText) {
    const div = document.createElement("div");
    div.className = "sr-card";

    const img = document.createElement("img");
    img.src = src;
    img.alt = title;

    const h = document.createElement("div");
    h.style.fontWeight = "600";
    h.style.fontSize = "12px";
    h.style.marginBottom = "4px";
    h.textContent = title;

    const m = document.createElement("div");
    m.className = "sr-metrics";
    m.textContent = metricsText || "";

    div.appendChild(img);
    div.appendChild(h);
    div.appendChild(m);

    return div;
  }

  function fmt(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") {
      return v.toFixed(2);
    }
    return String(v);
  }
})();