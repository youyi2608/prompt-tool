// ==================== ★ 199 批：黑箱（黑箱白模）====================
// 他原话：「完全原版的工作流已经有了，叫黑箱白模……黑箱和叫出原版工作流的两种新功能都要依靠这个」
//         「先做一个没有生图效果的黑箱，检查一下 UI 以及一键放大到刚好占用整个屏幕的功能」
// 这一批只做**壳**：一颗纯前端节点（不碰后端、不用重启 ComfyUI），面板 + 「⛶ 占满屏幕」。
// 原版白模（`ComfyUI\user\default\workflows\黑箱白模.json`）= 12 颗原生节点：
//   UNETLoader / CLIPLoader / VAELoader / LoraLoader×3 / CLIPTextEncode×2 / KSampler / EmptyLatentImage / VAEDecode / PreviewImage
// 下一步（他点头再做）：把这张图"塞进"黑箱壳里、一键叫出/收回、生图。
import { app } from "../../scripts/app.js";

const NODE_NAME = "PromptToolBlackBox";
const W = 880, H = 600;
const WHITE_MODEL = [
  ["UNETLoader", "主模型（Anima/diffusion_models）"],
  ["CLIPLoader", "CLIP / 文本编码器"],
  ["VAELoader", "VAE"],
  ["LoraLoader ×3", "三颗 LoRA（进黑箱后由 LoRA 池接管）"],
  ["CLIPTextEncode ×2", "正 / 负 文本编码"],
  ["EmptyLatentImage", "空 Latent（宽高）"],
  ["KSampler", "采样器"],
  ["VAEDecode", "VAE 解码"],
  ["PreviewImage", "预览图"],
];
function log(...a) { console.log("[BlackBox]", ...a); }

// —— 视图：让这颗节点刚好铺满整个画布可视区 ——
var _savedView = null;
function canvasEl() {
  try {
    var c = app.canvas;
    if (!c) return null;
    var el = c.canvas || c.canvasEl || c.el;
    if (el && (el.clientWidth || el.offsetWidth)) return el;
    // 兜底：画布容器里那颗 <canvas>
    var host = document.querySelector(".graph-canvas-container canvas") || document.querySelector("canvas");
    return host || el || null;
  } catch (e) { return null; }
}
function viewSize() {
  var el = canvasEl();
  if (!el) return [0, 0];
  return [el.clientWidth || el.offsetWidth || 0, el.clientHeight || el.offsetHeight || 0];
}
// ★ 206 批：他拿尺子量出来的目标（屏幕宽约 35cm）——
//   占满之后，黑箱离屏幕 **上 3cm / 左 1.5cm / 下 1.5cm / 右 8cm**。
//   按比例换算成窗口像素（左右不对称！右边让出那块是给"任务队列"侧栏的）。
var FIT_CM = { top: 3, left: 1.5, bottom: 1.5, right: 8, screenCm: 35 };
function fitInsets() {
  var W = window.innerWidth, H = window.innerHeight;
  var k = W / FIT_CM.screenCm;                     // 1cm ≈ 多少像素（按窗口宽反推）
  return {
    top: Math.round(FIT_CM.top * k),
    left: Math.round(FIT_CM.left * k),
    bottom: Math.round(FIT_CM.bottom * k),
    right: Math.round(FIT_CM.right * k),
    W: W, H: H
  };
}
function fitNodeToScreen(node, pad) {
  try {
    var c = app.canvas, el = canvasEl();
    if (!c || !el || !node || !node.size) return false;
    var ins = fitInsets();
    var cw = ins.W - ins.left - ins.right;          // 目标可视宽
    var chh = ins.H - ins.top - ins.bottom;         // 目标可视高
    if (cw < 200 || chh < 160) return false;        // 窗口太小就别硬塞
    if (!_savedView) _savedView = { scale: c.ds.scale, offset: [c.ds.offset[0], c.ds.offset[1]], size: [node.size[0], node.size[1]] };
    // 先把黑箱改成和目标区域同一个长宽比，再缩放 → 正好铺在这个矩形里
    var nw = 900, nh = Math.round(nw * chh / cw);
    nh = Math.max(320, Math.min(1200, nh));
    try { node.setSize([nw, nh]); } catch (e) { /* 忽略 */ }
    bbFit(node);
    var w = node.size[0], h = node.size[1];
    var scale = Math.min(cw / w, chh / h);
    scale = Math.max(0.12, Math.min(4, scale));
    c.ds.scale = scale;
    // 屏幕坐标 → 画布偏移：屏幕x = (pos[0] + offset[0]) * scale
    c.ds.offset[0] = (ins.left / scale) - node.pos[0];
    c.ds.offset[1] = (ins.top / scale) - node.pos[1];
    c.setDirty(true, true);
    try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
    return true;
  } catch (e) { return false; }
}
function restoreView() {
  try {
    if (!_savedView) return false;
    var c = app.canvas;
    c.ds.scale = _savedView.scale;
    c.ds.offset[0] = _savedView.offset[0];
    c.ds.offset[1] = _savedView.offset[1];
    // 尺寸也一起还原（点了"占满屏幕"会把黑箱改成跟屏幕同比例）
    try {
      var n = window.__pcBlackBox && window.__pcBlackBox.types ? window.__pcBlackBox.types()[0] : null;
      if (n && _savedView.size) n.setSize([_savedView.size[0], _savedView.size[1]]);
    } catch (e) { /* 忽略 */ }
    c.setDirty(true, true);
    _savedView = null;
    return true;
  } catch (e) { return false; }
}

// ★ 202 批：拆掉黑箱 —— 把里面装着的原版工作流散回画布，再移除黑箱本身。
// ★ 236 批：真装进去了 —— **按黑箱里"亮着的 LoRA"数量动态重建 LoRA 链**
//   （他 233 批的待办：「黑箱拆开只爆亮着的 N 个 LoRA」）。
//   亮 2 个 → 画布上就 2 个 LoraLoader；一个都没亮 → 整条链去掉，UNETLoader 直连 KSampler。
function dismantle(node) {
  try {
    if (!node || !node.graph) return false;
    // ① 首选：**内部节点已经建过**（他生成过图）→ 直接把那套节点移到黑箱的位置接管，
    //    这样"拆掉"= 把他已经调好的那套真节点交给他，不用再从模板重建一遍。
    var inn = null;
    try { inn = bbInner(node); } catch (e) { inn = null; }
    if (inn && inn.ok) {
      var ox = node.pos ? node.pos[0] : 0, oy = node.pos ? node.pos[1] : 0;
      var minX = Infinity, minY = Infinity;
      inn.mine.forEach(function (n) {
        if (n.pos[0] < minX) minX = n.pos[0];
        if (n.pos[1] < minY) minY = n.pos[1];
      });
      if (!isFinite(minX)) { minX = 0; minY = 0; }
      inn.mine.forEach(function (n) {
        n.pos = [ox + (n.pos[0] - minX), oy + (n.pos[1] - minY)];
        try { delete n.properties[BB_OWNER]; } catch (e) { /* 忽略 */ }
      });
      app.graph.remove(node);
      app.graph.setDirtyCanvas(true, true);
      bbToast("已拆掉，把你生成用的那 " + inn.mine.length + " 颗节点挪到这儿了");
      return true;
    }
    // ② 次选：按模板放出来（带裁剪）
    var spawned = null;
    if (bbTmplReady()) {
      spawned = bbSpawn(node, { trim: true });
    }
    if (spawned) {
      var made = spawned.res.made;
      var missed = spawned.res.missed || [];
      app.graph.remove(node);
      app.graph.setDirtyCanvas(true, true);
      var msg = "已拆掉，散出 " + made + " 颗原生节点";
      msg += spawned.lit.length
        ? ("；LoRA 链按亮着的 " + spawned.lit.length + " 个重建（" + spawned.chainLen + " 层）")
        : "；一个 LoRA 都没亮 → 整条 LoRA 链已去掉";
      if (spawned.dropped && spawned.dropped.length) msg += "；本机没有的 LoRA 已摘掉：" + spawned.dropped.join("、");
      if (missed.length) msg += "；有 " + missed.length + " 颗类型本机没有：" + missed.join("、");
      bbToast(msg, missed.length > 0);
      return true;
    }
    // ② 模板还没读到 / 读失败：退回"内存里存着的 __inner"（黑箱当空壳时通常没有）
    var inner = node.__inner || null;
    var restored = 0;
    if (inner && Array.isArray(inner.nodes) && inner.nodes.length) {
      var LG = window.LiteGraph;
      var map = {};
      inner.nodes.forEach(function (nd) {
        try {
          var n = LG.createNode(nd.type);
          if (!n) return;
          if (nd.pos) n.pos = [nd.pos[0], nd.pos[1]];
          if (nd.size) n.setSize([nd.size[0], nd.size[1]]);
          if (nd.widgets_values) { try { n.widgets_values = nd.widgets_values; } catch (e) { /* 忽略 */ } }
          if (nd.properties) n.properties = nd.properties;
          app.graph.add(n);
          map[nd.id] = n; restored++;
        } catch (e) { /* 单颗失败不影响别的 */ }
      });
      if (Array.isArray(inner.links)) {
        inner.links.forEach(function (l) {
          try {
            var a = map[l[1]], b = map[l[3]];
            if (a && b) a.connect(l[2], b, l[4]);
          } catch (e) { /* 忽略 */ }
        });
      }
    }
    app.graph.remove(node);
    app.graph.setDirtyCanvas(true, true);
    bbToast(restored ? ("已拆掉，散回 " + restored + " 颗节点") : "已拆掉", !restored);
    log("黑箱已拆掉", node.id, "散出节点", restored);
    return true;
  } catch (e) { log("拆失败", e); return false; }
}
// 一键叫出原版工作流（不裁剪：4 个 LoraLoader 空槽原样保留，方便对照）
function spawnOriginal(node) {
  var r = bbSpawn(node, { trim: false });
  if (!r) return false;
  try { app.graph.remove(node); } catch (e) { /* 忽略 */ }
  app.graph.setDirtyCanvas(true, true);
  var msg = "已叫出原版工作流：" + r.res.made + " 颗节点";
  if (r.dropped && r.dropped.length) msg += "；本机没有的 LoRA 已摘掉：" + r.dropped.join("、");
  if ((r.res.missed || []).length) msg += "（缺类型：" + r.res.missed.join("、") + "）";
  bbToast(msg, (r.res.missed || []).length > 0);
  return true;
}

