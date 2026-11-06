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

// ==================== ★ 193 批：三档尺寸（不再允许自由拖宽高）====================
//   他原话：「lora 池在管理中设置档位大中小，小档位下框框一排，中档位下框框两排，大档位下框框三排，
//   大中小档位对应一二三倍宽度的同时，也对应一二三倍高度，lora 池不允许自定义宽度高度」
//   → 档位存进节点状态（跟着工作流走）：宽高 = 1/2/3 倍，胶囊框 = 1/2/3 排。
const LP_BASE = [475, 450];                              // ★ 208 批：小档放大 25%（380×360 → 475×450）
const LP_OVER = 82;                                      // 除面板外，节点还占掉的高度（实测）
const LP_SIZE = {                                        // 三档（208 批：中/大各缩 15%）
  s: { box: [475, 450], rows: 1, cols: 1, label: "小" },
  m: { box: [646, 612], rows: 2, cols: 2, label: "中" },
  l: { box: [969, 918], rows: 3, cols: 3, label: "大" },
};
function sizeKeyOf(st) { return (st && LP_SIZE[st.lpSize]) ? st.lpSize : "s"; }
function sizeBoxOf(key) {
  const e = LP_SIZE[key] || LP_SIZE.s;
  return [e.box[0], e.box[1]];
}
function capsRowsH(rows) { return 14 + rows * 32; }        // 一排胶囊 ~32px + 上下内边距
// 把档位落到节点上：改节点尺寸 + 胶囊框排数 + 参数列表列数
function applySize(node, key) {
  const k = LP_SIZE[key] ? key : "s";
  const box = sizeBoxOf(k);
  try { if (node.setSize) node.setSize([box[0], box[1]]); } catch (e) { /* 忽略 */ }
  try {
    if (node.__lpCaps) {
      const h = capsRowsH(LP_SIZE[k].rows);
      node.__lpCaps.style.minHeight = h + "px";
      node.__lpCaps.style.maxHeight = h + "px";
    }
  } catch (e) { /* 忽略 */ }
  // ★ 194 批：参数那一栏一排显示几个（小 1 / 中 2 / 大 3）
  try {
    if (node.__lpBox) node.__lpBox.style.gridTemplateColumns = "repeat(" + LP_SIZE[k].cols + ", minmax(0,1fr))";
  } catch (e) { /* 忽略 */ }
  try { if (node.__lpW && node.__lpW.computeSize) node.__lpW.computeSize(); } catch (e) { /* 忽略 */ }
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
}

function log(...a) { console.log("[LoraPool]", ...a); }
function clamp(v) {
  v = Math.round(Number(v) / STEP) * STEP;
  return Math.max(VMIN, Math.min(VMAX, Math.round(v * 100) / 100));
}
function stateWidget(node) {
  const ws = node && node.widgets;
  if (!Array.isArray(ws)) return null;
  return ws.find((w) => w && w.name === "状态") || null;
}
function readState(node) {
  const w = stateWidget(node);
  let o = null;
  try { o = JSON.parse(String((w && w.value) || "") || "null"); } catch (e) { o = null; }
  if (!o || !Array.isArray(o.loras)) o = { mode: "model", loras: [] };
  if (o.mode !== "clip") o.mode = "model";
  if (!LP_SIZE[o.lpSize]) o.lpSize = "s";          // ★ 193 批：尺寸档位（小/中/大，跟着工作流走）
  o.loras.forEach((r) => {
    r.name = String(r.name || "");
    r.on = r.on !== false;
    r.model = clamp(r.model == null ? 1 : r.model);
    r.clip = clamp(r.clip == null ? 1 : r.clip);
  });
  return o;
}
function writeState(node, st) {
  const w = stateWidget(node);
  if (!w) return;
  try { w.value = JSON.stringify(st); } catch (e) { /* 忽略 */ }
  try { node.graph && node.graph.change && node.graph.change(); } catch (e) { /* 忽略 */ }
}
function sorted(st) {                       // 停的排到最后（他：暂时隐藏的排到不隐藏的后一个）
  return st.loras.slice().sort((a, b) => (a.on === b.on) ? 0 : (a.on ? -1 : 1));
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
  el.style.cssText = [
    "display:flex", "align-items:center", "gap:7px", "flex:0 0 auto", "height:34px",
    "padding:0 6px", "border-radius:8px", "border:1px solid rgba(150,162,180,.26)",
    "background:" + (row.on ? "rgba(255,255,255,.05)" : "rgba(255,255,255,.02)"),
    "opacity:" + (row.on ? "1" : ".55"),
  ].join(";");

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
  pill.title = row.on ? "点一下：暂时不用（不参与生成，排到最后）" : "点一下：重新参与生成";
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    row.on = !row.on;
    writeState(node, st); rerender();
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

  const del = document.createElement("div");
  del.textContent = "✕";
  del.style.cssText = "flex:0 0 auto;width:16px;text-align:center;cursor:pointer;opacity:.55;font-size:11px";
  del.title = "从池子里删掉这颗";
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
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
  });
  // ★ 194 批（他："在参数上滚轮会调整参数，这个效果关掉，会影响拖动体验"）→ 滚轮调强度**删掉**，
  //   滚轮现在只用来滚列表（不然在滑杆上滚一下数值就变了，还挡住整页滚动）。

  el.appendChild(name);
  el.appendChild(track);
  el.appendChild(num);
  // ★ 196 批（他："Lora 池下面框框右边的小叉叉根本不需要，因为不要这个节点的话，
  //   直接通过管理把节点吐出来就行，不应该有删除键"）：
  //   **从画布吃进来的**那些（src==="node"）不给 ✕ —— 要走「管理 → 吐出来」才算干净；
  //   他自己手动加的（没有节点在背后）才留 ✕，不然就删不掉了。
  if (row.src !== "node") el.appendChild(del);
  paint();
  return el;
}

