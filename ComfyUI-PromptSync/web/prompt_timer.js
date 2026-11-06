// 「计时器（休息计时 + 生图效率）」节点（PromptToolTimer）的前端
//
// 他 2026-10-05 的原话（先给规格、再纠正"放在哪"）：
//   「套图节点的计时效率，你说超过多少秒响一声，还有特效，响一声的那个音效，就是鸭小黄鸭的那个音效，
//     特效就是比较明显的水波特效。至于多少秒响一声，设专门的编辑按钮，自己定，包括音效也可以自己导入文件」
//   「**计时是单独的节点啊，不应该是套图排队上的节点**」
// —— 所以它是**独立一颗节点**（本包第 6 颗），套图排队那边一点都不沾。
//
// 它自己**不参与工作流、也不会被 ComfyUI 执行**（没有输出、不是 OUTPUT_NODE），放几颗都不占排队。
// 计时靠 **ComfyUI 自己的事件**（execution_start / execution_success）→ 任何工作流出图都能计时，不只套图；
// 顺带读一下 `/prompt_sync/batch/status`，套图休息还剩几秒也能显示在节点上。
//
// 节点上的东西：
//   · 圆环：一圈 = 1 分钟，中间写"上一张出图完成之后过了多久"（正在出图时写这张已经跑了多久）
//   · 「✔ 这张有效」：点一下记一张（存在 node.properties.pcTimer.valid）
//   · 「⏱ 计时设置…」：试听 / 导入音效文件 / 恢复默认（小黄鸭）/ 有效图清零（秒数在节点那颗控件上，
//     面板里改的也是同一个值）
//   · 超过设定秒数、而且**确实有事在跑**（正在出图 / 套图正在排）→ 响一声 + 放一圈水波；全空闲就不叫了
import { app } from "../../scripts/app.js";
import * as apiMod from "../../scripts/api.js";

const NODE_NAME = "PromptToolTimer";
const BATCH_STATUS = "/prompt_sync/batch/status";
const SOUND_UPLOAD = "/prompt_sync/timer/sound";
// 第一百零七批（他原话）：「现在是**黄条读秒制图时间，灰条读秒制图后的休息时间**，可以设置是黄条还是灰条
//   读秒一段时间后叫一声，**二者独立**，所以可以**设置两声**」→ 阈值拆成两颗控件（0 = 那一侧不叫）。
const W_SEC_GEN = "制图超过多少秒提醒";       // 控件 1（黄条 = 制图时间）
const W_SEC_REST = "休息超过多少秒提醒";      // 控件 2（灰条 = 休息时间）
const W_SEC_OLD = "每超过多少秒提醒一次";      // 第一百零六批那版的旧名字（后端还没重启时兜底读它）
const TIMER_SEC_DEFAULT = 60;
const TIMER_SEC_MIN = 0;                     // 0 = 不提醒
const TIMER_SEC_MAX = 3600;
const STATUS_H = 46;                 // 底部预留：一行状态字（圆环现在占节点主体，见 clockGeo）
const NODE_WIDGET_H = 20;            // ComfyUI 前端里"没有 computeSize / computeLayoutSize 的控件"的默认高（见 widgetStackH）
const CLOCK_MIN_R = 34;              // 表盘最小 / 最大半径
const CLOCK_MAX_R = 140;
const CLOCK_BLOCK = 176;             // 表盘那一块占多高（新节点默认这么多 → 半径 ~80；拖高时这块会一起长）
const TITLE_H = 34;                  // 标题栏高度（表盘从这个下面开始摆）
const CORNER_R = 13;                 // 右下角那两颗小圆键的半径（静音 / 关机）
const CORNER_GAP = 6;
const CORNER_PAD = 8;
const RIPPLE_MS = 1500;              // 水波时长
const POLL_MS = 2000;                // 问一次套图排队的休息秒数
const POLL_RETRY_MS = 30000;         // 连着问不到就慢下来重试
const BTN_VALID = "✔ 这张有效";
const BTN_TIMER = "⏱ 计时设置…";
// ★ 2026-11-03（他第 1 条）：「计时器能不能来一个按键？点击之后它就会以浮窗的形式直接浮在角落，
//   可以将其拖动……浮窗状态下只显示表盘本身，甚至可以在设置中调整它，使其打开工作流就存在」
const BTN_FLOAT = "◱ 浮窗";
// ★ 2026-11-04（他第 2 条）：关机键从画布圆钮改成真按钮
const BTN_POWER = "⏻ 关机";
function paintPowerBtn(node) {
  try {
    const w = node && node.__pcPowerBtn;
    if (!w) return;
    const off = !!(node.properties && node.properties.pcTimer && node.properties.pcTimer.off);
    const t = off ? "⏻ 开机（点了继续计时）" : BTN_POWER;
    w.name = t; w.label = t;
    if (w.options && typeof w.options === "object") w.options.label = t;
  } catch (e) { /* 忽略 */ }
}
const FLOAT_KEY = "promptCopier.timerFloat.v1";   // {on, x, y, auto}
const FLOAT_SIZE = 152;                           // 浮窗边长（只放表盘，别的都不要）
const VOL_DEFAULT = 100;             // ★ 第一百四十六批（他第 4 条）：**每个音效各自一份音量（百分比）**，初始 100
const VOL_MAX = 200;                  // 他原话：「计时器音量改成最多可以到达 200，且每个音频的声音初始 100，独立声音大小」
const VOL_KEYS = ["duck", "hajimi", "wow", "bell", "manbo", "file"];   // file = 他自己导入的那个文件
// 内置音效（2026-10-06 第一百零八批按他要求改的）：
//   · **去掉**「哈基米（猫叫）」的合成版和「木鱼咚」（他点名不要）
//   · **加上**他给的两个真音频文件（跟节点的其它文件一起发出去，不走"导入"那条路）
//     —— 这两个是 `web/sounds/` 里随包带的，用 `/extensions/<目录>/sounds/xxx.wav` 直接播
//   · **第一百三十六批**（他原话：「计时器中的水滴音效删除，加上这个音效，这样一共 5 个音效，
//     **都要是默认设置中的，能分享到其他人，别人也能用**」）→ **去掉「水滴」、加上「漫波」**：
//     漫波是他给的 mp3，放在 `web/sounds/manbo.mp3`（ASCII 文件名）**跟着节点包一起发出去**，
//     别人解包就能直接播，不用自己导入；5 个音效全部在默认列表里。
const BUILTIN_SOUNDS = {
  hajimi: { name: "哈基米", file: "hajimi.wav" },
  wow: { name: "WOW", file: "wow.wav" },
  manbo: { name: "漫波", file: "manbo.mp3" },
};
const TONES = [
  { id: "duck", name: "小黄鸭（默认）" },
  { id: "hajimi", name: "哈基米", file: BUILTIN_SOUNDS.hajimi.file },
  { id: "wow", name: "WOW", file: BUILTIN_SOUNDS.wow.file },
  { id: "bell", name: "铃铛叮咚" },
  { id: "manbo", name: "漫波", file: BUILTIN_SOUNDS.manbo.file },
];
function soundUrl(file) { return "/extensions/ComfyUI-PromptSync/sounds/" + file; }

const api = (apiMod && apiMod.api) || (typeof window !== "undefined" && window.comfyAPI?.api?.api) || null;

function log(...args) { console.log("[计时器]", ...args); }

// 同一时间只服务一颗（他画布上一般就放一颗）：ticker / 重画都认它
let activeNode = null;

// 计时状态：startAt = 这一段的起点（0 = 还没开始过）；genAt = 这张什么时候开始出的；
// lastDur = 上一张出图用了多少秒（"生图效率"）；
// genFired / restFired = **这一段**的黄条 / 灰条是不是已经叫过了（他报"连续叫好多下" → 改成每段只叫一次）；
// stopped = 他点了表盘（停表且不叫，下一次出图自动恢复）；rippleAt = 水波起点
const T = {
  startAt: 0, genAt: 0, lastDur: 0, tick: null, raf: 0, rippleAt: 0, shown: "",
  genFired: true, restFired: true, stopped: false, alerts: 0,
  generating: false,
  batch: { ok: false, running: false, paused: false, resting: false, rest_left: 0, index: 0, planned: 0, done: 0 },
  batchFail: 0, retryAt: 0,
};

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

