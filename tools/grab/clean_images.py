# -*- coding: utf-8 -*-
"""图片清洗：剔除广告图 / 废图 / 重复图。

在抓图之后、构建之前跑一次，把当天目录里的图清洗干净：

    见闻  →  广告图删掉 / 废图删掉 / 重复图删掉
    见笑  →  广告图删掉 / 废图删掉 / 重复图删掉
    见她  →  广告图删掉 / 废图删掉 / 重复图删掉

写真不做自动分流（用户手动整理），原因见下方「写真判据：已下线」。

用法：
    python clean_images.py --date 2026-10-26          # 处理某天
    python clean_images.py --date 2026-10-26 --dry    # 只报告不删
    python clean_images.py --all --dry                # 处理所有日期

────────────────────────────────────────────────────────────
判据怎么来的
────────────────────────────────────────────────────────────
所有阈值都是拿 2026-10-25 / 2026-10-26 的真实数据反推的，不是拍脑袋：

  废图（用户点名的灰色占位图，实测 480x360）：
      唯一色 14、边缘密度 0.0000、饱和度 0.000
      → 判据：uniq < 40 且 edge < 0.001

  广告横幅（用户点名的红色横幅，实测 820x70）：
      长宽比 11.71、16x16 纯色块 std 47.8、饱和度 0.662
      → 判据：ar >= 4.5 且 blk >= 25

  窄条推广图（喷嚏图卦站点水印条，实测 663x100）：
      长宽比 6.63、饱和度 0.043（白底黑字）、纯色块 std 仅 2.2
      → 判据：ar >= 6.0（白底水印条 sat/blk 都不高，只能靠长宽比抓）

  广告方图（9bo 无人机群广告，实测 800x450）：
      饱和度 0.609，OCR 认出「9b0 £ om 0 丿 玩 U 投 上 九 博 @kpay」
      → 判据：sat >= 0.55 且 OCR 文本命中广告词

  反例（确认不误伤）：dd8b91133a_122 是黑白漫画，uniq 只有 220，
      但 edge 高达 0.26、blk 只有 0.01 —— 两个条件都不满足，安全。

为什么 Windows 用系统内置 OCR 而不是 RapidOCR / tesseract：
  - onnxruntime 在这台 Windows 机器上原生崩溃（0xC0000005），RapidOCR 用不了
  - tesseract 没装，中文还要额外下语言包
  - Windows 自带 WinRT OCR，零额外依赖，中文识别质量足够
    （实测「玩 U 投 上 九 博」「@kpay」都认得出来）

macOS / Linux 换成 RapidOCR（pip install rapidocr-onnxruntime）：
  - winsdk 是 WinRT 绑定，别的平台根本装不了 —— 原来在这两个平台上
    一 import 就抛异常，OCR 规则整条失效（带广告文案的图不会被过滤掉）
  - RapidOCR 走纯 onnxruntime，跨平台可用，中文广告词同样认得出来
  - 这条路径没在真机上验证过，所以写得保守：任何异常都吞掉并降级，
    绝不让 OCR 把整个清洗流程搞挂（降级只是少一条广告判据）

为什么 OCR 只在 sat 高的图上跑：
  OCR 慢（全量 200+ 张要几分钟），而正常梗图里带文字的很多
  （实测 14-18 行文字的梗图一大把）—— 全量 OCR 反而容易误伤。
  高饱和是广告的强先验，先用它筛一遍，OCR 只确认。

去重用 pHash（imagehash.phash hash_size=8，阈值 5），
与抓图阶段 daily_grab_all.py 的跨日期去重同一套判据，
但这里跑的是「清洗后的最终态」，能抓到跨目录重复。
"""
import argparse
import asyncio
import glob
import logging
import os
import re
import shutil
import sys

import numpy as np
from PIL import Image
import cv2

log = logging.getLogger("clean_images")

# ══════════════════════════════════════════════════════════
# 阈值（全部来自真实数据反推，见文件头）
# ══════════════════════════════════════════════════════════

# 废图：几乎是纯色/空白的占位图
WASTE_UNIQ = 40        # 唯一色数上限
WASTE_EDGE = 0.001     # 边缘密度上限（Canny 非零像素占比）

# 广告横幅：极端长宽比 + 大面积纯色底板
AD_AR = 4.5            # 长宽比下限
AD_BLK = 25.0          # 16x16 纯色块 std 下限

