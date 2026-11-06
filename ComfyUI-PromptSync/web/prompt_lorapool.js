// LoRA 池 —— 2026-10-19 第 180 批（先做外形）+ 第 181 批（实装）。
//
// 他描述的那一版里有**三个滑块，各管一件事**：
//   ① 中间的左右滑块 = 模式切换（决定下面每行拖的是「模型强度」还是「CLIP 强度」）
//   ② 每行下面那条滑块 = 这颗 LoRA 的强度（0.05 一格，跟「关键词权重」那颗同款）
//   ③ 右边那条竖滑块 = 列表滚动（行数超出那个框才出现）
//
// 第 181 批他加的四条：
//   「模型强度和 CLIP 强度这个滑块按不动」→ 拖动改成 document 级 pointer 监听（以前绑在元素上，一动就被画布吃掉）
//   「小眼睛图标换成其他的」→ 换成「用 / 停」的小胶囊
//   「下面的参数用一个框框框起来，这样子好放滚轮上下」→ 列表套一层带边框的滚动框
//   「可以把 Lora 池实装了」→ 后端真的按顺序叠 LoRA（nodes.py 的 apply_pool）
import { app } from "../../scripts/app.js";

const NODE_NAME = "PromptToolLoraPool";
const W = 420, H = 440;
const STEP = 0.05, VMIN = 0, VMAX = 2;
const FALLBACK_LORAS = ["（点这里选 LoRA）"];

