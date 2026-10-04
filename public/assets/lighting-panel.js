// Lighting-console output editor for /control: one card per output, a line
// per cue with a live preview of what will be sent, per-cue test buttons,
// and a JSON view of the whole config for bulk edits / copying between
// machines. Field definitions and parsing come from cue-syntax.js, the same
// module the server uses.

import { CUES, CUE_LABELS, OUTPUT_TYPES, newOutput, normalizeConfig, parseCueLine, validateOutput } from "/assets/cue-syntax.js";
import { formatTime } from "/assets/shared.js";

function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

export function createLightingPanel({ root, headers }) {
  const list = root.querySelector("#lightOutputs");
  const addBar = root.querySelector("#lightAdd");
  const saveButton = root.querySelector("#lightSave");
  const revertButton = root.querySelector("#lightRevert");
  const dirtyNote = root.querySelector("#lightDirty");
  const toast = root.querySelector("#lightToast");
  const currentCue = root.querySelector("#lightCurrentCue");
  const jsonBox = root.querySelector("#lightJson");
  const jsonApply = root.querySelector("#lightJsonApply");
  const jsonCopy = root.querySelector("#lightJsonCopy");
  const midiDatalist = root.querySelector("#midiPorts");

  let saved = { outputs: [] };
  // Editing copy; null while the form matches what the server has.
  let draft = null;
  let statuses = new Map();

  const current = () => draft || saved;

  function markDirty() {
    if (!draft) draft = structuredClone(saved);
    dirtyNote.hidden = false;
    for (const button of list.querySelectorAll("[data-test-cue]")) button.disabled = true;
    jsonBox.value = JSON.stringify(draft, null, 2);
  }

  async function postJson(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `request failed: ${response.status}`);
    return payload;
  }

  // ---- Rendering ----

  function statusText(output) {
    const status = statuses.get(output.id);
    if (!output.enabled) return "已停用";
    if (!status) return "尚未儲存";
    const parts = [`已送 ${status.sent} 次`];
    if (status.lastSentAt) parts.push(`最後 ${formatTime(status.lastSentAt)}`);
    return parts.join(" · ");
  }

  function renderStatus(card, output) {
    const status = statuses.get(output.id);
    card.querySelector(".light-output-status").textContent = statusText(output);
    const error = card.querySelector(".light-output-error");
    error.textContent = status?.lastError ? `錯誤：${status.lastError}` : "";
    error.hidden = !status?.lastError;
  }

  function renderProblem(card, output) {
    const problem = validateOutput(output);
    const box = card.querySelector(".light-output-problem");
    box.textContent = problem ? `無法儲存：${problem}` : "";
    box.hidden = !problem;
  }

  function cuePreview(output, cue) {
    try {
      return { text: `→ ${parseCueLine(output, output.cues[cue]).summary}`, ok: true };
    } catch (error) {
      return { text: `✕ ${error.message}`, ok: false };
    }
  }

  function fieldInput(output, field, card) {
    const value = output[field.key];
    let input;
    if (field.type === "select") {
      input = element("select", {}, field.options.map(([option, label]) => element("option", { value: option, textContent: label })));
      input.value = value;
    } else {
      input = element("input", {
        type: field.type === "number" ? "number" : "text",
        value: value ?? "",
        placeholder: field.placeholder || ""
      });
      if (field.type === "number") {
        input.min = field.min;
        input.max = field.max;
      }
      if (field.list) input.setAttribute("list", field.list);
    }
    input.addEventListener("input", () => {
      markDirty();
      const target = draft.outputs.find((item) => item.id === output.id);
      target[field.key] = field.type === "number" ? (input.value === "" ? null : Number(input.value)) : input.value.trim();
      refreshPreviews(card, target);
    });
    return element("label", { className: "light-field" }, [element("span", { textContent: field.label }), input]);
  }

  function refreshPreviews(card, output) {
    for (const cue of CUES) {
      const preview = cuePreview(output, cue);
      const node = card.querySelector(`[data-preview="${cue}"]`);
      node.textContent = preview.text;
      node.title = preview.text;
      node.classList.toggle("bad", !preview.ok);
    }
    renderProblem(card, output);
  }

  function renderCard(output) {
    const definition = OUTPUT_TYPES[output.type];
    const card = element("article", { className: "light-output", dataset: { id: output.id } });

    const name = element("input", { className: "light-output-name", value: output.name, "aria-label": "輸出名稱" });
    name.addEventListener("input", () => {
      markDirty();
      draft.outputs.find((item) => item.id === output.id).name = name.value;
    });
    const enabled = element("input", { type: "checkbox", checked: output.enabled });
    enabled.addEventListener("change", () => {
      markDirty();
      const target = draft.outputs.find((item) => item.id === output.id);
      target.enabled = enabled.checked;
      renderProblem(card, target);
    });
    const remove = element("button", { type: "button", className: "secondary", textContent: "刪除" });
    remove.addEventListener("click", () => {
      if (!confirm(`刪除「${output.name}」這個輸出？（按儲存後才生效）`)) return;
      markDirty();
      draft.outputs = draft.outputs.filter((item) => item.id !== output.id);
      render();
    });
    card.append(element("header", { className: "light-output-head" }, [
      element("span", { className: "light-output-type", textContent: definition.label }),
      name,
      element("label", { className: "light-output-toggle" }, [enabled, " 啟用"]),
      remove
    ]));

    card.append(element("div", { className: "light-fieldset" }, definition.fields.map((field) => fieldInput(output, field, card))));

    const rows = CUES.map((cue) => {
      const input = element("input", { className: "light-cue-input", value: output.cues[cue], placeholder: "留空 = 不送", spellcheck: false });
      const preview = element("span", { className: "light-cue-preview", dataset: { preview: cue } });
      input.addEventListener("input", () => {
        markDirty();
        const target = draft.outputs.find((item) => item.id === output.id);
        target.cues[cue] = input.value;
        refreshPreviews(card, target);
      });
      const testButton = element("button", { type: "button", className: "secondary", textContent: "送出", dataset: { testCue: cue }, disabled: Boolean(draft), title: "只送這個輸出的這個 cue（要先儲存）" });
      testButton.addEventListener("click", async () => {
        try {
          const payload = await postJson("/api/lighting/cue", { cue, outputId: output.id });
          update(payload.lighting);
          toast.textContent = `已送出 ${output.name} / ${CUE_LABELS[cue]}`;
        } catch (error) {
          toast.textContent = error.message;
        }
      });
      return element("div", { className: "light-cue-row" }, [
        element("span", { className: "light-cue-label", textContent: CUE_LABELS[cue] }),
        input,
        testButton,
        preview
      ]);
    });
    card.append(element("div", { className: "light-cues" }, rows));
    card.append(element("p", { className: "light-hint", textContent: definition.help }));
    card.append(element("p", { className: "light-output-problem", hidden: true }));
    card.append(element("p", { className: "light-output-status" }));
    card.append(element("p", { className: "light-output-error", hidden: true }));

    refreshPreviews(card, output);
    renderStatus(card, output);
    return card;
  }

  function render() {
    const config = current();
    list.replaceChildren(...config.outputs.map((output) => renderCard(structuredClone(output))));
    if (config.outputs.length === 0) {
      list.append(element("p", { className: "helper-text", textContent: "還沒有輸出。用下面的按鈕新增，每種都可以加很多個、同時送。" }));
    }
    jsonBox.value = JSON.stringify(config, null, 2);
  }

  // ---- Actions ----

  for (const [type, definition] of Object.entries(OUTPUT_TYPES)) {
    const button = element("button", { type: "button", className: "secondary", textContent: `＋ ${definition.label}` });
    button.addEventListener("click", () => {
      markDirty();
      draft.outputs.push(newOutput(type));
      render();
      list.lastElementChild?.scrollIntoView({ block: "nearest" });
    });
    addBar.append(button);
  }

  async function save(config) {
    try {
      const payload = await postJson("/api/lighting/config", config);
      draft = null;
      dirtyNote.hidden = true;
      update(payload.lighting, { force: true });
      toast.textContent = "燈光設定已儲存";
    } catch (error) {
      toast.textContent = `沒有儲存：${error.message}`;
    }
  }

  saveButton.addEventListener("click", () => save(current()));

  revertButton.addEventListener("click", () => {
    draft = null;
    dirtyNote.hidden = true;
    render();
    toast.textContent = "已還原成儲存的設定";
  });

  jsonApply.addEventListener("click", () => {
    let parsed;
    try {
      parsed = JSON.parse(jsonBox.value);
    } catch (error) {
      toast.textContent = `JSON 格式錯誤：${error.message}`;
      return;
    }
    save(normalizeConfig(parsed));
  });

  jsonCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(jsonBox.value);
      toast.textContent = "已複製設定 JSON";
    } catch {
      jsonBox.select();
      toast.textContent = "複製失敗，已選取文字，請手動複製";
    }
  });

  root.querySelectorAll("[data-light-cue]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const payload = await postJson("/api/lighting/cue", { cue: button.dataset.lightCue });
        update(payload.lighting);
        toast.textContent = `已送出 ${CUE_LABELS[button.dataset.lightCue]} 到所有啟用的輸出`;
      } catch (error) {
        toast.textContent = error.message;
      }
    });
  });

  // ---- Server state ----

  // Statuses always refresh; the form is only rebuilt from the server when
  // there are no unsaved edits (or right after saving).
  function update(lighting, { force = false } = {}) {
    if (!lighting) return;
    currentCue.textContent = CUE_LABELS[lighting.currentCue] || lighting.currentCue || "-";
    statuses = new Map((lighting.outputs || []).map((status) => [status.id, status]));
    midiDatalist.replaceChildren(...(lighting.midiPorts || []).map((port) => element("option", { value: port })));
    const incoming = JSON.stringify(lighting.config);
    if (force || (!draft && incoming !== JSON.stringify(saved))) {
      saved = lighting.config;
      render();
      return;
    }
    for (const card of list.querySelectorAll(".light-output")) {
      const output = current().outputs.find((item) => item.id === card.dataset.id);
      if (output) renderStatus(card, output);
    }
  }

  render();
  return { update };
}