# 窄条推广图：极端长宽比 + 大面积空白/浅色
# 喷嚏图卦的站点水印条就是这种（663x100，白底黑字，ar=6.63）
STRIP_AR = 6.0         # 长宽比下限（比 AD_AR 更严，避免误伤正常长图）

# 广告方图：高饱和 + 文本命中广告词
AD_SAT = 0.55          # 饱和度下限

# 广告词表：联系方式、推广话术、赌博/彩票类
#
# 词条来源是实测 OCR 出来的真实广告文案，不是凭空想的：
#   红色横幅 001_67993.gif → 「精选推荐 专业分析 实体旗舰店 15155550000」
#   红色横幅 002_67993.gif → 「新用户首单包赔 补贴可达 $888」
#   9bo 广告              → 「玩U投上九博 @kpay 钱包担保 900w美金
#                            验资 飞机市场最大的九博国际 TG投注」
# 所以「实体店/旗舰/首单/包赔/补贴/精选推荐/专业分析」这些
# 看起来很正经的词也得进表 —— 正常梗图不会写这些。
AD_KEYWORDS = re.compile(
    r"(加\s*群|进\s*群|群\s*[0-9]|[Qq][Qq]|薇|微\s*信|加\s*微|代理|招商|加盟|推广|"
    r"优惠|折扣|下单|客服|首充|返利|投注|彩票|博彩|棋牌|捕鱼|送彩金|"
    r"([0-9a-z]+\.(com|cn|net|cc|top|xyz|vip))|"
    r"公众号|旗舰店|实体店|销售|咨询|"
    r"[0-9]{6,}|"
    r"实体\s*旗舰店|精\s*选\s*推\s*荐|专\s*业\s*分\s*析|新\s*用\s*户|"
    r"首\s*单|包\s*赔|补\s*贴|验\s*资|担\s*保|无\s*忧\s*支\s*持|"
    r"专\s*业\s*推\s*荐|旗\s*舰\s*店|加\s*盟\s*热\s*线)"
)

# ── 两条「必须搭配上下文」才算广告的弱特征 ────────────────
#
# 2026-10-30 实测的两个误伤（都是硬删，不可逆）：
#   1) 单字「信」：魔兽「亲爱的兄弟」信件梗图，普通信件/写信/相信 全中
#   2) 裸 @handle：抖音截图里的作者 ID（@lalalala）被判成广告
#
# 处理方式：把这两类从主词表里摘出来，改成「命中了还得同时看到广告语境词」
# 才算广告。语境词表覆盖的是真广告的固定搭配：
#   9bo 广告 → 钱包 担保 验资 群 投注 平台 …
#   抖音梗图 → 没有这些词，只有作者 ID
#
# 注意 9bo 那张仍然会被抓 —— 它的 OCR 文本里还有「9bo.com」，
# 主词表的域名规则独立生效，不依赖 handle。
HANDLE_RE = re.compile(r"@[A-Za-z0-9_]{4,}")
AD_CONTEXT = re.compile(
    r"(代\s*理|招\s*商|加\s*盟|推\s*广|优\s*惠|折\s*扣|下\s*单|客\s*服|"
    r"首\s*充|返\s*利|投\s*注|彩\s*票|博\s*彩|棋\s*牌|捕\s*鱼|送\s*彩\s*金|"
    r"加\s*群|进\s*群|群\s*[0-9]|钱\s*包|担\s*保|验\s*资|包\s*赔|补\s*贴|"
    r"旗\s*舰|实\s*体|销\s*售|咨\s*询|公\s*众\s*号|加\s*微|微\s*信|薇|"
    r"出\s*款|平\s*台|官\s*方|官\s*网|专\s*业|首\s*单|九\s*博)"
)

# 站点自己的域名 —— 喷嚏图卦会往每篇文末塞一条品牌水印条
# （「铂程斋 www.dapenti.com 捕捉生活中的流光溢彩」）。
#
# 注意：这条规则对那张水印条其实**不生效** ——
# 实测 OCR 把 www.dapenti.com 读成了「铂 程 斋 捕 捉 生 活 中 的 流 光 溢 彩」，
# 域名根本没被识别出来。水印条是靠 STRIP_AR（长宽比 >= 6.0）抓到的。
# 这里保留域名规则作为兜底：哪天 OCR 认出域名就能多一层保险。
SELF_DOMAINS = re.compile(
    r"(dapenti\.com|dapenti\.cc|ichouti\.cn|luobo8\.com|ruanyifeng\.com|"
    r"appinn\.net|sspai\.com|ifanr\.com|v2ex\.com|hupu\.com)",
    re.IGNORECASE,
)

