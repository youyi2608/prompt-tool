"""互通节点的后端路由。

给 ComfyUI 的 aiohttp 服务挂三条接口：

  POST /prompt_sync/push     收下工具送来的正/负提示词，并实时推给浏览器
  GET  /prompt_sync/current  取回最后一次推送的内容（手动「从工具同步一次」用）
  GET  /prompt_sync/ping     探活：启动器 / 工具用它判断节点有没有装好

另有两组（都不碰上面这三条）：
  /prompt_sync/aliases       模型别名表（GET 读 / POST 改）
  /prompt_sync/batch/*       套图排队（push / status / start / stop / pause / clear）
  POST /prompt_sync/timer/sound   计时提醒的自定义音效（前端发 data URL，落盘到 web/sounds/）

**两条来源都放行**：

  ① 本地启动器的【服务端转发】—— 不带 Origin 头（原来只有这一条路）；
  ② 浏览器直连（2026-09-22 加的）：工具**没有配启动器**时（直接双击 HTML 打开的，
     发布包里就是这样），页面会直接 POST 到 127.0.0.1:<端口>/prompt_sync/push。

②是跨源请求，所以这里要回 CORS 头，并且**只认本机来源**：
Origin 为空（启动器转发）、"null"（file:// 直接打开的工具）、
http(s)://127.0.0.1[:端口] / http(s)://localhost[:端口]。
别的网站（比如 evil.com）拿不到 CORS 头，浏览器的预检就过不去，POST 根本发不出来。
"""

import base64
import copy
import json
import os
import random
import re
import shutil
import threading
import time
import urllib.parse
import uuid

from aiohttp import web

try:                       # 允许在没有 ComfyUI 的环境里单独导入本模块做自测
    from server import PromptServer
except Exception:          # pragma: no cover
    PromptServer = None

_LOCAL_ORIGIN = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$")
_CORS_METHODS = "GET, POST, OPTIONS"
_CORS_HEADERS = "Content-Type"

_last = {"pos": "", "neg": "", "name": "", "time": 0.0, "count": 0}


def normalize_payload(data):
    """把外部送来的数据收拾成内部结构（纯函数，便于单测）。

    - 非 dict、或正负都为空 → 返回 None（拒绝写入，避免空推送把节点清空）
    - 缺字段一律补空串；名字截断到 120 字
    """
    if not isinstance(data, dict):
        return None
    pos = data.get("pos")
    neg = data.get("neg")
    if pos is None and neg is None:
        return None
    return {
        "pos": "" if pos is None else str(pos),
        "neg": "" if neg is None else str(neg),
        "name": "" if data.get("name") is None else str(data.get("name"))[:120],
        "time": time.time(),
    }


def origin_allow(request):
    """该给这个请求回什么 Access-Control-Allow-Origin。

    返回 None  = 请求根本没带 Origin（启动器的服务端转发）→ 放行，不需要 CORS 头
    返回 字符串 = 本机页面（file:// 的 "null"，或 127.0.0.1 / localhost 的页面）→ 放行并回填
    返回 False = 别的网站 → 拒绝
    """
    origin = request.headers.get("Origin")
    if not origin:
        return None
    # file:// 直接双击打开的工具：不同 Chrome/Edge 版本给的不一样
    #（实测 Chrome 24 这边给的是字面量 "file://"，老版本给 "null"），两个都认
    if origin in ("null", "file://"):
        return origin
    if _LOCAL_ORIGIN.match(origin):
        return origin
    return False


def cors_headers(allow):
    headers = {
        "Access-Control-Allow-Methods": _CORS_METHODS,
        "Access-Control-Allow-Headers": _CORS_HEADERS,
        "Access-Control-Max-Age": "600",
    }
    # ★ 194 批（他双击 HTML 打开的工具连不上 ComfyUI，控制台是
    #   "No 'Access-Control-Allow-Origin' header is present"）：真因 —— 浏览器从 **file:// 页面**发起的请求
    #   可能**根本不带 Origin 头**，而这里以前对"没有 Origin"直接不填 ACAO → 浏览器判定不许读。
    #   不带 Origin 的请求只可能来自 file:// 页面或本机后台（网页发的跨源请求一定带 Origin），补 `*` 是安全的。
    if allow is not False:
        headers["Access-Control-Allow-Origin"] = allow if allow else "*"
    return headers


def _json(allow, data, status=200):
    return web.json_response(data, status=status, headers=cors_headers(allow))


async def push(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        data = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)

    payload = normalize_payload(data)
    if payload is None:
        return _json(allow, {"success": False, "error": "正负提示词都是空的，已忽略"}, status=400)

    _last.update(payload)
    _last["count"] = _last.get("count", 0) + 1

    if PromptServer is not None:
        try:
            PromptServer.instance.send_sync("prompt_sync.update", dict(_last))
        except Exception:
            pass

    return _json(allow, {
        "success": True,
        "name": payload["name"],
        "pos_len": len(payload["pos"]),
        "neg_len": len(payload["neg"]),
        "count": _last["count"],
    })


# ==== ★ 186 批：节点上的 ⚡/✎ 通过"工具中转"来优化 ====
#   节点把"要优化的这一段 + 用户要求"放到这里，**工具页面（开着的时候）**轮询拿走、
#   用它自己的 AI 配置去调模型，再把结果写回来。这样节点里不用再养一套密钥。
_ai_slot = {"id": 0, "pos": "", "neg": "", "ask": "", "want": "", "time": 0.0,
            "taken": 0, "done": 0, "text": "", "err": "", "negOut": ""}


async def ai_request(request):
    """节点这边发起一次优化请求（POST /prompt_sync/ai/request）。"""
    # ★ 193 批：这批接口以前**没回 CORS 头、也没登记 OPTIONS** —— 于是
    #   "双击 HTML 打开的工具"(file://) 根本读不到 /pending、也发不出 /store 的 POST，
    #   表现就是「节点点优化没反应」+「优化小设置怎么都同步不了」。现在全部按本机来源放行。
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        data = await request.json()
    except Exception:
        data = {}
    _ai_slot.update({
        "id": _ai_slot.get("id", 0) + 1,
        "pos": str(data.get("pos") or ""),
        "neg": str(data.get("neg") or ""),
        "ask": str(data.get("ask") or ""),
        "want": str(data.get("want") or "pos"),
        # ★ 285 批（他第 6 条："勾选顺便给出优化后的负提示词，在优化提示词之后，依旧不会生成负提示词"）
        #   真因就在这两行没写：节点明明发了 negWant，这里一个字段都没存 → /pending 也不带 →
        #   工具那边 `req.negWant` 永远是 undefined → 从来没让 AI 给负提示词 → 节点当然什么都收不到。
        "negWant": 1 if (data.get("negWant") in (1, True, "1", "true")) else 0,
        # ★ 285：画师串开关也一起传（节点没亮就别让 AI 加画师）
        "artist": data.get("artist") if data.get("artist") is not None else None,
        "time": time.time(),
        "taken": 0, "done": 0, "text": "", "err": "",
    })
    return _json(allow, {"success": True, "id": _ai_slot["id"]})


# ==== ★ 188 批：工具 ⇄ 节点的"小数据"互通（快捷词 / 要求历史 / 画师规则）====
#   两边浏览器不同源，localStorage 不通用，所以拿后端当一块共享黑板（进程内，重启就清）。
_store_slots = {}


async def store_get(request):
    """GET /prompt_sync/store?key=xxx → 取一块共享数据（没有就返回 None）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    key = request.query.get("key") or ""
    return _json(allow, {"success": True, "key": key, "value": _store_slots.get(key)})


async def store_post(request):
    """POST /prompt_sync/store {key, value} → 写一块共享数据。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        data = await request.json()
    except Exception:
        data = {}
    key = str(data.get("key") or "")
    if key:
        _store_slots[key] = data.get("value")
    return _json(allow, {"success": True, "key": key})


async def ai_pending(request):
    """工具页面来取"有没有活儿"（GET /prompt_sync/ai/pending）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    if not _ai_slot["id"] or _ai_slot["done"] or _ai_slot["taken"]:
        return _json(allow, {"success": True, "req": None})
    _ai_slot["taken"] = 1
    return _json(allow, {"success": True, "req": {
        "id": _ai_slot["id"], "pos": _ai_slot["pos"], "neg": _ai_slot["neg"],
        "ask": _ai_slot["ask"], "want": _ai_slot["want"],
        "negWant": _ai_slot.get("negWant", 0),          # ★ 285
        "artist": _ai_slot.get("artist", None),         # ★ 285
        # ★ 192 批：把"什么时候发的"一起给它 —— 工具页隔很久才打开时，
        #   陈年请求不该突然把提示词改掉（工具侧超过 10 分钟会直接回"太旧了"）。
        "time": _ai_slot.get("time", 0),
    }})


async def ai_answer(request):
    """工具页面把结果写回来（POST /prompt_sync/ai/answer）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        data = await request.json()
    except Exception:
        data = {}
    if int(data.get("id") or 0) == _ai_slot["id"]:
        _ai_slot["done"] = 1
        _ai_slot["text"] = str(data.get("text") or "")
        _ai_slot["err"] = str(data.get("err") or "")
        # ★ 273c 批：节点勾了"顺便给出负提示词"时，把那份负词原样带回给节点（它自己用小提示卡弹出来）
        _ai_slot["negOut"] = str(data.get("neg") or "") if data.get("neg") is not None else ""
    return _json(allow, {"success": True})


