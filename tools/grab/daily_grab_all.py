# -*- coding: utf-8 -*-
"""每日一次统一入口：3 个 Telegram 频道 + 喷嚏图卦 + 福利吧 + 煎蛋女装区。

输出目录按「站点的三个分类」组织 —— 下载即改名，站点构建端零改动：
  Telegram 三频道  →  见笑/   （梗图）
  喷嚏图卦        →  见闻/
  煎蛋网女装区    →  见她/
  福利吧          →  人像写真 → 见她/，其余 → 见笑/（靠人脸检测分流）

目录名用「下载当天」（发布日期），内容抓的是「昨天」——
和站点「日期页 = 目录名」的语义一致。

用法：
  python daily_grab_all.py                      # 抓昨天
  python daily_grab_all.py --date 2026-10-25    # 指定内容日期
  python daily_grab_all.py --out ~/image-root\\src
"""
import os
import re
import sys
import time
import json
import shutil
import logging
import hashlib
import requests
from datetime import datetime, date, timedelta, timezone
from urllib.parse import urlparse, unquote
from bs4 import BeautifulSoup
from PIL import Image
import imagehash

# 抓取台账：记住哪些 URL 已经抓过，重复的连请求都不发。
# 详见 fetch_ledger.py 顶部的说明（2026-10-28 那次 289 张里 142 张白下）。
try:
    from fetch_ledger import Ledger
except ImportError:  # 直接以脚本方式运行时，同目录能 import 到
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from fetch_ledger import Ledger

LEDGER_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".fetch-ledger.json",
)
LEDGER = Ledger(LEDGER_PATH)


def _date_str(d):
    """日期对象 -> "YYYY-MM-DD"（台账用）。"""
    if d is None:
        from datetime import date as _d
        return _d.today().isoformat()
    if hasattr(d, "isoformat"):
        return d.isoformat()
    return str(d)

# ==================== 配置 ====================


def _default_out_base():
    """输出根目录。

    优先级：--out 参数 > 环境变量 MEMES_DAILY_OUT > 平台默认。

    平台默认 = 用户家目录下的 image-root/src（**所有平台一致**）。

    刻意不写盘符：写死 'D:\\xxx' 的话，macOS 上会凭空造一个不存在的目录，
    而且**没有任何报错**（症状只是「今天没抓到图」）。
    """
    env = os.environ.get("MEMES_DAILY_OUT")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), "image-root", "src")


OUT_BASE = _default_out_base()
LOG_FILE = os.path.join(OUT_BASE, "grab.log")
DEBUG_ROOT = os.path.join(OUT_BASE, "_debug")


def _apply_cli_out():
    """--out 要在日志初始化之前生效，所以提前处理。"""
    global OUT_BASE, LOG_FILE, DEBUG_ROOT
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        if i + 1 < len(sys.argv):
            OUT_BASE = os.path.abspath(sys.argv[i + 1])
            LOG_FILE = os.path.join(OUT_BASE, "grab.log")
            DEBUG_ROOT = os.path.join(OUT_BASE, "_debug")


_apply_cli_out()

# ── 站点的三个分类目录（下载时直接写进这里）────────────────────────
DIR_JIANXIAO = "见笑"   # Telegram 三频道（梗图）
DIR_JIANWEN = "见闻"    # 喷嚏图卦
DIR_JIANSHE = "见她"    # 人像写真（煎蛋女装 + 福利吧里的人像）

# 福利吧的临时目录：先下到这里，人脸分流后再分到 见她/ 见笑/，然后清空
FULIBA_TMP = "_fuliba_tmp"

# 所有分类目录（pHash 跨日期去重要扫的）
ALL_CAT_DIRS = (DIR_JIANWEN, DIR_JIANSHE, DIR_JIANXIAO)

# 福利吧分流到「见她」的判据（两个信号取「或」）
#
# 阈值是拿真实数据调出来的：2026-10-25 那批 23 张福利吧图，
# 人工标了「哪些是人像写真」，然后逐张算指标反推阈值。
# 现在的组合是：漏判 0 张，误判 3 张（一张人民币广告、一张路人远景、一张表情包）。
#
# 想让分流更严 / 更松，就改这两个数：
#   FACE 调大 -> 少进「见她」（梗图漏进见笑的更多）
#   SKIN 调大 -> 多进「见她」（写真的漏进见笑的更多）
PORTRAIT_FACE_RATIO = 0.015   # 人脸框面积 / 画面面积
PORTRAIT_SKIN_RATIO = 0.31    # 肤色像素占比

# 福利吧「相册段」归并：同一相册内，逐张判据会成片出错，
# 所以最后按段统一归类（见 reconcile_fuliba_albums）。
#
# 2026-10-29 实测（2026151 期，97 张福利吧图，人工逐张核对过）：
#   写真段（079~127，39 张全是写真）：逐张判据说「写真」的只有 20 张 = 51.3%
#   梗图段（004~017 / 020~053 / 064~073）：判据说「写真」的占 28.6% / 23.5% / 10%
#   —— 中间隔着 20 多个百分点的空档，40% 正好落在中间，两边都稳。
#
# 为什么会有 51.3% 这种「成片漏判」：
#   那组写真是海边/花园的**背影和远景**，人脸小（YuNet 检不到），
#   肤色又被大片天空海水稀释（skin 只有 0.16~0.29，过不了 0.31 的线）。
#   同一相册里的近景写真（脸清楚）就能判对 —— 于是同一相册被拆成两半。
ALBUM_PORTRAIT_RATIO = 0.40   # 段内「写真」占比达到这个数 → 整段归「见她」
ALBUM_SEGMENT_GAP = 2         # 序号差 ≤2 视为同一相册段（中间可能有下载失败的）
ALBUM_MIN_SEGMENT = 3         # 段里少于这么多张就不做段级归并（统计上没有意义）

# 福利吧的图片文件名：<3位序号>_<5位hex>.<ext>
# 序号来自 grab_web_post 里的 enumerate(urls) —— 也就是**文章内的图片顺序**，
# 正好就是福利吧相册的原始序号，所以能当「相册内第几张」用。
#
# 好处：文件名自带相册序号，不依赖任何运行期状态，
# 上一轮跑剩的残留文件也能直接参与段级归并。
FULIBA_FILE_RE = re.compile(r"^(\d{3})_[0-9a-f]{5}\.(gif|jpg|jpeg|png|webp)$", re.I)

# Telegram 配置
TG_CHANNELS = [
    {"user": "woshadiao",   "label": "每日沙雕墙",  "skip_nsfw": False},
    {"user": "pingrangTV",  "label": "平壤卫视",    "skip_nsfw": False},
    {"user": "jandan_pic",  "label": "煎蛋无聊图",  "skip_nsfw": False},
]
TG_MAX_PAGES = 60
TG_PAGE_SLEEP = 1.2
TG_ITEM_SLEEP = 0.15
TG_MAX_PAGE_RETRIES = 3

# 喷嚏图卦 / 福利吧：自动发现的帖子 → 先下到临时目录，再分流
DAPENTI_OUT = DIR_JIANWEN          # 喷嚏图卦 → 见闻
FULIBA_OUT = FULIBA_TMP             # 福利吧 → 临时目录 → 人脸分流到 见她/ 见笑

BJ = timezone(timedelta(hours=8))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_10) "
                  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
session = requests.Session()
session.headers.update(HEADERS)

# ==================== 日志 ====================

# 提前确保 OUT_BASE 存在 (FileHandler 在 import 时就 open 写日志)
os.makedirs(OUT_BASE, exist_ok=True)

# 控制台是 GBK，日志里出现 ⚠（U+26A0）这类字符会抛 UnicodeEncodeError，
# 报错刷屏还会把真正的错误盖掉（2026-11-01 踩过）。
# 强制 stdout/stderr 用 UTF-8 + replace，坏字符降级成 '?'，绝不抛异常。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("daily_grab_all")

# ==================== 通用工具 ====================

def parse_target_date(s):
    if not s:
        return None
    sl = s.strip().lower()
    if sl in ("today", "t"):
        return datetime.now(BJ).date()
    if sl in ("yesterday", "y"):
        return datetime.now(BJ).date() - timedelta(days=1)
    return datetime.strptime(s, "%Y-%m-%d").date()


def compute_target_day(date_str=None):
    target = parse_target_date(date_str) or (datetime.now(BJ).date() - timedelta(days=1))
    start_utc = datetime(target.year, target.month, target.day, tzinfo=BJ).astimezone(timezone.utc)
    end_utc = start_utc + timedelta(days=1)
    return target, start_utc, end_utc


def in_day(ts_utc_iso, start_utc, end_utc):
    ts = datetime.fromisoformat(ts_utc_iso)
    return start_utc <= ts < end_utc


