// ==================== 图像画廊（PromptToolGallery 的前端界面）====================
//   ★ 2026-10-24 第 234 批开工。他 231 批定的口径：
//     ① 一排 4 张缩略图、点开在**节点内放大**、右键出选项、主页 = 节点内面板；
//     ② 一张图四个标（删除 / 下载 / 收藏 / 多选）；
//     ③ 删除进**回收站**、可恢复；收藏不占上限、永不被顶掉；
//     ④ 主页 / 收藏 / 回收站 **三个分页**；上限 正式 500 / 回收站 100；
//     ⑤ 图存 `桌面\工具 X.X 正式版\图片存档\{下载,收藏,回收站,编辑栏,素材}`（日期分组在里面）；
//     ⑥ **节点内容不因 ComfyUI 开关 / 重启而重置** —— 图在磁盘上，节点一建好就去拉列表。
//   数据来源：GET /prompt_sync/gallery/list?page=home|fav|trash|ext
//   图片地址：GET /prompt_sync/gallery/img?rel=<相对路径>
//   后端存图在 nodes.py 的 PromptToolGallery.collect() → routes.archive_put_png()（带 workflow 元数据）
import { app } from "../../scripts/app.js";

const NODE_TYPE = "PromptToolGallery";
const API = "/prompt_sync/gallery";
const PAGE_SIZE = 60;
const DEF_W = 900;
const DEF_H = 640;

function log() {
  try {
    console.log.apply(console, ["[提示词工具·画廊]"].concat([].slice.call(arguments)));
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 样式（只注入一次）
function injectStyle() {
  if (document.getElementById("pc-gal-style")) return;
  const s = document.createElement("style");
  s.id = "pc-gal-style";
  s.textContent = `
  .pc-gal{display:flex;flex-direction:column;width:100%;height:100%;box-sizing:border-box;
    font:12.5px/1.5 system-ui,'Microsoft YaHei',sans-serif;color:#e8eaf1;background:rgba(0,0,0,.14);
    overflow:hidden;position:relative;min-height:0}
  .pc-gal *{box-sizing:border-box}
  .gal-head{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:7px 9px;
    border-bottom:1px solid rgba(150,162,180,.22);background:rgba(255,255,255,.03)}
  .gal-tab{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;
    border:1px solid rgba(150,162,180,.34);background:rgba(255,255,255,.05);color:#dfe6ee}
  .gal-tab.on{background:linear-gradient(135deg,#7c5cff,#3b82f6);border-color:transparent;color:#fff;font-weight:700}
  .gal-tab .gal-n{opacity:.72;font-weight:400;margin-left:4px}
  .gal-sp{flex:1 1 auto}
  .gal-mini{font:inherit;font-size:11.5px;padding:3px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;
    border:1px solid rgba(150,162,180,.3);background:rgba(255,255,255,.05);color:#c9d4e2}
  .gal-mini:hover{background:rgba(255,255,255,.12);color:#fff}
  .gal-mini.on{background:rgba(124,92,255,.34);border-color:rgba(124,92,255,.7);color:#fff}
  .gal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:8px}
  /* ★ 237 批（他："预设图片一定要正方形吗？就不能改成和图片中原比例吗"）→ 不再强制 aspect-ratio:1，
     格子高度跟着图片原比例走（grid 的行高按该行最高的那张算）。 */
  .gal-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;align-items:start}
  .gal-cell{position:relative;border-radius:9px;overflow:hidden;
    background:rgba(255,255,255,.05);border:1px solid rgba(150,162,180,.2);cursor:zoom-in}
  .gal-cell img{width:100%;height:auto;display:block;object-fit:contain;transition:transform .16s}
  .gal-cell:hover img{transform:scale(1.03)}
  .gal-cell.sel{border-color:#38bdf8;box-shadow:0 0 0 2px rgba(56,189,248,.55) inset}
  .gal-marks{position:absolute;top:3px;right:3px;display:flex;gap:3px;opacity:0;transition:opacity .12s}
  .gal-cell:hover .gal-marks,.gal-cell.sel .gal-marks{opacity:1}
  .gal-mk{width:20px;height:20px;line-height:19px;text-align:center;font-size:11px;border-radius:6px;
    cursor:pointer;background:rgba(12,16,24,.78);border:1px solid rgba(150,162,180,.5);color:#dfe6ee;user-select:none}
  .gal-mk:hover{background:rgba(58,120,220,.85);color:#fff}
  .gal-mk.fav{color:#ff7a9c;border-color:rgba(255,122,156,.7)}
  .gal-mk.del:hover{background:#c0392b;border-color:#e06060}
  /* 勾选框只留左上角那一个（237 批：右上角不再重复一颗） */
  .gal-chk{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:5px;cursor:pointer;
    background:rgba(12,16,24,.72);border:1px solid rgba(150,162,180,.55);display:none}
  .gal-cell:hover .gal-chk{display:block}
  .gal-cell.sel .gal-chk{display:block;background:#38bdf8;border-color:#38bdf8}
  .pc-gal.multi .gal-chk{display:block}
  /* 一组几张的角标（一次生 2 张 = 一组） */
  .gal-count{position:absolute;left:3px;bottom:3px;font-size:10.5px;line-height:1;padding:3px 6px;border-radius:6px;
    background:rgba(12,16,24,.82);border:1px solid rgba(150,162,180,.5);color:#cfe3ff;user-select:none}
  .gal-empty{padding:26px 10px;text-align:center;color:rgba(200,210,225,.6);font-size:12.5px;line-height:1.8}
  .gal-foot{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:6px 9px;
    border-top:1px solid rgba(150,162,180,.22);background:rgba(255,255,255,.03);min-height:34px}
  .gal-note{font-size:11px;color:rgba(200,210,225,.62)}
  /* ★ 237 批：第二层 = 这一组并排看（右上角红叉回第一层） */
  .gal-group{position:absolute;inset:0;z-index:15;background:rgba(6,9,14,.97);display:none;
    flex-direction:column;gap:8px;padding:8px}
  .gal-group.on{display:flex}
  .gal-gbar{flex:0 0 auto;display:flex;align-items:center;gap:8px}
  .gal-gttl{font-size:11.5px;color:rgba(210,220,235,.8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gal-gclose{flex:0 0 auto;width:24px;height:24px;line-height:22px;text-align:center;border-radius:7px;cursor:pointer;
    font-size:13px;font-weight:700;background:#c0392b;border:1px solid #e06060;color:#fff;user-select:none}
  .gal-gclose:hover{background:#e04a3a}
  .gal-gbody{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;justify-content:center}
  .gal-gitem{position:relative;border-radius:8px;overflow:hidden;cursor:zoom-in;
    border:1px solid rgba(150,162,180,.32);background:rgba(255,255,255,.04);max-width:100%}
  .gal-gitem img{display:block;max-width:100%;max-height:44vh;width:auto;height:auto}
  .gal-gitem:hover{border-color:#38bdf8}
  .gal-gidx{position:absolute;left:4px;top:4px;font-size:10px;line-height:1;padding:2px 5px;border-radius:5px;
    background:rgba(12,16,24,.8);border:1px solid rgba(150,162,180,.45);color:#cfe3ff}
  .gal-zoom{position:absolute;inset:0;z-index:20;background:rgba(6,9,14,.94);display:none;
    flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:10px}
  .gal-zoom.on{display:flex}
  .gal-zoom img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
  .gal-zoom .gal-zbar{position:absolute;top:6px;left:8px;right:8px;display:flex;align-items:center;gap:6px}
  .gal-zoom .gal-zname{font-size:11px;color:rgba(210,220,235,.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* ★ 273i 批（他："画廊在主图只有一张的时候，很容易让人分不清第二层还是第三层，应该有特殊颜色的小字提醒才对，
     不要用灰字"）→ 每一层都挂一个彩色层号 */
  .gal-layer{font-size:11px;font-weight:700;line-height:1;padding:3px 7px;border-radius:7px;margin-right:8px;
    border:1px solid currentColor;white-space:nowrap;flex:0 0 auto}
  .gal-layer.l1{color:#8ea2ff}
  .gal-layer.l2{color:#ffd166}
  .gal-layer.l3{color:#7c5cff}
  .gal-layer.l4{color:#4ade80}
  /* ★ 273n（他第 9 条："小三角左右反了"）：改用 clip-path 画，左下角的直角三角形 */
  .gal-tri{position:absolute;left:0;bottom:0;width:16px;height:16px;pointer-events:none;z-index:6;
    clip-path:polygon(0 100%, 0 0, 100% 100%)}
  .gal-tri.gen{background:rgba(96,166,255,.95)}
  .gal-tri.inpaint{background:rgba(245,158,11,.95)}
  .gal-mask{position:absolute;inset:0;z-index:22;background:rgba(6,9,14,.97);display:none;align-items:center;justify-content:center}
  .gal-mask.on{display:flex}
  .gal-mask .gal-mbar{position:absolute;top:6px;left:8px;right:8px;display:flex;align-items:center;gap:8px}
  .gal-zarrow{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:52px;border-radius:9px;
    display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:20px;
    background:rgba(255,255,255,.09);border:1px solid rgba(150,162,180,.35);color:#e8eaf1;user-select:none}
  .gal-zarrow:hover{background:rgba(255,255,255,.2)}
  .gal-zarrow.l{left:6px}.gal-zarrow.r{right:6px}
  .gal-menu{position:fixed;z-index:100090;min-width:150px;padding:4px;border-radius:9px;
    background:#151a23;border:1px solid #3d444d;box-shadow:0 12px 32px rgba(0,0,0,.55);display:none}
  .gal-mi{padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12.5px;white-space:nowrap;color:#dfe6ee}
  .gal-mi:hover{background:rgba(90,140,230,.28)}
  .gal-mi.danger{color:#ffb4b4}
  .gal-mi.danger:hover{background:rgba(190,60,60,.4)}
  `;
  document.head.appendChild(s);
}

// ★ 2026-11-04（他第三次报请神失败，这次拿到了真凭据）：回来的**确实是 JSON**，但里面带
//   `"hanged": [NaN]` —— Python 的 `json.dumps` 默认会把 NaN / Infinity 原样写出来，
//   而 JS 的 `JSON.parse` **不认这两个字面量**（标准 JSON 没有它们）→ 解析失败，被我的兜底当成"没回 JSON"。
//   修法：解析前把裸 NaN / ±Infinity 换成 null 再试一次（只动"值"的位置，不碰字符串内容）。
function parseLooseJson(raw) {
  try { return JSON.parse(raw); } catch (e) { /* 落到下面清洗 */ }
  try {
    const fixed = String(raw).replace(/(?<=[:\s,\[])\s*(NaN|-?Infinity)(?=[\s,\]}])/g, " null");
    return JSON.parse(fixed);
  } catch (e2) { return null; }
}

// ---------------------------------------------------------------- 后端小工具
async function apiGet(path, q) {
  const u = API + path + (q ? "?" + new URLSearchParams(q).toString() : "");
  const r = await fetch(u, { cache: "no-store" });
  // ★ 2026-11-04：报错把**状态码 / 回来的原文前 120 字 / 实际地址**一起打出来（"读不到"就是靠它定案的）
  const raw = await r.text().catch(() => "");
  const j = parseLooseJson(raw);
  if (!j) {
    const head = String(raw || "").replace(/\s+/g, " ").slice(0, 120) || "(空响应)";
    throw new Error("接口没回 JSON（HTTP " + r.status + "）｜回来的是：" + head + "｜地址 " + u);
  }
  if (j.success === false) throw new Error(j.error || ("接口报错（HTTP " + r.status + "）"));
  return j;
}
async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.success === false) throw new Error((j && j.error) || ("HTTP " + r.status));
  return j;
}
const imgUrl = (rel) => API + "/img?rel=" + encodeURIComponent(rel);

// ★ 384 批（他第 5 条："关于第四层蒙版要展示的图…我的判断是，优先展示最新修改的那一张就行了"）
//   叠图（素材模式）保存时会合成一张「底图 + 素材」的成品图存进素材栏，这里记下 原图rel → 成品rel。
//   第 4 层：有这张成品就显示成品（而且**不叠红色滤镜**——叠图那块本来就是要重绘的，全图都知道）；
//   没有就还是老样子（底图 + 红色 = 手涂的蒙版）。
const GAL_STACK_KEY = "promptCopier.galStack.v1";
function galStackMap() {
  try { return JSON.parse(localStorage.getItem(GAL_STACK_KEY) || "{}") || {}; } catch (e) { return {}; }
}
function stackRelOf(rel) { const m = galStackMap(); return m[rel] || ""; }
function stackSet(rel, r) {
  const m = galStackMap();
  if (r) m[rel] = r; else delete m[rel];
  try { localStorage.setItem(GAL_STACK_KEY, JSON.stringify(m)); } catch (e) { /* 忽略 */ }
}

function el(tag, css, text) {
  const d = document.createElement(tag);
  if (css) d.style.cssText = css;
  if (text != null) d.textContent = text;
  return d;
}

// ---------------------------------------------------------------- 每个节点一份状态
const ST = new WeakMap();
function stOf(node) {
  let s = ST.get(node);
  if (!s) {
    s = {
      page: "home", offset: 0, items: [], total: 0, counts: {},
      multi: false, sel: new Set(), loading: false, root: "",
      zoom: null,          // 放大中的 rel（第三层）
      // ★ 237 批：三层 —— level 1 = 主页网格（一格一组）、level 2 = 这一组并排、level 3 = 单张放大（zoom 非空）
      level: 1,
      // ★ 273i 批（他："交换按组和平铺的关系，平铺才是默认，按组才是意外"）→ 默认平铺
      flat: true,          // 第一层"每张各一格（平铺）"还是"按组合并"
      autoSkip2: false,    // ★ 273j：自动忽略第二层（只有出图后 / 按组点组图才进第二层）
      showKind: true,      // ★ 273k：图片左下角三角标（蓝=文生图 / 橙=局部重绘）
      favOnCopy: false,    // ★ 291：右键「复制图片」时顺手收藏（设置第 7 项）
      groupKey: null,      // 第二层正在看哪一组（batch id 或 "one:<rel>"）
      galKey: "f",         // ★ 273 批：占满全屏的快捷键（默认 F，在「⚙ 设置」里能改）
      limits: { home: 500, trash: 100 },
    };
    ST.set(node, s);
    // ★ 273 批（他 272 批第 13 条："画廊的平铺还是按组，会因为刷新或者退出重进而重置，应该改成不重置"）
    //   以前这些状态只活在这个 WeakMap 里 → 刷新就回默认。现在跟着节点的 properties 走（存工作流也带着）。
    try {
      const pr = node && node.properties && node.properties.pcGal;
      if (pr && typeof pr === "object") {
        if (pr.flat === true || pr.flat === false) s.flat = pr.flat;
        // ★ 364 批：多页签后恢复也别把「编辑栏 / 素材」丢了
        if (["home", "fav", "trash", "edit", "material"].includes(pr.page)) s.page = pr.page;
        if (typeof pr.key === "string" && pr.key) s.galKey = pr.key;
        if (pr.autoSkip2 === true || pr.autoSkip2 === false) s.autoSkip2 = pr.autoSkip2;
        if (pr.showKind === true || pr.showKind === false) s.showKind = pr.showKind;
        if (pr.favOnCopy === true || pr.favOnCopy === false) s.favOnCopy = pr.favOnCopy;
        // ★ 274：局部重绘（自动裁切放大）的设置也要跟着工作流存
        if (pr.crop && typeof pr.crop === "object") s.crop = pr.crop;
      }
    } catch (e) { /* 忽略 */ }
  }
  return s;
}
// ★ 273 批：把「平铺/按组 + 在哪一页 + 快捷键」写回节点 properties（跟工作流一起存）
function saveGal(node) {
  try {
    const s = ST.get(node);
    if (!node || !s) return false;
    node.properties = node.properties || {};
    node.properties.pcGal = { flat: !!s.flat, page: s.page, key: s.galKey || "f", autoSkip2: !!s.autoSkip2, showKind: s.showKind !== false,
      crop: s.crop || { mode: "auto", pad: 35, target: 1024, feather: 16, expand: 12 },
      favOnCopy: !!s.favOnCopy };
    try { if (window.app && app.graph && typeof app.graph.change === "function") app.graph.change(); } catch (e2) { /* 忽略 */ }
    return true;
  } catch (e) { return false; }
}

// ================================================================
// ★ 273 批（他 272 批第 4 条）：画廊也要能"像黑箱那样占满全屏"
//   原话：「画廊滚轮只是现象，而不是要做出来的效果，应该是画廊设置中设置绑定一个快捷键，
//   点击之后就会直接像黑箱一样，上 3，左 1.5，下 1.5，右 8cm 的效果占满全屏」
//   → 尺寸照抄黑箱的 FIT_CM；快捷键默认 F，在「⚙ 设置」里能改。
const GAL_FIT_CM = { top: 3, left: 1.5, bottom: 1.5, right: 8, screenCm: 35 };
let galKeyWait = null;
// ★ 273b（他："画廊占满使用空格的话，当前键什么都不会显示，应该改成显示「空格键」三个字"）
//   空格在 e.key 里就是一个空格字符 → 统一存成 "space"，显示时翻成中文名。
function galKeyNorm(k) {
  const s = String(k == null ? "" : k);
  if (s === " " || s === "Spacebar" || s.toLowerCase() === "space") return "space";
  return s.length === 1 ? s.toLowerCase() : "";
}
function galKeyLabel(k) {
  const s = String(k || "");
  if (!s) return "";
  if (s === "space") return "空格键";
  return s.toUpperCase();
}
function galIns() {
  const k = window.innerWidth / GAL_FIT_CM.screenCm;
  return {
    top: Math.round(GAL_FIT_CM.top * k), left: Math.round(GAL_FIT_CM.left * k),
    bottom: Math.round(GAL_FIT_CM.bottom * k), right: Math.round(GAL_FIT_CM.right * k),
    W: window.innerWidth, H: window.innerHeight,
  };
}
function galFit(node) {
  try {
    if (!node || !node.size || !window.app || !app.canvas) return false;
    const c = app.canvas, ins = galIns();
    const cw = ins.W - ins.left - ins.right, chh = ins.H - ins.top - ins.bottom;
    if (cw < 200 || chh < 160) return false;
    if (!node.__galView) {
      node.__galView = { scale: c.ds.scale, offset: [c.ds.offset[0], c.ds.offset[1]], size: [node.size[0], node.size[1]] };
    }
    const nw = 900, nh = Math.max(320, Math.min(1200, Math.round(nw * chh / cw)));
    node.setSize([nw, nh]);
    try { if (typeof node.onResize === "function") node.onResize(node.size); } catch (e1) { /* 忽略 */ }
    const w = node.size[0], h = node.size[1];
    const scale = Math.max(0.12, Math.min(4, Math.min(cw / w, chh / h)));
    c.ds.scale = scale;
    c.ds.offset[0] = (ins.left / scale) - node.pos[0];
    c.ds.offset[1] = (ins.top / scale) - node.pos[1];
    c.setDirty(true, true);
    try { app.graph.setDirtyCanvas(true, true); } catch (e2) { /* 忽略 */ }
    node.__galFit = true;
    return true;
  } catch (e) { return false; }
}
function galRestoreView(node) {
  try {
    const v = node && node.__galView;
    if (!v) return false;
    const c = app.canvas;
    c.ds.scale = v.scale;
    c.ds.offset[0] = v.offset[0];
    c.ds.offset[1] = v.offset[1];
    try { if (v.size) node.setSize([v.size[0], v.size[1]]); } catch (e1) { /* 忽略 */ }
    try { if (typeof node.onResize === "function") node.onResize(node.size); } catch (e2) { /* 忽略 */ }
    c.setDirty(true, true);
    node.__galFit = false;
    node.__galView = null;
    return true;
  } catch (e) { return false; }
}
function galNodes() {
  try { return (app.graph._nodes || []).filter((n) => n && n.__galRoot); } catch (e) { return []; }
}
function ensureGalKey() {
  if (window.__pcGalKeyBound) return;
  window.__pcGalKeyBound = true;
  document.addEventListener("keydown", (e) => {
    try {
      if (galKeyWait) {                                  // 正在等用户按一个新键
        const nd = galKeyWait; galKeyWait = null;
        e.preventDefault(); e.stopPropagation();
        const nk = galKeyNorm(e.key);
        if (!nk) { toast("要按一个单字符键（字母 / 数字 / 空格）"); return; }
        const s = ST.get(nd);
        if (s) { s.galKey = nk; saveGal(nd); }
        render(nd);
        try { if (nd.__galSetRefresh) nd.__galSetRefresh(); } catch (e1) { /* 忽略 */ }
        toast("画廊「占满全屏」的快捷键改成：" + galKeyLabel(nk));
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const ns = galNodes();
      if (!ns.length) return;
      const k2 = galKeyNorm(e.key);
      if (!k2) return;
      // ★ 291 批（他第 3 条："工作流里有两个画廊……可以设置不同的快捷键，但无论按哪个都只放大其中一个"）
      //   两个原因：① 键值只信 ST 里那份缓存（properties 晚到时会两边都算 "f"）；
      //   ② 命中多个时永远取第 0 个。现在：键值读不到就回 properties 再查，并且**按"你现在指着/点着哪个"来选**。
      const keyOf = (n) => {
        let k = "";
        try { const s2 = ST.get(n); k = s2 && s2.galKey; } catch (e0) { k = ""; }
        if (!k) { try { k = (n.properties && n.properties.pcGal && n.properties.pcGal.key) || ""; } catch (e1) { k = ""; } }
        return String(k || "f");
      };
      const hit = ns.filter((n) => keyOf(n) === k2);
      if (!hit.length) return;
      e.preventDefault(); e.stopPropagation();
      const sel = (window.app && app.canvas && app.canvas.selected_nodes) || {};
      const under = (function () {
        try {
          const gm = window.app && app.canvas && app.canvas.graph_mouse;
          if (!gm) return null;
          return app.graph.getNodeOnPos(gm[0], gm[1], null, true) || null;
        } catch (e2) { return null; }
      })();
      const pick = hit.filter((n) => n === under)[0]
        || hit.filter((n) => sel && sel[n.id])[0]
        || hit.slice().sort((a, b) => (b.__galTouchedAt || 0) - (a.__galTouchedAt || 0))[0]
        || hit[0];
      if (pick.__galFit) galRestoreView(pick); else galFit(pick);
    } catch (err) { /* 忽略 */ }
  }, true);
}

// ---------------------------------------------------------------- 取一页
async function loadPage(node, reset) {
  const s = stOf(node);
  if (s.loading) return;
  s.loading = true;
  try {
    const q = { page: s.page, offset: reset ? 0 : s.offset, limit: PAGE_SIZE };
    const j = await apiGet("/list", q);
    s.total = j.total || 0;
    s.root = j.root || s.root;
    if (j.limits) s.limits = j.limits;
    s.items = reset ? (j.items || []) : s.items.concat(j.items || []);
    s.offset = s.items.length;
    try { await refreshCounts(node); } catch (e) { /* 忽略 */ }
  } catch (e) {
    log("拉列表失败", e);
    if (reset) { s.items = []; s.total = 0; }
    s.err = String(e.message || e);
  } finally {
    s.loading = false;
  }
  render(node);
}

async function refreshCounts(node) {
  const s = stOf(node);
  const j = await apiGet("/info");
  s.counts = j.counts || {};
  s.root = j.root || s.root;
  if (j.limits) s.limits = j.limits;
  return j;
}

function switchPage(node, page) {
  const s = stOf(node);
  if (s.page === page) return;
  s.page = page; s.offset = 0; s.items = []; s.sel.clear(); s.err = null;
  saveGal(node);            // ★ 273 批：记住在哪一页（刷新 / 重进工作流回到同一页）
  loadPage(node, true);
}

// ---------------------------------------------------------------- 动作
// ★ 273w：把这张图**复制**一份进「编辑栏」（原图留在原处），并把界面切过去、直接打开到第三层。
//   他说：「点击之后就会在输入口的画廊，把这张图加入这个新的栏位，**并且直接打开到第三层**」
async function toEditColumn(node, it) {
  try {
    const r = await apiPost("/toedit", { rel: it.rel });
    if (!r || r.success === false) { toast("加到编辑栏失败：" + ((r && r.error) || "未知原因")); return; }
    toast(r.dup ? "这张本来就在编辑栏里（已顶到最前）" : "已复制一份进编辑栏");
    const s0 = stOf(node);
    s0.page = "edit"; s0.offset = 0; s0.items = []; s0.sel.clear(); s0.err = null;
    saveGal(node);
    loadPage(node, true);
    const want = String(r.rel || it.rel);
    const t0 = Date.now();
    (function waitZoom() {
      const s1 = stOf(node);
      if (s1.page === "edit" && s1.items && s1.items.length) {
        const k = s1.items.findIndex((x) => x.rel === want);
        if (k >= 0) {
          // zoomAt 只挂在测试口 window.__pcGallery 上（模块作用域里没有同名函数）
          try {
            if (window.__pcGallery && typeof window.__pcGallery.zoomAt === "function") window.__pcGallery.zoomAt(node, k);
          } catch (eZ) { /* 忽略 */ }
          return;
        }
      }
      if (Date.now() - t0 < 5000) setTimeout(waitZoom, 130);
    })();
  } catch (e) {
    toast("加到编辑栏失败：" + (e && e.message ? e.message : e));
  }
}

// ★ 364 批（他第 3 条）：把存档里的图复制一份进「素材栏」（叠图用的透明 PNG 直接放这儿）
async function toMaterial(node, it) {
  try {
    const r = await apiPost("/material", { rel: it.rel, name: it.name || "" });
    if (!r || r.success === false) { toast("加到素材栏失败：" + ((r && r.error) || "未知原因")); return; }
    toast("已放进素材栏：" + (r.name || ""));
    const s0 = stOf(node);
    s0.page = "material"; s0.offset = 0; s0.items = []; s0.sel.clear(); s0.err = null;
    saveGal(node);
    loadPage(node, true);
  } catch (e) {
    toast("加到素材栏失败：" + (e && e.message ? e.message : e));
  }
}

async function toggleFav(node, it) {
  const s = stOf(node);
  try {
    const on = s.page !== "fav";
    await apiPost("/fav", { rel: it.rel, on: on });
    toast(on ? "已收藏（不占主页名额）" : "已取消收藏");
    await loadPage(node, true);
  } catch (e) { toast("收藏失败：" + e.message, true); }
}

function downloadOne(it) {
  const a = document.createElement("a");
  a.href = imgUrl(it.rel);
  a.download = it.name || "image.png";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function purgeOne(node, it) {
  try {
    await apiPost("/purge", { rels: [it.rel] });
    toast("已彻底删除");
    await loadPage(node, true);
  } catch (e) { toast("删除失败：" + e.message, true); }
}

async function trashOne(node, it) {
  // ★ 364 批（他："在回收站里的图片，点击删除会把图片放到回收站？回收站里删除肯定就直接删了"）
  if (stOf(node).page === "trash") return purgeOne(node, it);
  try {
    await apiPost("/trash", { rels: [it.rel] });
    toast("已移进回收站（可恢复）");
    await loadPage(node, true);
  } catch (e) { toast("删除失败：" + e.message, true); }
}

// ★ 256 批：批量收藏（后端 /fav 一次只收一张，这里逐张调）
async function favMany(node) {
  const s = stOf(node);
  const rels = [...s.sel].filter(function (r) { return !/^收藏\//.test(String(r)); });
  const already = s.sel.size - rels.length;
  if (!rels.length) { toast(already ? "勾的这些都已经在收藏里了" : "先勾几张再点收藏"); return; }
  let ok = 0, bad = 0;
  for (const rel of rels) {
    try { await apiPost("/fav", { rel: rel, on: true }); ok++; } catch (e) { bad++; }
  }
  toast("已收藏 " + ok + " 张" + (bad ? ("，" + bad + " 张失败") : "") + (already ? ("（另有 " + already + " 张本来就在收藏里）") : ""));
  s.sel.clear();
  await loadPage(node, true);
}

async function trashMany(node) {
  const s = stOf(node);
  const rels = [...s.sel];
  if (!rels.length) return;
  try {
    await apiPost("/trash", { rels: rels });
    toast("已移进回收站 " + rels.length + " 张（可恢复）");
    s.sel.clear();
    await loadPage(node, true);
  } catch (e) { toast("删除失败：" + e.message, true); }
}

async function restoreMany(node) {
  const s = stOf(node);
  const rels = [...s.sel];
  if (!rels.length) return;
  try {
    await apiPost("/restore", { rels: rels });
    toast("已恢复 " + rels.length + " 张");
    s.sel.clear();
    await loadPage(node, true);
  } catch (e) { toast("恢复失败：" + e.message, true); }
}

async function purgeMany(node) {
  const s = stOf(node);
  const rels = [...s.sel];
  if (!rels.length) return;
  confirm2("彻底删掉这 " + rels.length + " 张？", "回收站里就没了，找不回来。", "彻底删", async () => {
    try {
      await apiPost("/purge", { rels: rels });
      toast("已彻底删除 " + rels.length + " 张");
      s.sel.clear();
      await loadPage(node, true);
    } catch (e) { toast("删除失败：" + e.message, true); }
  });
}

// 轻提示（不打断操作；跟项目里别处一个口径）
let toastEl = null;
function toast(msg, bad) {
  try {
    if (toastEl) toastEl.remove();
    toastEl = el("div", "position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:100095;"
      + "max-width:min(520px,88vw);padding:9px 15px;border-radius:10px;font:12.5px/1.5 system-ui,'Microsoft YaHei';"
      + "box-shadow:0 10px 30px rgba(0,0,0,.45);"
      + (bad ? "background:rgba(120,26,40,.96);color:#ffe3e8;border:1px solid rgba(255,120,140,.55)"
             : "background:rgba(24,34,50,.96);color:#e6eefc;border:1px solid rgba(120,160,230,.5)"), msg);
    document.body.appendChild(toastEl);
    setTimeout(() => { try { if (toastEl) toastEl.remove(); toastEl = null; } catch (e) { /* 忽略 */ } }, 2600);
  } catch (e) { /* 忽略 */ }
}

// 两段式确认（零原生弹窗：不用 window.confirm）。结果走回调 —— 因为这里没有"同步返回值"可言
function confirm2(title, msg, okLabel, onOk) {
  const back = el("div", "position:fixed;inset:0;z-index:100096;background:rgba(3,6,10,.6);"
    + "display:flex;align-items:center;justify-content:center");
  const box = el("div", "width:min(430px,90vw);background:#151a23;border:1px solid #3d444d;border-radius:12px;"
    + "padding:16px 18px;box-shadow:0 18px 50px rgba(0,0,0,.6);font:12.5px/1.7 system-ui,'Microsoft YaHei';color:#e8eaf1");
  const h = el("div", "font-weight:700;font-size:13.5px;margin-bottom:8px", title);
  const p = el("div", "color:rgba(210,220,235,.82);white-space:pre-wrap", msg);
  const row = el("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:14px");
  const bC = el("button", "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.4);background:rgba(255,255,255,.06);color:#dfe6ee", "取消");
  const bO = el("button", "font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;"
    + "border:1px solid rgba(255,120,120,.6);background:#b93636;color:#fff;font-weight:700", okLabel || "确定");
  row.appendChild(bC); row.appendChild(bO);
  box.appendChild(h); box.appendChild(p); box.appendChild(row);
  back.appendChild(box); document.body.appendChild(back);
  const kill = () => { try { back.remove(); } catch (e) { /* 忽略 */ } };
  bC.addEventListener("click", kill);
  bO.addEventListener("click", () => { kill(); try { if (onOk) onOk(); } catch (e) { log(e); } });
  back.addEventListener("click", (e) => { if (e.target === back) kill(); });
  return back;
}

// ---------------------------------------------------------------- 渲染
// ---------------------------------------------------------------- 分组（237 批：第二层 = 一次生成的那几张）
// 同一批执行存下来的图带同一个 batch id；老图没有 batch → 每张自己一组。
function groupOf(items, flat) {
  // ★ 238 批：flat = true 时"一次生成的几张也各占一格"（他说的"分开放"）
  if (flat) return (items || []).map((it) => ({ key: "one:" + it.rel, batch: it.batch || "", items: [it], flat: true }));
  const out = [], map = new Map();
  (items || []).forEach((it) => {
    const k = it.batch || ("one:" + it.rel);
    let g = map.get(k);
    if (!g) { g = { key: k, batch: it.batch || "", items: [] }; map.set(k, g); out.push(g); }
    g.items.push(it);
  });
  return out;
}
function groupByKey(node, key) {
  const s = stOf(node);
  const hit = groupOf(s.items, s.flat).filter((g) => g.key === key)[0];
  if (hit) return hit;
  // ★ 273b：平铺模式下每张自己一组 → 出图后要"按 batch 进第二层"时再用不看平铺的方式找一次
  return groupOf(s.items, false).filter((g) => g.key === key)[0] || null;
}
// 第三层翻页时用哪一串：在第二层里就只翻这一组
function zoomList(node) {
  const s = stOf(node);
  if (s.level === 2) {
    const g = groupByKey(node, s.groupKey);
    if (g) return g.items;
  }
  return s.items;
}

// ---------------------------------------------------------------- 渲染
function render(node) {
  const s = stOf(node);
  const box = node.__galRoot;
  if (!box) return;
  box.classList.toggle("multi", s.multi);
  // 页签
  const tabN = { home: s.counts.home, fav: s.counts.fav, trash: s.counts.trash };
  box.querySelectorAll("[data-galpage]").forEach((b) => {
    const pg = b.getAttribute("data-galpage");
    b.classList.toggle("on", pg === s.page);
    const n = b.querySelector(".gal-n");
    if (n) n.textContent = (tabN[pg] == null ? "" : String(tabN[pg]));
  });

  const groups = groupOf(s.items, s.flat);

  // ---------- 第一层：网格（一格 = 一组）----------
  const grid = box.querySelector(".gal-grid");
  grid.innerHTML = "";
  if (!s.items.length) {
    const msg = s.err ? ("拉不到列表：" + s.err)
      : (s.page === "trash" ? "回收站是空的。删掉的图会先来这里，随时能恢复。"
        : s.page === "edit" ? "编辑栏还是空的。拿去重绘 / 融图 / 叠图的图会自动复制一份到这里；出图后右键「➕ 加到编辑栏」也能放进来。"
        : s.page === "fav" ? "还没有收藏。图上那颗 ♥ 就是收藏 —— 收藏不占主页名额，也不会被顶掉。"
          : "还没有图。把这个节点接在 VAEDecode 后面，出一张就自动存一张（带 workflow 元数据）。");
    const d = el("div", "grid-column:1/-1", msg);
    d.className = "gal-empty";
    grid.appendChild(d);
  }
  groups.forEach((g) => {
    const it = g.items[0];
    const allSel = g.items.every((x) => s.sel.has(x.rel));
    const cell = el("div", "");
    cell.className = "gal-cell" + (allSel ? " sel" : "");
    cell.setAttribute("data-gkey", g.key);
    const im = el("img", "");
    im.loading = "lazy";
    im.src = imgUrl(it.rel);
    im.alt = it.name || "";
    im.draggable = false;
    cell.appendChild(im);
    // 左上角勾选框（唯一的那一颗）
    const chk = el("div", "");
    chk.className = "gal-chk";
    cell.appendChild(chk);
    // 组角标：一组几张
    if (g.items.length > 1) {
      const c = el("div", "", "×" + g.items.length);
      c.className = "gal-count";
      c.title = "这一组共 " + g.items.length + " 张（点开看全组）";
      cell.appendChild(c);
    }
    // ★ 273k（他第 3 条）：左下角小三角 —— 蓝=文生图 / 橙=局部重绘
    if (stOf(node).showKind !== false) {
      const kd = String(it.kind || "gen");
      const tri = el("div", "");
      tri.className = "gal-tri " + (kd === "inpaint" ? "inpaint" : "gen");
      tri.title = (kd === "inpaint" ? "局部重绘出的" : "文生图出的") + "（请神时别请错工作流）";
      cell.appendChild(tri);
    }
    // 右上角三颗标记（237 批：多选框已经挪到左上角，这里不再重复）
    const marks = el("div", "");
    marks.className = "gal-marks";
    const mkFav = el("div", "", s.page === "fav" ? "♥" : "♡");
    mkFav.className = "gal-mk fav";
    mkFav.title = (s.page === "fav" ? "取消收藏" : "收藏") + (g.items.length > 1 ? "（这一组 " + g.items.length + " 张）" : "（不占主页名额）");
    const mkDl = el("div", "", "⤓");
    mkDl.className = "gal-mk";
    mkDl.title = g.items.length > 1 ? ("下载这一组 " + g.items.length + " 张") : "下载到电脑";
    const mkDel = el("div", "", "🗑");
    mkDel.className = "gal-mk del";
    mkDel.title = "删除" + (g.items.length > 1 ? "这一组（" + g.items.length + " 张）" : "") + "（进回收站，可恢复）";
    marks.appendChild(mkFav); marks.appendChild(mkDl); marks.appendChild(mkDel);
    cell.appendChild(marks);

    im.addEventListener("click", () => {
      const st0 = stOf(node);
      // ★ 273j（他第 10 条）：自动忽略第二层 —— 平铺（一格一张）直接进第三层；按组且这组多张时仍进第二层
      if (st0.autoSkip2 && g.items.length === 1) { openZoom(node, g.items[0].rel); return; }
      if (st0.autoSkip2 && st0.flat) { openZoom(node, g.items[0].rel); return; }
      enterGroup(node, g);
    });
    chk.addEventListener("click", (e) => { e.stopPropagation(); toggleSelGroup(node, g); });
    mkFav.addEventListener("click", (e) => { e.stopPropagation(); toggleFavGroup(node, g); });
    mkDl.addEventListener("click", (e) => { e.stopPropagation(); g.items.forEach((x) => downloadOne(x)); });
    mkDel.addEventListener("click", (e) => { e.stopPropagation(); trashGroup(node, g); });
    cell.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(node, e.clientX, e.clientY, it, g);
    });
    grid.appendChild(cell);
  });

  // ---------- 底部条 ----------
  const foot = box.querySelector(".gal-foot");
  foot.innerHTML = "";
  const noteTxt = s.total
    ? ("共 " + s.total + " 张" + (groups.length !== s.items.length ? " / 已显示 " + groups.length + " 组" : "，已显示 " + s.items.length))
    : "共 0 张";
  const nl = el("div", "", noteTxt);
  nl.className = "gal-note";
  foot.appendChild(nl);
  if (s.multi) {
    const c = el("button", "", "已勾 " + s.sel.size + " 张");
    c.className = "gal-mini";
    foot.appendChild(c);
    const sp = el("div", ""); sp.className = "gal-sp"; foot.appendChild(sp);
    if (s.page === "trash") {
      const bR = el("button", "", "↩ 恢复");
      bR.className = "gal-mini";
      bR.addEventListener("click", () => restoreMany(node));
      foot.appendChild(bR);
      const bP = el("button", "", "🧨 彻底删");
      bP.className = "gal-mini";
      bP.addEventListener("click", () => purgeMany(node));
      foot.appendChild(bP);
    } else {
      // ★ 256 批（他："画廊中的多选功能竟然没有收藏多选"）
      const bF = el("button", "", "♥ 收藏选中");
      bF.className = "gal-mini";
      bF.title = "把勾上的这些搬进「收藏」—— 搬过去就不再占主页那 500 张的名额";
      bF.addEventListener("click", () => favMany(node));
      foot.appendChild(bF);
      const bT = el("button", "", "🗑 删除选中");
      bT.className = "gal-mini";
      bT.addEventListener("click", () => trashMany(node));
      foot.appendChild(bT);
    }
    const bC = el("button", "", "退出多选");
    bC.className = "gal-mini";
    bC.addEventListener("click", () => { s.multi = false; s.sel.clear(); render(node); });
    foot.appendChild(bC);
  } else {
    const sp = el("div", ""); sp.className = "gal-sp"; foot.appendChild(sp);
    const l = el("div", "");
    l.className = "gal-note";
    l.textContent = "上限：主页 " + (s.limits.home || 500) + " 张 / 回收站 " + (s.limits.trash || 100)
    + " 张 / 编辑栏 " + (s.limits.edit || 200) + " 张 · 素材不限（收藏不算）";
    foot.appendChild(l);
  }

  // ---------- 第二层：这一组并排 ----------
  const gp = box.querySelector(".gal-group");
  const g2 = s.level === 2 ? groupByKey(node, s.groupKey) : null;
  if (g2) {
    gp.classList.add("on");
    paintGroup(node, gp, g2);
  } else {
    gp.classList.remove("on");
    if (s.level === 2) s.level = 1;     // 组没了（被删/换页）就退回第一层
    gp.innerHTML = "";
  }

  // ---------- 第三层：单张放大 ----------
  const z = box.querySelector(".gal-zoom");
  if (s.zoom) {
    z.classList.add("on");
    const cur = zoomList(node).filter((x) => x.rel === s.zoom)[0]
      || s.items.filter((x) => x.rel === s.zoom)[0];
    const zi = z.querySelector("img");
    if (zi && cur) zi.src = imgUrl(cur.rel);
    const zn = z.querySelector(".gal-zname");
    if (zn) zn.textContent = (cur ? ("第 3 层 · ⤴ 这张会输出 · " + (cur.day || "") + " · " + (cur.name || "")) : "");
    // ★ 273h：两个输出口都连着 → 显示「在遮罩编辑器里打开」
    try {
      const outs = node.outputs || [];
      const linked = outs.length > 1 && (outs[0].links || []).length > 0 && (outs[1].links || []).length > 0;
      const btn = z.querySelector(".gal-mini[title^='在这张图上涂蒙版']") || node.__galMaskBtn;
      try {
        const m4 = node.__galMask4Btn;
        if (m4 && cur) {
          const known = stOf(node).hasMask && stOf(node).hasMask[cur.rel];
          m4.style.display = known ? "" : "none";
          if (known === undefined) maskFlag(node, cur.rel, () => { try { render(node); } catch (e) {} });
        } else if (m4) m4.style.display = "none";
      } catch (e) { /* 忽略 */ }
      if (btn) btn.style.display = (linked && cur) ? "" : "none";
    } catch (e) { /* 忽略 */ }
  } else {
    z.classList.remove("on");
  }
  // ★ 274：设置一变就同步给后端那个隐藏控件（有变化才写，不会抖）
  try { syncCropWidget(node); } catch (e) { /* 忽略 */ }
}

// 第二层：把这一组一张张并排铺开（右上角红叉回第一层）
function paintGroup(node, gp, g) {
  const s = stOf(node);
  gp.innerHTML = "";
  const bar = el("div", "");
  bar.className = "gal-gbar";
  const ttl = el("div", "", "这一组 " + g.items.length + " 张 · " + (g.items[0].day || ""));
  ttl.className = "gal-gttl";
  // ★ 273i：第二层标层号；只有 1 张时特别说明（不然和第三层长得太像）
  const l2 = el("span", "", g.items.length === 1 ? "第 2 层（这组只有 1 张）" : ("第 2 层 · " + g.items.length + " 张"));
  l2.className = "gal-layer l2";
  ttl.textContent = "";
  ttl.appendChild(l2);
  ttl.appendChild(document.createTextNode((g.items[0].day || "")));
  bar.appendChild(ttl);
  const sp = el("div", ""); sp.style.cssText = "flex:1 1 auto"; bar.appendChild(sp);
  const x = el("div", "", "✕");
  x.className = "gal-gclose";
  x.title = "回到主页";
  x.addEventListener("click", () => { s.level = 1; s.groupKey = null; render(node); });
  bar.appendChild(x);
  gp.appendChild(bar);

  const body = el("div", "");
  body.className = "gal-gbody";
  g.items.forEach((it, i) => {
    const box2 = el("div", "");
    box2.className = "gal-gitem";
    box2.setAttribute("data-rel", it.rel);
    const im = el("img", "");
    im.src = imgUrl(it.rel);
    im.alt = it.name || "";
    im.draggable = false;
    im.loading = "lazy";
    box2.appendChild(im);
    const idx = el("div", "", String(i + 1));
    idx.className = "gal-gidx";
    box2.appendChild(idx);
    im.addEventListener("click", () => openZoom(node, it.rel));
    box2.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(node, e.clientX, e.clientY, it, g);
    });
    body.appendChild(box2);
  });
  gp.appendChild(body);
}

