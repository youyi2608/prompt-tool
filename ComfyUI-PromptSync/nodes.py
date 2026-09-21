class PromptSyncFromTool:
    """提示词工具的互通节点。

    文本由外部（桌面上的「提示词工具」）通过本地启动器推送进来，
    也可以直接在节点上手改。两个输出分别给正提示词和负提示词。
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
