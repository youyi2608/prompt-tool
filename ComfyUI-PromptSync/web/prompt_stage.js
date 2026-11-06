// 暂存节点（下一批文本）—— 2026-11-03 他第 1 条原话：
//   「暂存节点就是很正常的上下两个文本框，上面输入文本，然后在自定义优化窗输入要求。在连接情况下，
//    点击开始优化，就会把优化之后的文本，不放入优化节点，而是放入暂存节点在下文本框中」
//   「下文本框有两个键可以将里面的文本转移，既可以从下文本框转移到上文本框，顶掉原来的文本，
//    也可以直接转移到优化节点」
//   「暂存节点的上下文本框都分为两层，正提示词和负提示词。而分层，也就是正提示词负提示词之间的面积比例，
//    是可以拖动调整的，默认负提示词只占一排，这样可以把负提示词连带着优化」
//   「暂存节点的上下文本框也都有着上一步和下一步的切换，正负提示词会不会一起进行上一步下一步的切换，
//    要通过开关来开启或关闭」
//   「有了暂存文本，就可以一边生图，一边准备下一次生图的文本了」
//
// 本文件只做界面：上下两个框（各分正/负两层）、拖动分隔线、上一步/下一步、两个转移键。
// 后端一行活儿都不干（nodes.py 的 PromptToolStage 没有输出、不会被执行）。
//
// 和优化节点的对接走 window 钩子（两个模块加载顺序不保证）：
//   window.__pcStageDownstream(clipNode) -> 那颗优化节点下游连着的暂存节点（没有就 null）
//   window.__pcStageAccept(stageNode, posText, negText) -> 把优化结果放进下框
// prompt_clip.js 在写回之前会先问这两个钩子。
import { app } from "../../scripts/app.js";

const NODE_NAME = "PromptToolStage";
const W = 620, H = 520;

function log(...a) { console.log("[Stage]", ...a); }
function toast(msg, bad) {
  try {
    if (typeof window.__pcToast === "function") { window.__pcToast(msg, !!bad); return; }
  } catch (e) { /* 忽略 */ }
  log((bad ? "⚠ " : "") + msg);
}

// ---------------- 数据 ----------------
// 存在 properties.pcStage 里（会跟着工作流一起存）
function stOf(node) {
  node.properties = node.properties || {};
  var st = node.properties.pcStage;
  if (!st || typeof st !== "object") {
    st = {
      top: { pos: "", neg: "", hist: [], at: -1 },
      bot: { pos: "", neg: "", hist: [], at: -1 },
      negH: 40,        // 负词区高度（px）≈ 一行
      linkNeg: false,  // 正负是否一起翻（默认各翻各的）
      // ★ 2026-11-04（他第 9 条）：这一格里的文字"还没用于生图"就打一个 new 水印
      fresh: { top: false, bot: false },
    };
    node.properties.pcStage = st;
  }
  ["top", "bot"].forEach(function (k) {
    if (!st[k] || typeof st[k] !== "object") st[k] = { pos: "", neg: "", hist: [], at: -1 };
    if (!Array.isArray(st[k].hist)) st[k].hist = [];
    if (typeof st[k].at !== "number") st[k].at = -1;
    if (typeof st[k].pos !== "string") st[k].pos = "";
    if (typeof st[k].neg !== "string") st[k].neg = "";
  });
  if (typeof st.negH !== "number" || st.negH < 24) st.negH = 40;
  if (typeof st.linkNeg !== "boolean") st.linkNeg = false;
  if (!st.fresh || typeof st.fresh !== "object") st.fresh = { top: false, bot: false };
  ["top", "bot"].forEach(function (k) { if (typeof st.fresh[k] !== "boolean") st.fresh[k] = false; });
  return st;
}

// 历史栈：压一次快照（内容没变就不压）
function pushHist(side, snap) {
  var last = side.hist[side.at];
  if (last && last.pos === snap.pos && last.neg === snap.neg) return;
  side.hist = side.hist.slice(0, side.at + 1);
  side.hist.push({ pos: snap.pos, neg: snap.neg });
  if (side.hist.length > 80) side.hist.shift();
  side.at = side.hist.length - 1;
}

