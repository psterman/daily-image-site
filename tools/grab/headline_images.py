# -*- coding: utf-8 -*-
"""头条条目的**候选**配图抽取。

为什么需要它（2026-11-11 实测）：
    见报的「头条」那 5 个源里，微博热搜走 API、只给词条（**天生无图**，
    微博热搜 API 的 realtime 条目里压根没有任何图片字段：emoticon 全空、
    topic_flag 是数字标记），知乎热榜同理。但**虎扑步行街 / 驱动之家**
    的条目页里是有真实内容图的（虎扑帖子的配图、驱动之家文章里的插图）
    —— 只是抓取器从来没抽过它们。

    结果「热议」这一档 86 条里 52 条微博热搜 + 30 条虎扑 + 4 条抽屉，
    **一条图都没有**；用户打开见报第一眼看到的默认分类全是纯文字。

    这里干的事很简单：把条目页抓下来，把里面的 <img> 抠出来当**候选**。

    ���选 ≠ 能用。真正的「哪张能上站」（宽高、体积、是不是广告图/图标）
    交给 JS 那边的 tools/rss-images.mjs —— 它会真下载、真转码、真按尺寸筛。
    也就是说：**这里只管「找」，不管「选」**。分工跟 RSS 那条路完全一致。

    为什么单独一个模块（而不是写在 daily_headlines.py 里）：
    daily_headlines.py 一 import 就会建日志文件、读 cookie、写盘 —— 有副作用，
    不好测。这个模块是**纯函数 + 一个独立的抓取入口**，可以直接被单元测试调。
"""
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin

from bs4 import BeautifulSoup

# ── URL 层面的粗筛 ───────────────────────────────────────────────
# 这些词出现在图片 URL 里，基本可以断定不是内容图：
#   logo / icon / avatar   —— 站点 logo、导航图标、用户头像
#   def_                   —— 默认占位图（虎扑用 def_man.png 之类）
#   qrcode / qr_           —— 二维码
#   spacer / blank         —— 空白占位
#   /static/               —— 站点公共资源目录
#   sprite / ad            —— 雪碧图、广告位
# 注意：这些只是**便宜的预筛**，真正的判断靠下载后的实际尺寸（见 rss-images.mjs）。
_SKIP_URL = re.compile(
    r"(logo|icon|avatar|def_|qrcode|qr_|spacer|blank|placeholder|sprite|/static/|"
    r"/ads?/|ad_|banner_ad|sprite_|marketing|promotion|\.ico(\?|$))",
    re.I,
)

# 候选图 URL 的后缀（只认常见的图片格式，.js/.html 之类直接丢）
_IMG_EXT = re.compile(r"\.(jpe?g|png|gif|webp|bmp)(\?|#|$)", re.I)


def extract_candidates(html, base_url, limit=6, skip_first=0):
    """从一个 HTML 页面里抠出候选配图地址。

    :param html:      页面 HTML
    :param base_url:  页面地址（用来把协议相对地址补全）
    :param limit:     最多返回几个
    :param skip_first:跳过最前面的几张图 —— 站点 logo / 导航图总在最前面，
                       它们躲过了 URL 粗筛（名字里未必有 logo），但尺寸筛选
                       未必拦得住（有的 logo 挺大的）。
                       **默认 0**：实测虎扑/驱动之家的页面里，内容图就排在
                       广告图前面（虎扑是 `editor/…png`，驱动之家是 `s_<hash>.jpg`），
                       而 JS 那边的取图规则是「按顺序，第一个通过尺寸筛选的胜出」
                       —— 所以顺序天然正确，**不要**在这里跳过前面的图。
    :returns:         [{'url': str, 'kind': 'inline'}, ...]
                       **形状必须跟 RSS 那条路一致**（tools/fetch-rss.mjs 的
                       extractImages 产出的就是 {url, kind}）——
                       因为下游 tools/rss-images.mjs 直接读 cand.url / cand.kind，
                       形状不一致会静默拿到 undefined，图一张都下不下来。
    """
    if not html:
        return []
    soup = BeautifulSoup(html, "lxml")
    out, seen = [], set()
    skipped = 0
    for img in soup.find_all("img"):
        src = (img.get("src") or img.get("data-src") or img.get("data-original")
               or img.get("data-lazy-src") or "")
        src = (src or "").strip()
        if not src or src.startswith("data:"):
            continue
        u = urljoin(base_url, src)
        if not u.startswith("http"):
            continue
        if _SKIP_URL.search(u):
            continue
        if not _IMG_EXT.search(u):
            continue
        if u in seen:
            continue
        seen.add(u)
        skipped += 1
        if skipped <= skip_first:
            continue
        out.append({"url": u, "kind": "inline"})
        if len(out) >= limit:
            break
    return out


def attach_images(items, session, log=None, limit=6, skip_first=0, workers=6,
                  timeout=15, max_pages=40):
    """给一批条目逐条抓页面、抠候选图，挂到 item['imgs']。

    :param items:     条目列表（每个至少有 link）
    :param session:   requests.Session（自带 UA）
    :param limit:     每条最多几个候选
    :param skip_first:每页先跳过几张（见 extract_candidates）
    :param workers:   并发数
    :param max_pages: 最多抓多少个页面（防止条目太多把站点打疼）
    :returns:         (成功抓到图的条数, 总候选数)
    """
    targets = [it for it in items if it.get("link")][:max_pages]
    if not targets:
        return 0, 0

    def one(it):
        link = it["link"]
        try:
            r = session.get(link, timeout=timeout)
            if r.status_code != 200:
                return 0
            enc = r.apparent_encoding or "utf-8"
            html = r.content.decode(enc, errors="replace")
            cands = extract_candidates(html, link, limit=limit, skip_first=skip_first)
            if cands:
                it["imgs"] = cands
                return len(cands)
        except Exception:
            return 0
        return 0

    got = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for n in pool.map(one, targets):
            got += n
    hit = sum(1 for it in targets if it.get("imgs"))
    if log:
        log.info(f"    配图：{hit}/{len(targets)} 条页面抓到候选，共 {got} 个")
    return hit, got
