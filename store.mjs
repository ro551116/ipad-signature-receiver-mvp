// Signature persistence: keeps the retained signature list in a local JSON
// file so a server restart on site does not wipe the marquee wall.

import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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

  function load() {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.signatures)) {
        log(`loaded ${parsed.signatures.length} signatures from ${filePath}`);
        return parsed.signatures;
      }
    } catch (error) {
      if (error.code !== "ENOENT") log(`load failed: ${error.message}`);
    }
    return [];
  }

  async function flush() {
    if (saving || !pendingSnapshot) return;
    saving = true;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    try {
      mkdirSync(dataDir, { recursive: true });
      const body = JSON.stringify({ savedAt: new Date().toISOString(), signatures: snapshot }, null, 2);
      await writeFile(tmpPath, body, "utf8");
      await rename(tmpPath, filePath);
    } catch (error) {
      log(`save failed: ${error.message}`);
    } finally {
      saving = false;
      if (pendingSnapshot) flush();
    }
  }

  function save(signatures) {
    pendingSnapshot = signatures.map((signature) => ({ ...signature }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, debounceMs);
    saveTimer.unref();
  }

  // For shutdown: the debounce timer is unref'd, so a signature submitted in
  // the last debounce window would be silently lost without this.
  function flushSync() {
    if (!pendingSnapshot) return;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    if (saveTimer) clearTimeout(saveTimer);
    try {
      mkdirSync(dataDir, { recursive: true });
      const body = JSON.stringify({ savedAt: new Date().toISOString(), signatures: snapshot }, null, 2);
      writeFileSync(tmpPath, body, "utf8");
      renameSync(tmpPath, filePath);
    } catch (error) {
      log(`flushSync failed: ${error.message}`);
    }
  }

  return { load, save, flushSync, filePath };
}
