'use strict';

(function () {
  const TOKEN_KEY = 'kppp_auth_token_v1';
  const USER_KEY = 'kppp_auth_user_v1';

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  }

  function getToken() {
    return String(localStorage.getItem(TOKEN_KEY) || '').trim();
  }

  function getUser() {
    return readJSON(USER_KEY, null);
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token || '');
    localStorage.setItem(USER_KEY, JSON.stringify(user || null));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function pageName() {
    const path = (location.pathname || '/').replace(/\/+$/, '') || '/';
    return path.split('/').pop() || 'index.html';
  }

  function isPublicPage() {
    const name = pageName().toLowerCase();
    return name === 'login.html' || name === 'login';
  }

  function loginUrl() {
    const next = encodeURIComponent(location.pathname + location.search);
    return '/login.html?next=' + next;
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (!headers['Content-Type'] && options.body && typeof options.body === 'string') {
      headers['Content-Type'] = 'application/json';
    }
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (response.status === 401 && !isPublicPage()) {
      clearSession();
      location.replace(loginUrl());
      throw new Error('Unauthorized');
    }
    return { response, data };
  }

  // Attach Authorization to same-origin data/API calls used across the app.
  if (!window.__kpppAuthFetchPatched) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const absolute = new URL(url, location.origin);
        const sameOrigin = absolute.origin === location.origin;
        const needsAuth = sameOrigin && (
          absolute.pathname.startsWith('/api/') ||
          absolute.pathname === '/tenders.json'
        );
        const publicAuth = absolute.pathname === '/api/auth/login' || absolute.pathname === '/api/auth/bootstrap';
        if (needsAuth && !publicAuth) {
          const token = getToken();
          if (token) {
            const headers = new Headers((init && init.headers) || (input && input.headers) || {});
            if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
            init = Object.assign({}, init || {}, { headers });
          }
        }
      } catch {}
      return nativeFetch(input, init);
    };
    window.__kpppAuthFetchPatched = true;
  }

  async function requireAuth() {
    if (isPublicPage()) return getUser();
    const token = getToken();
    if (!token) {
      location.replace(loginUrl());
      return null;
    }
    try {
      const { response, data } = await api('/api/auth/me');
      if (!response.ok || !data?.success || !data.user) {
        clearSession();
        location.replace(loginUrl());
        return null;
      }
      setSession(token, data.user);
      return data.user;
    } catch {
      clearSession();
      location.replace(loginUrl());
      return null;
    }
  }

  async function login(username, password) {
    const { response, data } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    if (!response.ok || !data?.success || !data.token) {
      throw new Error(data?.message || 'Sign-in failed');
    }
    setSession(data.token, data.user);
    return data.user;
  }

  function logout() {
    clearSession();
    location.replace('/login.html');
  }

  function installUserMenu(user) {
    if (!user || isPublicPage()) return;
    if (document.getElementById('authUserMenu')) return;
    const host = document.querySelector('.topbar-inner') || document.querySelector('header') || document.body;
    const wrap = document.createElement('div');
    wrap.id = 'authUserMenu';
    wrap.className = 'auth-user-menu';
    wrap.innerHTML = `
      <div class="auth-user-meta">
        <strong>${escapeHtml(user.name || user.username)}</strong>
        <span>${escapeHtml(user.role === 'admin' ? 'Administrator' : 'Contractor')}</span>
      </div>
      ${user.role === 'admin' ? '<a class="auth-menu-link" href="/admin.html">Admin</a>' : ''}
      <button type="button" class="auth-menu-btn" id="authLogoutBtn">Sign out</button>`;
    host.appendChild(wrap);
    document.getElementById('authLogoutBtn')?.addEventListener('click', logout);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[c]));
  }

  window.KPPPAuth = {
    getToken,
    getUser,
    setSession,
    clearSession,
    login,
    logout,
    requireAuth,
    api,
    installUserMenu,
    isPublicPage
  };

  // Auto-gate protected pages as soon as this script loads.
  if (!isPublicPage()) {
    document.documentElement.classList.add('auth-pending');
    requireAuth().then((user) => {
      document.documentElement.classList.remove('auth-pending');
      if (user) {
        document.documentElement.classList.add('auth-ready');
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => installUserMenu(user));
        } else {
          installUserMenu(user);
        }
      }
    });
  }
})();
