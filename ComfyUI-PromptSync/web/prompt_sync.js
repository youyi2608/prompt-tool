// 提示词工具 ↔ ComfyUI 互通节点的前端扩展
// 职责：监听后端推来的 prompt_sync.update 事件，把正/负提示词写进本节点的两个文本框。
// 顺手还管三件事（都在下面）：① 「从工具同步一次」按钮；② 节点顶上两行灰字提示；
// ③ 「空Latent（自填宽高像素）」的比例矩形预览 + 「⇄ 对调横竖」。
import { app } from "../../scripts/app.js";
import * as apiMod from "../../scripts/api.js";

const NODE_NAME = "PromptSyncFromTool";
const EVENT_NAME = "prompt_sync.update";
const API_ROOT = "/prompt_sync";
// 节点顶上那两行灰字：
// ① 他 2026-10-02 要的：提醒把 CLIP 文本编码节点里的文本清空，
//    不然它自己那份老文本会和这里推过去的提示词打架、看不出到底用了哪个。
// ② 他 2026-10-03 第八十七批要的：有用户说"连接模式下连点几个按钮，出的图只剩最后一个词" ——
//    原因是连接模式下**点单个按钮只送这一个词**，要一次全送得先在工具里进购物车、再点「复制全部」。
const HINT_TEXT = "需要把 CLIP 文本编码节点的文本置空";
// ★ 2026-10-07（第一百一十一批）他第 3 条原话：「提示同步节点中的内容和已有内容并不是相加关系，而是覆盖关系，
//   能不能想办法改成相加关系？不能或者比较麻烦的话，那就不改了」——
//   **内置 CLIP 文本编码做不到相加**（ComfyUI 前端写死的：口上有线就整个覆盖控件那份，我们改不了别人的核心），
//   所以照他下半句办：「改不了直接在提示词同步节点用小字说出来」。
const HINT_TEXT_OVERRIDE = "覆盖关系、不是相加：接了线就只用本节点这份文本（想改成相加做不到）";
// ★ 2026-10-07（第一百一十二批）他第 6 条：这行小字从优化节点**搬过来**，文案是我拟的（他说"文案你自己想"）：
//   两个输出只接一个、或者都不接都不影响出图 —— 优化节点那两个「提示词同步」口也一样（都是可不连的口）。
const HINT_TEXT_ONE = "两个输出只接一个也行、都不接也不影响出图（优化节点上那两个「提示词同步」口连不连都一样）";
// ★ 2026-10-04 他要求：两个节点各写一行小字说清"一个展开另一个收起、收起的不参与作图"
const HINT_TEXT_SIB = "本节点和「CLIP 文本编码优化节点」一个展开、另一个就收起；收起状态下的文本不参与作图（等于点了小减号），这是正常的";
const HINT_TEXT_CONN = "连接模式下点单个按钮只送这一个词；要一次全送好几个，先在工具里进购物车、再点「复制全部」";
const HINT_COLOR = "rgba(150, 162, 180, 0.95)";

const api = (apiMod && apiMod.api) || (typeof window !== "undefined" && window.comfyAPI?.api?.api) || null;

function log(...args) {
  console.log("[PromptSync]", ...args);
}