def ext_from_url(url, default=".jpg"):
    path = urlparse(url).path
    name = unquote(path.split("?")[0].rsplit("/", 1)[-1])
    if "." in name:
        ext = "." + name.rsplit(".", 1)[-1].lower()
        if 2 <= len(ext) <= 6:
            return ext
    if "webp" in url.lower():
        return ".webp"
    if "gif" in url.lower():
        return ".gif"
    return default


# ==================== pHash 去重（跨日期、跨目录） ====================

PHASH_INDEX = {}        # abs_path -> imagehash.ImageHash
PHASH_THRESHOLD = 5    # 距离 ≤ 5 视为同一张图
PHASH_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

# 福利吧每张图的「逐张判据结论」缓存：文件名 -> 是否写真
# 段级归并要按段统计写真占比，总不能再把每张图重新判一遍。
FULIBA_JUDGE = {}

# 喷嚏图卦（见闻）单独用更严的阈值。
#
# 它的图都是新闻截图，同一条新闻常被切成上下两段滚动截图 ——
# 白底黑字、同一个 APP 框架、同一个日期栏，视觉上几乎一模一样
# （实测 pHash 距离 8），但全局阈值 5 差一点点就漏过去了，
# 肉眼看过去就是「同一张图出现两次」。
#
# 为什么只有它需要严：TG 的梗图内容差异大，阈值调高会误伤；
# 新闻截图天然同源（白底、同框架），距离本来就小。
# 实测 2026-10-28 那期 30 张里距离 ≤10 的只有 013/014 这一对，
# 所以 10 是安全的。
DAPENTI_PHASH_THRESHOLD = 10


def _all_root_dirs():
    """所有输出根目录（含 TG、网页源、女装），跨日期扫描。

    返回的是真正存放文件的目录路径集合：OUT_BASE/{any-date}/{category}/
    pHash 索引扫描这些目录以建立跨日期去重。
    """
    dirs = []
    if not os.path.isdir(OUT_BASE):
        return dirs
    for date_entry in os.listdir(OUT_BASE):
        date_path = os.path.join(OUT_BASE, date_entry)
        if not os.path.isdir(date_path):
            continue
        try:
            date.fromisoformat(date_entry)
        except (ValueError, TypeError):
            continue  # 不是日期格式目录（headlines / built / _debug 等），跳过
        for cat in ALL_CAT_DIRS + (FULIBA_TMP,):
            cat_path = os.path.join(date_path, cat)
            if os.path.isdir(cat_path):
                dirs.append(cat_path)
    return dirs


def cat_dir_for(category, target_date=None):
    """返回 OUT_BASE/{北京时区今天}/{category}/ 路径并确保存在.

    文件夹日期 = 下载当天 (mtime 当天)，与 target_date (内容日期) 无关。
    target_date 参数保留兼容旧调用，仅用于日志。
    """
    # 北京时区今天 = UTC + 8h
    bj_today = datetime.now(timezone.utc).astimezone(BJ).date()
    out = os.path.join(OUT_BASE, bj_today.isoformat(), category)
    os.makedirs(out, exist_ok=True)
    return out


def phash_scan_existing():
    """启动时扫一遍所有目录已有图，建立 pHash 索引。
    跨日期也要去重：今天新下载的图如果和昨天/前天的图 pHash 距离 ≤5，
    仍然算重复，不下载新文件。
    """
    cnt = 0
    for d in _all_root_dirs():
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            p = os.path.join(d, fn)
            if not os.path.isfile(p):
                continue
            if os.path.splitext(fn)[1].lower() not in PHASH_EXTS:
                continue
            try:
                with Image.open(p) as im:
                    PHASH_INDEX[p] = imagehash.phash(im, hash_size=8)
                cnt += 1
            except Exception as e:
                log.debug(f"phash skip {p}: {e}")
    log.info(f"pHash 索引：扫描到 {cnt} 张已有图片")


def phash_check_and_cleanup(path, threshold=None):
    """下载完成后做一次 pHash 检查：若与索引内任何图距离 ≤ 阈值，
    删除新文件并返回 True（视为被跳过）。
    否则把新文件加入索引，返回 False。

    threshold 用来给不同源用不同的严格程度：

    喷嚏图卦（见闻）用 10，全局默认仍是 5。
    原因是它的图是「新闻截图」——同一条新闻常被切成上下两段滚动截图，
    白底黑字 + 同一个 APP 框架，视觉上几乎一模一样（实测 pHash 距离 8），
    但全局阈值 5 差一点点就拦不住，肉眼看过去就是同一张图重复。
    实测 10-28 那期 30 张里，距离 ≤10 的只有这一对，调到 10 不会误伤。
    """
    thr = PHASH_THRESHOLD if threshold is None else threshold
    if not os.path.isfile(path):
        return False
    if os.path.splitext(path)[1].lower() not in PHASH_EXTS:
        return False
    try:
        with Image.open(path) as im:
            new_h = imagehash.phash(im, hash_size=8)
    except Exception:
        return False
    for existing_path, existing_h in PHASH_INDEX.items():
        if existing_path == path:
            continue
        d = new_h - existing_h
        if d <= thr:
            try:
                os.remove(path)
            except OSError:
                pass
            log.info(f"  pHash 跳过：{os.path.basename(path)} "
                     f"(与 [{os.path.dirname(existing_path).rsplit('/',1)[-1]}]/"
                     f"{os.path.basename(existing_path)} 距离 {d})")
            return True
    PHASH_INDEX[path] = new_h
    return False


# ==================== Telegram 部分 ====================

def tg_fetch_page(channel, before_id=None, retries=TG_MAX_PAGE_RETRIES):
    url = f"https://t.me/s/{channel}"
    if before_id:
        url = f"{url}?before={before_id}"
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, timeout=30)
            r.raise_for_status()
            return r.text, True
        except Exception as e:
            last_err = e
            time.sleep(2 ** attempt)
    return None, False


