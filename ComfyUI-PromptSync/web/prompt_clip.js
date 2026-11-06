// 「CLIP 文本编码优化节点」的前端扩展（2026-10-04 他要求做的新节点；他 2026-10-04 把显示名从
//  「分段CLIP文本编码（提示词工具）」改成现在这个 —— **类名 PromptToolClipSegments 没动**，
//   不然他画布上已经摆好的那个节点、还有存好的工作流都会认不出来）
//
// 他 2026-10-04 第三轮提的三件事（这一版全做了）：
//   一、① **虚线框要整段一个长方形**（以前把虚线边挂在文字上，行内元素的边框会"一行一个框"）；
//      ② 三颗小键回到**框的右上角（✕ / −）和右下角（⇄）**（上一版被我塞进文本框下面那排胶囊里了）；
//      ③ 点 − 隐藏之后**文字要变 50% 透明** → 这一版把"看得见的文字"交给背后那层镜像画，
//         文本框自己的字设成透明（光标另给颜色、placeholder 单独上色），于是每段能各自上样式。
//   二、从**一个**「提示词同步」输入口变成**两个**（正 / 负），对上「提示词同步」节点的两个输出；
//       **口里来的文本优先**（连了就用口里那份，没连就用文本框里写的）。
//   三、节点顶上写一行小字：和「提示词同步」节点一个展开、另一个就收起；**收起状态下的文本不参与作图**
//       （等于点了小减号）—— 这是正常的。
//
// ⚠️ 收起 = 文本不参与：收起时把后端那两个控件**清空**（内容留在 properties 里，展开时原样写回），
//    这样"最多只有一个节点的文本生效"是真的（他明确说了这条）。
import { app } from "../../scripts/app.js";

const NODE_NAME = "PromptToolClipSegments";
const SYNC_NODE = "PromptSyncFromTool";
const PORT_PREFIX = "提示词同步";            // 两个口都叫「提示词同步·正（可不连）」/「…负（可不连）」
const PROP = "pcClip";                       // 全部状态存这儿（跟着工作流走）
const BTN = 13;                              // 标题栏那颗小圆钮的直径
const DEF_H = 150;                           // 文本框默认高度
const HINT_TEXT = "本节点和「提示词同步」节点一个展开、另一个就收起；收起状态下的文本不参与作图（等于点了小减号），这是正常的";
// ⚠️ 2026-10-07（第一百一十二批）他第 6 条原话：「提示词同步节点只连一个也行，其实没必要放到优化节点的，
//   优化节点不要搞这个，你直接把这个小字写到提示是同步节点那里，**优化节点那行小字删了**」
//   → 上一批按他选的 A 写在这个节点上的那行小字**已经删掉**，搬去 prompt_sync.js 了。
const HINT_COLOR = "rgba(150, 162, 180, 0.95)";

function log(...args) { console.log("[PromptClip]", ...args); }
// ==================== ★ 199 批：优化状态**两行带色字 + 转圈**（取代之前的黄色波浪）====================
// 他原话：「水波震颤的效果被验证为完全失败……最重要的原因是因为水波震颤并不能完全反映提示词正在被优化，
//   完全是点了提示词优化之后，它就会开始播放水波震颤的动画，这并不是我想要的。所以要改成其他效果，
//   就用带色的字加上转圈的圆圈加载动画简单描述两行就行了，那两行字原来是灰色的，实现了之后才会加上颜色。
//   第一行字就是告诉你有没有和工具端成功连接；第二行字就是告诉你现在正在优化提示词」
// 落地：常驻在"左边接入口 / 右边接出口 中间那块空白"（`pcIOSlotBand`），**两行灰字，条件成立才上色**：
//   ① `工具端：未连接 / 已连接` —— 工具每 4 秒往共享黑板写一次心跳 `aiPing={at}`，节点读它（真的通才有色）
//   ② `空闲 / 正在优化提示词…`（带转圈）—— 只有这条节点真在等活时才亮
function pcIOSlotBand(node) {
  try {
    var inH = (node && node.inputs ? node.inputs.length : 0) * 20;
    return inH >= 40 ? { h: inH - 8, io: true } : { h: 62, io: false };
  } catch (e) { return { h: 62, io: false }; }
}
var PC_STAT = { pingAt: 0, pingTry: 0, timer: 0 };
function pcStatMake(node) {
  try {
    var panel = node && node.__pcPanel;
    if (!panel) return null;
    // ★ 202/204 批：状态**浮在面板上方那一排空白**里，一行字；绝对定位、不占布局高度、永远显示。
    // ★ 204 批改法：把它挂成「正提示词」那一行的**绝对定位子元素**（`left:0; bottom:100%`）——
    //   这样左边缘天生就和其他文字对齐，不用再去量坐标（之前量出来的值会随画布缩放漂移）。
    if (node.__pcStat && panel.contains(node.__pcStat)) return node.__pcStat;
    var labEl = panel.querySelector(".pc-clip-lab") || panel;
    try { labEl.style.position = "relative"; } catch (e) { /* 忽略 */ }
    var box = document.createElement("div");
    box.className = "pc-optstat";
    box.style.cssText = "position:absolute;z-index:8;left:0;bottom:100%;height:16px;"
      + "display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;padding:0;margin:0;"
      + "letter-spacing:0;pointer-events:none;white-space:nowrap;overflow:hidden";
    var c1 = document.createElement("span");
    c1.textContent = "○ 工具端：未连接";
    var sep = document.createElement("span");
    sep.textContent = "·"; sep.style.opacity = ".45";
    var c2 = document.createElement("span");
    c2.textContent = "空闲";
    box.appendChild(c1); box.appendChild(sep); box.appendChild(c2);
    // ★ 2026-11-04（他第 1 条 · 第二次澄清）：「我说的中断是自定义优化窗的中断去掉……你怎么把我**优化节点**的
    //   中断键给去掉了？补回来，然后把这个中断键给去掉」
    //   → 优化节点上这颗 14px「⏹」**补回来**（⚡/✎ 两条路打断都靠它）；
    //     自定义优化窗里那颗「开始优化」**永远保持"开始优化"**，不再变成"中断"。
    var stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "pc-optstop";
    stopBtn.textContent = "⏹";
    stopBtn.title = "中断这次优化（工具端可能还在跑，但结果不会再写回你的框）";
    stopBtn.style.cssText = "pointer-events:auto;cursor:pointer;font-family:inherit;font-size:8px;line-height:1;"
      + "width:14px;height:14px;padding:0;border-radius:50%;display:none;align-items:center;justify-content:center;box-sizing:border-box;"
      + "border:1px solid rgba(255,130,150,.55);background:rgba(255,80,110,.18);color:#ffd7de";
    stopBtn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      try { PC_OPT_STOP.at = Date.now(); } catch (e2) { /* 忽略 */ }
      try { node.__pcCancel = true; } catch (e3) { /* 忽略 */ }
      pcWaveStop();
      clipToast("已中断这次优化 —— 可以重新开始新的优化");
    });
    box.appendChild(stopBtn);
    labEl.appendChild(box);
    node.__pcStat = box; node.__pcL1 = c1; node.__pcL2 = c2; node.__pcStopBtn = stopBtn;
    return box;
  } catch (e) { return null; }
}
function pcStatPaint(node) {
  try {
    if (!node) return;
    var box = pcStatMake(node);
    if (!box) return;
    box.style.display = "flex";                 // ★ 202 批：不再跟「提示词优化」开关联动
    // ★ 他第 1 条（第二次澄清）：中断键是**优化节点上这颗小圆钮**，⚡ 键不再改文字、一直是"快速优化"。
    try { if (node.__pcStopBtn) node.__pcStopBtn.style.display = node.__pcBusy ? "inline-flex" : "none"; } catch (e0) { /* 忽略 */ }
    var now = Date.now();
    var live = PC_STAT.pingAt && (now - PC_STAT.pingAt < 90000);
    var l1 = node.__pcL1, l2 = node.__pcL2;
    // ★ 289 批（他："工具端一开始是连接的，点击优化，优化到一半未连接……所以到底是连接还是没连接呢"）
    //   真因：这行字亮的是**心跳**（工具页每几秒写一次 aiPing，窗口 90 秒）；AI 一次要跑十几到几十秒，
    //   工具忙着调 AI（或后台标签页被浏览器降频）时来不及刷心跳 → 就被判成"未连接"，可请求其实还在飞。
    //   修法：**优化中一律显示"正在处理…"**（正在跑本身就说明它活着），只有真的空闲才按心跳说话。
    var busyNow = !!node.__pcBusy;
    if (l1) {
      if (busyNow) {
        l1.textContent = "● 工具端：正在处理…";
        l1.style.color = "#5fe08f";
        l1.style.fontWeight = "700";
      } else {
        l1.textContent = live ? "● 工具端：已连接" : "○ 工具端：未连接";
        l1.style.color = live ? "#5fe08f" : "rgba(170,178,196,.62)";
        l1.style.fontWeight = live ? "700" : "400";
      }
    }
    if (l2) {
      var busy = !!node.__pcBusy;
      if (busy) {
        // ★ 2026-11-03（他第 2 条）：⚡ 快速优化 / ✎ 自定义优化 要一眼能分开 ——
        //   两种**不同颜色**（⚡ 橙金 / ✎ 紫）+ 字号加大加粗，文字也跟着换。
        var isAsk = node.__pcBusyKind === "ask";
        var wantTxt = isAsk ? "✎ 自定义优化中…" : "⚡ 快速优化中…";
        if (l2.getAttribute("data-pc-opt-txt") !== wantTxt) {
          l2.innerHTML = "";
          var sp = document.createElement("span");
          sp.className = "pc-spin";
          sp.style.width = "10px"; sp.style.height = "10px";
          sp.style.marginRight = "6px"; sp.style.verticalAlign = "-1px";
          l2.appendChild(sp);
          l2.appendChild(document.createTextNode(wantTxt));
          l2.setAttribute("data-pc-opt-txt", wantTxt);
        }
        l2.style.color = isAsk ? "#c084fc" : "#f0a52b";
        l2.style.fontSize = "13px";
        l2.style.fontWeight = "900";
        l2.style.letterSpacing = "0.3px";
        l2.title = isAsk
          ? "正在按你写的要求做自定义优化（结果会写回文本框；接了暂存节点就先进它的下框）"
          : "正在做快速优化（不用写要求，直接改这一段）";
      } else {
        l2.textContent = "空闲";
        l2.style.color = "rgba(170,178,196,.62)";
        l2.style.fontWeight = "400";
        l2.style.fontSize = "";
        l2.style.letterSpacing = "";
        l2.removeAttribute("data-pc-opt-txt");
        l2.title = "";
      }
    }
  } catch (e) { /* 忽略 */ }
}
function pcStatTick() {
  var now = Date.now();
  // 心跳：每 3 秒问一次共享黑板（ttl 90 秒 —— 工具页在后台时浏览器会把它的定时器降到 1 分钟一次，
  //   窗口留太短就会"一会儿已连接一会儿未连接"）
  if (now - PC_STAT.pingTry > 3000) {
    PC_STAT.pingTry = now;
    try {
      fetch("/prompt_sync/store?key=aiPing", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var v = j && j.value;
          if (v && v.at) PC_STAT.pingAt = Number(v.at) || 0;
        })
        .catch(function () { /* 读不到就当没连 */ });
    } catch (e) { /* 忽略 */ }
  }
  try {
    var all = (app.graph && app.graph._nodes) || [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (!n || n.type !== "PromptToolClipSegments") continue;
      pcStatMake(n);
      pcStatPaint(n);
      try { if (n.__pcCompPaint) n.__pcCompPaint(); } catch (e) { /* 忽略 */ }
      try { if (n.__pcCompNegPaint) n.__pcCompNegPaint(); } catch (e) { /* 忽略 */ }   // ★ 237 批：负提示词那边同步刷新
    }
  } catch (e) { /* 忽略 */ }
  if (!PC_STAT.timer) PC_STAT.timer = setInterval(pcStatTick, 3000);
}
// 优化开始 / 结束：只动"这一条"的状态（不再播放任何波浪动画）
// ★ 2026-11-03（他第 2 条）：要能看出**现在跑的是 ⚡ 快速优化还是 ✎ 自定义优化** —— 两种用不同颜色 + 大字号。
function pcStatusBusy(node, on, kind) {
  try {
    if (!node) return;
    node.__pcBusy = !!on;
    node.__pcBusyKind = on ? (kind === "ask" ? "ask" : "fast") : "";
    pcStatMake(node);
    pcStatPaint(node);
  } catch (e) { /* 忽略 */ }
}
function pcWaveStart(node, kind) { pcStatusBusy(node, true, kind); }
function pcWaveStop() {
  try {
    var all = (app.graph && app.graph._nodes) || [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (!n) continue;
      if (n.__pcBusy) { n.__pcBusy = false; n.__pcBusyKind = ""; pcStatPaint(n); }
    }
  } catch (e) { /* 忽略 */ }
}
// ★ 275 批（他："提示词优化时，正在优化的时候，旁边加一个中断标，随时中断，然后重新开始新的优化"）
//   → 用"按下中断的时刻"当令牌：每个优化循环记住自己开始的时刻，发现令牌比它新就立刻收手
//   （这样 ⚡ 和 ✎ 两条路都不用在节点上挂状态，也不会互相干扰）。
var PC_OPT_STOP = { at: 0 };
window.__pcOptStopNow = function () { try { PC_OPT_STOP.at = Date.now(); } catch (e) {} try { pcWaveStop(); } catch (e2) {} return true; };
window.__pcOptStopAt = function () { return PC_OPT_STOP.at || 0; };
window.__pcOptWave = {
  // ★ 2026-11-03（他第 2 条）：第二参数 kind —— "ask" = 自定义优化（紫 ✎）/ 其它 = 快速优化（橙金 ⚡），
  //   这样从「自定义优化窗」里点开始优化时，节点上的状态行也能正确显示是哪种。
  show: function (clipId, kind) { try { var n = app.graph.getNodeById(clipId); if (n) pcStatusBusy(n, true, kind); return !!n; } catch (e) { return false; } },
  hide: function () { pcWaveStop(); return true; },
};
// 测试钩子：两行字的文本 / 颜色 / 有没有转圈
window.__pcStatInfo = function (clipId) {
  try {
    var n = app.graph.getNodeById(clipId);
    if (!n) return null;
    pcStatMake(n); pcStatPaint(n);
    return {
      l1: n.__pcL1 ? n.__pcL1.textContent : "",
      l1c: n.__pcL1 ? getComputedStyle(n.__pcL1).color : "",
      l2: n.__pcL2 ? n.__pcL2.textContent : "",
      l2c: n.__pcL2 ? getComputedStyle(n.__pcL2).color : "",
      spin: n.__pcL2 ? n.__pcL2.querySelectorAll(".pc-spin").length : 0,
      busy: !!n.__pcBusy,
      kind: n.__pcBusyKind || "",
      l2size: n.__pcL2 ? getComputedStyle(n.__pcL2).fontSize : "",
      pingFresh: !!(PC_STAT.pingAt && (Date.now() - PC_STAT.pingAt < 8000)),
    };
  } catch (e) { return null; }
};
window.__pcStatSetPing = function (at) { PC_STAT.pingAt = Number(at) || 0; };
try { setTimeout(pcStatTick, 1200); } catch (e) { /* 忽略 */ }

