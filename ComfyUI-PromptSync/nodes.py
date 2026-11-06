"""本包的节点定义（后端那一半；前端在 web/*.js）。

一个文件夹 = 7 颗节点：提示词同步 / CLIP 文本编码优化节点 / 关键词权重（附属节点）/
空Latent / 游动羽翼工具栏 / 套图排队 / 计时器。
"""

import json
import os
import re

# ---------------------------------------------------------------- 关键词权重（批 C3，2026-10-06）
# 他 2026-10-05 定的规格（原话）：
#   「优化节点右下方加一个『调整关键词权重』的按钮……会叫出一个横长条状的附属节点，
#     上面有关键词的权重示数，还有一个横圆形滑块，按圆形滑块左右拖，就会以最小刻度 0.05 的方式调整。
#     附属节点不和任何节点连接，也不会改变优化节点的文本内容，但是确实可以改变其输出的内容」
#   「如果优化节点中没有对应关键词，实际上也是可以叫出相应关键词的节点的，这样就不是修改权重，
#     而是新加一个词，这个词带权重了，反正都一样」
# 前端在 web/prompt_weight.js；这里只放"怎么套进送去编码的那份文本"（纯函数，便于单测）。
WEIGHT_MIN = 0.05
WEIGHT_MAX = 2.00
WEIGHT_STEP = 0.05
WEIGHT_MAX_WORDS = 200          # 一张表最多记这么多词（防手改的工作流塞进来一大堆）
WEIGHT_MAX_LEN = 80             # 单个词最长这么多字符


def norm_weights(raw):
    """把前端发来的权重表收成 `{词: 权重}`（纯函数，便于单测）。

    raw 可以是：JSON 字符串 / `{词: 权重}` / `[{"word","weight"}]` / None。
    权重按 0.05 的刻度对齐、夹在 [0.05, 2.00] 里；空词、超长词、非数字一律丢掉。
    """
    if raw is None:
        return {}
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        try:
            raw = json.loads(s)
        except Exception:
            return {}
    if isinstance(raw, dict):
        items = list(raw.items())
    elif isinstance(raw, (list, tuple)):
        items = []
        for it in raw:
            if isinstance(it, dict):
                items.append((it.get("word", it.get("词")), it.get("weight", it.get("权重"))))
    else:
        return {}
    out = {}
    for k, v in items:
        word = str(k if k is not None else "").strip()
        if not word or len(word) > WEIGHT_MAX_LEN or word in out:
            continue
        try:
            w = float(v)
        except Exception:
            continue
        if w != w or w in (float("inf"), float("-inf")):        # NaN / inf
            continue
        w = round(round(min(WEIGHT_MAX, max(WEIGHT_MIN, w)) / WEIGHT_STEP) * WEIGHT_STEP, 2)
        out[word] = w
        if len(out) >= WEIGHT_MAX_WORDS:
            break
    return out


def weight_text(weight):
    """0.05 的倍数写成 `0.75` / `1.2` / `1` 这种（不补零）。"""
    w = round(float(weight), 2)
    if abs(w - round(w)) < 1e-9:
        return str(int(round(w)))
    return ("%.2f" % w).rstrip("0").rstrip(".")


def _weighted(word, weight):
    """权重 = 1 就不加括号（等于没改）；其余写成 `(词:1.2)`。"""
    if abs(float(weight) - 1.0) < 1e-9:
        return word
    return "(%s:%s)" % (word, weight_text(weight))


def apply_weights(text, weights, append_missing=False):
    """按权重表改写"送去编码的那一份"（**节点上显示的文本一个字都不动**）。

    ① 表里的词在文本里出现（忽略大小写、按整词边界）→ 换成 `(词:权重)`；
       原文里已经写成 `(词)` / `(词:1.2)` / `[词]` 的，**以权重表为准**覆盖掉。
    ② `append_missing=True` 时，表里有、文本里没有的词**追加到末尾**（带权重）——
       负提示词那边传 False（不然会把正面的词硬塞进负提示词里去）。
    ③ 长词优先、重叠的短词跳过（`long hair` 和 `hair` 同时命中时只吃长的那个）。
    """
    text = text or ""
    ws = weights if isinstance(weights, dict) else norm_weights(weights)
    if not ws:
        return text
    words = sorted(ws.keys(), key=lambda x: (-len(x), x))
    spans = []
    for word in words:
        w_esc = re.escape(word)
        pat = re.compile(
            r"[\(\（\[][ \t]*" + w_esc + r"[ \t]*(?::[ \t]*[0-9]*\.?[0-9]+[ \t]*)?[\)\）\]]"
            r"|(?<![0-9A-Za-z_])" + w_esc + r"(?![0-9A-Za-z_])",
            re.IGNORECASE)
        for m in pat.finditer(text):
            spans.append((m.start(), m.end(), word))
    spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))          # 同一个起点，长的优先
    picked, used = [], set()
    for st, en, word in spans:
        if picked and st < picked[-1][1]:                     # 和上一个重叠 → 跳过
            continue
        picked.append((st, en, word))
        used.add(word)
    out, pos = [], 0
    for st, en, word in picked:
        out.append(text[pos:st])
        out.append(_weighted(word, ws[word]))
        pos = en
    out.append(text[pos:])
    body = "".join(out)
    if not append_missing:
        return body
    missing = [w for w in words if w not in used]
    if not missing:
        return body
    tail = ", ".join(_weighted(w, ws[w]) for w in missing)
    stripped = body.rstrip()
    if not stripped:
        return tail
    if stripped.endswith(","):
        return stripped + " " + tail
    if stripped != body:                                      # 原来结尾就是空行 → 另起一行
        return stripped + "\n" + tail
    return stripped + ", " + tail


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
    "CLIP 文本编码优化节点",
    "关键词权重（附属节点）",
    "空Latent（自填宽高像素）",
    "套图排队（来自提示词工具）",
    "计时器（休息计时 + 生图效率）",
    "LoRA 池",
    "自定义优化窗（节点）",
    "游动羽翼工具栏",
    "图像画廊（展示 + 存档）",
    # ★ 2026-11-03：新加的两颗必须同步进这个清单，否则工具栏的「要添加的节点」下拉里选不到
    #   （他报的「游动羽翼工具栏不能把新的两个节点叫出来」就是这里漏了）
    "暂存节点（下一批文本）",
    "模型池（多套模型并行）",
]