async def ai_result(request):
    """节点轮询结果（GET /prompt_sync/ai/result?id=N）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    want_id = request.query.get("id")
    if want_id is not None and str(want_id) != str(_ai_slot["id"]):
        return _json(allow, {"success": True, "done": False, "stale": True})
    return _json(allow, {
        "success": True, "id": _ai_slot["id"], "done": bool(_ai_slot["done"]),
        "text": _ai_slot["text"], "err": _ai_slot["err"],
        "neg": _ai_slot.get("negOut") or "",
    })


async def current(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    return _json(allow, {"success": True, "data": dict(_last)})


# ==========================================================================================
# 模型别名（游动羽翼工具栏的第 2 件事）
#
# 用户为了认得出文件，以前会给 LoRA / Checkpoint 改名 —— 但改了名就没法分享（别人拿到的文件名对不上）。
# 所以改成：**文件名一个都不动，只给它记一个「别名」**，画布上显示别名、下拉列表里也显示别名，
# 而工作流 / API 图里存的、ComfyUI 真正加载的，仍然是真文件名。
#
# 别名表就是这个文件夹里的 model_aliases.json（纯 JSON，可以手改、可以拷给别人）：
#
#   { "loras/taffy-style-v1.0.safetensors": "我常用的那个画风",
#     "checkpoints/anima-base-v1.0.safetensors": "底模" }
#
# 键 = <种类>/<下拉里的相对路径>（种类来自前端认的 widget 名，见 web/prompt_toolbar.js）。
# ==========================================================================================

ALIAS_FILE_ENV = "PROMPT_SYNC_ALIAS_FILE"   # 自测用：指到临时文件，别碰真表
ALIAS_MAX_LEN = 60
ALIAS_KEY_MAX_LEN = 240


def alias_file_path():
    """别名表放在节点文件夹里（跟着节点走，便于整个拷给别人）。"""
    override = os.environ.get(ALIAS_FILE_ENV)
    if override:
        return override
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_aliases.json")


def normalize_alias_key(key):
    """键：非空、单行、不超过 240 字。不合法 → None（拒绝写入）。"""
    if key is None:
        return None
    text = str(key).replace("\r", " ").replace("\n", " ").strip()
    if not text or len(text) > ALIAS_KEY_MAX_LEN:
        return None
    return text


def normalize_alias_text(value):
    """别名：去首尾空白、压成单行、限长 60 字；空串 = 清除别名（恢复真文件名）。"""
    if value is None:
        return ""
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text[:ALIAS_MAX_LEN]


def clean_alias_map(raw):
    """把外部给的一整张表洗干净（只留合法的键值对，别名空的丢掉）。"""
    out = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        key = normalize_alias_key(k)
        if not key:
            continue
        alias = normalize_alias_text(v)
        if alias:
            out[key] = alias
    return out


def load_aliases(path=None):
    """读别名表。文件不存在 / 坏了 → 返回空表（绝不让一个坏 JSON 把节点搞挂）。"""
    p = path or alias_file_path()
    try:
        with open(p, "r", encoding="utf-8") as f:
            return clean_alias_map(json.load(f))
    except Exception:
        return {}


def save_aliases(data, path=None):
    """写别名表：先写 .tmp 再替换（写到一半断电也不会把旧表搞坏）。返回写到了哪个文件。"""
    p = path or alias_file_path()
    folder = os.path.dirname(os.path.abspath(p))
    if folder and not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(clean_alias_map(data), f, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, p)
    return p


def parse_alias_body(body):
    """解析一次写入请求（纯函数，便于单测）。

    支持三种写法（返回 (动作, 数据, 错误)）：
      {"key": "...", "alias": "..."}   改一个（alias 为空 = 删掉这一个）
      {"aliases": {...}}               整张表换掉（前端「导入 / 清空」用）
      {"clear": true}                  清空
    """
    if not isinstance(body, dict):
        return None, None, "请求体不是 JSON 对象"
    if body.get("clear") is True or body.get("clear") == "true":
        return "replace", {}, None
    if "aliases" in body:
        if not isinstance(body["aliases"], dict):
            return None, None, "aliases 必须是一个对象"
        return "replace", clean_alias_map(body["aliases"]), None
    key = normalize_alias_key(body.get("key"))
    if not key:
        return None, None, "缺 key（或者 key 太长 / 是空的）"
    return "set", {"key": key, "alias": normalize_alias_text(body.get("alias"))}, None


def apply_alias_change(current, action, data):
    """把一次动作落到表上（纯函数，不碰磁盘）。"""
    out = dict(current or {})
    if action == "replace":
        return clean_alias_map(data)
    if action == "set":
        key = data["key"]
        if data["alias"]:
            out[key] = data["alias"]
        else:
            out.pop(key, None)          # 别名清空 = 恢复真文件名
    return out


NODE_VERSION = "2.0"
LOG_TAG = "[提示词工具]"

# ==========================================================================================
# 套图排队（PromptToolBatchQueue）
#
# 工具把一整套提示词（N 段，每段 正/负/备注）推到这里，用户在节点上点「▶ 开始排队」，
# 节点前端把**当前工作流**的 API 图一起发过来；后端开一个喂饭线程：
#
#   排第 1 张 → 等它出完（轮询这个 prompt_id 的 history）→ 在**队列外面**歇 N 秒 → 再排下一张
#
# 为什么休息不写进图里（比如塞个 time.sleep 的节点）：那样这张图会一直显示"运行中"，
# 想停还得等它醒；放在队列外面休息时 ComfyUI 是真空闲，随时能停、也随时能手动取消。
#
# 暂停（2026-10-02 加的，他原话「如果生成到一半不能暂停，那就把这张图生成之后再暂停」）：
#   `_batch_pause` 只立旗；喂饭线程在"两张之间"（这张出完 / 休息里）才真的挂住 —— 正在跑的
#   那张不打断。恢复只是把旗放下，接着往下排。
#
# 旧的三条路由（push / current / ping）一行都没动，套图全走 /prompt_sync/batch/*。
# ==========================================================================================

BATCH_MAX_SEGMENTS = 20   # ★ 160 批⑧：24 → 20（工具侧 BATCH_MAX_BOXES 同步；配合"大规模套图生成"20+20+… 突破上限）
BATCH_MAX_REST = 600
BATCH_WAIT_TIMEOUT = 6 * 3600          # 一张图最多等 6 小时（真的卡死了也别把线程吊一辈子）
BATCH_POLL_INTERVAL = 0.5

# ---- LoRA 方案（2026-10-05 批 C2，他定的：最多 4 个、存了不能改） ----
BATCH_MAX_SCHEMES = 4                  # 节点上最多存几个方案
_SCHEME_MAX_LORAS = 32                 # 一个方案里最多记几个 LoRA（防手改的工作流塞进来一大堆）

# ---- 计时提醒的自定义音效（2026-10-05 批 C1，他定的：音效可以自己导入文件） ----
SOUND_MAX_BYTES = 4 * 1024 * 1024      # 上限 4MB（再大就不像"响一声"了）
SOUND_URL_PREFIX = "/extensions/ComfyUI-PromptSync/sounds/"
SOUND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "sounds")
_SOUND_EXT = (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm", ".opus", ".oga")
_SOUND_MIME_EXT = {
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/wave": ".wav", "audio/ogg": ".ogg", "audio/webm": ".webm", "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac", "audio/x-flac": ".flac",
    "audio/opus": ".opus",
}

_batch_lock = threading.Lock()
_batch_stop = threading.Event()
_batch_pause = threading.Event()
_batch = {
    "segments": [],     # 工具推来的那几段
    "running": False,
    "paused": False,    # 暂停键立起来了没有（真正挂住是在"两张之间"，见 _hold_if_paused）
    "stage": "idle",    # idle / queued(排上了，等它出完) / resting / paused / done / stopped / error
    "note": "",
    "index": 0,         # 正在排第几张（从 1 数）
    "planned": 0,       # 这一轮排几张
    "done": 0,          # 已经出完几张
    "rest_left": 0,     # 还要歇几秒
    "error": "",
    "prompt_ids": [],
    "scheme": "",       # 这一张用的是哪个 LoRA 方案（空 = 不换；见批 C2）
}


def normalize_segment(seg):
    """一段提示词 → {pos, neg, note}；正负都空 → None（丢掉）。"""
    if not isinstance(seg, dict):
        return None
    pos = seg.get("pos")
    neg = seg.get("neg")
    if (pos is None or str(pos) == "") and (neg is None or str(neg) == ""):
        return None
    return {
        "pos": "" if pos is None else str(pos),
        "neg": "" if neg is None else str(neg),
        "note": "" if seg.get("note") is None else str(seg.get("note"))[:60],
    }


def normalize_segments(raw):
    """把工具送来的一整批洗干净：丢掉空段、最多 BATCH_MAX_SEGMENTS 段。"""
    if not isinstance(raw, (list, tuple)):
        return []
    out = []
    for seg in raw:
        clean = normalize_segment(seg)
        if clean is not None:
            out.append(clean)
        if len(out) >= BATCH_MAX_SEGMENTS:
            break
    return out


# ---------------------------------------------------------------- LoRA 方案（批 C2）
# 他 2026-10-05 要的（「套图中途换 LoRA」，他自己说"属于高级选项"）：
#   ① 节点上把**当前画面里的所有 LoRA**（文件名 + 两个强度）存成一个"方案"，最多 4 个；
#   ② **存好之后不能改** —— 要改就删掉重新存（所以后端也不提供"改方案"这条路）；
#   ③ 每一张图可以点一个方案（不点 = 不换 LoRA，就用画布上现在这份）。
# 前端（web/prompt_batch.js）把方案连同"第几张用第几个"一起放进 /batch/start 的 body，
# 这里只负责洗干净 + 在造图时写回去（按节点 id 找那颗 LoRA 节点，找不到就跳过，不硬塞）。
def normalize_lora_item(item):
    """一个 LoRA 记录 → {id, type, lora_name, strength_model?, strength_clip?}；没 id 的丢掉。"""
    if not isinstance(item, dict):
        return None
    if item.get("id") is None:
        return None
    out = {
        "id": str(item.get("id")),
        "type": "" if item.get("type") is None else str(item.get("type"))[:60],
        "lora_name": "" if item.get("lora_name") is None else str(item.get("lora_name"))[:240],
    }
    for key in ("strength_model", "strength_clip"):
        val = item.get(key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            out[key] = val
    return out


def normalize_scheme(raw):
    """一个方案 → {name, loras:[…]}；一个 LoRA 都没有 → None（存不了）。"""
    if not isinstance(raw, dict):
        return None
    loras = []
    for item in (raw.get("loras") or []):
        one = normalize_lora_item(item)
        if one is not None:
            loras.append(one)
        if len(loras) >= _SCHEME_MAX_LORAS:
            break
    if not loras:
        return None
    name = str(raw.get("name") or "").strip()[:40] or "方案"
    return {"name": name, "loras": loras}


def normalize_schemes(raw):
    """最多收 BATCH_MAX_SCHEMES 个方案（多的丢掉，不去报错烦人）。"""
    if not isinstance(raw, (list, tuple)):
        return []
    out = []
    for one in raw:
        clean = normalize_scheme(one)
        if clean is not None:
            out.append(clean)
        if len(out) >= BATCH_MAX_SCHEMES:
            break
    return out


def normalize_assign(raw, total):
    """每张用哪个方案：-1 = 不换。长度对齐这一轮要排的张数。"""
    try:
        total = max(0, int(total))
    except Exception:
        total = 0
    if not isinstance(raw, (list, tuple)):
        raw = []
    out = []
    for i in range(total):
        val = raw[i] if i < len(raw) else -1
        try:
            val = int(val)
        except Exception:
            val = -1
        out.append(val)
    return out


def pick_scheme(schemes, assign, index):
    """第 index 张（从 0 数）该用哪个方案；没点 / 越界 → None。"""
    if not schemes:
        return None
    if isinstance(assign, (list, tuple)) and 0 <= index < len(assign):
        which = assign[index]
        if isinstance(which, int) and not isinstance(which, bool) and 0 <= which < len(schemes):
            return schemes[which]
    return None


def apply_lora_scheme(prompt, scheme):
    """把方案里记的 LoRA 写回这张图的 API 图；返回改了几颗。

    ⚠️ 只认"这颗节点还在、而且它真有 lora_name 这个输入"—— 工作流改过之后
    方案就可能对不上，那种情况**跳过**，绝不硬塞（塞错了比不塞更糟）。
    """
    if not isinstance(scheme, dict):
        return 0
    changed = 0
    for item in (scheme.get("loras") or []):
        node = prompt.get(str(item.get("id")))
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or "lora_name" not in inputs:
            continue
        if item.get("lora_name"):
            inputs["lora_name"] = item["lora_name"]
        for key in ("strength_model", "strength_clip"):
            # 连线过来的（list）不算、当前不是数字的也不算 —— 别把工作流的连线值覆盖掉
            if key in item and isinstance(inputs.get(key), (int, float)) and not isinstance(inputs.get(key), bool):
                inputs[key] = item[key]
        changed += 1
    return changed


# ---------------------------------------------------------------- 自定义音效（批 C1）
# 他 2026-10-05 要的：「至于多少秒响一声，设专门的编辑按钮，自己定，包括音效也可以自己导入文件」。
# 文件落在节点自己的 web/sounds/ 里（ComfyUI 把整个 web 目录按 /extensions/<目录名>/ 静态服务，
# 所以存进去就能直接当 <audio src> 播）；**不写进工作流**（不然每个工作流都背着一个音频文件）。
def save_sound(data_url, original_name=""):
    """把前端读出来的 data URL 落盘；返回 (ok, 文件名 或 错误说明)。"""
    if not isinstance(data_url, str) or not data_url.startswith("data:"):
        return False, "音效文件读出来的不是 data URL"
    head, _, b64 = data_url.partition(",")
    if not b64:
        return False, "音效文件里没有内容"
    mime = head[5:].split(";")[0].strip().lower()
    ext = _SOUND_MIME_EXT.get(mime) or os.path.splitext(str(original_name or ""))[1].lower()
    if ext not in _SOUND_EXT:
        ext = ".mp3"
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        return False, "音效文件解不出来（不是合法的 base64）"
    if not raw:
        return False, "音效文件是空的"
    if len(raw) > SOUND_MAX_BYTES:
        return False, "音效文件太大了（%.1f MB，上限 %d MB）" % (len(raw) / 1048576.0, SOUND_MAX_BYTES // 1048576)
    try:
        os.makedirs(SOUND_DIR, exist_ok=True)
        # 文件名统一换成 sound_<毫秒><后缀>：中文名 / 重名 / 目录穿越都在这一步没了，
        # 显示用的原名由前端自己留在节点属性里。
        name = "sound_%d%s" % (int(time.time() * 1000), ext)
        with open(os.path.join(SOUND_DIR, name), "wb") as fp:
            fp.write(raw)
    except Exception as exc:
        return False, "音效没能存进磁盘：" + repr(exc)
    return True, name


def find_sync_node(prompt):
    """在工作流的 API 图里找「提示词同步」那个节点（正负提示词就替换在它身上）。"""
    if not isinstance(prompt, dict):
        return None
    for node_id, node in prompt.items():
        if isinstance(node, dict) and node.get("class_type") == "PromptSyncFromTool":
            return node_id
    return None


def build_batch_prompt(template, node_id, seg, index, total, scheme=None):
    """按模板造第 index 张的那份 API 图：换掉正负提示词，顺手给节点改个名字好认。

    给了 `scheme`（LoRA 方案）就把那几颗 LoRA 的设置一并写回去 —— 见 batch C2。
    """
    p = copy.deepcopy(template)
    node = p.setdefault(node_id, {})
    node.setdefault("inputs", {})
    node["inputs"]["positive"] = seg["pos"]
    node["inputs"]["negative"] = seg["neg"]
    meta = node.setdefault("_meta", {})
    if isinstance(meta, dict):
        title = seg["note"] or ("套图 %d/%d" % (index + 1, total))
        if scheme:
            title = "%s · %s" % (title, scheme["name"])       # 这张用的是哪个方案，看标题就知道
            apply_lora_scheme(p, scheme)
        meta["title"] = title
    elif scheme:
        apply_lora_scheme(p, scheme)
    return p


def randomize_seeds(prompt):
    """把所有 seed / noise_seed 换成随机值（连线过来的不算）。返回换了几处。"""
    n = 0
    for node in prompt.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        if not isinstance(inputs, dict):
            continue
        for key in ("seed", "noise_seed"):
            val = inputs.get(key)
            if isinstance(val, int) and not isinstance(val, bool):
                inputs[key] = random.randint(0, 0xFFFFFFFFFFFFFFFF)
                n += 1
    return n


def output_node_ids(prompt, mapping=None):
    """自己挑出"要执行的输出节点"。

    和 ComfyUI 的 `execution.validate_prompt()` 里那段逻辑一致（只认 OUTPUT_NODE），
    但这里是同步的、不用等事件循环 —— 喂饭线程里没法 await。
    """
    if mapping is None:
        try:
            import nodes as comfy_nodes
            mapping = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
        except Exception:
            mapping = {}
    out = []
    for node_id, node in prompt.items():
        cls = node.get("class_type") if isinstance(node, dict) else None
        if cls and getattr(mapping.get(cls), "OUTPUT_NODE", False) is True:
            out.append(node_id)
    return out


def _prompt_finished(queue, prompt_id):
    """这张出完了没有：进了 history 算完；既不在 history 也不在队列里（被取消了）也算结束。"""
    try:
        if queue.get_history(prompt_id=prompt_id):
            return True
        running, queued = queue.get_current_queue_volatile()
        for item in list(running) + list(queued):
            try:
                if item[1] == prompt_id:
                    return False
            except Exception:
                continue
        return True
    except Exception:
        return True


def batch_status():
    with _batch_lock:
        return dict(_batch)


def _set_status(**kw):
    with _batch_lock:
        _batch.update(kw)
        snapshot = dict(_batch)
    if PromptServer is not None:
        try:
            PromptServer.instance.send_sync("prompt_sync.batch", snapshot)
        except Exception:
            pass
    return snapshot


def _next_queue_number():
    """给排队项取一个递增的号（ComfyUI 的队列是按这个号排序的）。"""
    try:
        inst = PromptServer.instance
        with _batch_lock:
            n = float(getattr(inst, "number", 0) or 0)
            inst.number = n + 1
        return n
    except Exception:
        return time.time()


def _hold_if_paused(stop_event, pause_event, sleep, notify, done, ids, rest_left=0):
    """暂停期间把喂饭线程挂住，返回 True = 挂着挂着被「停止」了（调用方该收手）。

    为什么醒一下看一下、而不是 `pause_event.wait()`：喂饭线程里的 sleep 是**注入**的
    （自测里换成"只记一下调用"的假函数），用 wait() 的话自测里"暂停 → 立刻恢复"这段
    会真的挂死。0.5 秒醒一次的代价可以忽略（一晚上也就醒几千次）。

    ⚠️ 这个函数只在**两张之间**被调到 —— 正在出的那一张不会被它打断。
    他要的就是这个：「如果生成到一半不能暂停，那就把这张图生成之后再暂停」。
    """
    if not pause_event.is_set():
        return False
    notify(running=True, stage="paused", rest_left=rest_left, done=done, prompt_ids=list(ids))
    while pause_event.is_set() and not stop_event.is_set():
        sleep(BATCH_POLL_INTERVAL)
    return stop_event.is_set()


def run_batch(template, node_id, segments, rest_seconds, randomize, client_id=None,
              stop_event=None, queue=None, sleep=None, status_cb=None, pause_event=None,
              schemes=None, assign=None):
    """喂饭线程本体（纯逻辑，自测里用假的 queue / sleep 直接跑）。

    `schemes` / `assign`：LoRA 方案 + "第几张用第几个"（批 C2；不传就是一张都不换）。

    返回 (出完几张, 状态字符串)。
    """
    stop_event = stop_event or _batch_stop
    pause_event = pause_event or _batch_pause
    sleep = sleep or time.sleep
    notify = status_cb or _set_status
    if queue is None:
        queue = PromptServer.instance.prompt_queue

    total = len(segments)
    done = 0
    ids = []
    notify(running=True, stage="queued", index=1, planned=total, done=0,
           rest_left=0, error="", prompt_ids=[], note="", scheme="")

    for i, seg in enumerate(segments):
        if stop_event.is_set():
            break
        # 暂停落在"两张之间"：这里也查一次，覆盖"上一张出完时按下的暂停"
        if _hold_if_paused(stop_event, pause_event, sleep, notify, done, ids):
            break
        scheme = pick_scheme(schemes, assign, i)
        prompt = build_batch_prompt(template, node_id, seg, i, total, scheme)
        if randomize:
            randomize_seeds(prompt)
        prompt_id = str(uuid.uuid4())
        ids.append(prompt_id)
        extra_data = {"batch_index": i + 1, "batch_total": total}
        if scheme:
            extra_data["batch_scheme"] = scheme["name"]
        if client_id:
            extra_data["client_id"] = client_id
        notify(running=True, stage="queued", index=i + 1, done=done, rest_left=0,
               scheme=(scheme["name"] if scheme else ""),
               note=seg["note"] or ("套图 %d/%d" % (i + 1, total)), prompt_ids=list(ids))
        try:
            queue.put((_next_queue_number(), prompt_id, prompt, extra_data,
                       output_node_ids(prompt), {}))
        except Exception as exc:
            notify(running=False, stage="error", error="排队失败：" + repr(exc))
            return done, "error"

        # ---- 等这张出完（这期间按暂停不打断它，等他这张出完再说）----
        deadline = time.time() + BATCH_WAIT_TIMEOUT
        while True:
            if stop_event.is_set():
                break
            if _prompt_finished(queue, prompt_id):
                break
            if time.time() > deadline:
                notify(running=False, stage="error", error="等这张出图超时了（6 小时）")
                return done, "error"
            sleep(BATCH_POLL_INTERVAL)
        if stop_event.is_set():
            break
        done += 1
        notify(running=True, stage="queued", index=i + 1, done=done, prompt_ids=list(ids))

        # ---- 这张出完了：如果暂停键是立着的，就停在这儿（他原话："把这张图生成之后再暂停"）----
        if _hold_if_paused(stop_event, pause_event, sleep, notify, done, ids):
            break

        # ---- 队列外面歇一会儿（歇的时候 ComfyUI 空闲，随时能停）----
        if i < total - 1 and rest_seconds > 0:
            left = int(rest_seconds)
            while left > 0 and not stop_event.is_set():
                if _hold_if_paused(stop_event, pause_event, sleep, notify, done, ids, rest_left=left):
                    break
                notify(running=True, stage="resting", rest_left=left, done=done, prompt_ids=list(ids))
                step = 1 if left <= 2 else 2
                sleep(step)
                left -= step
            notify(running=True, stage="queued", rest_left=0, done=done)

    stopped = stop_event.is_set()
    notify(running=False, stage="stopped" if stopped else "done", rest_left=0,
           done=done, prompt_ids=list(ids), error="", paused=False)
    _batch_stop.clear()
    _batch_pause.clear()
    return done, ("stopped" if stopped else "done")


def stop_batch(queue=None):
    """⏹ 停止：不再排下一张 + 收掉还没开始的那几张 + 正在跑的那张也打断。"""
    if queue is None:
        try:
            queue = PromptServer.instance.prompt_queue
        except Exception:
            queue = None
    stop_event = _batch_stop
    stop_event.set()
    _batch_pause.clear()          # 停止连"暂停中"一起收掉，免得下一轮开跑还挂着暂停
    ids = set(_batch.get("prompt_ids") or [])
    if queue is not None and ids:
        try:
            while queue.delete_queue_item(lambda item: item[1] in ids):
                pass
        except Exception:
            pass
        for pid in list(ids):
            try:
                if queue.interrupt_if_running(pid):
                    break
            except Exception:
                break
    return _set_status(running=False, stage="stopped", rest_left=0, paused=False)


def pause_batch(paused=True):
    """⏸ 暂停 / ▶ 继续。返回 (ok, 错误说明)。

    ⚠️ 只立旗、**不打断正在出的那一张** —— 真正挂住喂饭线程是在 `run_batch` 的
    "两张之间"那个落点上（见 `_hold_if_paused`）。他要的正是这个语义。
    """
    if paused:
        if not _batch.get("running"):
            return False, "现在没有正在排的套图 —— 没什么可暂停的"
        _batch_pause.set()
        _set_status(paused=True)
    else:
        _batch_pause.clear()
        _set_status(paused=False)
    return True, ""


def clear_batch():
    """🗑 清除进程：把这一轮收掉 + 清空工具推来的那几段，回到"等工具再推一次"。

    他 2026-10-02 要的：「暂停或者还没开始的时候，点击这个可以清除当前进程，等待工具再次同步」。
    所以：**正在出图（在排、又没暂停）时不许清** —— 让他先按「⏸ 暂停排队」或「⏹ 停止」；
    暂停中允许清：先把挂着的喂饭线程叫停，等它收尾了再把状态重置成 idle（否则线程尾巴会把
    "已停止"盖回来）。

    返回 (ok, 错误说明)。
    """
    if _batch.get("running") and not _batch.get("paused"):
        return False, "现在正在排这一套 —— 先点「⏸ 暂停排队」（这一张出完就停）或「⏹ 停止」，再清除"

    def _reset_idle():
        _set_status(segments=[], running=False, paused=False, stage="idle", index=0, planned=0,
                    done=0, rest_left=0, error="", prompt_ids=[], note="")

    _batch_pause.clear()
    if _batch.get("running"):
        # 暂停中：叫停喂饭线程 → 等它自己收尾（**不能在接口里 sleep**，那会卡住 ComfyUI 的整个服务）
        _batch_stop.set()
        def _when_idle():
            for _ in range(30):
                if not _batch.get("running"):
                    break
                time.sleep(0.1)
            _batch_stop.clear()
            _reset_idle()
        threading.Thread(target=_when_idle, name="prompt-tool-batch-clear", daemon=True).start()
        return True, ""

    _batch_stop.clear()
    _reset_idle()
    return True, ""


def start_error_code(err):
    """把"开不了排"的原因归个类给前端（前端据此决定用**中性提示**还是红字报错）。

    ⚠️ 为什么要有它（他 2026-10-03 提的）：很多人会先点「▶ 开始排队」再看工具推没推，
    那时后端回的是"还没有收到任何一段提示词 —— 先在工具里点「🎞 套图」推过来"，
    而前端把它当 error → 节点上红字「出错：…」，看着像坏了。其实这只是"还没推过来"。
    所以给个机器可读的 code：no-segments = 还没推过来（中性提示）；busy = 上一轮还在排；
    no-sync-node / no-output-node = 工作流缺东西；其它一律 error。
    """
    if err.startswith("还没有收到"):
        return "no-segments"
    if err.startswith("上一轮"):
        return "busy"
    if "提示词同步" in err:
        return "no-sync-node"
    if "输出节点" in err:
        return "no-output-node"
    return "error"


def start_batch(prompt, segments, rest_seconds, randomize, client_id=None, queue=None,
                schemes=None, assign=None):
    """开一轮套图。返回 (ok, 错误说明)。"""
    if _batch.get("running"):
        return False, "上一轮还在排（想重排先点「⏹ 停止」）"
    if not segments:
        return False, "还没有收到任何一段提示词 —— 先在工具里点「🎞 套图」把这一套推过来"
    node_id = find_sync_node(prompt)
    if node_id is None:
        return False, "当前工作流里没有「提示词同步（来自提示词工具）」节点 —— 先把它放进来并接好线"
    if not output_node_ids(prompt):
        return False, "当前工作流里没有输出节点（保存图片/预览那类）—— 排了也不会出图"

    try:
        rest = max(0, min(BATCH_MAX_REST, int(rest_seconds)))
    except Exception:
        rest = 60

    schemes = normalize_schemes(schemes)
    assign = normalize_assign(assign, len(segments))

    _batch_stop.clear()
    _batch_pause.clear()          # 新一轮一律不带着上次的暂停状态
    _set_status(running=True, paused=False, stage="queued", error="", done=0, rest_left=0,
                planned=len(segments), index=1, prompt_ids=[], note="", scheme="")
    t = threading.Thread(
        target=run_batch,
        args=(prompt, node_id, segments, rest, bool(randomize), client_id),
        kwargs=dict({"queue": queue} if queue is not None else {},
                    schemes=schemes, assign=assign),
        name="prompt-tool-batch", daemon=True)
    t.start()
    return True, ""


async def batch_push(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    segs = normalize_segments((body or {}).get("segments"))
    if not segs:
        return _json(allow, {"success": False, "error": "这一套里一段有效的提示词都没有"}, status=400)
    _set_status(segments=segs, done=0, error="", stage="idle", note="", rest_left=0, prompt_ids=[])
    return _json(allow, {"success": True, "count": len(segs), "segments": segs})


async def batch_status_get(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    st = batch_status()
    st["success"] = True
    # 段数只报个数（前端不需要正文），另外把每段的备注带上：节点上的"第几张用哪个方案"
    # 那张表就是拿备注来认人的（批 C2）。
    segs = st.get("segments") or []
    st["segment_notes"] = [str((s or {}).get("note") or "") for s in segs if isinstance(s, dict)]
    st["segments"] = len(segs)
    return _json(allow, st)


async def batch_start(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    prompt = body.get("prompt")
    if not isinstance(prompt, dict) or not prompt:
        return _json(allow, {"success": False, "error": "没收到工作流（前端 graphToPrompt 那份）"}, status=400)

    segs = normalize_segments(body.get("segments"))
    if not segs:
        segs = list(_batch.get("segments") or [])
    try:
        cap = int(body.get("max", 4))
    except Exception:
        cap = 4
    cap = max(1, min(BATCH_MAX_SEGMENTS, cap))
    segs = segs[:cap]

    ok, err = start_batch(prompt, segs, body.get("rest", 60), body.get("randomSeed", True),
                          body.get("clientId"), schemes=body.get("schemes"),
                          assign=body.get("assign"))
    if not ok:
        return _json(allow, {"success": False, "error": err, "code": start_error_code(err)}, status=400)
    st = batch_status()
    st["success"] = True
    return _json(allow, st)


async def batch_stop(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    st = stop_batch()
    st["success"] = True
    return _json(allow, st)


async def batch_pause(request):
    """⏸ 暂停 / ▶ 继续：body 里 `{"paused": true/false}`；不给就按当前状态取反。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        body = None
    want = (body or {}).get("paused")
    if not isinstance(want, bool):
        want = not bool(_batch.get("paused"))
    ok, err = pause_batch(want)
    if not ok:
        return _json(allow, {"success": False, "error": err}, status=400)
    st = batch_status()
    st["success"] = True
    return _json(allow, st)


