// 套图排队节点（PromptToolBatchQueue）的前端
//
// 三件事：
//   ① 四颗按钮：「▶ 开始排队」把**当前工作流**的 API 图连同设置发给节点后端，由它一张一张排；
//      「⏸ 暂停」/「▶ 继续」把排队键住（正在出的那一张会先出完，见下）；
//      「⏹ 停止」立刻停（不排下一张 + 收掉还没开始的 + 打断正在跑的那张）；
//      「🗑 清除进程」把这一轮收掉 + 清空工具推来的那几段，回到"等工具再推一次"
//      （他 2026-10-02 要的：暂停或还没开始的时候用它；正在出图时后端会拒绝并说明）。
//   ② 节点身上写清楚现在的状态：已收到几段 / 本轮的进度 / 正在休息还剩几秒 / 暂停了没有。
//   ③ 顶上一条灰字提示：它得和「提示词同步」节点一起用（提示词是那个节点送出去的）。
//
// ⚠️ 暂停的语义（他 2026-10-02 定的）：「如果生成到一半不能暂停，那就把这张图生成之后再暂停」
//    —— 所以暂停**不打断**正在跑的那张，落在"上一张出完 / 两张之间的休息里"这两个落点上。
//    按钮文字跟着后端状态变（paused），不靠前端自己记，免得两边说法不一致。
//
// 状态从两处来：节点后端推的 `prompt_sync.batch` 事件（首选）+ 一次 GET（节点刚建出来的时候补一次）。
import { app } from "../../scripts/app.js";
import * as apiMod from "../../scripts/api.js";

const NODE_NAME = "PromptToolBatchQueue";
const API_ROOT = "/prompt_sync/batch";
const EVENT_NAME = "prompt_sync.batch";
const W_REST = "每张之间休息(秒)";
const W_MAX = "一次最多几张";
const W_SEED = "每张换随机种子";
const STATUS_H = 46;
const HINT_TEXT = "需要和「提示词同步」节点一起使用";
const HINT_COLOR = "rgba(150, 162, 180, 0.95)";
const BTN_PAUSE = "⏸ 暂停排队";
const BTN_RESUME = "▶ 继续排队";
const BTN_CLEAR = "🗑 清除进程";

const api = (apiMod && apiMod.api) || (typeof window !== "undefined" && window.comfyAPI?.api?.api) || null;

function log(...args) { console.log("[套图排队]", ...args); }

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

