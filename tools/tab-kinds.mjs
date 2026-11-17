/**
 * tab 的「形态」判定 —— 媒体型（图片） vs 文本型（内容条目）
 *
 * 为什么要有这个单独的文件：
 *   manifest 里的 tab 有两种**根本不同**的形态，而判定条件散落在好几个地方：
 *     · tools/build.mjs 的产物自检（manifest 引用的文件是否真在 r2 母本里）
 *     · tools/build.mjs 的 diffImageTabs（--keep-manifest 时比对新旧产物）
 *     · tools/build.mjs 的汇总日志（图片总数）
 *     · tools/verify-build.mjs 的发布前产物核对
 *
 *   以前只有两种形态，判定条件写成 `tab.type === 'headlines'` 就够了。
 *   加第二个文本型 tab（音乐榜 / 影视榜）时，这几处**必须一起改** ——
 *   漏掉任何一处的后果不是「显示不对」，而是**构建直接失败**：
 *   文本型 tab 被当成图片 tab，产物自检会去 r2 母本里找它的图，找不到就抛
 *   「产物不完整，拒绝生成 manifest」；--keep-manifest 更是直接拒绝构建。
 *
 * 规则（只有这一处定义，别处一律引用这里，别再各写各的）：
 *   · 没有 type 字段 → 媒体型（图片 tab）：产物在 r2 母本里，item 带 thumb/full
 *   · 有 type 字段   → 文本型：item 是内容条目，**产物不在母本里**，没有 thumb/full
 *   · type 的具体值只影响前端怎么渲染：
 *       'headlines' → 见报（RSS 热榜，单列文字 + 可选配图）
 *       'rank'      → 榜单（音乐/影视，单列文字 + 远程封面）
 */

/** 已知的文本型 tab 类型。新增文本型 tab 时往这里加。 */
export const TEXT_TAB_TYPES = ['headlines', 'rank'];

/**
 * 媒体型（图片）tab 吗？
 * 只有图片 tab 的产物才在 r2 母本里，发布前才需要核对文件存在。
 */
export function isMediaTab(tab) {
  return !tab || !tab.type;
}

/**
 * 文本型 tab 吗？
 * 文本型 tab 的条目是内容（标题、链接、封面 URL），不涉及母本里的图片文件。
 */
export function isTextTab(tab) {
  return !!tab && !!tab.type;
}