def tg_save_debug(channel, target_date, page_no, before_id, html, msgs):
    try:
        dbg_dir = os.path.join(DEBUG_ROOT, channel, target_date.isoformat())
        os.makedirs(dbg_dir, exist_ok=True)
        with open(os.path.join(dbg_dir, f"page_{page_no:03d}.html"), "w", encoding="utf-8") as f:
            f.write(html)
        with open(os.path.join(dbg_dir, f"page_{page_no:03d}.meta.json"), "w", encoding="utf-8") as f:
            json.dump({
                "page": page_no, "before_id": before_id, "n_msgs": len(msgs),
                "msg_ids": [m["id"] for m in msgs],
                "msg_ts_bj": [m["ts_bj"] for m in msgs],
                "msg_image_counts": [len(m["images"]) for m in msgs],
            }, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning(f"  save_debug 失败: {e}")


def tg_extract_image_urls(wrap):
    urls, seen = [], set()
    for ph in wrap.select("a.tgme_widget_message_photo_wrap"):
        style = ph.get("style", "")
        for m in re.finditer(r"background-image\s*:\s*url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", style):
            u = m.group(1).strip()
            if u and u not in seen:
                seen.add(u)
                urls.append(u)
        if not any(u in style for u in seen):
            for img in ph.select("img"):
                src = img.get("src") or img.get("data-src")
                if src and src not in seen:
                    seen.add(src)
                    urls.append(src)
    return urls


def tg_parse_messages(html, channel_user):
    soup = BeautifulSoup(html, "lxml")
    out = []
    for wrap in soup.select("div.tgme_widget_message_wrap"):
        bubble = wrap.select_one("div.tgme_widget_message_bubble")
        if not bubble:
            continue
        post = wrap.select_one("div.tgme_widget_message")
        pid_raw = (post.get("data-post", "") if post else "").split("/")[-1]
        if not pid_raw.isdigit():
            continue
        pid = int(pid_raw)
        time_el = wrap.select_one("time.time")
        if not time_el or not time_el.get("datetime"):
            continue
        ts = datetime.fromisoformat(time_el["datetime"])
        text_el = wrap.select_one("div.tgme_widget_message_text")
        text = text_el.get_text("\n", strip=True) if text_el else ""
        is_nsfw = False
        if re.search(r"#NSFW|#nsfw", text, re.I):
            is_nsfw = True
        if wrap.select_one("tg-spoiler"):
            is_nsfw = True
        if wrap.select_one(".tgme_widget_message_photo_wrap.blured"):
            is_nsfw = True
        if wrap.select_one(".tgme_widget_message_video_player.blured"):
            is_nsfw = True
        images = tg_extract_image_urls(wrap)
        video = None
        vp = wrap.select_one("a.tgme_widget_message_video_player")
        if vp:
            v = vp.select_one("video")
            if v and v.get("src"):
                video = v["src"]
        out.append({
            "id": pid,
            "ts_utc": ts.astimezone(timezone.utc).isoformat(),
            "ts_bj": ts.astimezone(BJ).isoformat(),
            "text": text[:500],
            "is_nsfw": is_nsfw,
            "images": images,
            "video": video,
            "url": f"https://t.me/{channel_user}/{pid}",
        })
    return out


def tg_fetch_single_post_og_image(channel_user, mid):
    url = f"https://t.me/{channel_user}/{mid}"
    try:
        r = session.get(url, timeout=20)
        if r.status_code != 200:
            return None
        m = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', r.text)
        if not m:
            return None
        img_url = m.group(1).strip()
        if "preview" in img_url.lower() and "placeholder" in img_url.lower():
            return None
        return img_url
    except Exception as e:
        log.warning(f"  tg_fetch_single_post({mid}) 失败: {e}")
        return None


def tg_linear_interp_ts(prev_id, prev_ts_bj, post_id, post_ts_bj, target_id):
    if post_id == prev_id:
        return prev_ts_bj
    frac = (target_id - prev_id) / (post_id - prev_id)
    prev_dt = datetime.fromisoformat(prev_ts_bj)
    post_dt = datetime.fromisoformat(post_ts_bj)
    return (prev_dt + (post_dt - prev_dt) * frac).isoformat()


def tg_fill_id_gaps(channel_user, msgs, target_date, day_start_utc, day_end_utc):
    if not msgs:
        return msgs
    msgs = sorted(msgs, key=lambda m: m["id"])
    existing = set(m["id"] for m in msgs)
    filled = []
    s_ok, n_noimg, n_skip = 0, 0, 0
    for i in range(len(msgs) - 1):
        prev = msgs[i]; nxt = msgs[i + 1]
        for mid in range(prev["id"] + 1, nxt["id"]):
            if mid in existing:
                continue
            interp = tg_linear_interp_ts(prev["id"], prev["ts_bj"], nxt["id"], nxt["ts_bj"], mid)
            interp_utc = datetime.fromisoformat(interp).astimezone(timezone.utc)
            if not (day_start_utc <= interp_utc < day_end_utc):
                n_skip += 1
                continue
            img_url = tg_fetch_single_post_og_image(channel_user, mid)
            if not img_url:
                n_noimg += 1
                continue
            filled.append({
                "id": mid, "ts_utc": interp_utc.isoformat(), "ts_bj": interp,
                "text": "", "is_nsfw": False, "images": [img_url],
                "video": None, "url": f"https://t.me/{channel_user}/{mid}",
                "filled_gap": True,
            })
            existing.add(mid)
            s_ok += 1
            time.sleep(0.4)
    if s_ok or n_noimg or n_skip:
        log.info(f"  空洞直访补全: 成功 {s_ok}, 无图 {n_noimg}, 不在目标日 {n_skip}")
    return sorted(msgs + filled, key=lambda m: m["id"])


def tg_download(url, path, retries=3):
    """下载一张 TG 图片。

    必须带重试：cdn*.telesco.pe 会**间歇性**在 TLS 握手时掐断连接
    （SSLEOFError: UNEXPECTED_EOF_WHILE_READING）。2026-11-01 实测 5 张这样失败的，
    原样重发一次全部成功（HTTP 200）—— 不重试就是白白丢图。
    """
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return "skip"
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            with session.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                with open(path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=64 * 1024):
                        if chunk:
                            f.write(chunk)
            if phash_check_and_cleanup(path):
                return "phash_skip"
            return "ok"
        except Exception as e:
            last_err = e
            # 半截文件要清掉，否则下次会被「文件已存在就跳过」当成好的
            try:
                if os.path.exists(path) and os.path.getsize(path) == 0:
                    os.remove(path)
            except OSError:
                pass
            if attempt < retries:
                log.info(f"    下载重试 {attempt}/{retries}: {str(e)[:80]}")
                time.sleep(1.5 * attempt)
    log.warning(f"  下载失败 {url}: {last_err}")
    return "fail"


def grab_telegram_channel(channel_user, channel_label, day_start_utc, day_end_utc, target_date):
    img_dir = cat_dir_for(DIR_JIANXIAO, target_date)
    log.info(f"  输出目录: {img_dir}")
    log.info(f"==== TG {channel_user} ({channel_label}) ====")
    all_msgs = []
    before_id = None
    page = 0
    prev_oldest_id = None
    boundary_crossed = False

    while page < TG_MAX_PAGES:
        page += 1
        html, ok = tg_fetch_page(channel_user, before_id)
        if not ok or not html:
            log.warning(f"  第 {page} 页三次重试均失败，停止翻页。")
            break
        msgs = tg_parse_messages(html, channel_user)
        tg_save_debug(channel_user, target_date, page, before_id, html, msgs)
        if not msgs:
            log.info(f"  第 {page} 页无消息，停止。")
            break
        oldest = min(msgs, key=lambda m: m["id"])
        newest = max(msgs, key=lambda m: m["id"])
        log.info(f"  第 {page} 页 {len(msgs)} 条，id {newest['id']} @ {newest['ts_bj']}  ~  {oldest['id']} @ {oldest['ts_bj']}")
        if prev_oldest_id is not None:
            expected = prev_oldest_id - 1
            if newest["id"] != expected:
                log.warning(f"  ID 空洞: 预期 {expected}, 实际 {newest['id']}, 缺 {expected - newest['id']} 条")
        prev_oldest_id = oldest["id"]
        all_msgs.extend(m for m in msgs if in_day(m["ts_utc"], day_start_utc, day_end_utc))
        if datetime.fromisoformat(oldest["ts_utc"]) < day_start_utc:
            if not boundary_crossed:
                boundary_crossed = True
                log.info("  已跨过目标日期起点，额外多翻 1 页确认。")
                before_id = oldest["id"]
                time.sleep(TG_PAGE_SLEEP)
                continue
            else:
                log.info("  确认已离开目标日期，停止翻页。")
                break
        before_id = oldest["id"]
        time.sleep(TG_PAGE_SLEEP)

    all_msgs = tg_fill_id_gaps(channel_user, all_msgs, target_date, day_start_utc, day_end_utc)

    seen = set()
    unique = []
    for m in all_msgs:
        if m["id"] in seen:
            continue
        seen.add(m["id"])
        unique.append(m)
    unique.sort(key=lambda m: m["id"])
    log.info(f"  目标日共 {len(unique)} 条消息")

    ok_img = skip_img = fail_img = nsfw_count = n_text_only = 0
    phash_img = 0
    # 消息之间也要按 URL 去重：
    # Telegram 同一张图在两条消息里（转发、复读）用的是同一个 file_id，
    # URL 完全一样。而文件名带 msgid，「文件已存在就跳过」拦不住，
    # 于是同一张图会被完整下载两遍，第二遍下完才被 pHash 扔掉。
    seen_img_urls = set()
    dup_img = 0
    ledger_skip = 0
    for m in unique:
        if not m["images"]:
            n_text_only += 1
        bj_time = datetime.fromisoformat(m["ts_bj"]).strftime("%Y%m%d_%H%M%S")
        prefix = f"{channel_user}_{m['id']}_{bj_time}"
        for idx, img_url in enumerate(m["images"]):
            if img_url in seen_img_urls:
                dup_img += 1
                continue
            seen_img_urls.add(img_url)
            # 台账预检：以前抓过的 URL 直接跳过，连请求都不发
            if LEDGER.seen_url(img_url):
                ledger_skip += 1
                continue
            ext = ext_from_url(img_url)
            path = os.path.join(img_dir, f"{prefix}_img{idx}{ext}")
            r = tg_download(img_url, path)
            if r == "ok":
                ok_img += 1
                LEDGER.mark_url(img_url)
            elif r == "skip":
                skip_img += 1
                LEDGER.mark_url(img_url)
            elif r == "phash_skip":
                # 内容重复：图下过了但被 pHash 扔掉。
                # 以前这个分支落进 else 被算成「下载失败」，
                # 2026-11-01 那次日志报「失败 43」，实际真失败只有 5 张
                # （另外 38 张是 pHash 去重）—— 差点去查不存在的问题。
                phash_img += 1
                LEDGER.mark_url(img_url)
            else:
                fail_img += 1
            time.sleep(TG_ITEM_SLEEP)
    log.info(f"  结果: 新增 {ok_img} 跳过 {skip_img} 失败 {fail_img}, "
             f"pHash去重 {phash_img}, 同 URL 重复 {dup_img}（没下）, "
             f"NSFW 跳过 {nsfw_count}, 纯文本 {n_text_only}")
    if ledger_skip:
        log.info(f"  台账跳过 {ledger_skip} 张（以前抓过，这次没发请求）")


# ==================== 煎蛋网女装区 (jandan.net/beauty) ====================

JANDAN_BEAUTY_SECTION_ID = 108629
JANDAN_BEAUTY_API = "https://jandan.net/api/comment/post/{sid}?order=desc&page={p}"
JANDAN_BEAUTY_DIR = DIR_JIANSHE   # 煎蛋女装区 → 见她

JANDAN_BEAUTY_API_HEADERS = {
    "User-Agent": HEADERS["User-Agent"],
    "Referer": "https://jandan.net/beauty",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://jandan.net",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
}
JANDAN_BEAUTY_IMG_HEADERS = {
    "User-Agent": HEADERS["User-Agent"],
    "Referer": "https://jandan.net/",
    "Accept": "image/avif,image/webp,*/*",
}


# 从最新页往前最多翻多少页（一天约 30~60 帖、每页 20 帖，翻 15 页足够覆盖好几天）
JANDAN_BEAUTY_MAX_PAGES = 15
JANDAN_BEAUTY_IMG_RE = re.compile(r"\.(?:jpg|jpeg|png|gif|webp)(?:\?|$)", re.I)


def _jandan_beauty_fetch_page(page=None):
    """取煎蛋女装区某一页的帖子列表。

    page=None → 不带 page 参数，API 返回「最新页」（current_page == total_pages）。
    返回 {"ok": bool, "list": [...], "total_pages": int, "current_page": int,
          "code": ..., "msg": ...}

    2026-10-31 实测，把之前「登录墙」的误判彻底修掉了：
      · 不带 page 参数 → 最新 10 条，current_page = total_pages = 339
      · ?order=desc&page=N → **正常**返回第 N 页，每页 20 条
      · 登录墙（code=1000「较老的数据仅对登陆用户开放访问」）只挡**很老**的页：
        page=1/2/5 全被挡，而 page=325~339 全部 code=0 正常返回。
        之前误判成「page 参数被锁」，是因为只试了 page=1/2/5 这几个最老的页。
      · ?date= / ?before_id= 这类参数仍被静默忽略，翻页只能用 page。
    """
    if page is None:
        url = f"https://jandan.net/api/comment/post/{JANDAN_BEAUTY_SECTION_ID}"
    else:
        url = JANDAN_BEAUTY_API.format(sid=JANDAN_BEAUTY_SECTION_ID, p=page)
    try:
        r = session.get(url, headers=JANDAN_BEAUTY_API_HEADERS, timeout=30)
        if r.status_code != 200:
            return {"ok": False, "code": r.status_code, "msg": f"HTTP {r.status_code}"}
        j = r.json()
    except Exception as e:
        return {"ok": False, "code": -1, "msg": str(e)}
    if j.get("code") != 0:
        return {"ok": False, "code": j.get("code"), "msg": j.get("msg", "")}
    d = j.get("data") or {}
    return {
        "ok": True,
        "list": d.get("list") or [],
        "total_pages": int(d.get("total_pages") or 0),
        "current_page": int(d.get("current_page") or 0),
    }


def _jandan_beauty_to_large(url):
    return re.sub(r"/(mw600|mw1024|orj\d+|thumb\d+)/", "/large/", url)


def _jandan_beauty_get_ext(url):
    m = re.search(r"\.(\w+)$", urlparse(url).path)
    return m.group(1) if m else "jpg"


def grab_jandan_beauty(target_date):
    """煎蛋网女装区某一天的所有原图。

    target_date: datetime.date 对象（内容日期，不是发布日）
    输出目录: OUT_BASE/{北京时区今天}/见她/

    2026-10-31 修复的关键 bug
    -------------------------
    旧版只请求「不带 page 参数」的一页（API 只给最新 ~10 条），再按日期前缀
    筛目标日 —— 目标日绝大多数内容根本不在这一页里，所以见她经常是 0 张。
    实测 page 参数完全可用（登录墙只挡很老的页，见 _jandan_beauty_fetch_page），
    现在从最新页往前翻，翻到整页都早于目标日为止，再按日期前缀取目标日的帖。
    """
    log.info(f"==== 煎蛋网女装区 ====")
    out_dir = cat_dir_for(JANDAN_BEAUTY_DIR, target_date)
    log.info(f"  输出目录: {out_dir}")
    target_prefix = target_date.isoformat()
    target_start = target_prefix + "T00:00:00"

    head = _jandan_beauty_fetch_page(None)
    if not head.get("ok"):
        log.error(f"  API 请求失败: code={head.get('code')} msg={str(head.get('msg',''))[:80]!r}")
        return
    total_pages = head.get("total_pages") or 0
    cur_page = head.get("current_page") or total_pages
    log.info(f"  最新页 page={cur_page} / total_pages={total_pages}")

    # 从最新页往前翻，直到整页内容都早于目标日 00:00:00
    collected = []
    page = cur_page
    walked = 0
    while page >= 1 and walked < JANDAN_BEAUTY_MAX_PAGES:
        data = head if page == cur_page else _jandan_beauty_fetch_page(page)
        if not data.get("ok"):
            log.warning(f"  page={page} 拿不到数据 code={data.get('code')} "
                        f"msg={str(data.get('msg',''))[:80]!r} → 停止往前翻")
            break
        lst = data.get("list") or []
        if not lst:
            log.warning(f"  page={page} 返回空 list → 停止往前翻")
            break
        dates = [(p.get("date_gmt") or "") for p in lst]
        newest, oldest = max(dates), min(dates)
        collected.extend(lst)
        walked += 1
        log.info(f"    page={page}: {len(lst)} 帖  {newest[:19]} ~ {oldest[:19]}")
        if oldest < target_start:
            break
        page -= 1

    posts = [p for p in collected if (p.get("date_gmt") or "").startswith(target_prefix)]
    log.info(f"  目标日 {target_prefix} 命中 {len(posts)} 帖"
             f"（翻了 {walked} 页，共 {len(collected)} 帖）")
    if not posts:
        log.warning(f"  ⚠ 目标日 {target_prefix} 没有帖子")
        return

    # 抽图：post.content 里的 <img src=...>
    images = []
    for p in posts:
        content = p.get("content") or ""
        for idx, url in enumerate(re.findall(r'<img\s+[^>]*src="([^"]+)"', content)):
            if url.startswith("//"):
                url = "https:" + url
            if not JANDAN_BEAUTY_IMG_RE.search(url):
                continue
            images.append({
                "post_id": p.get("id"),
                "date": p.get("date_gmt"),
                "author": p.get("author"),
                "index": idx,
                "url": url,
            })
    log.info(f"  解析出 {len(images)} 张图")

    # 按 post_id 分组，命名 NN 序号
    from collections import defaultdict
    cnt = defaultdict(int)
    ok = skip = fail = phash_skip = ledger_skip = 0
    for img in images:
        cnt[img["post_id"]] += 1
        large = _jandan_beauty_to_large(img["url"])
        ext = _jandan_beauty_get_ext(large)
        fname = f"{img['post_id']}_{cnt[img['post_id']]:02d}.{ext}"
        path = os.path.join(out_dir, fname)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            skip += 1
            LEDGER.mark_url(large, _date_str(target_date))
            continue
        # 台账预检：以前抓过的 URL 直接跳过，连请求都不发
        if LEDGER.seen_url(large):
            ledger_skip += 1
            continue
        try:
            r = session.get(large, headers=JANDAN_BEAUTY_IMG_HEADERS,
                            stream=True, timeout=60)
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        f.write(chunk)
            LEDGER.mark_url(large, _date_str(target_date))
            if phash_check_and_cleanup(path):
                phash_skip += 1
            else:
                ok += 1
        except Exception as e:
            log.warning(f"  下载失败 {large}: {e}")
            fail += 1
        time.sleep(0.3)
    log.info(f"  结果: 新增 {ok} 跳过 {skip} 台账跳过 {ledger_skip} "
             f"pHash跳过 {phash_skip} 失败 {fail} → {out_dir}")


# ==================== 网页自动发现 + 抓取 ====================


# ==================== 网页自动发现 + 抓取 ====================

def _get_retry(url, tries=3, timeout=20, **kw):
    """抓网页，失败自动重试。

    为什么必须重试（2026-11-05 实测）：
    福利吧的 RSS 和文章页会**间歇性直接断开连接**
    （ConnectionResetError 10054「远程主机强迫关闭了一个现有的连接」）。
    实测同一个 URL 第一次失败、隔几秒第二次就成功 —— 而抓取器原来只请求一次，
    失败一次整期福利吧就 0 张（2026-11-04 那期就是这么没的：
    台账里福利吧的真实图地址只记到 11-03，11-04/11-05 全空）。

    只重试**连接层**的异常（超时/断开），不动 HTTP 状态码判断 ——
    状态码交给调用方的 raise_for_status()，语义不变。
    """
    last = None
    for i in range(tries):
        try:
            return session.get(url, timeout=timeout, **kw)
        except Exception as e:
            last = e
            log.warning(f"  ! 抓取失败（第 {i+1}/{tries} 次）: {url[:70]} —— "
                        f"{type(e).__name__}: {str(e)[:70]}")
            if i < tries - 1:
                time.sleep(1.5 * (i + 1))
    raise last


def _parse_tugua_date(title):
    """从图卦标题里解析它自己的日期。

    标题形如「【喷嚏图卦20261104】TRUMP OUT」→ '2026-11-04'。
    解析不出来就返回 None（让调用方退回「取最新」的老行为）。
    """
    m = re.search(r"图卦(\d{8})", title or "")
    if not m:
        return None
    d = m.group(1)
    return f"{d[0:4]}-{d[4:6]}-{d[6:8]}"


def web_discover_dapenti_tugua(target_date=None):
    """喷嚏图卦「带图版」：按**内容日期**挑那一期，排除同日的「音频版」。

    为什么必须按日期挑（2026-11-05 修）：
    原来这里取的是「id 最大的那一篇」，也就是**最新发表的**。
    但站点每天早上就把当天那期的图卦发出来了，于是「取最新」会**提前一天**把内容吃掉：

      - 11-04 那趟（内容日 11-03）抓到的是【喷嚏图卦20261104】，
        提前一天进了 11-04 那一期（11-04 期本该是【喷嚏图卦20261103】）；
      - 11-05 那趟（内容日 11-04）要的正是【喷嚏图卦20261104】，
        结果台账判定「抓过」→ 45 张全跳过 → **见闻整栏归零**。

    症状跟 2026-10-28 那次「换图床导致见闻归零」一模一样（见闻 0 张），
    但根因完全不同 —— 那个是过滤规则，这个是选期规则。

    标题里带日期（【喷嚏图卦20261104】），直接解析出来按日期选：
      1. 日期正好等于内容日的 → 用它；
      2. 没有正好相等的 → 用「日期不超过内容日」里最新的；
      3. 连这个都没有（站点还没发）→ 退回最新，但会打警告说明会提前发。
    """
    r = _get_retry("https://www.dapenti.com/")
    r.raise_for_status()
    html = r.content.decode("gbk", errors="replace")
    soup = BeautifulSoup(html, "lxml")
    candidates = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if ("name=xilei" not in href) or ("more" not in href) or ("id=" not in href):
            continue
        m = re.search(r"id=(\d+)", href)
        if not m:
            continue
        title = (a.get("title") or a.get_text() or "").strip()
        if "喷嚏图卦" in title and "音频" not in title:
            candidates.append({
                "id": int(m.group(1)),
                "title": title,
                "date": _parse_tugua_date(title),
                "url": f"https://www.dapenti.com/blog/more.asp?name=xilei&id={m.group(1)}",
            })
    candidates.sort(key=lambda c: c["id"], reverse=True)
    if not candidates:
        return None
    if target_date is not None:
        want = _date_str(target_date)
        exact = [c for c in candidates if c["date"] == want]
        if exact:
            return exact[0]
        older = [c for c in candidates if c["date"] and c["date"] <= want]
        if older:
            log.info(f"  没有内容日 {want} 的那一期，用最近的 {older[0]['date']}"
                     f"（{older[0]['title'][:30]}）")
            return older[0]
        log.warning(
            f"  ! 喷嚏图卦还没有内容日 {want} 的那一期，最新的是 {candidates[0]['date']}"
            f"（{candidates[0]['title'][:30]}）—— 这一期会提前发布"
        )
    return candidates[0]


def _fuliba_is_notice_page(html):
    """福利吧整站维护时，所有路径都返回同一个 Discuz「提示信息」页。

    2026-10-31 实测：站点进入「安全维护」状态后，
    - 已有期号 https://fuliba2023.net/2026152.html 返回 HTTP 200，
      title 是「提示信息 - 福利吧论坛」，正文只有 1 张图（站点 logo）；
    - 首页、RSS（/feed）、论坛页全部返回同一个 13091 字节的提示页；
    - 手机 UA 返回「登录」页，`?mobile=2` 返回 Database Error。

    **它是 200**，所以 raise_for_status() 拦不住，两个害处：
      1. 探测器会把维护页当成「这一期上线了」（实测 09:16 误报过一次）；
      2. 抓取器会把维护页当成文章页 —— 解析出 0 张图，
         再把「假期次 n=0」写进台账，导致真正的这一期以后被台账跳过。

    所以显式识别它：标题含「提示信息」，或提示块里写着「维护」。
    """
    if not html:
        return False
    m = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
    title = m.group(1) if m else ""
    if "提示信息" in title:
        return True
    m2 = re.search(r'(?is)<div[^>]*id="messagetext"[^>]*>(.*?)</div>', html)
    if m2:
        body = re.sub(r"<[^>]+>", " ", m2.group(1))
        if "维护" in body:
            return True
    return False


def web_discover_fuliba_image_post():
    """福利吧最新「数字命名」合集：从 RSS 拉。"""
    r = _get_retry("https://fuliba2023.net/feed")
    r.raise_for_status()
    try:
        _rss_html = r.content.decode(r.apparent_encoding or "utf-8", errors="replace")
    except Exception:
        _rss_html = r.text
    if _fuliba_is_notice_page(_rss_html):
        log.warning("  ⚠ 福利吧整站维护中（RSS 返回的是「提示信息」页，不是 feed）")
        return None
    soup = BeautifulSoup(r.content, "lxml-xml")
    candidates = []
    for item in soup.find_all("item"):
        link_el = item.find("link")
        if link_el is None:
            continue
        link = link_el.get_text(strip=True)
        m = re.search(r"fuliba2023\.net/(\d{6,})\.html", link)
        if not m:
            continue
        title_el = item.find("title")
        title = title_el.get_text(strip=True) if title_el else ""
        candidates.append({"id": int(m.group(1)), "title": title, "url": link})
    candidates.sort(key=lambda c: c["id"], reverse=True)
    return candidates[0] if candidates else None


def web_extract_image_urls(html, filter_fn):
    soup = BeautifulSoup(html, "lxml")
    urls, seen = [], set()
    for img in soup.find_all("img"):
        src = (img.get("src") or img.get("data-src") or img.get("data-original") or "").strip()
        if src and filter_fn(src) and src not in seen:
            seen.add(src)
            urls.append(src)
    for a in soup.find_all("a"):
        href = a.get("href", "").strip()
        if filter_fn(href) and href not in seen:
            seen.add(href)
            urls.append(href)
    return urls


def web_filename_for(idx, src_url):
    """文件名：序号 + URL 的稳定哈希。

    哈希必须稳定 —— 原来用的 abs(hash(url)) 是**随机化的**：
    Python 对字符串的 hash 受 PYTHONHASHSEED 影响，每次运行结果都不一样。
    后果是同一个 URL 每次生成不同文件名，
    「文件已存在就跳过」这条永远命中不了，同一张图每次运行都要重下一遍。

    改用 md5(url) 前 5 位十六进制（100 万种），
    配合序号基本不会撞；真撞了下面还有一道查重兜底。
    """
    ext = ext_from_url(src_url)
    # 只去掉 fragment（#...），query 要留着：
    # 福利吧的 URL 形如 /x.jpg?appid=122&url=<真实图片地址>，
    # 真正的区分度全在 query 里 —— 把 query 一起去掉，
    # 不同的图会算出同一个哈希。
    clean = src_url.split("#", 1)[0]
    h = hashlib.md5(clean.encode("utf-8")).hexdigest()[:5]
    return f"{idx:03d}_{h}{ext}"


def web_download(url, path, retries=2, phash_threshold=None):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return "skip"
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, stream=True, timeout=15, allow_redirects=True)
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        f.write(chunk)
            if phash_check_and_cleanup(path, threshold=phash_threshold):
                return "phash_skip"
            return "ok"
        except Exception as e:
            last_err = e
            time.sleep(1)
    log.warning(f"  下载失败 {url}: {last_err}")
    return "fail"


