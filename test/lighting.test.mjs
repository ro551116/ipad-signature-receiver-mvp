// Behaviour tests for the lighting-console bridge, observed on the wire: each
// test points outputs at local UDP/TCP/HTTP listeners and decodes what
// arrives, the way a console would.

import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import http from "node:http";
import { createLightingBridge } from "../lighting.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function udpListener(t, port = 0) {
  const packets = [];
  const socket = dgram.createSocket("udp4");
  socket.on("message", (message) => packets.push(message));
  await new Promise((resolve) => socket.bind(port, "127.0.0.1", resolve));
  t.after(() => socket.close());
  return { port: socket.address().port, packets };
}

async function tcpListener(t) {
  const chunks = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk) => chunks.push(chunk));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: server.address().port, data: () => Buffer.concat(chunks) };
}

function bridgeWith(t, outputs, options = {}) {
  const bridge = createLightingBridge({ log: () => {}, ...options });
  bridge.configure({ outputs });
  t.after(() => bridge.close());
  return bridge;
}

function decodeOsc(packet) {
  const readString = (offset) => {
    const end = packet.indexOf(0, offset);
    return [packet.subarray(offset, end).toString(), Math.ceil((end + 1) / 4) * 4];
  };
  const [address, afterAddress] = readString(0);
  let [tags, offset] = readString(afterAddress);
  const args = [];
  for (const tag of tags.slice(1)) {
    if (tag === "s") {
      const [text, next] = readString(offset);
      args.push(text);
      offset = next;
    } else {
      args.push(tag === "i" ? packet.readInt32BE(offset) : packet.readFloatBE(offset));
      offset += 4;
    }
  }
  return { address, tags, args };
}

test("OSC commands go out once per cue over UDP", async (t) => {
  const rx = await udpListener(t);
  const bridge = bridgeWith(t, [{
    type: "osc", host: "127.0.0.1", port: rx.port,
    cues: { idle: "", live: '/gma3/cmd "Go+ Sequence 2"', final: "/eos/cue/1/3/fire; /Page1/Fader201 i:100 0.5", blackout: "" }
  }]);

  bridge.trigger("live");
  bridge.trigger("final");
  bridge.trigger("final");
  await sleep(300);

  assert.deepEqual(rx.packets.map(decodeOsc), [
    { address: "/gma3/cmd", tags: ",s", args: ["Go+ Sequence 2"] },
    { address: "/eos/cue/1/3/fire", tags: ",", args: [] },
    { address: "/Page1/Fader201", tags: ",if", args: [100, 0.5] }
  ]);
});

test("OSC over TCP uses SLIP (1.1) or length-prefix (1.0) framing", async (t) => {
  const slipRx = await tcpListener(t);
  const lengthRx = await tcpListener(t);
  const bridge = bridgeWith(t, [
    { type: "osc", transport: "tcp-slip", host: "127.0.0.1", port: slipRx.port, cues: { final: "/eos/cue/1/3/fire" } },
    { type: "osc", transport: "tcp-length", host: "127.0.0.1", port: lengthRx.port, cues: { final: "/eos/cue/1/3/fire" } }
  ]);

  bridge.trigger("final");
  await sleep(300);

  const slipped = slipRx.data();
  assert.equal(slipped[0], 0xc0);
  assert.equal(slipped.at(-1), 0xc0);
  assert.equal(decodeOsc(slipped.subarray(1, -1)).address, "/eos/cue/1/3/fire");
  const framed = lengthRx.data();
  assert.equal(framed.readInt32BE(0), framed.length - 4);
  assert.equal(decodeOsc(framed.subarray(4)).address, "/eos/cue/1/3/fire");
});

test("Art-Net holds the active cue as DMX levels", async (t) => {
  const rx = await udpListener(t);
  const bridge = bridgeWith(t, [{
    type: "artnet", host: "127.0.0.1", port: rx.port, universe: 3,
    cues: { idle: "1@255", live: "1@120", final: "3@200, 4@50", blackout: "" }
  }]);

  bridge.trigger("final");
  await sleep(600);

  const frames = rx.packets.slice(-2);
  assert.ok(rx.packets.length >= 3, "levels are re-sent");
  for (const frame of frames) {
    assert.equal(frame.subarray(0, 8).toString("latin1"), "Art-Net\0");
    assert.equal(frame.readUInt16LE(14), 3);
    assert.deepEqual([...frame.subarray(18, 22)], [0, 0, 200, 50]);
  }
});

test("sACN sends E1.31 data packets with the active cue's levels", async (t) => {
  const rx = await udpListener(t, 5568);
  const bridge = bridgeWith(t, [{
    type: "sacn", host: "127.0.0.1", universe: 7, priority: 150,
    cues: { idle: "1@255", live: "2@255", final: "3@255", blackout: "" }
  }]);

  bridge.trigger("live");
  await sleep(600);

  const [first, second] = rx.packets.slice(-2);
  assert.equal(first.length, 638);
  assert.equal(first.subarray(4, 16).toString("latin1"), "ASC-E1.17\0\0\0");
  assert.equal(first.readUInt32BE(18), 4);
  assert.equal(first.readUInt32BE(40), 2);
  assert.match(first.subarray(44, 108).toString("utf8"), /^Signature Wall/);
  assert.equal(first[108], 150);
  assert.equal(first.readUInt16BE(113), 7);
  assert.equal(first.readUInt16BE(123), 513);
  assert.deepEqual([...first.subarray(126, 129)], [0, 255, 0]);
  assert.equal(second[111], (first[111] + 1) & 0xff, "sequence number advances");
});

