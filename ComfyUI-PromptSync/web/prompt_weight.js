// 关键词权重（批 C3 第一百零五批 / 第一百零六批改成正负两张表）—— 这个文件装两块东西：
//   ① 「CLIP 文本编码优化节点」上的两颗按钮打开的**权重表面板**：
//      「⚖ 调整正关键词权重」（挂在**中间**，两个文本框之间）+「⚖ 调整负关键词权重」（挂在**下边**那排键里）
//   ② 从面板里叫出来的**横长条附属节点**「关键词权重（附属节点）」（类名 PromptToolClipWeight）
//
// 他的原话（规格全在这两段里）：
//   ·（第一百零五批）「优化节点右下方加一个『调整关键词权重』的按钮，点击之后，会显示当前没有关键词，
//     需要你自己填」「填了对应词之后，关键词就会保留……这时候点击就会让你选新建新的关键词，还是调出已有关键词」
//     「会叫出一个**横长条状的附属节点**，上面有关键词的**权重示数**，还有一个**横圆形滑块**，按圆形滑块
//     左右拖，就会以**最小刻度 0.05** 的方式调整」「**附属节点不和任何节点连接**，也不会改变优化节点的
//     文本内容，但是确实可以改变其输出的内容」
//   ·（第一百零六批）「权重调整应该是一个**横条，中间一个小圆钮**左右拖动调整权重，当然也可以**手动输入数值**」
//     「权重从一个『调整关键词权重』改成『**调整正关键词权重**』『**调整负关键词权重**』，而且一个放在**中间**
//     一个放在**下边**，这样就可以**单独调整**拉出正关键词和负关键词的权重了，记得拉出的节点要有**正负之分**」
//
// ⚠️ 三处"真值"只有一份：**优化节点 properties.pcClip.weightsPos / weightsNeg**（{词: 权重}，跟着工作流走）。
//    附属节点只是它的一个"编辑器"；优化节点里那两条**藏起来的** `正权重表` / `负权重表` JSON 控件
//    是给后端 encode 看的镜像（收起时两条都写空 —— 不然"收起 = 不参与作图"会被这些词破坏）。

// ⚠️⚠️ 2026-10-06 第一百零八批的**血泪根因**：这个文件原来**没有 import app**（全靠全局 `app`），
//   而 ComfyUI 加载扩展 js 的时候 `window.app` 还没挂上 → 文件最后那句 `app.registerExtension(...)`
//   当场 `ReferenceError: app is not defined` → **整个扩展没注册**（自测钩子都在、横杆却永远不挂）。
//   本包其它文件（prompt_clip.js / prompt_timer.js / …）本来就 import 了，只有这个漏了。
import { app } from "../../scripts/app.js";

const CLIP_TYPE = "PromptToolClipSegments";
const WEIGHT_TYPE = "PromptToolClipWeight";
const PROP = "pcClip";             // 优化节点那颗上的状态包（和 prompt_clip.js 共用同一个键）
const WPROP = "pcWeight";          // 附属节点自己：{clip: <优化节点 id>, side: "pos"|"neg", word: "词"，
                                   //   title: "他自己改过的名字（有就显示它）"、auto: "我们最后一次画的自动名"}
const SIDES = {
  pos: { key: "weightsPos", widget: "正权重表", name: "正", cls: "pos", color: "#6eaaff" },
  neg: { key: "weightsNeg", widget: "负权重表", name: "负", cls: "neg", color: "#f08c8c" },
};
const OLD_KEY = "weights";         // 第一百零五批那版的单表 → 迁移成正表（那时它是"只加到正提示词"的那张）
const W_MIN = 0.05;
const W_MAX = 2.0;
const W_STEP = 0.05;
const W_DEF = 1.0;
const W_WORD_MAX = 80;             // 单个词最长这么多字符（和后端一致）
const W_NODE_W = 470;              // 附属节点 = 横长条
const W_NODE_H = 62;

function log(...args) { console.log("[关键词权重]", ...args); }

