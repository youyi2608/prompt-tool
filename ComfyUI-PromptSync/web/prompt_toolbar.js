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
import { app } from "../../scripts/app.js";

const ALIAS_API = "/prompt_sync/aliases";
const TOOLBAR_NODE = "PromptToolToolbar";
const TOOLBAR_COMBO = "要添加的节点";
const ALIAS_BG = "rgba(255, 255, 255, 0.13)";      // 别名那行的灰底（深浅主题下都看得清）
const ALIAS_MODE_OUTLINE = "rgba(255, 196, 92, 0.95)";

function log(...args) { console.log("[游动羽翼工具栏]", ...args); }

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
let backendOk = false;
let backendMsg = "";

function aliasOf(widget) {
  const a = ALIASES[keyOf(widget)];
  return a ? String(a) : "";
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
  redraw();
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

function patchWidget(widget) {
  if (!widget || widget.__pcAliasPatched) return false;
  if (!isModelCombo(widget)) return false;
  widget.__pcAliasPatched = true;

  // ① 显示别名：ComboWidget 原生支持 getOptionLabel —— 画布上的文字和下拉列表都走它，value 纹丝不动
  try {
    widget.options = widget.options || {};
    const prev = widget.options.getOptionLabel;
    widget.options.getOptionLabel = function (v) {
      if (v) {
        const a = ALIASES[kindOf(widget.name) + "/" + String(v)];
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

  // ③ 别名模式：亮边提示「这个能改」；平时什么都不画
  try {
    const origDraw = widget.drawWidget;
    if (typeof origDraw === "function") {
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

  return true;
}

function patchNode(node) {
  if (!node || !Array.isArray(node.widgets)) return 0;
  let n = 0;
  for (const w of node.widgets) if (patchWidget(w)) n++;
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
  .pcw-sec{margin:2px 0 6px;font-weight:600;font-size:12.5px;color:#cdd6e1;border-bottom:1px dashed #3d444d;padding-bottom:4px}
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
  try {
    await postAlias({ key: key, alias: text });
    log(text ? `别名已保存：${key} → ${text}` : `别名已清除：${key}`);
    closeAliasDialog();
    if (panelEl) renderPanelBody();
  } catch (e) {
    if (dlgEl) {
      const note = dlgEl.querySelector("[data-note]") || document.createElement("div");
      note.setAttribute("data-note", "1");
      note.className = "pcw-muted";
      note.style.color = "#ff9a9a";
      note.style.marginTop = "8px";
      note.textContent = "没存上：" + e.message;
      dlgEl.querySelector(".pcw-body").appendChild(note);
    }
  }
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
    try { await postAlias({ key: key, alias: input.value }); box.remove(); renderPanelBody(); }
    catch (e) { log("存别名失败", e); }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") box.querySelector("[data-save]").click(); });
  setTimeout(() => { try { input.focus(); input.select(); } catch (e) { /* 忽略 */ } }, 30);
}

function canvasModelRows() {
  const rows = [];
  for (const node of graphNodes()) {
    if (!Array.isArray(node.widgets)) continue;
    for (const w of node.widgets) {
      if (!w || !w.__pcAliasPatched) continue;
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

  body.innerHTML = `
    <div class="pcw-row" style="margin-bottom:10px">
      <button class="pcw-btn primary" data-pick="1">✎ 点一下画布改名</button>
      <button class="pcw-btn" data-refresh="1">🔄 刷新</button>
      ${backendOk ? "" : `<span class="pcw-muted" style="color:#ffb4b4">${esc(backendMsg)}</span>`}
    </div>
    <div class="pcw-sec">画布上的模型栏位（${rows.length}）</div>
    <div class="pcw-list">${rows.length ? rows.map(rowHtml).join("") : `<div class="pcw-muted">画布上还没有带模型下拉的节点。</div>`}</div>
    <div class="pcw-sec">已经改过别名的（${keys.length}）</div>
    <div class="pcw-list">${keys.length ? keys.map(aliasHtml).join("") : `<div class="pcw-muted">还没改过。改过的才会出现在这里，不会把上千个文件都列出来。</div>`}</div>
    <div class="pcw-sec">历史记录里用过的模型栏位（${HISTORY_MODELS === null ? "…" : histKeys.length}）</div>
    <div class="pcw-list">${histKeys.length ? histKeys.map(histHtml).join("")
      : `<div class="pcw-muted">${HISTORY_MODELS === null ? "正在读历史记录…" : "还没读到历史记录（在 ComfyUI 里跑过图之后这里就会出现）。"}</div>`}</div>
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
  body.querySelectorAll("[data-del-key]").forEach((b) => b.addEventListener("click", async () => {
    const key = keys[Number(b.dataset.delKey)];
    try { await postAlias({ key: key, alias: "" }); renderPanelBody(); } catch (e) { log("删别名失败", e); }
  }));
}

function openAliasPanel() {
  injectStyle();
  if (!panelEl) {
    panelEl = makeBox("模型别名（游动羽翼工具栏）", 620);
    panelEl.querySelector(".pcw-x").addEventListener("click", () => {
      panelEl.style.display = "none";
      setAliasMode(false);
    });
  }
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
    node.addCustomWidget(makeSpacer("2. 改模型别名", "rgba(160, 172, 192, 0.95)", { bold: true }));
    node.addWidget("button", "✎ 模型别名（点击这个按钮可以修改当前页面的模型栏位别名）", null, () => {
      openAliasPanel();
    }, { serialize: false });
    node.addCustomWidget(makeSpacer("3. 打开提示词工具（网页版）", "rgba(160, 172, 192, 0.95)", { bold: true }));
    // 从 ComfyUI 里打开工具：这个地址和 ComfyUI **同源**，互通 / 套图 / AI 全都连得上
    // （双击分享包里那份 HTML 是 file://，会被 ComfyUI 的跨源保护挡掉；分享包的 bat 已经加了
    //   --enable-cors-header 兜底，但**同源页面永远是最稳的那条路**）
    node.addWidget("button", "🌐 打开提示词工具（同源网页版，推荐）", null, () => {
      const url = new URL("/extensions/ComfyUI-PromptSync/prompt_tool.html", location.href).href;
      window.open(url, "_blank");
    }, { serialize: false });
    node.addCustomWidget(makeSpacer("本节点不参与工作流；别名只改显示，文件名一个都不动", "rgba(150, 162, 180, 0.72)", {}));
    for (const w of rest) node.addCustomWidget(w);      // 别的控件（以后加的）原样接在后面
    if (combo) patchToolbarCombo(combo);
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
  // 说明行现在是"排版用假控件"（见 makeSpacer），高度由控件数自己算 —— 这里只需要保证最窄宽度够画那两行字
  const computeSize = nodeType.prototype.computeSize;
  nodeType.prototype.computeSize = function (out) {
    const s = (computeSize ? computeSize.apply(this, arguments) : null) || out || [260, 80];
    if (s && typeof s[0] === "number") s[0] = Math.max(s[0], TOOLBAR_MIN_W);
    return s;
  };
}

// ---------------------------------------------------------------- 注册
app.registerExtension({
  name: "PromptToolbar.Alias",

  async setup() {
    injectStyle();
    hookAddCustomWidget();
    hookHover();
    patchAllNodes();
    try { await fetchAliases(); } catch (e) { log("拉别名表失败", e); }
    patchAllNodes();
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (dlgEl) closeAliasDialog();
      else if (aliasMode) setAliasMode(false);
    });
    log("已就绪（模型别名 + 游动羽翼工具栏）");
    window.__pcAlias = {
      aliases: () => Object.assign({}, ALIASES),
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
      historyModels: () => Object.assign({}, HISTORY_MODELS || {}),
      loadHistory: () => fetchHistoryModels(),
      move: (ev) => canvasPointerMove(ev),
      tipText: () => (tipEl && tipEl.style.display !== "none" ? tipEl.textContent : ""),
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || !nodeData.name) return;
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

  loadedGraphNode(node) {
    patchNode(node);
  },
});