// ★ 192 批（他："点快速优化也没有什么反应""连弹节点都没有"）：以前这些失败只写 console，
//   他根本看不见 → 现在给一个**画布上的小提示**（用 ComfyUI 自己的 toast，没有就退回 console）。
function clipToast(msg, bad) {
  log(msg);
  try {
    var em = app && app.extensionManager;
    if (em && em.toast && typeof em.toast.add === "function") {
      em.toast.add({ severity: bad ? "warn" : "info", summary: "提示词优化", detail: String(msg), life: 4200 });
      return;
    }
  } catch (e) { /* 忽略 */ }
}
// ★ 273d 批（他："节点端和 ComfyUI 端互通的画师串根本就不互通，点同步一次也没用，换一个方式吧：
//   在一端获得代码，再把代码放到另外一端的文本框里"）→ 画师规则用一段"码"搬运，不依赖后端黑板同步。
//   码 = PCAR1: + base64(JSON{black,boost,prob})，几千字也能贴。
function pcArtPack(o) {
  try {
    var j = JSON.stringify({
      black: (o && o.black) || [],
      boost: (o && o.boost) || [],
      boost2: (o && o.boost2) || [],
      prob: (o && typeof o.prob === "number") ? o.prob : 100,
      boostProb: (o && typeof o.boostProb === "number") ? o.boostProb : 0,
    });
    return "PCAR1:" + btoa(unescape(encodeURIComponent(j)));
  } catch (e) { return ""; }
}
function pcArtUnpack(s) {
  var t = String(s == null ? "" : s).trim();
  if (!t) return null;
  if (t.indexOf("PCAR1:") === 0) t = t.slice(6);
  try { return JSON.parse(decodeURIComponent(escape(atob(t.replace(/\s+/g, ""))))); } catch (e) { return null; }
}
function redraw() {
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}
// ★ 2026-10-05 第九十九批：点小键要有**看得见的反馈** —— 键自己原地沉浮一下 + 放一圈水波（绿=成功 / 红=没成）
function pulseBtn(box, btn, ok, ringOnly) {
  try {
    if (!btn || !btn.isConnected) return;
    if (!ringOnly) {
      btn.classList.remove("pc-pulse");
      void btn.offsetWidth;                       // 强制重排，连点也能重新播动画
      btn.classList.add("pc-pulse");
    }
    var ring = document.createElement("span");
    ring.className = "pc-wave" + (ok ? "" : " bad");
    ring.style.left = btn.offsetLeft + "px";
    ring.style.top = btn.offsetTop + "px";
    ring.style.width = btn.offsetWidth + "px";
    ring.style.height = btn.offsetHeight + "px";
    box.appendChild(ring);
    setTimeout(function () { try { box.removeChild(ring); } catch (e) { /* 忽略 */ } }, 660);
  } catch (e) { /* 忽略 */ }
}
// 复制成功 / 失败给个眼色（节点边框闪一下绿/红，1 秒后收掉）——和「提示词同步」那边同一个做法
function flashNode(node, ok) {
  try {
    node.boxcolor = ok ? "#1a9c5b" : "#c0392b";
    setTimeout(function () {
      try { node.boxcolor = undefined; redraw(); } catch (e) { /* 忽略 */ }
    }, 900);
  } catch (e) { /* 忽略 */ }
}
function styleOnce() {
  if (document.getElementById("pc-clip-style")) return;
  var st = document.createElement("style");
  st.id = "pc-clip-style";
  st.textContent = [
    ".pc-clip{display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;",
    "font-family:inherit;font-size:12px;padding:2px 6px 4px;}",
    // 子块不许被压扁（节点高度还没跟上时 flex 会把文本框挤成一条缝）
    ".pc-clip > .pc-clip-sec,.pc-clip > .pc-clip-foot{flex:0 0 auto;}",
    ".pc-clip-sec{display:flex;flex-direction:column;gap:4px;}",
    ".pc-clip-lab{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.95;min-width:0;}",
    ".pc-clip-lab .pc-clip-note{opacity:.6;font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    // ★ 191 批：优化工具条 —— 整条**靠右**贴在「小胶囊上面那一行」的末尾；开关在最右边，五颗键往左长
    ".pc-optbar{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:nowrap;justify-content:flex-end;}",
    ".pc-optset{display:none;align-items:center;gap:6px;}",
    ".pc-optset.on{display:inline-flex;}",
    // ⚡ / ✎ 两半等宽的渐变胶囊（照工具端那个样子）
    ".pc-optpair{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;align-items:stretch;",
    "border:1px solid rgba(124,92,255,.42);border-radius:9px;overflow:hidden;white-space:nowrap;",
    "background:linear-gradient(135deg,rgba(124,92,255,.18),rgba(59,130,246,.15) 65%,rgba(236,72,153,.12));",
    "box-shadow:inset 0 1px 0 rgba(255,255,255,.12);}",
    ".pc-optpair>button{border:none;background:transparent;color:#ddd4ff;font-family:inherit;font-size:11.5px;line-height:1;",
    "padding:5px 9px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;min-width:0;white-space:nowrap;}",
    // ★ 192 批：图标定宽 + 左右各贴外沿，字前后不再留空格（他说"小闪电前面两个空格、笔前后 0 个"）
    ".pc-optpair>.pc-optpi{font-style:normal;width:13px;flex:0 0 13px;text-align:center;font-size:12px;}",
    ".pc-optpair>button:first-child{justify-content:flex-start;}",
    ".pc-optpair>button:last-child{justify-content:flex-end;}",
    ".pc-optpair>button+button{border-left:1px solid rgba(124,92,255,.35);}",
    ".pc-optpair>button:hover{background:rgba(124,92,255,.26);color:#fff;}",
    ".pc-optpair>button:active{transform:translateY(1px);}",
    ":root[data-theme=\"light\"] .pc-optpair>button{color:#5b3fd6;}",
    // 只留图标的四颗（@ / @̸ / ⚙）
    ".pc-oico{width:26px;height:24px;border-radius:8px;border:1px solid rgba(150,162,180,.45);",
    "background:rgba(255,255,255,.06);color:#e8eaf1;font-family:inherit;font-size:12.5px;line-height:1;",
    "cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;}",
    ".pc-oico:hover{border-color:rgba(167,139,255,.9);background:rgba(124,92,255,.20);}",
    ".pc-oico.on{border-color:rgba(120,220,160,.95);background:rgba(120,220,160,.22);color:#c8f7dc;}",
    ".pc-oico.no.on{border-color:rgba(240,150,90,.95);background:rgba(240,150,90,.22);color:#ffdcc2;}",
    // @̸ 那颗：@ 上面压一道红斜线
    ".pc-atslash{position:relative;display:inline-block;width:13px;height:13px;font-weight:700;line-height:13px;text-align:center;}",
    ".pc-atslash i{position:absolute;left:-1px;top:6px;width:15px;height:1.6px;background:#ff8a8a;border-radius:2px;",
    "transform:rotate(-42deg);box-shadow:0 0 3px rgba(255,90,90,.75);}",
    // 小圆钮开关（toggle switch）
    ".pc-sw{display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;color:inherit;",
    "font-family:inherit;font-size:11.5px;cursor:pointer;padding:0;line-height:1;flex:0 0 auto;}",
    ".pc-sw .pc-sw-t{opacity:.85;white-space:nowrap;}",
    ".pc-sw .pc-sw-tr{position:relative;width:30px;height:16px;border-radius:9px;background:rgba(150,162,180,.35);",
    "border:1px solid rgba(150,162,180,.5);transition:background .16s,border-color .16s;display:inline-block;}",
    ".pc-sw .pc-sw-k{position:absolute;left:2px;top:1px;width:12px;height:12px;border-radius:50%;background:#fff;",
    "transition:left .16s;box-shadow:0 1px 3px rgba(0,0,0,.35);}",
    ".pc-sw.on .pc-sw-tr{background:linear-gradient(135deg,#7c5cff,#3b82f6);border-color:transparent;",
    "box-shadow:0 0 0 3px rgba(124,92,255,.14);}",
    ".pc-sw.on .pc-sw-k{left:15px;}",
    // ★ 196 批：点黄色波浪时整条抖一下（点击震动）
    // ★ 199 批：波浪放弃，改用"带色两行字 + 转圈"（转圈动画就在这里）
    "@keyframes pcSpin{to{transform:rotate(360deg)}}",
    ".pc-spin{display:inline-block;width:10px;height:10px;border-radius:50%;box-sizing:border-box;",
    "border:2px solid rgba(240,165,43,.28);border-top-color:#f0a52b;animation:pcSpin .85s linear infinite;flex:0 0 auto;}",
    // ★ 小胶囊那一排（★ 收起来的那一段就变成这里面的一颗胶囊；正/负各自一排，在文本框上面）
    ".pc-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}",
    ".pc-chips:empty{display:none;}",
    ".pc-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;font-size:11px;line-height:1;",
    "padding:3px 7px;border-radius:999px;border:1px solid rgba(150,170,210,.5);background:rgba(120,150,220,.16);",
    "color:#e8ecf5;user-select:none;-webkit-user-select:none;}",
    // ★ 第一百四十五批：那颗"挪到最前面"的 ◀
    //   第一百四十六批他第 3 条：「小箭头太大了，小一点」→ 11px 缩到 9px
    //   第一百四十七批他第 1 条：「**箭头还是大了一圈，再小一些**」→ 9px 再缩到 **7px**（更淡一点，别抢名字）
    ".pc-chip .pc-chip-first{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;",
    "font-size:7px;line-height:1;padding:0 2px 0 0;opacity:.7;vertical-align:middle;}",
    ".pc-chip .pc-chip-first:hover{opacity:1;}",
    ":root[data-theme=\"light\"] .pc-chip{color:#2b3040;}",
    ".pc-chip.pos{border-color:rgba(110,170,255,.75);background:rgba(110,170,255,.18);}",
    ".pc-chip.neg{border-color:rgba(240,140,140,.75);background:rgba(240,140,140,.18);}",
    ".pc-chip .pc-chip-name{cursor:pointer;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".pc-chip input.pc-chip-edit{width:90px;font:inherit;font-size:11px;color:inherit;background:rgba(0,0,0,.28);",
    "border:1px solid rgba(150,170,210,.65);border-radius:6px;padding:1px 4px;outline:none;}",
    ".pc-chip .pc-chip-back{border:none;background:transparent;color:inherit;cursor:pointer;font-size:12px;",
    "line-height:1;padding:0 1px;opacity:.75;}",
    ".pc-chip .pc-chip-back:hover{opacity:1;}",
    // ★★ 第一百零九批：胶囊上的小减号 / 加号（虚化 = 内容留着但不参与生图）
    ".pc-chip .pc-chip-off{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;",
    "font-size:12px;line-height:1;padding:0 3px 0 0;opacity:.8;}",
    ".pc-chip .pc-chip-off:hover{opacity:1;}",
    ".pc-chip .pc-chip-off.on{color:#ffd27f;opacity:1;}",
    ".pc-chip.off{opacity:.5;border-style:dashed;}",
    // ★ 216 批（他："这个机制不够明显……得有更明显的特效才行"）：伴随位 = **同一节奏的呼吸光环**
    //   伴随位那颗胶囊（.pc-comp-chip）和它配的小胶囊（.pc-chip.linked）用同一个动画 → 一眼看出是一对。
    // ★ 217 批（他："粉色光效看着像故障了，换成蓝色"）→ 光环、连线色、🔗 角标全换成蓝色系。
    "@keyframes pcCompPulse{0%{box-shadow:0 0 0 0 rgba(56,189,248,.62),0 0 0 rgba(56,189,248,0)}",
    "70%{box-shadow:0 0 0 6px rgba(56,189,248,0),0 0 10px rgba(56,189,248,.38)}",
    "100%{box-shadow:0 0 0 0 rgba(56,189,248,0),0 0 0 rgba(56,189,248,0)}}",
    ".pc-comp-chip{animation:pcCompPulse 1.9s ease-out infinite;}",
    ".pc-chip.linked{animation:pcCompPulse 1.9s ease-out infinite;border-color:rgba(56,189,248,.85)!important;}",
    // ★ 273t：连接标 🔗 已去掉（伴随位只留 .linked 的蓝色呼吸光环 + 蓝边框）
    // ★ 273s 锁链（他："锁链特效和伴随位特效并不冲突，可以同时存在"）：
    //   故意**只动 box-shadow、不动 border-color** —— 伴随位那套是 border-color + 蓝色呼吸光环，
    //   两者同时亮时各显示各的，不会互相盖掉。
    ".pc-chip.chained{box-shadow:inset 0 0 0 1px rgba(255,207,92,.55),0 0 7px rgba(255,207,92,.26);}",
    ".pc-chip.chained.off{box-shadow:none;border-style:dashed;}",
    ".pc-chain-badge{font-style:normal;font-size:10px;color:#ffcf5c;margin-right:2px;opacity:.95;}",
    ".pc-chip.off .pc-chain-badge{opacity:.45;}",
    ":root[data-theme=\"light\"] .pc-chain-badge{color:#b8860b;}",
    "@media (prefers-reduced-motion: reduce){.pc-comp-chip,.pc-chip.linked{animation:none;}}",
    // 文本框（字透明）+ 背后那层"真正显示文字"的镜像 + 最上面那层虚线矩形
    ".pc-ta-wrap{position:relative;display:block;}",
    ".pc-ta{position:relative;z-index:1;display:block;width:100%;box-sizing:border-box;",
    // ★ 273q：color 不再写死在这里 —— 否则关掉 @ 着色时用内联清不掉它（CSS 优先级会顶回来）。
    //   现在只有加上 .pc-at-on 时才透明（见下面），其余时候就是普通文本框。
    "background:transparent;caret-color:#7fb0ff;color:#e8ecf5;",
    "font-family:inherit;font-size:12px;line-height:1.45;",
    "border:1px solid rgba(150,170,210,.45);border-radius:8px;padding:6px 8px;outline:none;",
    "resize:both;min-height:60px;min-width:120px;max-width:100%;white-space:pre-wrap;word-break:break-word;}",
    // ★ 273q：关掉 @ 着色时文本框自己显示字 —— 白天主题下必须是深色，否则又是白字白底
    //   （注意：这条**必须放在 .pc-ta{} 外面**，塞进规则内部会把整条 .pc-ta 搞成语法错）
    ":root[data-theme=\"light\"] .pc-ta{color:#2b3040;}",
    ".pc-ta::placeholder{color:#8892a6;opacity:.95;}",
    ".pc-mirror{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:2;}",
    // ★ 273n（他第 8 条）：@ 号呼吸灯
    // ★ 2026-11-04（他第 1 条）：「专门提权的画师串的艾特号的特效还是太淡，改成**一直在外面波纹状散发残影**」
    //   → 从"亮度呼吸"换成**三层光晕向外扩散**：text-shadow 由内到外逐圈放大、透明度循环衰减，
    //   再配一点点 scale 让字形有"撑开"的感觉。只有"专门提权"那一批会挂这个 class。
    "@keyframes pcAtBreath{0%{text-shadow:0 0 4px currentColor,0 0 0 rgba(255,207,92,0),0 0 0 rgba(255,207,92,0);transform:scale(1)}",
    "45%{text-shadow:0 0 7px currentColor,0 0 14px rgba(255,207,92,.75),0 0 26px rgba(255,207,92,.35);transform:scale(1.06)}",
    "100%{text-shadow:0 0 4px currentColor,0 0 22px rgba(255,207,92,.05),0 0 40px rgba(255,207,92,0);transform:scale(1)}}",
    ".pc-at-breathe{animation:pcAtBreath 1.5s ease-out infinite;display:inline-block}",
    ".pc-mirror-in{color:#e8ecf5;font-family:inherit;font-size:12px;line-height:1.45;border:1px solid transparent;",
    "border-radius:8px;padding:6px 8px;white-space:pre-wrap;word-break:break-word;box-sizing:border-box;}",
    ":root[data-theme=\"light\"] .pc-mirror-in{color:#2b3040;}",
    // ★★ 273q：着色层的字色 —— 跟上面 .pc-mirror-in **两处必须同步改**。
    //   当初就是漏了这一条、靠继承，白天主题下继承到白字 → 整篇隐形（他报的"所有字都隐形"）。
    ".pc-at-hl{color:#e8ecf5;}",
    ":root[data-theme=\"light\"] .pc-at-hl{color:#2b3040;}",
    // 注意：下面这两条必须连着写。:root[data-theme="light"] .pc-ta 的具体度比 .pc-ta.pc-at-on 高，
    //   不补第二条的话，白天主题下"字透明"会被顶掉、着色层白画。
    ".pc-ta.pc-at-on,:root[data-theme=\"light\"] .pc-ta.pc-at-on{color:transparent;}",
    ".pc-mk{color:inherit;}",
    ".pc-mk.off{opacity:.5;}",
    // 「换掉这一段」成功之后，把那一段文字轻轻亮一下（像小助手那样"更新并高亮"）
    ".pc-mk.flash{animation:pcFlash .9s ease-out;}",
    "@keyframes pcFlash{0%{background:rgba(130,225,170,.45);border-radius:4px}100%{background:transparent}}",
    // 虚线矩形那层（每一段一个长方形，框自己不吃鼠标，只有三颗小键吃）
    ".pc-frames{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:3;}",
    // ★ 2026-11-04（他：「优化提示词之后的虚线框框还是看不到 New」）→ 刚优化出来、还没用过的段，
    //   在虚线框上贴一枚 New 小角标（左上/右上都被小键占了，就贴在框内左上角偏下）。
    // ★ 2026-11-05（他：「new 特效有点明显了，金色调成淡金色；new 本身往左下移一点，不要挡住紫色星号」）
      + "font:800 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.5px;color:#6b5626;"
      + "background:linear-gradient(135deg,#fff8e8,#f3dcb2);padding:1px 4px;border-radius:5px;"
      + "box-shadow:0 1px 4px rgba(240,205,150,.40);}",
    ".pc-frame.pc-new{border-color:#e8cfa0;box-shadow:0 0 8px rgba(240,205,150,.26);}",
    ".pc-frame{position:absolute;box-sizing:border-box;border:1.5px dashed #8aa0c8;border-radius:6px;",
    "background:rgba(120,150,220,.07);pointer-events:none;}",
    ".pc-frame.off{border-color:#9aa1b3;background:rgba(128,128,128,.07);}",
    ".pc-frame button{position:absolute;pointer-events:auto;border:none;border-radius:50%;width:17px;height:17px;",
    "line-height:1;padding:0;cursor:pointer;background:rgba(255,255,255,.16);color:#dfe6f5;font-size:11px;",
    "display:flex;align-items:center;justify-content:center;}",
    ".pc-frame button:hover{background:rgba(255,255,255,.34);}",
    ".pc-frame .pc-x{right:6px;top:-9px;background:#c0392b;color:#fff;}",
    ".pc-frame .pc-x:hover{background:#e04b3a;}",
    ".pc-frame .pc-off{right:30px;top:-9px;}",
    // ★★ 2026-10-06 他报：「信号（星号）变成胶囊的小圆钮，为什么从右上角变成了左上角？想了一下，我也认命了，
    //   算了，把它改个颜色，让它变得更显眼一点，就放左上角吧，右上角有点挤了。」
    //   根因：这颗键当初**根本没写定位规则**（`.pc-star` 缺一条）→ 绝对定位的默认位置就是框的左上角。
    //   → 就地钉在**左上角**，颜色换成显眼的**紫罗兰**（他早先说过"不要金黄色"），再加一圈亮边 + 淡光晕。
    ".pc-frame .pc-star{left:6px;top:-9px;right:auto;background:rgba(150,110,255,.9);color:#fff;",
    "border:1px solid rgba(205,185,255,.95);box-shadow:0 0 7px rgba(150,110,255,.8);font-weight:700;}",
    ".pc-frame .pc-star:hover{background:rgba(175,140,255,1);box-shadow:0 0 10px rgba(170,135,255,.95);}",
    // ★ 他 2026-10-05 第九十八批：「我说的星号不是金黄色的那个星星，是 * 这个星号，所以也不要金黄色的」
    //   → 就用半角 `*`，颜色跟旁边几颗键一样（不再单独上金黄色）。
    ".pc-frame .pc-copy{right:30px;bottom:4px;background:rgba(110,200,150,.55);}",
    ".pc-frame .pc-copy:hover{background:rgba(130,225,170,.8);}",
    ".pc-frame .pc-swap{right:6px;bottom:4px;background:rgba(90,140,240,.6);}",
    // ★ 2026-10-05 他报的「虚线框只有一排时，上下两排小键会重合在一起」→
    //   框太矮（一排字）时，五颗键**并成一排**全放到框上面去（顺序照旧：★ − ✕ 复制 ⇄）。
    ".pc-frame.short .pc-off{right:30px;top:-9px;bottom:auto;}",
    ".pc-frame.short .pc-star{right:54px;left:auto;top:-9px;bottom:auto;}",
    ".pc-frame.short .pc-copy{right:78px;top:-9px;bottom:auto;}",
    ".pc-frame.short .pc-swap{right:102px;top:-9px;bottom:auto;}",
    // ★ 2026-10-05 第九十九批他报「点复制键没反馈，哪怕像水波一样原地沉浮一下呢」：
    //   点下去时**键自己原地沉浮一下**（pcPulse），成功/失败再放一圈**水波**（pcWave，绿/红）。
    ".pc-frame button.pc-pulse{animation:pcPulse .42s ease-out;}",
    "@keyframes pcPulse{0%{transform:scale(1)}30%{transform:scale(1.32) translateY(-1px)}62%{transform:scale(.92)}100%{transform:scale(1)}}",
    ".pc-frame .pc-wave{position:absolute;box-sizing:border-box;border-radius:50%;pointer-events:none;",
    "border:2px solid rgba(130,225,170,.95);animation:pcWave .62s ease-out forwards;}",
    ".pc-frame .pc-wave.bad{border-color:rgba(240,120,110,.95);}",
    "@keyframes pcWave{0%{transform:scale(.5);opacity:1}70%{opacity:.45}100%{transform:scale(2.2);opacity:0}}",
    ".pc-clip-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
    ".pc-clip-foot button{border:1px dashed #7f8ea8;background:transparent;color:#b9c3d6;border-radius:8px;",
    "padding:3px 8px;cursor:pointer;font-family:inherit;font-size:11px;}",
    ".pc-clip-foot button:hover{background:rgba(255,255,255,.1);}",
    // ★ 批 C3 那颗「⚖ 调整…关键词权重」：跟旁边两颗虚线键一个长相，但边框点亮一点、好认
    //   （第一百零六批拆成两颗：**正**的挂在两个文本框中间、**负**的在这排键里 —— 底色分清正负）
    ".pc-clip-foot button.pc-weight-btn{border-style:solid;border-color:rgba(240,140,140,.75);color:#ffd9d9;}",
    ".pc-clip-foot button.pc-weight-btn:hover{background:rgba(240,140,140,.22);}",
    // 中间那条：正权重的按钮（夹在正/负两个文本框之间）
    ".pc-clip-mid{display:flex;align-items:flex-start;gap:8px;flex-wrap:nowrap;padding:1px 0 2px;position:relative;}",
    ".pc-clip-mid button{border:1px solid rgba(110,170,255,.75);background:transparent;color:#d6e6ff;",
    "border-radius:8px;padding:3px 8px;cursor:pointer;font-family:inherit;font-size:11px;}",
    ".pc-clip-mid button:hover{background:rgba(110,170,255,.22);}",
    ".pc-clip-mid .pc-clip-mid-tip{opacity:.55;font-size:11px;}",
    ".pc-clip-foot .pc-clip-tip{opacity:.55;font-size:11px;}",
    // ★ 2026-10-06 他说的「顺便用灰字提醒一下，就是一样长一样宽的」→ 灰字独占一行（排在按键下面）
    ".pc-clip-foot .pc-clip-wide{flex:1 0 100%;opacity:.6;font-size:11px;}",
    ".pc-collapse-btn{cursor:pointer;}",
    // ★ 2026-10-05 第一百零一批他定稿：撤销 / 重做两颗，**放在文本框右下角**（给原生那个拖拉角留出位置），
    //   箭头用**直的**（⇐ / ⇒）—— 跟小助手的弯箭头明显不一样（他原话：「要做的很像，但是不能一模一样……
    //   可以试着把箭头从弯的箭头变成直的箭头，要做出差异性，我没抄袭」）。
    ".pc-hist{position:absolute;right:22px;bottom:6px;display:flex;gap:4px;z-index:4;}",
    ".pc-hist button{width:18px;height:18px;padding:0;border:1px solid rgba(150,170,210,.5);border-radius:50%;",
    "background:rgba(20,26,40,.6);color:#dfe6f5;font-size:12px;line-height:1;cursor:pointer;",
    "display:flex;align-items:center;justify-content:center;font-family:inherit;}",
    ".pc-hist button:hover:not(:disabled){background:rgba(90,140,240,.6);}",
    ".pc-hist button:disabled{opacity:.3;cursor:default;}",
    ":root[data-theme=\"light\"] .pc-hist button{background:rgba(255,255,255,.88);color:#2b3040;}",
  ].join("");
  document.head.appendChild(st);
}

// ---------------------------------------------------------------- 状态（存 properties，跟着工作流走）
function normRange(r) {
  if (!r || typeof r !== "object") return null;
  var s = Math.max(0, parseInt(r.s, 10) || 0);
  var e = Math.max(s, parseInt(r.e, 10) || 0);
  // ★ 第一百四十五批（他第 1 条）：这一段"上次收成胶囊时叫什么名字"—— 记在**段自己身上**（`n`），
  //   跟着工作流一起存。于是【收起 → 展开 → 再收起】无论中间有没有刷新 / 重开，名字都还在，
  //   也不再只认"原文一字不差"（他报的正是这个：能继承，但只活在当前状态里）。
  var n = String(r.n == null ? "" : r.n).trim().slice(0, 60);
  return { s: s, e: e, off: !!r.off, n: n };
}
function normSide(side) {
  var v = (side && typeof side.v === "string") ? side.v : "";
  var rs = [];
  if (side && Array.isArray(side.r)) rs = side.r.map(normRange).filter(Boolean);
  var len = v.length;
  rs = rs.filter(function (r) { return r.s < len && r.e > r.s; })
    .map(function (r) { return { s: r.s, e: Math.min(r.e, len), off: r.off, n: r.n }; });
  var h = (side && parseInt(side.h, 10)) || DEF_H;
  var w = (side && parseInt(side.w, 10)) || 0;
  // ★ 小胶囊（★ 收起来的那一段）：文字已经从 v 里**拿掉**了，存在这儿 ——
  //   `at` = 它原来在（拿掉之后的）v 里的那个位置，送进后端时按这个位置插回去。
  var chips = [];
  if (side && Array.isArray(side.chips)) {
    chips = side.chips.filter(function (c) { return c && typeof c.text === "string" && c.text; })
      .map(function (c, i) {
        return {
          name: String(c.name || (i + 1)),
          text: c.text,
          at: Math.max(0, Math.min(len, parseInt(c.at, 10) || 0)),
          off: !!c.off,                       // − 隐藏过的那段：变成胶囊也仍然"不参与生图"
        };
      }).sort(function (a, b) { return a.at - b.at; });
  }
  // ★★ 胶囊的"名字记忆"（他第一百零九批第 1 条）：以前 ↩ 展开回文本框时名字就跟着胶囊一起没了，
  //    再点 * 收回来只能重新编号。这里按**那一段的原文**把名字记下来 → 收回去还是原来那个名字。
  var names = {};
  if (side && side.chipNames && typeof side.chipNames === "object") {
    Object.keys(side.chipNames).forEach(function (k) {
      var v2 = String(side.chipNames[k] == null ? "" : side.chipNames[k]).trim();
      if (k && v2 && k.length < 20000) names[k] = v2;
    });
  }
  return { v: v, r: rs, chips: chips, h: Math.max(60, Math.min(1200, h)), w: w, chipNames: names };
}
function sideOf(node, which) {
  if (!node.properties) node.properties = {};
  var p = node.properties[PROP];
  if (!p || typeof p !== "object") p = {};
  // ⚠️ 只在"还没规整过"的时候规整一次。normSide 每次都会造**新对象**，
  //   头一版每次调用都重建 → 界面里那些小键闭包攥着的 range 立刻变成孤儿（点了没反应）。
  if (p.__v !== 2) {
    if (!p.pos) p.pos = normSide(null);
    if (!p.neg) p.neg = normSide(null);
    // 兼容最初那一版：pcSegs = [{t, off}]
    if (Array.isArray(node.properties.pcSegs) && node.properties.pcSegs.length) {
      var joined = node.properties.pcSegs.filter(function (s) { return !s.off; })
        .map(function (s) { return String(s.t || ""); }).filter(Boolean).join("\n\n");
      if (joined && !p.pos.v) p.pos = normSide({ v: joined, r: [{ s: 0, e: joined.length, off: false }], h: DEF_H });
      try { delete node.properties.pcSegs; } catch (e) { /* 忽略 */ }
    }
    p.pos = normSide(p.pos); p.neg = normSide(p.neg);
    p.__v = 2;
  }
  node.properties[PROP] = p;
  return p[which];
}
// 送进后端的那份：① 隐藏起来（− ）的框**整段不参与**；
//   ② ★ 收成小胶囊的那些段**照样算**（他 2026-10-05 定的："还算，只是显示上收起来"）→ 按原来的先后位置插回去。
// ★ 215 批（他："伴随位的小胶囊根本不生效，里面的提示词根本没有参与生图"）：
//   伴随位以前只是**界面上的配对**，`comp` 从来没参与编码 —— 所以配了也没用。
//   现在的语义：**一颗小胶囊只要配了伴随位，就只在"配的那颗 LoRA 亮着"时才参与生图**；
//   LoRA 一熄灭（或从池子里删掉），这颗胶囊的文字自动不送进编码（跟点了 − 一个效果，但文字都留着）。
//   没配伴随位的胶囊照旧一直参与。
function litLoraNames() {
  try {
    var pools = ((app && app.graph && app.graph._nodes) || []).filter(function (n) { return n && n.type === "PromptToolLoraPool"; });
    if (!pools.length) return null;                       // 没有池子 → 不做伴随判断
    var w = (pools[0].widgets || []).filter(function (x) { return x && x.name === "状态"; })[0];
    var st = w ? JSON.parse(String(w.value || "{}")) : {};
    return (st.loras || []).filter(function (r) { return r && r.on; }).map(function (r) { return String(r.name); });
  } catch (e) { return null; }
}
function compPairsOf(node, chipText, which) {              // 这颗胶囊配了哪些伴随位（按正/负分侧）
  try {
    var side = (which === "neg") ? "neg" : "pos";          // ★ 237 批：负提示词也有伴随位了
    var q = (node && node.properties && node.properties.pcClip) || {};
    var comp = Array.isArray(q.comp) ? q.comp : [];
    return comp.filter(function (c) {
      return c && String(c.chip) === String(chipText) && ((c.side === "neg") ? "neg" : "pos") === side;
    });
  } catch (e) { return []; }
}
// 这颗胶囊的伴随状态：none=没配 / live=配对的那颗 LoRA 亮着 / dead=配了但 LoRA 没亮
function compStateOf(node, chipText, which) {
  var pairs = compPairsOf(node, chipText, which);
  if (!pairs.length) return { state: "none", pairs: pairs };
  var lit = litLoraNames();
  if (!lit) return { state: "live", pairs: pairs };       // 读不到池子就别乱判
  var on = pairs.some(function (c) { return lit.indexOf(String(c.lora)) >= 0; });
  return { state: on ? "live" : "dead", pairs: pairs };
}
function compGate(node, chipText, which) {                  // true = 这颗胶囊现在该参与生图
  try {
    var st = compStateOf(node, chipText, which);
    return st.state !== "dead";
  } catch (e) { return true; }
}
// ★ 273u（他："我把小胶囊排列在一起，我也不知道排列在一起的小胶囊之间不会有分隔号啊，
//   你应该改改这个分隔来着"）→ 拼胶囊时**没写分隔符就自动补一个逗号**。
//   只影响"送去编码的那串文本"，不动界面显示、也不动存下来的数据；
//   已经写了逗号 / 顿号 / 分号的地方一律不重复补。
function joinPiece(a, b) {
  var x = String(a == null ? "" : a), y = String(b == null ? "" : b);
  if (!y) return x;
  if (!x) return y;
  var xt = x.replace(/\s+$/, "");        // 前一段先去掉尾部空白再判
  if (!xt) return y;
  var yt = y.replace(/^\s+/, "");
  if (!yt) return xt;
  if (/[,，、;；]$/.test(xt) || /^[,，、;；]/.test(yt)) return xt + " " + yt;   // 已经有分隔符了
  return xt + ", " + yt;                                                      // 没有就补一个逗号
}
function effectiveText(side, node, which) {
  var evs = [];
  side.r.forEach(function (r) { if (r.off) evs.push({ s: r.s, e: r.e, t: null }); });
  (side.chips || []).forEach(function (c) {
    if (c.off) return;
    if (node && !compGate(node, c.text, which)) return;    // ★ 215/237 批：伴随位的 LoRA 没亮 → 这段不参与
    evs.push({ s: c.at, e: c.at, t: c.text });
  });
  evs.sort(function (a, b) { return a.s - b.s; });
  var out = "", pos = 0;
  evs.forEach(function (r) {
    if (r.s > pos) out = joinPiece(out, side.v.slice(pos, r.s));
    if (r.t !== null) out = joinPiece(out, r.t);
    pos = Math.max(pos, r.e);
  });
  out = joinPiece(out, side.v.slice(pos));
  // ★ 224 批（他："实行之后相当于小胶囊，但是这个小胶囊能不能隐形呢"）：
  //   亮着的 LoRA 的**触发词**在编码时拼到正提示词**末尾**（界面上不占胶囊行，只显示"x 个触发词已隐形"）。
  if (which === "pos" && node && typeof node.__pcTriggers === "function") {
    try {
      var tg = node.__pcTriggers() || [];
      if (tg.length) {
        var head = out.replace(/\s+$/, "");
        var tail = tg.join(", ");
        out = head ? (/,$/.test(head) ? head + " " + tail : head + ", " + tail) : tail;
      }
    } catch (e) { /* 忽略 */ }
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function textWidget(node, name) {
  var ws = node && node.widgets;
  if (!Array.isArray(ws)) return null;
  for (var i = 0; i < ws.length; i++) { if (ws[i] && ws[i].name === name) return ws[i]; }
  return null;
}
function writeWidget(w, val, node) {
  if (!w) return;
  try {
    w.value = val;
    if (typeof w.callback === "function") w.callback(val);
    if (w.inputEl && "value" in w.inputEl) w.inputEl.value = val;
    if (w.element && typeof w.element.querySelector === "function") {
      var ta = w.element.querySelector("textarea");
      if (ta) ta.value = val;
    }
    // ★ 273r：同样是程序改 value（不触发 input）→ 着色层要手动重画，
    //   否则收起/展开或写回控件时，屏幕上会留着上一份"假文本"。
    try {
      if (node && node.__pcHl) {
        Object.keys(node.__pcHl).forEach(function (k) { try { node.__pcHl[k].paint(); } catch (e2) { /* 忽略 */ } });
      }
    } catch (e3) { /* 忽略 */ }
  } catch (e) { /* 忽略 */ }
}
// ★ 197 批②（他 2026-10-21 澄清）：`@̸ 忽略画师串` **不是**"优化时不许加画师串" ——
//   优化照常**允许**挑/换画师串，只是这一段的文本**拿去绘图时**把画师串筛掉、不参与作图。
//   所以过滤放在 `syncBackend()`（真正写给后端 encode 的那一步），不动用户文本、也不动优化结果。
function stripArtistTokens(txt) {
  var NL = String.fromCharCode(10);
  return String(txt || "").split(NL).map(function (line) {
    return line.split(",").filter(function (t) {
      var core = String(t || "").trim();
      while (core.length > 1 && "([{".indexOf(core.charAt(0)) >= 0 && ")]}".indexOf(core.charAt(core.length - 1)) >= 0) core = core.slice(1, -1).trim();
      var w = core.indexOf(":");
      if (w > 0) { var tail = core.slice(w + 1).trim().replace(/[0-9.]/g, ""); if (tail === "") core = core.slice(0, w).trim(); }
      return !(core.charAt(0) === "@" && core.replace(/^@+/, "").trim());
    }).join(",").trim();
  }).filter(function (x) { return x; }).join(NL).trim();
}
// ★ 收起 = 文本不参与作图（他明确要的）：收起时把后端那两个控件清空，
//   内容还留在 properties 里，展开时原样写回。
// ★ 273h 批（他："重新建一个优化节点的成本太大，所以现在默认叫出来新的优化节点，
//   里面的数据是和上一个最新编辑过的优化节点的数据一模一样的"）
//   记两样：内存里最近一次编辑的整份状态 + 写进 properties 的时间戳（刷新后还能认出谁最新）。
var LAST_CLIP = { props: null, at: 0 };
function clipTouch(node) {
  try {
    var p = node && node.properties && node.properties[PROP];
    if (!p) return;
    var at = Date.now();
    p.__at = at;
    if (!LAST_CLIP.props || at >= LAST_CLIP.at) {
      LAST_CLIP.props = JSON.parse(JSON.stringify(p));
      LAST_CLIP.at = at;
    }
  } catch (e) { /* 忽略 */ }
}
function clipInherit(node) {
  try {
    if (!node.properties) node.properties = {};
    var has = node.properties[PROP];
    if (has && has.__at) return false;                 // 已经有自己的数据，不动
    var src = LAST_CLIP.props;
    if (!src) {
      var best = null, bestAt = -1;
      ((app && app.graph && app.graph._nodes) || []).forEach(function (n2) {
        if (!n2 || n2 === node || n2.type !== NODE_NAME) return;
        var q = n2.properties && n2.properties[PROP];
        var a2 = (q && q.__at) || 0;
        if (q && a2 > bestAt) { best = q; bestAt = a2; }
      });
      src = best;
    }
    if (!src) return false;
    var cp = JSON.parse(JSON.stringify(src));
    cp.__at = Date.now();
    node.properties[PROP] = cp;
    return true;
  } catch (e) { return false; }
}
function syncBackend(node) {
  var collapsed = !!(node.flags && node.flags.collapsed);
  try { clipTouch(node); } catch (e) { /* 忽略 */ }
  var wPos = textWidget(node, "正提示词") || textWidget(node, "text");   // text = 老版后端的那个控件
  var wNeg = textWidget(node, "负提示词");
  var posTxt = effectiveText(sideOf(node, "pos"), node, "pos");
  var negTxt = effectiveText(sideOf(node, "neg"), node, "neg");
  try {
    var u = optUIOf(node);
    if (u && u.noArtist) { posTxt = stripArtistTokens(posTxt); negTxt = stripArtistTokens(negTxt); }
  } catch (e) { /* 忽略 */ }
  writeWidget(wPos, collapsed ? "" : posTxt, node);
  writeWidget(wNeg, collapsed ? "" : negTxt, node);
  // ★ 批 C3（2026-10-06）：关键词权重表也有一条**藏起来的**控件（后端 encode 读它）——
  //   收起时同样得写空，不然"收起 = 不参与作图"会被那些带权重的词破坏（词会被追加到空文本上）。
  try { if (window.__pcWeights && window.__pcWeights.mirror) window.__pcWeights.mirror(node); } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 镜像（真正显示文字的那层）
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mirrorHTML(text, ranges) {
  var rs = ranges.slice().sort(function (a, b) { return a.s - b.s; });
  var out = "", pos = 0, i = 0;
  rs.forEach(function (r) {
    if (r.s < pos) return;                        // 交叠的跳过（正常不会出现）
    out += esc(text.slice(pos, r.s));
    // ⚠️ 带上 data-i：画框时**按这个索引去取**，不再依赖"querySelectorAll 的顺序 == ranges 的顺序"
    out += '<span class="pc-mk' + (r.off ? " off" : "") + '" data-i="' + i + '">' + esc(text.slice(r.s, r.e)) + "</span>";
    pos = r.e; i++;
  });
  out += esc(text.slice(pos));
  return out + "\n";                              // 尾巴补一个换行，跟 textarea 的滚动高度对齐
}
// 文本框变了之后：把每段的范围按"改在哪里"挪一下（打字的改动不算粘贴 → 不会生成新框）
function applyDelta(side, oldV, newV) {
  if (oldV === newV) return;
  var p = 0;
  while (p < oldV.length && p < newV.length && oldV.charAt(p) === newV.charAt(p)) p++;
  var so = oldV.length, sn = newV.length;
  while (so > p && sn > p && oldV.charAt(so - 1) === newV.charAt(sn - 1)) { so--; sn--; }
  var d = (sn - p) - (so - p);
  side.r = side.r.map(function (r) {
    if (r.e <= p) return r;
    if (r.s >= so) return { s: r.s + d, e: r.e + d, off: r.off, n: r.n };
    return null;                                   // 和这次改动相交 → 这个框没了
  }).filter(Boolean);
  // ★ 收成小胶囊的那几段：`at` 也跟着挪（插在它前面的字变长 / 变短了）
  (side.chips || []).forEach(function (c) {
    if (c.at <= p) return;
    if (c.at >= so) { c.at += d; return; }
    c.at = p;                                      // 正好改在它那个位置 → 贴到改动点
  });
  side.v = newV;
  side.r = side.r.filter(function (r) { return r.s < newV.length && r.e > r.s; });
}

// ---------------------------------------------------------------- 面板
function makePanel(node) {
  var panel = document.createElement("div");
  panel.className = "pc-clip";
  panel.style.setProperty("--comfy-widget-min-height", "110px");
  panel.style.setProperty("--comfy-widget-max-height", "4000px");

  // ★ 186 批：提示词优化工具条（总开关关着的时候整条按钮都不显示，节点看着干净）
  // ★ 191 批：位置改成「小胶囊上面那一行」的最右边 —— 所以这里只造、不挂，等正提示词那一块建好后
  //   再塞进它的标签行（见下面 buildSide("pos") 之后那几行）。
  var optBar = makeOptBar(node);
  panel.__pcOptBar = optBar;

  var secs = {};
  var dragW0 = null;              // 按下那一刻两个文本框的宽度（用来判断"他拖的是哪一个"）

  function buildSide(which, title, note, ph) {
    var sec = document.createElement("div");
    sec.className = "pc-clip-sec";
    var lab = document.createElement("div");
    lab.className = "pc-clip-lab";
    var n1 = document.createElement("span");
    n1.textContent = title;
    var n2 = document.createElement("span");
    n2.className = "pc-clip-note";
    n2.textContent = note;
    lab.appendChild(n1); lab.appendChild(n2);
    sec.appendChild(lab);

    // ★ 小胶囊那一排（在文本框上面；★ 收起来的那一段就变成这里面的一颗胶囊）——
    //   他 2026-10-05 挑的形态：**正 / 负各自一排**（所以这排长在各自那个文本框上面）。
    var chipRow = document.createElement("div");
    chipRow.className = "pc-chips";
    sec.appendChild(chipRow);

    var wrap = document.createElement("div");
    wrap.className = "pc-ta-wrap";
    var ta = document.createElement("textarea");
    ta.className = "pc-ta";
    ta.spellcheck = false;
    ta.placeholder = ph;
    var mirror = document.createElement("div");
    mirror.className = "pc-mirror";
    // ★ 273m（他："艾特符号和原来的叠在一起，像重影"）：这层只是给虚线框量位置用的，
    //   它的文字会跟着色层重复 → 视觉上隐藏（visibility 不影响量尺寸）
    mirror.style.visibility = "hidden";
    var mIn = document.createElement("div");
    mIn.className = "pc-mirror-in";
    mirror.appendChild(mIn);
    var frames = document.createElement("div");
    frames.className = "pc-frames";
    wrap.appendChild(ta);
    wrap.appendChild(mirror);
    wrap.appendChild(frames);
    // ★ 273l（他第 1 条：星星会残留/错位/被字淹没）→ 改成**把文本框里的 `@` 号本身显色**：
    //   文本用一层同排版的"着色层"画出来（textarea 自己的字透明、只留光标），
    //   未提权的 `@` 是紫色、提权过的 `@` 是金色，点一下 `@` 就切换（提示只一句短的）。
    var hlWrap = document.createElement("div");
    hlWrap.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:3;border-radius:inherit";
    wrap.appendChild(hlWrap);
    var hlIn = document.createElement("div");
    hlIn.className = "pc-at-hl";                       // ★ 273q：字色写在 CSS 里（下面 .pc-at-hl），切黑夜/白天自动跟
    hlIn.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;white-space:pre-wrap;"
      // ★ 273q（他："艾特画所附带的文本框…像不在同一图层一样"）：ta 自带 1px 边框 + 8px 圆角，
      //   这层没有同样的**透明**边框 → 文字整体比真字偏 1px 且底色范围对不上。
      + "word-break:break-word;overflow-wrap:break-word;margin:0;"
      + "border:1px solid transparent;border-radius:8px;box-sizing:border-box";
    hlWrap.appendChild(hlIn);
    // ★★ 273q 他报的恶性 bug：「因为我们把艾特号搞得花里胡哨的缘故，所以现在所有字它都隐形了，
    //   艾特画所附带的文本框也像不在同一图层一样，想去也去不掉」。查实的两个根因：
    //   ① 着色层 hlIn **没有自己的 color**，全靠从面板继承 —— 而 .pc-mirror-in 那层是有主题规则的
    //      （黑夜 #e8ecf5 / 白天 #2b3040）。白天主题下面板底色浅、hlIn 继承到白字 → 整篇隐形。
    //   ② hlIn 少了 ta 那条 1px 透明边框 → 字整体偏 1px、底色范围对不上，看着"不同图层"。
    //   ③ "想去也去不掉" = 这层特效当初没有关掉的入口 → 下面补一颗 @ 键，一步开关。
    //   → 现在的做法：颜色**每次都从镜像层抄**（那层已经写好了两套主题，以后加主题不用再动这里）。
    // ★ 273r（他："「@画师串：开着等于优化时允许它跳或者换画师串」，这个按钮开着的时候
    //   就直接相当于艾特号着色开启就行了，没必要再多设一个按钮"）
    //   → 着色不再有自己的开关：**亮着那颗 @ 按钮就上色，灭了就是普通字**。
    function atColorOff() {
      try { return !optUIOf(node).artist; } catch (e) { return true; }
    }
    function applyAtMode() {
      var off = atColorOff();
      try {
        if (off) {
          ta.classList.remove("pc-at-on");                // 恢复成跟旁边别的输入框一样的普通字
          try { ta.style.color = ""; } catch (e2) { /* 忽略 */ }   // 兼容 273l 留下的老内联
          hlIn.style.display = "none";
          hlIn.innerHTML = "";
        } else {
          ta.classList.add("pc-at-on");                   // 字交给着色层画（有 @ 时才真的画，见 paintHL）
          try { ta.style.color = ""; } catch (e2) { /* 忽略 */ }
          hlIn.style.display = "";
          paintHL();
        }
      } catch (e) { /* 忽略 */ }
    }
    try {
      ta.style.caretColor = "#e8eaf1";
      ta.style.background = "transparent";
    } catch (e) { /* 忽略 */ }
    function artRules() {
      if (!node.__artistRules) {
        var p0 = null;
        try { p0 = node.properties && node.properties.pcClipArtist; } catch (e) { p0 = null; }
        node.__artistRules = (p0 && typeof p0 === "object")
          ? { black: (p0.black || []).slice(), boost: (p0.boost || []).slice(), boost2: (p0.boost2 || []).slice(),
              prob: (typeof p0.prob === "number" ? p0.prob : 100), boostProb: (typeof p0.boostProb === "number" ? p0.boostProb : 0) }
          : { black: [], boost: [], boost2: [], prob: 100, boostProb: 0 };
      }
      if (!Array.isArray(node.__artistRules.black)) node.__artistRules.black = [];
      if (!Array.isArray(node.__artistRules.boost)) node.__artistRules.boost = [];
      // ★ 2026-11-04（他第 6 条）：「设置专门提权的画师串……并设置专门用到画师串的概率，
      //   概率不能高于所有画师串用到授权画师串的概率，并且专门的概率会占用那个总概率」
      //   → `boost2` = 专门提权（@ 金色 + 呼吸灯）；`boostProb` = 它们的子概率，永远 ≤ `prob`。
      if (!Array.isArray(node.__artistRules.boost2)) node.__artistRules.boost2 = [];
      if (typeof node.__artistRules.boostProb !== "number") node.__artistRules.boostProb = 0;
      node.__artistRules.boostProb = Math.max(0, Math.min(Number(node.__artistRules.prob) || 0, node.__artistRules.boostProb));
      return node.__artistRules;
    }
    function saveArtRules() {
      try {
        node.properties = node.properties || {};
        node.properties.pcClipArtist = {
          black: artRules().black.slice(), boost: artRules().boost.slice(), boost2: artRules().boost2.slice(),
          prob: artRules().prob, boostProb: artRules().boostProb,
        };
      } catch (e) { /* 忽略 */ }
    }
    function toggleArtist(name) {
      var r = artRules();
      var inBoost = r.boost.indexOf(name) >= 0;
      if (inBoost) {
        r.boost = r.boost.filter(function (x) { return x !== name; });
        r.boost2 = r.boost2.filter(function (x) { return x !== name; });   // 取消提权时连"专门提权"一起撤
      }
      else {
        r.boost.push(name);
        r.black = r.black.filter(function (x) { return x !== name; });
      }
      saveArtRules();
      paintHL();
      try { toast(inBoost ? ("已取消提权 " + name) : ("已提权 " + name)); } catch (e) { /* 忽略 */ }
    }
    function escHtml(x) {
      return String(x).replace(/[&<>"]/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
      });
    }
    function paintHL() {
      try {
        // ① 着色被关掉 → 一个字都不画，字交回给 textarea 自己（重载工作流时 properties 来得晚，这里纠回来）
        if (atColorOff()) {
          if (hlIn.innerHTML) hlIn.innerHTML = "";
          if (hlIn.style.display !== "none") hlIn.style.display = "none";
          if (ta.classList.contains("pc-at-on")) ta.classList.remove("pc-at-on");
          try { if (ta.style.color === "transparent") ta.style.color = ""; } catch (e2) { /* 忽略 */ }
          return;
        }
        // ★ 273q 保险：**框里根本没有 @ 就走原生显示**，完全不进着色层 ——
        //   绝大多数文本框里没有 @，这样它们跟普通输入框一模一样，着色层再出问题也波及不到。
        var hasAt = /@[A-Za-z0-9_\-.]+/.test(String(ta.value || ""));
        if (!hasAt) {
          if (hlIn.innerHTML) hlIn.innerHTML = "";
          if (hlIn.style.display !== "none") hlIn.style.display = "none";
          if (ta.classList.contains("pc-at-on")) ta.classList.remove("pc-at-on");
          return;
        }
        if (!ta.classList.contains("pc-at-on")) ta.classList.add("pc-at-on");
        if (hlIn.style.display === "none") hlIn.style.display = "";
        // ★ 273q：字色由 CSS 的 .pc-at-hl 决定（绝不能用内联，内联会压住主题规则）。
        var cs = window.getComputedStyle(ta);
        ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
         "paddingTop", "paddingLeft", "paddingRight", "paddingBottom",
         "borderTopWidth", "borderLeftWidth", "boxSizing", "textIndent"].forEach(function (k) {
          hlIn.style[k] = cs[k];
        });
        hlIn.style.width = ta.clientWidth + "px";
        var txt = String(ta.value || "");
        var r = artRules();
        var out = "";
        // ★ 273z（他第 3 条："画师串已经有了 @kuroboshi kouhaku，文本框里面也有，@ 号还是冒紫
        //   —— 因为被识别成了 @kuroboshi，没有识别 kouhaku，所以识别有问题"）
        //   真因：老正则 /@[A-Za-z0-9_\-.]+/ 只吃"一个词"，带空格的画师名永远匹配不上 →
        //   永远按"没提权"上紫色。现在改成：先在已知画师名（提权 + 黑名单）里挑**最长的那个**去试，
        //   都对不上才退回"一个词"。
        var known = [];
        (function () {
          var seen = {}, all = (r.boost || []).concat(r.boost2 || []).concat(r.black || []);
          for (var k = 0; k < all.length; k++) {
            var x = all[k];
            if (typeof x !== "string" || x.length < 2) continue;
            var nm = x.charAt(0) === "@" ? x : ("@" + x);
            if (seen[nm]) continue;
            seen[nm] = 1; known.push(nm);
          }
          known.sort(function (a, b) { return b.length - a.length; });   // 长名优先，免得短名抢走长的
        })();
        var t2 = String(txt || "");
        var last = 0;
        for (var i2 = 0; i2 < t2.length; i2++) {
          if (t2.charAt(i2) !== "@") continue;
          var name = "", hitK;
          for (hitK = 0; hitK < known.length; hitK++) {
            if (t2.substr(i2, known[hitK].length) === known[hitK]) { name = known[hitK]; break; }
          }
          if (!name) { var mm = /^@[A-Za-z0-9_\-.]+/.exec(t2.slice(i2)); name = mm ? mm[0] : ""; }
          if (!name) continue;
          out += escHtml(t2.slice(last, i2));
          // ★ 291 批（他第 1 条）：拉黑的画师串 → @ 号变**红色**（提权金 / 普通紫 / 拉黑红）
          //   注意：名单里有的存带 @ 的、有的不带（点击 @ 时记的是带 @ 的那串），比之前要剥掉 @
          var bareName = String(name || "").replace(/^@+/, "");
          var inList = function (arr) {
            for (var ii = 0; ii < (arr || []).length; ii++) {
              if (String(arr[ii] || "").replace(/^@+/, "") === bareName) return true;
            }
            return false;
          };
          var inB = inList(r.boost);
          var inTop = inList(r.boost2);
          var inBlack = inList(r.black);
          var atColor = inBlack ? "#ff5c5c" : (inB ? "#ffcf5c" : "#a855f7");
          var atGlow = inBlack ? "rgba(255,92,92,.5)" : (inB ? "rgba(255,207,92,.45)" : "rgba(168,85,247,.45)");
          // ★ 2026-11-04（他第 6 条）：**只有「专门提权」的 @ 才呼吸**（其余的 @ 是静止的），
          //   金色照旧；拉黑的红字不呼吸（它不是"好的提权"）。
          var breathCls = (inTop && !inBlack) ? "pc-at-breathe" : "";
          out += '<span data-at="' + escHtml(name) + '" class="' + breathCls + '" style="pointer-events:auto;cursor:pointer;font-weight:900;'
            + "color:" + atColor + ';text-shadow:0 0 6px ' + atGlow + '">@</span>'
            + escHtml(name.slice(1));
          last = i2 + name.length;
          i2 = last - 1;
        }
        out += escHtml(t2.slice(last));
        hlIn.innerHTML = out + "&nbsp;";
        hlIn.style.transform = "translateY(" + (-(ta.scrollTop || 0)) + "px)";
        Array.prototype.forEach.call(hlIn.querySelectorAll("span[data-at]"), function (sp) {
          sp.addEventListener("click", function (e2) {
            e2.preventDefault();
            e2.stopPropagation();
            toggleArtist(sp.getAttribute("data-at"));
          });
        });
      } catch (e) { /* 忽略 */ }
    }
    var hlTimer = 0;
    function scheduleHL() {
      if (hlTimer) clearTimeout(hlTimer);
      hlTimer = setTimeout(paintHL, 16);
    }
    ta.addEventListener("input", scheduleHL);
    ta.addEventListener("scroll", scheduleHL);
    try { if (window.ResizeObserver) new ResizeObserver(scheduleHL).observe(ta); } catch (e) { /* 忽略 */ }
    setTimeout(paintHL, 60);
    try { node.__pcStarPaint = node.__pcStarPaint || {}; node.__pcStarPaint[which] = scheduleHL; } catch (e) { /* 忽略 */ }
    // ★ 273r：给外面（renderSide / writeWidget / 顶部那颗 @ 按钮）留个口子。
    //   paint = 只重画着色层；apply = 连"该不该上色"一起重判。
    try {
      node.__pcHl = node.__pcHl || {};
      node.__pcHl[which] = { paint: scheduleHL, apply: applyAtMode };
    } catch (e) { /* 忽略 */ }


    // ★★ 2026-10-05 第一百零一批他定稿：「**只做撤销、重做两个按钮**，位置在**文本框右下角**，
    //   要做的很像、但不能一模一样，把箭头从弯的箭头变成直的箭头，要做出差异性」
    //   → 每颗文本框右下角一对：`⇐` 撤销 / `⇒` 重做（跟小助手的弯箭头 icon-undo/redo 明显不同）。
    var histBar = document.createElement("span");
    histBar.className = "pc-hist";
    var bUndo = document.createElement("button");
    bUndo.type = "button"; bUndo.textContent = "⇐"; bUndo.title = "撤销上一步（这个文本框自己的）";
    var bRedo = document.createElement("button");
    bRedo.type = "button"; bRedo.textContent = "⇒"; bRedo.title = "重做（把刚撤销的那一步再做回来）";
    [[bUndo, -1], [bRedo, 1]].forEach(function (pair) {
      var b = pair[0], dir = pair[1];
      ["pointerdown", "mousedown", "dblclick", "contextmenu"].forEach(function (ev2) {
        b.addEventListener(ev2, function (e2) { e2.stopPropagation(); });
      });
      b.addEventListener("click", function (e2) {
        e2.preventDefault(); e2.stopPropagation();
        applyHist(which, dir);
        pulseBtn(wrap, b, true);              // 跟别的小键一个手感：键自己沉浮一下
      });
    });
    histBar.appendChild(bUndo); histBar.appendChild(bRedo);
    wrap.appendChild(histBar);

    applyAtMode();
    // properties 是 configure 之后才到的（和 273b 那个坑一样）→ 晚一点再纠一次
    setTimeout(applyAtMode, 700);

    sec.appendChild(wrap);
    panel.appendChild(sec);

    // 输入框里的按键别让画布抢走（空格 / 删除会把节点搞掉）
    ["keydown", "keyup", "keypress", "wheel", "pointerdown", "mousedown", "dblclick", "contextmenu"].forEach(function (ev) {
      ta.addEventListener(ev, function (e2) { e2.stopPropagation(); });
    });
    ta.addEventListener("scroll", function () { syncScroll(which); layoutFrames(which); });

    // ★ 粘贴 = 一定套一个虚线框
    ta.addEventListener("paste", function (ev) {
      var cd = ev.clipboardData || window.clipboardData;
      var txt = cd ? cd.getData("text") : "";
      if (!txt) return;                                  // 让它走默认（比如粘图片）
      ev.preventDefault();
      // ⚠️⚠️ 2026-10-05 第九十八批他报「在虚线框之前另起一行 / 干什么都有可能打破虚线框」查实的根因之一：
      //   **剪贴板里常带 \r\n**（从网页、文档复制的都是），而 textarea 的 value 会把 \r\n 收敛成 \n →
      //   我按"原始长度"登记的偏移就全部多算了 1 位/行，框立刻和字错位、串行。→ 一律先归一化成 \n。
      txt = String(txt).replace(/\r\n?/g, "\n");
      var side = sideOf(node, which);
      var s = ta.selectionStart, e2 = ta.selectionEnd;
      var v = ta.value;
      var head = v.slice(0, s), tail = v.slice(e2);
      // 落在**某一段内部**粘贴 = 往那一段里补字：不补空行、那个框跟着变长（别把它弄丢）
      var inside = null;
      side.r.forEach(function (x) { if (x.s < s && e2 < x.e) inside = x; });
      var headPad = "", tailPad = "";
      if (!inside) {
        // ★ 虚线框和虚线框之间"天然隔一排"（他 2026-10-05 要的）：
        //   **前后都要保证空行** —— 第九十八批补上"后面"那半：原来只看插入点前面，
        //   所以在**某一段的开头**粘东西时，新框和旧框会贴在一起、重叠一行。
        var nlB = (head.match(/\n+$/) || [""])[0].length;
        var nlA = (tail.match(/^\n+/) || [""])[0].length;
        headPad = (head && nlB < 2) ? new Array(3 - nlB).join("\n") : "";
        tailPad = (tail && nlA < 2) ? new Array(3 - nlA).join("\n") : "";
      }
      var ins = headPad + txt + tailPad;
      var nv = head + ins + tail;
      var replacedLen = e2 - s;
      var shift = ins.length - replacedLen;
      side.r = side.r.map(function (x) {
        if (inside === x) { x.e += txt.length; return x; }             // 往这段里补字 → 框跟着长
        if (x.e <= s) return x;
        if (x.s >= e2) return { s: x.s + shift, e: x.e + shift, off: x.off, n: x.n };
        return null;
      }).filter(Boolean);
      if (!inside) side.r.push({ s: s + headPad.length, e: s + headPad.length + txt.length, off: false });
      (side.chips || []).forEach(function (c) {                    // 胶囊的落点也跟着挪
        if (c.at <= s) return;
        if (c.at >= e2) { c.at += shift; return; }
        c.at = s + ins.length;
      });
      side.v = nv;
      ta.value = nv;
      ta.selectionStart = ta.selectionEnd = s + ins.length;
      afterEdit(which);
    });

    ta.addEventListener("input", function () {
      var side = sideOf(node, which);
      applyDelta(side, side.v, ta.value);
      afterEdit(which);
    });
    // 拉高 / 拉宽文本框（右下角那个角，浏览器原生就能拉）。
    // ⚠️ 2026-10-05 他报「调整文本框高度时，节点本身竟然不会自适应」：原来把收尾挂在**文本框自己的**
    //   mouseup 上 —— 但原生 resize 是真的把指针拖到框外去的，抬手事件经常不落在文本框上，
    //   于是尺寸记不住、节点一直不动。→ 收尾改挂 document（见 makePanel 末尾），
    //   高度则交给下面的 ResizeObserver **实时**兜住。
    ta.addEventListener("pointerdown", function (e) {
      // ★ 209 批（他："优化节点在点击文本框的时候变窄一半了"）：
      //   以前**点一下文本框**（只想打字）也会进入"拖宽拖高"的收尾逻辑 —— 抬手时按内联 px 宽一算，
      //   差值是个大负数 → `node.setSize(宽 + dw)` 把节点宽度砍掉一半。
      //   现在只认**按在右下角那 22×22 的缩放角**上才算拖拽，其它位置点了不算。
      try {
        var tr = ta.getBoundingClientRect();
        var atCorner = (e.clientX > tr.right - 22) && (e.clientY > tr.bottom - 22);
        if (!atCorner) return;
      } catch (e2) { /* 忽略 */ }
      // ⚠️ 宽度的判据要记**内联 px 宽**（`style.width`），不能只看 offsetWidth：
      //   拖到比面板还宽时 offsetWidth 会被 max-width:100% 夹住 → 跟按下时一样 → 判成"没拖宽"，
      //   于是节点宽度不跟着变（他报的"拉不动"就是这个）。原生 resize 写的就是这个内联值。
      dragW0 = {
        posW: (secs.pos && secs.pos.ta) ? (secs.pos.ta.style.width || "") : "",
        negW: (secs.neg && secs.neg.ta) ? (secs.neg.ta.style.width || "") : "",
        posO: (secs.pos && secs.pos.ta) ? secs.pos.ta.offsetWidth : 0,
        negO: (secs.neg && secs.neg.ta) ? secs.neg.ta.offsetWidth : 0,
        posH: (secs.pos && secs.pos.ta) ? secs.pos.ta.offsetHeight : 0,
        negH: (secs.neg && secs.neg.ta) ? secs.neg.ta.offsetHeight : 0,
      };
    });

    secs[which] = { ta: ta, mIn: mIn, wrap: wrap, frames: frames, chips: chipRow, hist: { undo: bUndo, redo: bRedo } };
    // ★ 尺寸一变就量一次、喂给 fitNode() —— 拖高文本框时**节点本身当场跟着长高 / 变矮**。
    //   （RO 只在尺寸真的变了才回调；fitNode 里还有"高度没变就不 setSize"的闸，不会自我滚雪球。）
    try {
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(function () {
          var h2 = ta.offsetHeight;
          if (h2 > 40) { var s2 = sideOf(node, which); if (Math.abs(h2 - (s2.h || 0)) > 2) s2.h = h2; }
          layoutFrames(which);
          fitNode();
        });
        ro.observe(ta);
      }
    } catch (e) { /* 忽略 */ }
    try { sec.setAttribute("data-pcside", which); } catch (e) { /* 忽略 */ }   // ★ 241 批：安全复现要按侧写文本框
    return sec;
  }

  var posSec = buildSide("pos", "正提示词", "（粘贴进来的每一段会自动套一个虚线框）", "把正提示词粘在这里；一段一个虚线框");
  // ★ 2026-11-04（他第 2 条）：「把空 Latent 自填宽高像素里面的『⇄ 对调横竖』按钮和图形显示，
//   放在（面板右下角）那个位置，注意不要使其高度额外升高、不要新开一行。注意原理，本质上是借用
//   空 Latent 的按钮和图形搬在这里，并不是取代空 Latent 的效果」
//   → 做法：**绝对定位**贴在本面板右下角（不占布局、不加高度），照原点阵式画等比矩形 + 「横置 1152 × 896」；
//   点它调用的是空 Latent 自己的对调逻辑（`window.__pcLatentSwap`），两边始终是同一份值。
function pcLatentMini(node, container) {
  try {
    if (!container || container.__pcLatMini) return;
    container.__pcLatMini = true;
    var box = document.createElement("div");
    box.className = "pc-latmin";
    // ★ 他第四批第 8 条（原话）：「**横置和竖放然后像素数单独成第一排，然后图形放接下来的位置，
    //   图形本身占后面的三排**，三排占图形，这样图形显得比较大，比较容易直观可以看，
    //   而不是死活都要放在横置竖放的左边」→ **竖排**：第一排只写「横置 1152 × 896」+ ⇄，
    //   下面一大块（≈三排高）全给等比图形。
    // ★ 他第五批第 4 条：「一整个竖放模块全都占据了第一排的位置，导致左边的 UI 被破坏了，
    //   左边应该上下排列紧密才对，并且右边应该等比例再放大 1/3 倍」
    //   → ① 用**上下负外边距**把这块从行高里"抠掉"（行高仍只按左边那行算，左边自然紧凑）；
    //     ② 整个模块等比放大 1/3：宽 136→181、画布 124×54→165×72。
    // ★ 他第六批第 3 条：「横置的问题仍然存在，放置错位了，而且第一排照样比较厚，大概是两倍厚度，
    //   应该改成一倍厚度才对」→ 改成**绝对定位**挂在那一行右边：行高只由左边按钮决定（一倍厚），
    //   卡片自己向下溢出，盖的是"负提示词"那行右侧的空白（那里本来就空着）。
    // ★ 他第七批第 1 条：「背景也和其他背景不融合。应该改成类似的灰色，但是要淡一点的淡灰色背景，
    //   而不是深蓝色」→ 改成**半透明白灰**（黑夜=淡灰、白天=淡白灰，跟任何底色都融合），
    //   底部那点顶穿靠"再矮 8px + 整体上移 2px"解决。
    box.style.cssText = "position:absolute;right:0;top:-2px;display:flex;flex-direction:column;gap:5px;"
      + "width:181px;padding:4px 7px 6px;border-radius:11px;box-sizing:border-box;z-index:4;"
      + "background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);"
      + "backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);";
    var topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;gap:6px;justify-content:space-between;min-width:0";
    var cv = document.createElement("canvas");
    cv.width = 165; cv.height = 64;
    cv.style.cssText = "display:block;width:165px;height:64px;flex:0 0 auto";
    var btn = document.createElement("button");
    btn.type = "button"; btn.textContent = "⇄";
    btn.title = "对调横竖（和空 Latent 那颗按钮是同一条逻辑）";
    btn.style.cssText = "flex:0 0 auto;font-family:inherit;font-size:10px;line-height:1;padding:2px 6px;border-radius:6px;cursor:pointer;"
      + "border:1px solid rgba(140,190,255,.45);background:rgba(96,166,255,.14);color:#cfe4ff";
    var txt = document.createElement("div");
    txt.style.cssText = "flex:1 1 auto;min-width:0;font-size:9.5px;color:#dbe6ff;white-space:nowrap;"
      + "overflow:hidden;text-overflow:ellipsis;letter-spacing:.2px";
    topRow.appendChild(txt); topRow.appendChild(btn);
    box.appendChild(topRow);
    box.appendChild(cv);
    container.appendChild(box);
    var ctx = cv.getContext("2d");
    function paint() {
      var info = null;
      try { info = window.__pcLatentInfo ? window.__pcLatentInfo() : null; } catch (e1) { info = null; }
      if (!info) { box.style.display = "none"; return; }
      box.style.display = "flex";
      txt.textContent = info.kind + " " + info.w + " × " + info.h;
      // 图形：165×72（放大 1/3、≈三排高）里**按真实比例**画，横图贴上下边、竖图贴左右边。
      var W = 165, H = 64;
      var dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        cv.style.width = W + "px"; cv.style.height = H + "px";
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var k = Math.min((W - 6) / info.w, (H - 6) / info.h);
      var rw = Math.max(3, info.w * k), rh = Math.max(3, info.h * k);
      ctx.fillStyle = "rgba(120,170,255,.30)";
      ctx.strokeStyle = "rgba(150,200,255,.95)";
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.rect((W - rw) / 2, (H - rh) / 2, rw, rh); ctx.fill(); ctx.stroke();
    }
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      try { if (window.__pcLatentSwap) window.__pcLatentSwap(); } catch (e2) { /* 忽略 */ }
      paint();
    });
    ["pointerdown", "mousedown", "dblclick"].forEach(function (ev) {
      box.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    paint();
    var iv = setInterval(function () {
      if (!node.graph || !container.isConnected) { clearInterval(iv); return; }
      paint();
    }, 900);
  } catch (e) { /* 懒得影响主流程 */ }
}
  try {
    var posLab = posSec ? posSec.querySelector(".pc-clip-lab") : null;
    if (posLab) posLab.appendChild(optBar);
    else panel.appendChild(optBar);
  } catch (e) { try { panel.appendChild(optBar); } catch (e2) { /* 忽略 */ } }
  // ★ 197 批：**不再单独占一条**（他："不要额外占用位置"）。波浪改成优化时浮上去的一层，
  //   面板只留一个引用（`node.__pcPanel`），浮层由 pcWaveStart 现建现删，平时这里什么都没有。
  try { node.__pcPanel = panel; } catch (e) { /* 忽略 */ }
  // ★ 2026-11-04（他第 2 条，第二版）：「对调横竖居然放在最下面了，应该放在中间的 ——
  //   就正提示词文本框和负提示词文本框中间的右边位置，一整个空白全都用上」→ 挂到 midBar 上（见下面 midBar 之后）。
  // ★★ 208 批：小胶囊那一栏下面再加一行「伴随位」（灰字提示 + 小加号 + ！说明）
  //   规则：池子里有亮着的 LoRA 时小加号才可点；点开后选「一颗亮着的 LoRA」+「一个小胶囊」= 一颗伴随小胶囊；
  //   LoRA 一关掉 / 那个小胶囊没了 → 自动隐藏。
  try {
    var compRow = document.createElement("div");
    compRow.className = "pc-comp-row";   // 测试/样式钩子
    compRow.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:0";
    var compLab = document.createElement("span");
    compLab.textContent = "伴随位";
    compLab.style.cssText = "font-size:11px;opacity:.55;flex:0 0 auto";
    var compAdd = document.createElement("button");
    compAdd.type = "button"; compAdd.textContent = "＋";
    compAdd.style.cssText = "flex:0 0 auto;width:20px;height:20px;border-radius:6px;font-size:12px;line-height:1;"
      + "cursor:pointer;border:1px dashed rgba(150,162,180,.5);background:transparent;color:#cfd6e6;padding:0";
    var compHelp = document.createElement("span");
    compHelp.textContent = "!";
    compHelp.title = "伴随位 = 把一颗亮着的 LoRA 和一个小胶囊配成一对；LoRA 关掉时这一对自动隐藏。点已配好的小胶囊可取消。";
    compHelp.style.cssText = "flex:0 0 auto;width:14px;height:14px;border-radius:50%;font-size:9px;line-height:14px;"
      + "text-align:center;cursor:help;border:1px solid rgba(150,162,180,.55);color:#aab2c4";
    var compList = document.createElement("span");
    compList.style.cssText = "display:flex;align-items:center;gap:5px;flex-wrap:wrap;flex:1 1 auto;min-width:0";
    // ★ 222 批（他："伴随位那里再来一个小齿轮，可以调胶囊图标的显示……左箭头换成右箭头、
    //   连接标显示或不显示、以及直接干净利落地对胶囊进行编号"）→ 这颗 ⚙ 打开下面那个三选项小面板。
    var compGear = document.createElement("button");
    compGear.type = "button"; compGear.className = "pc-comp-gear"; compGear.textContent = "⚙";
    compGear.title = "伴随位 / 胶囊显示设置（箭头方向 · 编号）";
    compGear.style.cssText = "flex:0 0 auto;width:20px;height:20px;border-radius:6px;font-size:11px;line-height:1;"
      + "cursor:pointer;border:1px solid rgba(150,162,180,.5);background:transparent;color:#cfd6e6;padding:0";
    compRow.appendChild(compLab); compRow.appendChild(compAdd); compRow.appendChild(compHelp);
    compRow.appendChild(compGear); compRow.appendChild(compList);
    // ★ 209 批（他："伴随位放到小胶囊上面"）：插在小胶囊那一行**之前**（即紧跟正提示词那一行）
    var chipRowEl = posSec.querySelector(".pc-chips");
    if (chipRowEl && chipRowEl.parentNode === posSec) posSec.insertBefore(compRow, chipRowEl);
    else posSec.insertBefore(compRow, posSec.querySelector(".pc-ta-wrap"));
    node.__pcComp = { add: compAdd, list: compList, gear: compGear };
    // ★ 222 批：胶囊显示设置（存在 properties.pcClip.compOpt，跟工作流走）
    //   arrow: 小胶囊上那颗"挪到最前"的箭头朝哪边（left=◀ / right=▶）
    //   badge: 是否显示连接标 🔗    num: 是否在胶囊前面显示编号 1·2·3
    function compOpt() {
      var p = node.properties || (node.properties = {});
      var q = p.pcClip || (p.pcClip = {});
      var o = q.compOpt || (q.compOpt = {});
      if (o.arrow !== "right") o.arrow = "left";
      o.badge = o.badge !== false;
      o.num = !!o.num;
      o.copy = !!o.copy;          // ★ 287：小胶囊上带一颗 📋（不用展开就能复制里面的内容）
      // ★ 369 批（他："伴随位旁的小齿轮可以设置：去掉左右小箭头、去掉展开键、去掉小减号小加号；
      //   去掉减号加号之后，点小胶囊本体就等于点那个减号/加号"）
      o.noArrow = !!o.noArrow;    // 去掉左边那颗 ◀ / ▶（挪到最前）
      o.noBack = !!o.noBack;      // 去掉右边那颗 ↩（展开回文本框）
      o.noOff = !!o.noOff;        // 去掉 − / ＋，改成点胶囊本体切换
      return o;
    }
    // ★ 222 批：`compOpt` 在 try{} 块里（块级作用域），外面的 renderChips 看不到 → 挂到节点上给它用
    try { node.__pcCompOpt = compOpt; } catch (e) { /* 忽略 */ }
    // ★ 224 批：触发词（每颗 LoRA 一条）。只对**当前亮着的** LoRA 生效、也只允许改它们；
    //   编码时拼到正提示词末尾，但胶囊行里不出现 → 只显示"x 个触发词已隐形"。
    function trigMap() {
      var p = node.properties || (node.properties = {});
      var q = p.pcClip || (p.pcClip = {});
      if (!q.trig || typeof q.trig !== "object" || Array.isArray(q.trig)) q.trig = {};
      return q.trig;
    }
    function activeTriggers() {
      var lit = litLoras(), m = trigMap(), out = [];
      lit.forEach(function (nm) {
        var s = String(m[nm] || "").trim();
        if (s) out.push(s);
      });
      return out;
    }
    try { node.__pcTriggers = activeTriggers; } catch (e0) { /* 忽略 */ }
    // ★ 226 批：胶囊编号 = 固定位。pin = { "胶囊正文": 号 }（号从 1 开始）
    function pinMap() {
      var p = node.properties || (node.properties = {});
      var q = p.pcClip || (p.pcClip = {});
      if (!q.pin || typeof q.pin !== "object" || Array.isArray(q.pin)) q.pin = {};
      return q.pin;
    }
    try { node.__pcPinMap = pinMap; } catch (e0b) { /* 忽略 */ }
    // 按编号占位：编了号的固定在自己的号上，没编号的按原顺序填空位（水绕石头）
    function orderedChips(which) {
      var side = sideOf(node, which);
      var list = (side.chips || []).slice();
      var pins = {};
      try { pins = (node.__pcPinMap ? node.__pcPinMap() : {}) || {}; } catch (e) { pins = {}; }
      var n2 = list.length, slots = new Array(n2).fill(null), pinned = [], free = [];
      list.forEach(function (c) {
        var s2 = parseInt(pins[c.text], 10);
        if (s2 > 0) pinned.push({ c: c, s: s2 }); else free.push(c);
      });
      pinned.sort(function (a, b) { return a.s - b.s; });
      pinned.forEach(function (p2) {
        var idx = Math.min(n2 - 1, Math.max(0, p2.s - 1));
        while (idx < n2 && slots[idx]) idx++;
        if (idx >= n2) { for (var k = 0; k < n2; k++) if (!slots[k]) { idx = k; break; } }
        if (idx < n2) slots[idx] = p2.c;
      });
      // ★ 273z（他第 2 条："锁链链接的小胶囊之间能不能自动对齐顺序，不要上面 213 下面 321，
      //   上面和下面顺序一致，这样比较好操作"）
      //   负侧**没编号**的那几颗，按正侧的显示顺序重排；正侧没有同名的往后排（保持它们自己原来的相对顺序）。
      //   ⚠️ 只动"显示顺序"，不碰 at、也不碰文字 —— 送进生图的词一个都不变。
      if (which === "neg") {
        try {
          var rank = {}, po = orderedChips("pos") || [];
          for (var pi = 0; pi < po.length; pi++) {
            var pn = String(po[pi].name == null ? "" : po[pi].name).trim();
            if (pn && rank[pn] == null) rank[pn] = pi;
          }
          if (Object.keys(rank).length) {
            free.sort(function (a, b) {
              var ra = rank[String(a.name == null ? "" : a.name).trim()];
              var rb = rank[String(b.name == null ? "" : b.name).trim()];
              if (ra == null && rb == null) return 0;
              if (ra == null) return 1;
              if (rb == null) return -1;
              return ra - rb;
            });
          }
        } catch (eZ) { /* 忽略 */ }
      }
      var fi = 0;
      for (var i = 0; i < n2; i++) if (!slots[i]) slots[i] = free[fi++];
      return slots.filter(Boolean);
    }
    // ⚠️ 这段在 try{} 块里（块级作用域），外面的 renderChips 看不到 → 挂到节点上
    try { node.__pcOrderedChips = orderedChips; } catch (eOC) { /* 忽略 */ }
    // 两处都存（他 224 批第 1 条）：同时写一份进 LoRA 池状态，随机组合用的就是池子那份
    function syncTrigToPool(m) {
      try {
        var pools = ((app.graph && app.graph._nodes) || []).filter(function (n) { return n && n.type === "PromptToolLoraPool"; });
        if (!pools.length) return;
        var w = (pools[0].widgets || []).filter(function (x) { return x && x.name === "状态"; })[0];
        if (!w) return;
        var st = {};
        try { st = JSON.parse(String(w.value || "{}")) || {}; } catch (e) { st = {}; }
        st.trig = Object.assign({}, m);
        w.value = JSON.stringify(st);
        try { if (typeof w.callback === "function") w.callback(w.value); } catch (e2) { /* 忽略 */ }
      } catch (e3) { /* 忽略 */ }
    }
    function setCompOpt(k, v) {
      var o = compOpt(); o[k] = v;
      try { node.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
      try { node.__pcRender(); } catch (e2) { /* 忽略 */ }
    }
    var compPop = null;
    compRow.style.position = "relative";
    compGear.addEventListener("click", function (e) {
      e.stopPropagation();
      if (compPop) { closeCompPop(); return; }        // 再点一次 ⚙ = 关掉（225 批修掉"关不掉"）
      var o = compOpt();
      compPop = document.createElement("div");
      compPop.className = "pc-comp-pop";
      compPop.style.cssText = "position:absolute;z-index:40;background:rgba(24,28,38,.97);color:#dfe5f1;"
        + "border:1px solid rgba(150,162,180,.5);border-radius:8px;padding:9px 11px;font-size:11.5px;"
        + "display:flex;flex-direction:column;gap:7px;box-shadow:0 8px 22px rgba(0,0,0,.45);min-width:170px";
      function seg(labelText, key, opts) {
        var wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;align-items:center;gap:6px";
        var lb = document.createElement("span");
        lb.textContent = labelText; lb.style.cssText = "opacity:.7;flex:0 0 auto";
        wrap.appendChild(lb);
        opts.forEach(function (op) {
          var b = document.createElement("button");
          b.type = "button"; b.textContent = op.t;
          b.dataset.opt = key + ":" + op.v;
          var on = o[key] === op.v;
          b.style.cssText = "padding:2px 8px;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;"
            + (on ? "border:1px solid #7c5cff;background:rgba(124,92,255,.3);color:#efe9ff;font-weight:700"
              : "border:1px solid rgba(150,162,180,.45);background:transparent;color:#cfd6e6");
          b.addEventListener("click", function (ev2) { ev2.stopPropagation(); setCompOpt(key, op.v); });
          wrap.appendChild(b);
        });
        return wrap;
      }
      function chk(labelText, key) {
        var lab = document.createElement("label");
        lab.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
        var i = document.createElement("input");
        i.type = "checkbox"; i.checked = !!o[key]; i.dataset.chk = key;
        i.addEventListener("change", function (ev3) { ev3.stopPropagation(); setCompOpt(key, i.checked); });
        lab.appendChild(i); lab.appendChild(document.createTextNode(labelText));
        return lab;
      }
      var head = document.createElement("div");
      head.textContent = "胶囊显示";
      head.style.cssText = "font-weight:700;opacity:.85;display:flex;align-items:center;justify-content:space-between;gap:8px";
      var headX = document.createElement("button");
      headX.type = "button"; headX.textContent = "✕"; headX.className = "pc-comp-pop-x";
      headX.title = "关掉这个面板（也可以点空白处 / 按 Esc）";
      headX.style.cssText = "border:none;background:transparent;color:#cfd6e6;cursor:pointer;font-size:11px;"
        + "line-height:1;padding:0 2px;opacity:.65";
      headX.addEventListener("click", function (evX) { evX.stopPropagation(); closeCompPop(); });
      head.appendChild(headX);
      compPop.appendChild(head);
      compPop.appendChild(seg("左箭头", "arrow", [{ t: "◀", v: "left" }, { t: "▶", v: "right" }]));
      // ★ 287 批（他："伴随位旁边不是有个设置吗？设置里面可以让小胶囊附带一个复制标，
      //   这样子不用小胶囊展开就可以复制里面的内容了"）
      compPop.appendChild(chk("小胶囊带复制键 📋（不用展开就能复制里面的内容）", "copy"));
      // ★ 369 批：这三颗是"把胶囊上的键去掉"，让胶囊尽量干净
      compPop.appendChild(chk("去掉左边那颗箭头（◀ / ▶ 挪到最前）", "noArrow"));
      compPop.appendChild(chk("去掉右边那颗展开键 ↩（展开回文本框）", "noBack"));
      compPop.appendChild(chk("去掉小减号 − / 小加号 ＋（改成点胶囊本体来切换）", "noOff"));
      // ★ 273t：他要求去掉「显示连接标」这颗开关
      // ---------------- ★ 226 批：编号 = 固定位（在弹窗里给现有胶囊编号）----------------
      //   他："给胶囊编号的功能也改成在弹窗内给现有胶囊编号，编入了号之后的胶囊会完全固定在对应的位置，
      //       同时也失去左右移动标……石头就是固定的胶囊，水就是其他胶囊"
      var pinBox = document.createElement("div");
      pinBox.className = "pc-pin-box";
      pinBox.style.cssText = "border-top:1px solid rgba(150,162,180,.28);margin-top:3px;padding-top:7px;"
        + "display:flex;flex-direction:column;gap:5px;min-width:250px";
      var pinHead = document.createElement("div");
      pinHead.textContent = "固定位（填号 = 钉在这一位，0 = 不固定）";
      pinHead.style.cssText = "font-weight:700;opacity:.85;font-size:11px;line-height:1.4";
      pinBox.appendChild(pinHead);
      var posChips = [];
      try { posChips = (sideOf(node, "pos").chips || []).slice(); } catch (ePC) { posChips = []; }
      var pinNow = pinMap();
      var pinInputs = [];
      if (!posChips.length) {
        var pinNone = document.createElement("div");
        pinNone.textContent = "正提示词这边还没有小胶囊（先把某一段收成胶囊）。";
        pinNone.style.cssText = "font-size:10.5px;opacity:.6";
        pinBox.appendChild(pinNone);
      }
      posChips.forEach(function (c2) {
        var rowP = document.createElement("div");
        rowP.style.cssText = "display:flex;align-items:center;gap:6px";
        var lb2 = document.createElement("span");
        lb2.textContent = String(c2.name || c2.text.slice(0, 10)).slice(0, 12);
        lb2.title = c2.text;
        lb2.style.cssText = "flex:1 1 auto;min-width:0;opacity:.78;overflow:hidden;text-overflow:ellipsis;"
          + "white-space:nowrap;font-size:10.5px";
        var num2 = document.createElement("input");
        num2.type = "number"; num2.min = "0"; num2.step = "1";
        num2.value = String(parseInt(pinNow[c2.text], 10) || 0);
        num2.dataset.lppin = c2.text;
        num2.style.cssText = "flex:0 0 52px;height:22px;border-radius:6px;border:1px solid rgba(150,162,180,.5);"
          + "background:rgba(0,0,0,.28);color:#e8eaf1;padding:0 5px;font:inherit;font-size:11px;text-align:center";
        pinInputs.push(num2);
        rowP.appendChild(lb2); rowP.appendChild(num2);
        pinBox.appendChild(rowP);
      });
      if (posChips.length) {
        var pinApply = document.createElement("button");
        pinApply.type = "button";
        pinApply.textContent = "实行编号（固定到这些位置）";
        pinApply.dataset.lppinapply = "1";
        pinApply.style.cssText = "height:24px;margin-top:2px;border-radius:6px;cursor:pointer;font-family:inherit;"
          + "font-size:11.5px;border:1px solid rgba(124,92,255,.85);background:rgba(124,92,255,.24);color:#efe9ff";
        pinApply.addEventListener("click", function (evP) {
          evP.stopPropagation();
          var pm = pinMap();
          pinInputs.forEach(function (i2) {
            var k2 = i2.dataset.lppin, v2 = parseInt(i2.value, 10) || 0;
            if (v2 > 0) pm[k2] = v2; else delete pm[k2];
          });
          try { node.setDirtyCanvas(true, true); } catch (e1) { /* 忽略 */ }
          try { if (typeof node.__pcRender === "function") node.__pcRender(); } catch (e2b) { /* 忽略 */ }
          try { if (typeof node.__pcCompPaint === "function") node.__pcCompPaint(); } catch (e3b) { /* 忽略 */ }
          try { clipToast("编号已实行：编了号的胶囊固定住，不再显示移动箭头"); } catch (e4b) { /* 忽略 */ }
        });
        pinBox.appendChild(pinApply);
      }
      compPop.appendChild(pinBox);
      // ---------------- ★ 224 批：触发词（只列正在用的 LoRA）----------------
      var trigBox = document.createElement("div");
      trigBox.className = "pc-trig-box";
      trigBox.style.cssText = "border-top:1px solid rgba(150,162,180,.28);margin-top:3px;padding-top:7px;"
        + "display:flex;flex-direction:column;gap:5px;min-width:250px";
      var trigHead = document.createElement("div");
      trigHead.textContent = "触发词（只列正在用的 LoRA · 实行后隐形）";
      trigHead.style.cssText = "font-weight:700;opacity:.85;font-size:11px;line-height:1.4";
      trigBox.appendChild(trigHead);
      var litNow = litLoras();
      var tgNow = trigMap();
      var trigInputs = [];
      if (!litNow.length) {
        var none = document.createElement("div");
        none.textContent = "池子里还没有亮着的 LoRA —— 先点亮一颗，才能给它填触发词。";
        none.style.cssText = "font-size:10.5px;opacity:.6";
        trigBox.appendChild(none);
      }
      litNow.forEach(function (nm) {
        var rowT = document.createElement("div");
        rowT.style.cssText = "display:flex;align-items:center;gap:6px";
        var lb = document.createElement("span");
        lb.textContent = String(nm).replace(/\.safetensors$/i, "").slice(0, 12);
        lb.title = nm;
        lb.style.cssText = "flex:0 0 88px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px";
        var inp2 = document.createElement("input");
        inp2.type = "text";
        inp2.value = String(tgNow[nm] || "");
        inp2.placeholder = "触发词，逗号分隔";
        inp2.dataset.lptrig = nm;
        inp2.style.cssText = "flex:1 1 auto;min-width:130px;height:22px;border-radius:6px;"
          + "border:1px solid rgba(150,162,180,.5);background:rgba(0,0,0,.28);color:#e8eaf1;"
          + "padding:0 6px;font:inherit;font-size:11px";
        trigInputs.push(inp2);
        rowT.appendChild(lb); rowT.appendChild(inp2);
        trigBox.appendChild(rowT);
      });
      if (litNow.length) {
        var applyBtn = document.createElement("button");
        applyBtn.type = "button";
        applyBtn.textContent = "实行（变成隐形胶囊）";
        applyBtn.dataset.lptrigapply = "1";
        applyBtn.style.cssText = "height:24px;margin-top:2px;border-radius:6px;cursor:pointer;font-family:inherit;"
          + "font-size:11.5px;border:1px solid rgba(56,189,248,.8);background:rgba(56,189,248,.2);color:#dff3ff";
        applyBtn.addEventListener("click", function (ev2) {
          ev2.stopPropagation();
          var m2 = trigMap();
          trigInputs.forEach(function (i) {
            var k = i.dataset.lptrig, v = String(i.value || "").trim();
            if (v) m2[k] = v; else delete m2[k];
          });
          try { syncTrigToPool(m2); } catch (e) { /* 忽略 */ }
          try { node.setDirtyCanvas(true, true); } catch (e2) { /* 忽略 */ }
          try { syncBackend(node); } catch (e3) { /* 忽略 */ }
          try { if (typeof node.__pcCompPaint === "function") node.__pcCompPaint(); } catch (e4) { /* 忽略 */ }
          try { if (typeof node.__pcRender === "function") node.__pcRender(); } catch (e5) { /* 忽略 */ }
          var n2 = activeTriggers().length;
          try { clipToast("触发词已实行：" + (n2 ? n2 + " 个已隐形（参与生图）" : "已清空")); } catch (e6) { /* 忽略 */ }
        });
        trigBox.appendChild(applyBtn);
      }
      compPop.appendChild(trigBox);
      compRow.appendChild(compPop);
      compPop.style.left = Math.max(0, compGear.offsetLeft - 40) + "px";
      compPop.style.top = (compGear.offsetTop + 24) + "px";
    });
    // ★ 225 批（他："点击之后反而变成了点下会隐藏，不点击就会一直存在，完全无法关掉这个弹窗"）
    //   真因：下面这个"点外面关掉"的 pointerdown 比 ⚙ 自己的 click 先跑 —— 它把 compPop 关掉置空，
    //   紧接着 ⚙ 的 click 看到 compPop 已经是 null，又**重新打开**了一次 → 看起来永远关不掉。
    //   修法：点 **⚙ 自己**不算"点外面"；再补 Esc 关闭 + 右上角一颗 ✕。
    function closeCompPop() {
      if (compPop) { try { compPop.remove(); } catch (e) { /* 忽略 */ } compPop = null; }
    }
    try {
      document.addEventListener("pointerdown", function (ev4) {
        if (!compPop) return;
        if (compPop.contains(ev4.target) || compGear.contains(ev4.target)) return;
        closeCompPop();
      }, true);
      document.addEventListener("keydown", function (ev5) {
        if (compPop && ev5.key === "Escape") closeCompPop();
      });
    } catch (e0) { /* 忽略 */ }
    function compArr() {
      var p = node.properties || (node.properties = {});
      var q = p.pcClip || (p.pcClip = {});
      if (!Array.isArray(q.comp)) q.comp = [];
      return q.comp;
    }
    function litLoras() {
      try {
        var pools = (app.graph._nodes || []).filter(function (n) { return n && n.type === "PromptToolLoraPool"; });
        if (!pools.length) return [];
        var w = (pools[0].widgets || []).filter(function (x) { return x && x.name === "状态"; })[0];
        var st = w ? JSON.parse(String(w.value || "{}")) : {};
        return (st.loras || []).filter(function (r) { return r && r.on; }).map(function (r) { return String(r.name); });
      } catch (e) { return []; }
    }
    function chipTexts() {
      try { return (sideOf(node, "pos").chips || []).map(function (c) { return String(c.text || ""); }); } catch (e) { return []; }
    }
    // ★ 213 批（他："选择小胶囊的时候才发现里面原来是展示内容的，为什么要展示内容啊，
    //   小胶囊选择的时候展示的应该是小胶囊的名字啊"）→ 挑胶囊的地方（下拉、伴随位那颗）一律显示**名字**；
    //   没有名字才退回"胶囊 N"（绝不拿正文当标签）。`text` 仍是内部认胶囊用的键，对得上才对。
    function chipList() {
      try {
        var chips = (sideOf(node, "pos").chips || []).slice().sort(function (a, b) { return a.at - b.at; });
        return chips.map(function (c, i) {
          var nm = String(c.name == null ? "" : c.name).trim();
          return { text: String(c.text || ""), name: nm || ("胶囊 " + (i + 1)) };
        });
      } catch (e) { return []; }
    }
    function chipNameOf(text) {
      var hit = chipList().filter(function (c) { return c.text === String(text); })[0];
      return hit ? hit.name : "";
    }
    function paintComp() {
      if (!node.__pcComp) return;
      var lit = litLoras();
      compAdd.disabled = !lit.length;
      compAdd.style.opacity = lit.length ? "1" : ".35";
      compAdd.style.cursor = lit.length ? "pointer" : "not-allowed";
      compAdd.title = lit.length ? "选一颗亮着的 LoRA + 一个小胶囊" : "LoRA 池里还没点亮 LoRA";
      var chips = chipTexts(), arr = compArr();
      compList.innerHTML = "";
      var shown = 0;
      arr.forEach(function (c) {
        if (lit.indexOf(String(c.lora)) < 0) return;
        if (chips.indexOf(String(c.chip)) < 0) return;
        shown++;
        var b = document.createElement("span");
        // ★ 213 批：这里显示**胶囊名**（以前显示的是胶囊里的正文，他嫌"为什么展示内容"）
        var nmShow = chipNameOf(c.chip) || ("胶囊（正文已改：" + String(c.chip).slice(0, 10) + "…）");
        b.className = "pc-comp-chip";        // ★ 216 批：CSS 里给它粉色呼吸光环（和下面那颗胶囊同节奏）
        b.textContent = nmShow.slice(0, 18);
        b.title = "伴随小胶囊：" + nmShow + "（正文：" + String(c.chip).slice(0, 40) + "；绑定 " + c.lora + "；点一下取消）";
        b.style.cssText = "display:inline-flex;align-items:center;max-width:220px;padding:2px 7px;border-radius:999px;"
          + "border:1px solid rgba(56,189,248,.9);background:rgba(56,189,248,.20);color:#d6ecff;font-weight:700;"
          + "font-size:11px;line-height:1.5;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var i = arr.indexOf(c); if (i >= 0) arr.splice(i, 1);
          paintComp(); redraw();
        });
        compList.appendChild(b);
      });
      if (!shown) {
        var h = document.createElement("span");
        h.textContent = lit.length ? "（还没配）" : "（点亮 LoRA 后才能配）";
        h.style.cssText = "font-size:10.5px;opacity:.4";
        compList.appendChild(h);
      }
      // ★ 224 批（他："这个小胶囊能不能隐形呢，换成小字'x个触发词已隐形'" +
      //   "不应该新启一行，而是和其他内容排在一起"）→ 就排在这一行末尾，点它开 ⚙ 面板
      var nTrig = activeTriggers().length;
      if (nTrig) {
        var tipT = document.createElement("span");
        tipT.className = "pc-trig-tip";
        tipT.textContent = nTrig + " 个触发词已隐形";
        tipT.title = "这些触发词正在参与生图，但不在胶囊行里显示。点一下打开齿轮面板编辑。";
        tipT.style.cssText = "flex:0 0 auto;font-size:10.5px;opacity:.55;cursor:pointer;white-space:nowrap";
        tipT.addEventListener("click", function (e2) {
          e2.stopPropagation();
          try { compGear.click(); } catch (e3) { /* 忽略 */ }
        });
        compList.appendChild(tipT);
      }
    }
    function compPick() {
      var lit = litLoras(), chips = chipTexts();
      if (!lit.length || !chips.length) {
        clipToast(lit.length ? "这颗节点还没有小胶囊 —— 先把某一段收成胶囊" : "LoRA 池里还没点亮 LoRA", true);
        return;
      }
      var layer = document.createElement("div");
      layer.style.cssText = "position:fixed;inset:0;z-index:99998;background:rgba(8,10,16,.45);"
        + "display:flex;align-items:center;justify-content:center";
      var box = document.createElement("div");
      box.style.cssText = "width:min(420px,92vw);background:#1d2230;color:#e8eaf1;border:1px solid rgba(150,162,180,.45);"
        + "border-radius:12px;padding:14px 16px;box-shadow:0 16px 48px rgba(0,0,0,.5);"
        + "font:12px/1.6 system-ui,'Microsoft YaHei',sans-serif";
      var hd = document.createElement("div");
      hd.textContent = "配一颗伴随小胶囊";
      hd.style.cssText = "font-size:13px;font-weight:700;margin-bottom:10px";
      function mkSel(label, opts) {
        var w = document.createElement("div");
        w.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px";
        var l = document.createElement("span");
        l.textContent = label;
        l.style.cssText = "flex:0 0 42px;font-size:11.5px;opacity:.75";
        var s = document.createElement("select");
        s.style.cssText = "flex:1 1 auto;height:26px;border-radius:8px;border:1px solid rgba(150,162,180,.5);"
          + "background:rgba(0,0,0,.25);color:#e8eaf1;font:inherit";
        opts.forEach(function (o) {
          var op = document.createElement("option");
          op.value = o.v; op.textContent = o.t;
          s.appendChild(op);
        });
        w.appendChild(l); w.appendChild(s);
        return { wrap: w, sel: s };
      }
      var s1 = mkSel("LoRA", lit.map(function (n) { return { v: n, t: String(n).replace(/\.safetensors$/i, "") }; }));
      // ★ 213 批：下拉里显示**胶囊名**（value 仍用正文，内部靠它认胶囊）
      var s2 = mkSel("小胶囊", chipList().map(function (c) { return { v: c.text, t: c.name }; }));
      var row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px";
      var cancel = document.createElement("button");
      cancel.type = "button"; cancel.textContent = "取消";
      cancel.style.cssText = "height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
        + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.07);color:#e8eaf1";
      var ok = document.createElement("button");
      ok.type = "button"; ok.textContent = "配好";
      ok.style.cssText = "height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
        + "border:1px solid rgba(56,189,248,.8);background:rgba(56,189,248,.24);color:#d6ecff";
      row.appendChild(cancel); row.appendChild(ok);
      box.appendChild(hd); box.appendChild(s1.wrap); box.appendChild(s2.wrap); box.appendChild(row);
      layer.appendChild(box); document.body.appendChild(layer);
      function closeIt() { try { layer.remove(); } catch (e) { /* 忽略 */ } }
      cancel.addEventListener("click", closeIt);
      layer.addEventListener("click", function (e) { if (e.target === layer) closeIt(); });
      ok.addEventListener("click", function () {
        var arr = compArr();
        var lora = s1.sel.value, chip = s2.sel.value;
        if (!arr.some(function (c) { return c.lora === lora && c.chip === chip; })) arr.push({ lora: lora, chip: chip });
        paintComp(); redraw(); closeIt();
      });
    }
    compAdd.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    compAdd.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); compPick(); });
    node.__pcCompPaint = paintComp;
    paintComp();
  } catch (e) { /* 忽略 */ }

  // ★ 202 批：面板一建好就把"工具端 / 空闲"那一行挂上去（以前要等 3 秒的定时器才出现）
  try { pcStatMake(node); pcStatPaint(node); } catch (e) { /* 忽略 */ }

  // ★★ 2026-10-06 第一百零六批他要的：「权重从一个『调整关键词权重』改成『调整正关键词权重』
  //   『调整负关键词权重』，而且**一个放在中间一个放在下边**，这样就可以**单独调整**拉出正关键词和
  //   负关键词的权重了」→ 正的那颗**夹在两个文本框中间**，负的那颗在底下那排键里（见下面的 foot）。
  var midBar = document.createElement("div");
  midBar.className = "pc-clip-mid";
  // ★ 他第六批第 3 条（"第一排照样比较厚，大概是两倍厚度，应该改成一倍厚度"）：
  //   让这块**不参与行高** —— 绝对定位挂在这一行右边，行高完全由左边那颗按钮决定（= 一倍厚），
  //   图形向下溢出到"负提示词"那一行的右侧空白里。
  midBar.style.cssText = "position:relative;padding-right:196px;min-height:24px;";
  var btnPosW = document.createElement("button");
  btnPosW.type = "button";
  btnPosW.className = "pc-weight-btn pos";
  btnPosW.textContent = "⚖ 调整正关键词权重";
  btnPosW.title = "给**正**提示词里的关键词单独设权重（拖附属节点上那颗小圆钮，最小刻度 0.05；也能直接输数值）；"
    + "只改送去编码的那份正提示词，框里的字一个都不会动";
  btnPosW.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    try {
      if (typeof window.__pcOpenWeights === "function") window.__pcOpenWeights(node, "pos");
      else log("权重面板还没加载好（prompt_weight.js）");
    } catch (e2) { log("打开正权重面板失败", e2); }
  });
  var midTip = document.createElement("span");
  midTip.className = "pc-clip-mid-tip";
  midTip.textContent = "（正 / 负各一张权重表，互不串门）";
  midBar.appendChild(btnPosW); midBar.appendChild(midTip);
  // ★ 他第 2 条（第二版）：正/负两个文本框**中间那一行的右边** —— 那块空白就用它填，不再吊在面板右下角。
  try { pcLatentMini(node, midBar); } catch (eMini) { /* 忽略 */ }
  panel.appendChild(midBar);

  var negSec = buildSide("neg", "负提示词", "（在下面；同样，粘贴进来的才套框）", "把负提示词粘在这里");

  // ==================== ★ 237 批：负提示词栏也来一个伴随位 ====================
  //   他原话：「优化节点中负提示词栏也加一个伴随位」
  //   语义和正提示词那边**完全一样**（配一颗亮着的 LoRA + 一个负胶囊；那颗 LoRA 熄灭 → 这段暂不参与编码），
  //   只是数据里多一个 `side:"neg"`，两边互不串。⚙（胶囊显示设置）和触发词提示只留在正提示词那边。
  try {
    if (negSec) {
      var nRow = document.createElement("div");
      nRow.className = "pc-comp-row pc-comp-row-neg";
      nRow.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:0";
      var nLab = document.createElement("span");
      nLab.textContent = "伴随位";
      nLab.style.cssText = "font-size:11px;opacity:.55;flex:0 0 auto";
      var nAdd = document.createElement("button");
      nAdd.type = "button"; nAdd.textContent = "＋";
      nAdd.style.cssText = "flex:0 0 auto;width:20px;height:20px;border-radius:6px;font-size:12px;line-height:1;"
        + "cursor:pointer;border:1px dashed rgba(150,162,180,.5);background:transparent;color:#cfd6e6;padding:0";
      var nHelp = document.createElement("span");
      nHelp.textContent = "!";
      nHelp.title = "负提示词的伴随位：把一颗亮着的 LoRA 和一个小胶囊配成一对；那颗 LoRA 关掉时这一段暂时不参与生图（文字都留着）。";
      nHelp.style.cssText = "flex:0 0 auto;width:14px;height:14px;border-radius:50%;font-size:9px;line-height:14px;"
        + "text-align:center;cursor:help;border:1px solid rgba(150,162,180,.55);color:#aab2c4";
      var nList = document.createElement("span");
      nList.style.cssText = "display:flex;align-items:center;gap:5px;flex-wrap:wrap;flex:1 1 auto;min-width:0";
      nRow.appendChild(nLab); nRow.appendChild(nAdd); nRow.appendChild(nHelp); nRow.appendChild(nList);
      var nChipRow = negSec.querySelector(".pc-chips");
      if (nChipRow && nChipRow.parentNode === negSec) negSec.insertBefore(nRow, nChipRow);
      else if (negSec.querySelector(".pc-ta-wrap")) negSec.insertBefore(nRow, negSec.querySelector(".pc-ta-wrap"));
      else negSec.appendChild(nRow);
      node.__pcCompNeg = { add: nAdd, list: nList };

      function nCompArr() {
        var p = node.properties || (node.properties = {});
        var q = p.pcClip || (p.pcClip = {});
        if (!Array.isArray(q.comp)) q.comp = [];
        return q.comp;
      }
      function nChips() {
        try {
          return (sideOf(node, "neg").chips || []).slice().sort(function (a, b) { return a.at - b.at; })
            .map(function (c, i) {
              var nm = String(c.name == null ? "" : c.name).trim();
              return { text: String(c.text || ""), name: nm || ("胶囊 " + (i + 1)) };
            });
        } catch (e) { return []; }
      }
      function nPaint() {
        if (!node.__pcCompNeg) return;
        var lit = litLoraNames() || [];
        var chips = nChips();
        var texts = chips.map(function (c) { return c.text; });
        nAdd.disabled = !lit.length;
        nAdd.style.opacity = lit.length ? "1" : ".35";
        nAdd.style.cursor = lit.length ? "pointer" : "not-allowed";
        nAdd.title = lit.length ? "选一颗亮着的 LoRA + 一个负提示词胶囊" : "LoRA 池里还没点亮 LoRA";
        nList.innerHTML = "";
        var arr = nCompArr(), shown = 0;
        arr.forEach(function (c) {
          if ((c.side || "pos") !== "neg") return;          // 只要"负侧"的配对
          if (lit.indexOf(String(c.lora)) < 0) return;
          if (texts.indexOf(String(c.chip)) < 0) return;
          shown++;
          var hit = chips.filter(function (x) { return x.text === String(c.chip); })[0];
          var nm = hit ? hit.name : ("胶囊（正文已改：" + String(c.chip).slice(0, 10) + "…）");
          var b = document.createElement("span");
          b.className = "pc-comp-chip pc-comp-chip-neg";
          b.textContent = "🔗 " + nm.slice(0, 18);
          b.title = "伴随小胶囊（负提示词）：" + nm + "（绑定 " + c.lora + "；点一下取消）";
          b.style.cssText = "display:inline-flex;align-items:center;max-width:220px;padding:2px 7px;border-radius:999px;"
            + "border:1px solid rgba(255,150,120,.9);background:rgba(255,120,90,.18);color:#ffdfd6;font-weight:700;"
            + "font-size:11px;line-height:1.5;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          b.addEventListener("click", function (e) {
            e.stopPropagation();
            var i = arr.indexOf(c); if (i >= 0) arr.splice(i, 1);
            nPaint(); redraw();
          });
          nList.appendChild(b);
        });
        if (!shown) {
          var h = document.createElement("span");
          h.textContent = lit.length ? "（还没配）" : "（点亮 LoRA 后才能配）";
          h.style.cssText = "font-size:10.5px;opacity:.4";
          nList.appendChild(h);
        }
      }
      function nPick() {
        var lit = litLoraNames() || [];
        var chips = nChips();
        if (!lit.length || !chips.length) {
          clipToast(lit.length ? "负提示词这边还没有小胶囊 —— 先把某一段收成胶囊" : "LoRA 池里还没点亮 LoRA", true);
          return;
        }
        var layer = document.createElement("div");
        layer.style.cssText = "position:fixed;inset:0;z-index:99998;background:rgba(8,10,16,.45);"
          + "display:flex;align-items:center;justify-content:center";
        var box = document.createElement("div");
        box.style.cssText = "width:min(420px,92vw);background:#1d2230;color:#e8eaf1;border:1px solid rgba(150,162,180,.45);"
          + "border-radius:12px;padding:14px 16px;box-shadow:0 16px 48px rgba(0,0,0,.5);"
          + "font:12px/1.6 system-ui,'Microsoft YaHei',sans-serif";
        var hd = document.createElement("div");
        hd.textContent = "配一颗伴随小胶囊（负提示词）";
        hd.style.cssText = "font-size:13px;font-weight:700;margin-bottom:10px";
        function mkSel(label, opts) {
          var w = document.createElement("div");
          w.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px";
          var l = document.createElement("span");
          l.textContent = label;
          l.style.cssText = "flex:0 0 42px;font-size:11.5px;opacity:.75";
          var s = document.createElement("select");
          s.style.cssText = "flex:1 1 auto;height:26px;border-radius:8px;border:1px solid rgba(150,162,180,.5);"
            + "background:rgba(0,0,0,.25);color:#e8eaf1;font:inherit";
          opts.forEach(function (o) {
            var op = document.createElement("option");
            op.value = o.v; op.textContent = o.t;
            s.appendChild(op);
          });
          w.appendChild(l); w.appendChild(s);
          return { wrap: w, sel: s };
        }
        var s1 = mkSel("LoRA", lit.map(function (n) { return { v: n, t: String(n).replace(/\.safetensors$/i, "") }; }));
        var s2 = mkSel("小胶囊", chips.map(function (c) { return { v: c.text, t: c.name }; }));
        var row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px";
        var cancel = document.createElement("button");
        cancel.type = "button"; cancel.textContent = "取消";
        cancel.style.cssText = "height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
          + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.07);color:#e8eaf1";
        var ok = document.createElement("button");
        ok.type = "button"; ok.textContent = "配好";
        ok.style.cssText = "height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
          + "border:1px solid rgba(255,150,120,.8);background:rgba(255,120,90,.22);color:#ffdfd6";
        row.appendChild(cancel); row.appendChild(ok);
        box.appendChild(hd); box.appendChild(s1.wrap); box.appendChild(s2.wrap); box.appendChild(row);
        layer.appendChild(box); document.body.appendChild(layer);
        function closeIt() { try { layer.remove(); } catch (e) { /* 忽略 */ } }
        cancel.addEventListener("click", closeIt);
        layer.addEventListener("click", function (e) { if (e.target === layer) closeIt(); });
        ok.addEventListener("click", function () {
          var arr = nCompArr();
          var lora = s1.sel.value, chip = s2.sel.value;
          if (!arr.some(function (c) { return (c.side || "pos") === "neg" && c.lora === lora && c.chip === chip; })) {
            arr.push({ lora: lora, chip: chip, side: "neg" });
          }
          nPaint(); redraw(); closeIt();
        });
      }
      nAdd.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
      nAdd.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); nPick(); });
      node.__pcCompNegPaint = nPaint;
      nPaint();
    }
  } catch (e) { /* 忽略 */ }

  // ★★ 2026-10-05 他的第 1 条（第二次报，拓宽了要求）：
  //   「调一个文本框宽度，就等于调两个文本框宽度，**同时调整整个节点的宽度，所以其实是调整 3 个的宽度**」；
  //   「调整一个文本框的高度，会同时调整节点高度，但**不会调整另外一个文本框的高度**」→ 高度也照同理做。
  //   做法：抬手（挂 document —— 原生 resize 常把指针拖到框外）时比一比"哪个框变过"：
  //   · 宽变过 → 另一个框同一个宽度，**并且把节点宽度按差值一起改**（再补一次 onResize，
  //     ⚠️ 前端只有在 onResize 被调用时才会重排那个 DOM 面板的宽度：实测只 setSize 面板不动、
  //     补上 onResize 立刻跟着变），然后把两个框的 px 宽清掉 → 两框自动铺满、宽度就是刚拖的那个。
  //   · 高变过 → **两个框取同一个高度**，再由 fitNode() 把节点高度重算。
  document.addEventListener("pointerup", function () {
    if (!dragW0) return;
    var w0 = dragW0; dragW0 = null;
    var a = secs.pos && secs.pos.ta, b = secs.neg && secs.neg.ta;
    if (!a || !b || !a.offsetWidth || !b.offsetWidth) return;
    function wNum(k) {                                 // 现读"内联 px 宽"，没有就用实际宽
      var t = secs[k].ta;
      var v = parseFloat(t.style.width);
      return isFinite(v) && v > 0 ? v : t.offsetWidth;
    }
    function wSig(k) { return secs[k].ta.style.width || ""; }
    var which = (wSig("pos") !== w0.posW) ? "pos" : ((wSig("neg") !== w0.negW) ? "neg" : "");
    var wChanged = !!which;
    var whichH = (Math.abs(a.offsetHeight - w0.posH) > 3) ? "pos" : ((Math.abs(b.offsetHeight - w0.negH) > 3) ? "neg" : "");
    if (wChanged) {
      var dw = wNum(which) - (which === "pos" ? (parseFloat(w0.posW) || w0.posO) : (parseFloat(w0.negW) || w0.negO));
      ["pos", "neg"].forEach(function (k) {                       // 两个框都回到"跟着节点走"
        sideOf(node, k).w = 0;
        try { secs[k].ta.style.width = ""; } catch (e2) { /* 忽略 */ }
      });
      if (Math.abs(dw) > 0.5 && typeof node.setSize === "function" && node.size) {
        node.setSize([Math.max(240, node.size[0] + dw), node.size[1]]);
        try { if (typeof node.onResize === "function") node.onResize(node.size); } catch (e3) { /* 忽略 */ }
      }
    }
    if (whichH) {
      var hpx = secs[whichH].ta.offsetHeight;
      ["pos", "neg"].forEach(function (k) { sideOf(node, k).h = hpx; });     // 两个框一样高
      var other2 = whichH === "pos" ? "neg" : "pos";
      try { secs[other2].ta.style.height = hpx + "px"; } catch (e4) { /* 忽略 */ }
      node.__pcUserH = 0;          // 他改的是**文本框**高度 → 节点高度回到"跟着内容走"（第九十八批）
    }
    layoutFrames("pos"); layoutFrames("neg");
    fitNode();
    redraw();
  });

  var foot = document.createElement("div");
  foot.className = "pc-clip-foot";
  var hideAll = document.createElement("button");
  hideAll.type = "button";
  hideAll.textContent = "− 全部虚线框暂时隐藏";
  hideAll.title = "所有粘贴进来的段都不参与生图（内容一个字都不会丢，再点一次就回来）";
  hideAll.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    ["pos", "neg"].forEach(function (w) { sideOf(node, w).r.forEach(function (r) { r.off = true; }); });
    render(); redraw();
  });
  var showAll = document.createElement("button");
  showAll.type = "button";
  showAll.textContent = "＋ 全部放回来";
  showAll.title = "让所有虚线框重新参与生图";
  showAll.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    ["pos", "neg"].forEach(function (w) { sideOf(node, w).r.forEach(function (r) { r.off = false; }); });
    render(); redraw();
  });
  var tip = document.createElement("span");
  tip.className = "pc-clip-tip";
  tip.textContent = "共读两份文本（隐藏的段不进图）·留空就不编";
  // ★ 批 C3（2026-10-06）：他原话「…改成一个『调整正关键词权重』『调整负关键词权重』，
  //   而且一个放在中间一个放在下边」→ **正**那颗在上面 midBar 里、**负**这颗在这儿（下边那排键）。
  var btnWeight = document.createElement("button");
  btnWeight.type = "button";
  btnWeight.className = "pc-weight-btn neg";
  btnWeight.textContent = "⚖ 调整负关键词权重";
  btnWeight.title = "给**负**提示词里的关键词单独设权重（拖附属节点上那颗小圆钮，最小刻度 0.05；也能直接输数值）；"
    + "只改送去编码的那份负提示词，框里的字一个都不会动";
  btnWeight.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    try {
      if (typeof window.__pcOpenWeights === "function") window.__pcOpenWeights(node, "neg");
      else log("权重面板还没加载好（prompt_weight.js）");
    } catch (e2) { log("打开负权重面板失败", e2); }
  });
  // ★ 2026-10-06 他说的「顺便用灰字提醒一下，就是一样长一样宽的」→ 一行灰字（独占一排）
  var wideNote = document.createElement("span");
  wideNote.className = "pc-clip-wide";
  wideNote.textContent = "两个文本框永远一样长、一样宽：拖其中一个的宽 / 高，两个一起变，节点也跟着变";
  foot.appendChild(hideAll); foot.appendChild(showAll); foot.appendChild(btnWeight); foot.appendChild(tip);
  foot.appendChild(wideNote);
  panel.appendChild(foot);

  function syncScroll(which) {
    var sec = secs[which];
    sec.mIn.style.transform = "translate(" + (-sec.ta.scrollLeft) + "px," + (-sec.ta.scrollTop) + "px)";
  }
  // ★ 让镜像的**内容宽**跟文本框一模一样（2026-10-05 查实的坑）：
  //   文本框内容一旦超框就会出现**竖向滚动条**（15px），它的 clientWidth 因此比镜像窄 15px →
  //   两层换行位置不同 → 虚线框永远对不上字（偏小/偏大交替的那种漂移也有它一份）。
  //   做法：镜像明确用 content-box，宽度 = 文本框的 clientWidth − 左右 padding = 文本框的内容宽。
  function syncMirrorWidth(sec) {
    var ta = sec.ta, cs;
    try { cs = getComputedStyle(ta); } catch (e) { return; }
    var cw = ta.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (!(cw > 0)) return;
    sec.mIn.style.boxSizing = "content-box";
    sec.mIn.style.width = Math.round(cw) + "px";
  }
  // 每一段 → 一个虚线**矩形**（不是围着字画边）：量那段在镜像里的所有行矩形，取最小外接框
  function layoutFrames(which) {
    var s = sideOf(node, which), sec = secs[which];
    sec.frames.innerHTML = "";
    syncMirrorWidth(sec);
    var wrapR = sec.wrap.getBoundingClientRect();
    // ⚠️⚠️ 面板是挂在画布上的，整块被**画布缩放**包着 → getBoundingClientRect() 给的是"屏幕像素"，
    //   而 style.top/left 用的是"布局像素"，直接拿屏幕像素去设就又乘了一次缩放
    //   （实测：框只有真值的 0.715 倍 = 正好是当时的画布 scale → 他看到的"偏小/偏大来回漂"）。
    //   → 一律除以 scale 换成布局像素。
    var scale = (sec.wrap.offsetWidth > 0) ? (wrapR.width / sec.wrap.offsetWidth) : 1;
    if (!(scale > 0)) scale = 1;
    var wrapH = sec.wrap.offsetHeight;                 // 布局像素
    var list = s.r.slice().sort(function (a, b) { return a.s - b.s; });
    if (!list.length) return;
    list.forEach(function (r, i) {
      var span = sec.mIn.querySelector('span.pc-mk[data-i="' + i + '"]');
      if (!span) return;
      var rects, rect = null;
      try {
        var rg = document.createRange();
        rg.selectNodeContents(span);
        rects = rg.getClientRects();
        for (var k = 0; k < rects.length; k++) {
          var rc = rects[k];
          if (!rc.width && !rc.height) continue;
          if (!rect) rect = { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom };
          else {
            rect.left = Math.min(rect.left, rc.left); rect.top = Math.min(rect.top, rc.top);
            rect.right = Math.max(rect.right, rc.right); rect.bottom = Math.max(rect.bottom, rc.bottom);
          }
        }
      } catch (e) { rect = null; }
      if (!rect) return;
      var top = (rect.top - wrapR.top) / scale, left = (rect.left - wrapR.left) / scale;
      var h = (rect.bottom - rect.top) / scale, w = (rect.right - rect.left) / scale;
      // ★ 2026-10-05 他报「虚线框框太小了，会和字母挤在一起」→ 框往外让一圈（上下 3 / 左右 5）。
      // ⚠️⚠️ 第九十八批他报「滚轮滚动时文本滚没了、虚线框还挂在那儿」的根因就在这两行：
      //   原来先 `Math.max(0, top - PADY)` 把**滚出去的负值夹成了 0** → 于是那些框全被画在最上面、
      //   还叠在一起。正确顺序是：**先按"带让边后的位置"判整块在不在可视区，判完再夹**。
      var PADX = 5, PADY = 3;
      var top0 = top - PADY, bot0 = top + h + PADY;
      if (bot0 < 0 || top0 > wrapH) return;               // 整段都在可视区外 → 不画
      left = Math.max(0, left - PADX);
      top = top0;
      w += PADX * 2; h += PADY * 2;
      var wrapW = sec.wrap.offsetWidth || 0;
      if (wrapW && left + w > wrapW) w = Math.max(20, wrapW - left);
      var box = document.createElement("div");
      // 只有一排字的框：上下两排小键会重合 → 加个 .short，五颗键并成一排（见 CSS）
      var isShort = h < 32;
      var isNew = false;
      try {
        var nmk = node.__pcNewSeg && node.__pcNewSeg[which];
        // i 是这一段在 list 里的序号（和渲染时的段号一致）；15 分钟内有效，改过字就清
        if (nmk && nmk.until && Date.now() < nmk.until && nmk.i === i) isNew = true;
      } catch (eN) { isNew = false; }
      box.className = "pc-frame" + (r.off ? " off" : "") + (isShort ? " short" : "") + (isNew ? " pc-new" : "");
      box.style.left = Math.round(left) + "px";
      box.style.top = Math.round(top) + "px";
      box.style.width = Math.round(w) + "px";
      box.style.height = Math.round(h) + "px";
      function mk(cls, text, title, fn) {
        var b = document.createElement("button");
        b.type = "button"; b.className = cls; b.textContent = text; b.title = title;
        b.addEventListener("click", function (ev2) {
          ev2.preventDefault(); ev2.stopPropagation();
          fn(b);
          try { sec.ta.focus(); } catch (e2) { /* 忽略 */ }
        });
        box.appendChild(b);
      }
      mk("pc-x", "✕", "把这一段从文本框里删掉", function () {
        var side = sideOf(node, which);
        side.v = side.v.slice(0, r.s) + side.v.slice(r.e);
        var d = r.e - r.s;
        side.r = side.r.filter(function (x) { return x !== r; }).map(function (x) {
          return x.s >= r.e ? { s: x.s - d, e: x.e - d, off: x.off, n: x.n } : x;
        });
        render(); redraw();
      });
      mk("pc-off", r.off ? "＋" : "−",
        r.off ? "这一段现在不参与生图（内容还留着）——点一下让它回来" : "这一段暂时隐藏（内容留着，不参与生图，文字会变淡一半）",
        function () { r.off = !r.off; render(); redraw(); });
      // ★ 2026-10-05 他要的两颗新键：* 收成小胶囊（右上角那颗减号左边）、📋 复制（右下角，⇄ 的左边）
      mk("pc-star", "*",
        "把这一段收成一个小胶囊（放到上面那一排）——文字**照样参与生图**，点胶囊上的 ↩ 能展开回来",
        function () { collapseToChip(which, r); });
      mk("pc-copy", "📋", "把这一段复制到剪贴板（旁边那段的文字不会跑进来）", function (b) {
        var side = sideOf(node, which);
        var txt = side.v.slice(r.s, r.e);
        pulseBtn(box, b, true);                     // ★ 先立刻沉浮一下（他报的就是"点下去没反应"）
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt)
              .then(function () { pulseBtn(box, b, true, true); flashNode(node, true); })
              .catch(function () { pulseBtn(box, b, false, true); flashNode(node, false); });
          } else { pulseBtn(box, b, false, true); flashNode(node, false); }
        } catch (e) { log("复制这一段失败", e); pulseBtn(box, b, false, true); flashNode(node, false); }
      });
      mk("pc-swap", "⇄", "用剪贴板里的内容替换这一段（框里这段不会进剪贴板）", function (b) {
        pulseBtn(box, b, true);
        try {
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(function (txt) {
              if (typeof txt !== "string" || !txt) { pulseBtn(box, b, false, true); return; }
              var side = sideOf(node, which);
              side.v = side.v.slice(0, r.s) + txt + side.v.slice(r.e);
              var d = txt.length - (r.e - r.s);
              side.r = side.r.map(function (x) {
                if (x === r) return { s: r.s, e: r.s + txt.length, off: r.off, n: r.n };
                return x.s >= r.e ? { s: x.s + d, e: x.e + d, off: x.off, n: x.n } : x;
              });
              render(); redraw();
              flashRange(which, r);                   // 换掉之后把那一段亮一下（框刚被重画，键上的水波留不住）
            }).catch(function () { log("读不到剪贴板（浏览器要授权）"); pulseBtn(box, b, false, true); });
          } else { pulseBtn(box, b, false, true); }
        } catch (e) { log("读剪贴板失败", e); pulseBtn(box, b, false, true); }
      });
      sec.frames.appendChild(box);
    });
  }

  // ------------------------------------------------ ★ 小胶囊（★ 收起来的那一段）
  // 他 2026-10-05 定的：① 胶囊**照样算进生图**（"只是显示上收起来"）；② 正/负各自一排；
  // ③ 点名字就地改名、点右边的 ↩ 展开回文本框；④ 默认名字是编号（1、2、3…）。
  function chipName(which, text, r) {
    var side = sideOf(node, which), mx = 0, used = {};
    (side.chips || []).forEach(function (c) {
      used[String(c.name)] = 1;
      var n = parseInt(c.name, 10); if (n > mx) mx = n;
    });
    // ★ 第一百四十五批（他第 1 条）名字的优先级：
    //   ① **这一段自己记得的名字**（`r.n`，跟着工作流存 → 收起→展开→再收起、甚至刷新/重开都认）；
    //   ② 按"原文"记的名字表（老规矩，兼容以前的存档）；
    //   ③ 都没有才按编号给（1、2、3…）。
    var own = (r && r.n) ? String(r.n).trim() : "";
    if (own && !used[own]) return own;
    var remembered = (text && side.chipNames) ? side.chipNames[text] : "";
    if (remembered && !used[remembered]) return remembered;
    return String(mx + 1);
  }
  function rememberChipName(which, text, name) {
    if (!text || !name) return;
    var side = sideOf(node, which);
    if (!side.chipNames) side.chipNames = {};
    side.chipNames[text] = String(name);
  }
  function collapseToChip(which, r) {
    var side = sideOf(node, which);
    var txt = side.v.slice(r.s, r.e);
    if (!txt) return;
    var d = r.e - r.s;
    side.v = side.v.slice(0, r.s) + side.v.slice(r.e);
    side.r = side.r.filter(function (x) { return x !== r; }).map(function (x) {
      return x.s >= r.e ? { s: x.s - d, e: x.e - d, off: x.off } : x;
    });
    side.chips = side.chips || [];
    side.chips = side.chips.map(function (c) {                   // 落点跟着挪
      return c.at >= r.e ? { name: c.name, text: c.text, at: c.at - d, off: !!c.off } : c;
    });
    var nm = chipName(which, txt, r);
    side.chips.push({ name: nm, text: txt, at: Math.min(r.s, side.v.length), off: !!r.off });
    side.chips.sort(function (a, b) { return a.at - b.at; });
    rememberChipName(which, txt, nm);                            // 收回来的名字记下来，下次还是它
    render(); redraw();
  }
  // 胶囊上的小减号 / 加号：跟框上那颗 − 一个意思（虚化 = 内容留着但不参与生图）
  function toggleChipOff(which, chip) {
    var side = sideOf(node, which);
    if (side.chips.indexOf(chip) < 0) return;
    chip.off = !chip.off;
    // ★ 273s 锁链（他："在点亮或者点暗正提示词的小胶囊时，其对应的负提示词小胶囊也会同步点亮或者点暗…
    //   起同样的小胶囊名字，没了，就这么简单"）→ **按 text 全等配对**，点哪边都同步另一边。
    try {
      var other = sideOf(node, which === "pos" ? "neg" : "pos");
      var nmx = String(chip.name == null ? "" : chip.name).trim();   // ★ 273t：按**胶囊名**配对
      (other.chips || []).forEach(function (x) {
        if (String(x.name == null ? "" : x.name).trim() === nmx) x.off = chip.off;
      });
    } catch (eCh2) { /* 忽略 */ }
    render(); redraw();
  }
  function expandChip(which, chip) {
    var side = sideOf(node, which);
    if (side.chips.indexOf(chip) < 0) return;
    rememberChipName(which, chip.text, chip.name);               // 展开前先把名字存住（他改过的名字也算）
    var len = chip.text.length;
    // ★ 第一百四十六批（他第 2 条）：「重新把胶囊化的虚线框展开时，很容易和原有的虚线框互相交融在一起，
    //   改为展开时，**自动在第一排另起两行**，然后在另起的第一行将展开的虚线框放置」
    //   → 展开**不再塞回它原来那个位置**（那儿前后都有别的虚线框，一贴上去就"框里套框"分不清谁是谁），
    //     而是摆到**文本最上面第一行**、后面跟一个空行，让它自己孤立在一排。
    var head = String(side.v || "");
    var pad = head ? (head.charAt(0) === "\n" ? "\n" : "\n\n") : "";
    var shift = len + pad.length;
    side.v = chip.text + pad + head;
    side.r = side.r.map(function (x) { return { s: x.s + shift, e: x.e + shift, off: x.off, n: x.n }; });
    side.chips = side.chips.filter(function (c) { return c !== chip; }).map(function (c) {
      return { name: c.name, text: c.text, at: c.at + shift, off: !!c.off };
    });
    // ★ 第一百四十五批：展开回来又是一段文本 —— **把胶囊的名字写在段上**（`n`），
    //   这样哪怕之后再收起来、或者中途刷新 / 重开工作流，名字还是原来那个（他第 1 条要的继承）。
    side.r.push({ s: 0, e: len, off: !!chip.off, n: String(chip.name || "") });
    side.chips.sort(function (a, b) { return a.at - b.at; });
    render(); redraw();
  }
  function startChipRename(el, nm, chip, which) {
    var inp = document.createElement("input");
    inp.className = "pc-chip-edit";
    inp.value = chip.name;
    el.replaceChild(inp, nm);
    try { inp.focus(); inp.select(); } catch (e) { /* 忽略 */ }
    var done = false;
    function commit(ok) {
      if (done) return; done = true;
      if (ok) {
        var v = String(inp.value || "").trim();
        if (v) { chip.name = v; rememberChipName(which, chip.text, v); }   // 改的名字也要记住
      }
      render(); redraw();
    }
    ["keydown", "keyup", "keypress", "pointerdown"].forEach(function (ev) {
      inp.addEventListener(ev, function (e2) { e2.stopPropagation(); });   // 别让画布抢走按键
    });
    inp.addEventListener("keydown", function (e2) {
      if (e2.key === "Enter") { e2.preventDefault(); commit(true); }
      else if (e2.key === "Escape") { e2.preventDefault(); commit(false); }
    });
    inp.addEventListener("blur", function () { commit(true); });
  }
  // ★ 第一百四十五批（他第 2 条）：「胶囊之间的顺序应该可以自由调配才对」
  //   顺序的真值 = 每个胶囊的 `at`（它原来在文本里的落点）。所以"换顺序" = **把这一排现成的落点
  //   按新顺序重新发一份回去**：位置集合一个不变，只是谁占哪个位子变了。这样送进生图的顺序
  //   （`effectiveText` 按 `at` 把它插回文本）自然跟着这一排从左到右走，不用新增任何状态。
  //   ⚠️ 第一百四十六批（他第 3 条）：「拖动就不必了，拖动 bug 更多，还是别拖动了吧」→
  //   **拖动换位的代码整个删掉**（`el` 上那套 pointerdown/move/up + `chipIndexAt` + `.pc-chip-drag` 样式），
  //   只留这颗 ◀。⚠️ 另外他报「点了不会立即移到最左边」：这里顺手把"落点"整成**严格递增**的
  //   （万一以前有几颗胶囊落在同一个位置，换顺序会算出"没变" → 看着就是点了没反应）。
  function moveChipTo(which, chip, idx) {
    var side = sideOf(node, which);
    var list = (side.chips || []).slice().sort(function (a, b) { return a.at - b.at; });
    var i = list.indexOf(chip);
    if (i < 0) return false;
    var ats = list.map(function (c) { return c.at; });
    for (var j = 1; j < ats.length; j++) {                         // 落点严格递增（同点的往后让一格）
      if (ats[j] <= ats[j - 1]) ats[j] = ats[j - 1] + 1;
    }
    list.splice(i, 1);
    idx = Math.max(0, Math.min(list.length, parseInt(idx, 10) || 0));
    list.splice(idx, 0, chip);
    var changed = false;
    for (var k = 0; k < list.length; k++) {
      if (list[k].at !== ats[k]) { list[k].at = ats[k]; changed = true; }
    }
    side.chips = list;
    if (changed) { render(); redraw(); }                          // 当场重排 + 重画（别等下一次点击）
    return changed;
  }
  function renderChips(which) {
    var sec = secs[which], side = sideOf(node, which);
    var box = sec.chips;
    if (!box) return;
    box.innerHTML = "";
    // ★ 369b 批（他："去掉减号加号时，单击应该触发减号/加号的效果，双击才改名"）
    //   ⚠️ 单击会 toggleChipOff → render 把整排胶囊重建 → 浏览器原生 dblclick 抓不到（第二下落在新元素上）。
    //   → 在**这一排**（box，重排时不重建）上自己数点击：同一个胶囊 520ms 内两下 = 双击改名。
    if (!box.__pcNoOffBound) {
      box.__pcNoOffBound = true;
      box.addEventListener("click", function (ev) {
        var co = (node.__pcCompOpt ? node.__pcCompOpt() : null) || {};
        if (!co.noOff) return;
        var t = ev.target;
        var el2 = (t && t.closest) ? t.closest(".pc-chip") : null;
        if (!el2) return;
        if (t.closest("button,input")) return;          // 📋 等按钮、改名输入框照旧
        ev.preventDefault(); ev.stopPropagation();
        var key = el2.dataset.chipKey || "";
        var now = Date.now();
        var pick = function () {
          var arr = [];
          try { arr = sideOf(node, which).chips || []; } catch (e0) { arr = []; }
          for (var i = 0; i < arr.length; i++) {
            var x = arr[i];
            if ((which + "|" + x.at + "|" + String(x.text || "").length) === key) return x;
          }
          return null;
        };
        if (box.__pcPT && box.__pcPK === key && now - box.__pcPT <= 520) {   // 第二下 = 双击 → 改名
          box.__pcPT = 0; box.__pcPK = "";
          if (box.__pcPTimer) { clearTimeout(box.__pcPTimer); box.__pcPTimer = 0; }
          var nmEl = el2.querySelector(".pc-chip-name");
          var tg = pick();
          if (nmEl && tg) startChipRename(el2, nmEl, tg, which);
          return;
        }
        box.__pcPT = now; box.__pcPK = key;
        if (box.__pcPTimer) clearTimeout(box.__pcPTimer);
        box.__pcPTimer = setTimeout(function () {                            // 单击 = 切换参与 / 不参与
          box.__pcPTimer = 0;
          var tg2 = pick();
          if (tg2) toggleChipOff(which, tg2);
        }, 240);
      });
    }
    // ★ 226 批（他："编入了号之后的胶囊会完全固定在对应的位置，同时也失去左右移动标，
    //   这个时候其他胶囊的移动会给人一种河中水和石头的感觉"）：
    //   编了号的胶囊按它的号占位（固定不动），没编号的在剩下的位置里按原顺序流动。
    ((node.__pcOrderedChips ? node.__pcOrderedChips(which) : side.chips) || []).forEach(function (c, idxInRow) {
      var el = document.createElement("span");
      // ★ 215 批：被伴随位"挡着"的胶囊（配对的那颗 LoRA 现在没亮）→ 半透明 + 说明，
      //   跟他点过 − 的那种"暂时不参与"分开显示（点 − 是 off，伴随位是 .gated）
      // ★ 216 批（他："这个机制不够明显，用户不一定看得懂……得有更明显的特效才行"）：
      //   配了伴随位的胶囊 → **🔗 角标 + 和伴随位那颗同节奏的粉色呼吸光环**（.linked）；
      //   LoRA 没亮 → 灰色 .gated、不呼吸。这样"这两颗是一对"不用看字也看得出来。
      // ★ 237 批：负提示词的胶囊现在也可能是伴随位（which 直接传下去）
      var cs = compStateOf(node, c.text, which);
      var gated = !c.off && cs.state === "dead";
      var linked = !c.off && cs.state === "live";
      // ★ 273s 锁链：正负两侧有**同名**小胶囊就自动成对（他："起同样的小胶囊名字，没了，就这么简单"）
      // ⚠️ 273t 修正：「名字」指的是**胶囊名**（胶囊上显示、点它可以改的那个 1/2/3），不是胶囊里的文字 ——
      //   第一版按 c.text 比，旧胶囊文字各不相同 → 永远不锁。
      var chained = false;
      try {
        var otherC = sideOf(node, which === "pos" ? "neg" : "pos");
        var myName = String(c.name == null ? "" : c.name).trim();
        chained = !!myName && (otherC.chips || []).some(function (x) {
          return String(x.name == null ? "" : x.name).trim() === myName;
        });
      } catch (eCh) { chained = false; }
      el.className = "pc-chip " + (which === "pos" ? "pos" : "neg") + (c.off ? " off" : "")
        + (gated ? " gated" : "") + (linked ? " linked" : "") + (chained ? " chained" : "");
      if (chained) el.title = "⛓ 锁链：正负两侧同名 → 点这一颗，另一边那颗跟着亮/灭";
      if (gated) el.style.opacity = ".45";
      // ★ 222 批：连接标 🔗 / 编号 都可以在 ⚙ 里关掉（他："调整连接标的显示或者不显示，以及直接干净利落地对胶囊进行编号"）
      var co = (node.__pcCompOpt ? node.__pcCompOpt() : { arrow: "left", badge: true, num: false });
      var pinNo = 0;
      try { var pm2 = (node.__pcPinMap ? node.__pcPinMap() : {}) || {}; pinNo = parseInt(pm2[c.text], 10) || 0; } catch (eP) { pinNo = 0; }
      if (pinNo > 0 && which === "pos") {
        var no = document.createElement("b");
        no.className = "pc-chip-no";
        no.textContent = String(pinNo);
        no.title = "固定位 " + pinNo + "（编号的胶囊固定在这个位置，其他胶囊绕着它动；右键/在齿轮里改号）";
        el.insertBefore(no, el.firstChild);
      }
      if (chained) {
        var chb = document.createElement("i");
        chb.className = "pc-chain-badge";
        chb.textContent = "⛓";
        chb.title = "锁链：正负两侧同名，点一边另一边跟着亮/灭";
        el.insertBefore(chb, el.firstChild);
      }
      // ★ 273t（他："伴随位有特效就够了，再来一个连接标。显然不太适用，现在也不必有了"）→ 连接标 🔗 已删，
      //   伴随位只靠 .linked 那圈蓝色呼吸光环 + 蓝边框表达。
      el.title = (chained ? ("⛓ 锁链：正负两侧都有叫「" + String(c.name == null ? "" : c.name).trim() + "」的小胶囊 → 点一边亮/灭，另一边跟着走\\n") : "")
        + (gated
        ? "伴随位：这段配的那颗 LoRA 现在**没亮** → 它暂时不参与生图（文字都留着，把那颗 LoRA 点亮就回来）"
        : ("* 收起来的一段" + (c.off ? "（这段现在**不参与生图**，跟点了小减号一样；展开回去可以再点 ＋ 让它回来）" : "（照样参与生图，只是显示上收起来了）")))
        + "：\n" + c.text.slice(0, 240) + (c.text.length > 240 ? "…" : "")
        + "\n\n"
        + (co.noOff ? "单击 = 让它先不参与生图（再点回来）· 双击 = 改名" : "点名字可以改名字 · 点 − 让它先不参与生图")
        + (co.noArrow ? "" : " · 点左边的 ◀ 挪到最前面")
        + (co.noBack ? "" : " · 点右边的 ↩ 展开回文本框（展开后它会自己另起一排放在最上面）");
      // ★ 第一百四十五批（他第 2 条）：向左的小箭头 = **挪到第一个**
      //   第一百四十六批（他第 3 条）：「胶囊的小箭头太大了，小一点」→ 字号 11 → **9px**
      //   （小归小，还是留了 2px 内边距，点得中）
      // ★ 222 批：这颗箭头的**朝向**可以在 ⚙ 里切（◀ / ▶），他明确点名要这个
      var toFirst = document.createElement("button");
      toFirst.type = "button"; toFirst.className = "pc-chip-first";
      toFirst.textContent = co.arrow === "right" ? "▶" : "◀";
      if (pinNo > 0) toFirst.style.display = "none";   // ★ 226 批：编号的胶囊固定，不再给移动标
      toFirst.title = "点一下：把这颗胶囊挪到**最前面**（这一排从左到右 = 送进生图的先后顺序）";
      toFirst.addEventListener("click", function (e2) {
        e2.preventDefault(); e2.stopPropagation();
        moveChipTo(which, c, 0);
      });
      // ★★ 他第一百零九批第 1 条后半段：「同时胶囊情况下也要有小减号虚化键」→ 胶囊上补一颗 −/＋
      //    （跟框上那颗 pc-off 一个意思：内容留着，只是不参与生图）
      var off = document.createElement("button");
      off.type = "button";
      off.className = "pc-chip-off" + (c.off ? " on" : "");
      off.textContent = c.off ? "＋" : "−";
      off.title = c.off
        ? "这一段现在不参与生图（内容留着）——点一下让它回来"
        : "这一段暂时隐藏（内容留着，不参与生图）";
      off.addEventListener("click", function (e2) {
        e2.preventDefault(); e2.stopPropagation();
        toggleChipOff(which, c);
      });
      var nm = document.createElement("span");
      nm.className = "pc-chip-name";
      nm.textContent = c.name;
      // ★ 369b：去掉 −/＋ 之后「单击 = 切换参与、双击 = 改名」→ 名字上就**不要再挂单击改名**，
      //   不然点一下先弹输入框，永远轮不到切换（他原话："若点击名称还是会先触发改名…应该单击触发减号加号效果，双击改名"）。
      if (!co.noOff) {
        nm.title = "点一下改名（名字会记住）";
        nm.addEventListener("click", function (e2) {
          e2.preventDefault(); e2.stopPropagation();
          startChipRename(el, nm, c, which);
        });
      } else {
        nm.title = "单击 = 让它先不参与生图（再点回来）· 双击 = 改名";
      }
      var bk = document.createElement("button");
      bk.type = "button"; bk.className = "pc-chip-back"; bk.textContent = "↩";
      bk.title = "展开回文本框（它会自己另起一排放在最上面，不再和别的虚线框挤在一起）";
      bk.addEventListener("click", function (e2) {
        e2.preventDefault(); e2.stopPropagation();
        expandChip(which, c);
      });
      // ⚠️ 第一百四十六批（他第 3 条）：「拖动就不必了，拖动 bug 更多，还是别拖动了吧」
      //   → 这里原来那套"按住胶囊往左右拖换位"（pointerdown/move/up + chipIndexAt）**整个删掉**，
      //     顺序只由那颗 ◀ + 从面板/数据改。别再往这儿加拖动。
      // ★ 287：开着"复制键"时，胶囊上多一颗 📋 —— 点一下直接复制这颗胶囊里的内容
      var cpBtn = null;
      if (co.copy) {
        cpBtn = document.createElement("button");
        cpBtn.type = "button"; cpBtn.className = "pc-chip-copy"; cpBtn.textContent = "📋";
        cpBtn.title = "复制这颗小胶囊里的内容（不用展开）";
        cpBtn.style.cssText = "border:none;background:transparent;color:#cfd6e6;cursor:pointer;"
          + "font-family:inherit;font-size:10px;line-height:1;padding:0 1px;opacity:.8";
        cpBtn.addEventListener("click", function (e2) {
          e2.preventDefault(); e2.stopPropagation();
          var txt = String(c.text || "");
          try {
            navigator.clipboard.writeText(txt).then(function () {
              try { clipToast("已复制这颗小胶囊（" + txt.length + " 字）"); } catch (e3) { /* 忽略 */ }
            }, function () { try { clipToast("复制失败：浏览器没给权限", true); } catch (e4) { /* 忽略 */ } });
          } catch (e5) { try { clipToast("复制失败", true); } catch (e6) { /* 忽略 */ } }
        });
      }
      // ★ 369 批：这三颗键可以在 ⚙ 里去掉（胶囊尽量干净）；去掉 −/＋ 时改成点胶囊本体切换
      if (!co.noArrow) el.appendChild(toFirst);
      if (!co.noOff) el.appendChild(off);
      el.appendChild(nm);
      if (cpBtn) el.appendChild(cpBtn);
      if (!co.noBack) el.appendChild(bk);
      if (co.noOff) {
        el.style.cursor = "pointer";
        el.dataset.chipKey = which + "|" + c.at + "|" + String(c.text || "").length;   // 369b：给"这一排数点击"认人
      }
      box.appendChild(el);
    });
  }
  // 测试 / 自检用：直接调"换顺序"（真界面上是点那颗 ◀ 或者按住胶囊拖）
  window.__pcChipOrder = function (which) {
    try {
      return (sideOf(node, which).chips || []).slice().sort(function (a, b) { return a.at - b.at; })
        .map(function (c) { return c.name; });
    } catch (e) { return null; }
  };
  window.__pcChipMove = function (which, from, to) {
    try {
      var s = sideOf(node, which);
      var l = (s.chips || []).slice().sort(function (a, b) { return a.at - b.at; });
      return moveChipTo(which, l[from], to);
    } catch (e) { return false; }
  };

  // 「换掉这一段」之后把那一段文字亮一下（框刚被重画，挂在键上的水波留不住）
  function flashRange(which, r) {
    try {
      var sec = secs[which], side = sideOf(node, which);
      var list = side.r.slice().sort(function (a, b) { return a.s - b.s; });
      var i = list.indexOf(r);
      if (i < 0) return;
      var span = sec.mIn.querySelector('span.pc-mk[data-i="' + i + '"]');
      if (!span) return;
      span.classList.add("flash");
      setTimeout(function () { try { span.classList.remove("flash"); } catch (e) { /* 忽略 */ } }, 950);
    } catch (e) { /* 忽略 */ }
  }

  // ------------------------------------------------ 撤销 / 重做（每边一套，跟小助手一样按框分开记）
  // 他第 101 批只点了"这两个按钮"，所以这里就一个简单的编辑栈：**连打字自动并成一步**（800ms 内），
  // 段/胶囊/粘贴/删除/隐藏/换掉这些"离散动作"各算一步；最多 80 步。
  var HIST_MAX = 80;
  var histLock = false;
  var hists = { pos: { list: [], idx: -1, at: 0 }, neg: { list: [], idx: -1, at: 0 } };
  function histSnap(side) {
    return JSON.stringify({
      v: side.v,
      r: (side.r || []).map(function (x) { return { s: x.s, e: x.e, off: !!x.off, n: x.n }; }),
      chips: (side.chips || []).map(function (c) { return { name: c.name, text: c.text, at: c.at, off: !!c.off }; }),
    });
  }
  function paintHist() {
    ["pos", "neg"].forEach(function (k) {
      var sec = secs[k], h = hists[k];
      if (!sec || !sec.hist || !h) return;
      try { sec.hist.undo.disabled = h.idx <= 0; } catch (e) { /* 忽略 */ }
      try { sec.hist.redo.disabled = (h.idx < 0) || (h.idx >= h.list.length - 1); } catch (e) { /* 忽略 */ }
    });
  }
  function pushHist(which) {
    if (histLock) return;
    var h = hists[which];
    if (!h) return;
    var s = histSnap(sideOf(node, which));
    if (h.idx >= 0 && h.list[h.idx] === s) return;                 // 一个字都没变
    var now = Date.now();
    if (h.idx >= 0 && now - h.at < 800) {
      h.list[h.idx] = s;                                           // 连着打字 → 并进上一步
    } else {
      h.list = h.list.slice(0, h.idx + 1);                         // 新的动作 → 砍掉"重做"那截
      h.list.push(s);
      if (h.list.length > HIST_MAX) h.list.shift();
      h.idx = h.list.length - 1;
    }
    h.at = now;
    paintHist();
  }
  function applyHist(which, dir) {
    var h = hists[which];
    if (!h) return;
    var ni = h.idx + dir;
    if (ni < 0 || ni >= h.list.length) return;
    h.idx = ni; h.at = 0;
    histLock = true;
    try {
      var st = JSON.parse(h.list[ni]);
      var side = sideOf(node, which);
      side.v = st.v;
      side.r = (st.r || []).map(function (x) { return { s: x.s, e: x.e, off: !!x.off, n: x.n }; });
      side.chips = (st.chips || []).map(function (c) { return { name: c.name, text: c.text, at: c.at, off: !!c.off }; });
      renderSide(which);
      syncBackend(node);
      fitNode();
      redraw();
      log((dir < 0 ? "撤销" : "重做") + "一步（" + which + "，第 " + (ni + 1) + " / " + h.list.length + " 步）");
    } catch (e) { /* 忽略 */ }
    histLock = false;
    paintHist();
  }

  function renderSide(which) {
    var s = sideOf(node, which);
    var sec = secs[which];
    if (sec.ta.value !== s.v) sec.ta.value = s.v;
    if (s.h && Math.abs(sec.ta.offsetHeight - s.h) > 2) sec.ta.style.height = s.h + "px";
    if (s.w) sec.ta.style.width = s.w + "px";
    sec.mIn.innerHTML = mirrorHTML(s.v, s.r);
    renderChips(which);
    syncMirrorWidth(sec);
    syncScroll(which);
    layoutFrames(which);
    // ★★ 273r 他报：「切换上下步的时候，仍然会显示文本不变，真正存在的文本已经隐形，
    //   现在浮现的是假文本」—— 根因就在这儿：renderSide 是**程序改 ta.value**，
    //   不会触发 input 事件，所以着色层停在旧内容上（真文本因为透明看不见，旧字浮在上面）。
    //   renderSide 是撤销 / 重做 / 粘贴 / 快捷词 / AI 回填的必经之路 → 在这里重画一次全解决。
    try { if (node.__pcHl && node.__pcHl[which]) node.__pcHl[which].paint(); } catch (e) { /* 忽略 */ }
  }

  function afterEdit(which) {
    try { if (node.__pcNewSeg) { delete node.__pcNewSeg[which]; } } catch (eC) { /* 忽略 */ }
    syncBackend(node);
    if (which) renderSide(which); else { renderSide("pos"); renderSide("neg"); }
    pushHist("pos"); pushHist("neg");                 // ★ 每次改动记一步（没变的话 pushHist 自己会跳过）
    fitNode();
    redraw();
  }
  // 面板**内容**的真实高度（不能用 offsetHeight —— 前端会按 --comfy-widget-height 把元素撑起来，
  // 拿撑起来的值再喂回去就成了自我滚雪球：实测一路涨到 822，节点跟着变成 888 空的）
  function contentHeight() {
    var kids = panel.children, h = 0, n = 0;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (!k.offsetHeight) continue;                 // 隐藏的（比如还没粘贴、chips 空着）不算
      h += k.offsetHeight; n++;
    }
    if (n > 1) h += 8 * (n - 1);                     // .pc-clip 的 gap
    return h + 6;                                    // 上下 padding
  }
  // ★ 节点至少要有多高，**最底下那两颗按钮（全部隐藏 / 全部放回来）才在节点里面**（他第 1 条要的硬下限）。
  //   ⚠️ 量的是**最底下那排按钮**，不是面板自己 —— 面板元素被前端撑成"节点剩下的高度"
  //   （实测它跟着节点高度跑：节点 888 时面板高 778，可内容其实只有 388）→ 拿面板量会自我放大（量出 876 那种鬼数字）。
  //   按钮那排的位置只跟内容有关、跟节点高度无关，所以它稳定。
  function requiredNodeH() {
    var h = contentHeight();
    try {
      var cv = app.canvas, d = cv && cv.ds, cvs = cv && cv.canvas;
      var tail = panel.lastElementChild || panel;
      if (d && cvs && tail && tail.offsetHeight) {
        var r = cvs.getBoundingClientRect();
        var scale = d.scale || 1;
        var tailBottom = (tail.getBoundingClientRect().bottom - r.top) / scale - (d.offset ? d.offset[1] : 0);
        var need = tailBottom - ((node.pos && node.pos[1]) || 0) + 6;         // 再留 6px 余量
        if (need > 20 && need < 4000) return Math.ceil(need);
      }
    } catch (e) { /* 忽略 */ }
    return h + 106;                       // 量不到就退回"内容高 + 标题栏/说明行/控件间距（≈100）+ 余量"
  }
  function fitNode() {
    try {
      var h = contentHeight();
      if (!h) return;
      panel.style.setProperty("--comfy-widget-height", Math.max(110, h) + "px");
      // ★ 节点高度的**明确下限**：内容 + 标题栏 —— 也就是"最底下那两个按钮刚好在节点里面"。
      //   想再矮就去把文本框调矮（下限跟着降）。
      node.__pcMinH = Math.max(240, requiredNodeH());
      if (!(node.flags && node.flags.collapsed) && node.size && (node.size[1] || 0) < node.__pcMinH) {
        node.size[1] = node.__pcMinH;
      }
      // ★★ 2026-10-05 第九十八批他报「现在任何一个操作都有可能会导致重置优化节点的宽高调整」：
      //   因为他自己把节点拖高之后，这里每次都按"内容高"把它**按回去**了。
      //   → 记住他手动拖过的高度（`__pcUserH`，onResize 里认出来的），自动排版**只许比它更高**、不许压低。
      var target = Math.max(node.__pcMinH, node.__pcUserH || 0);
      if (node.__pcFitLast === h && Math.abs((node.size ? node.size[1] : 0) - target) <= 8) return;
      node.__pcFitLast = h;
      if (typeof node.setSize === "function" && node.size && !(node.flags && node.flags.collapsed)) {
        if (Math.abs((node.size[1] || 0) - target) > 8) {
          node.__pcAutoH = target;                       // 记下"这是自动排的"，onResize 里好跟手动拖的区分开
          node.setSize([node.size[0], target]);
        } else {
          node.__pcAutoH = node.size[1];
        }
      }
      // 刚建出来的时候节点还没进画布，那次 setSize 会被后面的排版盖掉 → 过一会儿再钉一次
      [90, 420].forEach(function (delay) {
        setTimeout(function () {
          try {
            if (!node.graph) return;
            if (node.flags && node.flags.collapsed) return;
            var hh = contentHeight();
            if (!hh) return;
            panel.style.setProperty("--comfy-widget-height", Math.max(110, hh) + "px");
            var w2 = Math.max(240, hh + 66);
            if (node.size && Math.abs((node.size[1] || 0) - w2) > 8) node.setSize([node.size[0], w2]);
            redraw();
          } catch (e2) { /* 忽略 */ }
        }, delay);
      });
    } catch (e) { /* 忽略 */ }
  }
  function render() {
    renderSide("pos"); renderSide("neg"); afterEdit(null);
  }

  // ★ 2026-10-05：**面板宽度变了 = 他改了节点本身的宽度** → 两个文本框都回到"跟着节点走"
  //   （清掉早先手拖出来的 px 宽度），不然手动拖过宽度的框会一直卡在那个宽度上、看着像"改宽节点它不变宽"。
  //   盯面板的宽度而不是 node.size[0]：DOM 控件的实际宽度只有面板自己知道（setSize 不一定马上生效）。
  try {
    if (window.ResizeObserver && !node.__pcPanelRO) {
      var roPanel = new ResizeObserver(function () {
        var pw = panel.offsetWidth;
        if (!pw) return;
        if (node.__pcPanelW && Math.abs(pw - node.__pcPanelW) > 2) {
          ["pos", "neg"].forEach(function (k) {
            try {
              sideOf(node, k).w = 0;
              if (secs[k] && secs[k].ta) secs[k].ta.style.width = "";
            } catch (e2) { /* 忽略 */ }
          });
          layoutFrames("pos"); layoutFrames("neg");
          fitNode();
        }
        node.__pcPanelW = pw;
      });
      roPanel.observe(panel);
      node.__pcPanelRO = roPanel;
    }
  } catch (e) { /* 忽略 */ }

  node.__pcPanelEl = panel;
  node.__pcRender = render;
  node.__pcFit = fitNode;
  node.__pcSide = function (w) { return sideOf(node, w); };
  node.__pcHist = function (which) {                  // 探针用：撤销/重做的游标与可用状态
    var h = hists[which], sec = secs[which];
    if (!h || !sec) return null;
    return {
      idx: h.idx, len: h.list.length,
      undoDisabled: !!(sec.hist && sec.hist.undo.disabled),
      redoDisabled: !!(sec.hist && sec.hist.redo.disabled),
      glyphs: sec.hist ? [sec.hist.undo.textContent, sec.hist.redo.textContent] : null,
    };
  };
  node.__pcLayout = function () { layoutFrames("pos"); layoutFrames("neg"); };
  return panel;
}