function roundW(v) {
  var n = Number(v);
  if (!isFinite(n)) n = W_DEF;
  n = Math.round(n / W_STEP) * W_STEP;
  n = Math.min(W_MAX, Math.max(W_MIN, n));
  return Math.round(n * 100) / 100;
}
function fmtW(v) {
  var n = roundW(v);
  return (Math.abs(n - Math.round(n)) < 1e-9) ? String(Math.round(n)) : String(n);
}
function el(tag, cls, text) {
  var d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
function sideOf(side) { return SIDES[side] || SIDES.pos; }
function allNodes() {
  try {
    var g = app.graph;
    if (g && Array.isArray(g._nodes)) return g._nodes;
    if (g && Array.isArray(g.nodes)) return g.nodes;
    return [];
  } catch (e) { return []; }
}
function nodeById(id) {
  if (id == null || id === "") return null;
  var list = allNodes();
  for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) return list[i]; }
  return null;
}
function isType(n, t) { return !!n && (n.type === t || n.comfyClass === t); }
function isClipNode(n) { return isType(n, CLIP_TYPE); }
function isWeightNode(n) { return isType(n, WEIGHT_TYPE); }
// 模块作用域是隔离的（每个 js 都是独立模块）→ 这两个小工具在这里留一份自己的
function textWidget(node, name) {
  var ws = node && node.widgets;
  if (!Array.isArray(ws)) return null;
  for (var i = 0; i < ws.length; i++) { if (ws[i] && ws[i].name === name) return ws[i]; }
  return null;
}
function writeWidget(w, val) {
  if (!w) return;
  try {
    w.value = val;
    if (typeof w.callback === "function") w.callback(val);
    if (w.inputEl && "value" in w.inputEl) w.inputEl.value = val;
    if (w.element && typeof w.element.querySelector === "function") {
      var inp = w.element.querySelector("input,textarea");
      if (inp) inp.value = val;
    }
  } catch (e) { /* 忽略 */ }
}
function redrawCanvas(node) {
  try { if (app.graph && typeof app.graph.setDirtyCanvas === "function") app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
  try { if (app.canvas && typeof app.canvas.setDirty === "function") app.canvas.setDirty(true, true); } catch (e) { /* 忽略 */ }
  try { if (node && typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 真值：优化节点上正/负两张表
function weightsOf(clip, side) {
  var out = {};
  try {
    var p = clip && clip.properties && clip.properties[PROP];
    if (!p || typeof p !== "object") return out;
    if (side === "pos" && p[OLD_KEY] && !p[SIDES.pos.key]) {      // 老的单表 → 正表
      p[SIDES.pos.key] = p[OLD_KEY];
      try { delete p[OLD_KEY]; } catch (e0) { /* 忽略 */ }
    }
    var ws = p[sideOf(side).key];
    if (ws && typeof ws === "object") {
      Object.keys(ws).forEach(function (k) {
        var word = String(k == null ? "" : k).trim();
        if (!word || word.length > W_WORD_MAX || (word in out)) return;
        out[word] = roundW(ws[k]);
      });
    }
  } catch (e) { /* 忽略 */ }
  return out;
}
function mirror(clip) {
  // 把两张表分别写成 JSON 塞进那两条藏起来的控件（后端 encode 读它们）；**收起时两条都写空**
  var collapsed = !!(clip.flags && clip.flags.collapsed);
  ["pos", "neg"].forEach(function (side) {
    var w = textWidget(clip, sideOf(side).widget);
    if (!w) return;
    try { writeWidget(w, collapsed ? "" : JSON.stringify(weightsOf(clip, side))); } catch (e) { /* 忽略 */ }
  });
}
function setWeights(clip, side, obj) {
  if (!clip) return;
  if (!clip.properties) clip.properties = {};
  var p = clip.properties[PROP];
  if (!p || typeof p !== "object") p = {};
  var clean = {};
  Object.keys(obj || {}).forEach(function (k) {
    var word = String(k == null ? "" : k).trim();
    if (!word || word.length > W_WORD_MAX || (word in clean)) return;
    clean[word] = roundW(obj[k]);
  });
  p[sideOf(side).key] = clean;
  clip.properties[PROP] = p;
  mirror(clip);
  weightNodesOf(clip, side).forEach(function (n) { syncWeightNode(n); });
  redrawCanvas(clip);
}

// ---------------------------------------------------------------- 附属节点（横长条）
function infoOf(node) {
  var info = node && node.properties && node.properties[WPROP];
  return (info && typeof info === "object") ? info : null;
}
// ★ 第一百四十六批（他第 1 条，原话）：「权重附属节点要么存在，要么不存在，没有隐藏化的选项，
//   应该改成**附属节点如果关闭，那就说明已经隐藏化了，重新叫出来才是要使用的情况**，同时叫出来的节点
//   再加一个隐藏化的键，**同样是减号小圆钮，点一下透明度降低为 50%，再点一下恢复原样**」
// → 状态记在节点自己的 `properties.pcWeight.hidden`（跟着工作流走）：
//   · **隐藏化 = 整颗节点 + 那条横杆一起半透明（50%）**，词和权重一个都不动（附属节点只是编辑器）；
//   · 那颗「− / ＋」小圆钮就长在横杆最左边（跟胶囊上那颗一个意思）；
//   · 从优化节点的面板再点「调出附属节点」把它**重新叫出来** = 自动取消隐藏（这才是"要使用它"）。
function isHiddenW(node) { var i = infoOf(node); return !!(i && i.hidden); }
function applyHiddenLook(node) {
  var on = isHiddenW(node);
  try { node.__pcWHidden = on; } catch (e) { /* 忽略 */ }
  try {
    var bar = node && node.__pcBar;
    if (bar && bar.row) { var o = on ? "0.5" : "1"; if (bar.row.style.opacity !== o) bar.row.style.opacity = o; }
    if (bar && bar.hide) {
      var t = on ? "＋" : "−";
      if (bar.hide.textContent !== t) bar.hide.textContent = t;
      var cls = "pcwt-hide" + (on ? " on" : "");
      if (bar.hide.className !== cls) bar.hide.className = cls;
    }
  } catch (e) { /* 忽略 */ }
}
function setHiddenW(node, on) {
  var i = infoOf(node);
  if (!i) return false;
  i.hidden = !!on;
  applyHiddenLook(node);
  redrawCanvas(node);
  log(i.hidden ? "附属节点已隐藏化（半透明，权重照旧）" : "附属节点恢复显示", node.id);
  return i.hidden;
}
// 画布上那颗节点的 50%：包一层画布的 drawNode（只动我们这颗，别人的节点一个像素都不碰）
let __pcWDrawHooked = false;
function hookDrawNode() {
  if (__pcWDrawHooked) return false;
  try {
    const C = (app && app.canvas && app.canvas.constructor && app.canvas.constructor.prototype) || null;
    if (!C || typeof C.drawNode !== "function") return false;
    __pcWDrawHooked = true;
    const orig = C.drawNode;
    C.drawNode = function (node, ctx) {
      if (!node || !node.__pcWHidden || !ctx) return orig.apply(this, arguments);
      ctx.save();
      try { ctx.globalAlpha = (ctx.globalAlpha == null ? 1 : ctx.globalAlpha) * 0.5; } catch (e) { /* 忽略 */ }
      const r = orig.apply(this, arguments);
      try { ctx.restore(); } catch (e) { /* 忽略 */ }
      return r;
    };
    return true;
  } catch (e) { return false; }
}
function nodeSide(node) {
  var info = infoOf(node);
  return (info && info.side === "neg") ? "neg" : "pos";
}
function weightNodesOf(clip, side) {
  if (!clip) return [];
  return allNodes().filter(function (n) {
    if (!isType(n, WEIGHT_TYPE)) return false;
    var info = infoOf(n);
    if (!info || String(info.clip) !== String(clip.id)) return false;
    return (side == null) || (String(info.side || "pos") === String(side));
  });
}
function widgetW(node) {
  var w = textWidget(node, "权重");
  return w ? roundW(w.value) : W_DEF;
}
function setWidgetW(node, v) {
  var w = textWidget(node, "权重");
  if (!w) return;
  var nv = roundW(v);
  if (Number(w.value) === nv) return;
  try {
    w.value = nv;
    if (w.inputEl && "value" in w.inputEl) w.inputEl.value = String(nv);
  } catch (e) { /* 忽略 */ }
}
// 他第一百三十七批第 1 条（原话）：「权重节点名称改了之后，再叫一次相同的节点把节点叫出来，改过的名称也要保留，
//   刷新也不要刷掉」→ 原来这里每同步一次就把标题**重画成自动名**（带词的那一串），于是
//   ① 他改过的名字在刷新（读工作流 → onConfigure → 同步）时被打回原形；
//   ② 那条横杆删掉、再从面板「调出附属节点」叫回来，名字也没了。
// 现在：**他改过的名字优先**，存两处 —— 节点自己的 `properties.pcWeight.title`（跟着工作流走）+
//   优化节点 `properties.pcClip.titles["侧|词"]`（同一个词再叫出来时也想得起来）；`info.auto` 记着
//   "我们最后一次画的自动名"，拿它跟当前标题一比就知道他自己动没动过（改成空 = 恢复自动名）。
function autoTitleOf(node) {
  var info = infoOf(node);
  var word = info ? String(info.word || "") : "";
  var sd = sideOf(nodeSide(node));
  // ★ 182 批⑤：标题里显示的「…」优先用**别名**（他："哪知道哪个是哪个啊"），没设别名就还是真词
  var show = aliasOfNode(node) || word;
  return show ? ("⚖ " + sd.name + "关键词权重 · 「" + show + "」")
    : ("⚖ 关键词权重（从优化节点的「调整" + sd.name + "关键词权重」叫出来）");
}
function titleKeyOf(node) {
  var info = infoOf(node);
  if (!info) return "";
  return String(info.side || "pos") + "|" + String(info.word || "");
}
// 优化节点上那张"名字表"（和正/负权重表并排，一样跟着工作流走）
function titleBagOf(clip) {
  try {
    var p = clip && clip.properties && clip.properties[PROP];
    if (!p || typeof p !== "object") return null;
    if (!p.titles || typeof p.titles !== "object") p.titles = {};
    return p.titles;
  } catch (e) { return null; }
}
function customTitleOf(node) {
  var info = infoOf(node);
  if (info && typeof info.title === "string" && info.title.trim()) return info.title.trim();
  var bag = titleBagOf(info ? nodeById(info.clip) : null);
  var k = titleKeyOf(node);
  var t = (bag && k && bag[k]) ? String(bag[k]).trim() : "";
  return t;
}
function rememberTitle(node, t) {          // t 给空串 = 恢复自动名
  var info = infoOf(node);
  if (!info) return;
  var clean = String(t == null ? "" : t).trim();
  try {
    if (clean) info.title = clean;
    else if (info.title) delete info.title;
    var bag = titleBagOf(nodeById(info.clip));
    var k = titleKeyOf(node);
    if (bag && k) {
      if (clean) bag[k] = clean;
      else if (bag[k]) delete bag[k];
    }
  } catch (e) { /* 忽略 */ }
}
function syncTitle(node) {
  var info = infoOf(node);
  if (!info) return;
  var cur = String(node.title == null ? "" : node.title).trim();
  var auto = String(info.auto == null ? "" : info.auto).trim();
  var custom = customTitleOf(node);
  // ① 当前标题既不是我们画的自动名、也不是记着的那个名字 → 是他自己改的（或改成空 = 恢复自动名）
  if (auto && cur !== auto && cur !== custom) rememberTitle(node, cur);
  // ② 该显示的名字：他改过的 > 名字表里记着的 > 自动名
  var mine = (typeof info.title === "string" && info.title.trim()) ? info.title.trim() : "";
  var want = mine || customTitleOf(node) || autoTitleOf(node);
  if (cur !== want) { try { node.title = want; } catch (e) { /* 忽略 */ } }
  info.auto = autoTitleOf(node);
}
function paintTitle(node) { syncTitle(node); }
// 面板上那颗小圆钮 / 数值框的位置（按值算，0.05 一格）
function knobPos(v) { return (roundW(v) - W_MIN) / (W_MAX - W_MIN); }
function valueAt(frac) { return roundW(W_MIN + Math.min(1, Math.max(0, frac)) * (W_MAX - W_MIN)); }

// 横条 + 中间小圆钮 + 右边的数值框（他第一百零六批要的形态）
function buildBar(node) {
  var row = el("div", "pcwt");
  var tag = el("span", "pcwt-side " + sideOf(nodeSide(node)).cls, sideOf(nodeSide(node)).name);
  var word = el("span", "pcwt-word", "");
  var track = el("span", "pcwt-track");
  var knob = el("span", "pcwt-knob");
  track.appendChild(knob);
  var num = document.createElement("input");
  num.type = "number";
  num.className = "pcwt-num";
  num.step = String(W_STEP);
  num.min = String(W_MIN);
  num.max = String(W_MAX);
  num.spellcheck = false;
  // ★ 第一百四十六批（他第 1 条）：**隐藏化那颗小圆钮**（跟胶囊上那颗 −/＋ 一个样子，长在横杆最左边）
  var hide = el("button", "pcwt-hide", "−");
  hide.type = "button";
  hide.title = "隐藏化：点一下这颗附属节点变半透明（收起来不占眼睛，词和权重一点不动）；再点一下恢复原样。"
    + "从优化节点的面板再点「调出附属节点」也会把它恢复出来。";
  hide.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    setHiddenW(node, !isHiddenW(node));
  });
  row.appendChild(hide); row.appendChild(tag); row.appendChild(word); row.appendChild(track); row.appendChild(num);
  node.__pcBar = { row: row, tag: tag, word: word, track: track, knob: knob, num: num, hide: hide, dragging: false };

  function paint() {
    var info = infoOf(node) || {};
    word.textContent = String(info.word || "（还没有词）");
    var clip = nodeById(info.clip);
    var ws = clip ? weightsOf(clip, nodeSide(node)) : {};
    var w = Object.prototype.hasOwnProperty.call(ws, String(info.word || "")) ? ws[String(info.word || "")] : widgetW(node);
    knob.style.left = (knobPos(w) * 100).toFixed(2) + "%";
    num.value = fmtW(w);
    tag.textContent = sideOf(nodeSide(node)).name;
    tag.className = "pcwt-side " + sideOf(nodeSide(node)).cls;
    applyHiddenLook(node);                        // 半透明那一下也跟着一起画
  }
  node.__pcBarPaint = paint;

  function commit(v) {
    var nv = roundW(v);
    var info = infoOf(node);
    setWidgetW(node, nv);
    if (info) {
      var clip = nodeById(info.clip);
      if (clip && String(info.word || "")) {
        var ws = weightsOf(clip, nodeSide(node));
        ws[String(info.word)] = nv;
        setWeights(clip, nodeSide(node), ws);
      }
    }
    paint();
  }
  node.__pcCommitW = commit;

  function fromEvent(e) {
    var r = track.getBoundingClientRect();
    if (!r.width) return;
    commit(valueAt((e.clientX - r.left) / r.width));
  }
  ["pointerdown", "mousedown"].forEach(function (ev) {
    track.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      node.__pcBar.dragging = true;
      try { track.setPointerCapture && track.setPointerCapture(e.pointerId); } catch (e2) { /* 忽略 */ }
      fromEvent(e);
    });
    knob.addEventListener(ev, function (e) { e.preventDefault(); });   // 别拦着，让它冒到 track 上起拖
  });
  track.addEventListener("pointermove", function (e) {
    if (!node.__pcBar.dragging) return;
    e.preventDefault(); e.stopPropagation();
    fromEvent(e);
  });
  ["pointerup", "pointercancel", "mouseup"].forEach(function (ev) {
    track.addEventListener(ev, function () { node.__pcBar.dragging = false; });
    document.addEventListener(ev, function () { if (node.__pcBar) node.__pcBar.dragging = false; });
  });
  // 方向键/滚轮微调（0.05 一格），跟拖圆钮等价
  track.addEventListener("wheel", function (e) {
    e.preventDefault(); e.stopPropagation();
    commit(widgetW(node) + (e.deltaY < 0 ? W_STEP : -W_STEP));
  }, { passive: false });
  // 手动输入数值（他明确要的）
  ["change", "blur"].forEach(function (ev) {
    num.addEventListener(ev, function () { commit(num.value); });
  });
  ["keydown", "keyup", "keypress", "pointerdown", "mousedown", "dblclick", "contextmenu"].forEach(function (ev) {
    num.addEventListener(ev, function (e) { e.stopPropagation(); });
  });
  paint();
  return row;
}
// 让附属节点显示表里的值（**表是准的**；表里没有这个词就把它自己这个值补回表里）
function syncWeightNode(node) {
  var info = infoOf(node);
  if (!info) return;
  var clip = nodeById(info.clip);
  var word = String(info.word || "");
  if (!clip || !word) { paintTitle(node); if (node.__pcBarPaint) node.__pcBarPaint(); return; }
  var side = nodeSide(node);
  var ws = weightsOf(clip, side);
  if (!Object.prototype.hasOwnProperty.call(ws, word)) {
    if (!node.__pcWSeed) {
      node.__pcWSeed = true;                       // 防"写表 → 同步 → 又写表"来回打转
      try {
        var add = weightsOf(clip, side);
        add[word] = widgetW(node);
        setWeights(clip, side, add);
      } finally { node.__pcWSeed = false; }
    }
    paintTitle(node);
    if (node.__pcBarPaint) node.__pcBarPaint();
    return;
  }
  setWidgetW(node, ws[word]);
  paintTitle(node);
  if (node.__pcBarPaint) node.__pcBarPaint();
}
function openWeightNode(clip, side, word) {
  if (!clip || !word) return null;
  var want = String(word);
  var found = weightNodesOf(clip, side).filter(function (n) {
    var i2 = infoOf(n);
    return !!i2 && String(i2.word || "") === want;
  })[0];
  if (found) {                                     // 已经叫出来过 → 选中它，不重复叫
    // ★ 第一百四十六批（他第 1 条）：重新叫出来 = **要使用它** → 隐藏化的自动恢复显示
    try { if (isHiddenW(found)) setHiddenW(found, false); } catch (e) { /* 忽略 */ }
    try { if (app.canvas && typeof app.canvas.selectNode === "function") app.canvas.selectNode(found); } catch (e) { /* 忽略 */ }
    redrawCanvas(found);
    return found;
  }
  var node = null;
  try { node = (window.LiteGraph && typeof LiteGraph.createNode === "function") ? LiteGraph.createNode(WEIGHT_TYPE) : null; } catch (e) { node = null; }
  if (!node) { log("叫不出附属节点（这个前端没有 LiteGraph.createNode）"); return null; }
  if (!node.properties) node.properties = {};
  node.properties[WPROP] = { clip: clip.id, side: (side === "neg" ? "neg" : "pos"), word: want };
  var ws = weightsOf(clip, side);
  if (Array.isArray(node.widgets)) {
    node.widgets.forEach(function (w) {
      if (!w) return;
      if (w.name === "关键词") { w.value = want; }
      if (w.name === "权重") { w.value = Object.prototype.hasOwnProperty.call(ws, want) ? ws[want] : W_DEF; }
    });
  }
  var cpos = (clip.pos || [0, 0]).slice();
  var csize = clip.size || [860, 620];
  var k = weightNodesOf(clip, side).length;
  node.pos = [cpos[0], cpos[1] + (csize[1] || 620) + 24 + k * (W_NODE_H + 12)];
  try { if (app.graph && typeof app.graph.add === "function") app.graph.add(node); } catch (e) { log("加进画布失败", e); }
  syncWeightNode(node);
  try { if (app.canvas && typeof app.canvas.selectNode === "function") app.canvas.selectNode(node); } catch (e) { /* 忽略 */ }
  redrawCanvas(node);
  return node;
}