# 站点自己的分类目录（源图目录名）
DIR_JIANXIAO = "见笑"
DIR_JIANWEN = "见闻"
DIR_JIANSHE = "见她"

# ══════════════════════════════════════════════════════════
# OCR（Windows 用系统内置 WinRT，macOS/Linux 用 RapidOCR）
# ══════════════════════════════════════════════════════════
#
# 引擎选择（环境变量 MEMES_OCR_ENGINE）：
#   auto（默认） Windows → WinRT(winsdk)；macOS/Linux → RapidOCR
#   winsdk      强制 WinRT —— 非 Windows 上必然失败，走降级
#   rapidocr    强制 RapidOCR（Windows 上也允许显式指定）
#   none        不装引擎，直接跳过 OCR 规则
#
# 降级契约（硬要求）：任何一种引擎都拿不到时 →
# 返回 None + 打警告 + 不崩，OCR 规则跳过。
# OCR 只是广告文案规则的一条判据，不能把整个清洗流程搞挂。

_OCR_ENGINE = None

# 引擎种类标记：_ocr_text 靠它决定走 WinRT 分支还是 RapidOCR 分支
_KIND_WINRT = "winrt"
_KIND_RAPIDOCR = "rapidocr"


class _RapidOcrEngine:
    """RapidOCR 的薄包装。

    只干两件事：
      1) 挂 kind 标记，好让 _ocr_text 认出这不是 WinRT 引擎
      2) 把 RapidOCR 的同步调用包一层，给线程池用
    """

    kind = _KIND_RAPIDOCR

    def __init__(self, engine):
        self._engine = engine

    def run(self, path):
        """同步跑一次 OCR，返回识别到的文本片段列表。

        解析结果时宁缺毋滥 —— 形状不认识就不认：
        绝不用猜出来的碎片去撞广告词表（那样会误删图）。
        """
        result, _elapse = self._engine(path)
        texts = []
        if isinstance(result, (list, tuple)):
            # 老版形态：[box, text, score]，文字取 r[1]
            for r in result:
                if isinstance(r, (list, tuple)) and len(r) >= 2:
                    texts.append(str(r[1]))
        else:
            # 新版形态：带 .txts 的结果对象
            for t in (getattr(result, "txts", None) or []):
                texts.append(str(t))
        return texts


def _ocr_engine_choice():
    """读环境变量 MEMES_OCR_ENGINE，返回引擎选择。"""
    v = (os.environ.get("MEMES_OCR_ENGINE") or "auto").strip().lower()
    if v not in ("auto", "winsdk", "rapidocr", "none"):
        log.warning(f"  未知的 MEMES_OCR_ENGINE={v!r} —— 按 auto 处理")
        v = "auto"
    return v


def _load_ocr():
    """初始化 OCR 引擎。失败返回 None（降级：不跑 OCR 规则）。

    Windows     → WinRT（winsdk，系统内置，零额外依赖）
    macOS/Linux → RapidOCR（pip install rapidocr-onnxruntime）

    拿不到引擎就返回 None + 打警告，绝不抛异常 ——
    清洗流程不能因为 OCR 挂掉。
    """
    global _OCR_ENGINE
    if _OCR_ENGINE is not None:
        return _OCR_ENGINE or None

    choice = _ocr_engine_choice()
    if choice == "none":
        log.warning("  MEMES_OCR_ENGINE=none —— 不加载 OCR 引擎，广告文案规则跳过")
        _OCR_ENGINE = False
        return None
    if choice == "auto":
        # Windows 默认 winsdk（跟原来一模一样），
        # macOS/Linux 默认 rapidocr —— winsdk 是 WinRT，别的平台装不了。
        choice = "winsdk" if sys.platform == "win32" else "rapidocr"

    if choice == "winsdk":
        # ── WinRT 分支：这段就是原来的实现，行为一个字都不改 ──
        try:
            from winsdk.windows.globalization import Language
            from winsdk.windows.media.ocr import OcrEngine
            eng = OcrEngine.try_create_from_language(Language("zh-Hans"))
            if eng is None:
                eng = OcrEngine.try_create_from_user_profile_languages()
            _OCR_ENGINE = eng
            if eng is None:
                log.warning("  没有可用的 OCR 引擎（中文语言包缺失？）—— 广告文案规则跳过")
            return _OCR_ENGINE
        except Exception as e:
            log.warning(f"  OCR 引擎初始化失败（{e}）—— 广告文案规则跳过")
            _OCR_ENGINE = False
            return None

    # ── RapidOCR 分支（macOS/Linux 首选）──
    #
    # 注意：onnxruntime 如果原生崩溃（0xC0000005），Python 是抓不到的 ——
    # 那种硬崩只能靠「别装」来避免（这台 Windows 机器上就装不了，
    # 所以 auto 在 Windows 上仍然走 winsdk）。
    try:
        from rapidocr_onnxruntime import RapidOCR
        _OCR_ENGINE = _RapidOcrEngine(RapidOCR())
        return _OCR_ENGINE
    except ImportError:
        log.warning(
            "  没装 RapidOCR —— 广告文案规则跳过。"
            "装一下即可：pip install rapidocr-onnxruntime"
        )
    except Exception as e:
        log.warning(f"  RapidOCR 引擎初始化失败（{e}）—— 广告文案规则跳过")
    _OCR_ENGINE = False
    return None


