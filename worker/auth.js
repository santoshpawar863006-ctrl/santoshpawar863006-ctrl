'use strict';

const USERS_KEY = 'auth:users:v1';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function b64url(bytes) {
  let str = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders
    }
  });
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name || user.username,
    role: user.role || 'user',
    active: user.active !== false,
    created_at: user.created_at || null,
    updated_at: user.updated_at || null
  };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, saltB64url) {
  const salt = saltB64url ? fromB64url(saltB64url) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    key,
    256
  );
  return {
    salt: b64url(salt),
    hash: b64url(bits)
  };
}

async function verifyPassword(password, user) {
  if (!user?.password_salt || !user?.password_hash) return false;
  const next = await hashPassword(password, user.password_salt);
  return next.hash === user.password_hash;
}

async function getUsers(env) {
  if (!env.AUTH_STORE) return { users: [] };
  try {
    const raw = await env.AUTH_STORE.get(USERS_KEY, { type: 'json' });
    if (raw && Array.isArray(raw.users)) return raw;
  } catch {}
  return { users: [] };
}

async function saveUsers(env, store) {
  if (!env.AUTH_STORE) throw new Error('AUTH_STORE KV binding is missing');
  await env.AUTH_STORE.put(USERS_KEY, JSON.stringify(store));
}

