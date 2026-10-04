// Lighting-console outputs: what each output type is, its settings, and how
// a cue line is read. Shared by the server (lighting.mjs sends the signals)
// and the control page (live preview while editing), so both read every
// line the same way. Plain ES module, no Node or DOM APIs.

export const CUES = ["idle", "live", "final", "blackout"];

export const CUE_LABELS = {
  idle: "Idle（待機）",
  live: "Live（落筆）",
  final: "Final（上牆）",
  blackout: "Blackout（牆面熄燈）"
};

const LIMITED_BROADCAST = "255.255.255.255";
const NOTE_OFF_AFTER_MS = 100;

const HOST = { key: "host", label: "目標 IP", type: "text", placeholder: "例如 2.0.0.20", required: true };
const PORT = (fallback) => ({ key: "port", label: "Port", type: "number", min: 1, max: 65535, default: fallback, required: true });

// kind "action": a cue fires once when it starts (GO / fire / note).
// kind "state":  the active cue is held as DMX levels and re-sent.
export const OUTPUT_TYPES = {
  osc: {
    label: "OSC",
    kind: "action",
    fields: [
      HOST,
      PORT(8000),
      { key: "transport", label: "傳輸", type: "select", default: "udp", options: [["udp", "UDP"], ["tcp-slip", "TCP（OSC 1.1 / SLIP）"], ["tcp-length", "TCP（OSC 1.0 / 長度前綴）"]] }
    ],
    cueDefaults: { idle: "/eos/cue/1/1/fire", live: "/eos/cue/1/2/fire", final: "/eos/cue/1/3/fire", blackout: "" },
    help: 'OSC 位址，後面可接參數：數字 = float、"文字" = string、i:100 = int、f:0.5 = float。多條用 ; 分隔，留空不送。例：ETC Eos /eos/cue/1/3/fire、grandMA3 /gma3/cmd "Go+ Sequence 3"、MagicQ /pb/1/go、grandMA3 推桿 /Page1/Fader201 i:100'
  },
  artnet: {
    label: "Art-Net",
    kind: "state",
    fields: [
      { ...HOST, placeholder: "控台或轉換器 IP，或 2.255.255.255" },
      PORT(6454),
      { key: "universe", label: "Universe（從 0 起算）", type: "number", min: 0, max: 32767, default: 0 }
    ],
    cueDefaults: { idle: "1@255", live: "2@255", final: "3@255", blackout: "4@255" },
    help: "channel@值，多組用逗號分隔。目前的 cue 送它的值，其他 cue 用到的 channel 送 0，每 250ms 重送。可以一個 cue 一個 channel（3@255），也可以同一個 channel 用不同值區分 cue（1@200）。這個 universe 要專用。"
  },
  sacn: {
    label: "sACN（E1.31）",
    kind: "state",
    fields: [
      { key: "universe", label: "Universe（1–63999）", type: "number", min: 1, max: 63999, default: 1 },
      { key: "priority", label: "Priority（0–200）", type: "number", min: 0, max: 200, default: 100 },
      { key: "host", label: "目標 IP（空白 = multicast）", type: "text", placeholder: "空白 = 239.255.x.x multicast" },
      { key: "interfaceIp", label: "送出網卡 IP（multicast 用）", type: "text", placeholder: "空白 = 系統預設網卡" }
    ],
    cueDefaults: { idle: "1@255", live: "2@255", final: "3@255", blackout: "4@255" },
    help: "格式同 Art-Net：channel@值，多組用逗號分隔，每 250ms 重送。multicast 要走燈光網路時，填這台電腦在燈光網路那張網卡的 IP。"
  },
  midi: {
    label: "MIDI",
    kind: "action",
    fields: [
      { key: "port", label: "MIDI 輸出埠（名稱包含）", type: "text", placeholder: "空白 = 第一個輸出埠", list: "midiPorts" },
      { key: "mscDevice", label: "MSC Device ID（127 = 全部）", type: "number", min: 0, max: 127, default: 127 },
      { key: "mscFormat", label: "MSC Command Format（1 = Lighting）", type: "number", min: 0, max: 127, default: 1 }
    ],
    cueDefaults: { idle: "msc go 1", live: "msc go 2", final: "msc go 3", blackout: "" },
    help: "msc go 3（MIDI Show Control GO cue 3，可再接 list）、msc fire 5、msc all_off、note 1 60 127（channel、note、velocity，自動補 Note Off）、pc 1 5（Program Change）、cc 1 20 127（Control Change）、hex F0 7F …（原始位元組）。多條用 ; 分隔。要在 server 這台電腦用 Chrome 開「MIDI 橋接」頁才會送出。"
  },
  text: {
    label: "UDP / TCP 文字",
    kind: "action",
    fields: [
      HOST,
      { ...PORT(undefined), placeholder: "控台接收文字指令的 port" },
      { key: "transport", label: "傳輸", type: "select", default: "udp", options: [["udp", "UDP"], ["tcp", "TCP"]] },
      { key: "lineEnding", label: "結尾", type: "select", default: "crlf", options: [["none", "不加"], ["cr", "\\r"], ["lf", "\\n"], ["crlf", "\\r\\n"]] }
    ],
    cueDefaults: { idle: "", live: "", final: "", blackout: "" },
    help: "直接送一行文字指令（控台的 UDP/TCP 字串、Telnet 指令等），可用 \\r \\n \\t \\xHH；結尾依上面的設定自動加。多條用 ; 分隔（文字裡的 ; 寫成 \\x3B）。"
  },
  http: {
    label: "HTTP",
    kind: "action",
    fields: [
      { key: "baseUrl", label: "Base URL（cue 填 /路徑 時套用）", type: "text", placeholder: "例如 http://127.0.0.1:8000" }
    ],
    cueDefaults: { idle: "", live: "", final: "", blackout: "" },
    help: "[GET|POST|PUT] 網址或 /路徑 [內容]，預設 GET。例：POST /api/location/1/0/1/press（Bitfocus Companion 按下 page 1 第 0 列第 1 格）。多條用 ; 分隔。"
  }
};

