"""互通节点的后端路由。

给 ComfyUI 的 aiohttp 服务挂三条接口：

  POST /prompt_sync/push     收下工具送来的正/负提示词，并实时推给浏览器
  GET  /prompt_sync/current  取回最后一次推送的内容（手动「从工具同步一次」用）
  GET  /prompt_sync/ping     探活：启动器 / 工具用它判断节点有没有装好

**两条来源都放行**：

  ① 本地启动器的【服务端转发】—— 不带 Origin 头（原来只有这一条路）；
  ② 浏览器直连（2026-09-22 加的）：工具**没有配启动器**时（直接双击 HTML 打开的，
     发布包里就是这样），页面会直接 POST 到 127.0.0.1:<端口>/prompt_sync/push。

②是跨源请求，所以这里要回 CORS 头，并且**只认本机来源**：
Origin 为空（启动器转发）、"null"（file:// 直接打开的工具）、
http(s)://127.0.0.1[:端口] / http(s)://localhost[:端口]。
别的网站（比如 evil.com）拿不到 CORS 头，浏览器的预检就过不去，POST 根本发不出来。
"""

import copy
import json
import os
import random
import re
import threading
import time
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
    if allow is not None and allow is not False:
        headers["Access-Control-Allow-Origin"] = allow
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


NODE_VERSION = "1.4"
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

BATCH_MAX_SEGMENTS = 12
BATCH_MAX_REST = 600
BATCH_WAIT_TIMEOUT = 6 * 3600          # 一张图最多等 6 小时（真的卡死了也别把线程吊一辈子）
BATCH_POLL_INTERVAL = 0.5

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


def find_sync_node(prompt):
    """在工作流的 API 图里找「提示词同步」那个节点（正负提示词就替换在它身上）。"""
    if not isinstance(prompt, dict):
        return None
    for node_id, node in prompt.items():
        if isinstance(node, dict) and node.get("class_type") == "PromptSyncFromTool":
            return node_id
    return None


def build_batch_prompt(template, node_id, seg, index, total):
    """按模板造第 index 张的那份 API 图：换掉正负提示词，顺手给节点改个名字好认。"""
    p = copy.deepcopy(template)
    node = p.setdefault(node_id, {})
    node.setdefault("inputs", {})
    node["inputs"]["positive"] = seg["pos"]
    node["inputs"]["negative"] = seg["neg"]
    meta = node.setdefault("_meta", {})
    if isinstance(meta, dict):
        meta["title"] = seg["note"] or ("套图 %d/%d" % (index + 1, total))
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
              stop_event=None, queue=None, sleep=None, status_cb=None, pause_event=None):
    """喂饭线程本体（纯逻辑，自测里用假的 queue / sleep 直接跑）。

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
           rest_left=0, error="", prompt_ids=[], note="")

    for i, seg in enumerate(segments):
        if stop_event.is_set():
            break
        # 暂停落在"两张之间"：这里也查一次，覆盖"上一张出完时按下的暂停"
        if _hold_if_paused(stop_event, pause_event, sleep, notify, done, ids):
            break
        prompt = build_batch_prompt(template, node_id, seg, i, total)
        if randomize:
            randomize_seeds(prompt)
        prompt_id = str(uuid.uuid4())
        ids.append(prompt_id)
        extra_data = {"batch_index": i + 1, "batch_total": total}
        if client_id:
            extra_data["client_id"] = client_id
        notify(running=True, stage="queued", index=i + 1, done=done, rest_left=0,
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


def start_batch(prompt, segments, rest_seconds, randomize, client_id=None, queue=None):
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

    _batch_stop.clear()
    _batch_pause.clear()          # 新一轮一律不带着上次的暂停状态
    _set_status(running=True, paused=False, stage="queued", error="", done=0, rest_left=0,
                planned=len(segments), index=1, prompt_ids=[], note="")
    t = threading.Thread(
        target=run_batch,
        args=(prompt, node_id, segments, rest, bool(randomize), client_id),
        kwargs={"queue": queue} if queue is not None else {},
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
    st["segments"] = len(st.get("segments") or [])
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
                          body.get("clientId"))
    if not ok:
        return _json(allow, {"success": False, "error": err}, status=400)
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
            print(LOG_TAG + " ✅ 互通节点已加载（版本 " + NODE_VERSION + "，走 app.router）：/prompt_sync/ping 可用")
            return True
        except Exception as exc:
            tried.append("app.router: " + repr(exc))
    print(LOG_TAG + " ⚠ 互通路由注册失败，工具会提示「节点没答话」。失败原因：" + (" | ".join(tried) or "找不到可用的路由对象"))
    return False


# 导入即注册（与「双语提示词检查器」同一套做法）
register_routes()