// ==================== ★ 217 批：宽、高**分开**选倍数 ====================
//   他原话：「Lora 池从大中小号改为宽度一倍、二倍、三倍和高度一倍、二倍、三倍」
//   → 状态里换成 `lpW` / `lpH`（各 1/2/3），节点尺寸 = 基准 × 倍数：
//     宽基准 475、高基准 450（= 208 批那个"小档"，也就是 1 倍）。
//     胶囊框排数跟**高**倍数走、参数列数跟**宽**倍数走（宽了排更多列、高了放更多排胶囊）。
//   ⚠️ 老工作流里只有 `lpSize`（s/m/l）→ 自动换算成 1/2/3 倍，不用他手动改。
const LP_W_BASE = 475, LP_H_BASE = 450;
const LP_OVER = 82;                                      // 除面板外，节点还占掉的高度（实测）
const LP_LABEL = { 1: "1 倍", 2: "2 倍", 3: "3 倍" };
function lpMul(v) { v = Math.round(Number(v) || 1); return v >= 3 ? 3 : (v >= 2 ? 2 : 1); }
function sizeWH(st) {
  st = st || {};
  if (st.lpW || st.lpH) return { w: lpMul(st.lpW), h: lpMul(st.lpH) };
  const k = st.lpSize;                                   // 兼容老档位
  const n = k === "m" ? 2 : (k === "l" ? 3 : 1);
  return { w: n, h: n };
}
function sizeBoxWH(wh) { return [LP_W_BASE * wh.w, LP_H_BASE * wh.h]; }
function sizeKeyOf(st) {                                  // 老代码 / 探针还在用这个名字：给个等价字符串
  const wh = sizeWH(st);
  return wh.w + "x" + wh.h;
}
function sizeBoxOf(key) {                                 // 老签名：'s'|'m'|'l' 或 {w,h} 或 '2x3'
  if (key && typeof key === "object") return sizeBoxWH(sizeWH(key));
  if (typeof key === "string" && key.indexOf("x") > 0) {
    const p = key.split("x");
    return sizeBoxWH({ w: lpMul(p[0]), h: lpMul(p[1]) });
  }
  return sizeBoxWH(sizeWH({ lpSize: key }));
}
function capsRowsH(rows) { return 14 + rows * 32; }        // 一排胶囊 ~32px + 上下内边距
// 把倍数落到节点上：节点尺寸 + 胶囊框排数（跟高）+ 参数列表列数（跟宽）
function applySize(node, arg) {
  //   arg 可以是：{w,h} / 'w×h' / 's'|'m'|'l' / 状态对象（含 lpW/lpH）
  //   ⚠️ 217 批第一版把 {w,h} 当成"状态对象"丢给 sizeWH → 直接掉回 1×1（节点尺寸根本没变），
  //      所以这里先认 w/h 这两个键。
  let wh;
  if (arg && typeof arg === "object" && (arg.w != null || arg.h != null)) {
    wh = { w: lpMul(arg.w || 1), h: lpMul(arg.h || 1) };
  } else if (typeof arg === "string" && arg.indexOf("x") > 0) {
    const p = arg.split("x");
    wh = { w: lpMul(p[0]), h: lpMul(p[1]) };
  } else {
    wh = sizeWH(arg && typeof arg === "object" ? arg : { lpSize: arg });
  }
  try { node.__lpWH = wh; } catch (e) { /* 忽略 */ }
  const box = sizeBoxWH(wh);
  try { if (node.setSize) node.setSize([box[0], box[1]]); } catch (e) { /* 忽略 */ }
  try {
    if (node.__lpCaps) {
      const h = capsRowsH(wh.h);
      node.__lpCaps.style.minHeight = h + "px";
      node.__lpCaps.style.maxHeight = h + "px";
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (node.__lpBox) node.__lpBox.style.gridTemplateColumns = "repeat(" + wh.w + ", minmax(0,1fr))";
  } catch (e) { /* 忽略 */ }
  try { if (node.__lpW && node.__lpW.computeSize) node.__lpW.computeSize(); } catch (e) { /* 忽略 */ }
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

function log(...a) { console.log("[LoraPool]", ...a); }

// ==================== ★ 210 批：面板宽度钉住（他："点一下就会变窄"）====================
//   实测真因不在我们代码里：前端在点击/聚焦之后会拿它自己记的 `widget.width`
//   （一个过时的 ~294px）去重设 DOM 控件的元素宽度，节点 size 完全没变，
//   于是面板 455 → 274（"变窄一半"）。做法：widget.width 改成"永远 = 节点宽 - 20"的计算属性，
//   元素宽度写死 + ResizeObserver 盯着被改小就按回去；节点真换档（onResize）时重算。
function pinWidgetWidth(node, widget) {
  try {
    if (!widget || !widget.element || node.__lpWidthPinned) return;
    node.__lpWidthPinned = true;
    const el = widget.element;
    const want = () => Math.max(240, (node.size ? node.size[0] : LP_BASE[0]) - 20);
    try {
      Object.defineProperty(widget, "width", {
        get: want,
        set: function () { /* 前端写的宽度不采纳 */ },
        configurable: true,
      });
    } catch (e) { /* 忽略 */ }
    const apply = () => { try { el.style.width = want() + "px"; } catch (e) { /* 忽略 */ } };
    apply();
    if (window.ResizeObserver) {
      let lastNode = -1;
      node.__lpWidthRO = new ResizeObserver(() => {
        const nw = node.size ? node.size[0] : 0;
        if (!nw) return;
        if (nw !== lastNode) { lastNode = nw; apply(); return; }
        if (Math.abs(el.offsetWidth - want()) > 8) apply();
      });
      node.__lpWidthRO.observe(el);
    }
    const prevResize = node.onResize;
    node.onResize = function () {
      const r = prevResize ? prevResize.apply(this, arguments) : undefined;
      apply();
      return r;
    };
  } catch (e) { /* 忽略 */ }
}
function clamp(v) {
  v = Math.round(Number(v) / STEP) * STEP;
  return Math.max(VMIN, Math.min(VMAX, Math.round(v * 100) / 100));
}

// ==================== ★ 214 批：角色 / 画风的颜色 + 角色互斥 ====================
//   他："Lora 池的上框框就算设置好了，也根本就没有角色 Lora 之间互斥的功能，
//        而且角色 Lora 和画风 Lora 的颜色也没有互相分"
//   → ① 胶囊和参数行都按种类上色：**角色=红 / 画风=蓝 / 没标=紫（默认）**；
//     ② **角色之间互斥**：再点亮一颗角色，就把别的角色自动关掉（画风不互斥，可以很多个）。
const KC = {
  char:  { bd: "#ff5c7a", bg: "#3a1f27", fg: "#ffd9e0", dot: "#ff5c7a" },
  style: { bd: "#38bdf8", bg: "#1b2f42", fg: "#d6ecff", dot: "#38bdf8" },
  "":    { bd: "#8a72ff", bg: "#3d3170", fg: "#efe9ff", dot: "#a855f7" },
};
function kindOf(st, name) {
  const k = st && st.kinds && st.kinds[name];
  return (k === "char" || k === "style") ? k : "";
}
function kindLabel(k) { return k === "char" ? "角色" : (k === "style" ? "画风" : "没标"); }
// 角色互斥：如果 keep 是角色且已点亮，就把其它亮着的角色关掉，返回被关掉的名字
// 291：某一类"最多同时点亮几颗"（0 = 无限制；老工作流里开过双人模式的，角色上限按 2 算）
function maxLitOf(st, kind) {
  const key = (kind === "char") ? "lpMaxChar" : "lpMaxStyle";
  const def = (kind === "char") ? 1 : 0;
  let v = (st && st[key] != null) ? Number(st[key]) : NaN;
  if (!isFinite(v)) {
    if (kind === "char" && st && st.lpTwoChar === true) v = 2;
    else v = def;
  }
  if (!isFinite(v) || v < 0) v = def;
  return Math.min(5, v);
}
function closeOtherChars(st, keep) {
  const off = [];
  // ★ 291 批（他第 8 条："删掉作为测试用的 Lora 池双人模式，改为直接在设置中调整角色和画风 Lora
  //   的最多持有数量，默认为角色一、画风无限制"）
  //   → 不再按"是不是角色"硬互斥，改成**按上限收**：超过上限就从池子后面往前关掉几颗。
  if (!keep || !keep.on) return off;
  const kind = kindOf(st, keep.name);
  if (!kind) return off;
  const max = maxLitOf(st, kind);
  if (!max) return off;                       // 0 = 无限制
  const lit = (st.loras || []).filter((r) => r && r.on && kindOf(st, r.name) === kind);
  const others = lit.filter((r) => r !== keep);
  let over = lit.length - max;
  for (let i = others.length - 1; i >= 0 && over > 0; i--) {
    others[i].on = false;
    off.push(String(others[i].name || "").replace(/\.safetensors$/i, ""));
    over--;
  }
  return off;
}
function stateWidget(node) {
  const ws = node && node.widgets;
  if (!Array.isArray(ws)) return null;
  return ws.find((w) => w && w.name === "状态") || null;
}
// ★ 283：`fromImg` = 生图时自动读原图 LoRA（底栏那颗 📥 小图标控制）
function readState(node) {
  const w = stateWidget(node);
  let o = null;
  try { o = JSON.parse(String((w && w.value) || "") || "null"); } catch (e) { o = null; }
  if (!o || !Array.isArray(o.loras)) o = { mode: "model", loras: [] };
  if (o.mode !== "clip") o.mode = "model";
  // ★ 217 批：宽 / 高各自 1/2/3 倍（老工作流只有 lpSize → 换算成 1/2/3 倍，别丢他的设置）
  {
    const legacy = o.lpSize === "m" ? 2 : (o.lpSize === "l" ? 3 : 1);
    o.lpW = lpMul(o.lpW || legacy);
    o.lpH = lpMul(o.lpH || legacy);
  }
  // ★ 222 批：参数行的删除键 ✕ 默认**不显示**（防误触），要开就进 ⚙ 管理打开
  o.lpDel = o.lpDel === true;
  // ★ 224 批（他 223/224 批给的规格）：每颗 LoRA 的**触发词**（两处都存：这里 + 组合存档里）
  if (!o.trig || typeof o.trig !== "object" || Array.isArray(o.trig)) o.trig = {};
  // 随机组合开关 + 时机（queue = 点生图/加入队列算一次；each = 每张图都换）
  o.lpRand = o.lpRand === true;
  o.lpRandMode = o.lpRandMode === "each" ? "each" : "queue";
  // ★ 227 批（他："在实装固定位的同时，同时上线排斥位，红蓝各填一处存档，保证这样的搭配不会在随机中出现"）
  //   固定位 = 缩小候选池（红/蓝各勾几个，只从这些里抽）；排斥位 = 指定 (红X + 蓝Y) 不许出现。
  if (!o.lpRandPin || typeof o.lpRandPin !== "object") o.lpRandPin = { char: [], style: [] };
  if (!Array.isArray(o.lpRandPin.char)) o.lpRandPin.char = [];
  if (!Array.isArray(o.lpRandPin.style)) o.lpRandPin.style = [];
  if (!Array.isArray(o.lpRandBan)) o.lpRandBan = [];
  // ★ 228 批（他："居然是点亮的 lora 会直接排在第一位……所以节点做个小开关，可以选择 Lora 点亮了之后在原地还是排前面"）
  //   lpKeepOrder 默认 true = **点亮原地不动**（排序更稳）；关掉就回到"点亮排最前"。
  o.lpKeepOrder = o.lpKeepOrder !== false;
  // ★ 273 批（他 272 批第 10 / 15 条）：两个新开关
  //   ① lpTwoChar = 双人模式（**测试用**）：允许两个角色 LoRA 同时点亮（默认关 = 角色互斥）
  //   ② lpFree    = 放开强度上限：滑块拉到 2.0 就换成文本框，想填多少自己填（关掉回滑块）
  o.lpTwoChar = o.lpTwoChar === true;
  o.lpFree = o.lpFree === true;
  // ★ 273 批：**读状态时也不能把超过 2 的值夹掉** —— 不然文本框里填 3.5 一读就变回 2（第一版就栽在这）
  const strengthOf = (v, d) => {
    const n = Number(v);
    if (!isFinite(n)) return d;
    if (o.lpFree) return Math.max(-5, Math.min(20, Math.round(n * 100) / 100));
    return clamp(n);
  };
  o.loras.forEach((r) => {
    r.name = String(r.name || "");
    r.on = r.on !== false;
    r.model = strengthOf(r.model == null ? 1 : r.model, 1);
    r.clip = strengthOf(r.clip == null ? 1 : r.clip, 1);
  });
  return o;
}
// ★ 232 批（他："一次性能点亮的 Lora 数量有限制，确实应该像你说的那样，就该有限制，
//   正常的 3 个就正常了，不正常的 4 个也差不多了，就 4 个上限吧"）
//   → **同时最多点亮 4 个**：超出时按顺序保留前面的 4 个，把后面的自动关掉并提示。
const MAX_LIT = 4;
function capLit(st) {
  if (!st || !Array.isArray(st.loras)) return [];
  const lit = st.loras.filter((r) => r.on !== false);
  if (lit.length <= MAX_LIT) return [];
  const keep = new Set(lit.slice(0, MAX_LIT).map((r) => r.name));
  const dropped = [];
  lit.forEach((r) => {
    if (!keep.has(r.name)) { r.on = false; dropped.push(String(r.name).replace(/\.safetensors$/i, "")); }
  });
  return dropped;
}
function writeState(node, st) {
  const w = stateWidget(node);
  if (!w) return;
  const dropped = capLit(st);                 // ★ 232 批：写入前先卡 4 个上限
  try { w.value = JSON.stringify(st); } catch (e) { /* 忽略 */ }
  try { node.graph && node.graph.change && node.graph.change(); } catch (e) { /* 忽略 */ }
  if (dropped.length) {
    try { toast(node, "最多同时点亮 " + MAX_LIT + " 个 LoRA —— 已自动关掉：" + dropped.join("、")); } catch (e) { /* 忽略 */ }
  }
  // ★ 214 批（他："伴随位的伴随效果不是实时的，有几秒钟延迟"）→ 池子一改就**立刻**通知外面，
  //   不再等 CLIP 节点那边 3 秒一次的轮询（prompt_clip.js 里监听这个事件重画伴随位）。
  try { window.dispatchEvent(new CustomEvent("pc-lorapool-changed", { detail: { node: node } })); } catch (e) { /* 忽略 */ }
}
function sorted(st) {
  // ★ 226 批：角色(红) → 画风(蓝) → 没标(紫) 自动排序
  // ★ 228 批：**亮着的是否提前由开关决定**（`lpKeepOrder`，默认 true = 原地不动）
  const kinds = (st && st.kinds) || {};
  const keep = !st || st.lpKeepOrder !== false;
  const rank = (r) => {
    const k = kinds[r.name];
    return k === "char" ? 0 : (k === "style" ? 1 : 2);
  };
  return st.loras.map((r, i) => ({ r: r, i: i }))
    .sort((a, b) => {
      if (!keep && a.r.on !== b.r.on) return a.r.on ? -1 : 1;   // 只有关掉开关时才"点亮排前"
      const ka = rank(a.r), kb = rank(b.r);
      if (ka !== kb) return ka - kb;
      return a.i - b.i;
    })
    .map((x) => x.r);
}
function toast(node, msg) {
  try {
    const em = app && app.extensionManager;
    if (em && em.toast && typeof em.toast.add === "function") {
      em.toast.add({ severity: "info", summary: "LoRA 池", detail: msg, life: 2200 });
      return;
    }
  } catch (e) { /* 忽略 */ }
  log(msg);
}

// ---- 取 loras 名单（和 ComfyUI 自己的 LoraLoader 用同一份）----
async function fetchLoras() {
  try {
    const r = await fetch("/object_info/LoraLoader", { cache: "no-store" });
    const j = await r.json();
    const spec = j && j.LoraLoader && j.LoraLoader.input && j.LoraLoader.input.required;
    const list = spec && spec.lora_name && spec.lora_name[0];
    if (Array.isArray(list) && list.length) return list.slice();
  } catch (e) { /* 忽略 */ }
  return FALLBACK_LORAS.slice();
}

// ---------------- 面板 ----------------
function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "lp-root";
  root.style.cssText = [
    "display:flex", "flex-direction:column", "gap:8px", "width:100%", "height:100%",
    "padding:8px", "box-sizing:border-box",
    "font:12px/1.5 system-ui,'Microsoft YaHei',sans-serif", "color:#e8eaf1",
  ].join(";");

  // —— 上面：装填框（★ 191 批重做）——
  //   他原话：「装填 Lora 一、装填 Lora 二那个地方本身并不好用，那个地方应该重新设置，放一个框框，
  //   用胶囊的方式显示 Lora 名称，拖动胶囊可以调整其间的顺序，点击胶囊可以使一个 Lora 暂时失效，
  //   背景用灰字提醒，把 Lora 节点拖动到这里，就可以把 Lora 节点吃掉，
  //   框框本身也要和游动羽翼工具栏的第 4 个功能模型别名互相生效」
  //   → 一个框，里面全是胶囊：拖 = 换顺序（顺序就是叠 LoRA 的顺序）；点 = 暂时失效（灰掉）；
  //     空白处那行灰字就是"把 Lora 节点拖到这里"的提醒；胶囊上显示的是**模型别名**（没有别名才显示文件名）。
  const caps = document.createElement("div");
  caps.className = "lp-caps";
  // ★ 192 批（他："最上面那个放 logo 的框肯定不能是虚线框啊，得是实线框"）→ 实线
  // ★ 193 批：高度改成按「小 / 中 / 大」档位 = 胶囊框 1 / 2 / 3 排（在 applySize 里设）
  caps.style.cssText = [
    "position:relative", "flex:0 0 auto", "min-height:46px", "max-height:46px", "overflow-y:auto", "overflow-x:hidden",
    "border:1px solid rgba(150,162,180,.55)", "border-radius:10px", "padding:7px", "box-sizing:border-box",
    "display:flex", "flex-wrap:wrap", "gap:6px", "align-content:flex-start", "background:rgba(255,255,255,.03)",
  ].join(";");
  const capHint = document.createElement("div");
  capHint.className = "lp-cap-hint";
  capHint.textContent = "把 Lora 节点拖到这里，就能把它吃掉";
  capHint.style.cssText = [
    "position:absolute", "left:8px", "right:8px", "top:0", "bottom:0", "display:flex", "align-items:center",
    "justify-content:center", "pointer-events:none", "font-size:11px", "opacity:.32", "text-align:center",
    "line-height:1.4", "z-index:0",
  ].join(";");
  caps.appendChild(capHint);
  root.appendChild(caps);
  node.__lpCaps = caps;
  node.__lpCapHint = capHint;

  // —— 中间：模式切换滑块（模型强度 / CLIP 强度）——
  const mode = document.createElement("div");
  mode.className = "lp-mode";
  mode.style.cssText = [
    "position:relative", "flex:0 0 auto", "height:30px", "border-radius:15px",
    "background:rgba(255,255,255,.08)", "border:1px solid rgba(150,162,180,.35)",
    "display:flex", "cursor:pointer", "user-select:none", "overflow:hidden",
  ].join(";");
  mode.innerHTML = '<div class="lp-mode-knob" style="position:absolute;top:2px;left:2px;width:calc(50% - 4px);height:24px;'
    + 'border-radius:12px;background:linear-gradient(135deg,#7c5cff,#3b82f6);transition:left .16s ease"></div>'
    + '<div style="flex:1;display:flex;align-items:center;justify-content:center;position:relative;z-index:1;font-weight:700;font-size:11.5px">模型强度</div>'
    + '<div style="flex:1;display:flex;align-items:center;justify-content:center;position:relative;z-index:1;font-weight:700;font-size:11.5px">CLIP 强度</div>';
  mode.addEventListener("click", (e) => {
    const r = mode.getBoundingClientRect();
    const st = readState(node);
    st.mode = (e.clientX - r.left) < r.width / 2 ? "model" : "clip";
    writeState(node, st); render(node);
  });
  root.appendChild(mode);

  // —— 下面：带边框的滚动框（他："下面的参数用一个框框框起来，这样子好放滚轮上下"）——
  //   ★ 194 批（他："中档位应该一排两个 lora 的参数，大档位一排三个，这样更直观"）→ 改成 grid，
  //     列数跟档位走（小 1 / 中 2 / 大 3），由 applySize 设 gridTemplateColumns。
  const box = document.createElement("div");
  box.className = "lp-box";
  box.style.cssText = [
    "flex:1 1 auto", "min-height:0", "border:1px solid rgba(150,162,180,.35)", "border-radius:10px",
    "background:rgba(0,0,0,.16)", "overflow-y:auto", "overflow-x:hidden",
    "display:grid", "grid-template-columns:minmax(0,1fr)", "align-content:start", "gap:6px", "padding:6px",
  ].join(";");
  root.appendChild(box);
  node.__lpBox = box;

  // —— 底部：＋ 加一颗 ——
  const foot = document.createElement("div");
  foot.style.cssText = "flex:0 0 auto;display:flex;gap:6px";
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "＋ 加一颗 LoRA";
  add.style.cssText = "flex:1 1 auto;height:24px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
    + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1";
  add.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    // ★ 183 批⑨：点一下先**选**要加哪一颗（以前只能按顺序加）
    pickLora(node, (name) => {
      if (!name) return;
      const st = readState(node);
      st.loras.push({ name: name, on: true, model: 1, clip: 1 });
      writeState(node, st); render(node);
      toast(node, "加了一颗「" + name + "」");
    });
  });
  foot.appendChild(add);
  // ★ 182 批①：加号旁边的「管理」——只有从这里才能把吃掉的 LoRA 节点吐回画布（行里点一下只是"暂时隐藏"）
  const mgr = document.createElement("button");
  mgr.type = "button";
  mgr.textContent = "⚙";
  mgr.title = "⚙ LoRA 管理：把池子里的 LoRA 吐回画布 / 存读整套组合 / 切档位";
  mgr.style.cssText = "flex:0 0 auto;width:30px;height:24px;border-radius:8px;cursor:pointer;font-family:inherit;"
    + "font-size:13px;border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1";
  mgr.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    openManager(node);
  });
  foot.appendChild(mgr);
  // ★ 283 批（他："Lora 池中的从原图读 Lora 这个功能，它并不是一个点击的响应键，而是一个勾选键，
  //   勾选之后它就会自动在生图的时候这么干…… 放在 Lora 池上面，作为一个单独的小按钮，
  //   鼠标悬在上面再显示解释，其他情况都是一个普通的图标"）
  //   → 底栏一颗小图标：亮 = 每次生图自动读"画廊第三层选中那张图"的 LoRA 并叠进池子（后端做），
  //   暗 = 不管。解释只在悬停的 title 里，平时就是个图标。
  const fromImg = document.createElement("button");
  fromImg.type = "button";
  fromImg.textContent = "📥";
  fromImg.dataset.lpfromimg = "1";
  fromImg.style.cssText = "flex:0 0 auto;width:30px;height:24px;border-radius:8px;cursor:pointer;font-family:inherit;"
    + "font-size:13px;line-height:1;border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1";
  function paintFromImg() {
    const on = !!(readState(node).fromImg);
    fromImg.style.background = on ? "rgba(124,92,255,.55)" : "rgba(255,255,255,.06)";
    fromImg.style.borderColor = on ? "rgba(160,130,255,.95)" : "rgba(150,162,180,.45)";
    fromImg.style.color = on ? "#fff" : "#e8eaf1";
    fromImg.title = (on ? "已开启：每次生图都会自动读「画廊第三层选中那张图」用的 LoRA，并用它盖掉池子里同名那颗的强度"
      : "点一下开启：每次生图自动读「画廊第三层选中那张图」用的 LoRA（局部重绘时用得上；文生图没有原图就不动）")
      + "\n开着 = 这颗图标是亮的。只搬 LoRA，不碰提示词和采样参数。";
  }
  fromImg.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const st2 = readState(node);
    st2.fromImg = !st2.fromImg;
    writeState(node, st2);
    paintFromImg();
    toast(node, st2.fromImg ? "已开启：生图时自动读原图的 LoRA" : "已关闭：生图时不再读原图的 LoRA");
  });
  paintFromImg();
  foot.appendChild(fromImg);
  // ★ 227 批（他："把每次生成随机取一个组合，这个勾选放到 lora 管理外面，就是 lora 池节点上"）
  //   → 开关放在节点面板的底栏（⚙ 里面只留"随机时机 / 固定位 / 排斥位"）。
  const randBox = document.createElement("label");
  randBox.className = "lp-rand-switch";
  randBox.title = "开着的时候：每次生成从存下的组合里随机抽（红角色抽一套 + 蓝画风抽一套）。\n"
    + "抽的范围、时机、排斥的搭配，都在 ⚙ 里设。";
  randBox.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:4px;height:24px;padding:0 8px;"
    + "border-radius:8px;cursor:pointer;font-size:11px;user-select:none;"
    + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1;white-space:nowrap";
  const randCb = document.createElement("input");
  randCb.type = "checkbox";
  randCb.dataset.lprand = "1";
  randCb.style.cssText = "cursor:pointer;margin:0";
  const randTxt = document.createElement("span");
  randTxt.textContent = "随机组合";
  function paintRandSwitch() {
    const st0 = readState(node);
    randCb.checked = st0.lpRand === true;
    randBox.style.borderColor = st0.lpRand ? "rgba(124,92,255,.9)" : "rgba(150,162,180,.45)";
    randBox.style.background = st0.lpRand ? "rgba(124,92,255,.26)" : "rgba(255,255,255,.06)";
    randTxt.style.fontWeight = st0.lpRand ? "700" : "400";
  }
  randCb.addEventListener("click", (e) => e.stopPropagation());
  randCb.addEventListener("change", (e) => {
    e.stopPropagation();
    const st = readState(node);
    st.lpRand = randCb.checked;
    writeState(node, st);
    paintRandSwitch();
    toast(node, randCb.checked ? "已开启：每次生成随机抽一套组合（红角色 + 蓝画风）" : "已关闭随机组合");
  });
  node.__lpRandSwitch = paintRandSwitch;
  paintRandSwitch();
  randBox.appendChild(randCb); randBox.appendChild(randTxt);
  foot.appendChild(randBox);
  // ★ 228 批：点亮之后"排到最前 / 留在原地"的开关（他："节点做个小开关"）
  const keepBox = document.createElement("label");
  keepBox.className = "lp-keep-switch";
  keepBox.title = "勾上：LoRA 点亮后**留在原位**（排序更稳）。\n不勾：点亮就自动排到最前面。";
  keepBox.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:4px;height:24px;padding:0 8px;"
    + "border-radius:8px;cursor:pointer;font-size:11px;user-select:none;"
    + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1;white-space:nowrap";
  const keepCb = document.createElement("input");
  keepCb.type = "checkbox"; keepCb.dataset.lpkeep = "1";
  keepCb.style.cssText = "cursor:pointer;margin:0";
  const keepTxt = document.createElement("span");
  keepTxt.textContent = "点亮原地";
  keepCb.addEventListener("click", (e) => e.stopPropagation());
  keepCb.addEventListener("change", (e) => {
    e.stopPropagation();
    const stK = readState(node);
    stK.lpKeepOrder = keepCb.checked;
    writeState(node, stK);
    render(node);
    toast(node, keepCb.checked ? "点亮后原地不动" : "点亮后排到最前面");
  });
  node.__lpKeepSwitch = function () { keepCb.checked = readState(node).lpKeepOrder !== false; };
  keepCb.checked = readState(node).lpKeepOrder !== false;
  keepBox.appendChild(keepCb); keepBox.appendChild(keepTxt);
  foot.appendChild(keepBox);
  root.appendChild(foot);

  return { root, box, mode, caps };
}

