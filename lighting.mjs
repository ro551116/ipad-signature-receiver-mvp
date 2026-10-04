// Lighting console cue bridge: turns signature-wall show events into signals
// a lighting console (or show-control software) maps to its own cues. The
// console runs the looks; this only says which show state is active.
//
// Cues: idle | live | final | blackout
//
// Any number of outputs can run at once, each with its own settings and one
// line per cue (syntax and field definitions: public/assets/cue-syntax.js):
//   osc    - OSC over UDP, or TCP with SLIP (OSC 1.1) or length-prefix (1.0)
//   artnet - DMX levels over Art-Net (DMX remote / input triggers)
//   sacn   - DMX levels over sACN / E1.31, multicast or unicast
//   midi   - MIDI / MIDI Show Control bytes, played by the MIDI bridge page
//            (Web MIDI) through onMidi; the server has no MIDI port itself
//   text   - plain string commands over UDP or TCP
//   http   - HTTP requests (e.g. Bitfocus Companion, console web APIs)
// Action outputs fire once when a cue starts; Art-Net and sACN hold the
// active cue's levels and re-send them every 250 ms.
//
// The config ({ outputs: [...] }) is edited in /control and persisted by the
// server to data/lighting-config.json (plain JSON, also fine to edit by hand
// while the server is stopped).

import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { CUES, OUTPUT_TYPES, normalizeConfig, validateOutput, parseCueLine } from "./public/assets/cue-syntax.js";

const KEEPALIVE_MS = 250;
const SACN_PORT = 5568;
const HTTP_TIMEOUT_MS = 3000;
const SHUTDOWN_FLUSH_MS = 500;

// ---- Encoders ------------------------------------------------------------------

function oscString(value) {
  const text = Buffer.from(String(value), "utf8");
  const padded = Buffer.alloc(Math.ceil((text.length + 1) / 4) * 4);
  text.copy(padded);
  return padded;
}

function oscMessage({ address, args }) {
  const parts = [oscString(address), oscString(`,${args.map((arg) => arg.type).join("")}`)];
  for (const arg of args) {
    if (arg.type === "s") {
      parts.push(oscString(arg.value));
    } else {
      const value = Buffer.alloc(4);
      if (arg.type === "i") value.writeInt32BE(arg.value);
      else value.writeFloatBE(arg.value);
      parts.push(value);
    }
  }
  return Buffer.concat(parts);
}

// OSC 1.1 stream framing (SLIP, RFC 1055 with a leading END).
function slip(packet) {
  const END = 0xc0, ESC = 0xdb, ESC_END = 0xdc, ESC_ESC = 0xdd;
  const bytes = [END];
  for (const byte of packet) {
    if (byte === END) bytes.push(ESC, ESC_END);
    else if (byte === ESC) bytes.push(ESC, ESC_ESC);
    else bytes.push(byte);
  }
  bytes.push(END);
  return Buffer.from(bytes);
}

// OSC 1.0 stream framing: int32 big-endian size before each packet.
function lengthPrefixed(packet) {
  const size = Buffer.alloc(4);
  size.writeInt32BE(packet.length);
  return Buffer.concat([size, packet]);
}

function artDmxPacket(universe, dmx) {
  const header = Buffer.alloc(18);
  header.write("Art-Net\0", 0, "ascii");
  header.writeUInt16LE(0x5000, 8); // OpDmx
  header.writeUInt16BE(14, 10); // protocol version
  header.writeUInt8(0, 12); // sequence (0 = disabled)
  header.writeUInt8(0, 13); // physical port
  header.writeUInt16LE(universe & 0x7fff, 14);
  header.writeUInt16BE(dmx.length, 16);
  return Buffer.concat([header, dmx]);
}