function enterGroup(node, g) {
  const s = stOf(node);
  s.level = 2;
  s.groupKey = g.key;
  s.zoom = null;
  render(node);
}

function toggleSel(node, rel, enterMulti) {
  const s = stOf(node);
  if (enterMulti && !s.multi) s.multi = true;
  if (s.sel.has(rel)) s.sel.delete(rel); else s.sel.add(rel);
  render(node);
}
// 第一层勾选 = 整组一起勾
function toggleSelGroup(node, g) {
  const s = stOf(node);
  const all = g.items.every((x) => s.sel.has(x.rel));
  g.items.forEach((x) => { if (all) s.sel.delete(x.rel); else s.sel.add(x.rel); });
  if (!s.multi) s.multi = true;
  render(node);
}

function askTrash(node, it) {
  // 删除 = 进回收站（可恢复），所以不再二次确认；真要彻底删在回收站页才问
  trashOne(node, it);
}

async function trashGroup(node, g) {
  // ★ 364 批：回收站页里删除 = 直接彻底删（不再"搬进回收站"）
  if (stOf(node).page === "trash") {
    try {
      await apiPost("/purge", { rels: g.items.map((x) => x.rel) });
      toast(g.items.length > 1 ? ("这一组 " + g.items.length + " 张已彻底删除") : "已彻底删除");
      await loadPage(node, true);
    } catch (e) { toast("删除失败：" + e.message, true); }
    return;
  }
  try {
    await apiPost("/trash", { rels: g.items.map((x) => x.rel) });
    toast(g.items.length > 1 ? ("这一组 " + g.items.length + " 张已移进回收站（可恢复）") : "已移进回收站（可恢复）");
    await loadPage(node, true);
  } catch (e) { toast("删除失败：" + e.message, true); }
}

async function toggleFavGroup(node, g) {
  const s = stOf(node);
  const on = s.page !== "fav";
  try {
    for (const it of g.items) await apiPost("/fav", { rel: it.rel, on: on });
    toast(on ? ("已收藏" + (g.items.length > 1 ? "这一组 " + g.items.length + " 张" : "") + "（不占主页名额）") : "已取消收藏");
    await loadPage(node, true);
  } catch (e) { toast("收藏失败：" + e.message, true); }
}

// ★ 273e 批（他："给画廊放一个输出口…画廊给哪个图放第三层单图展示，就说明输出哪张图"）
//   把"第三层那张"写进节点上那个隐藏控件「选中的图」，后端跑的时候读它把图读回来当 IMAGE 输出。
function pickedWidget(node) {
  try { return (node.widgets || []).find((w) => w && w.name === "选中的图") || null; } catch (e) { return null; }
}

// ★ 274 批（他："不要给我工作流了，给了我也不会用的，裁切放大能不能并入画廊里面，最好是自动裁切"）
//   局部重绘 = 自动裁切放大 + 重绘后按原坐标贴回，全部在这颗节点里做（**零新连线**）。
//   设置存在 properties.pcGal.crop（余量用百分数存），运行时同步给后端那个隐藏控件「局部重绘」。
// ★ 285 批（他："羽化膨胀初始 0 还是太过分了一点吧？不应该初始就来一个比较合适的数吗"）
//   → 羽化 16px、膨胀 12px 当出厂值（他随时能改，0 仍然是"自动羽化 2%"）
const CROP_DEF = { mode: "auto", pad: 35, target: 1024, feather: 16, expand: 12 };
function galCropOf(node) {
  let c = null;
  try { c = stOf(node).crop; } catch (e) { c = null; }
  c = (c && typeof c === "object") ? c : {};
  const mode = (c.mode === "off" || c.mode === "always") ? c.mode : "auto";
  const pad = Number.isFinite(Number(c.pad)) ? Number(c.pad) : CROP_DEF.pad;
  const target = Number(c.target) > 0 ? Number(c.target) : CROP_DEF.target;
  const feather = Number.isFinite(Number(c.feather)) ? Number(c.feather) : CROP_DEF.feather;
  const expand = Number.isFinite(Number(c.expand)) ? Number(c.expand) : CROP_DEF.expand;
  return {
    mode: mode,
    pad: Math.max(0, Math.min(150, pad)) / 100,
    target: Math.max(512, Math.min(1536, Math.round(target))),
    // ★ 283：羽化（贴回时边缘软多少）+ 膨胀（蒙版先长几像素）
    feather: Math.max(0, Math.min(200, Math.round(feather))),
    expand: Math.max(0, Math.min(200, Math.round(expand))),
  };
}
function cropWidgetOf(node) {
  try { return (node.widgets || []).find((w) => w && w.name === "局部重绘") || null; } catch (e) { return null; }
}
function syncCropWidget(node) {
  try {
    const w = cropWidgetOf(node);
    if (!w) return false;
    const c = galCropOf(node);
    const txt = JSON.stringify({ mode: c.mode, pad: Math.round(c.pad * 100), target: c.target,
                                 feather: c.feather || 0, expand: c.expand || 0 });
    if (String(w.value || "") !== txt) {
      w.value = txt;
      try { node.graph && node.graph.change && node.graph.change(); } catch (e) { /* 忽略 */ }
    }
    return true;
  } catch (e) { return false; }
}
function setPicked(node, rel) {
  try {
    const w = pickedWidget(node);
    if (!w) return false;
    w.value = rel ? String(rel) : "";
    try { node.graph && node.graph.change && node.graph.change(); } catch (e) { /* 忽略 */ }
    return true;
  } catch (e) { return false; }
}
function pickedName(node) {
  const w = pickedWidget(node);
  const v = w ? String(w.value || "") : "";
  if (!v) return "";
  const i = v.lastIndexOf("/");
  return i >= 0 ? v.slice(i + 1) : v;
}
function openZoom(node, rel) {
  stOf(node).zoom = rel;
  setPicked(node, rel);          // ★ 273e：点开到第三层 = 这张就是画廊要输出的那张
  render(node);
}

