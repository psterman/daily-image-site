/* 定时任务台的前端：3 秒轮询 /api/state，重绘。 */
'use strict';

const $ = (id) => document.getElementById(id);
let last = null;
let lastStepSig = '';

/** 不可逆动作的确认文案 —— 写不清不可逆性 = 不许发出去。 */
const CONFIRM = {
  runNow: {
    title: '立刻重跑今天这一期？',
    body: '立刻重跑今天的完整流程（抓图 → 头条 → 清洗 → 构建 → 上传 R2 → 部署 Pages）。\n' +
          '线上首页会立刻变成今天这一期。\n' +
          '撤回要等 24 小时边缘缓存，发出去的链接收不回来。',
    ok: '确认跑一次',
  },
  republish: {
    title: '补发某一天？',
    body: (d) => '补发 ' + d + '：重新构建并部署那一期。\n' +
          '线上首页会重新指向 ' + d + '；这一期之后的日期会下线，直到你再发一次新期。\n' +
          '撤回要等 24 小时边缘缓存。',
    ok: '确认补发',
  },
};

/**
 * 耗时：没有数值就显示「—」。
 * ⚠️ 不是装饰 —— 11-16~11-20 的真实日志是 Task 1 加时间戳**之前**跑的，
 *    `durationMs` 全是 null。显示 "NaN" 或 "null" 就是露怯。
 */
function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return h + ' 时 ' + m + ' 分';
  if (m) return m + ' 分 ' + s + ' 秒';
  return s + ' 秒';
}

/**
 * 时刻：**按北京时间显示**。
 * ⚠️ 不能用 toLocaleTimeString() 的本地时区 —— 浏览器在别的时区时会错位，
 *    而整站的时基是北京时间（spec §5.4 / Get-BjNow）。
 */
function fmtAt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 19);
  }
}