test("MIDI cues become Show Control, note and program messages for the bridge page", async (t) => {
  const sent = [];
  const bridge = bridgeWith(t, [{
    type: "midi", port: "USB MIDI", mscDevice: 1, mscFormat: 1,
    cues: { idle: "pc 2 5", live: "note 1 60 100", final: "msc go 3 1; hex 90 3C 7F", blackout: "msc all_off" }
  }], { onMidi: (event) => { sent.push(event); return 1; } });

  bridge.trigger("live");
  bridge.trigger("final");
  bridge.trigger("idle");

  assert.deepEqual(sent.map((event) => [event.cue, event.port, event.messages]), [
    ["live", "USB MIDI", [{ bytes: [0x90, 60, 100], delayMs: 0 }, { bytes: [0x80, 60, 0], delayMs: 100 }]],
    ["final", "USB MIDI", [
      { bytes: [0xf0, 0x7f, 0x01, 0x02, 0x01, 0x01, 0x33, 0x00, 0x31, 0xf7], delayMs: 0 },
      { bytes: [0x90, 0x3c, 0x7f], delayMs: 0 }
    ]],
    ["idle", "USB MIDI", [{ bytes: [0xc1, 5], delayMs: 0 }]]
  ]);
});

test("a MIDI cue with no bridge page connected shows an error", async (t) => {
  const bridge = bridgeWith(t, [{ type: "midi", cues: { final: "msc go 3" } }], { onMidi: () => 0 });

  bridge.trigger("final");

  assert.match(bridge.state().outputs[0].lastError, /MIDI 橋接/);
});

test("text commands go out over UDP and TCP with the chosen line ending", async (t) => {
  const udpRx = await udpListener(t);
  const tcpRx = await tcpListener(t);
  const bridge = bridgeWith(t, [
    { type: "text", host: "127.0.0.1", port: udpRx.port, transport: "udp", lineEnding: "cr", cues: { final: "GO 3\\x3B1" } },
    { type: "text", host: "127.0.0.1", port: tcpRx.port, transport: "tcp", lineEnding: "crlf", cues: { final: "Go+ Sequence 3; Go+ Sequence 4" } }
  ]);

  bridge.trigger("final");
  await sleep(300);

  assert.deepEqual(udpRx.packets.map((packet) => packet.toString("latin1")), ["GO 3;1\r"]);
  assert.equal(tcpRx.data().toString("latin1"), "Go+ Sequence 3\r\nGo+ Sequence 4\r\n");
});

test("HTTP cues call the console's web API and report failures", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(req.url.includes("missing") ? 404 : 200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const bridge = bridgeWith(t, [{
    type: "http", baseUrl: base,
    cues: { live: "POST /api/location/1/0/1/press", final: `${base}/go?cue=3`, blackout: "PUT /missing level=0" }
  }]);

  bridge.trigger("live");
  bridge.trigger("final");
  bridge.trigger("blackout");
  await sleep(300);

  assert.deepEqual(requests, [
    { method: "POST", url: "/api/location/1/0/1/press", body: "" },
    { method: "GET", url: "/go?cue=3", body: "" },
    { method: "PUT", url: "/missing", body: "level=0" }
  ]);
  assert.match(bridge.state().outputs[0].lastError, /404/);
});

test("outputs that cannot reach their console are refused, switched-off drafts are kept", async (t) => {
  const bridge = createLightingBridge({ log: () => {} });
  t.after(() => bridge.close());

  assert.throws(() => bridge.configure({ outputs: [{ type: "artnet", name: "Desk" }] }), /Desk：請填「目標 IP」/);
  assert.throws(() => bridge.configure({ outputs: [{ type: "artnet", host: "255.255.255.255" }] }), /255\.255\.255\.255/);
  assert.throws(() => bridge.configure({ outputs: [{ type: "midi", cues: { final: "msc jump 3" } }] }), /Final（上牆）：MSC 指令/);
  assert.equal(bridge.state().config.outputs.length, 0);

  const saved = bridge.configure({ outputs: [{ type: "osc", enabled: false, cues: { final: "/eos/cue/1/3/fire" } }] });
  assert.equal(saved.config.outputs.length, 1);
});

test("closing the bridge leaves every console on the idle cue", async (t) => {
  const artnetRx = await udpListener(t);
  const oscRx = await udpListener(t);
  const bridge = createLightingBridge({ log: () => {} });
  bridge.configure({
    outputs: [
      { type: "artnet", host: "127.0.0.1", port: artnetRx.port, cues: { idle: "1@255", final: "3@255" } },
      { type: "osc", host: "127.0.0.1", port: oscRx.port, cues: { idle: "/eos/cue/1/1/fire", final: "/eos/cue/1/3/fire" } }
    ]
  });
  bridge.trigger("final");
  await sleep(100);

  await bridge.close();
  await sleep(100);

  assert.deepEqual([...artnetRx.packets.at(-1).subarray(18, 21)], [255, 0, 0]);
  assert.equal(decodeOsc(oscRx.packets.at(-1)).address, "/eos/cue/1/1/fire");
});