// ★ 180 批④：用户反馈「从提示词工具复制时，负提示词也跑到正提示词框里了」，但反馈是单向的、没法再追问。
//   → 不去猜，**每次同时收到正+负的时候，弹一个小提示说清"这次收到了多少字"**。
//   这样下次出现时一眼就能分：提示里负 X 字（不是 0）说明两段是分开到的、问题在线/在按钮数据；
//   负 0 字说明工具那边根本没送负词过来。
function pcToast(msg) {
  try {
    const em = app && app.extensionManager;
    if (em && em.toast && typeof em.toast.add === "function") {
      em.toast.add({ severity: "info", summary: "提示词同步", detail: msg, life: 3200 });
      return;
    }
  } catch (e) { /* 老前端没有 toast */ }
  try { log(msg); } catch (e) { /* 忽略 */ }
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
    // ★ 收起的节点不参与作图（他 2026-10-04 定的）：推来先存进 properties，展开时再写进去，
    //   不然"收起时推一次"就白推了（而且它的两个输出此刻是空的，正好让 CLIP 那边用自己的文本框）。
    if (node.flags && node.flags.collapsed) {
      try {
        node.properties = node.properties || {};
        node.properties.pcKept = { pos: pos || "", neg: neg || "", tag: SESSION_TAG };
      } catch (e) { /* 忽略 */ }
      hit++;
      continue;
    }
    let wrote = false;
    if (pos) wrote = writeWidget(node, "positive", pos) || wrote;
    if (neg) wrote = writeWidget(node, "negative", neg) || wrote;
    if (wrote) { refreshCanvas(node); flash(node, true); hit++; }
  }
  if (hit) log(`已同步「${name || "未命名"}」到 ${hit} 个节点（正 ${pos.length} 字 / 负 ${neg.length} 字）`);
  // ★ 180 批④：同时带了负词时，明说这次收到了两段各多少字（负 0 字 = 工具那边没送）
  if (hit && (pos || neg)) pcToast(`收到「${name || "未命名"}」：正 ${pos.length} 字 / 负 ${neg.length} 字（两个框分开写，互不覆盖）`);
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
    // 灰字提示放最上面（控件是按数组顺序排的，想让字落在两个文本框之前就得当第一行）。
    // addTopWidget 是 unshift，所以**后插的在上头** → 想让 CLIP 那行在最前，就得把它留到最后插。
    addTopWidget(node, makeHintRow(HINT_TEXT_CONN));
    addTopWidget(node, makeHintRow(HINT_TEXT_SIB));
    addTopWidget(node, makeHintRow(HINT_TEXT_ONE));        // 2026-10-07 第一百一十二批：从优化节点搬来的
    addTopWidget(node, makeHintRow(HINT_TEXT_OVERRIDE));   // 2026-10-07：覆盖不是相加
    addTopWidget(node, makeHintRow(HINT_TEXT));
    log("已给节点加上「从工具同步一次」按钮 + 五行灰字提示");
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

// ★ 2026-11-04（他第 2 条）：把「对调横竖 + 等比矩形 + 尺寸」这套**借**给别的节点用
//   （他只是要"搬过去看"，不是要取代空 Latent 自己的效果）→ 开两个只读/调用的口子。
function latentNodeOf() {
  try {
    const arr = (app.graph && app.graph._nodes) || [];
    for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].type === LATENT_NODE) return arr[i];
  } catch (e) { /* 忽略 */ }
  return null;
}
window.__pcLatentInfo = function () {
  try {
    const n = latentNodeOf();
    if (!n) return null;
    const g = latentGeom(n);
    return { w: g.w, h: g.h, kind: g.kind };
  } catch (e) { return null; }
};
window.__pcLatentSwap = function () {
  try {
    const n = latentNodeOf();
    if (!n) return false;
    swapLatentOrientation(n);
    return true;
  } catch (e) { return false; }
};

function attachLatentButton(node) {  try {
    if (typeof node.addWidget !== "function") return;
    node.addWidget("button", "⇄ 对调横竖", null, () => { swapLatentOrientation(node); }, { serialize: false });
  } catch (e) {
    log("「对调横竖」按钮注入失败（不影响节点的计算）", e);
  }
}

