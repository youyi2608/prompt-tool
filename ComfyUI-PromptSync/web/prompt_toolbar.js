// 游动羽翼工具栏（节点 PromptToolToolbar）+ 「模型别名」
//
// 两件事：
//   ① 工具栏节点上两颗按钮：把我们自己的节点一键加到画布；打开「模型别名」面板。
//   ② 模型别名：LoRA / Checkpoint / VAE / UNet / CLIP / ControlNet 这些下拉里的文件名，
//      可以给它们记一个「别名」—— 画布上显示别名（灰底）、下拉列表里也显示别名（选到的仍是真文件），
//      鼠标悬停看得到真名。**文件一个都不改**，所以工作流 / API 图 / 分享出去的东西全都不受影响。
//
// 怎么改（不搞「把几千个文件列成一个下拉」那一套）：
//   · 点面板上的「✎ 点一下画布改名」→ 画布上所有模型下拉亮起来 → 点你要改的那个 → 填别名 → 保存；
//   · 或者在面板里「画布上的模型栏位」那一段直接改（那是你当前真的在用的几个，不会成百上千）；
//   · 下拉本身：右键？不用 —— 只要在别名模式下点它就会弹改名框；不在别名模式时照旧弹原来的文件列表。
//
// 落地用的都是 ComfyUI 自己的机制（已核对 comfyui_frontend 1.45.21 的源码）：
//   · 显示 = ComboWidget 原生支持的 options.getOptionLabel（画布上的文字 + 下拉列表都走它，
//     value 不动 → 工作流里存的还是真文件名）；
//   · 灰底 = 覆盖这个控件实例的 background_color（BaseWidget.drawWidgetShape 用它填色）；
//   · 点选改名 = 换掉这个控件实例的 onClick（LGraphCanvas.processWidgetClick 就是调它）。
// 拿不到这些结构时只往控制台说一声，绝不改 ComfyUI 自己的东西。
//
// ★ 2026-10-12（客户报障后定的口径）**惰性挂载：没用到别名的地方，一个字节都不碰。**
//   · 显示层（getOptionLabel + 灰底）只在这个"种类"真的有别名时才挂；
//   · 交互层（黄框 + 接点击改名）**只在别名模式里**才挂，退出即原样摘掉 —— 平时连控件的 onClick 都不碰，
//     "点不中模型下拉"这条路从根上没有了（细节见 patchWidget 上面那段注释）。
import { app } from "../../scripts/app.js";

const ALIAS_API = "/prompt_sync/aliases";
const TOOLBAR_NODE = "PromptToolToolbar";
const TOOLBAR_COMBO = "要添加的节点";
const ALIAS_BG = "rgba(255, 255, 255, 0.13)";      // 别名那行的灰底（深浅主题下都看得清）
const ALIAS_MODE_OUTLINE = "rgba(255, 196, 92, 0.95)";

function log(...args) { console.log("[游动羽翼工具栏]", ...args); }

// 打开工具那条地址上的版本号（见 attachToolbarButtons 里那颗按钮）：setup 时问一次 ping，拿到就缓在这儿。
// 2026-10-10 第一百四十批加：他报"工具栏打开的是 6.0"，他这台是新的 → 对方多半是**浏览器缓存了旧页面**，
// 所以打开的地址带上版本号，以后每换一版都算新地址，旧缓存再也顶不上来。
let CACHED_NODE_VER = "";
async function refreshNodeVer() {
  try {
    const r = await fetch(new URL("/prompt_sync/ping", location.href).href, { cache: "no-store" });
    const j = await r.json();
    if (j && j.version) CACHED_NODE_VER = String(j.version);
  } catch (e) { /* 拿不到就算了，按钮那边用时间戳兜底 */ }
}

// 面板里的文件名 / 别名是用户自己的东西（可能带引号或尖括号），进 innerHTML 前先转义
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------- 通用小工具（照 prompt_sync.js 那套）
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

function redraw() {
  try { app.graph && app.graph.setDirtyCanvas && app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
  try { app.canvas && app.canvas.setDirty && app.canvas.setDirty(true, true); } catch (e) { /* 忽略 */ }
}

function graphNodes() {
  return ((app && app.graph && app.graph._nodes) || []).filter(Boolean);
}

// ---------------------------------------------------------------- 模型下拉怎么认
// widget 名 → 别名表里的「种类」（种类只是给人看/手改 JSON 好认的分组前缀）
const KIND_BY_WIDGET = {
  ckpt_name: "checkpoints",
  checkpoint_name: "checkpoints",
  lora_name: "loras",
  lora_name_or_path: "loras",
  vae_name: "vae",
  unet_name: "diffusion_models",
  model_name: "diffusion_models",
  clip_name: "text_encoders",
  clip_name1: "text_encoders",
  clip_name2: "text_encoders",
  clip_name3: "text_encoders",
  clip_vision_name: "clip_vision",
  control_net_name: "controlnet",
  style_model_name: "style_models",
  gligen_name: "gligen",
  upscale_model_name: "upscale_models",
  ipadapter_file: "ipadapter",
  instantid_file: "instantid",
  puLID_file: "pulid",
  pose_file: "pose",
};

const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|pkl|sft)$/i;

function kindOf(widgetName) {
  const name = String(widgetName || "");
  if (KIND_BY_WIDGET[name]) return KIND_BY_WIDGET[name];
  const base = name.replace(/[_\s]*\d+$/, "");       // clay_name1 / clip_name2 …
  if (KIND_BY_WIDGET[base]) return KIND_BY_WIDGET[base];
  return name || "其他";
}

function valueList(widget) {
  const vals = widget && widget.options && widget.options.values;
  return Array.isArray(vals) ? vals : null;
}

// 是不是「模型文件下拉」：先认 widget 名，再兜底看选项是不是都长着模型文件的样子
function isModelCombo(widget) {
  if (!widget || widget.type !== "combo") return false;
  const vals = valueList(widget);
  if (!vals || !vals.length) return false;
  if (KIND_BY_WIDGET[String(widget.name)] || KIND_BY_WIDGET[String(widget.name).replace(/[_\s]*\d+$/, "")]) return true;
  return vals.slice(0, 12).some((v) => typeof v === "string" && MODEL_EXT.test(v));
}

function keyOf(widget) {
  return kindOf(widget.name) + "/" + String(widget.value == null ? "" : widget.value);
}

// ---------------------------------------------------------------- 别名表（内存里的那一刻 + 后端 JSON）
let ALIASES = {};
// ★ 2026-10-07（第一百一十四批 · 待办 ⑮）「别名让其他用户也能看到」→ **本地优先**：
//   存工作流时，把"画布里正在用的那几个模型"的别名写进 `graph.extra.pc_aliases`；
//   别人拿到这份工作流、本机又没给这些模型起过别名时，就**用工作流里带的那个**（他看得到你起的名字）。
//   ⚠️ 本机 `model_aliases.json` 里有的，**永远压过工作流里的**（"本地优先"）。
let GRAPH_ALIASES = {};
let backendOk = false;
let backendMsg = "";

function aliasOf(widget) {
  const k = keyOf(widget);
  const a = ALIASES[k];
  if (a) return String(a);
  const w = GRAPH_ALIASES[k];
  return w ? String(w) : "";
}

// 画布里现在用到的模型 → {键: 别名}（只取本机真起过名字的那些，别把整张表塞进工作流）
function graphAliasMap() {
  const out = {};
  try {
    graphNodes().forEach((n) => {
      (n && n.widgets ? n.widgets : []).forEach((w) => {
        if (!w || !isModelCombo(w)) return;
        const k = keyOf(w);
        if (ALIASES[k]) out[k] = String(ALIASES[k]);
      });
    });
  } catch (e) { /* 忽略 */ }
  return out;
}

function readGraphAliases() {                      // 读工作流里带过来的那一份（当兜底用）
  try {
    const ex = app && app.graph && app.graph.extra && app.graph.extra.pc_aliases;
    let map = {};
    if (ex && typeof ex === "object") map = (ex.map && typeof ex.map === "object") ? ex.map : ex;
    GRAPH_ALIASES = {};
    Object.keys(map || {}).forEach((k) => {
      const v = map[k];
      if (typeof v === "string" && v.trim()) GRAPH_ALIASES[k] = v.trim();
    });
  } catch (e) { GRAPH_ALIASES = {}; }
  return GRAPH_ALIASES;
}

// 存工作流那一下：把当前的别名塞进 extra（前端每次存盘都会走 graph.serialize）
function ensureAliasSerializeWrap() {
  try {
    const g = app && app.graph;
    if (!g || typeof g.serialize !== "function" || g.__pcAliasWrap) return false;
    const orig = g.serialize;
    g.serialize = function () {
      const s = orig.apply(this, arguments);
      try {
        const map = graphAliasMap();
        if (Object.keys(map).length && s && typeof s === "object") {
          s.extra = s.extra || {};
          s.extra.pc_aliases = { version: 1, at: Date.now(), map: map };
        }
      } catch (e) { /* 忽略 */ }
      return s;
    };
    g.__pcAliasWrap = true;
    return true;
  } catch (e) { return false; }
}

async function fetchAliases() {
  try {
    const r = await fetch(ALIAS_API, { cache: "no-store" });
    const j = await r.json();
    if (j && j.success && j.aliases) {
      ALIASES = j.aliases;
      backendOk = true;
      backendMsg = "";
    } else {
      backendOk = false;
      backendMsg = (j && j.error) || "后端没答话";
    }
  } catch (e) {
    backendOk = false;
    backendMsg = "连不上节点后端（节点可能是旧版 —— 重启一次 ComfyUI 就好）";
  }
  // ★ 2026-10-12：别名表更新了 → 补挂一次（惰性挂载：拉到别名之前这些控件一个都没被碰过）
  try { patchAllNodes(); } catch (e) { /* 忽略 */ }
  redraw();
  return ALIASES;
}

async function postAlias(body) {
  const r = await fetch(ALIAS_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!j || !j.success) throw new Error((j && j.error) || ("HTTP " + r.status));
  ALIASES = j.aliases || {};
  backendOk = true;
  backendMsg = "";
  // ★ 2026-10-12：刚起了个别名 → 立刻把这一种类的下拉挂上（不然要等下次载入工作流才显示）
  // ★ 221 批：这一步会遍历整张图的所有控件，放到下一个 tick 做 —— 否则"保存"那一下会卡住界面。
  setTimeout(() => {
    try { patchAllNodes(); } catch (e) { /* 忽略 */ }
    try { redraw(); } catch (e2) { /* 忽略 */ }
    // ★ 222 批：落盘成功**再抛一次**事件 —— 池子第一次收到时后端还没写完，会画成旧名字
    try { window.dispatchEvent(new CustomEvent("pc-alias-changed", { detail: { key: body && body.key } })); } catch (e3) { /* 忽略 */ }
  }, 0);
  return j;
}

// ---------------------------------------------------------------- 把别名接到某个模型下拉上
function findGetter(obj, name) {
  let p = obj;
  while (p) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d && typeof d.get === "function") return d.get;
    p = Object.getPrototypeOf(p);
  }
  return null;
}

// ★★ 2026-10-12（客户报障后定的口径）：**惰性挂载 —— 没用到别名的地方，一个字节都不碰。**
//   起因：客户（秋叶整合包 / 网页版）报「模型下拉点不中、只能靠 ◀▶ 跳，悬停模型名的预览图也没了」，
//   对方做的隔离测试 = 删掉这个文件就恢复。病根不是别名本身，而是我们**无条件**给所有模型下拉
//   包了四层（改名 / 灰底 / 黄框 / 接点击）—— 任何也挂在这个控件上的插件都会被牵连。
//   现在的闸门：
//     · 显示层（getOptionLabel + 灰底）：只在这个**种类**真的有别名时才挂（本机表 ∪ 工作流带来的表）；
//     · 交互层（drawWidget 黄框 + onClick 改名）：**只在别名模式里**才挂，**退出就原样摘掉** ——
//       平时连点击都不碰，"点不中模型"这条路从根上没有了。
//   判据：没命中任何别名时**连 `__pcAliasPatched` 都不打**（以后有了别名还能补挂）。
function kindHasAlias(kind) {
  const p = String(kind || "") + "/";
  for (const k in ALIASES) if (k.indexOf(p) === 0) return true;
  for (const k in GRAPH_ALIASES) if (k.indexOf(p) === 0) return true;
  return false;
}

function patchWidget(widget) {
  if (!widget || !isModelCombo(widget)) return false;
  const show = kindHasAlias(kindOf(widget.name));   // 这个种类有别名吗（有才需要改显示）
  const edit = !!aliasMode;                         // 正在"点一下画布改名"吗（要才需要接点击 / 画黄框）
  if (!show && !edit) return false;                 // ← 没用到 = 什么都不动（连标记都不打）
  let did = false;

  if (show && !widget.__pcAliasPatched) {
    widget.__pcAliasPatched = true;
    did = true;

    // ① 显示别名：ComboWidget 原生支持 getOptionLabel —— 画布上的文字和下拉列表都走它，value 纹丝不动
    try {
      widget.options = widget.options || {};
      const prev = widget.options.getOptionLabel;
      widget.options.getOptionLabel = function (v) {
        if (v) {
          // ★ ⑮（第一百一十四批）：本机 JSON 里的别名优先，工作流里带过来的那个当兜底
          const k = kindOf(widget.name) + "/" + String(v);
          const a = ALIASES[k] || GRAPH_ALIASES[k];
          if (a) return String(a);
        }
        if (typeof prev === "function") {
          try {
            const r = prev(v);
            if (r != null) return String(r);
          } catch (e) { /* 忽略 */ }
        }
        return v == null ? "" : String(v);
      };
    } catch (e) {
      log("挂 getOptionLabel 失败（画布上可能只显示真名）", e);
    }

    // ② 灰底：别名那一行给个灰底，一眼看出「这不是真文件名」
    try {
      const protoBg = findGetter(widget, "background_color");
      if (protoBg) {
        Object.defineProperty(widget, "background_color", {
          configurable: true,
          get() { return aliasOf(widget) ? ALIAS_BG : protoBg.call(this); },
        });
      }
    } catch (e) { /* 忽略：灰底只是锦上添花 */ }
  }

  if (edit && !widget.__pcAliasEdit) {
    widget.__pcAliasEdit = true;
    did = true;

    // ③ 别名模式：亮边提示「这个能改」；平时什么都不画
    try {
      const origDraw = widget.drawWidget;
      if (typeof origDraw === "function") {
        // ★ 记下原件 + "它本来是不是控件自己的" —— 退出别名模式时要**原样摘下来**（见 uneditWidget）
        widget.__pcAliasOrigDraw = origDraw;
        widget.__pcAliasHadOwnDraw = Object.prototype.hasOwnProperty.call(widget, "drawWidget");
        widget.drawWidget = function (ctx, opts) {
          const r = origDraw.call(this, ctx, opts);
          if (aliasMode) {
            try {
              ctx.save();
              ctx.setLineDash([5, 3]);
              ctx.lineWidth = 2;
              ctx.strokeStyle = ALIAS_MODE_OUTLINE;
              ctx.strokeRect(15, this.y, (opts && opts.width ? opts.width : 200) - 30, this.height);
              ctx.restore();
            } catch (e) { /* 忽略 */ }
          }
          return r;
        };
      }
    } catch (e) { /* 忽略 */ }

    // ④ 点选改名：别名模式下点它就是「我要改这个」，其余时候照旧弹原来的文件列表
    try {
      const origClick = widget.onClick;
      if (typeof origClick === "function") {
        widget.__pcAliasOrigClick = origClick;
        widget.__pcAliasHadOwnClick = Object.prototype.hasOwnProperty.call(widget, "onClick");
        widget.onClick = function (opts) {
          if (aliasMode) {
            setAliasMode(false);
            openAliasDialog(this, (opts && opts.node) || null);
            return;
          }
          return origClick.call(this, opts);
        };
      }
    } catch (e) { /* 忽略 */ }
  }

  return did;
}

