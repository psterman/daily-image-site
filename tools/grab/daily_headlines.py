# -*- coding: utf-8 -*-
"""每日头条聚合：抓 5 个源 → markdown + JSON
   输出：
     <日期目录>/headlines/headlines_YYYY-MM-DD.md     （人看的）
     <日期目录>/headlines/headlines_YYYY-MM-DD.json   （站点构建端读的）

   JSON 是给图片站「见报」tab 用的：每条带一个 category。
   注意（2026-11-05 改）：category 现在只是**归档线索**，不再当站点的大目录（chip）——
   站点的分类唯一真相源换成了 tools/news-taxonomy.json，
   归属由构建端（build.mjs）按源名 + 关键词重算。
   这里照旧写 category，是为了让 JSON 留一份当时的分类痕迹（好追溯、好回看旧期次）。

   源（name, category）：
   - 知乎热榜   API + cookie     → 知乎
   - 微博热搜   ajax + cookie    → 微博
   - V2EX 热榜  HTML             → V2EX
   - 驱动之家   HTML             → 科技
   - 虎扑步行街 HTML             → 社区
"""
import os
import re
import sys
import json
import time
import logging
import requests
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin
from bs4 import BeautifulSoup

# 头条条目的候选配图抽取（纯函数 + 独立抓取入口，方便单测）
import headline_images

BJ = timezone(timedelta(hours=8))


def _default_out_base():
    """输出根目录：--out > MEMES_DAILY_OUT > 平台默认。

    平台默认 = 用户家目录下的 image-root/src（**所有平台一致**）——
    跟 daily_grab_all.py 同一套规则，两边必须落在同一个目录
    （头条的配图要跟当期的图对上）。

    刻意不写盘符：写死 'D:\\xxx' 的话，macOS 上会凭空造一个不存在的目录，
    而且**没有任何报错**。
    """
    env = os.environ.get("MEMES_DAILY_OUT")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), "image-root", "src")


OUT_BASE = _default_out_base()


def _apply_cli_out():
    global OUT_BASE
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        if i + 1 < len(sys.argv):
            OUT_BASE = os.path.abspath(sys.argv[i + 1])


_apply_cli_out()

# 站点构建端按「日期目录」找 headlines，所以 JSON 落在日期目录下面，
# 和图片同一层级 —— 站点那边只要知道日期就能找到。
def _headlines_dir():
    bj_today = datetime.now(BJ).date().isoformat()
    d = os.path.join(OUT_BASE, bj_today, "headlines")
    os.makedirs(d, exist_ok=True)
    return d


OUT_DIR = _headlines_dir()
LOG_FILE = os.path.join(OUT_BASE, "grab.log")

# ==================== 用户提供的 cookie ====================
ZHIHU_COOKIE = (
    "_xsrf=Ihsm10KUBb8hAgUIkDnJAnEP4wPsgGgO; "
    "_zap=1e4e286b-8359-45e9-b0dc-740a49ebceea; "
    "d_c0=uBFYiM_j8xyPTsFsohoQ4-VE9qRYacMG4ig=|1790183510; "
    "__snaker__id=MgNhKDjkNLrez9gx; "
    "gdxidpyhxdE=yqtPiLnIMt8gDH9Yt4rh7KLmq1mnd7faSnBUP5eH4sjdc3ruTXpnm2eA1GceV6PEiOWRPbSujk%2F0KR%2By4c4U5j1WthXNhdujm0h29BNCWXBtZE1vQB2%5CBOPEXrEGWc%2BMCTveB%2Fn4tNJaN29LWQvC9LZKGmKjxtdfi5TfJR3Kq6Z2uavG%3A1790727072507; "
    "q_c1=ffd9fdab85584651ae3275970112526d|1790726319000|1790726319000; "
    "z_c0=2|1:0|10:1790726341|4:z_c0|92:Mi4xMHpNcUFBQUFBQUM0RVZpSXotUHpIQ1lBQUFCZ0FsVk5yNTZwYXdDSFZWTnpfT1dEV1RZRDF4S0E1VldtbjVQZ01R|53e8e39f9d9d4ead0b4e8303970595a437e7730f97b7d651aa607b8ddcb5039e; "
    "__zse_ck=005_qGGS0OWy5eknN32b329GubnZxBVNLREQhd8SS1g88w7COoCC3yNWgSp5yJezIEYP11J=6KLnM1QZNKK6ohXk6BGSSz54iiFzvSKlSeI=WJt8WqspUhudRACsDK0xYszQ-SLXTiqBSOCes2MsYKiR1c5MajohkHyxU5CpOdX0UpzQsgXt179YkWsZa9WBuuZ43sHDd+t2meje0rZvVtsufpp6SM8CXNPFH/u9IULBUi3QmV28ayr80Ulrx1IR6DMg3; "
    "Hm_lvt_98beee57fd2ef70ccdd5ca52b9740c49=1790608316,1790726162,1791073927,1791335880; "
    "HMACCOUNT=0084FAB0E306356F; "
    "BEC=d892da65acb7e34c89a3073e8fa2254f; "
    "Hm_lpvt_98beee57fd2ef70ccdd5ca52b9740c49=1791358123; "
    "SESSIONID=JgOtT81lPu4j9QE5c1KxnccUfTtsVGNymKlgN7Nmrql; "
    "JOID=VFEVB0qXIxC2BTn6ZF_LATbX2AF-0k1bx1YOwgzAWS3YOW-wWDza1N4NP_dleAS7_nzfkWoeeoI3O0ifsQoXqkA=; "
    "osd=VVkdAkyWKxizAzjybFrNAD7f3Qd_2kVewVcGygnGWCXQPGmxUDTf0t8FN_JjeQyz-3remWIbfIM_M02ZsAIfr0Y="
)
WEIBO_COOKIE = (
    "SCF=Agqo7OyqpPKrbC9BvUmWBw8Bi27BMIZRgRio6DVQ7KcSBeF9Q0c0ta7iMtOfJlCom8YMFfEn_-4Y7cv4IvdqMfU.; "
    "SUB=_2A25HweEhDeRhGeBK7lIY8ivOwzSIHXVkv3zprDV_PUNbm9ANLWnFkW1NR7dqN5_-xS2CS4HtQLP4SptEPoHKeK-L; "
    "SUBP=0033WrSXqPxfM725Ws9jqgMF55529P9D9W5IAF-YMjixBrmSgnDsgZTA5NHD95QcSh-71KzfeonRWs4Dqcj_i--fi-2Xi-2Ni--Xi-i2i-8hi--Ri-8si-zNi--ciKn4i-z4i--4iK.RiKnf; "
    "ALF=1793924721"
)

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")

