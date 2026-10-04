// Lighting cue bridge: maps signature-wall show events to lighting output.
//
// Signal modes (runtime switchable from /control or POST /api/lighting/config):
//   log            - print cues to console only, no hardware needed
//   osc            - one-shot OSC trigger message per cue
//                    (lighting console / TouchDesigner / QLC+ runs the effect)
//   artnet-trigger - set one DMX trigger channel to a per-cue value via Art-Net
//                    (console listens to that channel and fires its own cue);
//                    value is held with a low-rate keepalive stream
//   artnet-stream  - built-in aurora effect engine, streams full DMX frames
//                    directly to RGB PAR fixtures at LIGHT_FPS
//
// Cues: idle | live | final | blackout
//
// Env gives the initial defaults; runtime config overrides and is persisted
// by the server to data/lighting-config.json.

import dgram from "node:dgram";

export const SIGNAL_MODES = ["log", "osc", "artnet-trigger", "artnet-stream"];
const CUES = ["idle", "live", "final", "blackout"];

const FIXTURE_PROFILES = {
  rgb: { channels: 3, hasDimmer: false },
  drgb: { channels: 4, hasDimmer: true }
};

// Aurora palette stops used by the stream effect engine.
const AURORA_PALETTE = [
  { r: 8, g: 40, b: 60 },
  { r: 10, g: 120, b: 90 },
  { r: 40, g: 200, b: 140 },
  { r: 90, g: 230, b: 210 }
];

