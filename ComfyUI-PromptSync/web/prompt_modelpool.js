// 模型池 —— 2026-11-03 他第 5 条：
//   「需要开发模型池了，因为我要下载 moss，但是原来 Anima 生的图仍然有其画风优势。moss 的画风依赖画师串，
//    画师串没有 Lora 稳定，所以需要两种模型并行」
//   「模型池仍然采用 lora 池吃节点的逻辑，不过相对来讲会有些复杂」
//   「以 Anima Base 为例，它的模型一共三个节点，UNET 加载器加载 CLIP 加载 VAE。UNET 就有一个参数要调，
//    CLIP 有两个参数要调，参数实在太占 UI……建议是，点击齿轮，跳出弹窗，里面的参数就是当前这个模型的参数」
//   「模型池上中下三个框框，吃掉的节点放进什么框框里面，**就由输出口是模型还是 CLIP 还是 VAE 来决定**」
//   「Checkpoint 可以一口气一个节点连三条线，所以假如这种情况，那就是模型那个框框是实的模块，
//    另外两个是 50% 灰色压住的状态」
//   「在设置中点击哪 3 个节点为一套节点」→ 已简化：**拖进来的节点按类型自动归位，填满当前这一套**（他 2026-11-03 认可）
//   「如果有两套使用同一个 clip，那么 clip 也会显示两个」→ 池子里每条记录各自存文件+参数，天然独立
//   「每一套组合都会并排，排在一竖排上」→ 每套一张卡，竖向排；卡里上中下三个槽
//   「弹窗中也可以设置当前组合生图的时候，Lora 池要不要打开」
//   「顺便一提，和 Lora 池一样，设置里面调整一倍、二倍、三倍长度与宽度」
import { app } from "../../scripts/app.js";

const NODE = "PromptToolModelPool";
const MP_W_BASE = 520, MP_H_BASE = 470;
const MUL_LABEL = { 1: "一倍", 2: "二倍", 3: "三倍" };
const FIELDS = {
  unet: { name: "unet_name" },
  clip: { name: "clip_name" },
  vae: { name: "vae_name" },
  ckpt: { name: "ckpt_name" },
};

function log(...a) { console.log("[ModelPool]", ...a); }
function mul(v) { const n = Number(v) || 1; return Math.max(1, Math.min(3, Math.round(n))); }
function toast(node, msg, bad) {
  log((bad ? "⚠ " : "") + msg);
  try {
    const em = app && app.extensionManager;
    if (em && em.toast && typeof em.toast.add === "function") {
      em.toast.add({ severity: bad ? "warn" : "info", summary: "模型池", detail: String(msg), life: 4200 });
      return;
    }
  } catch (e) { /* 忽略 */ }
}

// ---------------- 状态 ----------------
function readState(node) {
  try {
    const w = (node.widgets || []).find((x) => x && x.name === "状态");
    const st = JSON.parse((w && w.value) || "{}");
    if (!st || typeof st !== "object") return { rows: [], cur: 0, mpW: 1, mpH: 1 };
    if (!Array.isArray(st.rows)) st.rows = [];
    st.rows = st.rows.map((r, i) => {
      const o = (r && typeof r === "object") ? r : {};
      return {
        kind: o.kind === "ckpt" ? "ckpt" : "unet",
        unet: o.unet || "", clip: o.clip || "", vae: o.vae || "", ckpt: o.ckpt || "",
        dtype: o.dtype || "default",
        clipType: o.clipType || "stable_diffusion",
        clipDevice: o.clipDevice || "default",
        loraPool: o.loraPool !== false,
        // ⚠️ 旧记录里存过 "UNET：xxx" / "Checkpoint：xxx" —— 读的时候一起洗干净（他要求省略 UNET）
        name: String(o.name || "").replace(/^(UNET|Checkpoint)\s*[:：]\s*/i, "") || ("第 " + (i + 1) + " 套"),
        // ★ 2026-11-04（他第 4 条）：「齿轮里面改成可以调整本身框框的别名以及三个文件的别名」
        unetAlias: o.unetAlias || "", clipAlias: o.clipAlias || "", vaeAlias: o.vaeAlias || "",
      };
    });
    st.cur = Math.max(0, Math.min(st.rows.length - 1, Number(st.cur) || 0));
    st.mpW = mul(st.mpW); st.mpH = mul(st.mpH);
    return st;
  } catch (e) { return { rows: [], cur: 0, mpW: 1, mpH: 1 }; }
}
function writeState(node, st) {
  try {
    const w = (node.widgets || []).find((x) => x && x.name === "状态");
    if (!w) return;
    w.value = JSON.stringify(st);
    node.setDirtyCanvas && node.setDirtyCanvas(true, false);
    try { app.graph.setDirtyCanvas(true, false); } catch (e) { /* 忽略 */ }
  } catch (e) { log("写状态失败", e); }
}
// ★ 2026-11-04（他第三批第 3 条）：尺寸口径**重新定死** ——
//   **宽度 1 倍 = 一排 2 个组合**（3 倍 = 一排 6 个）；**高度 1 倍 = 一列**（3 倍 = 三列）。
//   模块固定一列 = 132 宽 / 128 高（标签一行、名字一行），行列都按这个基准乘出来。
// ★ 2026-11-04（他第四次报"模型池还是少了一排，就是勾选联通 LoRA 池那个选项"）：
//   158 在他那儿仍然不够（文件名一换行就顶出去），**再放宽到 172**，并且不再用 overflow:hidden
//   把它硬裁 —— "高度 1 倍 = 一列"这个口径不变，只是这一列更高。
const MP_MOD_W = 132, MP_MOD_H = 172, MP_GAP = 7;
function sizeWH(st) {
  const wMul = mul(st && st.mpW), hMul = mul(st && st.mpH);
  const perRow = 2 * wMul;            // 一排几个组合
  const rows = hMul;                  // 几列（行数）
  // 宽度：一排 perRow 个模块 + 间距 + 外壳固定开销
  //   （面板左右 14 + 外框 padding 12 + 外框边框 2 + 节点到面板 16 = 44）+ **给竖向滚动条留 22**
  //   —— 不留这 22，内容一超高滚动条就挤掉一行，实测 1 倍宽只能排 3 个而不是 4 个。
  return [
    Math.round(perRow * MP_MOD_W + (perRow - 1) * MP_GAP + 66),
    Math.round(34 + rows * MP_MOD_H + (rows - 1) * MP_GAP + 24),
  ];
}
// ★ 他第 4 条（第二次反馈：「模型池调到两倍高度的时候，会出现显示问题」）：
//   上一版这里有个"量屏幕坐标再往下收"的兜底，换算不准 —— 2 倍高时会把面板一路收成一小条、
//   右边冒滚动条、下面一大片空白。**整个删掉**，只按"节点高 − 控件区起点"算，
//   控件区起点取 `max(widgets_start_y, 输入口占高)`，两头都兜住。
// ★ 他第 4 条（顶穿）：左边三个"可不连"输入口会把面板起点往下推 ~74px —— 节点高度要把这段**加上去**。
function inputH(node) {
  try { const n = (node.inputs || []).length; return n ? n * 22 + 8 : 0; } catch (e) { return 0; }
}
function withInputs(node, wh) { return [wh[0], wh[1] + inputH(node)]; }
function applySize(node, wh) {
  try {
    node.size = [Math.max(280, wh[0]), Math.max(140, wh[1])];
    const el = node.__mpRoot;
    if (el) {
      const topY = Math.max(Number(node.widgets_start_y) || 0, inputH(node));
      el.style.width = Math.max(240, node.size[0] - 16) + "px";
      el.style.height = Math.max(96, node.size[1] - topY - 6) + "px";
    }
    node.setDirtyCanvas && node.setDirtyCanvas(true, true);
  } catch (e) { /* 忽略 */ }
}

