class PromptSyncFromTool:
    """提示词工具的互通节点。

    文本由外部（桌面上的「提示词工具」）推送进来——有启动器时经它转发，
    直接双击 HTML 时由工具页面直连本节点；也可以直接在节点上手改。
    两个输出分别给正提示词和负提示词。

    ⚠️ 节点顶上有一行灰字提示：「需要把 CLIP 文本编码节点的文本置空」（2026-10-02 他要求加的）
    —— 那个框里要是还留着老文本，就和这里推过去的分不清到底用了哪个。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": False,   # 保持原文，别让动态提示词语法把 {{}} 吃掉
                        "default": "",
                    },
                ),
                "negative": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": False,
                        "default": "",
                    },
                ),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("正提示词", "负提示词")
    FUNCTION = "pass_through"
    CATEGORY = "文本/提示词工具"
    DESCRIPTION = "由「提示词工具」的互通开关直接写入；两个输出可分别接正/负提示词。"

    def pass_through(self, positive, negative):
        return (positive, negative)


# 「游动羽翼工具栏」下拉里能叫出来的原创节点（显示名必须和 __init__.py 的
# NODE_DISPLAY_NAME_MAPPINGS 一模一样 —— 前端就是拿这个名字去 registered_node_types 里找的）
TOOL_NODE_CHOICES = [
    "提示词同步（来自提示词工具）",
    "空Latent（自填宽高像素）",
    "套图排队（来自提示词工具）",
    "游动羽翼工具栏",
]


class PromptToolToolbar:
    """游动羽翼工具栏：放在画布上当「按钮面板」用，不参与工作流。

    为什么要有它：我们原创的节点名字起得太普通（「提示词同步」「空Latent（自填宽高像素）」），
    在搜索框里翻很难找 —— 这里一个下拉列出它们，选好点「➕ 加到画布」直接落到画布中间。

    第二件事是「模型别名」：LoRA / Checkpoint / VAE 这些下拉里的文件名，可以在这里改成你认得出来的
    别名（只改显示，工作流里存的还是真文件名）。详见 web/prompt_toolbar.js。

    ⚠️ 本节点没有输入输出，也不是 OUTPUT_NODE，所以 ComfyUI 永远不会执行它、也不占排队。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "要添加的节点": (
                    list(TOOL_NODE_CHOICES),
                    {"default": TOOL_NODE_CHOICES[0], "tooltip": "选好之后，点下面那颗「➕ 加到画布」"},
                ),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "提示词工具"
    DESCRIPTION = (
        "画布上的按钮面板：① 一键把我们自己的节点加到画布（不用去搜索框里翻）；"
        "② 给 LoRA / Checkpoint / VAE 这些模型下拉改别名（只改显示，文件真名不变）。"
        "本节点不参与工作流、也不会被 ComfyUI 执行。"
    )

    def noop(self, **kw):
        """永远不会被调到（没有输出 → 不在执行列表里），留着只是为了满足 ComfyUI 的接口。"""
        return {}