async def batch_clear(request):
    """🗑 清除进程：收掉这一轮 + 清空已推来的那几段，回到"等工具再推一次"。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    ok, err = clear_batch()
    if not ok:
        return _json(allow, {"success": False, "error": err}, status=400)
    st = batch_status()
    st["success"] = True
    return _json(allow, st)


async def ping(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    return _json(allow, {"success": True, "node": "PromptSync", "version": NODE_VERSION})


async def timer_sound_upload(request):
    """收一个自定义音效文件（前端用 FileReader 读成 data URL 发过来，见批 C1）。

    存到 `<节点目录>/web/sounds/` —— ComfyUI 把 web 目录按 `/extensions/<目录名>/` 静态服务，
    所以存完前端就能直接 `<audio src="/extensions/ComfyUI-PromptSync/sounds/xxx.mp3">` 播。
    """
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    ok, res = save_sound(body.get("data"), body.get("name"))
    if not ok:
        return _json(allow, {"success": False, "error": res}, status=400)
    original = "" if body.get("name") is None else str(body.get("name"))[:80]
    return _json(allow, {"success": True, "file": res, "name": original,
                         "url": SOUND_URL_PREFIX + res})


# ==================== 图片存档 / 画廊（2026-10-24 第 234 批起） ====================
#   他 220 / 231 批定的口径：
#     ① 图存 `桌面\工具 X.X 正式版\图片存档\{下载,收藏,回收站,编辑栏,素材}`，**日期分组在里面**；
#     ② 上限 主页 500 / 回收站 100，**收藏不占上限、永不被顶掉**；
#     ③ 删除 = 进回收站，可恢复；④ 手动存档不再弹选路径。
#   **真相来源 = 磁盘目录**（在"下载"就是主页、在"收藏"就是收藏），`index.json` 只补元信息
#   （原始位置、收藏时间）。这样即使 json 丢了/写坏了，靠扫目录也能把画廊重建出来。
ARCHIVE_DIRS = ("下载", "收藏", "回收站", "编辑栏", "素材")
ARCHIVE_LIMIT_HOME = 500
ARCHIVE_LIMIT_TRASH = 100
ARCHIVE_LIMIT_EDIT = 200                    # ★ 273w：编辑栏上限（他说 200）
ARCHIVE_PACK_VERSION = "8.0"
_IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
_index_lock = threading.Lock()


def _desktop_dir():
    """桌面目录（中英文系统都认；都没有就退回用户主目录）。"""
    home = os.path.expanduser("~")
    for name in ("Desktop", "桌面"):
        d = os.path.join(home, name)
        if os.path.isdir(d):
            return d
    return home


def archive_root():
    """存档根目录。环境变量 PC_ARCHIVE_ROOT 可覆盖（测试 / 以后挪盘用）。"""
    env = os.environ.get("PC_ARCHIVE_ROOT")
    if env:
        return os.path.abspath(env)
    return os.path.join(_desktop_dir(), "工具 " + ARCHIVE_PACK_VERSION + " 正式版", "图片存档")


def ensure_archive_dirs():
    root = archive_root()
    for d in ARCHIVE_DIRS:
        try:
            os.makedirs(os.path.join(root, d), exist_ok=True)
        except Exception:
            pass
    return root


def _index_path():
    return os.path.join(archive_root(), "index.json")


def load_index():
    try:
        with open(_index_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("items"), dict):
            return data
    except Exception:
        pass
    return {"version": 1, "items": {}}


def save_index(data):
    p = _index_path()
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with _index_lock:
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            os.replace(tmp, p)
        return True
    except Exception:
        return False


def _safe_rel(rel):
    """前端给的相对路径 → 干净相对路径（只认那四个顶层目录，挡掉 ../）。"""
    s = str(rel or "").replace("\\", "/").strip().lstrip("/")
    if not s:
        return None
    parts = s.split("/")
    if ".." in parts or parts[0] not in ARCHIVE_DIRS:
        return None
    return s


def _abs_of(rel):
    r = _safe_rel(rel)
    if not r:
        return None
    root = os.path.abspath(archive_root())
    p = os.path.abspath(os.path.join(root, r.replace("/", os.sep)))
    if not (p == root or p.startswith(root + os.sep)):
        return None
    return p


def _today():
    return time.strftime("%Y-%m-%d")


def _scan_page(page):
    """扫某一页的目录，返回文件列表（按修改时间新→旧）。"""
    root = ensure_archive_dirs()
    sub = {"home": "下载", "fav": "收藏", "trash": "回收站", "edit": "编辑栏",
           "material": "素材"}.get(page)
    if not sub:
        return None
    base = os.path.join(root, sub)
    out = []
    for dirpath, _dirs, files in os.walk(base):
        for fn in files:
            if not fn.lower().endswith(_IMG_EXT):
                continue
            full = os.path.join(dirpath, fn)
            try:
                stt = os.stat(full)
            except Exception:
                continue
            out.append({
                "rel": os.path.relpath(full, root).replace(os.sep, "/"),
                "name": fn,
                "at": int(stt.st_mtime * 1000),
                "size": stt.st_size,
                "day": os.path.basename(dirpath),
            })
    out.sort(key=lambda x: x["at"], reverse=True)
    return out


def _unique_dst(folder, name):
    """同一目录里重名就加 -1 / -2 …"""
    base, ext = os.path.splitext(name)
    dst = os.path.join(folder, name)
    i = 1
    while os.path.exists(dst):
        dst = os.path.join(folder, base + "-" + str(i) + ext)
        i += 1
    return dst


def _move_into(full_from, subdir, keep_name=None):
    """把文件搬到 `root/<subdir>/<今天>/` 下，返回新的 rel。"""
    root = ensure_archive_dirs()
    folder = os.path.join(root, subdir, _today())
    os.makedirs(folder, exist_ok=True)
    name = keep_name or os.path.basename(full_from)
    dst = _unique_dst(folder, name)
    shutil.move(full_from, dst)
    return os.path.relpath(dst, root).replace(os.sep, "/")


def _output_dir():
    try:
        import folder_paths
        return folder_paths.get_output_directory()
    except Exception:
        return None


def prune_archive(keep_trash=True):
    """按上限清理：主页 500（最旧的先走）、回收站 100。收藏/素材 一个都不动。"""
    root = ensure_archive_dirs()
    removed = {"home": 0, "trash": 0, "edit": 0}
    idx = load_index()
    for key, sub, limit in (("home", "下载", ARCHIVE_LIMIT_HOME), ("trash", "回收站", ARCHIVE_LIMIT_TRASH),
                            ("edit", "编辑栏", ARCHIVE_LIMIT_EDIT)):
        items = _scan_page(key) or []
        over = len(items) - limit
        if over <= 0:
            continue
        for it in items[-over:]:                      # items 是新→旧，末尾最旧
            p = _abs_of(it["rel"])
            if not p:
                continue
            try:
                os.remove(p)
                removed[key] += 1
                idx["items"].pop(it["rel"], None)
            except Exception:
                pass
    if removed["home"] or removed["trash"] or removed["edit"]:
        save_index(idx)
    return removed


async def gallery_list(request):
    """一页的图片列表（分页）。page = home / fav / trash / ext。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    page = request.query.get("page", "home")
    try:
        offset = max(0, int(request.query.get("offset", 0)))
    except Exception:
        offset = 0
    try:
        limit = min(200, max(1, int(request.query.get("limit", 60))))
    except Exception:
        limit = 60
    items = _scan_page(page)
    if items is None:
        return _json(allow, {"success": False, "error": "page 只认 home / fav / trash / ext / edit"}, status=400)
    idx = load_index()
    # ★ 273n（他第 9 条）：老图当年没记 kind → 读 PNG 里的 prompt 现补一次，并写回 index（只补一次）
    fixed = 0
    for it in items:
        m0 = idx["items"].get(it["rel"]) or {}
        if m0.get("kind"):
            continue
        try:
            pr = png_prompt_of(_abs_of(it["rel"]))
            kk = _classify_prompt(pr) if pr else "gen"
        except Exception:
            kk = "gen"
        idx["items"].setdefault(it["rel"], {})["kind"] = kk
        fixed += 1
    if fixed:
        save_index(idx)
    total = len(items)
    out = []
    for it in items[offset:offset + limit]:
        meta = idx["items"].get(it["rel"]) or {}
        it2 = dict(it)
        it2["url"] = "/prompt_sync/gallery/img?rel=" + urllib.parse.quote(it["rel"])
        it2["fav"] = it["rel"].startswith("收藏/")
        it2["origin"] = meta.get("origin") or ""
        it2["batch"] = meta.get("batch") or ""
        it2["kind"] = meta.get("kind") or "gen"   # ★ 273k：文生图/局部重绘（老图没记就按文生图）
        out.append(it2)
    return _json(allow, {"success": True, "page": page, "total": total, "offset": offset,
                         "limit": limit, "items": out, "root": archive_root(),
                         "limits": {"home": ARCHIVE_LIMIT_HOME, "trash": ARCHIVE_LIMIT_TRASH,
                                    "edit": ARCHIVE_LIMIT_EDIT, "material": 0}})


