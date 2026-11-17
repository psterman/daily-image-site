/**
 * 测试用的 R2 替身 —— 严格按 Cloudflare 官方契约实现。
 *
 * 为什么必须严格：
 *   之前这版 mock 认错了 etag 键名（etagMatch 而非 etagMatches）、
 *   冲突时抛异常而不是返回 null，结果把生产代码里的条件写 bug 完全挡住了 ——
 *   「并发点赞不丢」那条断言在把乐观锁整个删掉后照样通过。
 *   mock 宽松 = 测试在测 fiction，不是在测产品。
 *
 * 严格的五个点：
 *   1. 只认 etagMatches。遇到不认识的 onlyIf 键直接抛错 ——
 *      拼错键名要当场炸，不能悄悄退化成无条件写。
 *   2. 只认 Headers 形式的 If-None-Match: *（官方唯一的「仅当不存在才创建」写法）。
 *   3. 前置条件不满足时返回 null（官方契约），不抛异常。
 *   4. get/put 之间有真实延迟 —— 不加延迟的话并发请求会被同步体天然串行化，
 *      永远撞不上 etag 冲突，那条并发断言就白写了。
 *   5. 暴露 stats，让测试能断言「冲突真的发生过」。
 *
 * 官方契约：https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
 */

/** FNV-1a。真实 R2 的 etag 是不带引号的十六进制（httpEtag 才带引号） */
function etagOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * @param {object} store 存对象的字典
 * @param {object} [opts]
 * @param {number} [opts.delayMs] get/put 的模拟延迟（默认 2ms；顺序跑的用例可以传 0 提速）
 */
export function makeR2(store, opts) {
  const delayMs = opts && typeof opts.delayMs === 'number' ? opts.delayMs : 2;
  const stats = { gets: 0, puts: 0, conflicts: 0 };
  /* delayMs 0 = 完全不等（顺序跑的用例用它提速）。
     setTimeout(r, 0) 在 Node 里也有 ~1ms 的粒度，500 多次请求累积起来很可观。 */
  const sleep = delayMs > 0 ? () => new Promise((r) => setTimeout(r, delayMs)) : () => Promise.resolve();

  return {
    stats,

    async get(key) {
      stats.gets++;
      await sleep();
      if (!(key in store)) return null;
      const val = store[key];
      const text = typeof val === 'string' ? val : new TextDecoder().decode(val);
      return {
        etag: etagOf(text),
        async text() {
          return text;
        },
      };
    },

    async put(key, value, putOpts) {
      stats.puts++;
      await sleep();
      const cur = key in store ? store[key] : undefined;
      const curEtag = cur === undefined ? null : etagOf(cur);
      const only = putOpts && putOpts.onlyIf;

      if (only !== undefined && only !== null) {
        if (typeof only.get === 'function') {
          /* Headers 形式：目前只用 If-None-Match: *（仅当对象不存在才写）。
             别的条件头（If-Match 等）本 mock 不实现 —— 静默忽略比报错更危险，
             会让人以为条件生效了。

             顺序很重要：**先把不支持的条件头挑出来报错**。
             原来这个检查排在 If-None-Match 分支之后，
             于是「同时带 If-None-Match: * 和 If-Match」而且对象已存在时，
             先 return null 了 —— If-Match 被静默跳过，不报错。
             静默跳过比报错危险：它让人以为两个条件都参与了判断。 */
          for (const h of ['if-match', 'if-modified-since', 'if-unmodified-since']) {
            if (only.get(h) !== null && only.get(h) !== undefined) {
              throw new Error('mock R2: 不支持的条件头 "' + h + '"');
            }
          }
          const inm = only.get('if-none-match');
          if (inm !== null && inm !== undefined) {
            if (inm === '*') {
              if (cur !== undefined) {
                stats.conflicts++;
                return null;
              }
            } else if (curEtag === inm) {
              stats.conflicts++;
              return null;
            }
          }
        } else if (typeof only === 'object') {
          for (const k of Object.keys(only)) {
            if (k === 'etagMatches') {
              if (only[k] !== curEtag) {
                stats.conflicts++;
                return null;
              }
            } else if (k === 'etagDoesNotMatch') {
              if (only[k] === curEtag) {
                stats.conflicts++;
                return null;
              }
            } else {
              /* 注意：这条错误消息里不能出现 "precondition" / "412" 这些词 ——
                 生产代码的 writeJson 靠这个正则识别「这是条件写冲突」，
                 消息里带上就会把「拼错键名」这个真错误当成冲突吞掉。
                 （"etag" 是安全的：catch 已经收窄成 /precondition|412/i。）
                 消息里只列**本 mock 真正实现了**的键 —— 列了不实现的键，
                 就是在骗读代码的人。 */
              throw new Error(
                'mock R2: onlyIf 出现了未实现的键 "' + k +
                '"（本 mock 只实现了 etagMatches / etagDoesNotMatch）',
              );
            }
          }
        } else {
          throw new Error('mock R2: onlyIf 既不是对象也不是 Headers');
        }
      }

      store[key] = value;
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      return { key, etag: etagOf(text) };
    },
  };
}
