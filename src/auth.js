const crypto = require('node:crypto');

const COOKIE_NAME = 'esim_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function safeEqualString(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // Perform dummy comparison to keep timing consistent
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

function createAuthManager(config = {}) {
  const username = (config.username ?? process.env.AUTH_USERNAME ?? '').trim();
  const password = config.password ?? process.env.AUTH_PASSWORD ?? '';
  const enabled = Boolean(username && password);
  const secret =
    (config.secret ?? process.env.AUTH_SECRET ?? '').trim() ||
    crypto.randomBytes(32).toString('hex');

  function signPayload(payloadB64) {
    return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  }

  function createSessionToken(user) {
    const payload = {
      u: user,
      exp: Date.now() + SESSION_TTL_MS,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = signPayload(payloadB64);
    return `${payloadB64}.${sig}`;
  }

  function verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dotIdx = token.indexOf('.');
    if (dotIdx === -1) return null;
    const payloadB64 = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expectedSig = signPayload(payloadB64);
    if (!safeEqualString(sig, expectedSig)) return null;

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (!payload || typeof payload.u !== 'string' || typeof payload.exp !== 'number') {
        return null;
      }
      if (Date.now() > payload.exp) return null;
      if (!safeEqualString(payload.u, username)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function verifyCredentials(inputUser, inputPass) {
    if (!enabled) return true;
    const userOk = safeEqualString(String(inputUser ?? '').trim(), username);
    const passOk = safeEqualString(String(inputPass ?? ''), password);
    return userOk && passOk;
  }

  function getSession(req) {
    if (!enabled) return { authenticated: true, username: null };
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    const payload = verifySessionToken(token);
    if (!payload) return { authenticated: false, username: null };
    return { authenticated: true, username: payload.u };
  }

  function setSessionCookie(req, res, user) {
    const token = createSessionToken(user);
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isHttps) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearSessionCookie(res) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
    );
  }

  function requireAuth(req, res, next) {
    if (!enabled) return next();
    const session = getSession(req);
    if (!session.authenticated) {
      return res.status(401).json({ error: '未登录或登录已过期，请先登录' });
    }
    req.user = session.username;
    return next();
  }

  return {
    enabled,
    username,
    verifyCredentials,
    getSession,
    setSessionCookie,
    clearSessionCookie,
    requireAuth,
  };
}

module.exports = { createAuthManager };