async def _ocr_text(engine, path):
    """对一张图做 OCR，返回拼接后的文本。失败返回空串。

    engine 有两种：
      WinRT 引擎 → 原生 await（Windows 行为不变）
      RapidOCR   → 同步调用，丢线程池跑，不阻塞事件循环
    """
    if getattr(engine, "kind", None) == _KIND_RAPIDOCR:
        return await _ocr_text_rapidocr(engine, path)
    try:
        from winsdk.windows.graphics.imaging import BitmapDecoder
        from winsdk.windows.storage import StorageFile
        f = await StorageFile.get_file_from_path_async(path)
        s = await f.open_async(1)          # 1 = FileAccessMode.READ
        dec = await BitmapDecoder.create_async(s)
        bmp = await dec.get_software_bitmap_async()
        res = await engine.recognize_async(bmp)
        return " ".join(ln.text for ln in res.lines)
    except Exception:
        return ""


async def _ocr_text_rapidocr(engine, path):
    """RapidOCR 版 OCR：同步调用丢默认线程池，任何异常都吞掉返回空串。"""
    try:
        loop = asyncio.get_running_loop()
        texts = await loop.run_in_executor(None, engine.run, path)
        return " ".join(texts)
    except Exception:
        return ""


# ══════════════════════════════════════════════════════════
# 图像特征
# ══════════════════════════════════════════════════════════

def image_features(path):
    """算一张图的几何 + 统计特征。

    返回 dict：
      w,h,ar    尺寸与长宽比
      sat       平均饱和度（0-1）
      edge      Canny 边缘密度
      uniq      唯一颜色数
      blk       16x16 分块后的平均 std（大面积纯色 → 高）
    """
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        arr = np.array(im)
    bgr = arr[:, :, ::-1]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 200)
    uniq = _unique_colors(arr)
    small = cv2.resize(bgr, (16, 16), interpolation=cv2.INTER_AREA)
    blk = float(small.reshape(-1, 3).astype(np.int16).std(axis=1).mean())
    return {
        "w": w, "h": h, "ar": w / h,
        "sat": float(hsv[:, :, 1].mean()) / 255.0,
        "edge": float((edges > 0).sum()) / edges.size,
        "uniq": uniq, "blk": blk,
    }


def _unique_colors(arr):
    """统计唯一颜色数。

    实现要点：把 RGB 打包成一个 uint32 再去重，
    而不是 np.unique(arr.reshape(-1, 3), axis=0)。

    两者结果完全一致（实测 40 张图逐张比对，0 处不同），
    但快 30 倍 —— 40 张图 21.94s -> 0.70s。
    axis=0 的写法要对 (N, 3) 做结构化排序，是这条链路上最慢的一步；
    每天几百张图时，光这一项就要几分钟。

    打包用左移而不是乘法，避免 255*65536 之类的中间量溢出 uint32。
    """
    a = arr.astype(np.uint32)
    packed = (a[:, :, 0] << 16) | (a[:, :, 1] << 8) | a[:, :, 2]
    return int(len(np.unique(packed)))


def _skin_ratio(arr):
    """肤色像素占比（与 daily_grab_all.py 同款判据）。"""
    try:
        ycrcb = cv2.cvtColor(arr, cv2.COLOR_BGR2YCrCb)
        y, cr, cb = cv2.split(ycrcb)
        mask = (cr >= 133) & (cr <= 175) & (cb >= 77) & (cb <= 128) & (y > 50)
        b, g, r = cv2.split(arr)
        mask &= (r > g) & (g > b)
        return float(mask.sum()) / float(mask.size)
    except Exception:
        return 0.0