// ★ 2026-10-12：退出别名模式 → 把「黄框 + 接点击」这两层**原样摘下来**。
//   为什么要摘：这两层是唯一"会改变控件行为"的东西 —— 留着就等于我们一直插在别人的点击链上。
//   摘法：本来就有自己的 onClick/drawWidget 就还回去，本来没有的就把我们加的那个自有属性 delete 掉
//   （delete 之后又回到原型上的真实现，等价于没碰过）。
function uneditWidget(widget) {
  if (!widget || !widget.__pcAliasEdit) return false;
  try {
    if (widget.__pcAliasOrigClick !== undefined) {
      if (widget.__pcAliasHadOwnClick) widget.onClick = widget.__pcAliasOrigClick;
      else { try { delete widget.onClick; } catch (e2) { widget.onClick = widget.__pcAliasOrigClick; } }
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (widget.__pcAliasOrigDraw !== undefined) {
      if (widget.__pcAliasHadOwnDraw) widget.drawWidget = widget.__pcAliasOrigDraw;
      else { try { delete widget.drawWidget; } catch (e2) { widget.drawWidget = widget.__pcAliasOrigDraw; } }
    }
  } catch (e) { /* 忽略 */ }
  try { delete widget.__pcAliasOrigClick; delete widget.__pcAliasOrigDraw; } catch (e) { /* 忽略 */ }
  try { delete widget.__pcAliasEdit; } catch (e) { widget.__pcAliasEdit = false; }
  return true;
}

function uneditAllNodes() {
  let n = 0;
  try {
    for (const node of graphNodes()) for (const w of ((node && node.widgets) || [])) if (uneditWidget(w)) n++;
  } catch (e) { /* 忽略 */ }
  return n;
}

function patchNode(node) {
  if (!node || !Array.isArray(node.widgets)) return 0;
  let n = 0;
  for (const w of node.widgets) {
    if (patchWidget(w)) n++;
    // ★ 229 批：模型下拉挂"悬停看预览图"（原版 LoraLoader / CheckpointLoader 都吃这一套）
    try { hookWidgetPreview(node, w); } catch (e) { /* 忽略 */ }
  }
  return n;
}

function patchAllNodes() {
  let n = 0;
  for (const node of graphNodes()) n += patchNode(node);
  return n;
}

// 新控件也照单全收：接在「节点加控件」那个函数上（比一个个节点去补更稳）
function hookAddCustomWidget() {
  try {
    if (window.LiteGraph && window.LiteGraph.vueNodesMode) {
      if (!hookAddCustomWidget._warned) {
        hookAddCustomWidget._warned = true;
        log("当前是「Vue 节点」渲染模式 —— 别名只在经典画布模式下显示，设置里关掉 Vue 节点即可");
      }
      return false;
    }
    const LNode = window.LGraphNode || (window.LiteGraph && window.LiteGraph.LGraphNode);
    const proto = LNode && LNode.prototype;
    if (!proto || proto.__pcAliasHooked || typeof proto.addCustomWidget !== "function") return false;
    const orig = proto.addCustomWidget;
    proto.addCustomWidget = function (w) {
      const r = orig.apply(this, arguments);
      try { patchWidget(r); } catch (e) { /* 忽略 */ }
      return r;
    };
    proto.__pcAliasHooked = true;
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- DOM 小工具
let styleDone = false;
function injectStyle() {
  if (styleDone) return;
  styleDone = true;
  const s = document.createElement("style");
  s.textContent = `
  .pcw-box{position:fixed;z-index:10060;background:#22272e;color:#e6e6e6;border:1px solid #3d444d;
    border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.55);font:13px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif}
  .pcw-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #3d444d;cursor:move;user-select:none}
  .pcw-head b{flex:1 1 auto;font-weight:600;font-size:13.5px}
  .pcw-x{cursor:pointer;border:0;background:transparent;color:#9aa4b2;font-size:15px;line-height:1;padding:2px 6px;border-radius:6px}
  .pcw-x:hover{background:#333b45;color:#fff}
  /* ★ 226 批：面板改两栏（他嫌太高） */
  /* ★ 228 批（他："左右的上下分界线都做得更明显一些，不要融在一起"） */
  .pcw-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 18px;align-items:start}
  .pcw-col + .pcw-col{border-left:1px solid #4a5460;padding-left:16px}
  .pcw-sec{margin:10px 0 6px;padding-bottom:5px;border-bottom:2px solid #4a5460}
  .pcw-sec:first-child{margin-top:0}
  .pcw-col{display:flex;flex-direction:column;gap:6px;min-width:0}
  /* 两栏之后每一列自己滚，别把整个面板撑高 */
  .pcw-list{max-height:30vh;overflow:auto}
  .pcw-box{max-height:88vh;overflow:hidden}
  .pcw-body{max-height:calc(88vh - 44px);overflow:auto}
  .pcw-body{padding:12px}
  .pcw-btn{cursor:pointer;border:1px solid #4a5568;background:#2b323b;color:#e6e6e6;border-radius:7px;padding:5px 11px;font:12.5px system-ui,"Microsoft YaHei"}
  .pcw-btn:hover{background:#374050;border-color:#5c6b80}
  .pcw-btn.primary{background:#2f6fd0;border-color:#3d7fe0}
  .pcw-btn.primary:hover{background:#3b7fe0}
  .pcw-btn.danger{color:#ffb4b4;border-color:#6b3a3a}
  .pcw-muted{color:#9aa4b2;font-size:12px}
  .pcw-file{word-break:break-all;background:#1a1e24;border:1px solid #333b45;border-radius:7px;padding:6px 8px;
    color:#cfd8e3;font:12px ui-monospace,Consolas,monospace;user-select:text;max-height:96px;overflow:auto}
  .pcw-input{width:100%;box-sizing:border-box;background:#1a1e24;border:1px solid #3d444d;border-radius:7px;
    color:#fff;padding:6px 8px;font:13px system-ui,"Microsoft YaHei";margin-top:4px}
  .pcw-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .pcw-alias-chip{background:${ALIAS_BG};border-radius:6px;padding:1px 7px;color:#fff}
  /* ★ 228 批（他："左右的上下分界线都做得更明显一些，不要融在一起"） */
  .pcw-sec{margin:10px 0 6px;font-weight:600;font-size:12.5px;color:#cdd6e1;border-bottom:2px solid #4a5460;padding-bottom:5px}
  .pcw-list{max-height:296px;overflow:auto;margin-bottom:10px}
  .pcw-item{display:flex;gap:8px;align-items:center;padding:5px 4px;border-bottom:1px solid #2c333c}
  .pcw-item:last-child{border-bottom:0}
  .pcw-item .nm{flex:0 0 auto;color:#9aa4b2;font-size:12px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pcw-item .val{flex:1 1 auto;min-width:0;color:#dfe6ee;font:12px ui-monospace,Consolas,monospace;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pcw-banner{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:10070;padding:8px 14px;
    background:#3a2f13;border:1px solid #8a6d21;border-radius:999px;color:#ffe3a3;font:13px system-ui,"Microsoft YaHei";
    box-shadow:0 6px 20px rgba(0,0,0,.5);display:flex;align-items:center;gap:10px}
  .pcw-tip{position:fixed;z-index:10080;pointer-events:none;background:#141821;border:1px solid #3d444d;color:#dfe6ee;
    border-radius:6px;padding:3px 8px;font:12px ui-monospace,Consolas,monospace;box-shadow:0 4px 16px rgba(0,0,0,.5);display:none}
  `;
  document.head.appendChild(s);
}

function makeBox(title, width) {
  injectStyle();
  const el = document.createElement("div");
  el.className = "pcw-box";
  el.style.width = width + "px";
  el.style.left = Math.max(10, Math.round((window.innerWidth - width) / 2)) + "px";
  el.style.top = "96px";
  el.innerHTML = `<div class="pcw-head" data-drag="1"><b></b><button class="pcw-x" title="关掉">✕</button></div><div class="pcw-body"></div>`;
  el.querySelector("b").textContent = title;
  el.querySelector(".pcw-x").addEventListener("click", () => el.remove());
  // 标题栏拖动（项目里的老规矩：凡是浮层都能拖）
  const head = el.querySelector(".pcw-head");
  head.addEventListener("pointerdown", (ev) => {
    if (ev.target && ev.target.classList && ev.target.classList.contains("pcw-x")) return;
    const sx = ev.clientX, sy = ev.clientY;
    const ox = el.offsetLeft, oy = el.offsetTop;
    const move = (e2) => {
      el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + e2.clientX - sx)) + "px";
      el.style.top = Math.max(0, Math.min(window.innerHeight - 30, oy + e2.clientY - sy)) + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------- 改名弹窗（点选式）
let dlgEl = null;
let dlgWidget = null;

function openAliasDialog(widget, node) {
  if (!widget) return;
  if (dlgEl) dlgEl.remove();
  dlgWidget = widget;
  const real = String(widget.value == null ? "" : widget.value);
  const cur = aliasOf(widget);
  const owner = (node && (node.title || node.type)) || "画布上的节点";

  dlgEl = makeBox("改别名", 430);
  dlgEl.querySelector(".pcw-body").innerHTML = `
    <div class="pcw-muted">${esc(owner)} · ${esc(kindOf(widget.name))} / ${esc(widget.name)}</div>
    <div class="pcw-sec">真文件名（这个不会被动）</div>
    <div class="pcw-file" data-real="1"></div>
    <div class="pcw-sec" style="margin-top:10px">别名（画布和下拉里显示它）</div>
    <input class="pcw-input" data-alias="1" placeholder="给它起个你认得出的名字，例如：游动羽翼 画风" />
    <div class="pcw-muted" style="margin-top:6px">只改显示。工作流、API 图里存的、ComfyUI 真正加载的，都还是上面那个真文件名。</div>
    <div class="pcw-row" style="margin-top:12px;justify-content:flex-end">
      <button class="pcw-btn" data-clear="1">清除别名</button>
      <button class="pcw-btn" data-cancel="1">取消</button>
      <button class="pcw-btn primary" data-save="1">保存</button>
    </div>`;
  dlgEl.querySelector("[data-real]").textContent = real;
  const input = dlgEl.querySelector("[data-alias]");
  input.value = cur;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveAliasDialog(); }
    if (e.key === "Escape") { e.preventDefault(); closeAliasDialog(); }
  });
  dlgEl.querySelector("[data-save]").addEventListener("click", () => saveAliasDialog());
  dlgEl.querySelector("[data-cancel]").addEventListener("click", () => closeAliasDialog());
  dlgEl.querySelector("[data-clear]").addEventListener("click", () => saveAliasDialog(""));
  try { attachPreviewPicker(dlgEl, keyOf(dlgWidget)); } catch (e0) { /* 忽略 */ }
  setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* 忽略 */ } }, 30);
}

function closeAliasDialog() {
  if (dlgEl) dlgEl.remove();
  dlgEl = null;
  dlgWidget = null;
}

async function saveAliasDialog(forceText) {
  if (!dlgWidget) return;
  const input = dlgEl && dlgEl.querySelector("[data-alias]");
  const text = forceText !== undefined ? forceText : (input ? input.value : "");
  const key = keyOf(dlgWidget);
  const old = ALIASES[key];
  // ★ 221 批（他："改好 Lora 模型别名的时候，居然会卡一下……别名也没有成功被改，点刷新才能成功"）：
  //   以前是"等后端写完 + 全图重挂"再关窗 → 后端慢的那一下整页看着像卡死，失败也没人告诉你。
  //   现在：**先本地生效、立刻关窗**，落盘放后台；失败才回滚 + 红字提示。
  applyAliasLocal(key, text);
  closeAliasDialog();
  if (panelEl) { try { renderPanelBody(); } catch (e) { /* 忽略 */ } }
  try {
    await postAlias({ key: key, alias: text });
    log(text ? `别名已保存：${key} → ${text}` : `别名已清除：${key}`);
  } catch (e) {
    applyAliasLocal(key, old || "");
    toastBox("别名没存上（" + e.message + "）—— 已撤回，再试一次或点面板里的「🔄 刷新」");
    if (panelEl) { try { renderPanelBody(); } catch (e2) { /* 忽略 */ } }
  }
}

