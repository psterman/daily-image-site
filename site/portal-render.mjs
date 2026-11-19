import { cleanSummary, isTwitterLikeUrl } from '../lib/ingest-map.mjs';
import { fetchFullText } from '../lib/fulltext-client.mjs';
import { splitReadingParagraphs, isMostlyCjk, toReadingHtml } from '../lib/extract-article.mjs';
import { sourceIconUrl } from '../lib/tag-options.mjs';
import { FORMAT_OPTIONS, itemMatchesFormats } from '../lib/format-catalog.mjs';
import {
  SRC_MEDIA_CHIPS,
  SRC_PLATFORM_CHIPS,
  NEWS_CHIPS,
  TOPIC_CHIP_ICON,
  sourceMediaKey,
  sourcePlatformKey,
  sourceTopicKey,
} from '../lib/source-dims.mjs';

function markSpan(mark) {
  if (!mark || !mark.ch) return null;
  var s = document.createElement('span');
  s.className = 'chip-av';
  s.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-size:9px;font-weight:600;background:'
    + mark.bg + ';color:' + mark.fg;
  s.textContent = mark.ch;
  return s;
}

/** 简悦式正文：优先安全 HTML（段/链/图），否则纯文本再分段。 */
function fillReadingBody(box, text, html) {
  const sample = String(text || html || '');
  box.className = 'sr-body';
  if (isMostlyCjk(sample)) box.classList.add('is-cjk');
  box.textContent = '';
  var safe = String(html || '').trim();
  if (safe && /<[a-z]/i.test(safe)) {
    // 客户端再消一次，防缓存旧接口未消毒
    box.innerHTML = toReadingHtml(safe);
    return box;
  }
  const paras = splitReadingParagraphs(text);
  if (!paras.length) {
    box.textContent = String(text || '');
    return box;
  }
  paras.forEach(function (p) {
    const node = el('p');
    node.textContent = p;
    box.appendChild(node);
  });
  return box;
}

function readingMinutes(chars) {
  const n = Math.max(1, Math.round(Number(chars || 0) / 400));
  return n;
}

/**
 * portal-render.mjs —— 读者日报页渲染内核（浏览器 ES 模块）。
 *
 * 架构借鉴自 psterman/daily-image-site 的 site/app.js：
 *   - 一份数据驱动全部视图，前端不做取数、不调 API；
 *   - tabs[] 生成栏目按钮，location.hash 切栏目；
 *   - tab.type 分派三种渲染：text / rank / media；
 *   - safeHref() 单点校验外链协议，挡 javascript: XSS；
 *   - 搜索/筛选在前端做，三级 AND（栏目内 关键词 × 来源）。
 *
 * 与线上原版的关键差别：
 *   原版吃 manifest.tabs[].items[]（含 thumb/full/lqip 图片字段）；
 *   这里吃 lib/platform-flow.mjs 产出的 digest.tabs[].highlights[]，
 *   即 { title, url, note } —— 和 render-email.mjs 消费的是同一份数据。
 *   于是「网页 / 邮件 / agent」三端真正同源：改一次 digest，三端一起变。
 *
 * 版权策略：media 栏目默认渲染「索引卡 + 看原文」，不转存图片。
 *   highlights 里若带 thumb/full（授权源）才渲染真图。
 */
var rState = {};
var rOrder = [];
var rActive = null;
var rRoot = null;

/** 外链协议单点校验：只定义这一处，调用方一律用它。 */
export function safeHref(link) {
  if (!link || typeof link !== 'string') return '';
  return /^https?:\/\//i.test(link) ? link : '';
}

/** HTML 文本转义（& 最先，否则会把后面替换出的实体再转一次）。 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function el(tag, cls) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function qs(sel, root) {
  return Array.prototype.slice.call((root || rRoot || document).querySelectorAll(sel));
}

/** 切栏目。push=true 时同步地址栏 hash；支持外部 hashchange 触发。 */
export function switchTab(key, push) {
  if (!rState[key]) return;
  rActive = key;
  Object.keys(rState).forEach(function (k) {
    rState[k].grid.classList.toggle('is-active', k === key);
  });
  qs('.tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.key === key);
  });
  if (push && typeof location !== 'undefined' && location.hash !== '#' + key) {
    history.replaceState(null, '', '#' + key);
  }
}

export function currentTab() {
  return rActive;
}

/**
 * 把一份 digest 渲染进容器（幂等：重复调用会重建，不累加）。
 * @param {HTMLElement} root 容器元素
 * @param {object} digest lib/platform-flow.mjs 的 buildPlatformDigest 产物
 * @param {object} [opts] { onTab?, fulltextEndpoint?, enableFulltext?,
 *   shareUrl?, onCopyShare?, onForward? }
 */
