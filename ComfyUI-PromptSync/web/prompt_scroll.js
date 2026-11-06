// ============================================================================
// 节点「高度能拖小 + 装不下的内容裁掉 + 右边自动出现滚轮」（2026-10-08 第一百二十六批 · 他给的第 2 条）
//
// 他的原话：「空 latent（自填宽高像素）、游动羽翼工具栏、计时器都要有拖动改变高度的功能，拖动之后，
//   最下面的东西就会被折叠遮住，然后右边自动出现滚轮，可以往下滚，把被遮住的东西滚出来」
//   ＋「工具栏和计时器都是从下往上遮，但是空 latent 它不一样，它是从上往下遮」。
//
// 为什么以前拖不小（真前端 api-BqIxvqZ8.js 里查实的）：
//   `_arrangeWidgets()` 最后一句是 `!vueNodesMode && l > t && (this.setSize([this.size[0], l]), …)`
//   —— `l` = 控件摞的底部、`t` = `bodyHeight`（= 节点高度）。**内容装不下就自动把节点撑高**，
//   所以你把节点拖小，下一帧就被撑回去，看起来就是"不能拖高度"。
//
// 这套做法（全部在节点自己身上，不动全局设置）：
//   ① 不用前端的 `clip_area`（它会把标题栏 / 圆角一起裁掉）—— 自己包 `drawNodeWidgets` 只裁控件可视区；
//   ② 拦 `_arrangeWidgets`：先让前端照常摆，摆完把 `size[1]` 改回**你要的高度**（不许自动撑高），
//      再按滚动量把控件摞整体挪一段；
//   ③ `onDrawForeground` 里在右边画一条滚轮（**只在内容真的装不下时**才出现）；
//   ④ 窗口捕获阶段听 `wheel`：光标落在节点框里就滚它，并 `preventDefault` 掉（画布缩放不受影响）。
//
// 两种锚法（他点名要分开）：
//   · `anchor:"top"`（工具栏）= **从下往上遮**：控件摞贴着上边排，节点拖小就先遮住**下面**的，
//     往下滚把它们滚出来；
//   · `anchor:"bottom"`（空 Latent）= **从上往下遮**：控件摞贴着下边（预览框上面）排，节点拖小就先遮住
//     **上面**的，往下滚把它们滚出来。
//
// 用法：这个文件**自己**注册一个扩展，在 `beforeRegisterNodeDef` 里给这两颗节点装上
//   （所以不用改各节点脚本、也不怕脚本加载顺序 —— 见文件末尾的 registerExtension）。
// ============================================================================
import { app } from "../../scripts/app.js";     // ⚠️ 前端这些脚本是当 ES 模块加载的，`app` 必须显式 import
                                                //    （裸用 app = 扩展静默不注册；test_sync_node.py 里钉着这条守卫）
