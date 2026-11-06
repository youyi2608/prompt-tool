// 自定义优化窗（节点形态）—— 2026-10-19 第 188 批他原话：
//   「点自定义优化那个按钮，就会弹出一个和自定义优化弹窗布局一模一样的节点，节点本身不会连接，
//    只能同时出现一个，数据也要和自定义优化弹窗一样哦」
// 所以这颗节点就是工具端那个「✎ 自定义优化提示词」窗的复刻：写要求 → 快捷词 / 历史 → 开始优化。
// 真正的 AI 调用在「提示词工具」那边（它才有配置）：这里只发请求、等结果、写回那颗 CLIP 优化节点。
import { app } from "../../scripts/app.js";

const NODE_NAME = "PromptToolOptAsk";
const W = 560, H = 430;
const DEFAULT_QUICK = [
  // ★ 191 批：和工具端那份对齐（"画面干净"换成"杜绝莫名其妙的漫画分镜"）
  "加入和内容相符的背景", "加入和内容相符的动作", "杜绝莫名其妙的漫画分镜",
  "女角色限定只有一个", "镜头拉远到大腿半侧以上", "在保持其他不变的情况下",
  "更换一个不同风格的画师串", "角色一定不要完全正对镜头，略微保持侧身",
];
function log(...a) { console.log("[OptAsk]", ...a); }
// ★ 2026-11-04（他第 2 条）：高度倍数记一份全局默认值 —— 新开的窗（点 ✎ 新建节点）也照它还原。
const HMUL_KEY = "promptCopier.optAskHMul.v1";
// ★ 2026-11-06：快捷键改为挂 document（见下面的 onKeyGlobal）——同一时刻只让"最后打开的那块面板"吃键
let activeKeyRoot = null;
function api(path) { return "/prompt_sync" + path; }
// ★ 200 批（他："自定义优化窗下面的空白有些多了，去掉一些"）：
//   光改 `computeSize` 不够 —— 前端只在某些时机重排，节点一拉高，面板还停在老高度、底下留一条空带。
//   所以**直接把面板元素的高度按节点尺寸钉住**（同时保留 computeSize 让布局知道要留多少）。
function pcAskFit(node) {
  try {
    var el = node && node.__w && node.__w.element;
    if (!el || !node.size) return;
    el.style.height = Math.max(180, Math.round(node.size[1] - 34)) + "px";
    el.style.width = Math.max(240, Math.round(node.size[0] - 16)) + "px";
  } catch (e) { /* 忽略 */ }
}

function quickListOf(node) { return (node.__quick && node.__quick.length) ? node.__quick : DEFAULT_QUICK; }
function histListOf(node) { return node.__hist || []; }