export function renderReader(root, digest, opts) {
  if (!root) throw new Error('renderReader 需要容器元素');
  if (!digest || !Array.isArray(digest.tabs)) throw new Error('renderReader 需要含 tabs[] 的 digest');
  opts = opts || {};
  rRoot = root;
  rState = {};
  rOrder = [];
  rActive = null;
  root.innerHTML = '';
  // 默认开按需全文；宿主可 opts.enableFulltext=false 关掉
  if (opts.enableFulltext === undefined) opts.enableFulltext = true;

  var head = el('div', 'reader-head');
  var top = el('div', 'reader-topbar');
  var brand = el('div', 'reader-brand');
  var logo = el('div', 'reader-logo');
  logo.textContent = '头';
  var brandText = el('div');
  var name = el('div', 'reader-name');
  name.textContent = digest.title || '我的头条';
  var date = el('div', 'reader-date');
  date.textContent = digest.date || '';
  brandText.appendChild(name);
  brandText.appendChild(date);
  brand.appendChild(logo);
  brand.appendChild(brandText);
  top.appendChild(brand);

  var actions = el('div', 'reader-actions');
  if (opts.shareUrl || typeof opts.onCopyShare === 'function') {
    var shareBtn = el('button', 'btn sm reader-share');
    shareBtn.type = 'button';
    shareBtn.textContent = '复制今日链接';
    shareBtn.title = '发朋友圈 / 微信群：粘贴链接（微信无法代发）';
    shareBtn.addEventListener('click', function () {
      if (typeof opts.onCopyShare === 'function') opts.onCopyShare(opts.shareUrl || digest.issueUrl || '');
    });
    actions.appendChild(shareBtn);
  }
  if (typeof opts.onForward === 'function') {
    var fwd = el('button', 'btn sm primary');
    fwd.type = 'button';
    fwd.textContent = '去转发';
    fwd.addEventListener('click', function () { opts.onForward(); });
    actions.appendChild(fwd);
  }
  if (actions.childNodes.length) top.appendChild(actions);
  head.appendChild(top);

  var tabsEl = el('div', 'tabs');
  tabsEl.setAttribute('role', 'tablist');
  var gridsEl = el('div', 'grids');
  head.appendChild(tabsEl);
  root.appendChild(head);
  root.appendChild(gridsEl);

  var tabs = digest.tabs;
  if (!tabs.length) {
    var empty = el('div', 'empty');
    empty.textContent = digest.reading
      ? '已选栏目下暂无近两日内容。去「选内容包」勾选已入库来源，或等日更灌池。'
      : '今天还没有选用内容。去「今日转发」挑几条，或先等智能挑选。';
    gridsEl.appendChild(empty);
    return;
  }

  tabs.forEach(function (tab) {
    var key = String(tab.key || '');
    rOrder.push(key);
    rState[key] = { tab: tab };

    var btn = el('button', 'tab');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.dataset.key = key;
    btn.style.setProperty('--tab-accent', tab.accent || '#2563eb');
    var label = el('span');
    label.textContent = tab.label || key;
    var badge = el('span', 'tab-badge');
    badge.textContent = String(tab.count || 0);
    btn.appendChild(label);
    btn.appendChild(badge);
    btn.addEventListener('click', function () {
      switchTab(key, true);
      if (typeof opts.onTab === 'function') opts.onTab(key);
    });
    tabsEl.appendChild(btn);

    var grid = el('section', 'grid');
    grid.id = 'grid-' + key;
    grid.setAttribute('role', 'tabpanel');
    grid.style.setProperty('--tab-accent', tab.accent || '#2563eb');
    var type = String(tab.type || 'text');
    if (type === 'headlines' || type === 'text') renderText(grid, tab, opts);
    else if (type === 'rank') renderRank(grid, tab);
    else renderMedia(grid, tab);
    gridsEl.appendChild(grid);
    rState[key].grid = grid;
  });

  var hash = (typeof location !== 'undefined' ? location.hash || '' : '').replace('#', '');
  var initial = tabs.some(function (t) { return String(t.key) === hash; }) ? hash : tabs[0].key;
  switchTab(initial, false);
}