// ==================== ★ 191 批：模型别名（和「游动羽翼工具栏」第 3/4 项那份是同一张表）====================
//   别名表存在节点文件夹里的 model_aliases.json，key = "loras/文件名"。
//   这里**只读显示 + 双击改名**，两边互相生效：在工具栏改的，池子里立刻跟着变；在池子里双击改的，工具栏那边也变。
let LP_ALIASES = {};
async function fetchAliases() {
  try {
    const r = await fetch("/prompt_sync/aliases", { cache: "no-store" });
    const j = await r.json();
    if (j && j.success && j.aliases) { LP_ALIASES = j.aliases || {}; return LP_ALIASES; }
  } catch (e) { /* 后端没这接口就算了，用文件名显示 */ }
  return LP_ALIASES;
}
function aliasKeyOf(name) { return "loras/" + String(name || ""); }
function aliasOf(name) { return String(LP_ALIASES[aliasKeyOf(name)] || ""); }
function labelOf(name) { return aliasOf(name) || String(name || ""); }
async function setAliasOf(name, text) {
  const body = { key: aliasKeyOf(name), alias: String(text || "").trim() };
  try {
    const r = await fetch("/prompt_sync/aliases", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j && j.success) { LP_ALIASES = j.aliases || {}; return true; }
  } catch (e) { /* 忽略 */ }
  return false;
}

// ---------------- 一行 ----------------
function buildRow(node, st, row, rerender) {
  const el = document.createElement("div");
  el.className = "lp-row";
  const kd0 = kindOf(st, row.name);
  el.style.cssText = [
    "display:flex", "align-items:center", "gap:7px", "flex:0 0 auto", "height:34px",
    "padding:0 6px", "border-radius:8px", "border:1px solid rgba(150,162,180,.26)",
    // ★ 214 批：左边一条 3px 的**种类色**（角色红 / 画风蓝 / 没标紫），参数列表里一眼分类
    "border-left:3px solid " + KC[kd0].dot,
    "background:" + (row.on ? "rgba(255,255,255,.05)" : "rgba(255,255,255,.02)"),
    "opacity:" + (row.on ? "1" : ".55"),
  ].join(";");
  el.title = kindLabel(kd0) + "（同类超过「最多同时点亮」的上限时，会自动关掉前面那几颗）";

  // 「用 / 停」小胶囊（他："小眼睛图标换成其他的"）
  const pill = document.createElement("div");
  pill.style.cssText = [
    "flex:0 0 auto", "width:34px", "height:18px", "border-radius:9px", "cursor:pointer",
    "font-size:10.5px", "font-weight:700", "display:flex", "align-items:center", "justify-content:center",
    "border:1px solid " + (row.on ? "rgba(80,200,140,.75)" : "rgba(150,162,180,.45)"),
    "background:" + (row.on ? "rgba(80,200,140,.22)" : "rgba(255,255,255,.06)"),
    "color:" + (row.on ? "#7ee0a8" : "#9aa1b3"),
  ].join(";");
  pill.textContent = row.on ? "用" : "停";
  pill.dataset.lpon = String(row.name || "");      // ★ 291：给探针一个确定的行锚
  pill.title = row.on ? "点一下：暂时不用（不参与生成，排到最后）" : "点一下：重新参与生成";
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    row.on = !row.on;
    const off = closeOtherChars(st, row);          // ★ 291：按「最多同时点亮」的上限收
    writeState(node, st); rerender();
    if (off.length) toast(node, "已到上限：自动关掉了 " + off.join("、"));
  });
  el.appendChild(pill);

  const name = document.createElement("div");
  name.style.cssText = "flex:0 1 auto;min-width:0;max-width:34%;overflow:hidden;text-overflow:ellipsis;"
    + "white-space:nowrap;font-size:11.5px";
  name.textContent = row.name || "（未选）";
  name.title = row.name || "";

  // 强度滑块（模型 / CLIP 由中间那颗切换）—— 拖动用 document 级监听，不然会被画布吃掉
  const track = document.createElement("div");
  track.style.cssText = "position:relative;flex:1 1 auto;min-width:36px;height:16px;border-radius:8px;"
    + "background:rgba(255,255,255,.10);border:1px solid rgba(150,162,180,.30);cursor:pointer;"
    + "touch-action:none;user-select:none";
  const fill = document.createElement("div");
  fill.style.cssText = "position:absolute;left:0;top:0;bottom:0;border-radius:8px;"
    + "background:linear-gradient(90deg,rgba(124,92,255,.55),rgba(59,130,246,.55));pointer-events:none";
  track.appendChild(fill);
  const knob = document.createElement("div");
  knob.style.cssText = "position:absolute;top:-4px;width:14px;height:22px;border-radius:7px;pointer-events:none;"
    + "background:linear-gradient(135deg,#7c5cff,#3b82f6);box-shadow:0 1px 5px rgba(0,0,0,.4)";
  track.appendChild(knob);

  const num = document.createElement("div");
  num.style.cssText = "flex:0 0 auto;width:38px;text-align:right;font-size:11px;opacity:.92";

  // ★ 215 批：参数行默认**不造 ✕**。
  // ★ 222 批（他："角色画风在标红蓝的情况下还有红叉叉按键……红叉叉其实是可以有的，
  //   但是为了防止误触还是设计一个开关，开了之后再有叉叉吧。而且说到底，这又是一半有红叉叉、
  //   一半没有红叉叉的现象"）→ 改成 **⚙ 里一个总开关**（默认关）；一开就**所有行都有** ✕，不再一半一半。
  const del = document.createElement("div");
  del.textContent = "✕";
  del.style.cssText = "flex:0 0 auto;width:16px;text-align:center;cursor:pointer;opacity:.55;font-size:11px";
  del.title = row.src === "node"
    ? "从池子里删掉这颗（这颗是从画布吃进来的，节点已经不在画布上了 → 删掉 = 丢弃它）"
    : "从池子里删掉这颗";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    const i = st.loras.indexOf(row);
    if (i >= 0) st.loras.splice(i, 1);
    writeState(node, st); rerender();
  });
  function paint() {
    const v = st.mode === "clip" ? row.clip : row.model;
    const pct = (v - VMIN) / (VMAX - VMIN);
    knob.style.left = "calc(" + (pct * 100).toFixed(1) + "% - 7px)";
    fill.style.width = (pct * 100).toFixed(1) + "%";
    num.textContent = v.toFixed(2);
    track.title = (st.mode === "clip" ? "CLIP 强度" : "模型强度") + "：" + v.toFixed(2) + "（左右拖，0.05 一格；滚轮不再改数值）";
  }
  function setFromX(clientX) {
    const r = track.getBoundingClientRect();
    if (!r.width) return;
    const v = clamp(((clientX - r.left) / r.width) * (VMAX - VMIN) + VMIN);
    if (st.mode === "clip") row.clip = v; else row.model = v;
    paint();
  }
  track.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    setFromX(e.clientX);
    const move = (ev) => { ev.preventDefault(); setFromX(ev.clientX); };
    const up = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      writeState(node, st);
      // ★ 273 批：放开上限时，拖到 2.0 要当场换成文本框（不重画就还是滑块）
      try { if (readState(node).lpFree === true) render(node); } catch (e) { /* 忽略 */ }
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
  });
  // ★ 194 批（他："在参数上滚轮会调整参数，这个效果关掉，会影响拖动体验"）→ 滚轮调强度**删掉**，
  //   滚轮现在只用来滚列表（不然在滑杆上滚一下数值就变了，还挡住整页滚动）。

  el.appendChild(name);
  // ★ 273 批（他 272 批第 15 条："开关之后，在 lora 参数拉到 2.0 时直接去掉滑块，给你个文本栏，爱填多少数自己填；
  //   想从文本框滑回滑块，把开关关闭不就好了"）
  //   → 只在 lpFree 打开 **且这一行已经到 2.0** 时把滑块换成输入框；关掉开关 readState 会把超限值夹回 2.0 并重建滑块。
  const curV = () => Number(st.mode === "clip" ? row.clip : row.model) || 0;
  if (st.lpFree === true && curV() >= VMAX - 0.001) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = String(curV());
    input.dataset.lpfree = "1";
    input.title = "自由数值：开关打开时，拉到 2.0 就换成这个框，爱填多少填多少（填回小于 2 会变回滑块）";
    input.style.cssText = "flex:1 1 auto;min-width:44px;height:18px;border-radius:7px;cursor:text;"
      + "border:1px solid rgba(124,92,255,.85);background:rgba(124,92,255,.18);color:#efe9ff;"
      + "font:inherit;font-size:11px;padding:0 6px;text-align:right";
    const commit = () => {
      const n = Number(String(input.value).replace(/[^0-9.\-]/g, ""));
      if (!isFinite(n)) { input.value = String(curV()); return; }
      const st2 = readState(node);
      const target = (st2.loras || []).find((x) => x && x.name === row.name) || row;
      const v = Math.round(n * 100) / 100;
      if (st.mode === "clip") target.clip = v; else target.model = v;
      writeState(node, st2);
      render(node);
    };
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
    });
    input.addEventListener("blur", commit);
    input.addEventListener("change", commit);      // 有的路径只发 change、不发 blur，两个都接
    el.appendChild(input);
  } else {
    el.appendChild(track);
    el.appendChild(num);
  }
  // ★ 196/215 批的历史：默认不给 ✕（他两次说"不需要"）。
  // ★ 222 批：改成跟随 ⚙ 里的开关 `st.lpDel`（默认关，防误触）；**开了就每一行都有**，不再是"一半一半"。
  if (st.lpDel === true) el.appendChild(del);
  paint();
  return el;
}

function render(node) {
  const box = node.__lpBox;
  if (!box) return;
  // ★ 267 批：记下"这一颗刚画过"，给 `pc-lorapool-changed` 那个监听器做去重
  //   （池子自己 writeState → render 之后，事件才到，别让它再画一遍）
  node.__lpRenderAt = (window.performance && performance.now) ? performance.now() : Date.now();
  const st = readState(node);
  const knob = node.__lpMode && node.__lpMode.querySelector(".lp-mode-knob");
  if (knob) knob.style.left = st.mode === "clip" ? "calc(50% + 2px)" : "2px";
  box.innerHTML = "";
  const rows = sorted(st);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.textContent = "池子里还没有 LoRA —— 点下面「＋ 加一颗」";
    empty.style.cssText = "opacity:.6;font-size:11.5px;padding:6px 2px";
    box.appendChild(empty);
  }
  rows.forEach((row) => box.appendChild(buildRow(node, st, row, () => render(node))));
  renderCaps(node);
}

