import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { stat, writeFile, rename } from "node:fs/promises";
import { createLightingBridge } from "./lighting.mjs";
import { createSignatureStore } from "./store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const lightingConfigPath = path.join(dataDir, "lighting-config.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
// Once this many signatures are stored, new ones are refused with an error the
// iPad shows — stored signatures are never dropped to make room.
const maxSignatures = Number(process.env.MAX_SIGNATURES || 1000);
// Displays only draw the newest few in the marquee; the full list is staff-only
// via GET /api/signatures, so broadcasts stay small as the event goes on.
const recentSignatureLimit = 24;
// Lets walls notice a silently dead connection (venue Wi-Fi) and reconnect.
const heartbeatMs = 15000;
// Kept at/under the aurora video's natural length (8s, public/assets/aurora-final.mp4)
// so the video is still playing — not frozen on its last frame — when the
// exit fade begins. If the video file changes length, adjust this too.
const displayDurationMs = Number(process.env.DISPLAY_DURATION_MS || 7800);
// Staff token: show-control endpoints (cues, deletes, lighting) and every
// endpoint that returns signature strokes (walls, control console) require it.
// Set it before any real event: guests share the venue Wi-Fi with this
// server. Without a token, staff access is only left open on a loopback bind
// (127.0.0.1/localhost) or when explicitly opted into via
// ALLOW_UNSAFE_NO_CONTROL_TOKEN — anything else (e.g. the default 0.0.0.0)
// rejects those requests rather than failing open.
let controlToken = process.env.CONTROL_TOKEN || "";
const allowUnsafeNoToken = process.env.ALLOW_UNSAFE_NO_CONTROL_TOKEN === "1";
const isLoopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
// Remembers whatever was typed at the prompt below so this machine doesn't
// ask again next run. Lives under data/ (gitignored) — never committed, so
// this file is machine-local and not part of the public repo.
const controlTokenFile = path.join(dataDir, "control-token");

// Signing endpoints (POST /api/live-signature, /api/live-signature/clear,
// /api/signatures) are open by default (MVP: any device on the venue Wi-Fi
// can sign). Set SIGN_TOKEN to require iPads to present X-Sign-Token.
const signToken = process.env.SIGN_TOKEN || "";

const STAFF_ROLES = new Set(["wall", "control"]);
const WALL_ROLES = new Set(["wall"]);
const CONTROL_ROLES = new Set(["control"]);
const MIDI_ROLES = new Set(["midi"]);
const EVENT_ROLES = new Set(["wall", "control", "sign", "midi"]);

// EventSource cannot send headers, so the token may also arrive as ?token=.
function presentedToken(req, url, header) {
  return req.headers[header] || url.searchParams.get("token") || "";
}

function isStaff(req, url) {
  if (controlToken) return presentedToken(req, url, "x-control-token") === controlToken;
  return isLoopbackHost || allowUnsafeNoToken;
}

function isSigner(req, url) {
  if (!signToken) return true;
  return presentedToken(req, url, "x-sign-token") === signToken;
}

