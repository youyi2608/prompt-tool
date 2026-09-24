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

import re
import time

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


NODE_VERSION = "1.2"
LOG_TAG = "[提示词工具]"


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
            routes.options("/prompt_sync/push")(options)
            routes.options("/prompt_sync/current")(options)
            routes.options("/prompt_sync/ping")(options)
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
            router.add_route("OPTIONS", "/prompt_sync/push", options)
            router.add_route("OPTIONS", "/prompt_sync/current", options)
            router.add_route("OPTIONS", "/prompt_sync/ping", options)
            print(LOG_TAG + " ✅ 互通节点已加载（版本 " + NODE_VERSION + "，走 app.router）：/prompt_sync/ping 可用")
            return True
        except Exception as exc:
            tried.append("app.router: " + repr(exc))
    print(LOG_TAG + " ⚠ 互通路由注册失败，工具会提示「节点没答话」。失败原因：" + (" | ".join(tried) or "找不到可用的路由对象"))
    return False


# 导入即注册（与「双语提示词检查器」同一套做法）
register_routes()