// 本地先改（不碰网络）：写内存表 + 立即重挂 + 重画
function applyAliasLocal(key, text) {
  try {
    ALIASES = Object.assign({}, ALIASES, {});
    const v = String(text == null ? "" : text).trim();
    if (v) ALIASES[key] = v; else delete ALIASES[key];
    patchAllNodes();
    redraw();
  } catch (e) { log("本地改别名失败", e); }
  // ★ 222 批（他："别名并没有快速生效，一切都要等到刷新之后才能恢复正常"）：
  //   `patchAllNodes()` 只挂**节点上的下拉**；LoRA 池的胶囊用的是它自己那份 `LP_ALIASES` →
  //   以前必须刷新页面才看得到新名字。这里发一个事件，池子收到就重拉别名表并重画。
  try { window.dispatchEvent(new CustomEvent("pc-alias-changed", { detail: { key: key, alias: text } })); } catch (e2) { /* 忽略 */ }
}
// 一条轻提示（没有全局 toast 时用它，别让失败静默）
function toastBox(msg) {
  try {
    const d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText = "position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:99999;"
      + "max-width:min(520px,88vw);padding:10px 16px;border-radius:10px;font-size:12.5px;line-height:1.5;"
      + "background:rgba(120,26,40,.96);color:#ffe3e8;border:1px solid rgba(255,120,140,.55);"
      + "box-shadow:0 10px 30px rgba(0,0,0,.45)";
    document.body.appendChild(d);
    setTimeout(() => { try { d.remove(); } catch (e) { /* 忽略 */ } }, 4200);
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 别名模式（点一下画布上的下拉就改名）
let aliasMode = false;
let bannerEl = null;

function setAliasMode(on) {
  aliasMode = !!on;
  injectStyle();
  if (aliasMode) {
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.className = "pcw-banner";
      bannerEl.innerHTML = `<span>✎ 别名模式：点一下画布上要改名的那个下拉（黄框的就是能改的）</span>
        <button class="pcw-btn" data-exit="1">退出</button>`;
      bannerEl.querySelector("[data-exit]").addEventListener("click", () => setAliasMode(false));
      document.body.appendChild(bannerEl);
    }
    bannerEl.style.display = "flex";
  } else if (bannerEl) {
    bannerEl.style.display = "none";
  }
  // ★ 2026-10-12：进别名模式才把「黄框 + 接点击改名」挂上；**退出就原样摘掉**（平时连点击都不碰）
  if (aliasMode) { try { patchAllNodes(); } catch (e) { /* 忽略 */ } }
  else { try { uneditAllNodes(); } catch (e) { /* 忽略 */ } }
  redraw();
}

// ---------------------------------------------------------------- 悬停看真名
let tipEl = null;
let moveHooked = false;
let movePending = false;

function ensureTip() {
  if (tipEl) return tipEl;
  injectStyle();
  tipEl = document.createElement("div");
  tipEl.className = "pcw-tip";
  document.body.appendChild(tipEl);
  return tipEl;
}

function hideTip() {
  if (tipEl) tipEl.style.display = "none";
}

function canvasPointerMove(ev) {
  const canvas = app && app.canvas;
  const el = canvas && (canvas.canvas || canvas.canvasEl);
  if (!canvas || !el || !canvas.graph) return hideTip();
  const alias = (() => {
    try {
      const rect = el.getBoundingClientRect();
      const scale = (canvas.ds && canvas.ds.scale) || 1;
      const off = (canvas.ds && canvas.ds.offset) || [0, 0];
      const x = (ev.clientX - rect.left) / scale - off[0];
      const y = (ev.clientY - rect.top) / scale - off[1];
      const node = canvas.graph.getNodeOnPos(x, y, canvas.visible_nodes);
      const w = node && typeof node.getWidgetOnPos === "function" ? node.getWidgetOnPos(x, y, true) : null;
      if (!w || !w.__pcAliasPatched) return "";
      return aliasOf(w) ? String(w.value == null ? "" : w.value) : "";
    } catch (e) {
      return "";
    }
  })();
  if (!alias) return hideTip();
  const tip = ensureTip();
  tip.textContent = "真名：" + alias;
  tip.style.display = "block";
  tip.style.left = Math.min(window.innerWidth - 60, ev.clientX + 14) + "px";
  tip.style.top = Math.max(4, ev.clientY - 26) + "px";
}

function hookHover() {
  if (moveHooked) return;
  const canvas = app && app.canvas;
  const el = canvas && (canvas.canvas || canvas.canvasEl);
  if (!el || !el.addEventListener) return;
  el.addEventListener("pointermove", (ev) => {
    if (movePending) return;
    movePending = true;
    const run = () => { movePending = false; canvasPointerMove(ev); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  });
  el.addEventListener("pointerleave", hideTip);
  moveHooked = true;
}

// ---------------------------------------------------------------- 别名面板
let panelEl = null;
let HISTORY_MODELS = null;      // 历史记录里用过的模型栏位（null = 还没读过）

// 他 2026-10-01 要求：别名面板不要只看当前画布 —— **历史记录里用过的**（跑过图的那些工作流）也要列出来
async function fetchHistoryModels() {
  const out = {};
  try {
    const r = await fetch("/history?max_items=40", { cache: "no-store" });
    const j = await r.json();
    for (const pid of Object.keys(j || {})) {
      const rec = j[pid];
      const p = rec && rec.prompt;
      const graph = Array.isArray(p) ? p[2] : (p && p.prompt);
      if (!graph || typeof graph !== "object") continue;
      for (const nid of Object.keys(graph)) {
        const ins = graph[nid] && graph[nid].inputs;
        if (!ins || typeof ins !== "object") continue;
        for (const k of Object.keys(ins)) {
          const v = ins[k];
          if (typeof v !== "string" || !MODEL_EXT.test(v)) continue;
          const kind = kindOf(k);
          out[kind + "/" + v] = { kind, value: v };
        }
      }
    }
  } catch (e) { /* 读不到就当没有（老版 ComfyUI / 还没跑过图） */ }
  HISTORY_MODELS = out;
  return out;
}

// 按 alias 表的键改一个（不依赖画布上有没有那个控件）
function openAliasByKey(key) {
  injectStyle();
  const box = makeBox("改别名", 430);
  box.querySelector(".pcw-body").innerHTML = `
    <div class="pcw-muted">${esc(key)}</div>
    <div class="pcw-sec">别名</div>
    <input class="pcw-input" data-alias="1" />
    <div class="pcw-muted" style="margin-top:6px">只改显示，文件真名不变。</div>
    <div class="pcw-row" style="margin-top:12px;justify-content:flex-end">
      <button class="pcw-btn" data-cancel="1">取消</button>
      <button class="pcw-btn primary" data-save="1">保存</button>
    </div>`;
  const input = box.querySelector("[data-alias]");
  input.value = ALIASES[key] || "";
  box.querySelector("[data-cancel]").addEventListener("click", () => box.remove());
  box.querySelector("[data-save]").addEventListener("click", async () => {
    // ★ 221 批：同 saveAliasDialog —— 先本地生效、立刻关窗，落盘放后台，失败回滚 + 红字提示
    const val = input.value;
    const old = ALIASES[key];
    applyAliasLocal(key, val);
    box.remove();
    try { if (panelEl) renderPanelBody(); } catch (e2) { /* 忽略 */ }
    try { await postAlias({ key: key, alias: val }); }
    catch (e) {
      applyAliasLocal(key, old || "");
      toastBox("别名没存上（" + e.message + "）—— 已撤回，再试一次或点面板里的「🔄 刷新」");
      try { if (panelEl) renderPanelBody(); } catch (e3) { /* 忽略 */ }
    }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") box.querySelector("[data-save]").click(); });
  try { attachPreviewPicker(box, key); } catch (e0) { /* 忽略 */ }
  setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* 忽略 */ } }, 30);
}

function canvasModelRows() {
  const rows = [];
  for (const node of graphNodes()) {
    if (!Array.isArray(node.widgets)) continue;
    for (const w of node.widgets) {
      // ⚠️ 2026-10-12：这里**不能**再按 `__pcAliasPatched` 过滤 —— 惰性挂载之后，
      //   "还没起过别名"的栏位根本没被挂过，按标记筛就会让它们从面板里消失（也就再也加不了别名）。
      //   按 isModelCombo 筛，和惰性挂载之前列出来的是同一批。
      if (!w || !isModelCombo(w)) continue;
      rows.push({
        node,
        widget: w,
        owner: node.title || node.type || "节点",
        kind: kindOf(w.name),
        name: w.name,
        real: String(w.value == null ? "" : w.value),
        alias: aliasOf(w),
      });
    }
  }
  return rows;
}

function renderPanelBody() {
  if (!panelEl) return;
  const body = panelEl.querySelector(".pcw-body");
  const rows = canvasModelRows();
  const keys = Object.keys(ALIASES).sort();

  const rowHtml = (r, i) => `
    <div class="pcw-item">
      <span class="nm" title="${esc(r.owner)} · ${esc(r.name)}">${esc(r.owner)} · ${esc(r.name)}</span>
      <span class="val" title="${esc(r.real)}">${esc(r.real)}</span>
      <span class="pcw-alias-chip">${esc(r.alias) || "（还没别名）"}</span>
      <button class="pcw-btn" data-edit="${i}">✎</button>
    </div>`;

  const aliasHtml = (k, i) => `
    <div class="pcw-item">
      <span class="val" title="${esc(k)}">${esc(k)}</span>
      <span class="pcw-alias-chip">${esc(ALIASES[k])}</span>
      <button class="pcw-btn" data-edit-key="${i}">✎</button>
      <button class="pcw-btn danger" data-del-key="${i}">删</button>
    </div>`;

  const histKeys = Object.keys(HISTORY_MODELS || {}).sort();
  const histHtml = (k, i) => `
    <div class="pcw-item">
      <span class="val" title="${esc(k)}">${esc(k)}</span>
      <span class="pcw-alias-chip">${ALIASES[k] ? esc(ALIASES[k]) : "（还没别名）"}</span>
      <button class="pcw-btn" data-hist-key="${i}">✎</button>
    </div>`;

  // ★ 219 批（他："模型别名并不能识别当前 Lora 池里面的 Lora"）：
  //   被「吃掉」进 LoRA 池的那些，在画布上**已经没有模型下拉**了 → 上面三组都不会出现，
  //   于是根本没法给它们起别名（池子里能双击改，但工具栏这边看不到）。
  //   补一组「LoRA 池里的（N）」，key 统一 `loras/文件名`，和池子双击改名是同一张表。
  const poolNames = (() => {
    const out = [];
    try {
      ((app.graph && app.graph._nodes) || []).forEach((n) => {
        if (!n || n.type !== "PromptToolLoraPool") return;
        const w = (n.widgets || []).filter((x) => x && x.name === "状态")[0];
        let st = {};
        try { st = JSON.parse(String((w && w.value) || "{}")) || {}; } catch (e) { st = {}; }
        (st.loras || []).forEach((r) => {
          const nm = String((r && r.name) || "");
          if (nm && out.indexOf(nm) < 0) out.push(nm);
        });
      });
    } catch (e) { /* 忽略 */ }
    return out.sort();
  })();
  const poolHtml = (nm, i) => {
    const k = "loras/" + nm;
    return `
    <div class="pcw-item">
      <span class="nm" title="${esc(nm)}">池子 · ${esc(nm)}</span>
      <span class="pcw-alias-chip">${ALIASES[k] ? esc(ALIASES[k]) : "（还没别名）"}</span>
      <button class="pcw-btn" data-pool-key="${i}">✎</button>
    </div>`;
  };

  // ★ 226 批（他："模型别名游动羽翼工具栏和 Lora 管理这两个弹窗都太高了，一定要改成两排才行"）
  // ★ 226b（他："左边是画布上的模型栏位，一个栏位。右边是 Lora 池里面的栏位、已经改过名的栏位、
  //   历史记录里用过的模型栏位，三个栏位。左右 1:3，应该改成 2:2 才对"）→ 左 2 组 / 右 2 组
  body.innerHTML = `
    <div class="pcw-cols">
      <div class="pcw-col">
        <div class="pcw-row" style="margin-bottom:10px">
          <button class="pcw-btn primary" data-pick="1">✎ 点一下画布改名</button>
          <button class="pcw-btn" data-refresh="1">🔄 刷新</button>
          ${backendOk ? "" : `<span class="pcw-muted" style="color:#ffb4b4">${esc(backendMsg)}</span>`}
        </div>
        <div class="pcw-sec">画布上的模型栏位（${rows.length}）</div>
        <div class="pcw-list">${rows.length ? rows.map(rowHtml).join("") : `<div class="pcw-muted">画布上还没有带模型下拉的节点。</div>`}</div>
        <div class="pcw-sec">已经改过别名的（${keys.length}）</div>
        <div class="pcw-list">${keys.length ? keys.map(aliasHtml).join("") : `<div class="pcw-muted">还没改过。改过的才会出现在这里，不会把上千个文件都列出来。</div>`}</div>
      </div>
      <div class="pcw-col">
        <!-- ★ 228 批（他："Lora 池里的栏位和历史记录里用过的模型栏位，互相交换位置"）→ 历史在前、池子在后 -->
        <div class="pcw-sec">历史记录里用过的模型栏位（${HISTORY_MODELS === null ? "…" : histKeys.length}）</div>
        <div class="pcw-list">${histKeys.length ? histKeys.map(histHtml).join("")
          : `<div class="pcw-muted">${HISTORY_MODELS === null ? "正在读历史记录…" : "还没读到历史记录（在 ComfyUI 里跑过图之后这里就会出现）。"}</div>`}</div>
        <div class="pcw-sec">LoRA 池里的（${poolNames.length}）</div>
        <div class="pcw-list">${poolNames.length ? poolNames.map(poolHtml).join("")
          : `<div class="pcw-muted">画布上还没有 LoRA 池节点（或者池子是空的）。放一个「LoRA 池」到画布上、把 LoRA 拖进去，这里就会列出来。</div>`}</div>
      </div>
    </div>
    <div class="pcw-muted">别名表存在节点文件夹里的 model_aliases.json（可以直接手改、也可以拷给别人）。</div>`;

  body.querySelector("[data-pick]").addEventListener("click", () => {
    panelEl.style.display = "none";
    setAliasMode(true);
  });
  body.querySelector("[data-refresh]").addEventListener("click", async () => { await fetchAliases(); renderPanelBody(); });
  body.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
    openAliasDialog(rows[Number(b.dataset.edit)].widget, rows[Number(b.dataset.edit)].node);
  }));
  body.querySelectorAll("[data-edit-key]").forEach((b) => b.addEventListener("click", () => {
    openAliasByKey(keys[Number(b.dataset.editKey)]);
  }));
  body.querySelectorAll("[data-hist-key]").forEach((b) => b.addEventListener("click", () => {
    openAliasByKey(histKeys[Number(b.dataset.histKey)]);
  }));
  // ★ 219 批：LoRA 池里那些的改名入口（key = loras/文件名）
  body.querySelectorAll("[data-pool-key]").forEach((b) => b.addEventListener("click", () => {
    openAliasByKey("loras/" + poolNames[Number(b.dataset.poolKey)]);
  }));
  body.querySelectorAll("[data-del-key]").forEach((b) => b.addEventListener("click", async () => {
    const key = keys[Number(b.dataset.delKey)];
    try { await postAlias({ key: key, alias: "" }); renderPanelBody(); } catch (e) { log("删别名失败", e); }
  }));
}

function openAliasPanel() {
  injectStyle();
  if (!panelEl) {
    panelEl = makeBox("模型别名（游动羽翼工具栏）", 920);
    // ★ 226b（他："点击再关闭之后无法重复打开的问题仍然存在"）
    //   真因：`makeBox()` 自己给 ✕ 绑了 `el.remove()`，我又绑了一个"只隐藏"的 —— 两个都跑，
    //   结果元素被从 DOM 里**删掉**了；再打开时只是把 display 设成 block，可它已经不在文档里 → 看不见。
    //   修法：把 makeBox 绑过事件的那个 ✕ 换成克隆节点（克隆不带监听），只留下"隐藏"这一个行为；
    //   并且每次打开都确认它还在 body 里（万一被别处 remove 了也能救回来）。
    const oldX = panelEl.querySelector(".pcw-x");
    if (oldX) {
      const newX = oldX.cloneNode(true);
      oldX.replaceWith(newX);
      newX.addEventListener("click", () => {
        panelEl.style.display = "none";
        setAliasMode(false);
      });
    }
  }
  if (!document.body.contains(panelEl)) document.body.appendChild(panelEl);
  // ★ 238 批（他第 6 条："模型别名在关闭之后无法重新打开的问题仍然存在"）：
  //   三次机械开/关都正常（探针 _probe_248 全过），所以最可能是**面板被拖到屏幕外了**
  //   —— 位置只在创建时算过一次，之后窗口变小 / 被拖到右下角，再"打开"就是真的在屏幕外面。
  //   这里每次打开都把左上角**拉回可视区**（8px 留白），顺手也修掉"负坐标"。
  try {
    const r = panelEl.getBoundingClientRect();
    const curL = parseInt(panelEl.style.left, 10);
    const curT = parseInt(panelEl.style.top, 10);
    const maxL = Math.max(8, window.innerWidth - 140);
    const maxT = Math.max(8, window.innerHeight - 90);
    const L = Math.min(Math.max(8, isNaN(curL) ? Math.round(r.left) : curL), maxL);
    const T = Math.min(Math.max(8, isNaN(curT) ? Math.round(r.top) : curT), maxT);
    if (panelEl.style.left !== L + "px") panelEl.style.left = L + "px";
    if (panelEl.style.top !== T + "px") panelEl.style.top = T + "px";
  } catch (e) { /* 忽略 */ }
  panelEl.style.display = "block";
  renderPanelBody();
  if (HISTORY_MODELS === null) {
    // 第一次打开时去读一次"历史记录里用过的模型栏位"（他要求不只列当前画布）
    Promise.resolve().then(() => fetchHistoryModels()).then(() => { if (panelEl) renderPanelBody(); });
  }
  return panelEl;
}