// ======== 236 批：把原版工作流装进黑箱（一键叫出 / 拆开只爆亮着的 N 个）========
//   他的待办（231 / 233 批）：① 黑箱「拆开只爆亮着的 N 个 LoRA」—— 按点亮数量**动态重建** LoRA 链；
//   ② 一键叫出原版工作流。
//   模板 = `web/blackbox_template.json`（就是 `黑箱白模1023.json`：13 颗原生节点 / 17 条连线 /
//   4 个 LoraLoader 串在 `UNETLoader → KSampler` 之间，顺序 89 → 95 → 90 → 91）。
var BB_TEMPLATE_URL = new URL("./blackbox_template.json", import.meta.url).href;
var _bbTmpl = null;
var _bbTmplErr = "";

function bbTmplReady() { return !!_bbTmpl; }
function bbTemplate() {
  if (_bbTmpl) return Promise.resolve(_bbTmpl);
  if (_bbTmplErr) return Promise.reject(new Error(_bbTmplErr));
  return fetch(BB_TEMPLATE_URL, { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (j) {
      if (!j || !Array.isArray(j.nodes) || !j.nodes.length) throw new Error("模板里没有节点");
      _bbTmpl = j;
      log("原版工作流模板已载入：" + j.nodes.length + " 颗节点 / " + (j.links || []).length + " 条连线");
      return j;
    })
    .catch(function (e) {
      _bbTmplErr = String((e && e.message) || e);
      log("原版工作流模板读不到", e);
      throw e;
    });
}

function bbClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }

function bbToast(msg, bad) {
  try {
    log(msg);
    var em = app && app.extensionManager;
    if (em && em.toast && em.toast.add) {
      em.toast.add({ severity: bad ? "error" : "info", summary: "黑箱", detail: msg, life: bad ? 6000 : 4200 });
    }
  } catch (e) { /* 忽略 */ }
}

// 黑箱里"亮着的 LoRA"，顺序 = 界面顺序（角色组 → 画风组，组内按名字）—— 和 bbLoraPane 的 group 顺序一致
function bbLitLoras(node) {
  var st = bbState(node);
  var names = Object.keys(st.loras || {}).filter(function (n) { return !!st.loras[n]; });
  var chars = names.filter(function (n) { return bbKindOf(st, n) === "char"; }).sort();
  var styles = names.filter(function (n) { return bbKindOf(st, n) !== "char"; }).sort();
  return chars.concat(styles).map(function (n) { return { name: n, model: 1.0, clip: 1.0 }; });
}

// 沿 MODEL 输出把 LoRA 链按**真实叠加顺序**找出来（不是按节点数组顺序）
function bbLoraChain(data) {
  var byId = {};
  (data.nodes || []).forEach(function (n) { byId[n.id] = n; });
  var links = data.links || [];
  var head = (data.nodes || []).filter(function (n) { return n.type === "UNETLoader"; })[0];
  var chain = [];
  if (!head) return chain;
  var cur = head, guard = 0;
  while (guard++ < 40) {
    var nxt = null;
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (l[1] === cur.id && l[2] === 0) {                    // cur 的 MODEL 输出（slot 0）
        var t = byId[l[3]];
        if (t && t.type === "LoraLoader" && chain.indexOf(t) < 0) nxt = t;
        break;
      }
    }
    if (!nxt) break;
    chain.push(nxt);
    cur = nxt;
  }
  return chain;
}

// 按"亮着的几个"裁剪 LoRA 链：留下前 N 个（填上名字和强度），其余删掉并把上下游重新接上
function bbBuildTrimmed(data, lit) {
  var chain = bbLoraChain(data);
  if (!chain.length) return data;
  var keep = Math.max(0, Math.min(lit.length, chain.length));
  if (keep === chain.length) {                               // 一颗都不少：只填名字/强度
    chain.forEach(function (n, i) { n.widgets_values = [lit[i].name, lit[i].model, lit[i].clip]; });
    return data;
  }
  var lastNode = chain[chain.length - 1];
  // ① 链尾（就删掉的那个）原来还喂给谁：MODEL 一条 + CLIP 两条
  var tail = [];
  (data.links || []).forEach(function (l) {
    if (l[1] === lastNode.id) tail.push({ oslot: l[2], to: l[3], tslot: l[4], type: l[5] });
  });
  // ② 要删的节点
  var drop = {};
  chain.forEach(function (n, i) { if (i >= keep) drop[n.id] = true; });
  data.nodes = (data.nodes || []).filter(function (n) { return !drop[n.id]; });
  data.links = (data.links || []).filter(function (l) { return !drop[l[1]] && !drop[l[3]]; });
  var lid = Number(data.last_link_id || 1000);
  function relink(fromId, oslot, toId, tslot, type) {
    lid++;
    data.links.push([lid, fromId, oslot, toId, tslot, type]);
  }
  if (keep > 0) {
    for (var i = 0; i < keep; i++) chain[i].widgets_values = [lit[i].name, lit[i].model, lit[i].clip];
    var tailKeep = chain[keep - 1];
    tail.forEach(function (t) { relink(tailKeep.id, t.oslot, t.to, t.tslot, t.type); });
  } else {
    // 一个 LoRA 都没亮：整条链去掉 → UNETLoader.MODEL / CLIPLoader.CLIP 直连下游
    var unet = (data.nodes || []).filter(function (n) { return n.type === "UNETLoader"; })[0];
    var clip = (data.nodes || []).filter(function (n) { return n.type === "CLIPLoader"; })[0];
    tail.forEach(function (t) {
      var src = (t.oslot === 1) ? clip : unet;
      if (src) relink(src.id, 0, t.to, t.tslot, t.type);
    });
  }
  data.last_link_id = lid;
  return data;
}

// 把一份 {nodes, links} 真正建到画布上
function bbInstantiate(data) {
  var LG = window.LiteGraph;
  if (!LG || !LG.createNode) return { made: 0, missed: ["LiteGraph 没准备好"], map: {} };
  var map = {}, made = 0, missed = [];
  (data.nodes || []).forEach(function (nd) {
    var n = null;
    try { n = LG.createNode(nd.type); } catch (e) { n = null; }
    if (!n) { missed.push(nd.type); return; }
    try { app.graph.add(n); } catch (e) { /* 忽略 */ }
    try {
      var info = bbClone(nd);
      // 别让 configure 抢先建 link（link 我们下面自己 connect，不然会重复/悬空）
      (info.inputs || []).forEach(function (i) { i.link = null; });
      (info.outputs || []).forEach(function (o) { o.links = null; });
      n.configure(info);
    } catch (e) { log("恢复节点参数失败", nd.type, e); }
    map[nd.id] = n; made++;
  });
  (data.links || []).forEach(function (l) {
    try {
      var a = map[l[1]], b = map[l[3]];
      if (a && b) a.connect(l[2], b, l[4]);
    } catch (e) { /* 单条线失败不影响别的 */ }
  });
  return { made: made, missed: missed, map: map };
}

