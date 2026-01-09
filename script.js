import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

/* ===================== DOM ===================== */
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

/* ===================== CONFIG ===================== */
// Limit: 1GB per file
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

// FFmpeg assets (Wajib paling stabil di Vercel = local same-origin)
const LOCAL = {
  classWorkerURL: "/ffmpeg-worker.js",
  coreURL: "/ffmpeg-core.js",
  wasmURL: "/ffmpeg-core.wasm",
  workerURL: "/ffmpeg-core.worker.js", // optional
};

// CDN fallback (di-blob agar Worker tidak cross-origin)
const CDN = {
  ffmpegPkgBase: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm",
  coreBaseUmd: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd",
};

// Lists yang kamu minta (deteksi)
const IMG_EXT = new Set([
  "bmp","eps","gif","ico","jpeg","jpg","odd","png","psd","svg","tga","tiff","webp"
]);

const DOC_EXT = new Set([
  "doc","docx","pdf","ps","text","txt","word"
]);

const VID_EXT = new Set([
  "3gp","avi","flv","mkv","mov","mp4","ogv","webm","wmv"
]);

const AUD_EXT = new Set([
  "aac","aiff","alac","amr","flac","m4a","mp3","ogg","wav"
]);

// Output options (yang masuk akal client-side)
const OUTPUTS = {
  image: [
    { value: "png", label: "PNG" },
    { value: "jpg", label: "JPG" },
    { value: "webp", label: "WebP" },
    { value: "gif", label: "GIF" },
    { value: "bmp", label: "BMP" },
    { value: "tiff", label: "TIFF" },
    { value: "tga", label: "TGA" },
    // NOTE: SVG output dari raster itu tidak “convert” beneran (vectorize), jadi tidak disediakan.
    // ICO output sering butuh multi-size; disediakan "ico" tetap best-effort
    { value: "ico", label: "ICO (best-effort)" },
  ],
  video: [
    // Fokus percepat: video -> audio
    { value: "mp3", label: "MP3 (fast 128k)" },
    { value: "wav", label: "WAV" },
    { value: "ogg", label: "OGG (Opus/Vorbis)" },
    { value: "flac", label: "FLAC" },
    { value: "m4a", label: "M4A (AAC)" },
    { value: "alac", label: "ALAC (M4A)" },
    { value: "aiff", label: "AIFF" },
    { value: "amr", label: "AMR (best-effort)" },
  ],
  audio: [
    { value: "mp3", label: "MP3 (fast 128k)" },
    { value: "wav", label: "WAV" },
    { value: "ogg", label: "OGG (Opus/Vorbis)" },
    { value: "flac", label: "FLAC" },
    { value: "m4a", label: "M4A (AAC)" },
    { value: "alac", label: "ALAC (M4A)" },
    { value: "aiff", label: "AIFF" },
    { value: "amr", label: "AMR (best-effort)" },
  ],
  doc: [
    // yang bisa benar-benar tanpa server:
    { value: "txt", label: "TXT (copy/download saja)" },
  ],
};

/* ===================== STATE ===================== */
let queue = []; // [{file, kind}]
let converting = false;

// FFmpeg lazy
let ffmpeg = null;
let ffmpegLoaded = false;
let ffmpegLoading = null;

/* ===================== UTILS ===================== */
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

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

async function urlOk(url) {
  try {
    const r = await fetch(url, { method: "GET", cache: "no-store" });
    return r.ok;
  } catch { return false; }
}