function render(node) {
  const box = node.__lpBox;
  if (!box) return;
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
  st.loras.forEach((row) => caps.appendChild(buildCap(node, st, row)));
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
    "border:1px solid " + (row.on ? "#8a72ff" : "#5b6273"),
    "background:" + (row.on ? "#3d3170" : "#2a2e3a"),
    "color:" + (row.on ? "#efe9ff" : "#98a0b3"),
    "opacity:1",
  ].join(";");
  const txt = document.createElement("span");
  // 有别名就显示别名（鼠标悬上去能看真文件名）；没有就用文件名
  const al = aliasOf(row.name);
  txt.textContent = labelOf(row.name);
  txt.style.cssText = "overflow:hidden;text-overflow:ellipsis;max-width:150px";
  c.appendChild(txt);
  c.title = (al ? (al + "（" + row.name + "）") : row.name)
    + "\n点一下：" + (row.on ? "暂时失效（不参与生图，留在原位）" : "恢复参与生图")
    + "\n按住左右拖：换叠 LoRA 的顺序　·　双击：给它起个模型别名";
  // 点 = 暂时失效 / 恢复
  let dragged = false;
  c.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dragged) { dragged = false; return; }
    row.on = !row.on;
    writeState(node, st); render(node);
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
            var st = readState(node);
            var box = sizeBoxOf(sizeKeyOf(st));
            return [Math.max(240, box[0] - 16), Math.max(90, box[1] - LP_OVER)];
          };
          try { node.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
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
  // ★ 193 批：档位切换（探针 / 自检用；真界面在「管理」里点）
  setSize: (n, key) => {
    try {
      const st = readState(n); st.lpSize = LP_SIZE[key] ? key : "s"; writeState(n, st);
      applySize(n, st.lpSize); render(n);
      return true;
    } catch (e) { log("切档失败", e); return false; }
  },
  sizeOf: (n) => {
    try {
      const st = readState(n); const box = sizeBoxOf(sizeKeyOf(st));
      const cs = n.__lpW && n.__lpW.computeSize ? n.__lpW.computeSize() : [0, 0];
      return { key: sizeKeyOf(st), node: [Math.round(n.size[0]), Math.round(n.size[1])], box, widget: cs,
        rows: LP_SIZE[sizeKeyOf(st)].rows, cols: LP_SIZE[sizeKeyOf(st)].cols,
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
      writeState(hit, st);
      app.graph.remove(src);            // 吃掉：节点从画布消失
      render(hit);
      toast(hit, "吃掉了「" + name + "」—— 想吐回来点旁边的「管理」");
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

// 管理键：列出"从节点吃进来的"那些，能吐回画布
function openManager(node) {
  const st = readState(node);
  const rows = st.loras.slice();   // ★ 208 批：池子里所有行都能吐（他也说过"太不合理了"）
  const body = document.createElement("div");

  // ★ 193 批：「管理」里选档位（小 / 中 / 大 = 宽高 1/2/3 倍、胶囊框 1/2/3 排）
  const szRow = document.createElement("div");
  szRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap";
  const szLab = document.createElement("span");
  szLab.textContent = "档位：";
  szLab.style.cssText = "font-size:11.5px;opacity:.85";
  szRow.appendChild(szLab);
  const cur = sizeKeyOf(st);
  ["s", "m", "l"].forEach((k) => {
    const info = LP_SIZE[k];
    const box = sizeBoxOf(k);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = info.label + "（" + box[0] + "×" + box[1] + "）";
    b.title = "宽 " + box[0] + " × 高 " + box[1] + " · 上面那个框 " + info.rows + " 排";
    b.style.cssText = "font-family:inherit;font-size:11.5px;padding:4px 10px;border-radius:8px;cursor:pointer;"
      + (k === cur
        ? "border:1px solid rgba(124,92,255,.95);background:rgba(124,92,255,.28);color:#efe9ff;font-weight:700"
        : "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1");
    b.addEventListener("click", () => {
      const st2 = readState(node);
      st2.lpSize = k;
      writeState(node, st2);
      applySize(node, k);
      render(node);
      toast(node, "档位改成「" + LP_SIZE[k].label + "」（宽高 " + box[0] + "×" + box[1] + "，框 " + LP_SIZE[k].rows + " 排）");
      try { closeMini(); } catch (e) { /* 忽略 */ }
    });
    szRow.appendChild(b);
  });
  const szNote = document.createElement("div");
  szNote.textContent = "尺寸只由档位决定，不能拖";
  szNote.style.cssText = "font-size:11px;opacity:.6;width:100%";
  szRow.appendChild(szNote);
  body.appendChild(szRow);

  const tip = document.createElement("div");
  tip.textContent = rows.length
    ? "下面这些是池子里的 LoRA（不管是从画布吃进来的、还是自己加的都能吐）。点「吐出来」会把一个 LoraLoader 放回画布；点行里的「用/停」只是暂时不参与。"
    : "还没有吃掉任何 LoRA 节点 —— 把画布上的 LoraLoader 节点直接拖到这个池子上面松手就行。";
  tip.style.cssText = "font-size:11.5px;opacity:.8;line-height:1.6;margin-bottom:8px";
  body.appendChild(tip);
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow:auto";
  body.appendChild(list);
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
  body.appendChild(list);

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
  function paintSaves() {
    savedBox.innerHTML = "";
    const arr = readSaves();
    if (!arr.length) {
      const d = document.createElement("div");
      d.textContent = "还没存过组合。";
      d.style.cssText = "font-size:11px;opacity:.6";
      savedBox.appendChild(d); return;
    }
    arr.slice().reverse().forEach((it, ridx) => {
      const i = arr.length - 1 - ridx;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;border:1px solid rgba(150,162,180,.3);border-radius:8px;padding:5px 8px;font-size:11.5px";
      const nm = document.createElement("div");
      nm.textContent = (it.name || "（无名）") + " · " + (it.loras || []).length + " 颗";
      nm.title = (it.loras || []).map((x) => x.name).join("
");
      nm.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const bLoad = document.createElement("button");
      bLoad.type = "button"; bLoad.textContent = "读取";
      bLoad.style.cssText = "flex:0 0 auto;height:22px;padding:0 8px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;"
        + "border:1px solid rgba(56,189,248,.7);background:rgba(56,189,248,.18);color:#dff3ff";
      bLoad.addEventListener("click", () => {
        const st3 = readState(node);
        st3.loras = (it.loras || []).map((x) => ({ name: x.name, on: !!x.on, model: x.model, clip: x.clip, src: x.src }));
        writeState(node, st3); render(node);
        toast(node, "已读回组合「" + (it.name || "无名") + "」（" + st3.loras.length + " 颗）");
        try { closeMini(); } catch (e) { /* 忽略 */ }
      });
      const bDel = document.createElement("button");
      bDel.type = "button"; bDel.textContent = "删";
      bDel.style.cssText = "flex:0 0 auto;height:22px;padding:0 7px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;"
        + "border:1px solid rgba(255,120,120,.55);background:rgba(255,120,120,.14);color:#ffb4b4";
      bDel.addEventListener("click", () => {
        const a2 = readSaves(); a2.splice(i, 1); writeSaves(a2); paintSaves();
      });
      row.appendChild(nm); row.appendChild(bLoad); row.appendChild(bDel);
      savedBox.appendChild(row);
    });
  }
  bSave.addEventListener("click", () => {
    const st4 = readState(node);
    const name = String(inp.value || "").trim() || ("组合 " + new Date().toLocaleString());
    const a = readSaves();
    a.push({ name: name, at: Date.now(), loras: st4.loras.map((x) => ({ name: x.name, on: !!x.on, model: x.model, clip: x.clip, src: x.src })) });
    writeSaves(a); inp.value = ""; paintSaves();
    toast(node, "已存下组合「" + name + "」（" + st4.loras.length + " 颗）");
  });
  paintSaves();
  body.appendChild(sec);
  showMini(node, "⚙ LoRA 管理", body);
}

// 一个极简的浮层（不走浏览器 alert/dialog，免得挡画布）
let miniEl = null;
function closeMini() { if (miniEl && miniEl.parentNode) miniEl.parentNode.removeChild(miniEl); miniEl = null; }
function showMini(node, title, body) {
  closeMini();
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:99999;left:50%;top:50%;transform:translate(-50%,-50%);"
    + "width:min(420px,90vw);background:#1d2230;color:#e8eaf1;border:1px solid rgba(150,162,180,.45);"
    + "border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.5);padding:14px 16px;"
    + "font:12px/1.6 system-ui,'Microsoft YaHei',sans-serif";
  const head = document.createElement("div");
  head.textContent = title;
  head.style.cssText = "font-size:13px;font-weight:700;margin-bottom:8px";
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "关闭";
  close.style.cssText = "margin-top:10px;height:26px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;"
    + "font-size:11.5px;border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.07);color:#e8eaf1;float:right";
  close.addEventListener("click", closeMini);
  box.appendChild(head); box.appendChild(body); box.appendChild(close);
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