// ★ 273h 批（他："画廊右键没有那个「在遮罩编辑器里打开」……具体实行方式是在画廊的两个输出端口都连接时，
//   画廊第 3 层会有在遮罩编辑器里打开这个按键"）→ 两个输出口都连上时，第三层放大条上出现这颗键，
//   点开就是一个涂蒙版的小窗：白色 = 要重绘。蒙版单独存一张 PNG（不动原图），画廊的 MASK 输出优先读它。
let maskUI = null;
function closeMaskUI() {
  if (maskUI) { try { maskUI.remove(); } catch (e) { /* 忽略 */ } maskUI = null; }
}
function openMaskUI(node, rel) {
  // ★ 273n：这几个必须先声明（图片可能同步命中缓存 → drawAll 会在声明之前被调到）
  var objs = [], obj = null, dragObj = null;
  closeMaskUI();
  injectStyle();
  // ★ 273k 批（他第 2 条）：窗口重做——工具全部挪到左右两侧一排；图形不再标尺寸，
  //   改成右下角一个小方框里"拖出多大、盖上去就多大"；点形状按钮 = 在画面正中央放一个图案，
  //   之后可以拖动、拖角缩放、拖上面的把手旋转。
  const KEY = "promptCopier.galMaskShape.v1";
  function loadSt() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
      return { kind: String(o.kind || "brush"), color: String(o.color || "#ffffff"),
               size: Math.max(4, parseInt(o.size, 10) || 40),
               w: Math.max(8, parseInt(o.w, 10) || 160), h: Math.max(8, parseInt(o.h, 10) || 120),
               sq: Math.max(8, parseInt(o.sq, 10) || 140), ci: Math.max(8, parseInt(o.ci, 10) || 140) };
    } catch (e) { return { kind: "brush", color: "#ffffff", size: 40, w: 160, h: 120, sq: 140, ci: 140 }; }
  }
  const st1 = loadSt();
  function saveSt() { try { localStorage.setItem(KEY, JSON.stringify(st1)); } catch (e) { /* 忽略 */ } }

  const back = el("div", "position:fixed;inset:0;z-index:99997;background:rgba(8,11,18,.86);display:flex;align-items:center;justify-content:center");
  const card = el("div", "background:#1b2030;color:#e8eaf1;border:1px solid rgba(150,162,180,.4);border-radius:14px;"
    + "box-shadow:0 18px 50px rgba(0,0,0,.6);width:min(1280px,96vw);height:min(900px,94vh);"
    + "display:grid;grid-template-rows:auto 1fr auto;gap:8px;padding:10px 12px;box-sizing:border-box");
  const head = el("div", "display:flex;align-items:center;gap:8px;font:600 13px/1.4 system-ui,'Microsoft YaHei',sans-serif");
  const ttl = el("div", "", "🖌 画蒙版（涂到的地方 = 要重绘）");
  ttl.style.flex = "1 1 auto";
  // ★ 273x：这里原来写「第 3 层 · 蒙版」—— 第 3 层是"单张放大"那层，编辑器是另一扇窗，别跟层号混着叫
  const layerTag = el("span", "", "编辑图片");
  layerTag.className = "gal-layer l3";
  const xb = el("button", "border:none;background:transparent;color:#b9c2d4;cursor:pointer;font:16px/1 system-ui", "✕");
  xb.addEventListener("click", () => { closeMaskUI(); render(node); });
  head.appendChild(ttl); head.appendChild(layerTag); head.appendChild(xb);
  card.appendChild(head);

  // ---- 中间：舞台（左右两条工具栏夹着它） ----
  const body = el("div", "display:grid;grid-template-columns:96px 1fr 128px;gap:10px;min-height:0");
  card.appendChild(body);

  // ★ 374 批（他："编辑图片时左边那一排最下面居然有左右滑块，根本没有什么用"）→ 只留竖向滚动
  const railL = el("div", "display:flex;flex-direction:column;gap:6px;overflow-y:auto;overflow-x:hidden;padding-right:2px");
  const railR = el("div", "display:flex;flex-direction:column;gap:6px;align-items:center");
  const stage = el("div", "position:relative;min-height:0;min-width:0;background:#0b0e16;border:1px solid rgba(150,162,180,.28);"
    + "border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden");
  body.appendChild(railL); body.appendChild(stage); body.appendChild(railR);

  // ★ 386 批（他："滚轮调整放大、缩小时，底图和素材不会同步的问题仍然存在"）
  //   前两轮我都在**算**（给每个元素各写一句补偿 transform），只要有一处算不准就还是错位。
  //   这次改成**结构上保证**：底图 / 蒙版层 / 交互层 / 素材层全部装进同一个 viewW，
  //   视口只对 viewW 做一次 translate+scale —— 它们永远同处一个坐标系，物理上不可能再各走各的。
  const viewW = el("div", "position:absolute;left:0;top:0;width:100%;height:100%;display:flex;"
    + "align-items:center;justify-content:center;transform-origin:0 0;will-change:transform");
  stage.appendChild(viewW);

  const base = el("img", "display:block;max-width:100%;max-height:100%;user-select:none;-webkit-user-drag:none");
  base.draggable = false;
  base.src = imgUrl(rel);
  viewW.appendChild(base);
  const cv = document.createElement("canvas");          // 蒙版层
  cv.style.cssText = "position:absolute;pointer-events:none;opacity:.5";   // ★ 273l：半透明在整层，笔迹不互相叠加
  viewW.appendChild(cv);
  const ov = document.createElement("canvas");          // 交互层（笔刷光标 / 浮动图案 / 把手）
  ov.style.cssText = "position:absolute;cursor:crosshair;touch-action:none";
  viewW.appendChild(ov);

  function mk(txt, title, cls) {
    const b = el("button", "font:12.5px system-ui;padding:6px 6px;border-radius:8px;cursor:pointer;"
      + "border:1px solid rgba(150,162,180,.45);background:rgba(255,255,255,.06);color:#e8eaf1;text-align:left;"
      + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis", txt);
    if (title) b.title = title;
    if (cls) b.className = cls;
    return b;
  }
  const tools = [
    ["brush", "🖌 笔刷"], ["sq", "□ 方形"], ["ci", "○ 圆形"], ["rect", "▭ 矩形"], ["ell", "⬭ 椭圆"],
    ["drop", "💧 吸管"], ["eraser", "🧽 橡皮"], ["clear", "🧹 全清"], ["undo", "↩ 撤回"],
  ];
  const tBtn = {};
  var activeTool = "";
  function setActiveTool(k) {
    activeTool = k;
    Object.keys(tBtn).forEach((kk) => {
      const b = tBtn[kk];
      const on = (kk === k);
      b.style.background = on ? "linear-gradient(135deg,#7c5cff,#3b82f6)" : "rgba(255,255,255,.06)";
      b.style.borderColor = on ? "#c7d7ff" : "rgba(150,162,180,.45)";
      b.style.color = on ? "#fff" : "#e8eaf1";
      b.style.fontWeight = on ? "700" : "400";
      b.style.boxShadow = on ? "0 0 0 2px rgba(124,92,255,.35), 0 0 10px rgba(124,92,255,.45)" : "none";
      b.style.transform = on ? "translateX(2px)" : "none";
    });
    try { setState("当前工具：" + (({ brush: "笔刷", sq: "方形", ci: "圆形", rect: "矩形", ell: "椭圆", drop: "吸管", eraser: "橡皮" })[k] || k)); } catch (e) { /* 忽略 */ }
  }
  function toolTip(k) {
    if (k === "drop") return "点一下：把相邻、颜色相近的一整块都涂上";
    if (k === "brush") return "自由涂抹";
    if (k === "eraser") return "擦掉涂过的";
    if (k === "clear") return "整张清空（可撤回）";
    if (k === "undo") return "退回上一步（最多 30 步）";
    return "选它：在右边小方框里拖出大小，再点这个按钮 = 放到画面正中（可拖动 / 拖角缩放 / 拖把手旋转）";
  }
  tools.forEach(([k, label]) => {
    const b = mk(label, toolTip(k));
    b.addEventListener("click", () => {
      if (k === "undo") { doUndo(); return; }
      if (k === "clear") { snapMask(); ctx.clearRect(0, 0, cv.width, cv.height); setState("已全清（可以 ↩ 撤回）"); return; }
      if (k === "eraser") {
        // 橡皮保持"开关式"：点一下开、再点一下回到上一个工具（他习惯这么用）。
        // 关键是**任何别的工具被点时都要把它关掉**（见下面 erasing = false）。
        erasing = !erasing;
        if (erasing) setActiveTool("eraser"); else setActiveTool(st1.kind);
        return;
      }
      if (k === "drop") { erasing = false; st1.kind = "drop"; saveSt(); setActiveTool("drop"); drawAll(); setState("吸管：在图上点一下"); return; }
      if (obj) { commitObj(); }
      // ★ 273v（他报的 bug）：「笔刷和橡皮在来回切的时候，会完全导致选中笔刷但使用橡皮，
      //   想要换回笔刷要点橡皮」—— 橡皮是**开关式**（erasing = !erasing），而别的工具是**选中式**，
      //   切到别的工具时忘了把 erasing 关掉 → 按钮高亮成笔刷，画的时候还在擦。
      erasing = false;
      st1.kind = k; saveSt(); setActiveTool(k); drawAll(); drawTemplate();
      if (k !== "brush") { placeObj(); }
    });
    tBtn[k] = b;
    railL.appendChild(b);
  });
  setActiveTool(st1.kind === "drop" ? "drop" : st1.kind);
  const colorL = el("label", "display:flex;align-items:center;gap:6px;font:11.5px system-ui;padding:4px 2px;cursor:pointer");
  const colorIn = document.createElement("input");
  colorIn.type = "color"; colorIn.value = st1.color;
  colorIn.style.cssText = "width:34px;height:24px;padding:0;border:1px solid rgba(150,162,180,.45);border-radius:6px;background:transparent;cursor:pointer";
  colorIn.addEventListener("input", () => { st1.color = colorIn.value; saveSt(); });
  colorL.appendChild(colorIn);
  colorL.appendChild(document.createTextNode("颜色"));
  railL.appendChild(colorL);
  const brushSize = document.createElement("input");
  brushSize.type = "range"; brushSize.min = "4"; brushSize.max = "140"; brushSize.value = String(st1.size);
  brushSize.title = "笔刷大小（只影响笔刷）";
  brushSize.style.cssText = "width:100%;accent-color:#7c5cff";
  brushSize.addEventListener("input", () => { st1.size = parseInt(brushSize.value, 10) || 40; saveSt(); });
  railL.appendChild(brushSize);
  const tolLabel = el("div", "font:11px/1.4 system-ui;opacity:.75", "吸管宽容度");
  const tol = document.createElement("input");
  tol.type = "range"; tol.min = "5"; tol.max = "120"; tol.value = String(st1.tol || 34);
  tol.title = "越大越能把颜色差得多的部分也算进来";
  tol.style.cssText = "width:100%;accent-color:#ffb020";
  tol.addEventListener("input", () => { st1.tol = parseInt(tol.value, 10) || 34; saveSt(); });
  railL.appendChild(tolLabel); railL.appendChild(tol);
  // ★ 273l（他第 6 条）：颜色从固定几种里挑（笔刷 + 第 4 层共用这一个）
  const PALETTE = ["#ffffff", "#ff3b5c", "#ffb020", "#4ade80", "#3b82f6", "#a855f7"];
  const palRow = el("div", "display:flex;flex-wrap:wrap;gap:4px;padding:2px 0");
  const palBtns = {};
  PALETTE.forEach((c) => {
    const b = el("button", "width:18px;height:18px;border-radius:5px;cursor:pointer;border:2px solid "
      + (st1.color === c ? "#fff" : "rgba(150,162,180,.5)"), "");
    b.style.background = c;
    b.title = "用这个颜色";
    b.addEventListener("click", () => {
      st1.color = c; saveSt();
      Object.keys(palBtns).forEach((k2) => { palBtns[k2].style.borderColor = (k2 === c) ? "#fff" : "rgba(150,162,180,.5)"; });
    });
    palBtns[c] = b;
    palRow.appendChild(b);
  });
  railL.appendChild(palRow);
  const tip50 = el("div", "font:11px/1.4 system-ui;opacity:.6", "画上去固定 50% 透明（重叠不加深）");
  railL.appendChild(tip50);

  // ★ 273l（他第 3 条："算了吧，去掉模板"）→ 模板框整块不做了；tpl 只留一个离屏 canvas 给旧函数兜底
  const tpl = document.createElement("canvas");
  tpl.width = 108; tpl.height = 108;
  const tplTitle = { style: {} }, tplNote = { style: {} };
  const btnStamp = mk("✓ 盖上", "把当前浮动的图案真正涂进蒙版");
  btnStamp.style.display = "none";
  btnStamp.addEventListener("click", () => { if (obj) { commitObj(); setState("已盖上一个图案"); } });
  railR.appendChild(btnStamp);
  const btnDropObj = mk("✕ 取消图案", "把浮动的图案撤掉（不涂进去）");
  btnDropObj.style.display = "none";
  btnDropObj.addEventListener("click", () => { obj = null; syncObjBtns(); drawAll(); });
  railR.appendChild(btnDropObj);
  // ★ 364 批（他第 5 条："画蒙版时如果拉出一个图形，右边除了盖上 / 取消图案，再加一个键：
  //   把图案下的内容裁剪进素材"）→ 用图形当剪切蒙版，把底图那块裁成透明 PNG 存进「素材」栏。
  const btnCropMat = mk("✂ 裁进素材", "把图案盖住的那块画面裁成透明 PNG，存进「素材」栏（叠图用）");
  btnCropMat.style.display = "none";
  btnCropMat.addEventListener("click", async () => {
    if (!obj) return;
    try {
      const o = obj;
      const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
      const hw = o.w / 2, hh = o.h / 2;
      const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
        x: o.cx + x * c - y * s, y: o.cy + x * s + y * c,
      }));
      const minX = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))));
      const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
      const maxX = Math.min(base.naturalWidth, Math.ceil(Math.max(...pts.map((p) => p.x))));
      const maxY = Math.min(base.naturalHeight, Math.ceil(Math.max(...pts.map((p) => p.y))));
      const w = maxX - minX, h = maxY - minY;
      if (w < 4 || h < 4) { toast("图案太小或者跑到画面外了", true); return; }
      const out = document.createElement("canvas");
      out.width = w; out.height = h;
      const c2 = out.getContext("2d");
      c2.drawImage(base, -minX, -minY, base.naturalWidth, base.naturalHeight);   // 底图按原尺寸搬进来
      c2.globalCompositeOperation = "destination-in";                            // 只留图形里的
      c2.save(); c2.translate(-minX, -minY);
      objPath(c2, o);
      c2.fill(); c2.restore();
      c2.globalCompositeOperation = "source-over";
      let url = "";
      try { url = out.toDataURL("image/png"); } catch (e2) { toast("裁图失败：" + e2.message, true); return; }
      const nm = "素材_" + String(rel || "图").split("/").pop().replace(/\.[^.]+$/, "");
      btnCropMat.disabled = true;
      const r = await apiPost("/material", { png: url, name: nm });
      btnCropMat.disabled = false;
      if (!r || r.success === false) { toast("裁进素材失败：" + ((r && r.error) || "未知原因"), true); return; }
      toast("已裁进素材栏：" + (r.name || ""));
      setState("这块已经裁进「素材」栏了 —— 去画廊的「素材」那栏能看到");
    } catch (e) {
      btnCropMat.disabled = false;
      toast("裁进素材失败：" + (e && e.message ? e.message : e), true);
    }
  });
  railR.appendChild(btnCropMat);

  // ---- 底栏 ----
  const foot = el("div", "display:flex;align-items:center;gap:10px;font:12px/1.4 system-ui");
  const state = el("span", "flex:1 1 auto;opacity:.75", "还没画");
  const save = el("button", "font:12.5px system-ui;padding:6px 14px;border-radius:8px;cursor:pointer;"
    + "border:1px solid rgba(120,180,255,.65);background:rgba(96,166,255,.2);color:#dcebff", "💾 保存蒙版");
  foot.appendChild(state); foot.appendChild(save);
  // ================= ★ 376 批：素材模式的「视野」部分（放大微调 + 平移）=================
  //   他的口径：「底图要允许放大进行微调」「底图和素材图不处于同一图层」「允许新建图层或
  //   在原有图层上绘画修改（比如擦除素材的一部分）」。
  //   这一轮先落地：左下角开关 + 左栏工具收起 + 滚轮以光标为中心缩放 + 按住画布拖 = 平移。
  //   图层 / 素材拖入 / 图层上擦除 下一轮接（要独立的图层渲染器，改动大）。
  // ★ 377b（他："左下角的也不应该是按钮而是滑钮开关"）→ toggle switch（轨道 + 圆滑块），跟别处的小圆钮开关一个样
  const mBtn = el("span", "display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;flex:0 0 auto");
  const mSwLab = el("span", "font:12px system-ui;opacity:.8", "素材模式");
  const mSwTrack = el("i", "position:relative;display:inline-block;width:30px;height:16px;border-radius:999px;"
    + "background:rgba(150,162,180,.45);transition:background .15s;flex:0 0 auto");
  const mSwKnob = el("i", "position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;"
    + "background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.35)");
  mSwTrack.appendChild(mSwKnob);
  mBtn.appendChild(mSwLab); mBtn.appendChild(mSwTrack);
  mBtn.title = "打开：左栏工具收起、滚轮整体缩放（底图与素材同步）、中键拖 = 平移视角；右栏出现素材条与图层";
  foot.insertBefore(mBtn, foot.firstChild);
  const mZoom = el("span", "opacity:.6;font:11.5px system-ui", "");
  foot.insertBefore(mZoom, save);
  let mOn = false, mK = 1, mDx = 0, mDy = 0, mHudReady = false, mMeshReady = false;
  // ★ 386：视口只作用在 viewW 这一个容器上（底图 / 蒙版 / 素材都在里面），同步是结构性保证的
  function mPaintView() {
    viewW.style.transform = "translate(" + mDx + "px," + mDy + "px) scale(" + mK + ")";
    mZoom.textContent = Math.round(mK * 100) + "%";
    if (mHudReady) mHudPaint();            // 手柄挂在 stage 上、不跟容器缩放，得自己按视口换算
  }
  function mResetView() { mK = 1; mDx = 0; mDy = 0; mPaintView(); }
  function mSetOn(on) {
    mOn = !!on;
    mSwTrack.style.background = mOn ? "rgba(96,166,255,.85)" : "rgba(150,162,180,.45)";
    mSwKnob.style.transform = mOn ? "translateX(14px)" : "translateX(0)";
    railL.style.display = mOn ? "none" : "";
    // ★ 383 批（他："选中素材拿橡皮擦不掉 / 小按键点不到"）：蒙版那两层画布在图层上面、把点击全吃了
    //   → 素材模式下让它们不吃鼠标事件（视觉照旧），退出再还原。
    try { cv.style.pointerEvents = mOn ? "none" : ""; ov.style.pointerEvents = mOn ? "none" : ""; } catch (e) {}
    // ★ 385 批（他："底图的亮度被莫名调亮了"）真因：素材模式里蒙版那层（半透明白）还亮着，
    //   只要这张图以前存过蒙版 / 存过整张合成图，整张底图就会被"漂白"，看着就是变亮了。
    //   素材模式里不画蒙版 → 干脆把它藏掉，退出时还原。
    try { cv.style.visibility = mOn ? "hidden" : ""; } catch (e) { /* 忽略 */ }
    // ★ 377b：左栏藏掉之后必须把 grid 从「三列」改成「两列」，否则画布会被挤进 96px 那一列。
    body.style.gridTemplateColumns = mOn ? "minmax(0,1fr) 236px" : "96px 1fr 128px";
    if (!mOn) mResetView(); else mPaintView();
    setState(mOn ? "素材模式：滚轮 = 整体缩放（底图+素材同步）· 中键拖 = 移动视角 · Alt+滚轮 = 只缩选中的层 · 右键已关" : "已回到画蒙版");
  }
  mBtn.addEventListener("click", (ev) => { ev.stopPropagation(); mSetOn(!mOn); });
  // ★ 384 批（他："长按滚轮键会使底图和素材图同步视角移动，但是旋转滚轮放大缩小就会导致底图和素材错位，
  //   应该也改成同步才对"）→ 滚轮 = **整个视角一起缩放**（底图 / 蒙版画布 / 所有图层用同一个 transform，
  //   所以永远同步），并且以**光标所在点**为锚点缩放，放大时那一块不会跑。
  //   单层的缩放交给就地手柄（四角等比 / 右边改宽 / 下边改高）；Alt+滚轮 仍然可以只缩放选中的那一层。
  stage.addEventListener("wheel", (ev) => {
    if (!mOn) return;
    ev.preventDefault();
    const f = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (ev.altKey && mSelL) {                    // 备用：Alt+滚轮 = 只缩放选中的层
      const L = mSelL;
      const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
      L.w = Math.max(8, L.w * f); L.h = Math.max(8, L.h * f);
      L.x = cx - L.w / 2; L.y = cy - L.h / 2;
      mPlace(L);
      return;
    }
    const r = stage.getBoundingClientRect();
    const k2 = Math.min(8, Math.max(0.12, mK * f));
    if (Math.abs(k2 - mK) < 1e-4) return;
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const lx = (px - mDx) / mK, ly = (py - mDy) / mK;   // 光标下面的那一点（视角内坐标）
    mK = k2;
    mDx = px - lx * mK; mDy = py - ly * mK;             // 让它缩放前后停在原地
    mPaintView();
  }, { passive: false });
  let mPan = null;
  // 捕获阶段先拦：素材模式里**不画画**（点在图层上时让图层自己接管）
  stage.addEventListener("pointerdown", (ev) => {
    if (!mOn) return;
    // ★ 383 批：**中键拖动 = 移动视角**（他让我定键：左键留给"选中/拖素材"，右键留给菜单，
    //   所以用中键；触控板没有中键时也可以用 空格+左键 —— 这里只做中键，简单不打架）
    if (ev.button === 1) {
      ev.preventDefault(); ev.stopPropagation();
      const p0 = { x: ev.clientX, y: ev.clientY, dx: mDx, dy: mDy };
      const mv = (e2) => { mDx = p0.dx + (e2.clientX - p0.x); mDy = p0.dy + (e2.clientY - p0.y); mPaintView(); };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      return;
    }
    if (ev.button !== 0) return;
    const t = ev.target;
    if (t && t.closest && (t.closest(".gal-ml") || t.closest(".gal-hud"))) return;   // 图层 / 手柄自己接管
    ev.stopPropagation(); ev.preventDefault();
    // ★ 384 批（他："拿起橡皮擦把素材的一部分擦掉，还是做不到"）：笔 / 橡皮已经拿在手上时，
    //   从素材外面一点的地方起笔也要能擦到（以前必须正好按在素材上，稍微偏一点就变成了"点空白=取消选中"）
    if (mDropOn && mSelL) {                           // ★ 387：吸管橡皮（点在素材外面一点也照样生效）
      mStrokeUndo(mSelL);
      const n = mDropErase(ev, mSelL);
      setState(n ? "吸管橡皮：擦掉了这一块（" + n + " 像素），↩ 可撤回" : "这一块擦不动（可能已经是透明的）");
      return;
    }
    if ((mBrushOn || mEraseOn) && mSelL) {
      mStrokeUndo(mSelL);                             // ★ 386：一笔一撤回
      let last = mStrokeAt(ev);
      setState(mEraseOn ? "橡皮：正在擦这一层（底图不动）" : "画笔：正在这一层上画");
      const mv = (e2) => { last = mStrokeAt(e2, last); };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      return;
    }
    mSelectBase();                    // 点画布空白 / 底图 = 选中底图（同时挡掉底下的蒙版画笔）
  }, true);
  // ★ 383 批（他："右键拖拽竟然可以叫出来另外一个模式的方框，这明显是 bug"）→ 素材模式里彻底关掉右键菜单/右键手势
  stage.addEventListener("contextmenu", (ev) => { if (mOn) { ev.preventDefault(); ev.stopPropagation(); } }, true);
  // ★ 391 批（他："鼠标对着一个地方长按就可以吸色…到底长按的是哪个键呢？你自己想吧"）
  //   我定：**右键按住 0.4 秒**吸色（左键要留给拖素材、中键要留给平移；右键本来在素材模式里就是死的，
  //   正好给它一个用处）。按住期间一动超过 6px 就取消，免得拖拽误触。
  let mPickT = null, mPick0 = null;
  function mCancelPick() { if (mPickT) { clearTimeout(mPickT); mPickT = null; } }
  function mPickColorAt(cx, cy) {
    try {
      const g = mGeo();
      const p = mToLocal({ clientX: cx, clientY: cy });
      const ix = Math.round((p.x - g.bx) * g.sc), iy = Math.round((p.y - g.by) * g.sc);
      if (ix < 0 || iy < 0 || ix >= g.w || iy >= g.h) { toast("点在画面外面了，没吸到"); return; }
      const comp = mCompositeCanvas();          // 吸的是"眼前看到的那一点"（底图 + 所有图层，含亮度）
      const d = comp.getContext("2d").getImageData(ix, iy, 1, 1).data;
      const hex = "#" + [d[0], d[1], d[2]].map((v) => ("0" + v.toString(16)).slice(-2)).join("");
      mColor = hex;
      mBrushOn = true; mEraseOn = false; mDropOn = false;
      mRenderPanel();
      setState("吸到颜色 " + hex + " —— 画笔已经切过去，直接画就行");
      toast("吸到颜色 " + hex + "，已经给画笔了");
    } catch (e) { toast("吸色失败：" + (e && e.message ? e.message : e), true); }
  }
  stage.addEventListener("pointerdown", (ev) => {
    if (!mOn || ev.button !== 2) return;
    ev.preventDefault(); ev.stopPropagation();
    mPick0 = { x: ev.clientX, y: ev.clientY };
    mCancelPick();
    mPickT = setTimeout(() => {
      mPickT = null;
      if (!mPick0) return;
      const q = mPick0; mPick0 = null;
      mPickColorAt(q.x, q.y);
    }, 400);
    setState("按住右键不放 = 吸色（0.4 秒，别拖）");
  }, true);
  stage.addEventListener("pointerup", () => { mCancelPick(); mPick0 = null; }, true);
  stage.addEventListener("pointercancel", () => { mCancelPick(); mPick0 = null; }, true);
  stage.addEventListener("pointermove", (ev) => {
    if (!mPick0) return;
    if (Math.abs(ev.clientX - mPick0.x) + Math.abs(ev.clientY - mPick0.y) > 6) { mCancelPick(); mPick0 = null; }
  }, true);
  stage.addEventListener("pointermove", (ev) => {
    if (!mPan) return;
    ev.stopPropagation();
    mDx = mPan.dx + (ev.clientX - mPan.x);
    mDy = mPan.dy + (ev.clientY - mPan.y);
    mPaintView();
  }, true);
  const mPanEnd = () => { mPan = null; };
  stage.addEventListener("pointerup", mPanEnd, true);
  stage.addEventListener("pointercancel", mPanEnd, true);
  mResetView();
  try { node.__galMatMode = mSetOn; } catch (e) { /* 忽略 */ }   // 测试口

  // ================= ★ 377 批：素材模式的「图层」=================
  //   他的口径："图层之间可以调整顺序，但是底图一定是要最底部图层"；
  //   另：可新建图层、在原有图层上绘画修改（擦素材边缘让它融进背景）。
  const matWrap = el("div", "");
  matWrap.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2;"
    + "transform-origin:0 0";
  try { viewW.insertBefore(matWrap, cv); } catch (e) { viewW.appendChild(matWrap); }
  const mLayers = [];
  let mSelL = null, mBrushOn = false, mEraseOn = false, mDropOn = false, mBrush = 6, mSoft = 0.35, mColor = "#ffffff", mMaskMode = "grad", mMatItems = null, mSelBase = false;
  // ★ 411：渐强蒙版的参数。
  // ★ 413（他："去掉眼镜还是会有半透明"）：内部只要 0.1 —— 0.31 的轻改也会把细窄的深色素材洗成"半透明"；
  //   而素材本来就是从同一张图裁的，光照天然一致，真正需要的只是**边**。所以：内部 10%、过渡带拉到 24px。
  const MM_IN = 26, MM_BLUR = 10, MM_RING = 24;
  function mToLocal(ev) {
    const r = stage.getBoundingClientRect();
    // ★ 386：减掉边框（viewW 的原点是 stage 的 padding box 左上角，不是 border box）
    const cl = stage.clientLeft || 0, ct = stage.clientTop || 0;
    return { x: (ev.clientX - r.left - cl - mDx) / mK, y: (ev.clientY - r.top - ct - mDy) / mK };
  }
  function mPlace(L) {
    if (!L || !L.box) return;
    L.box.style.left = L.x + "px"; L.box.style.top = L.y + "px";
    L.box.style.width = L.w + "px"; L.box.style.height = L.h + "px";
    L.node.style.transform = "rotate(" + (L.rot || 0) + "deg) scale("
      + (L.flipX ? -1 : 1) + "," + (L.flipY ? -1 : 1) + ")";
    // ★ 384 批（他："新增给素材调高或者调低亮度的功能"）→ 亮度是这一层的属性，
    //   显示用 CSS filter，保存合成时用同一条 canvas filter（两边必须同值，否则存下来和看到的不一样）
    // ★ 417 批（他选方案 1：给素材加投影/接触阴影，让贴上去的东西"压"在头发上，不像贴纸）
    //   drop-shadow 按这一层的 **alpha 轮廓**投影，形状自动跟着走，不用另做蒙版；
    //   合成时用 canvas 的 shadowColor/shadowBlur/shadowOffset（参数必须和这里一致）。
    L.node.style.filter = "brightness(" + (L.bright || 1) + ")" + mShadowCss(L);
    // ★ 382 批（他："素材旁边的小按键完全不跟素材同步，需要点一下才能同步"）→ 每次动完就把手柄跟过去
    try { mHudPaint(); } catch (e) { /* 建好之前忽略 */ }
  }
  function mMakeLayer(kind, wNat, hNat) {
    const box = el("div", "");
    box.className = "gal-ml";
    box.style.cssText = "position:absolute;pointer-events:auto;cursor:move;outline:1px dashed rgba(120,180,255,0);"
      + "outline-offset:2px";
    const node = document.createElement("canvas");
    node.width = Math.max(1, Math.round(wNat)); node.height = Math.max(1, Math.round(hNat));
    node.style.cssText = "width:100%;height:100%;display:block;pointer-events:none;transform-origin:50% 50%";
    box.appendChild(node);
    matWrap.appendChild(box);
    return { kind: kind, box: box, node: node, ctx: node.getContext("2d"), natW: node.width, natH: node.height,
             x: 0, y: 0, w: 100, h: 100, rot: 0, flipX: false, flipY: false, bright: 1, shadow: 0,
             name: (kind === "paint" ? "绘画层" : "素材") };
  }
  function mBaseScale() {      // 底图在 k=1 时的显示比例（stage 像素 / 原图像素）
    const w0 = parseFloat(base.style.width) || base.clientWidth || base.naturalWidth;
    return w0 / Math.max(1, base.naturalWidth);
  }
  // ★ 385 批（他："底图如果放大，叫出素材肯定会在视角的中间，而且也有适中的大小，而不是固定大小、固定位置"）
  //   → 落点 = **当前视野**的中心（换算成视角内坐标），大小 = **当前可见范围**的 40%（跟着缩放走），
  //   这样放大到 300% 叫素材，也是"眼前这一块的中间、看得见的那么大"，不会跑到屏幕外面去。
  function mViewport() {
    const w = stage.clientWidth || 800, h = stage.clientHeight || 600;
    return { w: w / mK, h: h / mK, cx: (w / 2 - mDx) / mK, cy: (h / 2 - mDy) / mK };
  }
  async function mAddMat(relM, at) {
    try {
      const im = await new Promise((res, rej) => {
        const i2 = new Image(); i2.onload = () => res(i2); i2.onerror = rej;
        i2.src = API + "/img?rel=" + encodeURIComponent(relM);
      });
      const L = mMakeLayer("mat", im.naturalWidth, im.naturalHeight);
      L.ctx.drawImage(im, 0, 0);
      const vp = mViewport();
      // 大小：长边约占可见范围的 40%，但不超过原图在 100% 视角下的尺寸
      const baseSc = mBaseScale() / mK;                 // 原图 1px → 视角内 px（换算掉当前缩放）
      const want = Math.min(vp.w, vp.h) * 0.4;
      let sc2 = baseSc;
      const big = Math.max(L.natW || im.naturalWidth, L.natH || im.naturalHeight) * sc2;
      if (big > want) sc2 = sc2 * (want / big);
      L.w = Math.max(8, im.naturalWidth * sc2); L.h = Math.max(8, im.naturalHeight * sc2);
      const c = at ? { x: at.x, y: at.y } : { x: vp.cx, y: vp.cy };
      L.x = c.x - L.w / 2; L.y = c.y - L.h / 2;
      L.rel = relM;
      mPlace(L); mLayers.push(L); mSelectL(L);
      mAddUndo(L);
      setState("素材放上来了：拖 = 移动 · 四角手柄 = 缩放 · 右栏可调亮度 / 翻转 / 删除");
    } catch (e) { toast("把素材放到画布上失败：" + (e && e.message ? e.message : e), true); }
  }
  function mAddPaint() {
    const L = mMakeLayer("paint", base.naturalWidth, base.naturalHeight);
    const sc = mBaseScale();
    L.w = base.naturalWidth * sc; L.h = base.naturalHeight * sc;
    // ★ 393：绘画层要和底图严丝合缝 → 位置直接取「底图实际渲染在容器里的左上角」
    const g0 = mGeo();
    L.x = g0.bx; L.y = g0.by;
    mPlace(L); mLayers.push(L); mSelectL(L);
    mAddUndo(L);
    setState("新建了一个空白绘画层（在右栏选中它，然后用 🖌 / 🧽 在上面画）");
  }
  function mSelectL(L) {
    mSelL = L; mSelBase = false;
    base.style.outline = "";
    mLayers.forEach((x) => {
      // ★ 385：框线交给 mHud（它在屏幕尺度上，放大也不变粗）；素材盒子自己不再画虚线框
      x.box.style.outline = "none";
      x.box.style.zIndex = String(10 + mLayers.indexOf(x));       // 数组顺序 = 叠放顺序（底图永远在最底）
    });
    mHudPaint();
    mRenderPanel();
  }
  // ★ 379 批：底图也能被选中（不能调顺序，但选中后才知道"当前在改谁"）
  function mSelectBase() {
    mSelL = null; mSelBase = true;
    mLayers.forEach((x) => { x.box.style.outline = "none"; });
    base.style.outline = "1px dashed rgba(120,180,255,.95)";
    mHudPaint();
    mRenderPanel();
  }
  // ---- ★ 379 批：选中素材四周的就地手柄 + 右上角小按键（他："素材本身旁边来几个小按键，就像局部重绘的小方形一样"）----
  // ★ 385 批（他："素材所携带的框框，在放大的情况下会很占视野"）→ 手柄改成挂在 **stage 上、不在被缩放的容器里**，
  //   位置自己按 mK/mDx/mDy 换算（见 mHudPaint）。这样不管放大到多少，框线和手柄永远是屏幕上那么细那么小。
  const mHud = el("div", "");
  mHud.className = "gal-hud";
  mHud.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:9000;transform-origin:50% 50%;"
    + "outline:1px dashed rgba(120,180,255,.9);outline-offset:0";
  stage.appendChild(mHud);
  // ★ 386 批（他："用笔来画和用橡皮来画的时候，会找不到鼠标的位置，需要一个笔或者橡皮的图标来说明"）
  //   → 拿笔/橡皮时把系统指针藏起来，画一个**跟着鼠标的笔刷圈**（圈的大小 = 当前粗细），中心一个白点当准星。
  const mCursor = el("div", "");
  mCursor.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:9001;border-radius:50%;"
    + "border:1px solid rgba(255,255,255,.95);"
    + "box-shadow:0 0 0 1px rgba(0,0,0,.6),inset 0 0 0 1px rgba(0,0,0,.35);"
    + "transform:translate(-50%,-50%)";
  mCursor.appendChild(el("i", "position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;"
    + "border-radius:50%;background:rgba(255,255,255,.95);box-shadow:0 0 0 1px rgba(0,0,0,.55)"));
  stage.appendChild(mCursor);
  function mCursorSync(ev) {
    const armed = mOn && (mBrushOn || mEraseOn || mDropOn) && !!mSelL;
    if (!armed) { mCursor.style.display = "none"; try { stage.style.cursor = ""; } catch (e) { /* 忽略 */ } return; }
    try { stage.style.cursor = "none"; } catch (e) { /* 忽略 */ }
    if (!ev) return;
    const r = stage.getBoundingClientRect();
    const d = Math.max(3, mBrush * mK);
    mCursor.style.display = "block";
    mCursor.style.width = d + "px"; mCursor.style.height = d + "px";
    mCursor.style.left = (ev.clientX - r.left) + "px";
    mCursor.style.top = (ev.clientY - r.top) + "px";
  }
  stage.addEventListener("pointermove", (ev) => mCursorSync(ev), true);
  stage.addEventListener("pointerleave", () => { mCursor.style.display = "none"; }, true);
  try { node.__galMatCursor = () => ({ on: mCursor.style.display === "block", d: mCursor.style.width }); } catch (e) { /* 忽略 */ }
  function mHudBtn(txt, title, fn, css) {
    const b = el("button", "position:absolute;pointer-events:auto;width:20px;height:20px;border-radius:50%;"
      + "border:1px solid rgba(150,200,255,.9);background:rgba(24,34,54,.95);color:#dbe7ff;"
      + "font:11px/1 system-ui;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;" + (css || ""), txt);
    b.title = title || txt;
    b.addEventListener("pointerdown", (e2) => { e2.stopPropagation(); });
    b.addEventListener("click", (e2) => { e2.stopPropagation(); e2.preventDefault(); fn(); });
    mHud.appendChild(b);
    return b;
  }
  function mHudHandle(css, mode, cursor) {
    const h = el("i", "");
    h.style.cssText = "position:absolute;width:14px;height:14px;border-radius:3px;background:#5c8dff;"
      + "border:1px solid #cfe0ff;pointer-events:auto;cursor:" + cursor + ";" + css;
    h.dataset.mode = mode;
    mHud.appendChild(h);
    return h;
  }
  // 四角 = 等比例缩放；右边中点 = 只改宽（挤宽）；下边中点 = 只改高（拉高）
  mHudHandle("left:-6px;top:-6px;", "nw", "nwse-resize");
  mHudHandle("right:-6px;top:-6px;", "ne", "nesw-resize");
  mHudHandle("left:-6px;bottom:-6px;", "sw", "nesw-resize");
  mHudHandle("right:-6px;bottom:-6px;", "se", "nwse-resize");
  mHudHandle("right:-6px;top:50%;margin-top:-6px;border-radius:50%;", "e", "ew-resize");
  mHudHandle("left:50%;bottom:-6px;margin-left:-6px;border-radius:50%;", "s", "ns-resize");
  // ★ 382 批（他："旋转小按键没必要这么僵硬，可以设一个键，点击后长按拖动就能任意旋转"）→ 一颗可拖的旋转键，
  //   按住它拖 = 按鼠标相对中心的角度自由旋转（不再 15° 一格）。
  const mRotBtn = mHudBtn("↻", "按住拖动 = 任意旋转（相对中心的角度）", () => {}, "left:50%;top:-30px;margin-left:-10px;cursor:grab;");
  mRotBtn.addEventListener("pointerdown", (ev) => {
    if (!mSelL) return;
    ev.stopPropagation(); ev.preventDefault();
    const L = mSelL;
    mGeoUndo(L);                                      // ★ 386：旋转也能撤回
    const r = stage.getBoundingClientRect();
    // ★ 384 批（他："有时候点击旋转拖拽，结果拖拽方向完全相反"）两个真因：
    //   ① 参考中心算错：原来直接用 L.x/L.y（视角内坐标），一旦放大 / 平移过，屏幕上的真实中心
    //      就不在那儿了 → 起始角完全错，拖起来像反着转。要换算成**屏幕坐标**。
    //   ② atan2 在 ±180° 处会跳一整圈（+180 → -180）→ 差值一次 -360°，于是"方向反过来"。
    //      改成逐帧归一化累加，跨过 ±180° 也不会跳。
    const cx = r.left + mDx + (L.x + L.w / 2) * mK;
    const cy = r.top + mDy + (L.y + L.h / 2) * mK;
    const ang = (e2) => Math.atan2(e2.clientY - cy, e2.clientX - cx) * 180 / Math.PI;
    let prev = ang(ev), acc = 0;
    const rot0 = L.rot || 0;
    const mv = (e2) => {
      const a = ang(e2);
      let d = a - prev;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      acc += d; prev = a;
      L.rot = rot0 + acc;
      mPlace(L);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      setState("旋转到 " + Math.round(((L.rot % 360) + 360) % 360) + "°");
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  });
  mHudBtn("⇋", "左右翻转", () => { if (mSelL) { mGeoUndo(mSelL); mSelL.flipX = !mSelL.flipX; mPlace(mSelL); } }, "right:-30px;top:-26px;");
  mHudBtn("⇅", "上下翻转", () => { if (mSelL) { mGeoUndo(mSelL); mSelL.flipY = !mSelL.flipY; mPlace(mSelL); } }, "right:-54px;top:-26px;");
  // ★ 386 批（他："素材处理到一半觉得这个素材很好用…在翻转、删除键旁边再加一个按键，把这个半成品也称为素材"）
  // ★ 387 批（他："为什么我点把这个素材记录下来，你把整张图给我记录下来了呢"）
  //   → 之前存的是「底图 + 素材」的整张合成图 = 把底图也一起存了，那不是素材。
  //     现在只存**图层自己**：不含底图、保留透明、并按内容自动裁到边（省得素材里一大圈空的）。
  mHudBtn("📌", "把这一堆素材单独存成一张透明素材（不含底图，自动裁到内容边）", () => mSaveStackAsMat(), "right:-78px;top:-26px;");
  mHudBtn("🗑", "删掉这一层", () => mDelL(), "right:-6px;top:-30px;");
  function mLayersOnlyCanvas() {
    const g = mGeo();
    const full = document.createElement("canvas"); full.width = g.w; full.height = g.h;
    const c2 = full.getContext("2d");
    mLayers.forEach(function (L) { mDrawLayerOn(c2, L, g); });     // 只画图层，底图不画
    // 裁到有内容的范围（透明的地方不要，免得素材拖出来一大圈空边）
    let x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
    try {
      const d = c2.getImageData(0, 0, g.w, g.h).data;
      for (let y = 0; y < g.h; y++) {
        const row = y * g.w;
        for (let x = 0; x < g.w; x++) {
          if (d[(row + x) * 4 + 3] > 4) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
    } catch (e) { x1 = -1; }
    if (x1 < 0) return null;                                       // 全透明 = 没什么可存
    const cut = document.createElement("canvas");
    cut.width = x1 - x0 + 1; cut.height = y1 - y0 + 1;
    cut.getContext("2d").drawImage(full, -x0, -y0);
    return cut;
  }
  async function mSaveStackAsMat() {
    if (!mLayers.length) { toast("还没放素材，没什么可存的"); return; }
    try {
      const mat = mLayersOnlyCanvas();
      if (!mat) { toast("这几层现在是全透明的，没有东西可存"); return; }
      const nm = "半成品_" + String(rel || "图").split("/").pop().replace(/\.[^.]+$/, "")
        + "_" + String(Date.now()).slice(-5);
      const r = await apiPost("/material", { png: mat.toDataURL("image/png"), name: nm });
      if (!r || !r.rel) { toast("存失败：" + ((r && r.error) || ""), true); return; }
      mMatItems = null; mRenderPanel();          // 刷新素材条，马上能在上面看到
      toast("已存成素材：" + (r.name || "") + "（" + mat.width + "×" + mat.height + "，透明底、不含原图）");
    } catch (e) { toast("存失败：" + (e && e.message ? e.message : e), true); }
  }
  function mHudPaint() {
    if (!mSelL || !mOn) { mHud.style.display = "none"; if (mMeshReady) mMeshPaint(); return; }
    const L = mSelL;
    mHud.style.display = "block";
    // 屏幕坐标（不是视角内坐标）：手柄在 stage 上、不跟容器一起缩放
    mHud.style.left = (mDx + L.x * mK) + "px";
    mHud.style.top = (mDy + L.y * mK) + "px";
    mHud.style.width = Math.max(2, L.w * mK) + "px";
    mHud.style.height = Math.max(2, L.h * mK) + "px";
    mHud.style.transform = "rotate(" + (L.rot || 0) + "deg)";
    if (mMeshReady) mMeshPaint();           // ★ 392：开了网格的那一层，网格线跟着一起走
  }
  mHudReady = true;
  // 手柄拖动：角 = 等比、右边 = 只改宽、下边 = 只改高
  mHud.addEventListener("pointerdown", (ev) => {
    const mode = ev.target && ev.target.dataset ? ev.target.dataset.mode : "";
    if (!mode || !mSelL) return;
    ev.stopPropagation(); ev.preventDefault();
    const L = mSelL;
    mGeoUndo(L);                                      // ★ 386：拉手柄也能撤回
    const st0 = { x: ev.clientX, y: ev.clientY, w: L.w, h: L.h, cx: L.x + L.w / 2, cy: L.y + L.h / 2 };
    const ratio = L.w / Math.max(1, L.h);
    const mv = (e2) => {
      // ★ 385：手柄现在画在屏幕尺度上，位移要换算回视角内（否则放大 2 倍时拖 1px 会变成 2px）
      const dx = (e2.clientX - st0.x) / mK, dy = (e2.clientY - st0.y) / mK;
      const d = (mode === "se" || mode === "ne") ? dx : -dx;
      if (mode === "e") { L.w = Math.max(10, st0.w + dx); L.x = st0.cx - L.w / 2; }
      else if (mode === "s") { L.h = Math.max(10, st0.h + dy); L.y = st0.cy - L.h / 2; }
      else {                                   // 四角 = 等比缩放（从中心扩）
        L.w = Math.max(10, st0.w + d);
        L.h = Math.max(10, L.w / ratio);
        L.x = st0.cx - L.w / 2; L.y = st0.cy - L.h / 2;
      }
      mPlace(L); mHudPaint();
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); mRenderPanel(); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  });
  // ================= ★ 392 批：素材的「网格局部扭曲」=================
  //   他的口径：「素材允许切网格模式，然后进行局部扭曲」。
  //   做法：给这一层铺一张 n×n 网格，拖任意一个格点，格子按**三角形仿射**重画（源图存一份 L.src），
  //   是真正把那一块像素扭过去，不是盖一层遮罩。改的是这一层自己的画布 → 保存 / 合成自动带着它走。
  //   网格线画在独立的屏幕层上（和手柄同一思路），放大后线还是细的。
  const mMeshCv = document.createElement("canvas");
  mMeshCv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:9002;display:none";
  stage.appendChild(mMeshCv);
  function mMeshOn(L) { return !!(L && L.mesh); }
  function mMeshInit(L, n) {
    const w = L.node.width, h = L.node.height, nn = n || 4;
    const pts = [];
    for (let j = 0; j <= nn; j++) for (let i = 0; i <= nn; i++) pts.push({ x: i * w / nn, y: j * h / nn });
    L.mesh = { n: nn, pts: pts };
    if (!L.src) {                                   // 源图：扭曲永远基于它，反复拖不会越拖越糊
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(L.node, 0, 0);
      L.src = c;
    }
  }
  function mMeshReset(L) {
    if (!L || !L.mesh) return;
    const n = L.mesh.n;
    L.mesh = null; mMeshInit(L, n);
    const g = L.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, L.node.width, L.node.height);
    g.drawImage(L.src, 0, 0);
    mMeshPaint();
  }
  function mTri(g, src, a, b, c, A, B, C) {
    const e1x = b.x - a.x, e1y = b.y - a.y, e2x = c.x - a.x, e2y = c.y - a.y;
    const det = e1x * e2y - e2x * e1y;
    if (Math.abs(det) < 1e-6) return;
    const E1x = B.x - A.x, E1y = B.y - A.y, E2x = C.x - A.x, E2y = C.y - A.y;
    const m00 = (E1x * e2y - E2x * e1y) / det;
    const m01 = (e1x * E2x - e2x * E1x) / det;
    const m10 = (E1y * e2y - E2y * e1y) / det;
    const m11 = (e1x * E2y - e2x * E1y) / det;
    const tx = A.x - (m00 * a.x + m01 * a.y);
    const ty = A.y - (m10 * a.x + m11 * a.y);
    g.save();
    g.beginPath();
    g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.lineTo(C.x, C.y); g.closePath();
    g.clip();
    g.setTransform(m00, m10, m01, m11, tx, ty);
    g.drawImage(src, 0, 0);
    g.restore();
  }
  function mMeshWarp(L) {
    if (!L || !L.mesh || !L.src) return;
    const w = L.node.width, h = L.node.height, n = L.mesh.n, pts = L.mesh.pts;
    const g = L.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const at = (i, j) => pts[j * (n + 1) + i];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const s00 = { x: i * w / n, y: j * h / n }, s10 = { x: (i + 1) * w / n, y: j * h / n };
        const s11 = { x: (i + 1) * w / n, y: (j + 1) * h / n }, s01 = { x: i * w / n, y: (j + 1) * h / n };
        const p00 = at(i, j), p10 = at(i + 1, j), p11 = at(i + 1, j + 1), p01 = at(i, j + 1);
        mTri(g, L.src, s00, s10, s11, p00, p10, p11);
        mTri(g, L.src, s00, s11, s01, p00, p11, p01);
      }
    }
  }
  // 画布像素 → stage 屏幕坐标（和手柄同一套换算）
  function mScreenOfCanvasPx(L, cx, cy) {
    const u = cx / Math.max(1, L.node.width) * L.w - L.w / 2;
    const v = cy / Math.max(1, L.node.height) * L.h - L.h / 2;
    const x = u * (L.flipX ? -1 : 1), y = v * (L.flipY ? -1 : 1);
    const a = (L.rot || 0) * Math.PI / 180;
    const rx = x * Math.cos(a) - y * Math.sin(a), ry = x * Math.sin(a) + y * Math.cos(a);
    return { x: mDx + (L.x + L.w / 2 + rx) * mK, y: mDy + (L.y + L.h / 2 + ry) * mK };
  }
  function mMeshPaint() {
    if (!mMeshReady) return;
    const L = mSelL;
    if (!mOn || !mMeshOn(L)) { mMeshCv.style.display = "none"; return; }
    const W = Math.max(1, stage.clientWidth), H = Math.max(1, stage.clientHeight);
    if (mMeshCv.width !== W || mMeshCv.height !== H) { mMeshCv.width = W; mMeshCv.height = H; }
    mMeshCv.style.display = "block";
    const g = mMeshCv.getContext("2d");
    g.clearRect(0, 0, W, H);
    const n = L.mesh.n, pts = L.mesh.pts;
    const S = pts.map((p) => mScreenOfCanvasPx(L, p.x, p.y));
    g.strokeStyle = "rgba(120,180,255,.85)";
    g.lineWidth = 1;
    for (let j = 0; j <= n; j++) {
      g.beginPath();
      for (let i = 0; i <= n; i++) { const p = S[j * (n + 1) + i]; if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }
      g.stroke();
    }
    for (let i = 0; i <= n; i++) {
      g.beginPath();
      for (let j = 0; j <= n; j++) { const p = S[j * (n + 1) + i]; if (j) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }
      g.stroke();
    }
    g.fillStyle = "rgba(255,255,255,.95)";
    g.strokeStyle = "rgba(20,30,50,.9)";
    S.forEach((p) => { g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill(); g.stroke(); });
  }
  function mMeshHit(ev) {
    const L = mSelL;
    if (!mOn || !mMeshOn(L)) return -1;
    const r = stage.getBoundingClientRect();
    const mx = ev.clientX - r.left - (stage.clientLeft || 0);
    const my = ev.clientY - r.top - (stage.clientTop || 0);
    const pts = L.mesh.pts;
    let best = -1, bd = 14 * 14;
    for (let k = 0; k < pts.length; k++) {
      const p = mScreenOfCanvasPx(L, pts[k].x, pts[k].y);
      const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  // 拖格点：挂 window 捕获阶段，比 stage 上那些"点空白 = 取消选中"更早，抢到就是扭
  window.addEventListener("pointerdown", (ev) => {
    if (!mOn || ev.button !== 0) return;
    const L = mSelL;
    if (!mMeshOn(L)) return;
    const r = stage.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    const k = mMeshHit(ev);
    if (k < 0) return;
    ev.preventDefault(); ev.stopPropagation();
    // 撤回：把格点位置放回去再重新扭一次（不存像素，省内存）
    const pts0 = L.mesh.pts.map((p) => ({ x: p.x, y: p.y }));
    mUndoPush("扭了一下网格", () => {
      if (!L.mesh) return;
      L.mesh.pts = pts0.map((p) => ({ x: p.x, y: p.y }));
      mMeshWarp(L); mMeshPaint();
    });
    const mv = (e2) => {
      const p = mLocalOf(L, e2);
      L.mesh.pts[k].x = p.x / Math.max(1, L.w) * L.node.width;
      L.mesh.pts[k].y = p.y / Math.max(1, L.h) * L.node.height;
      mMeshWarp(L); mMeshPaint();
    };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    setState("网格：拖着这个格点扭一下（↩ 可撤回，「重置网格」还原）");
  }, true);
  mMeshReady = true;
  function mMoveL(d) {
    if (!mSelL) { toast("先在右栏选一个图层"); return; }
    const i = mLayers.indexOf(mSelL), j = i + d;
    if (j < 0 || j >= mLayers.length) return;
    mLayers.splice(i, 1); mLayers.splice(j, 0, mSelL);
    mLayers.forEach((x, k) => { x.box.style.zIndex = String(10 + k); });
    mRenderPanel();
  }
  function mDelL() {
    if (!mSelL) { toast("先在右栏选一个图层"); return; }
    const L = mSelL, i = mLayers.indexOf(L);
    if (i >= 0) mLayers.splice(i, 1);
    try { L.box.remove(); } catch (e) { /* 忽略 */ }
    mUndoPush("删掉一层", () => {                      // ★ 386：撤回 = 把那个盒子放回去（内容还在）
      mLayers.splice(Math.min(Math.max(0, i), mLayers.length), 0, L);
      matWrap.appendChild(L.box);
      mLayers.forEach((x, k) => { x.box.style.zIndex = String(10 + k); });
      mSelectL(L);
    });
    mSelL = mLayers.length ? mLayers[mLayers.length - 1] : null;
    if (mSelL) mSelectL(mSelL); else mRenderPanel();
    mHudPaint();          // ★ 385（他："素材就算删掉框框仍然存在"）→ 删完必须立刻重画/收掉手柄
  }
  // ★ 386 批（他："非素材模式有撤回上一步，素材模式没有，应该也同步加上才对"）
  //   每一步都压一条"怎么退回去"的闭包：几何类（移动/缩放/旋转/翻转/亮度）存一份旧数值，
  //   擦画类只存**那一层的像素**（一次一张，不会把几十张全图塞进内存），增删只存引用（DOM 盒子还在）。
  const mUndo = [];
  // ★ 392：像素快照（一笔一擦一扭）很占内存 —— 单独限条数，最多留 6 份，其余只保留"数值类"步骤
  function mUndoPush(label, fn, pix) {
    mUndo.push({ label: label, fn: fn, pix: !!pix });
    if (mUndo.length > 40) mUndo.shift();
    if (pix) {
      let n = 0;
      for (let i = mUndo.length - 1; i >= 0; i--) if (mUndo[i].pix) n++;
      while (n > 6) {
        for (let i = 0; i < mUndo.length; i++) if (mUndo[i].pix) { mUndo.splice(i, 1); break; }
        n--;
      }
    }
  }
  function mUndoRun() {
    const e = mUndo.pop();
    if (!e) { toast("素材模式里没有可以撤回的步骤了"); return; }
    try { e.fn(); } catch (err) { toast("撤回失败：" + (err && err.message ? err.message : err), true); }
    mHudPaint(); mRenderPanel();
    setState("撤回了一步：" + e.label);
  }
  function mGeoSnap(L) {
    return { x: L.x, y: L.y, w: L.w, h: L.h, rot: L.rot || 0,
             flipX: !!L.flipX, flipY: !!L.flipY, bright: L.bright || 1 };
  }
  function mGeoUndo(L) {                       // 动之前先存旧值
    if (!L) return;
    const s = mGeoSnap(L);
    mUndoPush("调整", () => {
      L.x = s.x; L.y = s.y; L.w = s.w; L.h = s.h; L.rot = s.rot;
      L.flipX = s.flipX; L.flipY = s.flipY; L.bright = s.bright;
      mPlace(L);
    });
  }
  function mAddUndo(L) {
    mUndoPush("加了" + (L.kind === "paint" ? "绘画层" : "素材"), () => {
      try { L.box.remove(); } catch (e) { /* 忽略 */ }
      const i = mLayers.indexOf(L);
      if (i >= 0) mLayers.splice(i, 1);
      if (mSelL === L) mSelL = mLayers.length ? mLayers[mLayers.length - 1] : null;
      if (mSelL) mSelectL(mSelL);
    });
  }
  function mStrokeUndo(L) {                    // 一笔开始前存这一层的像素
    if (!L) return;
    let snap = null;
    try { snap = L.ctx.getImageData(0, 0, L.node.width, L.node.height); } catch (e) { snap = null; }
    if (!snap) return;
    mUndoPush(mEraseOn ? "擦了一笔" : "画了一笔", () => { try { L.ctx.putImageData(snap, 0, 0); } catch (e) { /* 忽略 */ } }, true);
  }
  let mClearAt = 0;
  function mClearAll() {
    if (!mLayers.length) { toast("现在是空的，没有素材可以清"); return; }
    const now = Date.now();
    if (now - mClearAt > 3000) {
      mClearAt = now;
      toast("再点一次「🧹 全清」就把这 " + mLayers.length + " 层全部删掉（3 秒内有效）");
      return;
    }
    mClearAt = 0;
    const n = mLayers.length;
    const all = mLayers.slice();
    mUndoPush("全清 " + n + " 层", () => {                    // ★ 386：全清也能撤回
      all.forEach((x) => { if (!mLayers.includes(x)) { mLayers.push(x); matWrap.appendChild(x.box); } });
      mLayers.forEach((x, k) => { x.box.style.zIndex = String(10 + k); });
      if (mLayers.length) mSelectL(mLayers[mLayers.length - 1]);
    });
    mLayers.forEach((x) => { try { x.box.remove(); } catch (e) { /* 忽略 */ } });
    mLayers.length = 0;
    mSelL = null;
    mHudPaint();
    mRenderPanel();
    toast("已清空 " + n + " 层（底图没动）");
  }
  // ---- 画 / 擦：只作用在选中的那一层 ----
  // ★ 384 批（他："想要拿起橡皮擦把素材的一部分擦掉，还是做不到"）
  //   真因：素材摆好后基本都会转一点角度 / 翻一下，而这里原来遇到 rot/flip 直接弹"先擦再转/翻"就返回了
  //   —— 等于擦不了。现在把屏幕点**反算**回这一层自己的坐标（先撤旋转、再撤翻转），转多少度都能擦。
  function mLocalOf(L, ev) {
    const p = mToLocal(ev);
    let dx = p.x - (L.x + L.w / 2), dy = p.y - (L.y + L.h / 2);
    const a = -(L.rot || 0) * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    let rx = dx * c - dy * s, ry = dx * s + dy * c;
    if (L.flipX) rx = -rx;
    if (L.flipY) ry = -ry;
    return { x: rx + L.w / 2, y: ry + L.h / 2 };     // 图层盒内坐标（0..w / 0..h）
  }
  // ★ 399 批（他："可以来一个一键去背景"）→ 从**四边**往里洪泛，把和边缘连成一片的背景抠成透明。
  //   判据用"相邻像素差"而不是"和目标色差"，所以渐变背景（头发、天空）也能一路吃进去，
  //   而颜色突变的地方（黑色发卡）会挡住 —— 正好是抠图要的效果。做完可以 ↩ 撤回。
  function mCutBg(L) {
    if (!L) return 0;
    const w = L.node.width, h = L.node.height;
    let img;
    try { img = L.ctx.getImageData(0, 0, w, h); } catch (e) { return 0; }
    const d = img.data;
    const seen = new Uint8Array(w * h);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const p = y * w + x;
      if (seen[p]) return;
      if (d[p * 4 + 3] === 0) return;
      seen[p] = 1; stack.push(p);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    let n = 0;
    const TOL = 60;                       // 相邻像素 RGB 差之和的上限（太小抠不干净，太大咬进主体）
    while (stack.length) {
      const p = stack.pop();
      const j = p * 4;
      d[j + 3] = 0; n++;
      const px = p % w, py = (p - px) / w;
      const nb = [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]];
      for (let k = 0; k < 4; k++) {
        const nx = nb[k][0], ny = nb[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (seen[q]) continue;
        const jq = q * 4;
        if (d[jq + 3] === 0) continue;
        const diff = Math.abs(d[jq] - d[j]) + Math.abs(d[jq + 1] - d[j + 1]) + Math.abs(d[jq + 2] - d[j + 2]);
        if (diff > TOL) continue;         // 颜色突变 = 主体边缘，停在这儿
        seen[q] = 1; stack.push(q);
      }
    }
    if (n) L.ctx.putImageData(img, 0, 0);
    return n;
  }
  // ★ 387 批（他："来个吸管橡皮"）→ 点一下，把这一层里**连在一起的同色块**整块擦掉（不用一点点涂）。
  //   容差 34（和蒙版那边的吸管同一档）；只动选中的那一层，底图不碰。
  function mDropErase(ev, L) {
    if (!L) return 0;
    const p = mLocalOf(L, ev);
    const kx = L.node.width / Math.max(1, L.w), ky = L.node.height / Math.max(1, L.h);
    const w = L.node.width, h = L.node.height;
    const x0 = Math.floor(p.x * kx), y0 = Math.floor(p.y * ky);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return 0;
    let img;
    try { img = L.ctx.getImageData(0, 0, w, h); } catch (e) { return 0; }
    const d = img.data;
    const i0 = (y0 * w + x0) * 4;
    if (d[i0 + 3] === 0) { toast("这里是透明的，没有东西可擦"); return 0; }
    const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2];
    const tol = 34, seen = new Uint8Array(w * h), stack = [y0 * w + x0];
    let n = 0;
    while (stack.length) {
      const pi = stack.pop();
      if (seen[pi]) continue;
      seen[pi] = 1;
      const j = pi * 4;
      if (d[j + 3] === 0) continue;
      if (Math.abs(d[j] - r0) + Math.abs(d[j + 1] - g0) + Math.abs(d[j + 2] - b0) > tol) continue;
      d[j + 3] = 0; n++;
      const xx = pi % w, yy = (pi - xx) / w;
      if (xx > 0) stack.push(pi - 1);
      if (xx < w - 1) stack.push(pi + 1);
      if (yy > 0) stack.push(pi - w);
      if (yy < h - 1) stack.push(pi + w);
    }
    if (n) L.ctx.putImageData(img, 0, 0);
    return n;
  }
  // ★ 385 批（他："橡皮的粗细大小和柔和程度都没办法调，包括笔也是这样子"）
  //   粗细 = mBrush（滑条 4~200）；柔和 = mSoft（0 = 硬边，1 = 从中心一路渐隐出去）。
  //   柔和的实现是**径向渐变**：destination-out 时渐变里的低 alpha 就是"擦一半"，边缘自然过渡。
  function mRgba(hex, a) {
    let h = String(hex || "#ffffff").replace("#", "").trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    const v = isNaN(n) ? 0xffffff : n;
    return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
  }
  function mDab(g, x, y, r) {
    const col = mEraseOn ? "#ffffff" : mColor;
    // ★ 391 批（他："画笔和橡皮在同一个 px 下竟然是不同的粗细程度"）
    //   柔和改成往**外**扩（实心直径永远 = 粗细，外面那圈才是渐隐），
    //   画笔和橡皮走同一个圆、同一条 alpha 曲线 → 同一个 px 就是同一个粗细。
    const outer = r * (1 + mSoft);
    if (mSoft <= 0.02) {
      g.fillStyle = col;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      return;
    }
    const gr = g.createRadialGradient(x, y, r * 0.8, x, y, outer);
    gr.addColorStop(0, mRgba(col, 1));
    gr.addColorStop(1, mRgba(col, 0));
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, outer, 0, Math.PI * 2); g.fill();
    g.fillStyle = col;
  }
  function mStrokeAt(ev, prevPt) {
    const L = mSelL; if (!L) return null;
    const p = mLocalOf(L, ev);
    const kx = L.node.width / Math.max(1, L.w), ky = L.node.height / Math.max(1, L.h);
    const x = p.x * kx, y = p.y * ky;
    // 笔刷粗细按当前缩放折算（屏幕上看着一样粗，画在图上才准）
    const r = Math.max(1, (mBrush / 2) * kx);
    const g = L.ctx;
    g.save();
    g.globalCompositeOperation = mEraseOn ? "destination-out" : "source-over";
    // ★ 391：画笔用他挑的颜色（橡皮不吃颜色）
    g.fillStyle = mEraseOn ? "#ffffff" : mColor;
    g.strokeStyle = g.fillStyle;
    g.lineWidth = r * 2; g.lineCap = "round"; g.lineJoin = "round";
    if (mSoft <= 0.02) {
      // 硬笔：连线 + 圆头，快速拖也不断开
      if (prevPt) { g.beginPath(); g.moveTo(prevPt.x, prevPt.y); g.lineTo(x, y); g.stroke(); }
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    } else {
      // 软笔：沿路径补点，点与点之间不留缝
      if (prevPt) {
        const d = Math.hypot(x - prevPt.x, y - prevPt.y);
        const step = Math.max(1, r * 0.35), n = Math.min(240, Math.ceil(d / step));
        for (let i = 1; i < n; i++) {
          mDab(g, prevPt.x + (x - prevPt.x) * i / n, prevPt.y + (y - prevPt.y) * i / n, r);
        }
      }
      mDab(g, x, y, r);
    }
    g.restore();
    return { x: x, y: y };
  }
  matWrap.addEventListener("pointerdown", (ev) => {
    if (!mOn) return;
    const box = (ev.target && ev.target.closest) ? ev.target.closest(".gal-ml") : null;
    if (!box) return;
    const L = mLayers.filter((x) => x.box === box)[0];
    if (!L) return;
    ev.stopPropagation(); ev.preventDefault();
    mSelectL(L);
    if (mMeshOn(L) && (mBrushOn || mEraseOn || mDropOn)) {
      toast("这一层开着网格 —— 先关掉「▦ 网格扭曲」再画（不然画的东西会被扭曲覆盖掉）");
      return;
    }
    if (mDropOn) {                                    // ★ 387：吸管橡皮，点一下擦一整块
      mStrokeUndo(L);
      const n = mDropErase(ev, L);
      setState(n ? "吸管橡皮：擦掉了这一块（" + n + " 像素），↩ 可撤回" : "这一块擦不动（可能已经是透明的）");
      return;
    }
    if (mBrushOn || mEraseOn) {                       // 在选中层上画 / 擦
      mStrokeUndo(L);                                 // ★ 386：一笔一撤回
      let last = mStrokeAt(ev);
      setState(mEraseOn ? "橡皮：正在擦这一层（只擦选中的那一层，底图不动）" : "画笔：正在这一层上画");
      const mv = (e2) => { last = mStrokeAt(e2, last); };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      return;
    }
    mGeoUndo(L);                                      // ★ 386：拖之前存旧位置
    const st0 = { x: ev.clientX, y: ev.clientY, lx: L.x, ly: L.y };
    const mv2 = (e2) => {
      L.x = st0.lx + (e2.clientX - st0.x) / mK;
      L.y = st0.ly + (e2.clientY - st0.y) / mK;
      mPlace(L);
    };
    const up2 = () => { window.removeEventListener("pointermove", mv2); window.removeEventListener("pointerup", up2); };
    window.addEventListener("pointermove", mv2); window.addEventListener("pointerup", up2);
  }, true);
  // ---- 右栏：素材条 + 图层控制 ----
  const mLayerBox = el("div", "display:none;flex-direction:column;gap:5px;width:100%;max-height:40vh;overflow-y:auto;"
    + "overflow-x:hidden;border-top:1px solid rgba(150,162,180,.3);padding-top:6px;margin-top:2px;font:11.5px system-ui");
  railR.appendChild(mLayerBox);
  function mBtn2(txt, title, fn, on) {
    const b = el("button", "font:11.5px system-ui;padding:3px 7px;border-radius:6px;cursor:pointer;"
      + (on ? "border:1px solid rgba(120,180,255,.8);background:rgba(96,166,255,.28);"
            : "border:1px solid rgba(150,162,180,.5);background:rgba(255,255,255,.05)") + ";color:#dce3f0", txt);
    b.title = title || txt;
    b.addEventListener("click", (e2) => { e2.stopPropagation(); fn(); });
    return b;
  }
  function mRow() { const d = el("div", "display:flex;gap:4px;flex-wrap:wrap;align-items:center"); return d; }
  // ★ 385 批：一条"标签 + 滑条 + 当前值"的通用滑条（粗细 / 柔和都用它）
  function mSlider(label, min, max, step, value, onIn, unit) {
    const row = mRow();
    row.appendChild(el("span", "opacity:.75;font-size:11px;flex:0 0 auto", label));
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(value);
    inp.title = label + "（画笔和橡皮共用）";
    inp.style.cssText = "flex:1;min-width:62px;accent-color:#7c5cff";
    const vv = el("span", "opacity:.7;font-size:10.5px;flex:0 0 auto", value + (unit || ""));
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value) || 0;
      vv.textContent = v + (unit || "");
      onIn(v);
    });
    row.appendChild(inp); row.appendChild(vv);
    return row;
  }
  function mRenderPanel() {
    mLayerBox.innerHTML = "";
    mLayerBox.appendChild(el("div", "opacity:.85;font-weight:700", "素材（点一下放上去，也能拖进画布）"));
    const strip = el("div", "display:flex;gap:5px;overflow-x:auto;padding-bottom:3px");
    strip.style.cssText = "display:flex;gap:5px;overflow-x:auto;padding-bottom:3px;min-height:48px";
    mLayerBox.appendChild(strip);
    (async () => {
      if (!mMatItems) {
        try {
          const r = await fetch(API + "/list?page=material&offset=0&limit=300", { cache: "no-store" }).then((x) => x.json());
          mMatItems = (r && r.items) || [];
        } catch (e) { mMatItems = []; }
      }
      // ★ 384：叠图保存的成品图也叫「叠图_…」，别把它摆进素材条（它是整张图，不是透明小块）
      const only = mMatItems.filter((x) => !/^叠图_/.test(String((x && x.name) || "")));
      if (!only.length) {
        const t2 = el("div", "opacity:.55;font-size:11px", "素材栏是空的 —— 在画廊右键「➕ 加到素材栏」，或在下面裁素材");
        strip.appendChild(t2);
        return;
      }
      only.slice(0, 60).forEach((it) => {
        const im = document.createElement("img");
        im.src = imgUrl(it.rel);
        im.title = (it.name || "") + "\\n点一下 = 放到画布中间；也可以拖进画布";
        im.draggable = true;
        im.style.cssText = "width:44px;height:44px;object-fit:contain;border-radius:5px;cursor:pointer;"
          + "border:1px solid rgba(150,162,180,.5);background:rgba(0,0,0,.25);flex:0 0 auto";
        im.addEventListener("dragstart", (e2) => { try { e2.dataTransfer.setData("text/plain", it.rel); } catch (e3) {} });
        im.addEventListener("click", () => mAddMat(it.rel));
        strip.appendChild(im);
      });
    })();
    const r1 = mRow();
    r1.appendChild(mBtn2("＋ 绘画层", "新建一个空白图层，可以在上面画 / 擦", mAddPaint));
    r1.appendChild(mBtn2("⬆", "图层往上移一层（底图永远在最底）", () => mMoveL(1)));
    r1.appendChild(mBtn2("⬇", "图层往下移一层", () => mMoveL(-1)));
    r1.appendChild(mBtn2("🗑", "删掉选中的图层", mDelL));
    r1.appendChild(mBtn2("🧹 全清", "点两下 = 把所有素材 / 绘画层一起删掉（底图不动）", mClearAll));
    // ★ 386 批（他："非素材模式有撤回上一步，素材模式没有，应该也同步加上才对"）
    r1.appendChild(mBtn2("↩ 撤回", "退回上一步（移动 / 缩放 / 旋转 / 翻转 / 亮度 / 画一笔 / 擦一笔 / 增删 / 全清）", mUndoRun));
    mLayerBox.appendChild(r1);
    // ★ 385 批（他："右边按钮的旋转 15 度完全不需要了，上下左右翻转也不需要了"）→ 整排删掉。
    //   旋转 : 素材顶上那颗 ↻（按住拖）；翻转：素材右上角 ⇋ / ⇅ 两颗就地小键。
    const r3 = mRow();
    r3.appendChild(mBtn2("🖌 画笔", "打开后点图层 = 在上面画（白色）", () => { mBrushOn = !mBrushOn; if (mBrushOn) { mEraseOn = false; mDropOn = false; } mCursorSync(null); mRenderPanel(); }, mBrushOn));
    r3.appendChild(mBtn2("🧽 橡皮", "打开后点图层 = 擦掉那一层（比如擦素材边缘，让它融进背景）", () => { mEraseOn = !mEraseOn; if (mEraseOn) { mBrushOn = false; mDropOn = false; } mCursorSync(null); mRenderPanel(); }, mEraseOn));
    // ★ 387 批（他："来个吸管橡皮"）→ 点一下就把这一块连着一起的同色像素擦掉，不用一点点涂
    r3.appendChild(mBtn2("💧 吸管橡皮", "点一下 = 把这一层里连在一起的同一块颜色整块擦掉（做抠图、去底色用）",
      () => { mDropOn = !mDropOn; if (mDropOn) { mBrushOn = false; mEraseOn = false; } mCursorSync(null); mRenderPanel(); }, mDropOn));
    mLayerBox.appendChild(r3);
    { // ★ 399：一键去背景（把矩形素材抠成紧贴主体的透明块 → 自动蒙版就只包住主体）
      const r7 = mRow();
      r7.appendChild(mBtn2("🪄 一键去背景", "从四边往里抠掉连成一片的背景（渐变背景也能抠），只影响选中的这一层；撤销用 ↩ 撤回", () => {
        if (!mSelL) { toast("先选一个图层"); return; }
        const L = mSelL;
        mStrokeUndo(L);
        const n = mCutBg(L);
        if (!n) { toast("没抠掉东西（这一层边上可能本来就是透明的）"); return; }
        setState("去背景：抠掉 " + n + " 个像素（↩ 可撤回）");
        toast("已抠掉背景 " + n + " 像素；接着 💾 保存，蒙版就只包主体了");
      }));
      r7.appendChild(mBtn2("🩹 " + (mMaskMode === "full" ? "整块重画"
          : (mMaskMode === "ring" ? "只融边" : "渐强(推荐)")),
        "「渐强」= 素材内部只轻改（重新打光、补纹理，形状基本不动），外圈 12px 完整重画，既不突兀又能融合。"
        + "「只融边」= 内部一个像素都不动（最保真，但像贴纸）。「整块重画」= 完全交给模型。点一下轮换。",
        () => {
          mMaskMode = (mMaskMode === "grad" ? "ring" : (mMaskMode === "ring" ? "full" : "grad"));
          mRenderPanel();
        },
        mMaskMode === "grad"));
      mLayerBox.appendChild(r7);
      // ★ 423 批（他："好烂，不行咱放弃了吧"）→ 干脆**不经过模型**：底图 + 素材（含投影/亮度）
      //   直接合成一张成品，存进「素材」栏（名字 成图_…）。素材本来就是画不出来才贴的，
      //   让模型去碰它只会有伪影 —— 这条路是确定能用的。
      const r9 = mRow();
      r9.appendChild(mBtn2("💾 不经过模型出图", "把 底图 + 素材（含投影/亮度）直接合成一张成品，存进「素材」栏；"
        + "不跑采样、不改任何像素、零伪影", async () => {
        try {
          const comp = mCompositeCanvas();
          const nm = "成图_" + String(rel || "图").split("/").pop().replace(/\.[^.]+$/, "")
            + "_" + String(Date.now()).slice(-5);
          const r = await apiPost("/material", { png: comp.toDataURL("image/png"), name: nm });
          if (!r || !r.rel) { toast("存失败：" + ((r && r.error) || ""), true); return; }
          mMatItems = null; mRenderPanel();
          toast("已出图：" + (r.name || "") + "（在画廊「素材」页，右键可加进下载/编辑栏）");
        } catch (e) { toast("出图失败：" + (e && e.message ? e.message : e), true); }
      }));
      mLayerBox.appendChild(r9);
      // ★ 424 批（他："要特殊注明，这只是权宜之计，若有 qwen 等合适模型，仍然可以直接通过生图做到完美适配"）
      mLayerBox.appendChild(el("div", "opacity:.6;font-size:10.5px;line-height:1.5",
        "⚠ 权宜之计：这颗键是**纯手工合成**（素材原样贴上 + 投影/亮度），全程不经过任何 AI。"
        + "等以后有 qwen 这类合适的模型，仍然可以直接靠生图做到真正的完美适配。"));
    }
    // ★ 392 批（他："素材允许切网格模式，然后进行局部扭曲"）
    const r6 = mRow();
    r6.appendChild(mBtn2("▦ 网格扭曲", "打开后这一层出现 4×4 网格，拖任意格点就能局部扭曲（真的改像素）", () => {
      if (!mSelL) { toast("先在右栏选一个图层"); return; }
      const L = mSelL;
      if (L.mesh) {
        mUndoPush("关掉网格", () => { mMeshInit(L, 4); mMeshPaint(); });
        L.mesh = null;
      } else {
        mUndoPush("开了网格", () => { if (mSelL) { mSelL.mesh = null; mMeshPaint(); } });
        mMeshInit(L, 4);
      }
      mMeshPaint(); mRenderPanel();
    }, !!(mSelL && mSelL.mesh)));
    if (mSelL && mSelL.mesh) {
      r6.appendChild(mBtn2("↺ 重置网格", "把这一层的扭曲还原成原来的样子", () => {
        const L = mSelL;
        const pts0 = L.mesh.pts.map((p) => ({ x: p.x, y: p.y }));
        mUndoPush("重置网格", () => { L.mesh.pts = pts0.map((p) => ({ x: p.x, y: p.y })); mMeshWarp(L); mMeshPaint(); });
        mMeshReset(L);
      }));
    }
    mLayerBox.appendChild(r6);
    // ★ 387 批（他："我现在粗细 9PX 都嫌粗了"）→ 下限放到 1px，默认 6px
    // ★ 391 批（他："画笔并不能调整颜色，应该允许调整大致的颜色才对"）→ 颜色 + 一排常用色
    const r5 = mRow();
    r5.appendChild(el("span", "opacity:.75;font-size:11px;flex:0 0 auto", "🎨 颜色"));
    const cin = document.createElement("input");
    cin.type = "color"; cin.value = mColor;
    cin.title = "画笔颜色（也可以在画面上按住右键 0.4 秒吸色）";
    cin.style.cssText = "width:34px;height:22px;padding:0;border:1px solid rgba(150,162,180,.5);border-radius:5px;"
      + "background:transparent;cursor:pointer";
    cin.addEventListener("input", () => { mColor = cin.value || "#ffffff"; });
    r5.appendChild(cin);
    ["#ffffff", "#000000", "#ff3b5c", "#ffd166", "#86e07a", "#5c8dff"].forEach((c) => {
      const sw = el("i", "");
      sw.style.cssText = "width:16px;height:16px;border-radius:4px;background:" + c + ";cursor:pointer;flex:0 0 auto;"
        + "border:2px solid " + (String(c).toLowerCase() === String(mColor).toLowerCase()
            ? "rgba(120,180,255,.95)" : "rgba(150,162,180,.45)");
      sw.title = "用这个颜色：" + c;
      sw.addEventListener("click", () => { mColor = c; mRenderPanel(); });
      r5.appendChild(sw);
    });
    mLayerBox.appendChild(r5);
    mLayerBox.appendChild(mSlider("粗细", 1, 100, 1, mBrush, (v) => { mBrush = v; mCursorSync(null); }, "px"));
    mLayerBox.appendChild(mSlider("柔和", 0, 100, 5, Math.round(mSoft * 100), (v) => { mSoft = v / 100; }, "%"));
    // ★ 384 批（他："新增给素材调高或者调低亮度的功能"）→ 选中的那一层一颗亮度滑条（0.2 ~ 2.5 倍）
    const r4 = mRow();
    r4.appendChild(el("span", "opacity:.75;font-size:11px;flex:0 0 auto", "☀ 亮度"));
    if (mSelL) {
      const bcur = mSelL.bright || 1;
      const br = document.createElement("input");
      br.type = "range"; br.min = "0.2"; br.max = "2.5"; br.step = "0.05"; br.value = String(bcur);
      br.title = "调这一层的亮度（只影响选中的这一层，和保存出来的合成图一致）";
      br.style.cssText = "flex:1;min-width:70px;accent-color:#7c5cff";
      const bv = el("span", "opacity:.75;font-size:10.5px;flex:0 0 auto", Math.round(bcur * 100) + "%");
      let bPushed = false;                      // ★ 386：一次拖动只记一步，拖完松手再拖才记下一步
      br.addEventListener("input", () => {
        if (!mSelL) return;
        if (!bPushed) { bPushed = true; mGeoUndo(mSelL); }
        mSelL.bright = Math.max(0.1, parseFloat(br.value) || 1);
        mPlace(mSelL);
        bv.textContent = Math.round(mSelL.bright * 100) + "%";
      });
      br.addEventListener("change", () => {
        bPushed = false;
        setState("这一层亮度 " + Math.round((mSelL ? (mSelL.bright || 1) : 1) * 100) + "%");
      });
      r4.appendChild(br); r4.appendChild(bv);
    } else {
      r4.appendChild(el("span", "opacity:.5;font-size:10.5px", "先选一个素材 / 图层"));
    }
    mLayerBox.appendChild(r4);
    // ★ 417 批（他选方案 1）：投影 / 接触阴影滑条 —— 让贴上去的素材"压"在头发上，不像贴纸
    {
      const r8 = mRow();
      r8.appendChild(el("span", "opacity:.75;font-size:11px;flex:0 0 auto", "🌑 投影"));
      if (mSelL) {
        const scur = mSelL.shadow || 0;
        const sr = document.createElement("input");
        sr.type = "range"; sr.min = "0"; sr.max = "100"; sr.step = "5"; sr.value = String(Math.round(scur * 100));
        sr.title = "给这一层加接触阴影（按素材轮廓往外投，右下方向）。40~60 一般刚好";
        sr.style.cssText = "flex:1;min-width:70px;accent-color:#7c5cff";
        const sv = el("span", "opacity:.75;font-size:10.5px;flex:0 0 auto", Math.round(scur * 100) + "%");
        let sPushed = false;
        sr.addEventListener("input", () => {
          if (!mSelL) return;
          if (!sPushed) { sPushed = true; mGeoUndo(mSelL); }
          mSelL.shadow = Math.max(0, Math.min(1, parseFloat(sr.value) / 100));
          mPlace(mSelL);
          sv.textContent = Math.round(mSelL.shadow * 100) + "%";
        });
        sr.addEventListener("change", () => { sPushed = false; });
        r8.appendChild(sr); r8.appendChild(sv);
      } else {
        r8.appendChild(el("span", "opacity:.5;font-size:10.5px", "先选一个素材 / 图层"));
      }
      mLayerBox.appendChild(r8);
    }
    // ★ 391 批（他："标记错了，底图虽然是最底层，但是却放在最上面"）
    //   列表是**上面 = 视觉上更靠上的一层**，所以底图要排在**最后一行**（最下面），不能再顶在开头。
    mLayerBox.appendChild(el("div", "opacity:.6;font-size:11px", "图层（上面一行盖住下面一行）"));
    [...mLayers].reverse().forEach((L) => {
      const row = el("div", "display:flex;gap:5px;align-items:center;cursor:pointer;padding:1px 4px;border-radius:5px;"
        + (L === mSelL ? "background:rgba(96,166,255,.22)" : ""));
      row.textContent = (L.kind === "paint" ? "🖌 " : "🖼 ") + L.name + "  " + Math.round(L.w) + "×" + Math.round(L.h);
      row.addEventListener("click", () => mSelectL(L));
      mLayerBox.appendChild(row);
    });
    // 底图：永远在最下面（列表最后一行），不能调顺序，但**可以选中**
    const baseRow = el("div", "display:flex;gap:5px;align-items:center;cursor:pointer;padding:1px 4px;border-radius:5px;"
      + (mSelBase ? "background:rgba(96,166,255,.22)" : ""));
    baseRow.textContent = "🖼 底图（永远在最下面，不能调顺序）";
    baseRow.addEventListener("click", () => mSelectBase());
    mLayerBox.appendChild(baseRow);
    if (mLayers.length) {
      mLayerBox.appendChild(el("div", "opacity:.5;font-size:10.5px",
        "选中后：四角/四边有手柄，右上有旋转 / 翻转键；滚轮 = 整体缩放（底图+素材同步），Alt+滚轮才缩单层"));
    }
    try { mCursorSync(null); } catch (e) { /* 光标还没建好 */ }
  }
  // 素材直接拖进画布
  stage.addEventListener("dragover", (ev) => { if (!mOn) return; ev.preventDefault(); });
  stage.addEventListener("drop", (ev) => {
    if (!mOn) return;
    ev.preventDefault();
    let relM = "";
    try { relM = ev.dataTransfer.getData("text/plain") || ""; } catch (e) { relM = ""; }
    if (relM) mAddMat(relM, mToLocal(ev));
  });
  // ---- ★ 383/384 批：图层保存 / 恢复（sidecar）+ 合成图 + 蒙版 ----
  //   ★ 384 批两个合成 bug（他："点击第四层蒙版，还是只展示底图"）：
  //   ① 底图有 left/top 偏移（居中摆放），图层坐标是 stage 坐标 —— 原来直接拿 L.x 当底图像素用，
  //      等于把素材整体平移了「底图左边距」，常常直接飞出画面 → 合成图里只剩底图。
  //   ② 原来把 L.x/L.y 当**中心**画，而盒子是 left/top 定位 → 又偏半张素材。
  //   两处一起改：统一走 mDrawLayerOn()，中心 = 左上 + 尺寸/2，并减去底图原点。
  // ★ 393 批（他："重新打开时，发现蒙版里面的重绘位置直接错位了"）
  //   之前底图在容器里的位置是拿 `cv.style.left` 猜的（那串是 fit() 写进去的样式字符串，
  //   可能还没写、也可能是上一版布局的旧值）→ 蒙版/合成图整体偏一截，模型就在错的地方重绘，
  //   于是"出来只有原图要素"。
  //   现在改成**直接量屏幕上真实渲染出来的位置**：两个元素的 getBoundingClientRect 相减再除以缩放，
  //   跟我在算式里怎么摆无关 —— 屏幕上在哪就是哪。
  function mGeo() {
    const w = base.naturalWidth || 1, h = base.naturalHeight || 1;
    let bx = 0, by = 0, dw = w;
    try {
      const br = base.getBoundingClientRect(), wr = viewW.getBoundingClientRect();
      const k = mK > 0.0001 ? mK : 1;
      bx = (br.left - wr.left) / k;
      by = (br.top - wr.top) / k;
      dw = (br.width || 0) / k;
    } catch (e) { /* 忽略 */ }
    if (!(dw > 1)) dw = parseFloat(base.style.width) || w;
    return { w: w, h: h, sc: w / Math.max(1, dw), bx: bx, by: by };
  }
  // ★ 417：投影参数（显示用 CSS drop-shadow，合成用 canvas shadow*，两边必须取同一套）
  function mShadowParts(L) {
    const s = Math.max(0, Math.min(1, (L && L.shadow) || 0));
    if (s <= 0.01) return null;
    return { a: (0.5 * s).toFixed(2), blur: 3 + s * 10, dx: 2 + s * 4, dy: 2 + s * 5 };
  }
  function mShadowCss(L) {
    const p = mShadowParts(L);
    if (!p) return "";
    return " drop-shadow(" + p.dx.toFixed(1) + "px " + p.dy.toFixed(1) + "px "
      + p.blur.toFixed(1) + "px rgba(0,0,0," + p.a + "))";
  }
  function mDrawLayerOn(c2, L, g, skipBright) {
    const dw = Math.max(1, L.w * g.sc), dh = Math.max(1, L.h * g.sc);
    c2.save();
    c2.translate((L.x - g.bx + L.w / 2) * g.sc, (L.y - g.by + L.h / 2) * g.sc);
    c2.rotate((L.rot || 0) * Math.PI / 180);
    c2.scale(L.flipX ? -1 : 1, L.flipY ? -1 : 1);
    try { c2.filter = skipBright ? "none" : "brightness(" + (L.bright || 1) + ")"; } catch (e) { /* 忽略 */ }
    if (!skipBright) {                                  // 轮廓层不加投影（会把蒙版撑大）
      const sp = mShadowParts(L);
      if (sp) {
        c2.shadowColor = "rgba(0,0,0," + sp.a + ")";
        c2.shadowBlur = sp.blur;
        c2.shadowOffsetX = sp.dx * g.sc;
        c2.shadowOffsetY = sp.dy * g.sc;
      }
    }
    c2.drawImage(L.node, -dw / 2, -dh / 2, dw, dh);
    c2.restore();
  }
  function mCompositeCanvas() {
    const g = mGeo();
    const out = document.createElement("canvas"); out.width = g.w; out.height = g.h;
    const c2 = out.getContext("2d");
    c2.drawImage(base, 0, 0, g.w, g.h);
    mLayers.forEach(function (L) { mDrawLayerOn(c2, L, g); });
    return out;
  }
  // 叠图的蒙版 = 「素材 / 绘画层占的地方」（白 = 要重绘），轮廓外扩 8px。
  //   他："如果是叠图生成的话…都知道是叠图的那一部分要重新生成" → 不用他手涂。
  // ★ 407 批（他："肯定不能重画，发卡就是因为不能通过提示词画出来，所以才要把图片贴上去"）
  //   → 素材内部**一个像素都不该让模型碰**。默认蒙版改成只有**外圈那一条（12px）**：
  //   贴上去的像素原样保留，模型只负责把边融进背景。要整块重画时右栏可切换。
  function mSilhouetteCanvas(g) {
    const sil = document.createElement("canvas"); sil.width = g.w; sil.height = g.h;
    const sc2 = sil.getContext("2d");
    mLayers.forEach(function (L) {
      const t = document.createElement("canvas"); t.width = g.w; t.height = g.h;
      const tc = t.getContext("2d");
      mDrawLayerOn(tc, L, g, true);            // 轮廓不看亮度
      tc.globalCompositeOperation = "source-in";
      tc.fillStyle = "#fff"; tc.fillRect(0, 0, g.w, g.h);
      sc2.drawImage(t, 0, 0);
    });
    return sil;
  }
  function mMaskCanvasFromLayers() {
    const g = mGeo();
    const mc = document.createElement("canvas"); mc.width = g.w; mc.height = g.h;
    const m = mc.getContext("2d");
    m.fillStyle = "#000"; m.fillRect(0, 0, g.w, g.h);
    const R = MM_RING, ring = [[0, 0]];
    for (let i = 0; i < 8; i++) {
      ring.push([Math.round(Math.cos(i * Math.PI / 4) * R), Math.round(Math.sin(i * Math.PI / 4) * R)]);
    }
    const sil = mSilhouetteCanvas(g);
    ring.forEach(function (o) { m.drawImage(sil, o[0], o[1]); });      // 外扩一圈 → 这一圈给满强度
    if (mMaskMode === "ring") {                                       // 只融边：内部完全不动
      m.globalCompositeOperation = "destination-out";
      m.drawImage(sil, 0, 0);
      m.globalCompositeOperation = "source-over";
      return mc;
    }
    if (mMaskMode !== "full") {
      // ★ 411 批（他："只融边的话素材会显得很突兀，光影也不融合"）
      //   → **渐强蒙版**：素材内部给一个中等值（MM_IN），外面那圈给满值。
      //   配合采样器 denoise 0.9：内部实际只被"轻改"（重新打光/补纹理、形状基本不动），
      //   边上一圈则被完整重画 → 既不突兀、也不会把素材改成别的东西。
      // ★ 412：**只模糊内部**，外圈必须是干净的 255 —— 上一版把整张一起模糊，
      //   12px 宽的圈被削到 185（实测 max 197），融边力度直接掉了 30%。
      const gray = document.createElement("canvas"); gray.width = g.w; gray.height = g.h;
      const gc = gray.getContext("2d");
      gc.drawImage(sil, 0, 0);
      gc.globalCompositeOperation = "source-in";
      gc.fillStyle = "rgb(" + MM_IN + "," + MM_IN + "," + MM_IN + ")";
      gc.fillRect(0, 0, g.w, g.h);
      m.save();
      try { m.filter = "blur(" + Math.max(2, Math.round(MM_BLUR)) + "px)"; } catch (e) { /* 忽略 */ }
      m.drawImage(gray, 0, 0);                     // 内部：柔和的中等强度
      m.restore();
      const ringCv = document.createElement("canvas"); ringCv.width = g.w; ringCv.height = g.h;
      const rc = ringCv.getContext("2d");
      ring.forEach(function (o) { rc.drawImage(sil, o[0], o[1]); });
      rc.globalCompositeOperation = "destination-out";
      rc.drawImage(sil, 0, 0);
      m.drawImage(ringCv, 0, 0);                   // 外圈：干净的 255
      return mc;
    }
    return mc;
  }
  function mLayerPng(L) { try { return L.node.toDataURL("image/png"); } catch (e) { return ""; } }
  function mLayersSnapshot() {
    return { v: 1, at: Date.now(), base: rel, stack: stackRelOf(rel) || "",
             layers: mLayers.map(function (L) {
      return { kind: L.kind, name: L.name, x: L.x, y: L.y, w: L.w, h: L.h, rot: L.rot || 0,
               flipX: !!L.flipX, flipY: !!L.flipY, bright: L.bright || 1, shadow: L.shadow || 0, png: mLayerPng(L) };
    }) };
  }
  async function mSaveAll() {
    if (!mLayers.length) { toast("这个模式里一张素材都没放 —— 蒙版没动，只存了个空的图层记录"); }
    // ① 合成图（底图 + 所有图层）→ 存进「素材」栏；第 4 层以后直接显示它
    if (mLayers.length) {
      try {
        const comp = mCompositeCanvas();
        const nm = "叠图_" + String(rel || "图").split("/").pop().replace(/\.[^.]+$/, "");
        const dataUrl = comp.toDataURL("image/png");
        const r = await apiPost("/material", { png: dataUrl, name: nm });
        if (r && r.rel) stackSet(rel, r.rel);
        // ★ 393：再存一份**固定名字**的合成图（掩码/<rel>_stack.png）——
        //   画廊节点的 IMAGE 输出按这个名字找，比"按文件名猜"可靠得多。
        //   （后端没更新时 as 会被忽略、写成蒙版，但后面马上会写真正的蒙版，所以不会留脏）
        try { await apiPost("/mask", { rel: rel, png: dataUrl, as: "stack" }); } catch (e2) { /* 忽略 */ }
      } catch (e) { toast("合成图没存下来：" + (e && e.message ? e.message : e), true); }
    }
    // ② 图层记录（重开「编辑图片」时按它恢复）
    try { await apiPost("/layers", { rel: rel, data: mLayersSnapshot() }); }
    catch (e) { toast("存图层记录失败（这条接口要重启 ComfyUI 才生效）：" + (e && e.message ? e.message : e), true); }
    if (!mLayers.length) return;
    // ③ 蒙版 = 素材占的位置（白 = 要重绘）
    try {
      await apiPost("/mask", { rel: rel, png: mMaskCanvasFromLayers().toDataURL("image/png") });
      // ★ 399 批（他："发卡仍然是半透明的…我想要的效果是照着贴的图重画一遍"）
      //   这条必须写进保存提示：叠图是**靠模型重画**的；denoise 0.5~0.6 会把贴上去的像素按
      //   (1−denoise) 原样留下 → 深色素材被稀释成半透明灰。要"重画"就得 0.8~0.9。
      toast("已存：图层记录 + 合成图（第 4 层看得到）+ 蒙版（白 = 要重绘）\n"
        + (mMaskMode === "full"
            ? "⚠ 整块重画：denoise 0.8~0.9（素材会被完全重画）"
            : (mMaskMode === "ring"
                ? "🩹 只融边：蒙版只有外圈 12px，素材一个像素都不动；denoise 0.9（强度全由蒙版控制）"
                : "🩹 渐强：内部 35% + 外圈 100%，denoise 用 0.9（内部轻改/重新打光，外圈完整重画）")));
    } catch (e) { toast("蒙版没存下来：" + (e && e.message ? e.message : e), true); }
  }
  let mRestored = false;
  async function mTryRestore() {
    if (mRestored) return;
    mRestored = true;
    try {
      const r = await fetch(API + "/layers?rel=" + encodeURIComponent(rel), { cache: "no-store" }).then((x) => x.json());
      if (!r || !r.exists || !r.text) return;
      const d = JSON.parse(r.text);
      const arr = d.layers || [];
      for (let k = 0; k < arr.length; k++) {
        const it = arr[k];
        const im = await new Promise((res) => {
          const i2 = new Image();
          i2.onload = () => res(i2);
          i2.onerror = () => res(null);
          i2.src = it.png || "";
        });
        if (!im) continue;
        const L = mMakeLayer(it.kind || "mat", im.naturalWidth, im.naturalHeight);
        L.ctx.drawImage(im, 0, 0);
        L.name = it.name || "素材";
        L.x = it.x; L.y = it.y; L.w = it.w; L.h = it.h;
        L.rot = it.rot || 0; L.flipX = !!it.flipX; L.flipY = !!it.flipY;
        L.bright = (typeof it.bright === "number" && it.bright > 0) ? it.bright : 1;
        L.shadow = (typeof it.shadow === "number" && it.shadow > 0) ? Math.min(1, it.shadow) : 0;
        mPlace(L); mLayers.push(L);
      }
      mRenderPanel();
      if (mLayers.length) mSelectL(mLayers[mLayers.length - 1]);
      toast("已恢复上次摆的 " + arr.length + " 个图层");
    } catch (e) { /* 没有记录就静默 */ }
  }
  const mSetOnBase = mSetOn;
  mSetOn = function (on) {                    // 素材模式：顺带显示 / 收起右栏的图层区，并把图层跟着缩放
    mSetOnBase(on);
    mLayerBox.style.display = on ? "flex" : "none";
    if (on) { mPaintLayers(); mRenderPanel(); mTryRestore(); }
    else { mBrushOn = false; mEraseOn = false; mDropOn = false; }
  };
  node.__galMatMode = mSetOn;
  // ⚠️ 不要再给 mBtn 加第二个点击监听：上面那颗监听里引用的是 `mSetOn` 这个变量，重绑后自然走新逻辑，
  //    再加一个监听会变成"点一下切两次 = 没反应"。
  function mPaintLayers() {
    // 386：素材层已经装在 viewW 里了，跟着容器一起缩放，不需要再单独写 transform（空实现，防递归）
  }
  { const pv = mPaintView; mPaintView = function () { pv(); mPaintLayers(); }; }
  card.appendChild(foot);
  card.appendChild(el("div", "font:11px/1.5 system-ui;opacity:.55",
    "笔刷/形状涂到的都算蒙版；闭口区域中间双击 = 自动填满；💧 吸管点一下 = 相邻同色的整块都涂上。原图一个像素都不动。"));

  back.appendChild(card);
  back.addEventListener("click", (e) => { if (e.target === back) { closeMaskUI(); render(node); } });
  document.body.appendChild(back);
  maskUI = back;
  function setState(s) { state.textContent = s; }

  const ctx = cv.getContext("2d");
  const octx = ov.getContext("2d");
  let erasing = false;
  let undoS = [];
  function snapMask() {
    try { undoS.push(ctx.getImageData(0, 0, cv.width, cv.height)); if (undoS.length > 30) undoS.shift(); } catch (e) { /* 忽略 */ }
  }
  function doUndo() {
    const d = undoS.pop();
    if (!d) { setState("没有可撤回的了"); return; }
    ctx.putImageData(d, 0, 0); drawAll();
    setState("撤回一步（还可以回 " + undoS.length + " 步）");
  }
  function paintStyle(c2) {
    c2.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    // ★ 273l（他第 5 条）：50%+50% 不该叠成 75% → 笔迹之间 alpha 恒为 1，"半透明"交给整层 CSS opacity
    c2.globalAlpha = 1;
    c2.strokeStyle = st1.color; c2.fillStyle = st1.color;
    c2.lineCap = "round"; c2.lineJoin = "round";
  }
  function fit() {
    // 画布尺寸 = 图片"显示出来"的尺寸（物理像素用 natural，CSS 用显示框），两者对齐
    const stg = stage.getBoundingClientRect();
    if (!base.naturalWidth || !stg.width) return;
    const maxW = Math.max(40, stg.width - 4), maxH = Math.max(40, stg.height - 4);
    const k = Math.min(maxW / base.naturalWidth, maxH / base.naturalHeight);
    const dw = Math.max(1, Math.round(base.naturalWidth * k)), dh = Math.max(1, Math.round(base.naturalHeight * k));
    base.style.width = dw + "px"; base.style.height = dh + "px";
    base.style.maxWidth = "none"; base.style.maxHeight = "none";
    // ★ 273l（他第 2 条："涂着涂着就没了"）：以前每次 fit 都把 canvas 尺寸重设一遍 = 清空已画的
    //   → 只有尺寸真变了才重设，而且先把已画的搬过去
    if (cv.width !== base.naturalWidth || cv.height !== base.naturalHeight) {
      let keep = null;
      try { if (cv.width > 1 && cv.height > 1) keep = ctx.getImageData(0, 0, cv.width, cv.height); } catch (e) { keep = null; }
      cv.width = base.naturalWidth; cv.height = base.naturalHeight;
      if (keep) { try { ctx.putImageData(keep, 0, 0); } catch (e) { /* 忽略 */ } }
    }
    ov.width = base.naturalWidth; ov.height = base.naturalHeight;
    [cv, ov].forEach((c2) => {
      c2.style.width = dw + "px"; c2.style.height = dh + "px";
      c2.style.left = Math.round((stg.width - dw) / 2) + "px";
      c2.style.top = Math.round((stg.height - dh) / 2) + "px";
    });
    drawAll();
    if (!fit.__old) { fit.__old = true; loadOldMask(); }
  }
  function loadOldMask() {
    fetch(API + "/mask?rel=" + encodeURIComponent(rel), { cache: "no-store" })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b) return;
        const im = new Image();
        im.onload = () => {
          const tmp = document.createElement("canvas");
          tmp.width = cv.width; tmp.height = cv.height;
          const tc = tmp.getContext("2d");
          tc.drawImage(im, 0, 0, cv.width, cv.height);
          // ★ 273l（他第 2 条"一打开整张图被黑布盖住"）：存的是黑底白块，直接铺就是黑布
          //   → 把亮度当 alpha、颜色统一改成白的，黑的地方自然透明
          try {
            const dd = tc.getImageData(0, 0, tmp.width, tmp.height);
            const a = dd.data;
            for (let i = 0; i < a.length; i += 4) {
              const v = Math.max(a[i], a[i + 1], a[i + 2]);
              a[i] = 255; a[i + 1] = 255; a[i + 2] = 255; a[i + 3] = v;
            }
            tc.putImageData(dd, 0, 0);
          } catch (e) { /* 忽略 */ }
          ctx.save(); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
          ctx.drawImage(tmp, 0, 0); ctx.restore();
          drawAll(); setState("已有蒙版（可以继续补）");
        };
        im.src = URL.createObjectURL(b);
      })
      .catch(() => { /* 忽略 */ });
  }
  base.addEventListener("load", fit);
  if (base.complete && base.naturalWidth) fit();
  try { new ResizeObserver(() => { if (!obj) fit(); }).observe(stage); } catch (e) { /* 忽略 */ }

  // ---------- 图形对象（可反复选中编辑） ----------
  // ★ 273n（他第 1 条）：盖上之后还要能再点一下重新编辑；点画面空白 = 视为盖上。
  //   所以形状**不再"烧"成像素**，而是存进 objs 列表，保存时再合成。
  // objs/ obj/ dragObj 已在函数开头声明（避免加载竞态）



  function minPx() {          // ★ 他第 3 条：最小直径 2cm（屏幕约 35cm 宽）
    const perCm = (window.innerWidth || 1920) / 35;
    return Math.max(8, Math.round(2 * perCm * (cv.width / Math.max(1, cv.clientWidth || cv.width))));
  }
  function syncObjBtns() {
    btnStamp.style.display = obj ? "" : "none";
    btnDropObj.style.display = obj ? "" : "none";
    btnCropMat.style.display = obj ? "" : "none";     // ★ 364 批：选中图形时才出现
  }
  function objPath(c2, o) {
    c2.save();
    c2.translate(o.cx, o.cy);
    c2.rotate(o.rot || 0);
    c2.beginPath();
    if (o.kind === "sq" || o.kind === "rect") c2.rect(-o.w / 2, -o.h / 2, o.w, o.h);
    else c2.ellipse(0, 0, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
    c2.restore();
  }
  function placeObj() {
    if (st1.kind === "brush" || st1.kind === "drop") return;
    if (obj) commitObj();
    const k = st1.kind;
    const size = (k === "sq" ? st1.sq : (k === "ci" ? st1.ci : null));
    obj = { kind: k, cx: cv.width / 2, cy: cv.height / 2,
            w: Math.max(minPx(), size || st1.w), h: Math.max(minPx(), size || st1.h), rot: 0, phase: "place" };
    syncObjBtns(); drawAll();
    setState("图案放到画面中央了：先拖到位置 —— 松手后才出现缩放手柄；点画面空白 = 盖上");
  }
  function commitObj() {
    if (!obj) return;
    snapMask();
    obj.phase = "resize";
    objs.push(obj);
    obj = null; syncObjBtns(); drawAll();
    setState("已盖上（点它一下还能再改；↩ 撤回可退）");
  }
  function hitObj(p) {
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      const dx = p.x - o.cx, dy = p.y - o.cy;
      const c = Math.cos(-(o.rot || 0)), s = Math.sin(-(o.rot || 0));
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      if (Math.abs(lx) <= o.w / 2 && Math.abs(ly) <= o.h / 2) return i;
    }
    return -1;
  }
  function handlesOf(o) {
    const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
    const at = (lx, ly) => ({ x: o.cx + lx * c - ly * s, y: o.cy + lx * s + ly * c });
    return {
      scale: at(o.w / 2, o.h / 2),
      wOnly: at(o.w / 2, 0),
      hOnly: at(0, o.h / 2),
      rotate: at(0, -(o.h / 2 + cv.height / 18)),
      twoAxis: (o.kind === "rect" || o.kind === "ell"),
    };
  }
  function drawAll() {
    ov.width = ov.width;
    const drawOne = (o, active) => {
      octx.save();
      octx.globalAlpha = active ? 0.45 : 0.3;
      octx.fillStyle = st1.color;
      objPath(octx, o); octx.fill();
      octx.globalAlpha = 1;
      octx.strokeStyle = active ? "rgba(120,180,255,.95)" : "rgba(160,180,220,.55)";
      octx.lineWidth = Math.max(1.2, cv.width / 600);
      objPath(octx, o); octx.stroke();
      octx.restore();
      if (!active) return;
      const hd = handlesOf(o);
      const r = Math.max(6, cv.width / 70);
      octx.fillStyle = "#7c5cff"; octx.beginPath(); octx.arc(hd.scale.x, hd.scale.y, r, 0, Math.PI * 2); octx.fill();
      if (hd.twoAxis && o.phase === "resize") {
        octx.fillStyle = "#38bdf8"; octx.beginPath(); octx.arc(hd.wOnly.x, hd.wOnly.y, r, 0, Math.PI * 2); octx.fill();
        octx.fillStyle = "#4ade80"; octx.beginPath(); octx.arc(hd.hOnly.x, hd.hOnly.y, r, 0, Math.PI * 2); octx.fill();
      }
      if (o.phase === "resize") {
        octx.strokeStyle = "rgba(255,255,255,.85)";
        octx.beginPath(); octx.moveTo(o.cx, o.cy); octx.lineTo(hd.rotate.x, hd.rotate.y); octx.stroke();
        octx.fillStyle = "#ffcf5c";
        octx.beginPath(); octx.arc(hd.rotate.x, hd.rotate.y, r, 0, Math.PI * 2); octx.fill();
      }
      // ★ 273o（他第 2 条）：选中图形时，右上角就地给 ✓（盖上）/ ✕（取消）
      const br = Math.max(11, cv.width / 52);
      const c0 = Math.cos(o.rot || 0), s0 = Math.sin(o.rot || 0);
      const corner = { x: o.cx + (o.w / 2) * c0 - (-o.h / 2) * s0, y: o.cy + (o.w / 2) * s0 + (-o.h / 2) * c0 };
      const okBtn = { x: corner.x + br * 0.9, y: corner.y - br * 0.9 };
      const noBtn = { x: okBtn.x + br * 2.4, y: okBtn.y };
      hd.okBtn = okBtn; hd.noBtn = noBtn;
      octx.save();
      octx.lineWidth = Math.max(1.4, cv.width / 500);
      octx.font = "bold " + Math.round(br * 1.15) + "px system-ui, sans-serif";
      octx.textAlign = "center"; octx.textBaseline = "middle";
      octx.fillStyle = "rgba(34,197,94,.95)";
      octx.beginPath(); octx.arc(okBtn.x, okBtn.y, br, 0, Math.PI * 2); octx.fill();
      octx.fillStyle = "#fff"; octx.fillText("✓", okBtn.x, okBtn.y + 1);
      octx.fillStyle = "rgba(239,68,68,.95)";
      octx.beginPath(); octx.arc(noBtn.x, noBtn.y, br, 0, Math.PI * 2); octx.fill();
      octx.fillStyle = "#fff"; octx.fillText("✕", noBtn.x, noBtn.y + 1);
      octx.restore();
      o.handles = hd;
    };
    objs.forEach((o) => drawOne(o, false));
    if (obj) drawOne(obj, true);
    if (dragObj) {
      octx.save();
      octx.globalAlpha = 0.4;
      octx.fillStyle = st1.color;
      objPath(octx, dragObj); octx.fill();
      octx.globalAlpha = 1;
      octx.setLineDash([6, 4]);
      octx.strokeStyle = "rgba(120,180,255,.95)";
      objPath(octx, dragObj); octx.stroke();
      octx.restore();
    }
    syncObjBtns();
  }

  // ---------- 右侧模板框 ----------
  function tplSize() {
    const k = st1.kind;
    if (k === "sq") return { w: st1.sq, h: st1.sq };
    if (k === "ci") return { w: st1.ci, h: st1.ci };
    if (k === "rect" || k === "ell") return { w: st1.w, h: st1.h };
    return { w: st1.size, h: st1.size };
  }
  function drawTemplate() {
    const c2 = tpl.getContext("2d");
    c2.clearRect(0, 0, tpl.width, tpl.height);
    c2.fillStyle = "rgba(255,255,255,.04)";
    c2.fillRect(0, 0, tpl.width, tpl.height);
    const { w, h } = tplSize();
    const k = st1.kind;
    if (k === "brush") {
      c2.fillStyle = st1.color; c2.globalAlpha = 0.5;
      c2.beginPath(); c2.arc(tpl.width / 2, tpl.height / 2, Math.min(46, st1.size / 3), 0, Math.PI * 2); c2.fill();
      c2.globalAlpha = 1;
      return;
    }
    const pad = 10, maxW = tpl.width - pad * 2, maxH = tpl.height - pad * 2;
    const kk = Math.min(maxW / w, maxH / h);
    const dw = Math.max(6, w * kk), dh = Math.max(6, h * kk);
    c2.fillStyle = st1.color; c2.globalAlpha = 0.5;
    if (k === "sq" || k === "rect") c2.fillRect((tpl.width - dw) / 2, (tpl.height - dh) / 2, dw, dh);
    else { c2.beginPath(); c2.ellipse(tpl.width / 2, tpl.height / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2); c2.fill(); }
    c2.globalAlpha = 1;
    c2.strokeStyle = "rgba(150,162,180,.5)"; c2.lineWidth = 1;
    c2.strokeRect((tpl.width - dw) / 2, (tpl.height - dh) / 2, dw, dh);
  }
  // 在模板框里拖 = 直接调大小
  let tplDrag = false, tplStart = null;
  tpl.addEventListener("pointerdown", (e) => {
    tplDrag = true; tplStart = { x: e.clientX, y: e.clientY, w: tplSize().w, h: tplSize().h };
    try { tpl.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    e.preventDefault();
  });
  tpl.addEventListener("pointermove", (e) => {
    if (!tplDrag || !tplStart) return;
    const dx = e.clientX - tplStart.x, dy = e.clientY - tplStart.y;
    const k = st1.kind;
    const nw = Math.max(8, Math.round(tplStart.w + dx * 3));
    const nh = Math.max(8, Math.round(tplStart.h + dy * 3));
    if (k === "sq") st1.sq = Math.max(8, Math.round(nw));
    else if (k === "ci") st1.ci = Math.max(8, Math.round(nw));
    else { st1.w = nw; st1.h = nh; }
    saveSt(); drawTemplate();
    e.preventDefault();
  });
  const tplUp = () => { tplDrag = false; tplStart = null; };
  tpl.addEventListener("pointerup", tplUp);
  tpl.addEventListener("pointercancel", tplUp);

  // ---------- 画布交互 ----------
  function pos(e) {
    const r = ov.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (ov.width / Math.max(1, r.width)),
             y: (e.clientY - r.top) * (ov.height / Math.max(1, r.height)) };
  }
  function near(p, h) { return h && Math.hypot(p.x - h.x, p.y - h.y) < Math.max(14, ov.width / 45); }
  let dragMode = null, last = null, startPt = null;
  ov.addEventListener("pointerdown", (e) => {
    const p = pos(e);
    if (obj) {
      const hd = obj.handles || handlesOf(obj);
      const two = (obj.kind === "rect" || obj.kind === "ell") && obj.phase === "resize";
      if (near(p, hd.okBtn)) {
        commitObj();
        e.preventDefault();
        return;
      }
      if (near(p, hd.noBtn)) {
        obj = null;
        syncObjBtns(); drawAll();
        setState("已取消这个图案（没盖上去）");
        e.preventDefault();
        return;
      }
      if (near(p, hd.scale)) { dragMode = "scale"; }
      else if (two && near(p, hd.wOnly)) { dragMode = "wOnly"; }
      else if (two && near(p, hd.hOnly)) { dragMode = "hOnly"; }
      else if (obj.phase === "resize" && near(p, hd.rotate)) { dragMode = "rotate"; }
      else {
        // 点在图案里面 = 拖动
        const inside = (function () {
          const dx = p.x - obj.cx, dy = p.y - obj.cy;
          const c = Math.cos(-(obj.rot || 0)), s = Math.sin(-(obj.rot || 0));
          const lx = dx * c - dy * s, ly = dx * s + dy * c;
          return Math.abs(lx) <= obj.w / 2 && Math.abs(ly) <= obj.h / 2;
        })();
        dragMode = inside ? "move" : null;
      }
      if (dragMode) {
        last = p;
        try { ov.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        e.preventDefault();
        return;
      }
      // ★ 273n（他第 1 条）：点画面空白 = 直接视为盖上
      commitObj();
      e.preventDefault();
      return;
    }
    // 没有正在编辑的 → 点一下已落下的图形就把它捡回来继续改
    const hi = hitObj(p);
    if (hi >= 0) {
      obj = objs.splice(hi, 1)[0];
      obj.phase = "resize";
      syncObjBtns(); drawAll();
      setState("选中了这个图案：可拖动 / 拖紫点缩放 / 蓝色点只改宽、绿色点只改高 / 黄点旋转；点空白盖上");
      dragMode = "move"; last = p;
      try { ov.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
      return;
    }
    if (st1.kind === "drop") {
      snapMask();
      const ok = dropFill(p.x, p.y);
      drawAll(); setState(ok ? "吸管：这一块已经涂上" : "这里没找到同色块");
      e.preventDefault();
      return;
    }
    dragMode = "paint";
    snapMask();
    startPt = p; last = p;
    try { ov.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    if (st1.kind === "brush") {
      paintStyle(ctx);
      ctx.lineWidth = st1.size * (cv.width / Math.max(1, ov.clientWidth || cv.width));
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.01, p.y); ctx.stroke();
      drawAll();
    }
    setState("画着呢…");
    e.preventDefault();
  });
  ov.addEventListener("pointermove", (e) => {
    const p = pos(e);
    if (dragMode === "move" && obj) { obj.cx += p.x - last.x; obj.cy += p.y - last.y; last = p; drawAll(); e.preventDefault(); return; }
    if (dragMode === "scale" && obj) {
      const d = Math.hypot(p.x - obj.cx, p.y - obj.cy);
      const d0 = Math.hypot(last.x - obj.cx, last.y - obj.cy) || 1;
      const k = Math.max(0.15, d / d0);
      obj.w = Math.max(minPx(), obj.w * k); obj.h = Math.max(minPx(), obj.h * k);
      if (obj.kind === "sq" || obj.kind === "ci") obj.h = obj.w;
      last = p; drawAll(); e.preventDefault(); return;
    }
    if (dragMode === "wOnly" && obj) {          // ★ 273n：矩形/椭圆单独改宽
      const c = Math.cos(obj.rot || 0), s2 = Math.sin(obj.rot || 0);
      const dx = p.x - obj.cx, dy = p.y - obj.cy;
      obj.w = Math.max(minPx(), Math.abs(dx * c + dy * s2) * 2);
      drawAll(); e.preventDefault(); return;
    }
    if (dragMode === "hOnly" && obj) {          // ★ 273n：单独改高（椭圆=扁度）
      const c = Math.cos(obj.rot || 0), s2 = Math.sin(obj.rot || 0);
      const dx = p.x - obj.cx, dy = p.y - obj.cy;
      obj.h = Math.max(minPx(), Math.abs(-dx * s2 + dy * c) * 2);
      drawAll(); e.preventDefault(); return;
    }
    if (dragMode === "rotate" && obj) {
      obj.rot = Math.atan2(p.y - obj.cy, p.x - obj.cx) + Math.PI / 2;
      drawAll(); e.preventDefault(); return;
    }
    if (dragMode !== "paint") return;
    if (st1.kind === "brush") {
      paintStyle(ctx);
      ctx.lineWidth = st1.size * (cv.width / Math.max(1, ov.clientWidth || cv.width));
      ctx.beginPath(); ctx.moveTo((last || p).x, (last || p).y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; drawAll();
    } else if (startPt && st1.kind !== "drop") {
      // ★ 273n（他第 2 条）：拖着按住的时候，把"松手会出现的图案"实时画出来
      const k0 = st1.kind;
      const w0 = Math.abs(p.x - startPt.x), h0 = Math.abs(p.y - startPt.y);
      const side = Math.max(w0, h0, minPx());
      dragObj = { kind: k0, cx: (p.x + startPt.x) / 2, cy: (p.y + startPt.y) / 2,
                  w: (k0 === "sq" || k0 === "ci") ? side : Math.max(minPx(), w0),
                  h: (k0 === "sq" || k0 === "ci") ? side : Math.max(minPx(), h0), rot: 0 };
      drawAll();
    }
    e.preventDefault();
  });
  const endDrag = (e) => {
    if (dragMode === "paint" && dragObj) {
      // 松手 → 把刚才预览的那个图形变成"当前编辑对象"
      obj = dragObj;
      dragObj = null;
      obj.phase = "resize";
      obj.w = Math.max(minPx(), obj.w); obj.h = Math.max(minPx(), obj.h);
      syncObjBtns(); drawAll();
      setState("拖出来的图案：可以继续拖 / 拖紫点缩放；点画面空白 = 盖上");
    }
    // ★ 273m/273n：先拖到位置，拖完这一下才允许调大小
    if (obj && obj.phase === "place" && dragMode === "move") {
      obj.phase = "resize";
      setState("位置好了 → 现在可以拖右下角缩放、拖上面绿点旋转，满意点「✓ 盖上」");
      drawAll();
    }
    dragMode = null; last = null; startPt = null;
  };
  ov.addEventListener("pointerup", endDrag);
  ov.addEventListener("pointercancel", () => endDrag(null));
  ov.addEventListener("dblclick", (e) => {
    if (obj) return;
    snapMask();
    const p = pos(e);
    const ok = fillEnclosed(p.x, p.y);
    drawAll();
    setState(ok ? "已把这块闭口区域填满" : "这里没有围出闭口区域（或者已经在上面涂过）");
    e.preventDefault(); e.stopPropagation();
  });

  function dropFill(px0, py0) {
    const b = baseData();
    if (!b) return false;
    const w = cv.width, h = cv.height;
    const x0 = Math.round(px0), y0 = Math.round(py0);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;
    const i0 = (y0 * w + x0) * 4;
    const r0 = b.data[i0], g0 = b.data[i0 + 1], b0 = b.data[i0 + 2];
    const TOL = Math.max(5, parseInt(st1.tol, 10) || 34);   // ★ 273l：可调宽容度
    const seen = new Uint8Array(w * h), stack = [y0 * w + x0], pts = [];
    let guard = 0;
    while (stack.length && guard++ < w * h * 2) {
      const p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      const i = p * 4;
      const dr = b.data[i] - r0, dg = b.data[i + 1] - g0, db = b.data[i + 2] - b0;
      if (dr * dr + dg * dg + db * db > TOL * TOL) continue;
      pts.push(p);
      const x1 = p % w, y1 = (p - x1) / w;
      if (x1 > 0) stack.push(p - 1);
      if (x1 < w - 1) stack.push(p + 1);
      if (y1 > 0) stack.push(p - w);
      if (y1 < h - 1) stack.push(p + w);
    }
    if (!pts.length) return false;
    paintStyle(ctx);
    for (const p of pts) { const x1 = p % w, y1 = (p - x1) / w; ctx.fillRect(x1, y1, 1, 1); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    return true;
  }
  let baseCache = null;
  function baseData() {
    if (baseCache) return baseCache;
    try {
      const bc = document.createElement("canvas");
      bc.width = cv.width; bc.height = cv.height;
      const bctx = bc.getContext("2d");
      bctx.drawImage(base, 0, 0, cv.width, cv.height);
      baseCache = bctx.getImageData(0, 0, cv.width, cv.height);
      return baseCache;
    } catch (e) { return null; }
  }
  function fillEnclosed(px0, py0) {
    const w = cv.width, h = cv.height;
    let img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return false; }
    const d = img.data;
    const x0 = Math.round(px0), y0 = Math.round(py0);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;
    const p00 = y0 * w + x0;
    if (d[p00 * 4 + 3] > 8) { setState("这里已经涂过了"); return false; }
    const seen = new Uint8Array(w * h), stack = [p00], pts = [];
    let guard = 0;
    while (stack.length && guard++ < w * h * 2) {
      const p = stack.pop();
      if (seen[p]) continue;
      seen[p] = 1;
      if (d[p * 4 + 3] > 8) continue;
      pts.push(p);
      const x1 = p % w, y1 = (p - x1) / w;
      if (x1 > 0) stack.push(p - 1);
      if (x1 < w - 1) stack.push(p + 1);
      if (y1 > 0) stack.push(p - w);
      if (y1 < h - 1) stack.push(p + w);
    }
    if (!pts.length) return false;
    paintStyle(ctx);
    for (const p of pts) { const x1 = p % w, y1 = (p - x1) / w; ctx.fillRect(x1, y1, 1, 1); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    return true;
  }

  save.addEventListener("click", async () => {
    // ★ 383 批：素材模式下「保存」= 存图层记录 + 把底图+图层合成进蒙版（这样第 4 层能看到叠好的样子）
    if (mOn) {
      save.disabled = true;
      try { await mSaveAll(); } catch (e) { toast("保存失败：" + (e && e.message ? e.message : e), true); }
      finally { save.disabled = false; }
      try { closeMaskUI(); } catch (e2) { /* 忽略 */ }
      try { stOf(node).hasMask = { ...(stOf(node).hasMask || {}), [rel]: true }; } catch (e3) { /* 忽略 */ }
      try { render(node); } catch (e4) { /* 忽略 */ }
      return;
    }
    if (obj) commitObj();
    const out = document.createElement("canvas");
    out.width = cv.width; out.height = cv.height;
    const o = out.getContext("2d");
    o.fillStyle = "#000"; o.fillRect(0, 0, out.width, out.height);
    // ★ 273n：先把已落下的图形合成进去（它们不再烧在位图上）
    try {
      o.save(); o.globalAlpha = 1; o.fillStyle = "#ffffff";
      objs.concat(obj ? [obj] : []).forEach((oo) => { objPath(o, oo); o.fill(); });
      o.restore();
    } catch (e) { /* 忽略 */ }
    try {
      const src = ctx.getImageData(0, 0, out.width, out.height);
      const dst = o.getImageData(0, 0, out.width, out.height);
      const s = src.data, d = dst.data;
      for (let i = 0; i < s.length; i += 4) if (s[i + 3] > 8) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255; }
      o.putImageData(dst, 0, 0);
    } catch (err) { o.drawImage(cv, 0, 0); }
    let url = "";
    try { url = out.toDataURL("image/png"); } catch (err) { toast("导出蒙版失败：" + err.message, true); return; }
    save.disabled = true;
    try {
      await apiPost("/mask", { rel: rel, png: url });
      stackSet(rel, "");          // ★ 384：手涂的蒙版是最新一次修改 → 第 4 层回到「底图 + 红色」
      setState("已保存");
      toast("蒙版已保存 —— MASK 那根输出就是它；画廊里能看「第 4 层」了");
      stOf(node).hasMask = { ...(stOf(node).hasMask || {}), [rel]: true };
      closeMaskUI();
      render(node);
    } catch (e) {
      toast("保存蒙版失败：" + e.message, true);
    } finally { save.disabled = false; }
  });
}

  // ★ 273j（他第 9 条："涂好蒙版的新画面作为第四层显示在画廊上，第 4 层也会显示这是第 4 层"）
  function openMaskView(node, rel) {
    try {
      const root = node.__galRoot;
      const mv = root && root.querySelector(".gal-mask");
      if (!mv) return;
      const cv = mv.querySelector("canvas");
      const bar = mv.querySelector(".gal-mbar");
      const lay = bar && bar.querySelector(".gal-layer");
      if (lay) lay.textContent = "第 4 层 · 蒙版（白色=要重绘）";
      mv.classList.add("on");
      // ★ 384 批：这张图做过「叠图」就优先显示叠好的成品（他："优先展示最新修改的那一张"）
      const stkRel = stackRelOf(rel);
      if (stkRel) {
        if (lay) lay.textContent = "第 4 层 · 叠图（底图 + 素材）";
        const im = new Image();
        im.onload = () => {
          const W = Math.min(1200, im.naturalWidth || 960);
          const H = Math.round(W * ((im.naturalHeight || 640) / Math.max(1, im.naturalWidth || 960)));
          cv.width = W; cv.height = H;
          cv.style.cssText = "max-width:92vw;max-height:76vh;border-radius:8px;background:#111";
          const c0 = cv.getContext("2d");
          c0.drawImage(im, 0, 0, W, H);            // 不叠红色：叠图那块本来就是要重绘的，不用再标
        };
        im.onerror = () => { stackSet(rel, ""); openMaskView(node, rel); };   // 成品图没了就回退成蒙版
        im.src = imgUrl(stkRel) + "&t=" + Date.now();
        return;
      }
      const baseImg = new Image();
      const maskImg = new Image();
      let n = 0;
      const draw = () => {
        if (++n < 2) return;
        const W = Math.min(1200, baseImg.naturalWidth || 960);
        const H = Math.round(W * ((baseImg.naturalHeight || 640) / Math.max(1, baseImg.naturalWidth || 960)));
        cv.width = W; cv.height = H;
        cv.style.cssText = "max-width:92vw;max-height:76vh;border-radius:8px;background:#111";
        const c = cv.getContext("2d");
        c.drawImage(baseImg, 0, 0, W, H);
        // 蒙版染成红色、55% 透明叠上去
        const t = document.createElement("canvas");
        t.width = W; t.height = H;
        const tc = t.getContext("2d");
        tc.drawImage(maskImg, 0, 0, W, H);
        // ★ 273m（他第 4 条："第 4 层不显示第 3 层涂的内容"）：蒙版是黑底白块，整张不透明，
        //   直接 source-in 会把整块染红 → 先把亮度当 alpha
        try {
          const dd = tc.getImageData(0, 0, W, H);
          const a = dd.data;
          for (let i = 0; i < a.length; i += 4) {
            const v = Math.max(a[i], a[i + 1], a[i + 2]);
            a[i] = 255; a[i + 1] = 255; a[i + 2] = 255; a[i + 3] = v;
          }
          tc.putImageData(dd, 0, 0);
        } catch (e) { /* 忽略 */ }
        tc.globalCompositeOperation = "source-in";
        let tint = "#ff3b5c";
        try {
          const o2 = JSON.parse(localStorage.getItem("promptCopier.galMaskShape.v1") || "{}") || {};
          if (o2.color) tint = String(o2.color);
          if (!tint || tint.toLowerCase() === '#ffffff') tint = '#ff3b5c';   // ★ 273m：白色叠到图上等于没叠，默认用红色
        } catch (e) { /* 忽略 */ }
        tc.fillStyle = tint;
        tc.fillRect(0, 0, W, H);
        c.globalAlpha = 0.55;
        c.drawImage(t, 0, 0);
        c.globalAlpha = 1;
      };
      baseImg.onload = draw; maskImg.onload = draw;
      baseImg.src = imgUrl(rel);
      maskImg.src = API + "/mask?rel=" + encodeURIComponent(rel) + "&t=" + Date.now();   // ★ 273m：防缓存
    } catch (e) { /* 忽略 */ }
  }
  function maskFlag(node, rel, cb) {
    const s = stOf(node);
    s.hasMask = s.hasMask || {};
    if (typeof s.hasMask[rel] === "boolean") { if (cb) cb(s.hasMask[rel]); return; }
    fetch(API + "/mask?rel=" + encodeURIComponent(rel), { cache: "no-store" })
      .then((r) => {
        s.hasMask[rel] = r.ok && String(r.headers.get("content-type") || "").indexOf("image") >= 0;
      })
      .catch(() => { s.hasMask[rel] = false; })
      .then(() => { if (cb) cb(s.hasMask[rel]); });
  }

function stepZoom(node, dir) {
  const s = stOf(node);
  const list = zoomList(node);
  const i = list.findIndex((x) => x.rel === s.zoom);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  s.zoom = list[j].rel;
  setPicked(node, s.zoom);        // ★ 273e：翻页到哪张，输出就跟着换成哪张
  render(node);
}

// ---------------------------------------------------------------- 右键菜单
let menuEl = null;
function closeMenu() {
  if (menuEl) { try { menuEl.remove(); } catch (e) { /* 忽略 */ } menuEl = null; }
}
function openMenu(node, x, y, it, g) {
  closeMenu();
  const s = stOf(node);
  injectStyle();
  const m = el("div", "");
  m.className = "gal-menu";
  const add = (label, cls, fn) => {
    const d = el("div", "", label);
    d.className = "gal-mi" + (cls ? " " + cls : "");
    d.addEventListener("click", () => { closeMenu(); try { fn(); } catch (e) { log(e); } });
    m.appendChild(d);
  };
  const multi = !!(g && g.items.length > 1);
  if (multi) add("🗂 看这一组（" + g.items.length + " 张）", "", () => enterGroup(node, g));
  add(multi ? "🔍 放大这一张" : "🔍 放大看", "", () => openZoom(node, it.rel));
  add(multi ? ("⤓ 下载这一组（" + g.items.length + " 张）") : "⤓ 下载到电脑", "", () => {
    if (multi) g.items.forEach((x) => downloadOne(x)); else downloadOne(it);
  });
  if (s.page === "trash") {
    add(multi ? ("↩ 恢复这一组（" + g.items.length + " 张）") : "↩ 恢复这张", "", async () => {
      try {
        await apiPost("/restore", { rels: multi ? g.items.map((x) => x.rel) : [it.rel] });
        toast("已恢复");
        await loadPage(node, true);
      } catch (e) { toast("恢复失败：" + e.message, true); }
    });
    add(multi ? "🧨 彻底删掉这一组" : "🧨 彻底删掉", "danger", async () => {
      try {
        await apiPost("/purge", { rels: multi ? g.items.map((x) => x.rel) : [it.rel] });
        toast("已彻底删除");
        await loadPage(node, true);
      } catch (e) { toast("删除失败：" + e.message, true); }
    });
  } else {
    add((s.page === "fav" ? "♡ 取消收藏" : "♥ 收藏这张") + (multi ? "（整组）" : ""), "", () => {
      if (multi) toggleFavGroup(node, g); else toggleFav(node, it);
    });
    add(multi ? "☐ 勾上这一组" : "☐ 勾上（多选）", "", () => {
      if (multi) toggleSelGroup(node, g); else toggleSel(node, it.rel, true);
    });
    add("🗑 删除" + (multi ? "这一组" : "") + "（进回收站）", "danger", () => {
      if (multi) trashGroup(node, g); else trashOne(node, it);
    });
  }
  // ★ 240 批（他："请神上身做出来，然后右键图片除了请神上身以外，再加一个复制图片的功能"）
  m.appendChild(el("div", "height:1px;background:#2c333d;margin:4px 2px"));
  // ★ 273w：出图之后再改一轮 —— 把这张复制进「编辑栏」，直接在第三层打开
  add(s.page === "edit" ? "➕ 记住这张（已在编辑栏）" : "➕ 加到编辑栏（重绘 / 融图的素材）", "", () => toEditColumn(node, it));
  // ★ 364 批（他第 3 条）：素材栏 —— 存抠好的透明 PNG，叠图时用
  add(s.page === "material" ? "➕ 已经在素材栏里了" : "➕ 加到素材栏（透明 PNG 叠图用）", "", () => toMaterial(node, it));
  // ★ 241 批（他："请神上身改名为安全复现，括号里写请神上身"）
  add("🔮 安全复现（请神上身）", "", () => revealFromImage(node, it));
  // ★ 2026-11-04（他第 5 条）：「在请神上身的下面额外加一个选项，点击这个选项之后，就会让你输入名称，
  //   输完名称之后，就直接在工具端的暂无分类中新建一个按钮，正负提示词、图片所带的都有」
  add("➕ 存成工具端的按钮（正负提示词一起带过去）", "", () => saveAsToolButton(node, it));
  if (window.__pcReveal && window.__pcReveal.undo && window.__pcReveal.undo.length) {
    add("↩ 撤回安全复现（还原复现前的参数）", "", () => revealUndo());
  }
  add("📋 复制图片（可直接粘贴到聊天框）", "", () => copyImage(it, node));
  m.appendChild(el("div", "height:1px;background:#2c333d;margin:4px 2px"));
  add("📋 复制文件名", "", () => {
    try { navigator.clipboard.writeText(it.name || ""); toast("文件名已复制"); }
    catch (e) { toast("复制不了：" + e.message, true); }
  });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(window.innerWidth - r.width - 4, x)) + "px";
  m.style.top = Math.max(4, Math.min(window.innerHeight - r.height - 4, y)) + "px";
  m.style.display = "block";
  menuEl = m;
}
// 点哪儿都关菜单（只挂一次）
document.addEventListener("pointerdown", (e) => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
}, true);

