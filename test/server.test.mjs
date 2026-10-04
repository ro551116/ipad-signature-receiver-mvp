// Behaviour tests for the show server, exercised only through its HTTP API.
// Each test boots a real server on a random port with its own data dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_TOKEN = "test-control-token";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(t, env = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "signature-wall-test-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      CONTROL_TOKEN,
      SIGN_TOKEN: "",
      ALLOW_UNSAFE_NO_CONTROL_TOKEN: "",
      LIGHT_MODE: "log",
      DISPLAY_DURATION_MS: "300",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /running on port (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => reject(new Error(`server exited early (${code}):\n${output}`)));
  });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    rmSync(dataDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

function signature(id, x = 0.2) {
  const stroke = Array.from({ length: 40 }, (_, i) => ({ x: x + i * 0.01, y: 0.4 + (i % 5) * 0.02, p: 0.5 }));
  return { id, canvas: { width: 800, height: 400 }, strokes: [stroke], meta: { source: "test" } };
}

async function call(base, method, pathname, { body, token, headers = {} } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "X-Control-Token": token } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, bytes: Buffer.byteLength(text) };
}

const submit = (base, id) => call(base, "POST", "/api/signatures", { body: signature(id) });
const sendLive = (base, id, x) => call(base, "POST", "/api/live-signature", { body: signature(id, x) });
const staffSignatures = async (base) => (await call(base, "GET", "/api/signatures", { token: CONTROL_TOKEN })).json.signatures;
const staffState = async (base) => (await call(base, "GET", "/api/state", { token: CONTROL_TOKEN })).json;

// Collects server-sent events until stop() is called.
async function listen(base, query) {
  const controller = new AbortController();
  const response = await fetch(`${base}/events?${query}`, { signal: controller.signal });
  const events = [];
  const done = (async () => {
    if (!response.ok) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
          if (event) events.push({ event, data });
        }
      }
    } catch {}
  })();
  return {
    status: response.status,
    events,
    async stop() {
      controller.abort();
      await done;
    }
  };
}

test("a full store rejects new signatures instead of deleting earlier ones", async (t) => {
  const base = await startServer(t, { MAX_SIGNATURES: "2" });
  assert.equal((await submit(base, "sig-first-01")).status, 201);
  assert.equal((await submit(base, "sig-second-02")).status, 201);

  const third = await submit(base, "sig-third-03");

  assert.equal(third.status, 409);
  assert.deepEqual((await staffSignatures(base)).map((s) => s.id), ["sig-first-01", "sig-second-02"]);
});

test("doctor numbers stay unique after a signature is deleted", async (t) => {
  const base = await startServer(t);
  for (const id of ["sig-aaaaaa", "sig-bbbbbb", "sig-cccccc"]) await submit(base, id);
  await call(base, "DELETE", "/api/signatures/sig-bbbbbb", { token: CONTROL_TOKEN });

  await submit(base, "sig-dddddd");

  const names = (await staffSignatures(base)).map((s) => s.meta.doctorName);
  assert.deepEqual(names, ["醫師 01", "醫師 03", "醫師 04"]);
});

test("re-sending the same signature stores it once and keeps its number", async (t) => {
  const base = await startServer(t);
  await submit(base, "sig-retry-01");
  const retry = await submit(base, "sig-retry-01");
  await submit(base, "sig-next-02");

  assert.equal(retry.status, 200);
  const stored = await staffSignatures(base);
  assert.deepEqual(stored.map((s) => [s.id, s.meta.doctorName]), [
    ["sig-retry-01", "醫師 01"],
    ["sig-next-02", "醫師 02"]
  ]);
});

test("a live frame arriving after submission cannot take over the wall", async (t) => {
  const base = await startServer(t);
  await submit(base, "sig-late-frame");

  const late = await sendLive(base, "sig-late-frame");
  await sleep(600); // DISPLAY_DURATION_MS is 300 in tests

  assert.equal(late.status, 409);
  const state = await staffState(base);
  assert.equal(state.status, "idle");
  assert.equal(state.liveSignature, null);
  assert.equal(state.lighting.currentCue, "idle");
});

test("reading signatures requires the staff token", async (t) => {
  const base = await startServer(t);
  await submit(base, "sig-private-01");

  assert.equal((await call(base, "GET", "/api/signatures")).status, 403);
  assert.equal((await call(base, "GET", "/api/state")).status, 403);
  const anonymous = await listen(base, "role=wall");
  await anonymous.stop();
  assert.equal(anonymous.status, 403);

  assert.equal((await call(base, "GET", "/api/signatures", { token: CONTROL_TOKEN })).status, 200);
  const staff = await listen(base, `role=wall&token=${CONTROL_TOKEN}`);
  await staff.stop();
  assert.equal(staff.status, 200);
});

test("the signing iPad connection never receives signature strokes", async (t) => {
  const base = await startServer(t);
  await submit(base, "sig-other-doctor");
  const ipad = await listen(base, "role=sign");

  await sendLive(base, "sig-current-doctor");
  await sleep(200);
  await ipad.stop();

  assert.equal(ipad.status, 200);
  assert.ok(ipad.events.length > 0, "the iPad should still get connection events");
  for (const { data } of ipad.events) assert.ok(!data.includes("strokes"), `iPad received: ${data.slice(0, 80)}`);
});

test("live frames stay the same size as retained signatures accumulate", async (t) => {
  const base = await startServer(t, { DISPLAY_DURATION_MS: "60000" });
  const wall = await listen(base, `role=wall&token=${CONTROL_TOKEN}`);

  const before = await sendLive(base, "sig-live-first", 0.3);
  await call(base, "POST", "/api/live-signature/clear");
  for (let i = 0; i < 20; i += 1) await submit(base, `sig-bulk-${String(i).padStart(3, "0")}`);
  const after = await sendLive(base, "sig-live-second", 0.3);
  await sleep(200);
  await wall.stop();

  const liveEvents = wall.events.filter((e) => e.event === "signature:live").map((e) => Buffer.byteLength(e.data));
  assert.equal(liveEvents.length, 2);
  assert.ok(liveEvents[1] - liveEvents[0] < 200, `wall live event grew ${liveEvents[0]} -> ${liveEvents[1]} bytes`);
  assert.ok(after.bytes - before.bytes < 200, `live response grew ${before.bytes} -> ${after.bytes} bytes`);
});

test("deleting another signature mid-display keeps the display start time", async (t) => {
  const base = await startServer(t, { DISPLAY_DURATION_MS: "60000" });
  await submit(base, "sig-older-one");
  await submit(base, "sig-on-screen");
  const shown = await staffState(base);

  await sleep(20);
  await call(base, "DELETE", "/api/signatures/sig-older-one", { token: CONTROL_TOKEN });

  const after = await staffState(base);
  assert.ok(Number.isFinite(shown.activeSince), "state should expose when the current display started");
  assert.equal(after.currentSignature.id, "sig-on-screen");
  assert.equal(after.activeSince, shown.activeSince);
});