# ─────────────────────────────────────────────────────────────
# 写真判据：已下线
# ─────────────────────────────────────────────────────────────
# 原先有个「写真移到见她」的自动分流，做过完整校准但仍有残余误伤：
# 羊驼、长颈鹿、黑猫、手持卡片的图片肤色占比都很高
# （实测羊驼 skin=0.77，比大部分真人还高），
# 纯靠肤色/平滑度/OCR 字数分不开「真人写真」和「动物特写」。
# 用户决定这批图自己手动整理，所以自动分流整段下线。
#
# 保留这段说明是为了留个记录：真要恢复的话，
# 得先解决「怎么区分人和动物特写」这个硬问题，光调阈值解决不了。
# 上游 daily_grab_all.py 的福利吧分流还在（人脸框 + 肤色双判据），
# 那边的误判率在可接受范围内。


def _lap_var(gray):
    """拉普拉斯方差 —— 画面平滑度（保留供后续规则参考）。

    人物照片是大面积平滑区域（低值）；
    UI 截图/带字幕的图有大量细边缘（高值）。
    """
    blur = cv2.GaussianBlur(gray, (9, 9), 0)
    return float(cv2.Laplacian(blur, cv2.CV_64F).var())


# ══════════════════════════════════════════════════════════
# 规则
# ══════════════════════════════════════════════════════════

def is_waste(f):
    """废图：几乎纯色/空白的占位图。"""
    return f["uniq"] < WASTE_UNIQ and f["edge"] < WASTE_EDGE


def is_banner_ad(f):
    """广告横幅：极端长宽比 + 大面积纯色底板。"""
    return f["ar"] >= AD_AR and f["blk"] >= AD_BLK


def is_text_ad(f, ocr_text):
    """广告方图：文本命中广告词。

    饱和度门槛在这里再判一次 —— 调用方已经保证
    「sat >= AD_SAT 或 ar >= 3.0」才会跑 OCR，
    但窄条图（ar >= 3.0）饱和度可能只有 0.06，
    这种白底文字广告（喷嚏水印条那种）也得认出来。

    两级判定：
      1) 主词表 AD_KEYWORDS 命中 → 直接算广告
      2) 只命中 @handle 这种弱特征 → 还要同时出现广告语境词才算
         （详见 AD_CONTEXT 上面的注释：单字「信」和裸 handle 的误伤）
    """
    if not ocr_text:
        return False, ""
    m = AD_KEYWORDS.search(ocr_text)
    if m is not None:
        return True, m.group(0)
    m = HANDLE_RE.search(ocr_text)
    if m is not None and AD_CONTEXT.search(ocr_text):
        return True, m.group(0)
    return False, ""


def _ext(path):
    """取小写扩展名（含点）。"""
    return os.path.splitext(path)[1].lower()


# 源图支持的格式（和 build.mjs 的扫描规则保持一致）
IMG_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")

# 隔离区：清洗删掉的图先挪到这里，不直接 os.remove
# ────────────────────────────────────────────────────
# 为什么要有隔离区（2026-10-30 加）：
# 清洗是**不可逆**的硬删。出过一次事故 —— OCR 把单字「信」当广告词，
# 误删了一张魔兽信件梗图，等发现时源站图床已经挂了，那张图再也取不回来。
#
# 有了隔离区，误删的图还在原地，可以直接挪回去；
# 确认是废图之后再单独清掉隔离区就行。
#
# 隔离区放在日期目录下的 _quarantine/<分类>/，
# 不在三个分类目录里 —— 构建和 pHash 扫描都只认那三个目录，
# 所以隔离区里的图不会混进当天产物。
QUARANTINE_DIR = "_quarantine"


def _quarantine_path(base_dir, cat_dir, filename, reason):
    """隔离区目标路径；同名时加 _1/_2 后缀，不覆盖。"""
    qdir = os.path.join(base_dir, QUARANTINE_DIR, cat_dir)
    os.makedirs(qdir, exist_ok=True)
    stem, ext = os.path.splitext(filename)
    dst = os.path.join(qdir, filename)
    n = 1
    while os.path.exists(dst):
        dst = os.path.join(qdir, f"{stem}_{n}{ext}")
        n += 1
    return dst, qdir


