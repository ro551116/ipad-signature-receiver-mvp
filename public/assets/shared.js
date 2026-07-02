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

export function connectEvents(handlers = {}) {
  const source = new EventSource("/events");
  const setConnection = handlers.connection || (() => {});
  source.onopen = () => setConnection(true);
  source.onerror = () => setConnection(false);
  for (const [event, handler] of Object.entries(handlers)) {
    if (event !== "connection") {
      source.addEventListener(event, (message) => {
        try {
          handler(JSON.parse(message.data));
        } catch {
          handler(null);
        }
      });
    }
  }
  return source;
}

export async function postCue(path, headers = {}) {
  const response = await fetch(path, { method: "POST", headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `request failed: ${response.status}`);
  }
  return payload;
}

// Control pages pass ?token=... once; it sticks for the session and is sent
// as X-Control-Token on show-control requests (CONTROL_TOKEN on the server).
export function controlHeaders() {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) sessionStorage.setItem("controlToken", fromUrl);
  const token = fromUrl || sessionStorage.getItem("controlToken") || "";
  return token ? { "X-Control-Token": token } : {};
}

// Same pattern for the iPad sign page: open /sign?token=... once so the
// device sends X-Sign-Token on every signing request (SIGN_TOKEN on the
// server). No-op (empty headers) if SIGN_TOKEN isn't configured server-side.
export function signHeaders() {
  const fromUrl = new URLSearchParams(location.search).get("token");
  if (fromUrl) sessionStorage.setItem("signToken", fromUrl);
  const token = fromUrl || sessionStorage.getItem("signToken") || "";
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