// ---------------------------------------------------------------- 面板宽度钉住
//   ★ 210 批（他："优化节点和 Lora 池点一下就会变窄，还是原封不动的存在"）：
//   实测真因**不在我们代码里** —— 前端在点击/聚焦之后会拿它自己记的 `widget.width`
//   （一个过时的 ~284px）去重设 DOM 控件的元素宽度，节点 size 一点没变，
//   于是面板从 980 掉到 264、文本框跟着掉到 227 —— 这就是"变窄一半"。
//   做法三步：① `widget.width` 改成"永远返回节点宽 - 20"的计算属性（前端写进来的一概不认）；
//   ② 元素宽度按节点宽写死，并用 ResizeObserver 盯着，被改小就按回去；
//   ③ 节点真被拖宽/拖窄时（onResize）重算一次 —— 正常缩放不受影响。
function pinWidgetWidth(node, widget) {
  try {
    if (!widget || !widget.element || node.__pcWidthPinned) return;
    node.__pcWidthPinned = true;
    var el = widget.element;
    function want() { return Math.max(240, (node.size ? node.size[0] : 860) - 20); }
    try {
      Object.defineProperty(widget, "width", {
        get: want,
        set: function () { /* 前端写的宽度不采纳 */ },
        configurable: true,
      });
    } catch (e) { /* 忽略 */ }
    function apply() {
      try { el.style.width = want() + "px"; } catch (e2) { /* 忽略 */ }
    }
    apply();
    if (window.ResizeObserver) {
      var lastNode = -1;
      node.__pcWidthRO = new ResizeObserver(function () {
        var nw = node.size ? node.size[0] : 0;
        if (!nw) return;
        if (nw !== lastNode) { lastNode = nw; apply(); return; }
        if (Math.abs(el.offsetWidth - want()) > 8) apply();
      });
      node.__pcWidthRO.observe(el);
    }
    var prevResize = node.onResize;
    node.onResize = function () {
      var r = prevResize ? prevResize.apply(this, arguments) : undefined;
      apply();
      return r;
    };
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 伴随位「实时」刷新
//   ★ 214 批（他："伴随位的伴随效果竟然不是实时的，会有几秒钟的延迟，可以改成实时的吗"）
//   以前伴随位只在 CLIP 节点那边约 3 秒一次的轮询里重画 → 池子里点亮/熄灭一颗 LoRA 要等好几秒。
//   现在 `prompt_lorapool.js` 的 `writeState()` 一改动就 `dispatchEvent("pc-lorapool-changed")`，
//   这里收到就**当场**把所有 CLIP 节点的伴随位重画一遍（不等轮询）。
try {
  window.addEventListener("pc-lorapool-changed", function () {
    try {
      var nodes = (app && app.graph && app.graph._nodes) || [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n && n.type === "PromptToolClipSegments") {
          // ★ 215 批：伴随位是按"那颗 LoRA 亮没亮"决定这颗胶囊参不参与编码的，
          //   所以池子一变**必须重算送进编码的那份文本**（syncBackend）—— 光重画界面不够。
          try { if (typeof n.__pcCompPaint === "function") n.__pcCompPaint(); } catch (e2) { /* 忽略 */ }
          try { syncBackend(n); } catch (e4) { /* 忽略 */ }
          // 胶囊那边也要跟着变（被伴随位挡住的显示半透明）；正在文本框里打字就不重建 DOM
          try {
            var ae = document.activeElement;
            var typing = !!(ae && String(ae.className || "").indexOf("pc-ta") >= 0);
            if (!typing && typeof n.__pcRender === "function") n.__pcRender();
          } catch (e5) { /* 忽略 */ }
        }
      }
      try { if (app.canvas && app.canvas.setDirty) app.canvas.setDirty(true, true); } catch (e3) { /* 忽略 */ }
    } catch (e) { /* 忽略 */ }
  });
} catch (e) { /* 忽略 */ }

// ---------------------------------------------------------------- 收起 / 展开（和「提示词同步」互相切换）
function titleBarWidth(node) {
  // 收起时**不能用 size[0]**：前端把折叠宽度算成 min(size[0], 标题宽度 + 标题高*2)（存在 _collapsed_width 上）
  var w = node.size ? node.size[0] : 300;
  if (!(node.flags && node.flags.collapsed)) return w;
  var cw = node._collapsed_width;
  var fallback = (window.LiteGraph && window.LiteGraph.NODE_COLLAPSED_WIDTH) || 80;
  return Math.max(40, Math.min(w, (cw && cw > 20) ? cw : fallback));
}
function collapseBtnRect(node) {
  var th = (window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 30;
  return { x: titleBarWidth(node) - BTN / 2 - 6, y: -th / 2, r: BTN / 2 + 4 };
}
function syncPanelVisibility(node) {
  var el = node.__pcPanelEl;
  if (!el) return;
  var collapsed = !!(node.flags && node.flags.collapsed);
  try {
    var wasHidden = el.style.display === "none";
    el.style.display = collapsed ? "none" : "";
    // ★ 展开的瞬间面板还是 display:none（前端的 DOM 控件要等下一次画布重绘才真的显示出来）→
    //   那一刻量出来的矩形全是 0，虚线框就画不出来（实测：展开后 .pc-frame 数 = 0）。
    //   所以展开时安排几次"重新摆一遍"，等前端把面板显出来之后自动补上。
    if (!collapsed && wasHidden) scheduleRelayout(node);
  } catch (e) { /* 忽略 */ }
}
function scheduleRelayout(node) {
  [60, 200, 600].forEach(function (d) {
    setTimeout(function () {
      try {
        if (!node.graph) return;
        if (node.flags && node.flags.collapsed) return;
        if (typeof node.__pcRender === "function") node.__pcRender();
      } catch (e) { /* 忽略 */ }
    }, d);
  });
}
function setCollapsed(node, on) {
  try {
    node.flags = node.flags || {};
    var collapsedNow = !!node.flags.collapsed;
    if (collapsedNow === !!on) { syncPanelVisibility(node); syncBackend(node); redraw(); return; }
    if (on && node.size) node.__pcOpenH = node.size[1];
    node.flags.collapsed = !!on;
    if (!on && node.__pcOpenH && node.size) node.size[1] = node.__pcOpenH;
    if (typeof node.setSize === "function") node.setSize(node.size || [420, 200]);
    syncPanelVisibility(node);
    if (!on && typeof node.__pcRender === "function") node.__pcRender();     // 展开后把虚线框/文本框重新摆好
    syncBackend(node);                                                       // ★ 收起 = 清空后端那份（不参与作图）
    redraw();
  } catch (e) { /* 忽略 */ }
}
function inputIndexByName(node, prefix) {
  var ins = node && node.inputs;
  if (!Array.isArray(ins)) return -1;
  for (var i = 0; i < ins.length; i++) {
    if (ins[i] && typeof ins[i].name === "string" && ins[i].name.indexOf(prefix) === 0) return i;
  }
  return -1;
}
function pairedSyncNode(node) {                  // 我们的「提示词同步…」口上连着的那个节点
  try {
    var idx = inputIndexByName(node, PORT_PREFIX);
    if (idx < 0) return null;
    var l = node.inputs[idx].link;
    var link = (l !== null && l !== undefined) ? app.graph.links[l] : null;
    var other = link ? app.graph.getNodeById(link.origin_id) : null;
    if (!other) return null;
    return (other.type === SYNC_NODE || other.comfyClass === SYNC_NODE) ? other : null;
  } catch (e) { return null; }
}

// ★★ 2026-10-05 第九十九批（他确认「不是 bug，是需求」）：两个节点互换展开/收起时**对调工位** ——
//   「也会互换所在位置，并且展开之后的大小和另外一个节点一样」→ 一个收起来、另一个展开时：
//   **两个节点交换位置**，而且**各自取对方的大小**（刚展开那个就拿到了对方收起前的尺寸）。
function pcSwapSlots(a, b) {
  try {
    if (!a || !b || !a.pos || !b.pos || !a.size || !b.size) return false;
    var ax = a.pos[0], ay = a.pos[1], bx = b.pos[0], by = b.pos[1];
    var aw = a.size[0], ah = a.size[1], bw = b.size[0], bh = b.size[1];
    if (ax === bx && ay === by && aw === bw && ah === bh) return false;
    a.pos = [bx, by];
    b.pos = [ax, ay];
    if (typeof a.setSize === "function") a.setSize([bw, bh]);
    if (typeof b.setSize === "function") b.setSize([aw, ah]);
    // 面板是"钉在画布上"的 DOM：换了位置 / 大小必须让它重排一次
    var clip = isClipNode(a) ? a : (isClipNode(b) ? b : null);
    if (clip) {
      try { if (typeof clip.onResize === "function") clip.onResize(clip.size); } catch (e2) { /* 忽略 */ }
      scheduleRelayout(clip);
    }
    redraw();
    return true;
  } catch (e) { return false; }
}
function isClipNode(n) { return !!n && (n.type === NODE_NAME || n.comfyClass === NODE_NAME); }
window.__pcSwapSlots = pcSwapSlots;

// ---------------------------------------------------------------- 顶上那一行灰字（跟「提示词同步」/套图那几行同一个做法）
function clipText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  var t = text;
  while (t.length > 2 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}
function makeHintRow(text) {
  return {
    type: "pcText",
    name: text,
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
function addTopWidget(node, w) {
  if (typeof node.addCustomWidget === "function") node.addCustomWidget(w);
  else if (Array.isArray(node.widgets)) node.widgets.push(w);
  var ws = node.widgets;
  if (Array.isArray(ws)) {
    var at = ws.indexOf(w);
    if (at > 0) { ws.splice(at, 1); ws.unshift(w); }
  }
}

app.registerExtension({
  name: "PromptClip.Segments",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    styleOnce();

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const node = this;
      try {
        // ① 后端那四个文本框控件收起来（我们用自己的文本框 + 背后那层镜像）；
        //    第三、四个是批 C3（2026-10-06）的「正权重表」/「负权重表」—— 前端把两张关键词权重表写成
        //    JSON 塞进去（第一百零六批按他要求"正负分开调"拆成两条），后端 encode 只拿它们改写
        //    "送去编码的那份文本"，框里的字一个都不动。
        node.widgets = node.widgets || [];
        node.widgets.slice().forEach(function (w) {
          if (!w || (w.name !== "正提示词" && w.name !== "负提示词" && w.name !== "text"
            && w.name !== "正权重表" && w.name !== "负权重表" && w.name !== "权重表")) return;
          w.computeSize = function () { return [0, -4]; };
          w.hidden = true;
          try { if (w.element) w.element.style.display = "none"; } catch (e) { /* 忽略 */ }
        });
        // ② 顶上那行灰字（说明"一个展开另一个收起、收起的不参与作图"）
        if (typeof node.addWidget === "function") {
          try { addTopWidget(node, makeHintRow(HINT_TEXT)); } catch (e) { /* 忽略 */ }
        }
        // ③ 这是个"大节点"，默认就给足宽度（他原话：可以不用设置那么小的宽度）
        if (node.size && node.size[0] < 700) node.setSize([860, Math.max(node.size[1] || 0, 620)]);
        // ★ 273h：新节点默认继承"最近编辑过的那颗优化节点"的数据（他："成本太大"）
        try { if (clipInherit(node)) log("新节点继承了最近编辑过的那份提示词 / 权重 / 胶囊"); } catch (e) { /* 忽略 */ }
        // ④ 面板
        const panel = makePanel(node);
        if (typeof node.addDOMWidget === "function") {
          node.__pcPanelWidget = node.addDOMWidget("提示词", "pcClipPanel", panel, { serialize: false, hideOnZoom: false });
          // ★ 210 批：点一下文本框面板就缩成 1/4 —— 前端按它自己记的 widget.width 重设了元素宽度
          pinWidgetWidth(node, node.__pcPanelWidget);
        } else {
          log("这个前端没有 addDOMWidget，文本框面板降级显示");
          panel.style.position = "absolute";
          panel.style.zIndex = 20;
          panel.style.width = "760px";
          app.canvas?.canvasEl?.parentElement?.appendChild(panel);
        }
        // ⑤ 前端自己的收起（右键菜单 / 双击标题）也要让面板跟着收放
        if (typeof node.collapse === "function") {
          const origCollapse = node.collapse;
          node.collapse = function () {
            const out = origCollapse.apply(this, arguments);
            try {
              syncPanelVisibility(node);
              if (!(node.flags && node.flags.collapsed) && node.__pcRender) node.__pcRender();
              syncBackend(node);                       // 收起 = 后端那份清空
            } catch (e) { /* 忽略 */ }
            return out;
          };
        }
        if (node.__pcRender) node.__pcRender();
        syncBackend(node);
        scheduleRelayout(node);            // 面板刚挂上时宽度还没定，等前端排版完再摆一次
        log("已挂上正/负文本框 + 粘贴虚线框面板 + 顶上那行说明");
      } catch (e) {
        log("面板挂载失败（后端还能正常编码）", e);
      }
      return r;
    };

    // 读工作流时把文本框内容 / 虚线框恢复出来（properties 跟着工作流存）
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        if (info && info.properties && info.properties[PROP]) this.properties[PROP] = info.properties[PROP];
        sideOf(this, "pos"); sideOf(this, "neg");
        if (typeof this.__pcRender === "function") this.__pcRender();
        syncBackend(this);
      } catch (e) { /* 忽略 */ }
      return r;
    };

    // ★ 2026-10-05 他第 1 条的后半段：「节点高度的**下限**竟然不包括『全部虚线框暂时隐藏 / 全部放回来』
    //   这两个按钮」「节点框居然还能继续往下拖，突破下限，拖到负提示词文本框以内」→
    //   在 onResize 里**先把高度夹到下限**（= 面板内容 + 标题栏，fitNode 每帧算好的 `__pcMinH`），
    //   再调原来的 onResize 去重排 —— 想再矮就去把文本框调矮，下限会跟着降。
    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      try {
        var min = this.__pcMinH;
        // ⚠️ 收起状态不夹（第九十九批对调工位时，收起那个会拿到对方的尺寸，别把它顶回最小高度）
        if (min && size && size[1] < min && !(this.flags && this.flags.collapsed)) {
          size[1] = min;
          if (this.size) this.size[1] = min;
        }
        // ★ 第九十八批：他**手动拖过**节点大小 → 记住这个高度（`__pcUserH`）。
        //   自动排的那一次会先把目标写进 `__pcAutoH`，所以只认"跟自动值不一样"的那些。
        if (size && this.__pcAutoH !== undefined && Math.abs(size[1] - this.__pcAutoH) > 2) {
          this.__pcUserH = size[1];
        }
      } catch (e) { /* 忽略 */ }
      const r2 = onResize ? onResize.apply(this, arguments) : undefined;
      return r2;
    };

    // 标题栏右上角那颗「− / ＋」：收自己、把配对的「提示词同步」展开（两者永远一个收一个开）
    const onDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const r = onDraw ? onDraw.apply(this, arguments) : undefined;
      if (!ctx) return r;
      try {
        const collapsed = !!(this.flags && this.flags.collapsed);
        if (this.__pcCollapsedSeen !== collapsed) {          // 状态一变（不管谁改的）就把面板同步好
          this.__pcCollapsedSeen = collapsed;
          syncPanelVisibility(this);
          if (!collapsed && typeof this.__pcRender === "function") {
            try { this.__pcRender(); } catch (e2) { /* 忽略 */ }
          }
          syncBackend(this);
        }
        const b = collapseBtnRect(this);                     // ★ 每次现算，不算上一帧的缓存
        ctx.save();
        ctx.beginPath();
        ctx.arc(b.x, b.y, BTN / 2, 0, Math.PI * 2);
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
      return r;
    };

    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (e, pos, canvas) {
      try {
        if (pos) {
          const b = collapseBtnRect(this);                   // 同一个函数算位置 → 收起后也打得到
          const dx = pos[0] - b.x, dy = pos[1] - b.y;
          if (dx * dx + dy * dy <= b.r * b.r) {
            const willCollapse = !(this.flags && this.flags.collapsed);
            setCollapsed(this, willCollapse);
            const peer = pairedSyncNode(this);
            if (peer && typeof peer.__pcToggleCollapse === "function") peer.__pcToggleCollapse(!willCollapse);
            else if (peer && window.__pcSetCollapsed) window.__pcSetCollapsed(peer, !willCollapse);
            if (peer) pcSwapSlots(this, peer);          // ★ 对调工位（第九十九批他要的）
            return true;                                // 吃掉这次点击（别让节点被拖动）
          }
        }
      } catch (err) { /* 忽略 */ }
      const r = onMouseDown ? onMouseDown.apply(this, arguments) : undefined;
      return r;
    };
  },
});