def grab_web_post(name, out_subdir, url, filter_fn, target_date=None, on_file=None,
                  phash_threshold=None):
    """抓一个网页源的所有图。

    on_file: 每成功下载一张就调用一次（传本地路径）。
    用来做「下载即处理」—— 福利吧靠这个边下边判类，
    不再先堆满临时区再统一分流（见下方说明）。
    """
    log.info(f"==== WEB {name} ====")
    log.info(f"URL: {url}")
    try:
        r = _get_retry(url)
        r.raise_for_status()
    except Exception as e:
        log.error(f"  获取页面失败: {e}")
        return
    # dapenti GBK，其他 utf-8 / 页面自身 charset
    enc = "gbk" if "dapenti.com" in url else r.apparent_encoding or "utf-8"
    try:
        html = r.content.decode(enc, errors="replace")
    except Exception:
        html = r.text

    # 福利吧整站维护时，文章页也是 HTTP 200 的「提示信息」页。
    # 必须在这里挡住 —— 继续往下走会解析出 0 张图，
    # 然后把「假期次 n=0」写进台账，真正的这一期以后就被台账跳过了。
    if "fuliba2023.net" in url and _fuliba_is_notice_page(html):
        log.error("  ⚠ 福利吧站点维护中（页面是「提示信息」页），本次不抓")
        return None

    # === 分页遍历 (福利吧长文有 page=1, /2, /3 ...) ===
    extra_pages_html = []
    pagination_n = 0
    # 仅福利吧文章启用分页探测 (其它 web 源没分页机制)
    if "fuliba2023.net" in url and url.endswith(".html"):
        try:
            # 提取 <div class="article-paging"> 区块里所有 /xxxxx.html/N 链接
            paging = re.search(
                r'<div\s+class="article-paging"[^>]*>(.*?)</div>',
                html, re.DOTALL,
            )
            if paging:
                numbers = [int(n) for n in re.findall(
                    r'/(\d+)(?=")', paging.group(1)
                ) if n.isdigit()]
                if numbers:
                    pagination_n = max(numbers)
                    log.info(f"  文章分页: 共 {pagination_n} 页")
                    # 拉取 page=2..N
                    base = url
                    for p in range(2, pagination_n + 1):
                        page_url = f"{base.rstrip('/')}/{p}"
                        try:
                            rp = session.get(page_url, timeout=20)
                            rp.raise_for_status()
                            extra_pages_html.append(rp.text)
                        except Exception as e:
                            log.warning(f"  分页 page={p} 拉取失败: {e}")
        except Exception as e:
            log.warning(f"  分页解析失败 (忽略): {e}")
    log.info(f"  页面大小: {len(html)} bytes)")
    # 上面日志里多余 ')' 修一下
    # 跨页去重：同一个 URL 在多页出现时只留一次。
    #
    # 不去重的后果很实在：福利吧是分页长文（/2、/3…），
    # 同一张图常在相邻两页各出现一次。而文件名带序号，
    # 「文件已存在就跳过」这条拦不住（序号不同 → 文件名不同），
    # 于是同一张图被完整下载两遍，第二遍下完才被 pHash 扔掉。
    # 10-26 那批实测：124 张候选里 101 张是这么白下的。
    seen_urls = set()
    urls = []
    for pi, page_html in enumerate([html] + extra_pages_html, 1):
        page_urls = web_extract_image_urls(page_html, filter_fn)
        fresh = [u for u in page_urls if u not in seen_urls]
        seen_urls.update(fresh)
        urls.extend(fresh)
        if pi == 1:
            log.info(f"  解析出 {len(fresh)} 张候选图片 (page 1)")
        else:
            log.info(f"    + page {pi}: {len(fresh)} 张新候选"
                     f"（{len(page_urls) - len(fresh)} 张跨页重复，跳过不下）")
    if extra_pages_html:
        log.info(f"  全部 {pagination_n + 1} 页合计候选 {len(urls)} 张")
    if target_date is None:
        # 原来写的是 datetime.date.today() —— 但 datetime 是
        # `from datetime import datetime` 导进来的「类」，
        # datetime.date 是它的 date() 方法（未绑定），没有 .today。
        # 这行只在 target_date 传 None 时才会走到，
        # 而所有正常调用都传了日期 —— 所以这个雷一直没炸。
        # 改成直接用 date.today()，并且对齐北京时区（跟 cat_dir_for 一致）。
        target_date = datetime.now(timezone.utc).astimezone(BJ).date()
    out_dir = cat_dir_for(out_subdir, target_date)
    log.info(f"  输出目录: {out_dir}")
    ok = skip = fail = phash_skip = real_fail = 0
    ledger_skip = 0
    for idx, u in enumerate(urls):
        # ── 台账预检 ────────────────────────────────────────────
        # 这张图以前抓过 —— 连 HTTP 请求都不发，直接跳过。
        # 福利吧 RSS 滞后会让同一篇文章被反复抓（10-27 / 10-28 都抓到
        # 第 150 期），每抓一遍就是 113 张完整下载，白费 13MB 流量。
        # 实测同一篇文章抓两次 URL 100% 相同，所以这里能挡得干干净净。
        if LEDGER.seen_url(u):
            ledger_skip += 1
            continue
        path = os.path.join(out_dir, web_filename_for(idx + 1, u))
        r = web_download(u, path, phash_threshold=phash_threshold)
        if r == "ok":
            ok += 1
            LEDGER.mark_url(u)
            # 下载即处理：下完立刻归类，别让图在临时区里多待一秒
            if on_file:
                try:
                    on_file(path)
                except Exception as e:
                    log.warning(f"  下载后处理失败 {path}: {e}")
        elif r == "skip":
            skip += 1
            LEDGER.mark_url(u)          # 文件已在本地 = 以前下过
        elif r == "phash_skip":
            phash_skip += 1
            LEDGER.mark_url(u)          # 内容重复 = 白下了，别再下
        else:
            real_fail += 1
        time.sleep(0.2)
    log.info(f"  结果: 新增 {ok} 已存在 {skip} pHash {phash_skip} 失败 {real_fail} "
             f"(共 {len(urls)} 张候选) → {out_dir}")
    if ledger_skip:
        log.info(f"  台账跳过 {ledger_skip} 张（以前抓过，这次没发请求）")
    return urls