// ---------------------------------------------------------------- 工具栏节点自己的按钮
function findClassTypeByTitle(title) {
  const LG = window.LiteGraph;
  const reg = LG && LG.registered_node_types;
  if (!reg) return null;
  for (const key of Object.keys(reg)) {
    const def = reg[key];
    if (!def) continue;
    if (def.title === title || def.display_name === title) return def.type || key;
  }
  return null;
}

function addNodeToCanvas(classType) {
  const LG = window.LiteGraph;
  const node = LG && typeof LG.createNode === "function" ? LG.createNode(classType) : null;
  if (!node) return null;
  try {
    const canvas = app.canvas;
    const el = canvas && (canvas.canvas || canvas.canvasEl);
    const scale = (canvas && canvas.ds && canvas.ds.scale) || 1;
    const off = (canvas && canvas.ds && canvas.ds.offset) || [0, 0];
    const cw = (el && el.width) || 1200;
    const ch = (el && el.height) || 800;
    const size = node.size || [240, 100];
    const cx = -off[0] + cw / scale / 2;
    const cy = -off[1] + ch / scale / 2;
    node.pos = [Math.round(cx - size[0] / 2), Math.round(cy - size[1] / 2)];
    app.graph.add(node);
    if (canvas && typeof canvas.selectNodes === "function") canvas.selectNodes([node], false);
    else node.selected = true;
    redraw();
  } catch (e) {
    log("加到画布时出了点问题", e);
  }
  return node;
}

const TOOLBAR_MIN_W = 470;      // 两行说明和那颗长按钮要放得下

// 排版行：一个"只画字、不是输入"的假控件（litegraph 允许带 draw 的鸭子控件）。
// 为什么要这个：控件是按数组顺序一行一行排的，光靠 onDrawForeground 只能在**所有控件下面**写字 ——
// 而他要在每颗按钮**上面**先写一句"1./2."。标 serialize:false 就不会进 widgets_values
// （已核对 comfygraph 那侧 configure()：`if (widget.serialize === false) continue`）。
function makeSpacer(text, color, opts) {
  const o = opts || {};
  return {
    type: "pcText",
    name: o.name || text,       // 名字就用这句话本身：既好认，也方便自测断言
    value: null,
    y: 0, height: 20, last_y: 0,
    serialize: false,
    options: { serialize: false },
    hidden: false,
    computeSize: function (w) { return [w || 200, 20]; },
    onClick: function () {},
    draw: function (ctx, node, width, y, H) {
      ctx.save();
      ctx.font = (o.bold ? "12px" : "11px") + " sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(clipText(ctx, text, (width || 200) - 26), 15, y + H * 0.55);
      ctx.restore();
    },
  };
}

// ★ 273 批（他 272 批第 12 条："可不可以按键盘上的上下左右键，在 ComfyUI 上的视角就可以根据上下左右键移动"，
//   并要求"做成游动羽翼工具栏的新的一列功能"）→ 一排开关行，开了之后 ↑↓←→ 平移画布。
const ARROW_PAN_KEY = "pcToolbar.arrowPan.v1";
// ★ 273b（他："上下左右移动应该可以调速度才对"）→ 一格走多少像素可调（设置里改）
const ARROW_PAN_STEP_KEY = "pcToolbar.arrowPanStep.v1";
function arrowPanOn() { try { return localStorage.getItem(ARROW_PAN_KEY) === "1"; } catch (e) { return false; } }
// ★ 2026-11-04（他第 1 条）：键位三档 —— arrow（只 ↑↓←→）/ wasd（只 WASD）/ both（都绑）
const ARROW_KEYS_KEY = "pcToolbar.arrowKeys.v1";
const ARROW_KEY_LABEL = { arrow: "↑↓←→", wasd: "WASD", both: "两个都绑" };
function arrowKeyMode() {
  try {
    const v = String(localStorage.getItem(ARROW_KEYS_KEY) || "");
    if (v === "arrow" || v === "wasd" || v === "both") return v;
  } catch (e) { /* 忽略 */ }
  return "arrow";                        // 老行为：只有方向键
}
function setArrowKeyMode(v) {
  const m = (v === "wasd" || v === "both") ? v : "arrow";
  try { localStorage.setItem(ARROW_KEYS_KEY, m); } catch (e) { /* 忽略 */ }
  return m;
}
function arrowPanStep() {
  try {
    const v = Number(localStorage.getItem(ARROW_PAN_STEP_KEY));
    if (isFinite(v) && v >= 20 && v <= 2000) return Math.round(v);
  } catch (e) { /* 忽略 */ }
  return 120;
}
function setArrowPanStep(v) {
  const n = Number(v);
  const px = (!isFinite(n) || n <= 0) ? 120 : Math.max(20, Math.min(2000, Math.round(n)));
  try { localStorage.setItem(ARROW_PAN_STEP_KEY, String(px)); } catch (e) { /* 忽略 */ }
  return px;
}
function makeArrowPanRow() {
  const w = makeSpacer("", "rgba(160, 172, 192, 0.95)", { name: "pcArrowPanRow" });
  w.computeSize = function (width) { return [width || 200, 22]; };
  w.draw = function (ctx, node, width, y, H) {
    try {
      const on = arrowPanOn();
      ctx.save();
      ctx.font = "11.5px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = on ? "rgba(124, 235, 170, 0.95)" : "rgba(196, 202, 214, 0.9)";
      ctx.fillText((on ? "🟢 方向键移动视角：已开启（点这里关）" : "⚪ 方向键移动视角：已关闭（点这里开）"), 15, y + H * 0.55);
      ctx.restore();
    } catch (e) { /* 忽略 */ }
  };
  w.mouse = function (e) {
    try {
      const t = (e && e.type) || "";
      if (!/down|click/i.test(t)) return false;
      const v = !arrowPanOn();
      try { localStorage.setItem(ARROW_PAN_KEY, v ? "1" : "0"); } catch (e2) { /* 忽略 */ }
      if (window.app && app.canvas) app.canvas.setDirty(true, true);
      return true;
    } catch (e3) { return false; }
  };
  return w;
}
function ensureArrowPan() {
  if (window.__pcArrowPanBound) return;
  window.__pcArrowPanBound = true;
  document.addEventListener("keydown", function (e) {
    try {
      if (!arrowPanOn()) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const sel = (window.app && app.canvas && app.canvas.selected_nodes) || {};
      if (Object.keys(sel).length) {
        // ★ 273b（他："选中节点的时候，上下左右自动取消选中"）→ 先取消选中，接着照常移视角
        try {
          if (app.canvas && typeof app.canvas.deselectAllNodes === "function") app.canvas.deselectAllNodes();
          else Object.keys(sel).forEach((k) => { delete sel[k]; });
          app.canvas.setDirty(true, true);
        } catch (e0) { /* 忽略 */ }
      }
      let dx = 0, dy = 0;
      const STEP = arrowPanStep();
      // ★ 2026-11-04（他第 1 条）：「通过设置调整方向键移动视角用的是什么方向键，
      //   除了上下左右以外，也可以用 WASD，甚至两个都绑也行」
      //   → 三档：arrow（只 ↑↓←→，老行为）/ wasd（只 WASD）/ both（都绑）。
      const mode = arrowKeyMode();
      const k = e.key;
      const isArrow = k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown";
      const kk = String(k || "").toLowerCase();
      const isWasd = kk === "w" || kk === "a" || kk === "s" || kk === "d";
      if (isArrow && mode === "wasd") return;
      if (isWasd && mode === "arrow") return;
      if (k === "ArrowLeft" || kk === "a") dx = STEP;
      else if (k === "ArrowRight" || kk === "d") dx = -STEP;
      else if (k === "ArrowUp" || kk === "w") dy = STEP;
      else if (k === "ArrowDown" || kk === "s") dy = -STEP;
      else return;
      e.preventDefault();
      e.stopPropagation();
      const ds = app.canvas.ds;
      const sc = ds.scale || 1;
      ds.offset[0] += dx / sc;
      ds.offset[1] += dy / sc;
      app.canvas.setDirty(true, true);
    } catch (err) { /* 忽略 */ }
  }, true);
}

function makeEraserRow() {          // 按住这一行就能拖（橡皮擦本体）
  const w = makeSpacer("🧽 橡皮擦：按住这一行，拖到要擦的小字上松手", "rgba(255, 196, 92, 0.95)", { name: "pcEraserRow" });
  w.__pcEraser = true;             // 自己不能被擦
  // ★ 2026-10-08 修 bug（第一百一十五批 · 他报「橡皮擦功能根本没法用」）：
  //   真前端 api-BqIxvqZ8.js 的 `_processPrimaryButton` 里写的是
  //     `let d = n.getWidgetOnPos(s,c); if (d) { processWidgetClick(e,n,d) } else { … n.onMouseDown?.(e,u,this) … }`
  //   —— **落点在"控件行"上时走 processWidgetClick，node.onMouseDown 根本收不到**；而这颗 🧽 是 pcText 控件、
  //   必然被 getWidgetOnPos 命中（isWidgetVisible 只排 collapsed/hidden/advanced），所以之前挂在
  //   `nodeType.prototype.onMouseDown` 上等于没挂（连"顺手把节点拖走"都不行）。
  //   processWidgetClick 里 `toConcreteWidget` 的 switch 没有 pcText（default 直接返空）→ 会落到
  //   `else if (n.mouse) { n.mouse(e,[o,s],t) }`，所以按下钩子必须挂在**控件自己**身上（LiteGraph 的老口子）。
  //   ⚠️ 同一函数在 pointerup 的 finally 里还会再调一次 `n.mouse(eUp,…)` → 只认 down 那两个 type。
  //   ⚠️ 第一百二十六批起这条钩子**只是兜底**：真正接住按下的是 window 捕获阶段的 `onEraseDownCapture`
  //      （见上面那段长注释）。前端哪天把 `else if (n.mouse)` 这一行删了，才只有这条路可用。
  w.mouse = function (ev, pos, node) {
    const t = ev && ev.type;
    if (t === "pointerdown" || t === "mousedown") return startEraseDrag(node, ev);
    return false;
  };
  return w;
}

function clipText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 2 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

// 工具栏自己那个「要添加的节点」下拉：ComfyUI 默认给它画左右两颗箭头（◀ ▶），
// 四五个名字的下拉根本用不着它们，还会把标签挤到边上 —— 这里改成"标签 + 值 + 一个 ▾"。
function patchToolbarCombo(widget) {
  if (!widget || widget.__pcToolbarCombo) return false;
  widget.__pcToolbarCombo = true;
  try {
    widget.drawWidget = function (ctx, options) {
      const width = (options && options.width) || 300;
      const showText = !options || options.showText !== false;
      const { y, height: h } = this;
      const margin = 15;
      ctx.save();
      ctx.fillStyle = this.background_color;
      ctx.strokeStyle = this.getOutlineColor ? this.getOutlineColor() : "rgba(120, 130, 150, 0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(margin, y, width - margin * 2, h, [h * 0.5]);
      ctx.fill();
      if (showText && !this.computedDisabled) ctx.stroke();
      if (showText) {
        const cy = y + h * 0.5;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.font = "12px sans-serif";
        const label = this.displayName || this.name || "";
        ctx.fillStyle = this.secondary_text_color;
        ctx.fillText(label, margin * 2 + 1, cy);
        const labelW = ctx.measureText(label).width;
        const x0 = margin * 2 + 7 + labelW;
        const room = Math.max(20, width - x0 - margin * 2 - 12);
        ctx.fillStyle = this.text_color;
        ctx.fillText(clipText(ctx, String(this._displayValue == null ? "" : this._displayValue), room), x0, cy);
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "rgba(150, 162, 180, 0.8)";
        ctx.textAlign = "right";
        ctx.fillText("▾", width - margin * 2 - 3, cy);
      }
      ctx.restore();
    };
    // 顺带把"看不见的左右箭头"关掉：以前点到最左/最右 40px 会**悄悄换一个值**，现在一律弹列表
    const origClick = widget.onClick;
    if (typeof origClick === "function") {
      widget.onClick = function (opts) {
        try {
          const e = opts && opts.e;
          const node = opts && opts.node;
          if (e && node && typeof e.canvasX === "number") {
            const x = e.canvasX - node.pos[0];
            const width = this.width || (node.size ? node.size[0] : 300);
            if (x < 40 || x > width - 40) {
              const mid = Object.assign({}, e, { canvasX: node.pos[0] + width / 2 });
              return origClick.call(this, Object.assign({}, opts, { e: mid }));
            }
          }
        } catch (err) { /* 忽略 */ }
        return origClick.call(this, opts);
      };
    }
  } catch (e) {
    log("下拉外观改造失败（不影响使用）", e);
  }
  return true;
}

// 第一颗按钮干的事：把下拉里选中的那个节点加到画布中间（抽成函数，方便自测和以后复用）
function addChosenNode(node) {
  const c = resolveWidget(node, TOOLBAR_COMBO);
  const want = c ? String(c.value) : "";
  const type = findClassTypeByTitle(want);
  if (!type) {
    log(`没找到节点「${want}」—— 多半是那个节点还没装上（或者要重启一次 ComfyUI）`);
    return null;
  }
  const n = addNodeToCanvas(type);
  log(n ? `已把「${want}」加到画布中间` : `「${want}」加不进去`);
  return n;
}

// ==================== 第 4 组：只看选中的（把其他节点藏起来）====================
// ⚠️ 2026-10-06 第一百零六批：他原话「**暂时雪藏「只看选中的节点」这个功能，不要删除**」
//   → 这一组**先不挂到工具栏节点上**（下面这套代码、`window.__pcPark` 钩子全都原样留着，
//     一个字都没删）；要它回来只需要把 PARK_GROUP_ENABLED 改成 true（attachToolbarButtons 里那段
//     `if (PARK_GROUP_ENABLED) { … }` 就是它原来的全部内容）。
const PARK_GROUP_ENABLED = false;

// 2026-10-05 第一百零二批他挑的「批 B」：用**画布原生多选**（框选 / Ctrl 点选）→ 只留选中的，
// 把其他节点**藏起来** + 一键还原。
// ⚠️ 这个前端**没有真正的"隐藏节点"**（像素级对照实测：`flags.hidden=true` / `node.visible=false` /
//    `node.hidden=true` / `mode=4(BYPASS)` 全都照画不误，节点那块"墨迹"101159 一个像素不少；
//    真正有效的只有两条：① `node.collapse()`（收成小条：101159 → 587）② 挪出视野（→ 0））。
//    → 所以"藏" = **收起来 + 挪到当前视野下面的停车位**；原来的位置和原来的收起状态都记着。
// ⚠️ 停车位**绝不能跟着存盘**：把 `graph.serialize` 包一层 —— 存之前先放回来、存完再停回去。
const PARK_GAP = 620;         // 停车区放在当前视野下方多远（画布坐标）
const PARK_STEP = 270;        // 停车区横向间距
let parkStash = [];
let parkKeep = [];

function selectedNodeIds() {
  try {
    const sel = (app.canvas && app.canvas.selected_nodes) || {};
    return Object.keys(sel).map(function (k) {
      const v = sel[k];
      const id = (v && v.id !== undefined) ? v.id : Number(k);
      return Number(id);
    }).filter(function (v) { return !isNaN(v); });
  } catch (e) { return []; }
}

