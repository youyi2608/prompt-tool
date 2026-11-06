// ==================== 🪄 魔法棒（238/239 批）====================
//   他 238 批给的需求（原话）：
//     「魔法棒是游动羽翼工具栏的新功能，**和橡皮放在同一个地方**，和拖动橡皮一样，拖动魔法棒到节点后，
//      会把原版节点变为修改之后的节点，**并保持里面的文本和外部的连接状态不变**，
//      可以将修改之后的节点敲成原版节点，也可以把原版节点敲成修改之后的节点，**必须要撤回键，再敲一下就等于撤回了**。
//      毕竟本来就是双态转换。但本质其实是把连接状态取下来，**把原来的节点藏起来，把新的节点放上去**，
//      并不是变化。毕竟要真出了什么差错，数据还原都还原不了，那找谁哭去」
//   他 239 批确认：**全是默认口径** —— 一个一个敲（不做批量）、**双向**、只做"再敲即撤回"（不要总撤回键）。
//   确认的两条规则：CLIPTextEncode ×2 ⇄ 优化节点 ×1（成对收）· LoraLoader 链 ×N ⇄ LoRA 池 ×1（整链收）。
//
//   ⚠️ 核心安全设计：**"藏"= 从画布移除 + 把完整快照（类型/位置/大小/控件值/properties/每条连线）
//      写进新节点的 `properties.pcWand`**。快照跟着工作流一起存，所以随时能原样还原 ——
//      这和黑箱 `__inner` 是同一套做法（前端没有真的"隐藏节点"）。
import { app } from "../../scripts/app.js";

const TAG = "pcWand";
const DEF_W = 900;

function log() {
  try { console.log.apply(console, ["[提示词工具·魔法棒]"].concat([].slice.call(arguments))); } catch (e) { /* 忽略 */ }
}
var NL = String.fromCharCode(10);   // ★ 换行符（避免脚本转义把源码写坏）

function toast(msg) {
  // ★ 253 批：诊断信息要塞进 toast 给他看（他不会用 F12）→ 支持多行 + 显示更久
  const el = document.createElement("div");
  el.className = "pc-wand-toast";
  el.textContent = String(msg || "");
  el.style.cssText = "position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:100100;"
    + "max-width:min(760px,92vw);padding:10px 14px;border-radius:10px;white-space:pre-wrap;line-height:1.6;"
    + "font:12.5px/1.6 system-ui,-apple-system,'Microsoft YaHei',sans-serif;color:#e8eaf1;"
    + "background:rgba(24,26,32,.96);border:1px solid rgba(150,162,180,.5);box-shadow:0 10px 30px rgba(0,0,0,.5)";
  document.body.appendChild(el);
  const life = String(msg || "").indexOf(String.fromCharCode(10)) >= 0 ? 9000 : 2600;   // 带诊断的留 9 秒
  setTimeout(function () { try { el.remove(); } catch (e) { /* 忽略 */ } }, life);
  return el;
}

// ---------------------------------------------------------------- 配对表
//   每对：原版类型（可多个）→ 改版类型；mode 决定"怎么收"
const PAIRS = [
  {
    mod: "PromptToolEmptyLatent", mode: "one",
    orig: ["EmptyLatentImage", "EmptySD3LatentImage"],
    label: "空 Latent",
  },
  {
    mod: "PromptToolGallery", mode: "one",
    orig: ["PreviewImage"],
    label: "预览图像",
  },
  {
    mod: "PromptToolLoraPool", mode: "chain",
    orig: ["LoraLoader"],
    label: "LoRA 加载器链",
  },
  {
    mod: "PromptToolClipSegments", mode: "pair",
    orig: ["CLIPTextEncode"],
    label: "CLIP 文本编码",
  },
];
function typeOf(n) { return String((n && (n.comfyClass || n.type)) || ""); }
function pairForOrig(t) { return PAIRS.filter((p) => p.orig.indexOf(t) >= 0)[0] || null; }
function pairForMod(t) { return PAIRS.filter((p) => p.mod === t)[0] || null; }

// ---------------------------------------------------------------- 画布坐标 / 命中
function canvasEl() {
  const c = app && app.canvas;
  return c && (c.canvas || c.canvasEl);
}
function toGraph(ev) {
  const c = app.canvas, el = canvasEl();
  if (!c || !el || !c.ds) return null;
  const r = el.getBoundingClientRect();
  return [(ev.clientX - r.left) / c.ds.scale - c.ds.offset[0],
          (ev.clientY - r.top) / c.ds.scale - c.ds.offset[1]];
}
function nodeAt(ev) {
  const p = toGraph(ev);
  if (!p) return null;
  const nodes = (app.graph && app.graph._nodes) || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n || !n.size || (n.flags && n.flags.collapsed)) continue;
    if (p[0] >= n.pos[0] && p[0] <= n.pos[0] + n.size[0] && p[1] >= n.pos[1] && p[1] <= n.pos[1] + n.size[1]) return n;
  }
  return null;
}

// ---------------------------------------------------------------- 快照 / 还原
function linkById(id) { return id == null ? null : (app.graph.links || {})[id] || null; }

// 把一颗节点的"一切"拍成快照（连线按 id 记，还原时再校验 id 还在不在）
function snapshot(n) {
  const ins = [];
  (n.inputs || []).forEach((inp, i) => {
    if (!inp) { ins.push(null); return; }
    const l = linkById(inp.link);
    ins.push(l ? { slot: i, from: l.origin_id, fromSlot: l.origin_slot, type: l.type } : null);
  });
  const outs = [];
  (n.outputs || []).forEach((out, i) => {
    const arr = [];
    ((out && out.links) || []).forEach((lid) => {
      const l = linkById(lid);
      if (l) arr.push({ slot: i, to: l.target_id, toSlot: l.target_slot, type: l.type });
    });
    outs.push(arr);
  });
  return {
    id: n.id,                 // ★ 249 批：多节点还原时靠它建「旧id→新节点」映射
    type: n.type,
    title: n.title,
    pos: [n.pos[0], n.pos[1]],
    size: [n.size[0], n.size[1]],
    // ⚠️ 239 批踩到的坑：`widgets_values` 是"保存/加载时"才同步的快照，运行时改了 w.value 它不一定跟着变
    //   → 必须读 **widgets[].value** 才是当前真值（空 widgets 时再退回 widgets_values）。
    wv: (function () {
      var ws = n.widgets || [];
      if (ws.length) return ws.map(function (w) { return (w && typeof w === "object" && "value" in w) ? w.value : null; });
      return JSON.parse(JSON.stringify(n.widgets_values || []));
    })(),
    props: JSON.parse(JSON.stringify(n.properties || {})),
    ins: ins,
    outs: outs,
    at: Date.now(),
  };
}