// ---- Config ------------------------------------------------------------------

function newId() {
  return `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeField(field, value) {
  if (field.type === "number") {
    if (value === "" || value === null || value === undefined) return field.default ?? null;
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return field.default ?? null;
    return Math.min(field.max, Math.max(field.min, number));
  }
  if (field.type === "select") {
    return field.options.some(([option]) => option === value) ? value : field.default;
  }
  return String(value ?? "").trim();
}

export function newOutput(type) {
  return normalizeOutput({ type, enabled: true });
}

export function normalizeOutput(raw) {
  const definition = OUTPUT_TYPES[raw?.type];
  if (!definition) return null;
  const output = {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    type: raw.type,
    name: String(raw.name ?? "").trim() || definition.label,
    enabled: raw.enabled !== false,
    cues: {}
  };
  for (const field of definition.fields) output[field.key] = normalizeField(field, raw[field.key]);
  for (const cue of CUES) output.cues[cue] = String(raw.cues?.[cue] ?? definition.cueDefaults[cue] ?? "").trim();
  return output;
}

export function normalizeConfig(raw) {
  const seen = new Set();
  const outputs = [];
  for (const item of Array.isArray(raw?.outputs) ? raw.outputs : []) {
    const output = normalizeOutput(item);
    if (!output) continue;
    if (seen.has(output.id)) output.id = newId();
    seen.add(output.id);
    outputs.push(output);
  }
  return { outputs };
}

// First problem that would stop this output from reaching the console, or "".
// Cue lines are always checked; required settings only once it is enabled,
// so a half-filled output can be saved while it is switched off.
export function validateOutput(output) {
  const definition = OUTPUT_TYPES[output.type];
  if (!definition) return `不認得的輸出種類：${output.type}`;
  if (output.enabled) {
    for (const field of definition.fields) {
      const value = output[field.key];
      if (field.required && (value === "" || value === null || value === undefined)) return `請填「${field.label}」`;
    }
  }
  if (output.host === LIMITED_BROADCAST) {
    return "不要用 255.255.255.255：電腦有多張網卡時會從預設網卡（通常是 Wi-Fi）送出，控台收不到。請填控台 IP，或燈光網段的廣播位址（例如 2.255.255.255）";
  }
  for (const cue of CUES) {
    try {
      parseCueLine(output, output.cues[cue]);
    } catch (error) {
      return `${CUE_LABELS[cue]}：${error.message}`;
    }
  }
  return "";
}

// ---- Cue lines -----------------------------------------------------------------

// Splits on ; outside double quotes.
function splitCommands(line) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function tokenize(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(command))) {
    tokens.push(match[1] !== undefined ? { text: match[1], quoted: true } : { text: match[2], quoted: false });
  }
  return tokens;
}

function integer(text, min, max, what) {
  if (!/^-?\d+$/.test(String(text ?? ""))) throw new Error(`${what} 要是整數（${min}–${max}）`);
  const value = Number(text);
  if (value < min || value > max) throw new Error(`${what} 要在 ${min}–${max}`);
  return value;
}

function oscArg(token) {
  if (token.quoted) return { type: "s", value: token.text };
  const typed = /^([ifs]):(.*)$/.exec(token.text);
  if (typed) {
    const [, type, raw] = typed;
    if (type === "s") return { type, value: raw };
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) throw new Error(`${token.text} 不是數字`);
    if (type === "i" && !Number.isInteger(value)) throw new Error(`${token.text} 不是整數`);
    return { type, value };
  }
  if (/^-?\d+(\.\d+)?$/.test(token.text)) return { type: "f", value: Number(token.text) };
  return { type: "s", value: token.text };
}

function parseOsc(command) {
  const [address, ...rest] = tokenize(command);
  if (!address || address.quoted || !address.text.startsWith("/")) throw new Error(`OSC 位址要以 / 開頭：${command}`);
  const args = rest.map(oscArg);
  const summary = args.length
    ? `${address.text} ${args.map((arg) => (arg.type === "s" ? `"${arg.value}"` : `${arg.type}:${arg.value}`)).join(" ")}`
    : address.text;
  return { command: { address: address.text, args }, summary };
}

function parseDmx(line) {
  const pairs = line.split(/[\s,]+/).filter(Boolean).map((pair) => {
    const match = /^(\d+)@(\d+)$/.exec(pair);
    if (!match) throw new Error(`「${pair}」看不懂，格式是 channel@值，例如 3@255`);
    return { channel: integer(match[1], 1, 512, "channel"), value: integer(match[2], 0, 255, "值") };
  });
  return { commands: [{ channels: pairs }], summary: pairs.map((pair) => `ch${pair.channel}=${pair.value}`).join(" ") };
}

const MSC_COMMANDS = { go: 0x01, stop: 0x02, resume: 0x03, load: 0x05, fire: 0x07, all_off: 0x08, restore: 0x09, reset: 0x0a, go_off: 0x0b };
const MSC_WITH_CUE = new Set(["go", "stop", "resume", "load", "go_off"]);

function ascii(text) {
  return [...text].map((char) => char.charCodeAt(0));
}

function parseMidi(command, output) {
  const tokens = tokenize(command).map((token) => token.text);
  const kind = (tokens[0] || "").toLowerCase();
  const channel = () => integer(tokens[1], 1, 16, "MIDI channel") - 1;

  if (kind === "note") {
    const ch = channel();
    const note = integer(tokens[2], 0, 127, "note");
    const velocity = tokens[3] === undefined ? 127 : integer(tokens[3], 1, 127, "velocity");
    return {
      messages: [{ bytes: [0x90 | ch, note, velocity], delayMs: 0 }, { bytes: [0x80 | ch, note, 0], delayMs: NOTE_OFF_AFTER_MS }],
      summary: `Note On ch${ch + 1} #${note} vel${velocity}（${NOTE_OFF_AFTER_MS}ms 後 Note Off）`
    };
  }
  if (kind === "noteoff") {
    const ch = channel();
    const note = integer(tokens[2], 0, 127, "note");
    return { messages: [{ bytes: [0x80 | ch, note, 0], delayMs: 0 }], summary: `Note Off ch${ch + 1} #${note}` };
  }
  if (kind === "pc") {
    const ch = channel();
    const program = integer(tokens[2], 0, 127, "program");
    return { messages: [{ bytes: [0xc0 | ch, program], delayMs: 0 }], summary: `Program Change ch${ch + 1} → ${program}` };
  }
  if (kind === "cc") {
    const ch = channel();
    const controller = integer(tokens[2], 0, 127, "controller");
    const value = integer(tokens[3], 0, 127, "value");
    return { messages: [{ bytes: [0xb0 | ch, controller, value], delayMs: 0 }], summary: `Control Change ch${ch + 1} #${controller} = ${value}` };
  }
  if (kind === "msc") {
    const name = (tokens[1] || "").toLowerCase();
    const code = MSC_COMMANDS[name];
    if (code === undefined) throw new Error(`MSC 指令要是 ${Object.keys(MSC_COMMANDS).join(" / ")}`);
    let data = [];
    let detail = "";
    if (name === "fire") {
      const macro = integer(tokens[2], 0, 127, "macro");
      data = [macro];
      detail = ` macro ${macro}`;
    } else if (MSC_WITH_CUE.has(name)) {
      const numbers = tokens.slice(2, 5);
      for (const number of numbers) {
        if (!/^\d+(\.\d+)?$/.test(number)) throw new Error(`cue / list / path 要是數字：${number}`);
      }
      data = numbers.flatMap((number, index) => (index === 0 ? ascii(number) : [0x00, ...ascii(number)]));
      detail = ["cue", "list", "path"].map((label, index) => (numbers[index] ? ` ${label} ${numbers[index]}` : "")).join("");
    }
    const bytes = [0xf0, 0x7f, output.mscDevice ?? 127, 0x02, output.mscFormat ?? 1, code, ...data, 0xf7];
    return { messages: [{ bytes, delayMs: 0 }], summary: `MSC ${name.toUpperCase()}${detail}` };
  }
  if (kind === "hex") {
    const bytes = tokens.slice(1).map((token) => {
      if (!/^[0-9a-fA-F]{1,2}$/.test(token)) throw new Error(`「${token}」不是 00–FF 的位元組`);
      return parseInt(token, 16);
    });
    if (bytes.length === 0) throw new Error("hex 後面要接位元組，例如 hex 90 3C 7F");
    return { messages: [{ bytes, delayMs: 0 }], summary: `hex ${bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}` };
  }
  throw new Error(`MIDI 訊息要以 msc / note / noteoff / pc / cc / hex 開頭：${command}`);
}

