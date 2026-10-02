// 提示词工具 ↔ ComfyUI 互通节点的前端扩展
// 职责：监听后端推来的 prompt_sync.update 事件，把正/负提示词写进本节点的两个文本框。
// 顺手还管三件事（都在下面）：① 「从工具同步一次」按钮；② 节点顶上一行灰字提示；
// ③ 「空Latent（自填宽高像素）」的比例矩形预览 + 「⇄ 对调横竖」。
import { app } from "../../scripts/app.js";
import * as apiMod from "../../scripts/api.js";

const NODE_NAME = "PromptSyncFromTool";
const EVENT_NAME = "prompt_sync.update";
const API_ROOT = "/prompt_sync";
// 节点顶上那行灰字（他 2026-10-02 要的）：提醒把 CLIP 文本编码节点里的文本清空，
// 不然它自己那份老文本会和这里推过去的提示词打架、看不出到底用了哪个。
const HINT_TEXT = "需要把 CLIP 文本编码节点的文本置空";
const HINT_COLOR = "rgba(150, 162, 180, 0.95)";

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
    // 灰字提示放最上面（控件是按数组顺序排的，想让字落在两个文本框之前就得当第一行）
    addTopWidget(node, makeHintRow(HINT_TEXT));
    log("已给节点加上「从工具同步一次」按钮 + 一行灰字提示");
  } catch (e) {
    log("手动同步按钮注入失败（不影响自动同步）", e);
  }
}

// ---------------------------------------------------------------- 一行灰字 / 插到最上面
function clipText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 2 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

// 排版行：一个"只画字、不是输入"的假控件（和「游动羽翼工具栏」「套图排队」那几行说明同一个做法），
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

// ==================== 空Latent（自填宽高像素）：画一个比例矩形 + 一键对调朝向 ====================
const LATENT_NODE = "PromptToolEmptyLatent";
const LATENT_W_LONG = "长边像素";
const LATENT_W_SHORT = "短边像素";
const LATENT_W_HORIZ = "横边为长边还是短边";
const LATENT_W_VERT = "竖边为长边还是短边";
const PREVIEW_H = 86;                       // 节点底部留给预览的高度（用 computeSize 预留下来，不压到控件）

// 按当前五个控件的值算出真正的宽高（和 nodes.py 的算法一致：像素向下取整到 8 的倍数）
function latentGeom(node) {
  const lw = resolveWidget(node, LATENT_W_LONG);
  const sw = resolveWidget(node, LATENT_W_SHORT);
  const hz = resolveWidget(node, LATENT_W_HORIZ);
  const vt = resolveWidget(node, LATENT_W_VERT);
  const longVal = Math.max(8, Math.floor((Number(lw && lw.value) || 1152) / 8) * 8);
  const shortVal = Math.max(8, Math.floor((Number(sw && sw.value) || 896) / 8) * 8);
  const h = (hz && hz.value) || "长边";
  const v = (vt && vt.value) || "短边";
  const w = h === "长边" ? longVal : shortVal;
  const hh = v === "长边" ? longVal : shortVal;
  return { w, h: hh, kind: w === hh ? "正方形" : (w > hh ? "横置" : "竖放") };
}

// 值改了要让画布重画，不然矩形还是旧的
function watchLatentWidgets(node) {
  [LATENT_W_LONG, LATENT_W_SHORT, LATENT_W_HORIZ, LATENT_W_VERT].forEach((name) => {
    const w = resolveWidget(node, name);
    if (!w) return;
    const cb = w.callback;
    w.callback = function () {
      const r = cb ? cb.apply(this, arguments) : undefined;
      refreshCanvas(node);
      return r;
    };
  });
}

// 对调朝向：把「横边…」「竖边…」两个选择交换（像素数不动），横图⇄竖图
function swapLatentOrientation(node) {
  const a = resolveWidget(node, LATENT_W_HORIZ);
  const b = resolveWidget(node, LATENT_W_VERT);
  if (!a || !b) return;
  const t = a.value; a.value = b.value; b.value = t;
  [a, b].forEach((w) => {
    try { if (typeof w.callback === "function") w.callback(w.value); } catch (e) { /* 忽略 */ }
    try {
      if (w.inputEl && "value" in w.inputEl) w.inputEl.value = w.value;
      const el = w.element;
      if (el && typeof el.querySelector === "function") {
        const sel = el.querySelector("select");
        if (sel) sel.value = w.value;
      }
    } catch (e) { /* 忽略 */ }
  });
  refreshCanvas(node);
  const g = latentGeom(node);
  log(`已对调：现在 ${g.kind} ${g.w}×${g.h}`);
}

function attachLatentButton(node) {
  try {
    if (typeof node.addWidget !== "function") return;
    node.addWidget("button", "⇄ 对调横竖", null, () => { swapLatentOrientation(node); }, { serialize: false });
  } catch (e) {
    log("「对调横竖」按钮注入失败（不影响节点的计算）", e);
  }
}

function setupLatentNode(nodeType) {
  const onCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = onCreated ? onCreated.apply(this, arguments) : undefined;
    attachLatentButton(this);
    watchLatentWidgets(this);
    refreshCanvas(this);
    return r;
  };
  // 给底部那一块预留高度（不然矩形会压在控件上）
  const computeSize = nodeType.prototype.computeSize;
  nodeType.prototype.computeSize = function (out) {
    const s = (computeSize ? computeSize.apply(this, arguments) : null) || out || [220, 100];
    if (s && typeof s[1] === "number") s[1] += PREVIEW_H;
    return s;
  };
  // 在预留的那块里画等比矩形：长边着地=横置、短边着地=竖放、两边一样=正方形
  const onDraw = nodeType.prototype.onDrawForeground;
  nodeType.prototype.onDrawForeground = function (ctx) {
    const r = onDraw ? onDraw.apply(this, arguments) : undefined;
    if (!ctx || (this.flags && this.flags.collapsed)) return r;
    try {
      const g = latentGeom(this);
      const boxW = Math.max(40, Math.min(140, (this.size ? this.size[0] : 220) - 28));
      const boxH = 54;
      const top = (this.size ? this.size[1] : 200) - PREVIEW_H + 6;
      const k = Math.min(boxW / g.w, boxH / g.h);          // 等比缩放到能放进盒子
      const rw = Math.max(6, g.w * k), rh = Math.max(6, g.h * k);
      const cx = (this.size ? this.size[0] : 220) / 2;
      const rx = cx - rw / 2, ry = top + (boxH - rh) / 2;

      ctx.save();
      ctx.fillStyle = "rgba(120, 170, 255, 0.35)";
      ctx.strokeStyle = "rgba(140, 190, 255, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#dbe6ff";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${g.kind} ${g.w} × ${g.h}`, cx, top + boxH + 12);
      ctx.restore();
    } catch (e) { /* 画不出来不影响节点本身 */ }
    return r;
  };
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
    if (!nodeData || !nodeData.name) return;
    if (nodeData.name === LATENT_NODE) { setupLatentNode(nodeType); return; }
    if (nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      attachManualSync(this);
      return r;
    };
  },
});
