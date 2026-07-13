import { NextResponse } from 'next/server';
import { verifySession } from '@/lib/session';

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  if (
    pathname === '/login' ||
    pathname === '/api/auth/login' ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // Background cron jobs authenticate with a shared secret header instead of a
  // login session. Only honored for API routes, and only when CRON_SECRET is set.
  const cronSecret = process.env.CRON_SECRET;
  if (
    pathname.startsWith('/api/') &&
    cronSecret &&
    request.headers.get('x-cron-secret') === cronSecret
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get('session')?.value;
  const valid = await verifySession(token, process.env.SESSION_SECRET);

  if (valid) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
