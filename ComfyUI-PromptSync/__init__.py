"""提示词工具 → ComfyUI 互通节点。

装好后：在「提示词工具」左上角打开 🔗 互通开关，点按钮就不再复制，
而是直接把提示词送进本节点的文本框（正/负各一个）。
"""

from .nodes import PromptSyncFromTool, PromptToolEmptyLatent, PromptToolToolbar, PromptToolBatchQueue

import sys

# ⚠️ Windows 中文版控制台默认编码是 GBK，而 GBK 里没有 ✅ / ⚠ 这些字符 ——
# ComfyUI 的加载器遇到"节点加载失败"时会把 traceback 再打一遍，那时 print 一起抛
# UnicodeEncodeError（'gbk' codec can't encode character '\u26a0'），**会把整个 ComfyUI 进程带崩**
# （2026-09-30 在自组的 portable 上实测：exit code 1，服务根本起不来）。
# 这里只把编码**错误策略**改成 replace（编码本身不动，中文照样正常显示），
# 于是任何字符都不会再让 print / logging 抛异常。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

try:                       # 导入即注册本地 API 路由；注册失败也别让整个节点加载不了（要在控制台喊出来）
    from . import routes  # noqa: F401
except Exception as _exc:  # pragma: no cover
    import traceback
    print("[提示词工具] ⚠ 互通路由没挂上（节点本体还在，但工具会提示「节点没答话」）：" + repr(_exc))
    traceback.print_exc()

NODE_CLASS_MAPPINGS = {
    "PromptSyncFromTool": PromptSyncFromTool,
    "PromptToolEmptyLatent": PromptToolEmptyLatent,
    "PromptToolToolbar": PromptToolToolbar,
    "PromptToolBatchQueue": PromptToolBatchQueue,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptSyncFromTool": "提示词同步（来自提示词工具）",
    "PromptToolEmptyLatent": "空Latent（自填宽高像素）",
    "PromptToolToolbar": "游动羽翼工具栏",
    "PromptToolBatchQueue": "套图排队（来自提示词工具）",
}

# ⚠️ 一个节点模块只会被挂载成一个 web 目录（ComfyUI nodes.py：EXTENSION_WEB_DIRS[module_name]），
# 所以**前端 js 和网页版工具必须在同一个目录里** —— 以前 js 放 ./js、网页版放 ./web，
# 挂载名只有一个，结果 web/prompt_tool.html 一直 404（粉丝反馈的就是这个）。
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
