// Shared HTTP Basic auth. Enabled only when BOTH AUTH_USER and AUTH_PASSWORD
// are set (as [vars] in wrangler.toml or Pages project env vars/secrets).
// Protects /api/* and /dav/*; the static frontend stays public.

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authEnabled(env) {
  return Boolean(env.AUTH_USER && env.AUTH_PASSWORD);
}

export async function checkAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(header.slice(6).trim()); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  const [hu, hp] = await Promise.all([sha256hex(user), sha256hex(pass)]);
  const [eu, ep] = await Promise.all([sha256hex(env.AUTH_USER), sha256hex(env.AUTH_PASSWORD)]);
  return timingSafeEqual(hu, eu) && timingSafeEqual(hp, ep);
}

export function unauthorized() {
  return new Response('401 Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="D1 Drive", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
