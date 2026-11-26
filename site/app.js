/* 每日图片站 —— 交互层
   微信 X5 内核注意：
   - loading="lazy" 在 X5 上完全无效，懒加载必须用 IntersectionObserver 自己实现
   - srcset/sizes 会被微信忽略，图片一律走 <img src>
   - 见报 tab 的配图走的是**同一套** IntersectionObserver + 并发队列（key = news），
     没有另起一套：浏览器同域只开 6 条连接，见报要是自己占着连接不放，
     照片 tab 的缩略图就加载不出来（老坑：切 tab 后等 38~62 秒才出现）
*/
(function () {
  'use strict';

  /* manifest 现在放在独立的 .js 里（避免微信爬虫从 HTML 中读到全部图片 URL），
     所以从全局变量取；保留读取内联 <script id="manifest"> 的分支是为了兼容旧产物。 */
  var DATA = window.__DAILY_MANIFEST__ || null;

  /* ─────────────── 点赞 / 评论 ─────────────── */

  var VISITOR_KEY = 'like-vid-v1';
  var MINE_KEY = 'like-mine-v1';
  var VISITOR_RE = /^[0-9a-f]{16}$/;

  var social = { counts: {}, comments: {} };

  function randomHex16() {
    var bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  /** 访客 id：第一次访问时生成，存 localStorage。拿不到存储也不影响点赞 */
  function visitorId() {
    var v = null;
    try { v = localStorage.getItem(VISITOR_KEY); } catch (e) { v = null; }
    if (!v || !VISITOR_RE.test(v)) {
      v = randomHex16();
      try { localStorage.setItem(VISITOR_KEY, v); } catch (e) { /* 隐私模式：用内存里的就行 */ }
    }
    return v;
  }

  /** 「我赞过哪些图」记在本地 —— 服务端的 GET 是访客无关的（能缓存） */
  function mineMap() {
    try { return JSON.parse(localStorage.getItem(MINE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function setMine(date, id, on) {
    try {
      var m = mineMap();
      var list = m[date] || [];
      if (on) { if (list.indexOf(id) < 0) list.push(id); }
      else { list = list.filter(function (x) { return x !== id; }); }
      m[date] = list;
      localStorage.setItem(MINE_KEY, JSON.stringify(m));
    } catch (e) { /* 存不了就算了，计数照样对 */ }
  }
  function isMined(date, id) {
    return (mineMap()[date] || []).indexOf(id) >= 0;
  }

  /**
   * 赞数：服务端计数 + 一个下限。
   *
   * GET /likes/api 的响应头是 public, max-age=30（计数要能被边缘缓存），
   * 于是浏览器缓存里可能存着一份 30 秒前的旧副本。
   * 用户刚赞完就刷新页面时拿到的是旧计数（0），
   * 而「我赞过」记在 localStorage 里 —— 两者对不上，
   * 就会出现「👍 0」这种自相矛盾的状态（端到端实测：刷新后角标消失、查看器显示 👍 0）。
   *
   * 我赞过 = 至少 1 个赞（我自己的那个赞就在里面），所以旧计数低于 1 时用 1 兜底。
   * 这不是显示假数字，是把**已经确定的真值**补回来 —— 真值就是 ≥1。
   */
  function likeCount(date, id) {
    var n = social.counts[id] || 0;
    if (n < 1 && isMined(date, id)) return 1;
    return n;
  }

  /** 拉当期计数 —— 一次请求拿全部图的赞数和评论数 */
  function loadSocial(date) {
    if (!date) return;
    return fetch('/likes/api?date=' + encodeURIComponent(date))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) return;
        social.counts = j.counts || {};
        social.comments = j.comments || {};
        applyBadges();
        syncViewerActions();
      })
      .catch(function () { /* 点赞功能挂了也不该影响看图 */ });
  }

  /** 把赞数画到格子上。只在 > 0 时显示，0 赞不画 —— 免得 243 个角标糊满屏 */
  function applyBadges() {
    for (var key in state) {
      var s = state[key];
      if (!s || !s.cells) continue;
      for (var i = 0; i < s.cells.length; i++) {
        var c = s.cells[i];
        if (!c || !c.item) continue;
        var n = likeCount(DATA.date, c.item.id);
        if (!c.badge) {
          c.badge = document.createElement('span');
          c.badge.className = 'like-badge';
          c.badge.hidden = true;
          c.el.appendChild(c.badge);
        }
        if (n > 0) {
          c.badge.textContent = '👍 ' + n;
          c.badge.hidden = false;
        } else {
          c.badge.textContent = '';
          c.badge.hidden = true;
        }
      }
    }
  }

  /* ─────────────── 单图页链接（分享用） ─────────────── */

  /**
   * 单图页的**相对**路径：/pic/<日期>/<栏key>/<序号3位>/
   *
   * 为什么写相对路径、不写死域名：这套产物有两个副本（正式站 / 脱敏副本），
   * 写死域名的话脱敏副本给出的链接会指向正式站 —— 分享出去的卡片直接串台。
   * 相对路径在哪个域名下都指向「当前这个站」。
   * 只有「复制链接」的时候才拼成绝对地址（贴到微信里必须是绝对的，相对路径别人点不开）。
   *
   * 为什么是 /pic/：另一个功能（公开成果页）占了 /p/ 前缀，
   * 两条功能都用 /p/ 的话部署时会互相覆盖（Pages 同一路径只能有一个 Function）。 */
  function pagePath(tabKey, index) {
    return '/pic/' + encodeURIComponent(DATA.date) + '/' +
      encodeURIComponent(tabKey) + '/' +
      String(index + 1).padStart(3, '0') + '/';
  }

  /** 当前站点的绝对地址前缀（很老的内核没有 location.origin，兜一层）。 */
  function siteOrigin() {
    return location.origin || (location.protocol + '//' + location.host);
  }

  /** 单图页的绝对地址（复制链接 / 贴微信用）。 */
  function pageUrl(tabKey, index) {
    return siteOrigin() + pagePath(tabKey, index);
  }

  /**
   * 站内相对路径 → 绝对地址。
   *
   * manifest 里的 thumb/full 是 /img/... 这种相对路径（两个域名副本通用），
   * 但「原图」链接要发到微信 / 新标签页打开 → 必须是绝对地址。
   * 已经是 http(s) 的原样返回（协议校验走 safeHref —— 全站只那一处）。 */
  function absoluteUrl(p) {
    if (!p || typeof p !== 'string') return '';
    var abs = safeHref(p);
    if (abs) return abs;
    if (p.charAt(0) !== '/') return '';
    return siteOrigin() + p;
  }

  /** 查看器底部的赞数 / 评论数 / 评论链接 + 分享三件套（复制链接 / 原图 / 看原帖） */
  function syncViewerActions() {
    var likeBtn = document.getElementById('viewerLike');
    var cmtLink = document.getElementById('viewerComment');
    if (!likeBtn || !cmtLink) return;
    var s = state[vTab];
    var entry = s && s.cells ? s.cells[vIndex] : null;
    if (!entry || !entry.item) return;

    var id = entry.item.id;
    var n = likeCount(DATA.date, id);
    document.getElementById('viewerLikeCount').textContent = String(n);
    document.getElementById('viewerCommentCount').textContent = String(social.comments[id] || 0);

    var on = isMined(DATA.date, id);
    likeBtn.classList.toggle('is-on', on);
    document.getElementById('viewerLikeIco').textContent = on ? '👍' : '🤍';

    // 评论入口：把「哪一天、哪张图、缩略图」带给留言板页
    cmtLink.setAttribute(
      'href',
      '/board/?img=' + encodeURIComponent(DATA.date) +
        '&id=' + encodeURIComponent(id) +
        '&thumb=' + encodeURIComponent(entry.item.thumb),
    );

    /* 分享两件套 —— 全部跟着**当前查看的那张图**走（vTab / vIndex）。
       ⚠️ 这里**没有**「看原帖」：上游原帖是 t.me 外链，微信内置浏览器会拦
       （点开是微信自己的「已停止访问该网页」页）—— 入口已下线，
       现在的主流程是「复制这张图的链接 → 对方点进站看原图」。 */
    var origLink = document.getElementById('viewerOriginal');
    if (origLink) origLink.setAttribute('href', absoluteUrl(entry.item.full));
  }

  /** 点赞：幂等切换，on = 目标状态 */
  function toggleLike() {
    var s = state[vTab];
    var entry = s && s.cells ? s.cells[vIndex] : null;
    if (!entry || !entry.item) return;
    var id = entry.item.id;
    var on = !isMined(DATA.date, id);
    var btn = document.getElementById('viewerLike');
    if (btn) btn.disabled = true;

    fetch('/likes/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-daily-visitor': visitorId() },
      body: JSON.stringify({ date: DATA.date, id: id, on: on }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) return;
        social.counts[id] = j.count;
        setMine(DATA.date, id, on);
        applyBadges();
        syncViewerActions();
      })
      .catch(function () { /* 静默失败：角标还是上一个值 */ })
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* ─────────────── 复制单图页链接 ─────────────── */

  /**
   * 「复制链接」：把当前这张图的单图页地址复制到剪贴板。
   *
   * 两条路都得有：
   *   ① navigator.clipboard.writeText —— 现代浏览器
   *   ② 隐藏 textarea + document.execCommand('copy') ——
   *      **老安卓微信（X5 内核）没有 clipboard API**，只有这一条路能用
   * 两条都不成也要给个说法（提示手动复制地址栏），不能静默。
   *
   * 复制的是**绝对**地址：贴到微信里必须是绝对的，相对路径别人点不开。 */
  function copyPageLink() {
    var s = state[vTab];
    var entry = s && s.cells ? s.cells[vIndex] : null;
    if (!entry || !entry.item) return;
    var url = pageUrl(vTab, vIndex);
    var clip = navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      try {
        clip.writeText(url).then(function () {
          showHint(2200, '链接已复制');
        }).catch(function () {
          fallbackCopy(url);
        });
        return;
      } catch (e) {
        /* 不给 clipboard 的环境（非安全上下文 / 权限被拒）→ 走降级 */
      }
    }
    fallbackCopy(url);
  }

  /** 降级复制：隐藏 textarea + execCommand('copy')（老安卓微信 X5 只有这一条路）。 */
  function fallbackCopy(text) {
    var ok = false;
    var ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');   /* readonly：手机上不弹键盘 */
      /* 不能 display:none —— 那样选不中；缩到 1px 透明就行 */
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.padding = '0';
      ta.style.border = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
    showHint(2600, ok ? '链接已复制' : '复制失败，请手动复制地址栏');
  }

  if (!DATA) {
    var legacyEl = document.getElementById('manifest');
    if (legacyEl) {
      try { DATA = JSON.parse(legacyEl.textContent); } catch (e) { DATA = null; }
    }
  }
  if (!DATA) {
    document.getElementById('loading').innerHTML = '<p>数据加载失败</p>';
    return;
  }

  var tabsEl = document.getElementById('tabs');
  var tabInk = document.getElementById('tabInk');
  var gridsEl = document.getElementById('grids');
  var loadingEl = document.getElementById('loading');
  var countPill = document.getElementById('countPill');

  var viewer = document.getElementById('viewer');
  var viewerImg = document.getElementById('viewerImg');
  var viewerCount = document.getElementById('viewerCount');
  var viewerClose = document.getElementById('viewerClose');
  var viewerStage = document.getElementById('viewerStage');
  var viewerHint = document.getElementById('viewerHint');
  var gateNotice = document.getElementById('gateNotice');

  var tabs = DATA.tabs || [];
  if (!tabs.length) {
    loadingEl.innerHTML = '<p>今天还没有内容</p>';
    return;
  }

  /* ─────────────── 构建 DOM ─────────────── */

  var state = {};      // key -> { tab, grid, cells[], active }
  var order = [];      // tab key 顺序
  var activeKey = null;
  /* 见报 tab 的配图：单独一张表。
     它们不是照片格子（不能进 cells —— cells 要带 item.id 走点赞角标），
     但要挂在同一套懒加载队列上，所以单独记着：
     切回见报时把还没加载完的重新挂上观察。 */
  var newsThumbs = [];

  /* 榜单 tab 的封面懒加载器。
     榜单封面是**外站**的图（热链），跟本站图片不是一回事：
       · 不进本站的加载队列（那个队列的并发上限是给本站图片留的）
       · 不该占本站的 6 条浏览器连接
     所以自己开一个观察器：进了视口才赋 src。 */
  var rankIo = null;

  /* 外链协议校验 —— **只定义这一处**。
   *
   * 之前见报（renderHeadlines）和榜单（rankRow）各写了一遍一模一样的
   * `/^https?:\/\//i.test(it.link)`。两份拷贝意味着以后改一处忘了另一处，
   * 榜单就会漏掉校验 —— 而榜单的 link 全是外部来的（网易云/豆瓣/B站），
   * 恰恰是最需要校验的地方。
   *
   * 挡的是 javascript: 这类伪协议：放进 href 就是 XSS。
   * 校验不过就返回空串，调用方渲染成不可点的纯文本。 */
  function safeHref(link) {
    if (!link || typeof link !== 'string') return '';
    return /^https?:\/\//i.test(link) ? link : '';
  }

  // 见报 tab 是单列文字列表，不是多列图片网格
  function gridClass(tab, active) {
    var c = 'grid';
    if (tab.type === 'headlines') c += ' grid-headlines';
    if (tab.type === 'rank') c += ' grid-rank';
    if (active) c += ' is-active';
    return c;
  }

  tabs.forEach(function (tab) {
    order.push(tab.key);
    state[tab.key] = { tab: tab, grid: null, cells: [], active: false };

    // Tab 按钮
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-key', tab.key);
    btn.style.setProperty('--tab-accent', tab.accent);
    btn.innerHTML =
      '<span class="tab-label">' + tab.label + '</span>' +
      '<span class="tab-badge">' + tab.count + '</span>';
    tabsEl.appendChild(btn);

    // 网格
    var grid = document.createElement('section');
    grid.className = gridClass(tab, false);
    grid.id = 'grid-' + tab.key;
    grid.setAttribute('role', 'tabpanel');
    // 让见报 tab 的 chips / 标签用这个 tab 自己的强调色
    grid.style.setProperty('--tab-accent', tab.accent);

    if (tab.type === 'headlines') {
      renderHeadlines(grid, tab);
    } else if (tab.type === 'rank') {
      renderRank(grid, tab);
    } else {
      tab.items.forEach(function (item, i) {
        var cell = document.createElement('div');
        cell.className = 'cell';
        // 记下这张图属于哪个 tab —— 切 tab 时要靠它决定「谁让路、谁优先」
        cell.setAttribute('data-tab', tab.key);
        cell.style.paddingTop = (item.th / item.tw * 100).toFixed(4) + '%';

        /* 图包在 <a> 里：微信里长按一张被 <a> 包住的图片，给的是**链接菜单**
           （复制链接 / 发送给朋友），「发送给朋友」发出去就是**带缩略图的卡片**；
           不包 <a> 的话发出去是纯图片，链接就没了。
           href 用**相对路径**（正式站 / 脱敏副本两个域名下都对）。 */
        var link = document.createElement('a');
        link.className = 'cell-link';
        link.setAttribute('href', pagePath(tab.key, i));

        var img = document.createElement('img');
        img.alt = tab.label + ' ' + (i + 1);
        img.setAttribute('data-src', item.thumb);
        img.width = item.tw;
        img.height = item.th;
        img.decoding = 'async';
        link.appendChild(img);
        cell.appendChild(link);

        /* 模糊占位：LQIP 是 24px 的小图，以 base64 data URI 内联在 manifest 里。
           零额外请求 —— 首屏立刻有内容感，不用等缩略图下载完。
           没有 LQIP 的条目（老 manifest / 封面类）就什么也不设，
           CSS 里的 var(--lqip, none) 会让这一层完全透明。 */
        if (item.lqip) {
          cell.style.setProperty('--lqip', 'url("' + item.lqip + '")');
        }

        cell.addEventListener('click', function (e) {
          /* 包了 <a> 之后点击会触发链接跳转 —— 这里拦住，
             点图仍然是打开查看器。
             带修饰键的点击（Ctrl/Cmd/Shift）不拦：那是用户想「在新标签页打开」，
             右键菜单里的「在新标签页打开」也是同一个道理。 */
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          openViewer(tab.key, i);
        });

        grid.appendChild(cell);
        var entry = { el: cell, img: img, item: item, loaded: false };
        cell.__entry = entry;
        state[tab.key].cells.push(entry);
      });
    }

    gridsEl.appendChild(grid);
    state[tab.key].grid = grid;
  });

  /* ─────────────── 文字标题（RSS 见报 tab） ─────────────── */

  /* manifest 里那条可选的配图字段。
   *
   * 契约：站内绝对路径（形如 /img/rss/<日期>/<文件名>.webp）。
   *
   * 老 manifest 没有这个字段 —— 现在线上每一期都没有 ——
   * 所以这个函数绝大多数时候返回空串，调用方就不渲染任何 <img>，
   * 页面上跟加这个功能之前**完全一样**（纯文字卡片）。
   *
   * 「不是合法路径」的一律当没有：空串、不是字符串、不是以 / 开头的
   * （外站地址、javascript: 之类）、以 // 开头的（协议相对地址也是外站）、
   * 带空白或引号的（会把属性撑坏）。 */
  function newsImgSrc(it) {
    if (!it) return '';
    var s = it.img;
    if (typeof s !== 'string') return '';
    s = s.replace(/^\s+|\s+$/g, '');
    if (!s) return '';
    if (s.charAt(0) !== '/') return '';
    if (s.charAt(1) === '/') return '';
    if (/[\s"'<>]/.test(s)) return '';
    return s;
  }

  function renderHeadlines(grid, tab) {
    var items = tab.items || [];
    var tags = (tab.tags && tab.tags.length) ? tab.tags : [];
    var list = null;

    /* ─────────────── 真实 RSS 源名统计 ───────────────
     *
     * 为什么不能只拿 manifest 里的 tag 当筛选维度：
     *   tag 是**配置里翻译过**的分类名 —— 「科技」底下其实是驱动之家、
     *   「社区」是虎扑步行街、「数码」是爱范儿、「博客」是博海拾贝…
     *   十个大类里有八个只对应一个源，两套名字对不上，
     *   用户看着「科技」根本不知道底下是哪个 RSS 源。
     *
     * 所以做成两层：
     *   上层 chip = 大类（点它 = 汇总这个大类下所有源的条目）
     *   下层 chip = **真实源名**（点它 = 只看这个源）
     * 源名是从条目里统计出来的，不依赖配置 ——
     * 这样不管配置怎么改、哪一期的数据，名字永远是「真的那个源」。
     */
    var srcStats = {};   // 源名 -> { n: 条数, tags: { 大类名: true } }
    var allSrcs = [];
    for (var s0 = 0; s0 < items.length; s0++) {
      var it0 = items[s0];
      var name0 = it0.source || '';
      if (!name0) continue;
      if (!srcStats[name0]) {
        srcStats[name0] = { n: 0, tags: {} };
        allSrcs.push(name0);
      }
      srcStats[name0].n++;
      var tl0 = (it0.tags && it0.tags.length ? it0.tags : [it0.tag || '']);
      for (var q0 = 0; q0 < tl0.length; q0++) {
        if (tl0[q0]) srcStats[name0].tags[tl0[q0]] = true;
      }
    }

    /* 第一层当前选中的大类。
     *
     * 2026-11-06 起分类行不再有「全部」这个 chip（用户定的）：
     * 打开见报直接看第一个分类（热议），其余分类点一下切过去。
     * 6 个分类并起来本来就等于全部，所以「全部视图」不是必需品。
     *
     * 老 manifest（11-04 及更早）没有新分类时，tags[0] 就是它原来的第一个大类，
     * 行为一致；真的一条 tags 都没有的（理论上没有）退回「不过滤」。 */
    var curTag = tags.length ? tags[0] : '';
    var curSrc = '';   // 第二层当前选中的源名
    var curQuery = ''; // 第三层：关键词

    /* ─────────────── 关键词搜索（2026-11-09 加） ───────────────
     *
     * 为什么加：见报一天 250+ 条，分类 × 来源两层 chip 只能「按类筛」，
     * 没法按内容找 —— 看到标题里有个关键词想直接定位，
     * 只能一个个目录点着翻。
     *
     * 搜什么：标题 + 来源 + 摘要。**不搜标签** —— 标签就是分类名，
     * 跟上面的分类 chip 重复了，搜「科技」会命中一大片没意思的条目。
     *
     * 跟分类/来源是 AND（第三个维度）：分类 ∩ 来源 ∩ 关键词。
     * 跟现有两层保持同一套逻辑，不搞「搜索时忽略分类」那套魔法 ——
     * 用户在某个分类下搜，就是想在这个分类里找。
     * （防「搜不到」的坑靠下面那个提示：当前分类 0 条但全局有的话会说出来。）
     */
    var search = document.createElement('div');
    search.className = 'news-search';

    var searchRow = document.createElement('div');
    searchRow.className = 'news-search-row';

    var input = document.createElement('input');
    /* 用 type="text" + inputmode="search"，**不用 type="search"**。
     *
     * 为什么：type="search" 在 Chrome / Edge / Safari 上会自带一个原生清空按钮
     *（长在输入框里面），跟我们自己那个 ✕ 按钮并排出现 —— 页面上就是两个清空按钮，
     * 看着像两回事。原生那个还塞在输入框里、我们的在外面，视觉上更乱。
     * 老安卓 WebView / 微信 X5 又未必有原生按钮，两边行为还不一样。
     *
     * 改成 type="text" + inputmode="search"：
     *   - 所有浏览器都**只有我们自己的 ✕** 一个清空控件；
     *   - inputmode="search" 让手机键盘照样出「搜索」键（iOS/Android 都认）；
     *   - 顺带把 Esc 也收归我们管 —— type="search" 时 Chrome 会**原生**清空输入框
     *     并触发 input 事件，那是浏览器在干活、不是我们的代码在干活。
     */
    input.type = 'text';
    input.setAttribute('inputmode', 'search');
    input.setAttribute('enterkeyhint', 'search');
    input.setAttribute('autocomplete', 'off');
    input.className = 'news-search-input';
    input.placeholder = '搜标题、来源或摘要';
    input.setAttribute('aria-label', '搜索见报条目');

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'news-search-clear';
    clearBtn.textContent = '✕';
    clearBtn.setAttribute('aria-label', '清空搜索');
    clearBtn.hidden = true;

    var countEl = document.createElement('span');
    countEl.className = 'news-search-count';

    searchRow.appendChild(input);
    searchRow.appendChild(clearBtn);
    search.appendChild(searchRow);
    search.appendChild(countEl);
    grid.appendChild(search);

    input.addEventListener('input', function () {
      curQuery = input.value.trim().toLowerCase();
      clearBtn.hidden = !curQuery;
      applyFilter();
    });
    clearBtn.addEventListener('click', function () {
      input.value = '';
      curQuery = '';
      clearBtn.hidden = true;
      applyFilter();
      input.focus();
    });
    input.addEventListener('keydown', function (e) {
      /* Esc 清空搜索。别让它冒泡 —— 页面上还有查看器的 Esc 处理。 */
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!input.value) return;
      input.value = '';
      curQuery = '';
      clearBtn.hidden = true;
      applyFilter();
    });

    /* 当前大类下的源；没选大类时是全部 */
    function visibleSrcs() {
      if (!curTag) return allSrcs.slice();
      return allSrcs.filter(function (nm) { return srcStats[nm].tags[curTag]; });
    }

    /* 三个维度是 AND：大类 ∩ 源 ∩ 关键词 */
    function applyFilter() {
      if (!list) return;
      var q = curQuery;
      var lis = list.getElementsByTagName('li');
      var shown = 0;
      var globalHit = 0;
      for (var k = 0; k < lis.length; k++) {
        // 一条新闻可能同时属于多个目录（data-tags 空格分隔），
        // 所以是「包含」匹配而不是「等于」——
        // 以后某条要同时挂两个目录也能切得动。
        var ts = (lis[k].getAttribute('data-tags') || '').split(/\s+/);
        var hitTag = !curTag || ts.indexOf(curTag) >= 0;
        var srcName = lis[k].getAttribute('data-src') || '';
        var hitSrc = !curSrc || srcName === curSrc;
        var hitQ = !q || (lis[k].getAttribute('data-search') || '').indexOf(q) >= 0;
        // 用 class 而不是 hidden 属性 —— CSS 里设了 display 会盖掉 [hidden]
        var hit = hitTag && hitSrc && hitQ;
        lis[k].className = hit ? 'news-item' : 'news-item is-hidden';
        if (hit) shown++;
        if (q && hitQ) globalHit++;
      }
      /* 结果计数。
       *   没搜索词时不显示（平时不需要多一行字）。
       *   当前筛选下 0 条、但全局有命中时要说出来 ——
       *   否则用户会以为「这站上没有这条」，其实换个分类就有。
       *   文案说「当前筛选」而不是「本分类」：源那一层也可能正在收窄。 */
      if (!q) {
        countEl.textContent = '';
      } else if (shown === 0 && globalHit > 0) {
        countEl.textContent = '当前筛选 0 条 · 全局 ' + globalHit + ' 条';
      } else {
        countEl.textContent = '找到 ' + shown + ' 条';
      }
    }

    function markActive(container, key, attr) {
      var bs = container.getElementsByTagName('button');
      for (var j = 0; j < bs.length; j++) {
        var v = bs[j].getAttribute(attr) || '';
        bs[j].className = (v === key) ? 'chip is-active' : 'chip';
      }
    }

    /* ── 第一层：大类 ── */
    if (tags.length) {
      var tagChips = document.createElement('div');
      tagChips.className = 'chips chips-tags';

      var mkTag = function (label, tag) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'chip';
        c.textContent = label;
        c.setAttribute('data-tag', tag || '');
        return c;
      };

      /* 没有「全部」了 —— 只留分类本身。
         当前选中的那个由 markActive 统一打上 is-active（初始是第一个分类）。 */
      for (var i = 0; i < tags.length; i++) tagChips.appendChild(mkTag(tags[i], tags[i]));
      markActive(tagChips, curTag, 'data-tag');

      tagChips.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.chip') : null;
        if (!btn) return;
        curTag = btn.getAttribute('data-tag') || '';
        curSrc = '';              // 换大类时把源的选择重置
        markActive(tagChips, curTag, 'data-tag');
        renderSrcChips();
        applyFilter();
      });

      grid.appendChild(tagChips);
    }

    /* ── 第二层：真实 RSS 源名 ── */
    var srcChips = document.createElement('div');
    srcChips.className = 'chips chips-srcs';
    srcChips.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chip') : null;
      if (!btn) return;
      curSrc = btn.getAttribute('data-src') || '';
      markActive(srcChips, curSrc, 'data-src');
      applyFilter();
    });
    grid.appendChild(srcChips);

    function renderSrcChips() {
      // 清空用 removeChild 而不是 innerHTML ——
      // 这个文件里 innerHTML 只用来放静态字符串，别把动态内容混进来
      while (srcChips.firstChild) srcChips.removeChild(srcChips.firstChild);

      var cap = document.createElement('span');
      cap.className = 'chips-cap';
      cap.textContent = '来源';
      srcChips.appendChild(cap);

      var mkSrc = function (label, nm) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'chip';
        c.textContent = label;
        c.setAttribute('data-src', nm || '');
        return c;
      };

      // 按钮文案说清楚「全部」指的是哪个范围 —— 两层都有「全部」，容易混
      srcChips.appendChild(mkSrc(curTag ? ('全部·' + curTag) : '全部源', ''));
      var vs = visibleSrcs();
      for (var j = 0; j < vs.length; j++) {
        var nm = vs[j];
        srcChips.appendChild(mkSrc(nm + ' ' + srcStats[nm].n, nm));
      }
      markActive(srcChips, curSrc, 'data-src');
    }
    renderSrcChips();

    list = document.createElement('ul');
    list.className = 'news-list';

    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      var li = document.createElement('li');
      li.className = 'news-item';
      // data-tag  = 显示在徽章上的那个标签
      // data-tags = 这条新闻归属的全部标签（空格分隔），过滤用
      // data-src  = 真实 RSS 源名，第二层 chip 过滤用
      // 老数据没有 tags 字段时退回单个 tag，兼容旧 manifest。
      li.setAttribute('data-tag', it.tag || '');
      li.setAttribute('data-tags', (it.tags && it.tags.length ? it.tags : [it.tag || '']).join(' '));
      li.setAttribute('data-src', it.source || '');
      // 搜索用的文本：标题 + 来源 + 摘要。**不含标签** —— 标签就是分类名，
      // 跟分类 chip 重复了，搜「科技」会命中一大片没意义的条目。
      li.setAttribute('data-search',
        ((it.title || '') + ' ' + (it.source || '') + ' ' + (it.desc || '')).toLowerCase());

      // 没有原文链接的条目**不要**渲染成 <a href="#">：
      // 点了会跳到页面顶部，用户以为页面坏了。
      // 这种情况渲染成纯文本 span，看起来就是「这条没有链接」。
      var href = safeHref(it.link);
      var box;
      if (href) {
        box = document.createElement('a');
        box.className = 'news-link';
        box.href = href;
        box.target = '_blank';
        box.rel = 'noopener noreferrer';
      } else {
        box = document.createElement('span');
        box.className = 'news-link news-link-plain';
      }

      /* 配图（可选）。
       *
       * manifest 里没有 img 字段的老数据走不到这个分支 ——
       * 纯文字、不渲染任何 <img>，版式跟以前一个像素都不差。
       * 有图的条目才套 .has-thumb，走「图在左、字在右」的两栏版式。 */
      var body = box;
      var imgUrl = newsImgSrc(it);
      if (imgUrl) {
        body = document.createElement('span');
        body.className = 'news-body';
        box.className = box.className + ' has-thumb';

        var thumb = document.createElement('span');
        thumb.className = 'news-thumb';
        /* 跟照片格子一样标 data-tab：
           懒加载的 IntersectionObserver 从这个属性取队列的 key，
           见报 tab 的 key 是 news —— 切走时队列会把这边的在途请求中止掉。 */
        thumb.setAttribute('data-tab', tab.key);
        var timg = document.createElement('img');
        timg.className = 'news-thumb-img';
        /* 装饰性图片：内容都在标题里。
           alt 留空，读屏软件就不会念出图片文件名。 */
        timg.alt = '';
        /* 真实地址先存在 data-src 上，等进了视口才赋给 src */
        timg.setAttribute('data-src', imgUrl);
        /* 写死宽高：图片到位之前位置就占好了，页面不会跳（CLS）。
           真正显示的尺寸由 CSS 定（.news-thumb），这里只是给浏览器一个宽高比。 */
        timg.width = 96;
        timg.height = 72;
        timg.decoding = 'async';
        thumb.appendChild(timg);
        box.appendChild(thumb);
        newsThumbs.push(thumb);
      }

      var h = document.createElement('span');
      h.className = 'news-title';
      h.textContent = it.title || '';
      body.appendChild(h);

      if (it.desc) {
        var d = document.createElement('span');
        d.className = 'news-desc';
        d.textContent = it.desc;
        body.appendChild(d);
      }

      var meta = document.createElement('span');
      meta.className = 'news-meta';
      // 源名放最前、样式最重：用户要「诚实展示各个 rss 名称来源」，
      // 源名才是真的那个名字；大类名是配置里翻译过的，弱化成描边标签。
      if (it.source) {
        var src = document.createElement('span');
        src.className = 'news-src';
        src.textContent = it.source;
        meta.appendChild(src);
      }
      if (it.tag) {
        var tg = document.createElement('span');
        tg.className = 'news-tag';
        tg.textContent = it.tag;
        meta.appendChild(tg);
      }
      if (it.time) {
        var tm = document.createElement('span');
        tm.className = 'news-time';
        tm.textContent = it.time;
        meta.appendChild(tm);
      }
      if (href) {
        // 外链角标：一眼看出这条能跳出去看全文
        var arrow = document.createElement('span');
        arrow.className = 'news-arrow';
        arrow.textContent = '↗';
        meta.appendChild(arrow);
        // 知乎 / 微博 / X 这几个源点进去是登录墙，不是坏链。
        // 提前标出来，省得用户以为链接有问题。
        if (it.needLogin) {
          var auth = document.createElement('span');
          auth.className = 'news-auth';
          auth.textContent = '需登录';
          meta.appendChild(auth);
        }
      }
      body.appendChild(meta);

      // 有配图时文字装在 .news-body 里（两栏版式：图左字右）；
      // 没有配图的老数据直接挂在链接上，DOM 结构跟以前一模一样。
      if (body !== box) box.appendChild(body);

      li.appendChild(box);
      list.appendChild(li);
    }

    grid.appendChild(list);

    /* 初始就要按当前分类过滤 —— 默认是第一个分类（热议）。
       不调这一下的话，列表是全量渲染的，chip 高亮着「热议」但屏幕上还是全部。 */
    applyFilter();
  }

  /* ─────────────── 榜单 tab（听乐 / 看片） ─────────────── */
  /*
   * 三个能力：
   *   1. 本地搜 —— 对 manifest 里烘好的榜单条目做过滤。**零请求**。
   *   2. 全网搜 —— 音乐走 iTunes Search API，**浏览器直连**
   *      （那家的响应头是 Access-Control-Allow-Origin: *），
   *      完全不经过本站的 Cloudflare → 0 次 Workers 请求、0 次 R2 操作。
   *      影视没有可直连的免 key 搜索 API，回车跳豆瓣搜索页 ——
   *      搜索发生在豆瓣那边，本站零消耗。
   *   3. 封面 —— 对方图床的远程 URL，热链。加载失败就把封面藏掉，
   *      条目本身照常显示（热链被防盗链拦掉是很常见的事）。
   *
   * 为什么本地搜和全网搜要分开：
   *   本地搜即时、零成本，但只能搜到构建期抓下来的那批；
   *   全网搜覆盖整个曲库，但要等一次网络往返。
   *   所以默认行为是「边打字边过滤本地，回车才走全网」。
   */

  function getRankIo() {
    if (rankIo) return rankIo;
    if (!('IntersectionObserver' in window)) return null;
    rankIo = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        var img = e.target;
        rankIo.unobserve(img);
        var src = img.getAttribute('data-src');
        if (src) img.src = src;
      }
    }, { rootMargin: '300px 0px', threshold: 0.01 });
    return rankIo;
  }

  /* iTunes 全网搜。
     country=cn 对**英文**词一条都搜不到（实测 count=0），
     不带 country 的默认 storefront 给的又是繁体中文 ——
     所以策略是「先试 cn（简体），搜不到再退回默认」。
     中文简体优先，英文词也不至于搜了个寂寞。 */
  function itunesSearch(term) {
    var base = 'https://itunes.apple.com/search?media=music&limit=20&term=' + encodeURIComponent(term);
    function get(u) {
      return fetch(u).then(function (r) { return r.json(); });
    }
    return get(base + '&country=cn').then(function (j) {
      if (j && j.resultCount) return j.results || [];
      return get(base).then(function (j2) { return (j2 && j2.results) || []; });
    }).catch(function () { return []; });
  }

  function itunesToItem(r, i) {
    var cover = '';
    /* 100x100 的图放大到 200x200 —— 榜单里封面占 56px，100px 已经够，
       但 200 更经得起高分屏，而且 URL 换了照样是同一张图。 */
    if (r.artworkUrl100) cover = r.artworkUrl100.replace('100x100bb', '200x200bb');
    return {
      rank: i + 1,
      title: r.trackName || r.collectionName || '',
      subtitle: r.artistName || '',
      meta: r.collectionName || '',
      cover: cover,
      link: r.trackViewUrl || '',
      source: 'iTunes',
      tag: '全网搜',
    };
  }

  /* 一条榜单。跟见报条目共用 .news-* 样式，只多了序号和封面。 */
  function rankRow(it) {
    var li = document.createElement('li');
    li.className = 'news-item rank-item';
    li.setAttribute('data-tag', it.tag || '');
    /* 多层筛选靠 data-lv（JSON 数组，见报那套 data-tags 是空格分隔）：
       一条可以同时属于「平台 / 语言」「城市 / 区 / 类型」多个维度，
       所以过滤是「包含」匹配而不是「等于」——
       改成等值匹配的话，多层的第二条就没法筛了。

       ⚠️ 这里用 JSON 而不是空格分隔：
       标签值里**真的会带空格**（平台名 Prime Video、语言 English），
       空格分隔的话标签会被拆成两半，筛选直接失效。
       见报那套 data-tags 不用改 —— 它的标签值是分类名，不带空格。 */
    li.setAttribute('data-lv', JSON.stringify(it.tags && it.tags.length ? it.tags : [it.tag || '']));
    li.setAttribute(
      'data-search',
      ((it.title || '') + ' ' + (it.subtitle || '') + ' ' + (it.meta || '') + ' ' + (it.source || '')).toLowerCase()
    );

    var href = safeHref(it.link);
    var box;
    if (href) {
      box = document.createElement('a');
      box.className = 'news-link has-thumb';
      box.href = href;
      box.target = '_blank';
      box.rel = 'noopener noreferrer';
    } else {
      box = document.createElement('span');
      box.className = 'news-link news-link-plain has-thumb';
    }

    if (it.rank) {
      var no = document.createElement('span');
      no.className = 'rank-no';
      no.textContent = it.rank;
      box.appendChild(no);
    }

    if (it.cover) {
      var cov = document.createElement('span');
      cov.className = 'news-thumb rank-cover';
      var cimg = document.createElement('img');
      cimg.className = 'news-thumb-img';
      cimg.alt = '';
      cimg.setAttribute('data-src', it.cover);
      cimg.width = 56;
      cimg.height = 56;
      cimg.decoding = 'async';
      /* ⚠️ referrerpolicy 必须设成 no-referrer ——
         浏览器默认会把本站地址当 Referer 发出去，而 B站的图床
         (i*.hdslb.com) 见到**非 B站**的 Referer 直接返 403。
         实测：带 Referer: https://example.com/ → 403，不带 → 200。
         不设这一行，听乐/看片 tab 的封面在浏览器里会全挂。 */
      cimg.referrerPolicy = 'no-referrer';
      /* 封面挂了就把整个框藏掉 —— 榜单封面是热链，
         对方加防盗链时 403 很常见，不该给用户留一个灰色方块。 */
      cimg.addEventListener('load', function () { cov.className += ' is-loaded'; });
      cimg.addEventListener('error', function () { cov.className += ' is-failed'; });
      cov.appendChild(cimg);
      box.appendChild(cov);
      var rio = getRankIo();
      if (rio) rio.observe(cimg);
      else cimg.src = it.cover;
    } else {
      /* 没有封面的条目也占一个位 —— 豆瓣的图床全站防盗链
         （裸连 418、带任何第三方 Referer 403），250 部电影的封面
         在构建期就被置空了。有图没图混排会让列表参差不齐，
         所以给个占位框，让序号、封面、文字三列始终对齐。 */
      var ph = document.createElement('span');
      ph.className = 'news-thumb rank-cover rank-cover-empty';
      ph.textContent = (it.title || '?').charAt(0);
      box.appendChild(ph);
    }

    var body = document.createElement('span');
    body.className = 'news-body';

    var h = document.createElement('span');
    h.className = 'news-title';
    h.textContent = it.title || '';
    body.appendChild(h);

    if (it.subtitle || it.meta) {
      var d = document.createElement('span');
      d.className = 'news-desc';
      d.textContent = [it.subtitle, it.meta].filter(Boolean).join(' · ');
      body.appendChild(d);
    }

    var meta = document.createElement('span');
    meta.className = 'news-meta';
    if (it.source) {
      var s = document.createElement('span');
      s.className = 'news-src';
      s.textContent = it.source;
      meta.appendChild(s);
    }
    if (it.tag) {
      var tg = document.createElement('span');
      tg.className = 'news-tag';
      tg.textContent = it.tag;
      meta.appendChild(tg);
    }
    if (href) {
      var arrow = document.createElement('span');
      arrow.className = 'news-arrow';
      arrow.textContent = '↗';
      meta.appendChild(arrow);
    }
    body.appendChild(meta);
    box.appendChild(body);
    li.appendChild(box);
    return li;
  }

  function renderRank(grid, tab) {
    var items = tab.items || [];
    var legacyChips = tab.chips || [];
    var searchCfg = tab.search || {};
    var list = null;
    var curQuery = '';
    var searching = false;

    /* ─────────────── 多层分类 chip ───────────────
     *
     * 层级用条目 tags 里的 '@N:' 前缀表示：
     *   @1 = 板块（全部 / 频道更新 / 本地演出 …）
     *   @2 = 分类（平台 / 城市 / 榜单名 …）
     *   @3 = 细分（语言 / 行政区 …）
     *   @4 = 类型（演出类型 …）
     *
     * 每层的选项**从当前仍然匹配的元素里现推**，不写死在代码里：
     *   选了「本地演出」→ 第二层只出现城市；选了「武汉」→ 第三层只出现武汉的区。
     * 这样天然没有「点进去是空的」的死 chip，换城市组、换平台也不用改前端。
     *
     * 旧 manifest（条目没有 tags 数组）走老路：manifest.chips 给什么就渲染什么，
     * 过滤用 data-tag 等值匹配 —— 不然「只换前端、内容不动」的 --keep-manifest
     * 构建会让分类 chip 整排消失。 */
    var LEVEL_CAPS = ['板块', '分类', '细分', '类型'];
    var MAX_LEVEL = 4;
    var sel = ['', '', '', ''];
    var chipRows = [];
    var legacyRow = null;
    var legacyTag = '';

    /* 条目里有没有层级标签（没有 = 旧 manifest） */
    var hasTags = !!(items.length && items[0].tags && items[0].tags.length);
    var useLegacy = !hasTags;

    /* 某一层的全部标签值。
       一条内容可以同属多个值（比如一首歌同时在中文榜和国际榜），
       所以这里返回**数组**而不是单个值 —— 只取第一个的话，
       「既在中文榜又在国际榜」的歌就只会出现在一个榜里。 */
    function levelTags(el, level) {
      var raw = el.getAttribute('data-lv');
      if (!raw) return [];
      var arr;
      try { arr = JSON.parse(raw); } catch (e) { return []; }
      if (!arr || !arr.length) return [];
      var p = '@' + level + ':';
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string' && arr[i].indexOf(p) === 0 && out.indexOf(arr[i]) < 0) {
          out.push(arr[i]);
        }
      }
      return out;
    }

    /* 元素是否满足已选的各层（upto = 检查到第几层） */
    function matchSel(el, upto) {
      for (var L = 1; L <= upto; L++) {
        if (!sel[L - 1]) continue;
        if (levelTags(el, L).indexOf(sel[L - 1]) < 0) return false;
      }
      return true;
    }

    /* ── 搜索框（复用见报那套样式与交互） ── */
    var search = document.createElement('div');
    search.className = 'news-search';
    var searchRow = document.createElement('div');
    searchRow.className = 'news-search-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('inputmode', 'search');
    input.setAttribute('enterkeyhint', 'search');
    input.setAttribute('autocomplete', 'off');
    input.className = 'news-search-input';
    input.placeholder = searchCfg.placeholder || '搜歌名或歌手';
    input.setAttribute('aria-label', '搜索榜单条目');
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'news-search-clear';
    clearBtn.textContent = '✕';
    clearBtn.setAttribute('aria-label', '清空搜索');
    clearBtn.hidden = true;
    var countEl = document.createElement('span');
    countEl.className = 'news-search-count';
    searchRow.appendChild(input);
    searchRow.appendChild(clearBtn);
    search.appendChild(searchRow);
    search.appendChild(countEl);
    grid.appendChild(search);

    /* chip 行的容器 —— 放在列表前面，chip 行是往它里面塞的 */
    var chipHost = document.createElement('div');
    chipHost.className = 'chip-lines';
    grid.appendChild(chipHost);

    /* ── 旧 manifest 的单层 chip ── */
    if (useLegacy && legacyChips.length) {
      legacyRow = document.createElement('div');
      legacyRow.className = 'chips chips-tags';
      legacyTag = legacyChips[0].tag || '';
      for (var ci = 0; ci < legacyChips.length; ci++) {
        var c = document.createElement('button');
        c.type = 'button';
        c.className = ci === 0 ? 'chip is-active' : 'chip';
        c.textContent = legacyChips[ci].label;
        c.setAttribute('data-tag', legacyChips[ci].tag || '');
        legacyRow.appendChild(c);
      }
      legacyRow.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.chip') : null;
        if (!btn) return;
        legacyTag = btn.getAttribute('data-tag') || '';
        var bs = legacyRow.getElementsByTagName('button');
        for (var j = 0; j < bs.length; j++) {
          bs[j].className = (bs[j].getAttribute('data-tag') === legacyTag) ? 'chip is-active' : 'chip';
        }
        applyFilter();
      });
      chipHost.appendChild(legacyRow);
    }

    /* ── 列表 ── */
    list = document.createElement('ul');
    list.className = 'news-list rank-list';
    for (var n = 0; n < items.length; n++) list.appendChild(rankRow(items[n]));
    grid.appendChild(list);

    /* 全网搜的结果单独标出来 —— 它们不参与本地过滤
       （它们本来就是「本地搜不到」才去搜出来的）。 */
    function clearExtra() {
      var lis = list.getElementsByTagName('li');
      for (var i = lis.length - 1; i >= 0; i--) {
        if (lis[i].getAttribute('data-extra')) list.removeChild(lis[i]);
      }
    }

    /* ── 画某一层的 chip 行 ──
       结构：.chip-line 里左边一个不跟着滚的小标题（板块/分类/细分/类型），
       右边一个横向滚动的 .chips。小标题放滚动区外面，
       否则用户往右滑的时候「这排是什么」就跟着滑没了。 */
    function makeRow(L) {
      var line = document.createElement('div');
      line.className = 'chip-line';
      var cap = document.createElement('span');
      cap.className = 'chips-cap';
      cap.textContent = LEVEL_CAPS[L - 1];
      var row = document.createElement('div');
      row.className = 'chips chips-tags chips-lv' + L;
      row.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.chip') : null;
        if (!btn) return;
        setSel(L, btn.getAttribute('data-tag') || '');
      });
      line.appendChild(cap);
      line.appendChild(row);
      return line;
    }

    function setSel(L, tag) {
      sel[L - 1] = tag;
      /* 改了上层，下层的选择就作废 ——
         否则会出现「选了深圳、结果按上海的区筛」这种看不懂的组合。 */
      for (var i = L; i < MAX_LEVEL; i++) sel[i] = '';
      renderChips();
      applyFilter();
    }

    function renderChips() {
      if (useLegacy) return;
      var lis = list.getElementsByTagName('li');
      for (var L = 1; L <= MAX_LEVEL; L++) {
        /* 本层的候选 = 满足前面所有已选层的元素 */
        var cands = [];
        for (var i = 0; i < lis.length; i++) {
          if (lis[i].getAttribute('data-extra')) continue;
          if (matchSel(lis[i], L - 1)) cands.push(lis[i]);
        }
        /* 本层的选项 = 候选里 '@L:' 标签去重（按出现顺序 = 数据里的顺序） */
        var opts = [];
        var seen = {};
        for (var j = 0; j < cands.length; j++) {
          var lv = levelTags(cands[j], L);
          for (var m = 0; m < lv.length; m++) {
            if (seen[lv[m]]) continue;
            seen[lv[m]] = 1;
            opts.push(lv[m]);
          }
        }
        var row = chipRows[L - 1];
        if (!opts.length) {
          /* 这一层在当前选择下没有内容 → 整行撤掉（不留下一个点了没反应的排）。
             同时要把缓存清掉 —— 否则这层重新有内容时不会挂回 DOM。 */
          if (row && row.parentNode) row.parentNode.removeChild(row);
          chipRows[L - 1] = null;
          continue;
        }
        if (!row) {
          row = makeRow(L);
          chipRows[L - 1] = row;
          chipHost.appendChild(row);
        }
        var chipsBox = row.getElementsByClassName('chips')[0];
        chipsBox.innerHTML = '';
        /* 「全部」= 本层不过滤 */
        chipsBox.appendChild(makeChip('', '全部', sel[L - 1] === ''));
        for (var k = 0; k < opts.length; k++) {
          var full = opts[k];
          var label = full.slice(full.indexOf(':') + 1);
          chipsBox.appendChild(makeChip(full, label, sel[L - 1] === full));
        }
      }
    }

    function makeChip(tag, label, active) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = active ? 'chip is-active' : 'chip';
      b.textContent = label;
      b.setAttribute('data-tag', tag);
      return b;
    }

    function applyFilter() {
      if (!list) return;
      var q = curQuery;
      var lis = list.getElementsByTagName('li');
      var shown = 0;
      for (var k = 0; k < lis.length; k++) {
        var el = lis[k];
        if (el.getAttribute('data-extra')) continue;
        var hitTag = useLegacy
          ? (!legacyTag || (el.getAttribute('data-tag') || '') === legacyTag)
          : matchSel(el, MAX_LEVEL);
        var hitQ = !q || (el.getAttribute('data-search') || '').indexOf(q) >= 0;
        var hit = hitTag && hitQ;
        el.className = hit ? 'news-item rank-item' : 'news-item rank-item is-hidden';
        if (hit) shown++;
      }
      if (!q) countEl.textContent = '';
      else countEl.textContent = '找到 ' + shown + ' 条';
    }

    function doItunes(term) {
      if (searching) return;
      searching = true;
      countEl.textContent = '全网搜中…';
      itunesSearch(term).then(function (results) {
        searching = false;
        clearExtra();
        if (!results.length) {
          countEl.textContent = '全网搜没搜到「' + term + '」';
          return;
        }
        var sep = document.createElement('li');
        sep.className = 'rank-sep';
        sep.setAttribute('data-extra', '1');
        sep.textContent = 'iTunes 全网搜 · ' + results.length + ' 条';
        list.insertBefore(sep, list.firstChild);
        /* 倒序插入到分隔行后面 —— 最终显示顺序是正序 */
        for (var i = results.length - 1; i >= 0; i--) {
          var row = rankRow(itunesToItem(results[i], i + 1));
          row.setAttribute('data-extra', '1');
          list.insertBefore(row, sep.nextSibling);
        }
        countEl.textContent = '全网搜 ' + results.length + ' 条 · 本地 ' + curQuery;
        applyFilter();
      });
    }

    input.addEventListener('input', function () {
      curQuery = input.value.trim().toLowerCase();
      clearBtn.hidden = !curQuery;
      applyFilter();
    });
    clearBtn.addEventListener('click', function () {
      input.value = '';
      curQuery = '';
      clearBtn.hidden = true;
      clearExtra();
      applyFilter();
      input.focus();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!input.value) return;
        input.value = '';
        curQuery = '';
        clearBtn.hidden = true;
        clearExtra();
        applyFilter();
        return;
      }
      if (e.key !== 'Enter') return;
      var term = input.value.trim();
      if (!term) return;
      if (searchCfg.itunes) {
        doItunes(term);
      } else if (searchCfg.douban) {
        /* 跳豆瓣搜 —— 搜索发生在豆瓣那边，本站一点消耗都没有。
           用 location.href 而不是 window.open：微信里新窗口经常被拦。 */
        window.location.href = 'https://search.douban.com/movie/subject_search?search_text=' + encodeURIComponent(term);
      }
    });

    /* 首屏先把各层 chip 画出来（选项是从条目里推的，列表建完才知道） */
    renderChips();
    applyFilter();
  }

  /* ─────────────── 懒加载（IntersectionObserver） ─────────────── */

  var io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var cell = entry.target;
        io.unobserve(cell);
        var key = cell.getAttribute('data-tab');
        enqueueLoad(cell, key, key === activeKey);
      });
    }, { rootMargin: '260px 0px', threshold: 0.01 });
  }

  var loadFailures = 0;

  /* ─────────────── 加载队列（并发上限 + tab 优先级） ───────────────
   *
   * 为什么不直接 img.src = url：
   *   浏览器对同一域名只开 6 条连接。切 tab 的时候，
   *   旧 tab 没下完的图（尤其是看大图时加载的全尺寸图，最大 556KB）
   *   会一直占着这 6 条连接不放，新 tab 的缩略图只能排在浏览器队列里干等 ——
   *   实测切到「见她」后，最后几张等 38~62 秒才出现，看起来就是「加载不了」。
   *
   * 这里自己排一个队：
   *   - 全站在途不超过 MAX_INFLIGHT 条
   *   - 切 tab 时作废其它 tab 在途的请求，把连接让给用户眼前要看的
   *   - 其它 tab 排队中的项退回「未加载」，回头再切回去时重新排队
   *   - 新 tab 的项提到队首
   */
  var MAX_INFLIGHT = 6;
  var loadQueue = [];
  var inflight = 0;
  var inflightJobs = [];
  /* 1x1 透明 gif：用来中止在途的图片请求。
   * 把 src 指到它，浏览器会立刻取消当前下载。
   * .cell img 默认 opacity:0，.is-loaded 才 opacity:1，所以放了也看不见。 */
  var ABORT_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  function enqueueLoad(cell, key, urgent) {
    if (!cell) return;
    if (cell.getAttribute('data-done')) return;
    var img = cell.querySelector('img');
    if (!img) return;
    var src = img.getAttribute('data-src');
    if (!src) return;

    if (cell.getAttribute('data-queued')) {
      // 已经在队列里 —— urgent 时把它提到队首
      if (urgent) {
        for (var i = 0; i < loadQueue.length; i++) {
          if (loadQueue[i].cell === cell) {
            var j = loadQueue.splice(i, 1)[0];
            loadQueue.unshift(j);
            break;
          }
        }
      }
      return;
    }

    cell.setAttribute('data-queued', '1');
    var job = { cell: cell, img: img, key: key, src: src, tries: 0 };
    if (urgent) loadQueue.unshift(job); else loadQueue.push(job);
    pump();
  }

  function pump() {
    while (inflight < MAX_INFLIGHT && loadQueue.length) {
      var job = loadQueue.shift();
      if (job.cell.getAttribute('data-done')) continue;
      startLoad(job);
    }
  }

  function startLoad(job) {
    var cell = job.cell, img = job.img;
    cell.removeAttribute('data-queued');
    inflight++;
    inflightJobs.push(job);

    // 先挂事件再赋 src —— 反过来的话，极快的响应可能在事件挂上之前就回来了
    img.onload = function () { finishLoad(job, true); };
    img.onerror = function () { finishLoad(job, false); };
    img.src = job.src;

    // 极老内核既无 IO 也无 onload 兜底时，至少别一直转圈
    setTimeout(function () {
      if (!cell.getAttribute('data-done')) cell.classList.add('is-loaded');
    }, 20000);
  }

  function finishLoad(job, ok) {
    var cell = job.cell, img = job.img;
    inflight--;
    for (var i = 0; i < inflightJobs.length; i++) {
      if (inflightJobs[i] === job) { inflightJobs.splice(i, 1); break; }
    }

    if (ok) {
      cell.classList.add('is-loaded');
      cell.setAttribute('data-done', '1');
      if (cell.__entry) cell.__entry.loaded = true;
    } else {
      job.tries++;
      // 偶发的 ERR_ABORTED / 超时很常见，一次失败就变裂图太亏 —— 重试两次
      if (job.tries < 2) {
        // 还在重试就别去掉微光 —— 否则格子会先变成一片空白，比转圈更糟
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        setTimeout(function () { enqueueLoad(cell, job.key, true); }, 700 * job.tries);
      } else {
        cell.classList.add('is-loaded');
        cell.setAttribute('data-done', '1');
        /* 见报配图失败只是这一条没图 ——
           不能因此把「访问口令没带上」的提示拉出来（那是照片整片都裂了才该出现的）。
           见报的配图标一下 is-failed，CSS 把它整个藏掉，不给用户留一个空框。 */
        if (cell.classList.contains('news-thumb')) {
          cell.classList.add('is-failed');
        } else {
          loadFailures++;
          // 连续失败多半是访问口令没带上，给个明确提示而不是白屏
          if (loadFailures >= 2 && gateNotice) gateNotice.hidden = false;
        }
      }
    }
    pump();
  }

  /* 切 tab：把连接让给新 tab */
  function switchPriority(key) {
    // 排队中的其它 tab：丢掉（cell 退回未加载，回头再切回去时重新排队）
    for (var i = loadQueue.length - 1; i >= 0; i--) {
      if (loadQueue[i].key !== key) {
        loadQueue[i].cell.removeAttribute('data-queued');
        loadQueue.splice(i, 1);
      }
    }
    // 在途的其它 tab：中止下载，把 6 条连接腾出来给用户现在要看的
    for (var j = inflightJobs.length - 1; j >= 0; j--) {
      var job = inflightJobs[j];
      if (job.key === key) continue;
      job.img.onload = null;
      job.img.onerror = null;
      try { job.img.src = ABORT_SRC; } catch (e) { /* 忽略 */ }
      job.cell.removeAttribute('data-queued');
      inflightJobs.splice(j, 1);
      inflight--;
    }
    pump();
  }

  /* 见报 tab 的配图不在 cells 里（cells 是照片格子），单独观察一遍。
     切走时队列里这批在途请求会被 switchPriority 中止
     （key 是 news，跟照片 tab 不是一路 —— 连接让给用户现在要看的），
     切回来时这里把还没加载完的重新挂上观察。 */
  function observeNewsThumbs() {
    for (var i = 0; i < newsThumbs.length; i++) {
      var t = newsThumbs[i];
      if (t.getAttribute('data-done')) continue;
      if (io) {
        io.observe(t);
      } else {
        // 没有 IntersectionObserver 的老内核：直接全量加载
        enqueueLoad(t, 'news', true);
      }
    }
  }

  function observeTab(key) {
    var cells = state[key].cells;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.loaded) continue;
      if (io) {
        io.observe(c.el);
      } else {
        // 没有 IntersectionObserver 的老内核：直接全量加载该 tab
        enqueueLoad(c.el, key, true);
      }
    }
    // 见报 tab 的配图不在 cells 里，单独观察
    if (key === 'news') observeNewsThumbs();
  }

  /* ─────────────── Tab 切换 ─────────────── */

  function moveInk(btn) {
    if (!btn) return;
    var navLeft = tabsEl.scrollLeft;
    var left = btn.offsetLeft - navLeft;
    tabInk.style.width = btn.offsetWidth + 'px';
    tabInk.style.transform = 'translateX(' + left + 'px)';
    tabInk.style.setProperty('--tab-accent', btn.style.getPropertyValue('--tab-accent') || '#4a8cff');
  }

  function activate(key, skipHash) {
    if (!state[key]) return;
    var prev = activeKey;

    if (prev && prev !== key && state[prev].active) {
      state[prev].grid.className = gridClass(state[prev].tab, false);
      state[prev].active = false;
      var prevBtn = tabsEl.querySelector('[data-key="' + prev + '"]');
      if (prevBtn) prevBtn.className = 'tab';
    }

    var s = state[key];
    s.grid.className = gridClass(s.tab, true);
    s.active = true;
    var btn = tabsEl.querySelector('[data-key="' + key + '"]');
    if (btn) {
      btn.className = 'tab is-active';
      btn.setAttribute('aria-selected', 'true');
      // 保证选中项在可视范围内
      if (btn.offsetLeft < tabsEl.scrollLeft ||
          btn.offsetLeft + btn.offsetWidth > tabsEl.scrollLeft + tabsEl.clientWidth) {
        tabsEl.scrollLeft = btn.offsetLeft - 10;
      }
      moveInk(btn);
    }

    activeKey = key;
    /* 计数单位：图片 tab（没有 type）用「张」，文本型 tab（headlines / rank）用「条」——
       榜单条不是图片，写成「200 张」是错的（2026-11-16 加「追更」时发现）。 */
    countPill.textContent = s.tab.count + (s.tab.type ? ' 条' : ' 张');
    switchPriority(key);   // 把连接让给这个 tab
    observeTab(key);
    if (!skipHash) {
      try { history.replaceState(null, '', '#' + key); } catch (e) { location.hash = key; }
    }
  }

  tabsEl.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.tab') : null;
    if (!btn) return;
    activate(btn.getAttribute('data-key'));
  });

  /* ─────────────── 大图查看器 ─────────────── */

  var vTab = null;
  var vIndex = 0;
  var touchX = 0, touchY = 0, moved = false;

  /* ── 缩放（2026-11-26 加）───────────────────────────────
     为什么加：用户反馈「见笑的图片无法放大」。
     见笑的梗图最长边只有 800px（**上游图源给的上限**，改构建参数也提不高），
     在手机上按屏宽铺开之后字就看不清；
     而站点的 <meta viewport> 写着 user-scalable=no + maximum-scale=1.0，
     **浏览器自带的双指缩放被全局禁掉了** → 以前真的一点放大办法都没有。

     ⚠️ 缩放不能突破源图的像素：放大到 800px 源图的 2 倍以上就是插值糊。
        这里给的是「看清楚」的余地，不是「凭空变清晰」。

     上限 4×：再往上没有信息量，只是把像素摊开。 */
  var ZOOM_MIN = 1, ZOOM_MAX = 4, ZOOM_DOUBLE = 2.5;
  var zoom = 1, panX = 0, panY = 0;
  var zoomBadge = document.getElementById('viewerZoom');

  /** 缩放/平移的最终状态 —— 统一在这里落到 DOM 上。 */
  function applyZoom() {
    if (!viewerImg) return;
    /* ⚠️ data-zoom 是给护栏看的「数字真值」。
       只看 transform 的话，zoom=0.5 和 zoom=1 长得一模一样
       （applyZoom 在 zoom<=1.001 时把 transform 清空）→ 断言就抓不到「缩到 1× 以下」。
       这里把比例直接写出来，护栏才能断言「夹在 1×~4× 之间」。 */
    viewerStage.setAttribute('data-zoom', zoom.toFixed(3));
    if (zoom <= 1.001) {
      viewerImg.style.transform = '';
      viewerStage.classList.remove('is-zoomed');
    } else {
      viewerImg.style.transform =
        'translate3d(' + Math.round(panX) + 'px,' + Math.round(panY) + 'px,0) scale(' + zoom.toFixed(3) + ')';
      viewerStage.classList.add('is-zoomed');
    }
    if (zoomBadge) {
      if (zoom <= 1.001) {
        zoomBadge.hidden = true;
      } else {
        zoomBadge.hidden = false;
        zoomBadge.textContent = zoom.toFixed(1) + '×';
      }
    }
  }

  /**
   * 设定缩放比例。
   * @param {number} z 目标比例（夹在 1× ~ 4× 之间）
   * @param {number} [ax] 锚点屏幕坐标 x；不给就是以 stage 中心为锚点
   * @param {number} [ay] 锚点屏幕坐标 y
   *
   * 锚点缩放的算法：图以 stage 中心为中心、transform-origin 也是 center，
   * 所以「锚点底下那个像素」在图上的相对位置是 (锚点 - 中心 - pan) / zoom；
   * 换比例后要让它还停在锚点上 → pan' = 锚点偏移 - 相对位置 × 新比例。
   * 不这么算的话，捏合的时候图会往两根手指中间「滑」，越放大越跑偏。 */
  function setZoom(z, ax, ay) {
    var old = zoom;
    var nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (nz <= 1.001) nz = 1;
    if (typeof ax === 'number' && typeof ay === 'number') {
      var box = viewerStage.getBoundingClientRect();
      var dx = ax - (box.left + box.width / 2);
      var dy = ay - (box.top + box.height / 2);
      var ux = (dx - panX) / old;
      var uy = (dy - panY) / old;
      panX = dx - ux * nz;
      panY = dy - uy * nz;
    }
    zoom = nz;
    if (zoom === 1) { panX = 0; panY = 0; }
    clampPan();
    applyZoom();
  }

  /** 平移边界：放大后不能把图拖出屏幕，也不能拖到图外面露出空白。 */
  function clampPan() {
    if (zoom <= 1.001) { panX = 0; panY = 0; return; }
    var maxX = Math.max(0, (viewerImg.offsetWidth * zoom - viewerStage.clientWidth) / 2);
    var maxY = Math.max(0, (viewerImg.offsetHeight * zoom - viewerStage.clientHeight) / 2);
    if (panX > maxX) panX = maxX; else if (panX < -maxX) panX = -maxX;
    if (panY > maxY) panY = maxY; else if (panY < -maxY) panY = -maxY;
  }

  /** 回到 1× —— 切图、关闭时都要复位，否则下一张也是放大的。 */
  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyZoom();
  }

  /* ── 返回陷阱：看大图时按返回，别把整页退出去 ──────────────
     CSS 那一侧（overscroll-behavior）能拦掉「页面自己造成的横向越界」，
     但**系统级边缘返回**（iOS Safari 的右滑、微信里右滑退出到聊天列表）
     那是宿主行为，页面拦不住。

     能做的代码级缓解是**返回陷阱**：打开大图时往历史里压一条，
     用户按返回 / 右滑时退掉的是**这一条** → popstate 里把大图关掉，
     而不是让整页退出去。

     ⚠️ **只压一条**，而且**只在查看器开着的时候压**：
        压多了会把用户困在站内（返回键怎么按都出不去），那是骚扰。
        一条 = 「看图时那一次返回被大图吃掉」；
        关掉大图时我们把这条退掉 → 下一次返回照旧正常退出页面。 */
  var trapId = 0;            // 当前压着的那条陷阱的编号（0 = 没压）
  var trapSeq = 0;           // 编号自增
  var trapBacking = false;   // 「我们自己退掉那条」还没落地
  var trapBackToken = 0;     // 用来作废过期的兜底定时器
  var trapWaiters = [];      // 等「退干净了」再压新一条的排队

  function flushTrapWaiters() {
    var ws = trapWaiters;
    trapWaiters = [];
    for (var i = 0; i < ws.length; i++) {
      try { ws[i](); } catch (e) { /* 压不进去就算了，不能连累别的 */ }
    }
  }

  /** 压一条历史。URL 用空串 = 保持当前地址不变（只是多一条历史）。 */
  function pushTrap() {
    trapId = ++trapSeq;
    try {
      history.pushState({ vt: trapId }, '');
    } catch (e) {
      trapId = 0;   // 压不进去就算了 —— 不能因此把关闭逻辑弄坏
    }
  }

  /** 把自己压的那条退掉 —— 让用户下一次返回是「正常退出页面」，而不是白白多按一次 */
  function popTrap() {
    if (!trapId) return;
    trapId = 0;
    trapBacking = true;
    var myToken = ++trapBackToken;
    try {
      history.back();
    } catch (e) {
      trapBacking = false;
      return;
    }
    /* 兜底：万一回声没来（history.back() 什么也没做），
       1.5 秒后自己把标志清掉 —— 别把陷阱永久卡死。 */
    setTimeout(function () {
      if (trapBackToken !== myToken) return;   // 已经有更新的动作了
      if (!trapBacking) return;                // 回声已经到了
      trapBacking = false;
      flushTrapWaiters();
    }, 1500);
  }

  window.addEventListener('popstate', function () {
    if (trapBacking) {
      /* 回声：是我们自己在 closeViewer 里退掉那条触发的 —— 什么都不用做 */
      trapBacking = false;
      trapBackToken++;      // 作废兜底定时器
      flushTrapWaiters();
      return;
    }
    /* 不是回声 = 用户自己按了返回 / 做了边缘返回手势。
       大图开着 → 关大图，**页面不退出**。 */
    if (viewer.hidden) return;   // 没有大图可关 → 放行，页面正常后退
    trapId = 0;                  /* 那条历史已经被浏览器退掉了 */
    closeViewer({ fromPopstate: true });
  });

  function openViewer(key, index) {
    vTab = key;
    vIndex = index;
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    resetZoom();
    renderViewer();
    viewerHint.className = 'viewer-hint';
    /* 压一条历史，让返回手势先被大图吃掉（见上面的「返回陷阱」） */
    if (trapBacking) {
      /* 上一条陷阱正在退 —— 等退干净了再压新的。
         不等的话会多压一条 → 用户返回要多按一次才出得来。 */
      trapWaiters.push(pushTrap);
    } else {
      pushTrap();
    }
  }

  function closeViewer(opts) {
    opts = opts || {};
    clearTimeout(closeTimer);
    viewer.hidden = true;
    document.body.style.overflow = '';
    viewerImg.removeAttribute('src');
    resetZoom();
    abortPreloads();
    /* 大图都关了，排队等着压的那条也作废（别压出一条没人管的陷阱） */
    trapWaiters.length = 0;
    /* 从 popstate 进来时，那条历史**已经被浏览器退掉了** —— 不能再退一次，
       再退一次就把页面本身退出去了。 */
    if (!opts.fromPopstate) popTrap();
  }

  function renderViewer() {
    var s = state[vTab];
    var entry = s.cells[vIndex];
    if (!entry) return;
    /* 切图 = 回到 1×。带着上一张的缩放切过去，图会停在莫名其妙的位置。 */
    resetZoom();
    viewerImg.src = entry.item.full;
    viewerCount.textContent = vIndex + 1 + ' / ' + s.tab.count;
    showHint(3200);
    // 预载左右邻居，滑动时不卡
    preload(vIndex - 1);
    preload(vIndex + 1);
    syncViewerActions();
  }

  /* 预加载的图片对象必须保留引用。
     如果 new Image() 创建完就丢掉引用（局部变量出作用域即被回收），
     Chromium 可能在请求完成前把它 GC 掉，连带把正在进行的图片请求取消掉，
     控制台/网络面板里表现为 net::ERR_ABORTED。
     这里用一个数组把预加载对象钉住。 */
  var preloadPool = [];

  function preload(i) {
    var s = state[vTab];
    var entry = s.cells[i];
    if (!entry) return;
    var im = new Image();
    im.src = entry.item.full;
    preloadPool.push(im);
    // 上限从 12 降到 4 —— 一张全尺寸图最大 556KB，
    // 12 张就是在后台白白下 6.7MB，慢链路上要堵好几分钟。
    if (preloadPool.length > 4) preloadPool.splice(0, preloadPool.length - 4);
  }

  /* 关掉查看器时，把预载的全尺寸图全部中止。
   *
   * 不中止的话它们会在后台继续下载完（一张 556KB 的全尺寸图，
   * 在慢链路上要一两分钟），把浏览器那 6 条连接占满 ——
   * 后面切 tab 的缩略图只能排在后面干等，
   * 表现就是「见闻和见笑的图片加载不了」。
   *
   * 预载只是为了让滑动不卡，用户已经看完关掉了，就没必要下完。 */
  function abortPreloads() {
    for (var i = 0; i < preloadPool.length; i++) {
      try { preloadPool[i].src = ABORT_SRC; } catch (e) { /* 忽略 */ }
    }
    preloadPool.length = 0;
  }

  function step(delta) {
    var s = state[vTab];
    var next = vIndex + delta;
    if (next < 0 || next >= s.tab.count) return;
    vIndex = next;
    renderViewer();
  }

  viewerClose.addEventListener('click', closeViewer);

  document.addEventListener('keydown', function (e) {
    if (viewer.hidden) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  });

  /* ── 手势：滑动切图 / 双击放大 / 双指捏合 / 拖动平移 ──────
     ⚠️ 下面三个监听器**不能**是 passive:true ——
        捏合缩放必须 preventDefault，否则浏览器会自己把双指当页面缩放/滚动
        （而站点的 viewport 里 user-scalable=no，浏览器缩放又被禁了，
          结果就是页面被拖走、我们的缩放不生效）。
        所以这里改成非 passive：需要拦的分支调 preventDefault，
        不需要拦的分支（1× 状态的单指滑动切图）照样放行。 */
  var pinchDist = 0, pinchZoom = 1, pinching = false;
  var panFromX = 0, panFromY = 0, panBaseX = 0, panBaseY = 0;
  var lastTapAt = 0, lastTapX = 0, lastTapY = 0;
  var closeTimer = 0;

  /** 两指之间的距离（捏合比例用）。 */
  function touchDist(e) {
    if (!e.touches || e.touches.length < 2) return 0;
    var a = e.touches[0];
    var b = e.touches[1];
    var dx = a.clientX - b.clientX;
    var dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 两指的中点（捏合时的锚点）。 */
  function touchMid(e) {
    var a = e.touches[0];
    var b = e.touches[1];
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  /**
   * 是不是「双击」的第二次？
   * 第一次调用只是登记这次点击，第二次在时间窗内且位置够近才算双击。
   * 判定阈值 40px / 280ms —— 手指头点不准，位置差得太多就不算双击。 */
  function isDoubleTap(x, y) {
    var now = Date.now();
    if (now - lastTapAt < 280 && Math.abs(x - lastTapX) < 40 && Math.abs(y - lastTapY) < 40) {
      lastTapAt = 0;
      return true;
    }
    lastTapAt = now;
    lastTapX = x;
    lastTapY = y;
    return false;
  }

  /**
   * 点一下（单击、或双击的其中一下）。
   *
   * ⚠️ 单击和双击**必须共用这一条路** —— 之前把它们分成两套（放大态提前 return、
   *    1× 态走另一套），结果放大态的那一下既没登记成「双击」、
   *    也没取消上一轮遗留的「延时关闭」定时器，
   *    那个定时器随后把查看器关了（2026-11-26 护栏实测抓到的）。
   *
   * 双击的第一下不能立刻生效（否则双击放大永远等不到第二下），
   * 所以单击一律**延后 240ms** 再执行；第二下会把这个延时取消。
   */
  function handleTap(x, y) {
    if (isDoubleTap(x, y)) {
      clearTimeout(closeTimer);
      if (zoom > 1.001) setZoom(1);
      else setZoom(ZOOM_DOUBLE);
      return;
    }
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      /* 单击：放大状态下 = 还原到 1×；1× 状态下 = 关闭查看器。 */
      if (zoom > 1.001) setZoom(1);
      else closeViewer();
    }, 240);
  }

  viewerStage.addEventListener('touchstart', function (e) {
    if (e.touches.length >= 2) {
      /* 双指 = 捏合缩放。基准记下来，比例按「当前距离 / 起始距离」算。 */
      pinching = true;
      pinchDist = touchDist(e);
      pinchZoom = zoom;
      moved = true;
      return;
    }
    var t = e.touches[0];
    touchX = t.clientX;
    touchY = t.clientY;
    panFromX = t.clientX;
    panFromY = t.clientY;
    panBaseX = panX;
    panBaseY = panY;
    moved = false;
  }, { passive: false });

  viewerStage.addEventListener('touchmove', function (e) {
    if (pinching && e.touches.length >= 2) {
      e.preventDefault();
      var d = touchDist(e);
      if (pinchDist > 0 && d > 0) {
        var mid = touchMid(e);
        setZoom(pinchZoom * (d / pinchDist), mid.x, mid.y);
      }
      return;
    }
    if (zoom > 1.001 && e.touches.length === 1) {
      /* 放大状态下：单指拖动 = 平移，不切图。 */
      e.preventDefault();
      var t = e.touches[0];
      panX = panBaseX + (t.clientX - panFromX);
      panY = panBaseY + (t.clientY - panFromY);
      clampPan();
      applyZoom();
      moved = true;
      return;
    }
    /* 1× 状态下的单指拖动：这里**只处理横向**（横向 = 切图）。
     *
     * ⚠️ **横向必须 preventDefault** —— 否则浏览器会把这个横拖
     *    当成它自己的「横向越界」→ 规范里叫 horizontal swipe navigation →
     *    **历史回退** → 用户一滑就退出网页（手机端最常见的误退出原因）。
     *    纵向不拦：viewer 是全屏固定层，纵向本来就不滚，拦了只会挡掉系统行为。
     *    注：`.viewer-stage` 上还有 `touch-action:none` 兜底，但那是 CSS 层面的，
     *    老内核/微信 X5 可能不认 —— 显式 preventDefault 才是真正的那道门。 */
    if (e.touches.length === 1) {
      var dx = e.touches[0].clientX - panFromX;
      var dy = e.touches[0].clientY - panFromY;
      if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
    }
    moved = true;
  }, { passive: false });

  viewerStage.addEventListener('touchend', function (e) {
    if (pinching) {
      /* 双指抬起一根：不算点击、也不算切图。
         把基准挪到剩下那根手指上，否则它继续动会突然跳一大截。 */
      if (e.touches.length < 2) {
        pinching = false;
        if (e.touches.length === 1) {
          var rest = e.touches[0];
          touchX = rest.clientX;
          touchY = rest.clientY;
          panFromX = rest.clientX;
          panFromY = rest.clientY;
          panBaseX = panX;
          panBaseY = panY;
        }
        moved = true;
      }
      return;
    }
    var t = e.changedTouches[0];
    var dx = t.clientX - touchX;
    var dy = t.clientY - touchY;
    if (zoom > 1.001) {
      /* 放大状态下：单指拖动已经在 touchmove 里平移过了，这里只处理「点一下」。
         ⚠️ 横向滑动**不能**切图 —— 否则拖着看图会一路翻页。 */
      if (!moved) handleTap(t.clientX, t.clientY);
      return;
    }
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
      step(dx < 0 ? 1 : -1);
      showHint(1600);
    } else if (!moved) {
      handleTap(t.clientX, t.clientY);
    }
  });

  // 桌面端：滚轮缩放（查看器是全屏固定层，页面本身不会滚，所以滚轮直接拿来缩放）
  viewerStage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var k = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    setZoom(zoom * k, e.clientX, e.clientY);
  }, { passive: false });

  /* 桌面端点图关闭 / 放大 / 双击放大 —— 跟触屏**共用** handleTap。
   * ⚠️ 这里**故意不用 dblclick 事件**：
   *   ① 触屏上双击会同时派发 dblclick，那条路 touchend 已经处理过了，
   *      再处理一遍会把刚放大的图又还原掉（放大→还原，来回抵消）；
   *   ② 桌面端 dblclick 是在 click,click 之后才派的，
   *      而 click 已经把「双击的第一下」记上了 —— 用 click 自己判更准。
   * 所以双击统一由 handleTap 里的 isDoubleTap 判定。 */
  viewerStage.addEventListener('click', function (e) {
    if ('ontouchstart' in window) return; // 移动端交给 touchend
    handleTap(e.clientX, e.clientY);
  });

  var hintTimer = null;
  var HINT_DEFAULT = '左右滑动切换 · 双击放大 · 长按可保存';
  /**
   * 查看器底部那行提示。
   * @param {number} delay 多久之后自动收回去
   * @param {string} [text] 要显示的文字；不给就用默认那句。
   *   「链接已复制」这类临时提示靠这个参数，收回时自动换回默认文案，
   *   免得下一张图还挂着「链接已复制」。 */
  function showHint(delay, text) {
    viewerHint.textContent = text === undefined ? HINT_DEFAULT : text;
    viewerHint.className = 'viewer-hint';
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      viewerHint.className = 'viewer-hint is-hidden';
      viewerHint.textContent = HINT_DEFAULT;
    }, delay);
  }

  /* ─────────────── 启动 ─────────────── */

  loadingEl.hidden = true;

  var initial = (location.hash || '').replace('#', '');
  if (!state[initial]) {
    // 默认落点由构建时写死（见 tools/build.mjs 的 TABS[].default）。
    // 不再用「数量最多的分类」兜底 —— 那个逻辑会让第一眼的内容随照片数量漂移，
    // 万一「见她」的照片变多，群友点开看到的第一眼就变成写真了。
    // 老产物（没有 defaultTab 字段）才退回「数量最多」。
    if (state[DATA.defaultTab]) {
      initial = DATA.defaultTab;
    } else {
      var best = tabs[0];
      tabs.forEach(function (t) { if (t.count > best.count) best = t; });
      initial = best.key;
    }
  }
  activate(initial, true);

  // 字体加载完成后 tab 宽度会变，重算指示条
  window.addEventListener('load', function () {
    var btn = tabsEl.querySelector('[data-key="' + activeKey + '"]');
    moveInk(btn);
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      var btn = tabsEl.querySelector('[data-key="' + activeKey + '"]');
      moveInk(btn);
    });
  }

  // 横竖屏切换后重算
  window.addEventListener('resize', function () {
    var btn = tabsEl.querySelector('[data-key="' + activeKey + '"]');
    moveInk(btn);
  });

  /* 点赞：计数 + 角标 */
  document.getElementById('viewerLike').addEventListener('click', function () {
    toggleLike();
  });

  /* 「复制链接」：复制当前这张图的单图页地址（老安卓微信走降级路径） */
  var viewerShare = document.getElementById('viewerShare');
  if (viewerShare) {
    viewerShare.addEventListener('click', function () {
      copyPageLink();
    });
  }

  loadSocial(DATA.date);
})();