/** text / headlines：紧凑列表；筛选条与来源芯片同一行。 */
function renderText(grid, tab, opts) {
  var highlights = Array.isArray(tab.highlights) ? tab.highlights : [];
  var srcSet = {};
  highlights.forEach(function (h) {
    var host = hostOf(h.url);
    if (host) srcSet[host] = 1;
  });
  var srcs = Object.keys(srcSet);
  var curSrc = '';
  var curQ = '';
  var openUrl = '';
  opts = opts || {};

  if (!highlights.length) {
    var emptyTab = el('div', 'empty');
    emptyTab.textContent = '本栏目暂无近两日内容。可在「选内容包」勾选已入库来源，或等日更灌池。';
    grid.appendChild(emptyTab);
    return;
  }

  var toolbar = el('div', 'news-toolbar');
  var curFormats = Array.isArray(opts.formats) ? opts.formats.slice() : [];

  // 格式第二轴：文章/播客/视频/Twitter/网站（多选；全不选=不限）
  var fmtBox = el('div', 'src-chips format-chips');
  fmtBox.setAttribute('aria-label', '内容格式');
  FORMAT_OPTIONS.forEach(function (f) {
    var b = el('button', 'src-chip cat-chip');
    b.type = 'button';
    b.dataset.format = f.key;
    b.textContent = f.label;
    if (curFormats.indexOf(f.key) >= 0) b.classList.add('active');
    b.addEventListener('click', function () {
      var i = curFormats.indexOf(f.key);
      if (i >= 0) curFormats.splice(i, 1);
      else curFormats.push(f.key);
      b.classList.toggle('active', curFormats.indexOf(f.key) >= 0);
      if (typeof opts.onFormatsChange === 'function') opts.onFormatsChange(curFormats.slice());
      apply();
    });
    fmtBox.appendChild(b);
  });
  toolbar.appendChild(fmtBox);

  if (srcs.length > 1) {
    var chipBox = el('div', 'src-chips');
    var all = el('button', 'src-chip active');
    all.type = 'button';
    all.textContent = '全部';
    chipBox.appendChild(all);
    srcs.forEach(function (s) {
      var b = el('button', 'src-chip');
      b.type = 'button';
      b.title = s;
      b.appendChild(favImg(s, 'src-chip-ico'));
      var lab = el('span');
      lab.textContent = s.replace(/^www\./, '');
      b.appendChild(lab);
      b.addEventListener('click', function () {
        curSrc = curSrc === s ? '' : s;
        qs('.src-chip', chipBox).forEach(function (x) { x.classList.remove('active'); });
        (curSrc ? b : all).classList.add('active');
        apply();
      });
      chipBox.appendChild(b);
    });
    all.addEventListener('click', function () {
      curSrc = '';
      qs('.src-chip', chipBox).forEach(function (x) { x.classList.remove('active'); });
      all.classList.add('active');
      apply();
    });
    toolbar.appendChild(chipBox);
  }

  var row = el('div', 'news-search-row');
  var input = el('input', 'news-search-input');
  input.type = 'text';
  input.placeholder = '筛选';
  input.setAttribute('aria-label', '搜索本栏目');
  var clear = el('button', 'news-search-clear');
  clear.type = 'button';
  clear.textContent = '✕';
  clear.hidden = true;
  var count = el('span', 'news-search-count');
  input.addEventListener('input', function () {
    curQ = input.value.trim().toLowerCase();
    clear.hidden = !curQ;
    apply();
  });
  clear.addEventListener('click', function () {
    input.value = '';
    curQ = '';
    clear.hidden = true;
    apply();
    input.focus();
  });
  row.appendChild(input);
  row.appendChild(clear);
  row.appendChild(count);
  toolbar.appendChild(row);
  grid.appendChild(toolbar);

  var list = el('div', 'news-list');
  grid.appendChild(list);

  function noteLine(h) {
    var title = String(h.title || '').trim();
    var note = cleanSummary(h.note || '', title);
    if (note.length > 88) note = note.slice(0, 88) + '…';
    return note;
  }

  function apply() {
    var items = highlights.filter(function (h) {
      if (!itemMatchesFormats(h, curFormats)) return false;
      if (curSrc && hostOf(h.url) !== curSrc) return false;
      if (curQ && ((h.title || '') + (h.note || '') + hostOf(h.url)).toLowerCase().indexOf(curQ) < 0) return false;
      return true;
    });
    count.textContent = items.length + '/' + highlights.length;
    list.innerHTML = '';
    if (!items.length) {
      var none = el('div', 'empty');
      none.textContent = '当前筛选没有内容。';
      list.appendChild(none);
      return;
    }
    items.forEach(function (h) {
      var wrap = el('div', 'news-item');
      var item = el('div', 'news-row');
      var href = safeHref(h.url);
      var host = hostOf(h.url);
      if (href && openUrl === href) wrap.classList.add('is-open');

      var thumb = el('div', 'news-thumb');
      var imgHref = safeHref(h.image);
      if (imgHref) {
        var cover = document.createElement('img');
        cover.className = 'news-cover';
        cover.src = imgHref;
        cover.alt = '';
        cover.loading = 'lazy';
        cover.referrerPolicy = 'no-referrer';
        cover.onerror = function () {
          thumb.innerHTML = '';
          thumb.classList.add('ico-only');
          thumb.appendChild(favImg(host, 'news-fav lg'));
        };
        thumb.appendChild(cover);
        var badge = el('span', 'news-src-badge');
        badge.appendChild(favImg(host, 'news-fav'));
        thumb.appendChild(badge);
      } else {
        thumb.classList.add('ico-only');
        thumb.appendChild(favImg(host, 'news-fav lg'));
      }
      item.appendChild(thumb);

      var body = el('div', 'news-body');
      var title = el('div', 'news-title');
      if (href) {
        var a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = h.title || '(无标题)';
        a.addEventListener('click', function (e) { e.stopPropagation(); });
        title.appendChild(a);
      } else {
        title.textContent = h.title || '(无标题)';
      }
      body.appendChild(title);
      var note = noteLine(h);
      if (note) {
        var meta = el('div', 'news-meta');
        meta.textContent = note;
        body.appendChild(meta);
      }
      item.appendChild(body);

      if (opts.enableFulltext && href) {
        var ftBtn = el('button', 'news-ft-btn');
        ftBtn.type = 'button';
        ftBtn.textContent = openUrl === href ? '收起' : '原文';
        ftBtn.title = '按需抽取正文，不入库';
        ftBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openUrl = openUrl === href ? '' : href;
          apply();
        });
        item.appendChild(ftBtn);
      }

      wrap.appendChild(item);

      if (opts.enableFulltext && href && openUrl === href) {
        var pane = el('div', 'news-fulltext');
        var loading = el('div', 'news-ft-loading');
        loading.textContent = '正在抽取正文…';
        pane.appendChild(loading);
        wrap.appendChild(pane);
        fetchFullText(href, opts.fulltextEndpoint).then(function (out) {
          if (openUrl !== href) return;
          pane.innerHTML = '';
          if (!out.ok) {
            var err = el('div', 'news-ft-err');
            err.textContent = out.error || '全文失败';
            pane.appendChild(err);
            var go = document.createElement('a');
            go.className = 'news-ft-link';
            go.href = href;
            go.target = '_blank';
            go.rel = 'noopener';
            go.textContent = '打开原文';
            pane.appendChild(go);
            return;
          }
          var head = el('div', 'news-ft-head');
          var headLeft = el('div', 'news-ft-source');
          headLeft.appendChild(favImg(host, 'news-fav'));
          var headMeta = el('div', 'news-ft-source-text');
          var hostEl = el('div', 'news-ft-host');
          hostEl.textContent = host || '来源';
          var sub = el('div', 'news-ft-sub');
          sub.textContent = out.chars + ' 字 · 仅本次阅读，不入库';
          headMeta.appendChild(hostEl);
          headMeta.appendChild(sub);
          headLeft.appendChild(headMeta);
          head.appendChild(headLeft);
          var hTitle = el('h3', 'news-ft-title');
          hTitle.textContent = out.title || h.title || '';
          var pre = el('div', 'news-ft-body');
          fillReadingBody(pre, out.text || '', out.html || '');
          var foot = el('div', 'news-ft-foot');
          var src = document.createElement('a');
          src.className = 'news-ft-link';
          src.href = href;
          src.target = '_blank';
          src.rel = 'noopener';
          src.textContent = '在来源站阅读 →';
          foot.appendChild(src);
          pane.appendChild(head);
          pane.appendChild(hTitle);
          pane.appendChild(pre);
          pane.appendChild(foot);
        });
      }

      list.appendChild(wrap);
    });
  }
  apply();
}