// ANSI E1.31-2016 data packet with all 512 slots.
function sacnPacket({ cid, sourceName, priority, sequence, universe, dmx }) {
  const packet = Buffer.alloc(638);
  packet.writeUInt16BE(0x0010, 0); // preamble size
  packet.writeUInt16BE(0x0000, 2); // post-amble size
  packet.write("ASC-E1.17\0\0\0", 4, "ascii");
  packet.writeUInt16BE(0x7000 | (638 - 16), 16);
  packet.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
  cid.copy(packet, 22);
  packet.writeUInt16BE(0x7000 | (638 - 38), 38);
  packet.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
  packet.write(sourceName.slice(0, 63), 44, "utf8");
  packet.writeUInt8(priority, 108);
  packet.writeUInt16BE(0, 109); // synchronization address
  packet.writeUInt8(sequence, 111);
  packet.writeUInt8(0, 112); // options
  packet.writeUInt16BE(universe, 113);
  packet.writeUInt16BE(0x7000 | (638 - 115), 115);
  packet.writeUInt8(0x02, 117); // VECTOR_DMP_SET_PROPERTY
  packet.writeUInt8(0xa1, 118); // address & data type
  packet.writeUInt16BE(0x0000, 119); // first property address
  packet.writeUInt16BE(0x0001, 121); // address increment
  packet.writeUInt16BE(513, 123); // property value count (start code + 512)
  packet.writeUInt8(0x00, 125); // DMX start code
  dmx.copy(packet, 126, 0, Math.min(512, dmx.length));
  return packet;
}

