#!/usr/bin/env node
/**
 * 发布状态判定的单测（2026-11-15 加）
 *
 * 为什么要有这个测试：
 *   审稿台原来只靠「45 分钟兜底」判断发布是不是还活着。
 *   11-14 / 11-15 两次发布都被腰斩（构建往 stderr 打了一行 warning，
 *   把 publish.ps1 掀翻），日志停在「✓ 产物自检通过」再也没动 ——
 *   界面于是一直转「发布中…」，用户看着像「审核了但没发布」。
 *   「日志多久没动」这条判据是这次修的核心，必须有护栏盯着。
 *
 * 变异测试（护栏有没有牙齿的判定标准）：
 *   把 publish-state.mjs 里的 staleMs 判据去掉（ageMs > staleMs 那行改成 false），
 *   这个测试必须变红。
 *   把 done 分支去掉，也必须变红。
 */
import { computePublishState, describeDeadState, PUBLISH_STALE_MS } from './publish-state.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const NOW = 1794707000000; // 固定时钟
const min = 60 * 1000;

/* 1) 有结束标记 = 发布进程自己说完了：以它为准 */
{
  const st = computePublishState({ done: true, doneExitCode: 0, mtime: NOW - 1000, now: NOW });
  check('有结束标记且 exit=0 -> 不再运行', st.running === false, st);
  check('有结束标记且 exit=0 -> 退出码 0', st.exitCode === 0, st);
  check('有结束标记 -> 不算 dead', st.dead === false, st);
}
{
  const st = computePublishState({ done: true, doneExitCode: 1, mtime: NOW - 1000, now: NOW });
  check('有结束标记且 exit=1 -> 退出码 1', st.exitCode === 1, st);
}

/* 2) 日志刚动过 -> 还在跑 */
{
  const st = computePublishState({ done: false, mtime: NOW - 30 * 1000, startedAt: NOW - 60 * 1000, running: true, now: NOW });
  check('日志 30 秒前动过 -> 还在跑', st.running === true, st);
  check('日志刚动过 -> 不算 dead', st.dead === false, st);
  check('日志刚动过 -> 没有退出码', st.exitCode === null, st);
}

/* 3) 只有「内存里那个标记」在（审稿台重启过、startedAt 没了）也要认还在跑 */
{
  const st = computePublishState({ done: false, mtime: NOW - 3 * min, startedAt: null, running: true, now: NOW });
  check('日志 3 分钟没动但内存标记在 -> 还在跑', st.running === true, st);
  check('日志 3 分钟没动 -> 不算 dead（阈值 6 分钟）', st.dead === false, st);
}

/* 4) 日志很久没动又没结束标记 = 进程已经不在了（本次修的核心） */
{
  const st = computePublishState({ done: false, mtime: NOW - 10 * min, startedAt: NOW - 12 * min, running: true, now: NOW });
  check('日志 10 分钟没动 -> 判为 dead', st.dead === true, st);
  check('日志 10 分钟没动 -> 不再显示「发布中」', st.running === false, st);
  check('日志 10 分钟没动 -> 退出码 -1', st.exitCode === -1, st);
  check('日志 10 分钟没动 -> 原因是 stale', st.reason === 'stale', st);
  check('stale 时报出日志停了多久', Math.abs(st.ageMs - 10 * min) < 1000, st);
}

/* 5) 兜底超时：跑了 45 分钟还没结束标记 */
{
  const st = computePublishState({ done: false, mtime: NOW - 10 * 1000, startedAt: NOW - 46 * min, running: true, now: NOW });
  check('跑了 46 分钟 -> 判为 dead', st.dead === true, st);
  check('跑了 46 分钟 -> 原因是 timeout', st.reason === 'timeout', st);
  check('跑了 46 分钟 -> 退出码 -1', st.exitCode === -1, st);
}

/* 6) 阈值本身：6 分钟 */
{
  check('stale 阈值是 6 分钟', PUBLISH_STALE_MS === 6 * min, PUBLISH_STALE_MS);
  const just = computePublishState({ done: false, mtime: NOW - (6 * min - 1000), startedAt: NOW - 7 * min, running: true, now: NOW });
  check('差 1 秒到阈值 -> 还算活着', just.dead === false, just);
  const over = computePublishState({ done: false, mtime: NOW - (6 * min + 1000), startedAt: NOW - 7 * min, running: true, now: NOW });
  check('超过阈值 1 秒 -> 判死', over.dead === true, over);
}

/* 7) 完全没有日志（刚点发布还没写盘）-> 不能判死 */
{
  const st = computePublishState({ done: false, mtime: 0, startedAt: NOW - 5000, running: true, now: NOW });
  check('没有日志文件 -> 不判死', st.dead === false, st);
  check('没有日志文件 -> 按内存标记算还在跑', st.running === true, st);
}

/* 8) 给界面看的话 */
{
  const st = computePublishState({ done: false, mtime: NOW - 10 * min, startedAt: NOW - 12 * min, running: true, now: NOW });
  const msg = describeDeadState(st);
  check('stale 的话术点明「进程已经不在了」', msg.includes('进程已经不在了'), msg);
  check('stale 的话术带上停了多久', msg.includes('600'), msg);
  const t = computePublishState({ done: false, mtime: NOW - 1000, startedAt: NOW - 46 * min, running: true, now: NOW });
  check('timeout 的话术点明「超时」', describeDeadState(t).includes('超时'), describeDeadState(t));
  check('活着的时候不产话术', describeDeadState({ dead: false }) === '', describeDeadState({ dead: false }));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
