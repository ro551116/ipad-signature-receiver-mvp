export function signatureToPath(signature, width = 1000, height = 500) {
  if (!signature?.strokes?.length) return "";
  return signature.strokes.map((stroke) => strokeToPath(stroke, width, height)).join(" ");
}

export function strokeToPath(stroke, width = 1000, height = 500) {
  return stroke.map((point, index) => {
    const x = Math.round(point.x * width * 10) / 10;
    const y = Math.round(point.y * height * 10) / 10;
    return `${index === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");
}

// One d-string per stroke, in writing order, so the wall can replay
// the signature stroke by stroke instead of revealing everything at once.
export function signatureToStrokePaths(signature, width = 1000, height = 500) {
  if (!signature?.strokes?.length) return [];
  return signature.strokes.map((stroke) => strokeToPath(stroke, width, height));
}

// The server pings every 15s; if nothing arrives for this long the
// connection is assumed dead (e.g. venue Wi-Fi dropped silently) and reopened.
const silenceLimitMs = 40000;

// role: "wall" | "control" | "sign". Walls and the console need the staff
// token; the iPad uses the sign token and only receives liveness events.
export function connectEvents(role, handlers = {}) {
  const setConnection = handlers.connection || (() => {});
  const token = role === "sign" ? signToken() : controlToken();
  const query = new URLSearchParams({ role });
  if (token) query.set("token", token);
  const url = `/events?${query}`;
  let source = null;
  let watchdog = null;

  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      setConnection(false);
      open();
    }, silenceLimitMs);
  }

  function open() {
    source?.close();
    source = new EventSource(url);
    source.onopen = () => {
      setConnection(true);
      armWatchdog();
    };
    source.onerror = () => setConnection(false);
    source.addEventListener("ping", armWatchdog);
    for (const [event, handler] of Object.entries(handlers)) {
      if (event === "connection") continue;
      source.addEventListener(event, (message) => {
        armWatchdog();
        let data = null;
        try {
          data = JSON.parse(message.data);
        } catch {}
        handler(data);
      });
    }
    // Covers a refused connection (403) too: EventSource gives up on non-200
    // responses, the watchdog keeps retrying.
    armWatchdog();
  }

  open();
}

export async function postCue(path, headers = {}) {
  const response = await fetch(path, { method: "POST", headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `request failed: ${response.status}`);
  }
  return payload;
}

// Staff pages (/control, /wall, /medical-wall) are opened once with
// ?token=...; it sticks for the tab session and is sent as X-Control-Token
// (CONTROL_TOKEN on the server). The iPad sign page does the same with
// SIGN_TOKEN. Use the console's Quick Links: they carry the right token.
function pageToken(storageKey) {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) sessionStorage.setItem(storageKey, fromUrl);
  return fromUrl || sessionStorage.getItem(storageKey) || "";
}

export function controlToken() {
  return pageToken("controlToken");
}

export function signToken() {
  return pageToken("signToken");
}

export function controlHeaders() {
  const token = controlToken();
  return token ? { "X-Control-Token": token } : {};
}

export function signHeaders() {
  const token = signToken();
  return token ? { "X-Sign-Token": token } : {};
}

export function setDot(dot, connected) {
  dot.classList.toggle("live", connected);
  dot.classList.toggle("error", !connected);
}

export function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-Hant", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
