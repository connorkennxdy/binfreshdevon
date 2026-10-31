/* Bin Fresh Rounds — Tom's app. No dependencies, no build step. Hash routes:
   #/today[/YYYY-MM-DD]  #/visit/:id  #/calendar[/YYYY-MM-DD]  #/customers  #/customer/:id  #/customers/new  #/money  #/settings  #/signin */
(function () {
  'use strict';
  if (window.top !== window.self) { window.top.location = window.location; return; } // frame-buster
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});

  // ---------- tiny DOM helper ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function svg(path) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = path; return s; // constant icon paths only
  }
  var I = {
    map: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    call: '<path d="M5 4h3.5l1.6 4.2-2.2 1.4a11 11 0 0 0 6.5 6.5l1.4-2.2L20 15.5V19a2 2 0 0 1-2.2 2A16 16 0 0 1 3 6.2 2 2 0 0 1 5 4z"/>',
    text: '<path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/>',
    tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    prev: '<path d="M15 5l-7 7 7 7"/>', next: '<path d="M9 5l7 7-7 7"/>',
    grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/>',
    more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3.2"/>',
  };
  var view = document.getElementById('view');
  var gbp = function (p) { return '£' + ((p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function addDays(s, n) { var d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function todayLondon() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  function shortDate(s) { var d = new Date(s + 'T00:00:00Z'); return DAYS[(d.getUTCDay() + 6) % 7] + ' ' + d.getUTCDate() + ' ' + d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }); }
  function when(iso) { return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '—'; }

  // ---------- api ----------
  async function api(path, opts) {
    opts = opts || {};
    var r = await fetch('/api/admin/' + path, { method: opts.method || 'GET', credentials: 'same-origin', headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    var d = await r.json().catch(function () { return {}; });
    if (r.status === 401) { go('#/signin'); throw new Error('Sign in required'); }
    if (!r.ok) throw new Error(d.error || 'Something went wrong');
    return d;
  }
  function toast(msg, ms) {
    var t = document.getElementById('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }
  async function run(btn, fn, okMsg) {
    if (btn) btn.disabled = true;
    try { var r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { if (e.message !== 'Sign in required') toast(e.message, 4000); throw e; }
    finally { if (btn) btn.disabled = false; }
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

  // ---------- sheet ----------
  function sheet(title, build) {
    var host = document.getElementById('sheetHost');
    var prev = document.activeElement;
    var close = function () { host.innerHTML = ''; document.removeEventListener('keydown', esc); if (prev && prev.focus) prev.focus(); };
    var esc = function (e) { if (e.key === 'Escape') close(); };
    var body = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'grab', 'aria-hidden': 'true' }),
      h('div', { class: 'row between' }, h('h2', { text: title }), h('button', { class: 'btn-ghost', type: 'button', onclick: close, text: 'Close' })));
    build(body, close);
    var scrim = h('div', { class: 'scrim', onclick: function (e) { if (e.target === scrim) close(); } }, body);
    host.innerHTML = ''; host.append(scrim);
    document.addEventListener('keydown', esc);
    var f = body.querySelector('input,select,textarea,button:not(.btn-ghost)'); if (f) f.focus();
    return close;
  }

  function payBadge(v) {
    var m = { paid: ['paid', 'Paid'], due: ['due', 'Due 7am'], unpaid: ['due', 'Unpaid'], failed: ['bad', 'Payment failed'], refunded: ['est', 'Refunded'] }[v.payment_status] || ['due', v.payment_status];
    if (v.payment_status === 'due' && v.date < todayLondon()) m = ['due', 'Due'];
    return h('span', { class: 'badge ' + m[0], text: m[1] });
  }
  function mapsUrl(v) { return 'https://maps.apple.com/?q=' + encodeURIComponent(v.address + ', ' + v.postcode); }
  function smsUrl(v) { return 'sms:' + v.phone + '&body=' + encodeURIComponent('Hi ' + v.name.split(' ')[0] + ', it\'s Tom from Bin Fresh. '); }

  // ================= SIGN IN =================
  async function signin(params) {
    document.getElementById('tabs').hidden = true;
    var info = await fetch('/api/admin/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).catch(function () { return {}; });
    if (info.authed) return go('#/today');
    var err = h('p', { class: 'err', role: 'alert', text: params.get('error') || '' });
    var pass = h('input', { type: 'password', id: 'pass', autocomplete: 'current-password', required: true });
    var btn = h('button', { class: 'btn block', type: 'submit', text: 'Continue' });
    var form = h('form', { class: 'card sec', onsubmit: async function (e) {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        var r = await fetch('/api/admin/session', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: pass.value }) });
        var d = await r.json().catch(function () { return {}; });
        if (r.ok) { pass.value = ''; go('#/today'); } else err.textContent = d.error || 'Sign in failed.';
      } catch (x) { err.textContent = 'Could not reach the server.'; }
      btn.disabled = false;
    } },
      h('h1', { text: 'Sign in' }),
      info.google_configured ? h('a', { class: 'gbtn', href: '/api/google/signin' }, h('span', { 'aria-hidden': 'true', text: 'G' }), 'Sign in with Google') : null,
      info.google_configured ? h('div', { class: 'divider' }) : null,
      h('div', { class: 'field' }, h('label', { for: 'pass', text: 'Passcode' }), pass),
      err, btn,
      info.passcode_configured === false ? h('p', { class: 'note', text: 'No passcode is set. Add APP_PASSCODE in Netlify.' }) : null);
    view.replaceChildren(h('div', { class: 'login' }, form));
  }

  // ================= TODAY =================
  async function today(date) {
    date = date || todayLondon();
    var d = await api('today?date=' + date);
    var title = d.is_today ? 'Today' : shortDate(d.date);
    var stats = h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', { text: d.totals.done + '/' + d.totals.total }), h('span', { text: 'visits done' })),
      h('div', { class: 'stat' }, h('b', { text: gbp(d.totals.expected_pence) }), h('span', { text: 'expected' })),
      h('div', { class: 'stat' }, h('b', { text: gbp(d.totals.collected_pence) }), h('span', { text: 'collected' })));
    var banners = [];
    if (d.failed.length) banners.push(h('div', { class: 'banner red', role: 'alert' },
      h('b', { text: d.failed.length === 1 ? '1 payment failed for today' : d.failed.length + ' payments failed for today' }),
      h('ul', null, d.failed.map(function (f) { return h('li', null, h('a', { href: '#/visit/' + f.id, text: f.name + ' · ' + gbp(f.amount_pence) })); })),
      h('span', { text: 'Stripe is retrying. You decide whether to clean.' })));
    if (d.attention.length) banners.push(h('div', { class: 'banner amber' },
      h('b', { text: 'Needs attention' }),
      h('ul', null, d.attention.map(function (a) { return h('li', null, h('a', { href: '#/visit/' + a.id, text: a.name + ', ' + a.date_short + ' ' + a.window_label + ': ' + a.attention })); }))));
    if (d.blocked) banners.push(h('div', { class: 'banner amber', text: 'This day is blocked: ' + d.blocked }));

    var nav = h('div', { class: 'daynav' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous day', onclick: function () { go('#/today/' + prevDay(date)); } }, svg(I.prev)),
      d.is_today ? null : h('button', { class: 'btn sec2', type: 'button', text: 'Today', onclick: function () { go('#/today'); } }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next day', onclick: function () { go('#/today/' + nextDay(date)); } }, svg(I.next)));

    var body = h('div', { class: 'stack' });
    d.windows.forEach(function (w) {
      var list = h('div', { class: 'stack', 'data-window': w.id });
      body.append(h('div', { class: 'wtitle' }, h('h2', { text: w.label }), h('span', { class: 'sub', text: w.visits.length + (w.visits.length === 1 ? ' visit' : ' visits') })));
      if (!w.visits.length) list.append(h('div', { class: 'card empty', text: 'Nothing booked.' }));
      w.visits.forEach(function (v) { list.append(visitCard(v, date, w.id)); });
      body.append(list);
    });
    view.replaceChildren(h('div', { class: 'head' }, h('div', null, h('h1', { text: title }), h('p', { class: 'sub', text: d.date_long })), nav), h('div', { class: 'stack' }, banners, stats, body));
    swipe(view, function () { go('#/today/' + nextDay(date)); }, function () { go('#/today/' + prevDay(date)); });
  }
  function prevDay(s) { var p = addDays(s, -1); return new Date(p + 'T00:00:00Z').getUTCDay() === 0 ? addDays(p, -1) : p; }
  function nextDay(s) { var n = addDays(s, 1); return new Date(n + 'T00:00:00Z').getUTCDay() === 0 ? addDays(n, 1) : n; }

  function visitCard(v, date, win) {
    var doneLabel = v.status === 'done' ? 'Done' : v.status === 'skipped' ? 'Skipped: ' + (v.skip_reason || '') : 'Done';
    var doneBtn = h('button', { class: 'done-btn' + (v.status === 'done' ? ' is-done' : v.status === 'skipped' ? ' is-skipped' : ''), type: 'button', 'aria-describedby': 'hint-' + v.id }, svg(I.tick), doneLabel);
    longPress(doneBtn, function () { if (v.status === 'scheduled') markDone(v, doneBtn); else undo(v, doneBtn); }, function () { skipSheet(v); });
    var card = h('article', { class: 'visit' + (v.status !== 'scheduled' ? ' ' + v.status : ''), 'data-id': v.id },
      h('div', { class: 'top' },
        h('div', { class: 'who' },
          h('a', { class: 'name', href: '#/visit/' + v.id, text: v.name }),
          h('div', { class: 'addr', text: v.address + ', ' + v.postcode })),
        payBadge(v),
        h('button', { class: 'handle', type: 'button', 'aria-label': 'Reorder ' + v.name + '. Drag, or use arrow keys.' }, svg(I.grip))),
      h('div', { class: 'items', text: v.items_text }),
      v.access_notes ? h('div', { class: 'access', text: v.access_notes }) : null,
      v.notes ? h('div', { class: 'sub', text: 'Note: ' + v.notes }) : null,
      v.attention ? h('div', { class: 'sub', text: v.attention }) : null,
      h('div', { class: 'acts' },
        h('a', { class: 'act', href: mapsUrl(v), target: '_blank', rel: 'noopener' }, svg(I.map), 'Maps'),
        h('a', { class: 'act', href: 'tel:' + v.phone }, svg(I.call), 'Call'),
        h('a', { class: 'act', href: smsUrl(v) }, svg(I.text), 'Text'),
        doneBtn),
      h('div', { class: 'hint', id: 'hint-' + v.id, text: v.status === 'scheduled' ? 'Hold for Skip' : 'Tap to undo' }));
    dragSort(card, date, win);
    return card;
  }
  function longPress(el, onTap, onLong) {
    var t = null, fired = false;
    var start = function (e) { if (e.button > 0) return; fired = false; t = setTimeout(function () { fired = true; if (navigator.vibrate) navigator.vibrate(15); onLong(); }, 550); };
    var cancel = function () { clearTimeout(t); };
    el.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { el.addEventListener(ev, cancel); });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.addEventListener('click', function (e) { if (fired) { e.preventDefault(); return; } onTap(); });
    el.addEventListener('keydown', function (e) { if ((e.key === 's' || e.key === 'S') || (e.key === 'Enter' && e.shiftKey)) { e.preventDefault(); onLong(); } });
  }
  async function markDone(v, btn) { await run(btn, function () { return api('visits/' + v.id + '/done', { method: 'POST', body: {} }); }, 'Marked done'); route(); }
  async function undo(v, btn) { await run(btn, function () { return api('visits/' + v.id + '/undo', { method: 'POST', body: {} }); }, 'Undone'); route(); }
  function skipSheet(v) {
    sheet('Skip ' + v.name, function (body, close) {
      body.append(h('p', { class: 'sub', text: 'Why are you skipping this visit?' }));
      var opts = h('div', { class: 'opts' });
      ['Rain', 'Bins not out', 'No access', 'Bins still full', 'Other'].forEach(function (r) {
        opts.append(h('button', { class: 'opt', type: 'button', onclick: async function (e) {
          var res = await run(e.currentTarget, function () { return api('visits/' + v.id + '/skip', { method: 'POST', body: { reason: r } }); }, 'Skipped');
          close();
          if (res.needs_decision) decideSheet(v); else route();
        } }, h('span', { class: 't', text: r })));
      });
      body.append(opts);
    });
  }
  function decideSheet(v) {
    sheet('This visit was paid', function (body, close) {
      body.append(h('p', { class: 'sub', text: v.name + ' has paid ' + gbp(v.amount_pence) + '. Move the clean to another day, or refund it.' }),
        h('button', { class: 'btn block', type: 'button', text: 'Move to another day', onclick: function () { close(); moveSheet(v); } }),
        h('button', { class: 'btn sec2 block', type: 'button', text: 'Refund ' + gbp(v.amount_pence), onclick: async function (e) {
          await run(e.currentTarget, function () { return api('visits/' + v.id + '/refund', { method: 'POST', body: { cancel: true } }); }, 'Refunded'); close(); route();
        } }),
        h('button', { class: 'btn-ghost', type: 'button', text: 'Decide later', onclick: function () { close(); route(); } }));
    });
  }
  function moveSheet(v) {
    sheet('Move ' + v.name, function (body, close) {
      var date = h('input', { type: 'date', id: 'mvDate', value: nextDay(v.date) });
      var win = v.window;
      var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Window' });
      [['14-16', '2–4pm'], ['16-18', '4–6pm']].forEach(function (x) {
        seg.append(h('button', { type: 'button', 'aria-pressed': String(x[0] === win), text: x[1], onclick: function (e) { win = x[0]; seg.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === e.currentTarget)); }); } }));
      });
      var force = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Allow over the cap', onclick: function () { force.setAttribute('aria-checked', String(force.getAttribute('aria-checked') !== 'true')); } });
      var notify = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'true', 'aria-label': 'Tell the customer', onclick: function () { notify.setAttribute('aria-checked', String(notify.getAttribute('aria-checked') !== 'true')); } });
      var err = h('p', { class: 'err', role: 'alert' });
      body.append(h('div', { class: 'field' }, h('label', { for: 'mvDate', text: 'New day' }), date), seg,
        h('div', { class: 'toggle' }, h('span', { text: 'Allow over the cap' }), force),
        h('div', { class: 'toggle' }, h('span', { text: 'Email and text the customer' }), notify), err,
        h('button', { class: 'btn block', type: 'button', text: 'Move visit', onclick: async function (e) {
          err.textContent = '';
          try { await run(e.currentTarget, function () { return api('visits/' + v.id + '/move', { method: 'POST', body: { date: date.value, window: win, force: force.getAttribute('aria-checked') === 'true', notify: notify.getAttribute('aria-checked') === 'true' } }); }, 'Moved'); close(); route(); }
          catch (x) { err.textContent = x.message; }
        } }));
    });
  }
  // drag to reorder within a window (pointer events; keyboard: arrow keys on the handle)
  function dragSort(card, date, win) {
    var handle = card.querySelector('.handle');
    var save = function (list) {
      var ids = Array.prototype.map.call(list.querySelectorAll('.visit'), function (c) { return c.dataset.id; });
      api('visits/reorder', { method: 'POST', body: { date: date, window: win, ids: ids } }).then(function () { toast('Order saved'); }).catch(function () {});
    };
    handle.addEventListener('keydown', function (e) {
      var list = card.parentNode;
      if (e.key === 'ArrowUp' && card.previousElementSibling) { list.insertBefore(card, card.previousElementSibling); handle.focus(); save(list); e.preventDefault(); }
      if (e.key === 'ArrowDown' && card.nextElementSibling) { list.insertBefore(card.nextElementSibling, card); handle.focus(); save(list); e.preventDefault(); }
    });
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var list = card.parentNode, startY = e.clientY, moved = false;
      handle.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
      var move = function (ev) {
        var dy = ev.clientY - startY; card.style.transform = 'translateY(' + dy + 'px)';
        var sib = dy < 0 ? card.previousElementSibling : card.nextElementSibling;
        if (sib && sib.classList.contains('visit')) {
          var r = sib.getBoundingClientRect(), mid = r.top + r.height / 2;
          if ((dy < 0 && ev.clientY < mid) || (dy > 0 && ev.clientY > mid)) {
            if (dy < 0) list.insertBefore(card, sib); else list.insertBefore(sib, card);
            startY = ev.clientY; card.style.transform = ''; moved = true;
          }
        }
      };
      var up = function () {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
        card.classList.remove('dragging'); card.style.transform = '';
        if (moved) save(list);
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
  }
  function swipe(el, left, right) {
    var x0 = null, y0 = null;
    el.ontouchstart = function (e) { if (e.target.closest('.handle,.done-btn,input,select,textarea')) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; };
    el.ontouchend = function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) (dx < 0 ? left : right)();
      x0 = null;
    };
  }

  // ================= VISIT =================
  async function visitPage(id) {
    var d = await api('visits/' + id);
    var v = d.visit;
    var acts = h('div', { class: 'row' });
    if (v.status === 'scheduled') {
      acts.append(h('button', { class: 'btn', type: 'button', text: 'Mark done', onclick: function (e) { markDone(v, e.currentTarget); } }),
        h('button', { class: 'btn sec2', type: 'button', text: 'Skip', onclick: function () { skipSheet(v); } }));
    } else if (v.status === 'done' || v.status === 'skipped') acts.append(h('button', { class: 'btn sec2', type: 'button', text: 'Undo ' + v.status, onclick: function (e) { undo(v, e.currentTarget); } }));
    if (v.status === 'scheduled' || v.status === 'skipped') acts.append(h('button', { class: 'btn sec2', type: 'button', text: 'Move', onclick: function () { moveSheet(v); } }));
    if (v.payment_status === 'paid') acts.append(h('button', { class: 'btn sec2', type: 'button', text: 'Refund', onclick: function () {
      sheet('Refund ' + gbp(v.amount_pence) + '?', function (body, close) {
        body.append(h('p', { class: 'sub', text: 'The money goes back to ' + v.name + '\'s card in 5 to 10 days.' }),
          h('button', { class: 'btn danger block', type: 'button', text: 'Refund ' + gbp(v.amount_pence), onclick: async function (e) { await run(e.currentTarget, function () { return api('visits/' + v.id + '/refund', { method: 'POST', body: {} }); }, 'Refunded'); close(); route(); } }));
      });
    } }));
    var note = h('textarea', { id: 'vnote', maxlength: '500' }); note.value = v.notes || '';
    view.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h1', { text: v.name }), h('p', { class: 'sub', text: v.date_long + ', ' + v.window_label + (v.original_date !== v.date ? ' (billing date ' + shortDate(v.original_date) + ')' : '') }))),
      h('div', { class: 'stack' },
        v.payment_status === 'failed' ? h('div', { class: 'banner red', role: 'alert', text: 'The card payment for this visit failed. Stripe is retrying and has asked the customer to update their card.' }) : null,
        v.attention ? h('div', { class: 'banner amber' }, h('span', { text: v.attention }), h('button', { class: 'btn-ghost', type: 'button', text: 'Clear flag', onclick: async function (e) { await run(e.currentTarget, function () { return api('visits/' + v.id + '/clear-flag', { method: 'POST', body: {} }); }); route(); } })) : null,
        h('div', { class: 'card sec' },
          h('div', { class: 'row between' }, h('span', { text: v.items_text }), payBadge(v)),
          h('div', null, h('div', { text: v.address + ', ' + v.postcode }), v.access_notes ? h('div', { class: 'access sub mt', text: 'Access: ' + v.access_notes }) : null),
          h('div', { class: 'acts' },
            h('a', { class: 'act', href: mapsUrl(v), target: '_blank', rel: 'noopener' }, svg(I.map), 'Maps'),
            h('a', { class: 'act', href: 'tel:' + v.phone }, svg(I.call), 'Call'),
            h('a', { class: 'act', href: smsUrl(v) }, svg(I.text), 'Text'),
            h('a', { class: 'act', href: '#/customer/' + v.customer_id, text: 'Customer' })),
          h('div', { class: 'ln tot' }, h('span', { text: 'Amount' }), h('span', { text: gbp(v.amount_pence) })),
          h('div', { class: 'ln' }, h('span', { text: 'Status' }), h('span', { text: v.status + (v.skip_reason ? ' (' + v.skip_reason + ')' : '') })),
          d.payments.map(function (p) { return h('div', { class: 'ln' }, h('span', { text: 'Payment ' + when(p.paid_at) }), h('span', { text: gbp(p.amount_pence) + (p.fee_pence != null ? ' · fee ' + gbp(p.fee_pence) : '') + (p.refunded_pence ? ' · refunded ' + gbp(p.refunded_pence) : '') })); })),
        acts,
        h('div', { class: 'card sec' }, h('div', { class: 'field' }, h('label', { for: 'vnote', text: 'Note for this visit (shows in the calendar)' }), note),
          h('button', { class: 'btn sec2', type: 'button', text: 'Save note', onclick: function (e) { run(e.currentTarget, function () { return api('visits/' + v.id + '/note', { method: 'POST', body: { notes: note.value } }); }, 'Saved'); } }))));
  }

  // ================= CALENDAR =================
  async function calendar(week) {
    var d = await api('calendar' + (week ? '?week=' + week : ''));
    var grid = h('div', { class: 'week' });
    d.days.forEach(function (day) {
      var whole = day.blocks.find(function (b) { return !b.window; });
      grid.append(h('button', { class: 'wday' + (day.is_today ? ' today' : ''), type: 'button', 'aria-label': day.long + ': ' + day.windows.map(function (w) { return w.label + ' ' + (w.blocked ? 'blocked' : w.used + ' of ' + w.cap); }).join(', '), onclick: function () { daySheet(day); } },
        h('span', { class: 'dl', text: day.label }),
        day.windows.map(function (w) {
          return h('span', { class: 'wslot' + (w.blocked ? ' blocked' : w.used >= w.cap ? ' full' : '') + (w.override != null ? ' ovr' : '') }, h('span', { text: w.label }), h('b', { text: w.blocked ? 'off' : w.used + '/' + w.cap }));
        }),
        whole ? h('span', { class: 'wnote', text: whole.reason || 'Blocked' }) : day.blocks.map(function (b) { return h('span', { class: 'wnote', text: (b.reason || 'Blocked') }); })));
    });
    view.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h1', { text: 'Calendar' }), h('p', { class: 'sub', text: 'Week of ' + shortDate(d.week) + '. Tap a day to block it or change its caps.' })),
        h('div', { class: 'daynav' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous week', onclick: function () { go('#/calendar/' + d.prev); } }, svg(I.prev)),
          h('button', { class: 'btn sec2', type: 'button', text: 'This week', onclick: function () { go('#/calendar'); } }),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next week', onclick: function () { go('#/calendar/' + d.next); } }, svg(I.next)))),
      grid, h('p', { class: 'sub mt', text: '* this day has its own cap' }));
    swipe(view, function () { go('#/calendar/' + d.next); }, function () { go('#/calendar/' + d.prev); });
  }
  function daySheet(day) {
    sheet(day.long, function (body, close) {
      var reason = h('input', { type: 'text', id: 'blkReason', placeholder: 'Holiday, van service…', maxlength: '120' });
      var target = null; // null = whole day
      var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'What to block' });
      [[null, 'Whole day']].concat(day.windows.map(function (w) { return [w.id, w.label]; })).forEach(function (x) {
        seg.append(h('button', { type: 'button', 'aria-pressed': String(x[0] === null), text: x[1], onclick: function (e) { target = x[0]; seg.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === e.currentTarget)); }); } }));
      });
      var out = h('div', { class: 'sec' });
      async function doBlock(btn, extra) {
        var r = await run(btn, function () { return api('blocks', { method: 'POST', body: Object.assign({ date: day.date, window: target, reason: reason.value }, extra || {}) }); });
        if (r.conflicts) {
          out.replaceChildren(h('p', { class: 'note', text: r.conflicts.length + (r.conflicts.length === 1 ? ' visit is' : ' visits are') + ' booked then:' }),
            h('ul', null, r.conflicts.map(function (c) { return h('li', { text: c.name + ' · ' + c.window_label + ' · ' + c.postcode }); })),
            h('button', { class: 'btn block', type: 'button', text: 'Block and move them to the next available day', onclick: function (e) { doBlock(e.currentTarget, { move: true }); } }),
            h('button', { class: 'btn sec2 block', type: 'button', text: 'Block but leave them booked', onclick: function (e) { doBlock(e.currentTarget, { confirm: true }); } }));
          return;
        }
        var msg = 'Blocked' + (r.moved && r.moved.length ? '. Moved ' + r.moved.length + ' and told them.' : '') + (r.stuck && r.stuck.length ? ' ' + r.stuck.length + ' could not be moved: see Today.' : '');
        toast(msg, 4000); close(); route();
      }
      body.append(h('p', { class: 'lbl', text: 'Block' }), seg, h('div', { class: 'field' }, h('label', { for: 'blkReason', text: 'Reason (optional)' }), reason),
        h('button', { class: 'btn block', type: 'button', text: 'Block', onclick: function (e) { doBlock(e.currentTarget); } }), out);
      if (day.blocks.length) {
        body.append(h('div', { class: 'divider' }), h('p', { class: 'lbl', text: 'Blocked' }));
        day.blocks.forEach(function (b) {
          body.append(h('div', { class: 'row between' }, h('span', { text: (b.window ? (day.windows.find(function (w) { return w.id === b.window; }) || {}).label : 'Whole day') + (b.reason ? ': ' + b.reason : '') }),
            h('button', { class: 'btn sec2', type: 'button', text: 'Unblock', onclick: async function (e) { await run(e.currentTarget, function () { return api('blocks/' + b.id, { method: 'DELETE', body: {} }); }, 'Unblocked'); close(); route(); } })));
        });
      }
      body.append(h('div', { class: 'divider' }), h('p', { class: 'lbl', text: 'Spaces this day' }));
      day.windows.forEach(function (w) {
        var inp = h('input', { type: 'number', min: '0', max: '30', inputmode: 'numeric', id: 'cap-' + w.id, value: String(w.override != null ? w.override : w.default_cap) });
        body.append(h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'cap-' + w.id, text: w.label + ' (usually ' + w.default_cap + ', ' + w.used + ' booked)' }), inp),
          h('button', { class: 'btn sec2', type: 'button', text: 'Set', onclick: async function (e) { await run(e.currentTarget, function () { return api('caps', { method: 'POST', body: { date: day.date, window: w.id, cap: Number(inp.value) === w.default_cap ? null : Number(inp.value) } }); }, 'Saved'); close(); route(); } })));
      });
    });
  }

  // ================= CUSTOMERS =================
  async function customers(params) {
    var q = params.get('q') || '';
    var input = h('input', { type: 'search', id: 'cq', placeholder: 'Name, postcode or phone', value: q, autocomplete: 'off' });
    var list = h('div', { class: 'card list' }, h('div', { class: 'loading', text: 'Loading…' }));
    var t = null;
    async function load() {
      var d = await api('customers?q=' + encodeURIComponent(input.value));
      list.replaceChildren();
      if (!d.customers.length) list.append(h('div', { class: 'empty', text: input.value ? 'No match.' : 'No customers yet.' }));
      d.customers.forEach(function (c) {
        list.append(h('a', { class: 'item', href: '#/customer/' + c.id },
          h('div', { class: 'grow' }, h('b', { text: c.name }), h('span', { class: 'sub', text: [c.postcode, c.town, c.next_visit ? 'next ' + shortDate(c.next_visit) : null].filter(Boolean).join(' · ') })),
          c.has_failed ? h('span', { class: 'badge bad', text: 'Failed' }) : c.plan_status ? h('span', { class: 'badge ' + (c.plan_status === 'active' ? 'ok' : 'due'), text: c.plan_status === 'active' ? '4-weekly' : c.plan_status }) : null,
          h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
      });
    }
    input.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { history.replaceState(null, '', '#/customers' + (input.value ? '?q=' + encodeURIComponent(input.value) : '')); load(); }, 250); });
    view.replaceChildren(h('div', { class: 'head' }, h('h1', { text: 'Customers' }), h('a', { class: 'btn', href: '#/customers/new', text: 'Add customer' })),
      h('div', { class: 'stack' }, h('label', { class: 'sr', for: 'cq', text: 'Search customers' }), input, list));
    await load();
  }

  async function customerPage(id) {
    var d = await api('customers/' + id);
    var c = d.customer;
    var plans = d.plans.filter(function (p) { return p.status !== 'cancelled'; });
    function planCard(p) {
      var acts = h('div', { class: 'row' });
      if (p.status === 'active') acts.append(
        h('button', { class: 'btn sec2', type: 'button', text: 'Move cadence', onclick: function () { dateSheet('Move ' + c.name + '\'s plan', 'Next visit date', 'Move plan', function (date) { return api('plans/' + p.id + '/move', { method: 'POST', body: { date: date } }); }, 'Their card is next charged at 7am on this date, then every 4 weeks.'); } }),
        h('button', { class: 'btn sec2', type: 'button', text: 'Pause', onclick: function (e) { run(e.currentTarget, function () { return api('plans/' + p.id + '/pause', { method: 'POST', body: {} }); }, 'Paused').then(route); } }));
      if (p.status === 'paused') acts.append(h('button', { class: 'btn sec2', type: 'button', text: 'Resume', onclick: function () { dateSheet('Resume ' + c.name + '\'s plan', 'Next visit date', 'Resume plan', function (date) { return api('plans/' + p.id + '/resume', { method: 'POST', body: { date: date } }); }); } }));
      if (p.status === 'active' || p.status === 'paused') acts.append(h('button', { class: 'btn sec2', type: 'button', text: 'Cancel plan', onclick: function () {
        sheet('Cancel ' + c.name + '\'s plan?', function (body, close) {
          var refund = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Refund their next paid visit', onclick: function () { refund.setAttribute('aria-checked', String(refund.getAttribute('aria-checked') !== 'true')); } });
          body.append(h('p', { class: 'sub', text: 'No more charges. Unpaid future visits are cancelled and removed from the calendar.' }),
            h('div', { class: 'toggle' }, h('span', { text: 'Refund and cancel their next paid visit (if more than 24h away)' }), refund),
            h('button', { class: 'btn danger block', type: 'button', text: 'Cancel plan', onclick: async function (e) { await run(e.currentTarget, function () { return api('plans/' + p.id + '/cancel', { method: 'POST', body: { refund_next: refund.getAttribute('aria-checked') === 'true' } }); }, 'Plan cancelled'); close(); route(); } }));
        });
      } }));
      return h('div', { class: 'card sec' },
        h('div', { class: 'row between' }, h('h2', { text: p.status === 'pending' ? 'Waiting for card' : '4-weekly plan' }), h('span', { class: 'badge ' + (p.status === 'active' ? 'ok' : 'due'), text: p.status })),
        h('div', { class: 'ln' }, h('span', { text: p.items }), h('span', { text: gbp(p.price_pence) + ' / 4 weeks' })),
        h('div', { class: 'ln' }, h('span', { text: 'Cadence from' }), h('span', { text: shortDate(p.anchor_date) + ', ' + p.window_label })),
        acts);
    }
    function vrow(v) {
      return h('a', { class: 'item', href: '#/visit/' + v.id }, h('div', { class: 'grow' }, h('b', { text: v.date_short + ', ' + v.window_label }), h('span', { class: 'sub', text: v.items_text + ' · ' + gbp(v.amount_pence) + (v.status !== 'scheduled' ? ' · ' + v.status : '') })), payBadge(v), h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
    }
    var notes = h('textarea', { id: 'cnotes', maxlength: '1000' }); notes.value = c.notes || '';
    view.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h1', { text: c.name }), h('p', { class: 'sub', text: c.postcode + (c.source !== 'online' ? ' · added ' + c.source.replace('-', ' ') : '') }))),
      h('div', { class: 'stack' },
        h('div', { class: 'card sec' },
          h('div', null, h('div', { text: [c.address_line1, c.address_line2, c.town, c.postcode].filter(Boolean).join(', ') }), c.access_notes ? h('div', { class: 'sub', text: 'Access: ' + c.access_notes }) : null, c.collection_day ? h('div', { class: 'sub', text: 'Collection day: ' + c.collection_day }) : null),
          h('div', { class: 'acts' },
            h('a', { class: 'act', href: 'https://maps.apple.com/?q=' + encodeURIComponent(c.address_line1 + ', ' + c.postcode), target: '_blank', rel: 'noopener' }, svg(I.map), 'Maps'),
            h('a', { class: 'act', href: 'tel:' + c.phone }, svg(I.call), 'Call'),
            h('a', { class: 'act', href: 'sms:' + c.phone }, svg(I.text), 'Text'),
            h('a', { class: 'act', href: 'mailto:' + c.email, text: 'Email' })),
          h('div', { class: 'row' },
            h('button', { class: 'btn sec2', type: 'button', text: 'Edit', onclick: function () { editCustomer(c); } }),
            h('button', { class: 'btn sec2', type: 'button', text: 'Resend manage link', onclick: function (e) { run(e.currentTarget, function () { return api('customers/' + c.id + '/link', { method: 'POST', body: {} }); }, 'Link emailed'); } }),
            c.has_stripe ? h('button', { class: 'btn sec2', type: 'button', text: 'Send card update link', onclick: function (e) { run(e.currentTarget, function () { return api('customers/' + c.id + '/card-link', { method: 'POST', body: {} }); }, 'Sent by email and text'); } }) : null)),
        plans.map(planCard),
        h('div', { class: 'card list' }, h('h2', { text: 'Next visits' }), d.upcoming.length ? d.upcoming.map(vrow) : h('div', { class: 'empty', text: 'None booked.' })),
        h('div', { class: 'card list' }, h('h2', { text: 'History' }), d.history.length ? d.history.map(vrow) : h('div', { class: 'empty', text: 'No past visits.' })),
        h('div', { class: 'card sec' }, h('h2', { text: 'Payments' }), d.payments.length ? d.payments.map(function (p) {
          return h('div', { class: 'ln' }, h('span', { text: when(p.paid_at) + (p.visit_date ? ' · for ' + shortDate(p.visit_date) : '') }), h('span', { text: gbp(p.amount_pence) + (p.refunded_pence ? ' (refunded ' + gbp(p.refunded_pence) + ')' : '') }));
        }) : h('p', { class: 'sub', text: 'No payments yet.' })),
        h('div', { class: 'card sec' }, h('div', { class: 'field' }, h('label', { for: 'cnotes', text: 'Notes about this customer' }), notes),
          h('button', { class: 'btn sec2', type: 'button', text: 'Save note', onclick: function (e) { run(e.currentTarget, function () { return api('customers/' + c.id + '/note', { method: 'POST', body: { notes: notes.value } }); }, 'Saved'); } }))));
  }
  function dateSheet(title, label, action, fn, hint) {
    sheet(title, function (body, close) {
      var inp = h('input', { type: 'date', id: 'dsDate', value: addDays(todayLondon(), 7) });
      var err = h('p', { class: 'err', role: 'alert' });
      body.append(h('div', { class: 'field' }, h('label', { for: 'dsDate', text: label }), inp), hint ? h('p', { class: 'sub', text: hint }) : null, err,
        h('button', { class: 'btn block', type: 'button', text: action, onclick: async function (e) { err.textContent = ''; try { await run(e.currentTarget, function () { return fn(inp.value); }, 'Done'); close(); route(); } catch (x) { err.textContent = x.message; } } }));
    });
  }
  function custFields(c) {
    c = c || {};
    var f = {};
    var mk = function (id, label, type, val, extra) { f[id] = h(type === 'textarea' ? 'textarea' : 'input', Object.assign({ id: 'cf-' + id, type: type === 'textarea' ? null : type }, extra || {})); f[id].value = val || ''; return h('div', { class: 'field' }, h('label', { for: 'cf-' + id, text: label }), f[id]); };
    var wrap = h('div', { class: 'sec' },
      mk('name', 'Name', 'text', c.name, { autocomplete: 'off' }),
      h('div', { class: 'row' }, mk('email', 'Email', 'email', c.email), mk('phone', 'Mobile', 'tel', c.phone)),
      mk('address_line1', 'Address', 'text', c.address_line1), mk('address_line2', 'Address line 2', 'text', c.address_line2),
      h('div', { class: 'row' }, mk('town', 'Town', 'text', c.town), mk('postcode', 'Postcode', 'text', c.postcode)),
      mk('access_notes', 'Where the bins are kept', 'textarea', c.access_notes), mk('collection_day', 'Collection day', 'text', c.collection_day));
    return { el: wrap, values: function () { var o = {}; for (var k in f) o[k] = f[k].value.trim(); return o; } };
  }
  function editCustomer(c) {
    sheet('Edit ' + c.name, function (body, close) {
      var fields = custFields(c); var err = h('p', { class: 'err', role: 'alert' });
      body.append(fields.el, err, h('button', { class: 'btn block', type: 'button', text: 'Save', onclick: async function (e) {
        err.textContent = '';
        try { await run(e.currentTarget, function () { return api('customers/' + c.id, { method: 'PATCH', body: fields.values() }); }, 'Saved'); close(); route(); } catch (x) { err.textContent = x.message; }
      } }));
    });
  }
  async function newCustomer() {
    var svc = (await api('services')).services.filter(function (s) { return s.active && s.price_recurring_pence != null; });
    var fields = custFields();
    var qty = {};
    var items = h('div', { class: 'sec' });
    svc.forEach(function (s) {
      var out = h('output', { text: '0' });
      var set = function (n) { qty[s.slug] = Math.max(0, Math.min(6, n)); out.textContent = qty[s.slug]; };
      items.append(h('div', { class: 'row between' }, h('div', null, h('div', { text: s.name }), h('span', { class: 'sub', text: gbp(s.price_recurring_pence) + ' every 4 weeks' })),
        h('div', { class: 'row' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fewer ' + s.name, text: '−', onclick: function () { set((qty[s.slug] || 0) - 1); } }), out,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More ' + s.name, text: '+', onclick: function () { set((qty[s.slug] || 0) + 1); } }))));
    });
    var next = h('input', { type: 'date', id: 'ncNext' });
    var win = '14-16';
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Window' });
    [['14-16', '2–4pm'], ['16-18', '4–6pm']].forEach(function (x) { seg.append(h('button', { type: 'button', 'aria-pressed': String(x[0] === win), text: x[1], onclick: function (e) { win = x[0]; seg.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === e.currentTarget)); }); } })); });
    var source = 'square-migration';
    var srcSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Source' });
    [['square-migration', 'From Square'], ['manual', 'New, by phone']].forEach(function (x) { srcSeg.append(h('button', { type: 'button', 'aria-pressed': String(x[0] === source), text: x[1], onclick: function (e) { source = x[0]; srcSeg.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === e.currentTarget)); }); } })); });
    var err = h('p', { class: 'err', role: 'alert' });
    view.replaceChildren(h('div', { class: 'head' }, h('div', null, h('h1', { text: 'Add customer' }), h('p', { class: 'sub', text: 'They get a link by email and text to add their card. Nothing is charged until their next clean.' }))),
      h('div', { class: 'stack' },
        h('div', { class: 'card sec' }, srcSeg, fields.el),
        h('div', { class: 'card sec' }, h('h2', { text: 'Bins' }), items),
        h('div', { class: 'card sec' }, h('div', { class: 'field' }, h('label', { for: 'ncNext', text: 'Next clean due' }), next), seg),
        err,
        h('button', { class: 'btn block', type: 'button', text: 'Create plan and send link', onclick: async function (e) {
          err.textContent = '';
          var it = {}; for (var k in qty) if (qty[k] > 0) it[k] = qty[k];
          try {
            var r = await run(e.currentTarget, function () { return api('customers', { method: 'POST', body: { customer: fields.values(), items: it, next_date: next.value, window: win, source: source } }); }, 'Link sent');
            go('#/customer/' + r.customer_id);
          } catch (x) { err.textContent = x.message; }
        } })));
  }

  // ================= MONEY =================
  async function money() {
    var d = await api('money');
    var box = function (label, r) {
      return h('div', { class: 'card sec' }, h('div', { class: 'row between' }, h('h2', { text: label }), h('span', { class: 'sub', text: r.n + (r.n === 1 ? ' payment' : ' payments') })),
        h('div', { class: 'ln' }, h('span', { text: 'Gross' }), h('span', { text: gbp(r.gross) })),
        h('div', { class: 'ln' }, h('span', { text: 'Stripe fees' + (r.fee_pending ? ' (' + r.fee_pending + ' pending)' : '') }), h('span', { text: '−' + gbp(r.fees) })),
        r.refunds ? h('div', { class: 'ln' }, h('span', { text: 'Refunds' }), h('span', { text: '−' + gbp(r.refunds) })) : null,
        h('div', { class: 'ln tot' }, h('span', { text: 'After fees' }), h('span', { text: gbp(r.net) })));
    };
    view.replaceChildren(h('div', { class: 'head' }, h('h1', { text: 'Money' })),
      h('div', { class: 'stack' },
        d.failed.length ? h('div', { class: 'card sec' }, h('h2', { text: 'Failed payments' }), d.failed.map(function (f) {
          return h('div', { class: 'row between' }, h('a', { href: '#/visit/' + f.visit_id, text: f.name + ' · ' + f.date_short + ' · ' + gbp(f.amount_pence) }),
            h('button', { class: 'btn sec2', type: 'button', text: 'Resend card link', onclick: function (e) { run(e.currentTarget, function () { return api('customers/' + f.customer_id + '/card-link', { method: 'POST', body: {} }); }, 'Sent'); } }));
        })) : null,
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', { text: String(d.plans.active) }), h('span', { text: 'active plans' })),
          h('div', { class: 'stat' }, h('b', { text: gbp(d.plans.per_cycle) }), h('span', { text: 'per 4-week cycle' })),
          h('div', { class: 'stat' }, h('b', { text: gbp(d.scheduled_28.to_collect) }), h('span', { text: 'to collect, next 28 days' }))),
        h('p', { class: 'sub', text: d.scheduled_28.visits + ' visits booked in the next 28 days, worth ' + gbp(d.scheduled_28.total) + ' (some already paid).' }),
        box('Today', d.collected.today), box('This week', d.collected.week), box('This month', d.collected.month), box('This year', d.collected.year),
        h('div', { class: 'card sec' }, h('h2', { text: 'Recent payments' }), d.recent.length ? d.recent.map(function (p) {
          return h('div', { class: 'ln' }, h('span', null, h('a', { href: '#/customer/' + p.customer_id, text: p.name }), ' · ' + when(p.paid_at)),
            h('span', { text: gbp(p.amount_pence) + (p.fee_pence != null ? ' · fee ' + gbp(p.fee_pence) : '') + (p.refunded_pence ? ' · ref ' + gbp(p.refunded_pence) : '') }));
        }) : h('p', { class: 'sub', text: 'No payments yet.' }))));
  }

  // ================= SETTINGS =================
  async function settings(params) {
    var d = await api('settings');
    var sv = await api('services');
    var msg = params.get('calendar') === 'connected' ? h('p', { class: 'info', text: 'Google Calendar connected. Visits will appear in "Bin Fresh Rounds".' }) : params.get('error') ? h('p', { class: 'note', role: 'alert', text: params.get('error') }) : null;

    // services
    var svcCard = h('div', { class: 'card sec' }, h('h2', { text: 'Services and prices' }));
    sv.services.forEach(function (s) {
      var one = h('input', { type: 'text', inputmode: 'decimal', id: 'p1-' + s.slug, value: s.price_one_off_pence != null ? (s.price_one_off_pence / 100).toFixed(2) : '' });
      var rec = s.category === 'addon' ? null : h('input', { type: 'text', inputmode: 'decimal', id: 'p4-' + s.slug, value: s.price_recurring_pence != null ? (s.price_recurring_pence / 100).toFixed(2) : '' });
      var online = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(s.online_bookable), 'aria-label': s.name + ' bookable online', onclick: function () { online.setAttribute('aria-checked', String(online.getAttribute('aria-checked') !== 'true')); } });
      var toP = function (x) { return x.value.trim() === '' ? null : Math.round(parseFloat(x.value) * 100); };
      svcCard.append(h('div', { class: 'sec' }, h('div', { class: 'divider' }), h('h3', { text: s.name }),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'p1-' + s.slug, text: 'One-off £' }), one), rec ? h('div', { class: 'field' }, h('label', { for: 'p4-' + s.slug, text: 'Every 4 weeks £' }), rec) : null),
        h('div', { class: 'toggle' }, h('span', { text: 'Bookable online' }), online),
        h('div', { class: 'row' }, h('button', { class: 'btn sec2', type: 'button', text: 'Save', onclick: function (e) {
          run(e.currentTarget, function () { return api('services/' + s.slug, { method: 'PATCH', body: { price_one_off_pence: toP(one), price_recurring_pence: rec ? toP(rec) : null, online_bookable: online.getAttribute('aria-checked') === 'true' } }); }, 'Saved and synced to Stripe').then(route);
        } }), s.plans_on_old_price ? h('button', { class: 'btn sec2', type: 'button', text: 'Apply new price to ' + s.plans_on_old_price + ' existing ' + (s.plans_on_old_price === 1 ? 'plan' : 'plans'), onclick: function (e) {
          if (!window.confirm('Email ' + s.plans_on_old_price + ' customers 14 days\' notice and move them to ' + gbp(s.price_recurring_pence) + '?')) return;
          run(e.currentTarget, function () { return api('services/' + s.slug + '/apply-existing', { method: 'POST', body: {} }); }, 'Customers notified').then(route);
        } }) : null, s.plans_using ? h('span', { class: 'sub', text: s.plans_using + ' plans use this' }) : null)));
    });

    // booking rules
    var winInputs = d.windows.map(function (w) {
      return { id: w.id, start: h('input', { type: 'time', id: 'ws-' + w.id, value: w.start }), end: h('input', { type: 'time', id: 'we-' + w.id, value: w.end }), cap: h('input', { type: 'number', min: '0', max: '30', id: 'wc-' + w.id, value: String(w.cap), inputmode: 'numeric' }) };
    });
    var days = d.bookable_weekdays.slice();
    var dayPills = h('div', { class: 'pills', role: 'group', 'aria-label': 'Bookable days' });
    DAYS.slice(0, 6).forEach(function (n, i) { var b = h('button', { class: 'pill', type: 'button', 'aria-pressed': String(days.indexOf(i + 1) >= 0), text: n, onclick: function () { var k = days.indexOf(i + 1); if (k >= 0) days.splice(k, 1); else days.push(i + 1); b.setAttribute('aria-pressed', String(k < 0)); } }); dayPills.append(b); });
    var cutoff = h('input', { type: 'time', id: 'cutoff', value: d.booking_cutoff_time });
    var horizon = h('input', { type: 'number', id: 'horizon', min: '1', max: '26', value: String(d.horizon_weeks) });
    var districts = h('input', { type: 'text', id: 'districts', value: d.postcode_districts.join(', ') });
    var rules = h('div', { class: 'card sec' }, h('h2', { text: 'Booking rules' }),
      h('p', { class: 'note', text: 'From November to February the 4–6pm window runs into darkness in North Devon. You can change the window times here, or block the later window on specific days.' }),
      winInputs.map(function (w) {
        var lbl = (d.windows.find(function (x) { return x.id === w.id; }) || {}).label;
        return h('div', { class: 'row tight' }, h('div', { class: 'field' }, h('label', { for: 'ws-' + w.id, text: lbl + ' starts' }), w.start), h('div', { class: 'field' }, h('label', { for: 'we-' + w.id, text: 'Ends' }), w.end), h('div', { class: 'field' }, h('label', { for: 'wc-' + w.id, text: 'Visits' }), w.cap));
      }),
      h('p', { class: 'lbl', text: 'Bookable days (Sunday is never bookable)' }), dayPills,
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'cutoff', text: 'Bookings close the day before at' }), cutoff), h('div', { class: 'field' }, h('label', { for: 'horizon', text: 'Book up to (weeks ahead)' }), horizon)),
      h('div', { class: 'field' }, h('label', { for: 'districts', text: 'Postcode districts for online booking' }), districts),
      h('button', { class: 'btn', type: 'button', text: 'Save booking rules', onclick: function (e) {
        run(e.currentTarget, function () { return api('settings', { method: 'POST', body: {
          windows: winInputs.map(function (w) { return { id: w.id, start: w.start.value, end: w.end.value, cap: Number(w.cap.value) }; }),
          bookable_weekdays: days, booking_cutoff_time: cutoff.value, horizon_weeks: Number(horizon.value),
          postcode_districts: districts.value.split(/[\s,]+/).filter(Boolean) } }); }, 'Saved').then(route);
      } }));

    // calendar
    var cal = d.calendar;
    var calCard = h('div', { class: 'card sec' }, h('h2', { text: 'Google Calendar' }),
      cal.connected ? h('p', { class: 'sub', text: 'Connected as ' + cal.email + '. Last sync ' + when(cal.last_sync) + (cal.stale ? '. ' + cal.stale + ' waiting to sync.' : '.') }) : h('p', { class: 'sub', text: 'Not connected. Visits will appear in a "Bin Fresh Rounds" calendar in your Google account and on your iPhone.' }),
      cal.last_error ? h('p', { class: 'note', text: cal.last_error }) : null,
      h('div', { class: 'row' },
        cal.oauth_configured ? h('a', { class: 'btn', href: '/api/google/calendar', text: cal.connected ? 'Reconnect' : 'Connect Google Calendar' }) : h('p', { class: 'note', text: 'Google is not set up yet (GOOGLE_CLIENT_ID).' }),
        cal.connected ? h('button', { class: 'btn sec2', type: 'button', text: 'Resync all', onclick: function (e) { run(e.currentTarget, function () { return api('settings/resync', { method: 'POST', body: {} }); }, 'Resynced').then(route); } }) : null,
        cal.connected ? h('button', { class: 'btn sec2', type: 'button', text: 'Disconnect', onclick: function (e) { if (window.confirm('Stop syncing to Google Calendar?')) run(e.currentTarget, function () { return api('settings/disconnect-calendar', { method: 'POST', body: {} }); }, 'Disconnected').then(route); } }) : null),
      h('div', { class: 'divider' }),
      h('p', { class: 'sub', text: 'Backup feed: a private calendar link you can subscribe to on your iPhone if Google access ever stops working. Creating a new link turns off the old one.' }),
      h('button', { class: 'btn sec2', type: 'button', text: d.ics_enabled ? 'Create a new feed link' : 'Create feed link', onclick: async function (e) {
        var r = await run(e.currentTarget, function () { return api('settings/ics-token', { method: 'POST', body: {} }); });
        sheet('Calendar feed link', function (body) {
          var inp = h('input', { type: 'text', readonly: true, id: 'icsUrl', value: r.url });
          body.append(h('p', { class: 'sub', text: 'On your iPhone: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste this link. Keep it private.' }), inp,
            h('button', { class: 'btn block', type: 'button', text: 'Copy link', onclick: function () { inp.select(); try { navigator.clipboard.writeText(r.url).then(function () { toast('Copied'); }); } catch (x) { document.execCommand('copy'); toast('Copied'); } } }));
        });
      } }));

    // alerts
    var alertEmail = h('input', { type: 'email', id: 'alertEmail', value: d.tom_alert_email || '' });
    var mobile = h('input', { type: 'tel', id: 'tomMobile', value: d.tom_mobile || '' });
    var smsSw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(d.sms_enabled), 'aria-label': 'Send reminder texts', onclick: function () { smsSw.setAttribute('aria-checked', String(smsSw.getAttribute('aria-checked') !== 'true')); } });
    var alerts = h('div', { class: 'card sec' }, h('h2', { text: 'Alerts and messages' }),
      h('div', { class: 'field' }, h('label', { for: 'alertEmail', text: 'Email for failed payments and alerts' }), alertEmail),
      h('div', { class: 'field' }, h('label', { for: 'tomMobile', text: 'Your mobile (for test texts)' }), mobile),
      h('div', { class: 'toggle' }, h('div', null, h('div', { text: 'Reminder texts' }), h('div', { class: 'sub', text: 'Sent at 5pm the day before each clean, from "BinFresh".' })), smsSw),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', text: 'Save', onclick: function (e) { run(e.currentTarget, function () { return api('settings', { method: 'POST', body: { tom_alert_email: alertEmail.value, tom_mobile: mobile.value, sms_enabled: smsSw.getAttribute('aria-checked') === 'true' } }); }, 'Saved'); } }),
        h('button', { class: 'btn sec2', type: 'button', text: 'Send test SMS', onclick: function (e) { run(e.currentTarget, function () { return api('settings/test-sms', { method: 'POST', body: {} }); }, 'Test text sent'); } }),
        h('button', { class: 'btn sec2', type: 'button', text: 'Send test email', onclick: function (e) { run(e.currentTarget, function () { return api('settings/test-email', { method: 'POST', body: {} }); }, 'Test email sent'); } })));

    var integ = d.integrations;
    view.replaceChildren(h('div', { class: 'head' }, h('h1', { text: 'Settings' })),
      h('div', { class: 'stack' }, msg, calCard, alerts, rules, svcCard,
        h('div', { class: 'card sec' }, h('h2', { text: 'Account' }),
          h('div', { class: 'ln' }, h('span', { text: 'Signed in as' }), h('span', { text: d.you })),
          h('div', { class: 'ln' }, h('span', { text: 'Stripe' }), h('span', { text: integ.stripe ? integ.stripe_mode + ' mode' : 'not set up' })),
          h('div', { class: 'ln' }, h('span', { text: 'Email (Resend)' }), h('span', { text: integ.resend ? 'on' : 'not set up' })),
          h('div', { class: 'ln' }, h('span', { text: 'SMS (Twilio)' }), h('span', { text: integ.twilio ? 'on' : 'not set up' })),
          h('button', { class: 'btn sec2', type: 'button', text: 'Sign out', onclick: async function () { await fetch('/api/admin/session', { method: 'DELETE', credentials: 'same-origin' }); go('#/signin'); } }))));
  }

  // ================= ROUTER =================
  var routes = [
    [/^#\/signin/, function (m, p) { return signin(p); }],
    [/^#\/today(?:\/(\d{4}-\d{2}-\d{2}))?$/, function (m) { return today(m[1]); }, 'today'],
    [/^#\/visit\/([0-9a-f-]{36})$/, function (m) { return visitPage(m[1]); }, 'today'],
    [/^#\/calendar(?:\/(\d{4}-\d{2}-\d{2}))?$/, function (m) { return calendar(m[1]); }, 'calendar'],
    [/^#\/customers\/new$/, function () { return newCustomer(); }, 'customers'],
    [/^#\/customers$/, function (m, p) { return customers(p); }, 'customers'],
    [/^#\/customer\/([0-9a-f-]{36})$/, function (m) { return customerPage(m[1]); }, 'customers'],
    [/^#\/money$/, function () { return money(); }, 'money'],
    [/^#\/settings$/, function (m, p) { return settings(p); }, 'settings'],
  ];
  var rendering = 0;
  async function route() {
    var raw = location.hash || '#/today';
    var q = raw.indexOf('?');
    var path = q >= 0 ? raw.slice(0, q) : raw, params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
    var r = routes.find(function (x) { return x[0].test(path); }) || routes[1];
    var my = ++rendering;
    document.getElementById('sheetHost').innerHTML = ''; // a sheet never survives navigation
    document.getElementById('tabs').hidden = r[2] == null;
    document.querySelectorAll('.tab').forEach(function (t) { if (t.dataset.tab === r[2]) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
    if (!view.firstChild || !view.firstChild.classList || !view.firstChild.classList.contains('head')) view.replaceChildren(h('div', { class: 'loading', text: 'Loading…' }));
    try {
      await r[1](path.match(r[0]), params);
      if (my === rendering && r[2]) { document.title = 'Rounds · ' + r[2].charAt(0).toUpperCase() + r[2].slice(1); }
    } catch (e) {
      if (e.message === 'Sign in required' || my !== rendering) return;
      view.replaceChildren(h('div', { class: 'card empty' }, h('p', { text: e.message }), h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: route })));
    }
  }
  window.addEventListener('hashchange', function () { route(); window.scrollTo(0, 0); });
  // refresh Today when the app comes back to the foreground
  document.addEventListener('visibilitychange', function () { if (!document.hidden && /^#\/(today|$)/.test(location.hash || '#/today')) route(); });
  fetch('/api/admin/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
    if (!s.authed) return go('#/signin');
    document.getElementById('who').textContent = s.actor === 'passcode' ? '' : s.actor;
    route();
  }).catch(function () { view.replaceChildren(h('div', { class: 'card empty', text: 'Could not reach the server. Check your signal and pull down to retry.' })); });
})();