// 给「提示词同步」那边调的：收/放我们这颗节点
window.__pcSetCollapsed = function (node, on) { setCollapsed(node, on); };
window.__pcClipInfo = function (node) {                 // 测试钩子
  if (!node) return null;
  var p = { pos: sideOf(node, "pos"), neg: sideOf(node, "neg") };
  var wPos = textWidget(node, "正提示词") || textWidget(node, "text");
  return {
    pos: p.pos.v, neg: p.neg.v,
    posBoxes: p.pos.r.length, negBoxes: p.neg.r.length,
    posOut: effectiveText(p.pos, node, "pos"), negOut: effectiveText(p.neg, node, "neg"),
    widgetPos: wPos ? String(wPos.value || "") : null,
    frames: node.__pcPanelEl ? node.__pcPanelEl.querySelectorAll(".pc-frame").length : 0,
    frameCounts: node.__pcPanelEl ? Array.prototype.map.call(node.__pcPanelEl.querySelectorAll(".pc-clip-sec"), function (s) {
      return s.querySelectorAll(".pc-frame").length;
    }) : [],
    posH: p.pos.h, negH: p.neg.h, size: node.size ? node.size.slice() : null,
    minH: node.__pcMinH || 0,                                   // 节点高度的明确下限（第九十七批）
    chipsPos: (p.pos.chips || []).map(function (c) { return c.name; }),
    chipsNeg: (p.neg.chips || []).map(function (c) { return c.name; }),
    // ★ 2026-10-06 第一百零九批加的：胶囊的明细（名字 / 有没有被虚化 / 原文）+ 名字记忆 + 胶囊上那颗小减号
    chipsPosInfo: (p.pos.chips || []).map(function (c) { return { name: c.name, off: !!c.off, text: c.text }; }),
    chipsNegInfo: (p.neg.chips || []).map(function (c) { return { name: c.name, off: !!c.off, text: c.text }; }),
    chipNames: { pos: p.pos.chipNames || {}, neg: p.neg.chipNames || {} },
    // ★ 第一百四十五批：每一段"自己记着的名字"（收起→展开→再收起要继承的就是它）
    rangeNames: { pos: p.pos.r.map(function (x) { return x.n || ""; }), neg: p.neg.r.map(function (x) { return x.n || ""; }) },
    chipOffKeys: (function () {
      try {
        if (!node.__pcPanelEl) return [];
        return Array.prototype.map.call(node.__pcPanelEl.querySelectorAll(".pc-chip .pc-chip-off"),
          function (b) { return b.textContent; });
      } catch (e8) { return null; }
    })(),
    // ★ 2026-10-05 加的：两个文本框的实际宽高（验"一样宽""拖高时节点跟着长"都用它）
    boxW: (function () {
      try {
        return Array.prototype.map.call(node.__pcPanelEl.querySelectorAll("textarea.pc-ta"),
          function (t) { return Math.round(t.offsetWidth); });
      } catch (e4) { return null; }
    })(),
    boxH: (function () {
      try {
        return Array.prototype.map.call(node.__pcPanelEl.querySelectorAll("textarea.pc-ta"),
          function (t) { return Math.round(t.offsetHeight); });
      } catch (e5) { return null; }
    })(),
    panelH: node.__pcPanelEl ? Math.round(node.__pcPanelEl.offsetHeight) : 0,
    panelW: node.__pcPanelEl ? Math.round(node.__pcPanelEl.offsetWidth) : 0,
    panelVar: node.__pcPanelEl ? String(node.__pcPanelEl.style.getPropertyValue("--comfy-widget-height") || "") : "",
    collapsed: !!(node.flags && node.flags.collapsed),
    width: titleBarWidth(node), btn: collapseBtnRect(node),
    portNames: (node.inputs || []).map(function (x) { return x.name; }),
    panelVisible: !!(node.__pcPanelEl && node.__pcPanelEl.offsetHeight > 0),
    // ★ 批 C3（2026-10-06）：关键词权重那套（正/负两张表 / 两条藏起来的 JSON 控件 / 两颗按钮在不在）
    weights: (window.__pcWeights && window.__pcWeights.weightsOf)
      ? { pos: window.__pcWeights.weightsOf(node, "pos"), neg: window.__pcWeights.weightsOf(node, "neg") } : null,
    weightWidget: (function () {
      var a = textWidget(node, "正权重表"), b = textWidget(node, "负权重表");
      return {
        pos: a ? String(a.value == null ? "" : a.value) : null,
        neg: b ? String(b.value == null ? "" : b.value) : null,
      };
    })(),
    weightBtn: (function () {
      try {
        var p = node.__pcPanelEl;
        if (!p) return { pos: false, neg: false };
        return {
          pos: !!p.querySelector(".pc-clip-mid button.pc-weight-btn"),
          neg: !!p.querySelector(".pc-clip-foot button.pc-weight-btn"),
        };
      } catch (e7) { return { pos: false, neg: false }; }
    })(),
    star: (function () {
      try {
        var b = node.__pcPanelEl && node.__pcPanelEl.querySelector(".pc-frame .pc-star");
        if (!b) return null;
        var cs = (window.getComputedStyle ? window.getComputedStyle(b) : null);
        var box = b.getBoundingClientRect();
        var fr = b.parentElement ? b.parentElement.getBoundingClientRect() : null;
        return {
          bg: cs ? cs.backgroundColor : "",
          left: fr ? Math.round(box.left - fr.left) : null,     // 相对那个虚线框的左边距
          top: fr ? Math.round(box.top - fr.top) : null,
        };
      } catch (e6) { return null; }
    })(),
  };
};