function parkOthers(keepIds) {
  try {
    const keep = Array.isArray(keepIds) ? keepIds : [];
    const nodes = (app.graph && app.graph._nodes) || [];
    const cvs = app.canvas && app.canvas.canvas, ds = app.canvas && app.canvas.ds;
    if (!cvs || !ds) return 0;
    // 选中的如果原来在停车区，先把它接回来（重选一次就能捞回来）
    const keepParked = parkStash.filter(function (s) { return keep.indexOf(s.id) >= 0; });
    if (keepParked.length) { parkStash = parkStash.filter(function (s) { return keep.indexOf(s.id) < 0; });
      keepParked.forEach(function (s) { restoreOne(nodes, s); }); }
    const left = -ds.offset[0];
    const bottom = -ds.offset[1] + cvs.height / ds.scale;
    let i = 0, n = 0;
    for (const nd of nodes) {
      if (!nd || keep.indexOf(nd.id) >= 0) continue;
      if (parkStash.some(function (s) { return s.id === nd.id; })) continue;   // 已经在停车区
      const pos = [nd.pos[0], nd.pos[1]];
      const wasCollapsed = !!(nd.flags && nd.flags.collapsed);
      if (!wasCollapsed && typeof nd.collapse === "function") { try { nd.collapse(); } catch (e) { /* 忽略 */ } }
      const col = i % 4, row = Math.floor(i / 4);
      nd.pos = [Math.round(left + col * PARK_STEP), Math.round(bottom + PARK_GAP + row * 96)];
      parkStash.push({ id: nd.id, pos: pos, wasCollapsed: wasCollapsed });
      i++; n++;
    }
    parkKeep = keep.slice();
    redraw();
    return n;
  } catch (e) { log("藏节点时出了点问题", e); return 0; }
}

function restoreOne(nodes, s) {
  const nd = nodes.filter(function (x) { return x.id === s.id; })[0];
  if (!nd) return false;
  nd.pos = [s.pos[0], s.pos[1]];
  // 只把自己收起来的那颗展开（他本来就收着的别乱动）
  if (!s.wasCollapsed && nd.flags && nd.flags.collapsed && typeof nd.collapse === "function") {
    try { nd.collapse(); } catch (e) { /* 忽略 */ }
  }
  return true;
}

function unparkAll() {
  let n = 0;
  try {
    const nodes = (app.graph && app.graph._nodes) || [];
    parkStash.forEach(function (s) { if (restoreOne(nodes, s)) n++; });
  } catch (e) { log("放回来时出了点问题", e); }
  parkStash = [];
  parkKeep = [];
  redraw();
  return n;
}

// 存盘前先放回来（别让"停车位"被写进工作流），存完再停回去
function wrapParkSerialize() {
  try {
    if (!app.graph || app.graph.__pcParkWrapped) return false;
    const orig = app.graph.serialize.bind(app.graph);
    app.graph.serialize = function () {
      const hadStash = parkStash.length > 0, keep = parkKeep.slice();
      if (hadStash) unparkAll();
      try { return orig.apply(null, arguments); }
      finally { if (hadStash) parkOthers(keep); }
    };
    app.graph.__pcParkWrapped = true;
    return true;
  } catch (e) { return false; }
}

// 一行会变的"状态字"（画在假控件里，靠闭包里的对象改字）。name 可传，默认是"停车位"那行的老名字
// （2026-10-12：新增的「设置」状态行用 pcSyncStatus，免得和停车场那行混在一起）。
function makeStatusRow(name) {
  const st = { text: "" };
  return {
    widget: {
      type: "pcText", name: name || "pcParkStatus", value: null, y: 0, height: 20, last_y: 0,
      serialize: false, options: { serialize: false }, hidden: false,
      computeSize: function (w) { return [w || 200, st.text ? 20 : -4]; },
      onClick: function () {},
      draw: function (ctx, node, width, y, H) {
        if (!st.text) return;
        ctx.save();
        ctx.font = "11px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(130, 205, 150, 0.95)";
        ctx.fillText(clipText(ctx, st.text, (width || 200) - 26), 15, y + H * 0.55);
        ctx.restore();
      },
    },
    set: function (t) { st.text = String(t || ""); },
  };
}

// ==================== 第 5 组：设置（第一百四十九批 · 他加的第 5 项）====================
//   他原话：「在游动羽翼第 4 项功能和第 5 项功能之间加第 5 项功能，把打开工具变为第 6 项功能，
//   新的第 5 项功能是设置，目前可以调的设置只有**提示词同步每次刷新或者重新打开时里面的文本会不会重置**」。
//   存储：`pcToolbar.syncReset.v1`（"1" = 清空 / 默认不写 = **保留**）——
//   web/prompt_sync.js 读同一个键（同源页面 → 同一个 localStorage），改完不用重启。
const SYNC_RESET_KEY = "pcToolbar.syncReset.v1";
let settingsStat = null;                            // 工具栏上那行状态字（改完设置立刻更新）
function syncResetOn() { try { return localStorage.getItem(SYNC_RESET_KEY) === "1"; } catch (e) { return false; } }
function setSyncReset(on) {
  try { localStorage.setItem(SYNC_RESET_KEY, on ? "1" : "0"); } catch (e) { /* 忽略 */ }
  // 工具栏那行状态字立刻跟着变（自测钩子也是走这里 → 钩子一调，状态就同步）
  try { if (settingsStat) settingsStat.set(settingsStatusText()); } catch (e) { /* 忽略 */ }
  log(on ? "设置：提示词同步在刷新 / 重开时**清空**文本" : "设置：提示词同步在刷新 / 重开时**保留**文本");
  return on;
}
function syncStatusText(on) {
  return on ? "提示词同步：刷新 / 重开时清空（只认工具这一次推过来的词）"
            : "提示词同步：刷新 / 重开时保留文本";
}

// ==================== ★ 234 批（他第 2 条）：运行前张数确认 ====================
//   他原话：「设置额外加一个功能，空 latent（这里是改版的还是原版的都要有啊）。
//   设置数量大于多少时，在点击运行时提前蹦出确认提醒，默认为 4」
//   → 覆盖面：原版 `EmptyLatentImage` 的 `batch_size` ＋ 黑箱节点里的「张数」（`properties.pcBlackBox.count`）。
//   → 存储：`pcToolbar.batchWarn.v1`（数字；**0 = 不提醒**；没写过 = 默认 4）。
const BATCH_WARN_KEY = "pcToolbar.batchWarn.v1";
const BATCH_WARN_DEFAULT = 4;
function batchWarnLimit() {
  try {
    const v = localStorage.getItem(BATCH_WARN_KEY);
    if (v == null || v === "") return BATCH_WARN_DEFAULT;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : BATCH_WARN_DEFAULT;
  } catch (e) { return BATCH_WARN_DEFAULT; }
}
function batchWarnLabel(lim) { return lim > 0 ? ("超过 " + lim + " 张先确认") : "不提醒张数"; }
function settingsStatusText() {
  return (syncResetOn() ? "同步：刷新时清空" : "同步：刷新时保留") + " ｜ " + batchWarnLabel(batchWarnLimit());
}
function setBatchWarnLimit(n) {
  const v = Math.max(0, Math.min(999, parseInt(n, 10) || 0));
  try { localStorage.setItem(BATCH_WARN_KEY, String(v)); } catch (e) { /* 忽略 */ }
  try { if (settingsStat) settingsStat.set(settingsStatusText()); } catch (e) { /* 忽略 */ }
  log(v > 0 ? ("设置：一次超过 " + v + " 张时，运行前先确认") : "设置：运行前不再提醒张数");
  return v;
}

// 扫一遍这张图里"一次要出几张"的地方（原版空 Latent + 黑箱）
function scanBatchPlan() {
  const list = [];
  let total = 0;
  try {
    const g = (window.app && window.app.graph) || null;
    const nodes = (g && g._nodes) || [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n) continue;
      const t = String(n.type || n.comfyClass || "");
      const where = String(n.title || t || "节点");
      // 原版：EmptyLatentImage / EmptySD3LatentImage / EmptyLatentImage…（排掉我们自己的节点）
      if (/Empty[A-Za-z0-9]*Latent/i.test(t) && !/PromptTool/i.test(t)) {
        const w = (n.widgets || []).filter(function (x) { return x && x.name === "batch_size"; })[0];
        if (w) {
          const v = Math.max(1, Math.floor(Number(w.value) || 1));
          list.push({ id: n.id, kind: "空 Latent", where: where, n: v });
          total += v;
        }
      }
      // 改版：黑箱自己记着的「张数」（黑箱是纯前端节点，type 名不同版本可能不一样 → 认 properties 兜底）
      if (t === "PromptToolBlackBox" || t === "提示词工具/黑箱"
        || (n.properties && n.properties.pcBlackBox && typeof n.properties.pcBlackBox.count === "number")) {
        const st = n.properties && n.properties.pcBlackBox;
        const v = Math.max(1, Math.floor(Number(st && st.count) || 1));
        list.push({ id: n.id, kind: "黑箱张数", where: where, n: v });
        total += v;
      }
    }
  } catch (e) { log("扫张数出错", e); }
  return { total: total, list: list };
}

// 三段式确认窗（零原生弹窗）：标题 / 说明 / 钉底动作排
let batchAsking = false;
let batchBypass = false;
function confirmBox(title, msg, okLabel, cb) {
  injectStyle();
  const box = makeBox(title, 520);
  const body = box.querySelector(".pcw-body");
  const p = document.createElement("div");
  p.className = "pcw-muted";
  p.style.cssText = "white-space:pre-wrap;line-height:1.75";
  p.textContent = msg;
  body.appendChild(p);
  const row = document.createElement("div");
  row.className = "pcw-row";
  row.style.cssText = "margin-top:14px;justify-content:flex-end";
  const bCancel = document.createElement("button");
  bCancel.className = "pcw-btn"; bCancel.textContent = "取消";
  const bOk = document.createElement("button");
  bOk.className = "pcw-btn primary"; bOk.textContent = okLabel || "确定";
  row.appendChild(bCancel); row.appendChild(bOk);
  body.appendChild(row);
  const cleanup = function () { batchAsking = false; };
  bCancel.addEventListener("click", function () { cleanup(); box.remove(); });
  bOk.addEventListener("click", function () {
    cleanup(); box.remove();
    try { if (cb) cb(); } catch (e) { log("确认后出错", e); }
  });
  // ⚠️ 右上角 ✕ 是 makeBox 自己绑的 `el.remove()` —— 这里**加**一个监听（不拦它），
  //    否则关掉窗口后 `batchAsking` 永远停在 true，以后点运行都会被静默吞掉。
  const x = box.querySelector(".pcw-x");
  if (x) x.addEventListener("click", cleanup);
  return box;
}

// 弹确认：这次不排，等用户点「就排」
function askBatchConfirm(number, batchCount, plan, lim) {
  const detail = plan.list.map(function (x) {
    return "· " + x.kind + "「" + x.where + "」 = " + x.n + " 张";
  }).join("\n");
  confirmBox("张数确认",
    "这次一下要排 " + plan.total + " 张（超过你设的 " + lim + " 张）。\n\n" + detail
    + "\n\n显卡会一直跑完这些才停。点「就排」继续，点「取消」回去改。",
    "就排", function () {
      batchAsking = false;
      batchBypass = true;
      try { window.app.queuePrompt(number, batchCount); }
      finally { batchBypass = false; }
    });
}