async def gallery_material(request):
    """把东西放进「素材栏」（364 批，叠图用的素材）。
    两种入法：① `{"rel": "下载/…png"}` = 把存档里某张图**复制**一份进去；
             ② `{"png": "data:image/png;base64,…", "name": "发卡"}` = 直接把一段 PNG 写进去（蒙版编辑器裁出来的）。
    素材不做上限清理（跟收藏一样，不会被自动删）。
    """
    import base64
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        data = await request.json()
    except Exception:
        data = {}
    data = data or {}
    name = str(data.get("name") or "").strip()
    png = str(data.get("png") or "")
    rel = str(data.get("rel") or "").strip().replace("\\\\", "/")
    root = ensure_archive_dirs()
    folder = os.path.join(root, "素材", _today())
    try:
        os.makedirs(folder, exist_ok=True)
    except Exception:
        pass
    # 文件名：只留中文/字母/数字/-/_，其它一律去掉（避免路径穿越与怪字符）
    safe = "".join(ch for ch in name if (ch.isalnum() or ch in "-_"))[:40] or "素材"
    try:
        if png:
            b64 = png.split(",", 1)[1] if "," in png else png
            raw = base64.b64decode(b64)
            if not raw:
                return _json(allow, {"success": False, "error": "empty png"}, status=400)
            dst = _unique_dst(folder, safe + ".png")
            tmp = dst + ".tmp"
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, dst)
        elif rel:
            src = _abs_of(rel)
            if not src or not os.path.isfile(src):
                return _json(allow, {"success": False, "error": "find: no such image"}, status=404)
            base0 = os.path.splitext(os.path.basename(src))[0] or "素材"
            dst = _unique_dst(folder, base0 + ".png" if src.lower().endswith(".png") else base0 + ".png")
            if src.lower().endswith(".png"):
                shutil.copy2(src, dst)                  # 原样复制，不重编码
            else:                                       # 非 PNG（webp/jpg）才转一次
                try:
                    from PIL import Image
                    with Image.open(src) as im:
                        im.convert("RGBA").save(dst, "PNG")
                except Exception:
                    shutil.copy2(src, dst)
        else:
            return _json(allow, {"success": False, "error": "need rel or png"}, status=400)
    except Exception as exc:
        return _json(allow, {"success": False, "error": repr(exc)}, status=500)
    rel_out = os.path.relpath(dst, root).replace(os.sep, "/")
    return _json(allow, {"success": True, "rel": rel_out, "name": os.path.basename(dst)})