// 按**输出口类型**判断这个节点该进哪个槽 —— 他原话：「就由输出口是模型还是 CLIP 还是 VAE 来决定」
function kindOfNode(n) {
  const t = (n.outputs || []).map((o) => String((o && o.type) || "").toUpperCase());
  const M = t.indexOf("MODEL") >= 0, C = t.indexOf("CLIP") >= 0, V = t.indexOf("VAE") >= 0;
  if (M && C && V) return "ckpt";
  if (M && !C && !V) return "unet";
  if (C && !M && !V) return "clip";
  if (V && !M && !C) return "vae";
  return "";
}
function wget(n, name) {
  const w = (n.widgets || []).find((x) => x && x.name === name);
  return w ? w.value : undefined;
}
function fileNameOf(n, kind) {
  const pref = FIELDS[kind] && FIELDS[kind].name;
  let v = pref ? wget(n, pref) : undefined;
  if (v === undefined) {
    // 兜底：第一个看起来像文件名的字符串控件
    for (const w of (n.widgets || [])) {
      if (w && typeof w.value === "string" && /\.[a-z0-9]{2,5}$/i.test(w.value)) { v = w.value; break; }
    }
  }
  return String(v || "").trim();
}

// ---------------- 面板 ----------------
function render(node) {
  const st = readState(node);
  const root = node.__mpRoot;
  if (!root) return;
  root.innerHTML = "";

  // 顶栏
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:7px;flex:0 0 auto;padding-bottom:4px;"
    + "border-bottom:1px solid rgba(255,255,255,.10)";
  const ttl = document.createElement("span");
  ttl.textContent = "🔀 模型池";
  ttl.style.cssText = "font-size:13px;font-weight:700";
  const cnt = document.createElement("span");
  cnt.textContent = st.rows.length ? ("共 " + st.rows.length + " 套 · 出图只用高亮那套") : "还没吃掉任何节点";
  cnt.style.cssText = "font-size:10.5px;opacity:.62;font-weight:400";
  const gear = document.createElement("button");
  gear.type = "button"; gear.textContent = "⚙";
  gear.title = "设置：池子尺寸（宽 / 高 各 1~3 倍）";
  gear.style.cssText = "cursor:pointer;border-radius:6px;padding:0 7px;font-size:11px;line-height:16px;"
    + "border:1px solid rgba(255,255,255,.22);background:transparent;color:#cfd4e2";
  gear.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openSettings(node); });
  head.appendChild(ttl); head.appendChild(cnt); head.appendChild(gear);
  root.appendChild(head);

  // 空态
  if (!st.rows.length) {
    const empty = document.createElement("div");
    // ⚠️ 2026-11-03（他截图里那两行字跑到一左一右）：原来是 `display:flex` 配 `<br>`，
    //   而 flex 容器会把 `<br>` 前后的文字拆成**两个匿名弹性项并排** → 排版错乱。
    //   空态用 block + text-align:center 就行，别用 flex。
    empty.style.cssText = "flex:1 1 auto;display:block;"
      + "font-size:11.5px;line-height:1.9;opacity:.6;text-align:center;padding:26px 12px;";
    empty.innerHTML = "把画布上的 <b>UNET 加载器 / CLIP 加载器 / VAE 加载器</b><br>"
      + "（或一个 <b>Checkpoint</b>）直接拖到这个池子上面松手<br>"
      + "会按输出口类型自动归位";
    root.appendChild(empty);
    return;
  }

  // ★ 2026-11-04（他第 2 条，整块重做）：「里面内容和 LoRA 池一样改成一个大框框，大框框里面单独有一个模块，
  //   模块下除了模型名称以外还有三行字，分别对应 3 个节点，模块本身有设置，可以调整节点的微调内容，
  //   模块右上角除了设置以外，还有三个小圆点，分别对应该模块已经含有的内容 —— 若该模块 VAE 节点没有填入，
  //   那么红色节点就会变为灰色；模块在未选中时，会减少 50% 透明度」
  const SLOT_META = [
    { key: "unet", label: "MODEL", bd: "rgba(168,132,255,.95)", fg: "#dcccff" },
    { key: "clip", label: "CLIP", bd: "rgba(255,206,92,.95)", fg: "#ffe8ae" },
    { key: "vae", label: "VAE", bd: "rgba(255,110,110,.95)", fg: "#ffc9c9" },
  ];
  const GOLD = "rgba(255,206,92,.98)";
  function slotVal(row, key) {
    if (row.kind === "ckpt") return key === "unet" ? row.ckpt : "";
    return row[key] || "";
  }
  // ★ 他第 4 条：「在两倍或者三倍高度的情况下，可以改成 MODEL 然后另起一行 Anima base v1.0」
  //   → 高度倍数 ≥ 2 时模块用"两行式"（标签独占一行、文件名/别名另起一行），框更窄更高、更好认。
  // ★ 尺寸新口径（2026-11-04 第三批）：模块**一律两行式**（标签一行、名字一行），宽 132 固定，
  //   "一排几个 / 几列"完全由宽高倍数决定，不再随内容抖。
  const stacked = true;

  // ---- 一个大外框（和 LoRA 池同一个意思），框里排"模块"（一套 = 一个模块） ----
  const frame = document.createElement("div");
  frame.className = "mp-frame";
  frame.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto;box-sizing:border-box;"
    + "display:flex;flex-wrap:wrap;align-content:flex-start;gap:7px;padding:6px;scrollbar-gutter:stable;"
    + "border:1px solid rgba(255,255,255,.14);border-radius:9px;background:rgba(0,0,0,.18);";
  st.rows.forEach(function (row, i) {
    const on = i === st.cur;
    const mod = document.createElement("div");
    mod.className = "mp-mod";
    mod.style.cssText = "flex:0 0 auto;width:" + MP_MOD_W + "px;height:" + MP_MOD_H + "px;"
      + "display:flex;flex-direction:column;gap:3px;box-sizing:border-box;"
      + "border:1px solid " + (on ? GOLD : "rgba(255,255,255,.14)") + ";border-radius:8px;padding:4px 5px 5px;"
      + "background:" + (on ? "rgba(255,206,92,.08)" : "rgba(0,0,0,.22)") + ";cursor:pointer;"
      + "opacity:" + (on ? "1" : ".5") + ";"
      + (on ? "box-shadow:0 0 9px rgba(255,206,92,.28),inset 0 0 0 1px rgba(255,206,92,.22);" : "");
    mod.title = "点一下 = 出图用这一套；双击名字能改名";
    mod.addEventListener("click", function () {
      const s2 = readState(node); s2.cur = i; writeState(node, s2); render(node);
    });

    // 模块头：名字（双击改）+ 三个状态小圆点 + 齿轮
    const mh = document.createElement("div");
    mh.style.cssText = "display:flex;align-items:center;gap:4px;min-width:0";
    const nm = document.createElement("span");
    nm.textContent = row.name || ("第 " + (i + 1) + " 套");
    nm.style.cssText = "flex:1 1 auto;min-width:0;font-size:10px;font-weight:700;line-height:1.4;"
      + "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:" + (on ? "#ffe08a" : "#dfe4ee");
    nm.title = "双击改名（名字默认取第一个吃进来的节点名）";
    nm.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = row.name || "";
      inp.style.cssText = "flex:1 1 auto;min-width:0;font-family:inherit;font-size:10px;line-height:1.4;"
        + "background:#2a3044;color:#e8eaf1;border:1px solid rgba(255,206,92,.6);border-radius:4px;padding:0 3px";
      mh.replaceChild(inp, nm);
      try { inp.focus(); inp.select(); } catch (eF) { /* 忽略 */ }
      let done = false;
      function commit(ok) {
        if (done) return; done = true;
        const s2 = readState(node);
        if (s2.rows[i]) {
          const v = ok ? String(inp.value || "").trim() : String(s2.rows[i].name || "");
          s2.rows[i].name = v || ("第 " + (i + 1) + " 套");
          writeState(node, s2);
        }
        render(node);
      }
      inp.addEventListener("keydown", function (ev) {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
        if (ev.key === "Escape") { ev.preventDefault(); commit(false); }
      });
      inp.addEventListener("blur", function () { commit(true); });
      inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
    });
    const dots = document.createElement("span");
    dots.style.cssText = "display:flex;align-items:center;gap:2px;flex:0 0 auto";
    dots.title = "三个点 = MODEL / CLIP / VAE 有没有填（没填的那颗变灰）";
    SLOT_META.forEach(function (meta) {
      const filled = !!(String(slotVal(row, meta.key) || "").trim()) || row.kind === "ckpt";
      const dot = document.createElement("i");
      dot.style.cssText = "display:block;width:5px;height:5px;border-radius:50%;"
        + "background:" + (filled ? meta.bd : "rgba(120,128,148,.45)") + ";";
      dot.title = meta.label + (filled ? "：已填好" : "：还没填");
      dots.appendChild(dot);
    });
    const gb = document.createElement("button");
    gb.type = "button"; gb.textContent = "⚙";
    gb.title = "这一套的设置：别名 / 参数 / 把节点吐回画布";
    gb.style.cssText = "flex:0 0 auto;cursor:pointer;border:none;border-radius:4px;padding:0 2px;font-size:10px;"
      + "line-height:14px;background:transparent;color:" + (on ? "#ffe08a" : "#cfd4e2");
    gb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openParams(node, i); });
    mh.appendChild(nm); mh.appendChild(dots); mh.appendChild(gb);
    mod.appendChild(mh);

    // 三行：MODEL / CLIP / VAE（有别名就显示别名）
    SLOT_META.forEach(function (meta) {
      const line = document.createElement("div");
      line.style.cssText = "display:flex;min-width:0;gap:4px;"
        + (stacked ? "flex-direction:column;align-items:stretch;gap:1px;margin-bottom:2px" : "align-items:baseline");
      const lb = document.createElement("span");
      lb.textContent = meta.label;
      lb.style.cssText = "font-size:8px;font-weight:800;letter-spacing:.4px;color:" + meta.fg + ";opacity:.85;"
        + (stacked ? "display:block" : "flex:0 0 34px");
      const vv = document.createElement("span");
      const raw = slotVal(row, meta.key);
      const alias = String(row[meta.key + "Alias"] || "").trim();
      const same = row.kind === "ckpt" && meta.key !== "unet";
      vv.textContent = same ? "（同 Checkpoint）" : (raw ? (alias || raw) : "（空）");
      vv.title = same ? "这套用 Checkpoint，CLIP/VAE 跟它走" : (raw || "还没填");
      vv.style.cssText = "flex:1 1 auto;min-width:0;word-break:break-all;overflow:hidden;color:" + meta.fg + ";"
        + (stacked ? "font-size:10px;line-height:1.35;max-height:29px;" : "font-size:9.5px;line-height:1.35;max-height:24px;")
        + (same || raw ? "" : "opacity:.45;font-style:italic;");
      line.appendChild(lb); line.appendChild(vv);
      mod.appendChild(line);
    });

    // ★ 他第 2 条（第二次）：「生图时带上 LoRA 池的勾选，**放在设置外面的框框里面**」
    //   → 就在模块框里、三行下面这一行；勾着 = 这套生图时带上 LoRA 池。
    const lr = document.createElement("label");
    lr.className = "mp-lora";
    lr.title = "这一套生图时要不要带上 LoRA 池（等于原来齿轮里那个勾选）";
    lr.style.cssText = "display:flex;align-items:center;gap:4px;font-size:8.5px;line-height:1.5;"
      + "cursor:pointer;margin-top:1px;color:" + (row.loraPool === false ? "#ffb3b3" : "#cfd4e2");
    const lrk = document.createElement("input");
    lrk.type = "checkbox"; lrk.checked = row.loraPool !== false;
    lrk.style.cssText = "width:10px;height:10px;margin:0;cursor:pointer;flex:0 0 auto";
    lrk.addEventListener("click", function (e) {
      e.stopPropagation();
      const s2 = readState(node);
      if (s2.rows[i]) { s2.rows[i].loraPool = lrk.checked; writeState(node, s2); }
      toast(node, "第 " + (i + 1) + " 套：" + (lrk.checked ? "生图时会带上 LoRA 池" : "生图时不用 LoRA 池"));
      render(node);
    });
    lr.appendChild(lrk);
    lr.appendChild(document.createTextNode("带 LoRA 池"));
    mod.appendChild(lr);
    frame.appendChild(mod);
  });
  root.appendChild(frame);

  // （旧的三条横框 / 列头行 / 底部 LoRA 行已删 —— 2026-11-04 他第 2 条改成"一个大框 + 框里若干模块"）

  // （底部那行「LoRA池」勾选也删了 —— 挪进每个模块的 ⚙ 里，和参数放一起；关掉时模块上会给一行小字提醒）
}