function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "pc-optask";
  // ★ 195 批：节点被拖小时，内容宁可出滚动条，也不要互相挤扁（他报的"一排排文字都被挤压下来了"）
  // ★ 199 批（他："右下角的关闭和开始优化，根本就不应该因为滚轮而被淹没"）：
  //   改成**三段式**：标题固定 / 中间那一坨自己滚 / 底部按钮排钉死（`flex:0 0 auto`，永远在最下面）。
  root.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%;height:100%;padding:8px;box-sizing:border-box;"
    + "overflow:hidden;min-height:0;"
    + "font:12px/1.6 system-ui,'Microsoft YaHei',sans-serif;color:#e8eaf1";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700";
  const ttl = document.createElement("span"); ttl.textContent = "✎ 自定义优化提示词";
  const hint = document.createElement("span");
  hint.style.cssText = "font-size:11px;font-weight:400;opacity:.7";
  hint.textContent = "写清要改成什么样 → 开始优化（结果写回那颗 CLIP 优化节点）";
  head.appendChild(ttl); head.appendChild(hint);
  head.style.flex = "0 0 auto";
  root.appendChild(head);

  // ★ 247 批（他："生成时切页面重置的问题还是没解决。你要真解决不了，直接用小字提醒吧，
  //   生成的时候不要切页面，会重置"）→ 按他给的降级口径，钉一行灰字在标题下面。
  const warn = document.createElement("div");
  warn.className = "pc-optask-warn";
  warn.textContent = "⚠ 生成（排队）期间请不要切工作流，切回来这里的文字会重置";
  warn.style.cssText = "flex:0 0 auto;font-size:10.5px;line-height:1.5;color:#ffd9a0;"
    + "background:rgba(232,180,90,.10);border:1px solid rgba(232,180,90,.28);"
    + "border-radius:6px;padding:3px 7px";
  root.appendChild(warn);

  // 中间可滚的那一坨（要求框 / 快捷词 / 历史）
  const body = document.createElement("div");
  body.style.cssText = "display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden";

  // ★ 244 批（他："自定义优化窗在优化的时候，如果切页面会直接导致优化重置，里面的内容文本也会直接消失"）
  //   根因：这个窗是**画布上的节点**，切工作流 = graph.clear() = 节点被移除，textarea 里的字自然跟着没了。
  //   修法：**边打字边存草稿**（localStorage），下次建面板先读回来 —— 切走再切回、甚至关掉 ComfyUI 再开都在。
  const DRAFT_KEY = "promptCopier.optAskDraft.v1";
  const ta = document.createElement("textarea");
  ta.placeholder = "在这里写下这次的要求（回车换行，写多长都行）…";
  // 先把上次没写完的草稿填回来
  try {
    var draft = localStorage.getItem(DRAFT_KEY);
    if (draft) ta.value = draft;
  } catch (e) { /* 忽略 */ }
  ta.addEventListener("input", function () {
    try { localStorage.setItem(DRAFT_KEY, ta.value); } catch (e) { /* 忽略 */ }
  });
  ta.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
  // ★ 283 批（他："试图调自定义节点的宽度，结果长度不受控制的往下延，根本控制不住"）
  //   这个框原来带 `resize:vertical` 的手柄 —— 拖那个手柄等于把内容顶高，节点就被内容反推着长。
  //   节点的规矩是「三段式：标题固定 / 中间滚动 / 底部钉死」，高度只跟节点走，所以手柄去掉。
  // ★ 11-04（他第 2 条）：要求框也跟着高度一起长（原来固定 96px，窗口拉高只多出空白）
  ta.style.cssText = "flex:2 1 96px;min-height:96px;resize:none;font-family:inherit;font-size:12.5px;line-height:1.6;"
    + "padding:8px 10px;border-radius:9px;border:1px solid rgba(150,162,180,.45);background:rgba(0,0,0,.22);color:#e8eaf1";
  body.appendChild(ta);

  // ★ 273c 批（他："自定义优化节点加入一个键，就是工具端的『顺便给出优化后的负提示词
  //   （原来的负词是空的也照给，结果用小提示卡弹出来）』"）
  //   语义跟工具端那颗 optNegOut 完全一致：请求里多要一份 negative，拿到就用小提示卡弹出来。
  var NEG_KEY = "promptCopier.optAskNeg.v1";
  var negRow = document.createElement("label");
  negRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:1.5;"
    + "flex:0 0 auto;opacity:.92;cursor:pointer";
  var negCk = document.createElement("input");
  negCk.type = "checkbox";
  negCk.dataset.pcaskneg = "1";
  negCk.style.cssText = "margin-top:2px;cursor:pointer";
  try { negCk.checked = localStorage.getItem(NEG_KEY) === "1"; } catch (e0) { /* 忽略 */ }
  negCk.addEventListener("change", function () {
    try { localStorage.setItem(NEG_KEY, negCk.checked ? "1" : "0"); } catch (e1) { /* 忽略 */ }
  });
  var negTx = document.createElement("span");
  // ★ 287 批（他第 3 条："括号内小字提醒这一件事"）→ 勾上之后 ⚡ 快速优化 也照样给负词
  negTx.textContent = "顺便给出优化后的负提示词（原来的负词是空的也照给，结果用小提示卡弹出来；勾上以后 ⚡ 快速优化 也会这样做）";
  negRow.appendChild(negCk);
  negRow.appendChild(negTx);
  body.appendChild(negRow);

  // 小提示卡：负提示词的回执。★ 275 批（他："勾选了之后也不会改负提示词"）——
  //   现在这张卡**只当回执**：负词已经真的写进那颗节点的负提示词框了，卡片顺手给一份可复制的副本，
  //   并留一颗「↩ 还原原来的负词」（覆盖必须能退回去，这是项目红线）。
  function showNegCard(txt, wrote, oldTxt, clipId) {
    try {
      var card = document.createElement("div");
      card.style.cssText = "position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:100120;"
        + "max-width:min(520px,86vw);padding:10px 13px;border-radius:10px;cursor:pointer;"
        + "background:rgba(22,42,78,.96);color:#e4eeff;border:1px solid rgba(120,170,255,.55);"
        + "font:12.5px/1.6 system-ui,'Microsoft YaHei';box-shadow:0 10px 30px rgba(0,0,0,.45)";
      var h = document.createElement("div");
      h.textContent = wrote
        ? "✅ 负提示词已经写回那颗节点了（点这张卡可以再复制一份）"
        : "AI 顺便给的负提示词（点这张卡复制）";
      h.style.cssText = "font-weight:700;margin-bottom:4px;opacity:.92";
      var p = document.createElement("div");
      p.textContent = String(txt || "");
      p.style.cssText = "white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto";
      card.appendChild(h);
      card.appendChild(p);
      if (wrote) {
        var br = document.createElement("button");
        br.type = "button";
        br.textContent = "↩ 还原原来的负词";
        br.title = "把负提示词框退回成优化前的那份";
        br.style.cssText = "margin-top:6px;font-family:inherit;font-size:11px;padding:3px 9px;border-radius:7px;"
          + "cursor:pointer;border:1px solid rgba(165,205,255,.55);background:rgba(255,255,255,.1);color:#e4eeff";
        br.addEventListener("click", function (e5) {
          e5.stopPropagation();
          try {
            if (window.__pcClipSetText) window.__pcClipSetText(clipId, "neg", oldTxt || "");
            h.textContent = "已经还原成原来的负词";
            setTimeout(function () { try { card.remove(); } catch (e6) { /* 忽略 */ } }, 700);
          } catch (e7) { h.textContent = "还原失败"; }
        });
        card.appendChild(br);
      }
      card.addEventListener("click", function () {
        try {
          navigator.clipboard.writeText(String(txt || "")).then(function () {
            h.textContent = "已复制这份负提示词";
            setTimeout(function () { try { card.remove(); } catch (e2) { /* 忽略 */ } }, 550);
          }, function () { h.textContent = "复制失败（浏览器没给权限）"; });
        } catch (e3) { h.textContent = "复制失败"; }
      });
      document.body.appendChild(card);
      setTimeout(function () { try { card.remove(); } catch (e4) { /* 忽略 */ } }, 12000);
    } catch (e) { log("负提示词小卡失败", e); }
  }

  const quickHead = document.createElement("div");
  quickHead.style.cssText = "font-size:11.5px;opacity:.75;display:flex;align-items:center;gap:8px";
  const qt = document.createElement("span"); qt.textContent = "快捷词（点一下插进上面的框）";
  // ★ 191 批：一颗小刷新键 —— 工具端刚加的快捷词，点一下就从共享黑板读回来
  const qref = document.createElement("button");
  qref.type = "button"; qref.textContent = "🔄";
  qref.title = "从共享黑板重新读一次（工具端改了就点这个）";
  qref.style.cssText = "font-family:inherit;font-size:11px;line-height:1;padding:2px 6px;border-radius:7px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1";
  qref.addEventListener("click", function () { loadShared(); });
  // ★ 273 批（他 272 批第 11 条："自定义优化节点加入清空文本框的按键"）
  //   规矩：清空必须能撤回（项目红线：关闭/清空一律可恢复）→ 同一颗键 15 秒内可以点回来。
  var clr = document.createElement("button");
  clr.type = "button"; clr.textContent = "🧹 清空";
  clr.title = "把上面要求框里的字一次清掉（15 秒内再点这颗键能撤回）";
  clr.dataset.pcaskclear = "1";
  // ★ 283 批（他："清空要求框虽然现在很显眼，但是有点过于显眼了，而且自己占一排，
  //   而不是和「顺便给出优化后的负提示词」这个勾选的选项共享一排"）
  //   → 回到勾选那一行的最右边；显眼程度**降半档**（去掉大投影、字号 12、内边距收小），
  //   但仍是实心红 + 粗体，比原来那颗淡红描边的小键明显得多。
  clr.style.cssText = "margin-left:auto;flex:0 0 auto;font-family:inherit;font-size:12px;font-weight:700;line-height:1;"
    + "padding:5px 12px;border-radius:8px;cursor:pointer;border:1px solid rgba(255,140,150,.8);color:#fff;"
    + "background:linear-gradient(135deg,#e8555f,#b8263a)";
  var clrUndo = null, clrTimer = 0;
  function paintClr() {
    const undoable = clrUndo != null;
    clr.textContent = undoable ? "↩ 撤回清空" : "🧹 清空要求框";
    clr.style.background = undoable ? "linear-gradient(135deg,#3f9a6a,#2b6f4d)" : "linear-gradient(135deg,#e8555f,#b8263a)";
    clr.style.borderColor = undoable ? "rgba(120,220,160,.8)" : "rgba(255,140,150,.8)";
  }
  clr.addEventListener("click", function () {
    if (clrUndo != null) {                      // 撤回：把刚才清掉的原样放回去
      ta.value = clrUndo; clrUndo = null; paintClr();
      try { localStorage.setItem(DRAFT_KEY, ta.value); } catch (e) { /* 忽略 */ }
      try { ta.focus(); } catch (e2) { /* 忽略 */ }
      return;
    }
    if (!String(ta.value || "")) return;        // 本来就是空的：什么都不做（不占撤回位）
    clrUndo = ta.value;
    ta.value = "";
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* 忽略 */ }
    paintClr();
    clearTimeout(clrTimer);
    clrTimer = setTimeout(function () { if (clrUndo != null) { clrUndo = null; paintClr(); } }, 15000);
    try { ta.focus(); } catch (e3) { /* 忽略 */ }
  });
  quickHead.appendChild(qt); quickHead.appendChild(qref);
  // ★ 283：清空键并到「顺便给出优化后的负提示词」那一行的最右边（不再自己占一排）
  negRow.appendChild(clr); paintClr();
  body.appendChild(quickHead);

  // ★ 2026-11-04（他第 2 条）：「高度在 1.4 倍以上就没有意义了，快捷词和最近写过的要求**里面的内容不会展开**
  //   （应该改成展开才对），再往下延全都是空白」→ 这两块改成**跟着节点高度一起长**（不再固定 max-height）。
  // ★ 他第六批第 1 条：「增加自定义优化窗中快捷词的占据高度」→ 基准高 64 → 132，
  //   并给它一点抢空间的权重（1.4），历史那块保持 1。
  const quickBox = document.createElement("div");
  quickBox.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;overflow:auto;flex:1.4 1 auto;min-height:132px;align-content:flex-start";
  body.appendChild(quickBox);

  const histHead = document.createElement("div");
  histHead.style.cssText = "font-size:11.5px;opacity:.75";
  histHead.textContent = "最近写过的要求（点一条填回上面的框）";
  body.appendChild(histHead);

  const histBox = document.createElement("div");
  // ★ 195 批：容器本身也不许被压缩；★ 11-04：改成跟着高度一起长（见 quickBox 那条注释）
  histBox.style.cssText = "display:flex;flex-direction:column;gap:4px;min-height:52px;overflow:auto;flex:1 1 auto";
  body.appendChild(histBox);

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 0 auto;padding-top:2px;border-top:1px solid rgba(150,162,180,.22)";
  const state = document.createElement("span");
  state.style.cssText = "font-size:11.5px;opacity:.75;flex:1 1 auto";
  const go = document.createElement("button");
  go.type = "button"; go.textContent = "开始优化";
  go.style.cssText = "font-family:inherit;font-size:12.5px;font-weight:700;padding:7px 16px;border-radius:9px;"
    + "border:none;color:#fff;cursor:pointer;background:linear-gradient(135deg,#7c5cff,#3b82f6)";
  // ★ 2026-11-04（他第 4 条）：「ctrl+enter 和开始优化之间的距离应该是贴近了，中间有个关闭，很容易误触。
  //   而且说到底，关闭这个键到底存在的意义是什么呢？直接把关闭这个键删了吧」→ **「关闭」键整个删掉**。
  //   要关掉这个窗：删节点（选中按 Del）或点那颗 ✎ 再开一次；草稿照样边打边存，不丢。
  // ★ 287 批（他第 1 条："自定义优化窗的高度改为文本框填入高度倍数，最大 3、最小 1，允许有小数"）
  //   → 一个数字框直接填倍数（默认 1），回车/失焦就按 H × 倍数定高。绕开拖拽那条别扭的路。
  const hWrap = document.createElement("span");
  hWrap.style.cssText = "display:flex;align-items:center;gap:4px;flex:0 0 auto;opacity:.9";
  const hLab = document.createElement("span");
  hLab.textContent = "高度 ×";
  hLab.style.cssText = "font-size:11px";
  const hNum = document.createElement("input");
  hNum.type = "number";
  hNum.min = "1"; hNum.max = "3"; hNum.step = "0.1"; hNum.value = "1";
  hNum.dataset.pcaskhmul = "1";
  hNum.title = "节点高度的倍数：1~3，可以填小数（1.5 = 一倍半高）";
  hNum.style.cssText = "width:52px;font-family:inherit;font-size:11px;line-height:1;padding:4px 6px;border-radius:7px;"
    + "border:1px solid rgba(150,162,180,.45);background:rgba(0,0,0,.22);color:#e8eaf1";
  function applyHMult() {
    let k = Number(hNum.value);
    if (!isFinite(k)) k = 1;
    k = Math.max(1, Math.min(3, Math.round(k * 10) / 10));
    hNum.value = String(k);
    try {
      node.__pcFitBusy = true;                       // 程序定高，绕开"高度失控"那道刹车
      node.setSize([node.size[0], Math.round(H * k)]);
      node.__pcLastH = node.size[1];
      node.__pcFitBusy = false;
      pcAskFit(node);
    } catch (err) { node.__pcFitBusy = false; }
    state.textContent = "高度已设成 " + k + " 倍（" + Math.round(H * k) + "px）";
    // ★ 291 批（他第 4 条："点击刷新之后高度不变，但高度倍数的示数会重置为 1，应该改成示数也不重置"）
    try {
      node.properties = node.properties || {};
      node.properties.pcOptAsk = Object.assign({}, node.properties.pcOptAsk || {}, { hMul: k });
    } catch (eP) { /* 忽略 */ }
    // ★ 2026-11-04（他第 2 条）：「高度很容易重置为一倍」—— 关掉窗口再点 ✎ 会**新建一颗节点**，
    //   新节点没有 properties → 又变回一倍。这里顺手记一份全局值，新窗口默认就用它。
    try { localStorage.setItem(HMUL_KEY, String(k)); } catch (eL) { /* 忽略 */ }
  }
  hNum.addEventListener("change", applyHMult);
  hNum.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); applyHMult(); }
    e.stopPropagation();
  });
  hWrap.appendChild(hLab); hWrap.appendChild(hNum);
  // 面板（重新）建起来 / 工作流读回来时，把上次填的倍数显示回来（291：他第 4 条）
  function syncHMul() {
    try {
      const hm0 = Number(((node.properties || {}).pcOptAsk || {}).hMul);
      if (isFinite(hm0) && hm0 >= 1) hNum.value = String(Math.min(3, Math.round(hm0 * 10) / 10));
      else hNum.value = "1";
    } catch (eR) { /* 忽略 */ }
  }
  try { node.__pcAskSyncH = syncHMul; } catch (eS) { /* 忽略 */ }
  syncHMul();

  // ★ 2026-11-04（他第 4 条）：「开始优化旁边新增一个按键，可以调整开始优化的键盘快捷键」
  //   规矩：不弹原生 prompt（项目红线），点一下这颗键 = 进入"捕捉"状态，接着按你要的组合键即可。
  //   组合里必须带 Ctrl 或 Alt —— 否则在文本框里打字会被误触。
  const HOTKEY_KEY = "promptCopier.optAskHotkey.v1";
  const hkBtn = document.createElement("button");
  hkBtn.type = "button";
  hkBtn.dataset.pcaskhk = "1";
  hkBtn.style.cssText = "flex:0 0 auto;font-family:inherit;font-size:11px;line-height:1;padding:5px 8px;border-radius:7px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.5);background:rgba(255,255,255,.06);color:#cfd5e2";
  var hk = { ctrl: true, shift: false, alt: false, key: "enter" };
  function hkLabel() {
    const parts = [];
    if (hk.ctrl) parts.push("Ctrl");
    if (hk.alt) parts.push("Alt");
    if (hk.shift) parts.push("Shift");
    parts.push(hk.key === "enter" ? "Enter" : String(hk.key).toUpperCase());
    return parts.join("+");
  }
  function hkTyping() {
    try {
      const ae = document.activeElement;
      return !!(ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT"));
    } catch (e) { return false; }
  }
  function hkSingle() { return !hk.ctrl && !hk.alt && !hk.shift; }
  function hkPaint() {
    // ★ 2026-11-04（他第 4 条）：「快捷键可以设置单键……按一下快捷词的按钮，也会使其暂时关闭
    //   快捷键优化的按钮，表现方式为按钮灰暗」
    //   规律 = **单键快捷键在"光标在输入框里"时让开**（点一下快捷词就会聚焦到要求框，所以一按就变灰）；
    //   带 Ctrl / Alt 的组合键任何时候都好使（写着要求也能一键开始）。
    const off = hkSingle() && hkTyping();
    hkBtn.textContent = "⌨ " + hkLabel() + (off ? "（暂停）" : "");
    hkBtn.title = off
      ? "光标正在输入框里 —— 单键快捷键暂时让开（免得打字误触）；点到别处就恢复，或改成带 Ctrl 的组合键"
      : "开始优化的快捷键（现在是 " + hkLabel() + "）。**双击**这颗键，再按你想用的键就能换。"
        + "\n窗开着就一直有效：拖节点、点画布、光标不在窗里都照样能按（只是画布上什么都没选中时，这个键还给 ComfyUI 自己用）";
    hkBtn.style.opacity = off ? ".42" : "1";
  }
  function hkLoad() {
    try {
      const j = JSON.parse(localStorage.getItem(HOTKEY_KEY) || "null");
      if (j && j.key) hk = { ctrl: !!j.ctrl, shift: !!j.shift, alt: !!j.alt, key: String(j.key) };
    } catch (eHK) { /* 忽略 */ }
    hkPaint();
  }
  var hkWait = false;
  function hkReset() {
    hkWait = false;
    hkBtn.style.borderColor = "rgba(150,162,180,.5)";
    hkBtn.style.color = "#cfd5e2";
    hkPaint();
  }
  // ★ 他第 4 条：「修改快捷键的进入方式改为双击」→ 单击不做任何事（避免和"开始优化"抢手感）
  hkBtn.addEventListener("dblclick", function (eHK1) {
    eHK1.preventDefault(); eHK1.stopPropagation();
    hkWait = true;
    hkBtn.textContent = "⌨ 按你要的键…";
    hkBtn.style.opacity = "1";
    hkBtn.style.borderColor = "rgba(255,206,92,.9)";
    hkBtn.style.color = "#ffd98a";
    state.textContent = "现在按你想用的组合键（一定要带 Ctrl 或 Alt；Esc 取消）";
    try { ta.focus(); } catch (eHK2) { /* 忽略 */ }
  });
  function hkMatch(e) {
    const k = String(e.key || "").toLowerCase();
    if (k !== hk.key) return false;
    // ★ 他第 4 条：允许**单键**（不再强制带 Ctrl/Alt）；单键什么时候让开见下面 keydown 里的判断
    return (!!e.ctrlKey === hk.ctrl) && (!!e.altKey === hk.alt) && (!!e.shiftKey === hk.shift);
  }
  // ★ 2026-11-06（他第 2 条）：「自定义节点的快捷键有时候会突然关闭，需要时不时重新打开，
  //   难道是拖开就关闭，但是拖回不打开？」→ 正是这个原因。
  //   以前监听挂在 root 上，**只有光标还在这块面板里**才收得到按键；拖一下节点、点一下画布，
  //   焦点跑到画布上，快捷键当场变哑，拖回来也不会自己恢复（他就得点回窗里"重新打开"）。
  //   现在挂到 document 上，并且**把"这颗节点被选中"也算作在用这个窗**（拖动=选中，所以拖开拖回都好使）；
  //   点到空白画布（没选中任何节点）时仍然让给 ComfyUI 自己（不然会抢走 Ctrl+Enter 排队）。
  function pcAskKeyScopeOk() {
    try {
      if (activeKeyRoot && activeKeyRoot !== root) return false;   // 开了两个窗时只让最后打开的那个吃键
      var ae = document.activeElement;
      if (ae && root.contains(ae)) return true;                     // 光标就在窗里
      var sel = (app.canvas && app.canvas.selected_nodes) || null;
      if (!sel) return true;
      var ks = Object.keys(sel);
      if (!ks.length) return false;                                 // 画布上什么都没选中 → 不抢键
      if (ks.indexOf(String(node.id)) >= 0) return true;            // 选中了这颗优化窗
      if (node.__targetClip != null && ks.indexOf(String(node.__targetClip)) >= 0) return true;  // 选中了它要优化的那颗
      return false;
    } catch (eS) { return true; }
  }
  function onKeyGlobal(e) {
    if (!root.isConnected) return;                                  // 面板没了
    if (!pcAskKeyScopeOk()) return;
    if (hkWait) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { hkReset(); state.textContent = "还是用原来的快捷键"; return; }
      const k = String(e.key || "").toLowerCase();
      if (k === "control" || k === "shift" || k === "alt" || k === "meta") return;   // 修饰键本身不算
      // ★ 他第 4 条：单键也允许（例：F8 / ` / Space）。单键在"光标在框里"时会自动让开，不会吃字。
      hk = { ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, key: k };
      try { localStorage.setItem(HOTKEY_KEY, JSON.stringify(hk)); } catch (eHK3) { /* 忽略 */ }
      hkReset();
      state.textContent = "快捷键换成 " + hkLabel() + " 了（点「开始优化」照样能用）";
      return;
    }
    if (hkMatch(e)) {
      if (hkSingle() && hkTyping()) return;       // 单键 + 光标在框里 → 让开，别把字吃掉
      e.preventDefault(); e.stopPropagation(); go.click();
    }
  }
  document.addEventListener("keydown", onKeyGlobal, true);
  activeKeyRoot = root;
  try {
    node.__pcKeyOff = function () {
      document.removeEventListener("keydown", onKeyGlobal, true);
      if (activeKeyRoot === root) activeKeyRoot = null;
    };
  } catch (eK0) { /* 忽略 */ }
  hkLoad();
  // 光标进出要求框时把快捷键键的状态画准（灰/亮）
  ta.addEventListener("focus", function () { try { hkPaint(); } catch (e) { /* 忽略 */ } });
  ta.addEventListener("blur", function () { setTimeout(function () { try { hkPaint(); } catch (e) { /* 忽略 */ } }, 0); });

  foot.appendChild(state); foot.appendChild(hWrap); foot.appendChild(hkBtn); foot.appendChild(go);
  root.appendChild(body);
  foot.className = 'pc-optask-foot';
  root.appendChild(foot);

  node.__ta = ta; node.__go = go; node.__state = state;

  go.addEventListener("click", function () {
    // ★ 2026-11-04（他第 1 条 · 第二次澄清）：「我说的是**自定义优化窗的中断**去掉，那个按键**一直都是开始优化**，
    //   不要改成中断」→ 这颗键永远叫「开始优化」，优化中只变灰；真要中断去点 CLIP 优化节点上那颗「⏹」。
    if (go.dataset.running === "1") return;
    const myAt = Date.now();                                  // ★ 275：中断令牌的比较基准
    const ask = String(ta.value || "").trim();
    if (!ask) { state.textContent = "先写一句要求"; ta.focus(); return; }
    let clipId = node.__targetClip;
    if (clipId == null) clipId = pcAskRestoreTarget(node);   // ★ 242 批：先自己找回来
    if (clipId == null) { state.textContent = "不知道要给哪颗节点优化（先点那颗 CLIP 节点上面的 ✎ 打开）"; return; }
    const pos = (window.__pcClipText ? window.__pcClipText(clipId, "pos") : "") || "";
    // ★ 207 批：空着也行（让 AI 从无到有写）
    const fromScratch = !String(pos).trim();
    go.disabled = true; go.dataset.running = "1";       // 文字始终是「开始优化」，不变成中断
    state.textContent = "正在优化…（第一次会慢几秒；要中断就去点那颗 CLIP 节点上的 ⏹）";
  // ★ 244 批：开始优化就把草稿落一次（万一中途切走，回来接着能看）
  try { localStorage.setItem(DRAFT_KEY, ta.value); } catch (e) { /* 忽略 */ }
    // ★ 195 批：那颗 CLIP 节点的正提示词上亮起黄色波浪（和 ⚡ 同款）
    // ★ 2026-11-03（他第 2 条）：带上 "ask" —— 节点状态行要显示紫 ✎「自定义优化中…」，和 ⚡ 分开
    try { if (window.__pcOptWave) window.__pcOptWave.show(clipId, "ask"); } catch (e) { /* 忽略 */ }
    // ★ 191 批：把画师规则也带上（以前这个窗一个字都不带 —— 他："提示词优化里面的数据并没有互通啊"）
    const hint = (window.__pcArtistHint ? String(window.__pcArtistHint(clipId) || "") : "").trim();
    // ★ 273c：勾了"顺便给出负提示词"就把负词也带上（负词框空着也照给 —— 由 AI 从无到有写）
    const wantNeg = negCk.checked === true;
    const negNow = wantNeg ? ((window.__pcClipText ? window.__pcClipText(clipId, "neg") : "") || "") : "";
    fetch(api("/ai/request"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pos: pos, neg: negNow, negWant: wantNeg ? 1 : 0, want: "pos", from: "optask",
        artist: (function () { try { var c = app.graph.getNodeById(clipId); return (c && c.properties && c.properties.pcClip && c.properties.pcClip.optUI && c.properties.pcClip.optUI.artist) ? 1 : 0; } catch (e0) { return 0; } })(),
        ask: (ask + (hint ? ("；" + hint) : "") + (fromScratch ? "；（现在正提示词框是空的）请直接写一段完整可用的正提示词" : "")) }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      const id = j && j.id; let tries = 0;
      (function poll() {
        // ★ 194b 批：AI 正常要十几秒 —— 先问共享黑板里的「aiPicked」记号，接活了就安静等，别误报
        if (tries++ > 200) { go.disabled = false; try { window.__pcOptWave && window.__pcOptWave.hide(); } catch (e) { /* 忽略 */ } state.textContent = "等太久了 —— 提示词工具是不是没打开？"; return; }
        fetch(api("/ai/result?id=" + id), { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (go.dataset.running !== "1") return;                 // ★ 275：已经中断了
            if (window.__pcOptStopAt && window.__pcOptStopAt() > myAt) {
              go.dataset.running = "0"; go.textContent = "开始优化"; go.disabled = false;
              try { window.__pcOptWave && window.__pcOptWave.hide(); } catch (e2) { /* 忽略 */ }
              state.textContent = "已中断这次优化 —— 可以直接写新要求重新开始";
              return;
            }
            if (!res || !res.done) { setTimeout(poll, 700); return; }
            go.disabled = false; go.dataset.running = "0"; go.textContent = "开始优化";
            try { window.__pcOptWave && window.__pcOptWave.hide(); } catch (e) { /* 忽略 */ }
            if (res.err) { state.textContent = "没成功：" + res.err; return; }
            // ★ 2026-11-03（他第 1 条，已按他的纠正改正）：输出口长在**本窗节点自己**身上 ——
            //   连了暂存节点 → 结果先进它的下框；没连 → 照旧替换被优化那颗节点的文本。
            var negTxt0 = String(res.neg || "").trim();
            var stageN = null;
            try { stageN = window.__pcStageDownstream ? window.__pcStageDownstream(node) : null; } catch (eSt) { stageN = null; }
            if (stageN) {
              var okSt = false;
              try { okSt = window.__pcStageAccept ? window.__pcStageAccept(stageN, res.text, negTxt0) === true : false; } catch (eSt2) { okSt = false; }
              if (okSt) {
                state.textContent = "优化好了 → 已放进「暂存节点」的下框（满意后点那边的「↑ 顶掉上框」）";
                rememberHist(node, ask);
                return;
              }
            }
            if (window.__pcClipSetText) window.__pcClipSetText(clipId, "pos", res.text);
            // ★ 2026-11-04（他第 7 条）：只有"真写进文本框"才响；上面那条进暂存节点的路不响。
            try { if (window.__pcTimerPing) window.__pcTimerPing("自定义优化"); } catch (eTP) { /* 忽略 */ }
            state.textContent = "优化好了，已经写回那颗节点";
            // ★ 275 批（他："勾选了之后也不会改负提示词"）：负词也要**真的写进负提示词框**。
            //   以前只弹一张卡让他自己抄 —— 正是他反复说的"生成完还要再点一下"那种老毛病。
            var negTxt = String(res.neg || "").trim();
            if (negTxt) {
              var oldNeg = "";
              try { oldNeg = String(window.__pcClipText ? (window.__pcClipText(clipId, "neg") || "") : ""); } catch (e8) { oldNeg = ""; }
              var wroteNeg = false;
              try { wroteNeg = !!(window.__pcClipSetText && window.__pcClipSetText(clipId, "neg", negTxt)); } catch (e9) { wroteNeg = false; }
              if (wroteNeg) state.textContent = "优化好了：正、负提示词都写回去了";
              showNegCard(negTxt, wroteNeg, oldNeg, clipId);
            }
            rememberHist(node, ask);
          })
          .catch(function () { setTimeout(poll, 900); });
      })();
    }).catch(function (e) {
      go.disabled = false;
      try { window.__pcOptWave && window.__pcOptWave.hide(); } catch (e2) { /* 忽略 */ }
      state.textContent = "请求失败（ComfyUI 那边接口还没重启生效？）";
      log(e);
    });
  });

  // 快捷词 / 历史：优先用后端那块共享黑板（和工具端同一份）
  function loadShared() {
    fetch(api("/store?key=quick"), { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && Array.isArray(j.value) && j.value.length) { node.__quick = j.value.map(String); renderQuick(); }
      }).catch(function () {});
    fetch(api("/store?key=hist"), { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && Array.isArray(j.value)) { node.__hist = j.value.map(String).slice(0, 20); renderHist(); }
      }).catch(function () {});
  }
  function renderQuick() {
    quickBox.innerHTML = "";
    quickListOf(node).slice(0, 40).forEach(function (w) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = w; b.title = w;
      b.style.cssText = "font-family:inherit;font-size:11.5px;padding:4px 9px;border-radius:999px;cursor:pointer;"
        + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1;"
        + "max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      b.addEventListener("click", function () {
        const at = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
        const pre = ta.value.slice(0, at), post = ta.value.slice(at);
        // ★ 273 批（他 272 批第 7 条："工具端点快捷词会自动填入逗号，ComfyUI 端反而不行"）
        //   → 照搬工具端 optQuickInsert 的规则：前面不是空白 / 逗号 / 顿号就补一个"，"。
        const glue = (pre && !/[\s，,、]$/.test(pre)) ? "，" : "";
        ta.value = pre + glue + w + post;
        const pos = (pre + glue + w).length;
        try { ta.setSelectionRange(pos, pos); } catch (e2) { /* 忽略 */ }
        try { localStorage.setItem(DRAFT_KEY, ta.value); } catch (e3) { /* 忽略 */ }
        ta.focus();
      });
      quickBox.appendChild(b);
    });
  }
  function renderHist() {
    histBox.innerHTML = "";
    const arr = histListOf(node);
    if (!arr.length) {
      const d = document.createElement("div");
      d.style.cssText = "opacity:.55;font-size:11.5px";
      d.textContent = "还没有记录 —— 写过一次要求之后这里就留着（和工具端共用一份）";
      histBox.appendChild(d); return;
    }
    arr.forEach(function (t) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = t; b.title = t;
      // ★ 195 批（他贴图："一排排文字都被挤压下来了"）：原因就是这个列表是 flex 竖排 + 限高，
      //   子项默认 flex-shrink:1 → 每条被压成一条细线。给每条 `flex:0 0 auto` + 固定行高就不再压。
      b.style.cssText = "flex:0 0 auto;min-height:22px;height:22px;line-height:20px;"
        + "text-align:left;font-family:inherit;font-size:11.5px;padding:0 9px;border-radius:8px;cursor:pointer;"
        + "border:1px solid rgba(150,162,180,.3);background:rgba(255,255,255,.05);color:#e8eaf1;"
        + "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      b.addEventListener("click", function () { ta.value = t; ta.focus(); });
      histBox.appendChild(b);
    });
  }
  function rememberHist(n, ask) {
    if (!Array.isArray(n.__hist)) n.__hist = [];
    n.__hist = [ask].concat(n.__hist.filter(function (x) { return x !== ask; })).slice(0, 20);
    renderHist();
    try {
      fetch(api("/store"), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "hist", value: n.__hist }) }).catch(function () {});
    } catch (e) { /* 忽略 */
    }
  }
  node.__renderQuick = renderQuick; node.__renderHist = renderHist;
  renderQuick(); renderHist(); loadShared();
  return root;
}