// ---------------- 界面 ----------------
function buildPanel(node) {
  var root = document.createElement("div");
  root.className = "pc-stage";
  root.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;height:100%;padding:7px;"
    + "box-sizing:border-box;overflow:hidden;min-height:0;"
    + "font:12px/1.55 system-ui,'Microsoft YaHei',sans-serif;color:#e8eaf1;";

  var st = stOf(node);

  // ---- 顶部：标题 + 正负联动开关 ----
  var head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 0 auto";
  var ttl = document.createElement("span");
  ttl.textContent = "🗂 暂存节点";
  ttl.style.cssText = "font-size:13px;font-weight:700";
  var hint = document.createElement("span");
  hint.textContent = "下框接住优化结果，你满意了再搬上去";
  hint.style.cssText = "font-size:10.5px;opacity:.62;font-weight:400";
  var sw = document.createElement("button");
  sw.type = "button";
  sw.style.cssText = "margin-left:auto;cursor:pointer;border-radius:6px;padding:2px 8px;font-size:10.5px;"
    + "border:1px solid rgba(255,255,255,.22);background:transparent;color:#cfd4e2;";
  function paintSw() {
    sw.textContent = "正负一起翻：" + (st.linkNeg ? "开" : "关");
    if (st.linkNeg) {
      sw.style.background = "rgba(122,162,255,.22)";
      sw.style.borderColor = "rgba(122,162,255,.6)";
      sw.style.color = "#dbe6ff";
    } else {
      sw.style.background = "transparent";
      sw.style.borderColor = "rgba(255,255,255,.22)";
      sw.style.color = "#cfd4e2";
    }
  }
  sw.title = "开着 = 点上一步/下一步时正提示词和负提示词一起翻；关着 = 只有你刚点的那一侧翻（默认关）";
  sw.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    st.linkNeg = !st.linkNeg; paintSw();
  });
  head.appendChild(ttl); head.appendChild(hint); head.appendChild(sw);
  root.appendChild(head);

  // ---- 一个"框"（上半 / 下半共用同一套构建） ----
  var refs = {};   // refs.top / refs.bot = { pos, neg, hPrev, hNext, box }

  function mkBox(which, label, tint) {
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;min-height:0;flex:1 1 0;"
      + "border:1px solid " + tint + ";border-radius:8px;overflow:hidden;"
      + "background:rgba(255,255,255,.025);";

    // 小标题条
    var bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:2px 7px;"
      + "border-bottom:1px solid " + tint + ";font-size:10.5px;";
    var lab = document.createElement("span");
    lab.textContent = label;
    lab.style.cssText = "font-weight:700;opacity:.9";
    var hPrev = document.createElement("button");
    hPrev.type = "button"; hPrev.textContent = "← 上一步";
    var hNext = document.createElement("button");
    hNext.type = "button"; hNext.textContent = "下一步 →";
    [hPrev, hNext].forEach(function (b) {
      b.style.cssText = "cursor:pointer;border-radius:5px;padding:0 6px;font-size:10px;line-height:16px;"
        + "border:1px solid rgba(255,255,255,.18);background:transparent;color:#cfd4e2;";
    });
    bar.appendChild(lab);
    bar.appendChild(hPrev); bar.appendChild(hNext);
    wrap.appendChild(bar);

    // 文本框区（正 + 拖动条 + 负）
    var body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;min-height:0;flex:1 1 auto;position:relative";
    // ★ 2026-11-04（他第 9 条）：「如果这段文字还没有用于生图，那么会在左上角显示一个
    //   有一定透明程度、大概 80% 透明的 new 字样」→ 水印只吃显示、不吃点击（pointer-events:none）。
    var badge = document.createElement("div");
    badge.textContent = "new";
    badge.title = "这一格里的文字还没用于生图（送进优化节点之后它就消失）";
    badge.style.cssText = "position:absolute;left:6px;top:2px;z-index:3;pointer-events:none;"
      + "font:800 11px/1 ui-monospace,Consolas,monospace;letter-spacing:1.5px;color:#ffd98a;"
      + "padding:2px 5px;border-radius:5px;background:rgba(255,190,90,.16);"
      + "border:1px solid rgba(255,190,90,.34);"
      + "opacity:0;transition:opacity .18s;text-shadow:0 0 8px rgba(255,190,90,.45)";

    function mkTa(ph) {
      var t = document.createElement("textarea");
      t.placeholder = ph;
      t.spellcheck = false;
      t.style.cssText = "flex:1 1 auto;width:100%;resize:none;box-sizing:border-box;"
        + "background:transparent;border:0;outline:none;color:#e8eaf1;padding:4px 7px;"
        + "font:12px/1.5 ui-monospace,Consolas,'Microsoft YaHei',monospace;min-height:0;";
      return t;
    }
    var pos = mkTa("正提示词（上框 = 现在正在用的；下框 = 刚优化出来待检的）");

    // 拖动条
    var grip = document.createElement("div");
    grip.title = "拖动调整正/负两层的高度（默认负词只占一行）";
    grip.style.cssText = "flex:0 0 auto;height:7px;cursor:ns-resize;position:relative;"
      + "border-top:1px solid rgba(255,255,255,.16);border-bottom:1px solid rgba(255,255,255,.16);"
      + "background:rgba(255,255,255,.05);";
    var dot = document.createElement("i");
    dot.style.cssText = "position:absolute;left:50%;top:50%;width:26px;height:2px;border-radius:2px;"
      + "transform:translate(-50%,-50%);background:rgba(255,255,255,.35);font-style:normal";
    grip.appendChild(dot);

    var neg = mkTa("负提示词（默认只占一行，优化时会连它一起带上）");

    body.appendChild(pos);
    body.appendChild(grip);
    body.appendChild(neg);
    body.appendChild(badge);
    wrap.appendChild(body);

    // 拖动：document 级监听（元素上监听会被画布吃掉，182 批的教训）
    grip.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      var startY = e.clientY, startH = st.negH, bodyH = body.clientHeight || 120;
      function mv(ev) {
        var h = startH - (ev.clientY - startY);
        h = Math.max(24, Math.min(bodyH - 34, h));
        st.negH = h;
        neg.style.height = h + "px";
        neg.style.flex = "0 0 auto";
      }
      function up() {
        document.removeEventListener("pointermove", mv);
        document.removeEventListener("pointerup", up);
        // 拖完压一次历史（高度不算内容，但顺手记一下方便撤销布局）
        try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (e2) { /* 忽略 */ }
      }
      document.addEventListener("pointermove", mv);
      document.addEventListener("pointerup", up);
    });

    refs[which] = { pos: pos, neg: neg, hPrev: hPrev, hNext: hNext, box: wrap, body: body, badge: badge };
    return wrap;
  }

  var boxTop = mkBox("top", "上框 · 现在正在用的", "rgba(122,162,255,.45)");
  var boxBot = mkBox("bot", "下框 · 刚优化出来的", "rgba(232,180,90,.45)");
  root.appendChild(boxTop);
  root.appendChild(boxBot);

  // ---- 底部两颗转移键 ----
  var foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:8px;flex:0 0 auto";
  var bUp = document.createElement("button");
  bUp.type = "button"; bUp.textContent = "↑ 顶掉上框";
  var bSend = document.createElement("button");
  bSend.type = "button"; bSend.textContent = "→ 送进优化节点";
  [bUp, bSend].forEach(function (b) {
    b.style.cssText = "flex:1 1 0;cursor:pointer;border-radius:7px;padding:5px 8px;font-size:11.5px;"
      + "border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#e8eaf1;";
  });
  bUp.title = "把下框（正+负）搬到上框，覆盖上框原来的文本";
  bSend.title = "把下框（正+负）直接写进上游那颗「CLIP 文本编码优化节点」";
  bUp.style.borderColor = "rgba(232,180,90,.5)";
  bSend.style.borderColor = "rgba(122,162,255,.5)";
  // ★ 2026-11-04 **关键修正**：他说的 Ctrl+B 是 **Bypass（旁路）**，不是折叠！
  //   ComfyUI 里 Ctrl+B = bypass（`node.mode = 4`，节点变紫/半透明、输入直通输出）。
  //   折叠会把面板和这颗键一起收进去 —— 这就是他说"按了还是会自动收起"的原因。
  //   改成 bypass：节点原地不动，这颗键一直在，再点一下就是开机。
  var bFold = document.createElement("button");
  bFold.type = "button"; bFold.textContent = "⏻ 关机";
  // ★ 2026-11-04（他第 1 条）：「暂存节点的关机键做的明显一些」
  bFold.style.cssText = "flex:0 0 auto;cursor:pointer;border-radius:8px;padding:6px 12px;font-size:12.5px;"
    + "font-weight:800;letter-spacing:.5px;"
    + "border:1.5px solid rgba(255,150,90,.98);background:rgba(255,140,80,.22);color:#ffe0c4;";
  bFold.title = "等于按 Ctrl+B（旁路）：这颗节点不参与工作流、变紫；再点一下开机";
  function paintFold() {
    var off = Number(node.mode) === 4;
    bFold.textContent = off ? "⏻ 开机" : "⏻ 关机";
  }
  bFold.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    try {
      var off = Number(node.mode) === 4;
      node.mode = off ? 0 : 4;                 // ComfyUI 的 bypass = mode 4
    } catch (err) { /* 忽略 */ }
    paintFold();
    try { node.setDirtyCanvas && node.setDirtyCanvas(true, true); } catch (e2) { /* 忽略 */ }
  });
  // 外部用 Ctrl+B 折叠时按钮文案也要跟上 —— 轻量轮询（只有这颗节点有一个）
  var foldTimer = setInterval(function () {
    try {
      if (!node || !node.graph) { clearInterval(foldTimer); return; }
      paintFold();
    } catch (e) { clearInterval(foldTimer); }
  }, 500);
  foot.appendChild(bUp); foot.appendChild(bSend); foot.appendChild(bFold);
  root.appendChild(foot);
  paintFold();

  // ---------------- 行为 ----------------
  // ★ 2026-11-04（他第 9 条）：new 水印的判定
  //   亮：这一格刚有文字 / 文字改过 / 刚从下框搬上来 / 刚翻过历史 → 都还没送去生图
  //   灭：按了「→ 送进优化节点」（那一刻这段文字才真的成了"正在用的那份"）
  function paintFresh() {
    ["top", "bot"].forEach(function (w) {
      var r = refs[w];
      if (!r || !r.badge) return;
      // ★ 他第 6 条：原来 0.22 太淡，深色框里几乎看不见（他以为"没显示 new"）→ 提到 0.62。
      r.badge.style.opacity = (st.fresh && st.fresh[w]) ? "0.62" : "0";
    });
  }
  // ★ 他第 6 条：「优化提示词生成新的提示词置换之后并不会显示 New」——
  //   除了调亮，再加一条**兜底**：任何把文字写进框里的路径（accept / 顶掉 / 翻历史 / 打字）
  //   之后都重画一次，别指望调用方一定记得调 paint。
  function markFresh(which, on) {
    try { st.fresh = st.fresh || { top: false, bot: false }; st.fresh[which] = !!on; } catch (e) { /* 忽略 */ }
    paintFresh();
  }

  function snap(which) { return { pos: refs[which].pos.value, neg: refs[which].neg.value }; }

  function syncSide(which) {
    var s = st[which];
    var oldPos = refs[which].pos.value, oldNeg = refs[which].neg.value;
    refs[which].pos.value = s.pos;
    refs[which].neg.value = s.neg;
    // ★ 他第 6 条「优化生成的新提示词置换之后不显示 New」：只要框里的字跟原来不一样，
    //   就把这一格标成"还没用于生图" —— 不管是谁写进来的（优化结果 / 顶掉上框 / 翻历史）。
    if ((oldPos !== s.pos || oldNeg !== s.neg) && (String(s.pos).trim() || String(s.neg).trim())) {
      try { st.fresh = st.fresh || { top: false, bot: false }; st.fresh[which] = true; } catch (e0) { /* 忽略 */ }
    }
    applyNegH();
    paintFresh();
  }
  function applyNegH() {
    ["top", "bot"].forEach(function (w) {
      var r = refs[w];
      if (!r) return;
      r.neg.style.height = Math.max(24, st.negH) + "px";
      r.neg.style.flex = "0 0 auto";
    });
  }

  // 输入 → 存 + 压历史（防抖）
  var timers = {};
  function bindSide(which) {
    ["pos", "neg"].forEach(function (f) {
      refs[which][f].addEventListener("input", function () {
        st[which][f] = refs[which][f].value;
        markFresh(which, true);                       // ★ 他第 9 条：改过就是"还没用过"
        clearTimeout(timers[which + f]);
        timers[which + f] = setTimeout(function () {
          pushHist(st[which], snap(which));
        }, 700);
      });
      // 生成期间别让他误触切页面丢字（和自定义优化窗同一条降级口径）
      refs[which][f].addEventListener("keydown", function (e) {
        e.stopPropagation();
      });
      refs[which][f].addEventListener("wheel", function (e) {
        if (!e.ctrlKey) e.stopPropagation();
      }, { passive: true });
    });
  }

  // 上一步 / 下一步
  function step(which, dir) {
    var s = st[which];
    if (!s.hist.length) { toast("这一侧还没有历史可翻"); return; }
    var at = s.at;
    // 先把当前内容补进去（第一次点"上一步"时，现在的文本就是最新一条）
    if (at < 0) { pushHist(s, snap(which)); at = s.at; }
    var to = Math.max(0, Math.min(s.hist.length - 1, at + dir));
    if (to === at) { toast(dir < 0 ? "已经是最早那一步了" : "已经是最新那一步了"); return; }
    s.at = to;
    var h = s.hist[to] || { pos: "", neg: "" };
    s.pos = h.pos; s.neg = h.neg;
    syncSide(which);
    markFresh(which, true);
    // ★ 他要的：正负要不要一起翻由开关决定
    if (st.linkNeg) {
      var other = which === "top" ? "bot" : "top";
      var so = st[other];
      if (so.hist.length) {
        var to2 = Math.max(0, Math.min(so.hist.length - 1, (so.at < 0 ? so.hist.length - 1 : so.at) + dir));
        so.at = to2;
        var h2 = so.hist[to2] || { pos: "", neg: "" };
        so.pos = h2.pos; so.neg = h2.neg;
        syncSide(other);
        markFresh(other, true);
      }
    }
    toast((dir < 0 ? "回到上一步" : "前进到下一步") + (st.linkNeg ? "（正负一起）" : ""));
  }

  // 接在本节点输入口上的那颗 —— 正常是「✎ 自定义优化窗」连过来
  function upstreamNode() {
    try {
      var inp = (node.inputs || [])[0];
      if (!inp || !inp.link) return null;
      var g = app.graph;
      var lk = g.links[inp.link];
      if (!lk) return null;
      return g.getNodeById(lk.origin_id) || null;
    } catch (e) { return null; }
  }
  // 「→ 送进优化节点」到底送给哪颗：✎ 窗自己记着它在服务哪颗优化节点（properties.pcOptAsk.clip）
  function upstreamClip() {
    var src = upstreamNode();
    if (!src) return null;
    try {
      if (src.type === "PromptToolClipSegments") return src;   // 万一他直接把优化节点连过来，也认
      var pid = src.properties && src.properties.pcOptAsk && src.properties.pcOptAsk.clip;
      if (pid) { var c = app.graph.getNodeById(pid); if (c) return c; }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  bUp.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    var b = snap("bot");
    if (!b.pos.trim() && !b.neg.trim()) { toast("下框是空的，没东西可搬", true); return; }
    pushHist(st.top, snap("top"));
    st.top.pos = b.pos; st.top.neg = b.neg;
    syncSide("top");
    markFresh("top", !!(st.fresh && st.fresh.bot));   // ★ 第 9 条：搬上去的算"还没用过"（它还没被送进生图那一步）
    pushHist(st.top, snap("top"));
    toast("搬上去了：上框已换成下框那份（上框原来那份在 ← 上一步里）");
  });

  bSend.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    var b = snap("bot");
    if (!b.pos.trim() && !b.neg.trim()) { toast("下框是空的，没东西可送", true); return; }
    var src = upstreamClip();
    if (!src || !src.id) { toast("这个暂存节点没有接「✎ 自定义优化窗」 —— 先把它的输入口连到那颗窗节点的『优化结果（可不连）』上", true); return; }
    var ok = false;
    try {
      if (typeof window.__pcClipSetText === "function") {
        ok = window.__pcClipSetText(src.id, "pos", b.pos) !== false;
        if (b.neg.trim()) window.__pcClipSetText(src.id, "neg", b.neg);
      }
    } catch (e2) { ok = false; }
    if (ok) { toast("已经写进优化节点（正" + (b.neg.trim() ? "、负" : "") + "两侧都写了）"); markFresh("bot", false); }   // ★ 第 9 条：送进去了，new 熄灭
    else toast("写进优化节点失败 —— 那颗节点可能已经被删了", true);
  });

  refs.top.hPrev.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); step("top", -1); });
  refs.top.hNext.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); step("top", 1); });
  refs.bot.hPrev.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); step("bot", -1); });
  refs.bot.hNext.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); step("bot", 1); });

  bindSide("top"); bindSide("bot");
  syncSide("top"); syncSide("bot");

  node.__pcStagePaint = function () { syncSide("top"); syncSide("bot"); paintSw(); paintFresh(); };
  paintSw();
  return root;
}

