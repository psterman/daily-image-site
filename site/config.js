/**
 * site/config.js —— 前端公开配置（可入库，只含公开信息）
 *
 * 这里只放 Project URL + publishable key + schema —— 三者都是设计上可公开的：
 *   - publishable key 受 RLS 约束，本来就要下发到浏览器
 *   - schema 名不是秘密
 * 绝不在这里放 service_role / secret key / PAT。
 *
 * 部署到真实环境时，把下面三个值改成你的项目值即可。
 * 当前填的是本项目已部署的 Supabase 实例（onetone-daily / platform schema）。
 */
export const SB_CONFIG = {
  url: 'https://efqljinkeatzpobvuouj.supabase.co',
  key: 'sb_publishable_IOwVQqr7oTB2mYYWJw9k0g_YksWTtKU',
  schema: 'platform',
  siteUrl: 'https://efqljinkeatzpobvuouj.pages.dev',
};

/** 会话持久化用的 localStorage key */
export const SESSION_KEY = 'platform.session.v1';

/**
 * 按需全文：同域 /fulltext/api（Pages Function；本地 portal-dev 已内嵌）。
 * 也可写成绝对地址覆盖。永不把全文写入共享池。
 */
export const FULLTEXT_ENDPOINT = '/fulltext/api';