function loadSavedControlToken() {
  try {
    return readFileSync(controlTokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function saveControlToken(token) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(controlTokenFile, token, "utf8");
  } catch (error) {
    console.warn(`[security] could not save control token: ${error.message}`);
  }
}

function promptControlToken(defaultToken) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hint = defaultToken ? " (Enter to reuse the saved token)" : "";
    rl.question(`Set CONTROL_TOKEN for /control and the walls${hint}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultToken);
    });
  });
}

// CONTROL_TOKEN env wins outright (scripted/production start, no prompt).
// Otherwise, if this is an interactive terminal, ask once and remember the
// answer in controlTokenFile so the next `npm start` on this machine doesn't
// ask again. Non-interactive runs (systemd/CI/piped input) skip the prompt
// and fall through to the fail-closed check further below.
async function resolveControlToken() {
  if (controlToken) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const saved = loadSavedControlToken();
  const answer = await promptControlToken(saved);
  if (!answer) return;
  controlToken = answer;
  if (answer !== saved) saveControlToken(answer);
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

// MIDI has no port on the server: cues go to the MIDI bridge page(s), which
// play them through Web MIDI on the machine with the MIDI interface.
const lighting = createLightingBridge({
  initialConfig: loadLightingConfig(),
  onMidi: (event) => broadcast("midi", event, MIDI_ROLES)
});
const store = createSignatureStore({ dataDir });

const clients = new Map(); // SSE response -> role (wall | control | sign | midi)
const stored = store.load();
const signatures = stored.signatures;
let nextDoctorNumber = stored.nextDoctorNumber;
// Ids that already went through final submission. Late live frames for them
// are refused (they would pull the wall back into live mode), and a retried
// submission is acknowledged without storing or replaying it twice.
const submittedIds = new Set(signatures.map((signature) => signature.id));
// Seeded per boot so a wall that reconnects after a server restart never
// mistakes a new list for the one it already drew.
let signaturesVersion = Date.now();
let liveSignature = null;
let lastSignature = null;
let currentSignature = null;
// Server time (ms) when currentSignature's display window began. Walls time
// the reveal/exit from this plus serverNow, never from their own clock alone.
let activeSince = null;
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

function countClients(role) {
  let count = 0;
  for (const clientRole of clients.values()) if (clientRole === role) count += 1;
  return count;
}

function connectionCounts() {
  return {
    connectedDisplays: countClients("wall"),
    connectedSigners: countClients("sign"),
    connectedMidiBridges: countClients("midi")
  };
}

// What walls and the control console get. Only the newest signatures ride
// along (the marquee); the console fetches the full list when
// signaturesVersion changes.
function displayState() {
  return {
    status,
    sequence,
    lastUpdated,
    serverNow: Date.now(),
    activeSince,
    liveSignature,
    currentSignature,
    recentSignatures: signatures.slice(-recentSignatureLimit),
    signatureCount: signatures.length,
    signaturesVersion,
    displayDurationMs,
    hasLastSignature: Boolean(lastSignature),
    ...connectionCounts(),
    lighting: lighting.state()
  };
}

// Returns how many clients the event went to.
function broadcast(event, payload, roles = STAFF_ROLES) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  let reached = 0;
  for (const [res, role] of clients) {
    if (!roles.has(role)) continue;
    res.write(message);
    reached += 1;
  }
  return reached;
}

const heartbeat = setInterval(() => {
  for (const res of clients.keys()) res.write("event: ping\ndata: {}\n\n");
}, heartbeatMs);
heartbeat.unref();

function touch() {
  sequence += 1;
  lastUpdated = new Date().toISOString();
}

function touchStatus(nextStatus) {
  status = nextStatus;
  touch();
}

function doctorLabel(number) {
  return `醫師 ${String(number).padStart(2, "0")}`;
}

function signaturesChanged() {
  signaturesVersion += 1;
  store.save({ signatures, nextDoctorNumber });
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
    stopShow("idle", "auto-idle", "cue:auto-idle");
  }, displayDurationMs);
}

function startDisplay(signature, nextStatus, reason) {
  liveSignature = null;
  lastSignature = signature;
  currentSignature = signature;
  activeSince = Date.now();
  touchStatus(nextStatus);
  lighting.trigger("final", { reason });
  broadcast("signature:submitted", displayState());
  scheduleReturnToIdle(signature.id);
}

function stopShow(nextStatus, reason, event) {
  clearReturnTimer();
  liveSignature = null;
  currentSignature = null;
  activeSince = null;
  touchStatus(nextStatus);
  lighting.trigger(nextStatus === "blackout" ? "blackout" : "idle", { reason });
  const state = displayState();
  broadcast(event, state);
  return state;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sanitizeSignature(input) {
  if (!input || typeof input !== "object") {
    throw new Error("signature payload must be an object");
  }

  if (!Array.isArray(input.strokes) || input.strokes.length === 0) {
    throw new Error("signature payload requires at least one stroke");
  }

  // 4 decimals is 0.1 px on a 1000 px wide wall: far finer than any display,
  // and roughly halves the bytes of every live frame and stored signature.
  const strokes = input.strokes.slice(0, 120).map((stroke) => {
    if (!Array.isArray(stroke)) return [];
    return stroke.slice(0, 1200)
      .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)))
      .map((point) => ({
        x: round(clamp(Number(point.x), 0, 1), 4),
        y: round(clamp(Number(point.y), 0, 1), 4),
        p: round(clamp(Number(point.p ?? 0.5), 0, 1), 2)
      }));
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

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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
    ["/curtain", "/curtain.html"],
    ["/midi-bridge", "/midi-bridge.html"],
    ["/control", "/control.html"]
  ]);

  const targetPath = pageAliases.get(pathname) || pathname;
  const decoded = safeDecodeURIComponent(targetPath);
  if (decoded === null) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request");
    return;
  }
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

// Walls and the console get the show state; the iPad only gets connection
// liveness (hello + ping) — never other doctors' strokes.
function openEventStream(req, res, url) {
  const role = url.searchParams.get("role") || "";
  if (!EVENT_ROLES.has(role)) {
    json(res, 400, { ok: false, error: "role must be one of: wall, control, sign" });
    return;
  }
  const allowed = role === "sign" ? isSigner(req, url) : isStaff(req, url);
  if (!allowed) {
    json(res, 403, { ok: false, error: "forbidden: missing or wrong token" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1000\n\n");
  clients.set(res, role);
  if (role === "sign" || role === "midi") res.write(`event: hello\ndata: ${JSON.stringify({ role })}\n\n`);
  else res.write(`event: state\ndata: ${JSON.stringify(displayState())}\n\n`);
  broadcast("clients", connectionCounts(), CONTROL_ROLES);

  req.on("close", () => {
    clients.delete(res);
    broadcast("clients", connectionCounts(), CONTROL_ROLES);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Show control is gated, and so is anything that returns signature strokes.
  // Signing (POST /api/signatures, /api/live-signature) has its own token.
  const isControlRequest =
    (req.method === "POST" && (
      pathname.startsWith("/api/cue/") ||
      pathname.startsWith("/api/lighting/")
    )) ||
    (req.method === "DELETE" && pathname.startsWith("/api/signatures/"));
  const isStaffRead =
    req.method === "GET" &&
    (pathname === "/api/state" || pathname === "/api/signatures" || pathname === "/api/links" || pathname === "/api/lighting");

  if ((isControlRequest || isStaffRead) && !isStaff(req, url)) {
    json(res, 403, { ok: false, error: "forbidden: missing or wrong X-Control-Token" });
    return;
  }

  // Control actions are destructive or show-affecting: always leave a trace.
  // (The MIDI bridge's own port/result reports are routine, not operator actions.)
  if (isControlRequest && !pathname.startsWith("/api/lighting/midi-")) {
    console.log(`[control] ${new Date().toISOString()} ${req.method} ${pathname} from ${req.socket.remoteAddress}`);
  }

  const isSigningRequest =
    req.method === "POST" &&
    (pathname === "/api/live-signature" ||
      pathname === "/api/live-signature/clear" ||
      pathname === "/api/signatures");

  if (isSigningRequest && !isSigner(req, url)) {
    json(res, 403, { ok: false, error: "forbidden: missing or wrong X-Sign-Token" });
    return;
  }

  if (req.method === "GET" && pathname === "/events") {
    openEventStream(req, res, url);
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    json(res, 200, displayState());
    return;
  }

  if (req.method === "GET" && pathname === "/api/signatures") {
    json(res, 200, { ok: true, signatures, signatureCount: signatures.length, signaturesVersion });
    return;
  }

  // Ready-to-share page links with the right token baked in, for the
  // console's quick links (staff only: it reveals both tokens).
  if (req.method === "GET" && pathname === "/api/links") {
    const staffQuery = controlToken ? `?token=${encodeURIComponent(controlToken)}` : "";
    const signQuery = signToken ? `?token=${encodeURIComponent(signToken)}` : "";
    json(res, 200, {
      ok: true,
      links: {
        wall: `/wall${staffQuery}`,
        medicalWall: `/medical-wall${staffQuery}`,
        curtain: `/curtain${staffQuery}`,
        // Web MIDI needs a secure context: http://localhost on the server itself.
        midiBridge: `http://localhost:${server.address().port}/midi-bridge${staffQuery}`,
        control: `/control${staffQuery}`,
        sign: `/sign${signQuery}`
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/live-signature") {
    try {
      const signature = sanitizeSignature(await readJson(req));
      if (submittedIds.has(signature.id)) {
        json(res, 409, { ok: false, error: "signature already submitted" });
        return;
      }
      if (!signature.meta.doctorName) signature.meta.doctorName = doctorLabel(nextDoctorNumber);
      clearReturnTimer();
      currentSignature = null;
      activeSince = null;
      liveSignature = {
        ...signature,
        updatedAt: new Date().toISOString(),
        isLive: true
      };
      if (status !== "live_signing") {
        lighting.trigger("live", { reason: "pen-down" });
      }
      touchStatus("live_signing");
      // One frame per pen movement: send walls just the stroke being written,
      // not the retained list, and answer the iPad with an ack only.
      broadcast("signature:live", { status, sequence, liveSignature }, WALL_ROLES);
      json(res, 200, { ok: true, signatureId: signature.id });
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
    broadcast("signature:live-clear", displayState());
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/signatures") {
    try {
      const signature = sanitizeSignature(await readJson(req));
      if (submittedIds.has(signature.id)) {
        json(res, 200, { ok: true, signatureId: signature.id, duplicate: true });
        return;
      }
      if (signatures.length >= maxSignatures) {
        console.warn(`[store] refused ${signature.id}: ${signatures.length}/${maxSignatures} signatures stored (MAX_SIGNATURES)`);
        json(res, 409, { ok: false, error: `已達簽名上限 ${maxSignatures} 筆，請通知工作人員` });
        return;
      }
      if (!signature.meta.doctorName) {
        signature.meta.doctorName = doctorLabel(nextDoctorNumber);
        nextDoctorNumber += 1;
      }
      submittedIds.add(signature.id);
      signatures.push(signature);
      signaturesChanged();
      startDisplay(signature, "signature_received", "signature-submitted");
      json(res, 201, { ok: true, signatureId: signature.id });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/reset") {
    json(res, 200, { ok: true, state: stopShow("idle", "cue-reset", "cue:reset") });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/replay") {
    const target = signatures.at(-1) || lastSignature;
    if (!target) {
      json(res, 409, { ok: false, error: "no signature to replay" });
      return;
    }
    startDisplay(target, "replay", "cue-replay");
    json(res, 200, { ok: true, state: displayState() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/blackout") {
    json(res, 200, { ok: true, state: stopShow("blackout", "cue-blackout", "cue:blackout") });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/idle") {
    json(res, 200, { ok: true, state: stopShow("idle", "cue-idle", "cue:idle") });
    return;
  }

  if (req.method === "POST" && pathname === "/api/cue/clear-signatures") {
    // Wiping is irreversible from the UI, so snapshot to a backup file first.
    if (signatures.length > 0) {
      const backupPath = path.join(dataDir, `signatures-cleared-${Date.now()}.json`);
      try {
        mkdirSync(dataDir, { recursive: true });
        await writeFile(backupPath, JSON.stringify({ savedAt: new Date().toISOString(), nextDoctorNumber, signatures }, null, 2), "utf8");
        console.log(`[store] cleared ${signatures.length} signatures, backup: ${backupPath}`);
      } catch (error) {
        console.log(`[store] clear backup failed: ${error.message}`);
      }
    }
    signatures.length = 0;
    lastSignature = null;
    nextDoctorNumber = 1;
    signaturesChanged();
    json(res, 200, { ok: true, state: stopShow("idle", "clear-signatures", "cue:clear-signatures") });
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/signatures/")) {
    const id = safeDecodeURIComponent(pathname.slice("/api/signatures/".length));
    if (id === null) {
      json(res, 400, { ok: false, error: "invalid signature id" });
      return;
    }
    const index = signatures.findIndex((item) => item.id === id);
    if (index < 0) {
      json(res, 404, { ok: false, error: "signature not found" });
      return;
    }
    signatures.splice(index, 1);
    signaturesChanged();
    if (lastSignature?.id === id) lastSignature = signatures.at(-1) || null;
    if (currentSignature?.id === id) {
      json(res, 200, { ok: true, state: stopShow("idle", "signature-removed", "signature:removed") });
      return;
    }
    touch();
    const state = displayState();
    broadcast("signature:removed", state);
    json(res, 200, { ok: true, state });
    return;
  }

  if (req.method === "GET" && pathname === "/api/lighting") {
    json(res, 200, { ok: true, lighting: lighting.state(), cues: lighting.cues });
    return;
  }

  // Body: { outputs: [...] } — the whole output list, as edited in /control.
  if (req.method === "POST" && pathname === "/api/lighting/config") {
    try {
      const payload = await readJson(req);
      const lightingState = lighting.configure(payload);
      await saveLightingConfig(lightingState.config);
      broadcast("lighting:config", displayState());
      json(res, 200, { ok: true, lighting: lightingState });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  // Body: { cue, outputId? } — fire a cue now (all outputs, or just one).
  if (req.method === "POST" && pathname === "/api/lighting/cue") {
    try {
      const payload = await readJson(req);
      const cue = String(payload.cue || "").trim();
      if (!lighting.cues.includes(cue)) {
        json(res, 400, { ok: false, error: `cue must be one of: ${lighting.cues.join(", ")}` });
        return;
      }
      const outputId = payload.outputId ? String(payload.outputId) : undefined;
      const lightingState = lighting.trigger(cue, { reason: "manual-test", outputId });
      json(res, 200, { ok: true, lighting: lightingState });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  // From the MIDI bridge page: the MIDI output ports it can see.
  if (req.method === "POST" && pathname === "/api/lighting/midi-ports") {
    try {
      const payload = await readJson(req);
      lighting.setMidiPorts(payload.ports);
      broadcast("lighting:status", lighting.state(), CONTROL_ROLES);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  // From the MIDI bridge page: whether a cue's MIDI actually went out.
  if (req.method === "POST" && pathname === "/api/lighting/midi-result") {
    try {
      const payload = await readJson(req);
      lighting.recordMidiResult(String(payload.outputId || ""), { ok: Boolean(payload.ok), error: payload.error });
      broadcast("lighting:status", lighting.state(), CONTROL_ROLES);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  await serveStatic(req, res, pathname);
});

async function main() {
  await resolveControlToken();

  if (!controlToken && !isLoopbackHost) {
    console.warn(
      allowUnsafeNoToken
        ? `[security] CONTROL_TOKEN not set while bound to ${host}: control endpoints and signature data are OPEN to anyone on this network (ALLOW_UNSAFE_NO_CONTROL_TOKEN=1).`
        : `[security] CONTROL_TOKEN not set while bound to ${host}: /control and the walls will get 403 until CONTROL_TOKEN is set. Set ALLOW_UNSAFE_NO_CONTROL_TOKEN=1 to explicitly allow open access instead (not recommended for a real event).`
    );
  }
  if (!signToken && !isLoopbackHost) {
    console.warn(`[security] SIGN_TOKEN not set while bound to ${host}: any device on this network can draw live on the wall. Set SIGN_TOKEN and open the iPads with the /sign link from /control.`);
  }

  server.listen(port, host, () => {
    const actualPort = server.address().port;
    const urls = getLocalUrls(actualPort);
    console.log(`iPad Signature Receiver MVP running on port ${actualPort}`);
    console.log("Open on this computer:");
    console.log(`  http://localhost:${actualPort}`);
    console.log("Open from iPad on the same Wi-Fi:");
    for (const url of urls) console.log(`  ${url}`);
    const lightingState = lighting.state();
    const enabledOutputs = lightingState.config.outputs.filter((output) => output.enabled);
    console.log(`Lighting console outputs: ${enabledOutputs.length ? enabledOutputs.map((output) => `${output.name} (${output.type})`).join(", ") : "none enabled"}`);
    for (const output of lightingState.outputs) {
      if (output.lastError) console.warn(`[lighting] ${output.id}: ${output.lastError}`);
    }
    console.log(`Signatures restored: ${signatures.length} (${store.filePath})`);
    if (controlToken) console.log("Control token in effect: open /control?token=... and use its Quick Links for the walls and iPads.");
  });
}

main();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await store.flushNow();
  await lighting.close();
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
