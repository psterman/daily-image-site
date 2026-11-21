#!/usr/bin/env node
/**
 * 定时任务台的解析层：把日志/标记**文本**变成结构化状态。
 *
 * 边界：这一层是**纯函数** —— 只解析传进来的文本，不读文件、
 * 不碰网络、不 spawn 任何东西。文件 IO 由调用方负责。
 * 状态全部从磁盘推导 —— 不调 Cloudflare API（不花 token、不触发限流，
 * 线上挂了也不影响你看历史）。
 *
 * 时间戳格式（2026-11-20 起，Task 1 改的三个 helper 产出）：
 *   === 1/6 刷新 Cloudflare token ===  [00:12:03]
 * 老日志没有方括号里的时间戳 —— 照样解析，只是阶段耗时显示不出来。
 */

/* ── 依赖 ───────────────────────────────────────────────── */

/**
 * 「死没死 / 超时没超时」复用发布审稿台那套纯函数（tools/publish-state.mjs），
 * 不重造。publish-state.mjs 同样是**零 I/O 的纯函数**模块 ——
 * 引入它不破坏本文件「纯函数」的边界（仍然不读文件、不碰网络）。
 */
import { computePublishState, describeDeadState } from './publish-state.mjs';

/* ── 常量 ───────────────────────────────────────────────── */

/** 三个来源的结束标记。night / manual / review 各用各的，别混。 */
export const DONE_MARKERS = {
  night: /=== NIGHT_DONE exit=(-?\d+) ===/,
  manual: /=== MANUAL_DONE exit=(-?\d+) ===/,
  review: /=== PUBLISH_DONE exit=(-?\d+) ===/,
};

/**
 * 阶段标记行。
 * ① 编号 N/M  ② 文案  ③ 可选的 [HH:mm:ss]
 */
const STEP_RE = /^===\s+(\d+)\/(\d+)\s+(.+?)\s+===\s*(?:\[(\d{2}:\d{2}:\d{2})\])?\s*$/;

/** 界面上的三个组 */
export const GROUPS = [
  { key: 'prepare', label: '准备' },
  { key: 'verify', label: '校验与审稿' },
  { key: 'publish', label: '发布' },
];

/**
 * 15 个节点的「标准长相」，按日志里出现的顺序。
 *
 * 为什么要有这张表：日志只写**实际走过**的步骤（跳过的分支不写），
 * 界面却要一直显示 15 个位置。所以用这张表当骨架，
 * 再用日志里观察到的步骤覆盖 key 对应的那一格（文案以日志实际出现的为准）。
 */
export const CANONICAL_STEPS = [
  { key: 'prepare/1-3', label: '每日准备（抓图 → 头条 → 清洗 → 榜单/追更 → 构建）' },
  { key: 'prepare/0-5', label: '准备环境' },
  { key: 'prepare/1-5', label: '抓图 + 目录分流' },
  { key: 'prepare/2-5', label: '抓头条（见报的分类目录）' },
  { key: 'prepare/3-5', label: '清洗图片（剔广告 / 剔废图 / 剔重复）' },
  { key: 'prepare/4-5', label: '抓榜单 + 追更' },
  { key: 'prepare/5-5', label: '构建（本地，不上传）' },
  { key: 'verify/2-3', label: '校验构建产物' },
  { key: 'verify/3-3', label: '跳过审稿台（-SkipReview）' },
  { key: 'publish/1-6', label: '刷新 Cloudflare token' },
  { key: 'publish/2-6', label: '构建页面与图片' },
  { key: 'publish/3-6', label: '探测 R2 状态' },
  { key: 'publish/4-6', label: '跳过审稿闸门' },
  { key: 'publish/5-6', label: '上传图片到 R2' },
  { key: 'publish/6-6', label: '部署 Cloudflare Pages' },
];

/** 编号 → 组。1/3 是「每日准备」的开头，2/3、3/3 已经是后面两步了。 */
function groupOf(num, den) {
  if (den === 6) return 'publish';
  if (den === 5) return 'prepare';
  if (den === 3) return num === 1 ? 'prepare' : 'verify';
  return 'prepare';
}