const GROUP_LABEL = { prepare: '准备', verify: '校验与审稿', publish: '发布' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 阶段点。签名没变就不重画 —— 否则每 3 秒重建 DOM，点一下就闪。 */
function renderSteps(steps) {
  const sig = steps.map((s) => s.key + ':' + s.status).join('|');
  if (sig === lastStepSig) return;
  lastStepSig = sig;

  const groups = [];
  for (const s of steps) {
    let g = groups.find((x) => x.key === s.group);
    if (!g) { g = { key: s.group, label: GROUP_LABEL[s.group] || s.group, items: [] }; groups.push(g); }
    g.items.push(s);
  }
  $('steps').innerHTML = groups.map((g) =>
    '<div class="group"><div class="group-name">' + g.label + '（' + g.items.length + '）</div>' +
    '<div class="dots">' + g.items.map((s, i) =>
      '<button class="dot ' + (s.status || 'pending') + '" data-g="' + esc(g.key) +
      '" data-i="' + i + '" title="' + esc(s.label) + '"></button>').join('') +
    '</div><div class="labels">' + g.items.map((s) =>
      '<span>' + esc(s.label.replace(/（.*?）/g, '').slice(0, 6)) + '</span>').join('') +
    '</div></div>').join('');

  /* 阶段点可点：点一下展开那一步的日志尾部（spec §8.1）。 */
  for (const el of document.querySelectorAll('#steps .dot')) {
    el.addEventListener('click', () => {
      const g = groups.find((x) => x.key === el.getAttribute('data-g'));
      const item = g && g.items[Number(el.getAttribute('data-i'))];
      if (item) openStep(item);
    });
  }
}

/**
 * 点开某一步：取那一天的日志尾部，切出这一步的那一段。
 * 日志标记是 `=== 1/5 抓图 + 目录分流 ===`，step 的 label 与它**逐字对得上**。
 */
async function openStep(step) {
  const d = (last && last.current && last.current.date) || '';
  if (!d) return;
  $('logBox').classList.remove('hidden');
  $('logTitle').textContent = step.label + ' · ' + d;
  $('logBody').textContent = '读取中…';
  try {
    const r = await fetch('/api/log?date=' + encodeURIComponent(d), { cache: 'no-store' });
    const j = await r.json();
    const lines = (j && Array.isArray(j.lines)) ? j.lines : [];
    const seg = sliceStep(lines, step);
    if (seg.length) {
      $('logBody').textContent = seg.join('\n');
    } else if (lines.length) {
      /* ⚠️ **诚实降级**：这一步的标记不在接口返回的那 120 行里。
         /api/log 按契约只返回**最后 120 行**（spec §7.2「尾部 120 行」），
         而 11-20 的日志有 1274 行 —— 16 个阶段标记里有 **11 个在窗口外**。
         这里**不许**假装有内容，也不许把整个尾巴糊上去冒充「这一步的日志」——
         那会让人以为看到了这一步，其实看到的是别的步骤。
         直接说清楚在哪：完整日志在磁盘上的哪个文件。 */
      $('logBody').textContent =
        '这一步的日志不在保留的尾部里（/api/log 只返回最后 120 行）。\n' +
        '完整日志：' + (last && last.current ? last.current.date : '') + ' 的 .night-publish-<日期>.log\n' +
        '（下面是这次运行的最后 120 行）\n\n' + lines.join('\n');
    } else {
      $('logBody').textContent = '（这一天没有日志内容）';
    }
  } catch (e) {
    $('logBody').textContent = '读不到日志：' + (e && e.message ? e.message : e);
  }
}

/** 从日志尾部里切出「这一步」那一段：含这一步文案的 === 行 → 下一个 === 行之前。 */
function sliceStep(lines, step) {
  const label = step.label || '';
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (label && lines[i].indexOf(label) >= 0) { start = i; break; }
  }
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    /* ⚠️ 分隔用的长横线是 `==========`（第三个 = 后面还是 =），
       不会命中 `=== ` —— 别把分隔线当阶段边界。 */
    if (/^\s*=== /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

function render(st) {
  last = st;
  const c = st.current || {};

  $('heroTitle').textContent = (c.date || st.todayBj) + ' 夜间发布';
  $('heroBadge').textContent = c.headline || '—';
  $('heroSub').textContent = [
    c.startedAt ? ('开始 ' + fmtAt(c.startedAt)) : '',
    c.finishedAt ? ('结束 ' + fmtAt(c.finishedAt)) : '',
    ((c.steps || []).filter((s) => s.status === 'done').length) + '/' +
      ((c.steps || []).length) + ' 节点完成',
  ].filter(Boolean).join(' · ');

  const sc = st.schedule || {};
  $('sched').textContent = sc.available
    ? ('计划任务 ' + (sc.state || '') + ' · 上次 ' + (sc.lastRunTime || '—') + ' · 下次 ' + (sc.nextRunTime || '—'))
    : '计划任务：读不到';

  renderSteps(c.steps || []);

  const ps = st.problems || [];
  const p = ps[0] || null;
  if (p) {
    $('problem').className = 'problem ' + (p.level || 'info');
    $('pTitle').textContent = p.title || '';
    $('pDetail').textContent = p.detail || '';
  } else {
    $('problem').className = 'problem hidden';
    $('pTitle').textContent = '';
    $('pDetail').textContent = '';
  }

  /* 未读问题提示：页面关着的时候也会漏，所以下次打开要补一条。 */
  const unread = $('unread');
  unread.classList.toggle('hidden', ps.length === 0);
  if (ps.length) unread.textContent = '有 ' + ps.length + ' 条未读问题：' + (ps[0].title || '');

  const h = (st.history || []).slice(0, 7);
  $('strip').innerHTML = h.map((x) =>
    '<i class="' + (x.status === 'failed' ? 'err' : (x.status === 'success' ? '' : 'warn')) + '" title="' +
    esc(x.date + ' ' + (x.headline || '')) + '"></i>').join('');
  $('hBody').innerHTML = h.map((x) =>
    '<tr><td>' + esc(x.date) + '</td><td>' + esc(x.status) + '</td><td>' + esc(fmtDur(x.durationMs)) +
    '</td><td>' + esc(x.source || '—') + '</td><td>' + esc(x.headline || '') + '</td></tr>').join('');

  /* 补发日期：源图目录还在的才能选。
     源图被清掉的**显示但禁用**并注明「源图已清理」（spec §8.3）——
     哪些被清掉，从 `history − republishDates` 就能推出来，不用改接口。 */
  const pick = $('republishDate');
  const dates = (st.actions && st.actions.republishDates) || [];
  const cleaned = (st.history || []).map((x) => x.date).filter((d) => dates.indexOf(d) < 0);
  const sig = dates.join(',') + '|' + cleaned.join(',');
  if (pick.dataset.sig !== sig) {
    pick.dataset.sig = sig;
    pick.innerHTML = dates.map((d) => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('') +
      cleaned.map((d) => '<option value="' + esc(d) + '" disabled>' + esc(d) + '（源图已清理）</option>').join('');
  }

  /* 已经有发布在跑 → 把写按钮置灰（服务端还会再挡一道 409）。 */
  const busy = !!(st.actions && st.actions.busy);
  $('runNow').disabled = busy;
  $('republish').disabled = busy;
}

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const st = await r.json();
    if (st && st.ok) render(st);
  } catch (e) {
    $('heroTitle').textContent = '连不上任务台服务';
  }
}

/** 二次确认条：不可逆动作必须走这里。onOk 是真正发起请求的那个函数。 */
function confirm(title, body, okLabel, onOk) {
  const dlg = $('confirm');
  $('dTitle').textContent = title;
  $('dBody').textContent = body;
  $('dOk').textContent = okLabel;
  $('dOk').onclick = async () => {
    dlg.close();
    try {
      await onOk();
    } catch (e) {
      alert('没发出去：' + (e && e.message ? e.message : e));
    }
  };
  dlg.showModal();
}

$('dCancel').onclick = () => $('confirm').close();
$('logClose').onclick = () => $('logBox').classList.add('hidden');

$('runNow').onclick = () => {
  confirm(CONFIRM.runNow.title, CONFIRM.runNow.body, CONFIRM.runNow.ok, async () => {
    const r = await fetch('/api/run-now', { method: 'POST' });
    if (!r.ok) alert('没发出去：' + ((await r.json()).error || r.status));
  });
};

$('republish').onclick = () => {
  const d = $('republishDate').value;
  if (!d) { alert('没有可补发的日期（源图都不在了）'); return; }
  confirm('补发 ' + d + '？', CONFIRM.republish.body(d), CONFIRM.republish.ok + ' ' + d, async () => {
    const r = await fetch('/api/republish?date=' + encodeURIComponent(d), { method: 'POST' });
    if (!r.ok) alert('没发出去：' + ((await r.json()).error || r.status));
  });
};

$('toggleHistory').onclick = () => $('hTable').classList.toggle('hidden');

/* 浏览器桌面通知：只在页面开着时有效。 */
if ('Notification' in window && Notification.permission === 'default') {
  const b = document.createElement('button');
  b.textContent = '开启通知';
  b.className = 'btn ghost';
  b.style.marginLeft = '12px';
  b.onclick = () => Notification.requestPermission();
  document.querySelector('.top').appendChild(b);
}

let prevStatus = null;
let prevProblem = null;
setInterval(async () => {
  await poll();
  const st = last || {};
  const c = st.current || {};
  const ps = st.problems || [];
  const p = ps[0] || null;
  const pkey = p ? ((p.level || '') + '|' + (p.title || '')) : null;

  /* 触发点（spec §8.4）：跑完、出现 error/warn。 */
  const notify = (body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('任务台', { body: body });
    }
  };
  const s = c.status;
  if (prevStatus && prevStatus !== s && s === 'success') {
    notify(c.headline || '这一期跑完了');
  }
  if (pkey && pkey !== prevProblem && (p.level === 'error' || p.level === 'warn')) {
    notify((p.title || '') + ' · ' + (p.detail || ''));
  }
  prevStatus = s;
  prevProblem = pkey;
}, 3000);

poll();
