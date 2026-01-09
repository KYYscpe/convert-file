import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const formatSelect = document.getElementById("formatSelect");
const convertBtn = document.getElementById("convertBtn");
const clearBtn = document.getElementById("clearBtn");
const results = document.getElementById("results");
const statusText = document.getElementById("statusText");
const barFill = document.getElementById("barFill");
const nameInput = document.getElementById("nameInput");
const qualityWrap = document.getElementById("qualityWrap");
const quality = document.getElementById("quality");
const qualityVal = document.getElementById("qualityVal");
const ffmpegHint = document.getElementById("ffmpegHint");

quality.addEventListener("input", () => (qualityVal.textContent = quality.value));

let queue = [];
let converting = false;

let ffmpeg = null;
let ffmpegLoaded = false;
let ffmpegLoading = null;

// ====== URLs (LOCAL first = fastest & no CORS) ======
const LOCAL = {
  // worker milik package @ffmpeg/ffmpeg (class worker)
  classWorkerURL: "/ffmpeg-worker.js",
  // core (single thread)
  coreURL: "/ffmpeg-core.js",
  wasmURL: "/ffmpeg-core.wasm",
  // optional (dipakai mt; tapi aman disediakan kalau kamu taruh)
  workerURL: "/ffmpeg-core.worker.js",
};

// ====== CDN fallback (blobify -> worker jadi same-origin Blob URL) ======
const CDN = {
  ffmpegPkgBase: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm",
  coreBaseUmd: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd",
};

function setProgress(pct, text = "") {
  const v = Math.max(0, Math.min(100, pct));
  barFill.style.width = `${v}%`;
  if (text) statusText.textContent = text;
}

function fmtBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function extOf(name) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

function isImage(file) {
  return file.type.startsWith("image/") || ["png","jpg","jpeg","webp"].includes(extOf(file.name));
}

function isVideoOrAudio(file) {
  return file.type.startsWith("video/") || file.type.startsWith("audio/") ||
    ["mp4","mov","webm","mkv","m4a","aac","wav","mp3","ogg"].includes(extOf(file.name));
}

function buildFormatOptions(files) {
  const hasImage = files.some(isImage);
  const hasMedia = files.some(isVideoOrAudio);
  const opts = [];

  if (hasImage) {
    opts.push({ value: "png", label: "PNG (image/png)" });
    opts.push({ value: "jpg", label: "JPG (image/jpeg)" });
    opts.push({ value: "webp", label: "WEBP (image/webp)" });
  }
  if (hasMedia) {
    opts.push({ value: "mp3", label: "MP3 (audio/mpeg) — via FFmpeg.wasm" });
    opts.push({ value: "wav", label: "WAV (audio/wav) — via FFmpeg.wasm" });
  }
  return opts;
}

function setSelectOptions(opts) {
  formatSelect.innerHTML = "";
  if (!opts.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "Format tidak tersedia untuk file ini";
    formatSelect.appendChild(o);
    formatSelect.disabled = true;
    return;
  }
  for (const opt of opts) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    formatSelect.appendChild(o);
  }
  formatSelect.disabled = false;
}

function showQualityIfNeeded(format) {
  qualityWrap.hidden = !(format === "jpg" || format === "webp");
}

formatSelect.addEventListener("change", () => {
  showQualityIfNeeded(formatSelect.value);
  if (["mp3","wav"].includes(formatSelect.value) && queue.some(isVideoOrAudio)) warmupFFmpeg();
});

async function urlOk(url) {
  try {
    const r = await fetch(url, { method: "GET", cache: "no-store" });
    return r.ok;
  } catch { return false; }
}

// preload supaya "Menyiapkan FFmpeg..." lebih cepat
function warmupFFmpeg() {
  if (ffmpegLoaded || ffmpegLoading) return;
  ffmpegHint.textContent = "Menyiapkan FFmpeg (preload)…";
  const run = () => ensureFFmpeg().catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 200);
}