const CUE_PROFILES = {
  idle: { base: 0.22, wave: 0.1, speed: 0.35 },
  live: { base: 0.4, wave: 0.18, speed: 0.8 },
  final: { base: 0.55, wave: 0.45, speed: 1.6 },
  blackout: { base: 0, wave: 0, speed: 0 }
};

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function samplePalette(t) {
  const scaled = clamp01(t) * (AURORA_PALETTE.length - 1);
  const index = Math.min(AURORA_PALETTE.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const from = AURORA_PALETTE[index];
  const to = AURORA_PALETTE[index + 1];
  return {
    r: Math.round(lerp(from.r, to.r, local)),
    g: Math.round(lerp(from.g, to.g, local)),
    b: Math.round(lerp(from.b, to.b, local))
  };
}

function oscString(value) {
  const text = Buffer.from(String(value), "utf8");
  const padded = Buffer.alloc(Math.ceil((text.length + 1) / 4) * 4);
  text.copy(padded);
  return padded;
}

function oscFloat(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatBE(Number(value) || 0);
  return buffer;
}

function buildOscMessage(address, cue, intensity) {
  return Buffer.concat([
    oscString(address),
    oscString(",sf"),
    oscString(cue),
    oscFloat(intensity)
  ]);
}

function buildArtDmxPacket(universe, dmxData) {
  const header = Buffer.alloc(18);
  header.write("Art-Net\0", 0, "ascii");
  header.writeUInt16LE(0x5000, 8); // OpDmx
  header.writeUInt16BE(14, 10); // protocol version
  header.writeUInt8(0, 12); // sequence (0 = disabled)
  header.writeUInt8(0, 13); // physical port
  header.writeUInt16LE(universe & 0x7fff, 14);
  header.writeUInt16BE(dmxData.length, 16);
  return Buffer.concat([header, dmxData]);
}

function defaultConfig(env) {
  const profileName = (env.LIGHT_FIXTURE_PROFILE || "rgb").toLowerCase();
  return {
    mode: SIGNAL_MODES.includes(env.LIGHT_MODE) ? env.LIGHT_MODE : "log",
    osc: {
      host: env.LIGHT_OSC_HOST || "127.0.0.1",
      port: clamp(env.LIGHT_OSC_PORT || 8000, 1, 65535),
      address: env.LIGHT_OSC_ADDRESS || "/signature-wall/cue"
    },
    artnet: {
      host: env.LIGHT_ARTNET_HOST || "255.255.255.255",
      port: clamp(env.LIGHT_ARTNET_PORT || 6454, 1, 65535),
      universe: clamp(env.LIGHT_ARTNET_UNIVERSE || 0, 0, 32767),
      parCount: clamp(env.LIGHT_PAR_COUNT || 4, 1, 64),
      dmxStart: clamp(env.LIGHT_DMX_START || 1, 1, 512),
      profile: FIXTURE_PROFILES[profileName] ? profileName : "rgb",
      fps: clamp(env.LIGHT_FPS || 30, 10, 44),
      triggerChannel: clamp(env.LIGHT_TRIGGER_CHANNEL || 1, 1, 512),
      triggerValues: {
        idle: clamp(env.LIGHT_TRIGGER_IDLE || 10, 0, 255),
        live: clamp(env.LIGHT_TRIGGER_LIVE || 120, 0, 255),
        final: clamp(env.LIGHT_TRIGGER_FINAL || 200, 0, 255),
        blackout: clamp(env.LIGHT_TRIGGER_BLACKOUT || 0, 0, 255)
      }
    }
  };
}

function mergeConfig(base, patch = {}) {
  const next = structuredClone(base);
  if (SIGNAL_MODES.includes(patch.mode)) next.mode = patch.mode;
  if (patch.osc && typeof patch.osc === "object") {
    if (patch.osc.host) next.osc.host = String(patch.osc.host).trim();
    if (patch.osc.port !== undefined) next.osc.port = clamp(patch.osc.port, 1, 65535);
    if (patch.osc.address) next.osc.address = String(patch.osc.address).trim();
  }
  if (patch.artnet && typeof patch.artnet === "object") {
    const a = patch.artnet;
    if (a.host) next.artnet.host = String(a.host).trim();
    if (a.port !== undefined) next.artnet.port = clamp(a.port, 1, 65535);
    if (a.universe !== undefined) next.artnet.universe = clamp(a.universe, 0, 32767);
    if (a.parCount !== undefined) next.artnet.parCount = clamp(a.parCount, 1, 64);
    if (a.dmxStart !== undefined) next.artnet.dmxStart = clamp(a.dmxStart, 1, 512);
    if (a.profile && FIXTURE_PROFILES[a.profile]) next.artnet.profile = a.profile;
    if (a.fps !== undefined) next.artnet.fps = clamp(a.fps, 10, 44);
    if (a.triggerChannel !== undefined) next.artnet.triggerChannel = clamp(a.triggerChannel, 1, 512);
    if (a.triggerValues && typeof a.triggerValues === "object") {
      for (const cue of CUES) {
        if (a.triggerValues[cue] !== undefined) {
          next.artnet.triggerValues[cue] = clamp(a.triggerValues[cue], 0, 255);
        }
      }
    }
  }
  return next;
}

// Stream mode writes parCount fixtures from dmxStart; anything past channel
// 512 would silently fall off the universe, so refuse it instead.
function dmxOverrun(config) {
  if (config.mode !== "artnet-stream") return "";
  const { dmxStart, parCount, profile } = config.artnet;
  const channels = FIXTURE_PROFILES[profile].channels;
  const lastChannel = dmxStart - 1 + parCount * channels;
  if (lastChannel <= 512) return "";
  return `DMX 超出 512 channel：起始 ${dmxStart} + ${parCount} 盞 × ${channels}ch，最後一個 channel 是 ${lastChannel}`;
}

export function createLightingBridge(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((...args) => console.log("[lighting]", ...args));

  let config = mergeConfig(defaultConfig(env), options.initialConfig || {});
  let socket = null;
  let ticker = null;
  let currentCue = "idle";
  let cueStartedAt = Date.now();
  let cueDurationMs = 0;
  let lastError = dmxOverrun(config);
  let packetsSent = 0;

  function ensureSocket() {
    if (socket) return socket;
    socket = dgram.createSocket("udp4");
    socket.unref();
    socket.on("error", (error) => {
      lastError = error.message;
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (error) {
        lastError = error.message;
      }
    });
    return socket;
  }

  function sendUdp(buffer, port, host) {
    try {
      ensureSocket().send(buffer, port, host, (error) => {
        if (error) lastError = error.message;
        else packetsSent += 1;
      });
    } catch (error) {
      lastError = error.message;
    }
  }

  // ---- Art-Net stream mode: aurora effect engine --------------------------

  function renderStreamFrame(now) {
    const cueProfile = CUE_PROFILES[currentCue] || CUE_PROFILES.idle;
    const profile = FIXTURE_PROFILES[config.artnet.profile];
    const elapsed = (now - cueStartedAt) / 1000;
    const channelCount = config.artnet.dmxStart - 1 + config.artnet.parCount * profile.channels;
    const dmx = Buffer.alloc(Math.min(512, Math.max(2, channelCount + (channelCount % 2))));

    let envelope = 1;
    if (currentCue === "final" && cueDurationMs > 0) {
      const t = clamp01((now - cueStartedAt) / cueDurationMs);
      if (t < 0.15) envelope = t / 0.15; // attack
      else if (t > 0.75) envelope = clamp01((1 - t) / 0.25); // release
    }
    if (currentCue === "blackout") envelope = 0;

    for (let i = 0; i < config.artnet.parCount; i += 1) {
      const phase = (i / config.artnet.parCount) * Math.PI * 2;
      const wave = Math.sin(elapsed * cueProfile.speed * Math.PI + phase) * 0.5 + 0.5;
      const intensity = clamp01(cueProfile.base + cueProfile.wave * wave) * envelope;
      const color = samplePalette(0.35 + 0.65 * wave);
      const offset = config.artnet.dmxStart - 1 + i * profile.channels;

      if (profile.hasDimmer) {
        dmx[offset] = Math.round(intensity * 255);
        dmx[offset + 1] = color.r;
        dmx[offset + 2] = color.g;
        dmx[offset + 3] = color.b;
      } else {
        dmx[offset] = Math.round(color.r * intensity);
        dmx[offset + 1] = Math.round(color.g * intensity);
        dmx[offset + 2] = Math.round(color.b * intensity);
      }
    }

    return dmx;
  }

  // ---- Art-Net trigger mode: hold one trigger channel value ---------------

  function renderTriggerFrame() {
    const channel = config.artnet.triggerChannel;
    const value = config.artnet.triggerValues[currentCue] ?? 0;
    const dmx = Buffer.alloc(Math.max(2, channel + (channel % 2)));
    dmx[channel - 1] = value;
    return dmx;
  }

  function tickerSettings() {
    // Stream mode animates at full fps; trigger mode just holds the value
    // with a low-rate keepalive so the Art-Net node never sees the line drop.
    if (config.mode === "artnet-stream") {
      return { interval: Math.round(1000 / config.artnet.fps), render: renderStreamFrame };
    }
    if (config.mode === "artnet-trigger") {
      return { interval: 250, render: renderTriggerFrame };
    }
    return null;
  }

  function restartTicker() {
    stopTicker();
    const settings = tickerSettings();
    if (!settings) return;
    ticker = setInterval(() => {
      const packet = buildArtDmxPacket(config.artnet.universe, settings.render(Date.now()));
      sendUdp(packet, config.artnet.port, config.artnet.host);
    }, settings.interval);
    ticker.unref();
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  // ---- Public API ----------------------------------------------------------

  function trigger(cue, context = {}) {
    if (!CUES.includes(cue)) cue = "idle";
    const previous = currentCue;
    currentCue = cue;
    cueStartedAt = Date.now();
    cueDurationMs = Number(context.durationMs || 0);

    if (previous !== cue || context.reason === "manual-test") {
      log(`cue:${cue}`, `mode:${config.mode}`, context.reason ? `(${context.reason})` : "");
    }

    if (config.mode === "osc") {
      const intensity = CUE_PROFILES[cue].base + CUE_PROFILES[cue].wave;
      const message = buildOscMessage(config.osc.address, cue, intensity);
      sendUdp(message, config.osc.port, config.osc.host);
    }

    if (config.mode === "artnet-trigger") {
      // Push the new value immediately, keepalive ticker holds it afterwards.
      const packet = buildArtDmxPacket(config.artnet.universe, renderTriggerFrame());
      sendUdp(packet, config.artnet.port, config.artnet.host);
    }

    return state();
  }

  function configure(patch) {
    const next = mergeConfig(config, patch);
    const overrun = dmxOverrun(next);
    if (overrun) throw new Error(overrun);
    config = next;
    lastError = "";
    restartTicker();
    // Re-assert the current cue so the new target hears about it right away.
    trigger(currentCue, { reason: "config-change", durationMs: cueDurationMs });
    return state();
  }

  function state() {
    return {
      mode: config.mode,
      modes: SIGNAL_MODES,
      currentCue,
      cueStartedAt: new Date(cueStartedAt).toISOString(),
      packetsSent,
      lastError,
      config
    };
  }

  function close() {
    stopTicker();
    if (socket) {
      socket.close();
      socket = null;
    }
  }

  restartTicker();

  return { trigger, configure, state, close, cues: CUES, modes: SIGNAL_MODES };
}