// ---------------------------------------------------------------- 造面板
function buildPanel(node) {
  injectStyle();
  const s = stOf(node);
  const root = el("div", "");
  root.className = "pc-gal";

  const head = el("div", "");
  head.className = "gal-head";
  // ★ 273i：第一层也挂层号（彩色，不用灰字）
  const layer1 = el("span", "", "第 1 层");
  layer1.className = "gal-layer l1";
  head.appendChild(layer1);
  const mkTab = (page, label) => {
    const b = el("button", "", label);
    b.className = "gal-tab";
    b.setAttribute("data-galpage", page);
    b.appendChild(el("span", "", ""));
    b.lastChild.className = "gal-n";
    b.addEventListener("click", () => switchPage(node, page));
    return b;
  };
  head.appendChild(mkTab("home", "主页"));
  head.appendChild(mkTab("fav", "收藏"));
  head.appendChild(mkTab("trash", "回收站"));
  // ★ 273w（他第 2 条）：「局部重绘占用的快捷栏是收藏的快捷栏，建议单独再开一个栏…再来一个局部重绘栏
  //   ——但是不一定叫这个名字，毕竟还要管除了局部重绘以外，融图生成、叠图生成之类的」→ 就叫「编辑栏」
  head.appendChild(mkTab("edit", "编辑栏"));
  // ★ 364 批（他第 3 条："画廊多一栏素材栏"）→ 放抠好的透明 PNG，叠图用；来源 = 右键加到素材栏 / 编辑图片里裁素材
  head.appendChild(mkTab("material", "素材"));
  const sp = el("div", ""); sp.className = "gal-sp"; head.appendChild(sp);
  // ★ 238 批（他："第一层的图片究竟是分开放，还是单独放在一起乘二，这个小开关也放在右上角，
  //   和多选刷新存档位置放在一块"）→ 分组方式切换
  const bFlat = el("button", "", stOf(node).flat ? "▦ 平铺中" : "🗂 按组");
  bFlat.className = "gal-mini" + (stOf(node).flat ? " on" : "");
  bFlat.title = stOf(node).flat ? "现在：一次生成的几张各占一格（点一下改成按组）" : "现在：一次生成的几张合成一格、标 ×N（点一下改成平铺）";
  bFlat.addEventListener("click", () => {
    const s0 = stOf(node);
    s0.flat = !s0.flat;
    s0.level = 1; s0.groupKey = null;
    bFlat.textContent = s0.flat ? "▦ 平铺中" : "🗂 按组";
    bFlat.classList.toggle("on", s0.flat);
    bFlat.title = s0.flat ? "现在：一次生成的几张各占一格（点一下改成按组）" : "现在：一次生成的几张合成一格、标 ×N（点一下改成平铺）";
    saveGal(node);                      // ★ 273 批：刷新 / 重进工作流不再重置成「按组」
    render(node);
  });
  head.appendChild(bFlat);
  const bMulti = el("button", "", "☐ 多选");
  bMulti.className = "gal-mini";
  bMulti.addEventListener("click", () => {
    s.multi = !s.multi;
    if (!s.multi) s.sel.clear();
    bMulti.classList.toggle("on", s.multi);
    render(node);
  });
  head.appendChild(bMulti);
  const bRef = el("button", "", "🔄 刷新");
  bRef.className = "gal-mini";
  bRef.addEventListener("click", () => loadPage(node, true));
  head.appendChild(bRef);
  // ★ 273 批（他 272 批第 4 条："设置取代存档位置的位置，然后设置里面信息写存档位置"）
  const bSet = el("button", "", "⚙ 设置");
  bSet.className = "gal-mini";
  bSet.dataset.galset = "1";
  bSet.title = "画廊设置：存档位置 / 上限说明 / 占满全屏的快捷键";
  head.appendChild(bSet);
  root.appendChild(head);

  // —— 设置面板（盖在画廊上；点「关闭」回列表）
  const setBox = el("div", "");
  setBox.className = "gal-set";
  setBox.style.cssText = "position:absolute;left:0;right:0;top:0;bottom:0;z-index:60;display:none;"
    + "background:rgba(14,16,22,.95);color:#e8eaf1;padding:12px 14px;overflow:auto;"
    + "font-size:11.5px;line-height:1.7";
  root.appendChild(setBox);
  const setBtnCss = "font:inherit;font-size:11px;padding:3px 9px;border-radius:7px;cursor:pointer;"
    + "border:1px solid rgba(150,162,180,.5);background:rgba(255,255,255,.06);color:#e8eaf1";
  function renderSetBox() {
    const s2 = stOf(node);
    const cnt = s2.counts || {};
    const lim = s2.limits || { home: 500, trash: 100 };
    setBox.innerHTML = "";
    const mk = (tag, text, css) => {
      const d = document.createElement(tag);
      if (text) d.textContent = text;
      if (css) d.style.cssText = css;
      setBox.appendChild(d);
      return d;
    };
    mk("div", "⚙ 画廊设置", "font-weight:700;font-size:13px;margin-bottom:8px");
    mk("div", "1. 存档位置（手动往「下载 / 收藏 / 回收站」里放图也行）", "opacity:.75");
    const p = mk("div", s2.root || "（还没读到，先点一下右上角「🔄 刷新」）",
      "user-select:text;word-break:break-all;background:rgba(255,255,255,.06);"
      + "border:1px solid rgba(150,162,180,.35);border-radius:7px;padding:5px 8px;"
      + "font-family:Consolas,monospace;font-size:11px");
    p.dataset.galroot = "1";
    const cp = document.createElement("button");
    cp.type = "button"; cp.textContent = "📋 复制路径"; cp.style.cssText = setBtnCss + ";margin-top:6px";
    cp.addEventListener("click", () => {
      try { navigator.clipboard.writeText(s2.root || ""); toast("路径已复制"); }
      catch (e) { toast("复制失败，手动选中上面那行吧", true); }
    });
    setBox.appendChild(cp);
    mk("div", "2. 存档上限：主页 " + (cnt.home != null ? cnt.home : "?") + " / " + lim.home
      + "　·　回收站 " + (cnt.trash != null ? cnt.trash : "?") + " / " + lim.trash, "margin-top:12px");
    mk("div", "超过上限会自动删掉最旧的那几张（真的会删，不是只提醒）—— 想长期留就点收藏：收藏的图不动，也不占主页名额。",
      "opacity:.7;font-size:11px");
    mk("div", "3. 占满全屏", "margin-top:12px;font-weight:700");
    mk("div", "和黑箱一样：上 3 / 左 1.5 / 下 1.5 / 右 8cm。按快捷键切换「占满 / 还原」。",
      "opacity:.7;font-size:11px");
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap";
    setBox.appendChild(row);
    const now = document.createElement("span");
    now.textContent = "当前键：" + galKeyLabel(s2.galKey || "f");
    now.style.cssText = "opacity:.9";
    row.appendChild(now);
    const bChange = document.createElement("button");
    bChange.type = "button"; bChange.textContent = "改键"; bChange.style.cssText = setBtnCss;
    bChange.addEventListener("click", () => { galKeyWait = node; now.textContent = "现在按一个键…"; });
    row.appendChild(bChange);
    const bReset = document.createElement("button");
    bReset.type = "button"; bReset.textContent = "恢复 F"; bReset.style.cssText = setBtnCss;
    bReset.addEventListener("click", () => {
      const s3 = stOf(node); s3.galKey = "f"; saveGal(node); renderSetBox(); toast("快捷键恢复成 F");
    });
    row.appendChild(bReset);
    const bFit = document.createElement("button");
    bFit.type = "button"; bFit.textContent = node.__galFit ? "↺ 还原" : "⛶ 现在占满";
    bFit.style.cssText = setBtnCss;
    bFit.addEventListener("click", () => {
      if (node.__galFit) galRestoreView(node); else galFit(node);
      renderSetBox();
    });
    row.appendChild(bFit);
    // ★ 273j（他第 10 条）：新增一项「自动忽略第二层」
    mk("div", "4. 自动忽略第二层", "margin-top:12px;font-weight:700");
    mk("div", "勾上以后：平时点图直接进第三层（单张放大）；只有「一次生成出多张、自动回第二层」或「按组模式下点那一组」才进第二层。",
      "opacity:.7;font-size:11px");
    const skipRow = document.createElement("label");
    skipRow.style.cssText = "display:flex;align-items:center;gap:7px;margin-top:6px;cursor:pointer";
    const skipCk = document.createElement("input");
    skipCk.type = "checkbox"; skipCk.checked = !!stOf(node).autoSkip2; skipCk.style.cssText = "accent-color:#7c5cff";
    skipCk.addEventListener("change", () => {
      const s3 = stOf(node); s3.autoSkip2 = !!skipCk.checked; saveGal(node);
      toast(skipCk.checked ? "已开启：平时直接进第三层" : "已关闭：点图先进第二层");
    });
    skipRow.appendChild(skipCk);
    skipRow.appendChild(document.createTextNode("平时跳过第二层，直接看单张"));
    setBox.appendChild(skipRow);
    // ★ 273k（他第 3 条）：角落里的小三角可以关
    mk("div", "5. 角落小三角（标出这张是文生图还是局部重绘）", "margin-top:12px;font-weight:700");
    mk("div", "蓝三角 = 文生图出的，橙三角 = 局部重绘出的 —— 请神的时候一眼就能看出该用哪条工作流。", "opacity:.7;font-size:11px");
    const kindRow = document.createElement("label");
    kindRow.style.cssText = "display:flex;align-items:center;gap:7px;margin-top:6px;cursor:pointer";
    const kindCk = document.createElement("input");
    kindCk.type = "checkbox"; kindCk.checked = stOf(node).showKind !== false; kindCk.style.cssText = "accent-color:#7c5cff";
    kindCk.addEventListener("change", () => {
      const s3 = stOf(node); s3.showKind = !!kindCk.checked; saveGal(node); render(node);
      toast(kindCk.checked ? "已显示角落小三角" : "已隐藏角落小三角");
    });
    kindRow.appendChild(kindCk);
    kindRow.appendChild(document.createTextNode("在每张图左下角显示颜色三角"));
    setBox.appendChild(kindRow);
    // ★ 274：局部重绘（自动裁切放大 + 贴回）—— 他要"不要给工作流、并入画廊、自动裁切"
    mk("div", "6. 局部重绘：自动裁切放大", "margin-top:12px;font-weight:700");
    mk("div", "涂完蒙版直接生成就行：涂抹那一块会自动裁出来、放大到够像素，重绘完再按原坐标贴回整张图"
      + "（边缘做了羽化，不会有方块边）。不用另接工作流、也不用多连一根线。", "opacity:.7;font-size:11px");
    const cr0 = galCropOf(node);
    const crRow = document.createElement("div");
    crRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap";
    setBox.appendChild(crRow);
    const cSel = document.createElement("select");
    cSel.style.cssText = "font:inherit;font-size:11px;padding:2px 6px;border-radius:6px;"
      + "background:rgba(255,255,255,.08);color:#e8eaf1;border:1px solid rgba(150,162,180,.45)";
    [["auto", "自动（涂得少才放大）"], ["always", "总是放大"], ["off", "关掉（原图直接重绘）"]].forEach((pair) => {
      const o = document.createElement("option");
      o.value = pair[0]; o.textContent = pair[1];
      if (cr0.mode === pair[0]) o.selected = true;
      cSel.appendChild(o);
    });
    crRow.appendChild(cSel);
    const mkNum = (label, val, lo, hi) => {
      const sp = document.createElement("span");
      sp.style.cssText = "display:flex;align-items:center;gap:4px";
      sp.appendChild(document.createTextNode(label));
      const inp = document.createElement("input");
      inp.type = "number"; inp.value = String(val); inp.min = String(lo); inp.max = String(hi); inp.step = "8";
      inp.style.cssText = "width:66px;font:inherit;font-size:11px;padding:2px 5px;border-radius:6px;"
        + "background:rgba(255,255,255,.08);color:#e8eaf1;border:1px solid rgba(150,162,180,.45)";
      sp.appendChild(inp);
      crRow.appendChild(sp);
      return inp;
    };
    const cPad = mkNum("余量 %", Math.round(cr0.pad * 100), 0, 150);
    const cTar = mkNum("放大到短边", cr0.target, 512, 1536);
    // ★ 283 批（他："羽化 / 膨胀做成两个数字，用于调整"）
    const cFea = mkNum("羽化 px", cr0.feather || 0, 0, 200);
    const cExp = mkNum("膨胀 px", cr0.expand || 0, 0, 200);
    const applyCrop = (tip) => {
      const s3 = stOf(node);
      s3.crop = {
        mode: cSel.value,
        pad: Math.max(0, Math.min(150, parseInt(cPad.value, 10) || 0)),
        target: Math.max(512, Math.min(1536, parseInt(cTar.value, 10) || 1024)),
        feather: Math.max(0, Math.min(200, parseInt(cFea.value, 10) || 0)),
        expand: Math.max(0, Math.min(200, parseInt(cExp.value, 10) || 0)),
      };
      saveGal(node); syncCropWidget(node); toast(tip);
    };
    cSel.addEventListener("change", () => applyCrop("局部重绘：" + (cSel.value === "off" ? "关掉了（原图直接重绘）"
      : cSel.value === "always" ? "总是放大" : "自动（涂得少才放大）")));
    cPad.addEventListener("change", () => applyCrop("余量改成 " + cPad.value + "%"));
    cTar.addEventListener("change", () => applyCrop("放大到短边 " + cTar.value));
    cFea.addEventListener("change", () => applyCrop("羽化 " + cFea.value + "px（贴回边缘的软硬）"));
    cExp.addEventListener("change", () => applyCrop("膨胀 " + cExp.value + "px（蒙版先长这么一圈）"));
    mk("div", "「自动」的判据：涂抹区域的短边 < 放大目标的一半时才裁。涂得大时本来就够像素，裁了反而慢、还容易改到不该动的地方。",
      "opacity:.6;font-size:10.5px;margin-top:4px");

    // ★ 291 批（他第 5 条）：勾上以后「复制图片」会顺便收藏
    mk("div", "7. 复制时顺手收藏", "margin-top:12px;font-weight:700");
    mk("div", "勾上以后：右键「复制图片」（复制到剪贴板）会**顺手把这张加入收藏** —— 收藏是搬家，所以它会从主页挪到收藏夹。",
      "opacity:.7;font-size:11px");
    const favRow = document.createElement("label");
    favRow.style.cssText = "display:flex;align-items:center;gap:7px;margin-top:6px;cursor:pointer";
    const favCk = document.createElement("input");
    favCk.type = "checkbox";
    favCk.dataset.pcfavcopy = "1";
    favCk.checked = !!stOf(node).favOnCopy;
    favCk.style.cssText = "accent-color:#7c5cff";
    favCk.addEventListener("change", () => {
      const s4 = stOf(node); s4.favOnCopy = !!favCk.checked; saveGal(node);
      toast(favCk.checked ? "已开启：复制图片时顺手收藏" : "已关闭：复制图片不再自动收藏");
    });
    favRow.appendChild(favCk);
    favRow.appendChild(document.createTextNode("复制图片时，顺手把这张加进收藏"));
    setBox.appendChild(favRow);

    const bClose = document.createElement("button");
    bClose.type = "button"; bClose.textContent = "关闭"; bClose.style.cssText = setBtnCss + ";margin-top:12px";
    bClose.addEventListener("click", () => { setBox.style.display = "none"; });
    setBox.appendChild(bClose);
  }
  bSet.addEventListener("click", () => {
    if (setBox.style.display === "block") { setBox.style.display = "none"; return; }
    renderSetBox();
    setBox.style.display = "block";
  });
  node.__galSetRefresh = renderSetBox;      // ★ 273b：改成空格这类要当场刷新面板里的"当前键"
  ensureGalKey();

  const body = el("div", "");
  body.className = "gal-body";
  const grid = el("div", "");
  grid.className = "gal-grid";
  body.appendChild(grid);
  body.addEventListener("scroll", () => {
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 40) {
      const st = stOf(node);
      if (!st.loading && st.items.length < st.total) loadPage(node, false);
    }
  });
  root.appendChild(body);

  const foot = el("div", "");
  foot.className = "gal-foot";
  root.appendChild(foot);

  // ★ 237 批：第二层（这一组并排看）—— 内容由 render → paintGroup 每次重建
  const group = el("div", "");
  group.className = "gal-group";
  root.appendChild(group);

  // 放大层
  const zoom = el("div", "");
  zoom.className = "gal-zoom";
  const zbar = el("div", "");
  zbar.className = "gal-zbar";
  const zn = el("div", "");
  zn.className = "gal-zname";
  zbar.appendChild(zn);
  const zsp = el("div", ""); zsp.style.cssText = "flex:1 1 auto"; zbar.appendChild(zsp);
  // ★ 273h：两个输出口都连上才出来；★ 364 批（他："「在遮罩编辑器中打开」改个更通俗的名字，因为这颗键
  //   马上还要管别的功能"）→ 改名「编辑图片」，蒙版的解释挪到悬停提示里。
  const zMask = el("button", "", "🖌 编辑图片");
  zMask.className = "gal-mini";
  zMask.style.display = "none";
  zMask.title = "在图上涂哪儿要重绘（白色 = 重绘）；原图不动，蒙版另存一张。以后裁素材也走这儿";
  zMask.addEventListener("click", (e) => {
    e.stopPropagation();
    const rel = stOf(node).zoom;
    if (!rel) return;
    // ★ 273w（他第 2 条前半）：**点了「在遮罩编辑器里打开」才算**用过 → 自动复制一份进「编辑栏」留历史
    apiPost("/toedit", { rel: rel }).catch(() => {});
    openMaskUI(node, rel);
  });
  zbar.appendChild(zMask);
  node.__galMaskBtn = zMask;
  const zM4 = el("button", "", "👁 第 4 层（蒙版）");
  zM4.className = "gal-mini";
  zM4.style.display = "none";
  zM4.title = "看第 4 层（取最新那次修改：手涂蒙版 = 红；叠图 = 直接看叠好的成品）";
  zM4.addEventListener("click", (e) => {
    e.stopPropagation();
    const r0 = stOf(node).zoom;
    if (r0) openMaskView(node, r0);
  });
  zbar.appendChild(zM4);
  node.__galMask4Btn = zM4;
  // ★ 273n（他第 6 条）：第三层也能请神（原来只有右键）
  const zGod = el("button", "", "🔮 请神");
  zGod.className = "gal-mini";
  zGod.title = "读这张图的元数据，把参数 / 提示词 / LoRA 填回当前画布";
  zGod.addEventListener("click", (e) => {
    e.stopPropagation();
    const rel = stOf(node).zoom;
    const it = rel ? (stOf(node).items.filter((x) => x.rel === rel)[0] || { rel: rel, name: "" }) : null;
    if (it) revealFromImage(node, it);
  });
  zbar.appendChild(zGod);
  node.__galGodBtn = zGod;
  const zClose = el("button", "", "✕ 关");
  zClose.className = "gal-mini";
  zClose.addEventListener("click", () => { stOf(node).zoom = null; render(node); });
  zbar.appendChild(zClose);
  zoom.appendChild(zbar);
  const zi = el("img", "");
  zi.draggable = false;
  zoom.appendChild(zi);
  const zL = el("div", "", "‹");
  zL.className = "gal-zarrow l";
  zL.addEventListener("click", (e) => { e.stopPropagation(); stepZoom(node, -1); });
  const zR = el("div", "", "›");
  zR.className = "gal-zarrow r";
  zR.addEventListener("click", (e) => { e.stopPropagation(); stepZoom(node, 1); });
  zoom.appendChild(zL); zoom.appendChild(zR);
  zoom.addEventListener("click", (e) => {
    if (e.target === zoom) { stOf(node).zoom = null; render(node); }
  });
  root.appendChild(zoom);
  // ★ 273j：第 4 层（蒙版预览）
  const maskView = el("div", "");
  maskView.className = "gal-mask";
  const mbar = el("div", ""); mbar.className = "gal-mbar";
  const mlay = el("span", "第 4 层 · 蒙版"); mlay.className = "gal-layer l4";
  mbar.appendChild(mlay);
  const msp = el("div", ""); msp.style.cssText = "flex:1 1 auto"; mbar.appendChild(msp);
  // ★ 273n（他第 6 条）：第 4 层没法右键，给一颗明确的请神键
  const mGod = el("button", "", "🔮 请神");
  mGod.className = "gal-mini";
  mGod.title = "读这张图的元数据，把参数 / 提示词 / LoRA 填回当前画布";
  mGod.addEventListener("click", () => {
    const rel = stOf(node).zoom;
    const it = rel ? (stOf(node).items.filter((x) => x.rel === rel)[0] || { rel: rel, name: "" }) : null;
    if (it) revealFromImage(node, it);
  });
  mbar.appendChild(mGod);
  // ★ 273x（他第 1 条："从第四层点关闭会直接回到第二层，这点关闭肯定是退到第三层啊"）
  //   真因：这颗 ✕ 连 zoom 一起清了 → 底下那层「第二层（这一组并排）」就露出来了。
  //   第 4 层只是盖在第 3 层上面的一层，关它只该掀开它自己，zoom 一个字节都别动。
  //   顺手去掉原来那颗「↩ 回第 3 层」—— 跟 ✕ 是同一个去处，留一颗就够。
  const mClose = el("button", "", "✕ 关"); mClose.className = "gal-mini";
  mClose.title = "关掉蒙版层，回到第 3 层（放大看的那张）";
  mClose.addEventListener("click", () => { maskView.classList.remove("on"); });
  mbar.appendChild(mClose);
  maskView.appendChild(mbar);
  const mcv = document.createElement("canvas"); mcv.width = 640; mcv.height = 480;
  maskView.appendChild(mcv);
  maskView.addEventListener("click", (e) => { if (e.target === maskView) maskView.classList.remove("on"); });
  root.appendChild(maskView);

  // ★ 291：哪颗画廊最后被点过 —— 快捷键命中多颗时按这个挑（"指哪个放大哪个"）
  try { root.addEventListener("pointerdown", () => { node.__galTouchedAt = Date.now(); }, true); } catch (eT) { /* 忽略 */ }
  node.__galRoot = root;
  node.__galBody = body;
  return root;
}

