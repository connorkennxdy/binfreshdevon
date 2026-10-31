// Records calls to Resend, Twilio and Google (OAuth + Calendar) so tests can assert on them.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

export async function startFakeServices() {
  const calls = [];
  const events = new Map(); // google event id -> event
  const calendars = new Map();
  let googleDown = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const parsed = (req.headers['content-type'] || '').includes('json') ? (body ? JSON.parse(body) : {}) : Object.fromEntries(new URLSearchParams(body));
      calls.push({ method: req.method, path: u.pathname, body: parsed, auth: req.headers.authorization });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (u.pathname === '/emails') return send(200, { id: 'em_' + randomBytes(4).toString('hex') });
      if (/\/2010-04-01\/Accounts\/\w+\/Messages\.json$/.test(u.pathname)) return send(201, { sid: 'SM' + randomBytes(8).toString('hex') });
      if (u.pathname === '/token') {
        if (parsed.grant_type === 'authorization_code') return send(200, { access_token: 'at_' + parsed.code, refresh_token: 'rt_' + parsed.code, expires_in: 3600, scope: 'openid email', id_token: 'x' });
        if (parsed.refresh_token === 'rt_revoked') return send(400, { error: 'invalid_grant' });
        return send(200, { access_token: 'at_' + randomBytes(4).toString('hex'), expires_in: 3600 });
      }
      if (u.pathname === '/v1/userinfo') {
        const email = (req.headers.authorization || '').replace('Bearer at_', '');
        return send(200, { email, email_verified: true });
      }
      if (u.pathname === '/revoke') return send(200, {});
      if (u.pathname.startsWith('/calendar/v3/')) {
        if (googleDown) return send(503, { error: { code: 503, message: 'backendError' } });
        if (req.method === 'POST' && u.pathname === '/calendar/v3/calendars') { const c = { id: 'cal_' + randomBytes(4).toString('hex') + '@group.calendar.google.com', ...parsed }; calendars.set(c.id, c); return send(200, c); }
        const mc = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)$/);
        if (mc && req.method === 'GET') { const c = calendars.get(decodeURIComponent(mc[1])); return c ? send(200, c) : send(404, { error: { code: 404 } }); }
        const m = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
        if (m) {
          const evId = m[2] && decodeURIComponent(m[2]);
          if (req.method === 'POST') { const e = { id: 'ev' + randomBytes(5).toString('hex'), ...parsed, calendarId: decodeURIComponent(m[1]) }; events.set(e.id, e); return send(200, e); }
          if (req.method === 'PUT') { if (!events.has(evId)) return send(404, { error: { code: 404 } }); const e = { ...parsed, id: evId }; events.set(evId, e); return send(200, e); }
          if (req.method === 'DELETE') { if (!events.has(evId)) return send(410, { error: { code: 410 } }); events.delete(evId); res.writeHead(204); return res.end(); }
        }
      }
      send(404, { error: 'fake: no route ' + u.pathname });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, calls, events, calendars,
    setGoogleDown(v) { googleDown = v; },
    emails: () => calls.filter((c) => c.path === '/emails').map((c) => c.body),
    sms: () => calls.filter((c) => c.path.endsWith('/Messages.json')).map((c) => c.body),
    reset() { calls.length = 0; },
    close: () => new Promise((r) => server.close(r)),
  };
}
