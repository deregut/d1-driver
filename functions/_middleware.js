// Pages Functions middleware — enforces optional Basic auth on API + WebDAV.
import { authEnabled, checkAuth, unauthorized } from './lib/auth.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);

  const guarded =
    pathname.startsWith('/api/') || pathname.startsWith('/dav') ||
    pathname === '/api' || pathname === '/dav';

  if (guarded && authEnabled(env)) {
    const ok = await checkAuth(request, env);
    if (!ok) return unauthorized();
  }
  return next();
}
