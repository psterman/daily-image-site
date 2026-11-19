/**
 * auth-ui.mjs —— 登录 / 注册界面 + 会话管理（浏览器 ES 模块，零依赖）
 *
 * 借鉴线上原版「零框架、单一真源」的风格：
 *   - 一个 renderAuth(root, state, handlers) 函数按状态渲染整块 UI
 *   - 登录态只有三种：checking / signedOut / signedIn
 *   - 表单 mode：login | signup | recover | reset
 *   - 会话存 localStorage；JWT 到期用 refresh_token 续期
 *
 * 安全边界：只碰 publishable key（在 sb-client 里），本模块不接触任何私密凭证。
 */
import { SESSION_KEY } from './config.js';

const STATE_LABEL = {
  checking: '正在恢复会话…',
  signedOut: '未登录',
  signedIn: '已登录',
};

/** access_token 到期前多久主动续期（秒）。jwt_exp=3600，留 5 分钟余量。 */
export const REFRESH_SKEW_SEC = 5 * 60;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 把 GoTrue 返回体整理成可落盘的会话。
 * 有的版本只给 expires_in，没有 expires_at —— 这里补齐。
 */
export function normalizeSession(data) {
  if (!data || !data.access_token) return null;
  let expires_at = data.expires_at ? Number(data.expires_at) : null;
  if (!expires_at && data.expires_in != null) {
    expires_at = Math.floor(Date.now() / 1000) + Number(data.expires_in);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: expires_at || null,
    user: data.user
      ? { id: data.user.id, email: data.user.email }
      : (data.user === null ? null : undefined),
  };
}

/** 剩余有效期不足 skew 秒（或已过期）→ 需要续期。缺 expires_at 时不瞎猜。 */
export function sessionNeedsRefresh(session, skewSec = REFRESH_SKEW_SEC) {
  if (!session || !session.access_token) return true;
  if (!session.expires_at) return false;
  return Number(session.expires_at) * 1000 <= Date.now() + skewSec * 1000;
}

/**
 * 解析邮箱确认 / 重置密码回调里的 hash 片段。
 * 形如 #access_token=…&refresh_token=…&type=recovery|signup
 */
export function parseAuthHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw || raw.indexOf('access_token=') < 0) return null;
  const p = new URLSearchParams(raw);
  const access_token = p.get('access_token');
  if (!access_token) return null;
  const expires_in = p.get('expires_in');
  const expires_at = p.get('expires_at');
  const sess = normalizeSession({
    access_token,
    refresh_token: p.get('refresh_token'),
    expires_in: expires_in ? Number(expires_in) : null,
    expires_at: expires_at ? Number(expires_at) : null,
    user: null,
  });
  if (!sess) return null;
  sess.type = p.get('type') || 'unknown';
  return sess;
}

/** 从 localStorage 读取会话；坏数据返回 null。 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.access_token) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    const norm = normalizeSession(session) || session;
    if (!norm || !norm.access_token) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      access_token: norm.access_token,
      refresh_token: norm.refresh_token || null,
      expires_at: norm.expires_at || null,
      user: norm.user
        ? { id: norm.user.id, email: norm.user.email }
        : null,
    }));
  } catch { /* 隐私模式下 localStorage 可能不可写，忽略 */ }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/**
 * 渲染认证区。
 * @param {HTMLElement} root 容器
 * @param {object} state { status, user, mode:'login'|'signup'|'recover'|'reset', busy, error, notice, pendingEmail }
 * @param {object} handlers {
 *   onSubmit(email,pw), onSwitch(mode), onLogout(),
 *   onRecover(email), onResend(email), onReset(password)
 * }
 */