// ---------------- ★ 191 批：上面那个框里的胶囊 ----------------
//   顺序的真值 = `st.loras` 的数组顺序（= 真的叠 LoRA 的顺序，后端 apply_pool 就是按这个走的）。
//   停掉的**留在原位**、只是灰掉（不像下面那个列表那样沉底 —— 沉底会让"换顺序"看着像没生效）。
function renderCaps(node) {
  const caps = node.__lpCaps;
  if (!caps) return;
  const st = readState(node);
  const hint = node.__lpCapHint;
  Array.prototype.slice.call(caps.querySelectorAll(".lp-cap")).forEach((c) => c.remove());
  if (hint) hint.textContent = st.loras.length
    ? "把 Lora 节点拖到这里就能吃掉它"
    : "把 Lora 节点拖到这里，就能把它吃掉（也可以点下面「＋ 加一颗」）";
  // ★ 226 批：胶囊也走 sorted() —— 角色(红) → 画风(蓝) → 没标(紫)，和下面的参数行保持一致
  sorted(st).forEach((row) => caps.appendChild(buildCap(node, st, row)));
}
// ★ 235 批：本机有没有这个 LoRA 文件（名单来自 /object_info 的 LoraLoader 下拉）。
//   名单还没拉到时返回 false —— 宁可先不标，也不要误报一片 ⚠。
function missingOnMachine(node, name) {
  const list = node && node.__lpLoras;
  if (!Array.isArray(list) || !list.length) return false;
  return list.indexOf(String(name || "")) < 0;
}

function buildCap(node, st, row) {
  const c = document.createElement("div");
  c.className = "lp-cap";
  c.dataset.name = row.name || "";
  c.style.cssText = [
    "position:relative", "z-index:1", "display:inline-flex", "align-items:center", "gap:5px", "max-width:100%",
    "font-size:11px", "line-height:1", "padding:5px 9px", "border-radius:999px", "cursor:pointer",
    "user-select:none", "-webkit-user-select:none", "white-space:nowrap", "overflow:hidden",
    "text-overflow:ellipsis", "touch-action:none",
    // ★ 192 批（他："江南画的 Lora 应该是不透明的，会把灰底小字挡住，而不是互相不透明"）
    //   → 胶囊改成**纯色不透明**底，灰字提醒在它后面被完全盖住
    "opacity:1",
  ].join(";");
  // ★ 214 批（他："角色 Lora 和画风 Lora 的颜色也没有互相分"）：点亮时按**种类**上色
  //   角色 = 红 / 画风 = 蓝 / 没标 = 紫（默认）；灭掉的统一灰。写在 cssText 之后，否则会被冲掉。
  {
    const kd = kindOf(st, row.name), kc = KC[kd];
    c.style.border = "1px solid " + (row.on ? kc.bd : "#5b6273");
    c.style.background = row.on ? kc.bg : "#2a2e3a";
    c.style.color = row.on ? kc.fg : "#98a0b3";
    c.dataset.kind = kd || "none";
  }
  const txt = document.createElement("span");
  // 有别名就显示别名（鼠标悬上去能看真文件名）；没有就用文件名
  const al = aliasOf(row.name);
  txt.textContent = labelOf(row.name);
  // ★ 222 批（他："lora 池上框框，Lora 名称太长显示不下的问题……至少得扩到 20 吧"）
  //   150px ≈ 12.5 个汉字 → 放到 260px（≈21 个汉字），再把胶囊本身允许更宽。
  txt.style.cssText = "overflow:hidden;text-overflow:ellipsis;max-width:260px;white-space:nowrap";
  c.appendChild(txt);
  c.title = (al ? (al + "（" + row.name + "）") : row.name)
    + "\n点一下：" + (row.on ? "暂时失效（不参与生图，留在原位）" : "恢复参与生图")
    + "\n按住左右拖：换叠 LoRA 的顺序　·　双击：给它起个模型别名";
  // ★ 229 批（他："鼠标悬在 Lora 池对应的 Lora 上面，就会显示对应图片"）
  //   悬停 400ms 出预览图（和原版 LoraLoader 下拉用的是同一套图：manifest + 用户自己选的）
  let pvTimer = null;
  // ★ 235 批（他：「别人导入我的工作流，但是 Lora 池里面暗淡的 Lora 却并不匹配时，
  //   仍然要保证工作流可以正常运行，也就是说只要亮起来的 Lora 有文件可以匹配，那就不会报错」）
  //   → 本机没有这个文件的，胶囊后面挂一个 ⚠：**只是提示，不改状态、不拦执行、不删名单**。
  //     后端 apply_pool 对"缺文件"一律跳过（熄灭的连查都不查），所以缺几个也照样能跑。
  if (missingOnMachine(node, row.name)) {
    const warn = document.createElement("span");
    warn.textContent = "⚠";
    warn.style.cssText = "font-size:10px;line-height:1;opacity:.9;color:" + (row.on ? "#ffd166" : "#8b93a5");
    c.appendChild(warn);
    c.title += "\n⚠ 本机没有这个文件：出图时会跳过它（不影响其他 LoRA，也不会报错）";
  }
  c.addEventListener("mouseenter", (e) => {
    if (pvTimer) clearTimeout(pvTimer);
    pvTimer = setTimeout(() => {
      pvTimer = null;
      try {
        if (!window.__pcPreview) return;
        const url = window.__pcPreview.url("loras", row.name);
        if (url) window.__pcPreview.show(url, labelOf(row.name), e.clientX, e.clientY);
      } catch (er) { /* 忽略 */ }
    }, 400);
  });
  c.addEventListener("mouseleave", () => {
    if (pvTimer) { clearTimeout(pvTimer); pvTimer = null; }
    try { if (window.__pcPreview) window.__pcPreview.hide(); } catch (er) { /* 忽略 */ }
  });
  // 点 = 暂时失效 / 恢复
  let dragged = false;
  c.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dragged) { dragged = false; return; }
    row.on = !row.on;
    const off = closeOtherChars(st, row);            // ★ 291：按「最多同时点亮」的上限收
    writeState(node, st); render(node);
    if (off.length) { toast(node, "已到上限：自动关掉了 " + off.join("、")); return; }
    toast(node, (row.on ? "恢复：「" : "暂时失效：「") + labelOf(row.name) + "」");
  });
  // 双击 = 改名（写进模型别名那张表 → 工具栏那边也变）
  c.addEventListener("dblclick", (e) => {
    e.stopPropagation(); e.preventDefault();
    const v = window.prompt("给这颗 LoRA 起个别名（留空 = 用回文件名）", al || "");
    if (v === null) return;
    setAliasOf(row.name, v).then((ok) => {
      if (!ok) { toast(node, "改别名失败（后端接口没生效？）"); return; }
      render(node);
      toast(node, v.trim() ? ("别名 → " + v.trim()) : "已用回文件名");
    });
  });
  // 按住拖动 = 换顺序（document 级监听，不然会被画布吃掉）
  c.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    dragged = false;
    c.style.cursor = "grabbing";
    c.style.zIndex = "5";
    const move = (ev) => {
      if (!dragged && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
      dragged = true;
      ev.preventDefault();
      // 找指针底下那颗兄弟胶囊 → 把这一颗挪到它前面 / 后面
      const over = Array.prototype.slice.call(node.__lpCaps.querySelectorAll(".lp-cap")).find((el) => {
        if (el === c) return false;
        const r = el.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      if (!over) return;
      const or = over.getBoundingClientRect();
      const before = (ev.clientX - or.left) < or.width / 2;
      if (before) node.__lpCaps.insertBefore(c, over);
      else node.__lpCaps.insertBefore(c, over.nextSibling);
    };
    const up = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      c.style.cursor = "pointer";
      c.style.zIndex = "1";
      if (!dragged) return;
      // 把 DOM 顺序写回 st.loras（这就是真的叠 LoRA 的顺序）
      const order = Array.prototype.slice.call(node.__lpCaps.querySelectorAll(".lp-cap")).map((el) => el.dataset.name);
      const byName = {};
      st.loras.forEach((r) => { byName[r.name] = r; });
      const next = [];
      order.forEach((n) => { if (byName[n] && next.indexOf(byName[n]) < 0) next.push(byName[n]); });
      st.loras.forEach((r) => { if (next.indexOf(r) < 0) next.push(r); });
      st.loras = next;
      writeState(node, st); render(node);
      toast(node, "顺序改好了（叠 LoRA 就按这个先后）");
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
  });
  return c;
}

app.registerExtension({
  name: "PromptSync.LoraPool",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || nodeData.name !== NODE_NAME) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const node = this;
      try {
        (node.widgets || []).slice().forEach((w) => {
          if (!w || w.name !== "状态") return;
          w.hidden = true;
          w.computeSize = function () { return [0, -4]; };
          try { if (w.element) w.element.style.display = "none"; } catch (e) { /* 忽略 */ }
        });
        node.setSize([W, H]);
        const { root, box, mode } = buildPanel(node);
        node.__lpPanel = root;
        node.__lpMode = mode;
        node.__lpBox = box;
        node.__lpLoras = FALLBACK_LORAS.slice();
        if (typeof node.addDOMWidget === "function") {
          node.__lpW = node.addDOMWidget("LoRA 池", "pcLoraPool", root, { serialize: false, hideOnZoom: false });
          // ★ 193 批（他："lora 池不允许自定义宽度高度"）：尺寸**只由档位决定**，一点 node.size 都不读
          //   → 面板请求的尺寸是常量（档位 1/2/3 倍里减掉实测余量 82），排版再怎么排都不会把节点撑大。
          node.__lpW.computeSize = function () {
            var wh = node.__lpWH || sizeWH(readState(node));
            var box = sizeBoxWH(wh);
            return [Math.max(240, box[0] - 16), Math.max(90, box[1] - LP_OVER)];
          };
          try { node.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
          // ★ 210 批：点一下池子就缩成一半 —— 前端按它自己记的 widget.width 重设了元素宽度
          pinWidgetWidth(node, node.__lpW);
        }
        // ★ 193 批：不允许自定义宽高 —— 能设就关掉四角拖动；档位从状态里读，默认「小」
        applySize(node, sizeKeyOf(readState(node)));
        try { node.resizable = false; } catch (e) { /* 忽略 */ }
        fetchLoras().then((list) => {
          node.__lpLoras = list;
          render(node);
        });
        // ★ 191 批：别名表先拉一次（胶囊上显示别名；工具栏那边改的这边跟着变）
        fetchAliases().then(() => render(node));
        render(node);
        log("LoRA 池就绪", node.id);
      } catch (e) { log("LoRA 池初始化失败", e); }
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const node = this;
      // ★ 193 批：工作流里存的尺寸不作数 —— 一律按档位重新摆（不然以前拖大的会带回来）
      setTimeout(() => {
        try { applySize(node, sizeKeyOf(readState(node))); } catch (e) { /* 忽略 */ }
        try { node.resizable = false; } catch (e) { /* 忽略 */ }
        try { render(node); } catch (e) { /* 忽略 */ }
      }, 0);
      return r;
    };
    // ★ 193 批：onResize 那个"只认用户拖"的钩子**删掉了** —— 高度完全跟着节点走，不需要再判断是谁改的。
  },
});

window.__pcLoraPool = {
  state: (n) => readState(n),
  render: (n) => { render(n); return true; },
  // ★ 215 批：探针用 —— 打开「⚙ LoRA 管理」面板（以前只能靠点那颗齿轮，探针点不准）
  openManager: (n) => { try { openManager(n); return true; } catch (e) { log("打开管理失败", e); return false; } },
  // ★ 217 批：宽 / 高分开设（探针 / 自检用；真界面在「⚙ 管理」里点两组键）
  setWH: (n, w, h) => {
    try {
      const st = readState(n);
      st.lpW = lpMul(w); st.lpH = lpMul(h);
      delete st.lpSize;
      writeState(n, st);
      applySize(n, { w: st.lpW, h: st.lpH });
      render(n);
      return true;
    } catch (e) { log("切倍数失败", e); return false; }
  },
  // 老签名：'s'|'m'|'l' → 宽高都按 1/2/3 倍（老探针还能跑）
  setSize: (n, key) => {
    try {
      const k = key === "m" ? 2 : (key === "l" ? 3 : 1);
      return window.__pcLoraPool.setWH(n, k, k);
    } catch (e) { log("切档失败", e); return false; }
  },
  sizeOf: (n) => {
    try {
      const st = readState(n), wh = sizeWH(st), box = sizeBoxWH(wh);
      const cs = n.__lpW && n.__lpW.computeSize ? n.__lpW.computeSize() : [0, 0];
      return { w: wh.w, h: wh.h, key: wh.w + "x" + wh.h,
        node: [Math.round(n.size[0]), Math.round(n.size[1])], box, widget: cs,
        rows: wh.h, cols: wh.w,
        caps: n.__lpCaps ? Math.round(n.__lpCaps.getBoundingClientRect().height) : 0,
        listCols: n.__lpBox ? String(n.__lpBox.style.gridTemplateColumns || '') : '' };
    } catch (e) { return null; }
  },
};