// 钩住 app.queuePrompt（要在**最外层**，否则随机组合的 each 模式会把这一次拆成 N 次、弹 N 个窗）
function ensureBatchWarnHook() {
  const a = window.app;
  if (!a || typeof a.queuePrompt !== "function") return false;
  if (a.queuePrompt.__pcBatchWarn) return true;               // 已经在最外层了
  const orig = a.queuePrompt.bind(a);
  const wrapped = function (number, batchCount) {
    try {
      if (!batchBypass) {
        if (batchAsking) return;                               // 确认窗已经开着：别排、也别叠第二个窗
        const lim = batchWarnLimit();
        if (lim > 0) {
          const plan = scanBatchPlan();
          if (plan.total > lim) {
            batchAsking = true;
            askBatchConfirm(number, batchCount, plan, lim);
            return;                                            // 这一下不排
          }
        }
      }
    } catch (e) { log("张数检查出错（继续正常排队）", e); }
    return orig(number, batchCount);
  };
  wrapped.__pcBatchWarn = true;
  a.queuePrompt = wrapped;
  log("张数确认钩子已挂上");
  return true;
}
function installBatchWarn() {
  try {
    ensureBatchWarnHook();
    // 状态行跟着读一次（默认 4 张也要显示出来）
    if (settingsStat) settingsStat.set(settingsStatusText());
  } catch (e) { /* 忽略 */ }
}
// 随机组合的钩子在 1.2s / 4s 挂（它只挂一次）→ 我们排在 7.5s 挂，就永远在它外面。
setTimeout(installBatchWarn, 1500);
setTimeout(installBatchWarn, 4500);
setTimeout(installBatchWarn, 7500);
setTimeout(installBatchWarn, 12000);
function openSettingsPanel() {
  // ★ 234 批（他第 1 条）：标题里别挂说明括号 —— "设置就是设置"。
  const box = makeBox("设置", 580);
  renderSettingsBody(box);
  return box;
}
function renderSettingsBody(box) {
  const on = syncResetOn();
  const lim = batchWarnLimit();
  const arrowOn = arrowPanOn();
  const step = arrowPanStep();
  const arrowKeys = arrowKeyMode();      // ★ 2026-11-04：键位三档 arrow / wasd / both
  const body = box.querySelector(".pcw-body");
  const limBtns = [0, 1, 2, 4, 8, 16].map((v) =>
    `<button class="pcw-btn${lim === v ? " primary" : ""}" data-bw="${v}">${v === 0 ? "不提醒" : v + " 张"}</button>`
  ).join("");
  const stepBtns = [60, 120, 240, 480].map((v) =>
    `<button class="pcw-btn${step === v ? " primary" : ""}" data-astep="${v}">${v}px</button>`
  ).join("");
  body.innerHTML = `
    <div class="pcw-sec">提示词同步</div>
    <div class="pcw-muted" style="margin:2px 0 9px">刷新页面 / 重新打开 ComfyUI 时，那两颗文本框
      （正提示词 / 负提示词）要不要清空？这颗节点只是个"中转站"，两种用法都有人要，所以做成开关。</div>
    <div class="pcw-row">
      <button class="pcw-btn${on ? "" : " primary"}" data-keep="1">保留文本${on ? "" : " ✓ 现在"}</button>
      <button class="pcw-btn${on ? " primary" : ""}" data-reset="1">清空${on ? " ✓ 现在" : ""}</button>
    </div>
    <div class="pcw-sec" style="margin-top:14px">运行前张数确认</div>
    <div class="pcw-muted" style="margin:2px 0 9px">一次要排的张数超过这个数，点「运行」会先弹一句确认，
      免得手滑排了几十张、显卡跑一下午。原版「空 Latent」的 batch_size 和黑箱里的「张数」都算。</div>
    <div class="pcw-row">
      ${limBtns}
      <input class="pcw-input" data-bwinput="1" style="width:74px" placeholder="其他" title="填 0 = 不提醒" />
    </div>
    <div class="pcw-sec" style="margin-top:14px">方向键移动视角</div>
    <div class="pcw-muted" style="margin:2px 0 9px">开着的时候按方向键平移画布，一格走多远在这里调；
      选中节点时会<b>先取消选中</b>再平移。在输入框里打字不受影响。</div>
    <div class="pcw-row">
      <button class="pcw-btn${arrowOn ? " primary" : ""}" data-arrowon="1">${arrowOn ? "已开启 ✓" : "开启"}</button>
      <button class="pcw-btn${arrowOn ? "" : " primary"}" data-arrowoff="1">${arrowOn ? "关闭" : "已关闭 ✓"}</button>
      ${stepBtns}
      <input class="pcw-input" data-astepinput="1" style="width:74px" placeholder="px" title="一格多少像素（20~2000）" />
    </div>
    <div class="pcw-muted" style="margin:8px 0 5px">用哪套键（★ 2026-11-04 新增：如果打字/画图时 WASD 容易误触，就选「只 ↑↓←→」）</div>
    <div class="pcw-row">
      <button class="pcw-btn${arrowKeys === "arrow" ? " primary" : ""}" data-akeys="arrow">只 ↑↓←→${arrowKeys === "arrow" ? " ✓" : ""}</button>
      <button class="pcw-btn${arrowKeys === "wasd" ? " primary" : ""}" data-akeys="wasd">只 WASD${arrowKeys === "wasd" ? " ✓" : ""}</button>
      <button class="pcw-btn${arrowKeys === "both" ? " primary" : ""}" data-akeys="both">两个都绑${arrowKeys === "both" ? " ✓" : ""}</button>
    </div>
    <div class="pcw-sec" style="margin-top:12px">现在：${on ? "清空" : "保留文本"} ｜ ${batchWarnLabel(lim)} ｜ 方向键 ${arrowOn ? "开" : "关"} ${step}px ｜ 键位 ${ARROW_KEY_LABEL[arrowKeys] || arrowKeys}</div>
    <div class="pcw-muted">${on
      ? "每次刷新 / 重开都会清空 —— 文本只认「这一次由提示词工具推过来的那一份」。"
      : "文本留在节点里（跟着工作流一起存）—— 关掉工具、刷新页面、明天再打开，里面还是那两句。"}</div>
    <div class="pcw-muted" style="margin-top:6px">⚠️ 改完不用重启 ComfyUI：下一次刷新 / 打开就按新设置走。</div>`;
  body.querySelector("[data-keep]").addEventListener("click", () => {
    setSyncReset(false);
    redraw(); renderSettingsBody(box);
  });
  body.querySelector("[data-reset]").addEventListener("click", () => {
    setSyncReset(true);
    redraw(); renderSettingsBody(box);
  });
  body.querySelectorAll("[data-bw]").forEach((b) => {
    b.addEventListener("click", () => {
      setBatchWarnLimit(Number(b.getAttribute("data-bw")));
      redraw(); renderSettingsBody(box);
    });
  });
  const inp = body.querySelector("[data-bwinput]");
  if (inp) {
    inp.value = String(lim);
    const applyInp = () => {
      setBatchWarnLimit(Number(inp.value));
      redraw(); renderSettingsBody(box);
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyInp(); } });
    inp.addEventListener("blur", applyInp);
  }
  // ★ 273b：方向键移动视角（开关 + 速度）
  const setArrow = (v) => {
    try { localStorage.setItem(ARROW_PAN_KEY, v ? "1" : "0"); } catch (e) { /* 忽略 */ }
    redraw(); renderSettingsBody(box);
  };
  const bAOn = body.querySelector("[data-arrowon]");
  const bAOff = body.querySelector("[data-arrowoff]");
  if (bAOn) bAOn.addEventListener("click", () => setArrow(true));
  if (bAOff) bAOff.addEventListener("click", () => setArrow(false));
  body.querySelectorAll("[data-astep]").forEach((b) => {
    b.addEventListener("click", () => { setArrowPanStep(Number(b.getAttribute("data-astep"))); redraw(); renderSettingsBody(box); });
  });
  // ★ 2026-11-04（他第 1 条）：键位三档
  body.querySelectorAll("[data-akeys]").forEach((b) => {
    b.addEventListener("click", () => {
      setArrowKeyMode(b.getAttribute("data-akeys"));
      redraw(); renderSettingsBody(box);
    });
  });
  const sinp = body.querySelector("[data-astepinput]");
  if (sinp) {
    sinp.value = String(step);
    const applyStep = () => { setArrowPanStep(Number(sinp.value)); redraw(); renderSettingsBody(box); };
    sinp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyStep(); } });
    sinp.addEventListener("blur", applyStep);
  }
}

function attachToolbarButtons(node) {
  try {
    if (typeof node.addWidget !== "function") return;
    // 他要的顺序（从上到下）：先写「1. …」这句 → 再是「要添加的节点」下拉 → 再是「加到画布」按钮
    //                       → 再写「2. …」这句 → 再是「模型别名」按钮 → 最后一行脚注
    const combo = resolveWidget(node, TOOLBAR_COMBO);
    const rest = (node.widgets || []).filter(function (w) { return w !== combo; });
    node.widgets = [];
    node.addCustomWidget(makeSpacer("1. 一键把本包的节点加到画布", "rgba(160, 172, 192, 0.95)", { bold: true }));
    if (combo) node.addCustomWidget(combo);
    node.addWidget("button", "➕ 加到画布", null, () => { addChosenNode(node); }, { serialize: false });
    // ★ 202 批（他："游动羽翼工具栏为什么叫不出来黑箱"）：黑箱是**纯前端节点**、不在下拉清单里，
    //   所以必须给一颗独立按钮。以前放在第 4 格（在节点下面、常常滚不到），现在**提到第 1 格**、
    //   紧跟「➕ 加到画布」，一打开就能看见。
    //   ★ 235 批：他要求「"放一个黑箱到画布（黑箱白模）"去掉括号」→ 按钮名只写功能名
    node.addWidget("button", "📦 放一个黑箱到画布", null, () => {
      try {
        if (window.__pcBlackBox && window.__pcBlackBox.create) {
          const n = window.__pcBlackBox.create();
          if (n && window.__pcBlackBox.fit) setTimeout(() => window.__pcBlackBox.fit(n), 60);
        } else { console.warn("[提示词工具] 黑箱没加载上（Ctrl+F5 一次）"); }
      } catch (e) { console.warn("[提示词工具] 黑箱创建失败", e); }
    }, { serialize: false });
    // ★ 2026-10-07（第一百一十四批 · 待办 ⑪）他定过：「工具栏**第 2 格**改成节点连线说明书」
    //   → 说明书是**同源静态页** `web/nodes_guide.html`（7 颗节点各连哪儿 + 三种常见接法 + 排错）；
    //     放同源页是因为：能跟画布并排看、双击 HTML 那条 file:// 路也不会被跨源挡。
    node.addCustomWidget(makeSpacer("2. 节点连线说明书", "rgba(160, 172, 192, 0.95)", { bold: true }));
    node.addWidget("button", "📖 打开节点连线说明书（7 颗节点各连哪儿）", null, () => {
      const url = new URL("/extensions/ComfyUI-PromptSync/nodes_guide.html", location.href).href;
      window.open(url, "_blank");
    }, { serialize: false });
    node.addCustomWidget(makeSpacer("3. 改模型别名", "rgba(160, 172, 192, 0.95)", { bold: true }));
    node.addWidget("button", "✎ 模型别名（点击这个按钮可以修改当前页面的模型栏位别名）", null, () => {
      openAliasPanel();
    }, { serialize: false });
    // ★ 199 批做的第 4 格黑箱按钮，202 批已**搬到第 1 格**（他找不到），这里不再重复挂。

    // ⚠️ 2026-10-06 第一百零六批他原话：「**暂时雪藏「只看选中的节点」这个功能，不要删除**」
    //   → 这一组**先不挂到节点上**；代码、自测钩子（window.__pcPark）、以及这一文件里那整套"停车位"
    //     逻辑（parkOthers / unparkAll / wrapParkSerialize / selectedNodeIds …）**一个字都没删**。
    //     哪天要它回来：把 PARK_GROUP_ENABLED 改成 true 就行（下面这段就是原来的全部内容）。
    if (PARK_GROUP_ENABLED) {
      node.addCustomWidget(makeSpacer("6. 只看选中的节点（把其他藏起来）", "rgba(160, 172, 192, 0.95)", { bold: true }));
      const parkStat = makeStatusRow();
      node.addWidget("button", "👁 只看选中的（先在画布上框选 / Ctrl 点选）", null, () => {
        const ids = selectedNodeIds();
        if (!ids.length) {
          parkStat.set("还没选节点 —— 先在画布上框选一片，或者按住 Ctrl 点几个节点");
          redraw();
          return;
        }
        const n = parkOthers(ids.concat([node.id]));      // ⚠️ 工具栏自己永远不藏（不然这颗"放回来"的键也跟着飞走了）
        parkStat.set(n ? ("已藏起 " + n + " 个，留下 " + ids.length + " 个（点下面那颗放回来）")
          : "没有可以藏的（选中的就是全部）");
        redraw();
      }, { serialize: false });
      node.addWidget("button", "↩ 把藏起来的都放回来", null, () => {
        const n = unparkAll();
        parkStat.set(n ? ("已放回来 " + n + " 个") : "现在没有藏起来的节点");
        redraw();
      }, { serialize: false });
      node.addCustomWidget(parkStat.widget);
      wrapParkSerialize();
    }
    // ★ 2026-10-07（第一百一十二 / 一百一十四批）他第 4 条：多一颗**可拖拽的橡皮擦** —— 把小字拖掉。
    //   第一百一十五批他要求：「把这个 bug 修完之后，让它和打开提示词工具互换一下次序」
    //   → 橡皮擦升到 **4.**；「打开提示词工具」顺延成 **5.**；雪藏的那组仍是 6.
    // ★ 238 批（他："工具栏的第四个功能，擦掉小字，括号橡皮擦也改为神奇工具"）
    //   这一格现在装两个工具：🧽 擦小字 + 🪄 魔法棒，所以标题叫「神奇工具」
    node.addCustomWidget(makeSpacer("4. 神奇工具", "rgba(160, 172, 192, 0.95)", { bold: true }));
    node.addCustomWidget(makeEraserRow());
    // ★ 239 批：魔法棒（prompt_wand.js 提供）—— 和橡皮挨着放，同一格「神奇工具」
    //   那个文件可能比本文件晚加载 → 先试一次，没到就等 600ms 再补（挂上过一次就不再重复）。
    if (window.__pcWand && window.__pcWand.makeRow) {
      const rowW = window.__pcWand.makeRow();
      if (rowW) { node.addCustomWidget(rowW); node.__pcWandAttached = true; }   // ★ 254 批：雪藏时返回 null
    } else {
      setTimeout(function () {
        try {
          if (node.__pcWandAttached || !window.__pcWand || !window.__pcWand.makeRow) return;
          const lateW = window.__pcWand.makeRow();
          if (!lateW) return;                          // ★ 254 批：雪藏时返回 null
          node.addCustomWidget(lateW);
          node.__pcWandAttached = true;
          redraw();
        } catch (e) { /* 忽略 */ }
      }, 600);
    }
    node.addCustomWidget(makeSpacer("橡皮擦只擦掉你拖到的那颗节点的小字 —— 别的节点、以后重新叫出来的新节点都不受影响（在那颗节点上右键可以「↩ 恢复小字」）", "rgba(150, 162, 180, 0.72)", {}));
    // ★ 2026-10-12（第一百四十九批）他第 1 条：在第 4 项与「打开提示词工具」之间**插入第 5 项「设置」**，
    //   「打开提示词工具」顺延成 **6.**（他原话：「把打开工具变为第 6 项功能，新的第 5 项功能是设置」）。
    node.addCustomWidget(makeSpacer("5. 设置", "rgba(160, 172, 192, 0.95)", { bold: true }));
    const setStat = makeStatusRow("pcSyncStatus");
    settingsStat = setStat;
    setStat.set(settingsStatusText());
    // ★ 234 批（他第 1 条）：「设置就是设置」—— 按钮名里不挂功能清单括号。
    node.addWidget("button", "⚙ 设置", null, () => { openSettingsPanel(); }, { serialize: false });
    node.addCustomWidget(setStat.widget);
    node.addCustomWidget(makeSpacer("6. 打开提示词工具（网页版）", "rgba(160, 172, 192, 0.95)", { bold: true }));
    // 从 ComfyUI 里打开工具：这个地址和 ComfyUI **同源**，互通 / 套图 / AI 全都连得上
    // （双击分享包里那份 HTML 是 file://，会被 ComfyUI 的跨源保护挡掉；分享包的 bat 已经加了
    //   --enable-cors-header 兜底，但**同源页面永远是最稳的那条路**）
    // ★ 2026-10-10（第一百四十批）他报「游动翼工具栏里面打开的是 6.0」——他这台是新的，
    //   对方那台是**浏览器缓存了旧页面**（或手上是旧包）。防守一手：打开的地址带上版本号，
    //   以后每换一版都算新地址，旧缓存再也顶不上来（拿不到版本时用时间戳，反正一定是最新的）。
    node.addWidget("button", "🌐 打开提示词工具（同源网页版，推荐）", null, () => {
      // ?from=toolbar：从工具栏打开的工具**默认就把互通连上**（普通打开工具默认不连，见工具里的 FROM_TOOLBAR）
      // ⚠️ 第一百四十五批（他第 4 条 · 对方"工具栏进去还是老版本，换默认浏览器才好"那份记录）：
      //   光带**节点版本号**顶不住这种缓存 —— 143 / 144 批那种"只改工具页面"的更新**不会动节点版本**（都还是 1.5），
      //   地址一模一样 → 浏览器就把旧页面拿出来给你。所以版本号后面再加一个**每次打开的时间戳**：
      //   每次点都算新地址，旧缓存永远顶不上来（本地文件 1.3MB，重读一次可以忽略）。
      const v = encodeURIComponent((CACHED_NODE_VER ? CACHED_NODE_VER + "-" : "") + Date.now());
      const url = new URL("/extensions/ComfyUI-PromptSync/prompt_tool.html?from=toolbar&v=" + v, location.href).href;
      window.open(url, "_blank");
    }, { serialize: false });
    node.addCustomWidget(makeSpacer("7. 方向键移动视角", "rgba(160, 172, 192, 0.95)", { bold: true }));
    node.addCustomWidget(makeArrowPanRow());
    node.addCustomWidget(makeSpacer("开着的时候 ↑↓←→ 平移画布（一步多远在「5. 设置」里调）；选中节点时按方向键会先取消选中再平移；输入框里打字不受影响", "rgba(150, 162, 180, 0.72)", {}));
    node.addCustomWidget(makeSpacer("本节点不参与工作流；别名只改显示，文件名一个都不动", "rgba(150, 162, 180, 0.72)", {}));
    for (const w of rest) node.addCustomWidget(w);      // 别的控件（以后加的）原样接在后面
    if (combo) patchToolbarCombo(combo);
    ensureArrowPan();
    redraw();
  } catch (e) {
    log("工具栏按钮注入失败", e);
  }
}