// ★ 210 批那个坑的同一套修法：前端会在点击/聚焦后拿它自己记的过时 widget.width 重设元素宽度
function pinWidgetWidth(node, widget) {
  try {
    if (!widget || !widget.element || node.__pcWidthPinned) return;
    node.__pcWidthPinned = true;
    const elm = widget.element;
    const want = () => Math.max(260, (node.size ? node.size[0] : DEF_W) - 20);
    try {
      Object.defineProperty(widget, "width", { get: want, set() { /* 不采纳 */ }, configurable: true });
    } catch (e) { /* 忽略 */ }
    const apply = () => { try { elm.style.width = want() + "px"; } catch (e) { /* 忽略 */ } };
    apply();
    if (window.ResizeObserver) {
      let lastNode = -1;
      node.__pcWidthRO = new ResizeObserver(() => {
        const nw = node.size ? node.size[0] : 0;
        if (!nw) return;
        if (nw !== lastNode) { lastNode = nw; apply(); return; }
        if (Math.abs(elm.offsetWidth - want()) > 8) apply();
      });
      node.__pcWidthRO.observe(elm);
    }
    const prevResize = node.onResize;
    node.onResize = function () {
      const r = prevResize ? prevResize.apply(this, arguments) : undefined;
      apply();
      const h = node.size ? node.size[1] : 0;
      if (h && elm) elm.style.height = Math.max(120, h - 34) + "px";
      return r;
    };
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------------------------
// ★ 273b 批（他："画廊的分组平铺会被重置的问题还是没解决"）
//   真因：attachGallery 在 **onNodeCreated** 就跑，那时 properties 还是空的 → stOf 已经按默认
//   flat=false 缓存进 WeakMap；之后 configure 把 properties 塞进来，却没人再读一遍。
//   → 提供一个"从 properties 重新对一遍"的函数，onConfigure 里调；顺便把按钮文字也跟着改。
function syncGalProps(node) {
  try {
    const s = ST.get(node);
    if (!s) return false;
    const pr = node && node.properties && node.properties.pcGal;
    if (!pr || typeof pr !== "object") return false;
    if (pr.flat === true || pr.flat === false) s.flat = pr.flat;
    if (pr.page === "home" || pr.page === "fav" || pr.page === "trash") s.page = pr.page;
    if (typeof pr.key === "string" && pr.key) s.galKey = pr.key;
    const root = node.__galRoot;
    if (root) {
      const b = [...root.querySelectorAll(".gal-mini")].filter((x) => /按组|平铺/.test(x.textContent))[0];
      if (b) {
        b.textContent = s.flat ? "▦ 平铺中" : "🗂 按组";
        b.classList.toggle("on", !!s.flat);
        b.title = s.flat ? "现在：一次生成的几张各占一格（点一下改成按组）" : "现在：一次生成的几张合成一格、标 ×N（点一下改成按组）";
      }
    }
    return true;
  } catch (e) { return false; }
}

function attachGallery(node) {
  if (node.__galAttached) return;
  node.__galAttached = true;
  injectStyle();
  const root = buildPanel(node);
  let widget = null;
  try {
    widget = node.addDOMWidget("pcGallery", "pcGallery", root, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => "",
      setValue: () => {},
    });
  } catch (e) {
    log("addDOMWidget 失败", e);
    return;
  }
  node.setSize([Math.max(node.size ? node.size[0] : 0, DEF_W), Math.max(node.size ? node.size[1] : 0, DEF_H)]);
  try {
    root.style.height = Math.max(120, (node.size ? node.size[1] : DEF_H) - 34) + "px";
  } catch (e) { /* 忽略 */ }
  pinWidgetWidth(node, widget);
  // ★ 273g 批（他："连接点搞特殊一些"）—— 两个输出口手动上色，跟普通 IMAGE / MASK 口区分开
  try {
    const outs = node.outputs || [];
    if (outs[0]) { outs[0].color_on = "#7c5cff"; outs[0].color_off = "#4a3aa8"; }
    if (outs[1]) { outs[1].color_on = "#38bdf8"; outs[1].color_off = "#1e6f96"; }
  } catch (e) { /* 忽略 */ }
  // ★ 273e：把「选中的图」那个控件藏起来（他用不到，是前端跟后端之间的暗号）
  try {
    const w = pickedWidget(node);
    if (w) {
      w.hidden = true;
      w.computeSize = function () { return [0, -4]; };
    }
  } catch (e) { /* 忽略 */ }
  // ★ 274：「局部重绘」「裁切记录」也是暗号（面板 → 后端），一样藏起来；顺手把设置写进去
  try {
    ["局部重绘", "裁切记录"].forEach((nm) => {
      const cw = (node.widgets || []).find((x) => x && x.name === nm);
      if (cw) { cw.hidden = true; cw.computeSize = function () { return [0, -4]; }; }
    });
    syncCropWidget(node);
  } catch (e) { /* 忽略 */ }
  // 出一张就刷新
  const prevExec = node.onExecuted;
  node.onExecuted = function (message) {
    const r = prevExec ? prevExec.apply(this, arguments) : undefined;
    try {
      const got = message && message.pc_gallery;
      if (got && got.length) log("新图 " + got.length + " 张：" + got.join(", "));
      const st0 = stOf(node);
      // ★ 273 批（他 272 批第 6 条："画廊在第三层的时候，这时候新生成图片，肯定要切回新生成图片的第二层"）
      //   以前这里三条判断把路全堵死了：只在主页才跳、新组必须 >1 张、而且没清 zoom（画面还停在放大那张）。
      //   现在：先确保回到主页 → 拉一次列表 → 不管当时在第几层、几张，统一落到"新生成那一组的第二层"。
      if (st0.page !== "home") { st0.page = "home"; st0.offset = 0; st0.items = []; saveGal(node); }
      loadPage(node, true).then(() => {
        try {
          if (!got || !got.length) return;
          // ★ 273b（他："画廊生图之后展示的应该是第二层组图，而不是第三层单图"）
          //   以前用 groupOf(items, flat) 找组 —— **平铺模式下每张自己一组**，于是"第二层"只剩这一张，
          //   看着就跟第三层单图一样。现在按 batch 认组（不看平铺开关），一次出的几张永远并排。
          const rel0 = got[0];
          const it0 = st0.items.filter((x) => x.rel === rel0)[0] || null;
          const key0 = it0 ? (it0.batch || ("one:" + it0.rel)) : null;
          st0.zoom = null;                                  // 第三层（放大）必须退出来
          if (key0) { st0.level = 2; st0.groupKey = key0; }
          else { st0.level = 1; st0.groupKey = null; }
          render(node);
        } catch (e3) { log("自动进组失败", e3); }
      });
    } catch (e) { log("执行完刷新失败", e); }
    return r;
  };
  // 一建好就去拉列表（图在磁盘上，开关 ComfyUI 不会丢）
  setTimeout(() => loadPage(node, true), 120);
}

// 右键菜单上「存档位置」这类需要节点上下文的地方，用全局钩子接（探针也走这里）
window.__pcGallery = {
  open: (node) => { try { loadPage(node, true); return true; } catch (e) { return false; } },
  state: (node) => {
    const s = stOf(node);
    return { page: s.page, total: s.total, shown: s.items.length, multi: s.multi,
             sel: [...s.sel], root: s.root, counts: s.counts, zoom: s.zoom, err: s.err || null,
             level: s.level, groupKey: s.groupKey,
             limits: s.limits };
  },
  items: (node) => stOf(node).items.map((x) => ({ rel: x.rel, name: x.name, day: x.day, url: x.url, batch: x.batch || "" })),
  page: (node, p) => { switchPage(node, p); return stOf(node).page; },
  // ★ 237 批：三层导航（主页 → 这一组 → 单张）的自测口
  groups: (node) => groupOf(stOf(node).items, stOf(node).flat).map((g) => ({ key: g.key, n: g.items.length, batch: g.batch || "" })),
  level: (node) => stOf(node).level,
  flat: (node) => stOf(node).flat,
  setFlat: (node, on) => {
    const b = [...(node.__galRoot || document).querySelectorAll(".gal-mini")].filter((x) => /按组|平铺/.test(x.textContent))[0];
    if (b && (stOf(node).flat !== !!on)) b.click();
    return stOf(node).flat;
  },
  enterGroup: (node, i) => {
    const g = groupOf(stOf(node).items, stOf(node).flat)[i];
    if (!g) return false;
    enterGroup(node, g);
    return true;
  },
  groupOpen: (node) => {
    const gp = node.__galRoot && node.__galRoot.querySelector(".gal-group");
    return !!(gp && gp.classList.contains("on"));
  },
  groupCells: (node) => (node.__galRoot ? node.__galRoot.querySelectorAll(".gal-group .gal-gitem").length : -1),
  closeGroup: (node) => {
    const x = node.__galRoot && node.__galRoot.querySelector(".gal-group .gal-gclose");
    if (x) x.click();
    return !!x;
  },
  clickGroupItem: (node, i) => {
    const it = node.__galRoot && node.__galRoot.querySelectorAll(".gal-group .gal-gitem")[i];
    if (!it) return false;
    it.querySelector("img").click();
    return true;
  },
  marks: (node, i) => {
    const cell = node.__galRoot && node.__galRoot.querySelectorAll(".gal-cell")[i];
    if (!cell) return [];
    return [...cell.querySelectorAll(".gal-mk")].map((x) => x.textContent);
  },
  cellCount: (node) => (node.__galRoot ? node.__galRoot.querySelectorAll(".gal-cell").length : -1),
  // ★ 256 批：批量收藏 + 当前列表（自测用）
  favMany: (node) => favMany(node),
  items: (node) => stOf(node).items,
  selCount: (node) => stOf(node).sel.size,
  enterMulti: (node, on) => { const s = stOf(node); s.multi = !!on; if (!on) s.sel.clear(); render(node); return true; },
  check: (node, rel) => { const s = stOf(node); s.multi = true; if (s.sel.has(rel)) s.sel.delete(rel); else s.sel.add(rel); render(node); return true; },
  // ★ 240 批：请神上身 / 复制图片 的自测口
  reveal: (node, i) => { const it = stOf(node).items[i]; if (!it) return Promise.resolve(false); return revealFromImage(node, it); },
  revealParse: (meta) => revealParse(meta),
  revealApply: (parsed) => { const r = revealApply(parsed); window.__pcReveal = window.__pcReveal || {}; window.__pcReveal.undo = (window.__pcReveal.undo || []).concat(r.undo || []); return r; },
  revealUndo: () => revealUndo(),
  copyImage: (node, i) => { const it = stOf(node).items[i]; if (!it) return Promise.resolve(false); return copyImage(it, node); },
  meta: (rel) => apiGet("/meta", { rel: rel }),
  menuHas: (label) => [...(menuEl ? menuEl.querySelectorAll(".gal-mi") : [])].filter((x) => new RegExp(label).test(x.textContent)).length,
  tab: (node, p) => {
    const r = node.__galRoot && node.__galRoot.querySelector('[data-galpage="' + p + '"]');
    if (r) r.click();
    return !!r;
  },
  fav: (node, rel, on) => apiPost("/fav", { rel: rel, on: !!on }),
  trash: (node, rels) => apiPost("/trash", { rels: rels }),
  restore: (node, rels) => apiPost("/restore", { rels: rels }),
  purge: (node, rels) => apiPost("/purge", { rels: rels }),
  info: () => apiGet("/info"),
  zoomAt: (node, i) => { const s = stOf(node); if (s.items[i]) { openZoom(node, s.items[i].rel); return true; } return false; },
  zoomed: (node) => {
    const z = node.__galRoot && node.__galRoot.querySelector(".gal-zoom");
    return !!(z && z.classList.contains("on"));
  },
  step: (node, d) => { stepZoom(node, d); return stOf(node).zoom; },
  closeZoom: (node) => { stOf(node).zoom = null; render(node); return true; },
  // ★ 273x：第 4 层（蒙版预览）的开关自测口
  maskView: (node) => { const m = node.__galRoot && node.__galRoot.querySelector(".gal-mask"); return !!(m && m.classList.contains("on")); },
  maskViewOpen: (node) => { const b = node.__galMask4Btn; if (b) b.click(); return !!(b && b.style.display !== "none"); },
  maskViewClose: (node) => {
    const m = node.__galRoot && node.__galRoot.querySelector(".gal-mask");
    const b = m ? [...m.querySelectorAll(".gal-mini")].filter((x) => /✕/.test(x.textContent))[0] : null;
    if (b) b.click();
    return !!b;
  },
  menu: (node, i) => {
    const s = stOf(node);
    if (!s.items[i]) return false;
    const cell = node.__galRoot.querySelectorAll(".gal-cell")[i];
    if (!cell) return false;
    const r = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }));
    return !!menuEl;
  },
  menuItems: () => (menuEl ? [...menuEl.querySelectorAll(".gal-mi")].map((x) => x.textContent) : []),
  clickMark: (node, i, which) => {
    const cells = node.__galRoot.querySelectorAll(".gal-cell");
    const cell = cells[i];
    if (!cell) return false;
    const map = { fav: 0, dl: 1, del: 2 };   // 237 批：右上角只剩三颗（多选框已挪到左上角）
    const mk = cell.querySelectorAll(".gal-mk")[map[which]];
    if (!mk) return false;
    mk.click();
    return true;
  },
  toggleMulti: (node) => {
    const b = [...node.__galRoot.querySelectorAll(".gal-mini")].filter((x) => /多选/.test(x.textContent))[0];
    if (b) b.click();
    return !!b;
  },
  // 测试用：临时替换确认窗（避免真删 / 真弹）
  confirmHook: (fn) => { window.__pcGalleryConfirm = fn; },
};