class PromptToolBatchQueue:
    """套图排队：把「提示词工具」送来的一整套提示词，一张一张排队出图，每张之间歇一会儿。

    为什么要单独一个节点（不改造「提示词同步」）：这两种用法完全不一样 —— 那个是"推一次出一次"，
    这个是"一次排一整套、中间自己等"。放一起会互相干扰，所以各管各的，旧的三条路由一行都不动。

    它自己同样**不参与工作流、也不会被执行**（没有输出、不是 OUTPUT_NODE）：真正干活的是
    节点后端那条新路由 + 一个喂饭线程 —— 排第 1 张 → 等它出完 → **在队列外面**歇 N 秒 → 再排下一张。
    因为休息落在队列之外，休息期间 ComfyUI 是真空闲的，随时能停。

    按钮在节点前端（`web/prompt_batch.js`）：「▶ 开始排队」/「⏸ 暂停排队（▶ 继续排队）」/「⏹ 停止」/
    **「🗑 清除进程」**（把这一轮收掉 + 清空工具推来的那几段，回到"等工具再推一次"；**正在出图时不许清** ——
    他会先按暂停/停止）。顶上一条灰字提示写明它得和「提示词同步」节点一起用（提示词是那个节点送出去的）。

    ⚠️ 暂停的语义（2026-10-02 他定的）：「如果生成到一半不能暂停，那就把这张图生成之后再暂停」
    —— 暂停只落在"两张之间"（这张出完 / 休息里），**不打断**正在跑的那张。见 routes.py 的
    `_hold_if_paused` 与 `pause_batch`。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "每张之间休息(秒)": (
                    "INT",
                    {"default": 60, "min": 0, "max": 600,
                     "tooltip": "每张图之间歇多久。官方建议别低于 60 秒，填小了我们也会照做（工具那边会提醒一句）"},
                ),
                "一次最多几张": (
                    "INT",
                    {"default": 4, "min": 1, "max": 12,
                     "tooltip": "这一轮最多排几张；工具一次最多送 4 段，这里再兜一层上限"},
                ),
                "每张换随机种子": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "开着的话，每张都把工作流里的 seed / noise_seed 换一个随机值"},
                ),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "文本/提示词工具"
    DESCRIPTION = (
        "把工具里「🎞 套图」那一整套提示词一张一张排出来，每张之间自己休息（休息在队列之外，随时能停、随时能暂停）。"
        "本节点不参与工作流、也不会被 ComfyUI 执行 —— 干活的是节点后端和它开的喂饭线程。"
        "⚠️ 它得和「提示词同步（来自提示词工具）」节点一起用（提示词由那个节点送出去）。"
    )

    def noop(self, **kw):
        """永远不会被调到（没有输出 → 不在执行列表里）。"""
        return {}


class PromptToolEmptyLatent:
    """空 Latent：自己填长边/短边两条像素数，再自己指定横边 / 竖边各用哪一条。

    为什么不直接用别的预设节点：那些节点只有一个「尺寸」下拉，分不清"现在横边比竖边长、
    还是反过来"，而且全是英文。这里就是五排：长边像素 / 短边像素 / 横边为长边还是短边 /
    竖边为长边还是短边 / 数量。

    两条边都选同一条（比如都选「长边」）就老老实实出正方形——不做兜底。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "长边像素": (
                    "INT",
                    {"default": 1152, "min": 64, "max": 16384, "step": 8,
                     "tooltip": "长边那条的像素数（放到哪条边，看下面两排）"},
                ),
                "短边像素": (
                    "INT",
                    {"default": 896, "min": 64, "max": 16384, "step": 8,
                     "tooltip": "短边那条的像素数"},
                ),
                "横边为长边还是短边": (["长边", "短边"], {"default": "长边", "tooltip": "左右那条边用长边还是短边像素数"}),
                "竖边为长边还是短边": (["长边", "短边"], {"default": "短边", "tooltip": "上下那条边用长边还是短边像素数"}),
                "数量": (
                    "INT",
                    {"default": 1, "min": 1, "max": 64, "tooltip": "一次生成几张"},
                ),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("空Latent",)
    FUNCTION = "build"
    CATEGORY = "latent/提示词工具"
    DESCRIPTION = "直接填长边/短边两条像素数，再指定横边/竖边各用哪条。像素数不是 8 的倍数时向下取整（latent 只能是 1/8）。"

    def build(self, **kw):
        import torch  # 放在函数里：不装 ComfyUI / torch 也能导入本模块（自测脚本要用）

        long_val = int(kw.get("长边像素", 1152))
        short_val = int(kw.get("短边像素", 896))
        horiz = kw.get("横边为长边还是短边", "长边")
        vert = kw.get("竖边为长边还是短边", "短边")
        width = long_val if horiz == "长边" else short_val
        height = long_val if vert == "长边" else short_val
        width = max(8, (width // 8) * 8)
        height = max(8, (height // 8) * 8)
        batch = max(1, int(kw.get("数量", 1)))
        return ({"samples": torch.zeros([batch, 4, height // 8, width // 8])},)
