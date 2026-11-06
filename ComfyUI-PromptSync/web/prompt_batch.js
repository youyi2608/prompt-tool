// 套图排队节点（PromptToolBatchQueue）的前端
//
// 三件事：
//   ① 四颗按钮：「▶ 开始排队」把**当前工作流**的 API 图连同设置发给节点后端，由它一张一张排；
//      「⏸ 暂停」/「▶ 继续」把排队键住（正在出的那一张会先出完，见下）；
//      「⏹ 停止」立刻停（不排下一张 + 收掉还没开始的 + 打断正在跑的那张）；
//      「🗑 清除进程」把这一轮收掉 + 清空工具推来的那几段，回到"等工具再推一次"
//      （他 2026-10-02 要的：暂停或还没开始的时候用它；正在出图时后端会拒绝并说明）。
//      + 「⚙ LoRA 方案（高级选项）」（2026-10-05 批 C2）：把当前画面的所有 LoRA 存成方案、每张各挑一个。
//   ② 节点身上写清楚现在的状态：已收到几段 / 本轮的进度 / 正在休息还剩几秒 / 暂停了没有 / 这张用哪个方案。
//   ③ 顶上一条灰字提示：它得和「提示词同步」节点一起用（提示词是那个节点送出去的）。
//
// ⚠️ **计时 / 提醒不在这颗节点上**（他 2026-10-05 纠正：「计时是单独的节点，不应该是套图排队上的节点」）
//    —— 圆环 / ✔ 这张有效 / 计时设置 / 音效 / 水波都在「计时器（休息计时 + 生图效率）」，见 web/prompt_timer.js。
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
const STATUS_H = 46;                 // 底部预留：两行状态字
const MAX_SCHEMES = 4;               // 最多存几个 LoRA 方案（和 routes.py 的 BATCH_MAX_SCHEMES 对齐）
const HINT_TEXT = "需要和「提示词同步」节点一起使用";
const HINT_COLOR = "rgba(150, 162, 180, 0.95)";
const BTN_PAUSE = "⏸ 暂停排队";
const BTN_RESUME = "▶ 继续排队";
const BTN_CLEAR = "🗑 清除进程";
const BTN_LORA = "⚙ LoRA 方案（高级选项）";

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
// status = 节点后端那份：{segments(段数), running, paused, stage, index, planned, done, rest_left, error, note, scheme}
// notes  = 每段的备注（前端那张"第几张用哪个方案"的表拿它认人；批 C2）
// hint 是**前端自己的**中性提示（不是故障，比如"工具还没把这一套推过来"）—— 他 2026-10-03 提的：
// 很多人先点「▶ 开始排队」再看工具推没推，原来会红字写「出错：…」，看着像坏了。
const STATUS = { segments: -1, running: false, paused: false, stage: "idle", index: 0, planned: 0,
  done: 0, rest_left: 0, error: "", note: "", hint: "", backend: "unknown", scheme: "", notes: [] };
let pollTimer = null;
let pollNode = null;

function stageText() {
  if (STATUS.backend === "missing") return "节点后端没有套图接口（节点是旧版 —— 重启一次 ComfyUI）";
  if (STATUS.error) return "出错：" + STATUS.error;
  // 中性提示（不是故障）：比如还没点「🎞 套图」把这一套推过来
  if (STATUS.hint) return STATUS.hint;
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
  if (STATUS.scheme) parts.push(`方案「${STATUS.scheme}」`);     // 这张正在用哪个 LoRA 方案（批 C2）
  return parts.join(" · ");
}