app.registerExtension({
  name: "PromptSync.OptAsk",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const node = this;
      try {
        (node.widgets || []).slice().forEach(function (w) {
          if (!w || w.name !== "状态") return;
          w.hidden = true; w.computeSize = function () { return [0, -4]; };
          try { if (w.element) w.element.style.display = "none"; } catch (e) { /* 忽略 */ }
        });
        // ★ 2026-11-04（他第 2 条）：「自定义优化窗的高度**很容易重置为一倍**」——
        //   真因：这里每次建节点都无条件 `setSize([W, H])`，把他上次设的「高度 ×」直接抹平。
        //   现在先把 properties 里记着的 hMul 读回来，按它还原高度。
        var hMul0 = 1;
        try { hMul0 = Number(((node.properties || {}).pcOptAsk || {}).hMul); } catch (e0) { hMul0 = 1; }
        if (!isFinite(hMul0) || hMul0 < 1) hMul0 = 1;
        // 新节点没有 properties → 退回全局记住的那个倍数（关掉窗再点 ✎ 也不会跳回一倍）
        if (hMul0 === 1) { try { var g0 = Number(localStorage.getItem(HMUL_KEY)); if (g0 >= 1) hMul0 = g0; } catch (eG) { /* 忽略 */ } }
        hMul0 = Math.min(3, hMul0);
        node.setSize([W, Math.round(H * hMul0)]);
        // ★ 199 批（他："自定义优化窗应该设置下限的……开始优化那个键根本就点不动"）：
        //   真因是 DOM 控件以前给的是**死高度** `[W-16, H-52]`，节点一缩小，底部按钮就被挤到节点外面
        //   → 点击落到画布上（看着有键、就是点不动）。现在 ① 控件高度跟着节点走 ② 节点有最小尺寸。
        try {
          node.resizable = true;
          node.__pcMinSize = [380, 320];
          var clampSize = function () {
            var s = node.size || [W, H], m = node.__pcMinSize;
            if (s[0] < m[0] || s[1] < m[1]) node.setSize([Math.max(s[0], m[0]), Math.max(s[1], m[1])]);
          };
          clampSize();
          var onResize0 = node.onResize;
          node.__pcLastH = (node.size && node.size[1]) || H;
          node.onResize = function () {
            var rr = onResize0 ? onResize0.apply(this, arguments) : undefined;
            try {
              if (node.__pcFitBusy) return rr;         // ★ 283：防重入（里面 setSize 会再触发一次 onResize）
              node.__pcFitBusy = true;
              clampSize();
              // ★ 283：万一高度还是被内容反推着长（一次蹦过一大截），直接退回上一次的高度 ——
              //   宁可少长，不许失控。宽度照旧随他拖。
              var prevH = node.__pcLastH;
              if (prevH && (node.size[1] - prevH) > 240) {
                log("拦下一次高度失控", prevH, "->", node.size[1]);
                node.setSize([node.size[0], prevH]);
              }
              node.__pcLastH = node.size && node.size[1];
              pcAskFit(node);
              node.__pcFitBusy = false;
            } catch (e) { node.__pcFitBusy = false; }
            return rr;
          };
        } catch (e) { /* 忽略 */ }
        // ★ 246 批：抽成 pcAskMount（onConfigure 也要调它 —— 读工作流时 onNodeCreated 不跑）
        pcAskMount(node);
        // ★ 2026-11-06：节点被删/切工作流时把 document 上的按键监听摘掉，免得越积越多
        const prevRm = this.onRemoved;
        this.onRemoved = function () {
          try { if (node.__pcKeyOff) { node.__pcKeyOff(); node.__pcKeyOff = null; } } catch (eK1) { /* 忽略 */ }
          return prevRm ? prevRm.apply(this, arguments) : undefined;
        };
        const st = (node.properties && node.properties.pcOptAsk) || {};
        if (st.clip != null) node.__targetClip = st.clip;
        // ★ 242 批：读工作流时（configure）properties 才到位 —— 那时要再恢复一次
        const prevCfg = this.onConfigure;
        this.onConfigure = function () {
          const r2 = prevCfg ? prevCfg.apply(this, arguments) : undefined;
          try {
            // ★ 246 批（他："生成的时候切到别的工作流之后，文本都会重置归零；不生成时互相切没事"）：
            //   真因 —— 面板建在 onNodeCreated 里，而从工作流读回来走的是 configure、onNodeCreated 不跑
            //   → 切回来后节点在、面板是空的（看着像"文本归零"）。这里补建一次。
            pcAskMount(this);
            const got = pcAskRestoreTarget(this);
            if (got != null) log("已重新连上 CLIP 节点", got);
          } catch (e) { /* 忽略 */ }
          return r2;
        };
        log("自定义优化窗就绪", node.id);
      } catch (e) { log("初始化失败", e); }
      return r;
    };
  },
});