# 喷嚏图卦换过图床，同一期文章里的图片 URL 有两种形态：
#   老格式：/dapenti/<目录>/<文件>.jpg
#   新格式：/codex-image-assets-<hash>/Dapenti%20Pic%20Manager/文章图片/<文件>.jpg
#
# 2026-10-28 抓 10-27 那期（id=196393）时全站已经迁到新图床，
# 原来写死 "/dapenti/" 的过滤把 34 张图里的 33 张全滤掉了，
# 只剩一张每期都出现的固定横条 banner（663x100）——
# 那张又被清洗当成「极窄长条废图」删掉，结果「见闻」当天一张不剩。
# 新老两种图床都得收，固定 banner 单独排掉。
DAPENTI_BANNER_MARK = "/dapenti/CXxLP5UV/"


def _is_dapenti_tugua_image(u):
    if not u.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".webp")):
        return False
    if "dapenti.com" not in u:
        return False
    if "/dapenti/" not in u and "codex-image-assets" not in u:
        return False
    # 固定横条 banner，每期都一样，不是图卦内容
    if DAPENTI_BANNER_MARK in u:
        return False
    return True


def grab_dapenti_tugua(target_date):
    log.info("Step: 发现 喷嚏图卦 最新「图卦」合集...")
    tugua = web_discover_dapenti_tugua(target_date)
    if not tugua:
        log.warning("  未发现喷嚏图卦最新合集")
        return
    log.info(f"  发现: id={tugua['id']} title={tugua['title'][:50]}")
    _prev = LEDGER.articles.get(f"dapenti:{tugua['id']}")
    if _prev:
        log.info(f"    （这一期 {_prev['at']} 抓过，台账会跳过重复的）")
    urls = grab_web_post("喷嚏图卦", DAPENTI_OUT, tugua["url"],
                          _is_dapenti_tugua_image, target_date=target_date,
                          phash_threshold=DAPENTI_PHASH_THRESHOLD)
    if not urls:
        # 页面拿不到 / 候选为 0 —— 不写台账。
        # 否则会记下「这一期 n=0」，以后 article_seen 命中就永远跳过这一期。
        log.warning("  未抓到喷嚏图卦图片，不写台账")
        return
    LEDGER.mark_article(f"dapenti:{tugua['id']}", len(urls), _date_str(target_date))