# 提前确保 OUT_BASE 存在 (FileHandler 在 import 时就 open 写日志)
os.makedirs(OUT_BASE, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("daily_headlines")
session = requests.Session()
session.headers.update({"User-Agent": UA})


# ==================== 各源抓取器 ====================

def fetch_zhihu():
    """知乎热榜：API + cookie"""
    headers = {
        "Referer": "https://www.zhihu.com/",
        "Cookie": ZHIHU_COOKIE,
        "Accept": "application/json",
    }
    url = "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50"
    r = session.get(url, headers=headers, timeout=20)
    r.raise_for_status()
    data = r.json().get("data", [])
    items = []
    for d in data:
        t = d.get("target", {}) or {}
        title = (t.get("title") or "").strip()
        if not title:
            continue
        # url: api.zhihu.com/questions/<id> → www.zhihu.com/question/<id>
        qurl = t.get("url", "")
        m = re.search(r"questions/(\d+)", qurl)
        link = f"https://www.zhihu.com/question/{m.group(1)}" if m else qurl
        item = {"title": title, "link": link}
        # 知乎热榜的 target 里有时带缩略图（thumbnail / image_areas）。
        # 有就带上，���有也不影响 —— 头条的图是**可选**的。
        thumb = (t.get("thumbnail") or "").strip()
        if thumb.startswith("http"):
            # 形状跟 RSS 那条路一致：{url, kind}
            item["imgs"] = [{"url": thumb, "kind": "inline"}]
        items.append(item)
    return items


def fetch_weibo():
    """微博热搜：ajax + cookie"""
    headers = {
        "Referer": "https://weibo.com/",
        "Cookie": WEIBO_COOKIE,
        "Accept": "application/json",
    }
    url = "https://weibo.com/ajax/side/hotSearch"
    r = session.get(url, headers=headers, timeout=20)
    r.raise_for_status()
    data = r.json().get("data", {})
    realtime = data.get("realtime", [])
    items = []
    for x in realtime:
        word = x.get("word", "").strip()
        if not word:
            continue
        # 链接用搜索 URL
        items.append({
            "title": f"{word}（{x.get('num', 0):,}）",
            "link": f"https://s.weibo.com/weibo?q=%23{requests.utils.quote(word)}%23",
        })
    return items


def _html_titles(url, title_sel, link_sel=None, base_url=None, max_items=30):
    """通用 HTML 标题抓取：title_sel='a' + 文本匹配 / link_sel='a[href*=...]'

    链接一律用 urljoin 规范化：
      "//host/path"（协议相对）-> "https://host/path"
      "/path"（根相对）      -> "https://host/path"
    以前只认 startswith("http")，协议相对地址会被直接丢掉 ——
    结果页面上那几条点不动（href="#"），跳到页面顶部，像是坏了。
    """
    r = session.get(url, timeout=20)
    r.raise_for_status()
    enc = r.apparent_encoding or "utf-8"
    html = r.content.decode(enc, errors="replace")
    soup = BeautifulSoup(html, "lxml")
    items = []
    seen = set()
    for a in soup.select(title_sel):
        title = (a.get_text() or "").strip()
        title = re.sub(r"\s+", " ", title)
        if len(title) < 6 or len(title) > 200:
            continue
        if title in seen:
            continue
        link = a.get("href", "") or ""
        if link:
            link = urljoin(base_url or url, link)
        items.append({"title": title, "link": link})
        seen.add(title)
        if len(items) >= max_items:
            break
    return items


def fetch_v2ex():
    """V2EX 热榜：每条都是 a[href^=/t/] 自带链接"""
    r = session.get("https://www.v2ex.com/?tab=hot", timeout=20)
    r.raise_for_status()
    enc = r.apparent_encoding or "utf-8"
    soup = BeautifulSoup(r.content.decode(enc, errors="replace"), "lxml")
    items, seen = [], set()
    for a in soup.select('a[href^="/t/"]'):
        href = a.get("href", "")
        text = (a.get_text() or "").strip()
        text = re.sub(r"\s+", " ", text)
        if len(text) < 4 or len(text) > 200:
            continue
        if not re.search(r"[\u4e00-\u9fff]|[\x20-\x7E]", text):
            continue
        if text in seen:
            continue
        seen.add(text)
        link = urljoin("https://www.v2ex.com/", href)
        items.append({"title": text, "link": link})
    return items[:30]


def fetch_mydrivers():
    items = _html_titles(
        "https://news.mydrivers.com/",
        title_sel='a',
        max_items=120,
    )
    out, seen = [], set()
    for it in items:
        t = it["title"]
        if not re.search(r"[\u4e00-\u9fff]", t):
            continue
        if len(t) < 10 or len(t) > 80:
            continue
        if any(k in t for k in ["首页", "论坛", "APP", "微博", "微信", "客户端", "登录", "注册", "订阅", "RSS", "关于", "联系", "招聘", "投稿", "导航"]):
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append(it)
    return out[:30]


def fetch_hupu():
    """虎扑 步行街 /bxj"""
    r = session.get("https://bbs.hupu.com/bxj", timeout=20)
    r.raise_for_status()
    enc = r.apparent_encoding or "utf-8"
    soup = BeautifulSoup(r.content.decode(enc, errors="replace"), "lxml")
    items, seen = [], set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        # 虎扑帖子：/NNNNNNN.html
        if not re.search(r"/\d{6,}\.html", href):
            continue
        text = a.get_text(strip=True)
        if len(text) < 6 or len(text) > 100:
            continue
        if any(k in text for k in ["首页", "登录", "注册", "微博", "微信", "APP", "客户端", "导航", "联系", "关于", "加入"]):
            continue
        if text in seen:
            continue
        seen.add(text)
        link = urljoin("https://bbs.hupu.com/", href)
        items.append({"title": text, "link": link})
    return items[:30]


# ==================== 主流程 ====================
#
# 每个源带一个 category —— 它是**归档线索**，站点不再拿它当大目录（chip）。
# （2026-11-05 改：站点的分类唯一真相源换成了 tools/news-taxonomy.json，
#   归属由 build.mjs 按源名 + 关键词重算。这里照旧写 category，
#   是为了给 JSON 留一份当时的分类痕迹。）
#
# 脉络：最早把所有源拍平成一个「头条」标签，再套一个「热榜」伞标签，
# 两个标签内容高度重复（热榜 = 全部），用户根本分不清；
# 之后按 category 分目录（知乎 / 微博 / V2EX / 科技 / 社区 ……）；
# 现在站点改用「用户思维」分类（热议 / 科技数码 / AI / 效率工具 / 技术社区 / 深度阅读），
# 那张表在站点侧，Python 侧不用跟着改。
# 第 4 个字段 want_images：要不要给这个源的条目**逐条抓页面抽候选图**。
#
# 为什么分这么细（2026-11-11 实测）：
#   · 微博热搜走 API，realtime 条目里**压根没有任何图片字段**（emoticon 全空、
#     topic_flag 是数字标记）→ 抓页面也没用，不做。
#   · V2EX 热榜的热榜页是纯文字（图片都在 JS 模板里），帖子页里大多是头像
#     和外链图 → 产出极低，不做。
#   · 虎扑步行街 / 驱动之家的条目页里**有真实内容图**（虎扑帖子配图、
#     驱动之家文章插图）→ 值得抓。
#   抓完只是**候选**，能不能上站由 JS 那边的 rss-images.mjs 按实际尺寸筛。
SOURCES = [
    ("知乎热榜",     fetch_zhihu,     "知乎", False),
    ("微博热搜",     fetch_weibo,     "微博", False),
    ("V2EX 热榜",    fetch_v2ex,      "V2EX", False),
    ("驱动之家",     fetch_mydrivers, "科技", True),
    ("虎扑步行街",   fetch_hupu,      "社区", True),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    today_bj = datetime.now(BJ).date()
    date_str = today_bj.isoformat()
    out_path = os.path.join(OUT_DIR, f"headlines_{date_str}.md")
    json_path = os.path.join(OUT_DIR, f"headlines_{date_str}.json")
    log.info(f"========== daily_headlines 启动 ==========")
    log.info(f"输出: {out_path}")
    log.info(f"      {json_path}")

    sections = []
    summary = []  # (源, 数量, 状态)
    for src_name, fn, category, want_images in SOURCES:
        log.info(f"━━ 抓 {src_name}（分类：{category}）")
        try:
            items = fn()
            ok = True
        except Exception as e:
            log.warning(f"  失败: {e}")
            items = []
            ok = False
        count = len(items)
        # 候选配图：逐条抓它的页面，把 <img> 抠出来当候选。
        # 抓不到不影响条目本身（头条的图是可选的）。
        if want_images and items:
            try:
                headline_images.attach_images(items, session, log=log)
            except Exception as e:
                log.warning(f"  配图抽取失败（不影响条目）: {e}")
        summary.append((src_name, count, ok))
        log.info(f"  → {count} 条 {'OK' if ok else '失败'}")
        sections.append((src_name, category, items))
        time.sleep(0.5)

    # 写 markdown
    lines = []
    lines.append(f"# 每日头条 · {date_str}")
    lines.append("")
    lines.append(f"抓取于: {datetime.now(BJ).strftime('%Y-%m-%d %H:%M:%S %Z')}")
    lines.append("")
    lines.append("## 总览")
    lines.append("")
    lines.append("| 源 | 条数 | 状态 |")
    lines.append("|---|---:|:---:|")
    for src_name, count, ok in summary:
        status = "✓" if ok and count > 0 else ("✗" if not ok else "0条")
        lines.append(f"| {src_name} | {count} | {status} |")
    lines.append("")

    for src_name, category, items in sections:
        lines.append(f"## {src_name}")
        lines.append("")
        if not items:
            lines.append("_(无数据)_")
            lines.append("")
            continue
        for idx, it in enumerate(items, 1):
            title = it["title"].replace("|", "\\|").replace("\n", " ")
            if it["link"]:
                lines.append(f"{idx}. [{title}]({it['link']})")
            else:
                lines.append(f"{idx}. {title}")
        lines.append("")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    log.info(f"  markdown → {out_path}")

    # ── 写 JSON：站点「见报」tab 的大目录读这个 ────────────────────
    #
    # 为什么单独存 JSON：markdown 是给人看的，站点要的是结构化数据。
    # 让站点构建期直接读这个文件，就不用在构建时再抓一遍这 6 个源
    # （构建期抓 RSS 是为了拿更细的标签；这批源带 cookie，
    #   抓一次不容易被风控）。
    now = datetime.now(BJ)
    flat = []
    with_imgs = 0
    for src_name, category, items in sections:
        for it in items:
            imgs = it.get("imgs") or []
            if imgs:
                with_imgs += 1
            flat.append({
                "title": it.get("title", ""),
                "link": it.get("link", ""),
                "source": src_name,
                # category = 归档线索（站点侧不再拿它当分类，
                # 分类唯一真相源是站点的 tools/news-taxonomy.json）
                "category": category,
                # 候选配图（可选）：站点那边会真下载、真按尺寸筛，筛不过就不出图。
                # 没有这个字段 = 这条没图候选。
                "imgs": imgs,
            })

    payload = {
        "date": date_str,
        "generatedAt": now.isoformat(),
        "ts": int(now.timestamp()),
        "sources": [
            {"name": n, "category": c, "count": len(items), "items": items}
            for n, c, items in sections
        ],
        "items": flat,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    ok_sources = sum(1 for n, c, ok in summary if ok and c > 0)
    log.info(f"  json     → {json_path}")
    log.info(f"  条目     : {len(flat)} 条 / {ok_sources} 个源正常 / {with_imgs} 条带候选图")
    cats = {}
    for _, cat, items in sections:
        cats[cat] = cats.get(cat, 0) + len(items)
    log.info(f"  分类     : " + "、".join(f"{k} {v}" for k, v in cats.items()))
    log.info(f"========== 完成 ==========")


if __name__ == "__main__":
    main()