export function renderAuth(root, state, handlers) {
  if (!root) return;
  const status = state.status || 'signedOut';
  const mode = state.mode || 'login';

  if (status === 'checking') {
    root.innerHTML = '<div class="auth-card card pad"><div class="auth-loading">正在恢复会话…</div></div>';
    return;
  }

  if (status === 'signedIn' && mode !== 'reset') {
    const email = esc(state.user && state.user.email ? state.user.email : '已登录用户');
    root.innerHTML =
      '<div class="auth-card card pad signed">' +
        '<div class="auth-ok"><span class="auth-dot"></span>已连接到你的云端平台</div>' +
        '<div class="auth-email">' + email + '</div>' +
        '<div class="auth-actions"><span class="auth-state">' + STATE_LABEL.signedIn + '</span>' +
        '<button class="btn sm" data-auth-action="logout">退出登录</button></div>' +
      '</div>';
    const btn = root.querySelector('[data-auth-action="logout"]');
    if (btn && handlers.onLogout) btn.addEventListener('click', handlers.onLogout);
    return;
  }

  const notice = state.notice
    ? '<div class="auth-notice">' + esc(state.notice) +
      (state.pendingEmail && handlers.onResend
        ? ' <button type="button" class="auth-link" data-auth-action="resend">重发确认邮件</button>'
        : '') +
      '</div>' : '';
  const error = state.error
    ? '<div class="auth-error">' + esc(state.error) + '</div>' : '';

  // 重置密码（邮件链接回调后）
  if (mode === 'reset') {
    root.innerHTML =
      '<div class="auth-card card pad">' +
        '<div class="auth-title">设置新密码</div>' +
        '<div class="auth-sub">请输入新密码（至少 6 位），完成后即可登录</div>' +
        notice + error +
        '<form class="auth-form" novalidate>' +
          '<label class="auth-label">新密码<input class="auth-input" type="password" name="password" autocomplete="new-password" placeholder="至少 6 位" required></label>' +
          '<button class="btn primary auth-submit" type="submit" ' + (state.busy ? 'disabled' : '') + '>' +
            (state.busy ? '请稍候…' : '保存新密码') + '</button>' +
        '</form>' +
        '<div class="auth-switch"><button class="auth-link" data-auth-action="switch-login">返回登录</button></div>' +
      '</div>';
    const form = root.querySelector('form');
    if (form && handlers.onReset) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        handlers.onReset(String(form.elements.password.value || ''));
      });
    }
    const back = root.querySelector('[data-auth-action="switch-login"]');
    if (back && handlers.onSwitch) back.addEventListener('click', () => handlers.onSwitch('login'));
    return;
  }

  // 找回密码（只填邮箱）
  if (mode === 'recover') {
    root.innerHTML =
      '<div class="auth-card card pad">' +
        '<div class="auth-title">找回密码</div>' +
        '<div class="auth-sub">我们会发一封重置邮件到你的邮箱</div>' +
        notice + error +
        '<form class="auth-form" novalidate>' +
          '<label class="auth-label">邮箱<input class="auth-input" type="email" name="email" autocomplete="email" placeholder="you@example.com" required></label>' +
          '<button class="btn primary auth-submit" type="submit" ' + (state.busy ? 'disabled' : '') + '>' +
            (state.busy ? '请稍候…' : '发送重置邮件') + '</button>' +
        '</form>' +
        '<div class="auth-switch"><button class="auth-link" data-auth-action="switch-login">返回登录</button></div>' +
      '</div>';
    const form = root.querySelector('form');
    if (form && handlers.onRecover) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        handlers.onRecover(String(form.elements.email.value || '').trim());
      });
    }
    const back = root.querySelector('[data-auth-action="switch-login"]');
    if (back && handlers.onSwitch) back.addEventListener('click', () => handlers.onSwitch('login'));
    return;
  }

  // signedOut —— 登录 / 注册表单
  const isSignup = mode === 'signup';
  root.innerHTML =
    '<div class="auth-card card pad">' +
      '<div class="auth-title">' + (isSignup ? '创建账号' : '登录你的平台') + '</div>' +
      '<div class="auth-sub">' + (isSignup
        ? '注册后即可搭建属于自己的信息平台' : '登录后继续搭建你的今日头条') + '</div>' +
      notice + error +
      '<form class="auth-form" novalidate>' +
        '<label class="auth-label">邮箱<input class="auth-input" type="email" name="email" autocomplete="email" placeholder="you@example.com" required></label>' +
        '<label class="auth-label">密码<input class="auth-input" type="password" name="password" autocomplete="' +
          (isSignup ? 'new-password' : 'current-password') + '" placeholder="至少 6 位" required></label>' +
        '<button class="btn primary auth-submit" type="submit" ' + (state.busy ? 'disabled' : '') + '>' +
          (state.busy ? '请稍候…' : (isSignup ? '注册并登录' : '登录')) + '</button>' +
      '</form>' +
      (isSignup
        ? ''
        : '<div class="auth-switch"><button class="auth-link" data-auth-action="recover">忘记密码？</button></div>') +
      '<div class="auth-switch">' + (isSignup ? '已有账号？' : '还没有账号？') +
        '<button class="auth-link" data-auth-action="switch">' + (isSignup ? '去登录' : '免费注册') + '</button>' +
      '</div>' +
      '<div class="auth-footnote">数据存在你自己的 Supabase 项目，受行级安全（RLS）保护。</div>' +
    '</div>';

  const form = root.querySelector('form');
  if (form && handlers.onSubmit) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = String(form.elements.email.value || '').trim();
      const pw = String(form.elements.password.value || '');
      handlers.onSubmit(email, pw);
    });
  }
  const sw = root.querySelector('[data-auth-action="switch"]');
  if (sw && handlers.onSwitch) {
    sw.addEventListener('click', () => handlers.onSwitch(isSignup ? 'login' : 'signup'));
  }
  const rec = root.querySelector('[data-auth-action="recover"]');
  if (rec && handlers.onSwitch) {
    rec.addEventListener('click', () => handlers.onSwitch('recover'));
  }
  const resend = root.querySelector('[data-auth-action="resend"]');
  if (resend && handlers.onResend) {
    resend.addEventListener('click', () => handlers.onResend(state.pendingEmail));
  }
}

/**
 * 把 Supabase Auth 的错误翻译成人话。
 */
export function authError(err) {
  const m = String(err && err.message ? err.message : err || '');
  if (/invalid login credentials|invalid email or password/i.test(m)) return '邮箱或密码不正确';
  if (/user already registered|already exists/i.test(m)) return '该邮箱已注册，请直接登录';
  if (/password should be at least|password.*at least 6/i.test(m)) return '密码至少需要 6 位';
  if (/email not confirmed/i.test(m)) return '邮箱尚未验证，请先到邮箱点确认链接';
  if (/same password|should be different/i.test(m)) return '新密码不能与旧密码相同';
  if (/refresh_token|invalid.*token|token.*expired/i.test(m)) return '登录已过期，请重新登录';
  if (/rate limit|too many/i.test(m)) return '请求太频繁，请稍后再试';
  if (/failed to fetch|network/i.test(m)) return '网络异常，请检查连接后重试';
  return m || '操作失败，请重试';
}