function setupLatentNode(nodeType) {
  // ★ 2026-10-08（第一百二十六批 · 他第 2 条）：高度能拖小，装不下的控件裁掉 + 右边出现滚轮。
  //   空 Latent 是**从上往下遮**（底部那块等比矩形预览必须一直露着，所以控件摞贴着它上面排，
  //   节点拖小先遮住**上面**的几个控件）→ 由 web/prompt_scroll.js 统一装（anchor:"bottom"、底部按预览留白）。
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

// ============ 标题栏那颗「−」：收起自己 + 展开配对的「CLIP 文本编码优化节点」（2026-10-04 他要求）============
// 他的原话：「提示词同步节点也加一个小减号，点击小减号之后，提示词同步节点就会收起……点了小减号收起之后，
//          CliP 节点就会展开，也就是二者一个收起，另外一个就会展开」
const SEG_NODE = "PromptToolClipSegments";
const SEG_INPUT = "提示词同步";                 // 端口名以它开头就算（新版后端叫「提示词同步（可不连）」）
const BTN_D = 13;

// ★ 2026-10-04 他定死的规矩：**收起 = 里面的文本不参与作图**（等于点了小减号）。
//   做法：收起时把 positive / negative 两个控件清空（原值留在 properties.pcKept 里），展开时原样写回。
//   这样"从头到尾最多只有一个节点的文本生效"就是真的 —— 和连不连、有没有配对都没关系。
// ★ 2026-10-05 他的第 3 条：「打开 ComfyUI 时保证里面内容是空的」——
//   每次打开页面给一个"本次会话"的标记，收起时暂存的那份文本**只在本次打开期间有效**：
//   工作流里带过来的旧暂存（上一次打开留下的）一律不写回去。这样不依赖前端"读工作流"的先后顺序。
const SESSION_TAG = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);