def grab_fuliba(target_date):
    log.info("Step: 发现 福利吧 最新数字命名合集...")
    fuliba = web_discover_fuliba_image_post()
    if not fuliba:
        log.warning("  未发现福利吧最新合集")
        return
    log.info(f"  发现: id={fuliba['id']} title={fuliba['title'][:50]}")
    # 福利吧的 RSS 更新滞后于发文 —— 早上跑的时候经常拿到的还是上一期。
    # 那样会把同一篇文章整篇重下一遍（113 张里 111 张是昨天下过的）。
    # 这里提前说一声：抓到的还是上期，说明源站今天还没发新的。
    _prev = LEDGER.articles.get(f"fuliba:{fuliba['id']}")
    if _prev:
        log.info(f"    ⚠ 这一期 {_prev['at']} 已经抓过 —— 源站大概率还没发新一期，"
                 f"台账会把重复的 {_prev.get('n')} 张全部跳过")
    # 边下边分流：下载完一张立刻判类归位，不再先堆满临时区。
    # 福利吧是分页长文，跨页重复多；图在临时区里多待一秒，
    # 就多一次「同一张图再下一遍」的机会。
    counters = {"her": 0, "xiao": 0}

    def _route(p):
        dst, is_p = route_fuliba_file(p, target_date)
        counters["her" if is_p else "xiao"] += 1

    urls = grab_web_post("福利吧", FULIBA_OUT, fuliba["url"], lambda u: (
        "sogoucdn.com" in u and ("?appid=122" in u or "url=" in u)
    ), target_date=target_date, on_file=_route)
    if not urls:
        # 站点维护中 / 页面不可用 / 没候选 —— 都不写台账。
        # 写「n=0」会让这一期以后永远被 article_seen 命中跳过。
        log.warning("  未抓到福利吧图片，不写台账")
        return
    log.info(f"  福利吧逐张初判：见她 {counters['her']} 张 / 见笑 {counters['xiao']} 张")
    log.info("  （这只是初判，最后还会按相册段统一裁定 —— 见 reconcile_fuliba_albums）")
    LEDGER.mark_article(f"fuliba:{fuliba['id']}", len(urls), _date_str(target_date))