class PromptToolOptAsk:
    """自定义优化窗（节点形态）—— 2026-10-19 第 188/189 批他要的：

      「点自定义优化那个按钮，就会弹出一个和自定义优化弹窗布局一模一样的节点，节点本身不会连接，
        只能同时出现一个，数据也要和自定义优化弹窗一样哦」

    → 它是一颗**界面节点**（不参与工作流、不出图时永远不执行），画布上长得跟工具端那个
      「✎ 自定义优化提示词」窗一样：一个文本框写要求、下面一排快捷词、再下面是写过的要求历史，
      点「开始优化」就把要求发给**提示词工具**（工具侧轮询 /prompt_sync/ai/pending 接手），
      结果写回被优化的那颗「CLIP 文本编码优化节点」的正提示词框。
      快捷词 / 历史走 /prompt_sync/store 那块共享黑板 —— 所以和工具里看到的是同一份。

    ★ 2026-11-03 第 1 条的补充纠正（很重要，别再加错地方）：
      「**自定义优化叫出来的自定义节点多一个输出口**，在连接的情况下将优化结果放在暂存节点里，
        在不连接的情况下继续对优化节点的文本进行替换，**而不是让优化节点从两个输出口变成三个**」
    → 所以：**这个口长在本节点（✎ 自定义优化窗）身上**，CLIP 优化节点永远保持"正向/负向"两个口。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "状态": (
                    "STRING",
                    {"default": "", "multiline": False,
                     "tooltip": "前端把「这一窗是给哪颗优化节点用的」存在这里（跟着工作流走）"},
                ),
            }
        }

    # ★ 2026-11-03：唯一的一个输出口，接「暂存节点」。
    #   连了 = 优化结果先进暂存节点的下框；没连 = 照旧替换被优化那颗节点的文本（老行为）。
    #   本节点其余部分仍然是纯界面（不参与工作流、不出图时不会被执行）。
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("优化结果（可不连）",)
    FUNCTION = "noop"
    CATEGORY = "条件/提示词工具"
    DESCRIPTION = (
        "点「CLIP 文本编码优化节点」上的 ✎ 自定义优化就会弹出这一个窗（同时只允许一个）："
        "写清要改成什么样 → 开始优化 → 由「提示词工具」替你调 AI。"
        "**没接『优化结果（可不连）』这个口** = 结果替换那颗优化节点的文本（老行为）；"
        "**接上「暂存节点」** = 结果先进暂存节点的下框，你过目满意后再点「↑ 顶掉上框」。"
        "快捷词与历史跟工具端是同一份。"
    )

    def noop(self, **kw):
        return ("",)


def _gallery_picked_rel(prompt):
    """从整张 prompt 里找「图像画廊」节点选中的那张图（相对路径）。找不到给空串。"""
    try:
        for _nid, n in (prompt or {}).items():
            if str((n or {}).get("class_type") or "") != "PromptToolGallery":
                continue
            v = ((n or {}).get("inputs") or {}).get("选中的图")
            if isinstance(v, str) and v.strip():
                return v.strip()
    except Exception:
        pass
    return ""


def _loras_from_prompt_dict(pr):
    """沿采样器的 model 那条线往上游走，把 LoraLoader 一个个捡出来，最后反序 = 真正的叠加顺序。"""
    out = []
    try:
        def lt(v):
            return v[0] if isinstance(v, (list, tuple)) and v else None
        start = None
        for _nid, n in (pr or {}).items():
            ct = str((n or {}).get("class_type") or "")
            if "KSampler" in ct or "SamplerCustom" in ct:
                start = lt(((n or {}).get("inputs") or {}).get("model"))
                if start:
                    break
        cur, guard = start, 0
        while cur and guard < 200:
            guard += 1
            n = (pr or {}).get(cur) or {}
            ct = str(n.get("class_type") or "")
            ii = n.get("inputs") or {}
            if ct in ("LoraLoader", "LoraLoaderModelOnly"):
                try:
                    sm = float(ii.get("strength_model", 1.0))
                except Exception:
                    sm = 1.0
                try:
                    sc = float(ii.get("strength_clip", ii.get("strength_model", 1.0)))
                except Exception:
                    sc = sm
                out.append({"name": str(ii.get("lora_name") or ""), "model": sm, "clip": sc})
            cur = lt(ii.get("model"))
    except Exception:
        return []
    out.reverse()
    return [x for x in out if x["name"]]


def _loras_from_image_rel(rel):
    """读画廊里某张图的 PNG 元数据（`prompt` 那段），抠出它当时叠的 LoRA。读不到给空表。"""
    try:
        from . import routes as R
        from PIL import Image
        p = R._abs_of(str(rel or "").strip())
        if not p or not os.path.isfile(p):
            return []
        with Image.open(p) as im:
            raw = dict(im.info).get("prompt")
        if not raw:
            return []
        return _loras_from_prompt_dict(json.loads(raw))
    except Exception:
        return []


class PromptToolLoraPool:
    """LoRA 池 —— 2026-10-19 第 180 批他第 3 条（先做外形）+ 第 181 批「可以把 Lora 池实装了」。

    外形（他原话）：「正方形上面两个框框，装填 Lora，装填的 Lora 可以通过点一下暂时隐藏不参与生成，
    也可以再点一下重新参与生成，暂时隐藏的会排到不隐藏的后一个；中间来一个左右滑块……下面就是每一个
    Lora 的模型强度或者 CLIP 强度，通过左右滑块调整；列数超越节点时，右边的滑动滑块可以调整上下」。
    **三个滑块各管一件事**：① 中间 = 模式切换（模型强度 / CLIP 强度）；② 每行 = 这颗 LoRA 的强度；
    ③ 右边 = 列表滚动。

    实装（本批）：它是**真节点**了 —— 接 MODEL / CLIP，按顺序把「钩着（用）」的那几颗 LoRA 叠上去：
      for r in loras: if r.on: model, clip = comfy.sd.load_lora_for_models(model, clip, lora, r.model, r.clip)
    隐藏（状态 = 停）的那些直接跳过。前端把池子的状态压成 JSON 塞进隐藏控件「状态」。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "把底模的 MODEL 接进来，叠完 LoRA 从输出接出去"}),
                "clip": ("CLIP", {"tooltip": "把 CLIP 接进来，叠完从输出接出去"}),
                "状态": (
                    "STRING",
                    {"default": "", "multiline": False,
                     "tooltip": "前端把这一池的状态（哪几颗 LoRA、用/停、模型强度、CLIP 强度）压成 JSON 存在这里"},
                ),
            },
            # ★ 283 批（他："Lora 池中的从原图读 Lora …… 勾选之后它就会自动在生图的时候这么干"）
            #   要看整张 prompt 才能找到"画廊节点选中的那张图"，所以要 hidden 的 prompt。
            "hidden": {"prompt": "PROMPT"},
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "apply_pool"
    CATEGORY = "条件/提示词工具"
    DESCRIPTION = (
        "LoRA 池：把 MODEL / CLIP 接进来，按池子里「用」着的那几颗 LoRA 依次叠上去（隐藏/停的不参与）。"
        "每颗 LoRA 有**模型强度**和 **CLIP 强度**两份，用中间的滑块切换当前在调哪一份；"
        "行多了右边能上下滚。LoRA 名单来自你的 models/loras 文件夹。"
    )

    def apply_pool(self, model=None, clip=None, 状态="", prompt=None):
        """按池子状态叠 LoRA。

        ★ 235 批（他原话：「别人导入我的工作流，但是 Lora 池里面暗淡的 Lora 却并不匹配时，
          仍然要保证工作流可以正常运行，也就是说**只要亮起来的 Lora 有文件可以匹配，那就不会报错**」）：
          - **熄灭（停）的 LoRA 一律不碰文件**：缺不缺都跟本次执行无关，连查都不查；
          - **亮着但本机缺文件**的：跳过它 + 最后汇总提示一行，**绝不抛异常**（别人缺几个也得能跑）；
          - 单颗叠加失败（文件坏了 / 版本不对）也只跳过那一颗。
          即"缺 LoRA"永远降级成"少叠一层"，不会变成"工作流报错"。
        """
        try:
            import json
            st = json.loads(状态 or "{}") if isinstance(状态, str) else {}
        except Exception:
            st = {}
        rows = st.get("loras") if isinstance(st, dict) else None
        if not isinstance(rows, list):
            rows = []
        rows = [dict(x) for x in rows if isinstance(x, dict)]      # 复制一份：改的是这次执行的副本
        # ★ 283：底栏那颗 📥 亮着 → 生图时自动把"原图用的 LoRA"并进来（文生图没有原图 → 什么都不做）
        if isinstance(st, dict) and st.get("fromImg"):
            try:
                grel = _gallery_picked_rel(prompt)
                if grel:
                    got = _loras_from_image_rel(grel)
                    if got:
                        byname = {}
                        for x in rows:
                            byname[str(x.get("name") or "").strip()] = x
                        addc = 0
                        for it in got:
                            nm = it["name"]
                            if nm in byname:
                                byname[nm]["on"] = True
                                byname[nm]["model"] = it["model"]
                                byname[nm]["clip"] = it["clip"]
                            else:
                                rows.append({"name": nm, "on": True, "model": it["model"],
                                             "clip": it["clip"], "src": "img"})
                                addc += 1
                        print("[提示词工具] LoRA 池：从原图读到 " + str(len(got)) + " 颗 LoRA"
                              + (("（新加 " + str(addc) + " 颗）") if addc else "") + "，已按原图强度叠上")
            except Exception as exc:      # 读不到就当没开，绝不连累出图
                print("[提示词工具] LoRA 池：读原图 LoRA 失败（跳过）：" + repr(exc))
        # ★ 2026-11-03（他第 5 条）：「弹窗中也可以设置当前组合生图的时候，Lora 池要不要打开」
        #   → 靠 hidden 的 prompt 找到画布上的「模型池」，读它状态里当前那一套的 `loraPool`；
        #     为 false 就**整池跳过**（这一次生图不叠任何 LoRA）。
        try:
            if isinstance(prompt, dict) and isinstance(st, dict):
                for _nid, _n in prompt.items():
                    if str((_n or {}).get("class_type") or "") != "PromptToolModelPool":
                        continue
                    _raw = ((_n or {}).get("inputs") or {}).get("状态") or "{}"
                    _mst = json.loads(_raw) if isinstance(_raw, str) else (_raw or {})
                    _rows = _mst.get("rows") if isinstance(_mst, dict) else None
                    _row = None
                    if isinstance(_rows, list) and _rows:
                        _mk = [x for x in _rows if isinstance(x, dict) and x.get("on")]
                        if _mk:
                            _row = _mk[0]
                        else:
                            _ci = _mst.get("cur", 0)
                            try:
                                _ci = max(0, min(len(_rows) - 1, int(_ci)))
                            except Exception:
                                _ci = 0
                            _row = _rows[_ci] if isinstance(_rows[_ci], dict) else None
                    if isinstance(_row, dict) and _row.get("loraPool") is False:
                        print("[提示词工具] LoRA 池：模型池当前那一套勾了「不用 LoRA 池」，整池跳过")
                        return (model, clip)
                    break
        except Exception:
            pass
        if model is None or clip is None:
            return (model, clip)
        try:
            import comfy.sd
            import comfy.utils
            import folder_paths
        except Exception:
            return (model, clip)
        missing = []
        failed = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            # 「停」的不参与 —— 用真值判断（前端可能存 false / 0 / ""，`is False` 会漏）
            if not r.get("on", True):
                continue
            name = str(r.get("name") or "").strip()
            if not name:
                continue
            try:
                path = folder_paths.get_full_path("loras", name)
            except Exception:
                path = None
            if not path:
                missing.append(name)
                continue
            try:
                lora = comfy.utils.load_torch_file(path, safe_load=True)
                sm = float(r.get("model", 1.0))
                sc = float(r.get("clip", 1.0))
                model, clip = comfy.sd.load_lora_for_models(model, clip, lora, sm, sc)
            except Exception:                   # 单颗失败不影响后面的
                failed.append(name)
                continue
        if missing:
            print("[提示词工具] LoRA 池：亮着的 LoRA 里有 " + str(len(missing))
                  + " 颗在本机没有对应文件，已跳过（不影响其他 LoRA，也不报错）：" + "、".join(missing))
        if failed:
            print("[提示词工具] LoRA 池：这 " + str(len(failed)) + " 颗叠不上去，已跳过："
                  + "、".join(failed))
        return (model, clip)