// 面板高度按节点尺寸钉住（只改 computeSize 不够，200 批的教训）
function stageFit(node) {
  try {
    var el = node && node.__pw && node.__pw.element;
    if (!el || !node.size) return;
    el.style.height = Math.max(220, Math.round(node.size[1] - 34)) + "px";
    el.style.width = Math.max(280, Math.round(node.size[0] - 16)) + "px";
  } catch (e) { /* 忽略 */ }
}

function mount(node) {
  try {
    if (node.__pw) return true;
    if (typeof node.addDOMWidget !== "function") return false;
    var panel = buildPanel(node);
    node.__pw = node.addDOMWidget("暂存文本", "pcStage", panel, { serialize: false, hideOnZoom: false });
    stOf(node);
    var orig = node.computeSize;
    node.computeSize = function () {
      var s = orig ? orig.apply(this, arguments) : [W, H];
      return [Math.max(s[0], W), Math.max(s[1], H)];
    };
    if (!node.size || node.size[0] < 200) node.size = [W, H];
    setTimeout(function () { stageFit(node); }, 0);
    return true;
  } catch (e) {
    log("建面板失败", e);
    return false;
  }
}

// ---------------- 给 prompt_optask.js 用的钩子 ----------------
// ⚠️ 传进来的 `srcNode` 是**「✎ 自定义优化窗」节点**（不是 CLIP 优化节点）——
//   他 2026-11-03 明确纠正过：「而不是让优化节点从两个输出口变成三个」。
//   找它下游连着的暂存节点。
window.__pcStageDownstream = function (srcNode) {
  try {
    var outs = srcNode && srcNode.outputs;
    if (!outs) return null;
    var g = app.graph;
    for (var i = 0; i < outs.length; i++) {
      var o = outs[i];
      if (!o || !o.links) continue;
      for (var k = 0; k < o.links.length; k++) {
        var lk = g.links[o.links[k]];
        if (!lk) continue;
        var t = g.getNodeById(lk.target_id);
        if (t && t.type === NODE_NAME) return t;
      }
    }
  } catch (e) { /* 忽略 */ }
  return null;
};