function redrawNode(node) {
  try { node && node.graph && node.graph.setDirtyCanvas && node.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
  try { app.graph && app.graph.setDirtyCanvas && app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 节点属性
// ⚠️ 别塞 widgets_values（那是"控件值的数组"）—— 有效图计数和音效都放 properties。
function nodeProps(node) {
  if (!node.properties || typeof node.properties !== "object") node.properties = {};
  return node.properties;
}

function timerCfg(node) {
  const p = nodeProps(node);
  let c = p.pcTimer;
  if (!c || typeof c !== "object") c = p.pcTimer = {};
  if (typeof c.valid !== "number" || !Number.isFinite(c.valid)) c.valid = 0;
  if (!c.sound || typeof c.sound !== "object") c.sound = null;
  // ★ 第一百四十六批（他第 4 条）：「每个音频的声音初始 100，独立声音大小」
  //   一份给每个内置音效 + 一份给"导入的文件"，各记各的（0~200%，默认 100%）。
  //   老的全局 `c.vol`（0~1 一个数管所有）作废 → 删掉，不参与（他那次就是要求"独立"）。
  if (!c.vols || typeof c.vols !== "object") c.vols = {};
  for (const k of VOL_KEYS) {
    let v = Number(c.vols[k]);
    if (!Number.isFinite(v)) v = VOL_DEFAULT;
    c.vols[k] = Math.max(0, Math.min(VOL_MAX, Math.round(v)));
  }
  if (c.vol !== undefined) { try { delete c.vol; } catch (e) { /* 忽略 */ } }
  if (typeof c.tone !== "string" || !TONES.some(function (t) { return t.id === c.tone; })) c.tone = "duck";
  c.muted = !!c.muted;            // 静音（只关声音，水波照放）—— 右下角那颗键切的
  c.off = !!c.off;                // 关机（停表 + 不再叫，再点一下开回来）—— 右下角那颗键切的
  return c;
}

// 这个音效的音量存在哪个格子里（内置的按 id；导入了文件就是那一格 file）
function volKeyOf(node, cfg) {
  const c = cfg || timerCfg(node);
  return (c.sound && c.sound.url) ? "file" : String(c.tone || "duck");
}
function volOf(node, key) {
  const c = timerCfg(node);
  return c.vols[key || volKeyOf(node, c)];
}
function volNameOf(node, key) {
  const c = timerCfg(node);
  const k = key || volKeyOf(node, c);
  if (k === "file") return (c.sound && c.sound.name) ? String(c.sound.name) : "导入的文件";
  const t = TONES.filter(function (x) { return x.id === k; })[0];
  return t ? t.name : TONES[0].name;
}
function setVolKey(node, key, v) {
  const c = timerCfg(node);
  const k = VOL_KEYS.indexOf(key) >= 0 ? key : volKeyOf(node, c);
  let n = Number(v);
  if (!Number.isFinite(n)) n = VOL_DEFAULT;
  // 兼容老写法：小于 1.5 的小数当成"0~1 的比例"（0.8 → 80%）；其余一律按百分比
  if (n > 0 && n < 1.5 && n !== Math.round(n)) n = n * 100;
  c.vols[k] = Math.max(0, Math.min(VOL_MAX, Math.round(n)));
  return c.vols[k];
}
function setVol(node, v) { return setVolKey(node, volKeyOf(node), v); }   // 老签名：设"当前这个音效"的音量

function toneName(node) {
  const c = timerCfg(node);
  const t = TONES.filter(function (x) { return x.id === c.tone; })[0];
  return (t ? t.name : TONES[0].name);
}

// ★ 第一百四十六批：音量最多能到 **200%** —— 而 `HTMLAudioElement.volume` 最多只认 1.0，
//   所以超过 100% 的那一半得靠 WebAudio 补（`createMediaElementSource` + 一个增益节点，只建一次）。
//   元素自己的 volume 照样设（≤1 那部分），这样即使增益那条路建不起来，最差也是按 100% 播。
let mediaSrc = null, mediaGain = null;
function boostMediaEl(pct) {
  try {
    const a = audio();
    if (!a || !audioEl) return false;
    if (!mediaSrc) {
      mediaSrc = a.createMediaElementSource(audioEl);
      mediaGain = a.createGain();
      mediaSrc.connect(mediaGain);
      mediaGain.connect(a.destination);
    }
    mediaGain.gain.value = Math.max(0, pct / 100);
    return true;
  } catch (e) {
    log("这个后端补不了 100% 以上的音量（按 100% 播）", e);
    return false;
  }
}
function setElVol(pct) {
  const p = Math.max(0, Number(pct) || 0);
  try { if (audioEl) audioEl.volume = Math.min(1, p / 100); } catch (e) { /* 忽略 */ }
  if (p > 100) boostMediaEl(p);
  else if (mediaGain) { try { mediaGain.gain.value = 1; } catch (e) { /* 忽略 */ } }
}

// 表盘几何（2026-10-06 第一百零八批他报「**钟表应该在按钮正上方，现在的钟表被挡住了**」→ 改成：
//   用 `node.widgets_start_y` 把**控件整体往下推**，表盘就独占上面那块，控件全在它下面。
//   ⚠️ `widgets_start_y` 是 ComfyUI 前端支持的（`_arrangeWidgets` / `computeSize` 都读它），
//      默认值是"标题栏高度 + 2"，也就是**从节点顶端算起**的 y。
// 控件那一摞占多高 —— 算法**跟 ComfyUI 前端 `_arrangeWidgets` 一模一样**（第一百零九批对齐的）：
//   ① `computeSize` 的：高度 + 4；② `computeLayoutSize` 的（DOM 控件那颗大绿键走这条）：minHeight，**不加 4**；
//   ③ 两样都没有的（普通数字/按钮控件）：20（前端 `NODE_WIDGET_HEIGHT`）+ 4。
//   ⚠️ 不跟齐就会出现"算出来的摞高 < 实际摞高"→ 控件一路压到底部那行状态字上（他第一百零九批的截图）。
function widgetStackH(node) {
  let h = 0;
  const ws = (node && node.widgets) || [];
  for (const w of ws) {
    if (!w || w.hidden) continue;                        // 前端 `getLayoutWidgets()` 就是 filter(!hidden)
    try {
      if (typeof w.computeSize === "function") {
        h += (Number(w.computeSize(node.size ? node.size[0] : 320)[1]) || NODE_WIDGET_H) + 4;
      } else if (typeof w.computeLayoutSize === "function") {
        h += Number((w.computeLayoutSize(node) || {}).minHeight) || 50;
      } else {
        h += NODE_WIDGET_H + 4;
      }
    } catch (e) { h += NODE_WIDGET_H + 4; }
  }
  return h;
}
// 让表盘独占上面那块：控件从 `TITLE_H + block` 开始排；节点被拖高时多出来的空间**全给表盘**
// ★ 2026-10-08（第一百二十六批 · 他第 2 条）：节点被拖**小**时，以前表盘硬占 CLOCK_BLOCK(176) 不让，
//   于是控件摞整摞被顶到节点框外面（看不见也滚不了）。现在表盘可以一路缩到 CLOCK_MIN_BLOCK，
//   把剩下的高度让给控件摞（装不下就由 prompt_scroll.js 裁掉 + 右边滚轮滚）。
const CLOCK_MIN_BLOCK = 96;          // 表盘那一块最小占多高（圆心 + 最小半径 34 + 上下留白）
const STACK_MIN_H = 72;              // 给控件摞至少留这么高（不然拖到底就只剩表盘，滚轮也没得滚）
function fitClock(node) {
  try {
    const wH = widgetStackH(node);
    const h = (node && node.size ? node.size[1] : 0) || 0;
    const base = TITLE_H + CLOCK_BLOCK + wH + STATUS_H + 6;
    const room = h - TITLE_H - STATUS_H - 6 - STACK_MIN_H;      // 表盘最多能占多少
    let block = CLOCK_BLOCK + Math.max(0, h - base);
    if (node && node.__pcScrollOn) block = Math.max(CLOCK_MIN_BLOCK, Math.min(block, Math.max(CLOCK_MIN_BLOCK, room)));
    const want = TITLE_H + block;
    if (node.widgets_start_y !== want) node.widgets_start_y = want;
    return block;
  } catch (e) { return CLOCK_BLOCK; }
}
// 让前端**重新摆一次**控件（真正按 `widgets_start_y` 摆放控件的是 `node.arrange()` / `_arrangeWidgets`）
function reflow(node) {
  try { if (node && typeof node.arrange === "function") node.arrange(); } catch (e) { /* 忽略 */ }
  try { redrawNode(node); } catch (e) { /* 忽略 */ }
}
// 节点尺寸至少得放得下：标题栏 + 表盘那一块 + 控件摞 + 底部状态字。
// ⚠️ 第一百零九批：老工作流里存下来的尺寸可能**比这个下限还矮**（那时候还没有绿键那 52px），
//    载入时把它补到下限，否则底部那行小字又被按钮压住（他截图报的就是这个）。
// `allowSmall`（★ 第一百二十六批）：读工作流 / 切「这张有效」时**允许**节点是"拖小的"那个高度
//   —— 那时装不下是正常的（裁掉 + 滚轮滚），别再把它撑回去。新节点还是按完整高度生出来（默认样子不变）。
function ensureFit(node, force, allowSmall) {
  try {
    const sz = (node && node.size) || [0, 0];
    const needW = 320;
    const fullH = Math.max(380, TITLE_H + CLOCK_BLOCK + widgetStackH(node) + STATUS_H + 6);
    const smallH = TITLE_H + CLOCK_MIN_BLOCK + STATUS_H + 40;
    const needH = (allowSmall && node && node.__pcScrollOn) ? smallH : fullH;
    if ((sz[1] || 0) < needH || (sz[0] || 0) < needW) {
      if (force) node.setSize([Math.max(needW, sz[0] || 0), Math.max(needH, sz[1] || 0)]);
    }
    return needH;
  } catch (e) { return 380; }
}
function clockGeo(node) {
  const w = (node && node.size ? node.size[0] : 320);
  const h = (node && node.size ? node.size[1] : 380);
  const block = (node && typeof node.widgets_start_y === "number")
    ? Math.max(CLOCK_BLOCK, node.widgets_start_y - TITLE_H) : CLOCK_BLOCK;
  const top = TITLE_H + 6;
  const bottom = Math.max(top + 40, TITLE_H + block - 6);
  const cx = w / 2;
  const cy = (top + bottom) / 2;
  let r = Math.min((w - 24) / 2, (bottom - top) / 2);
  r = Math.min(CLOCK_MAX_R, Math.max(CLOCK_MIN_R, r));
  return { cx: cx, cy: cy, r: r, top: top, bottom: bottom, w: w, h: h };
}

function clampSec(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = TIMER_SEC_MIN;
  return Math.min(TIMER_SEC_MAX, Math.max(TIMER_SEC_MIN, Math.round(n)));
}

// 两条阈值都存在**节点那两颗控件**上（跟着工作流走）：`制图…`（黄条）/ `休息…`（灰条）。
// ⚠️ 后端还没重启时节点上只有第一百零六批那颗旧控件（`每超过多少秒提醒一次`）→ 兜底把它当制图阈值读，
//    休息阈值读不到就按 0（不叫）。
function resolveSecWidget(node, name) {
  return resolveWidget(node, name) || (name === W_SEC_GEN ? resolveWidget(node, W_SEC_OLD) : null);
}
function getSecGen(node) {
  const w = resolveSecWidget(node, W_SEC_GEN);
  const v = Number(w && w.value);
  return Number.isFinite(v) && v >= 0 ? clampSec(v) : TIMER_SEC_DEFAULT;
}
function getSecRest(node) {
  const w = resolveSecWidget(node, W_SEC_REST);
  const v = Number(w && w.value);
  return Number.isFinite(v) && v >= 0 ? clampSec(v) : 0;
}
function getSec(node) { return getSecGen(node); }        // 兼容旧调用（面板里显示的第一颗）
function setSec(node, n, which) {
  const name = (which === "rest") ? W_SEC_REST : W_SEC_GEN;
  const v = clampSec(n);
  const w = resolveSecWidget(node, name);
  if (w) {
    w.value = v;
    try { if (typeof w.callback === "function") w.callback(v); } catch (e) { /* 忽略 */ }
  }
  redrawNode(node);
  return v;
}

// ---------------------------------------------------------------- 计时本体
function fmtElapsed(sec) {
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function ringInfo() {
  const ms = T.startAt ? Math.max(0, Date.now() - T.startAt) : 0;
  const sec = Math.floor(ms / 1000);
  const every = activeNode ? getSecGen(activeNode) : TIMER_SEC_DEFAULT;
  return {
    ms: ms, sec: sec, text: fmtElapsed(sec), lap: Math.floor(sec / 60), frac: (sec % 60) / 60,
    every: every, active: !!T.startAt, stopped: !!T.stopped,
  };
}

function startStopwatch() {
  T.startAt = Date.now();
  T.shown = "";
  ensureTicker();
}

function stopStopwatch() {
  T.startAt = 0;
  T.shown = "";
  if (T.tick) { try { if (T.tick.stop) T.tick.stop(); } catch (eTS) { /* 忽略 */ } T.tick = null; }
}

// ★ 273s（他报的 bug）：「如果在另外一个工作流生好图，那么有计时器的工作流就会一直开始计时，
//   并且到了规定计时的时间也不会声响，而是会切回这个有计时器的工作流时才会开始声响，
//   应该改成另外一个工作流的生图，和这个计时器没关系才对」
//   真因：onGenerationStart/Done **没判断这次生图是不是发生在这颗计时器所在的画布上** ——
//   ComfyUI 的 execution_start / execution_success 是**整个实例**的事件，切走工作流照样会触发；
//   于是 T.generating / T.genAt 在别的画布上被改写，checkAlert 又因为 activeNode 为空而不叫，
//   等切回来 onNodeCreated 认回节点，残留的 genAt 早超时 → 立刻补响。
//   → 判据：**生图事件先确认"我这颗计时器还在当前画布上"**，不在就整段不管。
function liveTimer() {
  try {
    if (!activeNode) return null;
    const ns = (window.app && window.app.graph && window.app.graph._nodes) || [];
    if (ns.indexOf(activeNode) < 0) { activeNode = null; return null; }   // 顺手清掉过期引用
    return activeNode;
  } catch (e) { return null; }
}

// ---- ComfyUI 自己的出图事件：开始出图 / 出图完成（**只认本画布的那颗计时器**）
function onGenerationStart() {
  if (!liveTimer()) return;                    // ★ 273s：别的画布在生图，跟这颗计时器无关
  T.generating = true;
  T.genAt = Date.now();
  T.genFired = false;              // 黄条：这一张重新开始读秒（到点叫一次）
  T.restFired = true;              // 灰条：休息段结束
  T.stopped = false;               // ⚠️「点表盘停表」到下一次作图就自己恢复
  startStopwatch();                // 这一段从"开始出图"起算
  log("开始出图，计时起跑");
}

function onGenerationDone() {
  if (!liveTimer()) return;                    // ★ 273s：同上，不是我这张画布的出图就不管
  T.generating = false;
  T.lastDur = T.genAt ? Math.max(0, (Date.now() - T.genAt) / 1000) : 0;   // 上一张用时（生图效率）
  T.restFired = false;             // 灰条：休息段重新开始读秒（到点叫一次）
  T.genFired = true;               // 黄条：制图段结束
  T.stopped = false;
  startStopwatch();                // 这一段从"出图完成"起算（他说的"出图后过了多久"）
  log(`出图完成，这张用了 ${Math.round(T.lastDur)} 秒`);
}

// 每 0.25 秒看一眼：显示变了才重画（不白烧画布）；顺带判"够不够久，该提醒了"
// ★ 2026-11-04（他第 11 条）：「如果前台切其他页面，即使切到一分钟的时候不会叫，而是会切回 ComfyUI 的时候再叫」
//   真因：浏览器会把**后台标签页的主线程定时器降到最快 1 分钟一次** → 250ms 的 tick 变成"一分钟才醒一下"，
//   于是该响的时候不响、切回来才补响（和第 273s 那条"跨工作流补响"是两个不同的根）。
//   修法：**让 Worker 去数时间**（Worker 在后台不会被这样降频），它每 250ms 丢一条消息进来，
//   主线程收到就跑同一段 tick —— 业务逻辑一条都不用改。Worker 建不出来就退回原来的 setInterval。
function pcTicker(ms, fn) {
  var w = null, iv = 0;
  const step = Math.max(120, ms | 0);
  try {
    const src = "setInterval(function(){postMessage(1);}, " + step + ");";
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    w = new Worker(url);
    w.onmessage = function () { try { fn(); } catch (e) { /* 忽略 */ } };
    w.onerror = function () { try { w.terminate(); } catch (e2) { /* 忽略 */ } w = null; };
  } catch (e) { w = null; }
  if (!w) iv = setInterval(function () { try { fn(); } catch (e3) { /* 忽略 */ } }, step);
  return {
    worker: !!w,
    stop: function () {
      try { if (w) { w.terminate(); w = null; } } catch (e4) { /* 忽略 */ }
      try { if (iv) { clearInterval(iv); iv = 0; } } catch (e5) { /* 忽略 */ }
    },
  };
}
function ensureTicker() {
  if (T.tick) return;
  T.tick = pcTicker(250, () => {
    if (!activeNode) return;
    const info = ringInfo();
    const key = info.text + "|" + info.lap + "|" + (T.generating ? "g" : "-") + "|" + (T.batch.resting ? T.batch.rest_left : "-");
    if (!rippleActive() && key === T.shown) return;
    T.shown = key;
    redrawNode(activeNode);
    checkAlert(info);
  });
}

// 提醒只在"确实有事在跑"的时候发生：正在出图，或者套图正在排（全都空闲就不叫，免得半夜一直响）
// ⚠️ 第一百零七批他报「叫声为什么会**连续叫好多下**」→ 语义从"每超过 N 秒就叫一次"改成
//    **每段只叫一次**：黄条（制图）到点一声、灰条（休息）到点一声，各自独立，最多两声。
function checkAlert(info) {
  if (!activeNode) return false;
  const cfg = timerCfg(activeNode);
  if (cfg.off) return false;                                   // 关机键
  if (T.stopped) return false;                                 // 点了表盘：停表且不叫
  // ⚠️ 第一百零七批之前这里是"没在出图、套图也没在排就不叫"（防半夜一直响）。现在改成**每段只叫一次**，
  //    半夜重复响的根已经不在了 → **单张出图**的场景也该提醒（他说的"灰条读秒休息时间到点叫一声"就是它）。
  if (!T.generating && !info.active) return false;
  if (T.generating) {
    const th = getSecGen(activeNode);
    if (th > 0 && !T.genFired && info.sec >= th) {
      T.genFired = true;
      fireAlert(activeNode, "制图");
      return true;
    }
    return false;
  }
  const th = getSecRest(activeNode);
  if (th > 0 && !T.restFired && info.sec >= th) {
    T.restFired = true;
    fireAlert(activeNode, "休息");
    return true;
  }
  return false;
}

function fireAlert(node, which) {
  T.alerts += 1;                            // 记账：到点一共响了几声（自测拿它验"每段只叫一次"）
  try { playSound(node); } catch (e) { log("响铃失败", e); }
  startRipple();
  const c = timerCfg(node);
  log(`提醒（${which || "?"}）：已经过了 ${fmtElapsed(ringInfo().sec)}`
    + `（制图 ${getSecGen(node)}s / 休息 ${getSecRest(node)}s${c.muted ? " · 已静音" : ""}）`);
}

// ★ 2026-11-04（他第 7 条）：「计时器额外在一种情况下也会发声，那就是提示词优化完成、已经发送到文本框的时候。
//   优化的提示词如果放到暂存节点里，不会发生」
//   → 给节点侧开一个口：**结果真的写进文本框那一刻**才响一声（用「铃铛叮咚」那档音效，音量跟它自己那份走）。
//   进暂存节点走的是 `__pcStageAccept`，那边不调这个口，所以不响 —— 正好是他要的"放暂存里不响"。
//   关机（旁路）/ 静音的时候不打扰。
window.__pcTimerPing = function (why) {
  try {
    const node = someTimerNode();
    if (node) {
      const c = timerCfg(node);
      if (c.off || c.muted) return false;
    }
    playTone("bell", node ? volOf(node, "bell") : 55);
    log("提示词写好写进文本框了，响一声" + (why ? "（" + why + "）" : ""));
    return true;
  } catch (e) { log("提示词完成音失败", e); return false; }
};

// ---- 音效：默认是**现场合成的橡皮鸭叫**（不带音频文件，零版权零网络）；
//      他在「⏱ 计时设置」里可以导入自己的文件替换掉。
let audioCtx = null;
let audioEl = null;

function audio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) {
    try { audioCtx = new AC(); } catch (e) { return null; }
  }
  if (audioCtx.state === "suspended") { try { audioCtx.resume(); } catch (e) { /* 还要用户点一下 */ } }
  return audioCtx;
}

// 一个"音头"：频率从 f0 滑到 f1、带一点颤音、过一个带通/低通，再乘上音量
function beep(a, opt) {
  const t0 = opt.t0, dur = opt.dur, f0 = opt.f0, f1 = (opt.f1 == null ? opt.f0 : opt.f1);
  const vol = Math.max(0.0002, (opt.vol == null ? 0.3 : opt.vol) * opt.master);
  const gain = a.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + (opt.attack || 0.012));
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let last = gain;
  if (opt.filter) {
    const flt = a.createBiquadFilter();
    flt.type = opt.filter;
    flt.frequency.setValueAtTime(opt.fc || 1200, t0);
    if (opt.q != null) flt.Q.value = opt.q;
    gain.connect(flt);
    last = flt;
  }
  const osc = a.createOscillator();
  osc.type = opt.type || "sawtooth";
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur * (opt.glide == null ? 0.85 : opt.glide));
  osc.connect(gain);
  let lfo = null, lg = null;
  if (opt.vib) {
    lfo = a.createOscillator();
    lg = a.createGain();
    lfo.frequency.value = opt.vib;
    lg.gain.value = opt.vibDepth || 45;
    lfo.connect(lg); lg.connect(osc.frequency);
    lfo.start(t0); lfo.stop(t0 + dur + 0.05);
  }
  osc.start(t0); osc.stop(t0 + dur + 0.05);
  last.connect(a.destination);
}