// ---------------------------------------------------------------- 权重表面板（正 / 负各一张）
const PANEL_CSS = `
.pcw-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99998;display:flex;align-items:center;justify-content:center;}
.pcw-card{min-width:440px;max-width:min(740px,92vw);max-height:82vh;overflow:auto;background:#232733;color:#e8ecf5;
  border:1px solid #4b5468;border-radius:12px;padding:14px 16px 16px;box-shadow:0 18px 48px rgba(0,0,0,.55);
  font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:13px;box-sizing:border-box;}
.pcw-card h3{margin:0 0 10px;font-size:15px;display:flex;align-items:center;gap:10px;}
.pcw-card h3 span{flex:1 1 auto;}
.pcw-card h3 .side{flex:0 0 auto;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid currentColor;}
.pcw-card h3 .side.pos{color:#8fc0ff;}
.pcw-card h3 .side.neg{color:#f4a2a2;}
.pcw-x{margin-left:auto;border:1px solid #5a6478;background:transparent;color:#dfe6f5;border-radius:8px;
  width:26px;height:26px;cursor:pointer;font-size:13px;line-height:1;}
.pcw-x:hover{background:#39405280;}
.pcw-tip{color:#9aa6bd;font-size:12px;line-height:1.6;margin:0 0 10px;}
.pcw-empty{color:#ffd08a;font-size:13px;margin:0 0 10px;}
.pcw-list{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;}
.pcw-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#1c2029;border:1px solid #3b4254;
  border-radius:8px;padding:6px 8px;}
.pcw-word{flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,Consolas,monospace;}
.pcw-num{color:#9fd8ff;font-family:ui-monospace,Consolas,monospace;min-width:44px;text-align:right;}
.pcw-btn{border:1px solid #5a6478;background:#2c3242;color:#dfe6f5;border-radius:7px;padding:4px 9px;
  cursor:pointer;font-family:inherit;font-size:12px;}
.pcw-btn:hover{background:#394052;}
.pcw-btn.pri{background:#2b5f8a;border-color:#3d7fb4;}
.pcw-btn.pri:hover{background:#336f9f;}
.pcw-btn.danger{background:#5d2f2c;border-color:#8c4740;}
.pcw-btn.danger:hover{background:#743a34;}
.pcw-add{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;}
.pcw-inp{flex:1 1 200px;min-width:140px;background:#141821;border:1px solid #4b5468;border-radius:7px;
  color:#e8ecf5;padding:5px 8px;font-family:inherit;font-size:13px;outline:none;}
.pcw-err{color:#ffb060;font-size:12px;min-height:16px;margin-top:8px;}
/* 附属节点上那条横杆：左边正/负标签 + 词 + 横条（中间一颗小圆钮）+ 数值框 */
.pcwt{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:5px 8px 7px;}
.pcwt-side{flex:0 0 auto;font-size:11px;line-height:1;padding:2px 6px;border-radius:999px;border:1px solid currentColor;}
.pcwt-side.pos{color:#8fc0ff;background:rgba(110,170,255,.16);}
.pcwt-side.neg{color:#f4a2a2;background:rgba(240,140,140,.16);}
.pcwt-word{flex:0 1 auto;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;opacity:.95;}
.pcwt-track{position:relative;flex:1 1 auto;height:10px;border-radius:999px;cursor:pointer;
  background:linear-gradient(90deg, rgba(110,170,255,.18), rgba(150,170,255,.42), rgba(240,140,140,.28));
  border:1px solid rgba(150,170,210,.5);}
.pcwt-knob{position:absolute;top:50%;left:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;
  background:#e8ecf5;border:2px solid rgba(90,120,190,.9);box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:grab;}
.pcwt-track:active .pcwt-knob{cursor:grabbing;}
.pcwt-num{flex:0 0 62px;width:62px;background:#141821;border:1px solid #4b5468;border-radius:6px;color:#e8ecf5;
  padding:3px 5px;font-family:inherit;font-size:12px;outline:none;text-align:right;}
/* ★ 第一百四十六批（他第 1 条）：横杆最左边那颗「− / ＋」= 隐藏化（50% 半透明 ↔ 恢复） */
.pcwt-hide{flex:0 0 auto;width:17px;height:17px;line-height:15px;text-align:center;box-sizing:border-box;
  border-radius:50%;border:1px solid rgba(150,170,210,.55);background:rgba(0,0,0,.28);color:#e8ecf5;
  font:inherit;font-size:11px;padding:0;cursor:pointer;opacity:.85;}
.pcwt-hide:hover{opacity:1;background:rgba(0,0,0,.45);}
.pcwt-hide.on{color:#ffd27f;border-color:rgba(255,210,127,.75);opacity:1;}
`;
function injectCss() {
  if (document.getElementById("pcw-style")) return;
  var s = document.createElement("style");
  s.id = "pcw-style";
  s.textContent = PANEL_CSS;
  document.head.appendChild(s);
}
function makeCard(title, side) {
  injectCss();
  var back = el("div", "pcw-back");
  var card = el("div", "pcw-card");
  var head = el("h3");
  head.appendChild(el("span", null, title));
  head.appendChild(el("span", "side " + sideOf(side).cls, sideOf(side).name + "权重"));
  var x = el("button", "pcw-x", "✕");
  head.appendChild(x);
  card.appendChild(head);
  back.appendChild(card);
  function close() {
    try { back.remove(); } catch (e) { /* 忽略 */ }
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") close(); }
  x.onclick = close;
  back.addEventListener("click", function (e) { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(back);
  return { back: back, card: card, close: close };
}

function openWeightsPanel(clip, side) {
  if (!clip) return null;
  var sd = sideOf(side);
  var ui = makeCard("⚖ 调整" + sd.name + "关键词权重", side);
  ui.card.appendChild(el("div", "pcw-tip",
    "这是这颗优化节点**「" + sd.name + "」那一侧**的关键词权重表（跟着工作流走、会存下来）。表里的词："
    + "在" + sd.name + "提示词文本框里出现 → 送去编码时变成 (词:权重)，原文里已经写成 (词) / (词:1.2) / [词] 的以这张表为准；"
    + "文本里没有的词 → 加到" + sd.name + "提示词末尾（正表只管正、负表只管负，互不串门）。"
    + "⚠️ 它只改送去编码的那一份文本，框里的字一个都不会动。"));
  var listBox = el("div", "pcw-list");
  var emptyBox = el("div", "pcw-empty", "");
  ui.card.appendChild(listBox);
  ui.card.appendChild(emptyBox);

  var addRow = el("div", "pcw-add");
  var inp = document.createElement("input");
  inp.className = "pcw-inp";
  inp.type = "text";
  inp.placeholder = "填一个" + sd.name + "关键词（比如 " + (side === "neg" ? "bad hands" : "long hair") + "）";
  inp.spellcheck = false;
  var bAdd = el("button", "pcw-btn pri", "➕ 新建关键词");
  addRow.appendChild(inp);
  addRow.appendChild(bAdd);
  ui.card.appendChild(addRow);
  var err = el("div", "pcw-err", "");
  ui.card.appendChild(err);
  ui.card.appendChild(el("div", "pcw-tip",
    "点「调出附属节点」会在节点下面叫出一条**横长条**：拖**中间那颗小圆钮**左右改权重（**0.05 一格**），"
    + "也可以直接在右边的数值框里**手动输入**。附属节点不和任何节点连线，也不参与工作流；标题上写着正还是负。"
    + "标题你自己改了也没关系 —— **改过的名字会记住**：刷新、重新叫出来都还是那个名字（改回空 = 恢复自动名）。"));

  function renderList() {
    var ws = weightsOf(clip, side);
    var keys = Object.keys(ws);
    listBox.innerHTML = "";
    emptyBox.textContent = keys.length ? ""
      : ("当前没有" + sd.name + "关键词，需要你自己填 —— 在下面那个框里写一个词，点「➕ 新建关键词」。");
    keys.forEach(function (word) {
      var row = el("div", "pcw-row");
      row.appendChild(el("span", "pcw-word", word));
      row.appendChild(el("span", "pcw-num", fmtW(ws[word])));
      // ★ 182 批⑤：面板里也能给这个词设别名（不然一堆「1」「2」分不清谁是谁）
      var bAlias = el("button", "pcw-btn", "别名");
      (function (w) {
        bAlias.title = "给「" + w + "」起个看得懂的名字（只改显示，不动真实词）";
        bAlias.onclick = function () {
          var bag = aliasBagOf(clip);
          var k = side + "|" + w;
          var open = window.prompt("「" + w + "」显示成什么名字？（留空 = 恢复真词）", (bag && bag[k]) || "");
          if (open == null) return;
          var clean = String(open).trim().slice(0, 24);
          if (bag) { if (clean) bag[k] = clean; else if (bag[k]) delete bag[k]; }
          // 已经叫出来的附属节点也跟着改标题
          weightNodesOf(clip, side).forEach(function (n) {
            var i2 = infoOf(n);
            if (i2 && String(i2.word || "") === w) {
              try { if (clean) i2.alias = clean; else if (i2.alias) delete i2.alias; } catch (e) {}
              try { syncTitle(n); } catch (e) {}
            }
          });
          renderList();
          err.textContent = clean ? ("「" + w + "」以后显示成「" + clean + "」") : ("「" + w + "」恢复显示真词");
        };
      })(word);
      var bOpen = el("button", "pcw-btn", "调出附属节点");
      bOpen.onclick = function () {
        var n = openWeightNode(clip, side, word);
        err.textContent = n ? ("已经把「" + word + "」的横长条叫出来了（在节点下面）") : "叫不出来：这个前端没有 LiteGraph.createNode";
      };
      var bDel = el("button", "pcw-btn danger", "🗑 删");
      bDel.onclick = function () {
        // ⚠️ 顺序要紧：**先把这个词的横长条撤掉，再改表** —— 反过来的话，那条还开着的附属节点
        //   会在"表里没这个词"时把它自己又补回表里（自愈那一步），删不掉。
        weightNodesOf(clip, side).filter(function (n) {
          var i2 = infoOf(n);
          return !!i2 && String(i2.word || "") === word;
        }).forEach(function (n) { try { if (app.graph && app.graph.remove) app.graph.remove(n); } catch (e) { /* 忽略 */ } });
        var m = weightsOf(clip, side);
        delete m[word];
        setWeights(clip, side, m);
        err.textContent = "已经把「" + word + "」从" + sd.name + "权重表里删掉了";
        renderList();
      };
      row.appendChild(bAlias);
      row.appendChild(bOpen);
      row.appendChild(bDel);
      listBox.appendChild(row);
    });
  }
  bAdd.onclick = function () {
    var word = String(inp.value || "").trim();
    if (!word) { err.textContent = "先在上面那个框里写一个词"; inp.focus(); return; }
    if (word.length > W_WORD_MAX) { err.textContent = "这个词太长了（最多 " + W_WORD_MAX + " 个字符）"; return; }
    var m = weightsOf(clip, side);
    if (!Object.prototype.hasOwnProperty.call(m, word)) m[word] = W_DEF;
    setWeights(clip, side, m);
    inp.value = "";
    openWeightNode(clip, side, word);
    renderList();
    err.textContent = "「" + word + "」已经记下了（" + sd.name + "权重 " + fmtW(weightsOf(clip, side)[word]) + "）；下次打开这张表它还在";
  };
  inp.addEventListener("keydown", function (e) {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); bAdd.click(); }
  });
  ["pointerdown", "mousedown", "wheel", "click", "dblclick", "contextmenu"].forEach(function (ev) {
    inp.addEventListener(ev, function (e) { e.stopPropagation(); });
  });
  renderList();
  return ui;
}

// 给 prompt_clip.js 那两颗按钮调的
window.__pcOpenWeights = function (clip, side) { return openWeightsPanel(clip, side || "pos"); };
injectCss();          // 横杆的样式（附属节点一建出来就要用，不能等面板开）
// 给 prompt_clip.js 的 syncBackend 调的（收起时两张表都要清掉）
window.__pcWeights = {
  mirror: mirror,
  weightsOf: weightsOf,
  setWeights: setWeights,
  openNode: openWeightNode,
  panel: openWeightsPanel,
  // ★ 第一百四十六批（他第 1 条）：隐藏化（50% 半透明）—— 自测用
  setHidden: setHiddenW,
  isHidden: isHiddenW,
  hookDraw: hookDrawNode,
};
// 测试钩子
window.__pcWeightInfo = function (clip, side) {
  if (!clip) return null;
  var s = side || "pos";
  var w = textWidget(clip, sideOf(s).widget);
  return {
    side: s,
    weights: weightsOf(clip, s),
    widget: w ? String(w.value == null ? "" : w.value) : null,
    widgetHidden: !!(w && (w.hidden || (w.element && w.element.style.display === "none"))),
    nodes: weightNodesOf(clip, s).map(function (n) {
      var i2 = infoOf(n);
      var bar = n.__pcBar;
      return {
        id: n.id, word: i2 ? String(i2.word || "") : "", side: i2 ? String(i2.side || "pos") : "pos",
        w: widgetW(n), title: String(n.title || ""), size: n.size ? n.size.slice() : null,
        knobLeft: bar ? Math.round(parseFloat(bar.knob.style.left) || 0) : null,
        num: bar ? String(bar.num.value) : null,
        hidden: isHiddenW(n),
        barOpacity: bar && bar.row ? String(bar.row.style.opacity || "") : null,
        hideBtn: bar && bar.hide ? String(bar.hide.textContent) : null,
      };
    }),
    collapsed: !!(clip.flags && clip.flags.collapsed),
  };
};

app.registerExtension({
  name: "PromptClip.Weight",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || nodeData.name !== WEIGHT_TYPE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const node = this;
      try {
        node.properties = node.properties || {};
        if (!infoOf(node)) {
          var w0 = textWidget(node, "关键词");
          node.properties[WPROP] = { clip: null, side: "pos", word: String(w0 && w0.value ? w0.value : "").trim() };
        }
        // 后端那两颗控件（关键词 / 权重）都收起来 —— 看得见的是我们画的那条横杆
        node.widgets = node.widgets || [];
        node.widgets.slice().forEach(function (w) {
          if (!w || (w.name !== "关键词" && w.name !== "权重")) return;
          w.computeSize = function () { return [0, -4]; };
          w.hidden = true;
          try { if (w.element) w.element.style.display = "none"; } catch (e) { /* 忽略 */ }
        });
        // 横长条：宽而矮（它就只有一条横杆）
        if (typeof node.setSize === "function") {
          var sz = node.size || [W_NODE_W, W_NODE_H];
          node.setSize([Math.max(W_NODE_W, sz[0] || 0), W_NODE_H]);
          try { if (typeof node.onResize === "function") node.onResize(node.size); } catch (e) { /* 忽略 */ }
        }
        // 那条横杆（挂成 DOM 控件）
        try {
          if (typeof node.addDOMWidget === "function") {
            node.__pcBarWidget = node.addDOMWidget("权重条", "pcWeightBar", buildBar(node), { serialize: false, hideOnZoom: false });
          } else {
            var host = document.getElementById("pcw-host");
            if (!host) { host = document.createElement("div"); host.id = "pcw-host"; host.style.cssText = "position:fixed;left:-9999px;top:0;width:470px;"; document.body.appendChild(host); }
            host.appendChild(buildBar(node));
          }
        } catch (e) { log("横杆挂载失败（权重还能用面板改）", e); }
        // 权重那颗控件（藏着）的 callback 也接上：万一前端自己改了值，照样写回表
        var wW = textWidget(node, "权重");
        if (wW) {
          var oldCb = wW.callback;
          wW.callback = function (v) {
            try { if (oldCb) oldCb.apply(this, arguments); } catch (e) { /* 忽略 */ }
            if (node.__pcCommitW) node.__pcCommitW(v);
          };
        }
        syncWeightNode(node);
        log("附属节点就绪", node.id, nodeSide(node));
      } catch (e) { log("附属节点初始化失败", e); }
      return r;
    };

    function setWidgetWord(node, word) {
      var w = textWidget(node, "关键词");
      if (!w) return;
      if (String(w.value || "") === String(word)) return;
      try {
        w.value = word;
        if (w.inputEl && "value" in w.inputEl) w.inputEl.value = word;
      } catch (e) { /* 忽略 */ }
    }

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const node = this;
      try {
        if (info && info.properties && info.properties[WPROP]) node.properties[WPROP] = info.properties[WPROP];
        // ⚠️ 优化节点那颗的 properties 是这个前端**在 onConfigure 之后**才写回来的 → 等一下再对齐一次
        setTimeout(function () { try { syncWeightNode(node); } catch (e) { /* 忽略 */ } }, 600);
      } catch (e) { /* 忽略 */ }
      return r;
    };

    // 他自己在界面上把标题改了 → 每画一帧顺手认一次（前端没有"标题变了"的回调可挂）
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDrawForeground ? onDrawForeground.apply(this, arguments) : undefined;
      try { syncTitle(this); } catch (e) { /* 忽略 */ }
      try { applyHiddenLook(this); } catch (e) { /* 忽略 */ }   // ★ 第一百四十六批：隐藏化那 50% 每帧顺手对上
      return r;
    };
    // 存工作流那一下也认一次（万一一帧都没画就直接存盘/刷新）
    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      try { syncTitle(this); } catch (e) { /* 忽略 */ }
      return onSerialize ? onSerialize.apply(this, arguments) : undefined;
    };

    const computeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (out) {
      const s = (computeSize ? computeSize.apply(this, arguments) : null) || out || [W_NODE_W, W_NODE_H];
      return [Math.max(W_NODE_W, (s && s[0]) || 0), Math.max(W_NODE_H, (s && s[1]) || 0)];
    };
  },

  async setup() {
    // 页面起来后把所有优化节点的两张表都镜像一遍（万一本文件比 prompt_clip.js 后加载）
    setTimeout(function () {
      try { allNodes().filter(isClipNode).forEach(function (n) { mirror(n); }); } catch (e) { /* 忽略 */ }
      try { hookDrawNode(); } catch (e) { /* 忽略 */ }          // ★ 第一百四十六批：隐藏化那 50% 靠它
      try { allNodes().filter(isWeightNode).forEach(function (n) { applyHiddenLook(n); }); } catch (e) { /* 忽略 */ }
    }, 900);
  },
});