// ★ 2026-11-04（他第 4 条）：「模型池设置里面可以把相应节点吐出来」
//   照 LoRA 池那套（`ejectLora`）：在池子右边新建一颗原版加载器，文件/参数照这一套填回去；
//   **池子里那一格不动**（吐出来只是"再拿一份到画布上"，不是搬家）。选"关浮窗"那类误会的坑也一并避开。
function ejectSlot(node, idx, which) {
  try {
    const st = readState(node);
    const row = st.rows[idx];
    if (!row) return false;
    const LG = window.LiteGraph;
    if (!LG || typeof LG.createNode !== "function") { toast(node, "建不出节点（这个前端没有 LiteGraph.createNode）", true); return false; }
    let type = "", file = "", sets = {}, dy = 0;
    if (row.kind === "ckpt" || which === "ckpt") {
      type = "CheckpointLoaderSimple"; file = row.ckpt; sets = { ckpt_name: file }; dy = 0;
    } else if (which === "unet") {
      type = "UNETLoader"; file = row.unet;
      sets = { unet_name: file, weight_dtype: row.dtype || "default" }; dy = 0;
    } else if (which === "clip") {
      type = "CLIPLoader"; file = row.clip;
      sets = { clip_name: file, type: row.clipType || "stable_diffusion", device: row.clipDevice || "default" }; dy = 100;
    } else if (which === "vae") {
      type = "VAELoader"; file = row.vae; sets = { vae_name: file }; dy = 190;
    }
    if (!String(file || "").trim()) { toast(node, "这一格是空的，没东西可吐", true); return false; }
    const n = LG.createNode(type);
    if (!n) { toast(node, "建不出 " + type + "（这个版本没有这颗节点？）", true); return false; }
    (n.widgets || []).forEach(function (w) {
      if (w && sets[w.name] !== undefined) w.value = sets[w.name];
    });
    n.pos = [(node.pos ? node.pos[0] : 0) + (node.size ? node.size[0] : 400) + 40,
             (node.pos ? node.pos[1] : 0) + 20 + dy];
    app.graph.add(n);
    toast(node, "吐出来了：" + type + "（" + file + "）");
    return true;
  } catch (e) { log("吐回失败", e); toast(node, "吐回失败：" + ((e && e.message) || e), true); return false; }
}

