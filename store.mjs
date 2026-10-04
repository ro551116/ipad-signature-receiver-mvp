// Signature persistence: keeps the retained signature list and the doctor
// number counter in a local JSON file so a server restart on site does not
// wipe the marquee wall or reuse doctor numbers.

import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";

export function createSignatureStore(options = {}) {
  const dataDir = options.dataDir;
  const filePath = path.join(dataDir, "signatures.json");
  const tmpPath = `${filePath}.tmp`;
  const debounceMs = Number(options.debounceMs || 400);
  const log = options.log || ((...args) => console.log("[store]", ...args));

  let saveTimer = null;
  let saving = false;
  let pendingSnapshot = null;
  // Tracks the in-flight write so shutdown can await it instead of racing
  // process.exit() against an async writeFile()/rename() pair.
  let inFlight = Promise.resolve();

  function load() {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.signatures)) {
        log(`loaded ${parsed.signatures.length} signatures from ${filePath}`);
        return { signatures: parsed.signatures, nextDoctorNumber: savedNextNumber(parsed) };
      }
    } catch (error) {
      if (error.code !== "ENOENT") log(`load failed: ${error.message}`);
    }
    return { signatures: [], nextDoctorNumber: 1 };
  }

  // Files written before the counter existed only carry names like "醫師 07";
  // continue after the highest number in use so nothing is handed out twice.
  function savedNextNumber(parsed) {
    const saved = Number(parsed.nextDoctorNumber);
    if (Number.isInteger(saved) && saved > 0) return saved;
    const used = parsed.signatures
      .map((signature) => Number(/(\d+)\s*$/.exec(signature?.meta?.doctorName || "")?.[1]))
      .filter(Number.isFinite);
    return Math.max(parsed.signatures.length, ...used) + 1;
  }

  async function writeSnapshot(snapshot) {
    mkdirSync(dataDir, { recursive: true });
    const body = JSON.stringify({ savedAt: new Date().toISOString(), ...snapshot }, null, 2);
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, filePath);
  }

  async function flush() {
    if (saving || !pendingSnapshot) return;
    saving = true;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    inFlight = (async () => {
      try {
        await writeSnapshot(snapshot);
      } catch (error) {
        log(`save failed: ${error.message}`);
      } finally {
        saving = false;
        if (pendingSnapshot) flush();
      }
    })();
    await inFlight;
  }

  function save({ signatures, nextDoctorNumber }) {
    pendingSnapshot = { nextDoctorNumber, signatures: signatures.map((signature) => ({ ...signature })) };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, debounceMs);
    saveTimer.unref();
  }

  // For shutdown: waits for any debounced write (unref'd, so it would
  // otherwise be silently lost) and any save already in flight — including
  // one that re-triggers itself because a newer snapshot arrived mid-write —
  // to fully settle before the process exits.
  async function flushNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    while (pendingSnapshot || saving) {
      if (pendingSnapshot && !saving) await flush();
      else await inFlight;
    }
  }

  return { load, save, flushNow, filePath };
}