// 把原版工作流放到画布（trim=true 时按亮着的 LoRA 数量裁剪链）
function bbSpawn(node, opt) {
  opt = opt || {};
  if (!_bbTmpl) {
    bbTemplate()
      .then(function () { bbToast("原版工作流读到了，再点一次"); })
      .catch(function (e) { bbToast("原版工作流模板读不到：" + ((e && e.message) || e), true); });
    return null;
  }
  var data = bbClone(_bbTmpl);
  var local = Array.isArray(node && node.__bbLoras) ? node.__bbLoras : null;
  var has = function (nm) { return !local || !local.length || local.indexOf(String(nm || "")) >= 0; };
  var lit = bbLitLoras(node);
  var dropped = [];
  if (opt.trim) {
    // 只留下"亮着 + 本机确实有文件"的那些（缺的静默降级成少叠一层，同 235 批那条准则）
    var kept = [];
    lit.forEach(function (x) {
      if (has(x.name)) kept.push(x); else dropped.push(x.name);
    });
    lit = kept;
    data = bbBuildTrimmed(data, lit);
  } else {
    // 叫出原版：名字/强度都用模板里的原值，但本机没有的那几颗要摘掉（否则一开就报错）
    var chain0 = bbLoraChain(data);
    var keepList = [];
    chain0.forEach(function (nd) {
      var wv = nd.widgets_values || [];
      var nm = String(wv[0] || "");
      if (has(nm)) {
        keepList.push({ name: nm, model: Number(wv[1] == null ? 1 : wv[1]), clip: Number(wv[2] == null ? 1 : wv[2]) });
      } else if (nm) { dropped.push(nm); }
    });
    data = bbBuildTrimmed(data, keepList);
  }
  // 摆到黑箱右边，别叠在它身上
  var minX = Infinity, minY = Infinity;
  (data.nodes || []).forEach(function (n) {
    var p = n.pos || [0, 0];
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; }
  var ox = node.pos ? (node.pos[0] + (node.size ? node.size[0] : 900) + 60) : 40;
  var oy = node.pos ? node.pos[1] : 40;
  (data.nodes || []).forEach(function (n) {
    var p = n.pos || [0, 0];
    n.pos = [ox + (p[0] - minX), oy + (p[1] - minY)];
  });
  var res = bbInstantiate(data);
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
  return { res: res, lit: lit, dropped: dropped, count: (data.nodes || []).length, chainLen: bbLoraChain(data).length };
}

// ======== 207 批：黑箱 UI（左中右三栏；左上下两份、中上下两份、右一整块）========
// ★ 242 批（他："既然已经有横竖之比了，那 4:3，3:4 就不用分开了，应该去掉 4:3，
//   都是 3:4 和 9:16，然后用横竖来调"）：
//   比例表只留竖版（宽 < 高），横着的那份（4:3 / 16:9）删掉 —— 方向交给上面的「横竖」去换。
var BB_RATIOS = [
  { k: "1:1", w: 1024, h: 1024, label: "1:1" },
  { k: "3:4", w: 896, h: 1152, label: "3:4" },
  { k: "2:3", w: 832, h: 1216, label: "2:3" },
  { k: "9:16", w: 768, h: 1344, label: "9:16" }
];
// 老工作流里存着 "4:3" / "16:9" 的，读进来先折成等价竖版（不然比例会跳回第一个）
function bbNormRatio(k) {
  var s = String(k || "");
  if (s === "4:3") return "3:4";
  if (s === "16:9") return "9:16";
  if (s === "3:2") return "2:3";
  return BB_RATIOS.some(function (r) { return r.k === s; }) ? s : "3:4";
}
var BB_COUNTS = [1, 2, 4, 8];
// ★ 208 批（他："一个 Lora 到底是角色还是画风，这个问题也不是你说了算的，需要用户自己说了算"）
//   → 不再按名字猜：**默认一律算画风**，他点行里那颗「角」才变成角色（存 node.properties.pcBlackBox.kinds）。
// ★ 249 批（他："黑箱被叫出来的时候，正提示词初始固定为…，负提示词初始固定为…"）
//   —— 新建黑箱预填这套（他给的原话，一字未改）；**已经写过内容的不覆盖**。
// ★ 250 批（他："黑箱被叫出来的时候，初始点亮的 Lora 就是能天使加 ICEQBE 加 bantan step"）
var BB_DEFAULT_LIT = [
  "Exusiai the New CovenantV2-Nuclear1811-IL.safetensors",
  "iceqbe-2_v1_epoch60.safetensors",
  "bantan-step00007000.safetensors"
];
var BB_DEFAULT_POS = "jewelry,ahoge,earrings,wings,halo,cross,Exusiai the New Covenant,orange eyes,red hair,short hair,one side up,bangs,hair between eyes,hair over one eye,cross earrings,energy wings,detached wings";
var BB_DEFAULT_NEG = "(transparent clothing, see-through fabric, translucent swimsuit, sheer material, wet transparent:1.4), (visible nipples through clothes, exposed nipples, nipple outline:1.3), (large nipples, prominent nipples, big areolas, dark nipples, puffy nipples:1.3), (small breasts, flat chest, reduced bust:1.4), (extra character, chibi, mascot, pet, 2girls:1.4), (bad anatomy, bad hands, bad feet, extra fingers, missing fingers, deformed, blurry, lowres:1.4), (censored, mosaic, bar censor:1.4), (messy lineart, sketchy lines:1.2), (fang, vampire teeth, sharp teeth:1.1)";

function bbState(node) {
  var p = node.properties || (node.properties = {});
  var q = p.pcBlackBox;
  if (!q || typeof q !== "object") {
    // ★ 250 批：全新黑箱 → 默认点亮随包那三颗（能天使 / iceqbe / bantan）
    var lit0 = {};
    BB_DEFAULT_LIT.forEach(function (nm0) { lit0[nm0] = true; });
    q = p.pcBlackBox = { pos: BB_DEFAULT_POS, neg: BB_DEFAULT_NEG, loras: lit0, kinds: {}, ratio: "3:4", count: 1 };
  }
  if (!q.loras || typeof q.loras !== "object") q.loras = {};
  if (!q.kinds) q.kinds = {};
  q.ratio = bbNormRatio(q.ratio);   // ★ 242 批：4:3 → 3:4 / 16:9 → 9:16（老工作流兼容）
  if (!q.count) q.count = 1;
  // 空串 = 从没写过 → 用默认那套（写过哪怕一个字都不动）
  if (q.pos === "" || q.pos == null) q.pos = BB_DEFAULT_POS;
  if (q.neg === "" || q.neg == null) q.neg = BB_DEFAULT_NEG;
  return q;
}
// ★ 238 批：分类默认值改从固定名单拿（名单是手写的、不是按名字猜的，符合 208 批"不许猜"）；
//   用户点行里那颗「角/风」照样能改，改过的值存在 st.kinds 里优先。
function bbKindOf(st, name) {
  var k = st && st.kinds ? st.kinds[name] : "";
  if (k === "char" || k === "style") return k;
  var it = bbCatOf(name);
  return it && it.kind === "char" ? "char" : "style";
}
function bbSave() { try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ } }
function bbBtn(txt, extra) {
  var b = document.createElement("button");
  b.type = "button"; b.textContent = txt;
  b.style.cssText = "font-family:inherit;font-size:12px;line-height:1;padding:6px 10px;border-radius:8px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.42);background:rgba(255,255,255,.06);color:#e8eaf1;white-space:nowrap;" + (extra || "");
  return b;
}
function bbPane(title, sub) {
  var box = document.createElement("div");
  box.style.cssText = "display:flex;flex-direction:column;min-height:0;min-width:0;border:1px solid rgba(150,162,180,.26);"
    + "border-radius:12px;background:rgba(0,0,0,.16);overflow:hidden";
  if (title) {
    var h = document.createElement("div");
    h.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:12px;font-weight:700;"
      + "border-bottom:1px solid rgba(150,162,180,.18)";
    var t = document.createElement("span"); t.textContent = title; h.appendChild(t);
    if (sub) { var s = document.createElement("span"); s.textContent = sub; s.style.cssText = "font-size:11px;font-weight:400;opacity:.6"; h.appendChild(s); }
    box.appendChild(h);
  }
  var bodyEl = document.createElement("div");
  bodyEl.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px";
  box.appendChild(bodyEl);
  box.__body = bodyEl;
  return box;
}
function bbTextArea(st, key, node, ph) {
  var ta = document.createElement("textarea");
  ta.placeholder = ph;
  ta.value = String(st[key] || "");
  ta.style.cssText = "flex:1 1 auto;min-height:60px;resize:none;font-family:inherit;font-size:12px;line-height:1.55;"
    + "padding:8px 10px;border-radius:9px;border:1px solid rgba(150,162,180,.42);background:rgba(0,0,0,.24);color:#e8eaf1";
  ta.addEventListener("input", function () { st[key] = ta.value; bbSave(); });
  return ta;
}
// ======== 238 批：LoRA 固定名单（13 个）+ 别名 + 预览图 + 缺了给链接 ========
//   他 238 批原话：「我目前 Lora 池里面的 Lora 一共 14 个，不准备再加了，黑箱里面的 Lora 也稳定为这 14 个，
//   能天使，iceqbe，bantan 这 3 个我会随分享传播分享，其他都以链接方式提供，所以黑箱也要有，
//   鼠标悬停在 Lora 名称上面显示图片，如果点击缺失的 Lora，会自动弹出相应网址提供下载」
//   ＋「黑箱的 Lora 要显示我给出的别名」＋「赛博朋克不要了，14 个改成 13 个」
//   → 名单落在 `web/lora-catalog.json`（13 项：file / 别名 / 角色还是画风 / bundled / civitai 链接 / 触发词 / 权重区间）
var BB_CATALOG_URL = new URL("./lora-catalog.json", import.meta.url).href;
var _bbCat = null;
var _bbCatByFile = {};
function bbCatalog() {
  if (_bbCat) return Promise.resolve(_bbCat);
  return fetch(BB_CATALOG_URL, { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (j) {
      _bbCat = (j && j.items) || [];
      _bbCat.forEach(function (it) { if (it && it.file) _bbCatByFile[it.file] = it; });
      return _bbCat;
    })
    .catch(function (e) { log("LoRA 名单读不到", e); return []; });
}
function bbCatOf(name) { return _bbCatByFile[String(name || "")] || null; }
// 显示名：优先用**用户给的别名**（别名表 key = "loras/<文件名>"），其次名单里的名字，最后去扩展名
function bbLabelOf(name) {
  try {
    var al = window.__pcAlias && window.__pcAlias.aliasGet ? window.__pcAlias.aliasGet("loras/" + name) : "";
    if (al) return al;
  } catch (e) { /* 忽略 */ }
  var it = bbCatOf(name);
  if (it && it.name) return it.name;
  return String(name || "").replace(/\.safetensors$/i, "");
}

// ★ 238 批：缺失 LoRA 的下载弹窗（三段式、零原生弹窗）—— 放模块级，bbInit 里挂到节点上
function bbMissingDialog(item) {
  var back = document.createElement("div");
  back.style.cssText = "position:fixed;inset:0;z-index:100097;background:rgba(3,6,10,.62);"
    + "display:flex;align-items:center;justify-content:center";
  var box = document.createElement("div");
  box.style.cssText = "width:min(460px,92vw);background:#151a23;border:1px solid #3d444d;border-radius:12px;"
    + "padding:16px 18px;box-shadow:0 18px 50px rgba(0,0,0,.6);"
    + "font:12.5px/1.7 system-ui,'Microsoft YaHei',sans-serif;color:#e8eaf1";
  var h = document.createElement("div");
  h.textContent = "本机没有这颗 LoRA";
  h.style.cssText = "font-weight:700;font-size:13.5px;margin-bottom:8px";
  var body = document.createElement("div");
  body.style.cssText = "color:rgba(210,220,235,.85);white-space:pre-wrap";
  body.textContent = bbLabelOf(item.file) + "\n" + item.file + "\n\n"
    + (item.bundled
      ? "这颗是随分享包一起发的（bundled），把它放进 models/loras 就能用。"
      : "这颗不随包发，需要你自己下载后放进 models/loras：\n" + (item.url || "（名单里没填链接）"));
  var row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px";
  var bCopy = document.createElement("button");
  bCopy.type = "button"; bCopy.textContent = "复制链接";
  bCopy.style.cssText = "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.4);background:rgba(255,255,255,.06);color:#dfe6ee";
  var bOpen = document.createElement("button");
  bOpen.type = "button"; bOpen.textContent = "打开下载页";
  bOpen.style.cssText = "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;font-weight:700;"
    + "border:1px solid rgba(56,189,248,.8);background:rgba(56,189,248,.22);color:#d6ecff";
  var bOk = document.createElement("button");
  bOk.type = "button"; bOk.textContent = "知道了";
  bOk.style.cssText = "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.4);background:rgba(255,255,255,.06);color:#dfe6ee";
  row.appendChild(bCopy);
  if (item.url) row.appendChild(bOpen);
  row.appendChild(bOk);
  box.appendChild(h); box.appendChild(body); box.appendChild(row);
  back.appendChild(box); document.body.appendChild(back);
  var kill = function () { try { back.remove(); } catch (e) { /* 忽略 */ } };
  bOk.addEventListener("click", kill);
  back.addEventListener("click", function (e) { if (e.target === back) kill(); });
  bCopy.addEventListener("click", function () {
    try {
      navigator.clipboard.writeText(item.url || "");
      bCopy.textContent = "已复制";
      setTimeout(function () { bCopy.textContent = "复制链接"; }, 1400);
    } catch (e) { /* 忽略 */ }
  });
  bOpen.addEventListener("click", function () {
    try { window.open(item.url, "_blank"); } catch (e) { /* 忽略 */ }
  });
}

function bbLoraPane(node) {
  var st = bbState(node);
  var pane = bbPane("LoRA", "角色在前 · 画风在后（顺序固定）");
  var bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 0 auto";
  var tip = document.createElement("span");
  tip.style.cssText = "font-size:10.5px;opacity:.6;flex:1 1 auto";
  tip.textContent = "角色只能亮一个；画风可亮多个";
  bar.appendChild(tip);
  pane.__body.appendChild(bar);
  var listBox = document.createElement("div");
  listBox.style.cssText = "display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-height:0;overflow:auto";
  pane.__body.appendChild(listBox);
  var g = { chars: [], styles: [] };
  var ref = bbBtn("🔄 读名单", "padding:3px 8px;font-size:11px");
  ref.title = "重新读一次 LoRA 名单（固定 13 个）和本机实际文件";
  bar.appendChild(ref);

  function paint() {
    listBox.innerHTML = "";
    function group(label, arr, color) {
      if (!arr.length) return;
      var h = document.createElement("div");
      h.textContent = label;
      h.style.cssText = "font-size:10.5px;letter-spacing:.04em;opacity:.65;padding:4px 2px 2px;color:" + color;
      listBox.appendChild(h);
      arr.forEach(function (it) { listBox.appendChild(rowEl(it)); });
    }
    group("角色 · 只能亮一个", g.chars, "#ffb3d5");
    group("画风 · 可亮多个", g.styles, "#9ddcff");
    if (!g.chars.length && !g.styles.length) {
      var e = document.createElement("div");
      e.style.cssText = "font-size:11px;opacity:.6;line-height:1.7";
      e.textContent = "名单没读出来 —— 点上面「🔄 读名单」（名单在节点包的 web/lora-catalog.json）";
      listBox.appendChild(e);
    }
  }

  // 本机有没有这个文件
  function hasFile(name) {
    var list = node.__bbLoras;
    if (!Array.isArray(list) || !list.length) return true;      // 名单没拉到时别误判成"缺"
    return list.indexOf(String(name)) >= 0;
  }

  function rowEl(item) {
    var name = item.file;
    var isChar = bbKindOf(st, name) === "char";
    var present = hasFile(name);
    var on = !!st.loras[name] && present;
    var d = document.createElement("div");
    d.setAttribute("data-bblora", name);
    var c = isChar ? "rgba(236,72,153," : "rgba(56,189,248,";
    d.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px;cursor:pointer;"
      + "border:1px solid " + (on ? c + ".75" : (present ? "rgba(150,162,180,.22)" : "rgba(232,180,90,.5)"))
      + ";background:" + (on ? c + ".18" : "rgba(255,255,255,.03)")
      + ";opacity:" + (on ? "1" : (present ? ".62" : ".8"));
    var dot = document.createElement("i");
    dot.style.cssText = "flex:0 0 7px;height:7px;border-radius:50%;display:block;background:"
      + (on ? c + ".95)" : (present ? "rgba(150,162,180,.5)" : "rgba(232,180,90,.9)"));
    var nm = document.createElement("span");
    nm.className = "bb-lora-name";
    nm.textContent = bbLabelOf(name);                         // ★ 238 批：显示别名
    nm.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px";
    var kind = document.createElement("span");
    kind.textContent = isChar ? "角" : "风";
    kind.title = "点一下切换分类（角色 / 画风）：只改分类，不改顺序";
    kind.style.cssText = "flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:6px;cursor:pointer;"
      + "border:1px solid " + (isChar ? "rgba(236,72,153,.7)" : "rgba(150,162,180,.5)")
      + ";color:" + (isChar ? "#ffb3d5" : "#c9d2e4");
    kind.addEventListener("click", function (e) {
      e.stopPropagation();
      st.kinds[name] = isChar ? "style" : "char";
      if (st.kinds[name] === "char") g.chars.forEach(function (o) { if (o.file !== name) st.loras[o.file] = false; });
      bbSave(); load();
    });
    d.appendChild(dot); d.appendChild(nm);
    // ★ 238 批：本机没有的 LoRA → 挂一个「缺」徽标，title 说明点它会出下载地址
    if (!present) {
      var miss = document.createElement("span");
      miss.textContent = "缺";
      miss.style.cssText = "flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:6px;"
        + "border:1px solid rgba(232,180,90,.8);color:#ffd9a0;background:rgba(232,180,90,.14)";
      d.appendChild(miss);
    }
    d.appendChild(kind);
    d.title = bbLabelOf(name) + (bbLabelOf(name) !== name.replace(/\.safetensors$/i, "") ? "（" + name + "）" : "")
      + (present ? "\n点一下：" + (on ? "熄灭（不参与出图）" : "点亮（参与出图）") : "\n本机没有这个文件 —— 点一下给你下载地址");

    // ---- 鼠标悬停 400ms 出预览图（和 LoRA 池用的是同一套图）----
    var pvTimer = null;
    d.addEventListener("mouseenter", function (e) {
      if (pvTimer) clearTimeout(pvTimer);
      pvTimer = setTimeout(function () {
        pvTimer = null;
        try {
          if (!window.__pcPreview) return;
          var url = window.__pcPreview.url("loras", name);
          if (url) window.__pcPreview.show(url, bbLabelOf(name), e.clientX, e.clientY);
        } catch (er) { /* 忽略 */ }
      }, 400);
    });
    d.addEventListener("mouseleave", function () {
      if (pvTimer) { clearTimeout(pvTimer); pvTimer = null; }
      try { if (window.__pcPreview) window.__pcPreview.hide(); } catch (er) { /* 忽略 */ }
    });

    d.addEventListener("click", function () {
      // ★ 238 批：缺失的那颗**不点亮**，而是弹出下载地址
      if (!present) { bbMissingDialog(item); return; }
      if (isChar) {
        var was = !!st.loras[name];
        g.chars.forEach(function (o) { st.loras[o.file] = false; });
        st.loras[name] = !was;
      } else {
        st.loras[name] = !st.loras[name];
      }
      bbSave(); paint();
    });
    return d;
  }

  function load() {
    // 本机实际有哪些 LoRA（用来判断"缺"）+ 固定名单（决定显示哪些、什么顺序）
    var p1 = fetch("/object_info/LoraLoader", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var req = (((j || {}).LoraLoader || {}).input || {}).required;
        var arr = (req && req.lora_name ? req.lora_name[0] : []) || [];
        node.__bbLoras = arr.slice();          // ★ 236 批：拆开时按这份名单判断"本机有没有"
        return arr;
      })
      .catch(function () { return []; });
    Promise.all([bbCatalog(), p1]).then(function (res) {
      var cat = res[0] || [];
      g = { chars: [], styles: [] };
      cat.forEach(function (it) {
        if (bbKindOf(st, it.file) === "char") g.chars.push(it); else g.styles.push(it);
      });
      paint();
    });
  }
  ref.addEventListener("click", function () { _bbCat = null; load(); });
  load();
  return pane;

  // ★ 238 批：挂到节点上，测试口 __pcBlackBox.missingDialog 也用它
  // ---- 缺失 LoRA 的下载弹窗（三段式，零原生弹窗）----
}