function addResultCard({ outName, blob, kind, originalName, note }) {
  const url = URL.createObjectURL(blob);

  const div = document.createElement("div");
  div.className = "item";

  const row = document.createElement("div");
  row.className = "row";

  const left = document.createElement("div");
  left.innerHTML = `<div class="name">${escapeHtml(outName)}</div>
                    <div class="meta">from: ${escapeHtml(originalName)} • ${fmtBytes(blob.size)}</div>
                    ${note ? `<div class="meta">${escapeHtml(note)}</div>` : ""}`;

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

/* ===================== KIND DETECTION ===================== */
function detectKind(file) {
  const ext = extOf(file.name);

  // based on your list
  if (IMG_EXT.has(ext)) return "image";
  if (VID_EXT.has(ext)) return "video";
  if (AUD_EXT.has(ext)) return "audio";
  if (DOC_EXT.has(ext)) return "doc";

  // fallback by mime
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";

  return "unknown";
}

/* ===================== UI OPTIONS ===================== */
function setSelectOptionsForKind(kind) {
  const opts = OUTPUTS[kind] || [];
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

/* ===================== FFmpeg (fix Worker + preload) ===================== */
function warmupFFmpeg() {
  if (ffmpegLoaded || ffmpegLoading) return;
  ffmpegHint.textContent = "Menyiapkan FFmpeg (preload)…";
  const run = () => ensureFFmpeg().catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 200);
}

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

    // 1) local (paling cepat & stabil)
    const hasLocalClassWorker = await urlOk(LOCAL.classWorkerURL);
    const hasLocalCore = await urlOk(LOCAL.coreURL) && await urlOk(LOCAL.wasmURL);

    if (hasLocalClassWorker && hasLocalCore) {
      ffmpegHint.textContent = "FFmpeg: local assets (fast).";
      await ffmpeg.load({
        classWorkerURL: LOCAL.classWorkerURL,
        coreURL: LOCAL.coreURL,
        wasmURL: LOCAL.wasmURL,
        workerURL: (await urlOk(LOCAL.workerURL)) ? LOCAL.workerURL : undefined,
      });
      ffmpegLoaded = true;
      ffmpegHint.textContent = "FFmpeg siap (local).";
      return ffmpeg;
    }

    // 2) fallback CDN blob
    ffmpegHint.textContent = "FFmpeg: CDN fallback (blob)…";
    const classWorkerBlob = await toBlobURL(`${CDN.ffmpegPkgBase}/worker.js`, "text/javascript");
    const coreBlob = await toBlobURL(`${CDN.coreBaseUmd}/ffmpeg-core.js`, "text/javascript");
    const wasmBlob = await toBlobURL(`${CDN.coreBaseUmd}/ffmpeg-core.wasm`, "application/wasm");

    await ffmpeg.load({
      classWorkerURL: classWorkerBlob,
      coreURL: coreBlob,
      wasmURL: wasmBlob,
    });

    ffmpegLoaded = true;
    ffmpegHint.textContent = "FFmpeg siap (CDN blob).";
    return ffmpeg;
  })();

  return ffmpegLoading;
}

/* ===================== CONVERTERS ===================== */
function showQualityIfNeeded(kind, outExt) {
  // quality slider hanya relevan untuk jpg/webp output gambar
  qualityWrap.hidden = !(kind === "image" && (outExt === "jpg" || outExt === "webp"));
}

async function convertTextLike(file) {
  // hanya untuk txt/text: download ulang isinya (no “convert”)
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: "text/plain" });
  return { blob, mime: "text/plain", note: "Dokumen non-TXT (DOC/DOCX/PDF/PS/EPS) butuh backend untuk convert." };
}