function redrawNode(node) {
  try { node.graph && node.graph.setDirtyCanvas && node.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
  try { app.graph && app.graph.setDirtyCanvas && app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 状态
// status = 节点后端那份：{segments(段数), running, paused, stage, index, planned, done, rest_left, error, note}
const STATUS = { segments: -1, running: false, paused: false, stage: "idle", index: 0, planned: 0, done: 0, rest_left: 0, error: "", note: "", backend: "unknown" };
let pollTimer = null;
let pollNode = null;

function stageText() {
  if (STATUS.backend === "missing") return "节点后端没有套图接口（节点是旧版 —— 重启一次 ComfyUI）";
  if (STATUS.error) return "出错：" + STATUS.error;
  // 暂停键按下去了、但这一张还在出 —— 说清楚"它会在哪里停"
  if (STATUS.paused && STATUS.stage !== "paused") return "已按下暂停 —— 等这一张出完就停在这儿…";
  switch (STATUS.stage) {
    case "queued":
      return STATUS.index ? `已排第 ${STATUS.index} / ${STATUS.planned} 张，等它出完…` : "正在排队…";
    case "resting":
      return `正在休息 ${STATUS.rest_left} 秒（这段时间 ComfyUI 是空的）…`;
    case "paused":
      return "已暂停 —— 点「▶ 继续排队」接着排（已经出的图都在）";
    case "done":
      return `这一轮排完了（共 ${STATUS.done} 张）`;
    case "stopped":
      return `已停止（出了 ${STATUS.done} 张）`;
    case "error":
      return "出错了，看下面的红字";
    default:
      return STATUS.segments > 0 ? "空闲 —— 点「▶ 开始排队」就开跑" : "空闲 —— 等工具把这一套推过来";
  }
}

function countText() {
  const got = STATUS.segments < 0 ? "?" : STATUS.segments;
  const parts = [`已收到 ${got} 段`];
  if (STATUS.planned && STATUS.running) parts.push(`本轮 ${Math.min(STATUS.index || 1, STATUS.planned)}/${STATUS.planned} 张`);
  if (STATUS.done) parts.push(`已出 ${STATUS.done} 张`);
  return parts.join(" · ");
}

function applyStatus(st) {
  if (!st || typeof st !== "object") return;
  if (typeof st.segments === "number") STATUS.segments = st.segments;
  else if (Array.isArray(st.segments)) STATUS.segments = st.segments.length;
  ["running", "paused", "stage", "index", "planned", "done", "rest_left", "error", "note"].forEach((k) => {
    if (k in st) STATUS[k] = st[k];
  });
  if (st.success === true || st.stage) STATUS.backend = "ok";
  if (STATUS.running) startPolling(); else stopPolling();
  updatePauseButton();
  if (pollNode) redrawNode(pollNode);
}

async function fetchStatus(node) {
  pollNode = node || pollNode;
  try {
    const r = await fetch(`${API_ROOT}/status`, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    applyStatus(await r.json());
  } catch (e) {
    STATUS.backend = "missing";
    STATUS.error = STATUS.error || "";
    if (pollNode) redrawNode(pollNode);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => fetchStatus(), 1500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------- 开始 / 停止
function widgetNumber(node, name, fallback) {
  const w = resolveWidget(node, name);
  const v = Number(w && w.value);
  return Number.isFinite(v) ? v : fallback;
}

async function startBatch(node) {
  STATUS.error = "";
  try {
    let graph = null;
    if (app && typeof app.graphToPrompt === "function") graph = await app.graphToPrompt();
    const prompt = (graph && (graph.output || graph.prompt)) || null;   // graphToPrompt() = {workflow, output}
    if (!prompt) throw new Error("取不到当前工作流（ComfyUI 版本太老？）");
    const body = {
      prompt: prompt,
      clientId: (api && api.clientId) || null,
      rest: widgetNumber(node, W_REST, 60),
      max: widgetNumber(node, W_MAX, 4),
      randomSeed: !!(resolveWidget(node, W_SEED) || {}).value,
    };
    const r = await fetch(`${API_ROOT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.success) throw new Error((j && j.error) || ("HTTP " + r.status));
    applyStatus(j);
    STATUS.backend = "ok";
    log(`开始排队：本轮最多 ${body.max} 张，每张之间休息 ${body.rest} 秒`);
  } catch (e) {
    STATUS.error = String(e.message || e);
    STATUS.stage = "error";
    log("开始排队失败：", e);
  }
  redrawNode(node);
}

async function stopBatch(node) {
  try {
    const r = await fetch(`${API_ROOT}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json().catch(() => null);
    if (j && j.success) applyStatus(j);
    log("已请求停止");
  } catch (e) {
    log("停止失败：", e);
  }
  redrawNode(node);
}

// 🗑 清除进程：把这一轮收掉 + 清空工具推来的那几段，回到"等工具再推一次"
// （他 2026-10-02 要的：「暂停或者还没开始的时候，点击这个可以清除当前进程，等待工具再次同步」）
// 正在出图时后端会拒绝并给一句话，照旧写到节点上，不弹窗。
async function clearBatch(node) {
  try {
    const r = await fetch(`${API_ROOT}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const j = await r.json().catch(() => null);
    if (j && j.success) {
      applyStatus(j);
      log("已清除这一轮 —— 等工具再把这一套推过来");
    } else {
      STATUS.error = String((j && j.error) || ("HTTP " + r.status));
      STATUS.stage = "error";
      log("清除失败：", j && j.error);
    }
  } catch (e) {
    log("清除失败：", e);
  }
  redrawNode(node);
}

// ⏸ 暂停 / ▶ 继续：显式把"我想要的状态"发过去（不靠本地取反，两边就不会各说各话）
async function pauseBatch(node) {
  const want = !STATUS.paused;
  try {
    const r = await fetch(`${API_ROOT}/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: want }),
    });
    const j = await r.json().catch(() => null);
    if (j && j.success) {
      applyStatus(j);
      log(want ? "已请求暂停（这一张出完就停）" : "已继续");
    } else {
      // 没在排的时候按暂停：后端会给一句话，写到节点上，不弹窗
      STATUS.error = String((j && j.error) || ("HTTP " + r.status));
      STATUS.stage = "error";
      log("暂停/继续失败：", j && j.error);
    }
  } catch (e) {
    log("暂停/继续失败：", e);
  }
  redrawNode(node);
}

// 按钮文字 = 现在能做的事（跟着后端状态走）
function updatePauseButton() {
  const w = pollNode && pollNode.__pcPauseBtn;
  if (!w) return;
  const text = STATUS.paused ? BTN_RESUME : BTN_PAUSE;
  if (w.name === text) return;
  // 三处一起改，哪一代前端都吃得上：name（老 litegraph / 现在这颗就是照 name 画的）、
  // label（有的版本读它）、options.label（1.45 的 BaseWidget 里 `get label()` 优先取这个）。
  // ⚠️ label 在某些版本里是**只读 getter**，直接赋值会抛 TypeError —— 必须包在 try 里。
  try { w.name = text; } catch (e) { /* 忽略 */ }
  try { w.label = text; } catch (e) { /* 忽略 */ }
  try { if (w.options && typeof w.options === "object") w.options.label = text; } catch (e) { /* 忽略 */ }
  if (pollNode) redrawNode(pollNode);
}

function clipText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 2 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

// 灰字提示行：一个"只画字、不是输入"的假控件（和「游动羽翼工具栏」那几行说明同一个做法）。
// 控件是按数组顺序一行一行排的，想让字落在**所有控件上面**就得让它当第一行；
// 标 serialize:false 就不会进 widgets_values（configure() 里 `if (widget.serialize === false) continue`）。
function makeHintRow(text) {
  return {
    type: "pcText",
    name: text,                 // 名字就用这句话本身：好认，也方便自测断言
    value: null,
    y: 0, height: 20, last_y: 0,
    serialize: false,
    options: { serialize: false },
    hidden: false,
    computeSize: function (w) { return [w || 200, 20]; },
    onClick: function () {},
    draw: function (ctx, node, width, y, H) {
      ctx.save();
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = HINT_COLOR;
      ctx.fillText(clipText(ctx, text, (width || 200) - 26), 15, y + H * 0.55);
      ctx.restore();
    },
  };
}

// 把一行控件插到最上面（真前端走 addCustomWidget，假的/老前端直接塞数组）
function addTopWidget(node, w) {
  if (typeof node.addCustomWidget === "function") node.addCustomWidget(w);
  else if (Array.isArray(node.widgets)) node.widgets.push(w);
  const ws = node.widgets;
  if (Array.isArray(ws)) {
    const at = ws.indexOf(w);
    if (at > 0) { ws.splice(at, 1); ws.unshift(w); }
  }
}

function attachButtons(node) {
  try {
    if (typeof node.addWidget !== "function") return;
    // 四颗按钮按「开始 / 暂停 / 停止 / 清除」排；灰字提示插到最上面（在所有控件之前）
    node.addWidget("button", "▶ 开始排队", null, () => { startBatch(node); }, { serialize: false });
    node.addWidget("button", BTN_PAUSE, null, () => { pauseBatch(node); }, { serialize: false });
    node.__pcPauseBtn = node.widgets[node.widgets.length - 1];
    node.addWidget("button", "⏹ 停止", null, () => { stopBatch(node); }, { serialize: false });
    node.addWidget("button", BTN_CLEAR, null, () => { clearBatch(node); }, { serialize: false });
    addTopWidget(node, makeHintRow(HINT_TEXT));
    updatePauseButton();
  } catch (e) {
    log("按钮注入失败", e);
  }
}

function setupBatchNode(nodeType) {
  const onCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = onCreated ? onCreated.apply(this, arguments) : undefined;
    pollNode = this;                    // 先认下这个节点，按钮文字才好跟着状态改
    attachButtons(this);
    fetchStatus(this);
    redrawNode(this);
    return r;
  };

  const onRemoved = nodeType.prototype.onRemoved;
  nodeType.prototype.onRemoved = function () {
    stopPolling();
    if (pollNode === this) pollNode = null;
    const r = onRemoved ? onRemoved.apply(this, arguments) : undefined;
    return r;
  };

  const computeSize = nodeType.prototype.computeSize;
  nodeType.prototype.computeSize = function (out) {
    const s = (computeSize ? computeSize.apply(this, arguments) : null) || out || [300, 120];
    if (s && typeof s[1] === "number") s[1] += STATUS_H;
    if (s && typeof s[0] === "number") s[0] = Math.max(s[0], 360);
    return s;
  };

  const onDraw = nodeType.prototype.onDrawForeground;
  nodeType.prototype.onDrawForeground = function (ctx) {
    const r = onDraw ? onDraw.apply(this, arguments) : undefined;
    if (!ctx || (this.flags && this.flags.collapsed)) return r;
    try {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const w = (this.size ? this.size[0] : 360);
      const h = (this.size ? this.size[1] : 160);
      const maxW = w - 18;
      ctx.font = "11px sans-serif";
      ctx.fillStyle = "rgba(158, 170, 190, 0.95)";
      ctx.fillText(clipText(ctx, countText(), maxW), w / 2, h - STATUS_H + 11);
      const bad = STATUS.stage === "error" || STATUS.backend === "missing";
      const paused = STATUS.paused || STATUS.stage === "paused";
      ctx.fillStyle = bad ? "rgba(255, 186, 96, 0.98)"
        : (paused ? "rgba(255, 214, 130, 0.98)"
          : (STATUS.running ? "rgba(160, 230, 180, 0.98)" : "rgba(150, 162, 180, 0.8)"));
      ctx.fillText(clipText(ctx, stageText(), maxW), w / 2, h - STATUS_H + 29);
      ctx.restore();
    } catch (e) { /* 画不出来不影响节点 */ }
    return r;
  };
}

app.registerExtension({
  name: "PromptSync.BatchQueue",

  async setup() {
    if (api && typeof api.addEventListener === "function") {
      api.addEventListener(EVENT_NAME, (e) => {
        try { applyStatus(e && e.detail ? e.detail : {}); } catch (err) { /* 忽略 */ }
      });
    }
    window.__pcBatch = {
      status: () => Object.assign({}, STATUS),
      stageText,
      countText,
      fetch: (node) => fetchStatus(node || pollNode),
      start: (node) => startBatch(node || pollNode),
      pause: (node) => pauseBatch(node || pollNode),
      stop: (node) => stopBatch(node || pollNode),
      clear: (node) => clearBatch(node || pollNode),
      setStatus: (st) => applyStatus(st),
      pauseLabel: () => (pollNode && pollNode.__pcPauseBtn ? pollNode.__pcPauseBtn.name : ""),
    };
    log("已就绪");
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    setupBatchNode(nodeType);
  },

  nodeCreated(node) {
    if (node && (node.type === NODE_NAME || node.comfyClass === NODE_NAME)) {
      pollNode = node;
      fetchStatus(node);
    }
  },
});