// 按快照把一颗节点原样做回来，并把连线接回（目标/来源不在了就只保留能接的）
function restore(snap) {
  let n = null;
  try { n = window.LiteGraph.createNode(snap.type); } catch (e) { n = null; }
  if (!n) { log("还原失败：本机没有这个类型", snap.type); return null; }
  try { app.graph.add(n); } catch (e) { /* 忽略 */ }
  try {
    n.pos = [snap.pos[0], snap.pos[1]];
    // ★ 249 批（他："空 latent 敲了两下之后，尺寸变得异常"）：
    //   快照里存的是**原版的尺寸**，还原成改版时会用原版尺寸 → 又变小了。改版按 MOD_MIN 兜底。
    var mmR = modMinSize(typeOf(n));
    n.setSize([Math.max(snap.size[0], mmR[0]), Math.max(snap.size[1], mmR[1])]);
  } catch (e) { /* 忽略 */ }
  // ★ 250 批（他："空 latent 敲击两下之后长宽异常变化的问题仍然没有解决"）：
  //   真因 —— 这里**按索引**把快照的控件值照抄过去，可原版和改版的控件根本不是一套语义：
  //   原版 EmptyLatentImage = [width, height, batch_size]，改版 = [长边像素, 短边像素, 横边为长边还是短边, …]
  //   → 还原成改版时变成"长边=512、短边=512、横边=1"，长宽自然全乱。
  //   修法：**同类型才按索引抄**；跨类型走 wvByType 的语义映射。
  try {
    const sameType = String(snap.type) === String(typeOf(n));
    if (sameType) {
      (n.widgets || []).forEach((w, i) => {
        if (i < snap.wv.length && w && typeof w === "object") {
          try { w.value = snap.wv[i]; } catch (e) { /* 忽略 */ }
        }
      });
    } else {
      wvByType(snap.type, n, snap.wv);
    }
  } catch (e) { log("控件值还原失败", e); }
  try { n.title = snap.title || n.title; } catch (e) { /* 忽略 */ }
  // widgets_values 也一起写回（保存工作流 / 别的插件读的都是它；只写 w.value 的话存盘会丢）
  try {
    if (String(snap.type) === String(typeOf(n))) n.widgets_values = JSON.parse(JSON.stringify(snap.wv || []));
    else n.widgets_values = (n.widgets || []).map(function (w) { return w && w.value; });
  } catch (e) { /* 忽略 */ }
  try { if (snap.props) n.properties = snap.props; } catch (e) { /* 忽略 */ }
  // 连线：输入侧（来源 → 我）
  try {
    (snap.ins || []).forEach((rec) => {
      if (!rec) return;
      const from = (app.graph._nodes || []).filter((x) => x.id === rec.from)[0];
      if (from) { try { from.connect(rec.fromSlot, n, rec.slot); } catch (e) { /* 忽略 */ } }
    });
  } catch (e) { /* 忽略 */ }
  // 输出侧（我 → 目标）
  try {
    (snap.outs || []).forEach((arr) => (arr || []).forEach((rec) => {
      const to = (app.graph._nodes || []).filter((x) => x.id === rec.to)[0];
      if (to) { try { n.connect(rec.slot, to, rec.toSlot); } catch (e) { /* 忽略 */ } }
    }));
  } catch (e) { /* 忽略 */ }
  return n;
}

// 把"原节点们"收进新节点的 properties（藏起来），再把它们从画布移除
function stash(newNode, snaps) {
  try {
    newNode.properties = newNode.properties || {};
    newNode.properties[TAG] = { version: 1, before: snaps };
  } catch (e) { /* 忽略 */ }
}
function stashOf(node) {
  try {
    const p = node && node.properties && node.properties[TAG];
    if (p && Array.isArray(p.before) && p.before.length) return p;
  } catch (e) { /* 忽略 */ }
  return null;
}

// ---------------------------------------------------------------- 转换：一对多/多对一
// 沿 MODEL 输出把 LoRA 链按真实顺序找出来（和黑箱 bbLoraChain 同一套思路）
function loraChainOf(node) {
  const links = app.graph.links || {};
  const nodes = app.graph._nodes || [];
  const byId = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  function followModel(n) {
    const out = n.outputs && n.outputs[0];
    for (const lid of (out && out.links) || []) {
      const l = links[lid];
      if (!l) continue;
      const t = byId[l.target_id];
      if (t && typeOf(t) === "LoraLoader") return t;
    }
    return null;
  }
  // 往回找到链头（前一个 MODEL 来源不是 LoraLoader 的那颗）
  let head = node, guard = 0;
  while (guard++ < 40) {
    const inp = head.inputs && head.inputs[0];
    const l = linkById(inp && inp.link);
    const from = l ? byId[l.origin_id] : null;
    if (from && typeOf(from) === "LoraLoader") head = from; else break;
  }
  const chain = [];
  let cur = head, g2 = 0;
  while (cur && g2++ < 40) { chain.push(cur); cur = followModel(cur); }
  return chain;
}

// 从 KSampler 反查"这颗 CLIPTextEncode 是正还是负"
function sideOfClipText(node) {
  const links = app.graph.links || {};
  const nodes = app.graph._nodes || [];
  const out = node.outputs && node.outputs[0];
  for (const lid of (out && out.links) || []) {
    const l = links[lid];
    if (!l) continue;
    const t = nodes.filter((x) => x.id === l.target_id)[0];
    if (t && /KSampler/.test(typeOf(t))) {
      if (l.target_slot === 1) return { side: "pos", ks: t };
      if (l.target_slot === 2) return { side: "neg", ks: t };
    }
  }
  return { side: "", ks: null };
}
// 同一颗 KSampler 对面那槽上是哪颗 CLIPTextEncode
function otherClipText(node, ks, wantSlot) {
  if (!ks || !ks.inputs || !ks.inputs[wantSlot]) return null;
  const l = linkById(ks.inputs[wantSlot].link);
  if (!l) return null;
  const from = (app.graph._nodes || []).filter((x) => x.id === l.origin_id)[0];
  return from && typeOf(from) === "CLIPTextEncode" ? from : null;
}

// ---------------------------------------------------------------- ★ 249 批：LoRA 池按名单补全
//   他："我都是敲复制工作流里面的东西的，怎么敲着敲着，原版工作流里面的 LORA 池里面暗的东西全消失了，
//   只剩下亮的 1 加 2 个了。帮我把丢掉的 10 个全补回来，也不知道怎么补。为了防止再次丢失，也想个办法"
function fillPoolFromCatalog(node) {
  const url = new URL("./lora-catalog.json", import.meta.url).href;
  fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (cat) {
    // ★ 249 批：lora-catalog.json 的结构是 `{_note, version, items:[…]}`，**不是数组** ——
    //   原来 `Array.isArray(cat)` 判完直接 return，所以点了一点反应都没有。
    const arr = Array.isArray(cat) ? cat : ((cat && cat.items) || []);
    if (!arr.length) { toast("名单读不出来"); return; }
    let st = {};
    try { st = JSON.parse(String(wvOf(node, "状态", "{}"))); } catch (e) { st = {}; }
    st.loras = Array.isArray(st.loras) ? st.loras : [];
    st.kinds = st.kinds || {};
    const have = {};
    st.loras.forEach(function (r) { if (r && r.name) have[r.name] = true; });
    let added = 0;
    arr.forEach(function (it) {
      if (!it || !it.file || have[it.file]) return;
      st.loras.push({ name: it.file, on: false, model: 1, clip: 1, src: "catalog" });
      st.kinds[it.file] = it.kind === "char" ? "char" : "style";
      added++;
    });
    const w2 = (node.widgets || []).filter(function (x) { return x && x.name === "状态"; })[0];
    if (w2) w2.value = JSON.stringify(st);
    // ★ 251 批（他："按名单补全 Lora 会在刷新之后才生效，不会实时生效"）：
    //   除了派发事件，还**直接**让节点重排 / 重画（有些路径不听那个事件）。
    // ★ 267 批：`__pcLoraPool.repaint` **根本不存在**（只有 render）→ 上一版这一行永远空转，
    //   所以他才说"还得刷新一下"。现在改成真的调 render，并顺手把工作流标脏（否则改动存不进工作流）。
    try { if (node && node.graph && node.graph.change) node.graph.change(); } catch (e) { /* 忽略 */ }
    try { if (window.__pcLoraPool && window.__pcLoraPool.render) window.__pcLoraPool.render(node); } catch (e) { /* 忽略 */ }
    try { window.dispatchEvent(new CustomEvent("pc-lorapool-changed", { detail: { node: node } })); } catch (e) { /* 忽略 */ }
    try { if (node && node.onWidgetChanged) node.onWidgetChanged("状态", w2 ? w2.value : null, null, w2); } catch (e) { /* 忽略 */ }
    try { if (node && node.setSize) node.setSize([node.size[0], node.size[1]]); } catch (e) { /* 忽略 */ }
    try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
    toast(added ? ("已按名单补回 " + added + " 个 LoRA（都是熄灭的，要用再点亮点）") : "名单里的都在池子里了");
  }).catch(function (e) { toast("补全失败：" + (e && e.message)); });
}
window.__pcFillPoolCatalog = fillPoolFromCatalog;