/** rank：榜单，带序号；封面是外站热链时单独占位，不占本站连接。 */
function renderRank(grid, tab) {
  var list = el('div', 'rank-list');
  var highlights = Array.isArray(tab.highlights) ? tab.highlights : [];
  if (!highlights.length) {
    var none = el('div', 'empty');
    none.textContent = '本栏目今天还没有选用内容。';
    grid.appendChild(none);
    return;
  }
  highlights.forEach(function (h, i) {
    var row = el('div', 'rank-row');
    var no = el('div', 'rank-no' + (i < 3 ? ' top' : ''));
    no.textContent = String(i + 1);
    var href = safeHref(h.url);
    var host = hostOf(h.url);
    var ico = el('div', 'rank-ico');
    ico.appendChild(favImg(host, 'news-fav'));
    var body = el('div', 'rank-title');
    if (href) {
      var a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = h.title || '(无标题)';
      body.appendChild(a);
    } else {
      body.textContent = h.title || '(无标题)';
    }
    row.appendChild(no);
    row.appendChild(ico);
    row.appendChild(body);
    list.appendChild(row);
  });
  grid.appendChild(list);
}

/** 见笑/见她整期 → 展成无标题图格；普通 media 仍一卡一图。 */
function expandMediaCells(highlights) {
  var out = [];
  (highlights || []).forEach(function (h) {
    var imgs = Array.isArray(h.images) && h.images.length ? h.images : null;
    var href = safeHref(h.url);
    if (!imgs) {
      out.push({
        title: h.title || '',
        url: href,
        img: safeHref(h.thumb) || safeHref(h.full) || safeHref(h.image),
      });
      return;
    }
    imgs.forEach(function (im) {
      var src = safeHref(im.thumb) || safeHref(im.full) || safeHref(im.url);
      if (!src) return;
      out.push({ title: '', url: href, img: src, full: safeHref(im.full) || src });
    });
  });
  return out;
}

/** media：图片格；整期图墙无分条标题。 */
function renderMedia(grid, tab) {
  var box = el('div', 'photo-grid');
  var cells = expandMediaCells(Array.isArray(tab.highlights) ? tab.highlights : []);
  if (!cells.length) {
    var none = el('div', 'empty');
    none.textContent = '本栏目今天还没有选用内容。';
    grid.appendChild(none);
    return;
  }
  cells.forEach(function (cell) {
    var card = el('div', 'photo');
    var inner = el('div', 'photo-inner');
    if (cell.img) {
      var img = document.createElement('img');
      img.src = cell.img;
      img.alt = cell.title || '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      inner.appendChild(img);
    } else {
      var tag = el('span');
      tag.textContent = '索引卡';
      inner.appendChild(tag);
    }
    if (cell.title) {
      var cap = el('div', 'photo-cap');
      cap.textContent = cell.title;
      inner.appendChild(cap);
    }
    card.appendChild(inner);
    var openUrl = cell.full || cell.url;
    if (openUrl) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', function () {
        window.open(openUrl, '_blank', 'noopener');
      });
    }
    box.appendChild(card);
  });
  grid.appendChild(box);
}

function hostOf(url) {
  var href = safeHref(url);
  if (!href) return '';
  var m = /^https?:\/\/([^\/]+)/i.exec(href);
  return m ? m[1].replace(/^www\./, '') : '';
}

/** 网易云 song id（官方外链播放器用） */
function neteaseSongId(url) {
  var href = safeHref(url) || String(url || '');
  if (!/music\.163\.com/i.test(href)) return '';
  var m = /[?&]id=(\d+)/i.exec(href) || /\/song\/(\d+)/i.exec(href);
  return m ? m[1] : '';
}

/** 网易云内嵌试听：官方 outchain + audio 兜底（点开即播，不走「加载正文」） */
function appendNeteasePlayer(host, songId, autoplay) {
  if (!host || !songId) return;
  var box = el('div', 'netease-player');
  var iframe = document.createElement('iframe');
  iframe.className = 'netease-embed';
  // 对齐官方嵌入尺寸；auto=1 点开即播
  iframe.src = 'https://music.163.com/outchain/player?type=2&id=' + encodeURIComponent(songId)
    + '&auto=' + (autoplay ? '1' : '0') + '&height=66';
  iframe.width = '330';
  iframe.height = '86';
  iframe.title = '网易云试听';
  iframe.setAttribute('frameborder', 'no');
  iframe.setAttribute('border', '0');
  iframe.setAttribute('allow', 'autoplay; encrypted-media');
  iframe.setAttribute('scrolling', 'no');
  box.appendChild(iframe);

  // 部分免费曲仍可走 outer mp3；失败则藏掉
  var audio = document.createElement('audio');
  audio.className = 'netease-audio';
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = 'https://music.163.com/song/media/outer/url?id=' + encodeURIComponent(songId) + '.mp3';
  audio.addEventListener('error', function () { audio.hidden = true; });
  if (autoplay) {
    audio.addEventListener('loadeddata', function () {
      try { audio.play().catch(function () {}); } catch (_) { /* autoplay 可能被拦 */ }
    });
  }
  box.appendChild(audio);
  host.appendChild(box);
}

/** 来源 favicon（热链，不转存）；失败退字母。 */
function favImg(host, cls) {
  var url = host ? sourceIconUrl(host) : '';
  if (!url) {
    var ph = el('span', (cls || 'news-fav') + ' ph');
    ph.textContent = (host || '源').slice(0, 1);
    return ph;
  }
  var img = document.createElement('img');
  img.className = cls || 'news-fav';
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.width = 16;
  img.height = 16;
  img.onerror = function () {
    var s = el('span', (cls || 'news-fav') + ' ph');
    s.textContent = (host || '源').slice(0, 1);
    if (img.parentNode) img.parentNode.replaceChild(s, img);
  };
  return img;
}

