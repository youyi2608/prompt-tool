// 提示词工具 ↔ ComfyUI 互通节点的前端扩展
// 职责：监听后端推来的 prompt_sync.update 事件，把正/负提示词写进本节点的两个文本框。
import { app } from "../../scripts/app.js";
import * as apiMod from "../../scripts/api.js";

const NODE_NAME = "PromptSyncFromTool";
const EVENT_NAME = "prompt_sync.update";
const API_ROOT = "/prompt_sync";

const api = (apiMod && apiMod.api) || (typeof window !== "undefined" && window.comfyAPI?.api?.api) || null;

function log(...args) {
  console.log("[PromptSync]", ...args);
}

// 取控件：ComfyUI 新版可能把控件包在 PrimeVue 代理里，用 resolveDeepest 取到真身
function resolveWidget(node, name) {
  const ws = node && node.widgets;
  if (!Array.isArray(ws)) return null;
  for (const w of ws) {
    let target = w;
    try {
      const deep = w && typeof w.resolveDeepest === "function" ? w.resolveDeepest() : null;
      if (deep && deep.widget) target = deep.widget;
    } catch (e) { /* 忽略 */ }
    if (target && target.name === name) return target;
  }
  for (const w of ws) if (w && w.name === name) return w;
  return null;
}

// 写控件值：只赋 .value 不够，必须联动 callback 与画布重绘
function writeWidget(node, name, value) {
  const w = resolveWidget(node, name);
  if (!w) return false;
  try { w.value = value; } catch (e) { return false; }
  try { if (typeof w.callback === "function") w.callback(value); } catch (e) { /* 忽略 */ }
  try {
    if (w.inputEl && "value" in w.inputEl) w.inputEl.value = value;
    else if (w.element && typeof w.element.querySelector === "function") {
      const ta = w.element.querySelector("textarea");
      if (ta) ta.value = value;
    }
  } catch (e) { /* 忽略 */ }
  return true;
}

function refreshCanvas(node) {
  try { node.graph && node.graph.change && node.graph.change(); } catch (e) { /* 忽略 */ }
  try { app.graph && app.graph.setDirtyCanvas && app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

function flash(node, ok) {
  try {
    node.boxcolor = ok ? "#1a9c5b" : "#c0392b";
    setTimeout(() => {
      try { node.boxcolor = undefined; app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
    }, 1200);
  } catch (e) { /* 忽略 */ }
}

function targetNodes() {
  const nodes = (app && app.graph && app.graph._nodes) || [];
  return nodes.filter((n) => n && (n.type === NODE_NAME || n.comfyClass === NODE_NAME));
}

// 把一次推送写进画布上所有互通节点
function applyPayload(payload) {
  const nodes = targetNodes();
  if (!nodes.length) { log("画布里没有「提示词同步」节点，收到但无处写入"); return 0; }
  const pos = typeof payload?.pos === "string" ? payload.pos : "";
  const neg = typeof payload?.neg === "string" ? payload.neg : "";
  const name = payload?.name || "";
  let hit = 0;
  for (const node of nodes) {
    let wrote = false;
    if (pos) wrote = writeWidget(node, "positive", pos) || wrote;
    if (neg) wrote = writeWidget(node, "negative", neg) || wrote;
    if (wrote) { refreshCanvas(node); flash(node, true); hit++; }
  }
  if (hit) log(`已同步「${name || "未命名"}」到 ${hit} 个节点（正 ${pos.length} 字 / 负 ${neg.length} 字）`);
  return hit;
}

// 手动兜底：从本地节点取回最后一次推送
async function pullOnce() {
  try {
    const r = await fetch(`${API_ROOT}/current`, { cache: "no-store" });
    const j = await r.json();
    if (j && j.success && j.data) return applyPayload(j.data);
  } catch (e) {
    log("取回失败", e);
  }
  return 0;
}

function attachManualSync(node) {
  try {
    if (typeof node.addWidget !== "function") return;
    node.addWidget("button", "从工具同步一次", null, () => { pullOnce(); }, { serialize: false });
    log("已给节点加上「从工具同步一次」按钮");
  } catch (e) {
    log("手动同步按钮注入失败（不影响自动同步）", e);
  }
}

app.registerExtension({
  name: "PromptSync.FromTool",

  async setup() {
    if (api && typeof api.addEventListener === "function") {
      api.addEventListener(EVENT_NAME, (e) => {
        try { applyPayload(e && e.detail ? e.detail : {}); }
        catch (err) { console.warn("[PromptSync] 写入节点失败", err); }
      });
      log("已开始监听 " + EVENT_NAME);
    } else {
      console.warn("[PromptSync] 取不到 ComfyUI 的 api 模块：自动同步不可用，请用节点上的「从工具同步一次」按钮");
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      attachManualSync(this);
      return r;
    };
  },
});