// 把优化结果放进暂存节点的下框（不覆盖上框）
window.__pcStageAccept = function (stageNode, posText, negText) {
  try {
    if (!stageNode) return false;
    var st = stOf(stageNode);
    var b = st.bot;
    pushHist(b, { pos: b.pos, neg: b.neg });     // 先存旧的，方便后悔
    b.pos = String(posText || "");
    if (negText && String(negText).trim()) b.neg = String(negText);
    pushHist(b, { pos: b.pos, neg: b.neg });
    // ★ 2026-11-04（他第 9 条）：刚优化出来的这份当然"还没用于生图" → 下框亮起 new
    st.fresh = st.fresh || { top: false, bot: false };
    st.fresh.bot = true;
    if (typeof stageNode.__pcStagePaint === "function") stageNode.__pcStagePaint();
    return true;
  } catch (e) {
    log("收优化结果失败", e);
    return false;
  }
};

app.registerExtension({
  name: "PromptTool.Stage",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    // ⚠️ 前端 1.57 会拿 nodeType = null 调一次这个钩子（见 prompt_timer.js 里同一条注释），
    //   必须先挡掉，否则 nodeType.prototype 会抛 TypeError、整段面板增强静默失效。
    if (!nodeType || !nodeData || nodeData.name !== NODE_NAME) return;

    var onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      var r = onCreated ? onCreated.apply(this, arguments) : undefined;
      var self = this;
      setTimeout(function () { mount(self); }, 0);
      return r;
    };

    // ⚠️ 从工作流读回来走 configure，onNodeCreated 不跑 → 必须也挂一次（246 批踩过的）
    var onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      var r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      var self = this;
      setTimeout(function () {
        if (!mount(self)) return;
        if (typeof self.__pcStagePaint === "function") self.__pcStagePaint();
        stageFit(self);
      }, 0);
      return r;
    };

    var onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function () {
      var r = onResize ? onResize.apply(this, arguments) : undefined;
      stageFit(this);
      return r;
    };

    var onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      var r = onRemoved ? onRemoved.apply(this, arguments) : undefined;
      return r;
    };
  },
});