function unescapeText(text) {
  return text.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, code) => {
    if (code[0] === "x" && code.length === 3) return String.fromCharCode(parseInt(code.slice(1), 16));
    return { r: "\r", n: "\n", t: "\t", "\\": "\\", '"': '"' }[code] ?? code;
  });
}

function visible(text) {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function parseHttp(command, output) {
  const tokens = tokenize(command);
  let method = "GET";
  if (tokens[0] && !tokens[0].quoted && HTTP_METHODS.has(tokens[0].text.toUpperCase())) {
    method = tokens.shift().text.toUpperCase();
  }
  const target = tokens.shift();
  if (!target) throw new Error("要填網址或 /路徑");
  let url = target.text;
  if (url.startsWith("/")) {
    if (!output.baseUrl) throw new Error(`「${url}」是路徑，請先填 Base URL`);
    url = output.baseUrl.replace(/\/+$/, "") + url;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`網址看不懂：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`只支援 http / https：${url}`);
  const body = tokens.map((token) => token.text).join(" ");
  return { command: { method, url: parsed.toString(), body }, summary: `${method} ${parsed.toString()}${body ? ` ${body}` : ""}` };
}

// Returns { commands, summary } for one cue line. An empty line is valid and
// sends nothing. Throws an Error with a readable message on a bad line.
export function parseCueLine(output, line) {
  const text = String(line ?? "").trim();
  if (!text) return { commands: [], summary: "（不送）" };
  const kind = output.type;

  if (kind === "artnet" || kind === "sacn") return parseDmx(text);

  const commands = [];
  const summaries = [];
  for (const part of splitCommands(text)) {
    if (kind === "osc") {
      const { command, summary } = parseOsc(part);
      commands.push(command);
      summaries.push(summary);
    } else if (kind === "midi") {
      const { messages, summary } = parseMidi(part, output);
      commands.push({ messages });
      summaries.push(summary);
    } else if (kind === "text") {
      const payload = unescapeText(part);
      commands.push({ payload });
      summaries.push(`"${visible(payload)}"`);
    } else if (kind === "http") {
      const { command, summary } = parseHttp(part, output);
      commands.push(command);
      summaries.push(summary);
    } else {
      throw new Error(`不認得的輸出種類：${kind}`);
    }
  }
  return { commands, summary: summaries.join("；") };
}