// ==================== ★ 182 批⑤ 别名 + 双击只改「」里的字 ====================
//   他原话：「正关键词权重·「1」，我要双击改这个节点的名称的话，那肯定是只改一里面的内容啊」
//           「我点击调整正关键词权重的话，那里面这个弹窗的内容，肯定也可以设置别名啊，不然哪知道哪个是哪个啊」
//   → 别名只影响**标题/面板上显示的字**，不动真实关键词、也不动权重表里的键。
function aliasBagOf(clip) {
  try {
    var p = (clip && clip.properties) || {};
    p.pcClip = p.pcClip || {};
    if (!p.pcClip.aliases || typeof p.pcClip.aliases !== "object") p.pcClip.aliases = {};
    return p.pcClip.aliases;
  } catch (e) { return null; }
}
function aliasOfNode(node) {
  var info = infoOf(node);
  if (info && typeof info.alias === "string" && info.alias.trim()) return info.alias.trim();
  var bag = aliasBagOf(info ? nodeById(info.clip) : null);
  var k = titleKeyOf(node);
  return (bag && k && bag[k]) ? String(bag[k]).trim() : "";
}
function rememberAlias(node, t) {
  var info = infoOf(node);
  if (!info) return false;
  var clean = String(t == null ? "" : t).trim();
  if (clean.length > 24) clean = clean.slice(0, 24);
  try {
    if (clean) info.alias = clean; else if (info.alias) delete info.alias;
    var bag = aliasBagOf(nodeById(info.clip));
    var k = titleKeyOf(node);
    if (bag && k) { if (clean) bag[k] = clean; else if (bag[k]) delete bag[k]; }
  } catch (e) { /* 忽略 */ }
  try { syncTitle(node); } catch (e) { /* 忽略 */ }
  return true;
}