function sacnMulticastAddress(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

// ---- Bridge ----------------------------------------------------------------------

export function createLightingBridge(options = {}) {
  const log = options.log || ((...args) => console.log("[lighting]", ...args));
  // Receives { outputId, port, cue, messages: [{ bytes, delayMs }] } and
  // returns how many MIDI bridge pages it reached.
  const onMidi = options.onMidi || (() => 0);
  const cid = randomBytes(16);
  const sourceName = `Signature Wall (${os.hostname()})`;

  let config = { outputs: [] };
  let runtimes = new Map();
  let currentCue = "idle";
  let cueStartedAt = Date.now();
  let midiPorts = [];
  let ticker = null;

  function runtimeFor(output) {
    let runtime = runtimes.get(output.id);
    if (!runtime) {
      runtime = { sent: 0, lastError: "", lastSentAt: null, cues: {}, configError: "", udp: null, tcp: null, tcpReady: false, tcpQueue: [], sequence: 0 };
      runtimes.set(output.id, runtime);
    }
    return runtime;
  }

  function succeeded(runtime) {
    runtime.sent += 1;
    runtime.lastSentAt = new Date().toISOString();
    if (!runtime.configError) runtime.lastError = "";
  }

  function failed(runtime, message) {
    runtime.lastError = message;
  }

  function apply(nextConfig) {
    closeTransports();
    config = nextConfig;
    const previous = runtimes;
    runtimes = new Map();
    for (const output of config.outputs) {
      const runtime = runtimeFor(output);
      const before = previous.get(output.id);
      if (before) {
        runtime.sent = before.sent;
        runtime.lastSentAt = before.lastSentAt;
      }
      runtime.configError = validateOutput(output);
      runtime.lastError = runtime.configError;
      if (!runtime.configError) {
        for (const cue of CUES) runtime.cues[cue] = parseCueLine(output, output.cues[cue]).commands;
      }
    }
    restartTicker();
    // Warm up TCP connections so the first cue is not delayed by a connect.
    for (const output of activeOutputs()) {
      if (usesTcp(output)) tcpConnection(output, runtimeFor(output));
    }
  }

  function activeOutputs() {
    return config.outputs.filter((output) => output.enabled && !runtimeFor(output).configError);
  }

  function usesTcp(output) {
    return (output.type === "osc" && output.transport !== "udp") || (output.type === "text" && output.transport === "tcp");
  }

  // ---- Transports ----

  function udpSocket(output, runtime) {
    if (runtime.udp) return runtime.udp;
    const socket = dgram.createSocket("udp4");
    socket.unref();
    socket.on("error", (error) => failed(runtime, error.message));
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        if (output.type === "sacn" && output.interfaceIp) socket.setMulticastInterface(output.interfaceIp);
      } catch (error) {
        failed(runtime, error.message);
      }
    });
    runtime.udp = socket;
    return socket;
  }

  function sendUdp(output, runtime, buffer, port, host) {
    return new Promise((resolve) => {
      try {
        udpSocket(output, runtime).send(buffer, port, host, (error) => {
          if (error) failed(runtime, error.message);
          else succeeded(runtime);
          resolve();
        });
      } catch (error) {
        failed(runtime, error.message);
        resolve();
      }
    });
  }

  function tcpConnection(output, runtime) {
    if (runtime.tcp) return runtime.tcp;
    const socket = net.createConnection({ host: output.host, port: output.port });
    socket.unref();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    runtime.tcp = socket;
    runtime.tcpReady = false;
    socket.on("connect", () => {
      runtime.tcpReady = true;
      const queued = runtime.tcpQueue;
      runtime.tcpQueue = [];
      for (const { buffer, resolve } of queued) writeTcp(runtime, buffer).then(resolve);
    });
    socket.on("data", () => {}); // consoles may answer; nothing to do with it
    socket.on("error", (error) => failed(runtime, `TCP ${output.host}:${output.port} ${error.message}`));
    socket.on("close", () => {
      if (runtime.tcp === socket) {
        runtime.tcp = null;
        runtime.tcpReady = false;
      }
      // Anything still waiting for this connection is lost; say so.
      for (const { resolve } of runtime.tcpQueue.splice(0)) resolve();
    });
    return socket;
  }

  function writeTcp(runtime, buffer) {
    return new Promise((resolve) => {
      runtime.tcp.write(buffer, (error) => {
        if (error) failed(runtime, error.message);
        else succeeded(runtime);
        resolve();
      });
    });
  }

  // Connects on demand (and again after a drop); a cue sent while connecting
  // goes out as soon as the connection is up.
  function sendTcp(output, runtime, buffer) {
    tcpConnection(output, runtime);
    if (runtime.tcpReady) return writeTcp(runtime, buffer);
    return new Promise((resolve) => runtime.tcpQueue.push({ buffer, resolve }));
  }

  async function sendHttp(runtime, { method, url, body }) {
    try {
      const response = await fetch(url, {
        method,
        body: body && method !== "GET" ? body : undefined,
        headers: body && method !== "GET" ? { "Content-Type": "text/plain; charset=utf-8" } : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      if (response.ok) succeeded(runtime);
      else failed(runtime, `HTTP ${response.status} ${method} ${url}`);
    } catch (error) {
      failed(runtime, `${method} ${url}：${error.name === "TimeoutError" ? "逾時" : error.message}`);
    }
  }

  // ---- Per type ----

  // Every channel any cue uses is 0 unless the active cue sets it.
  function dmxFrame(runtime, length) {
    const dmx = Buffer.alloc(length);
    for (const { channels } of runtime.cues[currentCue]) {
      for (const { channel, value } of channels) dmx[channel - 1] = value;
    }
    return dmx;
  }

  function sendState(output) {
    const runtime = runtimeFor(output);
    if (output.type === "artnet") {
      // ArtDmx carries channels 1..n with n even: cover the highest channel any cue uses.
      let highest = 2;
      for (const cue of CUES) for (const { channels } of runtime.cues[cue]) for (const { channel } of channels) highest = Math.max(highest, channel);
      const dmx = dmxFrame(runtime, highest + (highest % 2));
      return sendUdp(output, runtime, artDmxPacket(output.universe, dmx), output.port, output.host);
    }
    runtime.sequence = (runtime.sequence + 1) & 0xff;
    const packet = sacnPacket({ cid, sourceName, priority: output.priority, sequence: runtime.sequence, universe: output.universe, dmx: dmxFrame(runtime, 512) });
    return sendUdp(output, runtime, packet, SACN_PORT, output.host || sacnMulticastAddress(output.universe));
  }

  function fireAction(output, cue) {
    const runtime = runtimeFor(output);
    const commands = runtime.cues[cue];
    if (commands.length === 0) return Promise.resolve();
    if (output.type === "midi") {
      const reached = onMidi({ outputId: output.id, port: output.port, cue, messages: commands.flatMap((command) => command.messages) });
      if (reached === 0) failed(runtime, "沒有 MIDI 橋接頁連線：在 server 這台電腦用 Chrome 開控制台的「MIDI 橋接」連結");
      return Promise.resolve();
    }
    return Promise.all(commands.map((command) => {
      if (output.type === "http") return sendHttp(runtime, command);
      if (output.type === "osc") {
        const packet = oscMessage(command);
        if (output.transport === "udp") return sendUdp(output, runtime, packet, output.port, output.host);
        return sendTcp(output, runtime, output.transport === "tcp-slip" ? slip(packet) : lengthPrefixed(packet));
      }
      const ending = { none: "", cr: "\r", lf: "\n", crlf: "\r\n" }[output.lineEnding];
      const buffer = Buffer.from(command.payload + ending, "latin1");
      if (output.transport === "tcp") return sendTcp(output, runtime, buffer);
      return sendUdp(output, runtime, buffer, output.port, output.host);
    }));
  }

  function announce(output, cue) {
    return OUTPUT_TYPES[output.type].kind === "state" ? sendState(output) : fireAction(output, cue);
  }

  function restartTicker() {
    clearInterval(ticker);
    ticker = null;
    if (!config.outputs.some((output) => OUTPUT_TYPES[output.type].kind === "state")) return;
    ticker = setInterval(() => {
      for (const output of activeOutputs()) {
        if (OUTPUT_TYPES[output.type].kind === "state") sendState(output);
      }
    }, KEEPALIVE_MS);
    ticker.unref();
  }

  function closeTransports() {
    for (const runtime of runtimes.values()) {
      runtime.udp?.close();
      runtime.udp = null;
      runtime.tcp?.destroy();
      runtime.tcp = null;
      runtime.tcpReady = false;
    }
  }

  // ---- Public API ----

  // manual-test re-fires the cue even if it is already active; outputId
  // limits the announcement to one output (state outputs always follow the
  // current cue on their next keepalive).
  function trigger(cue, context = {}) {
    if (!CUES.includes(cue)) cue = "idle";
    const changed = cue !== currentCue;
    currentCue = cue;
    cueStartedAt = Date.now();
    if (!changed && context.reason !== "manual-test") return state();
    log(`cue:${cue}`, context.reason ? `(${context.reason})` : "", context.outputId ? `→ ${context.outputId}` : "");
    for (const output of activeOutputs()) {
      if (context.outputId && output.id !== context.outputId) continue;
      announce(output, cue);
    }
    return state();
  }

  // Replaces the whole output list. Throws (and keeps the old config) if an
  // output could not reach its console.
  function configure(rawConfig) {
    const next = normalizeConfig(rawConfig);
    for (const output of next.outputs) {
      const problem = validateOutput(output);
      if (problem) throw new Error(`${output.name}：${problem}`);
    }
    apply(next);
    // State outputs carry the cue, so new targets get it right away. Action
    // outputs are not replayed on a settings change.
    for (const output of activeOutputs()) {
      if (OUTPUT_TYPES[output.type].kind === "state") sendState(output);
    }
    return state();
  }

  function setMidiPorts(ports) {
    midiPorts = Array.isArray(ports) ? ports.map(String).slice(0, 64) : [];
    return state();
  }

  function recordMidiResult(outputId, result = {}) {
    const output = config.outputs.find((item) => item.id === outputId);
    if (!output) return state();
    const runtime = runtimeFor(output);
    if (result.ok) succeeded(runtime);
    else failed(runtime, String(result.error || "MIDI 送出失敗"));
    return state();
  }

  function state() {
    return {
      currentCue,
      cueStartedAt: new Date(cueStartedAt).toISOString(),
      midiPorts,
      config,
      outputs: config.outputs.map((output) => {
        const runtime = runtimeFor(output);
        return { id: output.id, sent: runtime.sent, lastSentAt: runtime.lastSentAt, lastError: runtime.lastError };
      })
    };
  }

  // Leaves every console on the idle cue before going quiet (consoles and
  // DMX receivers hold the last thing they got).
  async function close() {
    clearInterval(ticker);
    ticker = null;
    if (currentCue !== "idle") {
      currentCue = "idle";
      cueStartedAt = Date.now();
      log("cue:idle", "(shutdown)");
      const sends = activeOutputs().map((output) => announce(output, "idle"));
      await Promise.race([Promise.all(sends), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_MS))]);
    }
    closeTransports();
  }

  // A saved config that no longer validates is loaded but stays silent and
  // shows its problem on the console page instead of failing startup.
  apply(normalizeConfig(options.initialConfig));

  return { trigger, configure, state, close, setMidiPorts, recordMidiResult, cues: CUES };
}