function applyStatus(st) {
  if (!st || typeof st !== "object") return;
  if (typeof st.segments === "number") STATUS.segments = st.segments;
  else if (Array.isArray(st.segments)) {
    STATUS.segments = st.segments.length;
    STATUS.notes = st.segments.map((s) => String((s && s.note) || ""));     // 段的备注：方案表用
  }
  if (Array.isArray(st.segment_notes)) STATUS.notes = st.segment_notes.map((s) => String(s || ""));
  ["running", "paused", "stage", "index", "planned", "done", "rest_left", "error", "note", "scheme"].forEach((k) => {
    if (k in st) STATUS[k] = st[k];
  });
  if (st.success === true || st.stage) STATUS.backend = "ok";
  if (st.running === true) STATUS.hint = "";      // 真的排起来了 → 那条中性提示收掉
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

// ---------------------------------------------------------------- 节点属性（跟着工作流存）
// LoRA 方案（方案表 + "第几张用哪个"）塞 node.properties.pcLora（工作流 JSON 里的 properties
// 是自由字典，会跟着存）。⚠️ 别塞 widgets_values —— 那是"控件值的数组"，塞自定义结构会被打乱。
// ⚠️ 计时 / 有效图那套**不在这个节点上**（他 2026-10-05：「计时是单独的节点，不应该是套图排队上的节点」）
//    → 全在「计时器（休息计时 + 生图效率）」那颗节点上，见 web/prompt_timer.js。
function nodeProps(node) {
  if (!node.properties || typeof node.properties !== "object") node.properties = {};
  return node.properties;
}

function loraCfg(node) {
  const p = nodeProps(node);
  let c = p.pcLora;
  if (!c || typeof c !== "object") c = p.pcLora = {};
  if (!Array.isArray(c.schemes)) c.schemes = [];
  if (!Array.isArray(c.assign)) c.assign = [];
  return c;
}

// ---------------------------------------------------------------- 开始 / 停止
function widgetNumber(node, name, fallback) {
  const w = resolveWidget(node, name);
  const v = Number(w && w.value);
  return Number.isFinite(v) ? v : fallback;
}

async function startBatch(node) {
  STATUS.error = "";
  STATUS.hint = "";                                  // 每次点开始都先清掉上一次的中性提示
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
      // LoRA 方案 + "第几张用哪个方案"（批 C2；没存方案时是空数组，后端就当"一张都不换"）
      schemes: loraCfg(node).schemes,
      assign: loraCfg(node).assign,
    };
    const r = await fetch(`${API_ROOT}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.success) {
      const err = new Error((j && j.error) || ("HTTP " + r.status));
      err.pcCode = (j && j.code) || "";      // 后端给的机器可读代号（no-segments = 工具还没推过来）
      throw err;
    }
    applyStatus(j);
    STATUS.backend = "ok";
    log(`开始排队：本轮最多 ${body.max} 张，每张之间休息 ${body.rest} 秒`
      + (body.schemes.length ? `，带了 ${body.schemes.length} 个 LoRA 方案` : ""));
  } catch (e) {
    const msg = String((e && e.message) || e);
    const notReady = (e && e.pcCode === "no-segments") || /还没有收到任何一段/.test(msg);
    if (notReady) {
      // 「还没收到提示词」不是故障，是"还没推过来"—— 用中性提示，别写"出错"吓人
      STATUS.hint = msg;
      STATUS.error = "";
      STATUS.stage = "idle";
      log("还没收到提示词：", msg);
    } else {
      STATUS.error = msg;
      STATUS.stage = "error";
      log("开始排队失败：", e);
    }
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
// 三处一起改，哪一代前端都吃得上：name（老 litegraph / 现在这颗就是照 name 画的）、
// label（有的版本读它）、options.label（1.45 的 BaseWidget 里 `get label()` 优先取这个）。
// ⚠️ label 在某些版本里是**只读 getter**，直接赋值会抛 TypeError —— 必须包在 try 里。
function setWidgetText(w, text) {
  if (!w || w.name === text) return false;
  try { w.name = text; } catch (e) { /* 忽略 */ }
  try { w.label = text; } catch (e) { /* 忽略 */ }
  try { if (w.options && typeof w.options === "object") w.options.label = text; } catch (e) { /* 忽略 */ }
  return true;
}

function updatePauseButton() {
  const w = pollNode && pollNode.__pcPauseBtn;
  if (!w) return;
  const text = STATUS.paused ? BTN_RESUME : BTN_PAUSE;
  if (setWidgetText(w, text) && pollNode) redrawNode(pollNode);
}

// ---------------------------------------------------------------- 面板（批 C2 的 LoRA 方案）
const PANEL_CSS = `
.pcb-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9000;display:flex;align-items:center;justify-content:center;}
.pcb-card{width:380px;max-width:92vw;max-height:76vh;overflow-x:hidden;overflow-y:auto;background:#232326;color:#e6ecf5;
  border:1px solid #3a3f47;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);
  font:13px/1.65 "Microsoft YaHei",system-ui,sans-serif;padding:13px 15px 15px;}
.pcb-card h3{margin:0 0 6px;font-size:15px;font-weight:600;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:10px;}
.pcb-x{cursor:pointer;color:#9aa4b2;font-size:15px;padding:0 4px;border:0;background:none;}
.pcb-x:hover{color:#ff7b7b;}
.pcb-tip{color:#98a2b3;font-size:11.5px;margin:3px 0 9px;}
.pcb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;}
.pcb-row>label{color:#c8d2e0;flex:0 0 auto;}
.pcb-card input[type=number]{width:66px;background:#161719;color:#fff;border:1px solid #3a3f47;border-radius:6px;padding:3px 6px;font-size:13px;}
.pcb-card select{flex:1 1 auto;min-width:0;background:#161719;color:#fff;border:1px solid #3a3f47;border-radius:6px;padding:3px 6px;font-size:12.5px;}
.pcb-btn{cursor:pointer;background:#2f343b;color:#e6ecf5;border:1px solid #454c56;border-radius:7px;padding:4px 9px;font-size:12.5px;}
.pcb-btn:hover{background:#3a4149;border-color:#5a636f;}
.pcb-btn.pri{background:#2b5f8a;border-color:#3d7fb4;}
.pcb-btn.pri:hover{background:#336f9f;}
.pcb-btn[disabled]{opacity:.5;cursor:default;}
.pcb-item{border:1px solid #3a3f47;border-radius:9px;padding:7px 9px;margin:7px 0;background:#1e2023;}
.pcb-item .t{color:#fff;font-weight:600;margin-bottom:2px;}
.pcb-item .s{color:#98a2b3;font-size:11.5px;word-break:break-all;margin-bottom:5px;}
.pcb-sel{display:flex;gap:8px;align-items:center;margin:6px 0;}
.pcb-sel .n{color:#c8d2e0;flex:0 0 auto;}
.pcb-note{color:#8b95a3;font-size:11px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pcb-err{color:#ffb060;font-size:12px;min-height:16px;margin-top:6px;}
`;

function injectPanelCss() {
  if (document.getElementById("pcb-style")) return;
  const s = document.createElement("style");
  s.id = "pcb-style";
  s.textContent = PANEL_CSS;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

// 一张会浮在页面中间的小卡片：✕ / 点背景 / Esc 都能关
function makeCard(title) {
  injectPanelCss();
  const back = el("div", "pcb-back");
  const card = el("div", "pcb-card");
  const head = el("h3");
  head.appendChild(el("span", null, title));
  const x = el("button", "pcb-x", "✕");
  head.appendChild(x);
  card.appendChild(head);
  back.appendChild(card);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    try { back.remove(); } catch (e) { /* 忽略 */ }
    document.removeEventListener("keydown", onKey);
    if (typeof card.__pcOnClose === "function") card.__pcOnClose();
  }
  x.onclick = close;
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(back);
  return { back: back, card: card, close: close };
}

// ---------------------------------------------------------------- ⚙ LoRA 方案（批 C2）
// 他 2026-10-05 要的（他自己说"属于高级选项"）：把**当前画面里的所有 LoRA**存成一个方案，
// 最多 4 个、**存了不能改**（要改就删掉重新存），然后每一张图各自点一个方案。
function captureLoras() {
  const g = app && app.graph;
  const nodes = (g && (g._nodes || g.nodes)) || [];
  const out = [];
  for (const n of nodes) {
    if (!n || !Array.isArray(n.widgets)) continue;
    const w = n.widgets.find((x) => x && x.name === "lora_name");
    if (!w) continue;
    const item = {
      id: String(n.id),
      type: String(n.comfyClass || n.type || ""),
      title: String(n.title || ""),
      lora_name: String(w.value == null ? "" : w.value),
    };
    const sm = n.widgets.find((x) => x && x.name === "strength_model");
    if (sm && typeof sm.value === "number") item.strength_model = sm.value;
    const sc = n.widgets.find((x) => x && x.name === "strength_clip");
    if (sc && typeof sc.value === "number") item.strength_clip = sc.value;
    out.push(item);
  }
  return out;
}

function loraLabel(item) {
  const name = String((item && item.lora_name) || "").split(/[\\/]/).pop() || "(没选文件)";
  const sm = (item && typeof item.strength_model === "number") ? item.strength_model : "-";
  const sc = (item && typeof item.strength_clip === "number") ? item.strength_clip : "-";
  return name + "（" + sm + "/" + sc + "）";
}

function saveScheme(node) {
  const cfg = loraCfg(node);
  if (cfg.schemes.length >= MAX_SCHEMES) {
    return { ok: false, err: "最多存 " + MAX_SCHEMES + " 个方案 —— 要换就先把旧的删掉" };
  }
  const loras = captureLoras();
  if (!loras.length) {
    return { ok: false, err: "当前画面上一个 LoRA 节点都没找到 —— 先把它放到画布上再来存" };
  }
  cfg.seq = Math.max(Number(cfg.seq) || 0, cfg.schemes.length) + 1;
  cfg.schemes.push({ name: "方案" + cfg.seq, loras: loras });
  return { ok: true, count: loras.length };
}

function dropScheme(node, index) {
  const cfg = loraCfg(node);
  if (!(index >= 0 && index < cfg.schemes.length)) return false;
  cfg.schemes.splice(index, 1);
  // 删掉中间那个之后，"第几张用哪个"要跟着挪，不然会指到别的方案上
  cfg.assign = cfg.assign.map((v) => {
    if (v === index) return -1;
    return (typeof v === "number" && v > index) ? v - 1 : v;
  });
  return true;
}

function assignOf(cfg, i) {
  const v = cfg.assign[i];
  return (typeof v === "number" && v >= -1 && v < cfg.schemes.length) ? Math.round(v) : -1;
}

function setAssign(node, i, v) {
  const cfg = loraCfg(node);
  while (cfg.assign.length <= i) cfg.assign.push(-1);
  cfg.assign[i] = Math.round(Number(v));
  if (!(cfg.assign[i] >= 0 && cfg.assign[i] < cfg.schemes.length)) cfg.assign[i] = -1;
}

// 这一轮会排几张（段数 + 节点上的「一次最多几张」），方案表就画几行
function plannedRows(node) {
  const segs = STATUS.segments > 0 ? STATUS.segments : 0;
  const cap = Math.max(1, Math.round(widgetNumber(node, W_MAX, 4)));
  return Math.min(segs, cap);
}

function renderLoraPanel(node, ui) {
  const cfg = loraCfg(node);
  while (ui.card.children.length > 1) ui.card.removeChild(ui.card.lastChild);   // 只留标题行
  const err = el("div", "pcb-err");
  ui.err = err;
  ui.card.appendChild(el("div", "pcb-tip",
    "方案里存的是「当前画面中的所有 LoRA」（文件名 + 模型强度 / CLIP 强度）。最多 " + MAX_SCHEMES
    + " 个；存好之后不能改 —— 要改就把旧的删掉重新存。"));

  const row = el("div", "pcb-row");
  const add = el("button", "pcb-btn pri", "➕ 把当前画面的 LoRA 存成方案");
  add.onclick = () => {
    const r = saveScheme(node);
    if (!r.ok) { err.textContent = r.err; return; }
    renderLoraPanel(node, ui);
    ui.err.textContent = "已存 1 个方案（含 " + r.count + " 个 LoRA）";
  };
  if (cfg.schemes.length >= MAX_SCHEMES) add.disabled = true;
  row.appendChild(add);
  const peek = el("button", "pcb-btn", "👁 看看画面上有哪些 LoRA");
  peek.onclick = () => {
    const loras = captureLoras();
    err.textContent = loras.length ? ("画面上现在有：" + loras.map(loraLabel).join("、")) : "画面上现在一个 LoRA 节点都没有";
  };
  row.appendChild(peek);
  ui.card.appendChild(row);

  if (!cfg.schemes.length) {
    ui.card.appendChild(el("div", "pcb-tip", "还没有方案（点上面那颗键存一个）。"));
  }
  cfg.schemes.forEach((s, i) => {
    const item = el("div", "pcb-item");
    item.appendChild(el("div", "t", (i + 1) + ". " + s.name));
    item.appendChild(el("div", "s", s.loras.map(loraLabel).join("、")));
    const del = el("button", "pcb-btn", "🗑 删掉这个方案");
    del.onclick = () => { dropScheme(node, i); renderLoraPanel(node, ui); };
    item.appendChild(del);
    ui.card.appendChild(item);
  });

  ui.card.appendChild(el("div", "pcb-tip",
    "下面这一轮要排的每一张，各自点一个方案（不点 = 不换 LoRA，就用画布上现在这份）："));
  const rows = plannedRows(node);
  if (!rows) {
    ui.card.appendChild(el("div", "pcb-tip",
      "等工具把「🎞 套图」推过来之后再来选每张的方案。"));
  }
  for (let i = 0; i < rows; i++) {
    const line = el("div", "pcb-sel");
    line.appendChild(el("span", "n", "第 " + (i + 1) + " 张"));
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = "-1";
    none.textContent = "不换 LoRA";
    sel.appendChild(none);
    cfg.schemes.forEach((s, k) => {
      const o = document.createElement("option");
      o.value = String(k);
      o.textContent = (k + 1) + ". " + s.name;
      sel.appendChild(o);
    });
    sel.value = String(assignOf(cfg, i));
    sel.onchange = () => { setAssign(node, i, sel.value); STATUS.shown = ""; redrawNode(node); };
    line.appendChild(sel);
    const note = STATUS.notes[i];
    if (note) line.appendChild(el("span", "pcb-note", note));
    ui.card.appendChild(line);
  }
  ui.card.appendChild(err);
}

function openLoraPanel(node) {
  const ui = makeCard("⚙ LoRA 方案（高级选项）");
  renderLoraPanel(node, ui);
  return ui;
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
    // 批 C2：LoRA 方案（高级选项）。⚠️ 计时 / 提醒不在这颗节点上，见「计时器（休息计时 + 生图效率）」。
    node.addWidget("button", BTN_LORA, null, () => { openLoraPanel(node); }, { serialize: false });
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
      drawStatusText(this, ctx);      // 底部两行字
    } catch (e) { /* 画不出来不影响节点 */ }
    return r;
  };
}

// 底部两行字（计数行 + 状态行）
function drawStatusText(node, ctx) {
  const w = (node.size ? node.size[0] : 360);
  const h = (node.size ? node.size[1] : 160);
  const maxW = Math.max(40, w - 18);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
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
    // 批 C2（LoRA 方案）的调试钩子：探针和自测都走这里，不靠"点画布上的坐标"。
    // ⚠️ 计时 / 音效 / 有效图那套钩子在计时器节点那边（window.__pcTimer，见 web/prompt_timer.js）。
    window.__pcLora = {
      cfg: (node) => loraCfg(node || pollNode),
      capture: () => captureLoras(),
      save: (node) => saveScheme(node || pollNode),
      drop: (i, node) => dropScheme(node || pollNode, i),
      assign: (i, v, node) => { setAssign(node || pollNode, i, v); return loraCfg(node || pollNode).assign; },
      rows: (node) => plannedRows(node || pollNode),
      panel: (node) => { openLoraPanel(node || pollNode); return !!document.querySelector(".pcb-card"); },
      close: () => { const b = document.querySelector(".pcb-back"); if (b) b.remove(); },
    };
    log("已就绪");
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
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