# ==================== 人像分流（福利吧） ====================

try:
    import cv2
    import numpy as np
    _HAS_CV2 = True
except Exception as _e:  # pragma: no cover
    cv2 = None
    np = None
    _HAS_CV2 = False
    _CV2_ERR = _e

# YuNet 模型（opencv_zoo）。232 KB，一次性下载后放本地，不再联网。
YUNET_MODEL_NAME = "face_detection_yunet_2023mar.onnx"
YUNET_MODEL_URL = ("https://github.com/opencv/opencv_zoo/raw/main/models/"
                    "face_detection_yunet/" + YUNET_MODEL_NAME)
YUNET_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
YUNET_MODEL_PATH = os.path.join(YUNET_MODEL_DIR, YUNET_MODEL_NAME)

_DETECTOR = None          # ('yunet', obj) | ('haar', obj) | None
_DETECTOR_TRIED = False


def _fetch_yunet_model():
    """模型不存在就下一次（232 KB），失败不致命 —— 会退回 Haar。"""
    if os.path.exists(YUNET_MODEL_PATH):
        return True
    try:
        import urllib.request
        os.makedirs(YUNET_MODEL_DIR, exist_ok=True)
        log.info("  首次运行：下载人脸检测模型（232 KB，只需一次）…")
        tmp = YUNET_MODEL_PATH + ".part"
        urllib.request.urlretrieve(YUNET_MODEL_URL, tmp)
        os.replace(tmp, YUNET_MODEL_PATH)
        log.info(f"  模型已保存：{YUNET_MODEL_PATH}")
        return True
    except Exception as e:
        log.warning(f"  模型下载失败（{e}）—— 退回 Haar 级联")
        return False


def _load_detector():
    """加载人脸检测器。优先级：YuNet(DNN) > Haar 级联 > 无。

    为什么主用 YuNet：
      Haar 级联只认正脸，遇到侧脸、低头、逆光、特写局部就完全检不到。
      实测同一批图：Haar 漏判 5 张写真，YuNet 只漏 2 张。
    """
    global _DETECTOR, _DETECTOR_TRIED
    if _DETECTOR_TRIED:
        return _DETECTOR
    _DETECTOR_TRIED = True

    if not _HAS_CV2:
        return None

    # OpenCV 5.x 删掉了 Haar 级联（CascadeClassifier 不存在了），
    # 那是 breaking change —— 这时安静降级，不要让整个抓图流程挂掉。
    has_haar = hasattr(cv2, "CascadeClassifier")

    if hasattr(cv2, "FaceDetectorYN") and _fetch_yunet_model():
        try:
            det = cv2.FaceDetectorYN.create(YUNET_MODEL_PATH, "", (320, 320), 0.7, 0.3, 5000)
            _DETECTOR = ("yunet", det)
            return _DETECTOR
        except Exception as e:
            log.warning(f"  YuNet 初始化失败（{e}）—— 退回 Haar 级联")

    if has_haar:
        try:
            base = cv2.data.haarcascades
            face = cv2.CascadeClassifier(base + "haarcascade_frontalface_default.xml")
            if not face.empty():
                _DETECTOR = ("haar", face)
                return _DETECTOR
        except Exception as e:
            log.warning(f"  Haar 级联加载失败: {e}")

    log.warning("  没有可用的人脸检测器 —— 福利吧的图会全部归到「见笑」")
    if _HAS_CV2 and not has_haar:
        log.warning("    OpenCV %s 没有 Haar API（5.x 起移除），装 4.x：pip install 'opencv-python-headless<5'"
                    % cv2.__version__)
    return None


def _skin_ratio(arr):
    """肤色像素占比（YCrCb 色度区间 + R>G>B 约束）。

    这是人脸检测的补充判据：特写局部、二次元、背影这类
    「脸框都检不到但明显是写真」的图，靠肤色能捞回来。
    """
    try:
        ycrcb = cv2.cvtColor(arr, cv2.COLOR_BGR2YCrCb)
        y, cr, cb = cv2.split(ycrcb)
        mask = (cr >= 133) & (cr <= 175) & (cb >= 77) & (cb <= 128) & (y > 50)
        b, g, r = cv2.split(arr)
        mask &= (r > g) & (g > b)
        return float(mask.sum()) / float(mask.size)
    except Exception:
        return 0.0


def detect_portrait(path):
    """判断一张图是不是「人像写真」。True → 见她，False → 见笑。

    判据是「两个信号取或」：
      1. 人脸框占画面的比例够大（YuNet 优先，Haar 兜底）
         —— 写真里脸是主体；梗图里也有脸，但通常小得多
      2. 肤色像素占比够高
         —— 救「特写局部 / 二次元 / 侧脸低头」这些没人脸框的写真

    没有检测器时一律返回 False（归到见笑）——
    见笑是默认 tab，误判成梗图比误判成写真安全，
    而且日志会明确告警，不会悄悄出错。
    """
    det = _load_detector()
    if det is None:
        return False
    kind, model = det
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            w, h = im.size
            # 缩小再检：DNN 在大图上反而容易漏，而且快得多
            scale = min(1.0, 900.0 / max(w, h))
            if scale < 1.0:
                im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))))
            arr = np.array(im)[:, :, ::-1]          # PIL RGB -> BGR
            area = float(arr.shape[0] * arr.shape[1])

            face_ratio = 0.0
            if kind == "yunet":
                model.setInputSize((arr.shape[1], arr.shape[0]))
                _, faces = model.detect(arr)
                if faces is not None and len(faces):
                    best = max(faces, key=lambda f: f[2] * f[3])
                    face_ratio = (best[2] * best[3]) / area
            else:
                gray = cv2.equalizeHist(cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY))
                dets = model.detectMultiScale(gray, 1.1, 5, minSize=(24, 24))
                if len(dets):
                    best = max(dets, key=lambda f: f[2] * f[3])
                    face_ratio = (best[2] * best[3]) / area

            skin = _skin_ratio(arr)
            is_portrait = (face_ratio >= PORTRAIT_FACE_RATIO) or (skin >= PORTRAIT_SKIN_RATIO)
            log.debug(f"    {os.path.basename(path)}: face={face_ratio:.4f} "
                      f"skin={skin:.4f} -> {'写真' if is_portrait else '梗图'}")
            return is_portrait
    except Exception as e:
        log.debug(f"  人像判断失败 {path}: {e}")
        return False


def _move_into_cat(src, dst_dir):
    """把文件挪到 dst_dir，撞名就加 _f 后缀。

    挪完必须同步修 PHASH_INDEX —— 它的 key 是绝对路径，
    移动后 key 不跟着改，去重就失效了（同一张图会被再下一遍）。
    """
    dst = os.path.join(dst_dir, os.path.basename(src))
    if os.path.exists(dst):
        base, ext = os.path.splitext(os.path.basename(src))
        n = 1
        while os.path.exists(os.path.join(dst_dir, f"{base}_f{n}{ext}")):
            n += 1
        dst = os.path.join(dst_dir, f"{base}_f{n}{ext}")
    if os.path.abspath(dst) != os.path.abspath(src):
        shutil.move(src, dst)
        h = PHASH_INDEX.pop(src, None)
        if h is not None:
            PHASH_INDEX[dst] = h
    return dst


def fuliba_album_index(path):
    """从福利吧文件名里取相册序号（001 起），不是福利吧的图返回 None。

    文件名是 <3位序号>_<5位hex>.<ext>，序号 = 文章内图片顺序 = 相册序号。
    """
    m = FULIBA_FILE_RE.match(os.path.basename(path))
    return int(m.group(1)) if m else None


def route_fuliba_file(path, target_date):
    """下载完立刻判类并归位：写真 → 见她，其余 → 见笑。

    为什么不能「先全下到临时区再统一分流」：
      临时区里每多待一张图，就多一次重复的机会 ——
      福利吧是分页长文，跨页重复很多。
      下完就分流的话，分流后的图立刻进 pHash 索引，
      后面几页遇到同内容会直接跳过 —— 不会再下第二遍。

    这一步只是**逐张初判**。逐张判据对背影/远景写造成片漏判，
    最终分类由 reconcile_fuliba_albums() 按相册段统一裁定。

    返回 (最终路径, 是否写真)。
    """
    is_p = detect_portrait(path)
    FULIBA_JUDGE[os.path.basename(path)] = is_p
    want_dir = DIR_JIANSHE if is_p else DIR_JIANXIAO
    dst_dir = cat_dir_for(want_dir, target_date)
    dst = _move_into_cat(path, dst_dir)
    # 撞名改名后，判据缓存要跟着改 key
    if os.path.basename(dst) != os.path.basename(path):
        FULIBA_JUDGE[os.path.basename(dst)] = FULIBA_JUDGE.pop(
            os.path.basename(path), is_p)
    return dst, is_p


