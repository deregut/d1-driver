// Pages Functions middleware — enforces optional Basic auth on API + WebDAV.
import { authEnabled, checkAuth, unauthorized } from './lib/auth.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);

  const guarded =
    pathname.startsWith('/api/') || pathname.startsWith('/dav') ||
    pathname === '/api' || pathname === '/dav';

  // Browsers send CORS preflights without credentials; let them reach the handler
  // (which only answers them when DAV_CORS_ORIGINS is configured).
  const preflight = request.method === 'OPTIONS' &&
    request.headers.has('Access-Control-Request-Method') && Boolean(env.DAV_CORS_ORIGINS);

  if (guarded && !preflight && authEnabled(env)) {
    const ok = await checkAuth(request, env);
    if (!ok) return unauthorized();
  }
  return next();
}