// ★ 208 批（他："中区下部分的 UI 应该改成三排……横向 Stepper，左右箭头 + 中间数值"）：
//   三排 = 横竖 / 比例 / 张数。
// ★ 221 批（他："黑箱中区下面那三个横条互相调数值，就不能改成原版那样子吗，K 采样区就有 7 个那样的横条"）
//   → 换成**原版那种滑杆行**：左边名字、中间一条可拖的滑轨、右边数值。
//   引擎就是原生 `<input type="range">`（`accent-color` 上色），和 ComfyUI 画布上的滑杆观感一致。
// ★ 241 批（他贴了 K 采样器的截图："不是中间滑块左右拉，而是原版 ComfyUI 惯有的那种调试方式，
//   你可以参考一下 K 采样器，我的意思是**直接把原版的调试方式拿出来**"）：
//   原版长这样 —— 一颗圆角胶囊里：**左边 ◀、中间左边是标签、右边是值、最右 ▶**，中间不画轨道。
//   所以这里不再用 <input type=range>，改成和原版一样的箭头步进器（含长按连续步进）。
function bbSliderRow(label, values, idx, onChange) {
  var row = document.createElement("div");
  row.className = "bb-arrow-row";
  row.style.cssText = "display:flex;align-items:center;flex:0 0 auto;height:26px;border-radius:999px;"
    + "background:#1b1d22;border:1px solid rgba(150,162,180,.30);overflow:hidden;user-select:none";
  var lab = document.createElement("span");
  lab.textContent = label;
  lab.style.cssText = "flex:0 0 auto;padding-left:2px;font-size:12px;line-height:1;color:#dfe4ec;white-space:nowrap";
  var val = document.createElement("span");
  val.className = "bb-arrow-val";
  val.style.cssText = "flex:1 1 auto;min-width:0;text-align:right;padding-right:2px;font-size:12px;line-height:1;"
    + "color:#f2f5fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  function clampIdx(i) { return Math.max(0, Math.min(values.length - 1, i)); }
  function paint() {
    val.textContent = values[clampIdx(idx.v)];
    // ★ 241 批：颜色要设在**三角 <i>** 上（设在 button 上不管用 —— 三角是它的子元素）
    var tl = bl.querySelector(".bb-tri"), tr = br.querySelector(".bb-tri");
    if (tl) tl.style.borderRightColor = idx.v <= 0 ? "#4a4f5a" : "#b6bec9";
    if (tr) tr.style.borderLeftColor = idx.v >= values.length - 1 ? "#4a4f5a" : "#b6bec9";
  }
  // 箭头：用 CSS 三角画（不受字体影响，和原版那个实心三角一致）
  function mkBtn(dir) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bb-arrow " + dir;
    btn.style.cssText = "flex:0 0 28px;height:100%;display:flex;align-items:center;justify-content:center;"
      + "border:none;background:transparent;cursor:pointer;padding:0;margin:0";
    var tri = document.createElement("i");
    tri.style.cssText = "display:block;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;"
      + (dir === "l" ? "border-right:8px solid #b6bec9;" : "border-left:8px solid #b6bec9;");
    tri.className = "bb-tri " + dir;
    btn.appendChild(tri);
    btn.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    return btn;
  }
  var bl = mkBtn("l"), br = mkBtn("r");
  function step(d) {
    var nv = clampIdx(idx.v + d);
    if (nv === idx.v) return;
    idx.v = nv; paint(); onChange(idx.v);
  }
  // 点一下走一格；按住 380ms 后每 90ms 连续走（和原版手感一致）
  function bindHold(btn, d) {
    var t1 = null, t2 = null;
    function stop() { if (t1) { clearTimeout(t1); t1 = null; } if (t2) { clearInterval(t2); t2 = null; } }
    btn.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      step(d);
      t1 = setTimeout(function () { t2 = setInterval(function () { step(d); }, 90); }, 380);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (t) { btn.addEventListener(t, stop); });
    btn.addEventListener("click", function (e) { e.stopPropagation(); });
  }
  bindHold(bl, -1); bindHold(br, 1);
  row.appendChild(bl); row.appendChild(lab); row.appendChild(val); row.appendChild(br);
  paint();
  return { row: row, repaint: paint };
}
function bbStepRow(label, values, idx, onChange, hint) {
  var row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 0 auto";
  var lab = document.createElement("span");
  lab.textContent = label;
  lab.style.cssText = "flex:0 0 34px;font-size:11px;opacity:.7";
  var wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:2px;border:1px solid rgba(150,162,180,.4);border-radius:9px;overflow:hidden;background:rgba(255,255,255,.04)";
  function mkArrow(txt) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = txt;
    b.style.cssText = "width:26px;height:24px;border:none;background:transparent;color:#cfd6e6;cursor:pointer;font-size:13px;line-height:1";
    b.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    return b;
  }
  var bl = mkArrow("←");
  var val = document.createElement("span");
  val.style.cssText = "min-width:74px;text-align:center;font-size:12px;font-weight:700;padding:0 4px;white-space:nowrap";
  var br = mkArrow("→");
  function clampIdx(i) { return Math.max(0, Math.min(values.length - 1, i)); }
  function paint() { val.textContent = values[clampIdx(idx.v)]; }
  bl.addEventListener("click", function (e) { e.stopPropagation(); idx.v = clampIdx(idx.v - 1); paint(); onChange(idx.v); });
  br.addEventListener("click", function (e) { e.stopPropagation(); idx.v = clampIdx(idx.v + 1); paint(); onChange(idx.v); });
  wrap.appendChild(bl); wrap.appendChild(val); wrap.appendChild(br);
  row.appendChild(lab); row.appendChild(wrap);
  if (hint) { var h = document.createElement("span"); h.textContent = hint; h.style.cssText = "font-size:10px;opacity:.45"; row.appendChild(h); }
  paint();
  return { row: row, repaint: paint };
}
function bbOptPane(node) {
  var st = bbState(node);
  if (!st.orient) st.orient = "竖";
  var pane = bbPane("出图", "横竖 · 比例 · 张数");
  // 排 1：横竖
  var oIdx = { v: st.orient === "横" ? 1 : 0 };
  var r1 = bbSliderRow("横竖", ["竖", "横"], oIdx, function (i) { st.orient = i ? "横" : "竖"; bbSave(); paintPx(); });
  pane.__body.appendChild(r1.row);
  // 排 2：比例
  var ratioKeys = BB_RATIOS.map(function (r) { return r.k; });
  var rIdx0 = Math.max(0, ratioKeys.indexOf(st.ratio));
  var rrIdx = { v: rIdx0 };
  var r2 = bbSliderRow("比例", ratioKeys, rrIdx, function (i) { st.ratio = ratioKeys[i]; bbSave(); paintPx(); });
  pane.__body.appendChild(r2.row);
  // 排 3：张数（1~64）
  var cnt = Math.max(1, Math.min(64, Number(st.count) || 1));
  st.count = cnt;
  var cIdx = { v: cnt - 1 };
  var r3 = bbSliderRow("张数", (function () { var a2 = []; for (var i2 = 1; i2 <= 64; i2++) a2.push(i2 + " 张"); return a2; })(), cIdx,
    function (i) { st.count = i + 1; bbSave(); paintPx(); });
  pane.__body.appendChild(r3.row);
  var px = document.createElement("div");
  px.style.cssText = "font-size:10.5px;opacity:.55;margin-top:auto;padding-top:6px;line-height:1.5";
  function paintPx() {
    var r = BB_RATIOS.filter(function (x) { return x.k === st.ratio; })[0] || BB_RATIOS[1];
    var w = r.w, h = r.h;
    if (st.orient === "横" && h > w) { var t2 = w; w = h; h = t2; }
    if (st.orient === "竖" && w > h) { var t3 = w; w = h; h = t3; }
    px.textContent = st.orient + " · " + r.k + " → " + w + " × " + h + "，一次 " + Number(st.count || 1) + " 张";
  }
  paintPx();
  pane.__body.appendChild(px);
  return pane;
}
// ==================== ★ 243 批：黑箱真出图 ====================
//   他问过两次「黑箱能使用了吗」—— 之前它是壳（出图区写着"还没接生图"）。
//   现在：**第一次点「🎨 生成」时在画布旁边建一套真节点**（UNET/CLIP/VAE/LoRA×N/编码×2/KSampler/空Latent/解码/图像画廊），
//   面板参数每次生成前写进那套节点 → 入队 → 出图后由图像画廊存进存档并把文件名回传，黑箱面板直接显示缩略图。
//   ⚠️ 那套节点用 `properties.pcBBOwner = 黑箱id` 认领 —— 重开工作流后靠它找回来（对象引用不能序列化）。
var BB_OWNER = "pcBBOwner";
var BB_INNER_DX = 2600;          // 内部节点摆在黑箱右边多远（不挡操作，滚过去能看到）