async function ensureAdminSeeded(env) {
  if (!env.AUTH_STORE) {
    return { ok: false, message: 'AUTH_STORE not configured' };
  }
  const store = await getUsers(env);
  const adminUser = normalizeUsername(env.ADMIN_USERNAME || 'admin');
  const adminPass = String(env.ADMIN_PASSWORD || 'Admin@KPPP2026!').trim();
  const adminName = String(env.ADMIN_NAME || 'System Administrator').trim();
  let changed = false;
  let admin = store.users.find((u) => normalizeUsername(u.username) === adminUser);

  if (!admin) {
    const pwd = await hashPassword(adminPass);
    admin = {
      id: crypto.randomUUID(),
      username: adminUser,
      name: adminName,
      role: 'admin',
      active: true,
      password_salt: pwd.salt,
      password_hash: pwd.hash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    store.users.push(admin);
    changed = true;
  } else if (String(env.ADMIN_RESET || '').toLowerCase() === 'true') {
    const pwd = await hashPassword(adminPass);
    admin.password_salt = pwd.salt;
    admin.password_hash = pwd.hash;
    admin.role = 'admin';
    admin.active = true;
    admin.name = adminName;
    admin.updated_at = new Date().toISOString();
    changed = true;
  }

  if (changed) await saveUsers(env, store);
  return { ok: true, admin: publicUser(admin), seeded: changed };
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(sig);
}

async function createSessionToken(env, user) {
  const secret = String(env.SESSION_SECRET || env.ADMIN_PASSWORD || 'kppp-local-session-secret').trim();
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    sub: user.id,
    username: user.username,
    role: user.role,
    name: user.name || user.username,
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  })));
  const sig = await hmacSign(secret, `${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

async function verifySessionToken(env, token) {
  if (!token || token.split('.').length !== 3) return null;
  const [header, payload, sig] = token.split('.');
  const secret = String(env.SESSION_SECRET || env.ADMIN_PASSWORD || 'kppp-local-session-secret').trim();
  const expected = await hmacSign(secret, `${header}.${payload}`);
  if (expected !== sig) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (!body?.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

function bearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const url = new URL(request.url);
  return (url.searchParams.get('token') || '').trim() || null;
}

async function requireUser(request, env, { admin = false } = {}) {
  await ensureAdminSeeded(env);
  const token = bearerToken(request);
  if (!token) return { error: json({ success: false, message: 'Authentication required.' }, 401) };
  const session = await verifySessionToken(env, token);
  if (!session) return { error: json({ success: false, message: 'Session expired. Please sign in again.' }, 401) };
  const store = await getUsers(env);
  const user = store.users.find((u) => u.id === session.sub || normalizeUsername(u.username) === normalizeUsername(session.username));
  if (!user || user.active === false) return { error: json({ success: false, message: 'Account is inactive or missing.' }, 403) };
  if (admin && user.role !== 'admin') return { error: json({ success: false, message: 'Admin access required.' }, 403) };
  return { user, token, session };
}

async function handleLogin(request, env) {
  if (!env.AUTH_STORE) {
    return json({ success: false, message: 'Auth storage is not configured on this Worker.' }, 503);
  }
  await ensureAdminSeeded(env);
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const username = normalizeUsername(body.username || body.email);
  const password = String(body.password || '');
  if (!username || !password) {
    return json({ success: false, message: 'Username and password are required.' }, 400);
  }
  const store = await getUsers(env);
  const user = store.users.find((u) => normalizeUsername(u.username) === username);
  if (!user || user.active === false) {
    return json({ success: false, message: 'Invalid username or password.' }, 401);
  }
  const ok = await verifyPassword(password, user);
  if (!ok) return json({ success: false, message: 'Invalid username or password.' }, 401);
  const token = await createSessionToken(env, user);
  return json({
    success: true,
    token,
    user: publicUser(user),
    expires_in: SESSION_TTL_SECONDS
  });
}

async function handleMe(request, env) {
  const auth = await requireUser(request, env);
  if (auth.error) return auth.error;
  return json({ success: true, user: publicUser(auth.user) });
}

async function listUsers(request, env) {
  const auth = await requireUser(request, env, { admin: true });
  if (auth.error) return auth.error;
  const store = await getUsers(env);
  const users = store.users
    .map(publicUser)
    .sort((a, b) => String(a.username).localeCompare(String(b.username)));
  return json({ success: true, users, count: users.length });
}

async function createUser(request, env) {
  const auth = await requireUser(request, env, { admin: true });
  if (auth.error) return auth.error;
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  const name = String(body.name || username).trim();
  const role = String(body.role || 'user').toLowerCase() === 'admin' ? 'admin' : 'user';
  if (!username || username.length < 3) return json({ success: false, message: 'Username must be at least 3 characters.' }, 400);
  if (!/^[a-z0-9._-]+$/.test(username)) return json({ success: false, message: 'Username may only contain letters, numbers, dot, underscore, hyphen.' }, 400);
  if (password.length < 8) return json({ success: false, message: 'Password must be at least 8 characters.' }, 400);

  const store = await getUsers(env);
  if (store.users.some((u) => normalizeUsername(u.username) === username)) {
    return json({ success: false, message: 'That username already exists.' }, 409);
  }
  const pwd = await hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username,
    name,
    role,
    active: true,
    password_salt: pwd.salt,
    password_hash: pwd.hash,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: auth.user.username
  };
  store.users.push(user);
  await saveUsers(env, store);
  return json({ success: true, user: publicUser(user) }, 201);
}

async function updateUser(request, env, userId) {
  const auth = await requireUser(request, env, { admin: true });
  if (auth.error) return auth.error;
  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const store = await getUsers(env);
  const user = store.users.find((u) => u.id === userId);
  if (!user) return json({ success: false, message: 'User not found.' }, 404);

  if (body.name !== undefined) user.name = String(body.name || user.username).trim();
  if (body.role !== undefined) {
    const role = String(body.role).toLowerCase() === 'admin' ? 'admin' : 'user';
    if (user.id === auth.user.id && role !== 'admin') {
      return json({ success: false, message: 'You cannot remove your own admin role.' }, 400);
    }
    user.role = role;
  }
  if (body.active !== undefined) {
    const active = Boolean(body.active);
    if (user.id === auth.user.id && !active) {
      return json({ success: false, message: 'You cannot deactivate your own account.' }, 400);
    }
    user.active = active;
  }
  if (body.password) {
    const password = String(body.password);
    if (password.length < 8) return json({ success: false, message: 'Password must be at least 8 characters.' }, 400);
    const pwd = await hashPassword(password);
    user.password_salt = pwd.salt;
    user.password_hash = pwd.hash;
  }
  user.updated_at = new Date().toISOString();
  await saveUsers(env, store);
  return json({ success: true, user: publicUser(user) });
}

async function deleteUser(request, env, userId) {
  const auth = await requireUser(request, env, { admin: true });
  if (auth.error) return auth.error;
  const store = await getUsers(env);
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx < 0) return json({ success: false, message: 'User not found.' }, 404);
  if (store.users[idx].id === auth.user.id) {
    return json({ success: false, message: 'You cannot delete your own account.' }, 400);
  }
  const removed = store.users.splice(idx, 1)[0];
  await saveUsers(env, store);
  return json({ success: true, deleted: publicUser(removed) });
}

async function handleAuthRoutes(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/me' && method === 'GET') return handleMe(request, env);
  if (path === '/api/auth/bootstrap' && method === 'POST') {
    const result = await ensureAdminSeeded(env);
    return json({ success: result.ok, ...result });
  }

  if (path === '/api/admin/users' && method === 'GET') return listUsers(request, env);
  if (path === '/api/admin/users' && method === 'POST') return createUser(request, env);

  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch) {
    const id = decodeURIComponent(userMatch[1]);
    if (method === 'PATCH' || method === 'PUT') return updateUser(request, env, id);
    if (method === 'DELETE') return deleteUser(request, env, id);
  }

  return null;
}

async function requireAuthOrError(request, env) {
  const auth = await requireUser(request, env);
  if (auth.error) return auth.error;
  return null;
}

export {
  handleAuthRoutes,
  requireAuthOrError,
  requireUser,
  ensureAdminSeeded,
  json as authJson
};
