"""提示词工具 → ComfyUI 互通节点。

装好后：在「提示词工具」右上角打开 🔗 互通开关，点按钮就不再复制，
而是直接把提示词送进本节点的文本框（正/负各一个）。
"""

from .nodes import PromptSyncFromTool
from . import routes  # noqa: F401  导入即注册本地 API 路由

NODE_CLASS_MAPPINGS = {
    "PromptSyncFromTool": PromptSyncFromTool,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptSyncFromTool": "提示词同步（来自提示词工具）",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