// ==================== ★ 182 批① 拖 LoRA 节点进来「吃掉」 + 管理键吐回去 ====================
//   他原话：「装填方式竟然只是点加号装填，除了这个以外，还要允许直接把 lora 节点整个拖进去也算，
//   这样就算吃掉了这个 Lora 池，获得了其中的数据；加号旁边来一个管理键，这样又可以把吃掉的 Lora 节点再吐出来」
//   → 拖一个 **LoraLoader** 节点、松手时它的中心落在池子面板里 = 吃掉：名字与两种强度进池子成一行，节点从画布消失。
//     ⚠️ 被吃掉的那些**点一下只是"暂时隐藏/不参与"**（用/停胶囊），**只有管理键才能吐回画布**。
(function bindAbsorbDrop() {
  // ★ 183 批⑨（他："拖动加载 Lora 节点，Lora 池根本就吃不了这个节点啊"）：
  //   上一版把屏幕坐标算成 (clientX/scale - offset)，**漏掉了画布元素的偏移**（ComfyUI 画布不在视口左上角），
  //   于是"拖到池子上方"永远算不到。这次统一用 LiteGraph 自己的 canvas 坐标换算。
  let dragging = null;
  function toCanvasPoint(clientX, clientY) {
    try {
      const c = app.canvas;
      if (typeof c.convertEventToCanvasOffset === "function") {
        const p2 = c.convertEventToCanvasOffset({ clientX: clientX, clientY: clientY });
        if (Array.isArray(p2) && isFinite(p2[0]) && isFinite(p2[1])) return p2;
      }
      const ds = c.ds;
      const el = c.canvas || c.canvasEl;
      const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
      return [(clientX - r.left) / ds.scale - ds.offset[0], (clientY - r.top) / ds.scale - ds.offset[1]];
    } catch (err) { return null; }
  }
  document.addEventListener("pointerdown", function (e) {
    try {
      if (!app || !app.canvas || !app.graph) return;
      const pt = toCanvasPoint(e.clientX, e.clientY);
      if (!pt) return;
      const n = app.graph.getNodeOnPos ? app.graph.getNodeOnPos(pt[0], pt[1]) : null;
      dragging = (n && n.type === "PromptToolLoraPool") ? null : n;     // 别自己吃自己
    } catch (err) { dragging = null; }
  }, true);
  document.addEventListener("pointerup", function () {
    const src = dragging; dragging = null;
    if (!src || src.type !== "LoraLoader") return;
    try {
      const pools = (app.graph._nodes || []).filter((n) => n && n.type === "PromptToolLoraPool" && n.__lpPanel);
      if (!pools.length) return;
      const s = src.size || [200, 100];
      const cx = src.pos[0] + s[0] / 2, cy = src.pos[1] + s[1] / 2;     // 都在画布坐标里比
      const hit = pools.find((p2) => {
        const pr = p2.__lpPanel.getBoundingClientRect();
        if (!pr.width || !pr.height) return false;
        const a = toCanvasPoint(pr.left, pr.top), b = toCanvasPoint(pr.right, pr.bottom);
        if (!a || !b) return false;
        return cx >= a[0] && cx <= b[0] && cy >= a[1] && cy <= b[1];
      });
      if (!hit) return;
      const wName = (src.widgets || []).find((w) => w && w.name === "lora_name");
      const wM = (src.widgets || []).find((w) => w && w.name === "strength_model");
      const wC = (src.widgets || []).find((w) => w && w.name === "strength_clip");
      const name = String((wName && wName.value) || "").trim();
      if (!name) { toast(hit, "这个 LoraLoader 里没选 LoRA"); return; }
      const st = readState(hit);
      const exist = st.loras.find((x) => x.name === name);
      if (exist) { exist.on = true; }
      else st.loras.push({ name: name, on: true, src: "node",
        model: clamp(wM ? wM.value : 1), clip: clamp(wC ? wC.value : 1) });
      // ★ 214 批：拖进来的这颗如果标成了「角色」，也要守角色互斥
      const offAbsorb = closeOtherChars(st, exist || st.loras[st.loras.length - 1]);
      writeState(hit, st);
      app.graph.remove(src);            // 吃掉：节点从画布消失
      render(hit);
      if (offAbsorb.length) toast(hit, "吃掉了「" + name + "」；已到上限，顺手关掉 " + offAbsorb.join("、"));
      else toast(hit, "吃掉了「" + name + "」—— 想吐回来点旁边的「管理」");
    } catch (err) { log("吃掉失败", err); }
  }, true);
})();

// 吐回画布：在池子右边一点的位置重新建一个 LoraLoader（值原样带回去）
function ejectLora(node, row) {
  try {
    // ★ 192 批（他："用了 Lora 池管理，根本吐不出来"）：真因 —— `LiteGraph.createNode` 内部要用
    //   `this.registered_node_types`，**把它拆出来存进变量再调用，this 就丢了**，直接抛
    //   `Cannot read properties of undefined (reading 'registered_node_types')`。
    //   必须**当方法来调**：`window.LiteGraph.createNode(...)`。
    const LG = window.LiteGraph;
    if (!LG || typeof LG.createNode !== "function") { toast(node, "建不出 LoraLoader（这个前端没有 LiteGraph.createNode）"); return false; }
    const n = LG.createNode("LoraLoader");
    if (!n) { toast(node, "建不出 LoraLoader（这个 ComfyUI 版本不支持？）"); return false; }
    (n.widgets || []).forEach((w) => {
      if (!w) return;
      if (w.name === "lora_name") w.value = row.name;
      if (w.name === "strength_model") w.value = row.model;
      if (w.name === "strength_clip") w.value = row.clip;
    });
    n.pos = [ (node.pos ? node.pos[0] : 0) + (node.size ? node.size[0] : W) + 40, (node.pos ? node.pos[1] : 0) + 20 ];
    app.graph.add(n);
    return true;
  } catch (e) { log("吐回失败", e); return false; }
}


// ★ 228 批（他："你读这两个画风 lora 的档，就应该让蓝区其他画风 lora 都暗掉，就这两个亮起来，并且红区不受影响" +
//   "不管红紫关系，只看名称。如果红紫关系变了，就当没变"）
//   → 读档**只动同一区**：char 存档只碰「角色」，style 存档只碰「画风 + 没标」（按名字匹配，不看它现在标成什么）。
function poolKindGroup(st, name) {
  return ((st.kinds || {})[name] === "char") ? "char" : "style";
}
function applySaveToPool(node, it) {
  const st = readState(node);
  const k = (it && (it.kind === "char" || it.kind === "style")) ? it.kind
    : (((it.loras || []).some((x) => (st.kinds || {})[x.name] === "char")) ? "char" : "style");
  const want = {};
  (it.loras || []).forEach((x) => { want[x.name] = x; });
  // ① 同一区里的：存档里有的点亮 + 套强度；没有的**暗掉**（另一区一点不碰）
  st.loras.forEach((r) => {
    if (poolKindGroup(st, r.name) !== k) return;
    const src = want[r.name];
    r.on = !!src;
    if (src) {
      if (src.model != null) r.model = src.model;
      if (src.clip != null) r.clip = src.clip;
    }
  });
  // ② 存档里有、池子里没有的 → 追进来并点亮
  (it.loras || []).forEach((x) => {
    if (!st.loras.some((r) => r.name === x.name)) {
      st.loras.push({ name: x.name, on: true, model: x.model == null ? 1 : x.model, clip: x.clip == null ? 1 : x.clip, src: x.src });
    }
  });
  // ③ 触发词跟着合并
  if (it.trig) {
    st.trig = st.trig || {};
    Object.keys(it.trig).forEach((nm) => { st.trig[nm] = it.trig[nm]; });
  }
  writeState(node, st);
  render(node);
  return { kind: k, count: (it.loras || []).length, name: it.name || "" };
}