function synthDuck(master) {
  const a = audio();
  if (!a) return false;
  const t0 = a.currentTime + 0.01;
  // 橡皮鸭：两短声、音高上滑 + 26Hz 颤音
  beep(a, { t0: t0, dur: 0.16, f0: 700, f1: 1150, vol: 0.30, master: master, type: "sawtooth", filter: "bandpass", fc: 1050, q: 3.2, vib: 26 });
  beep(a, { t0: t0 + 0.20, dur: 0.21, f0: 820, f1: 1330, vol: 0.26, master: master, type: "sawtooth", filter: "bandpass", fc: 1230, q: 3.2, vib: 26 });
  return true;
}

function synthBell(master) {
  const a = audio();
  if (!a) return false;
  const t0 = a.currentTime + 0.01;
  beep(a, { t0: t0, dur: 0.5, f0: 1180, f1: 1180, vol: 0.20, master: master, type: "sine", attack: 0.006 });
  beep(a, { t0: t0 + 0.02, dur: 0.42, f0: 1770, f1: 1760, vol: 0.12, master: master, type: "sine", attack: 0.006 });
  beep(a, { t0: t0 + 0.26, dur: 0.55, f0: 880, f1: 880, vol: 0.20, master: master, type: "sine", attack: 0.006 });
  beep(a, { t0: t0 + 0.28, dur: 0.5, f0: 1320, f1: 1310, vol: 0.10, master: master, type: "sine", attack: 0.006 });
  return true;
}

function synthDrop(master) {
  const a = audio();
  if (!a) return false;
  const t0 = a.currentTime + 0.01;
  beep(a, { t0: t0, dur: 0.18, f0: 1350, f1: 320, vol: 0.26, master: master, type: "sine", attack: 0.004, glide: 0.95 });
  return true;
}

function playTone(id, pct) {                            // pct = 百分比（0~200）
  const t = TONES.filter(function (x) { return x.id === id; })[0];
  if (t && t.file) {                                   // 随包带的真音频（哈基米 / WOW / 漫波）
    try {
      const url = soundUrl(t.file);
      if (!audioEl) audioEl = new Audio();
      if (audioEl.src.indexOf(url) < 0) audioEl.src = url;
      setElVol(pct);
      audioEl.currentTime = 0;
      const p = audioEl.play();
      if (p && typeof p.catch === "function") p.catch(function () { log("这个音频播不出来：" + url); });
      return true;
    } catch (e) { log("放 " + id + " 失败", e); return false; }
  }
  const master = pct / 100;                            // 合成的没有 1.0 上限，200% 就是真的响一倍
  if (id === "bell") return synthBell(master);
  if (id === "drop") return synthDrop(master);
  return synthDuck(master);
}

function playSound(node) {
  const cfg = timerCfg(node);
  if (cfg.muted) return false;              // 静音（右下角那颗键）→ 只放水波、不响
  const pct = volOf(node);                  // ★ 第一百四十六批：认"当前这个音效"自己那一份音量
  const snd = cfg.sound;
  if (snd && snd.url) {
    try {
      if (!audioEl) audioEl = new Audio();
      if (audioEl.src.indexOf(snd.url) < 0) audioEl.src = snd.url;
      setElVol(pct);
      audioEl.currentTime = 0;
      const p = audioEl.play();
      if (p && typeof p.catch === "function") p.catch(() => playTone(cfg.tone, pct));   // 播不了就退回内置音
      return true;
    } catch (e) { /* 掉到内置音 */ }
  }
  return playTone(cfg.tone, pct);
}

// ---- 水波特效：从圆环那个位置一圈圈荡开（他说的"比较明显的水波特效"）
function startRipple() {
  T.rippleAt = Date.now();
  const until = T.rippleAt + RIPPLE_MS;
  const step = () => {
    T.raf = 0;
    if (!activeNode) return;
    redrawNode(activeNode);
    if (Date.now() < until) T.raf = requestAnimationFrame(step);
    else { T.rippleAt = 0; redrawNode(activeNode); }
  };
  if (T.raf) cancelAnimationFrame(T.raf);
  T.raf = requestAnimationFrame(step);
}

function rippleActive() {
  return !!T.rippleAt && Date.now() - T.rippleAt < RIPPLE_MS;
}

// ---- ✔ 这张有效：一颗**绿色大键**（他第一百零七批原话：「这张有效这个键，做的更大一点更显眼一点，
//      颜色不能是灰色的」）→ 用 addDOMWidget 自己画一颗大按钮；后端那颗原生按钮照旧留着但**藏起来**
//      （测试 / 老工作流兼容都靠它，`node.__pcValidBtn` 还指着它）。
function paintValid(node) {
  const n = timerCfg(node).valid;
  const text = n > 0 ? (BTN_VALID + "（已记 " + n + " 张）") : BTN_VALID;
  const w = node && node.__pcValidBtn;
  if (w) {
    try { w.name = text; } catch (e) { /* 忽略 */ }
    try { w.label = text; } catch (e) { /* 忽略 */ }
    try { if (w.options && typeof w.options === "object") w.options.label = text; } catch (e) { /* 忽略 */ }
  }
  const el2 = node && node.__pcValidEl;
  if (el2) { try { el2.textContent = text; } catch (e) { /* 忽略 */ } }
}

function setValid(node, n) {
  timerCfg(node).valid = Math.max(0, Math.round(Number(n) || 0));
  paintValid(node);
  redrawNode(node);
}

function bumpValid(node) {
  const cfg = timerCfg(node);
  setValid(node, cfg.valid + 1);
  log(`记下第 ${cfg.valid} 张有效图`);
}