// ==================== ★ 186 批：优化工具条（总开关 + ⚡/✎ + @ / @̸ + ⚙）====================
//   他原话：「CLIP 文本编码优化节点，如果想要使用提示词优化这个功能，需要开启开关，开关之后才会显现这些按钮，否则是没有的，
//   这样会显得简洁一些」「同款的快速优化和自定义优化，放在文本框上面的右边」「模式……然后在画师串按键旁边加一个 @ 号上面有一条斜线划痕的按钮，
//   点击之后就会忽略画师串效果」。
//   → @̸（忽略画师串）和 @（用画师串）**互斥**；点亮 @̸ = 这次优化绝对不动画师串。
function optUIOf(node) {
  try {
    var p = node.properties || (node.properties = {});
    var q = p.pcClip || (p.pcClip = {});
    if (!q.optUI || typeof q.optUI !== "object") q.optUI = { on: false, artist: false, noArtist: false };
    return q.optUI;
  } catch (e) { return { on: false, artist: false, noArtist: false }; }
}
function makeOptBar(node) {
  var bar = document.createElement("div");
  bar.className = "pc-optbar";
  bar.style.cssText = "display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:nowrap;justify-content:flex-end";

  // —— 五颗键：**先放容器、再放开关**，所以打开时它们是「从开关往左长出来」的 ——
  var box = document.createElement("span");
  box.className = "pc-optset";
  bar.appendChild(box);

  // ★ 191 批（他："勾选感觉有点丑了，就不能小圆钮开关吗"）→ 换成 toggle switch（轨道 + 圆滑块），
  //   位置放在这一行（小胶囊上面那一行）的**最右边**；打开时五颗键**向左展开**，不占额外高度。
  var sw = document.createElement("button");
  sw.type = "button";
  sw.className = "pc-sw";
  sw.setAttribute("role", "switch");
  sw.title = "提示词优化：打开之后这一行左边会冒出 ⚡ / ✎ / @ / @̸ / ⚙ 五颗键";
  var swT = document.createElement("span");
  swT.className = "pc-sw-t"; swT.textContent = "提示词优化";
  var swTr = document.createElement("span");
  swTr.className = "pc-sw-tr";
  var swK = document.createElement("i");
  swK.className = "pc-sw-k";
  swTr.appendChild(swK);
  sw.appendChild(swT); sw.appendChild(swTr);
  bar.appendChild(sw);

  function mkBtn(txt, title, extraCls) {
    var b = document.createElement("button");
    b.type = "button"; b.innerHTML = txt; b.title = title;
    b.className = extraCls || "";
    ["pointerdown", "mousedown", "dblclick", "contextmenu"].forEach(function (ev) {
      b.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    box.appendChild(b);
    return b;
  }
  function stopAll(el) {
    ["pointerdown", "mousedown", "dblclick", "contextmenu"].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
  }

  // ★ 191 批⑥（他："快速优化和自定义优化，要和工具端那样的，做好看一些"）→ 两半等宽的渐变胶囊
  var pair = document.createElement("span");
  pair.className = "pc-optpair";
  // ★ 192 批（他："小闪电前面有两个空格，后面有一个空格，笔前后都只有 0 个空格"）
  //   真因：两半等宽 + 内容居中 → 短的那半左右各空一截，看着像"多了几个空格"。
  //   修法：图标各给一个定宽格子，字前后不再写空格，左右两半分别贴外沿（start / end）。
  function mkHalf(ico, txt) {
    var b = document.createElement("button");
    b.type = "button";
    var i = document.createElement("i");
    i.className = "pc-optpi"; i.textContent = ico;
    var t = document.createElement("span");
    t.textContent = txt;
    b.appendChild(i); b.appendChild(t);
    b.__ico = i; b.__txt = t;             // ★ 2026-11-04：让状态行能改写这两截（⚡ ↔ ⏹）
    return b;
  }
  var bFast = mkHalf("⚡", "快速优化");
  try { node.__pcFast = { btn: bFast, ico: bFast.__ico, txt: bFast.__txt }; } catch (eFF) { /* 忽略 */ }
  bFast.title = "不用写要求，直接拿这一段去优化（结果直接写回文本框，不弹窗）";
  var bAsk = mkHalf("✎", "自定义优化");
  bAsk.title = "先写一句要求，再按它改写这一段";
  pair.appendChild(bFast); pair.appendChild(bAsk);
  stopAll(bFast); stopAll(bAsk);
  box.appendChild(pair);

  // ★ 191 批⑥（他："画师串、忽略画师串和优化小设置，全都只保留一个图标就行了，鼠标悬在上面会有文字提示"）
  var bArtist = mkBtn("@", "@ 画师串：开着 = 优化时允许它挑 / 换画师串，**同时文本框里的 @ 号会上色**（紫 = 未提权 / 金 = 已提权，点 @ 可切换）；灭着 = 只当普通文本，不上色（可以和右边那颗同时开）", "pc-oico");
  // ★ 191 批（他："忽略画师串的图标不行啊，要不你换一个，仍然有@元素就行"）
  //   → 还是 @，但上面压一道红斜线（自己画的，比原来的组合符清楚）
  // ★ 192 批：它和 @ 是**两件事**（@ = 可以添加 / @̸ = 把已有的画师串当无效），可以同时亮
  var bNoArtist = mkBtn('<span class="pc-atslash">@<i></i></span>',
    "@̸ 忽略画师串：点亮 = 这一段**拿去绘图时**把画师串筛掉（不参与作图）；优化时照常可以挑/换（和 @ 可以同时开）", "pc-oico no");
  var bGear = mkBtn("⚙", "优化小设置：拉黑 / 提权画师串、命中概率，还有和工具端的同步", "pc-oico");

  // ★ 190 批：进画布时先把共享的"画师规则"拉一次（⚙ 里改的、工具里改的都是这一份）
  try {
    fetch("/prompt_sync/store?key=artist", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.value && typeof j.value === "object") node.__artistRules = j.value; })
      .catch(function () { /* 接口没生效就算了，不影响别的 */ });
  } catch (e) { /* 忽略 */ }
  function paint() {
    var u = optUIOf(node);
    box.classList.toggle("on", !!u.on);
    sw.classList.toggle("on", !!u.on);
    sw.setAttribute("aria-checked", u.on ? "true" : "false");
    bArtist.classList.toggle("on", !!u.artist);
    bNoArtist.classList.toggle("on", !!u.noArtist);
    // ★ 200 批：状态小标签只在"提示词优化"开着时显示
    try { pcStatPaint(node); } catch (e) { /* 忽略 */ }
  }
  sw.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    var u = optUIOf(node); u.on = !u.on; paint();
  });
  // ★ 192 批（他："添加画师串和忽略画师串是可以同时出现的，毕竟忽略画师串是让画师串这个词无效化，
  //   忽略这个东西，不排斥添加"）→ **不再互斥**，两颗各点各的。
  bArtist.addEventListener("click", function () {
    var u = optUIOf(node); u.artist = !u.artist; paint();
    // ★ 273r：这颗键现在**同时就是 @ 号着色的总开关**（他不肯再多一颗按钮）
    try {
      if (node.__pcHl) Object.keys(node.__pcHl).forEach(function (k) { try { node.__pcHl[k].apply(); } catch (e2) { /* 忽略 */ } });
    } catch (e3) { /* 忽略 */ }
  });
  bNoArtist.addEventListener("click", function () {
    var u = optUIOf(node); u.noArtist = !u.noArtist; paint();
  });
  bGear.addEventListener("click", function () { openOptSettings(node); });
  bFast.addEventListener("click", function () {
    // ★ 他第 1 条（第二次澄清）：⚡ 永远是"快速优化"，不在优化中变中断 —— 中断交给节点上那颗小圆钮。
    optAskNode(node, "", bFast, "fast");
  });
  bAsk.addEventListener("click", function () { openAskNode(node); });
  paint();
  return bar;
}