function setupToolbarNode(nodeType) {
  const onCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = onCreated ? onCreated.apply(this, arguments) : undefined;
    attachToolbarButtons(this);
    redraw();
    return r;
  };
  // ★ 2026-10-07（第一百一十一批）：按住那颗「🧽」就起拖（松手时擦掉光标底下那一行小字）
  //   ⚠️ 2026-10-08（第一百一十五批修 bug）：**真前端根本不走这条** —— 落点在控件行上时 _processPrimaryButton
  //      先进 processWidgetClick，node.onMouseDown 收不到。真正的按下钩子在 makeEraserRow 的 `w.mouse` 上；
  //      这条留着兜"控件没命中"的老前端/别的入口（比如 pos 落在行边缘的 2px 容差里）。
  const onDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos, canvas) {
    try { if (eraserRowOf(this, pos)) return startEraseDrag(this, e); } catch (err) { /* 忽略 */ }
    return onDown ? onDown.apply(this, arguments) : undefined;
  };
  // 读工作流时（= 换了一份工作流）：之前那份的"停车位"没意义了，直接清掉（别去乱挪新工作流的节点）
  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (info) {
    const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
    try { parkStash = []; parkKeep = []; } catch (e) { /* 忽略 */ }
    return r;
  };
  // 说明行现在是"排版用假控件"（见 makeSpacer），高度由控件数自己算 —— 这里只需要保证最窄宽度够画那两行字
  const computeSize = nodeType.prototype.computeSize;
  nodeType.prototype.computeSize = function (out) {
    const s = (computeSize ? computeSize.apply(this, arguments) : null) || out || [260, 80];
    if (s && typeof s[0] === "number") s[0] = Math.max(s[0], TOOLBAR_MIN_W);
    return s;
  };
  // ★ 2026-10-08（第一百二十六批 · 他第 2 条）：高度能拖小，装不下的行裁掉 + 右边出现滚轮。
  //   工具栏是**从下往上遮**（控件贴着上边排，拖小先遮住下面那几行）→ 由 web/prompt_scroll.js 统一装（anchor:"top"）。
}

// ==================== 小字橡皮擦（2026-10-07 第一百一十一批 · 他第 4 条） ====================
// 他的原话：「现在的小字太多了，能不能让**游动羽翼工具栏**多出一个功能，一个**可拖拽的橡皮擦**，
//   把橡皮擦拖到小字上面，然后再放开，小字就会消失，**仅限这个节点**，把节点重新叫出来，
//   新的节点就不会有这个问题。」接着定的口径：「擦除范围是**全部**，同时用小字提醒，
//   只会擦掉**当前节点**的小字，新节点不会受到影响。」
//
// 做法：
//   · 所有"小字"都是 `type:"pcText"` 的排版假控件（各节点自己的 makeHintRow / makeSpacer 造的）
//     → 擦 = 把这一行的 draw 换成空函数、高度换 0（**占位也一起收掉**，不留空行）；
//       原来的两个函数存进 `w.__pcErase`，所以能**原样恢复**。
//   · **只记在被擦的那颗节点自己身上**：`node.properties.pcNoHint = ["那句话", …]`（跟着工作流存）
//     → 别的节点、新叫出来的节点、别的工作流都不受影响（正是他要的"新节点不会有这个问题"）。
//   · 读工作流时（loadedGraphNode）按这份名单把行收起来；误擦了在那颗节点上**右键 →「↩ 恢复小字」**。
const HINT_TYPE = "pcText";
const ERASE_KEY = "pcNoHint";
const ROW_H = 20;                  // pcText 行的标准高度

function rowName(w) { return w && typeof w.name === "string" ? w.name : ""; }
function isHintRow(w) { return !!(w && w.type === HINT_TYPE && !w.__pcEraser); }
function hintNames(node) {
  const list = node && node.properties && node.properties[ERASE_KEY];
  return Array.isArray(list) ? list.filter(function (x) { return typeof x === "string"; }) : [];
}
function setRowErased(w, on) {
  if (!w) return false;
  if (on) {
    if (w.__pcErase) return true;
    w.__pcErase = { draw: w.draw, computeSize: w.computeSize };
    w.draw = function () {};
    w.computeSize = function (wd) { return [wd || 200, 0]; };
    return true;
  }
  if (!w.__pcErase) return false;
  w.draw = w.__pcErase.draw;
  w.computeSize = w.__pcErase.computeSize;
  w.__pcErase = null;
  return true;
}
function erasedRows(node) {                       // 这颗节点上"按名单该收起来"的那些行
  const names = hintNames(node);
  return ((node && node.widgets) || []).filter(function (w) {
    return isHintRow(w) && names.indexOf(rowName(w)) >= 0;
  });
}
function applyErasedHints(node) {                 // 读工作流时用：把名单里的行收起来
  try { const rows = erasedRows(node); rows.forEach(function (w) { setRowErased(w, true); }); return rows.length; }
  catch (e) { return 0; }
}
function eraseHint(node, w) {
  if (!node || !isHintRow(w) || w.__pcErase) return false;
  setRowErased(w, true);
  node.properties = node.properties || {};
  const list = hintNames(node).slice();
  const nm = rowName(w);
  if (nm && list.indexOf(nm) < 0) list.push(nm);
  node.properties[ERASE_KEY] = list;
  try { if (node.size) resizeBy(node, -ROW_H); } catch (e) { /* 忽略 */ }
  redraw();
  return true;
}
function restoreHints(node) {                     // 右键「↩ 恢复小字」
  try {
    const rows = erasedRows(node);
    rows.forEach(function (w) { setRowErased(w, false); });
    if (node.properties) node.properties[ERASE_KEY] = [];
    try { if (node.size && rows.length) resizeBy(node, ROW_H * rows.length); } catch (e) { /* 忽略 */ }
    redraw();
    return rows.length;
  } catch (e) { return 0; }
}
// 节点高度 ±N（那一行占的位置一起收掉 / 还回去）。
// ⚠️ 先直接改 size（有些节点/老前端没有 setSize），有 setSize 再调一次让它走正常的重排。
function resizeBy(node, delta) {
  const h = Math.max(70, (node.size ? node.size[1] : 0) + delta);
  node.size[1] = h;
  if (typeof node.setSize === "function") node.setSize([node.size[0], h]);
  // ★ 第一百四十五批（`web/prompt_scroll.js` 改成"记住他拖出来的高度"之后必须补这一句）：
  //   擦掉 / 恢复一行小字也会改这个节点的高度 —— 那是**他动手的高度**，要一起记住；
  //   不然下一帧排版会按"原来那个高度"把它弹回去（看着就像"橡皮擦没把那一行收掉"）。
  try { if (window.__pcScroll && window.__pcScroll.rememberH) window.__pcScroll.rememberH(node, h); } catch (e) { /* 忽略 */ }
}

// 拖拽本体：按住工具栏那颗「🧽」，光标跟着一颗橡皮擦走；松手时命中哪一行就擦哪一行
let eraseDrag = null;                            // ghost / 高亮那两个 DOM
let eraseActive = false;                         // 正在拖（防重复起手 / 保证只收尾一次）
function ensureEraseDom() {
  if (!eraseDrag) eraseDrag = { ghost: null, hl: null };
  if (!eraseDrag.ghost) {
    const g = document.createElement("div");
    g.textContent = "🧽";
    document.body.appendChild(g);
    eraseDrag.ghost = g;
  }
  if (!eraseDrag.hl) {
    const h = document.createElement("div");
    document.body.appendChild(h);
    eraseDrag.hl = h;
  }
  return eraseDrag;
}
function toGraph(ev) {                            // 鼠标事件 → 画布坐标
  const c = app.canvas;
  if (!c) return null;
  try { if (typeof c.convertEventToCanvasOffset === "function") return c.convertEventToCanvasOffset(ev); } catch (e) { /* 忽略 */ }
  try {
    const rect = c.canvas.getBoundingClientRect(), ds = c.ds;
    return [(ev.clientX - rect.left) / ds.scale - ds.offset[0], (ev.clientY - rect.top) / ds.scale - ds.offset[1]];
  } catch (e) { return null; }
}
function rowAt(ev) {                              // 光标底下是哪一行小字（没有就 null）
  const p = toGraph(ev);
  if (!p) return null;
  const nodes = graphNodes();
  for (let i = nodes.length - 1; i >= 0; i--) {   // 后画的在上层，从后往前找
    const n = nodes[i];
    if (!n || !n.widgets || !n.size || n.flags && n.flags.collapsed) continue;
    const lx = p[0] - n.pos[0], ly = p[1] - n.pos[1];
    if (lx < 0 || lx > n.size[0] || ly < 0 || ly > n.size[1]) continue;
    for (const w of n.widgets) {
      if (!isHintRow(w) || w.__pcErase || typeof w.last_y !== "number") continue;
      if (ly >= w.last_y && ly <= w.last_y + ROW_H) return { node: n, w: w };
    }
  }
  return null;
}
function showGhost(ev) {
  const d = ensureEraseDom();
  d.ghost.style.cssText = "position:fixed;display:block;pointer-events:none;z-index:99999;"
    + "left:" + (ev.clientX - 15) + "px;top:" + (ev.clientY - 15) + "px;"
    + "width:30px;height:30px;font-size:24px;line-height:30px;text-align:center;"
    + "filter:drop-shadow(0 1px 3px rgba(0,0,0,.5));";
}
function showHighlight(hit) {
  const d = ensureEraseDom();
  if (!hit) { d.hl.style.display = "none"; return; }
  try {
    const c = app.canvas, ds = c.ds, rect = c.canvas.getBoundingClientRect();
    const x = rect.left + (hit.node.pos[0] + ds.offset[0]) * ds.scale;
    const y = rect.top + (hit.node.pos[1] + hit.w.last_y + ds.offset[1]) * ds.scale;
    d.hl.style.cssText = "position:fixed;display:block;pointer-events:none;z-index:99998;box-sizing:border-box;"
      + "left:" + x + "px;top:" + y + "px;width:" + (hit.node.size[0] * ds.scale) + "px;height:" + (ROW_H * ds.scale) + "px;"
      + "background:rgba(255,90,90,.20);border:1px dashed rgba(255,90,90,.85);";
  } catch (e) { d.hl.style.display = "none"; }
}
function hideEraseDom() {
  if (!eraseDrag) return;
  if (eraseDrag.ghost) eraseDrag.ghost.style.display = "none";
  if (eraseDrag.hl) eraseDrag.hl.style.display = "none";
}
// ★★ 第一百二十六批（他报：「按住橡皮擦拖不动，松开才开始跟手，放不下来也擦不掉，之后鼠标点击还失灵」）：
//   病根 = **不能指望 ComfyUI 把"按下"这一枪转交给我们**。真前端（api-BqIxvqZ8.js）那条链是
//     `processMouseDown`（画布 pointerdown，**capture**）→ `processNodeWidgets` → `getWidgetOnPos` 命中控件行
//       → `processWidgetClick(e,n,d)`：
//           1) `if (typeof n.onPointerDown === 'function' && n.onPointerDown(...)) return`
//           2) `let c = toConcreteWidget(n,t,false); if (c) { r.onClick=…; r.onDrag=… } else if (n.mouse) { n.mouse(e,…) }`
//           3) `r.finally = () => { … n.mouse(eUp,…) }`（松手时也会调一次！）
//   而 `CanvasPointer.down()` 里还有一句 `this.element.setPointerCapture(e.pointerId)` —— 指针一被画布收走，
//   后面谁收到 move/up 就全看画布脸色。只要上面任何一环对不上（命中"具体控件"、事件类型不是 down、
//   或中途抛错导致 `r.finally` 没装上），我们整条链子就断在**起手那一刻**：按下没反应、松手才被 `finally` 那一枪打中
//   → 橡皮擦"松手才开始跟手"、之后再也没有 up 能收尾 → 放不下来、擦不掉，画布的 `node_widget` 还卡着导致点击失灵。
//   → 现在**不再依赖它转交**：自己在 `window` 的**捕获阶段**做命中测试（和画布同一套几何 + `last_y`），
//     按下就接管，并且 `preventDefault + stopPropagation` 把这一次按下**从 LiteGraph 手里截下来**
//     （不让它拖节点 / 平移画布 / 抢指针）；移动和松手 **pointer + mouse 两套都听**，
//     `pointercancel` 也算收尾 —— 保证"一定放得下来"。控件上的 `w.mouse` 留作兜底（真前端如果哪天回到那条路也照样能用）。
function eraseListen(on) {
  const m = on ? "addEventListener" : "removeEventListener";
  try {
    window[m]("pointermove", onEraseMove, true); window[m]("mousemove", onEraseMove, true);
    window[m]("pointerup", onEraseUp, true); window[m]("mouseup", onEraseUp, true);
    window[m]("pointercancel", onEraseUp, true);
  } catch (e) { /* 忽略 */ }
}
function onEraseMove(ev) {
  if (!eraseActive) return;
  try { showGhost(ev); showHighlight(rowAt(ev)); } catch (e) { /* 忽略 */ }
}
function endEraseDrag(ev) {                       // 收尾（松手 / 取消 / 出错兜底都走这里）
  if (!eraseActive) return false;
  eraseActive = false;
  eraseListen(false);
  let hit = null;
  try { hit = ev ? rowAt(ev) : null; } catch (e) { hit = null; }
  hideEraseDom();
  if (hit && eraseHint(hit.node, hit.w)) log("已擦掉一行小字：" + rowName(hit.w));
  return !!hit;
}
function onEraseUp(ev) { endEraseDrag(ev); }
function startEraseDrag(node, ev) {
  if (eraseActive) return true;
  eraseActive = true;
  try { ensureEraseDom(); showGhost(ev); showHighlight(rowAt(ev)); } catch (e) { /* 忽略 */ }
  eraseListen(true);
  redraw();
  return true;
}
// 光标底下是不是"橡皮擦那一行"（捕获阶段用；和 eraserRowOf 同一套几何）
function eraserHitAt(ev) {
  const p = toGraph(ev);
  if (!p) return null;
  const nodes = graphNodes();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n || !n.widgets || !n.size || n.flags && n.flags.collapsed) continue;
    const lx = p[0] - n.pos[0], ly = p[1] - n.pos[1];
    if (lx < 0 || lx > n.size[0] || ly < 0 || ly > n.size[1]) continue;
    const w = eraserRowOf(n, [lx, ly]);
    if (w) return { node: n, w: w };
  }
  return null;
}
function onEraseDownCapture(ev) {
  try {
    if (eraseActive) return;
    if (ev && ev.button != null && ev.button !== 0) return;        // 只认左键
    const hit = eraserHitAt(ev);
    if (!hit) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    if (typeof ev.stopPropagation === "function") ev.stopPropagation();
    startEraseDrag(hit.node, ev);
  } catch (e) { eraseActive = false; eraseListen(false); hideEraseDom(); }
}
function hookErasePressCapture() {
  try {
    if (window.__pcErasePressHooked) return false;
    window.__pcErasePressHooked = true;
    window.addEventListener("pointerdown", onEraseDownCapture, true);
    return true;
  } catch (e) { return false; }
}
function eraserRowOf(node, pos) {                 // 按住的是不是工具栏那颗橡皮擦
  if (!node || !pos || !node.widgets) return null;
  for (const w of node.widgets) {
    if (!w || !w.__pcEraser || typeof w.last_y !== "number") continue;
    if (pos[1] >= w.last_y - 2 && pos[1] <= w.last_y + ROW_H + 2) return w;
  }
  return null;
}
// 每一颗节点都挂一条右键菜单：擦过小字才出现
function addEraseMenu(nodeType) {
  try {
    const orig = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = orig ? orig.apply(this, arguments) : undefined;
      try {
        const n = hintNames(this).length;
        if (n && Array.isArray(options)) {
          options.push({ content: "↩ 恢复小字（" + n + " 行）", callback: () => { restoreHints(this); } });
        }
      } catch (e) { /* 忽略 */ }
      return r;
    };
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 注册
app.registerExtension({
  name: "PromptToolbar.Alias",

  async setup() {
    injectStyle();
    hookAddCustomWidget();
    hookHover();
    hookErasePressCapture();                 // ★ 第一百二十六批：橡皮擦自己接按下（捕获阶段），不再等前端转交
    refreshNodeVer();                        // ★ 第一百四十批：把节点版本问出来，给"打开提示词工具"那条地址做缓存戳
    patchAllNodes();
    try { await fetchAliases(); } catch (e) { log("拉别名表失败", e); }
    patchAllNodes();
    // ★ ⑮：读一次"工作流里带过来的别名"（兜底用），并把存盘那一刻的钩子装上
    try { readGraphAliases(); patchAllNodes(); } catch (e) { /* 忽略 */ }
    ensureAliasSerializeWrap();
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (dlgEl) closeAliasDialog();
      else if (aliasMode) setAliasMode(false);
    });
    log("已就绪（模型别名 + 游动羽翼工具栏）");
    // 「只看选中的」那组的自测钩子
    // 「小字橡皮擦」的自测钩子（2026-10-07）
    window.__pcErase = {
      rows: (node) => (((node && node.widgets) || []).filter(isHintRow).map(rowName)),
      erased: (node) => hintNames(node),
      erase: (node, name) => {
        const w = (((node && node.widgets) || []).filter(function (x) { return rowName(x) === name; })[0]);
        return w ? eraseHint(node, w) : false;
      },
      restore: restoreHints,
      apply: applyErasedHints,
      hit: rowAt,
      rowOf: eraserRowOf,
      hitEraser: eraserHitAt,                     // ★ 第一百二十六批：光标底下是不是橡皮擦那一行（捕获阶段用的那个）
      active: () => eraseActive,                  // ★ 第一百二十六批：是不是正在拖
      cancel: () => endEraseDrag(null),           // ★ 第一百二十六批：测试用（收尾但不擦任何东西）
      pressed: () => !!window.__pcErasePressHooked,   // ★ 第一百二十六批：按下钩子挂上了没
      dragging: () => !!eraseDrag && !!(eraseDrag.ghost && eraseDrag.ghost.style.display !== "none"),
      rowHeight: () => ROW_H,
    };
    window.__pcPark = {
      selected: selectedNodeIds,
      park: parkOthers,
      unpark: unparkAll,
      info: function () { return { stash: parkStash.slice(), keep: parkKeep.slice() }; },
    };
    window.__pcAlias = {
      aliases: () => Object.assign({}, ALIASES),
      // ★ ⑮（第一百一十四批）：工作流里带过来的别名 + 存盘那一刻导出的那张表
      graphAliases: () => Object.assign({}, GRAPH_ALIASES),
      readGraphAliases: () => { const r = readGraphAliases(); patchAllNodes(); return r; },
      exportMap: () => Object.assign({}, graphAliasMap()),
      wrapSerialize: () => ensureAliasSerializeWrap(),
      backendOk: () => backendOk,
      backendMsg: () => backendMsg,
      mode: () => aliasMode,
      setMode: (on) => setAliasMode(!!on),
      kind: (name) => kindOf(name),
      key: (w) => keyOf(w),
      isModelCombo,
      aliasOf,
      patchWidget,
      patchNode,
      patchAll: () => patchAllNodes(),
      openDialog: openAliasDialog,
      dialogOpen: () => !!dlgEl,
      dialogText: () => (dlgEl ? dlgEl.textContent : ""),
      setDialogInput: (v) => { const i = dlgEl && dlgEl.querySelector("[data-alias]"); if (i) i.value = v; return !!i; },
      saveDialog: (v) => saveAliasDialog(v),
      closeDialog: closeAliasDialog,
      openPanel: () => !!openAliasPanel(),
      // ★ 第一百四十九批：第 5 组「设置」的自测钩子
      openSettings: () => !!openSettingsPanel(),
      syncReset: () => syncResetOn(),
      setSyncReset: (on) => setSyncReset(!!on),
      // ★ 234 批：运行前张数确认的自测钩子
      batchWarn: () => batchWarnLimit(),
      setBatchWarn: (n) => setBatchWarnLimit(n),
      scanBatch: () => scanBatchPlan(),
      batchHooked: () => !!(window.app && window.app.queuePrompt && window.app.queuePrompt.__pcBatchWarn),
      batchHookNow: () => ensureBatchWarnHook(),
      batchAsking: () => batchAsking,
      batchBypass: () => batchBypass,
      settingsText: () => (settingsStat ? settingsStatusText() : ""),
      panelOpen: () => !!(panelEl && panelEl.style.display !== "none"),
      panelText: () => (panelEl ? panelEl.textContent : ""),
      closePanel: () => { if (panelEl) panelEl.style.display = "none"; },
      refresh: () => fetchAliases(),
      addNode: (title) => { const t = findClassTypeByTitle(title); return t ? !!addNodeToCanvas(t) : false; },
      clickAdd: (node) => !!addChosenNode(node || graphNodes().filter(function (n) {
        return n && (n.type === TOOLBAR_NODE || n.comfyClass === TOOLBAR_NODE);
      })[0]),
      findType: findClassTypeByTitle,
      panelSections: () => (panelEl ? Array.prototype.map.call(panelEl.querySelectorAll(".pcw-sec"), function (e) { return e.textContent; }) : []),
      openAliasByKey,
      byKey: openAliasByKey,
      aliasGet: (k) => ALIASES[String(k)] || "",
      localAlias: (k, v) => { applyAliasLocal(String(k), v); return true; },
      historyModels: () => Object.assign({}, HISTORY_MODELS || {}),
      loadHistory: () => fetchHistoryModels(),
      move: (ev) => canvasPointerMove(ev),
      tipText: () => (tipEl && tipEl.style.display !== "none" ? tipEl.textContent : ""),
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || !nodeData.name) return;
    addEraseMenu(nodeType);                          // 所有节点：擦过小字就能右键恢复
    if (nodeData.name === TOOLBAR_NODE) { setupToolbarNode(nodeType); return; }
    // 别的节点：新控件挂上来时接上别名（老的 addCustomWidget 钩子已经覆盖大部分情况，这里兜一层）
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      patchNode(this);
      return r;
    };
  },

  nodeCreated(node) {
    patchNode(node);
  },

  // ★ ⑮：工作流打开/换工作流之后 —— 把 `extra.pc_aliases` 里带的别名读进来当兜底（本地优先）
  async afterConfigureGraph() {
    try { readGraphAliases(); patchAllNodes(); } catch (e) { /* 忽略 */ }
    ensureAliasSerializeWrap();
  },

  loadedGraphNode(node) {
    patchNode(node);
    applyErasedHints(node);                          // 2026-10-07：被擦过的小字，读工作流时照样收起来
  },
});