// ---------------------------------------------------------------- 套图排队的休息秒数（顺带读一下）
async function pollBatch() {
  if (T.batchFail >= 3 && Date.now() < T.retryAt) return;
  try {
    const r = await fetch(BATCH_STATUS, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    T.batch = {
      ok: true,
      running: !!j.running,
      paused: !!j.paused,
      resting: String(j.stage || "") === "resting",
      rest_left: Number(j.rest_left) || 0,
      index: Number(j.index) || 0,
      planned: Number(j.planned) || 0,
      done: Number(j.done) || 0,
    };
    T.batchFail = 0;
  } catch (e) {
    T.batchFail += 1;
    if (T.batchFail >= 3) T.retryAt = Date.now() + POLL_RETRY_MS;   // 问不到就慢下来重试
    T.batch = { ok: false, running: false, paused: false, resting: false, rest_left: 0, index: 0, planned: 0, done: 0 };
  }
  if (activeNode) redrawNode(activeNode);
}

let pollTimer = null;
function startBatchPoll() {
  if (pollTimer) return;
  pollBatch();
  pollTimer = setInterval(pollBatch, POLL_MS);
}
function stopBatchPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------- 面板
const PANEL_CSS = `
.ptm-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9000;display:flex;align-items:center;justify-content:center;}
.ptm-card{width:440px;max-width:92vw;max-height:76vh;overflow-x:hidden;overflow-y:auto;background:#232326;color:#e6ecf5;
  border:1px solid #3a3f47;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);
  font:13px/1.65 "Microsoft YaHei",system-ui,sans-serif;padding:13px 15px 15px;}
.ptm-card h3{margin:0 0 6px;font-size:15px;font-weight:600;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:10px;}
.ptm-x{cursor:pointer;color:#9aa4b2;font-size:15px;padding:0 4px;border:0;background:none;}
.ptm-x:hover{color:#ff7b7b;}
.ptm-tip{color:#98a2b3;font-size:11.5px;margin:3px 0 9px;}
.ptm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;}
.ptm-row>label{color:#c8d2e0;flex:0 0 auto;}
.ptm-card input[type=number]{width:66px;background:#161719;color:#fff;border:1px solid #3a3f47;border-radius:6px;padding:3px 6px;font-size:13px;}
/* 音量滑条（第一百零六批他要求"调整声音大小"） */
.ptm-card input[type=range]{flex:1 1 140px;min-width:110px;accent-color:#5aa0e0;cursor:pointer;}
.ptm-btn{cursor:pointer;background:#2f343b;color:#e6ecf5;border:1px solid #454c56;border-radius:7px;padding:4px 9px;font-size:12.5px;}
.ptm-btn:hover{background:#3a4149;border-color:#5a636f;}
.ptm-btn.pri{background:#2b5f8a;border-color:#3d7fb4;}
.ptm-btn.pri:hover{background:#336f9f;}
.ptm-snd{color:#9fd8ff;word-break:break-all;}
.ptm-err{color:#ffb060;font-size:12px;min-height:16px;margin-top:6px;}
/* 两条读秒标签（黄条 = 制图 / 灰条 = 休息） */
.ptm-tag{flex:0 0 auto;font-size:11.5px;line-height:1;padding:3px 7px;border-radius:999px;border:1px solid currentColor;}
.ptm-tag.gen{color:#ffcf8a;background:rgba(255,196,92,.14);}
.ptm-tag.rest{color:#c6cede;background:rgba(150,162,180,.16);}
/* 第一百零七批：那颗**大绿键**（他要求「做的更大一点更显眼一点，颜色不能是灰色的」）；
   第一百零八批他补一句「**这张有效应该没这么大**」→ 高度定死 42px、最多 320 宽，居中 */
.ptm-valid-wrap{display:flex;align-items:center;justify-content:center;box-sizing:border-box;
  width:100%;padding:4px 4px 6px;overflow:hidden;}
.ptm-valid{display:block;width:100%;max-width:320px;height:42px;box-sizing:border-box;
  font:700 15px/1 "Microsoft YaHei",system-ui,sans-serif;letter-spacing:.5px;color:#fff;cursor:pointer;
  background:linear-gradient(180deg,#3fae6a,#2c8551);border:1px solid #57c483;border-radius:10px;
  box-shadow:0 2px 10px rgba(63,174,106,.35);}
.ptm-valid:hover{background:linear-gradient(180deg,#4cc17a,#31905a);box-shadow:0 3px 14px rgba(63,174,106,.5);}
.ptm-valid:active{transform:translateY(1px);}
`;

function injectPanelCss() {
  if (document.getElementById("ptm-style")) return;
  const s = document.createElement("style");
  s.id = "ptm-style";
  s.textContent = PANEL_CSS;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

// 一张会浮在页面中间的小卡片：✕ / 点背景 / Esc 都能关
function makeCard(title) {
  injectPanelCss();
  const back = el("div", "ptm-back");
  const card = el("div", "ptm-card");
  const head = el("h3");
  head.appendChild(el("span", null, title));
  const x = el("button", "ptm-x", "✕");
  head.appendChild(x);
  card.appendChild(head);
  back.appendChild(card);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() {
    try { back.remove(); } catch (e) { /* 忽略 */ }
    document.removeEventListener("keydown", onKey);
  }
  x.onclick = close;
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(back);
  return { back: back, card: card, close: close };
}

function soundName(node) {
  const cfg = timerCfg(node);
  return (cfg.sound && cfg.sound.name) ? cfg.sound.name : toneName(node);
}

function openTimerPanel(node) {
  const ui = makeCard("⏱ 计时与提醒（计时器节点）");
  ui.card.appendChild(el("div", "ptm-tip",
    "计时从「开始出图」和「出图完成」两个时刻各自起跑：**黄条 = 制图时间**（这一张已经出了多久）、"
    + "**灰条 = 休息时间**（上一张出完之后歇了多久）。两条**各自一个秒数、各自到点叫一声**（最多两声），"
    + "**0 = 那一侧不叫**。⚠️ 只在「确实有事在跑」的时候才提醒（正在出图 / 套图正在排），全空闲就不响。"));

  // ★ 第一百零七批：两条独立的秒数（他原话：「可以设置是黄条还是灰条读秒一段时间后叫一声，二者独立，所以可以设置两声」）
  const mkSecRow = (label, cls, which, val) => {
    const row = el("div", "ptm-row");
    const tag = el("span", "ptm-tag " + cls, label);
    row.appendChild(tag);
    row.appendChild(el("label", null, "超过"));
    const inp = document.createElement("input");
    inp.type = "number";
    inp.min = String(TIMER_SEC_MIN);
    inp.max = String(TIMER_SEC_MAX);
    inp.step = "5";
    inp.value = String(val);
    row.appendChild(inp);
    row.appendChild(el("span", null, "秒叫一声（0 = 不叫）"));
    const apply = () => { inp.value = String(setSec(node, inp.value, which)); };
    inp.addEventListener("change", apply);
    inp.addEventListener("blur", apply);
    ui.card.appendChild(row);
    return inp;
  };
  const genInp = mkSecRow("黄条 · 制图", "gen", "gen", getSecGen(node));
  const restInp = mkSecRow("灰条 · 休息", "rest", "rest", getSecRest(node));
  ui.card.appendChild(el("div", "ptm-tip", "（这两个秒数就是节点上那两颗控件，两处一个值；老工作流里那个秒数会落到「黄条 · 制图」上）"));

  // ---- 音效（他 2026-10-06 要"更多声音，比如哈基米"；下面这些**全是现场合成的**，不带音频文件）
  const rowTone = el("div", "ptm-row");
  rowTone.appendChild(el("label", null, "音效"));
  const toneBtns = {};
  TONES.forEach(function (t) {
    const b = el("button", "ptm-btn ptm-tone", t.name);
    b.onclick = function () {
      timerCfg(node).tone = t.id;
      timerCfg(node).sound = null;              // 选内置音 = 不再用导入的那个文件
      paintTones();
      paintVol();                               // ★ 第一百四十六批：音量滑条跟着切到这个音效自己那份
      sndLabel.textContent = soundName(node);
      const r = playSound(node);
      err.textContent = "给你听一下「" + t.name + "」（它自己的音量 " + volOf(node) + "%）"
        + (r ? "" : "（浏览器还没允许出声 —— 先在本页点一下）");
    };
    toneBtns[t.id] = b;
    rowTone.appendChild(b);
  });
  ui.card.appendChild(rowTone);
  function paintTones() {
    const cur = timerCfg(node).sound ? "" : timerCfg(node).tone;
    TONES.forEach(function (t) {
      const on = (t.id === cur);
      toneBtns[t.id].className = "ptm-btn ptm-tone" + (on ? " pri" : "");
      toneBtns[t.id].title = (on ? "现在是这个（" : "点一下换成这个（") + "它自己的音量 " + volOf(node, t.id) + "%）";
    });
  }

  // ★ 第一百四十六批（他第 4 条）：「计时器音量改成最多可以到达 200，且每个音频的声音初始 100，独立声音大小」
  //   → 一条滑条，但绑的是**当前这个音效自己那一份**：换音效时它会自动切过去（各记各的，互不影响）。
  const volRow = el("div", "ptm-row");
  const volLabel = el("label", null, "音量");
  const vol = document.createElement("input");
  vol.type = "range";
  vol.min = "0";
  vol.max = String(VOL_MAX);
  vol.step = "5";
  const volTxt = el("span", "ptm-snd", "");
  function paintVol() {
    const pct = volOf(node);
    volLabel.textContent = "音量（" + volNameOf(node) + "）";
    vol.value = String(pct);
    volTxt.textContent = pct + "%";
  }
  vol.oninput = function () {
    const v = setVol(node, vol.value);
    volLabel.textContent = "音量（" + volNameOf(node) + "）";
    volTxt.textContent = v + "%";
    vol.title = "这一个音效的音量：" + v + "%（0~200%，各音效互不影响）";
  };
  vol.onchange = function () { playSound(node); };
  volRow.appendChild(volLabel);
  volRow.appendChild(vol);
  volRow.appendChild(volTxt);
  ui.card.appendChild(volRow);
  ui.card.appendChild(el("div", "ptm-tip",
    "**每个音效各记一份音量**（0~200%，初始 100%）：换上面那颗音效键，这条滑条就切到它自己的那份；"
    + "导入的文件也算一份。0% = 不响（只放水波）。⚠️ 超过 100% 靠 WebAudio 补，播文件时如果后端不给面子，最多按 100% 响。"));
  paintVol();

  const rowSnd = el("div", "ptm-row");
  rowSnd.appendChild(el("label", null, "当前"));
  const sndLabel = el("span", "ptm-snd", soundName(node));
  rowSnd.appendChild(sndLabel);
  ui.card.appendChild(rowSnd);
  paintTones();

  const file = document.createElement("input");
  file.type = "file";
  file.accept = "audio/*";
  file.style.display = "none";
  ui.card.appendChild(file);

  const err = el("div", "ptm-err");
  const rowBtns = el("div", "ptm-row");
  const btnTry = el("button", "ptm-btn pri", "🔊 试听");
  btnTry.onclick = () => { playSound(node); err.textContent = "响一声给你听 —— 就是提醒时那一声"; };
  const btnImport = el("button", "ptm-btn", "📁 导入音效文件");
  btnImport.onclick = () => file.click();
  const btnDefault = el("button", "ptm-btn", "↩ 恢复默认（小黄鸭）");
  btnDefault.onclick = () => {
    const c = timerCfg(node);
    c.sound = null;
    c.tone = "duck";
    paintTones();
    paintVol();                                    // ★ 音量滑条切回"小黄鸭"那一份
    sndLabel.textContent = soundName(node);
    err.textContent = "已经换回默认的小黄鸭了";
    playSound(node);
  };
  rowBtns.appendChild(btnTry);
  rowBtns.appendChild(btnImport);
  rowBtns.appendChild(btnDefault);
  ui.card.appendChild(rowBtns);

  file.onchange = () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    const reader = new FileReader();
    err.textContent = "正在存音效…";
    reader.onload = async () => {
      try {
        const r = await fetch(SOUND_UPLOAD, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: f.name, data: String(reader.result || "") }),
        });
        const j = await r.json().catch(() => null);
        if (!j || !j.success) throw new Error((j && j.error) || ("HTTP " + r.status));
        timerCfg(node).sound = { name: String(j.name || f.name), file: j.file, url: j.url };
        paintTones();
        paintVol();                                // ★ 音量滑条切到"导入的文件"那一份
        sndLabel.textContent = soundName(node);
        err.textContent = "音效存好了，给你放一下听听（它自己的音量 " + volOf(node) + "%）";
        playSound(node);
      } catch (e) {
        err.textContent = "音效没存上：" + String((e && e.message) || e);
      }
    };
    reader.onerror = () => { err.textContent = "这个文件读不出来（换一个试试）"; };
    reader.readAsDataURL(f);
  };
  ui.card.appendChild(err);

  // ★ 2026-11-03（他第 4 条）：「计时器的设置里面也有静音和关机两个键，这两个键去掉」
  //   → 整排「开关」删掉。静音/关机的状态已经由表盘和右下角那颗「关机」负责，
  //     设置面板里再放一遍只会让人以为有两套开关（他那句"这两个键就是坏的"就是这么来的）。
  ui.card.appendChild(el("div", "ptm-tip",
    "右下角那颗「⏻ 关机」= 把节点旁路（和 Ctrl+B 一样）并停响，**在原处点「⏻ 开机」就回来**，计时本身不受影响；"
    + "点一下表盘本体则是停表且不叫，下一次出图自己恢复。"));

  // ★ 2026-11-04（他第 3 条）：「一打开工作流就打开浮窗的设置，在计时设置里面找不到啊」→ 从右键菜单搬到这里
  const rowFloat = el("div", "ptm-row");
  rowFloat.appendChild(el("label", null, "计时浮窗"));
  const btnFloatAuto = el("button", "ptm-btn", "");
  function paintFloatAuto() {
    const on = !!floatCfg().auto;
    btnFloatAuto.textContent = on ? "👁 一打开就出现（点一下关掉）" : "🚫 不自动出现（点一下打开）";
    btnFloatAuto.className = "ptm-btn" + (on ? " pri" : "");
  }
  btnFloatAuto.onclick = () => {
    const nx = floatSave({ auto: !floatCfg().auto });
    paintFloatAuto();
    if (nx.auto && !floatBox) floatOpen();
    log("计时浮窗：" + (nx.auto ? "以后一打开就出现" : "不再自动出现"));
  };
  paintFloatAuto();
  rowFloat.appendChild(btnFloatAuto);
  const btnFloatNow = el("button", "ptm-btn", floatBox ? "✕ 收起浮窗" : "◱ 现在就打开");
  btnFloatNow.onclick = () => { floatToggle(); btnFloatNow.textContent = floatBox ? "✕ 收起浮窗" : "◱ 现在就打开"; };
  rowFloat.appendChild(btnFloatNow);
  ui.card.appendChild(rowFloat);
  ui.card.appendChild(el("div", "ptm-tip",
    "浮窗只是把同一个计时画成另一个圈：**节点和浮窗同时亮着也只响一声**；"
    + "浮窗开着时节点照常工作（不再自动关机）。"));

  const rowVal = el("div", "ptm-row");
  rowVal.appendChild(el("label", null, "有效图"));
  const vText = el("span", "ptm-snd", "已记 " + timerCfg(node).valid + " 张");
  rowVal.appendChild(vText);
  const btnZero = el("button", "ptm-btn", "清零");
  btnZero.onclick = () => { setValid(node, 0); vText.textContent = "已记 0 张"; };
  rowVal.appendChild(btnZero);
  ui.card.appendChild(rowVal);
  // ★ 2026-10-07（第一百一十三批）他第 1 条：那颗键**默认雪藏**，这颗键就是"重新调出来"的入口
  const rowShow = el("div", "ptm-row");
  rowShow.appendChild(el("label", null, "「这张有效」"));
  const btnShow = el("button", "ptm-btn", "");
  function paintShow() {
    const on = validShown(node);
    btnShow.textContent = on ? "👁 现在显示着（点一下雪藏）" : "🚫 已雪藏（点一下调出来）";
    btnShow.className = "ptm-btn" + (on ? " pri" : "");
  }
  btnShow.onclick = () => {
    setValidShown(node, !validShown(node));
    paintShow();
    err.textContent = validShown(node)
      ? "「✔ 这张有效」那颗键已经放回节点上（点一下记一张）"
      : "「✔ 这张有效」已雪藏：键从节点上摘掉、**记数不丢**，想用再点一下这里";
  };
  rowShow.appendChild(btnShow);
  ui.card.appendChild(rowShow);
  ui.card.appendChild(el("div", "ptm-tip", "「✔ 这张有效」那颗键点一下记一张（一直累加，要清零就点上面那颗）。"
    + "它默认是**雪藏**的 —— 这颗键就是开关：藏起来之后记数还在，随时能调回来。"));
  paintShow();
  return ui;
}