function keepAndBlank(node) {
  try {
    node.properties = node.properties || {};
    var old = node.properties.pcKept;
    // ⚠️ 里面那份是"上一次打开"留下的（标记不对）就当没有 —— 否则这次收起不会暂存、展开时又会把它丢掉，
    //    表现就是"收起再展开，文本没了"。
    if (!old || old.tag !== SESSION_TAG) {
      const wp = resolveWidget(node, "positive");
      const wn = resolveWidget(node, "negative");
      node.properties.pcKept = {
        pos: String((wp && wp.value) || ""),
        neg: String((wn && wn.value) || ""),
        tag: SESSION_TAG,
      };
    }
    writeWidget(node, "positive", "");
    writeWidget(node, "negative", "");
    refreshCanvas(node);
  } catch (e) { /* 忽略 */ }
}
function restoreKept(node) {
  try {
    const k = node.properties && node.properties.pcKept;
    if (!k) return;
    if (k.tag !== SESSION_TAG) {           // 上一次打开留下的暂存 → 丢掉，不写回来
      node.properties.pcKept = null;
      return;
    }
    if (k.pos) writeWidget(node, "positive", k.pos);
    if (k.neg) writeWidget(node, "negative", k.neg);
    node.properties.pcKept = null;
    refreshCanvas(node);
  } catch (e) { /* 忽略 */ }
}
function pcSetCollapsed(node, on) {
  try {
    node.flags = node.flags || {};
    node.flags.collapsed = !!on;
    if (on) keepAndBlank(node);          // 收起 → 文本清空（不参与作图）
    else restoreKept(node);              // 展开 → 原样写回
    if (on && node.size) node.__pcOpenH = node.size[1];
    if (!on && node.__pcOpenH && node.size) node.size[1] = node.__pcOpenH;
    if (typeof node.setSize === "function") node.setSize(node.size || [320, 200]);
    app.graph && app.graph.setDirtyCanvas && app.graph.setDirtyCanvas(true, true);
  } catch (e) { /* 忽略 */ }
}
function pcSegPeer(node) {                 // 我们这一侧连着的那颗 CLIP 优化节点（拿它的「提示词同步」输入口找）
  try {
    const nodes = (app.graph && app.graph._nodes) || [];
    const out = node.outputs || [];
    for (const n of nodes) {
      if (!n || (n.type !== SEG_NODE && n.comfyClass !== SEG_NODE)) continue;
      const ins = n.inputs || [];
      for (const inp of ins) {
        if (typeof inp.name !== "string" || inp.name.indexOf(SEG_INPUT) !== 0) continue;
        if (inp.link === null || inp.link === undefined) continue;
        const link = app.graph.links[inp.link];
        for (const o of out) {                        // 只要是从本节点某个输出出来的就算配对
          if (link && link.origin_id === node.id && link.origin_slot === out.slot_index) return n;
        }
        if (link && link.origin_id === node.id) return n;
      }
    }
  } catch (e) { /* 忽略 */ }
  return null;
}
// ⚠️ 2026-10-04 修掉他报的「收起之后小加号点不到 / 位置还是收起前的位置」：
//   收起后的节点宽度**不是** size[0]，前端存的是 `_collapsed_width = min(size[0], 量出来的标题宽度 + 标题高*2)`
//   （见前端 api-*.js 的 getBounding）。原来按 size[0] 算，一收起按钮就画到折叠盒外面、也点不到。
//   现在按 _collapsed_width 算，**而且画和点击都用同一个函数现算**（不再用上一帧缓存）。
function pcTitleBarWidth(node) {
  const w = node.size ? node.size[0] : 300;
  if (!(node.flags && node.flags.collapsed)) return w;
  const cw = node._collapsed_width;
  const fallback = (window.LiteGraph && window.LiteGraph.NODE_COLLAPSED_WIDTH) || 80;
  return Math.max(40, Math.min(w, (cw && cw > 20) ? cw : fallback));
}
function pcBtnRect(node) {
  const th = (window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 30;
  return { x: pcTitleBarWidth(node) - BTN_D / 2 - 6, y: -th / 2, r: BTN_D / 2 + 4 };
}
function pcDrawCollapseBtn(ctx, node) {
  try {
    const collapsed = !!(node.flags && node.flags.collapsed);
    const b = pcBtnRect(node);
    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, BTN_D / 2, 0, Math.PI * 2);
    ctx.fillStyle = collapsed ? "rgba(120,200,140,.9)" : "rgba(255,255,255,.18)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(collapsed ? "＋" : "−", b.x, b.y + 0.5);
    ctx.restore();
  } catch (e) { /* 忽略 */ }
}
function pcTogglePeer(peer, on) {
  if (!peer) return;
  if (typeof peer.__pcToggleCollapse === "function") { peer.__pcToggleCollapse(on); return; }
  if (typeof window.__pcSetCollapsed === "function") { window.__pcSetCollapsed(peer, on); return; }
  pcSetCollapsed(peer, on);
}
function setupCollapseToggle(nodeType) {
  const onDraw = nodeType.prototype.onDrawForeground;
  nodeType.prototype.onDrawForeground = function (ctx) {
    const r = onDraw ? onDraw.apply(this, arguments) : undefined;
    if (ctx) pcDrawCollapseBtn(ctx, this);
    return r;
  };
  const onDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos, canvas) {
    try {
      if (pos) {
        const b = pcBtnRect(this);                      // 现算，收起后也一样打得中
        const dx = pos[0] - b.x, dy = pos[1] - b.y;
        if (dx * dx + dy * dy <= b.r * b.r) {
          const willCollapse = !(this.flags && this.flags.collapsed);
          pcSetCollapsed(this, willCollapse);
          const peer = pcSegPeer(this);
          if (peer) pcTogglePeer(peer, !willCollapse);  // 一个收起来、另一个就展开
          // ★ 2026-10-05 第九十九批他要的"对调工位"：两个节点互换位置 + 各取对方的大小
          if (peer && typeof window.__pcSwapSlots === "function") window.__pcSwapSlots(this, peer);
          return true;
        }
      }
    } catch (err) { /* 忽略 */ }
    const r = onDown ? onDown.apply(this, arguments) : undefined;
    return r;
  };
}

