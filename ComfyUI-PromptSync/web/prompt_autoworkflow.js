/**
 * 打开 ComfyUI 就自动把「7.1工作流」摆上画布 —— 省掉"每次还要从工作流列表里点一下 / 拖进来"那一步。
 *
 * 为什么要有它：ComfyUI 首次打开会去加载官方 "get started" 模板，那个模板要用 3 个得从
 * HuggingFace 在线下载的模型，没加速器的环境下会一直超时（页面看着就像卡住/黑屏）。
 * 分享包里已经把 Comfy.TutorialCompleted 预置成 true，正常情况下打开就是空画布；
 * 这里再把我们的工作流补上，用户就什么都不用做。
 *
 * 安全边界（很重要）：
 *   · 只在**这个浏览器第一次打开**时做（localStorage 标记），之后再也不插手；
 *   · 只会覆盖"空画布"或"官方示例模板"；用户自己摆的东西**绝不动**；
 *   · 拿不到工作流文件（例如桌面版用户没放）→ 静默跳过，不报错、不影响任何功能。
 */
import { app } from "../../scripts/app.js";

const FLAG = "PromptSync.autoOpened.v1";
const WORKFLOW_NAME = "7.1工作流.json";
// ⚠️ ComfyUI 的 userdata 路由要求**整段相对路径一起编码**：
//    /api/userdata/workflows%2F7.0%E5%B7%A5%E4%BD%9C%E6%B5%81.json → 200
//    /api/userdata/workflows/7.1工作流.json                        → 404
const WORKFLOW_URL = "/api/userdata/" + encodeURIComponent("workflows/" + WORKFLOW_NAME);

function nodes() { return (app.graph && app.graph._nodes) || []; }
function ourNodeCount() {
  return nodes().filter((n) => /^Prompt(Tool|Sync)/.test(String(n.type || ""))).length;
}
// 空画布、或者画布上摆的是官方示例模板（那种要用在线模型）→ 可以接管；除此之外一律不动
function safeToReplace() {
  const ns = nodes();
  if (!ns.length) return true;
  return ns.some((n) => /ModelSamplingAuraFlow|EmptySD3LatentImage|CheckpointLoaderSimple/.test(String(n.type || "")));
}

async function loadOurs() {
  const res = await fetch(WORKFLOW_URL);
  if (!res.ok) return false;
  const wf = await res.json();
  if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) return false;
  if (ourNodeCount() > 0 || !safeToReplace()) return false;
  await app.loadGraphData(wf, true, true);
  return true;
}

async function tryAutoOpen() {
  try {
    if (localStorage.getItem(FLAG)) return;
    if (!app.graph || !Array.isArray(app.graph._nodes)) return;
    if (ourNodeCount() > 0) { localStorage.setItem(FLAG, "1"); return; }
    if (!safeToReplace()) return;                       // 用户自己在干活，别动
    await loadOurs();
    // 官方模板有时比我们晚落地（它要先等网络超时），落地会把我们的盖掉 → 过几秒确认一次
    setTimeout(async () => {
      try {
        if (localStorage.getItem(FLAG)) return;
        if (ourNodeCount() > 0) { localStorage.setItem(FLAG, "1"); return; }
        if (!safeToReplace()) return;
        if (await loadOurs()) localStorage.setItem(FLAG, "1");
      } catch (e) { /* 忽略 */ }
    }, 4500);
  } catch (e) { /* 顺手帮忙而已，失败就当没这回事 */ }
}

app.registerExtension({
  name: "PromptSync.AutoOpenWorkflow",
  async setup() {
    setTimeout(tryAutoOpen, 1500);
  },
});
