/**
 * 发布状态判定 —— 纯函数，单测直接调它。
 *
 * 为什么单独拎出来（2026-11-15 实测）：
 *   审稿台原来只有两个信号：日志里有没有结束标记、日志最近有没有被写过。
 *   11-15 那次发布被腰斩（构建往 stderr 打了一行连接重置的 warning，
 *   把 publish.ps1 整个掀翻了），日志停在「✓ 产物自检通过」再也没动 ——
 *   于是审稿台一直显示「发布中…」，直到 45 分钟超时才翻成失败。
 *   用户看到的就是「我审核了，没发布」。
 *
 *   现在多一条判据：**日志多久没动**。
 *   构建的静默窗口最长一分多钟（见报抓取那段不打印任何东西），
 *   超过 6 分钟没动 = 发布进程已经不在了 → 立刻报失败，别让人干等 45 分钟。
 *
 *   这个文件不含任何副作用，可以随便造时钟来测。
 */

/** 兜底：跑了这么久还没有结束标记，就当它死了。 */
export const PUBLISH_TIMEOUT_MS = 45 * 60 * 1000;

/** 日志多久没更新就算发布进程已经不在了。 */
export const PUBLISH_STALE_MS = 6 * 60 * 1000;

/** 最近动过 = 还在跑。 */
export const PUBLISH_TOUCH_MS = 2 * 60 * 1000;

/**
 * @param {object} input
 * @param {boolean} input.done         日志里有没有结束标记
 * @param {number|null} input.doneExitCode  结束标记里的退出码
 * @param {number} input.mtime         日志文件最后修改时间（毫秒，0 = 没有日志）
 * @param {number|null} input.startedAt 发布开始时间（毫秒）
 * @param {boolean} input.running      内存里「正在发布」这个标记
 * @param {number} [input.now]         当前时间（测的时候传假时钟）
 * @returns {{running: boolean, exitCode: number|null, dead: boolean, reason: string, ageMs: number}}
 */
export function computePublishState(input) {
  const {
    done = false,
    doneExitCode = null,
    mtime = 0,
    startedAt = null,
    running = false,
    now = Date.now(),
    timeoutMs = PUBLISH_TIMEOUT_MS,
    staleMs = PUBLISH_STALE_MS,
    touchMs = PUBLISH_TOUCH_MS,
  } = input || {};

  /* 有结束标记 = 发布进程自己说完了，一切以它为准。 */
  if (done) {
    return { running: false, exitCode: doneExitCode, dead: false, reason: 'done', ageMs: 0 };
  }

  const ageMs = mtime ? now - mtime : Infinity;

  /* 日志很久没动，又没有结束标记 —— 进程已经不在了（多半被强杀）。 */
  if (mtime && ageMs > staleMs) {
    return { running: false, exitCode: -1, dead: true, reason: 'stale', ageMs };
  }

  /* 兜底超时。 */
  if (startedAt && now - startedAt > timeoutMs) {
    return { running: false, exitCode: -1, dead: true, reason: 'timeout', ageMs };
  }

  /* 还在跑：要么日志刚动过，要么内存里那个标记还在。 */
  const touched = !!(mtime && ageMs < touchMs);
  return {
    running: !!(touched || running),
    exitCode: null,
    dead: false,
    reason: 'running',
    ageMs,
  };
}

/** 给界面看的一句话。 */
export function describeDeadState(state) {
  if (!state || !state.dead) return '';
  if (state.reason === 'stale') {
    const sec = Math.round((state.ageMs || 0) / 1000);
    return `✗ 发布进程已经不在了：日志 ${sec} 秒没有更新，也没有结束标记（多半是被强杀或脚本被腰斩）`;
  }
  return '✗ 发布超时：45 分钟没有结束标记';
}
