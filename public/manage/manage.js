/* Customer self-service: reschedule (24h+ before, within 7 days), cancel plan, cancel one-off, update card. */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var gbp = function (p) { return '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k]; if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) (function addc(c) { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(addc); else el.append(c.nodeType ? c : document.createTextNode(String(c))); })(arguments[i]);
    return el;
  }
  async function api(path, body) {
    var r = await fetch('/api/manage' + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    var d = await r.json().catch(function () { return {}; });
    if (r.status === 401) { lost(d.error); throw new Error('auth'); }
    if (!r.ok) throw new Error(d.error || 'Something went wrong. Please try again or call us.');
    return d;
  }
  // replaceChildren() can't take arrays or nulls; route everything through h()'s child handling
  function fill() { var tmp = h.apply(null, ['div', null].concat([].slice.call(arguments))); root.replaceChildren(...tmp.childNodes); }
  function focusTitle() { var t = root.querySelector('h1'); if (t) { t.setAttribute('tabindex', '-1'); t.focus(); } }

  function lost(msg) {
    var params = new URLSearchParams(location.search);
    var note = msg || (params.get('e') === 'expired' ? 'That link has expired or has already been replaced.' : params.get('e') === 'busy' ? 'Too many attempts. Please wait a few minutes.' : null);
    var email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
    var hp = h('input', { type: 'text', id: 'bf-check', tabindex: '-1', autocomplete: 'off' });
    var out = h('p', { class: 'note ok', role: 'status', hidden: true });
    var btn = h('button', { class: 'btn block', type: 'submit', text: 'Email me a link' });
    fill(h('div', { class: 'card sec' },
      h('h1', { text: 'Manage your booking' }),
      note ? h('p', { class: 'note warn', text: note }) : null,
      h('p', { class: 'sub', text: 'Use the link in your booking email or reminder text. Lost it? Enter your email and we\'ll send a new one.' }),
      h('form', { class: 'sec', novalidate: true, onsubmit: async function (e) {
        e.preventDefault(); btn.disabled = true;
        try {
          var r = await fetch('/api/manage/lost-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.value, 'bf-check': hp.value }) });
          var d = await r.json(); out.textContent = d.message; out.hidden = false;
        } catch (x) { out.textContent = 'We couldn\'t send that just now. Please try again.'; out.hidden = false; }
        btn.disabled = false;
      } }, h('div', { class: 'field' }, h('label', { for: 'email', text: 'Email address' }), email),
        h('p', { class: 'hp', 'aria-hidden': 'true' }, h('label', null, 'Leave this empty ', hp)), btn, out)));
    focusTitle();
  }

  var S = null;
  async function load() {
    try { S = await api(''); } catch (e) { if (e.message !== 'auth') fill(h('p', { class: 'note bad', text: e.message })); return; }
    render();
  }
  function payText(v) { return { paid: 'Paid', due: 'Charged the morning of the clean', failed: 'Payment failed: please update your card', refunded: 'Refunded', unpaid: 'Unpaid' }[v.payment_status] || ''; }

  function render(flash) {
    var upcoming = S.visits.filter(function (v) { return v.upcoming; });
    var past = S.visits.filter(function (v) { return !v.upcoming; }).slice(-5).reverse();
    fill(
      h('h1', { text: 'Hi ' + S.customer.first_name + '.' }),
      h('p', { class: 'lede', text: 'Reschedule or cancel up to 24 hours before a clean.' }),
      flash ? h('p', { class: 'note ok', role: 'status', text: flash }) : null,
      S.plans.map(function (p) {
        return h('section', { class: 'card sec', 'aria-label': 'Your plan' },
          h('h2', { text: 'Your 4-weekly plan' }),
          h('div', { class: 'ln' }, h('span', { text: p.items }), h('span', { text: gbp(p.price_pence) + ' every 4 weeks' })),
          p.status === 'paused' ? h('p', { class: 'note warn', text: 'Your plan is paused. Call us to restart it.' }) : null,
          h('button', { class: 'btn ghost', type: 'button', text: 'Cancel my plan', onclick: function () { cancelPlan(p); } }));
      }),
      h('section', { class: 'card sec', 'aria-label': 'Upcoming cleans' }, h('h2', { text: 'Upcoming cleans' }),
        upcoming.length ? upcoming.map(visitRow) : h('p', { class: 'sub', text: 'Nothing booked.' }),
        h('a', { class: 'btn ghost', href: '/book', text: 'Book another clean' })),
      h('section', { class: 'card sec', 'aria-label': 'Card' }, h('h2', { text: 'Your card' }),
        S.card ? h('p', { text: S.card.brand.charAt(0).toUpperCase() + S.card.brand.slice(1) + ' ending ' + S.card.last4 + ', expires ' + S.card.exp }) : h('p', { class: 'sub', text: 'No card on file.' }),
        S.card ? h('button', { class: 'btn ghost', type: 'button', text: 'Update card', onclick: async function (e) {
          e.currentTarget.disabled = true;
          try { var r = await api('/portal', {}); location.href = r.url; } catch (x) { if (x.message !== 'auth') alertMsg(x.message); e.currentTarget.disabled = false; }
        } }) : null),
      past.length ? h('section', { class: 'card sec', 'aria-label': 'Recent cleans' }, h('h2', { text: 'Recent cleans' }), past.map(function (v) {
        return h('div', { class: 'ln' }, h('span', { text: v.short + ', ' + v.window_label }), h('span', { text: v.status === 'done' ? 'Cleaned' : v.status === 'skipped' ? 'Missed' : v.status }));
      })) : null,
      h('p', null, h('button', { class: 'btn ghost', type: 'button', text: 'Sign out', onclick: async function () { await fetch('/api/manage/logout', { method: 'POST' }); location.href = '/'; } })));
    focusTitle();
  }
  function alertMsg(m) { var p = h('p', { class: 'note bad', role: 'alert', text: m }); root.prepend(p); }

  function visitRow(v) {
    var box = h('div', { class: 'sec' });
    var acts = h('div', { class: 'row' });
    if (v.can_change) {
      acts.append(h('button', { class: 'btn ghost', type: 'button', text: 'Reschedule', onclick: function () { reschedule(v, box); } }));
      if (!v.plan_id) acts.append(h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: function () { cancelVisit(v, box); } }));
    }
    box.append(h('div', { class: 'ln' }, h('span', null, h('strong', { text: v.date_label + ', ' + v.window_label }), h('br'), v.items), h('span', { text: gbp(v.amount_pence) })),
      h('p', { class: 'sub', text: payText(v) }),
      v.can_change ? acts : h('p', { class: 'sub', text: 'Less than 24 hours to go, so this clean can\'t be changed online. Call 07394 536053 if there\'s a problem.' }));
    return box;
  }

  async function reschedule(v, box) {
    var panel = h('div', { class: 'sec' }, h('div', { class: 'spinner', 'aria-label': 'Loading times' }));
    box.append(panel);
    var d;
    try { d = await api('/slots?visit=' + v.id); } catch (e) { panel.replaceChildren(h('p', { class: 'note bad', text: e.message })); return; }
    var picked = null;
    var go = h('button', { class: 'btn', type: 'button', text: 'Move my clean', disabled: true, onclick: async function () {
      go.disabled = true;
      try { await api('/reschedule', { visit_id: v.id, date: picked.date, window: picked.window }); S = await api(''); render('Done. Your clean has moved. We\'ve emailed you the new time.'); }
      catch (e) { if (e.message !== 'auth') { err.textContent = e.message; go.disabled = false; } }
    } });
    var err = h('p', { class: 'err', role: 'alert' });
    var grid = h('div', { class: 'opts slots', role: 'group', 'aria-label': 'Available times' });
    d.days.filter(function (x) { return x.bookable; }).forEach(function (day) {
      day.windows.filter(function (w) { return w.left > 0 && !(day.date === d.current.date && w.id === d.current.window); }).forEach(function (w) {
        var b = h('button', { class: 'opt', type: 'button', 'aria-pressed': 'false', onclick: function () {
          picked = { date: day.date, window: w.id };
          grid.querySelectorAll('.opt').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          go.disabled = false;
        } }, h('span', { class: 't', text: day.label }), h('span', { class: 'd', text: w.label }));
        grid.append(b);
      });
    });
    panel.replaceChildren(h('p', { class: 'lbl', text: 'Pick a new time (within a week of your usual day)' }),
      grid.children.length ? grid : h('p', { class: 'sub', text: 'No other times are free that week. Call us and we\'ll sort it.' }), err, go,
      h('button', { class: 'btn ghost', type: 'button', text: 'Keep my current time', onclick: function () { panel.remove(); } }));
    var first = grid.querySelector('button'); if (first) first.focus();
  }

  function cancelVisit(v, box) {
    var panel = h('div', { class: 'note warn sec' },
      h('p', { text: 'Cancel your clean on ' + v.date_label + '?' + (v.payment_status === 'paid' ? ' We\'ll refund ' + gbp(v.amount_pence) + ' to your card.' : '') }),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger', type: 'button', text: 'Yes, cancel it', onclick: async function (e) {
          e.currentTarget.disabled = true;
          try { var r = await api('/cancel-visit', { visit_id: v.id }); S = await api(''); render('Cancelled.' + (r.refunded ? ' ' + gbp(r.refunded) + ' is on its way back to your card (5 to 10 days).' : '')); }
          catch (x) { if (x.message !== 'auth') alertMsg(x.message); }
        } }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Keep it', onclick: function () { panel.remove(); } })));
    box.append(panel);
  }

  function cancelPlan(p) {
    var next = S.visits.find(function (v) { return v.upcoming && v.plan_id === p.id && v.payment_status === 'paid'; });
    var refund = h('input', { type: 'checkbox', id: 'refundNext' });
    var err = h('p', { class: 'err', role: 'alert' });
    fill(h('div', { class: 'card sec' },
      h('h1', { text: 'Cancel your plan?' }),
      h('p', { text: 'You won\'t be charged again, and your future cleans are cancelled.' }),
      next && next.can_change ? h('label', { class: 'check' }, refund, h('span', { text: 'You\'ve already paid for your clean on ' + next.date_label + '. Cancel that clean too and refund ' + gbp(next.amount_pence) + '.' })) : null,
      next && !next.can_change ? h('p', { class: 'note warn', text: 'Your already-paid clean on ' + next.date_label + ' is less than 24 hours away, so it still goes ahead and isn\'t refunded.' }) : null,
      err,
      h('button', { class: 'btn danger block', type: 'button', text: 'Cancel my plan', onclick: async function (e) {
        e.currentTarget.disabled = true;
        try {
          var r = await api('/cancel-plan', { plan_id: p.id, refund_next: refund.checked });
          S = await api('');
          render('Your plan is cancelled.' + (r.refunded ? ' ' + gbp(r.refunded) + ' is on its way back to your card.' : '') + (r.kept ? ' Your paid clean still goes ahead.' : ''));
        } catch (x) { if (x.message !== 'auth') { err.textContent = x.message; e.currentTarget.disabled = false; } }
      } }),
      h('button', { class: 'btn ghost block', type: 'button', text: 'Keep my plan', onclick: function () { render(); } })));
    focusTitle();
  }

  load();
})();