// KUNCI FIX: set classWorkerURL agar Worker tidak cross-origin. :contentReference[oaicite:2]{index=2}
async function ensureFFmpeg() {
  if (ffmpegLoaded) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    ffmpegHint.textContent = "Menyiapkan FFmpeg…";
    setProgress(5, "Menyiapkan FFmpeg…");

    ffmpeg = new FFmpeg();

    try {
      ffmpeg.on("progress", ({ progress }) => {
        const pct = 8 + Math.round(progress * 85);
        setProgress(pct);
      });
    } catch {}

    // 1) LOCAL (recommended for Vercel): /ffmpeg-worker.js + /ffmpeg-core.*
    const hasLocalClassWorker = await urlOk(LOCAL.classWorkerURL);
    const hasLocalCore = await urlOk(LOCAL.coreURL) && await urlOk(LOCAL.wasmURL);

    if (hasLocalClassWorker && hasLocalCore) {
      ffmpegHint.textContent = "FFmpeg: local assets (paling cepat).";
      await ffmpeg.load({
        classWorkerURL: LOCAL.classWorkerURL, // worker utama ffmpeg :contentReference[oaicite:3]{index=3}
        coreURL: LOCAL.coreURL,
        wasmURL: LOCAL.wasmURL,
        // workerURL opsional (mt). aman kalau ada file-nya
        workerURL: (await urlOk(LOCAL.workerURL)) ? LOCAL.workerURL : undefined,
      });
      ffmpegLoaded = true;
      ffmpegHint.textContent = "FFmpeg siap (local).";
      return ffmpeg;
    }

    // 2) FALLBACK: blobify CDN worker + blobify core (hindari error Worker cross-origin)
    ffmpegHint.textContent = "FFmpeg: CDN fallback (blob)…";
    try {
      const classWorkerBlob = await toBlobURL(`${CDN.ffmpegPkgBase}/worker.js`, "text/javascript");
      const coreBlob = await toBlobURL(`${CDN.coreBaseUmd}/ffmpeg-core.js`, "text/javascript");
      const wasmBlob = await toBlobURL(`${CDN.coreBaseUmd}/ffmpeg-core.wasm`, "application/wasm");

      await ffmpeg.load({
        classWorkerURL: classWorkerBlob, // ini yang memperbaiki error kamu :contentReference[oaicite:4]{index=4}
        coreURL: coreBlob,
        wasmURL: wasmBlob,
      });

      ffmpegLoaded = true;
      ffmpegHint.textContent = "FFmpeg siap (CDN blob).";
      return ffmpeg;
    } catch (e) {
      throw new Error(
        "Gagal load FFmpeg (Failed to fetch / Worker blocked). " +
        "Solusi paling stabil di Vercel: taruh file ffmpeg-worker.js + ffmpeg-core.js + ffmpeg-core.wasm di root project lalu redeploy."
      );
    }
  })();

  return ffmpegLoading;
}

function clearAll() {
  queue = [];
  results.innerHTML = "";
  formatSelect.innerHTML = `<option value="">Pilih file dulu…</option>`;
  formatSelect.disabled = true;
  convertBtn.disabled = true;
  clearBtn.disabled = true;
  nameInput.value = "";
  qualityWrap.hidden = true;
  ffmpegHint.textContent = "";
  setProgress(0, "Belum ada file.");
}

clearBtn.addEventListener("click", () => {
  if (converting) return;
  clearAll();
});

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

function addResultCard({ outName, blob, kind, originalName }) {
  const url = URL.createObjectURL(blob);
  const div = document.createElement("div");
  div.className = "item";

  const row = document.createElement("div");
  row.className = "row";

  const left = document.createElement("div");
  left.innerHTML = `<div class="name">${escapeHtml(outName)}</div>
                    <div class="meta">from: ${escapeHtml(originalName)} • ${fmtBytes(blob.size)}</div>`;

  const right = document.createElement("div");
  right.className = "meta";
  right.textContent = kind;

  row.appendChild(left);
  row.appendChild(right);

  const btnline = document.createElement("div");
  btnline.className = "btnline";

  const a = document.createElement("a");
  a.className = "dl";
  a.href = url;
  a.download = outName;
  a.textContent = "Download";
  btnline.appendChild(a);

  const preview = document.createElement("div");
  preview.className = "preview";

  if (blob.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = outName;
    preview.appendChild(img);
  } else if (blob.type.startsWith("audio/")) {
    const au = document.createElement("audio");
    au.src = url;
    au.controls = true;
    preview.appendChild(au);
  } else {
    preview.style.display = "none";
  }

  div.appendChild(row);
  div.appendChild(btnline);
  div.appendChild(preview);

  results.prepend(div);
}

async function convertImage(file, outExt) {
  const q = Math.max(0.5, Math.min(1, Number(quality.value) / 100));
  const mime =
    outExt === "jpg" ? "image/jpeg" :
    outExt === "png" ? "image/png" :
    outExt === "webp" ? "image/webp" : null;

  if (!mime) throw new Error("Format image tidak didukung.");

  const bmp = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;

  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.drawImage(bmp, 0, 0);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Gagal export canvas."))),
      mime,
      (mime === "image/jpeg" || mime === "image/webp") ? q : undefined
    );
  });

  return { blob, mime };
}