// ---------------------------------------------------------------- 画在节点上：一个**简约的大表盘**
// 他 2026-10-06 第一百零八批：「**钟表应该简约，现在加刻度不好看**」→ 12 格刻度整个去掉，
// 只留：一圈细边 + 两条读秒弧（黄=制图 / 灰=休息）+ 中间的文字。
function drawTimerRing(node, ctx, opts) {
  // ★ 2026-11-04（他第 3 条，强调过很多次）：浮窗必须**自己传几何**。
  //   clockGeo 是给"节点"算的（顶部要留 TITLE_H 给标题栏），套到浮窗上圆心会偏下（算出来 y=87，画布中心 76），
  //   圆就被画布边缘裁掉一块 —— 这就是他反复说的"截的不是一个完美的圆"。
  const g = (opts && opts.geo) ? opts.geo : clockGeo(node);
  const info = ringInfo();
  ctx.save();
  // ① 底盘 + 一圈细边
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(28, 34, 48, 0.55)";
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, g.r * 0.035);
  ctx.strokeStyle = "rgba(130, 142, 162, 0.5)";
  ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2); ctx.stroke();
  // ② 两条读秒弧（他原话：「现在是**黄条读秒制图时间，灰条读秒制图后的休息时间**」）：
  //    外圈 = 黄条（制图时间）、内圈 = 灰条（休息时间）
  const gFrac = Math.min(1, (T.generating ? info.sec : Math.round(T.lastDur)) / 60);
  const rFrac = Math.min(1, (!T.generating && info.active ? info.sec : 0) / 60);
  ctx.lineWidth = Math.max(2, g.r * 0.10);
  ctx.strokeStyle = "rgba(255, 196, 92, 0.20)";
  ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r * 0.80, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(150, 162, 180, 0.20)";
  ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r * 0.62, 0, Math.PI * 2); ctx.stroke();
  if (gFrac > 0) {
    ctx.strokeStyle = T.generating ? "rgba(255, 204, 130, 0.98)" : "rgba(255, 204, 130, 0.5)";
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r * 0.80, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * gFrac);
    ctx.stroke();
  }
  if (rFrac > 0) {
    ctx.strokeStyle = T.batch.running ? "rgba(150, 205, 255, 0.95)" : "rgba(178, 188, 205, 0.9)";
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r * 0.62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rFrac);
    ctx.stroke();
  }
  // ④ 表盘里：大字写"过了多久"（停表 / 关机时写清楚状态），下面一行小字写效率
  // ★ 2026-11-04（他第 4 条）：「浮窗并不需要带关机这两个字，并且有效 0 张 这四个字不需要存在」
  //   → 浮窗那边调这个函数时传 `{simple:true}`：只画时间/待机，**不写「已关机」、不写「有效 N 张」**。
  const simple = !!(opts && opts.simple);
  const cfg0 = activeNode ? timerCfg(activeNode) : null;
  const bigText = (cfg0 && cfg0.off) ? (simple ? "已停" : "已关机")
    : (T.stopped ? "已停" : (info.active ? info.text : "待机"));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 " + Math.max(18, Math.round(g.r * 0.42)) + "px system-ui, sans-serif";
  ctx.fillStyle = (T.stopped || (cfg0 && cfg0.off)) ? "rgba(255, 186, 120, 0.95)"
    : (info.active ? "rgba(232, 240, 250, 0.98)" : "rgba(150, 162, 180, 0.85)");
  // ★ 2026-11-04（他第 1 条）：「浮窗里面的表盘里面的数字并不居中，有点居上了」
  //   真因：这个 y 是按**节点**算的 —— 节点里大字下面还有一行「有效 N 张」，所以大字故意上移 0.08r 给下面留位；
  //   浮窗（simple）下面没有那行字，于是整体看着居上。→ 浮窗里直接画在圆心（再往下 0.02r 抵掉字形的视觉重心）。
  const bigY = simple ? (g.cy + g.r * 0.02) : (g.cy - g.r * 0.08);
  ctx.fillText(bigText, g.cx, bigY);
  if (!simple) {
    ctx.font = Math.max(10, Math.round(g.r * 0.14)) + "px sans-serif";
    ctx.fillStyle = "rgba(158, 170, 190, 0.9)";
    ctx.fillText(clipText(ctx, countText(), g.r * 1.5), g.cx, g.cy + g.r * 0.34);
  }
  if (info.lap >= 1 && !T.stopped) {
    ctx.font = Math.max(9, Math.round(g.r * 0.13)) + "px sans-serif";
    ctx.fillStyle = "rgba(255, 214, 130, 0.95)";
    ctx.fillText("+" + info.lap + " 分钟", g.cx, g.cy - g.r * 0.62);
  }
  ctx.restore();
  // ★ 2026-11-04（他第 2、3 条）：「计时器的关机键还是点不动，要不从小圆钮改成其他样子呢」
  //   「浮窗不需要有关机键」
  //   → canvas 画的圆键靠坐标判定容易点不中；而 drawTimerRing 被浮窗复用时会连它一起画出来。
  //   现在**画面上不再画这颗键**，改成控件排里的一颗真按钮（下面 attachButtons 里加的「⏻ 关机」），
  //   浮窗那边自然也就干净了。
}

