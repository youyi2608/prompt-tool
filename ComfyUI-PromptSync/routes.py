"""互通节点的后端路由。

给 ComfyUI 的 aiohttp 服务挂三条接口：

  POST /prompt_sync/push     收下工具送来的正/负提示词，并实时推给浏览器
  GET  /prompt_sync/current  取回最后一次推送的内容（手动「从工具同步一次」用）
  GET  /prompt_sync/ping     探活：启动器用它判断节点有没有装好

只有 POST /push 会被本地启动器调用，而且是【服务端转发】（不带 Origin），
所以不存在跨源问题；同时拒绝浏览器发起的跨站请求。
"""

import time

from aiohttp import web

try:                       # 允许在没有 ComfyUI 的环境里单独导入本模块做自测
    from server import PromptServer
except Exception:          # pragma: no cover
    PromptServer = None

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


def _is_cross_site(request):
    """浏览器跨站请求直接挡掉；启动器的服务端转发没有这个头，正常放行。"""
    return (request.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site"


async def push(request):
    if _is_cross_site(request):
        return web.json_response({"success": False, "error": "cross-site blocked"}, status=403)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是合法 JSON"}, status=400)

    payload = normalize_payload(data)
    if payload is None:
        return web.json_response({"success": False, "error": "正负提示词都是空的，已忽略"}, status=400)

    _last.update(payload)
    _last["count"] = _last.get("count", 0) + 1

    if PromptServer is not None:
        try:
            PromptServer.instance.send_sync("prompt_sync.update", dict(_last))
        except Exception:
            pass

    return web.json_response({
        "success": True,
        "name": payload["name"],
        "pos_len": len(payload["pos"]),
        "neg_len": len(payload["neg"]),
        "count": _last["count"],
    })


async def current(request):
    return web.json_response({"success": True, "data": dict(_last)})


async def ping(request):
    return web.json_response({"success": True, "node": "PromptSync", "version": "1.0"})


def register_routes():
    if PromptServer is None:
        return
    PromptServer.instance.routes.post("/prompt_sync/push")(push)
    PromptServer.instance.routes.get("/prompt_sync/current")(current)
    PromptServer.instance.routes.get("/prompt_sync/ping")(ping)


# 导入即注册（与「双语提示词检查器」同一套做法）
register_routes()