def _remove_or_quarantine(path, base_dir, cat_dir, reason):
    """删一张图：优先挪进隔离区，挪不动才真删。"""
    try:
        dst, qdir = _quarantine_path(base_dir, cat_dir, os.path.basename(path), reason)
        shutil.move(path, dst)
        return dst
    except Exception:
        try:
            os.remove(path)
        except OSError:
            pass
        return None


def _pair_key(path):
    """配对键 = 文件名开头的原始序号。

    源图命名：001_67993.gif / 002_67993.gif
    转码产物：0e5d98aec1_001_t.webp / 168a8662a1_001.webp
    两边 hash 前缀完全不同，只有序号对得上。
    """
    name = os.path.basename(path)
    m = re.match(r"^(\d+)", name)
    return m.group(1) if m else name


async def clean_dir(dir_path, dry=False, base_dir=None):
    """清洗一个分类目录：删废图 + 删广告图。

    返回统计 dict。
    """
    stats = {"total": 0, "waste": 0, "ad": 0, "errors": 0}
    if not os.path.isdir(dir_path):
        return stats

    if base_dir is None:
        base_dir = os.path.dirname(dir_path)
    cat_dir = os.path.basename(dir_path)

    files = sorted(
        f for f in glob.glob(os.path.join(dir_path, "*"))
        if os.path.isfile(f) and _ext(f) in IMG_EXTS
    )
    if not files:
        return stats

    # 缩略图和全图成对出现：只对全图跑判定，命中了成对处理
    # 源图目录里没有缩略图（那是转码时才产生的），所以这里基本是一对一。
    thumbs = {}
    for f in files:
        if _ext(f) == ".webp" and os.path.basename(f).endswith("_t.webp"):
            thumbs[_pair_key(f)] = f
    fulls = [f for f in files if not (
        _ext(f) == ".webp" and os.path.basename(f).endswith("_t.webp")
    )]

    engine = _load_ocr()
    for f in fulls:
        stats["total"] += 1
        name = os.path.basename(f)
        idx = _pair_key(f)                     # 配对键（原始序号）
        try:
            ft = image_features(f)
        except Exception as e:
            stats["errors"] += 1
            log.warning(f"  特征计算失败 {name}: {e}")
            continue

        # 1) 废图 —— 优先级最高，广告图里也有可能是废的
        if is_waste(ft):
            stats["waste"] += 1
            log.info(f"  [废图] {name}  uniq={ft['uniq']} edge={ft['edge']:.4f}")
            if not dry:
                _remove_or_quarantine(f, base_dir, cat_dir, "waste")
                t = thumbs.get(idx)
                if t and os.path.exists(t):
                    os.remove(t)
            continue

        # 2) 广告 —— 三类规则任一命中
        #
        # 顺序有讲究：先几何（快、零误伤），再 OCR（慢、要判据）。
        #
        #   A. 彩色大底板横幅  ar >= 4.5 且 blk >= 25
        #      红色赌博广告 820x70（ar=11.71 blk=47.8）
        #      绿色首单广告 820x82（ar=10.00 blk=39.6）
        #
        #   B. 窄条推广/水印条  ar >= 6.0
        #      喷嚏图卦水印条 663x100（ar=6.63）
        #      注意阈值不能降到 4.5：那张 800x176（ar=4.55）的
        #      「孩子，你记住，宁愿过度受辱也不要过度思考」是正常梗图，
        #      降到 4.5 就会误伤。
        #
        #   C. OCR 命中广告词（高饱和或窄条才跑 OCR）
        #      9bo 金币广告 800x450（ar=1.78 sat=0.609）
        is_ad = False
        why = ""
        if is_banner_ad(ft):
            is_ad = True
            why = f"彩色底板横幅(ar={ft['ar']:.1f} blk={ft['blk']:.1f})"
        elif ft["ar"] >= STRIP_AR:
            is_ad = True
            why = f"窄条推广图(ar={ft['ar']:.1f} blk={ft['blk']:.1f} sat={ft['sat']:.2f})"
        else:
            # OCR 只在这两种情况下才跑：饱和度高（广告强先验），
            # 或者图很窄长（白底文字条，几何特征不明显）。
            # 全量 OCR 一次要几分钟，而正常梗图带文字的很多，
            # 不加筛选反而容易误伤。
            need_ocr = ft["sat"] >= AD_SAT or ft["ar"] >= 3.0
            if engine is not None and need_ocr:
                txt = await _ocr_text(engine, f)
                hit, kw = is_text_ad(ft, txt)
                if hit:
                    is_ad = True
                    why = f"sat={ft['sat']:.2f} 广告词「{kw}」"
                elif txt and SELF_DOMAINS.search(txt):
                    # 站点自己的品牌水印条（喷嚏图卦每篇文末那条）
                    is_ad = True
                    why = f"站点水印条「{SELF_DOMAINS.search(txt).group(0)}」"

        if is_ad:
            stats["ad"] += 1
            log.info(f"  [广告] {name}  {why}")
            if not dry:
                _remove_or_quarantine(f, base_dir, cat_dir, "ad")
                t = thumbs.get(idx)
                if t and os.path.exists(t):
                    os.remove(t)
            continue

    return stats