// ★ 2026-11-04（他第 5 条）：画廊右键「存成工具按钮」。
//   做法：读这张图的元数据 → 抠出正负提示词 → 问他一个名字 → 推进后端的共享黑板
//   `newbtn_queue`；工具端每 3 秒取一次队列，取到就在「暂无分类」里建按钮（工具没开也不会丢）。
const STORE_URL = "/prompt_sync/store";
async function toolStoreGet(key) {
  const r = await fetch(STORE_URL + "?key=" + encodeURIComponent(key), { cache: "no-store" });
  const j = await r.json();
  return j && j.value ? j.value : null;
}
async function toolStorePut(key, value) {
  const r = await fetch(STORE_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key, value: value }),
  });
  return await r.json();
}
function askButtonName(defaultName) {
  return new Promise((resolve) => {
    const mask = el("div", "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center");
    const box = el("div", "min-width:320px;background:#1b2027;border:1px solid #3a424e;border-radius:12px;padding:14px 16px;color:#e8eaf1;box-shadow:0 10px 30px rgba(0,0,0,.5)");
    const ti = el("div", "", "存成工具端的按钮");
    ti.style.cssText = "font-weight:700;font-size:13px;margin-bottom:8px";
    const lab = el("div", "", "给这个按钮起个名字（会放进「暂无分类」）：");
    lab.style.cssText = "font-size:12px;opacity:.8;margin-bottom:6px";
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = defaultName || "";
    inp.style.cssText = "width:100%;box-sizing:border-box;background:#0f141a;color:#e8eaf1;border:1px solid #3a424e;"
      + "border-radius:8px;padding:7px 9px;font:inherit;font-size:13px";
    const row = el("div", "display:flex;justify-content:flex-end;gap:8px;margin-top:12px");
    const no = document.createElement("button");
    no.type = "button"; no.textContent = "先不存";
    no.style.cssText = "font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;border:1px solid #3a424e;background:transparent;color:#c9d2de";
    const ok = document.createElement("button");
    ok.type = "button"; ok.textContent = "存成按钮";
    ok.style.cssText = "font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;cursor:pointer;border:1px solid #7c5cff;background:rgba(124,92,255,.25);color:#efe9ff;font-weight:700";
    const done = (v) => { try { mask.remove(); } catch (e) { /* 忽略 */ } resolve(v); };
    no.addEventListener("click", () => done(""));
    ok.addEventListener("click", () => done(String(inp.value || "").trim()));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(String(inp.value || "").trim()); }
      if (e.key === "Escape") { e.preventDefault(); done(""); }
      e.stopPropagation();
    });
    row.appendChild(no); row.appendChild(ok);
    box.appendChild(ti); box.appendChild(lab); box.appendChild(inp); box.appendChild(row);
    mask.appendChild(box);
    document.body.appendChild(mask);
    setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) { /* 忽略 */ } }, 30);
  });
}
async function saveAsToolButton(node, it) {
  let meta = null;
  try { meta = await apiGet("/meta", { rel: it.rel }); }
  catch (e) { toast("读不到这张图的元数据：" + (e && e.message ? e.message : e), true); return; }
  const r = revealParse(meta);
  if (!r || (!r.pos && !r.neg)) { toast("这张图里没有可用的提示词（不是本插件出图存的），没法存成按钮", true); return; }
  const nm = await askButtonName((it.name || "画廊导入").replace(/\.png$/i, ""));
  if (!nm) return;
  const payload = {
    name: nm, pos: r.pos || "", neg: r.neg || "",
    imgRel: it.rel || "", imgName: it.name || "", time: Date.now() / 1000,
  };
  let list = [];
  try { const q = await toolStoreGet("newbtn_queue"); if (q && Array.isArray(q.list)) list = q.list; } catch (e) { /* 忽略 */ }
  list.push(payload);
  try { await toolStorePut("newbtn_queue", { list: list }); }
  catch (e) { toast("发给工具端失败：" + (e && e.message ? e.message : e), true); return; }
  toast("已发给提示词工具：「" + nm + "」会出现在「暂无分类」里（工具没开的话，打开时会自动收到）");
}