// 管理键：列出"从节点吃进来的"那些，能吐回画布
function openManager(node) {
  const st = readState(node);
  const rows = st.loras.slice();   // ★ 208 批：池子里所有行都能吐（他也说过"太不合理了"）
  const body = document.createElement("div");
  // ★ 226 批（他："Lora 管理内容太多，左边站一排，右边站一排，这样就不会太高了"）
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:10px 16px;align-items:start";
  const colL = document.createElement("div");
  colL.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0";
  const colR = document.createElement("div");
  colR.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0";
  grid.appendChild(colL); grid.appendChild(colR);
  // ★ 250 批（他："Lora 池还是不知道怎么补回来，如果是右键的话，里面显示的东西也太多了，
  //   你可以放在设置窗口右边里面"）→ 在 ⚙ 管理弹窗**右栏**加一颗「🔁 按名单补全」
  //   （右键那条留着当兜底，但主要入口在这里）。
  try {
    const fillWrap = document.createElement("div");
    fillWrap.style.cssText = "margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap";
    const fillBtn = document.createElement("button");
    fillBtn.type = "button";
    fillBtn.className = "lp-fill-catalog";
    fillBtn.textContent = "🔁 按名单补全 LoRA";
    fillBtn.title = "把固定名单里有、池子里没有的 LoRA 补回来（补进来的默认熄灭，不会擅自点亮）";
    fillBtn.style.cssText = "font-size:11.5px;padding:4px 10px;border-radius:8px;cursor:pointer;"
      + "border:1px solid rgba(150,162,180,.5);background:rgba(255,255,255,.05);color:#dfe4ec";
    fillBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (window.__pcFillPoolCatalog) window.__pcFillPoolCatalog(node);
      else alert("补全功能还没加载上，先 Ctrl+Shift+R 刷新一下");
    });
    fillWrap.appendChild(fillBtn);
    const tip = document.createElement("span");
    tip.textContent = "名单 = comfyui节点/web/lora-catalog.json 里那 13 个";
    tip.style.cssText = "font-size:10.5px;opacity:.55";
    fillWrap.appendChild(tip);
    colR.appendChild(fillWrap);
  } catch (e) { /* 忽略 */ }

  // ★ 217 批（他："Lora 池从大中小号改为宽度一倍、二倍、三倍和高度一倍、二倍、三倍"）
  //   → 宽、高各一排三颗，可以随便组合（比如 宽 2× + 高 1×）。宽决定参数几列、高决定胶囊几排。
  const szWrap = document.createElement("div");
  szWrap.style.cssText = "margin-bottom:10px;display:flex;flex-direction:column;gap:6px";
  const wh0 = sizeWH(st);
  function sizeRow(label, which, curV) {
    const rowEl = document.createElement("div");
    rowEl.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";
    const lb = document.createElement("span");
    lb.textContent = label;
    lb.style.cssText = "font-size:11.5px;opacity:.85;flex:0 0 auto";
    rowEl.appendChild(lb);
    [1, 2, 3].forEach((mul) => {
      const box = sizeBoxWH(which === "w" ? { w: mul, h: wh0.h } : { w: wh0.w, h: mul });
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = LP_LABEL[mul];
      b.dataset.lp = which + mul;                      // 探针钩子：data-lp="w2" / "h3"
      b.title = (which === "w" ? "宽度 " : "高度 ") + mul + " 倍（" + box[which === "w" ? 0 : 1] + "px）"
        + (which === "w" ? " · 参数这一栏排 " + mul + " 列" : " · 上面那个框放 " + mul + " 排胶囊");
      b.style.cssText = "font-family:inherit;font-size:11.5px;padding:4px 10px;border-radius:8px;cursor:pointer;"
        + (mul === curV
          ? "border:1px solid rgba(124,92,255,.95);background:rgba(124,92,255,.28);color:#efe9ff;font-weight:700"
          : "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1");
      b.addEventListener("click", () => {
        const st2 = readState(node);
        if (which === "w") st2.lpW = mul; else st2.lpH = mul;
        delete st2.lpSize;
        writeState(node, st2);
        applySize(node, { w: st2.lpW, h: st2.lpH });
        render(node);
        toast(node, "尺寸改成：宽 " + st2.lpW + " 倍 × 高 " + st2.lpH + " 倍（"
          + (LP_W_BASE * st2.lpW) + "×" + (LP_H_BASE * st2.lpH) + "）");
        try { closeMini(); } catch (e) { /* 忽略 */ }
      });
      rowEl.appendChild(b);
    });
    const none = document.createElement("span");
    none.style.cssText = "font-size:10.5px;opacity:.5";
    rowEl.appendChild(none);
    return rowEl;
  }
  szWrap.appendChild(sizeRow("宽度：", "w", wh0.w));
  szWrap.appendChild(sizeRow("高度：", "h", wh0.h));
  const szNote = document.createElement("div");
  szNote.textContent = "宽 / 高各自 1~3 倍，随便组合；尺寸只由这里决定，不能拖";
  szNote.style.cssText = "font-size:11px;opacity:.6";
  szWrap.appendChild(szNote);
  // ★ 222 批（他："红叉叉其实是可以有的，但是为了防止误触还是设计一个开关，开了之后再有叉叉吧"）
  //   参数行末尾那颗删除键 ✕ 的**总开关**（默认关）。开了 → 每一行都有，不再"一半有一半没有"。
  {
    const delRow = document.createElement("label");
    delRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11.5px;cursor:pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = st.lpDel === true; cb.dataset.lpdel = "1";
    cb.style.cssText = "cursor:pointer";
    cb.addEventListener("change", () => {
      const st2 = readState(node);
      st2.lpDel = cb.checked;
      writeState(node, st2);
      render(node);
      toast(node, cb.checked ? "参数行已显示删除键 ✕（每行都有，小心误触）" : "参数行的删除键 ✕ 已隐藏");
    });
    delRow.appendChild(cb);
    delRow.appendChild(document.createTextNode("在参数行显示删除键 ✕（默认关，防误触）"));
    szWrap.appendChild(delRow);
  }
  // ★ 273 批（他 272 批第 10 / 15 条）两个新开关：
  //   ① 双人模式（测试）—— 允许两个角色 LoRA 同时点亮，用来试双人图
  //   ② 放开强度上限 —— 滑块拉到 2.0 就换成文本框；关掉立刻回滑块，并把超过 2 的夹回 2.0
  [["lpFree", "放开强度上限：拉到 2.0 就换成文本框，想填多少自己填（关掉回滑块）"]].forEach((it) => {
    const key = it[0], label = it[1];
    const rowEl2 = document.createElement("label");
    rowEl2.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11.5px;cursor:pointer";
    const cb2 = document.createElement("input");
    cb2.type = "checkbox";
    cb2.checked = st[key] === true;
    cb2.dataset[key] = "1";
    cb2.style.cssText = "cursor:pointer";
    cb2.addEventListener("change", () => {
      const st2 = readState(node);
      st2[key] = cb2.checked;
      if (key === "lpFree" && !cb2.checked) {
        (st2.loras || []).forEach((r) => {
          ["model", "clip"].forEach((k) => {
            const v = Number(r[k]);
            if (isFinite(v) && v > VMAX) r[k] = VMAX;      // 收回开关：超过 2 的夹回 2.0
          });
        });
      }
      writeState(node, st2);
      render(node);
      toast(node, cb2.checked
        ? "强度上限已放开：拖到 2.0 会变成文本框，想填多少填多少"
        : "强度上限已收回：超过 2 的已夹回 2.0，滑块回来了");
    });
    rowEl2.appendChild(cb2);
    rowEl2.appendChild(document.createTextNode(label));
    szWrap.appendChild(rowEl2);
  });
  // ★ 291：角色 / 画风"最多同时点亮几颗"（1/2/3/4/5/无限制）
  [["lpMaxChar", "角色 LoRA 最多同时点亮", 1],
   ["lpMaxStyle", "画风 LoRA 最多同时点亮", 0]].forEach((it) => {
    const key = it[0], label = it[1], defV = it[2];
    const rowS = document.createElement("label");
    rowS.style.cssText = "display:flex;align-items:center;gap:8px;justify-content:space-between;"
      + "font-size:11.5px;cursor:pointer;margin-top:5px";
    const tx = document.createElement("span");
    tx.textContent = label;
    const sel = document.createElement("select");
    sel.dataset[key] = "1";
    sel.style.cssText = "font:inherit;font-size:11px;padding:2px 6px;border-radius:6px;"
      + "background:rgba(255,255,255,.08);color:#e8eaf1;border:1px solid rgba(150,162,180,.45)";
    [1, 2, 3, 4, 5, 0].forEach((v) => {
      const o = document.createElement("option");
      o.value = String(v); o.textContent = v === 0 ? "无限制" : String(v);
      sel.appendChild(o);
    });
    const cur = (st[key] == null) ? defV : Number(st[key]);
    sel.value = String(isFinite(cur) ? cur : defV);
    sel.addEventListener("change", () => {
      const st2 = readState(node);
      st2[key] = Number(sel.value) || 0;
      writeState(node, st2);
      render(node);
      toast(node, label + "：" + (st2[key] ? (st2[key] + " 颗") : "无限制"));
    });
    rowS.appendChild(tx); rowS.appendChild(sel);
    szWrap.appendChild(rowS);
  });
  colL.appendChild(szWrap);

  const tip = document.createElement("div");
  tip.textContent = rows.length
    ? "下面这些是池子里的 LoRA（不管是从画布吃进来的、还是自己加的都能吐）。点「吐出来」会把一个 LoraLoader 放回画布；点行里的「用/停」只是暂时不参与。"
    : "还没有吃掉任何 LoRA 节点 —— 把画布上的 LoraLoader 节点直接拖到这个池子上面松手就行。";
  tip.style.cssText = "font-size:11.5px;opacity:.8;line-height:1.6;margin-bottom:8px";
  colR.appendChild(tip);
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow:auto";
  colR.appendChild(list);
  rows.forEach((r) => {
    const el = document.createElement("div");
    el.style.cssText = "display:flex;align-items:center;gap:8px;border:1px solid rgba(150,162,180,.3);"
      + "border-radius:8px;padding:6px 8px;font-size:11.5px";
    const nm = document.createElement("div");
    nm.textContent = r.name;
    nm.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const btn = document.createElement("button");
    btn.type = "button"; btn.textContent = "吐出来";
    btn.style.cssText = "flex:0 0 auto;height:22px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;"
      + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.07);color:#e8eaf1";
    btn.addEventListener("click", () => {
      if (!ejectLora(node, r)) return;
      const i = st.loras.indexOf(r);
      if (i >= 0) st.loras.splice(i, 1);
      writeState(node, st); render(node);
      toast(node, "已把「" + r.name + "」放回画布");
      try { closeMini(); } catch (e) { /* 忽略 */ }
    });
    el.appendChild(nm); el.appendChild(btn);
    list.appendChild(el);
  });
  colR.appendChild(list);

  // ★ 208 批（他："管理改为小齿轮，小齿轮再加一个存档读档功能，这样就可以将 Lora 组合存档下来了"）
  const LS_KEY = "promptCopier.loraPoolSaves.v1";
  function readSaves() { try { const a = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function writeSaves(a) { try { localStorage.setItem(LS_KEY, JSON.stringify(a.slice(-40))); } catch (e) { /* 忽略 */ } }
  const sec = document.createElement("div");
  sec.style.cssText = "margin-top:12px;border-top:1px solid rgba(150,162,180,.22);padding-top:10px";
  const t2 = document.createElement("div");
  t2.textContent = "存 / 读整套组合";
  t2.style.cssText = "font-size:12px;font-weight:700;margin-bottom:6px";
  sec.appendChild(t2);
  const row1 = document.createElement("div");
  row1.style.cssText = "display:flex;gap:6px;align-items:center";
  const inp = document.createElement("input");
  inp.type = "text"; inp.placeholder = "给这套组合起个名字（例：仪玄 · 夜景）";
  inp.style.cssText = "flex:1 1 auto;min-width:0;height:26px;border-radius:8px;border:1px solid rgba(150,162,180,.5);"
    + "background:rgba(0,0,0,.25);color:#e8eaf1;padding:0 8px;font:inherit";
  const bSave = document.createElement("button");
  bSave.type = "button"; bSave.textContent = "💾 存下当前组合";
  bSave.style.cssText = "flex:0 0 auto;height:26px;padding:0 10px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;"
    + "border:1px solid rgba(124,92,255,.7);background:rgba(124,92,255,.22);color:#efe9ff";
  row1.appendChild(inp); row1.appendChild(bSave);
  sec.appendChild(row1);
  const savedBox = document.createElement("div");
  savedBox.style.cssText = "display:flex;flex-direction:column;gap:5px;margin-top:8px;max-height:26vh;overflow:auto";
  sec.appendChild(savedBox);
  // ★ 227 批：存档按「角色(红) / 画风(蓝+未选)」分组显示；老存档没有 kind 就按内容推断
  function kindOfSave(it) {
    if (it && (it.kind === "char" || it.kind === "style")) return it.kind;
    const kinds = (readState(node).kinds) || {};
    const anyChar = ((it && it.loras) || []).some((x) => kinds[x.name] === "char");
    return anyChar ? "char" : "style";
  }
  function paintSaves() {
    savedBox.innerHTML = "";
    const arr = readSaves();
    if (!arr.length) {
      const d = document.createElement("div");
      d.textContent = "还没存过组合。点上面「存下当前组合」= 自动拆成 角色 一条 + 画风 一条。";
      d.style.cssText = "font-size:11px;opacity:.6";
      savedBox.appendChild(d); return;
    }
    [["char", "🔴 角色存档", "#ff5c7a"], ["style", "🔵 画风存档（含未选）", "#38bdf8"]].forEach((grp) => {
      const head = document.createElement("div");
      const list0 = arr.filter((it) => kindOfSave(it) === grp[0]);
      head.textContent = grp[1] + "（" + list0.length + "）";
      head.style.cssText = "font-size:11px;font-weight:700;margin:6px 0 2px;color:" + grp[2];
      savedBox.appendChild(head);
      if (!list0.length) {
        const d2 = document.createElement("div");
        d2.textContent = "（还没有这一类的存档）";
        d2.style.cssText = "font-size:10.5px;opacity:.55";
        savedBox.appendChild(d2);
      }
    });
    arr.slice().reverse().forEach((it, ridx) => {
      const isChar = kindOfSave(it) === "char";
      const i = arr.length - 1 - ridx;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;border:1px solid rgba(150,162,180,.3);border-radius:8px;padding:5px 8px;font-size:11.5px";
      const nm = document.createElement("div");
      const pinnedNow = (((readState(node).lpRandPin || {})[isChar ? "char" : "style"]) || []).indexOf(it.name) >= 0;
      nm.textContent = (pinnedNow ? "✓ " : "") + (it.name || "（无名）") + " · " + (it.loras || []).length + " 颗";
      nm.title = (it.loras || []).map((x) => x.name).join("\n");
      nm.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
        + "color:" + (isChar ? "#ffc2cd" : "#cfe2ff");
      const bPin = document.createElement("button");
      bPin.type = "button"; bPin.textContent = "固定";
      bPin.dataset.lppinsave = (isChar ? "char:" : "style:") + it.name;
      bPin.title = "把它加入随机候选（固定位）。不勾 = 这一类里所有存档都参与随机。";
      {
        const onP = (((readState(node).lpRandPin || {})[isChar ? "char" : "style"]) || []).indexOf(it.name) >= 0;
        bPin.style.cssText = "flex:0 0 auto;height:22px;padding:0 7px;border-radius:6px;cursor:pointer;"
          + "font-family:inherit;font-size:11px;"
          + (onP ? "border:1px solid rgba(124,92,255,.95);background:rgba(124,92,255,.3);color:#efe9ff;font-weight:700"
                 : "border:1px solid rgba(150,162,180,.45);background:transparent;color:#cfd6e6");
      }
      bPin.addEventListener("click", () => {
        const stp = readState(node);
        const k2 = isChar ? "char" : "style";
        if (!stp.lpRandPin[k2]) stp.lpRandPin[k2] = [];
        const arrP = stp.lpRandPin[k2];
        const ix = arrP.indexOf(it.name);
        if (ix >= 0) arrP.splice(ix, 1); else arrP.push(it.name);
        writeState(node, stp);
        paintSaves();
        toast(node, ix >= 0 ? "已取消固定「" + it.name + "」" : "已固定「" + it.name + "」（随机只在这几个里抽）");
      });
      const bLoad = document.createElement("button");
      bLoad.type = "button"; bLoad.textContent = "读取";
      bLoad.style.cssText = "flex:0 0 auto;height:22px;padding:0 8px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;"
        + "border:1px solid rgba(56,189,248,.7);background:rgba(56,189,248,.18);color:#dff3ff";
      bLoad.addEventListener("click", () => {
        // ★ 228 批：只动这一区（红档只改角色、蓝档只改画风+未标），另一区不受影响
        const res3 = applySaveToPool(node, it);
        toast(node, "已读回「" + (it.name || "无名") + "」：" + (res3.kind === "char" ? "红区" : "蓝区")
          + " 点亮 " + res3.count + " 颗，另一个区没动");
        try { closeMini(); } catch (e) { /* 忽略 */ }
      });
      const bDel = document.createElement("button");
      bDel.type = "button"; bDel.textContent = "删";
      bDel.style.cssText = "flex:0 0 auto;height:22px;padding:0 7px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;"
        + "border:1px solid rgba(255,120,120,.55);background:rgba(255,120,120,.14);color:#ffb4b4";
      bDel.addEventListener("click", () => {
        const a2 = readSaves(); a2.splice(i, 1); writeSaves(a2); paintSaves();
      });
      row.appendChild(nm); row.appendChild(bPin); row.appendChild(bLoad); row.appendChild(bDel);
      savedBox.appendChild(row);
    });
  }
  bSave.addEventListener("click", () => {
    const st4 = readState(node);
    const a = readSaves();
    const kinds = st4.kinds || {};
    // ★ 228 批（他："存档存下来的数据就不包括未点亮的，所以 5 个画风 Lora 点亮了两个，
    //   那存下来的应该是两个画风 Lora 的档，并且名称也要说是什么画风 Lora（显示别名）"）
    //   → 只存**点亮的**；名字 = 「红 · 内容」/「蓝 · 内容」（内容用别名，没有别名用文件名）
    const lit = st4.loras.filter((x) => x.on !== false);
    const chars = lit.filter((x) => kinds[x.name] === "char");
    const styles = lit.filter((x) => kinds[x.name] !== "char");     // 画风 + 没标 都算蓝区
    const nameOf = (x) => labelOf(x.name).replace(/\.safetensors$/i, "");
    const content = (list) => list.map(nameOf).join(" + ");
    const mkEntry = (list, tag, kind) => {
      const tg = {};
      list.forEach((x) => { if (st4.trig && st4.trig[x.name]) tg[x.name] = st4.trig[x.name]; });
      return { name: tag + " · " + content(list), base: tag, kind: kind, at: Date.now(), trig: tg,
        loras: list.map((x) => ({ name: x.name, on: true, model: x.model, clip: x.clip, src: x.src })) };
    };
    let saved = 0, merged = 0;
    // ★ 273 批（他 272 批第 3 条："存下当前组合会允许重复组合，应该改成不会允许重复、应该合并"
    //   实际就是同一套组合存两次会出两条一模一样的 → 存之前按「同类 + 成员名单」比一遍，
    //   命中就**更新那一条**（强度/触发词刷新、挪到最新），不新增。
    const sigOf = (list) => (list || []).map((x) => String((x && x.name) || "")).sort().join("|");
    const put = (list, tag, kind) => {
      const entry = mkEntry(list, tag, kind);
      const sig = sigOf(list);
      const i = a.findIndex((it) => (it && (it.kind === kind || (it.kind == null && kindOfSave(it) === kind)))
        && sigOf(it.loras) === sig);
      if (i >= 0) { a.splice(i, 1); merged++; }
      a.push(entry);
      saved++;
    };
    if (chars.length) put(chars, "红", "char");
    if (styles.length) put(styles, "蓝", "style");
    writeSaves(a); inp.value = ""; paintSaves();
    toast(node, saved
      ? "已" + (merged ? "更新" : "存下") + "：" + (chars.length ? "红 · " + content(chars) : "") + (chars.length && styles.length ? "　／　" : "") + (styles.length ? "蓝 · " + content(styles) : "") + (merged ? "（这套本来就有，已合并成一条）" : "")
      : "池子里没有点亮的 LoRA（熄灭的不进存档）");
  });

  // ★ 224 批：随机「时机」；★ 227 批（他）：开关挪到节点面板上（见 buildPanel 的底栏「随机组合」），
  //   这里保留"随机时机"+"排斥位"，并补一句说明「固定位」在每行存档的「固定」键上。
  const randBox = document.createElement("div");
  randBox.style.cssText = "margin-top:10px;border:1px dashed rgba(124,92,255,.5);border-radius:8px;padding:8px 9px;"
    + "display:flex;flex-direction:column;gap:6px";
  randBox.dataset.lprandbox = "1";
  const randHead = document.createElement("div");
  randHead.textContent = "随机组合（开关在池子节点面板上：『随机组合』）";
  randHead.style.cssText = "font-weight:700;font-size:11.5px;opacity:.9";
  randBox.appendChild(randHead);
  const whenRow = document.createElement("div");
  whenRow.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;opacity:.9";
  const whenLab = document.createElement("span");
  whenLab.textContent = "随机时机：";
  whenLab.style.cssText = "flex:0 0 auto;opacity:.7";
  whenRow.appendChild(whenLab);
  function mkWhen(val, txt, tip) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = txt; b.title = tip;
    b.dataset.lpwhen = val;
    const on = st.lpRandMode === val;
    b.style.cssText = "flex:0 0 auto;height:22px;padding:0 9px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;"
      + (on ? "border:1px solid rgba(124,92,255,.9);background:rgba(124,92,255,.28);color:#efe9ff;font-weight:700"
            : "border:1px solid rgba(150,162,180,.45);background:transparent;color:#cfd6e6");
    b.addEventListener("click", () => {
      const st5 = readState(node);
      st5.lpRandMode = val;
      writeState(node, st5);
      whenRow.querySelectorAll("[data-lpwhen]").forEach((x) => {
        const on2 = x.dataset.lpwhen === val;
        x.style.cssText = "flex:0 0 auto;height:22px;padding:0 9px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;"
          + (on2 ? "border:1px solid rgba(124,92,255,.9);background:rgba(124,92,255,.28);color:#efe9ff;font-weight:700"
                 : "border:1px solid rgba(150,162,180,.45);background:transparent;color:#cfd6e6");
      });
    });
    return b;
  }
  whenRow.appendChild(mkWhen("queue", "点生图 / 加入队列算一次", "一次排队抽一次；套图整批用同一套，风格统一"));
  whenRow.appendChild(mkWhen("each", "每张图都换", "批次数量 > 1 时会拆成多张分别排队，每张换一套（套图逐张换）"));
  randBox.appendChild(whenRow);

  // ---- 固定位说明（真正的勾选在每行存档的「固定」键上，这样 2:2 布局不会被撑高）----
  {
    const stPn = readState(node);
    const nC = (stPn.lpRandPin.char || []).length, nS = (stPn.lpRandPin.style || []).length;
    const pinLine = document.createElement("div");
    pinLine.dataset.lppinline = "1";
    pinLine.textContent = "固定位：红 " + (nC ? nC + " 个" : "不限") + " / 蓝 " + (nS ? nS + " 个" : "不限")
      + "　（在下面每条存档上点「固定」来缩小候选；红2×蓝3 = 6 种）";
    pinLine.style.cssText = "font-size:10.5px;opacity:.72;line-height:1.5";
    randBox.appendChild(pinLine);
  }

  // ---- 排斥位：指定「红X + 蓝Y」的这种搭配永远不出 ----
  const banWrap = document.createElement("div");
  banWrap.style.cssText = "border-top:1px solid rgba(150,162,180,.25);padding-top:6px;display:flex;flex-direction:column;gap:5px";
  banWrap.dataset.lpbanbox = "1";
  const banHead = document.createElement("div");
  banHead.textContent = "排斥位（这些搭配不会在随机里出现）";
  banHead.style.cssText = "font-weight:700;font-size:11.5px;opacity:.9";
  banWrap.appendChild(banHead);
  const banList = document.createElement("div");
  banList.style.cssText = "display:flex;flex-direction:column;gap:4px";
  function paintBans() {
    banList.innerHTML = "";
    const stB = readState(node);
    if (!stB.lpRandBan.length) {
      const d = document.createElement("div");
      d.textContent = "（还没有排斥）";
      d.style.cssText = "font-size:10.5px;opacity:.55";
      banList.appendChild(d);
      return;
    }
    stB.lpRandBan.forEach((bn, bi) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11px;"
        + "border:1px solid rgba(255,120,140,.45);border-radius:7px;padding:3px 7px;background:rgba(255,120,140,.08)";
      const txt = document.createElement("span");
      txt.textContent = "🔴 " + (bn.char || "?") + "　✕　🔵 " + (bn.style || "?");
      txt.title = "这一套红 + 蓝 的搭配不会被随机到";
      txt.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "删";
      del.style.cssText = "flex:0 0 auto;height:20px;padding:0 6px;border-radius:5px;cursor:pointer;"
        + "font-family:inherit;font-size:10.5px;border:1px solid rgba(255,120,140,.6);background:transparent;color:#ffc2cd";
      del.addEventListener("click", () => {
        const stD = readState(node);
        stD.lpRandBan.splice(bi, 1);
        writeState(node, stD);
        paintBans();
      });
      row.appendChild(txt); row.appendChild(del);
      banList.appendChild(row);
    });
  }
  banWrap.appendChild(banList);
  // 「＋ 加一条排斥」= 选一个红存档 + 一个蓝存档
  const banAdd = document.createElement("button");
  banAdd.type = "button";
  banAdd.textContent = "＋ 加一条排斥（红 + 蓝）";
  banAdd.dataset.lpbanadd = "1";
  // ★ 229 批（他："把这个红蓝渐变的 UI 加入'加一条排斥红加蓝'"）
  banAdd.style.cssText = "height:26px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:11.5px;font-weight:700;"
    + "border:1px solid rgba(255,120,140,.55);background:linear-gradient(90deg,rgba(255,92,122,.22),rgba(56,189,248,.22));"
    + "color:#f2f6ff";
  banAdd.addEventListener("click", () => {
    const all = readSaves();
    const charList = all.filter((it) => kindOfSave(it) === "char");
    const styleList = all.filter((it) => kindOfSave(it) === "style");
    if (!charList.length || !styleList.length) {
      toast(node, "要同时有「角色存档」和「画风存档」才能加排斥（先存两套）");
      return;
    }
    const mkSel = (list, label) => {
      const w = document.createElement("label");
      w.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11.5px;margin:4px 0";
      const s2 = document.createElement("select");
      s2.style.cssText = "flex:1 1 auto;height:24px;border-radius:6px;background:#20262f;color:#e8eaf1;"
        + "border:1px solid rgba(150,162,180,.5);font:inherit;font-size:11px";
      list.forEach((it) => {
        const o = document.createElement("option");
        o.value = it.name; o.textContent = it.name;
        s2.appendChild(o);
      });
      w.appendChild(document.createTextNode(label));
      w.appendChild(s2);
      return { wrap: w, sel: s2 };
    };
    const a1 = mkSel(charList, "🔴 角色：");
    const a2 = mkSel(styleList, "🔵 画风：");
    const body = document.createElement("div");
    body.appendChild(a1.wrap); body.appendChild(a2.wrap);
    const okBtn = document.createElement("button");
    okBtn.type = "button"; okBtn.textContent = "加进去";
    okBtn.dataset.lpbanok = "1";
    okBtn.style.cssText = "height:26px;padding:0 12px;border-radius:7px;cursor:pointer;font-family:inherit;"
      + "font-size:11.5px;border:1px solid rgba(255,120,140,.7);background:rgba(255,120,140,.2);color:#ffd7de";
    okBtn.addEventListener("click", () => {
      const stA = readState(node);
      stA.lpRandBan.push({ char: a1.sel.value, style: a2.sel.value });
      writeState(node, stA);
      try { closeMini(); } catch (e) { /* 忽略 */ }
      openManager(node);
      toast(node, "已加排斥：🔴 " + a1.sel.value + " + 🔵 " + a2.sel.value + "（这条搭配不会再被随机到）");
    });
    body.appendChild(okBtn);
    showMini(node, "加一条排斥位", body);
  });
  banWrap.appendChild(banAdd);
  paintBans();
  randBox.appendChild(banWrap);

  const randHint = document.createElement("div");
  randHint.textContent = "随机时的规则：🔴角色存档里抽一条 + 🔵画风存档里抽一条（固定位缩小候选，排斥位砍掉指定搭配）；"
    + "抽到的 LoRA / 开关 / 强度 / 触发词会整套套到池子上。";
  randHint.style.cssText = "font-size:10.5px;opacity:.6;line-height:1.5";
  randBox.appendChild(randHint);
  sec.appendChild(randBox);
  paintSaves();
  // ★ 209 批：每颗 LoRA 可以标「角色 / 画风」；没标 = 紫色，标了角色红、画风蓝（可以标很多个）
  const kindSec = document.createElement("div");
  kindSec.style.cssText = "margin-top:12px;border-top:1px solid rgba(150,162,180,.22);padding-top:10px";
  const kindT = document.createElement("div");
  kindT.textContent = "角色 / 画风（紫 = 没标；角色=红、画风=蓝）· 角色之间互斥（点亮一颗角色会自动关掉别的角色），画风可以很多个";
  kindT.style.cssText = "font-size:11.5px;opacity:.8;margin-bottom:6px;line-height:1.5";
  kindSec.appendChild(kindT);
  const kindList = document.createElement("div");
  kindList.style.cssText = "display:flex;flex-direction:column;gap:5px;max-height:30vh;overflow:auto";
  function paintKinds() {
    kindList.innerHTML = "";
    const st5 = readState(node);
    if (!st5.loras.length) {
      const d0 = document.createElement("div");
      d0.textContent = "池子里还没有 LoRA。";
      d0.style.cssText = "font-size:11px;opacity:.6";
      kindList.appendChild(d0); return;
    }
    st5.loras.forEach(function (r) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid rgba(150,162,180,.25);border-radius:8px;padding:4px 7px";
      const kind = (st5.kinds || {})[r.name];
      const dot = document.createElement("i");
      dot.style.cssText = "flex:0 0 8px;height:8px;border-radius:50%;display:block;background:"
        + (kind === "char" ? "#ff5c7a" : (kind === "style" ? "#38bdf8" : "#a855f7"));
      const nm = document.createElement("span");
      nm.textContent = String(r.name).replace(/.safetensors$/i, "");
      nm.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      function mk(txt, val, color, on) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = txt;
        b.style.cssText = "flex:0 0 auto;height:20px;padding:0 7px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:10.5px;"
          + (on ? ("border:1px solid " + color + ";background:" + color + "33;color:#fff;font-weight:700")
                : "border:1px solid rgba(150,162,180,.4);background:rgba(255,255,255,.05);color:#cfd6e6");
        b.addEventListener("click", function () {
          const st6 = readState(node);
          st6.kinds = st6.kinds || {};
          if (st6.kinds[r.name] === val) delete st6.kinds[r.name]; else st6.kinds[r.name] = val;
          // ★ 214 批：标成「角色」时，如果它本来就是亮的，也要把别的角色关掉（角色互斥）
          const self6 = st6.loras.find(function (x) { return x && x.name === r.name; });
          const off6 = closeOtherChars(st6, self6);
          writeState(node, st6);
          paintKinds();
          render(node);
          if (off6.length) toast(node, "已到上限：自动关掉了 " + off6.join("、"));
        });
        return b;
      }
      row.appendChild(dot); row.appendChild(nm);
      row.appendChild(mk("角", "char", "#ff5c7a", kind === "char"));
      row.appendChild(mk("风", "style", "#38bdf8", kind === "style"));
      // ★ 215 批（他："Lora 池后面添加的 Lora 在调整参数的时候，居然还有小叉叉。我不是说小叉叉不需要有吗"）
      //   → 参数行不再有 ✕；**删除键收进这里**（只有手动加的才给：吃进来的是从画布拿走了节点，
      //     那种要走上面的「吐出来」回画布，不能在这儿一删了之）。
      if (r.src !== "node") {
        const dl = document.createElement("button");
        dl.type = "button"; dl.textContent = "✕";
        dl.title = "从池子里删掉这颗（只是从池子里去掉，不动画布）";
        dl.style.cssText = "flex:0 0 auto;height:20px;width:20px;border-radius:6px;cursor:pointer;font-family:inherit;"
          + "font-size:10.5px;border:1px solid rgba(255,120,140,.45);background:rgba(255,120,140,.12);color:#ffc2cd";
        dl.addEventListener("click", function () {
          const st7 = readState(node);
          const i7 = st7.loras.findIndex(function (x) { return x && x.name === r.name; });
          if (i7 < 0) return;
          st7.loras.splice(i7, 1);
          writeState(node, st7);
          paintKinds(); render(node);
          toast(node, "已从池子里删掉「" + String(r.name).replace(/\.safetensors$/i, "") + "」");
        });
        row.appendChild(dl);
      }
      kindList.appendChild(row);
    });
  }
  paintKinds();
  kindSec.appendChild(kindList);
  colR.appendChild(kindSec);
  colL.appendChild(sec);
  body.appendChild(grid);
  // ★ 316d（他："Lora 管理的限定高度为左半边的高度，让左边不要露出空白，也不要露出滑块，
  //   同时让高度最下面的关闭键始终能露出来"）
  //   → 弹窗三段式由 showMini 负责（关闭钉底）；这里再把**高度锁成左栏内容的高度**：
  //     右栏那一长串「角色 / 画风」在它自己里面滚，不把整窗撑高，左栏也就不会底下留白。
  grid.style.alignItems = "stretch";
  try {
    const lockH = () => {
      try {
        colR.style.display = "flex";
        colR.style.flexDirection = "column";
        colR.style.minHeight = "0";
        colR.style.overflow = "auto";
        kindList.style.maxHeight = "none";
        kindList.style.flex = "1 1 auto";
        kindList.style.minHeight = "0";
        kindList.style.overflow = "auto";
        grid.style.height = Math.max(120, colL.offsetHeight) + "px";
      } catch (e2) { /* 忽略 */ }
    };
    lockH();
    requestAnimationFrame(lockH);
    setTimeout(lockH, 80);
    setTimeout(lockH, 200);
  } catch (e) { /* 忽略 */ }
  showMini(node, "⚙ LoRA 管理", body);
}