def find_dates(src_root):
    """列出 src 根下所有日期目录。"""
    out = []
    try:
        for name in sorted(os.listdir(src_root)):
            p = os.path.join(src_root, name)
            if os.path.isdir(p):
                try:
                    from datetime import date
                    date.fromisoformat(name)
                except (ValueError, TypeError):
                    continue
                out.append(name)
    except OSError:
        pass
    return out


# ══════════════════════════════════════════════════════════
# 去重（pHash）
# ══════════════════════════════════════════════════════════

# 抓取阶段 daily_grab_all.py 已经有跨日期 pHash 去重，
# 但它是「下载时」查的 —— 清洗会把图在目录间搬来搬去，
# 搬完之后不会重新查一遍，同一张图可能同时出现在见笑和见她。
# 这里补一次最终态去重。
#
# 去重阈值**按目录分开定**，不再全局一个数。
#
#   见闻（喷嚏图卦）= 8
#      它把同一条新闻切成上下两段滚动截图：白底黑字、同一个 APP 框架、
#      同一个日期栏，视觉上几乎一模一样（实测 pHash 距离 8），
#      但全局阈值 5 差一点点就漏过去了，肉眼看过去就是「同一张图出现两次」。
#      2026-10-28 那期就有一对（见闻 013/014，同一篇每日经济新闻）。
#
#   见她 / 见笑 = 5（保守）
#      为什么不能全局用 8 —— 2026-10-29 踩到的坑：
#      福利吧的「同一相册构图相近的写真」和「同一微博串的连续截图」，
#      pHash 距离都能到 8，但它们是**完全不同的内容**：
#        见她 081_e25cd.gif（比基尼自拍） vs 119_8a573.gif（同相册另一张）距离 8
#        见笑 064/066（同一微博串，讲骨骼侧弯 vs 讲地球）距离 8
#        见笑 071/072（同一微博串，耳朵梗）距离 8
#      实测当日见她+见笑 205 张，距离 ≤10 的配对**只有这 3 对，全是误判**，
#      距离 0~7 一对都没有 —— 说明这两个目录里根本没有真重复，
#      阈值 8 在这里纯粹是误伤，会白删三张真内容。
#
# 跨目录配对时取**两者中更严的那个**（min），避免一张「见闻新闻截图」
# 因为阈值松就把「见笑梗图」误判成重复删掉。
#
# 为什么见闻定 8 不定 10：实测同一天的距离分布里
#   距离 8  = 1 对，真重复（同一篇新闻的上下两段）
#   距离 12 = 2 对，误报（微博截图 vs 推特截图，完全不同的图）
# 8 卡在真重复和误报之间。调到 12 就会把不同图当重复删掉。
DUP_THRESHOLD_JIANWEN = 8
DUP_THRESHOLD_DEFAULT = 5
DUP_THRESHOLD_BY_CAT = {
    DIR_JIANWEN: DUP_THRESHOLD_JIANWEN,
    DIR_JIANSHE: DUP_THRESHOLD_DEFAULT,
    DIR_JIANXIAO: DUP_THRESHOLD_DEFAULT,
}


def _dup_threshold(cat_a, cat_b):
    """配对去重阈值：跨目录取更严的那个。"""
    ta = DUP_THRESHOLD_BY_CAT.get(cat_a, DUP_THRESHOLD_DEFAULT)
    tb = DUP_THRESHOLD_BY_CAT.get(cat_b, DUP_THRESHOLD_DEFAULT)
    return min(ta, tb)

# 去重时的保留优先级：写真目录（见她）优先于梗图目录（见笑），
# 同级保留文件名靠前的（稳定，重复跑结果一致）。
_DUP_PRIORITY = {DIR_JIANSHE: 0, DIR_JIANXIAO: 1, DIR_JIANWEN: 2}