(function () {
  if (window.__pcScroll) return;
  var NODE_WIDGET_H = 20;                    // 前端 `NODE_WIDGET_HEIGHT`（没 computeSize 的控件就按这个算）

  function nodes() {
    try { return ((app && app.graph && app.graph._nodes) || []).filter(Boolean); }
    catch (e) { return []; }
  }
  function toGraph(ev) {                     // 鼠标事件 → 画布坐标（和别处同一套：优先问画布，问不到自己算）
    var c = app && app.canvas;
    if (!c) return null;
    try { if (typeof c.convertEventToCanvasOffset === "function") return c.convertEventToCanvasOffset(ev); } catch (e) { /* 忽略 */ }
    try {
      var r = c.canvas.getBoundingClientRect(), ds = c.ds || { scale: 1, offset: [0, 0] };
      return [(ev.clientX - r.left) / ds.scale - ds.offset[0], (ev.clientY - r.top) / ds.scale - ds.offset[1]];
    } catch (e) { return null; }
  }
  function redraw(node) {
    try { if (node && node.graph) node.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
    try { if (app && app.canvas && app.canvas.setDirty) app.canvas.setDirty(true, true); } catch (e) { /* 忽略 */ }
  }
  function layoutWidgets(node) {
    try {
      if (node && typeof node.getLayoutWidgets === "function") return node.getLayoutWidgets() || [];
    } catch (e) { /* 忽略 */ }
    return ((node && node.widgets) || []).filter(function (w) { return w && !w.hidden; });
  }
  function startY(node, base) {              // 控件摞从哪儿开始排（和前端 `_arrangeWidgets` 的 n 一模一样）
    if (node && typeof node.widgets_start_y === "number") return node.widgets_start_y;
    if (node && typeof node.__pcScrollBase === "number") return (node.widgets_up ? 0 : node.__pcScrollBase) + 2;
    return (node && node.widgets_up ? 0 : (Number(base) || 30)) + 2;
  }
  function geom(node, base) {
    var opt = (node && node.__pcScrollOpt) || {};
    var ws = layoutWidgets(node), total = 0, i;
    for (i = 0; i < ws.length; i++) total += (Number(ws[i].computedHeight) || (NODE_WIDGET_H + 4));
    var h = (node && node.size ? node.size[1] : 0) || 0;
    var padB = Number(opt.padBottom) || 0, padT = Number(opt.padTop) || 0;
    var viewTop = (opt.anchor === "bottom") ? padT : startY(node, base);
    var viewBottom = Math.max(viewTop, h - padB);
    var viewH = Math.max(0, viewBottom - viewTop);
    var over = Math.max(0, total - viewH);
    var sc = Math.min(over, Math.max(0, Number(node.__pcScrollY) || 0));
    return { ws: ws, total: total, over: over, scroll: sc, viewTop: viewTop, viewBottom: viewBottom,
      viewH: viewH, anchor: opt.anchor === "bottom" ? "bottom" : "top" };
  }
  function applyScroll(node, base) {
    if (!node || !node.__pcScrollOn) return null;
    var g = geom(node, base);
    node.__pcScrollY = g.scroll;
    var y = (g.anchor === "bottom") ? (g.viewBottom - g.total + g.scroll) : (g.viewTop - g.scroll);
    for (var i = 0; i < g.ws.length; i++) {
      var w = g.ws[i];
      w.y = y;
      y += (Number(w.computedHeight) || (NODE_WIDGET_H + 4));
    }
    node.__pcScrollGeom = g;
    return g;
  }

  // ==========================================================================
  // 「他拖出来的高度」怎么记住（第一百四十四~一百四十五批）
  //
  // 他原话（144 批）：「游动羽翼工具栏和空 latent 调整的高度会在刷新或者重新打开之后重置，应该保留才对」
  //               （145 批）：「工具栏和空 latent 拖动改变高度之后还是一样的呀，刷新就重置了」
  //
  // ⚠️⚠️ **144 批那版是错的，真因在下面这段（这次用真前端扒出来的）**：
  //   真前端 `ComfyNode.expandToFitContent()`（被 `addWidget` / `addInput` / `addOutput` 调）
  //   和 `_arrangeWidgets()` 尾巴那句，都会在**载入工作流时把节点撑到"内容那么高"**，
  //   它们走的是 `setSize()` → `onResize()`；而那时候 `__pcInArrange` 是 false →
  //   老代码的 `saveUserH()` 就把"**被撑大的尺寸**"当成"他拖的"记进了 `pcScrollH`，
  //   后面三次恢复读到的已经是那个大尺寸 → 自然什么都没恢复（他看到的还是重置）。
  //
  // 修法三条：
  //   ① **只有"指针真的按在这颗节点上"才记高度**（载入时的自动撑高不算，"他拖的"才算）；
  //   ② 记下来的高度存**两处**：`properties.pcScrollH`（跟着工作流走、别人打开也有）
  //      ＋ localStorage（这台机器上刷新 / 重开工作流都记得住，**哪怕他没保存工作流**）；
  //   ③ 记下来之后它就是这颗节点的**目标高度** `__pcWantH` —— `_arrangeWidgets` /
  //      `expandToFitContent` 之后一律按它纠回来。谁再想把节点撑大，下一帧就弹回去。
  // ==========================================================================
  const H_KEY = "pcScrollH";                 // 存在 properties 里（跟着工作流走）
  const H_STORE = "pcToolNodeH.v1";          // 存在 localStorage 里（这台机器上记住他最后拖的高度）
  function storeAll() {
    try { var o = JSON.parse(localStorage.getItem(H_STORE) || "{}"); return (o && typeof o === "object") ? o : {}; }
    catch (e) { return {}; }
  }
  function storeGet(type) {
    var v = Math.round(Number(storeAll()[type]));
    return (v > 0 && v < 4000) ? v : 0;
  }
  function storeSet(type, h) {
    try { var o = storeAll(); if (o[type] !== h) { o[type] = h; localStorage.setItem(H_STORE, JSON.stringify(o)); } }
    catch (e) { /* 忽略 */ }
  }
  // 这颗是"哪一类节点"（localStorage 那份记忆的键）——
  //   优先问 patch 时就写下的类型名（`opt.name` / proto 上那份），实例的 `comfyClass` / `type` 兜底。
  function typeOf(node) {
    try {
      var o = (node && node.__pcScrollOpt) || null;
      if (o && o.name) return String(o.name);
      var p = node && node.__pcScrollName;
      if (p) return String(p);
      return String((node && (node.comfyClass || node.type)) || "");
    } catch (e) { return ""; }
  }
  function propH(node) {
    try { var h = Math.round(Number(node.properties && node.properties[H_KEY])); return (h > 0 && h < 4000) ? h : 0; }
    catch (e) { return 0; }
  }
  // 「他拖出来的高度」：这台机器上记着的优先（比工作流里那份新），没有才退回工作流里那份
  function wantHOf(node) { return storeGet(typeOf(node)) || propH(node); }
  function rememberH(node, h) {
    h = Math.round(h);
    if (!(h > 0)) return;
    try { node.properties = node.properties || {}; if (node.properties[H_KEY] !== h) node.properties[H_KEY] = h; } catch (e) { /* 忽略 */ }
    storeSet(typeOf(node), h);
    node.__pcWantH = h;
  }
  function saveUserH(node) {                 // ⚠️ 只允许在"指针真按在这颗节点上"的时候调（见 hookPointer）
    try {
      if (!node || !node.size || (node.flags && node.flags.collapsed)) return;
      if (!node.__pcScrollReady) return;                      // 刚建出来那一下不算"他拖的"
      rememberH(node, node.size[1]);
    } catch (e) { /* 忽略 */ }
  }
  function restoreUserH(node) {              // 把"他拖出来的高度"放回去（返回"有没有真动过"）
    try {
      var h = wantHOf(node);
      if (!(h > 0) || !node.size) return false;
      node.__pcWantH = h;
      if (Math.abs(node.size[1] - h) < 1) return false;
      node.size[1] = h;
      if (typeof node.setSize === "function") node.setSize([node.size[0], h]);
      return true;
    } catch (e) { return false; }
  }
  // ★ 指针门闸：载入工作流时前端会自己把节点撑高（setSize → onResize），那不是"他拖的"。
  //   判据 = **按下鼠标那一刻光标就在这颗节点框里**（拖边角有时会往外偏几 px → 放宽 14px）。
  function hookPointer() {
    try {
      if (window.__pcScrollPtrHooked) return false;
      window.__pcScrollPtrHooked = true;
      var cur = null;
      function down(ev) {
        try {
          var n = nodeAt(ev, 14);
          if (cur && cur !== n) cur.__pcScrollDown = false;
          cur = n;
          if (n) n.__pcScrollDown = true;
        } catch (e) { /* 忽略 */ }
      }
      function up() {
        try { if (cur) cur.__pcScrollDown = false; } catch (e) { /* 忽略 */ }
        cur = null;
      }
      ["mousedown", "pointerdown"].forEach(function (k) { document.addEventListener(k, down, true); });
      ["mouseup", "pointerup", "pointercancel"].forEach(function (k) {
        document.addEventListener(k, up, true);
        window.addEventListener(k, up, true);
      });
      window.addEventListener("blur", up, true);
      return true;
    } catch (e) { return false; }
  }
  function drawBar(node, ctx) {
    var g = node && node.__pcScrollGeom;
    if (!ctx || !g || g.over <= 0 || g.viewH <= 12) return;
    var w = (node.size ? node.size[0] : 0) || 0;
    var barW = 5, x = Math.max(2, w - barW - 3);
    var thumbH = Math.max(18, Math.round(g.viewH * g.viewH / Math.max(1, g.total)));
    var span = Math.max(0, g.viewH - thumbH);
    var ty = g.viewTop + (g.over > 0 ? Math.round(span * g.scroll / g.over) : 0);
    ctx.save();
    try {
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, g.viewTop, barW, g.viewH, 3); else ctx.rect(x, g.viewTop, barW, g.viewH);
      ctx.fill();
      ctx.fillStyle = "rgba(150, 190, 255, 0.85)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, ty, barW, thumbH, 3); else ctx.rect(x, ty, barW, thumbH);
      ctx.fill();
    } catch (e) { /* 画不出来不影响节点 */ }
    ctx.restore();
  }
  function nodeAt(ev, pad) {
    var p = toGraph(ev);
    if (!p) return null;
    var m = Number(pad) || 0;
    var ns = nodes();
    for (var i = ns.length - 1; i >= 0; i--) {          // 后画的在上层
      var n = ns[i];
      if (!n || !n.__pcScrollOn || !n.size || (n.flags && n.flags.collapsed)) continue;
      if (p[0] < n.pos[0] - m || p[0] > n.pos[0] + n.size[0] + m) continue;
      if (p[1] < n.pos[1] - m || p[1] > n.pos[1] + n.size[1] + m) continue;
      return n;
    }
    return null;
  }
  function onWheel(ev) {
    try {
      var n = nodeAt(ev);
      if (!n) return;
      var g = n.__pcScrollGeom || geom(n, n.__pcScrollBase);
      if (!g || g.over <= 0) return;
      var step = (ev.deltaY > 0 ? 1 : -1) * 40;
      var next = Math.min(g.over, Math.max(0, g.scroll + step));
      if (typeof ev.preventDefault === "function") ev.preventDefault();      // 别让画布跟着缩放 / 平移
      if (typeof ev.stopPropagation === "function") ev.stopPropagation();
      if (next === g.scroll) return;
      n.__pcScrollY = next;
      try { if (typeof n.arrange === "function") n.arrange(); } catch (e) { applyScroll(n, n.__pcScrollBase); }
      redraw(n);
    } catch (e) { /* 忽略 */ }
  }
  function hookWheel() {
    try {
      if (window.__pcScrollWheelHooked) return false;
      window.__pcScrollWheelHooked = true;
      window.addEventListener("wheel", onWheel, { capture: true, passive: false });
      return true;
    } catch (e) { return false; }
  }
  // ★ 第一百三十五批（他："他们长得都不像节点了，名字都没有了，头部也尖尖方方的"）：
  //   **不再用前端的 `clip_area`** —— 它把整颗节点（含标题栏那一块 / 圆角）一起裁进一个方框里，
  //   节点一小就"名字没了、头变方"。改成**只裁控件那一块**：包一层画布的 `drawNodeWidgets`，
  //   进它之前按"控件可视区"（viewTop → 底边）裁、画完 restore ✓ 标题栏 / 圆角 / 外框一律不动。
  function hookWidgetClip() {
    try {
      if (window.__pcWidgetClipHooked) return false;
      var C = (app && app.canvas && app.canvas.constructor && app.canvas.constructor.prototype) || null;
      if (!C || typeof C.drawNodeWidgets !== "function") return false;
      window.__pcWidgetClipHooked = true;
      var orig = C.drawNodeWidgets;
      C.drawNodeWidgets = function (node, posY, ctx) {
        if (!node || !node.__pcScrollOn || !ctx) return orig.apply(this, arguments);
        var g = null;
        try { g = node.__pcScrollGeom || null; } catch (e) { g = null; }
        var w = (node.size ? node.size[0] : 0) || 0;
        var top = g ? g.viewTop : 0;
        var bottom = g ? (g.viewBottom + (Number((node.__pcScrollOpt || {}).padBottom) || 0)) : (node.size ? node.size[1] : 0);
        if (!(bottom > top)) return orig.apply(this, arguments);
        ctx.save();
        try {
          ctx.beginPath();
          ctx.rect(0, top, w, bottom - top);
          ctx.clip();
        } catch (e) { /* 裁不了就照常画 */ }
        var r;
        try { r = orig.apply(this, arguments); } finally { try { ctx.restore(); } catch (e) { /* 忽略 */ } }
        return r;
      };
      return true;
    } catch (e) { return false; }
  }

  // —— 给一个节点类型装上（每个类型只装一次）——
  function patchProto(proto, options) {
    if (!proto || proto.__pcScrollPatched) return false;
    proto.__pcScrollPatched = true;
    proto.__pcScrollOn = true;                 // 实例继承这个标记（`applyScroll` 靠它认"这颗节点归我管"）
    var opt = options || {};
    if (opt.name) proto.__pcScrollName = String(opt.name);      // 这颗是"哪一类节点"（localStorage 的键）
    hookWheel();
    hookPointer();
    hookWidgetClip();
    var origArrange = proto._arrangeWidgets;
    proto._arrangeWidgets = function (base) {
      if (!this.__pcScrollOn) this.__pcScrollOn = true;
      this.__pcScrollOpt = opt;
      this.clip_area = false;                             // ① 不用前端那套整节点裁剪（会把标题/圆角裁掉）
      // ② 目标高度 = 他拖出来的那个（`__pcWantH`）；没有就沿用当前的（= 老行为）
      var want = Number(this.__pcWantH) || 0;
      var keep = want > 0 ? want : (this.size ? this.size[1] : 0);
      var r = null;
      this.__pcInArrange = true;                          // 排版期间改的高度不算"他拖的"
      try { r = origArrange ? origArrange.call(this, base) : null; } catch (e) { r = null; }
      finally { this.__pcInArrange = false; }
      try { if (this.size && keep) { this.size[1] = keep; } } catch (e) { /* 忽略 */ }   // 不许「装不下就自动撑高」
      if (typeof base === "number") this.__pcScrollBase = base;
      this.__pcCapComputeSize();
      try { applyScroll(this, base); } catch (e) { /* 忽略 */ }
      this.__pcScrollReady = true;        // ★ 第一百三十五批：第一次排版跑完 = 节点已成型
      return r;
    };
    // ★ 第一百四十五批：真前端还有一条**绕过 arrange** 的撑高路线 ——
    //   `ComfyNode.expandToFitContent()`（加控件 / 加输入口 / 加输出口时调）直接 `setSize()`。
    //   载入工作流时就是它把"拖矮的节点"撑回了内容高。这里包一层：撑完立刻按 `__pcWantH` 纠回来。
    var origFit = proto.expandToFitContent;
    if (typeof origFit === "function" && !proto.__pcFitPatched) {
      proto.__pcFitPatched = true;
      proto.expandToFitContent = function () {
        var r = origFit.apply(this, arguments);
        try {
          var want = Number(this.__pcWantH) || 0;
          if (want > 0 && this.size && Math.abs(this.size[1] - want) >= 1) {
            this.size[1] = want;
            if (typeof this.setSize === "function") this.setSize([this.size[0], want]);
          }
        } catch (e) { /* 忽略 */ }
        return r;
      };
    }
    // ★ 第一百三十五批（他第 133 批之后又报"拖高度还是拖不到原有最小高度以下"）：
    //   真前端（api-BqIxvqZ8.js）拖边角改尺寸那段是 `let l = n.computeSize(); …
    //   o.height < l[1] && (…, o.height = l[1])` → **能拖多矮完全由 `computeSize()[1]` 决定**。
    //   以前这三颗的 computeSize 返回"整摞内容"的高度 → 拖到那儿就停住、滚轮永远出不来。
    //   ⚠️ 这顶"最小高度帽子"必须在**实例**上挂（不能在 proto 上）：各节点自己的 js 也会包一层
    //   computeSize（计时器 +168、空 Latent +PREVIEW_H 86），proto 上的包装谁里谁外看加载顺序、不可靠；
    //   实例上挂 = 一定是最外层 ✓。挂的时机 = 第一次排版/画帧（那时尺寸已经定下来了，
    //   所以**新建 / 刚载入那一刻不压** → 新节点初始尺寸跟以前一样）。
    proto.__pcCapComputeSize = function () {
      if (this.__pcCSCapped) return;
      this.__pcCSCapped = true;
      var cap = Number(opt.minH) || 0;
      if (!cap) return;
      var inner = this.computeSize, self = this;
      this.computeSize = function (out) {
        var s = (inner ? inner.apply(self, arguments) : null) || out || null;
        var w = (s && Number(s[0])) || (self.size ? self.size[0] : 320);
        var full = (s && Number(s[1])) || (self.size ? self.size[1] : 200);
        return [w, full > cap ? cap : full];
      };
    };
    var origDraw = proto.onDrawForeground;
    proto.onDrawForeground = function (ctx) {
      var r = origDraw ? origDraw.apply(this, arguments) : undefined;
      this.__pcCapComputeSize();        // ★ 画过第一帧 = 尺寸已定 → 这时才挂"最小高度"的帽子
      this.__pcScrollReady = true;
      try { drawBar(this, ctx); } catch (e) { /* 忽略 */ }   // ③ 右边那条滚轮
      return r;
    };
    var origResize = proto.onResize;
    proto.onResize = function () {
      var r = origResize ? origResize.apply(this, arguments) : undefined;
      // ★ 第一百四十五批：**只有"指针真按在这颗节点上"才记高度**
      //   （载入时前端自己撑高、加控件时的 expandToFitContent 都会走 onResize，那些不算他拖的）
      try { if (!this.__pcInArrange && this.__pcScrollDown) saveUserH(this); } catch (e) { /* 忽略 */ }
      try { applyScroll(this, this.__pcScrollBase); } catch (e) { /* 忽略 */ }
      return r;
    };
    // ⚠️ `__pcScrollReady` 一定要在"尺寸已经定下来之后"就置上：只靠 `_arrangeWidgets` 不够
    //    （实测计时器 / 空 Latent 那条路不一定会走它 → 空算不出来，最小高度压不下去）。
    ["onNodeCreated", "onConfigure"].forEach(function (k) {
      var orig = proto[k];
      proto[k] = function () {
        var r = orig ? orig.apply(this, arguments) : undefined;
        this.__pcScrollReady = true;
        if (k === "onConfigure") {
          // ★ 读工作流后，先把"他拖出来的高度"定成这颗节点的目标高度，再等他排完版放回去
          //   （试几次，覆盖慢前端；`_arrangeWidgets` 那一层也会按目标高度纠回来）
          var want = wantHOf(this);
          if (want > 0) this.__pcWantH = want;
          var self = this;
          [0, 120, 400, 900, 1600, 2600].forEach(function (ms) {
            setTimeout(function () {
              try { if (restoreUserH(self) && typeof self.arrange === "function") self.arrange(); } catch (e) { /* 忽略 */ }
            }, ms);
          });
        }
        return r;
      };
    });
    return true;
  }

  window.__pcScroll = {
    patchProto: patchProto,
    apply: applyScroll,
    geom: geom,
    scrollOf: function (node) { return Number((node || {}).__pcScrollY) || 0; },
    setScroll: function (node, v) {
      if (!node || !node.__pcScrollOn) return 0;
      node.__pcScrollY = Math.max(0, Number(v) || 0);
      try { if (typeof node.arrange === "function") node.arrange(); } catch (e) { applyScroll(node, node.__pcScrollBase); }
      redraw(node);
      return node.__pcScrollY;
    },
    overOf: function (node) { return (node && node.__pcScrollGeom ? node.__pcScrollGeom.over : 0); },
    // ★ 第一百四十四~一百四十五批：把"他拖出来的高度"存 / 取出来（测试与自检用）
    H_KEY: H_KEY,
    H_STORE: H_STORE,
    saveH: saveUserH,
    restoreH: restoreUserH,
    rememberH: rememberH,
    wantHOf: wantHOf,
    userHOf: function (node) { return wantHOf(node); },
    storeGet: storeGet,
    storeSet: storeSet,
    ptrHooked: function () { return !!window.__pcScrollPtrHooked; },
    // 测试用：直接告诉扩展"指针正按在这颗节点上 / 松开了"（等价于真按一下）
    ptrDown: function (node, on) { if (node) node.__pcScrollDown = !!on; return !!(node && node.__pcScrollDown); },
    wheelHooked: function () { return !!window.__pcScrollWheelHooked; },
    // 测试用：直接喂一个"光标在某个客户坐标"的假事件
    nodeAt: function (clientX, clientY) { return nodeAt({ clientX: clientX, clientY: clientY }); },
  };

  // ==================== ★ 211 批：工具栏「不允许再调整高度」 ====================
  //   他原话（2026-10-23 第 211 批第 1 条）：「游动羽翼工具栏不允许再调整高度」。
  //   → 高度**永远等于内容高**（= `computeSize()[1]`），拖高拖矮都会被立刻纠回去；
  //     宽度照旧可拖（`resizable` 不动），滚轮那套对这颗节点**不再安装**（内容永远装得下）。
  function lockHeight(proto) {
    if (!proto || proto.__pcHeightLocked) return true;
    proto.__pcHeightLocked = true;
    function wantH(node) {
      try {
        var s = node && node.computeSize ? node.computeSize() : null;
        var h = s && Number(s[1]);
        return (h > 0 && h < 4000) ? h : 0;
      } catch (e) { return 0; }
    }
    function fix(node) {
      try {
        var want = wantH(node);
        if (!want || !node || !node.size) return false;
        if (Math.abs(node.size[1] - want) <= 1) return false;
        node.size[1] = want;                                  // 先直接改，再走一次正常重排
        if (typeof node.setSize === "function") node.setSize([node.size[0], want]);
        return true;
      } catch (e) { return false; }
    }
    var origResize = proto.onResize;
    proto.onResize = function () {
      var r = origResize ? origResize.apply(this, arguments) : undefined;
      fix(this);
      return r;
    };
    var origArrange = proto._arrangeWidgets;                  // 前端"装不下就自动撑高"那条路
    if (typeof origArrange === "function") {
      proto._arrangeWidgets = function () {
        var r = origArrange.apply(this, arguments);
        fix(this);
        return r;
      };
    }
    var origCfg = proto.onConfigure;                          // 读工作流时把存错的旧高度纠回来
    proto.onConfigure = function () {
      var r = origCfg ? origCfg.apply(this, arguments) : undefined;
      var self = this;
      [0, 120, 500, 1200].forEach(function (ms) {
        setTimeout(function () { if (fix(self)) redraw(self); }, ms);
      });
      return r;
    };
    var origCreated = proto.onNodeCreated;
    proto.onNodeCreated = function () {
      var r = origCreated ? origCreated.apply(this, arguments) : undefined;
      var self = this;
      [0, 200, 600].forEach(function (ms) { setTimeout(function () { fix(self); }, ms); });
      return r;
    };
    return true;
  }

  // —— 装上哪两颗（他第 2 条点名的；计时器第 136 批已经改成不能改高度了）——
  //   · 空 Latent（自填宽高像素）：**从上往下遮**（底部那块等比预览一直露着）→ anchor:"bottom"
  //   · 游动羽翼工具栏：**从下往上遮** → anchor:"top"
  //   minH = **能拖到的最矮高度**（拖边角时的下限，见上面 computeSize 那段）：
  //     ★ 他第 134 批看到 72 / 216 / 152 之后说"还是有最小高度、不是无限往下缩的" →
  //       现在统一放到 **26**（≈ 只剩标题栏那么高：名字还看得见，再往下就没意义了）。
  //   ⚠️ **计时器**（PromptToolTimer）不在这里装 —— 他第 136 批：「算了，计时器就不用拖了，
  //      将其改为不能修改高度」（`prompt_timer.js` 里已设 `resizable = false`）。
  try {
    app.registerExtension({
      name: "PromptToolNodeScroll",
      beforeRegisterNodeDef(nodeType, nodeData) {
        if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子
        const n = nodeData && nodeData.name;
        if (!n) return;
        if (n === "PromptToolEmptyLatent") patchProto(nodeType.prototype, { name: n, anchor: "bottom", padBottom: 90, minH: 26 });
        // ★ 211 批：工具栏**不再装滚轮/可拖高度**，改成"高度锁死 = 内容高"（他："不允许再调整高度"）
        else if (n === "PromptToolToolbar") lockHeight(nodeType.prototype);
      },
      // ★ 第一百四十五批：读工作流时（= 节点已经配好）再补一次 —— 前端有些撑高发生在 onConfigure 之后
      loadedGraphNode(node) {
        try {
          if (!node || !node.__pcScrollOn) return;
          var want = wantHOf(node);
          if (want > 0) node.__pcWantH = want;
          restoreUserH(node);
        } catch (e) { /* 忽略 */ }
      },
    });
  } catch (e) { /* 注册不上也不影响别的节点 */ }
})();