// 把这一段交给"工具"去优化（工具侧在轮询 /prompt_sync/ai/pending，它有 AI 配置）
function clipTextOf(node, which) {
  try { return effectiveText(sideOf(node, which), node, which); } catch (e) { return ""; }
}
function setClipText(node, which, text) {
  try {
    var s = sideOf(node, which);
    var next = String(text || "");
    s.v = next;
    s.r = [{ s: 0, e: next.length, off: false }];
    // ★ 196 批（他："在优化的时候，竟然会把小胶囊里面的文本优化。小胶囊里面的文本应该不参与优化才对"）：
    //   发给 AI 的是**不含胶囊**的 v（见 optAskNode / clipRawText），所以这里也**不许把胶囊清掉**，
    //   只把它们的插入位置夹进新长度里（不然后面插回去会跑到越界的下标上）。
    (s.chips || []).forEach(function (c) {
      c.at = Math.max(0, Math.min(next.length, Number(c.at) || 0));
    });
    // ★ 2026-11-04：标记"这一段刚被优化过" → 虚线框上会挂 New（15 分钟，或他动手改字就清）
    try {
      node.__pcNewSeg = node.__pcNewSeg || {};
      node.__pcNewSeg[which] = { i: 0, until: Date.now() + 15 * 60 * 1000 };
    } catch (eN2) { /* 忽略 */ }
    if (typeof syncBackend === "function") syncBackend(node);
    if (typeof node.__pcRender === "function") node.__pcRender();
  } catch (e) { log("写回失败", e); }
}
// ★ 196 批：只取**文本框里那部分**（不含小胶囊、也不含被收起的段）——优化就只该动这里
function clipRawText(node, which) {
  try { return String(sideOf(node, which).v || ""); } catch (e) { return ""; }
}
function optAskNode(node, ask, btn, kind) {
  var u = optUIOf(node);
  // ★ 196 批：只优化**文本框里**那段（小胶囊里的文字不参与 —— 他明确要求的）
  var pos = clipRawText(node, "pos");
  // ★ 207 批（他："文本框空的时候也可以使用自定义优化，这样就是让 API 帮你从无到有写提示词了"）
  //   → 空框不再是错误，改成"从零写一段"
  var fromScratch = !pos.trim();
  // ★ 2026-11-04（他第 1 条）：这颗键**不再禁用、也不改文字** —— 优化中它由 pcStatPaint 统一画成
  //   「⏹ 中断」，点了就中断（否则改 textContent 会把 <i>⚡</i> + <span> 那两截一起冲掉）。
  pcWaveStart(node, kind);                             // ★ 195 批：优化中 → 正提示词那块亮起黄色波浪
                                                       // ★ 2026-11-03：kind 决定状态行显示 ⚡ 还是 ✎
  var body = { pos: pos, neg: clipRawText(node, "neg"), ask: ask || "", want: "pos",
               artist: optUIOf(node).artist ? 1 : 0 };            // ★ 285：画师串开关要告诉工具（没亮就别加画师）
  // ★ 287 批（他第 3 条）：自定义优化窗里那颗「顺便给出优化后的负提示词」勾选框是全局记着的，
  //   ⚡ 快速优化 也照它的状态来 —— 勾了就一起要负词、一起写回去。
  var wantNegQ = false;
  try { wantNegQ = localStorage.getItem("promptCopier.optAskNeg.v1") === "1"; } catch (eNQ) { wantNegQ = false; }
  if (wantNegQ) body.negWant = 1;
  var myAt = Date.now();                                   // ★ 275：中断令牌的比较基准
  if (fromScratch) body.ask = (body.ask ? body.ask + "；" : "") + "（现在正提示词框是空的）请按上面的要求，直接写一段完整可用的正提示词";
  body.ask = ((body.ask ? body.ask + "；" : "") + artistHintFor(node, u)).trim();
  fetch("/prompt_sync/ai/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(function (r) {
      if (!r.ok) throw new Error("接口回了 HTTP " + r.status + "（重启一次 ComfyUI 就有了）");
      return r.json();
    })
    .then(function (j) {
      var id = j && j.id;
      var tries = 0;
      (function poll() {
        // ★ 194b 批（他："两边都刷新过，工具那边还没接活"）：那条提示 99% 是**误报** —— AI 正常要十几秒，
        //   工具其实已经接活了。现在改成：先问一下共享黑板里那个「aiPicked」记号，
        //   记号里的 id 就是我这一条 = 工具接活了 → 一个字都不喊，安静等 AI 回。
        if (tries++ > 150) { pcWaveStop(); clipToast("等太久了 —— 提示词工具是不是没打开？（AI 是在工具里跑的）", true); try { pcStatPaint(node); } catch (eB) { /* 忽略 */ } return; }
        if (PC_OPT_STOP.at > myAt) { pcWaveStop(); try { pcStatPaint(node); } catch (eB) { /* 忽略 */ } return; }   // ★ 275：被中断就收手
        fetch("/prompt_sync/ai/result?id=" + id, { cache: "no-store" })
          .then(function (r2) { return r2.json(); })
          .then(function (res) {
            if (!res || !res.done) { setTimeout(poll, 700); return; }
            if (res.err) { pcWaveStop(); clipToast("优化失败：" + res.err, true); try { pcStatPaint(node); } catch (eB) { /* 忽略 */ } return; }
            // ⚠️ 2026-11-03 更正：接「暂存节点」的那个输出口长在「✎ 自定义优化窗」身上，
            //   不在这颗优化节点上（他：「而不是让优化节点从两个输出口变成三个」）。
            //   所以 ⚡ 快速优化这条路**永远照旧写回自己的文本框**。
            var negQ = String(res.neg || "").trim();
            setClipText(node, "pos", res.text);
            pcWaveStop();
            // ★ 2026-11-04（他第 7 条）：结果真写进文本框了 → 让计时器响一声（进暂存节点那条路不响）
            try { if (window.__pcTimerPing) window.__pcTimerPing("快速优化"); } catch (eTP) { /* 忽略 */ }
            // ★ 287：快速优化也要把负词写回去（勾了那颗勾选框、并且 AI 真的给了负词时）
            if (negQ) {
              var oldNegQ = clipRawText(node, "neg");
              setClipText(node, "neg", negQ);
              clipToast("正、负提示词都写回去了（负词原来的 " + String(oldNegQ || "").length + " 字已被替换，想退回用 ⇐ 撤销）");
            } else {
              clipToast("优化好了，已经写回正提示词框");
            }
          })
          .catch(function () { setTimeout(poll, 900); });
      })();
    })
    .catch(function (e) { pcWaveStop(); clipToast("请求失败：" + ((e && e.message) || e), true); })
    .then(function () { try { pcStatPaint(node); } catch (eB) { /* 忽略 */ } });
}