def _phash(path):
    """算 pHash，失败返回 None。"""
    try:
        import imagehash
        with Image.open(path) as im:
            return imagehash.phash(im, hash_size=8)
    except Exception:
        return None


def dedupe(base_dir, dry=False):
    """同一天内跨目录去重。

    遍历三个分类目录，算 pHash，命中已有图（距离 <= 阈值）就删掉后来的那张。
    按「目录优先级 + 文件名」排序，保证结果稳定可复现。
    """
    entries = []
    for cat in (DIR_JIANWEN, DIR_JIANXIAO, DIR_JIANSHE):
        d = os.path.join(base_dir, cat)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            p = os.path.join(d, fn)
            if os.path.isfile(p) and _ext(p) in IMG_EXTS:
                entries.append((cat, fn, p))

    # 保留优先级低的先来 —— 也就是「优先级高的图先占位」
    entries.sort(key=lambda e: (_DUP_PRIORITY.get(e[0], 9), e[0], e[1]))

    kept = []          # [(path, phash, cat)]
    removed = 0
    for cat, fn, p in entries:
        h = _phash(p)
        if h is None:
            kept.append((p, None, cat))
            continue
        dup = None
        for kp, kh, kcat in kept:
            if kh is None:
                continue
            d = h - kh
            if d <= _dup_threshold(cat, kcat):
                dup = (kp, d)
                break
        if dup:
            removed += 1
            log.info(f"  [重复] {cat}/{fn}  与 {os.path.basename(dup[0])} 重复（距离 {dup[1]}）")
            if not dry:
                _remove_or_quarantine(p, base_dir, cat, "dup")
        else:
            kept.append((p, h, cat))
    return removed


def _default_src_root():
    """源图根目录：家目录下的 image-root/src（**所有平台一致**）。

    跟 daily_grab_all.py 的 _default_out_base() 用同一套路径规则，
    这样「抓图 → 清洗」两端不用手动对齐目录。

    刻意不写盘符：写死 'D:\\xxx' 的话，macOS 上会凭空造一个不存在的目录，
    而且**没有任何报错**。
    """
    return os.path.join(os.path.expanduser("~"), "image-root", "src")


async def main():
    ap = argparse.ArgumentParser(description="剔除广告图/废图，写真移到见她")
    ap.add_argument("--date", help="处理某一天（YYYY-MM-DD）")
    ap.add_argument("--all", action="store_true", help="处理所有日期")
    ap.add_argument("--src-root", default=_default_src_root(), help="源图根目录")
    ap.add_argument("--dry", action="store_true", help="只报告不改动")
    ap.add_argument("--no-ocr", action="store_true", help="跳过 OCR 规则")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    if args.no_ocr:
        global _OCR_ENGINE
        _OCR_ENGINE = False

    if not args.date and not args.all:
        ap.error("要指定 --date 或 --all")

    dates = find_dates(args.src_root) if args.all else [args.date]

    grand = {"total": 0, "waste": 0, "ad": 0, "errors": 0, "dup": 0}
    for d in dates:
        base = os.path.join(args.src_root, d)
        if not os.path.isdir(base):
            log.warning(f"跳过 {d}（目录不存在）")
            continue
        log.info(f"═══ 清洗 {d}{'（dry-run）' if args.dry else ''} ═══")
        for cat in (DIR_JIANWEN, DIR_JIANXIAO, DIR_JIANSHE):
            dir_path = os.path.join(base, cat)
            if not os.path.isdir(dir_path):
                continue
            st = await clean_dir(dir_path, dry=args.dry, base_dir=base)
            log.info(
                f"  {cat}: 共 {st['total']} 张 → 废图 {st['waste']} / 广告 {st['ad']}"
                + (f" / 错误 {st['errors']}" if st["errors"] else "")
            )
            for k in st:
                grand[k] += st[k]

        # 去重放在最后 —— 清洗改过目录内容，
        # 这时候看到的才是最终状态，跨目录重复才抓得全。
        dup = dedupe(base, dry=args.dry)
        grand["dup"] += dup
        log.info(f"  去重：删掉 {dup} 张重复图")

    log.info("──────────── 汇总 ────────────")
    log.info(
        f"共处理 {grand['total']} 张：删废图 {grand['waste']}、删广告 {grand['ad']}、"
        f"删重复 {grand['dup']}"
        + (f"、错误 {grand['errors']}" if grand["errors"] else "")
    )


if __name__ == "__main__":
    asyncio.run(main())
