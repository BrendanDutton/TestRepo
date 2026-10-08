// Calendar relay for "My Day" (Cloudflare Worker, free plan).
//
// Why it exists: Google Calendar's private iCal link can't be read directly by a web page
// (no CORS headers), and putting it in the app would expose it. This relay keeps the link
// as a secret, fetches it for you, and only answers requests that carry your access key.
//
// Settings (Worker -> Settings -> Variables and Secrets):
//   CALENDAR_URLS   secret   one or more "Secret address in iCal format" links, separated by spaces
//   ACCESS_KEY      secret   a long random string; the app sends it as ?key=...
//   ALLOWED_ORIGIN  variable optional, e.g. https://brendandutton.github.io (the app's address)

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const key = new URL(request.url).searchParams.get('key') || '';
    if (!env.ACCESS_KEY || !safeEqual(key, env.ACCESS_KEY)) {
      return new Response('Unauthorized', { status: 401, headers: cors });
    }

    const urls = (env.CALENDAR_URLS || '').split(/[\s,]+/).filter((u) => u.startsWith('https://'));
    if (!urls.length) return new Response('CALENDAR_URLS is not set', { status: 500, headers: cors });

    // A calendar that fails to load is skipped so one bad link doesn't blank the others.
    const parts = await Promise.all(urls.map(async (u) => {
      try {
        const res = await fetch(u);
        return res.ok ? await res.text() : '';
      } catch { return ''; }
    }));
    const body = parts.filter(Boolean).join('\r\n');
    if (!body) return new Response('Could not load any calendar', { status: 502, headers: cors });

    return new Response(body, {
      headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