// ---------------------------------------------------------------- 右下角（现在只剩一颗「关机」）
// ★ 2026-11-03（他第 3 条）：「有声这个键去掉」「把关机键的原理就换成 Ctrl+B，点击关机，
//   就在原处点开机才能开」→ 所以只留 power 一颗；关机 = 折叠（Ctrl+B 那个效果）+ 停表，
//   折叠之后**在节点上点一下就开机**（见 onMouseDown 里那段）。
function cornerRects(node) {
  const w = (node && node.size ? node.size[0] : 300);
  const h = (node && node.size ? node.size[1] : 320);
  const cy = h - CORNER_PAD - CORNER_R;
  const right = w - CORNER_PAD - CORNER_R;
  return {
    power: { x: right, y: cy, r: CORNER_R },
    w: w, h: h,
  };
}
function inCircle(pos, c) {
  if (!pos || !c) return false;
  const dx = pos[0] - c.x, dy = pos[1] - c.y;
  return dx * dx + dy * dy <= c.r * c.r;
}
function clockHit(pos, node) {
  const g = clockGeo(node);
  const dx = pos[0] - g.cx, dy = pos[1] - g.cy;
  return dx * dx + dy * dy <= g.r * g.r;
}
function drawCornerKeys(node, ctx) {
  const r0 = cornerRects(node);
  const c = r0.power;
  if (!c) return;
  const cfg = timerCfg(node);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fillStyle = cfg.off ? "rgba(150, 96, 60, .92)" : "rgba(90, 100, 120, .85)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.45)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(cfg.off ? "开机" : "关机", c.x, c.y + 0.5);
  ctx.restore();
}
function toggleMute(node) {
  const c = timerCfg(node);
  c.muted = !c.muted;
  log(c.muted ? "静音（只放水波）" : "取消静音");
  redrawNode(node);
  return c.muted;
}
// ★ 2026-11-04 **根因**：他说的 Ctrl+B 是 **Bypass（旁路）**，不是折叠！
//   ComfyUI 里 Ctrl+B = bypass selected nodes（`node.mode = 4`，节点变紫/半透明、输入直通输出）；
//   折叠是另一回事，折叠之后那颗"开机"会跟着收进去 → 这就是他连说两次"按不动""自动收起"的原因。
//   所以"关机" = **bypass + 停表**，"开机" = 取消 bypass + 继续计时，节点原地不动、那颗键一直在。
function setBypass(node, on) {
  try { node.mode = on ? 4 : 0; } catch (e) { /* 1.57 可能是访问器，忽略 */ }
  try { if (node.setDirtyCanvas) node.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}
function isBypassed(node) {
  try { return Number(node && node.mode) === 4; } catch (e) { return false; }
}
function togglePower(node) {
  const c = timerCfg(node);
  c.off = !c.off;
  setBypass(node, c.off);
  // ★ 2026-11-04（他第 1 条）：「计时器从关机重新开机就会开始休息计时，这是个 bug」
  //   → 开机时**一律不要 startStopwatch()** —— 那会把 startAt 设成"现在"，于是"休息计时"被重置成"制图中"。
  //   关机时也不再 stopStopwatch()：计时用的是绝对时间戳，关掉期间照样准；开机后自然回到关机前那一刻的状态。
  log(c.off ? "关机（旁路；点「⏻ 开机」就回来，计时不受影响）" : "开机（取消旁路；休息/制图计时接着走，不会被重置）");
  paintPowerBtn(node);
  redrawNode(node);
  return c.off;
}
// 点表盘本体 = 停表且不叫（他第一条）；再点一下继续。下一次出图事件也会自动恢复。
function tapClock(node) {
  if (T.stopped || !T.startAt) { T.stopped = false; startStopwatch(); log("继续计时"); }
  else { T.stopped = true; stopStopwatch(); T.stopped = true; log("停表（下一次作图自己恢复）"); }
  redrawNode(node);
  return T.stopped;
}

function countText() {
  const parts = [];
  if (T.generating) parts.push("正在出图…");
  else if (T.lastDur > 0) parts.push("上一张用时 " + Math.round(T.lastDur) + "s");
  parts.push("有效 " + (activeNode ? timerCfg(activeNode).valid : 0) + " 张");
  return parts.join(" · ");
}

function stageText() {
  const info = ringInfo();
  const node = activeNode;
  const cfg = node ? timerCfg(node) : null;
  const gGen = node ? getSecGen(node) : 0;
  const gRest = node ? getSecRest(node) : 0;
  if (cfg && cfg.off) return "已关机 —— 右下角那颗键再点一下开回来";
  if (T.stopped) return "已停 —— 再点一下表盘继续，或等下一次出图自己走";
  if (T.generating) {
    return "正在出图 —— 这张已经跑了 " + info.sec + " 秒" + (gGen > 0 ? "（黄条 " + gGen + "s 到点叫一声）" : "（黄条没设提醒）");
  }
  if (T.batch.resting) return "套图休息中 —— 还剩 " + T.batch.rest_left + " 秒";
  if (T.batch.running) return "套图排队中（第 " + (T.batch.index || 1) + "/" + (T.batch.planned || "?") + " 张）";
  if (info.active) {
    return "上一张出图之后过了 " + info.text + (gRest > 0 ? "（灰条 " + gRest + "s 到点叫一声）" : "（灰条没设提醒）");
  }
  return "空闲 —— 一出图它自己就开始计时";
}

// 表盘下面那一行状态字（按钮就在它下面 —— 那排按钮就是"时钟的底座"）
function drawStatusText(node, ctx) {
  const g = clockGeo(node);
  const maxW = Math.max(40, g.w - 24);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "11px sans-serif";
  ctx.fillStyle = T.generating ? "rgba(255, 204, 130, 0.98)"
    : (T.batch.running ? "rgba(160, 230, 180, 0.98)" : "rgba(150, 162, 180, 0.9)");
  ctx.fillText(clipText(ctx, stageText(), maxW), g.w / 2, g.h - STATUS_H + 16);
  ctx.restore();
}

// 水波：从表盘中心一圈圈荡开（三圈错开）+ 头 0.35 秒给节点描个亮框
function drawRipple(node, ctx) {
  if (!rippleActive()) return;
  const g = clockGeo(node);
  const p = Math.min(1, (Date.now() - T.rippleAt) / RIPPLE_MS);
  const maxR = Math.max(g.w, g.h) * 0.95;
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const t = (p - i * 0.16) / 0.72;
    if (t <= 0 || t >= 1) continue;
    ctx.strokeStyle = "rgba(120, 214, 255, " + (0.55 * (1 - t)).toFixed(3) + ")";
    ctx.lineWidth = 2 + 5 * (1 - t);
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r + (maxR - g.r) * t, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (p < 0.35) {
    ctx.strokeStyle = "rgba(120, 214, 255, " + (0.85 * (1 - p / 0.35)).toFixed(3) + ")";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(0.5, 0.5, g.w - 1, g.h - 1);
    ctx.stroke();
  }
  ctx.restore();
}

function clipText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 2 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

// ★ 2026-10-07（第一百一十三批）他第 1 条原话：「计时器节点中，"这张有效"这个按钮**雪藏**，
//   在计时设置中可以重新调出来」
//   → 默认**不显示**（`properties.pcTimer.showValid`，缺省 = false），「⏱ 计时设置」面板里一颗键能调回来。
//   ⚠️ 按项目的"雪藏"铁律：**用开关藏着、代码一个字不删** —— 那颗大绿键还是原来那套，只是默认被藏起来；
//      后端那颗原生按钮也一直留着（自测用）。
const VALID_WIDGET_H = 52;                   // 42（键）+ 4 + 6（wrap 的上下 padding）
function validShown(node) {
  try { const t = node.properties && node.properties.pcTimer; return !!(t && t.showValid); } catch (e) { return false; }
}
function setValidShown(node, on) {
  try {
    node.properties = node.properties || {};
    node.properties.pcTimer = node.properties.pcTimer || {};
    node.properties.pcTimer.showValid = !!on;
  } catch (e) { /* 忽略 */ }
  applyValidShown(node);
}
function applyValidShown(node) {
  try {
    const on = validShown(node);
    const wrap = node.__pcValidWrap;
    if (wrap) {
      wrap.style.display = on ? "" : "none";
      const h = on ? VALID_WIDGET_H : 0;
      try {
        wrap.style.setProperty("--comfy-widget-min-height", h + "px");
        wrap.style.setProperty("--comfy-widget-max-height", h + "px");
      } catch (e) { /* 忽略 */ }
    }
    if (node.__pcValidWidget) {
      // 让节点按新的"控件摞"重排一次（老工作流里存的矮节点会被 ensureFit 补到下限）
      // ★ 第一百二十六批：开了"高度可拖小 + 滚轮"之后就别再按 computeSize 撑高（会把用户拖小的尺寸顶回去）
      try { if (!node.__pcScrollOn) node.setSize([node.size[0], node.computeSize()[1]]); } catch (e) { /* 忽略 */ }
      try { ensureFit(node, true, true); } catch (e) { /* 忽略 */ }
      try { node.arrange && node.arrange(); } catch (e) { /* 忽略 */ }
    }
    redrawNode(node);
  } catch (e) { log("显隐「这张有效」失败", e); }
}

function attachButtons(node) {
  try {
    if (typeof node.addWidget !== "function") return;
    // 后端那两颗原生按钮先建出来（`__pcValidBtn` 还指着"这张有效"那颗）—— 它们随后会被**藏起来**，
    // 看得见的是一颗自己画的大绿键（见下面的 addDOMWidget）。
    node.addWidget("button", BTN_VALID, null, () => { bumpValid(node); }, { serialize: false });
    node.__pcValidBtn = node.widgets[node.widgets.length - 1];
    node.addWidget("button", BTN_TIMER, null, () => { openTimerPanel(node); }, { serialize: false });
    // ★ 2026-11-03（他第 1 条）：「计时器能不能来一个按键？点击之后它就会以浮窗的形式直接浮在角落」
    node.addWidget("button", BTN_FLOAT, null, () => {
      try {
        const on = floatToggle();
        log(on ? "浮窗：已打开（可拖动，靠近角落会吸附）" : "浮窗：已收起");
      } catch (e) { log("浮窗切换失败", e); }
    }, { serialize: false });
    // ★ 2026-11-04（他第 2 条）：关机键从 canvas 圆钮改成**真按钮**（和上面两颗同排），一定点得动。
    node.addWidget("button", BTN_POWER, null, () => {
      try { togglePower(node); } catch (e) { log("开关机失败", e); }
    }, { serialize: false });
    node.__pcPowerBtn = node.widgets[node.widgets.length - 1];
    paintPowerBtn(node);
    node.widgets.slice().forEach(function (w) {
      if (!w || (w !== node.__pcValidBtn && w.name !== BTN_VALID)) return;
      w.computeSize = function () { return [0, -4]; };
      w.hidden = true;
      try { if (w.element) w.element.style.display = "none"; } catch (e) { /* 忽略 */ }
    });
    // ★ 大绿键（他要求"更大更显眼、颜色不能是灰的"；第一百零八批又要求"**没这么大**"）
    //   ⚠️ 第一百零八批的坑：原来**直接把 button 交给 addDOMWidget** → ComfyUI 会把那个元素**撑满**
    //      剩下的高度 → 那颗键变成一大片绿、把表盘整个盖住。→ 现在交一个**包一层的 div**，键本身定死高度。
    try {
      injectPanelCss();
      const wrap = document.createElement("div");
      wrap.className = "ptm-valid-wrap";
      const big = document.createElement("button");
      big.type = "button";
      big.className = "ptm-valid";
      big.textContent = BTN_VALID;
      big.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        bumpValid(node);
      });
      ["pointerdown", "mousedown", "dblclick", "contextmenu"].forEach(function (ev) {
        big.addEventListener(ev, function (e) { e.stopPropagation(); });
      });
      wrap.appendChild(big);
      // ★★ 第一百零九批他报：「计时器绿色按钮把小字挡住了，建议往上移一点」。
      //    根因：DOM 控件（`addDOMWidget` 交进去的这个 wrap）在 ComfyUI 前端里是**没有 maxHeight 的** →
      //    `_arrangeWidgets` 里 `distributeSpace()` 会把控件摞下面**剩下的所有空间**都分给它
      //    （`maxSize ?? Infinity`）→ 那颗键被拉成一大块、一路盖到底部那行状态字上。
      //    修法：把这个 DOM 控件的高度**钉死**（min = max = 键高 + 上下留白），剩下的空间就留在
      //    "控件摞下面"，底部那行小字自然露出来（＝他说的"往上移一点"）。
      try {
        wrap.style.setProperty("--comfy-widget-min-height", (validShown(node) ? VALID_WIDGET_H : 0) + "px");
        wrap.style.setProperty("--comfy-widget-max-height", (validShown(node) ? VALID_WIDGET_H : 0) + "px");
      } catch (e) { /* 忽略 */ }
      node.__pcValidEl = big;
      node.__pcValidWrap = wrap;                   // ★ 雪藏开关要拿它改高度/显隐
      if (typeof node.addDOMWidget === "function") {
        node.__pcValidWidget = node.addDOMWidget("这张有效", "pcTimerValid", wrap, {
          serialize: false, hideOnZoom: false,
          // ★ 动态读开关：雪藏时 min/max 都是 0 → 那颗键不占高度（前端 DOMWidgetImpl.computeLayoutSize 认这个）
          getMinHeight: () => (validShown(node) ? VALID_WIDGET_H : 0),
          getMaxHeight: () => (validShown(node) ? VALID_WIDGET_H : 0),
        });
      } else {
        const host = document.getElementById("ptm-host");
        const h = host || (function () { const d = document.createElement("div"); d.id = "ptm-host"; d.style.cssText = "position:fixed;left:-9999px;top:0;width:320px;"; document.body.appendChild(d); return d; })();
        h.appendChild(wrap);
      }
    } catch (e) { log("大绿键挂载失败（后端那颗还能点）", e); }
    applyValidShown(node);                       // ★ 让"雪藏 / 显示"这个开关生效（默认雪藏）
    paintValid(node);
  } catch (e) {
    log("按钮注入失败", e);
  }
}