// ★ 他第 2 条（第二次）：「模型池的齿轮蹦出来的弹窗都只在节点中央，显得太闭塞了，**改成节点之外蹦出弹窗**」
//   → 弹窗挂在 body 上（固定定位），贴着节点**右边**蹦出来（右边放不下就换左边），不再铺一层黑幕把节点盖住；
//   点空白处照样关，关的时候顺手重画一次面板。
function mpDialogHost(node) {
  document.querySelectorAll(".mp-modal").forEach(function (x) { try { x.remove(); } catch (e) { /* 忽略 */ } });
  const mask = document.createElement("div");
  mask.className = "mp-modal";
  // 透明、不吃点击：弹窗飘在节点外面时，画布本身照旧能看能用（点空白处关掉它）
  mask.style.cssText = "position:fixed;inset:0;z-index:99990;background:transparent;pointer-events:none";
  const box = document.createElement("div");
  box.className = "mp-dlg";
  box.style.cssText = "position:fixed;z-index:99991;pointer-events:auto;background:#1c2030;"
    + "border:1px solid rgba(124,92,255,.55);"
    + "border-radius:10px;padding:10px 12px;width:min(322px,86vw);max-height:76vh;overflow:auto;"
    + "font-size:11px;line-height:1.7;color:#e8eaf1;box-shadow:0 16px 44px rgba(0,0,0,.6)";
  mask.appendChild(box);
  document.body.appendChild(mask);
  // 点弹窗外面 = 关掉（画布那一下照常生效，不额外拦）
  const onDoc = function (ev) {
    try {
      if (box.contains(ev.target)) return;
      document.removeEventListener("pointerdown", onDoc, true);
      mask.remove();
      render(node);
    } catch (e) { /* 忽略 */ }
  };
  setTimeout(function () { document.addEventListener("pointerdown", onDoc, true); }, 0);
  try {
    const el = node.__mpRoot;
    const r = el ? el.getBoundingClientRect() : { left: 40, top: 40, right: 380 };
    const gap = 12, bw = Math.min(322, window.innerWidth * 0.86);
    let left = r.right + gap;
    if (left + bw > window.innerWidth - 8) left = Math.max(8, r.left - bw - gap);
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 140));
    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
  } catch (e) { /* 忽略 */ }
  return { mask: mask, box: box };
}