async function convertImageFastCanvas(file, outExt) {
  // fast path: hanya kalau browser bisa decode + output jpg/png/webp
  const q = Math.max(0.5, Math.min(1, Number(quality.value) / 100));
  const mime =
    outExt === "jpg" ? "image/jpeg" :
    outExt === "png" ? "image/png" :
    outExt === "webp" ? "image/webp" : null;
  if (!mime) throw new Error("Canvas fast path hanya untuk PNG/JPG/WebP.");

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

function shouldUseCanvasFastPath(inExt, outExt) {
  // fast & ringan untuk input yang umumnya bisa didecode browser
  const decodable = new Set(["png","jpg","jpeg","webp","bmp","gif","svg"]);
  const outOk = new Set(["png","jpg","webp"]);
  return decodable.has(inExt) && outOk.has(outExt);
}

async function convertWithFFmpeg(file, kind, outExt) {
  const ff = await ensureFFmpeg();

  const inExt = extOf(file.name) || "bin";
  const inName = `input.${inExt}`;
  const outName = `output.${outExt}`;

  setProgress(12, `Menulis file ke FFmpeg… (${file.name})`);
  await ff.writeFile(inName, await fetchFile(file));

  setProgress(18, `Converting… (${outExt.toUpperCase()})`);

  // ===== IMAGE =====
  if (kind === "image") {
    // EPS/ODD/PS tricky: kemungkinan besar tidak bisa tanpa Ghostscript (tidak ada di build).
    if (inExt === "eps" || inExt === "ps" || inExt === "odd") {
      throw new Error(`Format ${inExt.toUpperCase()} butuh engine tambahan (Ghostscript). Tidak bisa full client-side.`);
    }

    // SVG -> raster ok; raster -> SVG tidak (vectorize)
    if (outExt === "svg") {
      throw new Error("Output SVG dari raster tidak didukung (butuh vectorize).");
    }

    // Convert image -> image (best effort)
    // Tambahan: kalau output ico, biasanya butuh resize. Kita buat 256px sebagai default.
    if (outExt === "ico") {
      await ff.exec([
        "-hide_banner","-loglevel","error",
        "-i", inName,
        "-vf", "scale=256:256:force_original_aspect_ratio=decrease",
        "-f","ico",
        outName
      ]);
    } else {
      await ff.exec([
        "-hide_banner","-loglevel","error",
        "-i", inName,
        outName
      ]);
    }

    const data = await ff.readFile(outName);

    try { await ff.deleteFile?.(inName); } catch {}
    try { await ff.deleteFile?.(outName); } catch {}

    const mimeMap = {
      png: "image/png",
      jpg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tga: "image/x-tga",
      ico: "image/x-icon",
    };
    const mime = mimeMap[outExt] || "application/octet-stream";
    return { blob: new Blob([data], { type: mime }), mime };
  }

  // ===== VIDEO/AUDIO -> AUDIO =====
  if (kind === "video" || kind === "audio") {
    // percepat audio-only:
    // -map 0:a:0? (ambil audio track pertama)
    // -vn -sn -dn (matikan video/sub/data)
    // mp3: CBR 128k (lebih cepat)
    const commonIn = ["-hide_banner","-loglevel","error","-i", inName, "-map","0:a:0?", "-vn","-sn","-dn"];

    if (outExt === "mp3") {
      await ff.exec([...commonIn, "-ac","2","-ar","44100", "-c:a","libmp3lame","-b:a","128k", outName]);
    } else if (outExt === "wav") {
      await ff.exec([...commonIn, "-ac","2","-ar","44100", "-c:a","pcm_s16le", outName]);
    } else if (outExt === "flac") {
      await ff.exec([...commonIn, "-c:a","flac", outName]);
    } else if (outExt === "ogg") {
      // Opus kalau ada, fallback vorbis tetap jalan tergantung build
      // coba opus dulu
      try {
        await ff.exec([...commonIn, "-c:a","libopus", "-b:a","128k", outName]);
      } catch {
        await ff.exec([...commonIn, "-c:a","libvorbis", "-q:a","4", outName]);
      }
    } else if (outExt === "m4a") {
      // AAC in MP4/M4A container
      await ff.exec([...commonIn, "-c:a","aac", "-b:a","192k", "-f","ipod", outName]);
    } else if (outExt === "alac") {
      await ff.exec([...commonIn, "-c:a","alac", "-f","ipod", outName]);
    } else if (outExt === "aiff") {
      await ff.exec([...commonIn, "-c:a","pcm_s16be", outName]);
    } else if (outExt === "amr") {
      // best-effort (butuh encoder amr_nb; bisa saja tidak ada di build)
      await ff.exec([...commonIn, "-ar","8000", "-ac","1", "-c:a","amr_nb", outName]);
    } else if (outExt === "aac") {
      await ff.exec([...commonIn, "-c:a","aac", "-b:a","192k", outName]);
    } else {
      throw new Error(`Output audio ${outExt.toUpperCase()} belum diset.`);
    }

    const data = await ff.readFile(outName);

    try { await ff.deleteFile?.(inName); } catch {}
    try { await ff.deleteFile?.(outName); } catch {}

    const mimeMap = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      flac: "audio/flac",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
      alac: "audio/mp4",
      aiff: "audio/aiff",
      amr: "audio/amr",
      aac: "audio/aac",
    };
    const mime = mimeMap[outExt] || "application/octet-stream";
    return { blob: new Blob([data], { type: mime }), mime };
  }

  throw new Error("Kind tidak didukung untuk FFmpeg convert.");
}

async function convertOne(file, kind, outExt) {
  const inExt = extOf(file.name);

  // DOC/DOCX/PDF/PS/EPS: tidak bisa full tanpa backend
  if (kind === "doc") {
    if (inExt === "txt" || inExt === "text") {
      if (outExt !== "txt") throw new Error("TXT/TEXT hanya support output TXT.");
      return await convertTextLike(file);
    }
    throw new Error("DOC/DOCX/PDF/PS/EPS/WORD butuh backend untuk convert. (client-side saja tidak cukup)");
  }

  if (kind === "image") {
    showQualityIfNeeded(kind, outExt);

    // canvas fast path untuk cepat
    if (shouldUseCanvasFastPath(inExt, outExt)) {
      try {
        return await convertImageFastCanvas(file, outExt);
      } catch {
        // fallback ke ffmpeg
      }
    }
    return await convertWithFFmpeg(file, kind, outExt);
  }

  if (kind === "video" || kind === "audio") {
    return await convertWithFFmpeg(file, kind, outExt);
  }

  throw new Error("Format file tidak dikenali.");
}

