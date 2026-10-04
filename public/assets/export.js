// One-click export of the retained signatures (used by /control).
//
// signatures-<date>.zip
//   png/doctor-01.png   white background, black ink, 2000 px on the long side
//   svg/doctor-01.svg   vector, transparent background, black ink
//   index.csv           編號 / 醫師 / 簽名時間 / file names (UTF-8 BOM for Excel)
//   signatures.json     the raw stored data
//
// Each signature is cropped to its own strokes and drawn in the iPad's pixel
// space, so the proportions are what the doctor saw while signing.

const PNG_LONG_SIDE = 2000;
const INK_WIDTH = 4; // same line width the iPad shows while signing
const PADDING_RATIO = 0.06;
const FALLBACK_CANVAS = { width: 1000, height: 500 };

export async function buildSignatureExport(signatures, { now = new Date(), onProgress = () => {} } = {}) {
  const encoder = new TextEncoder();
  const files = [];
  const rows = [["編號", "醫師", "簽名時間", "PNG", "SVG", "簽名 ID"]];
  const usedNames = new Set();

  for (const [index, signature] of signatures.entries()) {
    onProgress(index + 1, signatures.length);
    const base = uniqueName(fileBase(signature, index), usedNames);
    files.push({ name: `png/${base}.png`, data: await signatureToPng(signature) });
    files.push({ name: `svg/${base}.svg`, data: encoder.encode(signatureToSvg(signature)) });
    rows.push([
      index + 1,
      signature.meta?.doctorName || "",
      formatLocalTime(signature.createdAt),
      `png/${base}.png`,
      `svg/${base}.svg`,
      signature.id
    ]);
  }

  const csv = "\uFEFF" + rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
  files.push({ name: "index.csv", data: encoder.encode(csv) });
  files.push({
    name: "signatures.json",
    data: encoder.encode(JSON.stringify({ exportedAt: now.toISOString(), signatures }, null, 2))
  });

  return { blob: createZip(files, now), fileName: `signatures-${fileStamp(now)}.zip` };
}

function signatureToSvg(signature) {
  const { strokes, box } = signatureGeometry(signature);
  const paths = strokes.map((stroke) => `    <path d="${pathData(stroke)}"/>`).join("\n");
  const width = round1(box.width);
  const height = round1(box.height);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round1(box.x)} ${round1(box.y)} ${width} ${height}" width="${width}" height="${height}">
  <title>${escapeXml(signature.meta?.doctorName || signature.id)}</title>
  <g fill="none" stroke="#000" stroke-width="${INK_WIDTH}" stroke-linecap="round" stroke-linejoin="round">
${paths}
  </g>
</svg>
`;
}

async function signatureToPng(signature) {
  const { strokes, box } = signatureGeometry(signature);
  const scale = PNG_LONG_SIDE / Math.max(box.width, box.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = INK_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    ctx.beginPath();
    stroke.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    // A single point (an i-dot) needs a zero-length segment to show its round cap.
    if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.01, stroke[0].y);
    ctx.stroke();
  }
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("PNG encoding failed"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function signatureGeometry(signature) {
  const width = Number(signature.canvas?.width) || FALLBACK_CANVAS.width;
  const height = Number(signature.canvas?.height) || FALLBACK_CANVAS.height;
  const strokes = (signature.strokes || [])
    .map((stroke) => stroke.map((point) => ({ x: point.x * width, y: point.y * height })))
    .filter((stroke) => stroke.length > 0);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) {
    return { strokes, box: { x: 0, y: 0, width, height } };
  }
  const pad = Math.max(maxX - minX, maxY - minY, 1) * PADDING_RATIO + INK_WIDTH;
  return {
    strokes,
    box: { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 }
  };
}

function pathData(stroke) {
  const d = stroke.map((point, index) => `${index === 0 ? "M" : "L"}${round1(point.x)} ${round1(point.y)}`).join(" ");
  return stroke.length === 1 ? `${d} l0.01 0` : d;
}

// "醫師 07" -> doctor-07; anything else falls back to its position in the list.
function fileBase(signature, index) {
  const number = /(\d+)\s*$/.exec(signature.meta?.doctorName || "")?.[1];
  return `doctor-${number || String(index + 1).padStart(2, "0")}`;
}

function uniqueName(base, used) {
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`;
  used.add(name);
  return name;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]);
}

function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function fileStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

// ---- Minimal ZIP writer (stored entries, UTF-8 names) ---------------------
// PNGs are already compressed and the rest is small, so no deflate is needed.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function createZip(files, date = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(date);
  const UTF8_NAMES = 0x0800;
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    localParts.push(local.buffer, name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8_NAMES, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, day, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centralParts.push(central.buffer, name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, end.buffer], { type: "application/zip" });
}