// ==================== ★ 240 批：请神上身（安全复现）====================
//   他原话：「请神上身做出来，然后右键图片除了请神上身以外，再加一个复制图片的功能，
//   这样子复制完图片之后，就可以直接在聊天框中点击右键，再把复制的图片粘贴出来，非常好用」
//   数据来源：图存进存档时就带了 `prompt`（API 格式）+ `workflow`（UI 格式）两段元数据，
//   后端 /prompt_sync/gallery/meta 原样读出来 → 这里只做解析和回填。
const REVEAL_TAG = "pcReveal";

// ——「复制图片到剪贴板」：写 PNG 二进制，聊天框右键就能粘 ——
async function copyImage(it, node) {
  try {
    const r = await fetch(imgUrl(it.rel), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    let blob = await r.blob();
    if (blob.type !== "image/png") blob = new Blob([blob], { type: "image/png" });
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error("这个浏览器不支持写图片到剪贴板");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    // ★ 291 批（他第 5 条）：设置里勾了「复制图片时顺手收藏」→ 复制完再收藏一份
    var favDone = false;
    try {
      var favOn = false;
      try { favOn = !!(node && node.properties && node.properties.pcGal && node.properties.pcGal.favOnCopy); } catch (eP) { favOn = false; }
      if (!favOn) { try { favOn = !!(node && stOf(node).favOnCopy); } catch (eQ) { favOn = false; } }
      if (favOn) {
        await apiPost("/fav", { rel: it.rel, on: true });
        favDone = true;
        try { await loadPage(node, true); } catch (eL) { /* 忽略 */ }
      }
    } catch (eF) { /* 收藏失败不影响复制 */ }
    toast(favDone ? "图片已复制，并且顺手加入收藏了 —— 到聊天框里右键「粘贴」就行"
      : "图片已复制 —— 到聊天框里右键「粘贴」就行");
    return true;
  } catch (e) {
    toast("复制图片失败：" + (e.message || e) + "（可以先「下载」再用拖的）", true);
    return false;
  }
}

// —— 解析：从 API 格式的 prompt 里抠出"复现要用的东西" ——
function revealParse(meta) {
  const prompt = meta && meta.prompt ? meta.prompt : {};
  const out = { ks: null, pos: "", neg: "", loras: [], warn: [] };
  const byId = (id) => prompt[id] || null;
  const linkOf = (v) => (Array.isArray(v) ? { id: v[0], slot: v[1] } : null);
  let kid = null, kn = null;
  Object.keys(prompt).forEach((id) => {
    const n = prompt[id];
    if (!kn && n && /KSampler/.test(String(n.class_type || ""))) { kid = id; kn = n; }
  });
  if (!kn) { out.warn.push("这张图的元数据里没有 KSampler"); return out; }
  const inp = kn.inputs || {};
  out.ks = { seed: inp.seed, steps: inp.steps, cfg: inp.cfg, sampler_name: inp.sampler_name, scheduler: inp.scheduler, denoise: inp.denoise };
  // 沿 conditioning 往上游找文本（兼容 CLIPTextEncode / 优化节点 / ConditioningCombine）
  const textAt = (link) => {
    let cur = linkOf(link), guard = 0;
    while (cur && guard++ < 40) {
      const n = byId(cur.id);
      if (!n) break;
      const t = String(n.class_type || "");
      const ii = n.inputs || {};
      if (t === "CLIPTextEncode") return { kind: "enc", text: String(ii.text || "") };
      if (t === "PromptToolClipSegments") {
        // ★ 255 批（他："请神上身并没有复现提示词的功能"）：
        //   真因 —— 这两个字段在 API 里叫 `正提示词` / `负提示词`，我一直读的 `状态`（那是 LoRA 池的字段）
        //   → 优化节点那一路永远解析出空字符串。
        return {
          kind: "seg",
          pos: String(ii["正提示词"] || ""),
          neg: String(ii["负提示词"] || ""),
        };
      }
      cur = linkOf(ii.conditioning || ii.conditioning_1);
    }
    return null;
  };
  const tp = textAt(inp.positive);
  const tn = textAt(inp.negative);
  if (tp) out.pos = tp.kind === "seg" ? tp.pos : tp.text;
  if (tn) out.neg = tn.kind === "seg" ? tn.neg : tn.text;
  // 沿 model 往上游收集 LoRA —— ★ 273i（他："请神上身竟然分不清 Lora 的先后"）：
  //   上游是先叠的、离 KSampler 近的是后叠的；所以一路 push（遇到的顺序 = 后叠 → 先叠），最后整体 reverse。
  //   池子的 `状态.loras` 本身是"先叠在前"，所以它内部要反过来 push，才能和整体 reverse 对上。
  let cur = linkOf(inp.model), guard = 0;
  while (cur && guard++ < 80) {
    const n = byId(cur.id);
    if (!n) break;
    const t = String(n.class_type || "");
    const ii = n.inputs || {};
    if (t === "LoraLoader") {
      out.loras.push({ name: String(ii.lora_name || ""), model: Number(ii.strength_model == null ? 1 : ii.strength_model), clip: Number(ii.strength_clip == null ? 1 : ii.strength_clip) });
    } else if (t === "PromptToolLoraPool") {
      try {
        const st = typeof ii["状态"] === "string" ? JSON.parse(ii["状态"]) : (ii["状态"] || {});
        (st.loras || []).filter((r) => r && r.on !== false).slice().reverse().forEach((r) => {
          out.loras.push({ name: String(r.name || ""), model: Number(r.model == null ? 1 : r.model), clip: Number(r.clip == null ? 1 : r.clip) });
        });
      } catch (e) { /* 忽略 */ }
    }
    cur = linkOf(ii.model);
  }
  out.loras.reverse();
  return out;
}

// —— 回填到"当前画布"上（按类型找，不按图里的 id —— 工作流可能早换过了） ——
function revealApply(parsed) {
  const nodes = (app.graph && app.graph._nodes) || [];
  const undo = [];
  const setW = (nd, name, val, opt) => {
    if (val == null) return false;
    const w = (nd.widgets || []).filter((x) => x && x.name === name)[0];
    if (!w) return false;
    if (!(opt && opt.force) && String(w.value) === String(val)) return true;
    undo.push({ node: nd, name: name, old: w.value });
    w.value = val;
    try { if (typeof w.callback === "function") w.callback(val, nd); } catch (e) { /* 忽略 */ }
    return true;
  };
  const res = { ks: [], text: 0, lora: 0, warn: [] };
  // ① KSampler
  const ks = nodes.filter((n) => /KSampler/.test(String(n.type || n.comfyClass || "")))[0];
  if (!ks) { res.warn.push("画布上没有 KSampler，复现不了"); return { ok: false, res: res, undo: undo }; }
  if (parsed.ks) {
    [["seed", "seed"], ["steps", "steps"], ["cfg", "cfg"], ["sampler_name", "sampler_name"], ["scheduler", "scheduler"], ["denoise", "denoise"]].forEach((p) => {
      if (setW(ks, p[1], parsed.ks[p[0]])) res.ks.push(p[1]);
    });
  }
  // ② 提示词：接在 positive / negative 上的那颗
  const upOf = (nd, slot) => {
    const inp = nd.inputs && nd.inputs[slot];
    if (!inp || inp.link == null) return null;
    const l = (app.graph.links || {})[inp.link];
    if (!l) return null;
    return nodes.filter((x) => x.id === l.origin_id)[0] || null;
  };
  // ★ 241 批修 bug（他实测"提示词没带过来"的真因之一）：这里原来是**箭头函数**，
  //   而下面用 `arguments[2]` 判断正负 —— 箭头函数没有自己的 arguments，拿到的是 revealApply 的，
  //   于是 which 永远是 "pos" → 正负词都写进正提示词（负词覆盖正词，负侧空着）。
  //   改成普通函数 + 显式第三个参数。
  const writeText = function (nd, text, whichSide) {
    if (!nd) return false;
    const t = String(nd.type || nd.comfyClass || "");
    if (t === "CLIPTextEncode") {
      const w = (nd.widgets || [])[0];
      if (!w) return false;
      undo.push({ node: nd, name: "__text0", old: w.value });
      w.value = text;
      try { if (typeof w.callback === "function") w.callback(text, nd); } catch (e) { /* 忽略 */ }
      return true;
    }
    if (t === "PromptToolClipSegments") {
      const which = whichSide === "neg" ? "neg" : "pos";
      // ★ 241 批（他："请神上身应该携带该图生成所需要的提示词才对" —— 上一版只写了 properties，
      //   **界面上的文本框不会变**，看着就像"提示词没带过来"）。
      //   现在优先"像用户打字那样"写进它的 textarea 并触发 input（界面立刻刷新，还能走它自己的保存链）。
      try {
        const panel = nd.__pcPanel || document;
        const sec = panel.querySelector('[data-pcside="' + which + '"]');
        const ta = sec ? sec.querySelector("textarea") : null;
        if (ta) {
          undo.push({ node: nd, name: "__ta_" + which, old: ta.value });
          ta.value = text;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      } catch (e) { /* 落到下面直接写 properties */ }
      // 面板没建出来时，退回直接写 properties（数据照样对）
      undo.push({ node: nd, name: "__seg_" + which, old: null });
      nd.properties = nd.properties || {};
      const q = nd.properties.pcClip || (nd.properties.pcClip = {});
      const side = q[which] || (q[which] = {});
      side.v = text;
      side.r = text ? [{ s: 0, e: text.length, off: false }] : [];
      if (!side.chips) side.chips = [];
      delete q.__v;
      try { if (nd.__pcCompPaint) nd.__pcCompPaint(); } catch (e) { /* 忽略 */ }
      try { if (nd.__pcCompNegPaint) nd.__pcCompNegPaint(); } catch (e) { /* 忽略 */ }
      return true;
    }
    return false;
  };
  const posNode = upOf(ks, 1), negNode = upOf(ks, 2);
  if (parsed.pos) { if (writeText(posNode, parsed.pos, "pos")) res.text++; }
  if (parsed.neg) { if (writeText(negNode, parsed.neg, "neg")) res.text++; }
  if (parsed.pos && !posNode) res.warn.push("KSampler 的 positive 没接东西，正提示词没地方放");
  if (parsed.neg && !negNode) res.warn.push("KSampler 的 negative 没接东西，负提示词没地方放");
  // ③ LoRA：优先写池子，没有池子就往 LoraLoader 链上按顺序填
  if (parsed.loras.length) {
    const pool = nodes.filter((n) => String(n.type || n.comfyClass || "") === "PromptToolLoraPool")[0];
    if (pool) {
      const w = (pool.widgets || []).filter((x) => x && x.name === "状态")[0];
      if (w) {
        let st = {};
        try { st = JSON.parse(String(w.value || "{}")); } catch (e) { st = {}; }
        undo.push({ node: pool, name: "__pool", old: w.value });
        // ★ 267 批（他："Lora 池莫名其妙会把暗淡掉的东西消失掉"）：
        //   以前这里是 `st.loras = 图上那几颗` —— 一按请神，池子里**熄灭的那些被整份删掉**
        //   （他攒的十几颗只剩图上那 1~3 颗）。现在改成合并：
        //   图上那几颗排前面 + 点亮（顺序 = 图里的叠加顺序），原有的**留着、只是熄灭**，
        //   撤回请神照样能整份还原。
        const oldLoras = Array.isArray(st.loras) ? st.loras : [];
        const revNames = parsed.loras.map((r) => r.name);
        const merged = parsed.loras.map((r) => {
          const was = oldLoras.filter((x) => x && x.name === r.name)[0];
          if (!was) return { name: r.name, on: true, model: r.model, clip: r.clip, src: "reveal" };
          const o = JSON.parse(JSON.stringify(was));
          o.on = true;
          if (r.model != null) o.model = r.model;
          if (r.clip != null) o.clip = r.clip;
          o.src = "reveal";
          return o;
        });
        const kept = oldLoras.filter((x) => x && revNames.indexOf(x.name) < 0)
          .map((x) => { const o = JSON.parse(JSON.stringify(x)); o.on = false; return o; });
        st.loras = merged.concat(kept);
        if (!st.kinds) st.kinds = {};
        if (!st.mode) st.mode = "model";
        w.value = JSON.stringify(st);
        res.lora = parsed.loras.length;
        try { window.dispatchEvent(new CustomEvent("pc-lorapool-changed", { detail: { node: pool } })); } catch (e) { /* 忽略 */ }
        // 池子那边也直接重画一次（万一监听器没装上 / 被去重挡掉）
        try { if (window.__pcLoraPool && window.__pcLoraPool.render) window.__pcLoraPool.render(pool); } catch (e) { /* 忽略 */ }
      }
    } else {
      const chain = nodes.filter((n) => String(n.type || n.comfyClass || "") === "LoraLoader");
      const n = Math.min(chain.length, parsed.loras.length);
      for (let i = 0; i < n; i++) {
        const r = parsed.loras[i];
        setW(chain[i], "lora_name", r.name, { force: true });
        setW(chain[i], "strength_model", r.model, { force: true });
        setW(chain[i], "strength_clip", r.clip, { force: true });
      }
      res.lora = n;
      if (parsed.loras.length > chain.length) res.warn.push("图上 " + parsed.loras.length + " 个 LoRA，画布只串了 " + chain.length + " 个 LoraLoader，后 " + (parsed.loras.length - chain.length) + " 个没放进去");
    }
  }
  return { ok: res.ks.length > 0 || res.text > 0 || res.lora > 0, res: res, undo: undo };
}

async function revealFromImage(node, it) {
  let meta = null;
  try {
    meta = await apiGet("/meta", { rel: it.rel });
  } catch (e) {
    toast("读不到这张图的元数据：" + e.message, true);
    return false;
  }
  if (!meta.has || !meta.has.prompt) {
    // ★ 他两次报这块 —— 把**是哪张图、为什么没有**说清（.jpg 外来图、素材模式合成图都不带 prompt/workflow）
    const nm = String((it && (it.name || it.rel)) || "这张图");
    toast("这张图里没有 prompt 元数据：" + nm + " —— 不是插件生图存的图（外来 .jpg / 素材合成图都不带），没法请神", true);
    return false;
  }
  const parsed = revealParse(meta);
  const r = revealApply(parsed);
  if (!r.ok) {
    toast("安全复现失败：" + ((r.res.warn || []).join("；") || "画布上没有能接这些参数的节点"), true);
    return false;
  }
  window.__pcReveal = window.__pcReveal || {};
  window.__pcReveal.undo = (window.__pcReveal.undo || []).concat(r.undo);
  window.__pcReveal.last = { rel: it.rel, at: Date.now(), res: r.res };
  const bits = [];
  if (r.res.ks.length) bits.push("采样参数 " + r.res.ks.length + " 项");
  if (r.res.text) bits.push("提示词 " + r.res.text + " 段");
  if (r.res.lora) bits.push("LoRA " + r.res.lora + " 颗");
  toast("安全复现完成：" + bits.join(" / ") + (r.res.warn.length ? "（" + r.res.warn.join("；") + "）" : "") + " —— 右键图片可「撤回请神」");
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
  return true;
}

// 撤回：把复现那一刻之前的值一个个写回去（倒序）
function revealUndo() {
  const u = (window.__pcReveal && window.__pcReveal.undo) || [];
  if (!u.length) { toast("没有可撤回的请神记录"); return false; }
  let n = 0;
  u.slice().reverse().forEach((x) => {
    try {
      if (x.name === "__pool") {
        const w = (x.node.widgets || []).filter((y) => y && y.name === "状态")[0];
        if (w) { w.value = x.old; n++; try { window.dispatchEvent(new CustomEvent("pc-lorapool-changed")); } catch (e) { /* 忽略 */ } }
      } else if (x.name === "__text0") {
        const w = (x.node.widgets || [])[0];
        if (w) { w.value = x.old; n++; }
      } else if (x.name === "__ta_pos" || x.name === "__ta_neg") {
        // 文本框：写回旧值 + 触发 input（它自己会把 properties 同步回去）
        const which = x.name === "__ta_neg" ? "neg" : "pos";
        const panel = x.node.__pcPanel || document;
        const sec = panel.querySelector('[data-pcside="' + which + '"]');
        const ta = sec ? sec.querySelector("textarea") : null;
        if (ta) { ta.value = x.old; ta.dispatchEvent(new Event("input", { bubbles: true })); n++; }
      } else if (x.name === "__seg_pos" || x.name === "__seg_neg") {
        // 优化节点的文本没有"单值"可还原，这里只在记录里标记（留原值）
        n++;
      } else {
        const w = (x.node.widgets || []).filter((y) => y && y.name === x.name)[0];
        if (w) { w.value = x.old; n++; }
      }
    } catch (e) { /* 忽略 */ }
  });
  window.__pcReveal.undo = [];
  try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* 忽略 */ }
  toast("已撤回请神：还原了 " + n + " 处参数");
  return true;
}

// ---------------------------------------------------------------- 注册
app.registerExtension({
  name: "PromptTool.Gallery",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeType) return;   // ⚠️ 前端 1.57 会拿 null 调一次这个钩子，不挡就整段面板增强静默失效
    if (!nodeData || nodeData.name !== NODE_TYPE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      try { attachGallery(this); } catch (e) { log("画廊初始化失败", e); }
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        syncGalProps(this);            // ★ 273b：属性到这时才到位 → 重新对一遍（平铺/按组不再重置）
        if (this.__galRoot) {
          const h = this.size ? this.size[1] : DEF_H;
          this.__galRoot.style.height = Math.max(120, h - 34) + "px";
        }
        render(this);
        setTimeout(() => loadPage(this, true), 200);
      } catch (e) { /* 忽略 */ }
      return r;
    };
    const computeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (out) {
      const sz = (computeSize ? computeSize.apply(this, arguments) : null) || out || [DEF_W, DEF_H];
      if (sz && typeof sz[0] === "number") {
        sz[0] = Math.max(sz[0], 420);
        sz[1] = Math.max(sz[1], 260);
      }
      return sz;
    };
  },
  nodeCreated(node) {
    if (node && node.comfyClass === NODE_TYPE) attachGallery(node);
  },
});

// ★ 273w（他第 2 条）：一张图**作为「图像画廊」节点的输出被连线使用时**也算用过 → 自动进「编辑栏」。
//   放在**跑图前**那一刻扫一遍：这样"翻着看图"不会把整本相册都堆进去，只有真要跑的时候才记。
(function hookToEditOnQueue() {
  try {
    const orig = window.app && window.app.queuePrompt;
    if (typeof orig !== "function" || orig.__pcToEdit) return;
    window.app.queuePrompt = function () {
      try {
        (window.app.graph._nodes || []).forEach((n) => {
          if (!n || n.type !== NODE_TYPE) return;
          const linked = (n.outputs || []).some((o) => o && o.links && o.links.length);
          if (!linked) return;
          const w = (n.widgets || [])[0];
          const rel = w ? String(w.value || "") : "";
          if (!rel || rel.indexOf("/") < 0) return;
          apiPost("/toedit", { rel: rel }).catch(() => {});
        });
      } catch (e) { /* 忽略 */ }
      return orig.apply(this, arguments);
    };
    window.__pcGallery.toEditHook = true;
  } catch (e) { /* 忽略 */ }
})();

log("已就绪（图像画廊）");