// 节点标题在屏幕上的矩形（用来判断"双击的是不是标题"）
function titleRectOf(node) {
  try {
    var ds = app.canvas.ds;
    var th = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;
    var s = node.size || [200, 100];
    var x = (node.pos[0] + ds.offset[0]) * ds.scale;
    var y = (node.pos[1] + ds.offset[1] - th) * ds.scale;
    return { left: x, top: y, right: x + s[0] * ds.scale, bottom: y + th * ds.scale };
  } catch (e) { return null; }
}
function weightNodeAtTitle(x, y) {
  try {
    var ns = (app.graph._nodes || []).filter(function (n) {
      return n && (n.type === "PromptToolClipWeight" || n.comfyClass === "PromptToolClipWeight");
    });
    for (var i = ns.length - 1; i >= 0; i--) {
      var r = titleRectOf(ns[i]);
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return ns[i];
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

// 一个小输入框（浮层，不挡画布太久）：只编辑「」里的那段文字
function openAliasEditor(node) {
  var info = infoOf(node);
  if (!info) return;
  var word = String(info.word || "");
  var cur = aliasOfNode(node) || "";
  var back = el("div", "pcw-back");
  var card = el("div", "pcw-card");
  card.style.cssText = "max-width:420px";
  var h = el("h3");
  h.appendChild(el("span", null, "改个名字（只改标题里的「」）"));
  var x = el("button", "pcw-x", "✕");
  h.appendChild(x);
  card.appendChild(h);
  card.appendChild(el("div", "pcw-tip",
    "真实关键词是「" + word + "」——**它不动**（权重表里的键还是它）。这里改的是标题上那个「」里显示的字，方便你认出谁是谁。"));
  var row = el("div", "pcw-add");
  var inp = document.createElement("input");
  inp.className = "pcw-inp";
  inp.type = "text";
  inp.maxLength = 24;
  inp.value = cur;
  inp.placeholder = word + "（留空 = 恢复显示真词）";
  inp.spellcheck = false;
  row.appendChild(inp);
  card.appendChild(row);
  var foot = el("div", "pcw-add");
  var ok = el("button", "pcw-btn pri", "保存");
  var cancel = el("button", "pcw-btn", "取消");
  foot.appendChild(ok); foot.appendChild(cancel);
  card.appendChild(foot);
  back.appendChild(card);
  document.body.appendChild(back);
  function close() { try { back.remove(); } catch (e) { /* 忽略 */ } }
  x.onclick = close; cancel.onclick = close;
  back.addEventListener("click", function (e) { if (e.target === back) close(); });
  ok.onclick = function () { rememberAlias(node, inp.value); close(); };
  inp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { rememberAlias(node, inp.value); close(); }
    if (e.key === "Escape") close();
    e.stopPropagation();     // 别让画布的快捷键抢走
  });
  setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) { /* 忽略 */ } }, 20);
}

// 双击标题 = 改「」里的字（拦住 ComfyUI 自带的"整条标题改名"）
document.addEventListener("dblclick", function (e) {
  try {
    if (!app || !app.canvas || !app.graph) return;
    var n = weightNodeAtTitle(e.clientX, e.clientY);
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    openAliasEditor(n);
  } catch (err) { /* 忽略 */ }
}, true);