async def gallery_img(request):
    """把存档目录里的图发给浏览器（不能走 /view，那只看 output）。"""
    p = _abs_of(request.query.get("rel", ""))
    allow = origin_allow(request)
    if allow is False:
        return web.Response(status=403, text="cross-site blocked")
    if not p or not os.path.isfile(p):
        return web.Response(status=404, text="not found", headers=cors_headers(allow))
    try:
        return web.FileResponse(p, headers=cors_headers(allow))
    except Exception as exc:
        return web.Response(status=500, text="读不出来：" + repr(exc), headers=cors_headers(allow))



def png_prompt_of(path):
    """★ 273n：读一张 PNG 里的 prompt 元数据（老图补 kind 用；读不到就 None，绝不抛）。"""
    try:
        from PIL import Image
        with Image.open(path) as im:
            raw = im.info.get("prompt")
        return json.loads(raw) if raw else None
    except Exception:
        return None

def _classify_prompt(prompt):
    """★ 273k：这张图是哪条工作流出的 —— "inpaint"=局部重绘（带 LoadImage / 内补节点），"gen"=文生图。"""
    try:
        s = json.dumps(prompt or {}, ensure_ascii=False)
    except Exception:
        return "gen"
    for k in ("VAEEncodeForInpaint", "SetLatentNoiseMask", "InpaintModelConditioning", "LoadImageMask", "LoadImage"):
        if k in s:
            return "inpaint"
    return "gen"