/**
 * Inoreader Column 视图：侧栏（全部 / 文件夹 / 源）· 列表 · 阅读面板。
 * 吃 buildReadingDigest 的 tabs[].highlights[]（含 columnKey/source/publishedAt）。
 */
export function renderInoReader(root, digest, opts) {
  if (!root) throw new Error('renderInoReader 需要容器元素');
  if (!digest || !Array.isArray(digest.tabs)) throw new Error('renderInoReader 需要含 tabs[] 的 digest');
  opts = opts || {};
  var enableFt = opts.enableFulltext !== false;
  var filterFolder = '';
  var filterSource = '';
  var filterMedia = '';
  var filterPlatform = '';
  var filterTopic = '';
  var dimTab = 'media'; // media | platform | topic
  var query = '';
  var selectedUrl = '';
  var readSet = Object.create(null);
  var ftCache = Object.create(null);
  var ftLoading = '';

  var flat = [];
  digest.tabs.forEach(function (tab) {
    (tab.highlights || []).forEach(function (h) {
      var row = {
        title: h.title,
        url: h.url,
        note: h.note,
        image: h.image || h.thumb || null,
        thumb: h.thumb || h.image || null,
        full: h.full || h.image || null,
        // 整期图墙字段必须带上，否则右侧只剩封面一张
        images: Array.isArray(h.images) ? h.images : null,
        issueKind: h.issueKind || null,
        issueDate: h.issueDate || null,
        source: h.source || null,
        name: h.source || null,
        publishedAt: h.publishedAt || null,
        contentType: h.contentType || 'article',
        columnKey: h.columnKey || tab.key,
        columnLabel: h.columnLabel || tab.label,
      };
      row.mediaKey = sourceMediaKey(row);
      row.platformKey = sourcePlatformKey(row);
      row.topicKey = sourceTopicKey(row);
      flat.push(row);
    });
  });
  flat.sort(function (a, b) {
    return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
  });

  function sourceKey(h) {
    return String(h.source || hostOf(h.url) || '未知来源');
  }

  function matchDims(h) {
    if (filterMedia && h.mediaKey !== filterMedia) return false;
    if (filterPlatform && h.platformKey !== filterPlatform) return false;
    if (filterTopic && h.topicKey !== filterTopic) return false;
    return true;
  }

  function timeLabel(iso) {
    if (!iso) return '';
    var t = Date.parse(String(iso));
    if (!Number.isFinite(t)) return String(iso).slice(0, 16);
    var d = new Date(t);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (sameDay) return p(d.getHours()) + ':' + p(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function filtered() {
    return flat.filter(function (h) {
      if (!matchDims(h)) return false;
      if (filterFolder && h.columnKey !== filterFolder) return false;
      if (filterSource && sourceKey(h) !== filterSource) return false;
      if (query) {
        var hay = ((h.title || '') + ' ' + (h.note || '') + ' ' + sourceKey(h)).toLowerCase();
        if (hay.indexOf(query) < 0) return false;
      }
      return true;
    });
  }

  function folderTree() {
    var map = Object.create(null);
    flat.forEach(function (h) {
      if (!matchDims(h)) return;
      var fk = h.columnKey || '_';
      if (!map[fk]) map[fk] = { key: fk, label: h.columnLabel || fk, count: 0, feeds: Object.create(null) };
      map[fk].count += 1;
      var sk = sourceKey(h);
      if (!map[fk].feeds[sk]) map[fk].feeds[sk] = { name: sk, count: 0, url: h.url };
      map[fk].feeds[sk].count += 1;
    });
    return digest.tabs.map(function (t) {
      return map[t.key] || { key: t.key, label: t.label, count: 0, feeds: Object.create(null) };
    }).filter(function (f) { return f.count > 0 || !flat.length; });
  }

  root.innerHTML = '';
  root.classList.add('ino');
  var shell = el('div', 'ino-reader');
  var side = el('aside', 'ino-side');
  var listCol = el('section', 'ino-list');
  var pane = el('section', 'ino-pane');
  shell.appendChild(side);
  shell.appendChild(listCol);
  shell.appendChild(pane);
  root.appendChild(shell);

  var sideHead = el('div', 'ino-side-head');
  var sideTitle = el('h2');
  sideTitle.textContent = '已选源';
  var sideSub = el('div', 'sub');
  sideSub.textContent = digest.platformName ? digest.platformName + ' · 近两日' : '近两日汇总';
  sideHead.appendChild(sideTitle);
  sideHead.appendChild(sideSub);
  var search = document.createElement('input');
  search.className = 'ino-search folo-search';
  search.type = 'search';
  search.placeholder = '搜索标题 / 来源';
  search.setAttribute('aria-label', '搜索标题或来源');
  search.addEventListener('input', function () {
    query = String(search.value || '').trim().toLowerCase();
    paintBody();
  });
  sideHead.appendChild(search);
  var dimTabs = el('div', 'ino-subtabs folo-subtabs');
  dimTabs.setAttribute('role', 'tablist');
  dimTabs.setAttribute('aria-label', '筛选维度');
  [['media', '分类'], ['platform', '平台'], ['topic', '来源']].forEach(function (pair) {
    var b = el('button', 'folo-subtab');
    b.type = 'button';
    b.setAttribute('data-dim', pair[0]);
    b.setAttribute('role', 'tab');
    b.textContent = pair[1];
    b.addEventListener('click', function () {
      if (dimTab === pair[0]) return;
      dimTab = pair[0];
      paint();
    });
    dimTabs.appendChild(b);
  });
  sideHead.appendChild(dimTabs);
  var dimChips = el('div', 'ino-dim-chips folo-chips');
  dimChips.setAttribute('aria-label', '子标签');
  sideHead.appendChild(dimChips);
  var dimActive = el('div', 'ino-active-filters folo-active-filters');
  dimActive.hidden = true;
  sideHead.appendChild(dimActive);
  side.appendChild(sideHead);
  var sideList = el('div', 'ino-side-list');
  side.appendChild(sideList);

  var listHead = el('div', 'ino-list-head');
  var headTitleRow = el('div', 'row');
  var headH2 = el('h2');
  headH2.textContent = '全部条目';
  var headSub = el('span', 'sub');
  headTitleRow.appendChild(headH2);
  headTitleRow.appendChild(headSub);
  listHead.appendChild(headTitleRow);
  listCol.appendChild(listHead);
  var listBody = el('div', 'ino-list-body');
  listCol.appendChild(listBody);

  function setFilter(folder, source) {
    filterFolder = folder || '';
    filterSource = source || '';
    if (!filtered().some(function (h) { return safeHref(h.url) === selectedUrl; })) {
      selectedUrl = '';
    }
    paint();
  }

  function openItem(h) {
    var href = safeHref(h.url);
    if (!href) return;
    selectedUrl = href;
    readSet[href] = true;
    paintBody();
  }

  function loadFull(href) {
    if (!enableFt || !href) return;
    if (ftCache[href]) {
      paintPane(filtered());
      return;
    }
    ftLoading = href;
    paintPane(filtered());
    fetchFullText(href, opts.fulltextEndpoint).then(function (out) {
      ftCache[href] = out;
      if (ftLoading === href) ftLoading = '';
      if (selectedUrl === href) paintPane(filtered());
    });
  }

  function paintSide(items) {
    sideList.innerHTML = '';
    var allBtn = el('button', 'ino-nav' + (!filterFolder && !filterSource ? ' on' : ''));
    allBtn.type = 'button';
    allBtn.appendChild(document.createTextNode('全部条目'));
    var allN = el('span', 'n');
    allN.textContent = String(flat.filter(matchDims).length);
    allBtn.appendChild(allN);
    allBtn.addEventListener('click', function () { setFilter('', ''); });
    sideList.appendChild(allBtn);

    folderTree().forEach(function (folder) {
      var box = el('div', 'ino-folder');
      var hd = el('button', 'ino-folder-hd' + (filterFolder === folder.key && !filterSource ? ' on' : ''));
      hd.type = 'button';
      hd.appendChild(document.createTextNode(folder.label));
      var fn = el('span', 'n');
      fn.textContent = String(folder.count);
      hd.appendChild(fn);
      hd.addEventListener('click', function () { setFilter(folder.key, ''); });
      box.appendChild(hd);

      Object.keys(folder.feeds).sort(function (a, b) {
        return folder.feeds[b].count - folder.feeds[a].count || a.localeCompare(b);
      }).forEach(function (sk) {
        var feed = folder.feeds[sk];
        var on = filterFolder === folder.key && filterSource === sk;
        var btn = el('button', 'ino-feed' + (on ? ' on' : ''));
        btn.type = 'button';
        btn.appendChild(favImg(hostOf(feed.url) || sk, 'news-fav'));
        var nm = el('span', 'nm');
        nm.textContent = feed.name;
        btn.appendChild(nm);
        var n = el('span', 'n');
        n.textContent = String(feed.count);
        btn.appendChild(n);
        btn.addEventListener('click', function () { setFilter(folder.key, sk); });
        box.appendChild(btn);
      });
      sideList.appendChild(box);
    });
  }

  function paintDimFilters() {
    qs('.folo-subtab', dimTabs).forEach(function (b) {
      var on = b.getAttribute('data-dim') === dimTab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    // 计数：有货高亮，无货仍展示（与全部源选项集对齐，不因近两日样本缩芯片）
    var countMedia = Object.create(null);
    var countPlatform = Object.create(null);
    var countTopic = Object.create(null);
    flat.forEach(function (h) {
      countMedia[h.mediaKey] = (countMedia[h.mediaKey] || 0) + 1;
      countPlatform[h.platformKey] = (countPlatform[h.platformKey] || 0) + 1;
      if (h.topicKey) countTopic[h.topicKey] = (countTopic[h.topicKey] || 0) + 1;
    });

    dimChips.innerHTML = '';
    function addChip(key, label, iconUrl, glyph, current, setFn, n, mark) {
      var on = current === key;
      var empty = !(n > 0);
      var chip = el('button', 'src-chip' + (on ? ' active' : '') + (empty ? ' is-empty' : ''));
      chip.type = 'button';
      chip.title = empty ? (label + '（近两日暂无）') : (label + ' · ' + n);
      var mk = markSpan(mark);
      if (mk) chip.appendChild(mk);
      else if (iconUrl) {
        var img = document.createElement('img');
        img.src = iconUrl;
        img.alt = '';
        img.width = 14;
        img.height = 14;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        chip.appendChild(img);
      } else if (glyph) {
        var g = el('span', 'chip-ico');
        g.textContent = glyph;
        chip.appendChild(g);
      }
      chip.appendChild(document.createTextNode(label));
      chip.addEventListener('click', function () {
        setFn(current === key ? '' : key);
        paint();
      });
      dimChips.appendChild(chip);
    }
    var allChip = el('button', 'src-chip' + (
      (dimTab === 'media' && !filterMedia) ||
      (dimTab === 'platform' && !filterPlatform) ||
      (dimTab === 'topic' && !filterTopic)
        ? ' active' : ''
    ));
    allChip.type = 'button';
    allChip.textContent = '全部';
    allChip.addEventListener('click', function () {
      if (dimTab === 'media') filterMedia = '';
      else if (dimTab === 'platform') filterPlatform = '';
      else filterTopic = '';
      paint();
    });
    dimChips.appendChild(allChip);

    if (dimTab === 'media') {
      SRC_MEDIA_CHIPS.forEach(function (c) {
        addChip(c.key, c.label, '', c.glyph, filterMedia, function (k) { filterMedia = k; }, countMedia[c.key] || 0, null);
      });
    } else if (dimTab === 'platform') {
      SRC_PLATFORM_CHIPS.forEach(function (c) {
        addChip(c.key, c.label, '', '', filterPlatform, function (k) { filterPlatform = k; }, countPlatform[c.key] || 0, c.mark || null);
      });
    } else {
      NEWS_CHIPS.forEach(function (c) {
        var icon = c.key === 'hot' ? '' : sourceIconUrl(TOPIC_CHIP_ICON[c.key] || 'wikipedia.org');
        addChip(c.key, c.label, icon, c.key === 'hot' ? '热' : '', filterTopic, function (k) { filterTopic = k; }, countTopic[c.key] || 0, null);
      });
    }

    var pills = [];
    if (filterMedia) {
      var mc = SRC_MEDIA_CHIPS.find(function (x) { return x.key === filterMedia; });
      pills.push({ dim: 'media', label: '分类·' + ((mc && mc.label) || filterMedia) });
    }
    if (filterPlatform) {
      var pc = SRC_PLATFORM_CHIPS.find(function (x) { return x.key === filterPlatform; });
      pills.push({ dim: 'platform', label: '平台·' + ((pc && pc.label) || filterPlatform) });
    }
    if (filterTopic) {
      var tc = NEWS_CHIPS.find(function (x) { return x.key === filterTopic; });
      pills.push({ dim: 'topic', label: '来源·' + ((tc && tc.label) || filterTopic) });
    }
    dimActive.hidden = pills.length === 0;
    dimActive.innerHTML = '';
    pills.forEach(function (p) {
      var span = el('span', 'af');
      span.appendChild(document.createTextNode(p.label));
      var x = el('button');
      x.type = 'button';
      x.setAttribute('data-clear', p.dim);
      x.setAttribute('aria-label', '清除');
      x.textContent = '×';
      x.addEventListener('click', function () {
        if (p.dim === 'media') filterMedia = '';
        if (p.dim === 'platform') filterPlatform = '';
        if (p.dim === 'topic') filterTopic = '';
        paint();
      });
      span.appendChild(x);
      dimActive.appendChild(span);
    });
  }

  function paintHead(items) {
    if (filterSource) headH2.textContent = filterSource;
    else if (filterFolder) {
      var tab = digest.tabs.find(function (t) { return t.key === filterFolder; });
      headH2.textContent = (tab && tab.label) || filterFolder;
    } else headH2.textContent = '全部条目';
    headSub.textContent = items.length + ' 条';
  }

  function paintList(items) {
    listBody.innerHTML = '';
    if (!items.length) {
      var none = el('div', 'empty');
      none.style.padding = '24px 16px';
      none.textContent = flat.length
        ? '当前筛选没有内容。'
        : (digest.summary || '已选栏目下暂无近两日内容。');
      listBody.appendChild(none);
      return;
    }
    items.forEach(function (h) {
      var href = safeHref(h.url);
      var isOn = href && href === selectedUrl;
      var isRead = href && readSet[href];
      var row = el('button', 'ino-row' + (isOn ? ' on' : '') + (isRead && !isOn ? ' read' : ''));
      row.type = 'button';
      var dot = el('span', 'dot');
      row.appendChild(dot);
      var body = el('div');
      var ti = el('div', 'ti');
      ti.textContent = h.title || '(无标题)';
      body.appendChild(ti);
      var meta = el('div', 'meta');
      var pub = el('span', 'pub');
      pub.appendChild(favImg(hostOf(h.url), 'news-fav'));
      pub.appendChild(document.createTextNode(sourceKey(h)));
      meta.appendChild(pub);
      if (h.columnLabel) {
        var col = el('span');
        col.textContent = h.columnLabel;
        meta.appendChild(col);
      }
      var tm = timeLabel(h.publishedAt);
      if (tm) {
        var tEl = el('span');
        tEl.textContent = tm;
        meta.appendChild(tEl);
      }
      body.appendChild(meta);
      row.appendChild(body);
      row.addEventListener('click', function () { openItem(h); });
      listBody.appendChild(row);
    });
  }

  function paintPane(items) {
    pane.innerHTML = '';
    var cur = items.find(function (h) { return safeHref(h.url) === selectedUrl; });
    if (!cur) {
      var empty = el('div', 'ino-pane-empty');
      empty.textContent = items.length ? '从左侧列表点开一条阅读' : '暂无条目';
      pane.appendChild(empty);
      return;
    }
    // 整期图墙：打开原站 tab（canonical 用 ?pack= 去重，展示仍跳 #jianxiao）
    var rawUrl = safeHref(cur.url);
    var songId = neteaseSongId(rawUrl || cur.url);
    var isMusic = !!songId;
    var href = rawUrl;
    if (!isMusic && cur.issueKind && cur.issueDate && href) {
      try {
        var origin = new URL(href).origin;
        href = origin + '/' + cur.issueDate + '/#' + cur.issueKind;
      } catch (_) { /* keep href */ }
    }
    var gallery = Array.isArray(cur.images) && cur.images.length ? cur.images : null;
    var out = !isMusic && !gallery && href && ftCache[href] && ftCache[href].ok ? ftCache[href] : null;
    var loading = !isMusic && !gallery && href && ftLoading === href && !out;
    // 推文类：已有较长摘要时先当短正文，避免必点 API
    var localNote = cleanSummary(cur.note || '', cur.title, {
      url: href,
      publisher: sourceKey(cur),
    });
    var shortform =
      !isMusic &&
      !gallery &&
      !out &&
      !loading &&
      isTwitterLikeUrl(href, sourceKey(cur)) &&
      localNote &&
      localNote.length >= 120;
    var reading = !!(out || shortform);
    var art = el('article', 'ino-article' + (reading ? ' is-reading' : ''));
    var wrap = el('div', reading ? 'sr-wrap' : 'ino-peek');

    var eye = el('div', 'eyebrow');
    var pub = el('span', 'pub');
    pub.appendChild(favImg(hostOf(rawUrl || href), 'news-fav'));
    pub.appendChild(document.createTextNode(sourceKey(cur)));
    eye.appendChild(pub);
    if (cur.columnLabel) {
      var col = el('span');
      col.textContent = cur.columnLabel;
      eye.appendChild(col);
    }
    var tm = timeLabel(cur.publishedAt);
    if (tm) {
      var tEl = el('span');
      tEl.textContent = tm;
      eye.appendChild(tEl);
    }
    if (isMusic) {
      var metaMusic = el('span');
      metaMusic.textContent = '在线试听';
      eye.appendChild(metaMusic);
    } else if (gallery) {
      var metaGal = el('span');
      metaGal.textContent = gallery.length + ' 张 · 整期精选';
      eye.appendChild(metaGal);
    } else if (out) {
      var meta = el('span');
      meta.textContent = (out.chars || 0) + ' 字 · 约 ' + readingMinutes(out.chars) + ' 分钟';
      eye.appendChild(meta);
    } else if (shortform) {
      var metaLocal = el('span');
      metaLocal.textContent = localNote.length + ' 字 · 摘要正文';
      eye.appendChild(metaLocal);
    }
    wrap.appendChild(eye);

    var title = el('h1');
    title.textContent = (out && out.title) || cur.title || '(无标题)';
    wrap.appendChild(title);

    var actions = el('div', 'actions');
    if (href) {
      var go = document.createElement('a');
      go.className = 'btn sm' + (isMusic || reading || gallery ? '' : ' primary');
      go.href = isMusic ? ('https://music.163.com/#/song?id=' + songId) : href;
      go.target = '_blank';
      go.rel = 'noopener';
      go.textContent = gallery ? '打开原站本期' : (isMusic ? '打开网易云' : '打开原文');
      actions.appendChild(go);
    }
    // 网易云不抽正文：点开即播
    if (enableFt && href && !gallery && !isMusic) {
      var ftBtn = el('button', 'btn sm' + (reading && !shortform ? '' : ' primary'));
      ftBtn.type = 'button';
      ftBtn.textContent = out
        ? '重新抽取'
        : (loading ? '抽取中…' : (shortform ? '刷新正文' : '加载正文'));
      ftBtn.disabled = !!loading;
      ftBtn.title = '按需抽取正文，不入库';
      ftBtn.addEventListener('click', function () {
        delete ftCache[href];
        loadFull(href);
      });
      actions.appendChild(ftBtn);
    }
    wrap.appendChild(actions);

    if (isMusic) {
      var imgHref = safeHref(cur.image);
      if (imgHref) {
        var cover = document.createElement('img');
        cover.className = 'cover';
        cover.src = imgHref;
        cover.alt = '';
        cover.loading = 'lazy';
        cover.referrerPolicy = 'no-referrer';
        cover.onerror = function () { cover.remove(); };
        wrap.appendChild(cover);
      }
      appendNeteasePlayer(wrap, songId, true);
      if (localNote) {
        var sumMusic = el('div', 'sum');
        sumMusic.textContent = localNote;
        wrap.appendChild(sumMusic);
      }
    } else if (gallery) {
      var gbox = el('div', 'photo-grid ino-issue-grid');
      gallery.forEach(function (im) {
        var src = safeHref(im.thumb) || safeHref(im.full) || safeHref(im.url);
        if (!src) return;
        var card = el('div', 'photo');
        var inner = el('div', 'photo-inner');
        var img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        inner.appendChild(img);
        card.appendChild(inner);
        var open = safeHref(im.full) || src;
        card.style.cursor = 'pointer';
        card.addEventListener('click', function () {
          window.open(open, '_blank', 'noopener');
        });
        gbox.appendChild(card);
      });
      wrap.appendChild(gbox);
    } else if (out) {
      var body = el('div');
      fillReadingBody(body, out.text || '', out.html || '');
      wrap.appendChild(body);
    } else if (shortform) {
      var bodyLocal = el('div');
      fillReadingBody(bodyLocal, localNote, '');
      wrap.appendChild(bodyLocal);
    } else {
      var imgHref2 = safeHref(cur.image);
      if (imgHref2) {
        var cover2 = document.createElement('img');
        cover2.className = 'cover';
        cover2.src = imgHref2;
        cover2.alt = '';
        cover2.loading = 'lazy';
        cover2.referrerPolicy = 'no-referrer';
        cover2.onerror = function () { cover2.remove(); };
        wrap.appendChild(cover2);
      }
      if (localNote) {
        var sum = el('div', 'sum');
        sum.textContent = localNote;
        wrap.appendChild(sum);
      }
      if (loading) {
        var wait = el('div', 'news-ft-loading');
        wait.textContent = '正在抽取正文…';
        wrap.appendChild(wait);
      } else if (href && ftCache[href] && !ftCache[href].ok) {
        var err = el('div', 'news-ft-err');
        err.textContent = ftCache[href].error || '全文失败';
        wrap.appendChild(err);
      }
    }

    art.appendChild(wrap);
    pane.appendChild(art);
  }

  function paintBody() {
    var items = filtered();
    paintList(items);
    paintPane(items);
    headSub.textContent = items.length + ' 条';
  }

  function paint() {
    var items = filtered();
    paintDimFilters();
    paintSide(items);
    paintHead(items);
    paintList(items);
    paintPane(items);
  }

  paint();
}

/** 页面级 hashchange 只需绑定一次；由宿主在初始化时调用。 */
export function bindHashRouting() {
  if (bindHashRouting._bound) return;
  bindHashRouting._bound = true;
  window.addEventListener('hashchange', function () {
    var hash = (location.hash || '').replace('#', '');
    if (hash && rState[hash] && hash !== rActive) switchTab(hash, false);
  });
}