// ★ 189 批：✎ 弹"自定义优化窗（节点）" —— 和工具端那个窗一模一样、不连线、同时只允许一个
function openAskNode(node) {
  try {
    var all = (app.graph._nodes || []).filter(function (n) { return n && n.type === "PromptToolOptAsk"; });
    var mine = all.filter(function (n) {
      return n.properties && n.properties.pcOptAsk && n.properties.pcOptAsk.clip === node.id;
    })[0];
    if (mine) { try { app.canvas.selectNode(mine); } catch (e) {} clipToast("这一颗的自定义优化窗已经开着"); return; }
    // 只允许一个：别的（哪怕属于别颗节点）先删掉
    all.forEach(function (n) { try { app.graph.remove(n); } catch (e) { /* 忽略 */ } });
    // ★ 192 批（他："点击自定义优化会弹出自定义优化窗失败"）：真因和 LoRA 池"吐不出来"是同一个 ——
    //   `LiteGraph.createNode` 内部要用 `this.registered_node_types`，**拆出来单独存就丢了 this**，
    //   直接抛异常 → 节点建不出来。必须**当方法调**。
    var LG = window.LiteGraph;
    if (!LG || typeof LG.createNode !== "function") { clipToast("建不出「自定义优化窗」节点 —— 这个前端没有 LiteGraph.createNode", true); return; }
    var n2 = LG.createNode("PromptToolOptAsk");
    if (!n2) { clipToast("建不出「自定义优化窗」节点 —— 这颗节点没注册上（重启一次 ComfyUI 就有了）", true); return; }
    if (window.__pcOptAskInit) window.__pcOptAskInit(n2, node.id);
    n2.pos = [(node.pos ? node.pos[0] : 0) + (node.size ? node.size[0] : 700) + 40, (node.pos ? node.pos[1] : 0) + 40];
    app.graph.add(n2);
    try { app.canvas.selectNode(n2); } catch (e) { /* 忽略 */ }
  } catch (e) { clipToast("打开自定义优化窗失败：" + ((e && e.message) || e), true); }
}
// 给那颗窗用的两个钩子：读 / 写这颗优化节点某一侧的文本
window.__pcClipText = function (clipId, which) {
  try {
    var n = app.graph.getNodeById(clipId);
    if (!n) return "";
    // ★ 196 批：给"自定义优化窗"读的也是**不含小胶囊**的那段（小胶囊里的字不参与优化）
    return clipRawText(n, which || "pos");
  } catch (e) { return ""; }
};
window.__pcClipSetText = function (clipId, which, text) {
  try {
    var n = app.graph.getNodeById(clipId);
    if (!n) return false;
    setClipText(n, which || "pos", text);
    return true;
  } catch (e) { log("写回失败", e); return false; }
};
// ★ 191 批：给「自定义优化窗（节点）」用 —— 让它发的请求也带上画师规则（以前它一个字都没带）
window.__pcArtistHint = function (clipId) {
  try {
    var n = app.graph.getNodeById(clipId);
    if (!n) return "";
    return artistHintFor(n, optUIOf(n));
  } catch (e) { return ""; }
};
// ★ 192 批：给探针用的两个口（真前端上验 ⚙ 面板 / ✎ 节点，不用装假 DOM）
window.__pcOptSettings = function (clipId) {
  try { var n = app.graph.getNodeById(clipId); if (n) { openOptSettings(n); return true; } } catch (e) { /* 忽略 */ }
  return false;
};
window.__pcAskOpen = function (clipId) {
  try { var n = app.graph.getNodeById(clipId); if (n) { openAskNode(n); return true; } } catch (e) { /* 忽略 */ }
  return false;
};