/* ===================== FLOW ===================== */
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

formatSelect.addEventListener("change", () => {
  const kind = queue[0]?.kind;
  const outExt = formatSelect.value;
  if (kind) showQualityIfNeeded(kind, outExt);
  if ((kind === "video" || kind === "audio" || kind === "image") && outExt) warmupFFmpeg();
});

async function convertAll() {
  if (converting) return;
  if (!queue.length) return;

  // NOTE: Untuk sederhana: output format yang sama untuk semua file di batch.
  const outExt = formatSelect.value;
  if (!outExt) return;

  converting = true;
  convertBtn.disabled = true;
  clearBtn.disabled = true;

  const total = queue.length;
  let done = 0;

  try {
    for (const item of queue) {
      done++;
      const file = item.file;
      const kind = item.kind;
      const label = `${done}/${total}`;

      const customBase = nameInput.value.trim();
      const outName = `${customBase ? customBase : baseName(file.name)}.${outExt}`;

      setProgress(Math.round(((done - 1) / total) * 100), `Memproses ${label}: ${file.name}`);

      try {
        const out = await convertOne(file, kind, outExt);

        addResultCard({
          outName,
          blob: out.blob,
          kind: out.blob.type,
          originalName: file.name,
          note: out.note || ""
        });

        setProgress(Math.round((done / total) * 100), `Selesai ${label}: ${file.name}`);
      } catch (e) {
        // tampilkan error per file jadi user tahu mana yang gagal
        addResultCard({
          outName: `FAILED_${file.name}.txt`,
          blob: new Blob([`GAGAL: ${file.name}\n\n${e?.message || e}`], { type: "text/plain" }),
          kind: "Error",
          originalName: file.name
        });
        setProgress(Math.round((done / total) * 100), `Gagal ${label}: ${file.name}`);
      }
    }

    setProgress(100, `Selesai semua (${total} file).`);
  } finally {
    converting = false;
    convertBtn.disabled = queue.length === 0 || !formatSelect.value;
    clearBtn.disabled = queue.length === 0;
  }
}

convertBtn.addEventListener("click", convertAll);

// Drag-drop
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

  const accepted = [];
  const rejected = [];

  for (const f of files) {
    if (!f || f.size <= 0) continue;
    if (f.size > MAX_FILE_BYTES) rejected.push(f);
    else accepted.push(f);
  }

  // simple mode: batch file boleh campur, tapi output dropdown mengikuti file pertama
  queue = accepted.map((file) => ({ file, kind: detectKind(file) }));

  results.innerHTML = "";

  if (!queue.length) {
    statusText.textContent = `Tidak ada file yang lolos (max 1GB/file).`;
    setProgress(0);
    convertBtn.disabled = true;
    clearBtn.disabled = true;
    formatSelect.innerHTML = `<option value="">Pilih file dulu…</option>`;
    formatSelect.disabled = true;
    ffmpegHint.textContent = rejected.length ? `Ditolak karena >1GB: ${rejected[0].name}` : "";
    return;
  }

  // set format options based on first file kind
  const firstKind = queue[0].kind;
  setSelectOptionsForKind(firstKind);

  // auto select default
  if (firstKind === "image") formatSelect.value = "jpg";
  else if (firstKind === "video" || firstKind === "audio") formatSelect.value = "mp3";
  else if (firstKind === "doc") formatSelect.value = "txt";

  showQualityIfNeeded(firstKind, formatSelect.value);

  convertBtn.disabled = false;
  clearBtn.disabled = false;

  const list = queue.slice(0, 3).map(x => `${x.file.name} (${fmtBytes(x.file.size)})`).join(" • ");
  const more = queue.length > 3 ? ` • +${queue.length - 3} file` : "";
  statusText.textContent = `Siap: ${queue.length} file (max 1GB/file) — ${list}${more}`;
  setProgress(0);

  if (rejected.length) {
    const names = rejected.slice(0, 2).map(x => `${x.name} (${fmtBytes(x.size)})`).join(", ");
    const moreR = rejected.length > 2 ? ` +${rejected.length - 2} lagi` : "";
    ffmpegHint.textContent = `Ditolak (>1GB): ${names}${moreR}`;
  } else {
    ffmpegHint.textContent = "";
  }

  // Warmup ffmpeg kalau butuh
  if (firstKind === "image" || firstKind === "video" || firstKind === "audio") {
    warmupFFmpeg();
  }
}

clearAll();