def reconcile_fuliba_albums(target_date):
    """相册段级多数票：同一相册段里的图统一归类。

    为什么要段级：
      逐张判据（人脸框 + 肤色）在「海边/花园的背影和远景」上成片漏判 ——
      人脸太小检不到，肤色又被大片天空海水稀释。
      2026-10-29 实测：同一个写真相册里逐张判据只认出 51.3%，
      于是同一个相册被拆成两半，一半在「见她」一半在「见笑」。
      但把相册当整体看，写真相册和梗图相册的判据命中率之间
      隔着 20 多个百分点的空档（51.3% vs 10%~28.6%），
      按段统一裁定就能一次判对。

    代价（实测 2026-10-29：97 张里 95 张与人工校正一致）：
      写真相册里夹的那一两张梗图会被一起拖进「见她」。
      换个说法：漏一张写真比多一张梗图进「见她」安全得多，
      写真漏了可以在审稿台手动移回来，梗图混进「见她」是内容事故。

    返回 {"moved": n, "segments": k}
    """
    # ── 收集所有福利吧图（含临时区残留）────────────────────────
    items = []
    for cat in (DIR_JIANSHE, DIR_JIANXIAO):
        d = cat_dir_for(cat, target_date)
        for fn in sorted(os.listdir(d)):
            p = os.path.join(d, fn)
            if not os.path.isfile(p):
                continue
            idx = fuliba_album_index(p)
            if idx is not None:
                items.append((idx, cat, p))
    tmp_dir = os.path.join(
        OUT_BASE, datetime.now(timezone.utc).astimezone(BJ).date().isoformat(),
        FULIBA_TMP)
    if os.path.isdir(tmp_dir):
        for fn in sorted(os.listdir(tmp_dir)):
            p = os.path.join(tmp_dir, fn)
            if not os.path.isfile(p):
                continue
            idx = fuliba_album_index(p)
            if idx is not None:
                items.append((idx, FULIBA_TMP, p))
    if not items:
        return {"moved": 0, "segments": 0}
    items.sort(key=lambda r: r[0])

    # ── 分段：序号差 ≤ ALBUM_SEGMENT_GAP 算同一段 ────────────────
    segs, cur = [], []
    for it in items:
        if cur and it[0] - cur[-1][0] > ALBUM_SEGMENT_GAP:
            segs.append(cur)
            cur = []
        cur.append(it)
    if cur:
        segs.append(cur)

    moved = 0
    for seg in segs:
        n = len(seg)
        lo, hi = seg[0][0], seg[-1][0]
        if n < ALBUM_MIN_SEGMENT:
            log.info(f"  福利吧段 {lo:03d}-{hi:03d} 只有 {n} 张（< {ALBUM_MIN_SEGMENT}），"
                     f"不做段级归并，按逐张判据")
            continue
        n_p = 0
        for idx, cat, p in seg:
            j = FULIBA_JUDGE.get(os.path.basename(p))
            if j is None:
                j = detect_portrait(p)
                FULIBA_JUDGE[os.path.basename(p)] = j
            n_p += 1 if j else 0
        ratio = n_p / float(n)
        want = DIR_JIANSHE if ratio >= ALBUM_PORTRAIT_RATIO else DIR_JIANXIAO
        log.info(f"  福利吧段 {lo:03d}-{hi:03d}  {n} 张  判据说写真 {n_p} 张"
                 f"（{ratio:.1%}）→ 整段归「{want}」")
        dst_dir = cat_dir_for(want, target_date)
        for idx, cat, p in seg:
            if cat == want:
                continue
            dst = _move_into_cat(p, dst_dir)
            moved += 1
            log.info(f"    {idx:03d} {os.path.basename(p)}: {cat} → {want}")
    if moved:
        log.info(f"  福利吧段级归并：移动 {moved} 张（共 {len(segs)} 段）")
    else:
        log.info(f"  福利吧段级归并：无需移动（共 {len(segs)} 段）")
    return {"moved": moved, "segments": len(segs)}


def split_fuliba_by_portrait(target_date):
    """兜底：处理临时目录里残留的图。

    以前福利吧是「全部下到临时区 → 统一分流」，
    现在改成边下边分流，正常跑完临时区是空的；
    这里只剩处理上次运行中断留下的残留。
    """
    tmp_dir = cat_dir_for(FULIBA_TMP, target_date)
    files = sorted(
        f for f in os.listdir(tmp_dir)
        if os.path.isfile(os.path.join(tmp_dir, f))
        and os.path.splitext(f)[1].lower() in PHASH_EXTS
    )
    if not files:
        log.info("  福利吧没有可分流的图")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"见她": 0, "见笑": 0}

    if not _HAS_CV2:
        log.warning("")
        log.warning("  ! 没装 opencv，无法做人像识别 —— 福利吧的图全部归到「见笑」")
        log.warning("    装上就有分流：pip install opencv-python-headless")
        log.warning("")

    n_her = n_xiao = 0
    for fn in files:
        src = os.path.join(tmp_dir, fn)
        _, is_p = route_fuliba_file(src, target_date)
        if is_p:
            n_her += 1
        else:
            n_xiao += 1

    shutil.rmtree(tmp_dir, ignore_errors=True)
    if n_her or n_xiao:
        log.info(f"  福利吧残留分流：见她 {n_her} 张 / 见笑 {n_xiao} 张")
    return {"见她": n_her, "见笑": n_xiao}


# ==================== 入口 ====================

def main():
    target_arg = None
    if "--date" in sys.argv:
        i = sys.argv.index("--date")
        if i + 1 < len(sys.argv):
            target_arg = sys.argv[i + 1]
    target, start_utc, end_utc = compute_target_day(target_arg)
    log.info(f"========== daily_grab_all 启动 ==========")
    log.info(f"目标日期: {target.isoformat()}  (参数: {target_arg or '<昨天>'})")
    log.info(f"UTC 区间: {start_utc}  ~  {end_utc}")

    # 启动时建好 pHash 索引，跨日期/跨目录去重
    phash_scan_existing()

    # 抓取台账：以前抓过的 URL 直接跳过，连请求都不发
    _ls = LEDGER.stats()
    log.info(f"抓取台账: {_ls['urls']} 个 URL / {_ls['articles']} 篇文章已记录"
             f"（重复的不会重复下载）")

    # 1) Telegram 三频道
    for ch in TG_CHANNELS:
        try:
            grab_telegram_channel(ch["user"], ch["label"], start_utc, end_utc, target)
        except Exception as e:
            log.exception(f"TG 频道 {ch['user']} 抓取失败: {e}")
        LEDGER.save()

    # 2) 喷嚏图卦
    try:
        grab_dapenti_tugua(target)
    except Exception as e:
        log.exception(f"喷嚏图卦 抓取失败: {e}")
    LEDGER.save()

    # 3) 福利吧（边下边分流：下载完一张立刻判类归位）
    try:
        grab_fuliba(target)
    except Exception as e:
        log.exception(f"福利吧 抓取失败: {e}")
    LEDGER.save()

    # 3b) 福利吧兜底分流：处理临时目录里残留的图（正常跑完是空的）
    try:
        split_fuliba_by_portrait(target)
    except Exception as e:
        log.exception(f"福利吧分流失败: {e}")

    # 3c) 福利吧相册段级归并：逐张判据只是初判，最终按相册段统一裁定。
    #     放在最后一步，是因为此时当日所有福利吧图都已落盘（临时区也清了），
    #     段级统计拿到的才是完整的一张图。
    try:
        reconcile_fuliba_albums(target)
    except Exception as e:
        log.exception(f"福利吧段级归并失败: {e}")

    # 4) 煎蛋网女装区
    try:
        grab_jandan_beauty(target)
    except Exception as e:
        log.exception(f"煎蛋网女装区 抓取失败: {e}")
    LEDGER.save()

    _ls = LEDGER.stats()
    log.info(f"抓取台账已更新: {_ls['urls']} 个 URL / {_ls['articles']} 篇文章")

    # ── 汇总：各分类最终张数（站点构建端要按这个目录名找图）─────────
    bj_today = datetime.now(timezone.utc).astimezone(BJ).date().isoformat()
    log.info(f"========== 全部完成 ==========")
    log.info(f"输出根目录: {OUT_BASE}")
    log.info(f"日期目录  : {bj_today}")
    for cat in ALL_CAT_DIRS:
        d = os.path.join(OUT_BASE, bj_today, cat)
        n = len([f for f in os.listdir(d)]) if os.path.isdir(d) else 0
        log.info(f"  {cat:<4} {n:>4} 张   {d}")
    log.info("下一步：node tools/build.mjs --date " + bj_today)


if __name__ == "__main__":
    main()