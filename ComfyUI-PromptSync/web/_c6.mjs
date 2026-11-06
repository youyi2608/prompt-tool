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
    ta.addEventListener("pointerdown", function () {
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