// ==================== ★ 2026-11-03 计时器**浮窗**（他第 1 条）====================
// 他原话：「计时器能不能来一个按键？点击之后它就会以浮窗的形式直接浮在角落，可以将其拖动。
//   不过也还是会优先在边角位置，这样就可以随时提醒了，当然，不能影响正常使用，
//   而且浮窗就是浮窗，浮窗就不能是节点……浮窗状态下的计时器，只显示表盘本身就行了，
//   甚至可以在设置中调整它，使其打开工作流就存在」
// → 所以这是**一个独立的 position:fixed 浮层**，跟画布/节点无关：不受缩放、平移影响，
//   也不是节点（不参与工作流、不能连线、不会跟着画布跑）。只画表盘那一圈 + 中间的时间。
function floatCfg() {
  try {
    const o = JSON.parse(localStorage.getItem(FLOAT_KEY) || "{}");
    return { on: !!o.on, x: Number(o.x) || 0, y: Number(o.y) || 0, auto: !!o.auto };
  } catch (e) { return { on: false, x: 0, y: 0, auto: false }; }
}
function floatSave(patch) {
  try {
    const nx = Object.assign({}, floatCfg(), patch || {});
    localStorage.setItem(FLOAT_KEY, JSON.stringify(nx));
    return nx;
  } catch (e) { return floatCfg(); }
}

let floatBox = null, floatCv = null, floatCtx = null, floatTimer = null, floatDrag = null;

// ★ 2026-11-04（他第 3 条）：「算了，计时器叫出浮窗不需要自身关机，我主要是担心两个计时器可能会响两下」
//   → **撤掉"开浮窗自动关机 / 关浮窗自动开机"这套联动**（原来那两颗设置项一起删掉）。
//   为什么不会响两下：响铃跑在**模块级唯一的一条 tick** 里（`T.tick` + `checkAlert`），
//   浮窗只是把同一份时间画成另一个圈 —— 它不会自己再数一遍时间，所以节点和浮窗同时亮着也只响一声。
// 拿一颗计时器节点（浮窗跟它联动）
function someTimerNode() {
  try {
    if (activeNode && activeNode.graph) return activeNode;
    const arr = (app.graph && app.graph._nodes) || [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].type === "PromptToolTimer") return arr[i];
    }
  } catch (e) { /* 忽略 */ }
  return null;
}
// 把节点切成"关机（旁路）" / "开机"
function forcePower(node, off) {
  try {
    if (!node) return;
    const c = timerCfg(node);
    c.off = !!off;
    setBypass(node, !!off);
    paintPowerBtn(node);
    redrawNode(node);
  } catch (e) { /* 忽略 */ }
}

function floatDefaultPos() {
  return {
    x: Math.max(8, window.innerWidth - FLOAT_SIZE - 16),
    y: Math.max(8, window.innerHeight - FLOAT_SIZE - 16),
  };
}
function floatPlace(x, y) {
  if (!floatBox) return null;
  const nx = Math.max(8, Math.min(Math.max(8, window.innerWidth - FLOAT_SIZE - 8), x));
  const ny = Math.max(8, Math.min(Math.max(8, window.innerHeight - FLOAT_SIZE - 8), y));
  floatBox.style.left = nx + "px";
  floatBox.style.top = ny + "px";
  return { x: nx, y: ny };
}
// 松手时吸附到最近的角 —— 他："优先在边角位置"
function floatSnap(x, y) {
  const w = window.innerWidth, h = window.innerHeight, M = FLOAT_SIZE + 14;
  let nx = x, ny = y;
  if (x < M) nx = 12; else if (x > w - M) nx = w - FLOAT_SIZE - 12;
  if (y < M) ny = 12; else if (y > h - M) ny = h - FLOAT_SIZE - 12;
  return floatPlace(nx, ny);
}
function floatPaint() {
  if (!floatCv || !floatCtx) return;
  try {
    const dpr = window.devicePixelRatio || 1;
    const S = FLOAT_SIZE;
    const want = Math.round(S * dpr);
    if (floatCv.width !== want || floatCv.height !== want) {
      floatCv.width = want; floatCv.height = want;
      floatCv.style.width = S + "px"; floatCv.style.height = S + "px";
    }
    const ctx = floatCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    // ★ 2026-11-04（他第 3 条，强调过很多次）：浮窗**自己算一个正居中的圆**，不再借 clockGeo。
    //   clockGeo 是给节点算的（顶部要留 TITLE_H 给标题栏）→ 套到浮窗上圆心会偏下（y=87，画布中心 76），
    //   圆被画布边缘裁掉一块，所以永远"不是一个完美的圆"。
    const R = (S / 2) - 5;                       // 留 5px 余量，保证圆完整落在画布内
    const geo = { cx: S / 2, cy: S / 2, r: R, w: S, h: S, top: S / 2 - R, bottom: S / 2 + R };
    const fake = { size: [S, S], widgets_start_y: TITLE_H + CLOCK_BLOCK };
    // 先铺一层不透明圆底（挡住底下节点），再画表盘
    ctx.beginPath();
    ctx.arc(geo.cx, geo.cy, R + 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(23, 27, 38, 1)";
    ctx.fill();
    drawTimerRing(fake, ctx, { simple: true, geo: geo });
    // ★ 2026-11-04（他第 4 条）：浮窗**只显示表盘本身** —— 原来这里又自己画了一遍时间和状态字，
    //   结果和 drawTimerRing 画的叠在一起（截图里两个「5:02」）。现在一个字都不多画。
  } catch (e) { /* 画不出来不影响浮窗存在 */ }
}
function floatOpen() {
  try {
    if (floatBox) { floatBox.style.display = "block"; floatPaint(); return true; }
    const box = document.createElement("div");
    box.id = "ptm-float";
    box.title = "拖动可移动（靠近角落会自动吸附）；右上角 ✕ 收起";
    box.style.cssText = "position:fixed;z-index:2500;width:" + FLOAT_SIZE + "px;height:" + FLOAT_SIZE + "px;"
      + "cursor:grab;user-select:none;touch-action:none;filter:drop-shadow(0 6px 18px rgba(0,0,0,.45));";
    const cv = document.createElement("canvas");
    cv.style.cssText = "display:block;border-radius:50%;";
    box.appendChild(cv);
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "✕";
    x.title = "收起浮窗（节点还在，随时能再打开）";
    x.style.cssText = "position:absolute;right:-2px;top:-2px;width:20px;height:20px;border-radius:50%;"
      + "border:1px solid rgba(255,255,255,.28);background:rgba(20,24,34,.86);color:#cfd4e2;"
      + "font-size:11px;line-height:1;cursor:pointer;padding:0;display:none;";
    box.appendChild(x);
    box.addEventListener("pointerenter", function () { x.style.display = "block"; });
    box.addEventListener("pointerleave", function () { if (!floatDrag) x.style.display = "none"; });
    x.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); floatClose(); });
    box.addEventListener("pointerdown", function (e) {
      if (e.target === x) return;
      e.preventDefault(); e.stopPropagation();
      const r = box.getBoundingClientRect();
      floatDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      box.style.cursor = "grabbing";
      x.style.display = "block";
      function mv(ev) { if (floatDrag) floatPlace(ev.clientX - floatDrag.dx, ev.clientY - floatDrag.dy); }
      function up() {
        document.removeEventListener("pointermove", mv, true);
        document.removeEventListener("pointerup", up, true);
        floatDrag = null;
        box.style.cursor = "grab";
        const cx = parseFloat(box.style.left) || 0, cy2 = parseFloat(box.style.top) || 0;
        const hit = floatSnap(cx, cy2) || { x: cx, y: cy2 };
        floatSave({ on: true, x: hit.x, y: hit.y });
      }
      document.addEventListener("pointermove", mv, true);
      document.addEventListener("pointerup", up, true);
    });
    document.body.appendChild(box);
    floatBox = box; floatCv = cv; floatCtx = cv.getContext("2d");
    const c = floatCfg(), d = floatDefaultPos();
    floatPlace(c.x || d.x, c.y || d.y);
    floatPaint();
    if (floatTimer) clearInterval(floatTimer);
    floatTimer = setInterval(floatPaint, 120);
    floatSave({ on: true });
    // ★ 2026-11-04（他第 3 条）：**不再把计时器节点关机**（浮窗和节点同时亮着也只响一声，见 someTimerNode 上方注释）
    return true;
  } catch (e) { log("浮窗打开失败", e); return false; }
}
function floatClose() {
  try {
    if (floatTimer) { clearInterval(floatTimer); floatTimer = null; }
    if (floatBox && floatBox.parentNode) floatBox.parentNode.removeChild(floatBox);
    floatBox = null; floatCv = null; floatCtx = null; floatDrag = null;
    floatSave({ on: false });
    // ★ 2026-11-04（他第 3 条）：关浮窗也不再自动开机（开关机只由那颗「⏻」按钮管）
    return true;
  } catch (e) { return false; }
}
function floatToggle() { if (floatBox) { floatClose(); return false; } return floatOpen(); }
// 窗口大小变了把浮窗拉回可视区（别让它跑到屏幕外面）
try {
  window.addEventListener("resize", function () {
    if (!floatBox) return;
    const cx = parseFloat(floatBox.style.left) || 0, cy2 = parseFloat(floatBox.style.top) || 0;
    floatPlace(cx, cy2);
  });
} catch (e) { /* 忽略 */ }