function bbFitNum(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

// 找出属于这颗黑箱的内部节点（按 pcBBOwner 认领，重开工作流也不会丢）
function bbInner(node) {
  var all = (app.graph && app.graph._nodes) || [];
  var mine = all.filter(function (n) {
    try { return n && n.properties && n.properties[BB_OWNER] === node.id; } catch (e) { return false; }
  });
  function one(t) { return mine.filter(function (n) { return String(n.type || n.comfyClass || "") === t; })[0] || null; }
  var loras = mine.filter(function (n) { return String(n.type || n.comfyClass || "") === "LoraLoader"; });
  var encs = mine.filter(function (n) { return String(n.type || n.comfyClass || "") === "CLIPTextEncode"; });
  return {
    ok: !!(one("UNETLoader") && one("KSampler")),
    unet: one("UNETLoader"), clip: one("CLIPLoader"), vae: one("VAELoader"),
    ks: one("KSampler"), latent: one("EmptyLatentImage"), decode: one("VAEDecode"),
    gallery: one("PromptToolGallery"),
    posEnc: encs[0] || null, negEnc: encs[1] || null,
    loras: loras,
    mine: mine
  };
}

function bbW(node, name) { return ((node && node.widgets) || []).filter(function (w) { return w && w.name === name; })[0] || null; }
function bbSetW(node, name, v) { var w = bbW(node, name); if (w) { w.value = v; try { if (typeof w.callback === "function") w.callback(v, node); } catch (e) { /* 忽略 */ } } }

// 建那套内部节点（只在第一次生成时跑）
function bbBuildInner(node) {
  var ox = (node.pos ? node.pos[0] : 0) + BB_INNER_DX;
  var oy = node.pos ? node.pos[1] : 0;
  function mk(t, dx, dy) {
    var n = window.LiteGraph.createNode(t);
    if (!n) return null;
    app.graph.add(n);
    n.pos = [ox + dx, oy + dy];
    try { n.properties = n.properties || {}; n.properties[BB_OWNER] = node.id; } catch (e) { /* 忽略 */ }
    return n;
  }
  var unet = mk("UNETLoader", 0, 0);
  var clipL = mk("CLIPLoader", 0, 220);
  var vae = mk("VAELoader", 0, 440);
  var posEnc = mk("CLIPTextEncode", 380, 0);
  var negEnc = mk("CLIPTextEncode", 380, 220);
  var latent = mk("EmptyLatentImage", 380, 440);
  var ks = mk("KSampler", 780, 0);
  var dec = mk("VAEDecode", 1180, 0);
  // ★ 246 批（他："图像节点也竟然是修改之后的画廊"）→ 内部链末端用**原版 SaveImage**，
  //   拆开黑箱后得到的就是一套原版工作流，不该混进我们自己的节点。
  var gal = mk("SaveImage", 1180, 260);
  if (!unet || !ks) { bbToast("出图失败：本机缺 UNETLoader / KSampler", true); return null; }
  // ★ 247 批（他："CLIP 使用的模型用错了，应该用另外一个才对，也就是 QWEN 306B base 那个"）：
  //   以前取的是下拉里的**第一项**（随便什么都行），必须按名字优先挑他那套：
  //   anima-base-v1.0 / qwen_3_06b_base / qwen_image_vae。找不到才退回第一项。
  function pickOpt(nd, name, prefer) {
    var w = bbW(nd, name);
    if (!w) return;
    var vals = (w.options && w.options.values) || [];
    if (!Array.isArray(vals) || !vals.length) return;
    var hit = null;
    if (prefer) {
      var low = String(prefer).toLowerCase();
      hit = vals.filter(function (v) { return String(v).toLowerCase().indexOf(low) >= 0; })[0] || null;
    }
    w.value = hit || vals[0];
    if (typeof w.callback === "function") { try { w.callback(w.value, nd); } catch (e) { /* 忽略 */ } }
  }
  pickOpt(unet, "unet_name", "anima-base");
  pickOpt(clipL, "clip_name", "qwen_3_06b_base");
  pickOpt(vae, "vae_name", "qwen_image_vae");
  // ★ 246 批（他："既没有连接完全……点运行也会 Prompt has no outputs"）：
  //   上一版这里只连了 3 条，而且 `unet.connect(0, posEnc, 0)` 类型都不对（UNET 出 MODEL、编码要 CLIP）。
  //   现在按原版白模把整条链**全部接上**（LoRA 那几层由 bbSyncInner 之后再插进来）。
  function wire(fn, why) { try { fn(); } catch (e) { log("内部连线失败：" + why, e); } }
  wire(function () { unet.connect(0, ks, 0); }, "unet.model→ks.model");          // LoRA 会插在这条前面
  wire(function () { clipL.connect(0, posEnc, 0); }, "clip→posEnc");
  wire(function () { clipL.connect(0, negEnc, 0); }, "clip→negEnc");
  wire(function () { posEnc.connect(0, ks, 1); }, "posEnc→ks.positive");
  wire(function () { negEnc.connect(0, ks, 2); }, "negEnc→ks.negative");
  wire(function () { latent.connect(0, ks, 3); }, "latent→ks.latent");
  wire(function () { ks.connect(0, dec, 0); }, "ks→dec.samples");
  wire(function () { vae.connect(0, dec, 1); }, "vae→dec.vae");
  wire(function () { dec.connect(0, gal, 0); }, "dec→saveImage");
  bbToast("黑箱已建好内部节点（在右边 " + BB_INNER_DX + "px 处，滚过去能看到）");
  return bbInner(node);
}

// 把面板参数写进内部节点（LoRA 链按点亮数量重建）
function bbSyncInner(node) {
  var st = bbState(node);
  var inn = bbInner(node);
  if (!inn.ok) inn = bbBuildInner(node);   // ★ 243 批：还没建就先建一套
  if (!inn || !inn.ok) return null;
  // ① 提示词
  try { bbSetW(inn.posEnc, "text", String(st.pos || "")); } catch (e) { /* 忽略 */ }
  try { bbSetW(inn.negEnc, "text", String(st.neg || "")); } catch (e) { /* 忽略 */ }
  // ② 尺寸（比例 × 横竖）
  try {
    var r = BB_RATIOS.filter(function (x) { return x.k === bbNormRatio(st.ratio); })[0] || BB_RATIOS[1];
    var w = r.w, h = r.h;
    var horiz = st.orient === "横", vert = st.orient === "竖";
    if (horiz && h > w) { var t1 = w; w = h; h = t1; }
    if (vert && w > h) { var t2 = w; w = h; h = t2; }
    bbSetW(inn.latent, "width", w);
    bbSetW(inn.latent, "height", h);
    // ★ 243 批：张数走 ComfyUI 自己的队列批次（一队出 N 张），不改 latent 的 batch_size
    //   —— 这样出图仍然是"一次执行、一组图"，和画廊的分组逻辑对得上。
    bbSetW(inn.latent, "batch_size", 1);
  } catch (e) { /* 忽略 */ }
  // ③ LoRA 链：按界面顺序重建（角色→画风），颗数 = 亮着的个数
  try {
    var lit = bbLitLoras(node);
    var local = Array.isArray(node.__bbLoras) ? node.__bbLoras : null;
    if (local && local.length) {
      lit = lit.filter(function (x) { return local.indexOf(x.name) >= 0; });
    }
    // 先拆掉旧的 LoRA 节点
    (inn.loras || []).forEach(function (n) { try { app.graph.remove(n); } catch (e) { /* 忽略 */ } });
    // 找 UNET 的 MODEL 和 CLIPLoader 的 CLIP 作为链头
    var headModel = inn.unet, headClip = inn.clip;
    var prevModel = headModel, prevClip = headClip;
    // ★ 247 批（他："最后一个 Lora 的 CLIP 输出节点没有和两个 CLIP 文本编码的输入相连，
    //   Lora 之间也没有 CLIP 的输入和输出相连，但是第一个 Lora 的 CLIP 是连上的"）：
    //   真因 —— CLIPLoader 的 CLIP 输出在 **slot 0**，而 LoraLoader 的 CLIP 输出在 **slot 1**（slot 0 是 MODEL）。
    //   我原来一律 `prevClip.connect(0, …)`：第一次（CLIPLoader）恰好对上，从第二个 LoRA 起就在拿 MODEL 输出连 CLIP 输入
    //   → 类型不匹配、connect 抛异常被 catch 吞掉 → 中间和末尾的 CLIP 全断。用变量记"当前这个节点的 CLIP 在哪个槽"。
    var prevClipSlot = 0;               // CLIPLoader：CLIP 在 slot 0
    var ox = (inn.posEnc ? inn.posEnc.pos[0] : 0) - 380, oy = (inn.unet ? inn.unet.pos[1] : 0);
    lit.forEach(function (it, i) {
      var n = window.LiteGraph.createNode("LoraLoader");
      if (!n) return;
      app.graph.add(n);
      n.pos = [ox + 380, oy + 0];
      try { n.properties = n.properties || {}; n.properties[BB_OWNER] = node.id; } catch (e) { /* 忽略 */ }
      // 名字必须在下拉里才写得进去（本机缺的会被上面 filter 掉）
      bbSetW(n, "lora_name", it.name);
      bbSetW(n, "strength_model", it.model);
      bbSetW(n, "strength_clip", it.clip);
      try { prevModel.connect(0, n, 0); } catch (e) { log("LoRA MODEL 连线失败", e); }
      try { prevClip.connect(prevClipSlot, n, 1); } catch (e) { log("LoRA CLIP 连线失败", e); }
      prevModel = n; prevClip = n; prevClipSlot = 1;   // LoraLoader：CLIP 在 slot 1
    });
    // 链尾接到 编码节点.clip 和 KSampler.model
    // 先把"没有 LoRA 时"那两条直连拆掉（否则插槽被占，新的连接不会生效）
    try {
      var ksIn = inn.ks.inputs && inn.ks.inputs[0];
      if (ksIn && ksIn.link != null) { var l0 = app.graph.links[ksIn.link]; if (l0 && l0.origin_id === inn.unet.id) inn.ks.disconnectInput(0); }
      [inn.posEnc, inn.negEnc].forEach(function (enc) {
        var ci = enc.inputs && enc.inputs[0];
        if (ci && ci.link != null) { var l1 = app.graph.links[ci.link]; if (l1 && l1.origin_id === inn.clip.id) enc.disconnectInput(0); }
      });
    } catch (e) { /* 忽略 */ }
    try { prevClip.connect(prevClipSlot, inn.posEnc, 0); } catch (e) { log("链尾→正编码 CLIP 失败", e); }
    try { prevClip.connect(prevClipSlot, inn.negEnc, 0); } catch (e) { log("链尾→负编码 CLIP 失败", e); }
    try { prevModel.connect(0, inn.ks, 0); } catch (e) { /* 忽略 */ }
  } catch (e) { log("内部 LoRA 链重建失败", e); }
  return bbInner(node);
}

// 点「🎨 生成」
function bbGenerate(node) {
  try {
    var inn = bbInner(node);
    if (!inn.ok) inn = bbBuildInner(node);
    if (!inn || !inn.ok) return false;
    inn = bbSyncInner(node) || inn;
    var st = bbState(node);
    var batch = Math.max(1, Math.min(64, bbFitNum(st.count, 1)));
    bbSave();
    bbPaintOut(node, null, "正在生成…（" + batch + " 张）");
    var p = app.queuePrompt(0, batch);
    if (p && typeof p.catch === "function") p.catch(function (e) { bbPaintOut(node, null, "排队失败：" + (e && e.message)); });
    return true;
  } catch (e) {
    log("生成失败", e);
    bbToast("生成失败：" + (e && e.message), true);
    return false;
  }
}

// 出图区：最近几张缩略图 + 生成按钮
// 一张图怎么显示：存档那边是相对路径（走 gallery/img），原版 SaveImage 是 /view?…
function bbImgSrc(x) {
  var v = String(x || "");
  if (!v) return "";
  if (v.charAt(0) === "/") return v;
  return "/prompt_sync/gallery/img?rel=" + encodeURIComponent(v);
}

function bbPaintOut(node, rels, note) {
  var box = node.__bbOut;
  if (!box) return;
  box.innerHTML = "";
  var st = bbState(node);
  // 按钮排
  var bar = document.createElement("div");
  bar.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:6px";
  var gen = bbBtn("🎨 生成", "border:none;color:#fff;font-weight:700;background:linear-gradient(135deg,#7c5cff,#3b82f6)");
  gen.className = "bb-generate";
  gen.title = "按面板上的词 / LoRA / 尺寸生成；出图会同时存进图像存档";
  gen.addEventListener("click", function (e) { e.stopPropagation(); bbGenerate(node); });
  bar.appendChild(gen);
  var sp = document.createElement("span"); sp.style.cssText = "flex:1 1 auto"; bar.appendChild(sp);
  var tip = document.createElement("span");
  tip.textContent = note || (rels && rels.length ? ("刚出了 " + rels.length + " 张") : (st.lastShown ? "最近生成的" : ""));
  tip.style.cssText = "font-size:10.5px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%";
  bar.appendChild(tip);
  box.appendChild(bar);
  // 缩略图墙（最近 6 张，按组显示）
  var wall = document.createElement("div");
  wall.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto;display:grid;"
    + "grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;align-content:start";
  var list = (rels && rels.length) ? rels : (st.lastShown || []);
  if (!list.length) {
    var ph = document.createElement("div");
    ph.textContent = "点「🎨 生成」就出图（同时存进图像存档）";
    ph.style.cssText = "grid-column:1/-1;margin:auto;font-size:11.5px;opacity:.45;text-align:center;line-height:1.7";
    wall.appendChild(ph);
  } else {
    list.slice(0, 6).forEach(function (rel) {
      var d = document.createElement("div");
      d.style.cssText = "position:relative;border-radius:7px;overflow:hidden;border:1px solid rgba(150,162,180,.3);cursor:zoom-in";
      var im = document.createElement("img");
      im.src = bbImgSrc(rel);
      im.style.cssText = "display:block;width:100%;height:auto";
      im.loading = "lazy";
      d.appendChild(im);
      d.addEventListener("click", function () {
        try { window.__pcBlackBox.showFull(rel); } catch (e) { /* 忽略 */ }
      });
      wall.appendChild(d);
    });
  }
  box.appendChild(wall);
}

function buildPanel(node) {
  var st = bbState(node);
  var root = document.createElement("div");
  root.className = "pc-blackbox";
  root.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%;height:100%;padding:10px;box-sizing:border-box;"
    + "overflow:hidden;min-height:0;font:12.5px/1.6 system-ui,'Microsoft YaHei',sans-serif;color:#e8eaf1";
  var head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 0 auto";
  var ttl = document.createElement("span");
  ttl.textContent = "📦 黑箱";
  ttl.style.cssText = "font-size:13.5px;font-weight:700";
  var spacer = document.createElement("span");
  spacer.style.cssText = "flex:1 1 auto";
  head.appendChild(ttl); head.appendChild(spacer);
  var bFit = bbBtn("⛶ 占满屏幕", "border:none;color:#fff;font-weight:700;background:linear-gradient(135deg,#7c5cff,#3b82f6)");
  bFit.addEventListener("click", function () { fitNodeToScreen(node); });
  head.appendChild(bFit);
  var bKill = bbBtn("🧨 拆掉黑箱", "border-color:rgba(255,120,120,.5);color:#ffb4b4");
  // ★ 238 批（他："黑箱的叫出原版工作流根本不需要存在，拆掉黑箱就是叫出原版工作流，
  //   最多把鼠标悬停在拆掉黑箱上面，会显示解释的小字就行"）→ 这颗就是"叫出原版工作流"
  bKill.title = "叫出原版工作流：把黑箱里装着的那套节点散回画布（LoRA 按你现在点亮的重建层数），这个黑箱同时收起";
  var armed = 0;
  bKill.addEventListener("click", function () {
    if (!armed) {
      armed = Date.now();
      bKill.textContent = "确定吗，不可撤回";
      bKill.style.background = "#d33b3b"; bKill.style.borderColor = "#ff8a8a"; bKill.style.color = "#fff";
      setTimeout(function () {
        if (armed && Date.now() - armed >= 3800) {
          armed = 0; bKill.textContent = "🧨 拆掉黑箱";
          bKill.style.background = "rgba(255,255,255,.06)";
          bKill.style.borderColor = "rgba(255,120,120,.5)"; bKill.style.color = "#ffb4b4";
        }
      }, 4000);
      return;
    }
    dismantle(node);
  });
  head.appendChild(bKill);
  root.appendChild(head);
  var grid = document.createElement("div");
  grid.style.cssText = "flex:1 1 auto;min-height:0;display:grid;gap:8px;"
    + "grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.15fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)";
  var pPos = bbPane("正提示词", "出图时用这段");
  pPos.__body.appendChild(bbTextArea(st, "pos", node, "在这里写正提示词…"));
  grid.appendChild(pPos);
  grid.appendChild(bbLoraPane(node));
  // ★ 243 批（他问过两次"黑箱能使用了吗"，这次真做成能出图的）：
  //   出图区不再是占位 —— 里面是"最近几张"的缩略图 + 一颗「🎨 生成」按钮。
  var pOut = bbPane("出图", "生成的图放这里");
  pOut.style.gridRow = "span 2";
  var outBox = document.createElement("div");
  outBox.className = "bb-out";
  outBox.style.cssText = "flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px";
  pOut.__body.appendChild(outBox);
  node.__bbOut = outBox;
  grid.appendChild(pOut);
  var pNeg = bbPane("负提示词", "出图时一起用");
  pNeg.__body.appendChild(bbTextArea(st, "neg", node, "在这里写负提示词…"));
  grid.appendChild(pNeg);
  grid.appendChild(bbOptPane(node));
  root.appendChild(grid);
  node.__fit = function () { return fitNodeToScreen(node); };
  return root;
}

var registered = false;
// ⚠️ 新版 ComfyUI 的 `LiteGraph.createNode()` 只认**后端 `/object_info` 里有的**类型 —— 纯前端类型即使
//   `registerNodeType` 注册成功，`createNode` 也返回 null（实测）。所以这里**直接 new 一个**再 `graph.add`，
//   并手动补上 `createNode` 本来会帮我们调的那一步初始化。
// ★ 204 批（他贴图："黑箱虽然说是占满了整个屏幕，实际上还留了很多空隙"）：
//   光让节点大没用 —— **面板元素本身没跟着长**（宽度还停在建节点时那个值），所以节点里一大片空白。
//   和自定义优化窗同一个坑：`computeSize` 只影响布局预留，真正要钉的是元素的宽高。
function bbFit(node) {
  try {
    var el = node && node.__w && node.__w.element;
    if (!el || !node.size) return;
    el.style.width = Math.max(260, Math.round(node.size[0] - 16)) + "px";
    el.style.height = Math.max(160, Math.round(node.size[1] - 34)) + "px";
  } catch (e) { /* 忽略 */ }
}
function bbInit(node) {
  try {
    if (node.__pcBBReady) return;
    node.__pcBBReady = true;
    node.__bbMissingDialog = bbMissingDialog;   // ★ 238 批：点"缺"的 LoRA 时弹下载地址
    node.setSize([W, H]);
    node.title = "📦 黑箱";
    node.__pcMinSize = [420, 300];
    var clamp = function () {
      var m = node.__pcMinSize, s = node.size || [W, H];
      if (s[0] < m[0] || s[1] < m[1]) node.setSize([Math.max(s[0], m[0]), Math.max(s[1], m[1])]);
    };
    clamp();
    var orz = node.onResize;
    node.onResize = function () {
      var r = orz ? orz.apply(this, arguments) : undefined;
      try { clamp(); bbFit(node); } catch (e) { /* 忽略 */ }
      return r;
    };
    var panel = buildPanel(node);
    if (typeof node.addDOMWidget === "function") {
      node.__w = node.addDOMWidget("黑箱面板", "pcBlackBox", panel, { serialize: false, hideOnZoom: false });
      node.__w.computeSize = function () {
        var s = node.size || [W, H];
        return [Math.max(260, s[0] - 16), Math.max(160, s[1] - 34)];
      };
      setTimeout(function () { bbFit(node); }, 60);
    }
    // ★ 236 批：先把原版工作流模板预取好（点「拆掉」/「叫出原版」时就是同步的）
    try { bbTemplate().catch(function () { /* 失败时点按钮会自己提示 */ }); } catch (e) { /* 忽略 */ }
    // ★ 243 批：出图区（最近几张 + 生成按钮）
    try { bbPaintOut(node); } catch (e) { /* 忽略 */ }
    log("黑箱已就绪", node.id);
  } catch (e) { log("初始化失败", e); }
}
function registerType() {
  if (registered) return true;
  var LG = window.LiteGraph;
  if (!LG || !LG.registerNodeType || !LG.LGraphNode) return false;
  // ⚠️ `LGraphNode` 是 **ES class**，不能 `Base.call(this)`（会抛 "Class constructor cannot be invoked without 'new'"）
  //   → 必须用 `extends` + `super()`。
  class BlackBox extends LG.LGraphNode {
    constructor() {
      super("📦 黑箱");
      this.type = NODE_NAME;                 // 直接 new 不会自动补 type（createNode 才会），序列化要靠它
      // ★ 245 批（他报 `Node '📦 黑箱' has no class_type`）：纯前端节点没有 comfyClass，
      //   一旦有人调 queuePrompt（比如 243 批加的「🎨 生成」），graphToPrompt 遍历全图就会抛这个错。
      //   给一个"真实存在但什么都不做"的 class —— 工具栏节点（RETURN_TYPES=()、非 OUTPUT_NODE）。
      this.comfyClass = "PromptToolToolbar";
      this.title = "📦 黑箱";
      this.size = [W, H];
      this.resizable = true;
      this.serialize_widgets = true;
    }
    onNodeCreated() { bbInit(this); }
    onConfigure() {
      try { if (this.size) this.setSize(this.size); } catch (e) { /* 忽略 */ }
      // ★ 238 批（第 7 条）：切工作流再切回来时，节点是 createNode + configure 出来的，
      //   **onNodeCreated 不会跑** → 面板（DOM widget）根本不存在 → 看起来像"节点坏了/空了"。
      //   这里补一次 bbInit（它自己有 __pcBBReady 闸，建过就不会重复建）。
      // ★ 245 批：从工作流读回来的黑箱，type / comfyClass 一律纠回正确值
      //   （老版本存下来过 `type: "📦 黑箱"` 这种脏数据，会直接导致提交时报 has no class_type）
      try {
        this.type = NODE_NAME;
        this.comfyClass = "PromptToolToolbar";
      } catch (e) { /* 忽略 */ }
      try { if (!this.__pcBBReady) bbInit(this); } catch (e) { log("configure 后重建面板失败", e); }
      // ★ 243 批：读取工作流后，把上次那几张图接着显示出来
      try { bbPaintOut(this); } catch (e) { /* 忽略 */ }
    }
  }
  BlackBox.title = "📦 黑箱";
  try { LG.registerNodeType("提示词工具/黑箱", BlackBox); } catch (e) { log("注册类型失败（不影响直接创建）", e); }
  // ★ 238 批（他："黑箱在切到其他工作流的时候，再切回来的时候就会直接报错，说这个节点错误"）
  //   真因：构造函数里 this.type = NODE_NAME（"PromptToolBlackBox"），存进工作流的就是这个 type；
  //   可注册名是 "提示词工具/黑箱" → 重新加载时 createNode("PromptToolBlackBox") 找不到 → 报节点错误。
  //   修法：同一个类用两个名字都注册（老工作流里的 type 也认）。
  try { LG.registerNodeType(NODE_NAME, BlackBox); } catch (e2) { /* 已注册就忽略 */ }
  window.__pcBlackBoxCtor = BlackBox;
  registered = true;
  return true;
}

// ★ 243 批：出图回传 —— 图像画廊节点出图后会把文件名报上来（它的 collect 返回 pc_gallery），
//   这里按 pcBBOwner 认出"这是哪颗黑箱的内部画廊"，把图记到那颗黑箱上并重画出图区。
function bbHookExecuted() {
  try {
    // ★ 2026-11-06（他："黑箱召唤出工作流生成的图，黑箱自己不显示"）：
    //   以前只认 `app.api`，万一那一版没有这个属性，钩子根本挂不上、界面又一点提示都没有 → 静默不出图。
    var A = (app && app.api) || window.api || null;
    if (window.__pcBBExecHooked || !A || !A.addEventListener) return false;
    window.__pcBBExecHooked = true;
    A.addEventListener("executed", function (ev) {
      try {
        var d = (ev && ev.detail) || {};
        // ★ 248 批（他："出图并不会在右栏出现图片"）：
        //   真因 —— ComfyUI 的 `executed` 事件里，节点输出挂在 **`detail.output`** 下面，
        //   SaveImage 的图是 `detail.output.images`，不是 `detail.images`（那条路径永远是 undefined）。
        var rels = (d.output && d.output.pc_gallery) || d.pc_gallery;
        if (!rels || !rels.length) {
          var imgs = (d.output && d.output.images) || d.images || [];
          rels = imgs.filter(function (x) { return x && x.filename; }).map(function (x) {
            return "/view?filename=" + encodeURIComponent(x.filename)
              + "&subfolder=" + encodeURIComponent(x.subfolder || "")
              + "&type=" + encodeURIComponent(x.type || "output");
          });
        }
        if (!rels || !rels.length) return;
        var all = ((app.graph && app.graph._nodes) || []).filter(Boolean);
        // ★ 2026-11-06：`d.node` 是**字符串**（服务端就是这么发的），而 `n.id` 是数字 ——
        //   以前用 `===` 比，永远对不上 → owner 永远是 null → 黑箱右栏一张图都不出。
        //   现在两边都转成字符串比，并且 `node` / `display_node` 两个字段都试。
        var cands = [d.node, d.display_node];
        var hitN = null;
        for (var i = 0; i < cands.length && !hitN; i++) {
          if (cands[i] == null) continue;
          var key = String(cands[i]);
          hitN = all.filter(function (n) { return String(n.id) === key; })[0] || null;
        }
        var owner = (hitN && hitN.properties) ? hitN.properties[BB_OWNER] : null;
        var bb = owner != null ? all.filter(function (n) { return String(n.id) === String(owner); })[0] : null;
        // 兜底：画布上只有一颗黑箱 → 就当成它的（宁可认错也不静默不出图）
        if (!bb) {
          var boxes = all.filter(function (n) { return n && n.type === NODE_NAME; });
          if (boxes.length === 1) bb = boxes[0];
        }
        if (!bb) {
          var boxes0 = all.filter(function (n) { return n && n.type === NODE_NAME; });
          if (boxes0.length > 1) { try { bbToast("出图了，但画布上有好几颗黑箱、没认出是哪颗 —— 只留一颗再试", true); } catch (eT) { } }
          log("出图了，但没认出是哪颗黑箱", d.node, d.display_node);
          return;
        }
        var st = bbState(bb);
        st.lastShown = rels.slice(0, 12);
        bbSave();
        bbPaintOut(bb, rels, null);
        log("黑箱出图完成", rels.length, "张");
      } catch (e) { /* 忽略 */ }
    });
    log("出图回传钩子已挂上");
    return true;
  } catch (e) { log("出图回传钩子挂载失败", e); return false; }
}

// ★ 245 批兜底：万一哪天 comfyClass 又被弄丢，提交前把黑箱临时设成 BYPASS（mode=4，前端会跳过它）。
//   graphToPrompt 的节点遍历是**同步**的（在第一个 await 之前），所以包一层同步的 mode 切换是安全的。
function bbHookGraphToPrompt() {
  try {
    if (window.__pcBBG2PHooked || !app || typeof app.graphToPrompt !== "function") return false;
    window.__pcBBG2PHooked = true;
    const orig = app.graphToPrompt.bind(app);
    app.graphToPrompt = function () {
      const bbs = ((app.graph && app.graph._nodes) || []).filter(function (n) { return n && n.type === NODE_NAME; });
      const saved = bbs.map(function (n) { return { n: n, mode: n.mode }; });
      // ★ 246 批（他："如果不点生成，点运行的话，也会有 Prompt has no outputs 的错误提示"）：
      //   画布上只有黑箱时，黑箱是壳、没有任何输出节点 → 前端会拒绝提交。
      //   这里在提交前**自动把内部链建好并接上**，这样"直接点运行"也能出图。
      try {
        var hasOut = ((app.graph && app.graph._nodes) || []).some(function (n) {
          return n && n.constructor && n.constructor.nodeData && n.constructor.nodeData.output_node;
        });
        if (!hasOut) {
          saved.forEach(function (x) {
            try {
              if (!bbInner(x.n).ok) bbBuildInner(x.n);
              bbSyncInner(x.n);
            } catch (e2) { log("提交前补内部链失败", e2); }
          });
        }
      } catch (e3) { /* 忽略 */ }
      saved.forEach(function (x) { try { x.n.mode = 4; } catch (e) { /* 忽略 */ } });
      let out;
      try { out = orig.apply(null, arguments); }
      finally { saved.forEach(function (x) { try { x.n.mode = x.mode | 0; } catch (e) { /* 忽略 */ } }); }
      return out;
    };
    log("提交前跳过黑箱的钩子已挂上");
    return true;
  } catch (e) { log("graphToPrompt 钩子失败", e); return false; }
}

app.registerExtension({
  name: "PromptSync.BlackBox",
  async setup() {
    registerType();
    setTimeout(bbHookExecuted, 1200);
    setTimeout(bbHookExecuted, 4000);
    setTimeout(bbHookGraphToPrompt, 1400);
    setTimeout(bbHookGraphToPrompt, 4200);
  },
});

// 给工具栏 / 控制台用的钩子
window.__pcBlackBox = {
  create: function () {
    try {
      registerType();
      var Ctor = window.__pcBlackBoxCtor;
      if (!Ctor) return null;
      var n = new Ctor();                       // ← 直接 new（createNode 只认后端类型）
      bbInit(n);
      setTimeout(function () { bbFit(n); }, 80);
      var c = app.canvas;
      var el = canvasEl();
      var vx = 60, vy = 60;
      try {
        if (c && c.ds && el) {
          vx = (30 / c.ds.scale) - c.ds.offset[0];
          vy = (30 / c.ds.scale) - c.ds.offset[1];
        }
      } catch (e) { /* 忽略 */ }
      n.pos = [vx, vy];
      app.graph.add(n);
      app.graph.setDirtyCanvas(true, true);
      return n;
    } catch (e) { console.error("[BlackBox] create 失败", e); return null; }
  },
  fit: function (n) { return fitNodeToScreen(n || app.graph._nodes.filter(function (x) { return x && x.type === NODE_NAME; })[0]); },
  restore: restoreView,
  types: function () { return (app.graph._nodes || []).filter(function (x) { return x && x.type === NODE_NAME; }); },
  // ★ 236 批：模板 / 生成的自测口
  tmplReady: bbTmplReady,
  loadTmpl: function () { return bbTemplate(); },
  tmpl: function () { return _bbTmpl ? { nodes: _bbTmpl.nodes.length, links: (_bbTmpl.links || []).length } : null; },
  lit: function (n) { return bbLitLoras(n || (window.__pcBlackBox.types()[0])); },
  chain: function (data) { return bbLoraChain(data || _bbTmpl).map(function (x) { return x.id + ":" + (x.widgets_values || [])[0]; }); },
  // ★ 243 批：真出图
  generate: function (n) { return bbGenerate(n || window.__pcBlackBox.types()[0]); },
  inner: function (n) { var i = bbInner(n || window.__pcBlackBox.types()[0]); return i ? { ok: i.ok, loras: i.loras.length, mine: i.mine.length } : null; },
  sync: function (n) { return !!bbSyncInner(n || window.__pcBlackBox.types()[0]); },
  lastShown: function (n) { var st = bbState(n || window.__pcBlackBox.types()[0]); return st.lastShown || []; },
  showFull: function (rel) {
    try {
      var back = document.createElement("div");
      back.style.cssText = "position:fixed;inset:0;z-index:100098;background:rgba(4,6,10,.93);display:flex;align-items:center;justify-content:center";
      var im = document.createElement("img");
      im.src = "/prompt_sync/gallery/img?rel=" + encodeURIComponent(rel);
      im.style.cssText = "max-width:94vw;max-height:92vh;border-radius:8px";
      back.appendChild(im);
      back.addEventListener("click", function () { try { back.remove(); } catch (e) { /* 忽略 */ } });
      document.body.appendChild(back);
      return true;
    } catch (e) { return false; }
  },
  catalog: function () { return _bbCat ? _bbCat.map(function (x) { return x.file; }) : null; },
  label: bbLabelOf,
  catOf: bbCatOf,
  missingDialog: function (node, file) {
    var it = bbCatOf(file);
    if (!it) return false;
    if (node && node.__bbMissingDialog) { node.__bbMissingDialog(it); return true; }
    return false;
  },
  trimPreview: function (litCount) {
    if (!_bbTmpl) return null;
    var fake = [];
    for (var i = 0; i < litCount; i++) fake.push({ name: "fake" + i + ".safetensors", model: 0.9, clip: 0.8 });
    var d = bbBuildTrimmed(bbClone(_bbTmpl), fake);
    return { nodes: d.nodes.length, links: d.links.length, chain: bbLoraChain(d).map(function (x) { return (x.widgets_values || [])[0]; }) };
  },
  spawn: function (n, trim) { return bbSpawn(n || window.__pcBlackBox.types()[0], { trim: !!trim }); },
  dismantle: function (n) { return dismantle(n || window.__pcBlackBox.types()[0]); },
  spawnOriginal: function (n) { return spawnOriginal(n || window.__pcBlackBox.types()[0]); },
};
