import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, readFileSync, mkdirSync } from "node:fs";
import { stat, writeFile, rename } from "node:fs/promises";
import { createLightingBridge } from "./lighting.mjs";
import { createSignatureStore } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const lightingConfigPath = path.join(dataDir, "lighting-config.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const maxSignatures = Number(process.env.MAX_SIGNATURES || 80);
const displayDurationMs = Number(process.env.DISPLAY_DURATION_MS || 9500);
// Show-control endpoints (cues, deletes, lighting) require this token when
// set. Signing and display endpoints stay open. Set it before any real event:
// guests share the venue Wi-Fi with this server.
const controlToken = process.env.CONTROL_TOKEN || "";

function isAuthorized(req) {
  return !controlToken || req.headers["x-control-token"] === controlToken;
}

function loadLightingConfig() {
  try {
    return JSON.parse(readFileSync(lightingConfigPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.log(`[lighting] config load failed, using defaults: ${error.message}`);
    }
    return {};
  }
}

async function saveLightingConfig(config) {
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmpPath = `${lightingConfigPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(config, null, 2), "utf8");
    await rename(tmpPath, lightingConfigPath);
  } catch (error) {
    console.log(`[lighting] config save failed: ${error.message}`);
  }
}

const lighting = createLightingBridge({ initialConfig: loadLightingConfig() });
const store = createSignatureStore({ dataDir });

const clients = new Set();
const signatures = store.load();
let liveSignature = null;
let lastSignature = null;
let currentSignature = null;
let status = "idle";
let sequence = 0;
let lastUpdated = new Date().toISOString();
let returnTimer = null;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"]
]);

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function currentState() {
  return {
    status,
    sequence,
    lastUpdated,
    liveSignature,
    currentSignature,
    signatures,
    signatureCount: signatures.length,
    displayDurationMs,
    hasLastSignature: Boolean(lastSignature),
    connectedDisplays: clients.size,
    lighting: lighting.state()
  };
}

function broadcast(event, payload) {
  const data = JSON.stringify(payload);
  for (const res of clients) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

function touch() {
  sequence += 1;
  lastUpdated = new Date().toISOString();
}

function touchStatus(nextStatus) {
  status = nextStatus;
  touch();
}

function clearReturnTimer() {
  if (returnTimer) {
    clearTimeout(returnTimer);
    returnTimer = null;
  }
}

function scheduleReturnToIdle(signatureId) {
  clearReturnTimer();
  returnTimer = setTimeout(() => {
    if (currentSignature?.id !== signatureId) return;
    currentSignature = null;
    touchStatus("idle");
    lighting.trigger("idle", { reason: "auto-idle" });
    const state = currentState();
    broadcast("cue:auto-idle", state);
  }, displayDurationMs);
}

function sanitizeSignature(input) {
  if (!input || typeof input !== "object") {
    throw new Error("signature payload must be an object");
  }

  if (!Array.isArray(input.strokes) || input.strokes.length === 0) {
    throw new Error("signature payload requires at least one stroke");
  }

  const strokes = input.strokes.slice(0, 120).map((stroke) => {
    if (!Array.isArray(stroke)) return [];
    return stroke.slice(0, 1200).map((point) => ({
      x: clamp(Number(point.x), 0, 1),
      y: clamp(Number(point.y), 0, 1),
      p: clamp(Number(point.p ?? 0.5), 0, 1)
    })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  }).filter((stroke) => stroke.length > 0);

  if (strokes.length === 0) {
    throw new Error("signature payload has no valid points");
  }

  return {
    id: safeSignatureId(input.id) || `sig-${Date.now()}`,
    createdAt: new Date().toISOString(),
    canvas: {
      width: Number(input.canvas?.width || 0),
      height: Number(input.canvas?.height || 0)
    },
    meta: {
      doctorName: String(input.meta?.doctorName || input.meta?.displayName || "").trim().slice(0, 80),
      source: String(input.meta?.source || "ipad-sign-page"),
      userAgent: String(input.meta?.userAgent || "").slice(0, 240)
    },
    strokes
  };
}

function safeSignatureId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) return "";
  return id;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, pathname) {
  const pageAliases = new Map([
    ["/", "/index.html"],
    ["/sign", "/sign.html"],
    ["/wall", "/wall.html"],
    ["/medical-wall", "/medical-wall.html"],
    ["/control", "/control.html"]
  ]);

  const targetPath = pageAliases.get(pathname) || pathname;
  const decoded = decodeURIComponent(targetPath);
  const safePath = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const ext = path.extname(filePath);
    const contentType = mimeTypes.get(ext) || "application/octet-stream";

    // Range support so <video> can seek/loop smoothly.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (start >= info.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
      });
      pipeFile(filePath, res, { start, end });
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": info.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    });
    pipeFile(filePath, res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// An unhandled "error" on a read stream would crash the whole process
// (wall, iPad and lighting all go down) — swallow it and drop the response.
function pipeFile(filePath, res, options) {
  const stream = createReadStream(filePath, options);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Show control is gated; signing (POST /api/signatures, /api/live-signature)
  // and read-only display endpoints stay open.
  const isControlRequest =
    (req.method === "POST" && (
      pathname.startsWith("/api/cue/") ||
      pathname === "/api/lighting/config" ||
      pathname === "/api/lighting/cue"
    )) ||
    (req.method === "DELETE" && pathname.startsWith("/api/signatures/"));

  if (isControlRequest && !isAuthorized(req)) {
    json(res, 403, { ok: false, error: "forbidden: missing or wrong X-Control-Token" });
    return;
  }

  // Control actions are destructive or show-affecting: always leave a trace.
  if (isControlRequest) {
    console.log(`[control] ${new Date().toISOString()} ${req.method} ${pathname} from ${req.socket.remoteAddress}`);
  }

  if (req.method === "GET" && pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 1000\n\n");
    clients.add(res);
    res.write(`event: state\n`);
    res.write(`data: ${JSON.stringify(currentState())}\n\n`);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    json(res, 200, currentState());
    return;
  }

  if (req.method === "GET" && pathname === "/api/signatures") {
    json(res, 200, { ok: true, signatures, signatureCount: signatures.length });
    return;
  }

  if (req.method === "POST" && pathname === "/api/live-signature") {
    try {
      const payload = await readJson(req);
      const signature = sanitizeSignature(payload);
      if (!signature.meta.doctorName) {
        signature.meta.doctorName = `醫師 ${String(signatures.length + 1).padStart(2, "0")}`;
      }
      clearReturnTimer();
      currentSignature = null;
      liveSignature = {
        ...signature,
        updatedAt: new Date().toISOString(),
        isLive: true
      };
      if (status !== "live_signing") {
        lighting.trigger("live", { reason: "pen-down" });
      }
      touchStatus("live_signing");
      const state = currentState();
      broadcast("signature:live", state);
      json(res, 200, { ok: true, signatureId: signature.id, state });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/live-signature/clear") {
    liveSignature = null;
    if (!currentSignature) {
      touchStatus("idle");
      lighting.trigger("idle", { reason: "live-clear" });
    }
    const state = currentState();
    broadcast("signature:live-clear", state);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "POST" && pathname === "/api/signatures") {
    try {
      const payload = await readJson(req);
      const signature = sanitizeSignature(payload);
      if (!signature.meta.doctorName) {
        signature.meta.doctorName = `醫師 ${String(signatures.length + 1).padStart(2, "0")}`;
      }
      liveSignature = null;
      const existingIndex = signatures.findIndex((item) => item.id === signature.id);
      if (existingIndex >= 0) signatures.splice(existingIndex, 1, signature);
      else signatures.push(signature);
      while (signatures.length > maxSignatures) signatures.shift();
      lastSignature = signature;
      currentSignature = signature;
      touchStatus("signature_received");
      lighting.trigger("final", { reason: "signature-submitted", durationMs: displayDurationMs });
      store.save(signatures);
      const state = currentState();
      broadcast("signature:submitted", state);
      scheduleReturnToIdle(signature.id);
      json(res, 201, { ok: true, signatureId: signature.id, state });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/reset") {
    clearReturnTimer();
    liveSignature = null;
    currentSignature = null;
    touchStatus("idle");
    lighting.trigger("idle", { reason: "cue-reset" });
    const state = currentState();
    broadcast("cue:reset", state);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/replay") {
    liveSignature = null;
    lastSignature = signatures.at(-1) || lastSignature;
    if (!lastSignature) {
      json(res, 409, { ok: false, error: "no signature to replay" });
      return;
    }
    currentSignature = lastSignature;
    touchStatus("replay");
    lighting.trigger("final", { reason: "cue-replay", durationMs: displayDurationMs });
    const state = currentState();
    broadcast("signature:submitted", state);
    scheduleReturnToIdle(lastSignature.id);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/blackout") {
    clearReturnTimer();
    liveSignature = null;
    currentSignature = null;
    touchStatus("blackout");
    lighting.trigger("blackout", { reason: "cue-blackout" });
    const state = currentState();
    broadcast("cue:blackout", state);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/idle") {
    clearReturnTimer();
    liveSignature = null;
    currentSignature = null;
    touchStatus("idle");
    lighting.trigger("idle", { reason: "cue-idle" });
    const state = currentState();
    broadcast("cue:idle", state);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/clear-signatures") {
    clearReturnTimer();
    // Wiping is irreversible from the UI, so snapshot to a backup file first.
    if (signatures.length > 0) {
      const backupPath = path.join(dataDir, `signatures-cleared-${Date.now()}.json`);
      try {
        mkdirSync(dataDir, { recursive: true });
        await writeFile(backupPath, JSON.stringify({ savedAt: new Date().toISOString(), signatures }, null, 2), "utf8");
        console.log(`[store] cleared ${signatures.length} signatures, backup: ${backupPath}`);
      } catch (error) {
        console.log(`[store] clear backup failed: ${error.message}`);
      }
    }
    signatures.length = 0;
    liveSignature = null;
    currentSignature = null;
    lastSignature = null;
    touchStatus("idle");
    lighting.trigger("idle", { reason: "clear-signatures" });
    store.save(signatures);
    const state = currentState();
    broadcast("cue:clear-signatures", state);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/signatures/")) {
    const id = decodeURIComponent(pathname.slice("/api/signatures/".length));
    const index = signatures.findIndex((item) => item.id === id);
    if (index < 0) {
      json(res, 404, { ok: false, error: "signature not found" });
      return;
    }
    signatures.splice(index, 1);
    if (lastSignature?.id === id) lastSignature = signatures.at(-1) || null;
    if (currentSignature?.id === id) {
      clearReturnTimer();
      currentSignature = null;
      touchStatus("idle");
      lighting.trigger("idle", { reason: "signature-removed" });
    } else {
      touch();
    }
    store.save(signatures);
    const state = currentState();
    broadcast("signature:removed", state);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "GET" && pathname === "/api/lighting") {
    json(res, 200, { ok: true, lighting: lighting.state(), cues: lighting.cues });
    return;
  }

  if (req.method === "POST" && pathname === "/api/lighting/config") {
    try {
      const payload = await readJson(req);
      const lightingState = lighting.configure(payload);
      await saveLightingConfig(lightingState.config);
      broadcast("lighting:config", currentState());
      json(res, 200, { ok: true, lighting: lightingState });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/lighting/cue") {
    try {
      const payload = await readJson(req);
      const cue = String(payload.cue || "").trim();
      if (!lighting.cues.includes(cue)) {
        json(res, 400, { ok: false, error: `cue must be one of: ${lighting.cues.join(", ")}` });
        return;
      }
      const lightingState = lighting.trigger(cue, {
        reason: "manual-test",
        durationMs: cue === "final" ? displayDurationMs : 0
      });
      json(res, 200, { ok: true, lighting: lightingState });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  await serveStatic(req, res, pathname);
});

server.listen(port, host, () => {
  const urls = getLocalUrls(port);
  console.log(`iPad Signature Receiver MVP running on port ${port}`);
  console.log("Open on this computer:");
  console.log(`  http://localhost:${port}`);
  console.log("Open from iPad on the same Wi-Fi:");
  for (const url of urls) console.log(`  ${url}`);
  const lightingState = lighting.state();
  console.log(`Lighting signal mode: ${lightingState.mode}`);
  if (lightingState.mode.startsWith("artnet")) {
    const a = lightingState.config.artnet;
    console.log(`  Art-Net -> ${a.host}:${a.port} universe ${a.universe}` +
      (lightingState.mode === "artnet-trigger"
        ? ` trigger ch${a.triggerChannel} (idle:${a.triggerValues.idle} live:${a.triggerValues.live} final:${a.triggerValues.final} blackout:${a.triggerValues.blackout})`
        : ` (${a.parCount}x ${a.profile} PAR @ ${a.fps}fps)`));
  }
  if (lightingState.mode === "osc") {
    const o = lightingState.config.osc;
    console.log(`  OSC -> ${o.host}:${o.port} ${o.address}`);
  }
  console.log(`Signatures restored: ${signatures.length} (${store.filePath})`);
});

function shutdown() {
  store.flushSync();
  lighting.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function getLocalUrls(serverPort) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${serverPort}`);
      }
    }
  }
  return urls;
}