def archive_put_png(image, prompt=None, extra_pnginfo=None, prune=False, batch=None):
    """把一张 IMAGE（tensor / ndarray）存进存档「下载/今天/」，**带 workflow + prompt 元数据**。

    元数据是"安全复现"的命根子：PNG 里那两段原文（`workflow` / `prompt`）就是复现的全部依据，
    所以这里和 ComfyUI 的 SaveImage 一样用 PngInfo 写进去，**绝不重编码成别的格式**。
    """
    import numpy as np                       # 放函数里：没有 ComfyUI / torch 的环境也能导入本模块
    from PIL import Image as PILImage
    from PIL.PngImagePlugin import PngInfo

    root = ensure_archive_dirs()
    folder = os.path.join(root, "下载", _today())
    os.makedirs(folder, exist_ok=True)
    arr = image
    try:
        if hasattr(image, "cpu"):
            arr = image.cpu().numpy()
        elif hasattr(image, "numpy"):
            arr = image.numpy()
        else:
            arr = np.asarray(image)
    except Exception:
        arr = np.asarray(image)
    a = np.clip(255.0 * arr, 0, 255).astype(np.uint8)
    if a.ndim == 2:
        a = np.stack([a] * 3, axis=-1)
    im = PILImage.fromarray(a)
    meta = PngInfo()
    if prompt is not None:
        try:
            meta.add_text("prompt", json.dumps(prompt, ensure_ascii=False))
        except Exception:
            pass
    if extra_pnginfo:
        for k, v in (extra_pnginfo or {}).items():
            try:
                meta.add_text(str(k), json.dumps(v, ensure_ascii=False))
            except Exception:
                pass
    name = "pctool_" + time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6] + ".png"
    dst = os.path.join(folder, name)
    im.save(dst, pnginfo=meta, compress_level=4)
    rel = os.path.relpath(dst, root).replace(os.sep, "/")
    idx = load_index()
    entry = {"at": int(time.time() * 1000), "auto": True, "kind": _classify_prompt(prompt)}
    if batch:
        entry["batch"] = str(batch)          # ★ 237 批：同一次执行存的多张共用一个 batch → 前端按组成组显示
    idx["items"][rel] = entry
    save_index(idx)
    if prune:
        prune_archive()
    return rel


async def gallery_meta(request):
    """读一张存档图里的元数据（`workflow` + `prompt`）——「请神上身」（安全复现）就靠这两段。

    240 批：图存进存档时就带了这两段（archive_put_png 写的），这里只负责原样读出来给前端，**不做任何解析**。
    """
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    rel = request.query.get("rel", "")
    p = _abs_of(rel)
    if not p or not os.path.isfile(p):
        return _json(allow, {"success": False, "error": "这张图不在了"}, status=404)
    try:
        from PIL import Image
        with Image.open(p) as im:
            info = dict(im.info)
            size = list(im.size)
    except Exception as exc:
        return _json(allow, {"success": False, "error": "读不出图片元数据：" + repr(exc)}, status=500)
    out = {"success": True, "rel": rel, "size": size, "has": {}}
    for key in ("prompt", "workflow"):
        raw = info.get(key)
        if not raw:
            out[key] = None
            out["has"][key] = False
            continue
        try:
            out[key] = json.loads(raw)
            out["has"][key] = True
        except Exception:
            out[key] = None
            out["has"][key] = False
    return _json(allow, out)


async def gallery_toedit(request):
    """把一张图**复制**一份进「编辑栏」（原图留在原处）。
    ★ 273w（他第 2 条）：重绘/融图/叠图**用到**这张图时自动调它，留下历史。
    同一张原图已经在编辑栏里 → 不重复复制，只把它顶到最前（dup=true）。
    """
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        data = await request.json()
    except Exception:
        data = {}
    rel = str((data or {}).get("rel") or "").strip().replace("\\", "/")
    src = _abs_of(rel)
    if not src or not os.path.isfile(src):
        return _json(allow, {"success": False, "error": "find: no such image"}, status=404)
    if rel.startswith("编辑栏/"):
        return _json(allow, {"success": True, "rel": rel, "dup": True})
    root = ensure_archive_dirs()
    idx = load_index()
    # 去重：同一张原图已经在编辑栏里 → 顶到最前就行
    for k, v in list(idx["items"].items()):
        if k.startswith("编辑栏/") and str((v or {}).get("origin") or "") == rel:
            try:
                os.utime(_abs_of(k), None)
            except Exception:
                pass
            return _json(allow, {"success": True, "rel": k, "dup": True})
    dst_dir = os.path.join(root, "编辑栏", time.strftime("%Y-%m-%d"))
    try:
        os.makedirs(dst_dir, exist_ok=True)
    except Exception:
        pass
    base = os.path.splitext(os.path.basename(src))[0]
    ext = os.path.splitext(src)[1] or ".png"
    dst = os.path.join(dst_dir, base + ext)
    n = 1
    while os.path.exists(dst):
        dst = os.path.join(dst_dir, "%s-%d%s" % (base, n, ext))
        n += 1
    try:
        shutil.copy2(src, dst)
    except Exception as e:
        return _json(allow, {"success": False, "error": "copy failed: %s" % e}, status=500)
    new_rel = os.path.relpath(dst, root).replace(os.sep, "/")
    e = dict(idx["items"].get(rel) or {})
    e["at"] = int(os.stat(dst).st_mtime * 1000)
    e["from"] = "编辑栏"
    e["origin"] = rel
    idx["items"][new_rel] = e
    save_index(idx)
    try:
        prune_archive()
    except Exception:
        pass
    return _json(allow, {"success": True, "rel": new_rel})


async def gallery_save(request):
    """把 ComfyUI output 里的图存进存档（默认「下载」；to=fav 直接进收藏）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    names = body.get("files") or ([body.get("file")] if body.get("file") else [])
    names = [str(n) for n in names if n]
    if not names:
        return _json(allow, {"success": False, "error": "没给文件名"}, status=400)
    to = "收藏" if str(body.get("to") or "") == "fav" else "下载"
    root = ensure_archive_dirs()
    srcdir = _output_dir()
    if not srcdir:
        return _json(allow, {"success": False, "error": "找不到 ComfyUI 的 output 目录"}, status=500)
    idx = load_index()
    saved, skipped = [], []
    for n in names:
        src = os.path.join(srcdir, os.path.basename(n))
        if not os.path.isfile(src):
            skipped.append({"file": n, "why": "output 里没有这个文件"})
            continue
        try:
            rel = _move_into(src, to) if body.get("move") else _copy_into(src, to)
        except Exception as exc:
            skipped.append({"file": n, "why": repr(exc)})
            continue

        # ★ 273o（他第 3 条：局部重绘还是蓝标）→ 从 output 收进来的图也要认出来源
        try:
            kk = _classify_prompt(png_prompt_of(src))
        except Exception:
            kk = "gen"
        idx["items"][rel] = {"at": int(time.time() * 1000), "from": os.path.basename(n), "kind": kk}
        saved.append(rel)
    save_index(idx)
    pr = prune_archive()
    return _json(allow, {"success": True, "saved": saved, "skipped": skipped,
                         "root": root, "pruned": pr, "total": len(_scan_page("home") or [])})


def _copy_into(src, subdir):
    root = ensure_archive_dirs()
    folder = os.path.join(root, subdir, _today())
    os.makedirs(folder, exist_ok=True)
    dst = _unique_dst(folder, os.path.basename(src))
    shutil.copy2(src, dst)
    return os.path.relpath(dst, root).replace(os.sep, "/")


async def gallery_fav(request):
    """收藏 / 取消收藏（在「下载」和「收藏」之间搬文件，不复制 → 只占一份）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    rel = _safe_rel(body.get("rel"))
    if not rel:
        return _json(allow, {"success": False, "error": "rel 不合法"}, status=400)
    p = _abs_of(rel)
    if not p or not os.path.isfile(p):
        return _json(allow, {"success": False, "error": "文件不在了"}, status=404)
    on = bool(body.get("on"))
    idx = load_index()
    is_fav = rel.startswith("收藏/")
    if on and not is_fav:
        new_rel = _move_into(p, "收藏")
        idx["items"].pop(rel, None)
        idx["items"][new_rel] = {"at": int(time.time() * 1000), "favAt": int(time.time() * 1000)}
    elif (not on) and is_fav:
        new_rel = _move_into(p, "下载")
        idx["items"].pop(rel, None)
        idx["items"][new_rel] = {"at": int(time.time() * 1000)}
    else:
        new_rel = rel
    save_index(idx)
    return _json(allow, {"success": True, "rel": new_rel, "fav": on,
                         "url": "/prompt_sync/gallery/img?rel=" + urllib.parse.quote(new_rel)})