// ==================== ★ 229 批：模型预览图（悬停出图 + 改名时顺手加图）====================
// ★ 229 批：模型预览图（悬停在模型下拉/别名上就浮出图片）
//   他："鼠标悬在 Lora 池对应的 Lora 上面，就会显示对应图片，这个功能要在原版 Lora 节点和原版模型节点同样适用……
//       悬在别名上面，初始那几个 Lora 你自己来添加，也可以在模型别名里面，在改名别名的同时顺手把图片加入"
//   数据来源：① 节点包自带的 web/previews/manifest.json（我从各模型目录的 .preview.* 转出来的）
//             ② localStorage `promptCopier.aliasPreview.v1`（用户在改名弹窗里自己选的图，存成 dataURL）
const PREVIEW_BASE = new URL("./previews/", import.meta.url).href;
let PREVIEW_MANIFEST = null;
let PREVIEW_LOCAL = null;
let previewEl = null;
let previewTimer = null;

function loadPreviewManifest() {
  if (PREVIEW_MANIFEST) return Promise.resolve(PREVIEW_MANIFEST);
  return fetch(PREVIEW_BASE + "manifest.json", { cache: "force-cache" })
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => { PREVIEW_MANIFEST = j || {}; return PREVIEW_MANIFEST; })
    .catch(() => { PREVIEW_MANIFEST = {}; return PREVIEW_MANIFEST; });
}
function loadPreviewLocal() {
  if (PREVIEW_LOCAL) return PREVIEW_LOCAL;
  try { PREVIEW_LOCAL = JSON.parse(localStorage.getItem("promptCopier.aliasPreview.v1") || "{}") || {}; }
  catch (e) { PREVIEW_LOCAL = {}; }
  return PREVIEW_LOCAL;
}
function savePreviewLocal(map) {
  PREVIEW_LOCAL = map || {};
  try { localStorage.setItem("promptCopier.aliasPreview.v1", JSON.stringify(PREVIEW_LOCAL)); } catch (e) { log("预览图存不下（太大了）"); }
}
// kind = "loras" | "checkpoints"；name = 文件名
function previewUrlFor(kind, name) {
  const key = String(kind) + "/" + String(name);
  const local = loadPreviewLocal()[key];
  if (local) return local;                                    // 用户自己选的优先
  const m = PREVIEW_MANIFEST || {};
  // ⚠️ manifest 里存的是 "previews/xxx.jpg"，BASE 已经带 previews/ 了 → 要剥掉前缀，不然会变成 previews/previews/
  if (m[key]) {
    const rel = String(m[key]).replace(/^previews[\\/]/, "");
    return PREVIEW_BASE + rel;
  }
  // 兜底：按名字猜（loras/xxx.safetensors → previews/loras-<md5前12>.jpg 猜不出来，只能靠 manifest）
  return "";
}
function ensurePreviewEl() {
  if (previewEl) return previewEl;
  previewEl = document.createElement("div");
  previewEl.id = "pcPreviewTip";
  previewEl.style.cssText = "position:fixed;z-index:10070;pointer-events:none;display:none;"
    + "border:1px solid rgba(150,162,180,.6);border-radius:10px;overflow:hidden;"
    + "box-shadow:0 10px 30px rgba(0,0,0,.55);background:#12161d";
  const img = document.createElement("img");
  img.style.cssText = "display:block;max-width:260px;max-height:260px";
  const cap = document.createElement("div");
  cap.style.cssText = "font:11px/1.4 system-ui,'Microsoft YaHei',sans-serif;color:#dfe5f1;"
    + "padding:4px 7px;background:rgba(18,22,29,.92);max-width:260px;overflow:hidden;"
    + "text-overflow:ellipsis;white-space:nowrap";
  previewEl.appendChild(img);
  previewEl.appendChild(cap);
  document.body.appendChild(previewEl);
  return previewEl;
}
function showPreview(url, label, x, y) {
  if (!url) return;
  const el = ensurePreviewEl();
  const img = el.querySelector("img");
  const cap = el.querySelector("div");
  img.src = url;
  cap.textContent = label || "";
  el.style.display = "block";
  // 位置：贴光标右侧，出界就翻到左边/上边
  const w = 270, h = 290;
  let left = x + 18, top = y + 14;
  if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 18);
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  el.style.left = left + "px";
  el.style.top = top + "px";
}
function hidePreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  if (previewEl) previewEl.style.display = "none";
}
// 给某个 widget（模型下拉）挂"悬停看预览"
function hookWidgetPreview(node, widget) {
  if (!widget || widget.__pcPrevHooked) return;
  widget.__pcPrevHooked = true;
  const kind = kindOf(widget.name);
  if (kind !== "loras" && kind !== "checkpoints") return;
  const prevMove = node.onMouseMove;
  node.onMouseMove = function (e, localPos, canvas) {
    try {
      if (prevMove) prevMove.call(this, e, localPos, canvas);
    } catch (er) { /* 忽略 */ }
    try {
      const y = localPos[1];
      let hit = null;
      for (const w of (node.widgets || [])) {
        if (w !== widget) continue;
        const ly = w.last_y == null ? null : w.last_y;
        if (ly == null) continue;
        const hgt = (typeof w.computeSize === "function" ? (w.computeSize(node.size)[1] || 20) : 20);
        if (y >= ly && y <= ly + hgt) hit = w;
      }
      if (hit) {
        if (!previewTimer && !(previewEl && previewEl.style.display === "block")) {
          const nm = String(widget.value || "");
          const label = (ALIASES[keyOf(widget)] || "") + (ALIASES[keyOf(widget)] ? "（" + nm + "）" : nm);
          previewTimer = setTimeout(() => {
            previewTimer = null;
            const url = previewUrlFor(kind, nm);
            if (url) showPreview(url, label, e.clientX, e.clientY);
          }, 300);
        }
      } else hidePreview();
    } catch (e2) { /* 忽略 */ }
  };
  // 鼠标离开节点就收起
  if (!node.__pcPrevLeaveHooked) {
    node.__pcPrevLeaveHooked = true;
    const prevOut = node.onMouseLeave;
    node.onMouseLeave = function () { try { if (prevOut) prevOut.call(this); } catch (e) { /* 忽略 */ } hidePreview(); };
  }
}

// 改名弹窗里"顺手加图"：选一张本地图片 → 缩到 320px → 存 dataURL
function attachPreviewPicker(box, key) {
  try {
    const body = box.querySelector(".pcw-body");
    if (!body) return;
    const kind = String(key).split("/")[0];
    const name = String(key).split("/").slice(1).join("/");
    const row = document.createElement("div");
    row.className = "pcw-row";
    row.style.cssText = "margin-top:8px;align-items:center;gap:8px";
    const btn = document.createElement("button");
    btn.className = "pcw-btn";
    btn.type = "button";
    btn.textContent = "📷 选一张预览图";
    btn.dataset.pickimg = "1";
    const state = document.createElement("span");
    state.className = "pcw-muted";
    state.textContent = previewUrlFor(kind, name) ? "（已有预览图）" : "（还没有预览图）";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.style.display = "none";
    file.dataset.pickimgfile = "1";
    btn.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const im = new Image();
        im.onload = () => {
          const c = document.createElement("canvas");
          const scale = Math.min(1, 320 / Math.max(im.width, im.height));
          c.width = Math.max(1, Math.round(im.width * scale));
          c.height = Math.max(1, Math.round(im.height * scale));
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          const url = c.toDataURL("image/jpeg", 0.86);
          const map = loadPreviewLocal();
          map[kind + "/" + name] = url;
          savePreviewLocal(map);
          state.textContent = "（已设好预览图 ✓）";
          try { showPreview(url, name, window.innerWidth / 2, 120); setTimeout(hidePreview, 1200); } catch (e) { /* 忽略 */ }
        };
        im.src = String(rd.result || "");
      };
      rd.readAsDataURL(f);
    });
    row.appendChild(btn); row.appendChild(state); row.appendChild(file);
    body.appendChild(row);
  } catch (e) { log("挂预览图选择器失败", e); }
}

try {
  window.__pcPreview = {
    url: previewUrlFor, show: showPreview, hide: hidePreview,
    manifest: () => PREVIEW_MANIFEST, local: () => loadPreviewLocal(),
    setLocal: (kind, name, dataUrl) => {
      const map = loadPreviewLocal();
      map[kind + "/" + name] = dataUrl;
      savePreviewLocal(map);
      return true;
    },
    setLocalFor: (key, dataUrl) => {
      const map = loadPreviewLocal();
      map[String(key)] = dataUrl;
      savePreviewLocal(map);
      return true;
    },
  };
  loadPreviewManifest();
} catch (e) { /* 忽略 */ }