// 参数弹窗（点卡上的 ⚙）
function openParams(node, idx) {
  const st = readState(node);
  const row = st.rows[idx];
  if (!row) return;
  const root = node.__mpRoot;
  if (!root) return;
  const host = mpDialogHost(node);
  const mask = host.mask;
  const box = host.box;
  const t = document.createElement("div");
  t.textContent = "⚙ " + (row.name || ("第 " + (idx + 1) + " 套")) + " 的参数";
  t.style.cssText = "font-weight:700;font-size:12px;margin-bottom:6px";
  box.appendChild(t);

  const hint = document.createElement("div");
  hint.textContent = "下面列出的是这套节点的参数（和内置节点里那几项一一对应）";
  hint.style.cssText = "font-size:10px;opacity:.55;margin-bottom:7px";
  box.appendChild(hint);

  function rowUI(label, key, options, cur) {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;align-items:center;gap:7px;margin-bottom:5px";
    const l = document.createElement("span");
    l.textContent = label;
    l.style.cssText = "flex:0 0 84px;opacity:.8";
    const sel = document.createElement("select");
    sel.style.cssText = "flex:1 1 auto;background:#2a3044;color:#e8eaf1;border:1px solid rgba(255,255,255,.18);"
      + "border-radius:6px;padding:2px 5px;font-size:11px;font-family:inherit";
    (options || []).forEach((o) => {
      const op = document.createElement("option");
      op.value = String(o); op.textContent = String(o);
      if (String(o) === String(cur)) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener("change", () => {
      const s2 = readState(node);
      if (!s2.rows[idx]) return;
      s2.rows[idx][key] = sel.value;
      // ⚠️ 2026-11-04：这里**不能调 render()** —— 面板根一重建，这个弹窗自己也跟着没了
      //   （"点一下设置就整个关掉"就是这么来的）。弹窗关掉时统一重画一次。
      writeState(node, s2);
    });
    line.appendChild(l); line.appendChild(sel);
    return line;
  }

  // ★ 2026-11-04（他第 4 条）：别名 —— 组合名 + 三个文件的显示名都能改，改完立刻生效
  const aliasBox = document.createElement("div");
  aliasBox.style.cssText = "margin-bottom:8px;padding-bottom:7px;border-bottom:1px dashed rgba(255,255,255,.14)";
  const aliasTitle = document.createElement("div");
  aliasTitle.textContent = "别名（留空 = 用真文件名）";
  aliasTitle.style.cssText = "font-size:10px;opacity:.62;margin-bottom:5px";
  aliasBox.appendChild(aliasTitle);
  function aliasRow(label, key, ph) {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px";
    const l = document.createElement("span");
    l.textContent = label;
    l.style.cssText = "flex:0 0 74px;opacity:.82;font-size:10.5px";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = String(row[key] || "");
    inp.placeholder = ph || "";
    inp.style.cssText = "flex:1 1 auto;min-width:0;background:#2a3044;color:#e8eaf1;"
      + "border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:2px 6px;font-size:10.5px;font-family:inherit";
    inp.addEventListener("input", () => {
      const s2 = readState(node);
      if (!s2.rows[idx]) return;
      s2.rows[idx][key] = inp.value;
      writeState(node, s2);       // 同上：不在这里 render，等弹窗关掉再重画
    });
    inp.addEventListener("click", (e) => e.stopPropagation());
    line.appendChild(l); line.appendChild(inp);
    return line;
  }
  aliasBox.appendChild(aliasRow("组合名", "name", row.name || ""));
  aliasBox.appendChild(aliasRow("MODEL", "unetAlias", row.unet || "（空）"));
  aliasBox.appendChild(aliasRow("CLIP", "clipAlias", row.clip || "（空）"));
  aliasBox.appendChild(aliasRow("VAE", "vaeAlias", row.vae || "（空）"));
  box.appendChild(aliasBox);
  if (row.kind === "ckpt") {
    box.appendChild(rowUI("Checkpoint", "ckpt", [row.ckpt], row.ckpt));
  } else {
    // UNET 的 weight_dtype（官方那 4 个）
    box.appendChild(rowUI("UNET 精度", "dtype",
      ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"], row.dtype));
    if (row.unet) {
      const u = document.createElement("div");
      u.textContent = "UNET：" + row.unet;
      u.style.cssText = "font-size:10px;opacity:.6;margin-bottom:5px;word-break:break-all";
      box.appendChild(u);
    }
    // CLIP 的 type（这里列常用的几个；换别的可以直接改节点再拖一次）
    box.appendChild(rowUI("CLIP 类型", "clipType",
      ["stable_diffusion", "qwen_image", "moss_image", "flux", "sd3", "wan", "cosmos", "lumina2"],
      row.clipType));
    box.appendChild(rowUI("CLIP 设备", "clipDevice", ["default", "cpu"], row.clipDevice));
    if (row.clip) {
      const c = document.createElement("div");
      c.textContent = "CLIP：" + row.clip;
      c.style.cssText = "font-size:10px;opacity:.6;margin-bottom:5px;word-break:break-all";
      box.appendChild(c);
    }
    if (row.vae) {
      const vv = document.createElement("div");
      vv.textContent = "VAE：" + row.vae;
      vv.style.cssText = "font-size:10px;opacity:.6;word-break:break-all";
      box.appendChild(vv);
    }
  }

  // ★ 他第 4 条：「模型池设置里面可以把相应节点吐出来」
  const ejBox = document.createElement("div");
  ejBox.style.cssText = "margin-top:8px;padding-top:7px;border-top:1px dashed rgba(255,255,255,.14)";
  const ejT = document.createElement("div");
  ejT.textContent = "把这一套的节点吐回画布（池子里这一格不动，只是再拿一份出来）";
  ejT.style.cssText = "font-size:10px;opacity:.62;margin-bottom:5px";
  ejBox.appendChild(ejT);
  const ejRow = document.createElement("div");
  ejRow.style.cssText = "display:flex;flex-wrap:wrap;gap:5px";
  [{ key: "unet", label: "MODEL" }, { key: "clip", label: "CLIP" }, { key: "vae", label: "VAE" }].forEach(function (meta) {
    if (row.kind === "ckpt" && meta.key !== "unet") return;
    const has = !!(String(row[meta.key] || "").trim());
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "↩ 吐回 " + (row.kind === "ckpt" ? "Checkpoint" : meta.label);
    b.disabled = !has;
    b.title = has ? "在池子右边重新建一颗加载器节点，文件和参数照这套填" : "这一格是空的，没东西可吐";
    b.style.cssText = "font-family:inherit;font-size:10.5px;padding:3px 8px;border-radius:7px;"
      + (has ? "cursor:pointer;border:1px solid rgba(120,180,255,.6);background:rgba(96,166,255,.16);color:#cfe4ff"
             : "cursor:not-allowed;border:1px solid rgba(150,162,180,.3);background:rgba(255,255,255,.04);color:#8a93a6");
    b.addEventListener("click", function () {
      if (ejectSlot(node, idx, row.kind === "ckpt" ? "ckpt" : meta.key)) b.textContent = "✅ 已吐回";
    });
    ejRow.appendChild(b);
  });
  ejBox.appendChild(ejRow);
  box.appendChild(ejBox);

  // ★ 他第 2 条（第二次）：「生图时带上 LoRA 池的勾选与否，**放在设置外面的框框里面**，而不是设置里面」
  //   → 这颗勾选搬回模块框里（模块第一行下面那行小字），齿轮里不再重复一份。

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:7px;margin-top:9px";
  const ok = document.createElement("button");
  ok.type = "button"; ok.textContent = "关闭该页面";
  ok.style.cssText = "flex:1 1 0;cursor:pointer;border-radius:7px;padding:4px 8px;font-size:11px;"
    + "border:1px solid rgba(124,92,255,.6);background:rgba(124,92,255,.22);color:#efe9ff";
  ok.addEventListener("click", () => { mask.remove(); render(node); });
  foot.appendChild(ok);
  box.appendChild(foot);
}

// 设置（点顶栏 ⚙）：宽 / 高 各 1~3 倍，和 LoRA 池同一套规矩
function openSettings(node) {
  const root = node.__mpRoot;
  if (!root) return;
  const st = readState(node);

  const host = mpDialogHost(node);
  const mask = host.mask;
  const box = host.box;
  const t = document.createElement("div");
  t.textContent = "⚙ 模型池设置";
  t.style.cssText = "font-weight:700;font-size:12px;margin-bottom:8px";
  box.appendChild(t);

  function sizeRow(label, which, curV) {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:7px";
    const l = document.createElement("span");
    l.textContent = label;
    l.style.cssText = "flex:0 0 44px;opacity:.85";
    line.appendChild(l);
    [1, 2, 3].forEach((m) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = MUL_LABEL[m];
      b.style.cssText = "font-family:inherit;font-size:11px;padding:3px 9px;border-radius:7px;cursor:pointer;"
        + (m === curV
          ? "border:1px solid rgba(124,92,255,.95);background:rgba(124,92,255,.28);color:#efe9ff;font-weight:700"
          : "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1");
      b.title = which === "w"
        ? ("宽 " + m + " 倍 = 一排 " + (2 * m) + " 个组合")
        : ("高 " + m + " 倍 = " + m + " 列");
      b.addEventListener("click", () => {
        const s2 = readState(node);
        if (which === "w") s2.mpW = m; else s2.mpH = m;
        writeState(node, s2);
        applySize(node, withInputs(node, sizeWH(s2)));
        render(node);
        toast(node, "尺寸改成：宽 " + s2.mpW + " 倍（一排 " + (2 * s2.mpW) + " 个）· 高 " + s2.mpH + " 倍（" + s2.mpH + " 列）");
        mask.remove();
      });
      line.appendChild(b);
    });
    return line;
  }
  box.appendChild(sizeRow("宽度：", "w", st.mpW));
  box.appendChild(sizeRow("高度：", "h", st.mpH));

  const tip = document.createElement("div");
  tip.textContent = "换模型只要点另一行高亮就行，不用重新连线。";
  tip.style.cssText = "font-size:10px;opacity:.55;margin-top:3px";
  box.appendChild(tip);
}

// ---------------- 挂面板 ----------------
function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "mp-root";
  root.style.cssText = "position:relative;display:flex;flex-direction:column;width:100%;height:100%;"
    // ★ 2026-11-04（他第 4 条）：「小齿轮往左边放放、往上放放，和三个输出口共处一排」
    //   → 顶部不留 padding，标题行直接贴到节点顶端那条线上，右侧就是模型/CLIP/VAE 三个输出口。
    + "padding:0 7px 6px;box-sizing:border-box;overflow:hidden;min-height:0;"
    + "font:12px/1.55 system-ui,'Microsoft YaHei',sans-serif;color:#e8eaf1;";
  node.__mpRoot = root;
  render(node);
  return root;
}

function mount(node) {
  try {
    if (node.__mpPanel) return true;
    if (typeof node.addDOMWidget !== "function") return false;
    const panel = buildPanel(node);
    node.__mpPanel = node.addDOMWidget("模型池", "pcModelPool", panel, { serialize: false, hideOnZoom: false });
    // ★ 2026-11-03（他截图里那条 {"rows":[],"cur":0,...} 明晃晃露在界面上）：后端那个 `状态` 控件
    //   是给程序用的，不该露出来。照计时器那套藏掉（不删控件，老工作流存的值还在）。
    try {
      const sw = (node.widgets || []).find(function (x) { return x && x.name === "状态"; });
      if (sw) {
        sw.hidden = true;
        sw.computeSize = function () { return [0, -4]; };
        if (sw.element) sw.element.style.display = "none";
        if (sw.inputEl) sw.inputEl.style.display = "none";
      }
    } catch (e) { /* 忽略 */ }
    const orig = node.computeSize;
    node.computeSize = function () {
      const s = orig ? orig.apply(this, arguments) : [MP_W_BASE, MP_H_BASE];
      const st = readState(this);
      const wh = sizeWH(st, st.rows.length);
      return [Math.max(s[0], wh[0]), Math.max(s[1], wh[1] + inputH(this))];
    };
    const st = readState(node);
    if (!node.size || node.size[0] < 200) node.size = sizeWH(st);
    setTimeout(function () {
      const s0 = readState(node); applySize(node, withInputs(node, sizeWH(s0, s0.rows.length)));
      render(node);
    }, 0);
    return true;
  } catch (e) { log("建面板失败", e); return false; }
}

// ---------------- 吃掉节点（照 LoRA 池那套，改成按输出口类型归位） ----------------
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

function bindEat() {
  document.addEventListener("pointerdown", function (e) {
    try {
      if (!app || !app.canvas || !app.graph) return;
      const pt = toCanvasPoint(e.clientX, e.clientY);
      if (!pt) return;
      const n = app.graph.getNodeOnPos ? app.graph.getNodeOnPos(pt[0], pt[1]) : null;
      dragging = (n && n.type === NODE) ? null : n;      // 别自己吃自己
    } catch (err) { dragging = null; }
  }, true);

  document.addEventListener("pointerup", function () {
    const src = dragging; dragging = null;
    if (!src) return;
    const kind = kindOfNode(src);
    if (!kind) return;                                    // 不是模型/CLIP/VAE 相关的节点，不管
    try {
      // ⚠️ 2026-11-03（他报"节点拖不进去"）：这里原来用 `p2.__mpPanel.getBoundingClientRect()`，
      //   而 `__mpPanel` 是 addDOMWidget 返回的 **widget 对象**，根本没有 getBoundingClientRect →
      //   一调用就抛 TypeError，又被外层 try/catch 吞掉 → **拖上去毫无反应、也不报错**。
      //   量位置必须用真正的 DOM：面板根 `__mpRoot`（没有就退回 widget.element）。
      const pools = (app.graph._nodes || []).filter((n) => n && n.type === NODE && (n.__mpRoot || n.__mpPanel));
      if (!pools.length) return;
      const s = src.size || [200, 100];
      const cx = src.pos[0] + s[0] / 2, cy = src.pos[1] + s[1] / 2;
      const hit = pools.find((p2) => {
        const el = p2.__mpRoot || (p2.__mpPanel && p2.__mpPanel.element);
        if (!el) return false;
        const pr = el.getBoundingClientRect();
        if (!pr.width || !pr.height) return false;
        const a = toCanvasPoint(pr.left, pr.top), b = toCanvasPoint(pr.right, pr.bottom);
        if (!a || !b) return false;
        return cx >= a[0] && cx <= b[0] && cy >= a[1] && cy <= b[1];
      });
      if (!hit) return;

      const st = readState(hit);
      const file = fileNameOf(src, kind);
      if (!file) { toast(hit, "这个节点里还没选文件", true); return; }

      if (kind === "ckpt") {
        st.rows.push({ kind: "ckpt", ckpt: file, unet: "", clip: "", vae: "",
          loraPool: true, name: file.replace(/\.safetensors$/i, "") });
        st.cur = st.rows.length - 1;
        toast(hit, "吃掉了 Checkpoint「" + file + "」—— 一套三件（CLIP/VAE 跟它走）");
      } else {
        // ★ 2026-11-04（他拍板的口径）：**不做自动识别**（模型文件之间没有血缘，猜必错）——
        //   「往哪套里吃，看你现在选中哪个模块」：拖进来就补进选中那套的空槽；那套这个槽已经满了、或者没选中，
        //   就新建一套。控制权在他手上，零歧义。
        let target = -1;
        if (st.rows.length) {
          const curRow = st.rows[st.cur];
          if (curRow && curRow.kind !== "ckpt" && !String(curRow[kind] || "").trim()) target = st.cur;
        }
        if (target < 0) {
          st.rows.push({ kind: "unet", unet: "", clip: "", vae: "",
            dtype: "default", clipType: "stable_diffusion", clipDevice: "default",
            loraPool: true,
            // 模块名默认取"第一个吃进来的那个节点名"（他拍板的），之后随时能双击改
            name: file.replace(/\.safetensors$/i, "") });
          target = st.rows.length - 1;
        }
        const r = st.rows[target];
        r[kind] = file;
        if (kind === "unet") {
          const dt = wget(src, "weight_dtype");
          if (typeof dt === "string" && dt) r.dtype = dt;
        }
        if (kind === "clip") {
          const tp = wget(src, "type"); if (typeof tp === "string" && tp) r.clipType = tp;
          const dv = wget(src, "device"); if (typeof dv === "string" && dv) r.clipDevice = dv;
        }
        if (!r.name) r.name = file.replace(/\.safetensors$/i, "");
        st.cur = target;
        toast(hit, "吃掉了「" + file + "」→ 放进第 " + (target + 1) + " 套的 " + kind.toUpperCase() + " 槽");
      }
      writeState(hit, st);
      if (hit.__mpRoot) {}      app.graph.remove(src);          // 吃掉：节点从画布消失
      render(hit);
    } catch (err) { log("吃掉失败", err); }
  }, true);
}
bindEat();

app.registerExtension({
  name: "PromptTool.ModelPool",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || nodeData.name !== NODE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      const self = this;
      setTimeout(function () { mount(self); }, 0);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const self = this;
      setTimeout(function () {
        if (!mount(self)) return;
        const s1 = readState(self); applySize(self, withInputs(self, sizeWH(s1, s1.rows.length)));
        render(self);
      }, 0);
      return r;
    };

    const onResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function () {
      const r = onResize ? onResize.apply(this, arguments) : undefined;
      applySize(this, this.size || [MP_W_BASE, MP_H_BASE]);
      return r;
    };
  },
});

// 测试钩子
window.__mpInfo = function (nodeId) {
  try {
    const n = app.graph.getNodeById(nodeId);
    if (!n) return null;
    const st = readState(n);
    return { rows: st.rows.length, cur: st.cur, mpW: st.mpW, mpH: st.mpH, size: n.size };
  } catch (e) { return null; }
};