async def gallery_trash(request):
    """删除 = 移到回收站（记下原来属于哪一页，恢复时放回去）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    rels = [_safe_rel(x) for x in (body.get("rels") or [])]
    rels = [x for x in rels if x]
    if not rels:
        return _json(allow, {"success": False, "error": "没给要删的图"}, status=400)
    idx = load_index()
    moved = []
    for rel in rels:
        p = _abs_of(rel)
        if not p or not os.path.isfile(p):
            continue
        origin = "收藏" if rel.startswith("收藏/") else "下载"
        try:
            new_rel = _move_into(p, "回收站")
        except Exception:
            continue
        idx["items"].pop(rel, None)
        idx["items"][new_rel] = {"at": int(time.time() * 1000), "origin": origin}
        moved.append(new_rel)
    save_index(idx)
    pr = prune_archive()
    return _json(allow, {"success": True, "moved": moved, "pruned": pr,
                         "trash": len(_scan_page("trash") or [])})


async def gallery_restore(request):
    """从回收站恢复（回到它原来在的那一页）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    rels = [_safe_rel(x) for x in (body.get("rels") or [])]
    rels = [x for x in rels if x]
    idx = load_index()
    back = []
    for rel in rels:
        if not rel.startswith("回收站/"):
            continue
        p = _abs_of(rel)
        if not p or not os.path.isfile(p):
            continue
        meta = idx["items"].get(rel) or {}
        sub = "收藏" if str(meta.get("origin") or "") == "收藏" else "下载"
        try:
            new_rel = _move_into(p, sub)
        except Exception:
            continue
        idx["items"].pop(rel, None)
        idx["items"][new_rel] = {"at": int(time.time() * 1000)}
        back.append(new_rel)
    save_index(idx)
    return _json(allow, {"success": True, "restored": back,
                         "trash": len(_scan_page("trash") or [])})


async def gallery_purge(request):
    """彻底删：指定 rels，或 all=true 清空回收站。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    idx = load_index()
    n = 0
    if body.get("all"):
        for it in (_scan_page("trash") or []):
            p = _abs_of(it["rel"])
            if p:
                try:
                    os.remove(p)
                    n += 1
                    idx["items"].pop(it["rel"], None)
                except Exception:
                    pass
    else:
        for rel in [_safe_rel(x) for x in (body.get("rels") or [])]:
            if not rel:
                continue
            p = _abs_of(rel)
            if not p:
                continue
            try:
                os.remove(p)
                n += 1
                idx["items"].pop(rel, None)
            except Exception:
                pass
    save_index(idx)
    return _json(allow, {"success": True, "removed": n,
                         "trash": len(_scan_page("trash") or [])})


# ---------------------------------------------------------------- 273h 批：画廊的"手画蒙版"
#   他："画廊右键没有那个「在遮罩编辑器里打开」，所以现在画廊并没有多功能的功能，应该加才对。
#   具体实行方式是在画廊的两个输出端口都连接时，画廊第 3 层会有在遮罩编辑器里打开这个按键。"
#   → 蒙版单独存成一张 PNG（不动原图、绝不重编码原图），画廊的 MASK 输出优先读它。
MASK_DIR = "掩码"


def _mask_dir():
    d = os.path.join(archive_root(), MASK_DIR)
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def mask_path_of(rel):
    """某个存档图对应的蒙版文件路径（没有就返回一个"应该放哪儿"的路径）。"""
    r = _safe_rel(rel)
    if not r:
        return None
    base = r.replace("/", "~")
    if base.lower().endswith(".png"):
        base = base[:-4]
    return os.path.join(_mask_dir(), base + "_mask.png")


def stack_path_of(rel):
    """「叠图合成图」的固定落点：掩码/<rel~>_stack.png（393 批）。
    为什么单独存一份：画廊节点的 IMAGE 输出必须给模型**已经贴好素材**的那张，
    靠文件名去"素材"目录里猜太脆（会被截断/重名），所以按原图的 rel 固定算一个名字。"""
    p = mask_path_of(rel)
    if not p:
        return None
    if p.endswith("_mask.png"):
        return p[: -len("_mask.png")] + "_stack.png"
    return p + "_stack.png"


def layers_path_of(rel):
    """某个存档图对应的「图层记录」文件（素材模式摆的素材/绘画层，383 批）。"""
    r = _safe_rel(rel)
    if not r:
        return None
    base = r.replace("/", "~")
    if base.lower().endswith(".png"):
        base = base[:-4]
    return os.path.join(_mask_dir(), base + "_layers.json")


async def gallery_layers_get(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    rel = _safe_rel(request.query.get("rel"))
    p = layers_path_of(rel) if rel else None
    if not p or not os.path.isfile(p):
        return _json(allow, {"success": True, "exists": False})
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = f.read()
    except Exception as exc:
        return _json(allow, {"success": False, "error": repr(exc)}, status=500)
    return _json(allow, {"success": True, "exists": True, "text": data})


async def gallery_layers_put(request):
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        body = {}
    rel = _safe_rel((body or {}).get("rel"))
    data = (body or {}).get("data")
    p = layers_path_of(rel) if rel else None
    if not p:
        return _json(allow, {"success": False, "error": "bad rel"}, status=400)
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        txt = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(txt)
        os.replace(tmp, p)
    except Exception as exc:
        return _json(allow, {"success": False, "error": repr(exc)}, status=500)
    return _json(allow, {"success": True, "path": p})


def mask_exists(rel):
    p = mask_path_of(rel)
    return bool(p and os.path.isfile(p))


def mask_save_bytes(rel, data):
    p = mask_path_of(rel)
    if not p:
        return None
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, p)
    return p


def mask_drop(rel):
    p = mask_path_of(rel)
    try:
        if p and os.path.isfile(p):
            os.remove(p)
            return True
    except Exception:
        pass
    return False


async def gallery_mask_get(request):
    """取某张图的蒙版（没有就 exists=false；前端开局用它判断按钮要不要显示"已画过"）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    rel = _safe_rel(request.query.get("rel"))
    p = mask_path_of(rel) if rel else None
    if not p or not os.path.isfile(p):
        return _json(allow, {"success": True, "exists": False})
    try:
        with open(p, "rb") as f:
            data = f.read()
    except Exception as exc:
        return _json(allow, {"success": False, "error": repr(exc)}, status=500)
    return web.Response(body=data, content_type="image/png", headers=cors_headers(allow))


async def gallery_mask_put(request):
    """存蒙版：{rel, png: "data:image/png;base64,…"}；delete=true 就删掉蒙版。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)
    body = body or {}
    rel = _safe_rel(body.get("rel"))
    if not rel:
        return _json(allow, {"success": False, "error": "rel 不合法"}, status=400)
    if not _abs_of(rel) or not os.path.isfile(_abs_of(rel)):
        return _json(allow, {"success": False, "error": "文件不在了"}, status=404)
    if body.get("delete"):
        return _json(allow, {"success": True, "deleted": mask_drop(rel), "rel": rel})
    s = str(body.get("png") or "")
    if not s:
        return _json(allow, {"success": False, "error": "没给蒙版"}, status=400)
    try:
        data = base64.b64decode(s.split(",", 1)[-1])
    except Exception as exc:
        return _json(allow, {"success": False, "error": "蒙版不是合法 base64：" + repr(exc)}, status=400)
    if not data.startswith(b"\x89PNG"):
        return _json(allow, {"success": False, "error": "蒙版不是 PNG"}, status=400)
    try:
        # ★ 393：`as="stack"` = 存「叠图合成图」（给画廊节点的 IMAGE 输出用），存在 _stack.png
        if str(body.get("as") or "") == "stack":
            p = stack_path_of(rel)
            if not p:
                return _json(allow, {"success": False, "error": "rel 不合法"}, status=400)
            tmp = p + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, p)
            return _json(allow, {"success": True, "rel": rel, "path": p, "stack": True})
        p = mask_save_bytes(rel, data)
    except Exception as exc:
        return _json(allow, {"success": False, "error": repr(exc)}, status=500)
    return _json(allow, {"success": True, "rel": rel, "path": p,
                         "url": "/prompt_sync/gallery/mask?rel=" + urllib.parse.quote(rel)})


async def gallery_info(request):
    """存档根目录 + 各页数量（前端一进来就拉一次，显示在标题行）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    root = ensure_archive_dirs()
    counts = {}
    for key in ("home", "fav", "trash", "ext"):
        counts[key] = len(_scan_page(key) or [])
    return _json(allow, {"success": True, "root": root, "counts": counts,
                         "limits": {"home": ARCHIVE_LIMIT_HOME, "trash": ARCHIVE_LIMIT_TRASH,
                                    "edit": ARCHIVE_LIMIT_EDIT, "material": 0},
                         "output": _output_dir() or ""})


async def options(request):
    """CORS 预检：浏览器带着 JSON 体的 POST 会先发这个。"""
    allow = origin_allow(request)
    if allow is False:
        return web.Response(status=403)
    return web.Response(status=204, headers=cors_headers(allow))