// 一个极简的浮层（不走浏览器 alert/dialog，免得挡画布）
let miniEl = null;
function closeMini() { if (miniEl && miniEl.parentNode) miniEl.parentNode.removeChild(miniEl); miniEl = null; }
function showMini(node, title, body) {
  closeMini();
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:99999;left:50%;top:50%;transform:translate(-50%,-50%);"
    + "display:flex;flex-direction:column;"
    + "width:min(780px,94vw);max-height:90vh;background:#1d2230;color:#e8eaf1;border:1px solid rgba(150,162,180,.45);"
    + "border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);padding:14px 16px;"
    // ★ 229 批（他："Lora 管理设置一个下限，不然关闭很容易找不到"）
    //   → 给面板一个**最小尺寸**（太小时内容全被挤掉、看着像没了），并且锁在视口内。
    + "min-width:320px;min-height:260px;max-height:90vh;"
    + "font:12px/1.6 system-ui,'Microsoft YaHei',sans-serif";
  const head = document.createElement("div");
  head.textContent = title;
  head.style.cssText = "flex:0 0 auto;font-size:13px;font-weight:700;margin-bottom:8px";
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "关闭";
  close.style.cssText = "height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;"
    + "font-size:11.5px;border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.07);color:#e8eaf1";
  close.addEventListener("click", closeMini);
  // ★ 316d（他："让高度最下面的关闭键始终能露出来，像其他弹窗一样"）
  //   三段式：标题固定 / 中间这块自己滚 / 关闭键钉在窗底，永远露着。
  const mid = document.createElement("div");
  mid.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto";
  mid.appendChild(body);
  const foot = document.createElement("div");
  foot.style.cssText = "flex:0 0 auto;display:flex;justify-content:flex-end;padding-top:10px;margin-top:8px;"
    + "border-top:1px solid rgba(150,162,180,.22)";
  foot.appendChild(close);
  box.appendChild(head); box.appendChild(mid); box.appendChild(foot);
  document.body.appendChild(box);
  miniEl = box;
}