// ==================== ★ 190 批：节点自己的「⚙ 优化小设置」====================
//   他："剩下的尾巴（⚙ 优化小设置还在去点工具那颗齿轮）→ 要做"
//   面板内容跟工具端一致：画师串黑名单 / 提权名单 / 命中概率；数据存在后端黑板 key=artist（和工具共用一份）。
function artistHintFor(node, u) {
  var r = node.__artistRules || {};
  var out = [];
  if (r.black && r.black.length) out.push("【画师黑名单】这些画师串绝对不许用、也不许推荐：" + r.black.join("、") + "。");
  if (r.boost && r.boost.length) {
    // ★ 205 批（他："提权的画师串设了 50% 结果还是 100%"）：**这里不再写概率** —— 概率由工具端
    //   掷骰子后决定这一次走哪条（`optBoostThisRun`），节点这边只负责把名单带过去。
    //   以前两边都写概率，模型看到"50% 从这几个里挑"就每次都挑，看着像 100%。
    out.push("【画师提权名单】需要挑画师串时，优先在这几个里考虑：" + r.boost.join("、")
      + "（这一次到底用不用这几个，工具那边会另外给出明确指令，以那条为准）。");
  }
  // ★ 2026-11-04（他第 6 条）：专门提权那一批单独交代一句（@ 金色呼吸的那几条）
  if (r.boost2 && r.boost2.length) {
    out.push("【专门提权的画师串】这几条是最希望出现的：" + r.boost2.join("、")
      + "（到底用不用、什么时候用，工具那边会掷骰子后给出明确指令，以那条为准）。");
  }
  // ★ 192 批：@ 和 @̸ 不再互斥
  // ★ 197 批②（他澄清语义）：**@̸ = 出图时把画师串筛掉**（`syncBackend` 里做），
  //   优化时**照常允许**挑/换画师串 —— 所以这里不再叫 AI "别加/去掉"，只保留 @ 那一句。
  if (u && u.artist && (!r.boost || !r.boost.length)) {
    out.push("【画师串可以按需挑一个】");
  }
  return out.join(" ");
}
function openOptSettings(node) {
  var old = document.getElementById("pcOptSetBack");
  if (old) { old.remove(); return; }
  var back = document.createElement("div");
  back.id = "pcOptSetBack";
  back.style.cssText = "position:fixed;inset:0;z-index:99998;background:rgba(10,14,22,.55);"
    + "display:flex;align-items:center;justify-content:center";
  var card = document.createElement("div");
  card.style.cssText = "width:min(560px,92vw);max-height:86vh;overflow:auto;background:#1d2230;color:#e8eaf1;"
    + "border:1px solid rgba(150,162,180,.45);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5);"
    + "padding:16px 18px;font:12.5px/1.7 system-ui,'Microsoft YaHei',sans-serif";
  var title = document.createElement("div");
  title.textContent = "⚙ 优化小设置（这颗节点用）";
  title.style.cssText = "font-size:14px;font-weight:700;margin-bottom:4px";
  var sub = document.createElement("div");
  sub.textContent = "这里的规则和「提示词工具」里那份是同一份（走共享黑板），改哪边都一样。";
  sub.style.cssText = "font-size:11.5px;opacity:.7;margin-bottom:10px";
  card.appendChild(title); card.appendChild(sub);

  function block(txt, hint) {
    var b = document.createElement("div");
    b.style.cssText = "margin-top:10px";
    var h = document.createElement("div");
    h.textContent = txt;
    h.style.cssText = "font-size:12px;font-weight:700;margin-bottom:4px";
    var p = document.createElement("div");
    p.textContent = hint;
    p.style.cssText = "font-size:11px;opacity:.6;margin-bottom:5px";
    b.appendChild(h); b.appendChild(p);
    return b;
  }
  var taStyle = "width:100%;box-sizing:border-box;height:64px;resize:vertical;font:inherit;font-size:12px;"
    + "padding:7px 9px;border-radius:9px;border:1px solid rgba(150,162,180,.45);background:rgba(0,0,0,.22);color:#e8eaf1";

  var bBlack = block("🚫 拉黑的画师串（不许用）", "一行一个，带不带 @ 都行");
  var tBlack = document.createElement("textarea"); tBlack.style.cssText = taStyle;
  bBlack.appendChild(tBlack); card.appendChild(bBlack);

  var bBoost = block("⭐ 提权的画师串（优先用）", "一行一个；需要挑画师串时优先从这些里挑");
  var tBoost = document.createElement("textarea"); tBoost.style.cssText = taStyle;
  bBoost.appendChild(tBoost); card.appendChild(bBoost);

  // ★ 2026-11-04（他第 6 条）：专门提权（@ 金色 + 呼吸灯）+ 自己的概率（占用总概率）
  var bTop = block("🌟 专门提权的画师串（金色 @ + 呼吸灯）", "一行一个；这一批的 @ 号会金色呼吸，其它提权的 @ 是静止的");
  var tTop = document.createElement("textarea"); tTop.style.cssText = taStyle;
  bTop.appendChild(tTop); card.appendChild(bTop);

  var bProb = block("用到授权画师串的概率", "所有授权共享这一个概率（10% 一格）");
  var rowP = document.createElement("div");
  rowP.style.cssText = "display:flex;align-items:center;gap:10px";
  var range = document.createElement("input");
  range.type = "range"; range.min = "0"; range.max = "100"; range.step = "10"; range.value = "100";
  range.style.cssText = "flex:1 1 auto;accent-color:#7c5cff";
  var pv = document.createElement("b"); pv.textContent = "100%";
  pv.style.cssText = "color:#8ea2ff;min-width:44px;text-align:right";
  range.addEventListener("input", function () { pv.textContent = range.value + "%"; syncTopMax(); });
  rowP.appendChild(range); rowP.appendChild(pv);
  bProb.appendChild(rowP); card.appendChild(bProb);

  // ★ 他第 6 条：「设置专门用到画师串的概率，概率不能高于所有画师串用到授权画师串的概率，
  //   并且专门的概率会占用那个总概率」→ 这根滑条的上限**跟着上面那根走**，永远不会超过它。
  var bProbTop = block("专门提权那几条的概率", "从上面那个总概率里占用：总 60% + 专门 40% 时，40% 走专门这几条、20% 走其它授权");
  var rowPT = document.createElement("div");
  rowPT.style.cssText = "display:flex;align-items:center;gap:10px";
  var range2 = document.createElement("input");
  range2.type = "range"; range2.min = "0"; range2.max = "100"; range2.step = "10"; range2.value = "0";
  range2.style.cssText = "flex:1 1 auto;accent-color:#ffcf5c";
  var pv2 = document.createElement("b"); pv2.textContent = "0%";
  pv2.style.cssText = "color:#ffcf5c;min-width:44px;text-align:right";
  function syncTopMax() {
    var cap = Math.max(0, Math.min(100, parseInt(range.value, 10) || 0));
    range2.max = String(cap);
    if ((parseInt(range2.value, 10) || 0) > cap) range2.value = String(cap);
    pv2.textContent = (parseInt(range2.value, 10) || 0) + "%";
  }
  range2.addEventListener("input", function () { pv2.textContent = (parseInt(range2.value, 10) || 0) + "%"; });
  rowPT.appendChild(range2); rowPT.appendChild(pv2);
  bProbTop.appendChild(rowPT); card.appendChild(bProbTop);

  // ★ 273d 批：把这份画师规则搬去工具端（或搬回来）—— 生成一段码 / 粘贴一段码
  var bCode = block("🔁 把这段码搬到工具端（或搬回来）",
    "点「生成码」就直接复制到剪贴板；到工具端「画师规则」里把码粘进那个框就生效（反过来也一样）。码里带拉黑 + 提权 + 概率。");
  var tCode = document.createElement("textarea");
  tCode.style.cssText = taStyle + ";height:56px;font-family:Consolas,monospace;font-size:11px";
  tCode.setAttribute("data-pcartcode", "1");
  bCode.appendChild(tCode);
  var codeRow = document.createElement("div");
  codeRow.style.cssText = "display:flex;gap:8px;margin-top:6px";
  var cMake = document.createElement("button");
  cMake.type = "button"; cMake.textContent = "📋 生成码（复制到剪贴板）";
  cMake.style.cssText = "font-family:inherit;font-size:11.5px;padding:5px 11px;border-radius:8px;cursor:pointer;"
    + "border:1px solid rgba(120,180,255,.6);background:rgba(96,166,255,.16);color:#cfe4ff";
  codeRow.appendChild(cMake);
  bCode.appendChild(codeRow);
  card.appendChild(bCode);

  var foot = document.createElement("div");
  foot.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px";
  var state = document.createElement("span");
  state.style.cssText = "flex:1 1 auto;font-size:11.5px;opacity:.7;align-self:center";
  // ★ 191 批（他："提示词优化里面的数据并没有互通啊，要不设置一个同步键"）→ 这一颗就是那颗同步键
  var sync = document.createElement("button");
  sync.type = "button"; sync.textContent = "🔄 现在同步一次";
  sync.title = "先推上去，再把较新的那份读回来（谁最后改的用谁的）";
  sync.style.cssText = "font-family:inherit;font-size:12px;padding:6px 14px;border-radius:9px;cursor:pointer;"
    + "border:1px solid rgba(120,180,255,.6);background:rgba(96,166,255,.16);color:#cfe4ff";
  var save = document.createElement("button");
  save.type = "button"; save.textContent = "保存";
  save.style.cssText = "font-family:inherit;font-size:12.5px;font-weight:700;padding:7px 16px;border-radius:9px;"
    + "border:none;color:#fff;cursor:pointer;background:linear-gradient(135deg,#7c5cff,#3b82f6)";
  var close = document.createElement("button");
  close.type = "button"; close.textContent = "关闭";
  close.style.cssText = "font-family:inherit;font-size:12px;padding:6px 14px;border-radius:9px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1";
  foot.appendChild(state); foot.appendChild(close); foot.appendChild(save);
  card.appendChild(foot);
  back.appendChild(card);
  document.body.appendChild(back);
  function shut() { try { back.remove(); } catch (e) { /* 忽略 */ } }
  close.addEventListener("click", shut);
  back.addEventListener("click", function (e) { if (e.target === back) shut(); });

  function norm(t) {
    return String(t || "").split(/\n+/).map(function (x) {
      x = String(x).trim().replace(/^@@+/, "@");
      if (!x) return "";
      return x.charAt(0) === "@" ? x : ("@" + x);
    }).filter(Boolean).slice(0, 80);
  }
  function fill(r) {
    r = r || {};
    tBlack.value = (r.black || []).join("\n");
    tBoost.value = (r.boost || []).join("\n");
    tTop.value = (r.boost2 || []).join("\n");
    var pr = (typeof r.prob === "number" ? r.prob : 100);
    range.value = String(pr); pv.textContent = pr + "%";
    var bt = (typeof r.boostProb === "number" ? r.boostProb : 0);
    range2.value = String(Math.max(0, Math.min(pr, bt)));
    syncTopMax();
  }
  function artEmpty(r) {
    return !(r && typeof r === "object" && ((r.black && r.black.length) || (r.boost && r.boost.length)));
  }
  // ★ 273i 批（他："一边更新画师串，另外一边并不会同步；一边删掉，另外一边居然会同步 ——
  //   就应改成都不同步才对"）→ 这里不再往黑板推，两端只靠「码」互通
  function pushArtist(v) { return Promise.resolve(); }
  fill(node.__artistRules);
  state.textContent = "两端不再自动同步 —— 要搬就点「📋 生成码」到另一端的框里粘贴";
  // ★ 273i 批：**不再去黑板核对 / 推送**（打开面板就是本机这一份，两端互不影响）

  // ★ 273d/273g 批（他："生成码点击之后直接提示已经复制到剪贴板了，没必要在文本框再展现一遍" +
  //   "接收端往文本框里粘贴就直接生效，没必要再按一下从码导入，把这个按钮删了吧"）
  function applyCode(txt) {
    var v = pcArtUnpack(txt);
    if (!v || typeof v !== "object") {
      state.textContent = "这段码看不懂 —— 是不是没复制全（要从 PCAR1: 一直到结尾）？";
      return false;
    }
    var rules = {
      black: norm((v.black || []).join("\n")),
      boost: norm((v.boost || []).join("\n")),
      boost2: norm((v.boost2 || []).join("\n")),
      prob: (typeof v.prob === "number") ? Math.max(0, Math.min(100, v.prob)) : 100,
      boostProb: (typeof v.boostProb === "number") ? Math.max(0, v.boostProb) : 0,
      at: Date.now(),
    };
    rules.boostProb = Math.min(rules.prob, rules.boostProb);
    fill(rules);
    node.__artistRules = rules;
    pushArtist(rules)
      .then(function () {
        state.textContent = "已从码导入并推给工具端：拉黑 " + rules.black.length + " / 提权 "
          + rules.boost.length + " / 概率 " + rules.prob + "%";
      })
      .catch(function () { state.textContent = "已从码导入（但推给工具端失败，接口可能要重启 ComfyUI）"; });
    return true;
  }
  cMake.addEventListener("click", function () {
    var rules = { black: norm(tBlack.value), boost: norm(tBoost.value), boost2: norm(tTop.value),
      prob: Math.round((parseInt(range.value, 10) || 0) / 10) * 10, at: Date.now() };
    rules.boostProb = Math.min(rules.prob, Math.round((parseInt(range2.value, 10) || 0) / 10) * 10);
    node.__artistRules = rules;
    var code = pcArtPack(rules);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code);
    } catch (e) { /* 忽略 */ }
    state.textContent = "已复制到剪贴板（" + code.length + " 字：拉黑 " + rules.black.length
      + " / 提权 " + rules.boost.length + " / 概率 " + rules.prob + "%）—— 去工具端「画师规则」那个框里粘贴";
  });
  tCode.addEventListener("paste", function (e) {
    var txt = "";
    try {
      var cd = e.clipboardData || window.clipboardData;
      txt = cd ? String(cd.getData("text") || "") : "";
    } catch (err) { txt = ""; }
    if (!txt.trim()) return;                     // 没文字就走原生
    e.preventDefault();                          // 不往框里留东西
    tCode.value = "";
    applyCode(txt);
  });
  save.addEventListener("click", function () {
    var rules = { black: norm(tBlack.value), boost: norm(tBoost.value), boost2: norm(tTop.value),
      prob: Math.round((parseInt(range.value, 10) || 0) / 10) * 10, at: Date.now() };
    rules.boostProb = Math.min(rules.prob, Math.round((parseInt(range2.value, 10) || 0) / 10) * 10);
    node.__artistRules = rules;
    fetch("/prompt_sync/store", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "artist", value: rules }) })
      .then(function () { state.textContent = "已保存（和工具端共用这一份）"; })
      .catch(function () { state.textContent = "保存失败（接口没生效？）"; });
  });
  // ★ 191 批：同步键 —— 推上去 + 把较新的那份读回来；★ 192 批：空的永远不作数
  sync.addEventListener("click", function () {
    state.textContent = "正在对……";
    var mine = { black: norm(tBlack.value), boost: norm(tBoost.value), boost2: norm(tTop.value),
      prob: Math.round((parseInt(range.value, 10) || 0) / 10) * 10, at: Date.now() };
    mine.boostProb = Math.min(mine.prob, Math.round((parseInt(range2.value, 10) || 0) / 10) * 10);
    var mineEmpty = artEmpty(mine);
    fetch("/prompt_sync/store?key=artist", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var v = (j && j.value && typeof j.value === "object") ? j.value : null;
        var he = artEmpty(v);
        var his = (v && typeof v.at === "number") ? v.at : 0;
        var myAt = (node.__artistRules && typeof node.__artistRules.at === "number") ? node.__artistRules.at : 0;
        if (mineEmpty && !he) {                       // 这边空、黑板有 → 读回来（绝不拿空壳覆盖）
          node.__artistRules = v; fill(v);
          state.textContent = "这边是空的 —— 已读回工具端那份";
          return;
        }
        if (!mineEmpty && he) {                       // 这边有、黑板空 → 推上去
          return pushArtist(mine).then(function () { node.__artistRules = mine; state.textContent = "工具端是空的 —— 已把这边这份推上去"; });
        }
        if (!mineEmpty && !he && his > myAt) {        // 两边都有 → 谁新用谁
          node.__artistRules = v; fill(v);
          state.textContent = "已读回工具端那份（它比你这边新）";
          return;
        }
        return pushArtist(mine).then(function () { node.__artistRules = mine; state.textContent = "已把这边这份推给工具端"; });
      })
      .catch(function () { state.textContent = "对不上（接口没生效？重启一次 ComfyUI 再试）"; });
  });
}