// ★ 242 批（他："每次重新打开之后都要重新叫一次进行匹配，原来就没有用了，
//   应该让原来的也保持联系状态才行"）：
//   真因 —— 恢复 targetClip 的那段写在 onNodeCreated 里，而那时候 properties 还没从工作流读进来
//   （configure 在 onNodeCreated 之后才跑），所以 st.clip 永远是空的 → 每次重开都要重新点一次 ✎。
//   现在改成：onConfigure 之后再恢复一次，并且校验那颗节点还在不在；id 变了就按类型兜底。
// ★ 246 批：把"建面板 + 挂 DOM widget"抽成模块级函数 —— onNodeCreated 与 onConfigure 都要能调
//   （从工作流读回来走 configure，onNodeCreated 不跑 → 以前切回来面板是空的，看着像"文本归零"）
function pcAskMount(node) {
  try {
    if (!node) return false;
    if (node.__w) {                                      // 已经建过：只把「高度倍数」的示数同步一次（291）
      try { node.__pcAskSyncH && node.__pcAskSyncH(); } catch (e0) { /* 忽略 */ }
      return false;
    }
    var panel = buildPanel(node);
    if (typeof node.addDOMWidget !== "function") return false;
    node.__w = node.addDOMWidget("优化要求", "pcOptAsk", panel, { serialize: false, hideOnZoom: false });
    node.__w.computeSize = function () {
      var w = (node.size && node.size[0]) || W, h = (node.size && node.size[1]) || H;
      return [Math.max(240, w - 16), Math.max(120, h - 34)];
    };
    setTimeout(function () { pcAskFit(node); }, 60);
    log("优化窗面板已挂上", node.id);
    return true;
  } catch (e) { log("挂优化窗面板失败", e); return false; }
}
window.__pcAskMount = pcAskMount;

function pcAskRestoreTarget(node) {
  try {
    var st = (node.properties && node.properties.pcOptAsk) || {};
    var id = st.clip;
    if (id == null) return null;
    var all = (app.graph && app.graph._nodes) || [];
    var hit = all.filter(function (n) { return n && n.id === id && String(n.type) === "PromptToolClipSegments"; })[0];
    if (hit) { node.__targetClip = hit.id; return hit.id; }
    // id 对不上了（换过工作流 / 重新编号）→ 画布上只有一颗就用它兜底
    var cands = all.filter(function (n) { return n && String(n.type) === "PromptToolClipSegments"; });
    if (cands.length === 1) {
      node.__targetClip = cands[0].id;
      st.clip = cands[0].id;
      node.properties.pcOptAsk = st;
      return cands[0].id;
    }
    node.__targetClip = null;
    return null;
  } catch (e) { return null; }
}
window.__pcOptAskRestore = pcAskRestoreTarget;

window.__pcOptAskInit = function (node, clipId) {
  try {
    node.__targetClip = clipId;
    node.properties = node.properties || {};
    node.properties.pcOptAsk = { clip: clipId };
  } catch (e) { /* 忽略 */ }
};
