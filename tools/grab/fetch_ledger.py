# -*- coding: utf-8 -*-
"""抓取台账：记住「哪些图片 URL 已经抓过」，重复的连请求都不发。

为什么需要它
------------
2026-10-28 实测的一次抓取里，一共下载了 289 张，最后入库 147 张 ——
**142 张是白下的**（下载完才算出来是重复，又被 pHash 扔掉）。

白下载的两个来源：

1. **同一篇文章被反复抓**（最大头）
   福利吧的 RSS 更新滞后于发文。10-27 抓到的是第 150 期（2026150），
   10-28 早上再抓，RSS 还没更新，还是第 150 期 —— 同一篇文章，
   113 张图完整下载第二遍，其中 111 张内容跟昨天一模一样。
   同一天如果重跑一遍，还会再来一次（10-27 的日志里福利吧就跑了两遍）。

2. **跨频道转发同一张图**
   Telegram 的不同频道转发同一张图时 URL 不同，pHash 能认出来，但得下完才知道。

台账解决第 1 类（也是大头）：**实测同一篇文章抓两次，URL 100% 相同**，
所以在下载前查一下表就能全部拦掉，一个字节都不下。

第 2 类仍然只能靠 pHash 兜底 —— URL 不同，只有内容才知道。

台账里的 key 是「归一化 URL」
--------------------------
搜狗代理的图 URL 长这样：

    https://img03.sogoucdn.com/v2/thumb/retype_exclude_gif/ext/auto/q/100/
        ?appid=122&url=https://tva1.sinaimg.cn/large/009Zip4ygy1...jpg

外层是转码代理（会重新编码），内层 `url=` 才是真正的图片地址。
两层都留着的话，外层节点一变（img01/img03/tvax1/tvax2…）key 就跟着变，
去重就失效了。所以只取内层。

台账文件
--------
`<工程目录>/.fetch-ledger.json`。台账丢了不要紧 —— 最坏情况是退回
「下完再判断重复」的老行为，不会出错，只是多下点流量。
"""
import json
import os
import re
from urllib.parse import urlparse, parse_qs, unquote

LEDGER_FILENAME = ".fetch-ledger.json"

# 代理层的真图地址参数名（按优先级）
_INNER_KEYS = ("url", "u", "img", "src", "imgurl", "pic")


def normalize_url(u):
    """把图片 URL 归一化成「内容稳定」的 key。

    优先剥掉代理层（?url=<真地址>），拿到底层图片地址；
    没有代理层就退回 host+path（丢掉 query 和 fragment）。
    """
    if not u:
        return ""
    u = u.strip()
    try:
        q = parse_qs(urlparse(u).query)
        for k in _INNER_KEYS:
            if k in q and q[k] and q[k][0]:
                v = unquote(q[k][0])
                v = re.sub(r"^https?://", "", v)
                v = v.split("#", 1)[0]
                return v.rstrip("/").lower()
    except Exception:
        pass
    try:
        v = urlparse(u)
        return (v.netloc + v.path).rstrip("/").lower()
    except Exception:
        return u.split("#", 1)[0].lower()


class Ledger:
    """已抓 URL + 已抓文章的台账。

    urls:    {归一化 URL: 首次抓到的日期 "YYYY-MM-DD"}
    articles: {文章 key: {"at": 日期, "n": 候选数}}
             —— 用来判断「这篇文章是不是整篇都没新东西」。

    urls 记日期是为了能按时间清理：每天 +150 条，一年下来几万条，
    JSON 会涨到几 MB。默认只留最近 120 天，更早的重复由 pHash 兜底
    （真重复的话，多下一次也只是白下一次，不会出错）。
    """

    KEEP_DAYS = 120

    def __init__(self, path):
        self.path = path
        self.urls = {}          # url -> "YYYY-MM-DD"
        self.articles = {}
        self.dirty = False
        self._load()

    # ---------------------------------------------------------------- 读写
    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            raw = d.get("urls") or []
            if isinstance(raw, dict):
                self.urls = dict(raw)
            else:
                # 老格式是 list（没有日期）—— 按最早日期补上，清理时不会被立刻丢掉
                self.urls = {u: "1970-01-01" for u in raw}
            self.articles = d.get("articles") or {}
        except Exception:
            self.urls = {}
            self.articles = {}

    def save(self):
        if not self.dirty:
            return
        try:
            self._prune()
            os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "version": 2,
                        "urls": self.urls,
                        "articles": self.articles,
                    },
                    f,
                    ensure_ascii=False,
                )
            os.replace(tmp, self.path)
            self.dirty = False
        except Exception as e:
            print(f"  [warn] 台账保存失败（忽略）: {e}")

    def _prune(self):
        """丢掉太老的记录，避免台账无限膨胀。"""
        try:
            from datetime import date, timedelta
            cutoff = (date.today() - timedelta(days=self.KEEP_DAYS)).isoformat()
            old = [u for u, dt in self.urls.items() if dt < cutoff and dt != "1970-01-01"]
            if old:
                for u in old:
                    self.urls.pop(u, None)
        except Exception:
            pass

    # ---------------------------------------------------------------- 查询
    def seen_url(self, u):
        return normalize_url(u) in self.urls

    def article_seen(self, key, url_count=None):
        """文章是否整篇见过。

        url_count 给定时，只有「上次抓的候选数一样」才算整篇见过 ——
        源站给文章补了新图的话，候选数会变，那就得重抓。
        """
        a = self.articles.get(key)
        if not a:
            return False
        if url_count is None:
            return True
        return a.get("n") == url_count

    # ---------------------------------------------------------------- 记录
    def mark_url(self, u, date_str=None):
        n = normalize_url(u)
        if not n:
            return
        if n not in self.urls:
            if date_str is None:
                from datetime import date
                date_str = date.today().isoformat()
            self.urls[n] = date_str
            self.dirty = True

    def mark_urls(self, urls, date_str=None):
        for u in urls:
            self.mark_url(u, date_str)

    def mark_article(self, key, url_count, date_str):
        self.articles[key] = {"at": date_str, "n": url_count}
        self.dirty = True

    # ---------------------------------------------------------------- 统计
    def stats(self):
        return {"urls": len(self.urls), "articles": len(self.articles)}