/** 'HH:mm:ss' → 当天零点起的毫秒数 */
function clockToMs(clock) {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(clock || ''));
  if (!m) return NaN;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

/* ── 纯函数 ─────────────────────────────────────────────── */

/**
 * 剥掉 UTF-8 BOM。
 * PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
 * 而 `JSON.parse('\uFEFF{...}')` 直接抛 —— 不剥就整个页面挂掉。
 */
export function stripBom(text) {
  const s = typeof text === 'string' ? text : '';
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

/**
 * 解析 `.night-publish-<日期>.done`。
 * **JSON 坏了返回 null，不抛** —— 一个坏标记不该让整个页面挂掉。
 */
export function parseDone(raw) {
  const text = stripBom(raw);
  if (!text.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  return {
    date: typeof obj.date === 'string' ? obj.date : null,
    at: typeof obj.at === 'string' ? obj.at : null,
    exit: Number.isFinite(obj.exit) ? obj.exit : null,
    by: typeof obj.by === 'string' ? obj.by : null,
  };
}

/**
 * 解析日志里的阶段标记。
 *
 * baseDate: 'YYYY-MM-DD'（这份日志属于哪天）—— 时间戳只有 HH:mm:ss，
 * 得靠 baseDate 拼成绝对时刻。**跨零点**：算出来比上一步还早就 +1 天
 * （手动跑可能在 23:50 起、跨过零点）。
 */
export function parseSteps(text, baseDate) {
  /* 入口显式剥一次 BOM。
     今天两个 PS 日志都先 `Set-Content -Value '' -Encoding UTF8` 建空文件、
     BOM 独占第一行；审稿台那份发布日志由 Node 写、无 BOM —— 所以现在打不到。
     那为什么还要剥：现在能扛住 BOM，靠的是 `line.trim()` 顺手吃掉首尾的
     U+FEFF（ECMAScript 的 WhiteSpace 产出式里有 <ZWNBSP>，trim() 两端都去）。
     那是**借来的**正确性 —— 空白集不是一成不变的（ES2016 就把 U+180E
     移出 Space_Separator 了，trim() 的行为随之变过）。
     显式剥一次，就不用把「第一行不被吞」押在 trim() 的行为上。 */
  const body = stripBom(String(text || ''));
  const raw = [];
  for (const line of body.split(/\r?\n/)) {
    const m = STEP_RE.exec(line.trim());
    if (!m) continue;
    raw.push({
      num: Number(m[1]),
      den: Number(m[2]),
      label: m[3],
      clock: m[4] || null,
    });
  }

  const base = baseDate ? Date.parse(baseDate + 'T00:00:00+08:00') : NaN;
  let prevMs = NaN;
  const steps = [];
  for (const r of raw) {
    let atMs = null;
    if (r.clock && Number.isFinite(base)) {
      atMs = base + clockToMs(r.clock);
      if (Number.isFinite(prevMs) && atMs < prevMs) atMs += 24 * 60 * 60 * 1000;
    }
    const group = groupOf(r.num, r.den);
    steps.push({
      key: group + '/' + r.num + '-' + r.den,
      label: r.label,
      group,
      num: r.num,
      den: r.den,
      clock: r.clock,
      atMs,
    });
    if (Number.isFinite(atMs)) prevMs = atMs;
  }
  return steps;
}

/**
 * 解析整份日志：阶段 + 结束标记。
 * endMs：这次运行的结束时刻（没有就传 null，阶段耗时只能算到下一步）。
 */
export function parseLog(text, baseDate, endMs) {
  /* 同样在入口剥一次 BOM：结束标记（DONE 行）也可能落在第一行。
     parseSteps 内部还会再剥一次 —— 无害，stripBom 只看第 0 个字符。 */
  const body = stripBom(String(text || ''));
  const steps = parseSteps(body, baseDate);
  const lines = body.split(/\r?\n/);

  let source = null;
  let exitCode = null;
  for (const line of lines) {
    for (const [key, re] of Object.entries(DONE_MARKERS)) {
      const m = re.exec(line);
      if (m) {
        source = key;
        exitCode = Number(m[1]);
      }
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const next = steps[i + 1];
    const to = next && Number.isFinite(next.atMs)
      ? next.atMs
      : (Number.isFinite(endMs) ? endMs : null);
    steps[i].durationMs = (Number.isFinite(steps[i].atMs) && to !== null)
      ? Math.max(0, to - steps[i].atMs)
      : null;
  }

  return { source, exitCode, steps };
}

/** 中位数。空数组 → null。偶数个取平均后四舍五入。 */
export function median(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/* ── 状态与问题 ─────────────────────────────────────────── */

/**
 * 把「日志里观察到的步骤」和「15 个节点的标准骨架」合成一份完整数组。
 * 没走到的节点 = pending（灰）；文案以日志实际出现的为准（跳过变体如实呈现）。
 */
export function mergeSteps(observed) {
  const byKey = new Map((observed || []).map((s) => [s.key, s]));
  return CANONICAL_STEPS.map((c) => {
    const o = byKey.get(c.key);
    if (!o) {
      return {
        key: c.key, label: c.label, group: c.key.split('/')[0],
        status: 'pending', observed: false, clock: null, atMs: null, durationMs: null,
      };
    }
    return {
      key: c.key, label: o.label, group: o.group,
      status: o.status || 'done', observed: true,
      clock: o.clock, atMs: o.atMs, durationMs: o.durationMs ?? null,
    };
  });
}

/** 毫秒 → 「31 分 36 秒」 */
export function fmtDuration(ms) {
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
 * 毫秒 → 北京时间「2026-11-20T00:10:02+08:00」。
 *
 * 不用 toISOString() —— 那是 UTC（"2026-11-19T16:10:02.000Z"），
 * 用户看的就是北京时间（spec:268-269 的示例就是带 +08:00 的）。
 */
export function fmtLocal(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '') + '+08:00';
}

/**
 * 算某一天这一期的状态。
 *
 * input: { date, done, logText, logMtime, now, history?, running? }
 *   done     = parseDone() 的结果 | null
 *   logText  = 日志全文（读不到给空串）
 *   logMtime = 日志文件的 mtime（ms）；0 = 没有日志
 *   history  = 历史流水（算慢夜告警的基线）；默认 []
 *   running  = 「有发布进程正在跑」这个内存标记；默认 false
 *
 * ⚠️ 完成记录以 **`.done` 为准**（F1）：
 *   night-publish.ps1:167 / manual-publish.ps1:167 都是**先写 `.done`、后写日志标记**
 *   （只隔一行，:168）。进程若在这两行之间被杀，`.done` 已落盘（带真实 exit）
 *   而日志里没有结束标记 —— 这时只有 `.done` 说得准。
 *   所以「跑完了 / 退出码多少 / 来源是谁 / 什么时候结束的」**一律同源**：
 *   有 `.done` 全取自 `.done`（at / exit / by），没有 `.done` 才全取自日志标记。
 */
export function buildCurrent(input) {
  const {
    date, done, logText, logMtime, now = Date.now(),
    history = [], running = false,
  } = input || {};

  /* 「日志有实质内容」= 剥掉 BOM 后 trim 掉空白还有东西。
     PS 的 `Set-Content -Value ''` 写出来的是 BOM + CRLF ——
     `logText.length > 0` 判不出一份空日志（它有 3 个字符）。 */
  const logHasBody = stripBom(String(logText || '')).trim().length > 0;

  const doneExists = !!done;
  const doneMs = doneExists && done.at ? Date.parse(done.at) : NaN;
  const endMs = Number.isFinite(doneMs) ? doneMs : now;

  const parsed = parseLog(logText || '', date, endMs);
  const logDoneFound = parsed.source !== null;

  /* 「跑完了」= 日志里有结束标记 **或** `.done` 存在。 */
  const doneFound = logDoneFound || doneExists;

  /* exitCode / finishedAt / source —— 同源（F1）。
     F2：`.done` 存在时 exitCode **只认 `done.exit`** ——
     `done.exit` 不是有限数就取 null，**不从日志兜底**：
     兜底会让 source/finishedAt 来自 `.done`、exitCode 来自日志 → 又变成不同源。 */
  const exitCode = doneExists
    ? (Number.isFinite(done.exit) ? done.exit : null)
    : parsed.exitCode;
  const source = doneExists
    ? (done.by === 'manual' ? 'manual' : 'night')
    : parsed.source;

  const firstAt = parsed.steps.length ? parsed.steps[0].atMs : null;
  const startedAtMs = Number.isFinite(firstAt) ? firstAt : NaN;

  /* 「死没死 / 超时没超时」直接复用既有纯函数，不重造。 */
  const ps = computePublishState({
    done: doneFound,
    doneExitCode: exitCode,
    mtime: logMtime || 0,
    startedAt: Number.isFinite(startedAtMs) ? startedAtMs : null,
    running: !!running,
    now,
  });

  let status;
  if (logHasBody && parsed.steps.length === 0) {
    /* F3：日志有内容却一个阶段标记都读不出来 → 格式变了。
       退化成 unknown，**不假装一切正常**（spec:404）。
       即使 `.done` 存在也仍然是 unknown —— 但 exitCode / finishedAt 仍如实取自 `.done`。 */
    status = 'unknown';
  } else if (doneFound) {
    status = exitCode === 0 ? 'success' : 'failed';
  } else if (!logHasBody) {
    status = 'not-run';
  } else if (ps.dead && !running) {
    /* F7：进程还在跑（内存标记在）就别判死 ——
       长静默的步骤（比如抓见报）不该被当成「进程已经不在了」。 */
    status = 'dead';
  } else {
    status = 'running';
  }

  /* F2：失败/卡住时，最后一个**观察到的**步骤标 failed（用户要看到卡在哪）。 */
  const lastIdx = parsed.steps.length - 1;
  const steps = parsed.steps.map((s, i) => ({
    ...s,
    status: (status === 'failed' || status === 'dead') && i === lastIdx
      ? 'failed'
      : (status === 'running' && i === lastIdx ? 'running' : 'done'),
  }));
  const merged = mergeSteps(steps);

  const durationMs = Number.isFinite(doneMs) && Number.isFinite(startedAtMs)
    ? Math.max(0, doneMs - startedAtMs)
    : null;

  const codeText = Number.isFinite(exitCode) ? ('退出码 ' + exitCode) : '退出码未知';
  let headline;
  if (status === 'success') headline = '成功 · ' + fmtDuration(durationMs);
  else if (status === 'failed') headline = '失败 · ' + codeText;
  else if (status === 'running') headline = '正在跑 · ' + fmtDuration(now - (startedAtMs || now));
  else if (status === 'dead') headline = '卡住了';
  else if (status === 'not-run') headline = '还没跑';
  else if (status === 'unknown') headline = '日志格式变了';
  else headline = '状态未知';

  const current = {
    date: date || null,
    source,
    status,
    headline,
    startedAt: fmtLocal(startedAtMs),
    finishedAt: fmtLocal(doneMs),
    durationMs,
    exitCode,
    /* 「有没有完成记录」与「退出码读得出来吗」是两件事：
       `.done` 存在但 `exit` 字段坏了 → 记录**在**，只是读不出退出码。
       不知道这个区分的话，unknown 的文案会说「没有完成记录」—— 与事实相反。 */
    doneExists,
    steps: merged,
    problem: null,
    deadReason: status === 'dead' ? describeDeadState(ps) : '',
    /* 死因（'stale' / 'timeout'）—— pickProblem 要按它分别措辞，
       别让 detail 说「6 分钟没动」而 title 说「45 分钟没结束标记」。 */
    deadCause: status === 'dead' ? (ps.reason || '') : '',
  };
  /* F6：用传进来的历史算慢夜告警（写死空数组的话成功夜恒为 problem=null）。
     F5：把 now 传下去 —— 「现在 > 06:00」这条判据要按调用时刻算。 */
  current.problem = pickProblem(current, history, { now: now });
  return current;
}

/** 历史流水：按日期倒序。 */
export function buildHistory(entries) {
  return (entries || [])
    .filter((e) => e && e.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 每个阶段的历史耗时中位数。
 * **只用成功的夜** —— 失败夜往往卡在某一步，会把中位数拉歪。
 *
 * excludeDate：可选，排除某一晚（算「今天」的基线时用它，
 * 否则今天自己参与了自己基准的计算，慢夜告警会被自己盖掉）。
 */
export function stepMedians(history, excludeDate) {
  const acc = new Map();
  for (const h of history || []) {
    if (!h || h.status !== 'success') continue;
    if (excludeDate && h.date === excludeDate) continue;
    for (const s of h.steps || []) {
      if (!Number.isFinite(s.durationMs)) continue;
      if (!acc.has(s.key)) acc.set(s.key, []);
      acc.get(s.key).push(s.durationMs);
    }
  }
  const out = new Map();
  for (const [k, v] of acc) out.set(k, median(v));
  return out;
}

/**
 * 挑出最该让人看到的那一条问题（只出一条，按严重度排序）。
 * current / history 见 buildCurrent / buildHistory。
 *
 * opts（可选第三参）：{ now, nowBjHour, nowBjDate }
 *   now       = epoch ms，默认 Date.now()
 *   nowBjHour = 北京时间小时（0–23）；不传就按 now 自己算
 *   nowBjDate = 北京时间日期（'YYYY-MM-DD'）；不传就按 now 自己算
 * 两参的旧调用方式（pickProblem(current, history)）继续可用。
 */
export function pickProblem(current, history, opts) {
  if (!current) return null;

  const o = opts || {};
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
  /* 北京时间的小时与日期 —— spec §6.2 的「现在 > 06:00」是北京时间口径。 */
  const bjHour = Number.isFinite(o.nowBjHour)
    ? o.nowBjHour
    : Math.floor((nowMs + 8 * 3600 * 1000) / 3600000) % 24;
  const bjDate = o.nowBjDate
    || new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);

  /* F5：中位数基线**排除当前这一夜**。
     否则「今天」参与了自己基准的计算：干净基线中位数 15 分 → 阈值 30 分，
     把今天（30 分 50 秒）自己也塞进历史后中位数变成 15 分 30 秒 → 阈值 31 分
     → 慢夜告警被自己盖掉。 */
  const okNights = (history || []).filter((h) =>
    h && h.status === 'success' && Number.isFinite(h.durationMs) && h.date !== current.date);
  const med = median(okNights.map((h) => h.durationMs));

  /* F4：退出码可能是 undefined（history 摘要条目里根本没这个字段）——
     拼进文案里会变成「退出码 undefined」。 */
  const codeText = Number.isFinite(current.exitCode)
    ? ('退出码 ' + current.exitCode)
    : '退出码未知';

  if (current.status === 'failed') {
    const step = (current.steps || []).find((s) => s && s.status === 'failed');
    return {
      level: 'error',
      title: (current.date || '') + ' 失败了',
      detail: step
        ? ('停在「' + step.label + '」，' + codeText)
        : codeText,
      stepKey: step ? step.key : null,
    };
  }
  if (current.status === 'dead') {
    /* F2：点名卡在哪一步。 */
    const step = (current.steps || []).find((s) => s && s.status === 'failed');
    /* F3：死因有两种 —— stale（日志 6 分钟没动）/ timeout（45 分钟没结束标记）。
       title 由 describeDeadState 按死因生成，detail 得跟它走，别自相矛盾。 */
    const cause = current.deadCause === 'timeout'
      ? '45 分钟没有结束标记。'
      : '日志 6 分钟没有更新，但一直没写结束标记。';
    return {
      level: 'error',
      title: current.deadReason || '发布进程已经不在了',
      detail: (step ? ('停在「' + step.label + '」，') : '') + cause,
      stepKey: step ? step.key : null,
    };
  }
  if (current.status === 'unknown') {
    /* F1：按完成记录分级。
       spec §6.2 的 error 判据只有三条（exit≠0 / 日志停摆 / 超时），
       「格式变了」不在其中 → exit≠0 才 error；exit=0（那一夜确认成功）
       或没有完成记录 → warn（值得看一眼，但不是坏了）。 */
    const level = (Number.isFinite(current.exitCode) && current.exitCode !== 0)
      ? 'error'
      : 'warn';
    return {
      level,
      title: '日志格式变了',
      detail: '日志格式变了，读不出阶段标记（'
        + (Number.isFinite(current.exitCode)
            ? ('完成记录 exit=' + current.exitCode)
            : (current.doneExists ? '完成记录 exit 读不出来' : '没有完成记录'))
        + '）',
      stepKey: null,
    };
  }
  if (current.status === 'not-run') {
    /* F5：06:00 之前不算问题 —— 计划任务 00:10 才起跑，
       00:00–06:00 说「今天凌晨还没跑」是每天一次假警报。
       历史条目也不该说「今天」—— 按日期分别措辞。 */
    if (bjHour < 6) return null;
    const title = current.date === bjDate
      ? '今天凌晨还没跑'
      : ((current.date || '那一期') + ' 凌晨还没跑');
    return { level: 'info', title, detail: '计划任务应该在 00:10 启动。', stepKey: null };
  }

  /* 夜级慢：总耗时 > 历史中位数 × 2（spec §6.2）。 */
  const nightRatio = (current.status === 'success' && med && Number.isFinite(current.durationMs)
      && current.durationMs > med * 2)
    ? current.durationMs / med
    : null;

  /* F4：阶段级慢 —— 某一步 > 该步基线 × 3（spec §6.2）。
     基线 <= 0 或没有基线 → **不判**（否则「平时 0 秒」会让任何耗时都超 3 倍 → 假警报）。 */
  const stepMeds = stepMedians(history, current.date);

  /* ⚠️ 只比「**闭合区间**」：
     最后一个观察到的步骤，耗时 = 结束时刻 − 阶段起点。
     结束时刻**未知**时（`finishedAt` 为 null：还在跑 / 卡住了 / `.done` 坏了 /
     日志里有结束标记但 `.done` 没写），这个耗时是「**到现在**」——
     它每次轮询都在涨，拿去和历史基线比会出现一条数字一直变的告警。
     `finishedAt` 非 null = 结束时刻已知 → 那一段是闭合的 → 照常比。

     判据用「结束时刻知不知道」而不是「status 是不是 running/dead」：
     前者把「`.done` 损坏但日志有结束标记」那条路也盖住了
     （那一夜 status 是 success，但结束时刻同样未知）。 */
  let lastObservedKey = null;
  for (const s of current.steps || []) {
    if (s && Number.isFinite(s.durationMs)) lastObservedKey = s.key;
  }
  const skipOpenTail = !current.finishedAt;

  let worst = null;
  for (const s of current.steps || []) {
    if (!s || !Number.isFinite(s.durationMs)) continue;
    if (skipOpenTail && lastObservedKey && s.key === lastObservedKey) continue;
    const m = stepMeds.get(s.key);
    if (!Number.isFinite(m) || m <= 0) continue;
    if (s.durationMs <= m * 3) continue;
    const ratio = s.durationMs / m;
    if (!worst || ratio > worst.ratio) worst = { step: s, med: m, ratio };
  }
  const stepRatio = worst ? worst.ratio : null;

  /* 两个都是 warn，取倍数大的那个；倍数相同夜级优先（夜级信息更完整）。 */
  if (nightRatio === null && stepRatio === null) return null;
  if (nightRatio !== null && (stepRatio === null || nightRatio >= stepRatio)) {
    return {
      level: 'warn',
      title: '这次花了 ' + fmtDuration(current.durationMs) + '，平时 ' + fmtDuration(med),
      /* detail 里也带上「平时多久」—— 界面上真正给用户看的是 detail，
         只写在中位数比较结果里的话，文案里看不到「15 分」这个数。 */
      detail: '平时中位数 ' + fmtDuration(med) + '，这次慢了不止一倍，值得看看是哪一段。',
      stepKey: null,
    };
  }
  const ratioText = String(Math.round(stepRatio * 10) / 10);
  return {
    level: 'warn',
    title: '「' + worst.step.label + '」这一步用了 ' + fmtDuration(worst.step.durationMs)
      + '，平时 ' + fmtDuration(worst.med),
    detail: '平时中位数 ' + fmtDuration(worst.med) + '，这次是 ' + ratioText + ' 倍 —— 值得看看这一段。',
    stepKey: worst.step.key,
  };
}
