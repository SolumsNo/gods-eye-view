import { next } from '@vercel/functions';

export const config = {
  matcher: '/:path*',
};

function requireLogin() {
  return new Response('Solums Skynet Spysat - innlogging kreves.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Solums Skynet Spysat", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}

export default function middleware(request: Request) {
  const username = process.env.ZEESTAR_AUTH_USER;
  const password = process.env.ZEESTAR_AUTH_PASSWORD;

  if (!username || !password) {
    return new Response('Solums Skynet Spysat authentication is not configured.', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    });
  }

  const authorization = request.headers.get('authorization') || '';
  const expected = `Basic ${btoa(`${username}:${password}`)}`;

  if (authorization !== expected) {
    return requireLogin();
  }

  return next({
    headers: {
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    },
  });
}
