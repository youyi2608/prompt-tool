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
    labEl.appendChild(box);
    node.__pcStat = box; node.__pcL1 = c1; node.__pcL2 = c2;
    return box;
  } catch (e) { return null; }
}
function pcStatPaint(node) {
  try {
    if (!node) return;
    var box = pcStatMake(node);
    if (!box) return;
    box.style.display = "flex";                 // ★ 202 批：不再跟「提示词优化」开关联动
    var now = Date.now();
    var live = PC_STAT.pingAt && (now - PC_STAT.pingAt < 90000);
    var l1 = node.__pcL1, l2 = node.__pcL2;
    if (l1) {
      l1.textContent = live ? "● 工具端：已连接" : "○ 工具端：未连接";
      l1.style.color = live ? "#5fe08f" : "rgba(170,178,196,.62)";
      l1.style.fontWeight = live ? "700" : "400";
    }
    if (l2) {
      var busy = !!node.__pcBusy;
      if (busy) {
        if (!l2.querySelector(".pc-spin")) {
          l2.innerHTML = "";
          var sp = document.createElement("span");
          sp.className = "pc-spin";
          sp.style.width = "9px"; sp.style.height = "9px";
          sp.style.marginRight = "5px"; sp.style.verticalAlign = "-1px";
          l2.appendChild(sp);
          l2.appendChild(document.createTextNode("正在优化提示词…"));
        }
        l2.style.color = "#f0a52b";
        l2.style.fontWeight = "700";
      } else {
        l2.textContent = "空闲";
        l2.style.color = "rgba(170,178,196,.62)";
        l2.style.fontWeight = "400";
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
    }
  } catch (e) { /* 忽略 */ }
  if (!PC_STAT.timer) PC_STAT.timer = setInterval(pcStatTick, 3000);
}
// 优化开始 / 结束：只动"这一条"的状态（不再播放任何波浪动画）
function pcStatusBusy(node, on) {
  try {
    if (!node) return;
    node.__pcBusy = !!on;
    pcStatMake(node);
    pcStatPaint(node);
  } catch (e) { /* 忽略 */ }
}
function pcWaveStart(node) { pcStatusBusy(node, true); }
function pcWaveStop() {
  try {
    var all = (app.graph && app.graph._nodes) || [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (!n) continue;
      if (n.__pcBusy) { n.__pcBusy = false; pcStatPaint(n); }
    }
  } catch (e) { /* 忽略 */ }
}
window.__pcOptWave = {
  show: function (clipId) { try { var n = app.graph.getNodeById(clipId); if (n) pcStatusBusy(n, true); return !!n; } catch (e) { return false; } },
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
    // 文本框（字透明）+ 背后那层"真正显示文字"的镜像 + 最上面那层虚线矩形
    ".pc-ta-wrap{position:relative;display:block;}",
    ".pc-ta{position:relative;z-index:1;display:block;width:100%;box-sizing:border-box;",
    "background:transparent;color:transparent;caret-color:#7fb0ff;",
    "font-family:inherit;font-size:12px;line-height:1.45;",
    "border:1px solid rgba(150,170,210,.45);border-radius:8px;padding:6px 8px;outline:none;",
    "resize:both;min-height:60px;min-width:120px;max-width:100%;white-space:pre-wrap;word-break:break-word;}",
    ".pc-ta::placeholder{color:#8892a6;opacity:.95;}",
    ".pc-mirror{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;z-index:2;}",
    ".pc-mirror-in{color:#e8ecf5;font-family:inherit;font-size:12px;line-height:1.45;border:1px solid transparent;",
    "border-radius:8px;padding:6px 8px;white-space:pre-wrap;word-break:break-word;box-sizing:border-box;}",
    ":root[data-theme=\"light\"] .pc-mirror-in{color:#2b3040;}",
    ".pc-mk{color:inherit;}",
    ".pc-mk.off{opacity:.5;}",
    // 「换掉这一段」成功之后，把那一段文字轻轻亮一下（像小助手那样"更新并高亮"）
    ".pc-mk.flash{animation:pcFlash .9s ease-out;}",
    "@keyframes pcFlash{0%{background:rgba(130,225,170,.45);border-radius:4px}100%{background:transparent}}",
    // 虚线矩形那层（每一段一个长方形，框自己不吃鼠标，只有三颗小键吃）
    ".pc-frames{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:3;}",
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
    ".pc-clip-mid{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:1px 0 2px;}",
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
function effectiveText(side) {
  var evs = [];
  side.r.forEach(function (r) { if (r.off) evs.push({ s: r.s, e: r.e, t: null }); });
  (side.chips || []).forEach(function (c) { if (!c.off) evs.push({ s: c.at, e: c.at, t: c.text }); });
  evs.sort(function (a, b) { return a.s - b.s; });
  var out = "", pos = 0;
  evs.forEach(function (r) {
    if (r.s > pos) out += side.v.slice(pos, r.s);
    if (r.t !== null) out += r.t;
    pos = Math.max(pos, r.e);
  });
  out += side.v.slice(pos);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
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
      var ta = w.element.querySelector("textarea");
      if (ta) ta.value = val;
    }
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
function syncBackend(node) {
  var collapsed = !!(node.flags && node.flags.collapsed);
  var wPos = textWidget(node, "正提示词") || textWidget(node, "text");   // text = 老版后端的那个控件
  var wNeg = textWidget(node, "负提示词");
  var posTxt = effectiveText(sideOf(node, "pos"));
  var negTxt = effectiveText(sideOf(node, "neg"));
  try {
    var u = optUIOf(node);
    if (u && u.noArtist) { posTxt = stripArtistTokens(posTxt); negTxt = stripArtistTokens(negTxt); }
  } catch (e) { /* 忽略 */ }
  writeWidget(wPos, collapsed ? "" : posTxt);
  writeWidget(wNeg, collapsed ? "" : negTxt);
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
    var mIn = document.createElement("div");
    mIn.className = "pc-mirror-in";
    mirror.appendChild(mIn);
    var frames = document.createElement("div");
    frames.className = "pc-frames";
    wrap.appendChild(ta);
    wrap.appendChild(mirror);
    wrap.appendChild(frames);

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
    return sec;
  }

  var posSec = buildSide("pos", "正提示词", "（粘贴进来的每一段会自动套一个虚线框）", "把正提示词粘在这里；一段一个虚线框");
  // ★ 191 批：工具条挂到「小胶囊上面那一行」的末尾（靠右；开关在最右，五颗键往左长）
  try {
    var posLab = posSec ? posSec.querySelector(".pc-clip-lab") : null;
    if (posLab) posLab.appendChild(optBar);
    else panel.appendChild(optBar);
  } catch (e) { try { panel.appendChild(optBar); } catch (e2) { /* 忽略 */ } }
  // ★ 197 批：**不再单独占一条**（他："不要额外占用位置"）。波浪改成优化时浮上去的一层，
  //   面板只留一个引用（`node.__pcPanel`），浮层由 pcWaveStart 现建现删，平时这里什么都没有。
  try { node.__pcPanel = panel; } catch (e) { /* 忽略 */ }
  // ★★ 208 批：小胶囊那一栏下面再加一行「伴随位」（灰字提示 + 小加号 + ！说明）
  //   规则：池子里有亮着的 LoRA 时小加号才可点；点开后选「一颗亮着的 LoRA」+「一个小胶囊」= 一颗伴随小胶囊；
  //   LoRA 一关掉 / 那个小胶囊没了 → 自动隐藏。
  try {
    var compRow = document.createElement("div");
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
    compRow.appendChild(compLab); compRow.appendChild(compAdd); compRow.appendChild(compHelp); compRow.appendChild(compList);
    // ★ 209 批（他："伴随位放到小胶囊上面"）：插在小胶囊那一行**之前**（即紧跟正提示词那一行）
    var chipRowEl = posSec.querySelector(".pc-chips");
    if (chipRowEl && chipRowEl.parentNode === posSec) posSec.insertBefore(compRow, chipRowEl);
    else posSec.insertBefore(compRow, posSec.querySelector(".pc-ta-wrap"));
    node.__pcComp = { add: compAdd, list: compList };
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
        b.textContent = "@" + String(c.lora).replace(/\.safetensors$/i, "") + " × " + String(c.chip).slice(0, 12);
        b.title = "伴随小胶囊：" + c.chip + "（绑定 " + c.lora + "；点一下取消）";
        b.style.cssText = "display:inline-flex;align-items:center;max-width:220px;padding:2px 7px;border-radius:999px;"
          + "border:1px solid rgba(236,72,153,.55);background:rgba(236,72,153,.14);color:#ffc9e2;"
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
      var s2 = mkSel("小胶囊", chips.map(function (t, i) { return { v: t, t: (String(t).slice(0, 24) || ("胶囊" + (i + 1))) }; }));
      var row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px";
      var cancel = document.createElement("button");
      cancel.type = "button"; cancel.textContent = "取消";
      cancel.style.cssText = "height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
        + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.07);color:#e8eaf1";
      var ok = document.createElement("button");
      ok.type = "button"; ok.textContent = "配好";
      ok.style.cssText = "height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
        + "border:1px solid rgba(236,72,153,.7);background:rgba(236,72,153,.24);color:#ffd8ea";
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
  panel.appendChild(midBar);

  buildSide("neg", "负提示词", "（在下面；同样，粘贴进来的才套框）", "把负提示词粘在这里");

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
      box.className = "pc-frame" + (r.off ? " off" : "") + (isShort ? " short" : "");
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
    (side.chips || []).forEach(function (c) {
      var el = document.createElement("span");
      el.className = "pc-chip " + (which === "pos" ? "pos" : "neg") + (c.off ? " off" : "");
      el.title = "* 收起来的一段" + (c.off ? "（这段现在**不参与生图**，跟点了小减号一样；展开回去可以再点 ＋ 让它回来）" : "（照样参与生图，只是显示上收起来了）")
        + "：\n" + c.text.slice(0, 240) + (c.text.length > 240 ? "…" : "")
        + "\n\n点名字可以改名字 · 点 − 让它先不参与生图 · 点左边的 ◀ 挪到最前面"
        + " · 点右边的 ↩ 展开回文本框（展开后它会自己另起一排放在最上面）";
      // ★ 第一百四十五批（他第 2 条）：向左的小箭头 = **挪到第一个**
      //   第一百四十六批（他第 3 条）：「胶囊的小箭头太大了，小一点」→ 字号 11 → **9px**
      //   （小归小，还是留了 2px 内边距，点得中）
      var toFirst = document.createElement("button");
      toFirst.type = "button"; toFirst.className = "pc-chip-first"; toFirst.textContent = "◀";
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
      nm.title = "点一下改名（名字会记住）";
      nm.addEventListener("click", function (e2) {
        e2.preventDefault(); e2.stopPropagation();
        startChipRename(el, nm, c, which);
      });
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
      el.appendChild(toFirst); el.appendChild(off); el.appendChild(nm); el.appendChild(bk);
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
  }

  function afterEdit(which) {
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
        // ④ 面板
        const panel = makePanel(node);
        if (typeof node.addDOMWidget === "function") {
          node.__pcPanelWidget = node.addDOMWidget("提示词", "pcClipPanel", panel, { serialize: false, hideOnZoom: false });
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
    posOut: effectiveText(p.pos), negOut: effectiveText(p.neg),
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
    return b;
  }
  var bFast = mkHalf("⚡", "快速优化");
  bFast.title = "不用写要求，直接拿这一段去优化（结果直接写回文本框，不弹窗）";
  var bAsk = mkHalf("✎", "自定义优化");
  bAsk.title = "先写一句要求，再按它改写这一段";
  pair.appendChild(bFast); pair.appendChild(bAsk);
  stopAll(bFast); stopAll(bAsk);
  box.appendChild(pair);

  // ★ 191 批⑥（他："画师串、忽略画师串和优化小设置，全都只保留一个图标就行了，鼠标悬在上面会有文字提示"）
  var bArtist = mkBtn("@", "@ 画师串：开着 = 优化时允许它挑 / 换画师串（可以和右边那颗同时开）", "pc-oico");
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
  });
  bNoArtist.addEventListener("click", function () {
    var u = optUIOf(node); u.noArtist = !u.noArtist; paint();
  });
  bGear.addEventListener("click", function () { openOptSettings(node); });
  bFast.addEventListener("click", function () { optAskNode(node, "", bFast); });
  bAsk.addEventListener("click", function () { openAskNode(node); });
  paint();
  return bar;
}

// 把这一段交给"工具"去优化（工具侧在轮询 /prompt_sync/ai/pending，它有 AI 配置）
function clipTextOf(node, which) {
  try { return effectiveText(sideOf(node, which)); } catch (e) { return ""; }
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
    if (typeof syncBackend === "function") syncBackend(node);
    if (typeof node.__pcRender === "function") node.__pcRender();
  } catch (e) { log("写回失败", e); }
}
// ★ 196 批：只取**文本框里那部分**（不含小胶囊、也不含被收起的段）——优化就只该动这里
function clipRawText(node, which) {
  try { return String(sideOf(node, which).v || ""); } catch (e) { return ""; }
}
function optAskNode(node, ask, btn) {
  var u = optUIOf(node);
  // ★ 196 批：只优化**文本框里**那段（小胶囊里的文字不参与 —— 他明确要求的）
  var pos = clipRawText(node, "pos");
  // ★ 207 批（他："文本框空的时候也可以使用自定义优化，这样就是让 API 帮你从无到有写提示词了"）
  //   → 空框不再是错误，改成"从零写一段"
  var fromScratch = !pos.trim();
  var btnTxt = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "优化中…"; }
  pcWaveStart(node);                                   // ★ 195 批：优化中 → 正提示词那块亮起黄色波浪
  var body = { pos: pos, neg: clipRawText(node, "neg"), ask: ask || "", want: "pos" };
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
        if (tries++ > 150) { pcWaveStop(); clipToast("等太久了 —— 提示词工具是不是没打开？（AI 是在工具里跑的）", true); if (btn) { btn.disabled = false; btn.textContent = btnTxt; } return; }
        fetch("/prompt_sync/ai/result?id=" + id, { cache: "no-store" })
          .then(function (r2) { return r2.json(); })
          .then(function (res) {
            if (!res || !res.done) { setTimeout(poll, 700); return; }
            if (res.err) { pcWaveStop(); clipToast("优化失败：" + res.err, true); if (btn) { btn.disabled = false; btn.textContent = btnTxt; } return; }
            setClipText(node, "pos", res.text);
            pcWaveStop();
            clipToast("优化好了，已经写回正提示词框");
          })
          .catch(function () { setTimeout(poll, 900); });
      })();
    })
    .catch(function (e) { pcWaveStop(); clipToast("请求失败：" + ((e && e.message) || e), true); })
    .then(function () { if (btn) { btn.disabled = false; btn.textContent = btnTxt; } });
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

  var bProb = block("用到授权画师串的概率", "所有授权共享这一个概率（10% 一格）");
  var rowP = document.createElement("div");
  rowP.style.cssText = "display:flex;align-items:center;gap:10px";
  var range = document.createElement("input");
  range.type = "range"; range.min = "0"; range.max = "100"; range.step = "10"; range.value = "100";
  range.style.cssText = "flex:1 1 auto;accent-color:#7c5cff";
  var pv = document.createElement("b"); pv.textContent = "100%";
  pv.style.cssText = "color:#8ea2ff;min-width:44px;text-align:right";
  range.addEventListener("input", function () { pv.textContent = range.value + "%"; });
  rowP.appendChild(range); rowP.appendChild(pv);
  bProb.appendChild(rowP); card.appendChild(bProb);

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
  foot.appendChild(state); foot.appendChild(sync); foot.appendChild(close); foot.appendChild(save);
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
    var pr = (typeof r.prob === "number" ? r.prob : 100);
    range.value = String(pr); pv.textContent = pr + "%";
  }
  function artEmpty(r) {
    return !(r && typeof r === "object" && ((r.black && r.black.length) || (r.boost && r.boost.length)));
  }
  function pushArtist(v) {
    return fetch("/prompt_sync/store", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "artist", value: v }) });
  }
  fill(node.__artistRules);
  state.textContent = "正在读共享设置…";
  // ★ 192 批（他："如果两边的优化小设置有一边是空的，那么空白的不能推到已有内容的"）
  //   → 打开面板时**绝不用空白把这里冲掉**：黑板空、这边有 → 把这边推上去；两边都有 → 谁新用谁。
  fetch("/prompt_sync/store?key=artist", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var v = (j && j.value && typeof j.value === "object") ? j.value : null;
      var mine = node.__artistRules || null;
      var me = artEmpty(mine), he = artEmpty(v);
      var mat = (mine && typeof mine.at === "number") ? mine.at : 0;
      var hat = (v && typeof v.at === "number") ? v.at : 0;
      if (he && !me) {
        pushArtist(mine).then(function () { state.textContent = "黑板上是空的 —— 已把这边这份推上去（没被冲掉）"; })
          .catch(function () { state.textContent = "黑板上是空的，但推上去失败了（接口要重启 ComfyUI）"; });
        return;
      }
      if (!he && (me || hat >= mat)) { node.__artistRules = v; fill(v); state.textContent = "已和工具端同步"; return; }
      if (!he && !me && mat > hat) {
        pushArtist(mine).then(function () { state.textContent = "这边更新 —— 已推给工具端"; })
          .catch(function () { state.textContent = "推上去失败（接口要重启 ComfyUI）"; });
        return;
      }
      state.textContent = "两边都还没有内容 —— 填好点「保存」就同步给工具端";
    })
    .catch(function () { state.textContent = "读共享设置失败（接口要重启 ComfyUI 才有）"; });

  save.addEventListener("click", function () {
    var rules = { black: norm(tBlack.value), boost: norm(tBoost.value), prob: Math.round((parseInt(range.value, 10) || 0) / 10) * 10, at: Date.now() };
    node.__artistRules = rules;
    fetch("/prompt_sync/store", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "artist", value: rules }) })
      .then(function () { state.textContent = "已保存（和工具端共用这一份）"; })
      .catch(function () { state.textContent = "保存失败（接口没生效？）"; });
  });
  // ★ 191 批：同步键 —— 推上去 + 把较新的那份读回来；★ 192 批：空的永远不作数
  sync.addEventListener("click", function () {
    state.textContent = "正在对……";
    var mine = { black: norm(tBlack.value), boost: norm(tBoost.value),
      prob: Math.round((parseInt(range.value, 10) || 0) / 10) * 10, at: Date.now() };
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