class PromptToolTimer:
    """计时器（休息计时 + 生图效率）：画布上的秒表 / 闹钟，不参与工作流。

    他 2026-10-05 的原话（先说了规格、又立刻纠正了"放在哪"）：
      · 「套图节点的计时效率，你说超过多少秒响一声，还有特效，响一声的那个音效，就是鸭小黄鸭的那个音效，
        特效就是比较明显的水波特效。至于多少秒响一声，设专门的编辑按钮，自己定，包括音效也可以自己导入文件」
      · 「**计时是单独的节点啊，不应该是套图排队上的节点**」
    —— 所以它是一颗**独立的**节点（本包第 6 颗），套图排队那边一点都不沾。

    它自己同样不参与工作流、也不会被 ComfyUI 执行（没有输出、不是 OUTPUT_NODE），放几颗都不占排队。
    计时用的是 **ComfyUI 自己的事件**（`execution_start` / `execution_success`），所以**任何工作流**出图都能计时，
    不只套图；顺带读一下 `/prompt_sync/batch/status`，套图休息还剩几秒也能一起显示。

    第一百零七批他一次给五条（都已落地）：① 「**点一下钟表，会停止计时而且不叫，直到下一次作图**」；
    ② 「右下角来一个**静音键和关机键**」；③ 「叫声为什么会**连续叫好多下**，这是个 bug 吧」→ 提醒语义改成
    **每张只叫一次**（原来"每超过 N 秒就叫一次"会一直重复）；④ 「现在是**黄条读秒制图时间，灰条读秒制图后的
    休息时间**，可以设置是黄条还是灰条读秒一段时间后叫一声，**二者独立**，所以可以**设置两声**」；⑤ 「**这张有效
    这个键，做的更大一点更显眼一点，颜色不能是灰色的**」→ 改成一颗绿底大键（前端 `addDOMWidget` 画的）。

    节点上一共四样（面板与圆环都在前端 `web/prompt_timer.js`）：
      · **大表盘**：**黄条 = 制图时间**（这一张已经跑了多久）、**灰条 = 休息时间**（上一张出完之后歇了多久），
        各按自己的秒数到点叫一声，中间写出图之后过了多久
      · **「✔ 这张有效」**：一颗**绿色大键**，点一下记一张（计数存在节点属性里）
      · **「⏱ 计时设置…」**：秒数（制图 / 休息两条）/ 音效 / 音量 / 静音 / 试听 / 导入音效文件 / 恢复默认 / 有效图清零
      · **右下角两颗小圆键**：**静音**（只关声音，水波照放）与**关机**（停表 + 不再叫，再点一下开回来）
    另外：**点表盘本体 = 停表且不叫**（下一次出图事件自动恢复）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 第一百零七批（他原话）：「现在是**黄条读秒制图时间，灰条读秒制图后的休息时间**，可以设置是黄条还是
                #   灰条读秒一段时间后叫一声，**二者独立**，所以可以**设置两声**」
                # → 阈值从一条拆成两条：制图（黄条）一条、休息（灰条）一条；**0 = 这一侧不提醒**。
                #   ⚠️ 第一颗控件的**位置没变**（老工作流里那个秒数会原样落到「制图…」这颗上）。
                "制图超过多少秒提醒": (
                    "INT",
                    {"default": 60, "min": 0, "max": 3600,
                     "tooltip": "黄条（这一张已经出了多久）超过这个秒数就叫一声，**每张只叫一次**；0 = 制图这一侧不叫"},
                ),
                "休息超过多少秒提醒": (
                    "INT",
                    {"default": 0, "min": 0, "max": 3600,
                     "tooltip": "灰条（上一张出完之后歇了多久）超过这个秒数就叫一声，**每张只叫一次**；0 = 休息这一侧不叫（默认 0）"},
                ),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "文本/提示词工具"
    DESCRIPTION = (
        "画布上的秒表 / 闹钟（不参与工作流、不会被执行）：大表盘一圈 = 1 分钟，中间写出图之后过了多久；"
        "**黄条 = 制图时间、灰条 = 休息时间，两条各自设一个秒数、各自到点叫一声**（0 = 那一侧不叫；"
        "到点 = 响一声 + 放一圈水波）；"
        "「✔ 这张有效」记有效图张数；右下角两颗键 = 静音 / 关机（关机 = 停表且不再叫，再点一下开回来）；"
        "**点一下表盘就停表且不叫，下一次出图自己恢复**。"
        "计时靠 ComfyUI 自己的出图事件，任何工作流都能用；正在排套图时还会把休息剩几秒显示出来。"
    )

    def noop(self, **kw):
        """永远不会被调到（没有输出 → 不在执行列表里）。"""
        return {}


class PromptToolClipSegments:
    """正负二合一的 CLIP 文本编码：和内置「CLIP文本编码」同一个用途，但文本放在**一个真文本框**里。

    为什么（他 2026-10-04 两句原话）：
      ① 第一轮：「clip 几乎不需要文本细微修改，只要填入一段一段提示词就行了。所以在一口气粘贴一长段提示词的
         时候，就应该用一个虚线把它框起来」
      ② 第二轮：「该节点并不是只有虚线的，而是需要有文本框，**文本框中有虚线框**……虚线框也不是手动添加的，
         而是**粘贴的内容就一定用虚线框框起来**」（手打的字不套框、文本框空了就没有框）
        + 「为了体现出差异性，将其变为**正提示词和负提示词二合一**的节点，负提示词在正提示词下方」

    → 后端只收两份算好的文本：`正提示词` / `负提示词`。
      文本框、粘贴套框、每条框的 ✕ 删 / − 暂时隐藏（**内容留着、不参与生图**）/ ⇄ 换剪贴板、
      以及和「提示词同步」节点一个收一个开，都做在前端（`web/prompt_clip.js`）。

    ⚠️ **这是新建的节点，内置的 CLIP文本编码 一个字都没动**（他明确要"新建一个，不要修改原有的"）。
    ⚠️ 控件顺序：`正提示词` 排第一 —— 老工作流里那个 `text` 的值会按位置落到它身上，不丢内容。

    `提示词同步·正（可不连）` / `提示词同步·负（可不连）`：两个**可选输入口**，分别对上「提示词同步（来自提示词工具）」
    节点的两个输出（他 2026-10-04 要求"从一个输入端变成两个输入端，并且标明一个正一个负"）。
    **口里来的文本优先**：连了就用口里那份去编码，没连就用文本框里写的。

    ⚠️ **收起 = 不参与作图**（他定死的规矩）：前端在这两颗节点的任意一颗被收起时，会把它的文本清空
    （内容留在工作流属性里、展开时写回），所以"从头到尾最多只有一个节点的文本参与作图"是真的。

    ⚠️ 批 C3（2026-10-06）多了两条**藏起来的**控件 `正权重表` / `负权重表`（第一百零六批按他要求
    "正负分开调"拆成两张）：前端把「⚖ 调整正/负关键词权重」那两张表写成 JSON 塞给它，`encode` 只拿它们
    改写**送去编码的那一份文本**（`apply_weights`），**节点框里显示的字一个都不动**
    （他原话：「也不会改变优化节点的文本内容，但是确实可以改变其输出的内容」）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "正提示词": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": False,   # 保住 {{}} / () 这些权重语法，别让动态提示词吃掉
                        "default": "",
                        "tooltip": "正提示词。粘进来的一整段会自动套一个虚线框；框可以暂时隐藏（隐藏的不进图）；上面那两个口连了的话以口里为准",
                    },
                ),
                "负提示词": (
                    "STRING",
                    {
                        "multiline": True,
                        "dynamicPrompts": False,
                        "default": "",
                        "tooltip": "负提示词（在正提示词下面那一个框里，两个一起出条件）",
                    },
                ),
            },
            "optional": {
                "提示词同步·正（可不连）": (
                    "STRING",
                    {"forceInput": True,
                     "tooltip": "（可不连）接「提示词同步（来自提示词工具）」节点的『正提示词』输出。连了就以这里为准；内容参与编码"},
                ),
                "提示词同步·负（可不连）": (
                    "STRING",
                    {"forceInput": True,
                     "tooltip": "（可不连）接「提示词同步（来自提示词工具）」节点的『负提示词』输出。连了就以这里为准；内容参与编码"},
                ),
                # 批 C3（2026-10-06）：关键词权重表 —— **正负各一张**，由前端写进来的两条 JSON
                # （控件都藏起来了，不用手填）。后端只拿它们去改写"送去编码的那份文本"，
                # **框里的字一个字都不动**。他第一百零六批要求"正负分开调"，所以是两条。
                "正权重表": (
                    "STRING",
                    {"default": "", "multiline": False, "dynamicPrompts": False,
                     "tooltip": "（自动写入，不用手填）**正**关键词权重表 JSON —— 由节点中间的「⚖ 调整正关键词权重」和它叫出来的横长条维护；只改送去编码的那份正提示词"},
                ),
                "负权重表": (
                    "STRING",
                    {"default": "", "multiline": False, "dynamicPrompts": False,
                     "tooltip": "（自动写入，不用手填）**负**关键词权重表 JSON —— 由节点底下的「⚖ 调整负关键词权重」和它叫出来的横长条维护；只改送去编码的那份负提示词"},
                ),
            },
        }

    # ⚠️ 2026-11-03 更正：**这颗节点永远只有两个输出口**。
    #   他明确说过「**而不是让优化节点从两个输出口变成三个**」—— 接暂存节点的那个输出口长在
    #   「✎ 自定义优化窗（PromptToolOptAsk）」身上，不长在这里。
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("正向", "负向")
    FUNCTION = "encode"
    CATEGORY = "条件/提示词工具"
    DESCRIPTION = (
        "正负二合一：上面一个正提示词文本框、下面一个负提示词文本框（都从左边收，直接接采样器）。"
        "粘进来的每一段会自动套一个虚线框——框可以 ✕ 删掉、− 暂时隐藏（内容留着、不进图、文字变淡一半）、"
        "⇄ 用剪贴板内容替换；手打的字不套框。左边两个可选口可以直接接「提示词同步」节点的正/负输出（连了以口里为准）。"
        "本节点是新建的，没有改动内置的「CLIP文本编码」。"
    )

    def encode(self, clip, 正提示词="", 负提示词="", 正权重表="", 负权重表="", **kw):
        # 两个「提示词同步·正/负（可不连）」的口**优先**：连了就用口里那份，没连就用文本框里写的
        def port(side):
            for k, v in kw.items():
                if isinstance(k, str) and k.startswith("提示词同步") and side in k:
                    if isinstance(v, str) and v.strip():
                        return v
            return ""
        pos_text = port("正") or (正提示词 or "")
        neg_text = port("负") or (负提示词 or "")
        # 批 C3 / 第一百零六批：**正负各一张权重表**（他要求"正负分开调"），各自只改自己那一侧的文本，
        # 框里的字一个字都不动；表里有、文本里没有的词**加到自己那一侧**（正表 → 正提示词，负表 → 负提示词）。
        wpos = norm_weights(正权重表)
        wneg = norm_weights(负权重表)
        if wpos:
            pos_text = apply_weights(pos_text, wpos, append_missing=True)
        if wneg:
            neg_text = apply_weights(neg_text, wneg, append_missing=True)
        pos = clip.encode_from_tokens_scheduled(clip.tokenize(pos_text))
        neg = clip.encode_from_tokens_scheduled(clip.tokenize(neg_text))
        return (pos, neg)