async def aliases_get(request):
    """取整张别名表（前端一进来就拉一次）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    data = load_aliases()
    return _json(allow, {"success": True, "aliases": data, "count": len(data), "file": alias_file_path()})


async def aliases_post(request):
    """改一个 / 整张换掉 / 清空。返回改完之后的整张表（前端直接拿去刷新画布）。"""
    allow = origin_allow(request)
    if allow is False:
        return _json(allow, {"success": False, "error": "cross-site blocked"}, status=403)
    try:
        body = await request.json()
    except Exception:
        return _json(allow, {"success": False, "error": "请求体不是合法 JSON"}, status=400)

    action, data, err = parse_alias_body(body)
    if err:
        return _json(allow, {"success": False, "error": err}, status=400)

    try:
        merged = apply_alias_change(load_aliases(), action, data)
        save_aliases(merged)
    except Exception as exc:                       # 盘写不进去（只读目录 / 被占用）也说人话
        return _json(allow, {"success": False, "error": "别名表没能写进磁盘：" + repr(exc)}, status=500)

    out = {"success": True, "aliases": merged, "count": len(merged), "file": alias_file_path()}
    if action == "set":
        out["key"] = data["key"]
        out["alias"] = data["alias"]
    return _json(allow, out)


def register_routes():
    """把三条接口挂到 ComfyUI 的 aiohttp 服务上。

    2026-09-24 起加了两件事（有用户报「装好了但工具还说节点没答话」）：
      ① 两条注册路子都试一遍：新版 `PromptServer.instance.routes`（RouteTableDef），
         老版/别的封装用 `PromptServer.instance.app.router`；
      ② **成功/失败都往控制台打一行**，前缀 `[提示词工具]` —— 用户排查时只要看
         ComfyUI 那个黑窗口里有没有「✅ 已加载」这行，就能立刻分清"节点没装/没加载"
         和"节点装了但工具连不上"。
    """
    if PromptServer is None:
        print(LOG_TAG + " ⚠ 没找到 ComfyUI 的 server 模块，互通路由没注册（这个节点只在 ComfyUI 里用）")
        return False
    inst = PromptServer.instance
    tried = []
    routes = getattr(inst, "routes", None)
    if routes is not None:
        try:
            routes.post("/prompt_sync/push")(push)
            routes.post("/prompt_sync/ai/request")(ai_request)
            routes.get("/prompt_sync/ai/pending")(ai_pending)
            routes.post("/prompt_sync/ai/answer")(ai_answer)
            routes.get("/prompt_sync/ai/result")(ai_result)
            routes.get("/prompt_sync/store")(store_get)
            routes.post("/prompt_sync/store")(store_post)
            routes.get("/prompt_sync/current")(current)
            routes.get("/prompt_sync/ping")(ping)
            routes.get("/prompt_sync/aliases")(aliases_get)
            routes.post("/prompt_sync/aliases")(aliases_post)
            routes.post("/prompt_sync/batch/push")(batch_push)
            routes.get("/prompt_sync/batch/status")(batch_status_get)
            routes.post("/prompt_sync/batch/start")(batch_start)
            routes.post("/prompt_sync/batch/stop")(batch_stop)
            routes.post("/prompt_sync/batch/pause")(batch_pause)
            routes.post("/prompt_sync/batch/clear")(batch_clear)
            routes.post("/prompt_sync/timer/sound")(timer_sound_upload)
            # ★ 234 批：图片存档 / 画廊
            routes.get("/prompt_sync/gallery/list")(gallery_list)
            routes.get("/prompt_sync/gallery/img")(gallery_img)
            routes.get("/prompt_sync/gallery/info")(gallery_info)
            routes.get("/prompt_sync/gallery/meta")(gallery_meta)
            routes.post("/prompt_sync/gallery/save")(gallery_save)
            routes.post("/prompt_sync/gallery/toedit")(gallery_toedit)
            routes.post("/prompt_sync/gallery/fav")(gallery_fav)
            routes.post("/prompt_sync/gallery/trash")(gallery_trash)
            routes.post("/prompt_sync/gallery/restore")(gallery_restore)
            routes.post("/prompt_sync/gallery/purge")(gallery_purge)
            # ★ 273h：画廊的手画蒙版
            routes.get("/prompt_sync/gallery/mask")(gallery_mask_get)
            routes.post("/prompt_sync/gallery/mask")(gallery_mask_put)
            # ★ 383 批：素材模式的图层记录（sidecar）
            routes.get("/prompt_sync/gallery/layers")(gallery_layers_get)
            routes.post("/prompt_sync/gallery/layers")(gallery_layers_put)
            routes.options("/prompt_sync/gallery/layers")(options)
            # ★ 364 批：素材栏（叠图素材）
            routes.post("/prompt_sync/gallery/material")(gallery_material)
            routes.options("/prompt_sync/gallery/material")(options)
            routes.options("/prompt_sync/push")(options)
            routes.options("/prompt_sync/current")(options)
            routes.options("/prompt_sync/ping")(options)
            routes.options("/prompt_sync/aliases")(options)
            routes.options("/prompt_sync/batch/push")(options)
            routes.options("/prompt_sync/batch/status")(options)
            routes.options("/prompt_sync/batch/start")(options)
            routes.options("/prompt_sync/batch/stop")(options)
            routes.options("/prompt_sync/batch/pause")(options)
            routes.options("/prompt_sync/batch/clear")(options)
            routes.options("/prompt_sync/timer/sound")(options)
            routes.options("/prompt_sync/gallery/list")(options)
            routes.options("/prompt_sync/gallery/img")(options)
            routes.options("/prompt_sync/gallery/info")(options)
            routes.options("/prompt_sync/gallery/meta")(options)
            routes.options("/prompt_sync/gallery/save")(options)
            routes.options("/prompt_sync/gallery/toedit")(options)
            routes.options("/prompt_sync/gallery/fav")(options)
            routes.options("/prompt_sync/gallery/trash")(options)
            routes.options("/prompt_sync/gallery/restore")(options)
            routes.options("/prompt_sync/gallery/purge")(options)
            routes.options("/prompt_sync/gallery/mask")(options)
            # ★ 193 批：AI 中转 + 共享黑板的 CORS 预检（以前**一个都没登记** →
            #   file:// 打开的工具发 POST 直接被挡，GET 也读不到内容）
            routes.options("/prompt_sync/ai/request")(options)
            routes.options("/prompt_sync/ai/pending")(options)
            routes.options("/prompt_sync/ai/answer")(options)
            routes.options("/prompt_sync/ai/result")(options)
            routes.options("/prompt_sync/store")(options)
            print(LOG_TAG + " ✅ 互通节点已加载（版本 " + NODE_VERSION + "）：/prompt_sync/ping 可用")
            return True
        except Exception as exc:
            tried.append("routes: " + repr(exc))
    router = getattr(inst, "app", None)
    router = getattr(router, "router", None) if router is not None else None
    if router is not None:
        try:
            router.add_post("/prompt_sync/push", push)
            router.add_get("/prompt_sync/current", current)
            router.add_get("/prompt_sync/ping", ping)
            router.add_get("/prompt_sync/aliases", aliases_get)
            router.add_post("/prompt_sync/aliases", aliases_post)
            router.add_post("/prompt_sync/batch/push", batch_push)
            router.add_get("/prompt_sync/batch/status", batch_status_get)
            router.add_post("/prompt_sync/batch/start", batch_start)
            router.add_post("/prompt_sync/batch/stop", batch_stop)
            router.add_post("/prompt_sync/batch/pause", batch_pause)
            router.add_post("/prompt_sync/batch/clear", batch_clear)
            router.add_post("/prompt_sync/timer/sound", timer_sound_upload)
            # ★ 234 批：图片存档 / 画廊
            router.add_get("/prompt_sync/gallery/list", gallery_list)
            router.add_get("/prompt_sync/gallery/img", gallery_img)
            router.add_get("/prompt_sync/gallery/info", gallery_info)
            router.add_get("/prompt_sync/gallery/meta", gallery_meta)
            router.add_post("/prompt_sync/gallery/save", gallery_save)
            router.add_post("/prompt_sync/gallery/toedit", gallery_toedit)
            router.add_post("/prompt_sync/gallery/fav", gallery_fav)
            router.add_post("/prompt_sync/gallery/trash", gallery_trash)
            router.add_post("/prompt_sync/gallery/restore", gallery_restore)
            router.add_post("/prompt_sync/gallery/purge", gallery_purge)
            # ★ 273h：画廊的手画蒙版
            router.add_get("/prompt_sync/gallery/mask", gallery_mask_get)
            router.add_post("/prompt_sync/gallery/mask", gallery_mask_put)
            # ★ 383 批：图层 sidecar
            router.add_get("/prompt_sync/gallery/layers", gallery_layers_get)
            router.add_post("/prompt_sync/gallery/layers", gallery_layers_put)
            # ★ 364 批：素材栏
            router.add_post("/prompt_sync/gallery/material", gallery_material)
            # ★ 193 批：AI 中转 + 共享黑板（含它们的 CORS 预检）
            router.add_post("/prompt_sync/ai/request", ai_request)
            router.add_get("/prompt_sync/ai/pending", ai_pending)
            router.add_post("/prompt_sync/ai/answer", ai_answer)
            router.add_get("/prompt_sync/ai/result", ai_result)
            router.add_get("/prompt_sync/store", store_get)
            router.add_post("/prompt_sync/store", store_post)
            router.add_route("OPTIONS", "/prompt_sync/push", options)
            router.add_route("OPTIONS", "/prompt_sync/current", options)
            router.add_route("OPTIONS", "/prompt_sync/ping", options)
            router.add_route("OPTIONS", "/prompt_sync/aliases", options)
            router.add_route("OPTIONS", "/prompt_sync/batch/push", options)
            router.add_route("OPTIONS", "/prompt_sync/batch/status", options)
            router.add_route("OPTIONS", "/prompt_sync/batch/start", options)
            router.add_route("OPTIONS", "/prompt_sync/batch/stop", options)
            router.add_route("OPTIONS", "/prompt_sync/batch/pause", options)
            router.add_route("OPTIONS", "/prompt_sync/batch/clear", options)
            router.add_route("OPTIONS", "/prompt_sync/timer/sound", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/list", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/img", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/info", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/meta", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/save", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/toedit", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/fav", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/trash", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/restore", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/purge", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/mask", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/layers", options)
            router.add_route("OPTIONS", "/prompt_sync/gallery/material", options)
            router.add_route("OPTIONS", "/prompt_sync/ai/request", options)
            router.add_route("OPTIONS", "/prompt_sync/ai/pending", options)
            router.add_route("OPTIONS", "/prompt_sync/ai/answer", options)
            router.add_route("OPTIONS", "/prompt_sync/ai/result", options)
            router.add_route("OPTIONS", "/prompt_sync/store", options)
            print(LOG_TAG + " ✅ 互通节点已加载（版本 " + NODE_VERSION + "，走 app.router）：/prompt_sync/ping 可用")
            return True
        except Exception as exc:
            tried.append("app.router: " + repr(exc))
    print(LOG_TAG + " ⚠ 互通路由注册失败，工具会提示「节点没答话」。失败原因：" + (" | ".join(tried) or "找不到可用的路由对象"))
    return False


# 导入即注册（与「双语提示词检查器」同一套做法）
register_routes()