// ==================== ★ 183 批⑨：选 LoRA 的列表 ====================
//   他原话：「Lora 池现在点一个加一颗 Lora，原来是选不了加什么 Lora 的，只能从顺序开始加」
//   → 点「＋ 加一颗」或上面那两个装填框，都先弹这个列表（带搜索框，能滚），选中哪颗就加哪颗。
function pickLora(node, onPick) {
  const list = (node.__lpLoras && node.__lpLoras.length) ? node.__lpLoras : FALLBACK_LORAS;
  const used = readState(node).loras.map((r) => r.name);
  const body = document.createElement("div");
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "搜一下 LoRA 名字（" + list.length + " 颗可选）";
  inp.style.cssText = "width:100%;box-sizing:border-box;height:26px;margin-bottom:8px;border-radius:8px;"
    + "border:1px solid rgba(150,162,180,.5);background:rgba(0,0,0,.25);color:#e8eaf1;padding:0 8px;font:inherit";
  body.appendChild(inp);
  const box = document.createElement("div");
  box.style.cssText = "max-height:44vh;overflow:auto;display:flex;flex-direction:column;gap:4px";
  body.appendChild(box);
  function paint() {
    const q = String(inp.value || "").trim().toLowerCase();
    box.innerHTML = "";
    list.filter((n) => !q || String(n).toLowerCase().indexOf(q) >= 0).slice(0, 300).forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = n + (used.indexOf(n) >= 0 ? "（已在池子里）" : "");
      b.style.cssText = "text-align:left;height:24px;border-radius:6px;cursor:pointer;font-family:inherit;"
        + "font-size:11.5px;border:1px solid rgba(150,162,180,.3);background:rgba(255,255,255,.05);color:#e8eaf1;"
        + "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px";
      b.addEventListener("click", () => { closeMini(); onPick(n); });
      box.appendChild(b);
    });
    if (!box.children.length) {
      const d = document.createElement("div");
      d.textContent = "没搜到 —— 名字以 ComfyUI 的 models/loras 里那份为准";
      d.style.cssText = "opacity:.65;font-size:11.5px;padding:6px 2px";
      box.appendChild(d);
    }
  }
  inp.addEventListener("input", paint);
  paint();
  showMini(node, "选一颗 LoRA", body);
  setTimeout(() => { try { inp.focus(); } catch (e) { /* 忽略 */ } }, 30);
}

// ★ 222 批（他："修改好别名之后无法再次打开，而且别名并没有快速生效，一切都要等到刷新之后"）：
//   工具栏那边改完别名会抛 `pc-alias-changed` —— 这里收到就**重拉别名表 + 重画所有池子**，
//   而不用等用户刷新页面。同时把"胶囊显示名字"这条链彻底走通（池子 = 第二个显示别名的地方）。
try {
  window.addEventListener("pc-alias-changed", function () {
    var p = fetchAliases();
    if (p && typeof p.then === "function") {
      p.then(function () {
        try {
          ((app && app.graph && app.graph._nodes) || []).forEach(function (n) {
            if (n && n.type === "PromptToolLoraPool") { try { render(n); } catch (e2) { /* 忽略 */ } }
          });
        } catch (e) { /* 忽略 */ }
      });
    }
  });
} catch (e) { /* 忽略 */ }

// ★ 267 批（他："点击按名单补全时，还要刷新一下才会还原"）：
//   池子里的界面只在自己那条路（writeState → render）上重画；**外面**也有东西会直接改 `状态` ——
//   🔁 按名单补全（prompt_wand.js）、🔮 安全复现（prompt_gallery.js）—— 它们只能抛
//   `pc-lorapool-changed`，而池子自己不监听，于是数据改了但界面不动，看着就像"要刷新才生效"。
//   → 这里收下事件就把池子重画一遍。`setTimeout 0` + 60ms 去重：池子自己写完之后紧跟着的
//   render 已经画过了，别白画第二遍。
try {
  window.addEventListener("pc-lorapool-changed", function (ev) {
    var one = ev && ev.detail && ev.detail.node;
    setTimeout(function () {
      var list = one ? [one] : (((app && app.graph && app.graph._nodes) || []).filter(function (n) {
        return n && n.type === "PromptToolLoraPool";
      }));
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      list.forEach(function (n) {
        if (!n || n.type !== "PromptToolLoraPool") return;
        if (n.__lpRenderAt && (now - n.__lpRenderAt) < 60) return;
        try { render(n); } catch (e) { /* 忽略 */ }
      });
    }, 0);
  });
} catch (e) { /* 忽略 */ }

// ==================== ★ 224 批：LoRA 组合随机 ====================
//   他："在 lora 组合设置存档里面设置，打开开关时每次上图都会在已有存档中随机选择一个，
//        Lora 需要触发词会自动填入" + "在设置中调整，是点生图才算还是套图也算"
//   做法：钩住 `app.queuePrompt`。每次排队前，把所有「开了随机」的池子按存档里的组合重设一遍
//        （LoRA + 开关 + 两种强度 + 触发词）；时机 = queue（一次排队抽一次）/ each（每张图抽一次，
//        batchCount>1 时拆成多张分别排队）。
(function bindRandomCombo() {
  const LS_KEY = "promptCopier.loraPoolSaves.v1";
  function saves() {
    try { const a = JSON.parse(localStorage.getItem(LS_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function pools() {
    return ((app && app.graph && app.graph._nodes) || []).filter((n) => n && n.type === "PromptToolLoraPool");
  }
  // ★ 227 批（他："如果没有选择固定位，那么这个时候随机抽取组合就会在红色中选一个，加上蓝色中选一个，
  //   这样子红色 3 加蓝色 3 就是 9 种选择，但是要是固定了一个红色或者蓝色，那就是 3 种，
  //   固定位可以同时添加多个，所以也可以是红色 2 加蓝色 3，6 种" +
  //   "同时上线排斥位，红蓝各填一处存档，保证这样的搭配不会在随机中出现"）
  function kindOfSave(it, kinds) {
    if (it && (it.kind === "char" || it.kind === "style")) return it.kind;
    // 老存档没有 kind：按它里面的 LoRA 有没有被标成"角色"来推断
    const anyChar = ((it && it.loras) || []).some((x) => (kinds || {})[x.name] === "char");
    return anyChar ? "char" : "style";
  }
  // 算出当前能随机到的所有 (红, 蓝) 组合 —— 探针直接用它验证 3×3=9 / 固定后=3 / 红2蓝3=6
  function validPairs(node) {
    const st = readState(node);
    const all = saves();
    const kinds = st.kinds || {};
    let chars = all.filter((it) => kindOfSave(it, kinds) === "char");
    let styles = all.filter((it) => kindOfSave(it, kinds) === "style");
    const pin = st.lpRandPin || { char: [], style: [] };
    if ((pin.char || []).length) chars = chars.filter((it) => pin.char.indexOf(it.name) >= 0);
    if ((pin.style || []).length) styles = styles.filter((it) => pin.style.indexOf(it.name) >= 0);
    const ban = st.lpRandBan || [];
    const out = [];
    chars.forEach((c) => styles.forEach((sv) => {
      const banned = ban.some((b) => b && b.char === c.name && b.style === sv.name);
      if (!banned) out.push({ char: c, style: sv });
    }));
    return out;
  }
  function applyOne(node) {
    try {
      const st = readState(node);
      if (!st.lpRand) return false;
      const pairs = validPairs(node);
      if (!pairs.length) { log("随机组合：没有可用组合（存档不全 / 固定位或排斥位把它砍光了）"); return false; }
      const p = pairs[Math.floor(Math.random() * pairs.length)];
      const c = p.char, sv = p.style;
      // ★ 273 批（他 272 批第 9 条："Lora 池触发随机组合的时候，暗掉的 lora 会自己消失"）
      //   又是"整份替换"。规矩同 267 批请神那次：**抽到的排前面并点亮，池子里原有的留着、只是熄灭**，绝不删。
      const picked = (c.loras || []).concat(sv.loras || []).map((x) => ({
        name: x.name, on: true, model: x.model, clip: x.clip, src: x.src || "rand" }));
      const keep = {};
      picked.forEach((x) => { keep[x.name] = 1; });
      const rest = (Array.isArray(st.loras) ? st.loras : []).filter((x) => x && !keep[x.name])
        .map((x) => ({ name: x.name, on: false, model: x.model, clip: x.clip, src: x.src }));
      st.loras = picked.concat(rest);
      st.trig = Object.assign({}, st.trig || {}, c.trig || {}, sv.trig || {});
      writeState(node, st);
      render(node);
      return (c.name || "?") + " + " + (sv.name || "?");
    } catch (e) { log("随机组合失败", e); return false; }
  }
  let hooked = false;
  function hook() {
    if (hooked) return;
    if (!window.app || typeof window.app.queuePrompt !== "function") return;
    hooked = true;
    const orig = window.app.queuePrompt.bind(window.app);
    window.app.queuePrompt = function (number, batchCount) {
      try {
        const ns = pools().filter((n) => readState(n).lpRand);
        if (ns.length && saves().length) {
          const each = ns.some((n) => readState(n).lpRandMode === "each");
          ns.forEach((n) => applyOne(n));
          const bc = Number(batchCount) || 1;
          if (each && bc > 1) {
            // 每张都换：拆成 bc 次单张排队，中间再抽
            for (let i = 0; i < bc; i++) {
              if (i > 0) ns.forEach((n) => applyOne(n));
              orig(number, 1);
            }
            return;
          }
        }
      } catch (e) { log("随机组合钩子出错（继续正常排队）", e); }
      return orig(number, batchCount);
    };
    log("随机组合钩子已挂上");
  }
  setTimeout(hook, 1200);
  setTimeout(hook, 4000);
  // 测试口
  try {
    window.__pcLoraPool = window.__pcLoraPool || {};
    window.__pcLoraPool.saves = saves;
    window.__pcLoraPool.randomPick = (node) => applyOne(node);
    window.__pcLoraPool.validPairs = (node) => validPairs(node).map((p) => p.char.name + " + " + p.style.name);
    window.__pcLoraPool.randHooked = () => hooked;
    window.__pcLoraPool.randSwitchRefresh = (node) => { try { if (node.__lpRandSwitch) node.__lpRandSwitch(); return true; } catch (e) { return false; } };
  } catch (e) { /* 忽略 */ }
})();