class PromptToolClipWeight:
    """关键词权重（附属节点）：从「CLIP 文本编码优化节点」右下角那颗「⚖ 调整关键词权重」叫出来的**横长条**。

    他 2026-10-05 的原话：
      · 「优化节点右下方加一个『调整关键词权重』的按钮，点击之后，会显示当前没有关键词，需要你自己填」
      · 「填了对应词之后，关键词就会保留……这时候点击就会让你选新建新的关键词，还是调出已有关键词」
      · 「会叫出一个**横长条状的附属节点**，上面有关键词的**权重示数**，还有一个**横圆形滑块**，
         按圆形滑块左右拖，就会以**最小刻度 0.05** 的方式调整」
      · 「**附属节点不和任何节点连接**，也不会改变优化节点的文本内容，但是确实可以改变其输出的内容」
      · 「如果优化节点中没有对应关键词，实际上也是可以叫出相应关键词的节点的，这样就不是修改权重，
         而是新加一个词，这个词带权重了」
    第一百零六批他又补了三条：
      · 「权重调整应该是一个**横条，中间一个小圆钮**左右拖动调整权重，当然也可以**手动输入数值**」
      · 「权重从一个『调整关键词权重』改成『**调整正关键词权重**』『**调整负关键词权重**』，
         而且一个放在**中间**一个放在**下边**，这样就可以**单独调整**拉出正关键词和负关键词的权重了，
         记得拉出的节点要有**正负之分**」

    所以它是一颗"界面节点"：**没有输入输出、不是 OUTPUT_NODE、永远不执行**（RETURN_TYPES = ()），
    只是画布上的一个横长条（前端 `web/prompt_weight.js` 把它压成一条横杆）：
      · 一条**横条 + 中间那颗小圆钮**（左右拖按 0.05 一格），右边**一个能直接打字的数值框**
      · 条上写着这个词，标题写「⚖ 正/负关键词权重 · 「词」」（正=蓝、负=红，跟他那两排胶囊一个色系）
      · 真正的"哪颗优化节点、哪一侧、哪个词"记在 `properties.pcWeight = {clip, side, word}`（前端维护）
    改完由前端写回优化节点那一侧的权重表（+ 藏起来的那条 JSON 控件），后端 `apply_weights` 才生效。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "关键词": (
                    "STRING",
                    {"default": "", "multiline": False,
                     "tooltip": "这颗附属节点管的是哪个词（一般由优化节点那边「调出已有关键词 / 新建关键词」自动写好）"},
                ),
                "权重": (
                    "FLOAT",
                    {"default": 1.0, "min": WEIGHT_MIN, "max": WEIGHT_MAX, "step": WEIGHT_STEP,
                     "tooltip": "这颗控件前端会藏起来 —— 真正给你拖的是节点上画的**那条横条 + 中间那颗小圆钮**（也可以直接在旁边的数值框里打字）"},
                ),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "条件/提示词工具"
    DESCRIPTION = (
        "从「CLIP 文本编码优化节点」的「⚖ 调整正关键词权重 / ⚖ 调整负关键词权重」叫出来的横长条："
        "上面写着这个词，**拖中间那颗小圆钮**就能按 0.05 一格改权重（也可以在右边的数值框里直接打字）。"
        "它不和任何节点连线、也不会被执行，**只改优化节点送去编码的那一份文本**（框里的字一个都不动）；"
        "标题上写着是**正**还是**负**。本节点不参与工作流。"
    )

    def noop(self, **kw):
        """永远不会被调到（没有输出 → 不在执行列表里）。"""
        return {}



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

    节点上还有两样（都在前端，**不加后端控件**，所以老工作流照旧能开）：
      · **「✔ 这张有效」**：点一下记一张（计数存在节点属性里；每开一轮从 0 重新数）。
      · **LoRA 方案（高级选项）**（2026-10-05 批 C2）：把**当前画面里的所有 LoRA**（文件名 + 两个强度）
        存成方案，最多 4 个、**存了不能改**（要改就删掉重存）；每一张图各自点一个方案，
        排到那张时由 routes.py 把这几颗 LoRA 的设置写回它的 API 图（连线过来的强度不动）。
    ⚠️ **计时 / 提醒不在这个节点上** —— 他 2026-10-05 明确「计时是单独的节点，不应该是套图排队上的节点」，
    所以那套（圆环 / ✔ 有效 / 计时设置 / 音效 / 水波）都在「**计时器（休息计时 + 生图效率）**」那颗节点上，
    见同文件的 `PromptToolTimer` 与 `web/prompt_timer.js`。
    这两样都不占 `widgets_values`，也不参与工作流。

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
                    {"default": 4, "min": 1, "max": 20,
                     "tooltip": "这一轮最多排几张；工具一次最多送 20 段（要更多就用工具的「大规模套图生成」分批送），这里再兜一层上限"},
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
        "节点上还有：「✔ 这张有效」记数 + LoRA 方案（高级选项：把当前画面的所有 LoRA 存成方案、每张各挑一个）。"
        "⚠️ 它得和「提示词同步（来自提示词工具）」节点一起用（提示词由那个节点送出去）；"
        "计时与提醒不在这里，见「计时器（休息计时 + 生图效率）」节点。"
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


# ★ 274：上一轮"读图"时用过的裁切窗口 —— 同一次执行里收图那颗节点据此贴回。
#   一条 prompt 里只有一个读图、一个收图，所以放模块级就够，不需要多连一根线。
_CROP_LAST = {}


def _CropRec():
    return _CROP_LAST


def _crop_cfg(raw):
    """面板写进来的 JSON → {mode, pad, target}。写坏了就一律按默认（auto / 35% / 1024），绝不抛。"""
    import json as _j
    d = {"mode": "auto", "pad": 0.35, "target": 1024, "feather": 16, "expand": 12}   # ★ 285：出厂值
    try:
        o = _j.loads(raw) if isinstance(raw, str) and raw.strip() else (raw if isinstance(raw, dict) else {})
        if isinstance(o, dict):
            if o.get("mode") in ("auto", "off", "always"):
                d["mode"] = o["mode"]
            if o.get("pad") is not None:
                d["pad"] = max(0.0, min(1.5, float(o["pad"]) / 100.0))   # 面板里填的是百分数
            if o.get("target") is not None:
                d["target"] = max(512, min(1536, int(o["target"])))
            # ★ 283 批（他："羽化 / 膨胀做成两个数字，用于调整"）
            if o.get("feather") is not None:
                d["feather"] = max(0, min(200, int(float(o["feather"]))))
            if o.get("expand") is not None:
                d["expand"] = max(0, min(200, int(float(o["expand"]))))
    except Exception:
        pass
    return d


class PromptToolGallery:
    """图像画廊：**代替 PreviewImage**，出一张存一张，面板里就是那三页画廊。

    他 231 批定的口径（234 批开工）：
      ① 一排 4 张缩略图、点开在**节点内放大**、右键出选项、主页 = 节点内面板；
      ② 一张图四个标记（删除 / 下载 / 收藏 / 多选）；删除进**回收站**、可恢复；
      ③ 收藏不占上限、永不被顶掉；主页 / 收藏 / 回收站 **三个分页**；
      ④ 上限 正式 500 / 回收站 100；日期分组在这四类**内部**；
      ⑤ **节点内容不因 ComfyUI 开关 / 重启而重置**（图在磁盘上，不是内存里）。

    存图落在「桌面 / 工具 X.X 正式版 / 图片存档 / 下载 / 日期」目录下，**带 workflow + prompt 两段元数据**
    （"安全复现"就靠这两段，所以绝不做任何重编码）。
    前端界面在 `web/prompt_gallery.js`（这颗节点后端只负责收图、存盘、把新文件名报给前端）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # ★ 273e 批（他："给画廊放一个输出口…画廊给哪个图放第三层单图展示，就说明输出哪张图"）
                #   前端在"第三层放大"时把那张图的相对路径写进这个控件；留空 = 用最新那张。
                #   控件本身在界面上是隐藏的（prompt_gallery.js 里 hideWidget），他看不到。
                "选中的图": ("STRING", {"default": "", "tooltip": "画廊里点开到第三层的那张（自动填，留空 = 最新一张）"}),
                # ★ 274 批（他："不要给我工作流了……裁切放大能不能并入画廊里面，最好是自动裁切"）
                #   自动裁切放大 + 重绘后按原坐标贴回，全在这颗节点里做，**不用多连一根线**。
                #   这个控件在界面上是隐藏的，由面板（画廊设置第 6 项）写 JSON 进来。
                "局部重绘": ("STRING", {"default": "", "tooltip": "自动裁切放大设置（面板写进来的 JSON）：mode=auto/off/always、pad=余量%、target=放大到的短边"}),
                # 上一轮裁切用了哪个窗口 —— 由后端写回、前端只显示，不许他手改
                "裁切记录": ("STRING", {"default": "", "tooltip": "上一轮自动裁切的窗口（x,y,源宽高 → 出图宽高），后端写回，只做参考"}),
            },
            "optional": {
                # 接上就是"出图 → 进画廊存档"（老用法）；不接就是"从画廊读一张图出去"（新的读图用法）
                "images": ("IMAGE", {"tooltip": "把 VAEDecode 接进来就会照旧存进画廊；不接也行 —— 这时这颗节点当读图用"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    # ★ 273g 批（他："图像画廊的输出口要加一个括号，可不连" + "输出口好像需要再加一个 Mask"）
    RETURN_NAMES = ("选中的图（可不连）", "选中的蒙版（可不连）")
    OUTPUT_NODE = True
    FUNCTION = "collect"
    CATEGORY = "图像/提示词工具"
    DESCRIPTION = (
        "两用：接上图像输入 = 出一张存一张（带 workflow 元数据）；不接 = 从画廊读图，"
        "输出「第三层点开的那张」+ 自带的蒙版（透明处=要重绘）。两个输出口都可以不连。"
    )

    # ★ 422 批（他："出问题了" + 输出变成了 1464×1024 的裁切块）
    #   真因：ComfyUI 会**缓存**读图节点的结果 —— 参数没变就跳过执行 → `_auto_crop` 不再跑 →
    #   贴回那一步（`_paste_back`）拿不到裁切记录 → 直接跳过 → 把放大后的裁切块存进了画廊。
    #   返回 NaN 让它每次都真跑（读一张图的代价可以忽略）。
    @classmethod
    def IS_CHANGED(cls, *args, **kwargs):
        return float("nan")

    def collect(self, 选中的图="", 局部重绘="", 裁切记录="", images=None, prompt=None, extra_pnginfo=None):
        from . import routes as R          # 存档逻辑全在 routes.py（那边有纯 Python 自测）
        import time as _t
        import uuid as _u
        # ★ 273e：没接输入图 = 当"读图"用，把第三层选中的那张读回来（没有任何图时给一张 64×64 黑图兜底）
        if images is None:
            img, mask = self._load_picked(选中的图, 局部重绘)
            rec = _CROP_LAST.get("txt", "") or ""
            return {"ui": {"pc_gallery": [], "裁切记录": [rec]}, "result": (img, mask)}
        # ★ 274：如果这一轮的图是"裁切放大块"跑出来的 → 先缩回原尺寸、按原坐标贴回整张图
        try:
            images = self._paste_back(images)
        except Exception as exc:
            print("[提示词工具] ⚠ 贴回失败（按原样存）：" + repr(exc))
        rels = []
        try:
            n = int(images.shape[0])       # [B,H,W,C]
        except Exception:
            n = 0
        # ★ 237 批：**同一次执行**存出来的几张共用一个 batch id → 前端按"组"显示（他说的第二层）
        batch_id = _t.strftime("%Y%m%d%H%M%S") + "-" + _u.uuid4().hex[:6]
        for i in range(n if n >= 1 else 1):
            try:
                one = images[i] if n >= 1 else images
                rels.append(R.archive_put_png(one, prompt=prompt, extra_pnginfo=extra_pnginfo, batch=batch_id))
            except Exception as exc:      # 存不进去也别让整张图白跑
                print("[提示词工具] ⚠ 画廊存图失败：" + repr(exc))
        try:
            R.prune_archive()
        except Exception:
            pass
        # 存完照旧把图往下游递（接不接都一样）；这种用法没有蒙版 → 给一张"全不选"的蒙版，形状对得上
        try:
            import torch
            mask_out = torch.zeros((int(images.shape[0]), int(images.shape[1]), int(images.shape[2])))
        except Exception:
            import torch
            mask_out = torch.zeros((1, 64, 64))
        return {"ui": {"pc_gallery": rels}, "result": (images, mask_out)}

    def _paste_back(self, images):
        """把"裁切放大块"跑出来的图缩回原尺寸、按原坐标贴回整张图。

        只在「上一轮读图时真的裁过」且「尺寸对得上」才动手，否则原样返回（绝不改别人的图）。
        """
        global _CROP_LAST
        rec = dict(_CropRec())
        _CROP_LAST.clear()
        if not rec or not rec.get("rel"):
            return images
        try:
            h, w = int(images.shape[1]), int(images.shape[2])
        except Exception:
            return images
        if (w, h) != (int(rec["outW"]), int(rec["outH"])):
            return images
        try:
            import numpy as np
            import torch
            from PIL import Image, ImageFilter
            from . import routes as R
            p = R._abs_of(rec["rel"])
            # ★ 395：贴回也贴到**叠图合成图**上（否则素材会被原图盖掉）
            try:
                _sp2 = R.stack_path_of(rec["rel"]) if hasattr(R, "stack_path_of") else None
                if _sp2 and os.path.isfile(_sp2):
                    p = _sp2
            except Exception:
                pass
            mp = R.mask_path_of(rec["rel"])
            if not p or not os.path.isfile(p) or not mp or not os.path.isfile(mp):
                return images
            base = Image.open(p).convert("RGB")
            W0, H0 = base.size
            x0, y0 = int(rec["x"]), int(rec["y"])
            cw, ch = int(rec["w"]), int(rec["h"])
            x1, y1 = min(W0, x0 + cw), min(H0, y0 + ch)
            cw, ch = x1 - x0, y1 - y0
            if cw <= 0 or ch <= 0:
                return images
            m = Image.open(mp).convert("L")
            if m.size != (W0, H0):
                m = m.resize((W0, H0), Image.LANCZOS)
            mc = m.crop((x0, y0, x1, y1)).resize((cw, ch), Image.LANCZOS)
            # 边缘羽化一下再贴 —— 不羽化就能看见一条方块边（他说的"错位"就是这个）
            _r = int(rec.get("feather") or 0) or max(2, int(min(cw, ch) * 0.02))
            mc = mc.filter(ImageFilter.GaussianBlur(_r))
            mm = np.array(mc).astype("float32") / 255.0
            # ★ 406 批（他试出"关掉局部重绘后发卡完全消失" → 采样器那块是能重画的，
            #   残影是"贴回"这一步混出来的）→ 贴回改成**硬贴**：蒙版值做一次对比度拉伸，
            #   白区一律 1.0 覆盖，只留一圈很窄的过渡，不再按模糊值做半透明叠加。
            mm = np.clip((mm - 0.15) * 1.45, 0.0, 1.0)
            try:
                _pw = mm > 0.9
                print("[提示词工具] 🩹 贴回蒙版：满覆盖 %.1f%% · 白区均值 %.2f"
                      % (float(_pw.mean()) * 100.0, float(mm[_pw].mean()) if _pw.any() else 0.0))
            except Exception:
                pass
            mm3 = mm[:, :, None]
            out = []
            for i in range(int(images.shape[0])):
                a = (images[i].detach().cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
                piece = Image.fromarray(a).resize((cw, ch), Image.LANCZOS)
                canvas = base.copy()
                reg = np.array(canvas.crop((x0, y0, x1, y1))).astype("float32")
                pc = np.array(piece).astype("float32")
                blend = reg * (1.0 - mm3) + pc * mm3
                canvas.paste(Image.fromarray(blend.clip(0, 255).astype("uint8")), (x0, y0))
                out.append(np.array(canvas).astype("float32") / 255.0)
            print("[提示词工具] 🩹 已贴回：%dx%d 的块 → (%d,%d) 处" % (cw, ch, x0, y0))
            return torch.from_numpy(np.stack(out, 0))
        except Exception as exc:
            print("[提示词工具] ⚠ 贴回异常（按原样存）：" + repr(exc))
            return images

    def _auto_crop(self, rel, path, img_t, mask_t, cfg):
        """涂抹的那一块够小、像素不够时 → 裁出来放大，让模型有足够像素画细节。

        他 274 批的口径：不按四分/六分等分切画布，按**蒙版外接框 + 余量**裁。
        mode=auto 时只有"涂抹区域短边 < 目标短边的一半"才动手（他自己说："四分之前就已经能画出够用的效果了"）。
        """
        import numpy as np
        import torch
        from PIL import Image
        global _CROP_LAST
        _CROP_LAST.clear()
        if str(cfg.get("mode")) == "off":
            return img_t, mask_t
        try:
            mv = mask_t[0].detach().cpu().numpy()
        except Exception:
            return img_t, mask_t
        # ★ 283：先按"膨胀"把蒙版长一圈（用 max_pool2d，几十像素也很快），再算外接框
        _exp = int(cfg.get("expand") or 0)
        if _exp > 0:
            try:
                import torch as _t
                _m0 = _t.from_numpy((mv > 0.5).astype("float32"))[None, None]
                _m1 = _t.nn.functional.max_pool2d(_m0, 2 * _exp + 1, stride=1, padding=_exp)
                mv = _m1[0, 0].numpy()
            except Exception:
                pass
        ys, xs = np.where(mv > 0.5)
        if not len(xs):
            return img_t, mask_t                      # 没涂蒙版 → 一个字都不动
        H, W = mv.shape
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        pw = int(round((x1 - x0) * float(cfg.get("pad", 0.35))))
        ph = int(round((y1 - y0) * float(cfg.get("pad", 0.35))))
        x0, y0 = max(0, x0 - pw), max(0, y0 - ph)
        x1, y1 = min(W, x1 + pw), min(H, y1 + ph)
        w, h = x1 - x0, y1 - y0
        if w < 16 or h < 16:
            return img_t, mask_t
        # ★ 398 批（他："效果仍然不太清晰…会有半透明的眼睛出现"）
        #   他这块素材在整张图里只有 ~80×42 像素。两个老参数一叠加就废了：
        #   ① 裁出来才 110×70，而放大上限写死 4× → 模型只在 440×280 的画布上作画，
        #      而这个模型是 1024 训练的 → 细节出不来 = "不清晰"，还容易在小块里乱认成眼睛/脸。
        #   ② 贴回时羽化 16px，可这块总共才 70 高 → 等于把整块糊成半透明，模型画的眼睛就"透"出来了。
        #   改法：小块自动多带点周围（短边至少 192），放大上限放到 8×，羽化按块的大小自动收窄。
        if min(w, h) < 192:
            _grow = (192 - min(w, h)) / 2.0
            x0, y0 = max(0, int(x0 - _grow)), max(0, int(y0 - _grow))
            x1, y1 = min(W, int(x1 + _grow)), min(H, int(y1 + _grow))
            w, h = x1 - x0, y1 - y0
        short = min(w, h)
        target = int(cfg.get("target", 1024))
        if str(cfg.get("mode")) == "auto" and short >= target * 0.5:
            return img_t, mask_t                      # 抹得够大 = 本来就够像素，不裁
        scale = max(1.0, min(8.0, target / float(max(1, short))))
        outW = max(64, int(round(w * scale / 8.0)) * 8)
        outH = max(64, int(round(h * scale / 8.0)) * 8)
        # ★ 274：长边也封个顶（1536）—— 细长的一条涂痕按 4 倍放大会变成 3000 多像素，显存直接爆
        _MAXS = 1536
        if max(outW, outH) > _MAXS:
            _k = _MAXS / float(max(outW, outH))
            outW = max(64, int(round(outW * _k / 8.0)) * 8)
            outH = max(64, int(round(outH * _k / 8.0)) * 8)
        if scale <= 1.0 and w >= W and h >= H:
            return img_t, mask_t
        # ★ 395 批（他连说三次"重绘只参考原图"）真凶就在这里：
        #   上面刚刚把 IMAGE 换成了**叠图合成图**，可这一行又 `Image.open(path)` 把**原图**读回来裁 ——
        #   合成图白做了。改成从传进来的 img_t 裁（它就是"这次要喂给模型的那张"）。
        try:
            _bn = (img_t[0].detach().cpu().numpy() * 255.0).clip(0, 255).astype("uint8")
            im = Image.fromarray(_bn, "RGB").crop((x0, y0, x1, y1)).resize((outW, outH), Image.LANCZOS)
        except Exception:
            im = Image.open(path).convert("RGB").crop((x0, y0, x1, y1)).resize((outW, outH), Image.LANCZOS)
        arr = np.array(im).astype("float32") / 255.0
        mimg = Image.fromarray((np.clip(mv, 0.0, 1.0) * 255.0).astype("uint8"))
        mimg = mimg.crop((x0, y0, x1, y1)).resize((outW, outH), Image.BILINEAR)
        mvv = np.array(mimg).astype("float32") / 255.0
        # ★ 398：羽化不能超过块子的 6%（110×70 的块给 16px 羽化 = 整块糊成半透明）
        _fe = int(cfg.get("feather") or 0)
        _fe = min(_fe, max(2, int(min(w, h) * 0.06))) if _fe > 0 else 0
        _CROP_LAST.update({"rel": rel, "x": x0, "y": y0, "w": w, "h": h,
                           "outW": outW, "outH": outH,
                           "feather": _fe,
                           "expand": _exp,
                           "txt": "裁 %dx%d @(%d,%d) → %dx%d（%.2f×）%s%s" % (
                               w, h, x0, y0, outW, outH, scale,
                               (" 羽化%d" % _fe) if _fe else "",
                               (" 膨胀%d" % _exp) if _exp else "")})
        print("[提示词工具] 🔍 局部重绘：裁 %dx%d @(%d,%d) → 放大到 %dx%d（%.2f×）羽化%d"
              % (w, h, x0, y0, outW, outH, scale, _fe))
        return torch.from_numpy(arr)[None, ...], torch.from_numpy(mvv)[None, ...]

    def _load_picked(self, rel, cropRaw=""):
        """把画廊里那张图读成 (IMAGE, MASK)。MASK = 那张图自带的 alpha（透明处=1=要重绘）；
        没有 alpha 就是全 0（= 不重绘）。读不到一律给 64×64 黑图 + 全 0 蒙版，绝不抛异常。"""
        import torch
        import numpy as np
        from PIL import Image
        from . import routes as R
        path = None
        try:
            rel0 = str(rel or "").strip()
            if rel0:
                p = R._abs_of(rel0)
                if p and os.path.isfile(p):
                    path = p
            if path is None:
                items = R._scan_page("home") or []
                if items:
                    p2 = R._abs_of(items[0]["rel"])
                    if p2 and os.path.isfile(p2):
                        path = p2
        except Exception:
            path = None
        if path is None:
            print("[提示词工具] ⚠ 画廊里一张图都没有 —— 先出图或往「下载」里放一张")
            return torch.zeros((1, 64, 64, 3)), torch.zeros((1, 64, 64))
        try:
            im0 = Image.open(path)
            has_alpha = (im0.mode in ("RGBA", "LA")) or ("transparency" in im0.info)
            arr = np.array(im0.convert("RGB")).astype("float32") / 255.0
            img_t = torch.from_numpy(arr)[None, ...]
            # ★ 392 批（他："生成的图片还是和底图差不多，奇怪"）
            #   真因：这张图做过「叠图」时，蒙版标的是素材那一块，但 IMAGE 输出还是**没有素材的原图** ——
            #   模型拿到"空着的那块 + 一块蒙版"，只能照着提示词从零画，出来自然还是底图的样子。
            #   叠图的正确喂法是：**IMAGE = 合成图（底图+素材）**，MASK = 素材占的区域 → 模型只需把边缘融合。
            #   合成图的位置记在图层记录的 stack 字段里（素材模式保存时写的）。
            try:
                _used = None
                # ① 固定落点：掩码/<rel~>_stack.png（393 起，素材模式保存时写的）—— 最可靠
                try:
                    sp1 = R.stack_path_of(rel0) if rel0 else None
                    if sp1 and os.path.isfile(sp1):
                        _im1 = Image.open(sp1).convert("RGB")
                        if _im1.size == im0.size:
                            arr = np.array(_im1).astype("float32") / 255.0
                            img_t = torch.from_numpy(arr)[None, ...]
                            _used = "掩码里的合成图"
                        else:
                            print("[提示词工具] ⚠ 叠图合成图尺寸和原图不一致，仍用原图")
                except Exception:
                    pass
                # ② 图层记录里的 stack 字段（383 起）
                if not _used:
                    lp = R.layers_path_of(rel0) if rel0 else None
                    if lp and os.path.isfile(lp):
                        import json as _json
                        with open(lp, "r", encoding="utf-8") as _f:
                            _d = _json.load(_f) or {}
                        _st = str(_d.get("stack") or "").strip()
                        _sp = R._abs_of(_st) if _st else None
                        if _sp and os.path.isfile(_sp):
                            _im2 = Image.open(_sp).convert("RGB")
                            if _im2.size == im0.size:
                                arr = np.array(_im2).astype("float32") / 255.0
                                img_t = torch.from_numpy(arr)[None, ...]
                                _used = "素材栏里的合成图"
                # ③ 兜底：老记录里什么都没有时，去「素材」里找最新的「叠图_<原图名>…」
                if not _used:
                    try:
                        stem = os.path.splitext(os.path.basename(path))[0]
                        root = R.ensure_archive_dirs()
                        cand, ctime = None, -1.0
                        for dp, _dn, fns in os.walk(os.path.join(root, "素材")):
                            for fn in fns:
                                if not fn.lower().endswith(".png") or not fn.startswith("叠图_"):
                                    continue
                                if stem and stem not in fn:
                                    continue
                                p3 = os.path.join(dp, fn)
                                t3 = os.path.getmtime(p3)
                                if t3 > ctime:
                                    cand, ctime = p3, t3
                        if cand:
                            _im3 = Image.open(cand).convert("RGB")
                            if _im3.size == im0.size:
                                arr = np.array(_im3).astype("float32") / 255.0
                                img_t = torch.from_numpy(arr)[None, ...]
                                _used = "素材栏里的合成图（按文件名找的）"
                    except Exception:
                        pass
                # 让他一眼能确认到底用没用（黑窗口每次生成打一行）
                if _used:
                    print("[提示词工具] ✅ 叠图：IMAGE 输出用的是「" + _used + "」，蒙版 = 素材那一块")
                elif rel0:
                    print("[提示词工具] ℹ 这张图没有叠图记录 —— IMAGE 用的是原图")
            except Exception:
                pass
            # ★ 273h：画廊里手画过蒙版的话，MASK 输出优先用它（白 = 要重绘）
            try:
                mp = R.mask_path_of(rel0) if rel0 else None
                if mp and os.path.isfile(mp):
                    m = Image.open(mp).convert("L")
                    if m.size != (arr.shape[1], arr.shape[0]):
                        m = m.resize((arr.shape[1], arr.shape[0]), Image.LANCZOS)
                    mv = np.array(m).astype("float32") / 255.0
                    # ★ 405：把"我交给下游的蒙版有多强"打出来。重绘如果还是半透明，先看这行 ——
                    #   白区均值 1.00 / 最大 1.00 就说明我们这边没问题，是被下游（GrowMask /
                    #   MaskToImage→ImageToMask / 合成节点）弄软了或弄小了。
                    try:
                        _w = mv > 0.5
                        print("[提示词工具] 🔎 交给下游的蒙版：白区占比 %.1f%% · 白区均值 %.2f · 最大 %.2f"
                              % (float(_w.mean()) * 100.0,
                                 float(mv[_w].mean()) if _w.any() else 0.0, float(mv.max())))
                    except Exception:
                        pass
                    return self._auto_crop(rel0, path, img_t, torch.from_numpy(mv)[None, ...], _crop_cfg(cropRaw))
            except Exception:
                pass
            if has_alpha:
                a = np.array(im0.convert("RGBA"))[:, :, 3].astype("float32") / 255.0
                mask_t = torch.from_numpy(1.0 - a)[None, ...]
            else:
                mask_t = torch.zeros((1, arr.shape[0], arr.shape[1]))
            return img_t, mask_t
        except Exception as exc:
            print("[提示词工具] ⚠ 画廊读图失败：" + repr(exc))
            return torch.zeros((1, 64, 64, 3)), torch.zeros((1, 64, 64))


class PromptToolStage:
    """暂存节点：先攒着下一批要用的文本，不打断正在出图的那一批。

    他 2026-11-03 第 1 条的原话：
      · 「自定义节点来一个输出口，连接新的节点暂存节点，注意要有括号显示这个输出口可不连」
      · 「暂存节点就是很正常的上下两个文本框，上面输入文本，然后在自定义优化窗输入要求。在连接情况下，
         点击开始优化，就会把优化之后的文本，不放入优化节点，而是放入暂存节点在下文本框中」
      · 「下文本框有两个键可以将里面的文本转移，既可以从下文本框转移到上文本框，顶掉原来的文本，
         也可以直接转移到优化节点」
      · 「暂存节点的上下文本框都分为两层，正提示词和负提示词。而分层，也就是正提示词负提示词之间的面积比例，
         是可以拖动调整的，默认负提示词只占一排，这样可以把负提示词连带着优化」
      · 「暂存节点的上下文本框也都有着上一步和下一步的切换，正负提示词会不会一起进行上一步下一步的切换，
         要通过开关来开启或关闭」
      · 「有了暂存文本，就可以一边生图，一边准备下一次生图的文本了」

    → **后端一行活儿都不干**：这颗节点没有输出、不是 OUTPUT_NODE，永远不会被执行
      （和计时器 / 工具栏 / LoRA 池同一族）。上下两个框、正负分层、拖动比例、上一步下一步、
      两个转移键，全部在前端 `web/prompt_stage.js` 里画。

    `优化结果（可不连）`：接「CLIP 文本编码优化节点」的第三个输出口。**连上之后，那颗节点点优化
    就不再回写自己的文本框，而是先把结果放进本节点的下框**（待你确认后再转移上去）。
    ⚠️ 这个口只是让"这俩是一对"在画布上看得见 —— 真正的文本由前端直接写，不等 ComfyUI 执行，
    所以优化完立刻就能看到，不用排队跑一次。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "优化结果（可不连）": (
                    "STRING",
                    {"forceInput": True,
                     "tooltip": "（可不连）接「CLIP 文本编码优化节点」的『优化结果（可不连）』输出口。"
                                "连上 = 那颗节点优化完的结果先进本节点的下文本框（不覆盖你现在用的上框）"},
                ),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "文本/提示词工具"
    DESCRIPTION = (
        "暂存节点的用途：**一边生图，一边准备下一次要用的文本**。"
        "上面那个框 = 你现在正在用的（下面那颗优化节点按它出图）；下面那个框 = 刚优化出来、还等你过目的。"
        "下框有两个键：「↑ 顶掉上框」把下框内容搬上去（覆盖上框原文本）／「→ 送进优化节点」直接写进优化节点。"
        "上下两个框都分正/负两层，中间那条分隔线**可以拖**，默认负词只占一行（这样负词也能跟着一起优化）；"
        "两个框各自有上一步/下一步，**正负要不要一起翻由一颗开关决定**。"
        "从「✎ 自定义优化窗」的『优化结果（可不连）』连过来即可；本节点不参与作图、不会被执行。"
    )

    def noop(self, **kw):
        """永远不会被调到（没有输出 → 不在执行列表里）。"""
        return {}


def _comfy_ns():
    """拿到 ComfyUI **根目录**那个 `nodes` 模块（不是本包里的这个同名文件）。

    模型池要靠它调用官方的 UNETLoader / CLIPLoader / VAELoader / CheckpointLoaderSimple，
    这样加载行为和内置节点**完全一致**（fp8 处理、device 选项、pixel_space 之类都不用我们重写）。
    """
    try:
        import sys
        m = sys.modules.get("nodes")
        if m is not None and hasattr(m, "UNETLoader"):
            return m
    except Exception:
        pass
    try:
        import importlib
        m = importlib.import_module("nodes")
        if hasattr(m, "UNETLoader"):
            return m
    except Exception:
        pass
    return None


class PromptToolModelPool:
    """模型池 —— 2026-11-03 他第 5 条（要做，排在暂存节点之后）。

    他的问题（原话）：「需要开发模型池了，因为我要下载 moss，但是原来 Anima 生的图仍然有其画风优势。
    moss 的画风依赖画师串，画师串没有 Lora 稳定，所以需要两种模型并行」。
    外形（原话）：「模型池上中下三个框框，吃掉的节点放进什么框框里面，**就由输出口是模型还是 CLIP 还是 VAE 来决定**」；
      「Checkpoint 可以一口气一个节点连三条线，所以假如这种情况，那就是**模型那个框框是实的模块，另外两个是 50% 灰色压住**」；
      「点击齿轮，跳出弹窗，里面的参数就是当前这个模型的参数」；
      「弹窗中也可以设置**当前组合生图的时候，Lora 池要不要打开**」。
    口径（他 2026-11-03 补的那句，很关键）：「**不用纠结节点到底是一个还是两个，你就把它当成两个呗，
      就当是做了新的一套组合，改了和原来组合不同的参数，所以 CLIP 顺势变为两个节点**」
      → 所以**池子里每条记录 = 模型文件 + 它自己那套参数**，两套要不同参数就是两条记录，
        出图时各自加载、互不影响；**画布上不额外摆空节点**。

    后端只做一件事：读隐藏控件「状态」里 `cur` 指的那一行，把 MODEL/CLIP/VAE 三件加载出来。
    一行三件可以来自：① 一个 Checkpoint（`load_checkpoint` 一次给三件）；
                       ② UNET + CLIP + VAE 三个加载器（各自调官方节点函数）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "状态": (
                    "STRING",
                    {"default": "", "multiline": False,
                     "tooltip": "前端把池子状态压成 JSON 存这里：每套组合的文件名 + 参数 + 当前选中哪一套"},
                ),
            },
            # ★ 2026-11-04（他第 2 条）：「模型池应该也有输入口，但是输入口是不连接的，
            #   同样和输出口是 3 个输入口，同时输入口标注可不连 —— 这是为了实在有什么模型节点我们不兼容，
            #   也可以直接连上，做出串联的效果。啊，更重要的是美观，这样左右对称」
            #   → 三个口**全都不连也能用**（就用池子里选中的那套）；连了哪个就用哪个透传。
            "optional": {
                "MODEL_可不连": ("MODEL", {"tooltip": "可不连：连了就直接用这个 MODEL（碰到不兼容的模型节点可以这样串进来）"}),
                "CLIP_可不连": ("CLIP", {"tooltip": "可不连：连了就直接用这个 CLIP"}),
                "VAE_可不连": ("VAE", {"tooltip": "可不连：连了就直接用这个 VAE"}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "apply_pool"
    CATEGORY = "条件/提示词工具"
    DESCRIPTION = (
        "模型池：把 UNET加载器 / CLIP加载器 / VAE加载器（或一个 Checkpoint）拖进池子，"
        "**按输出口类型自动归位**（MODEL / CLIP / VAE 三个槽），一个模块 = 一套组合。"
        "点模块上的齿轮能改这套的参数、别名，以及生图时要不要带 LoRA 池。"
        "左边三个输入口**可不连**：碰到不兼容的模型节点，可以直接连进来做串联（不连就用池子里选中的那套）。"
        "出图时只加载当前选中的那一套，其余几套留着不占显存。切换模型 = 点另一个模块，不用重新连线。"
    )

    def apply_pool(self, 状态="", MODEL_可不连=None, CLIP_可不连=None, VAE_可不连=None):
        # ★ 2026-11-04（他第 2 条）：三个输入口是"可不连"的 —— 全都没连 = 老行为（读池子）；
        #   连了哪个就用哪个透传（不兼容的模型节点可以这样串进来，做串联）。
        if MODEL_可不连 is not None and CLIP_可不连 is not None and VAE_可不连 is not None:
            print("[提示词工具] ✅ 模型池：三个输入口都连着 → 直接透传（没读池子）")
            return (MODEL_可不连, CLIP_可不连, VAE_可不连)
        import json
        try:
            st = json.loads(状态 or "{}") if isinstance(状态, str) else {}
        except Exception:
            st = {}
        rows = st.get("rows") if isinstance(st, dict) else None
        if not isinstance(rows, list) or not rows:
            raise RuntimeError(
                "模型池是空的 —— 把 UNET 加载器 / CLIP 加载器 / VAE 加载器（或一个 Checkpoint）"
                "拖进池子里就能用"
            )
        # 只认「用」着的那一套；没有明确标记就用 cur 那一行
        cur = st.get("cur", 0)
        try:
            cur = int(cur)
        except Exception:
            cur = 0
        row = None
        marked = [r for r in rows if isinstance(r, dict) and r.get("on")]
        if marked:
            row = marked[0]
        else:
            cur = max(0, min(len(rows) - 1, cur))
            row = rows[cur] if isinstance(rows[cur], dict) else None
        if not isinstance(row, dict):
            raise RuntimeError("模型池里当前那一套是空的 —— 重新拖一个加载器进去")

        cn = _comfy_ns()
        if cn is None:
            raise RuntimeError(
                "拿不到 ComfyUI 的加载器（根目录的 nodes 模块）—— 可能是版本改了名字，告诉我一声"
            )

        kind = str(row.get("kind") or "unet").strip().lower()

        # ---- ① 一个 Checkpoint 给三件 ----
        if kind == "ckpt":
            name = str(row.get("ckpt") or "").strip()
            if not name:
                raise RuntimeError("这一套用的是 Checkpoint，但没选中 checkpoint 文件")
            try:
                model, clip, vae = cn.CheckpointLoaderSimple().load_checkpoint(name)
            except Exception as exc:
                raise RuntimeError("加载 Checkpoint「" + name + "」失败：" + repr(exc))
            print("[提示词工具] ✅ 模型池：用「" + name + "」(Checkpoint，一套三件)")
            if MODEL_可不连 is not None:
                model = MODEL_可不连
            if CLIP_可不连 is not None:
                clip = CLIP_可不连
            if VAE_可不连 is not None:
                vae = VAE_可不连
            return (model, clip, vae)

        # ---- ② UNET + CLIP + VAE 分开 ----
        unet = str(row.get("unet") or "").strip()
        clipn = str(row.get("clip") or "").strip()
        vaen = str(row.get("vae") or "").strip()
        dtype = str(row.get("dtype") or "default").strip() or "default"
        ctype = str(row.get("clipType") or "stable_diffusion").strip() or "stable_diffusion"
        cdev = str(row.get("clipDevice") or "default").strip() or "default"
        if not unet:
            raise RuntimeError("这一套没选中 UNET（扩散模型）文件")
        if not clipn:
            raise RuntimeError("这一套没选中 CLIP（文本编码器）文件")
        if not vaen:
            raise RuntimeError("这一套没选中 VAE 文件")
        try:
            model = cn.UNETLoader().load_unet(unet, dtype)[0]
        except Exception as exc:
            raise RuntimeError("加载 UNET「" + unet + "」失败：" + repr(exc))
        try:
            clip = cn.CLIPLoader().load_clip(clipn, ctype, cdev)[0]
        except Exception as exc:
            raise RuntimeError("加载 CLIP「" + clipn + "」失败：" + repr(exc))
        try:
            vae = cn.VAELoader().load_vae(vaen)[0]
        except Exception as exc:
            raise RuntimeError("加载 VAE「" + vaen + "」失败：" + repr(exc))
        print("[提示词工具] ✅ 模型池：UNET「" + unet + "」+ CLIP「" + clipn + "」（" + ctype
              + "）+ VAE「" + vaen + "」" + ("" if dtype == "default" else "（" + dtype + "）"))
        # ★ 2026-11-04：单个口连着的，就用连着的那个（其余仍读池子）
        if MODEL_可不连 is not None:
            model = MODEL_可不连
        if CLIP_可不连 is not None:
            clip = CLIP_可不连
        if VAE_可不连 is not None:
            vae = VAE_可不连
        return (model, clip, vae)
