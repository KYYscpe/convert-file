// Vanilla converter: images via Canvas, audio/video via FFmpeg.wasm.
// API FFmpeg modern: new FFmpeg(), load(), writeFile(), exec(), readFile() :contentReference[oaicite:3]{index=3}

import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.15";
import { fetchFile, toBlobURL } from "https://esm.sh/@ffmpeg/util@0.12.1";

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

// FFmpeg loader (lazy)
let ffmpeg = null;
let ffmpegLoaded = false;

// Repo release indicates main/core versions can differ; using main 0.12.15 + core 0.12.10 :contentReference[oaicite:4]{index=4}
const FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";

function setProgress(pct, text = "") {
  const v = Math.max(0, Math.min(100, pct));
  barFill.style.width = `${v}%`;
  if (text) statusText.textContent = text;
}

function fmtBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
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
  // include webp
  return file.type.startsWith("image/") || ["png","jpg","jpeg","webp"].includes(extOf(file.name));
}

function isVideoOrAudio(file) {
  return file.type.startsWith("video/") || file.type.startsWith("audio/") ||
    ["mp4","mov","webm","mkv","m4a","aac","wav","mp3","ogg"].includes(extOf(file.name));
}

function buildFormatOptions(files) {
  // if mixed, show union but still validate per file during convert
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
  if (format === "jpg" || format === "webp") qualityWrap.hidden = false;
  else qualityWrap.hidden = true;
}

formatSelect.addEventListener("change", () => {
  showQualityIfNeeded(formatSelect.value);
});

async function ensureFFmpeg() {
  if (ffmpegLoaded) return ffmpeg;

  ffmpegHint.textContent = "Loading FFmpeg core (sekali saja)…";
  setProgress(5, "Menyiapkan FFmpeg…");

  ffmpeg = new FFmpeg();

  // Use toBlobURL for core/wasm/worker setup :contentReference[oaicite:5]{index=5}
  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    workerURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.worker.js`, "text/javascript"),
  });

  // Progress callback (best-effort)
  try {
    ffmpeg.on("progress", ({ progress }) => {
      // progress: 0..1
      const pct = 10 + Math.round(progress * 85);
      setProgress(pct);
    });
  } catch (_) {}

  ffmpegLoaded = true;
  ffmpegHint.textContent = "FFmpeg siap.";
  return ffmpeg;
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
  } else if (blob.type.startsWith("video/")) {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    preview.appendChild(v);
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

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

async function convertImage(file, outExt) {
  const q = Math.max(0.5, Math.min(1, Number(quality.value) / 100));
  const mime = outExt === "jpg" ? "image/jpeg"
            : outExt === "png" ? "image/png"
            : outExt === "webp" ? "image/webp"
            : null;

  if (!mime) throw new Error("Format image tidak didukung.");

  // Decode → canvas
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;

  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.drawImage(bmp, 0, 0);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Gagal export canvas."))),
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

  // Write file
  setProgress(12, `Menulis file ke FFmpeg FS… (${file.name})`);
  await ff.writeFile(inName, await fetchFile(file)); // :contentReference[oaicite:6]{index=6}

  // Commands (examples follow common FFmpeg usage) :contentReference[oaicite:7]{index=7}
  setProgress(18, `Converting via FFmpeg… (${outExt.toUpperCase()})`);

  if (outExt === "mp3") {
    // extract audio, encode mp3
    await ff.exec(["-i", inName, "-vn", "-acodec", "libmp3lame", "-q:a", "2", outName]);
  } else if (outExt === "wav") {
    // extract audio, PCM 16-bit
    await ff.exec(["-i", inName, "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", outName]);
  } else {
    throw new Error("Output audio tidak didukung.");
  }

  const data = await ff.readFile(outName);
  // Cleanup (best-effort)
  try { await ff.deleteFile(inName); } catch (_) {}
  try { await ff.deleteFile(outName); } catch (_) {}

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
      if (isImage(file)) {
        out = await convertImage(file, outExt);
      } else {
        ffmpegHint.textContent = "FFmpeg dipakai untuk media. Pertama kali bisa agak lama (download core).";
        out = await convertMediaToAudio(file, outExt);
      }

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
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const files = [...(e.dataTransfer?.files || [])];
  handleFiles(files);
});

fileInput.addEventListener("change", () => {
  const files = [...fileInput.files];
  handleFiles(files);
});

function handleFiles(files) {
  if (!files.length) return;

  // keep only "real" files
  queue = files.filter(f => f && f.size > 0);

  const opts = buildFormatOptions(queue);
  setSelectOptions(opts);

  // auto select: prefer image->jpg if mostly images; else mp3 if mostly media
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

  const list = queue.map(f => `${f.name} (${fmtBytes(f.size)})`).join(" • ");
  statusText.textContent = `Siap: ${queue.length} file — ${list}`;
  setProgress(0);

  // hint if FFmpeg likely needed
  if (queue.some(isVideoOrAudio) && ["mp3","wav"].includes(formatSelect.value)) {
    ffmpegHint.textContent = "Mode FFmpeg: proses bisa lebih lama, terutama pertama kali.";
  } else {
    ffmpegHint.textContent = "";
  }
}

// Init
clearAll();