async function convertMediaToAudio(file, outExt) {
  const ff = await ensureFFmpeg();

  const inExt = extOf(file.name) || "bin";
  const inName = `input.${inExt}`;
  const outName = `output.${outExt}`;

  setProgress(12, `Menulis file ke FFmpeg… (${file.name})`);
  await ff.writeFile(inName, await fetchFile(file));

  setProgress(18, `Converting via FFmpeg… (${outExt.toUpperCase()})`);

  if (outExt === "mp3") {
    await ff.exec(["-i", inName, "-vn", "-acodec", "libmp3lame", "-q:a", "2", outName]);
  } else if (outExt === "wav") {
    await ff.exec(["-i", inName, "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", outName]);
  } else {
    throw new Error("Output audio tidak didukung.");
  }

  const data = await ff.readFile(outName);

  try { await ff.deleteFile?.(inName); } catch {}
  try { await ff.deleteFile?.(outName); } catch {}

  const mime = outExt === "mp3" ? "audio/mpeg" : "audio/wav";
  const blob = new Blob([data], { type: mime });
  return { blob, mime };
}

function validatePerFile(file, outExt) {
  if (isImage(file) && ["png","jpg","webp"].includes(outExt)) return true;
  if (isVideoOrAudio(file) && ["mp3","wav"].includes(outExt)) return true;
  return false;
}

async function convertAll() {
  if (converting) return;
  if (!queue.length) return;

  const outExt = formatSelect.value;
  if (!outExt) return;

  converting = true;
  convertBtn.disabled = true;
  clearBtn.disabled = true;

  const total = queue.length;
  let done = 0;

  try {
    for (const file of queue) {
      done++;
      const label = `${done}/${total}`;

      if (!validatePerFile(file, outExt)) {
        addResultCard({
          outName: `SKIP_${file.name}`,
          blob: new Blob([`Tidak cocok: ${file.name} → ${outExt}`], { type: "text/plain" }),
          kind: "Skipped",
          originalName: file.name
        });
        setProgress(Math.round((done / total) * 100), `Skip ${label}: tipe tidak cocok`);
        continue;
      }

      const customBase = nameInput.value.trim();
      const outName = `${customBase ? customBase : baseName(file.name)}.${outExt}`;

      setProgress(Math.round(((done - 1) / total) * 100), `Memproses ${label}: ${file.name}`);

      let out;
      if (isImage(file)) out = await convertImage(file, outExt);
      else out = await convertMediaToAudio(file, outExt);

      addResultCard({
        outName,
        blob: out.blob,
        kind: out.blob.type,
        originalName: file.name
      });

      setProgress(Math.round((done / total) * 100), `Selesai ${label}: ${file.name}`);
    }
    setProgress(100, `Selesai semua (${total} file).`);
  } catch (err) {
    console.error(err);
    statusText.textContent = `Error: ${err?.message || err}`;
  } finally {
    converting = false;
    convertBtn.disabled = queue.length === 0 || !formatSelect.value;
    clearBtn.disabled = queue.length === 0;
  }
}

convertBtn.addEventListener("click", convertAll);

// Drag-drop UI
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  handleFiles([...(e.dataTransfer?.files || [])]);
});

fileInput.addEventListener("change", () => handleFiles([...(fileInput.files || [])]));

function handleFiles(files) {
  if (!files.length) return;
  queue = files.filter(f => f && f.size > 0);

  const opts = buildFormatOptions(queue);
  setSelectOptions(opts);

  const imgCount = queue.filter(isImage).length;
  const medCount = queue.filter(isVideoOrAudio).length;

  if (opts.length) {
    const auto = imgCount >= medCount
      ? (opts.find(o => o.value === "jpg") || opts[0])
      : (opts.find(o => o.value === "mp3") || opts[0]);
    formatSelect.value = auto.value;
    showQualityIfNeeded(auto.value);
  }

  convertBtn.disabled = !opts.length;
  clearBtn.disabled = false;

  statusText.textContent = `Siap: ${queue.length} file`;
  setProgress(0);

  if (queue.some(isVideoOrAudio)) {
    ffmpegHint.textContent = "Media terdeteksi. Preload FFmpeg…";
    warmupFFmpeg();
  } else {
    ffmpegHint.textContent = "";
  }
}

clearAll();
