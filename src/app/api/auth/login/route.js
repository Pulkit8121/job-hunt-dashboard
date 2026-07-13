import { NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth';
import { signSession } from '@/lib/session';

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(request) {
  const { email, password } = await request.json().catch(() => ({}));

  const emailOk = typeof email === 'string' && email.trim().toLowerCase() === (process.env.AUTH_EMAIL || '').toLowerCase();
  const passwordOk = emailOk && typeof password === 'string' &&
    verifyPassword(password, process.env.AUTH_PASSWORD_SALT, process.env.AUTH_PASSWORD_HASH);

  if (!emailOk || !passwordOk) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const expiry = Date.now() + SESSION_MAX_AGE * 1000;
  const token = await signSession(expiry, process.env.SESSION_SECRET);

  const res = NextResponse.json({ ok: true });
  res.cookies.set('session', token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