// ==================== 「重开 / 刷新后文本错乱」的真修 + 要不要清空的开关（第一百四十九批）====================
// ★ 他 2026-10-12 原话：「**不要躲开这个 bug**，修除每次重新打开 ComfyUI，里面的文本会错乱
//   （具体表现类似于正提示词会放在负提示词框，或者文本本身所在的位置会发生差别）的问题」。
//   真因**不在我们的写入逻辑**，在「前端存和读不对称」（从真前端 api-BqIxvqZ8.js 的 LGraphNode 里扒出来的）：
//     · **存**：`for (let [n, r] of widgets.entries()) if (r.serialize !== false) out.widgets_values[n] = r.value`
//              —— **按控件下标写**；被跳过的（灰字行 / 按钮，serialize:false）**留成空洞**，JSON 里变 null；
//     · **读**：`let t = 0; for (n of widgets) if (n.serialize !== false) n.value = widgets_values[t++]`
//              —— **从 0 顺次读**，完全不管空洞。
//   → 灰字行插在文本框**前面**（我们就是插在最上面）时，两个真值被推到数组后面 →
//     读的时候拿到的是前两个 null：**表现出来就是"刷新就重置"**；
//     而灰字行的条数**换过版本**（第一百一十二批从 4 行加到 5 行）→ 下标再错一位 →
//     正提示词正好落进负提示词框：**"错乱"就是这么来的**。
//   修法**不依赖前端**：这颗节点只有这两个文本框会序列化，所以"存下来的非空项"永远按 正 → 负 排
//   —— 不管中间夹了几行灰字、下标错到哪儿，**顺次认领**就对了（null = 空洞，空字符串 = 真的空）。
function adoptSyncText(node, info) {
  try {
    const vals = info && Array.isArray(info.widgets_values) ? info.widgets_values : null;
    if (!vals || !vals.length) return false;
    const keep = [];
    for (const v of vals) if (v !== null && v !== undefined) keep.push(String(v));
    if (!keep.length) return false;
    writeWidget(node, "positive", keep[0] || "");
    writeWidget(node, "negative", keep.length > 1 ? keep[1] : "");
    return true;
  } catch (e) { return false; }
}

// 刷新 / 重开时要不要清空：由工具栏那颗「5. 设置」里的开关决定（同源页面 → 同一个 localStorage）。
//   默认 **不重置**（文本留着）—— 他 2026-10-12 拍的那条。
const SYNC_RESET_KEY = "pcToolbar.syncReset.v1";
function syncResetOnLoad() {
  try { return localStorage.getItem(SYNC_RESET_KEY) === "1"; } catch (e) { return false; }
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
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || !nodeData.name) return;
    if (nodeData.name === LATENT_NODE) { setupLatentNode(nodeType); return; }
    if (nodeData.name !== NODE_NAME) return;
    setupCollapseToggle(nodeType);
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      attachManualSync(this);
      // ★ 2026-10-05 第九十八批查出的一个真 bug：那颗 −/＋ 是**互相切换**的 ——
      //   优化节点那颗 − 去收/放本节点时，原来会走 `window.__pcSetCollapsed`（那是**优化节点自己**的实现：
      //   它去写「正提示词/负提示词」两个控件，本节点根本没有 → 于是收起时 positive/negative **没被清空**、
      //   文本还在参与作图）。把自己这套挂到实例上，那边就会优先用它。
      try { this.__pcToggleCollapse = (on) => pcSetCollapsed(this, on); } catch (e) { /* 忽略 */ }
      return r;
    };

    // ★★ 2026-10-05 他的第 3 条：「打开 ComfyUI 时保证里面内容是空的」。
    //   ⚠️ 2026-10-12（第一百四十九批）**这条口径改了**：他要修掉"重开 / 刷新后文本错乱"这个真 bug，
    //   并把"要不要清空"做成工具栏「5. 设置」里的一项（**默认不重置** = 文本留着）。
    //   onConfigure 是节点把工作流里的值读完**之后**才调的（真前端 configure() 把它放在最后），
    //   所以在这儿纠正是有效的。
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        adoptSyncText(this, info);                    // ① 先把两个文本框摆正（治错乱 / 治"刷新就重置"）
        if (syncResetOnLoad()) {                      // ② 只有开关打开时才清空
          writeWidget(this, "positive", "");
          writeWidget(this, "negative", "");
        }
        if (this.properties && this.properties.pcKept) this.properties.pcKept = null;
        refreshCanvas(this);
      } catch (e) { /* 忽略 */ }
      return r;
    };
  },
});