function setupTimerNode(nodeType) {
  // ⚠️ 2026-11-03：以前这里没有任何保护 —— 只要**其中一步**抛错（比如 1.57 对 prototype
  //   冻结 / 加了只读 setter，严格模式下赋值就抛 TypeError），整段 setup 中断，
  //   表盘、按钮、事件**一个都不会挂上**，节点就剩两个输入框（他截图里那样）。
  //   现在每一步单独兜住，并且打日志说清走到第几步 —— 出问题一眼能看到卡在哪。
  function step(name, fn) {
    try { fn(); } catch (e) { console.error("[PromptSync.Timer] setup 第 " + name + " 步失败（已跳过，其余继续）：", e); }
  }
  // ★ 第一百三十六批（他原话：「算了，计时器就不用拖了，将其改为**不能修改高度**」）：
  //   计时器**不再支持拖高度**（那条"拖小 + 右边滚轮"也撤了，`prompt_scroll.js` 里不再装它），
  //   整颗节点固定高度 —— 前端拖边角时 `findResizeDirection()` 看到 `resizable === false` 直接不响应。
  // 1.57 把 `resizable` 变成了 `nodeDefStore` 里的 getter/setter（实测栈顶就是 `at set resizable`）——
  //   直接在 prototype 上赋值会调用那个 setter，而它内部访问了 undefined → 抛
  //   `TypeError: Cannot set properties of undefined (setting 'resizable')`。
  //   现在用 defineProperty 直接**替换**访问器（不调用它的 setter）；不行就整步跳过（节点仍可拖大小）。
  step("1 resizable", function () {
    try {
      Object.defineProperty(nodeType.prototype, "resizable", {
        value: false, writable: true, enumerable: true, configurable: true,
      });
    } catch (e) {
      console.warn("[PromptSync.Timer] 1.57 不允许锁死 resizable，跳过这一步（节点仍可拖大小）");
    }
  });
  const onCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = onCreated ? onCreated.apply(this, arguments) : undefined;
    // 实例上再设一次（1.57 的 setter 有时只认实例）：不让改就算了，别把整段 onNodeCreated 带崩
    try { this.resizable = false; } catch (e) { /* 忽略 */ }
    activeNode = this;
    attachButtons(this);
    // 新节点默认就给"表盘在上、按钮在下"那块够大的地方（老工作流里存过尺寸的照旧用存的那个 —— 太矮的会在 onConfigure 里补）。
    try {
      ensureFit(this, true);
      fitClock(this);              // 把控件整体推到表盘下面（他：钟表应该在按钮正上方）
    } catch (e) { /* 忽略 */ }
    startBatchPoll();
    redrawNode(this);
    return r;
  };

  const onRemoved = nodeType.prototype.onRemoved;
  nodeType.prototype.onRemoved = function () {
    stopBatchPoll();
    stopStopwatch();
    if (T.raf) { cancelAnimationFrame(T.raf); T.raf = 0; }
    // ★ 273s：切走工作流 / 删节点时把"正在跑"的状态整段清掉 —— 否则切回来会拿旧 genAt 立刻补响
    if (activeNode === this) {
      activeNode = null;
      T.generating = false;
      T.genAt = 0;
      T.genFired = true;      // 黄条已"叫过"，切回来不补
      T.restFired = true;     // 灰条同上
      T.shown = "";
    }
    const r = onRemoved ? onRemoved.apply(this, arguments) : undefined;
    return r;
  };

  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
    // ⚠️ properties 是这个前端**在 onConfigure 之后**才写回来的，所以等一下再画一次按钮文字
    const self = this;
    // 老工作流里存过的计时器节点：尺寸是旧的（表盘那一块还没留出来）→ 载入时也要把控件推下去，
    // 并且让前端**重新排一次**控件（`arrange()` 才是真正按 widgets_start_y 摆控件的那一步）。
    // ⚠️ 第一百零九批：老节点还可能**比新下限还矮**（那时候还没有绿键那 52px）→ 顺手补到下限。
    try { ensureFit(this, true, true); fitClock(this); reflow(this); } catch (e) { /* 忽略 */ }
    setTimeout(() => {
      try { ensureFit(self, true, true); fitClock(self); reflow(self); } catch (e) { /* 忽略 */ }
      try { applyValidShown(self); } catch (e) { /* 忽略 */ }   // ★ 读工作流里存的那个"显不显示"开关
      try { paintValid(self); } catch (e) { /* 忽略 */ }
    }, 600);
    return r;
  };

  const computeSize = nodeType.prototype.computeSize;
  nodeType.prototype.computeSize = function (out) {
    const s = (computeSize ? computeSize.apply(this, arguments) : null) || out || [320, 380];
    // 表盘那块由 `widgets_start_y` 自己撑开（前端 computeSize 会读它）→ 这里只保证最小宽度 / 最小高度够用
    if (s && typeof s[0] === "number") s[0] = Math.max(s[0], 320);
    if (s && typeof s[1] === "number") s[1] = Math.max(s[1], TITLE_H + CLOCK_BLOCK + widgetStackH(this) + STATUS_H + 6);
    return s;
  };

  // 节点被拖动大小 → 表盘跟着长（控件位置也重排一次）
  const onResize = nodeType.prototype.onResize;
  nodeType.prototype.onResize = function () {
    const r = onResize ? onResize.apply(this, arguments) : undefined;
    try { fitClock(this); } catch (e) { /* 忽略 */ }
    return r;
  };

  // ★ 180 批③（他报：装了 Qwen Image 2.1 图像编辑之后，计时器的「设置」点不开；而且反馈是单向的、
  //   没法再追问到底哪种情况）→ 不去猜原因，**直接多给一条入口**：在这个节点上右键，菜单里也有「⏱ 计时设置…」。
  //   右键菜单走的是另一条事件路径，就算那颗按钮控件被别的插件包坏 / 点不到，也能从这里打开面板。
  const onMenu = nodeType.prototype.getExtraMenuOptions;
  nodeType.prototype.getExtraMenuOptions = function (canvas, opts) {
    const r = onMenu ? onMenu.apply(this, arguments) : undefined;
    try {
      const arr = Array.isArray(opts) ? opts : (Array.isArray(r) ? r : null);
      if (arr) {
        arr.unshift({ content: BTN_TIMER, callback: () => { try { openTimerPanel(this); } catch (e) { /* 忽略 */ } } });
        // ★ 2026-11-04（他第 3 条）：「一打开工作流就打开浮窗的设置，在计时设置里面找不到啊」
        //   → 「打开时自动出现计时浮窗」搬进「⏱ 计时设置」面板；右键菜单只留"打开浮窗 / 打开设置"。
        //   「关浮窗时让计时器自动开机」这条**删掉**了（浮窗不再和开关机联动）。
        arr.unshift({
          content: (floatBox ? "✔ " : "") + BTN_FLOAT,
          callback: () => { try { floatToggle(); } catch (e) { /* 忽略 */ } },
        });
        arr.unshift(null);                 // 和别人的菜单项隔一条线
      }
    } catch (e) { /* 忽略 */ }
    return r;
  };

  const onDraw = nodeType.prototype.onDrawForeground;
  nodeType.prototype.onDrawForeground = function (ctx) {
    const r = onDraw ? onDraw.apply(this, arguments) : undefined;
    if (!ctx || (this.flags && this.flags.collapsed)) return r;
    try {
      if (activeNode !== this) activeNode = this;      // 画的时候顺手认下自己
      // 兜底自愈：任何路径进画布的节点（老工作流载入 / 撤销恢复 / 粘贴），只要发现控件还没被推下去，
      // 就地推一次并重排（推完 `widgets_start_y` 就 ≥ TITLE_H + CLOCK_BLOCK，这个判断之后恒为 false，不会再算）。
      if (!((this.widgets_start_y || 0) >= TITLE_H + CLOCK_BLOCK)) { fitClock(this); reflow(this); }
      drawTimerRing(this, ctx);
      drawStatusText(this, ctx);
      drawRipple(this, ctx);
    } catch (e) { /* 画不出来不影响节点 */ }
    return r;
  };

  // 点节点上的东西：**右下角两颗圆键**（静音 / 关机）+ **表盘本体**（点了就停表且不叫）
  const onMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos) {
    try {
      // ⚠️ 2026-11-04：canvas 圆键已经删掉了（改成真按钮），这里只留"点表盘 = 停表"。
      if (pos && clockHit(pos, this)) { tapClock(this); return true; }
    } catch (err) { /* 忽略 */ }
    const r = onMouseDown ? onMouseDown.apply(this, arguments) : undefined;
    return r;
  };
}

app.registerExtension({
  name: "PromptSync.Timer",

  async setup() {
    // 计时靠 ComfyUI 自己的事件 —— 所以**任何工作流**出图都能计时，不只套图
    if (api && typeof api.addEventListener === "function") {
      api.addEventListener("execution_start", () => { try { onGenerationStart(); } catch (e) { /* 忽略 */ } });
      api.addEventListener("execution_success", () => { try { onGenerationDone(); } catch (e) { /* 忽略 */ } });
      // 老前端在结束时会发一个 detail 为空的 executing —— 兜一层，别漏掉"出完"这一刻
      api.addEventListener("executing", (e) => {
        if (e && e.detail === null) { try { onGenerationDone(); } catch (err) { /* 忽略 */ } }
      });
    }
    // ★ 2026-11-03（他第 1 条）：浮窗恢复 —— 上次开着、或者设了"一打开就出现"，进页面就把它浮出来。
    //   延迟一下等布局稳（默认位置按窗口宽高算）。浮窗不是节点，所以跟有没有工作流无关。
    try {
      const fc = floatCfg();
      if (fc.on || fc.auto) setTimeout(function () { try { floatOpen(); } catch (e) { /* 忽略 */ } }, 900);
    } catch (e) { /* 忽略 */ }
    window.__pcFloat = {
      open: () => floatOpen(), close: () => floatClose(), toggle: () => floatToggle(),
      cfg: () => floatCfg(), isOpen: () => !!floatBox, el: () => floatBox,
    };
    window.__pcTimer = {
      validShown: (n) => validShown(n),
      setValidShown: (n, on) => { setValidShown(n, on); return validShown(n); },
      info: () => ringInfo(),
      cfg: (node) => timerCfg(node || activeNode),
      node: () => activeNode,
      sec: (node) => getSec(node || activeNode),
      setSec: (n, node) => setSec(node || activeNode, n),
      valid: (node) => timerCfg(node || activeNode).valid,
      bump: (node) => bumpValid(node || activeNode),
      zero: (node) => setValid(node || activeNode, 0),
      mark: () => { startStopwatch(); return ringInfo(); },
      stopwatch: () => { stopStopwatch(); },
      genStart: () => { onGenerationStart(); return true; },
      genDone: () => { onGenerationDone(); return T.lastDur; },
      generating: () => T.generating,
      lastDur: () => T.lastDur,
      play: (node) => playSound(node || activeNode),
      // ★ 第一百零六批新加：更多音效 + 音量 + 表盘几何（自测用）
      //   第一百四十六批改口径：音量变成**每个音效各一份（百分比 0~200，初始 100）**，
      //   所以 `vol()` = "当前这个音效"的音量；要整张表用 `vols()`。
      tones: () => TONES.map((t) => ({ id: t.id, name: t.name })),
      tone: (node) => timerCfg(node || activeNode).tone,
      setTone: (id, node) => { const c = timerCfg(node || activeNode); c.tone = id; c.sound = null; return c.tone; },
      vol: (node) => volOf(node || activeNode),
      vols: (node) => Object.assign({}, timerCfg(node || activeNode).vols),
      volKey: (node) => volKeyOf(node || activeNode),
      setVol: (v, node) => setVol(node || activeNode, v),
      setVolKey: (k, v, node) => setVolKey(node || activeNode, k, v),
      maxVol: () => VOL_MAX,
      playTone: (id, node) => playTone(id || timerCfg(node || activeNode).tone, volOf(node || activeNode)),
      geo: (node) => clockGeo(node || activeNode),
      stackH: (node) => widgetStackH(node || activeNode),
      fitClock: (node) => fitClock(node || activeNode),
      builtinSound: (id) => { const t = TONES.filter(function (x) { return x.id === id; })[0]; return t && t.file ? soundUrl(t.file) : null; },
      // ★ 第一百零七批新加：两条阈值 / 停表 / 静音 / 关机 / 两颗角键
      secGen: (node) => getSecGen(node || activeNode),
      secRest: (node) => getSecRest(node || activeNode),
      setSecGen: (n, node) => setSec(node || activeNode, n, "gen"),
      setSecRest: (n, node) => setSec(node || activeNode, n, "rest"),
      muted: (node) => timerCfg(node || activeNode).muted,
      toggleMute: (node) => toggleMute(node || activeNode),
      off: (node) => timerCfg(node || activeNode).off,
      togglePower: (node) => togglePower(node || activeNode),
      tapClock: (node) => tapClock(node || activeNode),
      stopped: () => T.stopped,
      checkAlert: () => checkAlert(ringInfo()),
      corners: (node) => cornerRects(node || activeNode),
      fired: () => ({ gen: T.genFired, rest: T.restFired }),
      alerts: () => T.alerts,
      resetAlerts: () => { T.alerts = 0; return 0; },
      alert: (node) => { fireAlert(node || activeNode, "测试"); return true; },
      rippling: () => rippleActive(),
      batch: () => Object.assign({}, T.batch),
      pollBatch: () => pollBatch(),
      text: () => ({ count: countText(), stage: stageText() }),
      panel: (node) => { openTimerPanel(node || activeNode); return !!document.querySelector(".ptm-card"); },
      close: () => { const b = document.querySelector(".ptm-back"); if (b) b.remove(); },
    };
    log("已就绪");
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    // ⚠️ 2026-11-03 实测（前端 1.57）：ComfyUI 会**用 nodeType = null 调一次**这个钩子
    //   （探针抓到的实参是 `args: [null, {input:{required:{制图超过多少秒提醒...}}}]`）。
    //   原来这里只挡了 nodeData，没挡 nodeType → `nodeType.prototype` 直接抛 TypeError
    //   → 整段 setupTimerNode 没执行 → **表盘/按钮/事件全没挂上，节点一片空白**（他报的"计时器坏了"）。
    if (!nodeType || !nodeData || nodeData.name !== NODE_NAME) return;
    setupTimerNode(nodeType);
  },

  nodeCreated(node) {
    if (node && (node.type === NODE_NAME || node.comfyClass === NODE_NAME)) {
      activeNode = node;
      startBatchPoll();
    }
  },
});