// ★ 249 批：给 LoRA 池挂一颗右键菜单（补回名单里缺的）—— 也防"再次丢失"
function hookPoolMenu() {
  try {
    if (window.__pcPoolMenuHooked) return false;
    const LN = window.LGraphNode || (window.LiteGraph && LiteGraph.LGraphNode);
    if (!LN) return false;
    window.__pcPoolMenuHooked = true;
    const orig = LN.prototype.getExtraMenuOptions;
    LN.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = orig ? orig.apply(this, arguments) : undefined;
      try {
        const t = String(this.type || this.comfyClass || "");
        if (t === "PromptToolLoraPool" && Array.isArray(options)) {
          options.push({ content: "🔁 按名单补全 LoRA（补回缺的）", callback: () => fillPoolFromCatalog(this) });
        }
      } catch (e) { /* 忽略 */ }
      return r;
    };
    return true;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- 主流程
// ★ 251 批：诊断记录 —— 他在实机上遇到"改了没效果"，用 window.__pcWand.lastOp 一眼看出卡在哪
function wandLog() {
  const rec = { at: new Date().toISOString(), steps: [] };
  try { (window.__pcWandLogs = window.__pcWandLogs || []).push(rec); if (window.__pcWandLogs.length > 20) window.__pcWandLogs.shift(); } catch (e) { /* 忽略 */ }
  try { window.__pcWand.lastOp = rec; } catch (e) { /* 忽略 */ }
  return {
    add: function (msg, data) { try { rec.steps.push({ msg: msg, data: data === undefined ? null : data }); } catch (e) { /* 忽略 */ } },
  };
}

function wandTap(node) {
  if (!node || !node.graph) return false;
  // ① 这颗是改版、且带着快照 → 还原（"再敲一下就等于撤回"）
  const st = stashOf(node);
  if (st) {
    const made = [];
    // ★ 249 批（他："只有第一个角色 Lora 的输出口模型会和 K 采样器连接，而不是理想中的串联"）：
    //   真因 —— 快照里记的连线是**旧节点 id**，restore 重建后 id 全变了 → 链内互相的连线一条都接不上。
    //   修法：建「旧 id → 新节点」映射，然后**按快照里的 ins/outs 原样重接**（这条路径对任何多节点还原都管用）。
    const idMap = {};
    st.before.forEach((snap) => {
      const n = restore(snap);
      if (n) { made.push(n); idMap[snap.id] = n; }
    });
    const pick = (oldId) => idMap[oldId] || (app.graph._nodes || []).filter((x) => x.id === oldId)[0] || null;
    st.before.forEach((snap) => {
      const nn = idMap[snap.id];
      if (!nn) return;
      (snap.ins || []).forEach((rec) => {
        if (!rec) return;
        const from = pick(rec.from);
        if (from && nn.inputs && rec.slot < nn.inputs.length) {
          try { from.connect(rec.fromSlot, nn, rec.slot); } catch (e) { log("重接输入失败", e); }
        }
      });
      (snap.outs || []).forEach((arr, oslot) => (arr || []).forEach((rec) => {
        const to = pick(rec.to);
        if (to && nn.outputs && oslot < nn.outputs.length) {
          // ★ 250 批（他："魔法棒最后一个 Lora 的 CLIP 输出口不会连接"）：
          //   删掉旧节点后，下游那颗（编码节点）的插槽上还挂着**指向已删节点的悬空 link** →
          //   connect 会因为"插槽已被占"而失败。必须**先断开那个输入**再接。
          try { if (to.inputs && to.inputs[rec.toSlot] && to.inputs[rec.toSlot].link != null) to.disconnectInput(rec.toSlot); } catch (e) { /* 忽略 */ }
          try { nn.connect(oslot, to, rec.toSlot); } catch (e) { log("重接输出失败", e); }
        }
      }));
    });
    const wasType = typeOf(node);
    try { app.graph.remove(node); } catch (e) { /* 忽略 */ }
    app.graph.setDirtyCanvas(true, true);
    // ★ 253 批：把诊断写进 toast（他能直接看到，不用开 F12）
    var dbg = st.before.map(function (sn) {
      var wv0 = (sn.wv && sn.wv[0] != null) ? String(sn.wv[0]) : "";
      return (sn.type || "?") + "：" + (wv0 ? "\"" + wv0.slice(0, 26) + "\"（" + wv0.length + " 字）" : "**文本为空**");
    }).join(NL);
    toast("已还原成原版" + (made.length > 1 ? "（" + made.length + " 颗）" : "") + "：" + made.map(typeOf).join(" + ")
      + "\n—— 快照里存的控件值：\n" + dbg);
    log("还原", wasType, "→", made.map(typeOf));
    return true;
  }
  // ★ 248 批（他："魔法棒完全不能从改版变为原版"）：
  //   真因 —— 「再敲一下还原」只对**带快照的**改版节点有效（快照是 239 批敲出来时写进去的）。
  //   他画布上那些改版节点（老版本建的 / 手动拖进来的 / 从没敲过的）没有快照 → 走到下面只弹一句
  //   "没有魔法棒记录"。现在补一条**按类型反向还原**的路：建原版、搬参数、照它现在的连线接回去。
  const pm = pairForMod(typeOf(node));
  if (pm) return restoreNoStash(node, pm);

  // ② 原版 → 改版
  const t = typeOf(node);
  const p = pairForOrig(t);
  if (!p) {
    // 改版但没快照（比如手建的）→ 给个提示
    const pm = pairForMod(t);
    toast(pm ? ("这颗「" + pm.mod + "」没有魔法棒记录，不知道怎么变回原版") : ("这颗节点魔法棒不认识：" + t));
    return false;
  }
  if (p.mode === "one") return swapOne(node, p);
  if (p.mode === "chain") return swapChain(node, p);
  if (p.mode === "pair") return swapPair(node, p);
  return false;
}

// ---------------------------------------------------------------- 没快照的改版 → 原版（248 批）
// ★ 248 批：改版节点各有自己的"能看的最小尺寸"，别用原版（空Latent 才 270×106）的尺寸
const MOD_MIN = {
  PromptToolEmptyLatent: [660, 430],
  PromptToolGallery: [760, 460],
  PromptToolLoraPool: [475, 450],
  PromptToolClipSegments: [560, 430],
};
// ★ 252 批（他："空 latent 敲两下之后长宽异常变化" —— 指的是**节点尺寸**）：
//   真因在下面这行 —— 它对**原版类型**也返回 [420,300]，于是敲回原版时把原本 270×106 的
//   EmptyLatentImage 硬撑成 420×300。原版类型必须**不设下限**（用快照里的原尺寸）。
function modMinSize(type) {
  const t = String(type || "");
  if (MOD_MIN[t]) return MOD_MIN[t];
  return [0, 0];
}

// ★ 250 批：原版 ↔ 改版的控件**语义映射**（不能按索引抄）
function wvByType(fromType, toNode, wv) {
  const ft = String(fromType || ""), tt = String(typeOf(toNode) || "");
  const setW = (name, v) => {
    const w = (toNode.widgets || []).filter((x) => x && x.name === name)[0];
    if (w && v != null) { try { w.value = v; } catch (e) { /* 忽略 */ } }
  };
  const isLatentOrig = /^Empty(SD3)?LatentImage$/.test(ft);
  const isLatentMod = tt === "PromptToolEmptyLatent";
  if (isLatentOrig && isLatentMod) {
    // 原版 [width, height, batch] → 改版的五排
    //   ⚠️ 251 批踩到：改版是「长边像素 / 短边像素 / **横边**为长边还是短边 / **竖边**为长边还是短边 / 数量」，
    //   漏掉"竖边"那一排 → 它保持默认（长边）→ 宽高都变成同一个数（他说的"长宽异常"）。
    const w0 = Number(wv[0]) || 1024, h0 = Number(wv[1]) || 1024;
    const long = Math.max(w0, h0), short = Math.min(w0, h0);
    const wide = w0 >= h0;
    setW("长边像素", long);
    setW("短边像素", short);
    setW("横边为长边还是短边", wide ? "长边" : "短边");
    setW("竖边为长边还是短边", wide ? "短边" : "长边");
    setW("数量", Number(wv[2]) || 1);
    setW("张数", Number(wv[2]) || 1);
    return;
  }
  if (isLatentMod && /^Empty(SD3)?LatentImage$/.test(tt)) {
    // 改版 → 原版：从改版节点读"长边/短边/横边"再换算
    const long = Number(wvOf(toNode, "长边像素", 1024)) || 1024;   // 注意：这里 toNode 是新建的原版，读不到
    return;
  }
  // 其它跨类型：一个都不抄（保留新节点的默认值，别拿错语义去污染）
}

function wvOf(node, name, dv) {
  const x = ((node && node.widgets) || []).filter((y) => y && y.name === name)[0];
  return x && x.value != null ? x.value : dv;
}
function inRecsOf(node) {
  return ((node && node.inputs) || []).map((x, i) => {
    if (!x || x.link == null) return null;
    const l = linkById(x.link);
    if (!l) return null;
    return { slot: i, from: l.origin_id, fromSlot: l.origin_slot };
  });
}
function outRecsOf(node) {
  const out = [];
  ((node && node.outputs) || []).forEach((x, i) => {
    ((x && x.links) || []).forEach((lid) => {
      const l = linkById(lid);
      if (l) out.push({ slot: i, to: l.target_id, toSlot: l.target_slot });
    });
  });
  return out;
}
function wireBack(made, ins, outs) {
  // 输入：原节点的每个输入来源 → **每一颗**新建节点都要接
  //   ★ 248 批：优化节点变回两颗编码时，两颗都得接同一个 CLIP（原来只接了 made[rec.slot]）
  (ins || []).forEach((rec) => {
    if (!rec) return;
    const from = (app.graph._nodes || []).filter((x) => x.id === rec.from)[0];
    if (!from) return;
    made.forEach((tgt) => {
      if (!tgt || !tgt.inputs || rec.slot >= tgt.inputs.length) return;
      try { from.connect(rec.fromSlot, tgt, rec.slot); } catch (e) { log("回接输入失败", e); }
    });
  });
  // 输出：原节点的下游 → 新节点**的 0 号输出**
  //   ★ 248 批：新建的每颗节点都只有 1 个输出，原来用 `src.connect(rec.slot, …)` 会连不上
  (outs || []).forEach((rec) => {
    const to = (app.graph._nodes || []).filter((x) => x.id === rec.to)[0];
    const src = made[rec.slot] || made[0];
    if (to && src) { try { src.connect(0, to, rec.toSlot); } catch (e) { log("回接输出失败", e); } }
  });
}

function restoreNoStash(node, pm) {
  const pos = [node.pos[0], node.pos[1]];
  const ins = inRecsOf(node);
  const outs = outRecsOf(node);
  const made = [];
  try {
    if (pm.mode === "one") {
      // ★ 248 批：pm.orig 是**数组**（EmptyLatentImage / EmptySD3LatentImage 都算）→ 挑本机真有的
      const origs = Array.isArray(pm.orig) ? pm.orig : [pm.orig];
      let nn = null;
      for (const ot of origs) { try { nn = window.LiteGraph.createNode(ot); } catch (e) { nn = null; } if (nn) break; }
      if (!nn) { toast("本机没有「" + pm.orig + "」这个节点"); return false; }
      app.graph.add(nn);
      nn.pos = pos;
      // 改版的"长边/短边/横边"→ 原版的 width/height
      try {
        const lng = Number(wvOf(node, "长边像素", 1024)) || 1024;
        const sht = Number(wvOf(node, "短边像素", 1024)) || 1024;
        // ★ 251 批：横边、竖边是**两排**，都要读（原来只读横边，竖边默认长边 → 宽高一样）
        const hzH = String(wvOf(node, "横边为长边还是短边", ""));
        const hzV = String(wvOf(node, "竖边为长边还是短边", ""));
        const pickBy = (txt, fallbackLong) => {
          if (/短/.test(txt)) return sht;
          if (/长/.test(txt)) return lng;
          return fallbackLong ? lng : lng;
        };
        const ww = pickBy(hzH, true), hh = pickBy(hzV, false);
        [["width", ww], ["height", hh], ["batch_size", Number(wvOf(node, "数量", wvOf(node, "张数", 1))) || 1]].forEach((p) => {
          const x = ((nn.widgets) || []).filter((y) => y && y.name === p[0])[0];
          if (x) x.value = p[1];
        });
      } catch (e) { log("空Latent 参数回搬失败", e); }
      made.push(nn);
    } else if (pm.mode === "pair") {
      // 优化节点 → 两颗 CLIPTextEncode（正/负文本从 properties.pcClip 读）
      const q = (node.properties && node.properties.pcClip) || {};
      const posText = String((q.pos && q.pos.v) || "");
      const negText = String((q.neg && q.neg.v) || "");
      const a = window.LiteGraph.createNode("CLIPTextEncode");
      const b = window.LiteGraph.createNode("CLIPTextEncode");
      if (!a || !b) { toast("本机没有 CLIPTextEncode"); return false; }
      app.graph.add(a); app.graph.add(b);
      a.pos = [pos[0], pos[1]];
      b.pos = [pos[0], pos[1] + 200];
      if ((a.widgets || [])[0]) (a.widgets || [])[0].value = posText;
      if ((b.widgets || [])[0]) (b.widgets || [])[0].value = negText;
      made.push(a, b);
    } else if (pm.mode === "chain") {
      // 池子 → 按亮着的 LoRA 建一条 LoraLoader 链
      let st = {};
      try { st = JSON.parse(String(wvOf(node, "状态", "{}"))); } catch (e) { st = {}; }
      const lit = (st.loras || []).filter((r) => r && r.on !== false);
      let prev = null;
      lit.forEach((r, i) => {
        const nn = window.LiteGraph.createNode("LoraLoader");
        if (!nn) return;
        app.graph.add(nn);
        nn.pos = [pos[0], pos[1] + i * 120];
        [["lora_name", r.name], ["strength_model", r.model == null ? 1 : r.model], ["strength_clip", r.clip == null ? 1 : r.clip]].forEach((p) => {
          const x = (nn.widgets || []).filter((y) => y && y.name === p[0])[0];
          if (x) x.value = p[1];
        });
        if (prev) { try { prev.connect(0, nn, 0); } catch (e) { /* 忽略 */ } try { prev.connect(1, nn, 1); } catch (e) { /* 忽略 */ } }
        prev = nn;
        made.push(nn);
      });
      if (!made.length) { toast("池子里没有亮着的 LoRA，不知道要建什么"); return false; }
    } else {
      return false;
    }
  } catch (e) { log("反向还原失败", e); toast("还原失败：" + (e && e.message)); return false; }

  if (!made.length) return false;
  if (pm.mode === "chain") {
    // ★ 249 批（他："每个 Lora 都只和加载 CLIP 节点连接，输出口更是全是空的，
    //   只有第一个角色 Lora 的输出口模型会和 K 采样器连接，而不是理想中的串联"）：
    //   真因 —— 248 批我把 wireBack 的"输入接给每一颗"用在了 LoRA 链上 → 所有 LoRA 并联到同一个 CLIP；
    //   输出又只从 made[0] 接出去。链必须**只给第一颗接输入、只从最后一颗接输出、中间自己串联**。
    (ins || []).forEach((rec) => {
      if (!rec) return;
      const from = (app.graph._nodes || []).filter((x) => x.id === rec.from)[0];
      if (from && made[0] && made[0].inputs && rec.slot < made[0].inputs.length) {
        try { from.connect(rec.fromSlot, made[0], rec.slot); } catch (e) { /* 忽略 */ }
      }
    });
    const tail = made[made.length - 1];
    (outs || []).forEach((rec) => {
      const to = (app.graph._nodes || []).filter((x) => x.id === rec.to)[0];
      if (to && tail) { try { tail.connect(0, to, rec.toSlot); } catch (e) { /* 忽略 */ } }
    });
  } else {
    wireBack(made, ins, outs);
  }
  try { app.graph.remove(node); } catch (e) { /* 忽略 */ }
  app.graph.setDirtyCanvas(true, true);
  toast("已变回原版：" + made.map(typeOf).join(" + "));
  log("反向还原", typeOf(node), "→", made.map(typeOf));
  return true;
}

// ---- 一对一 ----
function swapOne(node, p) {
  const snap = snapshot(node);
  let nn = null;
  try { nn = window.LiteGraph.createNode(p.mod); } catch (e) { nn = null; }
  if (!nn) { toast("本机没有「" + p.mod + "」这个节点"); return false; }
  app.graph.add(nn);
  // ★ 248 批（他："从原版变为改版，会出现改版完全遵循原版宽高的问题，所以会被严重挤压"）：
  //   这里原来把改版节点**照抄成原版尺寸**（原版 EmptyLatent 才 270×106）→ 挤成一小条。
  //   改成：只搬位置，尺寸用「改版自己的最小值」和原版尺寸取大 —— 永远不小于 MOD_MIN。
  try {
    nn.pos = [snap.pos[0], snap.pos[1]];
    const mm = modMinSize(p.mod);
    const cs = nn.computeSize ? nn.computeSize() : null;
    nn.setSize([Math.max((cs && cs[0]) || 0, mm[0], snap.size[0]), Math.max((cs && cs[1]) || 0, mm[1], snap.size[1])]);
  } catch (e) { /* 忽略 */ }
  // 参数搬运
  try { mapOneArgs(node, nn, p); } catch (e) { log("参数搬运失败", e); }
  stash(nn, [snap]);
  // 连线：先把来源接上（改版节点的输入槽 0 通常就是原来那个）
  (snap.ins || []).forEach((rec) => {
    if (!rec) return;
    const from = (app.graph._nodes || []).filter((x) => x.id === rec.from)[0];
    if (from && nn.inputs && rec.slot < nn.inputs.length) {
      try { from.connect(rec.fromSlot, nn, rec.slot); } catch (e) { /* 忽略 */ }
    }
  });
  app.graph.remove(node);
  // 输出侧：等原节点移除后再接（避免 id 冲突）
  (snap.outs || []).forEach((arr, oslot) => (arr || []).forEach((rec) => {
    const to = (app.graph._nodes || []).filter((x) => x.id === rec.to)[0];
    if (to && nn.outputs && oslot < nn.outputs.length) {
      try { nn.connect(oslot, to, rec.toSlot); } catch (e) { /* 忽略 */ }
    }
  }));
  app.graph.setDirtyCanvas(true, true);
  toast("已变成「" + (nn.title || p.mod) + "」—— 再敲一下变回原版");
  return true;
}
function mapOneArgs(src, dst, p) {
  // ⚠️ 读运行时真值（widgets[].value），别读 widgets_values
  const getW = (n2, name, dv) => {
    const w = (n2.widgets || []).filter((x) => x && x.name === name)[0];
    return w && w.value != null ? w.value : dv;
  };
  const wv = [getW(src, "width", 1024), getW(src, "height", 1024), getW(src, "batch_size", 1)];
  const setW = (n, name, v) => {
    const w = (n.widgets || []).filter((x) => x && x.name === name)[0];
    if (w) w.value = v;
  };
  if (p.mod === "PromptToolEmptyLatent") {
    const W = Number(wv[0]) || 1024, H = Number(wv[1]) || 1024, B = Number(wv[2]) || 1;
    const long = Math.max(W, H), short = Math.min(W, H);
    setW(dst, "长边像素", long);
    setW(dst, "短边像素", short);
    setW(dst, "横边为长边还是短边", W >= H ? "长边" : "短边");
    setW(dst, "竖边为长边还是短边", H >= W ? "长边" : "短边");
    setW(dst, "数量", B);
  }
  // PreviewImage → PromptToolGallery 没有参数
}

// ---- LoRA 链 → 池子（整链收）----
function swapChain(node, p) {
  const chain = loraChainOf(node);
  if (!chain.length) { toast("没找到 LoRA 链"); return false; }
  const snaps = chain.map((n) => snapshot(n));
  const loras = chain.map((n2) => {
    // ⚠️ 从 widgets[].value 读（widgets_values 运行时不同步）
    const g = (nm, dv) => {
      const w = (n2.widgets || []).filter((x) => x && x.name === nm)[0];
      return w && w.value != null ? w.value : dv;
    };
    const name = String(g("lora_name", (n2.widgets_values || [])[0] || ""));
    const nm2 = Number(g("strength_model", (n2.widgets_values || [])[1] != null ? (n2.widgets_values || [])[1] : 1));
    const nc2 = Number(g("strength_clip", (n2.widgets_values || [])[2] != null ? (n2.widgets_values || [])[2] : 1));
    return { name: name, on: true, model: nm2, clip: nc2, src: "wand" };
  });
  let nn = null;
  try { nn = window.LiteGraph.createNode(p.mod); } catch (e) { nn = null; }
  if (!nn) { toast("本机没有 LoRA 池节点"); return false; }
  app.graph.add(nn);
  try {
    const head = chain[0];
    nn.pos = [head.pos[0], head.pos[1]];
    // ★ 248 批：优化节点有自己的下限（560×430），别按原版那两颗小编码节点的尺寸来
    var cs2 = null;
    try { cs2 = nn.computeSize ? nn.computeSize() : null; } catch (e2) { cs2 = null; }
    nn.setSize([Math.max((cs2 && cs2[0]) || 560, head.size[0]), Math.max((cs2 && cs2[1]) || 430, head.size[1])]);
  } catch (e) { /* 忽略 */ }
  const state = { mode: "model", lpW: 1, lpH: 1, lpKeepOrder: true, kinds: {}, loras: loras };
  try {
    const w = (nn.widgets || []).filter((x) => x && x.name === "状态")[0];
    if (w) w.value = JSON.stringify(state);
  } catch (e) { /* 忽略 */ }
  stash(nn, snaps);
  // 链头那颗的输入来源 = 池子的输入来源（MODEL slot0 / CLIP slot1）
  try {
    const headSnap = snaps[0];
    (headSnap.ins || []).forEach((rec) => {
      if (!rec) return;
      const from = (app.graph._nodes || []).filter((x) => x.id === rec.from)[0];
      if (from && nn.inputs && rec.slot < nn.inputs.length) {
        try { from.connect(rec.fromSlot, nn, rec.slot); } catch (e) { /* 忽略 */ }
      }
    });
  } catch (e) { /* 忽略 */ }
  // 链尾那颗的输出目标 = 池子的输出目标（MODEL slot0 / CLIP slot1 → 原本由链尾喂的那些）
  const tailOuts = snaps[snaps.length - 1].outs || [];
  chain.forEach((n) => { try { app.graph.remove(n); } catch (e) { /* 忽略 */ } });
  // ★ 251 批（他："魔法棒最后一个 Lora 的 CLIP 输出口不会连接"）：
  //   收链时下游插槽上还挂着**指向刚被删掉的 LoRA 的悬空 link** → connect 必然失败。
  //   所以先断开下游那个输入，再接池子。
  const opOut = wandLog();
  tailOuts.forEach((arr, oslot) => (arr || []).forEach((rec) => {
    const to = (app.graph._nodes || []).filter((x) => x.id === rec.to)[0];
    if (!to || !nn.outputs || oslot >= nn.outputs.length) return;
    try { if (to.inputs && to.inputs[rec.toSlot] && to.inputs[rec.toSlot].link != null) to.disconnectInput(rec.toSlot); } catch (e) { /* 忽略 */ }
    try { nn.connect(oslot, to, rec.toSlot); opOut.add("下游接上", { oslot: oslot, to: rec.toSlot, type: to.type }); }
    catch (e) { opOut.add("下游接失败", { oslot: oslot, to: rec.toSlot, err: String(e && e.message) }); }
  }));
  app.graph.setDirtyCanvas(true, true);
  toast("已把 " + chain.length + " 个 LoRA 加载器收成一颗池子（接了 " + tailOuts.reduce(function (a, b) { return a + (b || []).length; }, 0) + " 个下游）—— 再敲一下变回原版");
  return true;
}

// ---- CLIPTextEncode ×2 → 优化节点（成对收）----
function swapPair(node, p) {
  const a = sideOfClipText(node);
  let posNode = a.side === "pos" ? node : (a.side === "neg" ? otherClipText(node, a.ks, 1) : null);
  let negNode = a.side === "neg" ? node : (a.side === "pos" ? otherClipText(node, a.ks, 2) : null);
  // 反查不出来（没接 KSampler）→ 把这一颗当正提示词
  if (!posNode && !negNode) posNode = node;
  const snaps = [];
  if (posNode) snaps.push(snapshot(posNode));
  if (negNode && negNode !== posNode) snaps.push(snapshot(negNode));
  let nn = null;
  try { nn = window.LiteGraph.createNode(p.mod); } catch (e) { nn = null; }
  if (!nn) { toast("本机没有 CLIP 文本编码优化节点"); return false; }
  // ★ 250 批（他："优化节点无论一次敲击还是两次敲击，都会完全把所有提示词数据全部清空"）：
  //   真因 —— `app.graph.add()` 会触发 onNodeCreated → 面板**立刻**按当时（还空着）的 properties 建出来，
  //   之后我才写 pcClip → 界面上永远是空的。修法：**先把 properties 塞好，再 add**。
  try {
    nn.properties = nn.properties || {};
    nn.properties.pcClip = {
      pos: mk((function (nd) { if (!nd) return ""; const w = (nd.widgets || [])[0]; if (w && w.value != null && String(w.value) !== "") return String(w.value); const q = nd.properties && nd.properties.pcClip; return (q && q.pos && q.pos.v) || String((nd.widgets_values || [])[0] || ""); })(posNode), posNode),
      neg: mk((function (nd) { if (!nd) return ""; const w = (nd.widgets || [])[0]; if (w && w.value != null && String(w.value) !== "") return String(w.value); const q = nd.properties && nd.properties.pcClip; return (q && q.neg && q.neg.v) || String((nd.widgets_values || [])[0] || ""); })(negNode), negNode),
      comp: (function () {
        let acc = [];
        try {
          [posNode, negNode].forEach(function (nd) {
            const q = nd && nd.properties && nd.properties.pcClip;
            if (q && Array.isArray(q.comp)) acc = acc.concat(q.comp);
          });
        } catch (e) { /* 忽略 */ }
        return acc;
      })(),
    };
    const fix = (side) => {
      const o = nn.properties.pcClip[side];
      if (o && o.v) o.r = [{ s: 0, e: o.v.length, off: false }];
    };
    fix("pos"); fix("neg");
  } catch (e) { log("预设 pcClip 失败", e); }
  app.graph.add(nn);
  // ★ 250 批：add 之后面板才建出来 —— 但面板建好时**不会**去读我们刚塞进去的 pcClip，
  //   所以界面上文本框是空的（properties 里其实有）。这里等一拍，把值补进界面。
  // ★ 250 批：`graph.add` 是同步的（onNodeCreated 也同步跑完）→ **立刻**就能写；
  //   再补一个 150ms 的兜底（有些路径面板是异步建的）。
  var pcPairFill = function () {
    try {
      const panel = nn.__pcPanel || document;
      ["pos", "neg"].forEach(function (side) {
        const sec = panel.querySelector('[data-pcside="' + side + '"]');
        const ta = sec ? sec.querySelector("textarea") : null;
        const q2 = nn.properties && nn.properties.pcClip;
        const v = q2 && q2[side] ? String(q2[side].v || "") : "";
        if (ta && !ta.value && v) {
          ta.value = v;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    } catch (e) { /* 忽略 */ }
  };
  pcPairFill();
  setTimeout(pcPairFill, 150);
  setTimeout(pcPairFill, 450);
  try {
    const base = posNode || negNode;
    nn.pos = [base.pos[0], base.pos[1]];
    nn.setSize([Math.max(620, base.size[0]), Math.max(320, base.size[1])]);
  } catch (e) { /* 忽略 */ }
  const textOf = (nd) => {
    if (!nd) return "";
    const w = (nd.widgets || [])[0];
    if (w && w.value != null) return String(w.value);
    return String((nd.widgets_values || [])[0] || "");
  };
  // ★ 251 批（他："优化节点无论一次敲击还是两次敲击，都会完全使所有提示词数据全部清空"）：
  //   最可能是**这里根本没读到文本**（结构和我假设的不一样）→ 于是把空字符串写进 properties = 清空。
  //   改成：① 多重兜底读（widgets / widgets_values / 面板里的 textarea / 原 properties）
  //         ② **两边都读不到就干脆不转换**，只提示，绝不用空值覆盖。
  const readText = (nd) => {
    if (!nd) return "";
    const w = (nd.widgets || [])[0];
    if (w && w.value != null && String(w.value) !== "") return String(w.value);
    const vv = (nd.widgets_values || [])[0];
    if (vv != null && String(vv) !== "") return String(vv);
    const q = nd.properties && nd.properties.pcClip;
    if (q && q.pos && q.pos.v) return String(q.pos.v);
    try {
      const ta = (nd.__pcPanel || document).querySelector("[data-pcside] textarea");
      if (ta && ta.value) return String(ta.value);
    } catch (e) { /* 忽略 */ }
    return "";
  };
  const opPair = wandLog();
  const posText = readText(posNode);
  const negText = readText(negNode);
  opPair.add("读文本", { posNode: posNode ? typeOf(posNode) : null, negNode: negNode ? typeOf(negNode) : null, posLen: posText.length, negLen: negText.length });
  if (!posText && !negText) {
    toast("读不到这两颗节点的提示词，先不转换（不然会把它清空）\n—— 你是不是没接 KSampler？正/负编码要分别接在 KSampler 的 positive / negative 上");
    return false;
  }
  // ★ 252 批（他："包括暗淡的小胶囊、亮着的小胶囊"）：原来 chips 硬写 [] → 转换时把胶囊整批清空。
  //   改成把原来那颗节点自己的 chips / chipNames 搬过来。
  const chipsOf = (nd) => {
    try {
      const q = nd && nd.properties && nd.properties.pcClip;
      if (q && q.pos && Array.isArray(q.pos.chips) && q.pos.chips.length) return q.pos.chips;
    } catch (e) { /* 忽略 */ }
    return [];
  };
  const mk = (v, oldNode) => ({
    v: v,
    r: v ? [{ s: 0, e: v.length, off: false }] : [],
    chips: chipsOf(oldNode),
    chipNames: (function () {
      try { const q = oldNode && oldNode.properties && oldNode.properties.pcClip; return (q && q.pos && q.pos.chipNames) || {}; } catch (e) { return {}; }
    })(),
    h: 80, w: 0,
  });
  try {
    nn.properties = nn.properties || {};
        // ★ 249 批（他："小胶囊亮的暗的也都没了"）：原来这里硬写 `comp: []`，把伴随位整片清空。
    //   现在从原来那两颗编码节点上把它们自己的 pcClip.comp 搬过来（没有才空）。
    var oldComp = [];
    try {
      [posNode, negNode].forEach(function (nd) {
        var q = nd && nd.properties && nd.properties.pcClip;
        if (q && Array.isArray(q.comp)) oldComp = oldComp.concat(q.comp);
      });
    } catch (e) { /* 忽略 */ }
    nn.properties.pcClip = Object.assign({}, nn.properties.pcClip, { pos: mk(posText), neg: mk(negText), comp: oldComp });
    delete nn.properties.pcClip.__v;      // 让 sideOf 自己规整一次
  } catch (e) { /* 忽略 */ }
  stash(nn, snaps);
  // clip 输入 ← 原来那颗的 clip 来源
  try {
    const srcSnap = snaps[0];
    (srcSnap.ins || []).forEach((rec) => {
      if (!rec) return;
      const from = (app.graph._nodes || []).filter((x) => x.id === rec.from)[0];
      if (from && nn.inputs && rec.slot < nn.inputs.length) {
        try { from.connect(rec.fromSlot, nn, rec.slot); } catch (e) { /* 忽略 */ }
      }
    });
  } catch (e) { /* 忽略 */ }
  // 下游：正向输出(0) ← 正那颗的 CONDITIONING 目标；负向(1) ← 负那颗的
  const posOuts = (posNode ? snapshot(posNode).outs : []) || [];
  const negOuts = (negNode ? snapshot(negNode).outs : []) || [];
  snaps.forEach((s) => {
    const n2 = (app.graph._nodes || []).filter((x) => x.id === (s === snaps[0] && posNode ? posNode.id : (negNode ? negNode.id : null)))[0];
    if (n2) { try { app.graph.remove(n2); } catch (e) { /* 忽略 */ } }
  });
  const wire = (outs, oslot) => (outs[0] || []).forEach((rec) => {
    const to = (app.graph._nodes || []).filter((x) => x.id === rec.to)[0];
    if (to && nn.outputs && oslot < nn.outputs.length) {
      try { nn.connect(oslot, to, rec.toSlot); } catch (e) { /* 忽略 */ }
    }
  });
  wire(posOuts, 0);
  wire(negOuts, 1);
  app.graph.setDirtyCanvas(true, true);
  toast("已收成一颗优化节点" + (negNode ? "（正+负两颗一起）" : "") + " —— 再敲一下变回原版");
  return true;
}

// ---------------------------------------------------------------- 工具栏那一行（和橡皮同款）
// ★ 版本号（写在这一行上）—— 他刷新后一眼就能看出加载的是新代码还是缓存里的老代码
// ★ 254 批（他："不纠结了，雪藏魔法棒，但是不要删除，万一有用呢"）
//   === 雪藏开关 ===
//   改回 true 就能原样恢复（工具栏那一行会出现、拖拽也能用）。
//   代码、快照逻辑、诊断口 window.__pcWand / __pcWandLogs 全部保留，一行没删。
const WAND_ENABLED = false;

const WAND_VER = "252";

function makeRow() {
  if (!WAND_ENABLED) return null;          // ★ 雪藏：工具栏不出现这一行
  const w = {
    type: "pcText", name: "pcWandRow", value: null, y: 0, height: 20, last_y: 0,
    serialize: false, options: { serialize: false }, hidden: false,
    computeSize: function (width) { return [width || 200, 20]; },
    onClick: function () { /* 只靠拖 */ },
    draw: function (ctx, node, width, y, H) {
      try {
        ctx.save();
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(186, 148, 255, 0.98)";
        ctx.fillText("🪄 魔法棒 v" + WAND_VER + "：按住这一行，拖到节点上松手（再拖一次 = 变回原版）", 15, y + H * 0.55);
        ctx.restore();
      } catch (e) { /* 忽略 */ }
    },
    mouse: function (ev) {
      const t = ev && ev.type;
      if (t === "pointerdown" || t === "mousedown") return startDrag(ev);
      return false;
    },
  };
  w.__pcWandRow = true;
  return w;
}

// ★ 247 批（他："魔法棒根本拖不动"）：
//   真因 —— 我只给控件挂了 `w.mouse`，而那是**兜底路径**：前端 `processWidgetClick` 的
//   `else if (n.mouse)` 分支不一定走到（橡皮当初也栽在这，见 prompt_toolbar.js 那段长注释）。
//   橡皮真正接住按下的是 **window 捕获阶段 + 几何命中**（`onEraseDownCapture` / `eraserHitAt`）。
//   魔法棒现在照同一套做：捕获阶段算落点在不在"魔法棒那一行"，在就开始拖。
function toGraphPos(ev) {
  try {
    const c = app && app.canvas;
    if (!c || !c.canvas) return null;
    const r = c.canvas.getBoundingClientRect();
    const ds = c.ds || { scale: 1, offset: [0, 0] };
    return [(ev.clientX - r.left) / ds.scale - ds.offset[0], (ev.clientY - r.top) / ds.scale - ds.offset[1]];
  } catch (e) { return null; }
}
function wandRowOf(node, pos) {
  if (!node || !pos || !node.widgets) return null;
  for (const x of node.widgets) {
    if (!x || !x.__pcWandRow || typeof x.last_y !== "number") continue;
    if (pos[1] >= x.last_y - 3 && pos[1] <= x.last_y + 23) return x;
  }
  return null;
}
function wandHitAt(ev) {
  const p = toGraphPos(ev);
  if (!p) return null;
  const nodes = (app.graph && app.graph._nodes) || [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n || !n.widgets || !n.size) continue;
    if (n.flags && n.flags.collapsed) continue;
    const lx = p[0] - n.pos[0], ly = p[1] - n.pos[1];
    if (lx < 0 || lx > n.size[0] || ly < 0 || ly > n.size[1]) continue;
    const x = wandRowOf(n, [lx, ly]);
    if (x) return { node: n, w: x };
  }
  return null;
}
function onWandDownCapture(ev) {
  if (!WAND_ENABLED) return;               // ★ 雪藏：不响应按下
  try {
    if (dragging) return;
    if (ev && ev.button != null && ev.button !== 0) return;
    const hit = wandHitAt(ev);
    if (!hit) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    if (typeof ev.stopPropagation === "function") ev.stopPropagation();
    startDrag(ev);
  } catch (e) { /* 忽略 */ }
}
function hookWandPress() {
  try {
    if (window.__pcWandPressHooked) return false;
    window.__pcWandPressHooked = true;
    window.addEventListener("pointerdown", onWandDownCapture, true);
    return true;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- 拖拽
let dragging = null;
function startDrag(ev) {
  if (dragging) return true;
  const g = document.createElement("div");
  g.textContent = "🪄";
  g.style.cssText = "position:fixed;z-index:100099;pointer-events:none;font-size:26px;line-height:1;"
    + "filter:drop-shadow(0 3px 8px rgba(0,0,0,.65));transform:translate(-50%,-50%)";
  g.style.left = ev.clientX + "px";
  g.style.top = ev.clientY + "px";
  document.body.appendChild(g);
  dragging = { el: g };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  try { document.body.style.cursor = "grabbing"; } catch (e) { /* 忽略 */ }
  return true;
}
function onMove(ev) {
  if (!dragging || !dragging.el) return;
  dragging.el.style.left = ev.clientX + "px";
  dragging.el.style.top = ev.clientY + "px";
  // 高亮光标下的节点（简单做法：给它加一圈描边）
  try {
    const n = nodeAt(ev);
    if (dragging.hot && dragging.hot !== n) clearHot(dragging.hot);
    if (n && n !== dragging.hot) { setHot(n); dragging.hot = n; }
  } catch (e) { /* 忽略 */ }
  try { if (typeof ev.preventDefault === "function") ev.preventDefault(); } catch (e) { /* 忽略 */ }
}
function setHot(n) {
  try { n.__pcWandOldBorder = n.boxcolor; n.boxcolor = "#ba94ff"; n.color = n.color; } catch (e) { /* 忽略 */ }
}
function clearHot(n) {
  try { n.boxcolor = n.__pcWandOldBorder; } catch (e) { /* 忽略 */ }
}
function onUp(ev) {
  if (!dragging) return;
  window.removeEventListener("pointermove", onMove, true);
  window.removeEventListener("pointerup", onUp, true);
  try { if (dragging.el) dragging.el.remove(); } catch (e) { /* 忽略 */ }
  try { document.body.style.cursor = ""; } catch (e) { /* 忽略 */ }
  if (dragging.hot) clearHot(dragging.hot);
  const hot = dragging.hot;
  dragging = null;
  const n = hot || nodeAt(ev);
  if (!n) { toast("没落在节点上 —— 要把魔法棒拖到节点身上再松手"); return; }
  if (n.__pcWandRow || String(n.type || "").indexOf("Toolbar") >= 0) { toast("魔法棒不能敲工具栏自己"); return; }
  try { wandTap(n); } catch (e) { log("魔法棒出错", e); toast("魔法棒出错了：" + (e && e.message)); }
}

// ---------------------------------------------------------------- 挂到工具栏（第 4 项，和橡皮同一处）
function attachToToolbar(node) {
  try {
    if (!node || node.__pcWandAttached) return false;
    // 已经有 pcWandRow 就不用再加（toolbar 那边可能先挂上了）
    if ((node.widgets || []).some((x) => x && (x.name === "pcWandRow" || x.__pcWandRow))) { node.__pcWandAttached = true; return false; }
    node.__pcWandAttached = true;
    node.addCustomWidget(makeRow());
  hookWandPress();                       // ★ 247 批：捕获阶段接住按下（和橡皮同一套）
  hookPoolMenu();                        // ★ 249 批：池子的「按名单补全」右键
    try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
    log("魔法棒已挂上工具栏");
    return true;
  } catch (e) { log("挂 toolbar 失败", e); return false; }
}
function tryAttachAll() {
  try {
    const nodes = (app.graph && app.graph._nodes) || [];
    nodes.forEach((n) => {
      if (n && String(n.type || "") === "PromptToolToolbar") attachToToolbar(n);
    });
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 测试口
window.__pcWand = {
  makeRow: makeRow,
  rowOf: wandRowOf,
  hitAt: wandHitAt,
  hookPress: hookWandPress,
  startDragAt: function (ev) { return startDrag(ev); },
  attach: tryAttachAll,
  tap: (n) => wandTap(n),
  hasStash: (n) => !!stashOf(n),
  stash: (n) => { const s = stashOf(n); return s ? s.before.map((x) => x.type) : null; },
  snapshot: snapshot,
  nodeAt: nodeAt,
  pairs: () => PAIRS.map((p) => ({ mod: p.mod, orig: p.orig, mode: p.mode })),
  drop: (fromNode) => wandTap(fromNode),
};

app.registerExtension({
  name: "PromptTool.Wand",
  async setup() {
    setTimeout(tryAttachAll, 900);
    setTimeout(tryAttachAll, 2600);   // 工具栏节点可能晚一点才建出来
  },
  nodeCreated(node) {
    if (node && String(node.type || "") === "PromptToolToolbar") setTimeout(() => attachToToolbar(node), 120);
  },
});

log("已就绪（魔法棒）");
