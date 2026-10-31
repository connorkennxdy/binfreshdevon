/* Bin Fresh booking flow. No dependencies. Prices shown here are a preview; the server prices every booking. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var gbp = function (p) { return '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var TIERS = ['household-1', 'household-2', 'household-3'];

  var CAT = null;          // { services, windows, range }
  var AVAIL = null;        // days from /api/availability
  var st = { postcode: '', plan: 'recurring', tier: null, xl: 0, deep: false, date: null, window: null };

  var params = new URLSearchParams(location.search);
  if (params.get('plan') === 'one-off' || params.get('plan') === 'recurring') st.plan = params.get('plan');
  if (TIERS.indexOf(params.get('bins')) >= 0) st.tier = params.get('bins');

  function svc(slug) { return CAT && CAT.services.find(function (s) { return s.slug === slug; }); }
  function iso(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
  function parse(s) { return new Date(s + 'T00:00:00Z'); }
  function wd(s) { var w = parse(s).getUTCDay(); return w === 0 ? 7 : w; }
  function longDate(s) { var d = parse(s); return LONG[wd(s) - 1] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
  function shortDate(s) { var d = parse(s); return DAYS[wd(s) - 1] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3); }
  function windowLabel(id) { var w = CAT && CAT.windows.find(function (x) { return x.id === id; }); return w ? w.label : id; }

  function save() { try { sessionStorage.setItem('bf_book', JSON.stringify({ st: st, details: details() })); } catch (e) {} }
  function restore() {
    try {
      var x = JSON.parse(sessionStorage.getItem('bf_book') || 'null');
      if (!x) return false;
      Object.assign(st, x.st);
      var d = x.details || {};
      ['name', 'email', 'phone', 'addr1', 'addr2', 'town', 'access', 'collection'].forEach(function (k) { if (d[k] != null && $(k)) $(k).value = d[k]; });
      return true;
    } catch (e) { return false; }
  }

  function show(id) { var el = $(id); if (el.hidden) { el.hidden = false; } return el; }
  function scrollTo(el) {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  // ---------- pricing preview ----------
  function lines() {
    var out = [];
    var rec = st.plan === 'recurring';
    if (st.tier) { var t = svc(st.tier); if (t) out.push({ slug: t.slug, name: t.name, qty: 1, unit: rec ? t.recurring_pence : t.one_off_pence }); }
    if (st.xl > 0) { var x = svc('household-360'); if (x) out.push({ slug: x.slug, name: x.name, qty: st.xl, unit: rec ? x.recurring_pence : x.one_off_pence }); }
    var main = out.slice();
    if (st.deep) { var d = svc('deep-clean'); if (d) out.push({ slug: 'deep-clean', name: 'Deep clean', qty: 1, unit: d.one_off_pence, addon: true }); }
    var mainTotal = main.reduce(function (a, l) { return a + l.unit * l.qty; }, 0);
    var all = out.reduce(function (a, l) { return a + l.unit * l.qty; }, 0);
    return { lines: out, first: all, recurring: rec ? mainTotal : 0, hasMain: main.length > 0 };
  }
  function itemsPayload() {
    var items = {};
    if (st.tier) items[st.tier] = 1;
    if (st.xl > 0) items['household-360'] = st.xl;
    return items;
  }

  function renderSummary() {
    var p = lines();
    var rec = st.plan === 'recurring';
    var per = !p.hasMain ? 'Choose your bins' : rec ? 'today, then ' + gbp(p.recurring) + ' every 4 weeks' : 'one-off clean';
    $('sumTotal').textContent = gbp(p.first); $('sheetTotal').textContent = gbp(p.first);
    $('sumPer').textContent = per; $('sheetPer').textContent = per;
    $('sumLines').innerHTML = '';
    p.lines.forEach(function (l) {
      var row = document.createElement('div'); row.className = 'ln';
      var a = document.createElement('span'); a.textContent = l.name + (l.qty > 1 ? ' ×' + l.qty : '');
      var b = document.createElement('span'); b.textContent = gbp(l.unit * l.qty);
      row.append(a, b); $('sumLines').append(row);
    });
    $('sumWhen').textContent = st.date ? longDate(st.date) + (st.window ? ', ' + windowLabel(st.window) : '') : '';
    if (rec && p.hasMain) {
      var one = 0;
      if (st.tier) one += svc(st.tier).one_off_pence;
      if (st.xl) one += svc('household-360').one_off_pence * st.xl;
      $('saveNote').textContent = one > p.recurring ? 'Save ' + gbp(one - p.recurring) + ' a clean' : '';
    } else $('saveNote').textContent = '';
  }

  // ---------- step 1: postcode ----------
  var PC_RE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/;
  async function checkPostcode() {
    var raw = $('postcode').value.toUpperCase().replace(/\s+/g, ' ').trim();
    $('pcErr').textContent = ''; $('outArea').hidden = true;
    var m = raw.match(PC_RE);
    if (!m) { $('pcErr').textContent = 'Please enter a full postcode, like EX31 1AA.'; $('postcode').setAttribute('aria-invalid', 'true'); $('postcode').focus(); return; }
    $('postcode').setAttribute('aria-invalid', 'false');
    var pc = m[1] + ' ' + m[2];
    $('pcBtn').disabled = true;
    try {
      var r = await fetch('/api/postcode?pc=' + encodeURIComponent(pc));
      var d = await r.json();
      if (!d.ok) {
        $('outArea').hidden = false;
        $('quoteLink').href = '/?postcode=' + encodeURIComponent(pc) + '#contact';
        ['s-plan', 's-bins', 's-date', 's-details', 's-pay'].forEach(function (id) { $(id).hidden = true; });
        return;
      }
      st.postcode = d.postcode; $('postcode').value = d.postcode; $('pc2').value = d.postcode;
      save();
      scrollTo(show('s-plan')); show('s-bins');
      if (st.tier || st.xl) { show('s-date'); loadAvailability(); }
    } catch (e) { $('pcErr').textContent = 'We couldn\'t check that just now. Please try again.'; }
    finally { $('pcBtn').disabled = false; }
  }

  // ---------- step 2/3: plan + bins ----------
  function renderPlan() {
    document.querySelectorAll('[data-plan]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.plan === st.plan)); });
  }
  function renderBins() {
    var rec = st.plan === 'recurring';
    var box = $('tiers'); box.innerHTML = '';
    TIERS.forEach(function (slug) {
      var s = svc(slug); if (!s) return;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.dataset.tier = slug; b.setAttribute('aria-pressed', String(st.tier === slug));
      var img = document.createElement('img'); img.src = '/' + s.photo; img.alt = ''; img.loading = 'lazy'; img.width = 300; img.height = 188;
      var t = document.createElement('span'); t.className = 't'; t.textContent = s.name.replace(' household', '');
      var p = document.createElement('span'); p.className = 'p'; p.textContent = gbp(rec ? s.recurring_pence : s.one_off_pence) + (rec ? ' / 4 wks' : '');
      b.append(img, t, p); box.append(b);
    });
    var xl = svc('household-360');
    $('xlLine').hidden = !xl;
    if (xl) $('xlPrice').textContent = gbp(rec ? xl.recurring_pence : xl.one_off_pence) + (rec ? ' each, every 4 weeks' : ' each');
    $('xlOut').textContent = st.xl; $('xlMinus').disabled = st.xl <= 0; $('xlPlus').disabled = st.xl >= 3;
    var dc = svc('deep-clean');
    $('deepLine').hidden = !dc;
    if (dc) $('deepPrice').textContent = '+' + gbp(dc.one_off_pence) + (rec ? ' on your first clean only.' : '.') + ' For a very dirty bin with heavy build-up.';
    $('deepSwitch').setAttribute('aria-checked', String(st.deep));
    renderSummary();
  }
  function binsChanged() {
    renderBins(); save();
    $('binsErr').textContent = '';
    if (lines().hasMain && $('s-date').hidden) { scrollTo(show('s-date')); loadAvailability(); }
    if (!$('s-pay').hidden) renderPay();
  }

  // ---------- step 4: calendar ----------
  async function loadAvailability() {
    if (AVAIL) return renderCal();
    try {
      var r = await fetch('/api/availability?from=' + CAT.range.from + '&to=' + CAT.range.to);
      AVAIL = (await r.json()).days;
      renderCal();
    } catch (e) { $('cal').innerHTML = ''; $('dateErr').textContent = 'We couldn\'t load available days. Please refresh the page.'; }
  }
  function dayInfo(date) { return AVAIL && AVAIL.find(function (d) { return d.date === date; }); }
  function renderCal() {
    var cal = $('cal'); cal.innerHTML = '';
    var head = document.createElement('div'); head.className = 'cal-head';
    DAYS.forEach(function (d) { var s = document.createElement('span'); s.textContent = d; s.setAttribute('aria-hidden', 'true'); head.append(s); });
    cal.append(head);
    var first = parse(CAT.range.from), last = parse(CAT.range.to);
    var start = new Date(first); start.setUTCDate(start.getUTCDate() - (wd(iso(first)) - 1));
    var end = new Date(last); end.setUTCDate(end.getUTCDate() + (7 - wd(iso(last))));
    var month = -1, week = null;
    for (var d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      var ds = iso(d), w = wd(ds);
      if (w === 1) {
        // label the month of the first in-range day this week
        var lab = new Date(Math.max(d.getTime(), first.getTime()));
        if (lab.getUTCMonth() !== month) {
          month = lab.getUTCMonth();
          var m = document.createElement('p'); m.className = 'cal-month'; m.textContent = MONTHS[month] + ' ' + lab.getUTCFullYear(); cal.append(m);
        }
        week = document.createElement('div'); week.className = 'cal-week'; week.setAttribute('role', 'group'); cal.append(week);
      }
      var b = document.createElement('button'); b.type = 'button'; b.className = 'day';
      var info = dayInfo(ds);
      if (d < first || d > last) { b.className = 'day blank'; b.disabled = true; b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); }
      else {
        var left = info ? info.windows.reduce(function (a, x) { return a + x.left; }, 0) : 0;
        var ok = info && info.bookable;
        b.disabled = !ok;
        b.dataset.date = ds;
        b.setAttribute('aria-pressed', String(st.date === ds));
        var why = !info ? 'unavailable' : info.reason === 'sunday' ? 'closed Sundays' : info.reason === 'full' ? 'fully booked' : info.reason ? 'unavailable' : left + ' spaces';
        b.setAttribute('aria-label', longDate(ds) + ', ' + why);
        b.textContent = String(d.getUTCDate());
        if (ok && left <= 3) { var sm = document.createElement('small'); sm.textContent = left + ' left'; b.append(sm); }
        if (info && info.reason === 'full') { var f = document.createElement('small'); f.textContent = 'full'; b.append(f); }
      }
      week.append(b);
    }
    if (st.date && !(dayInfo(st.date) || {}).bookable) { st.date = null; st.window = null; }
    renderWindows();
  }
  function renderWindows() {
    var info = st.date && dayInfo(st.date);
    $('winBlock').hidden = !info;
    if (!info) return;
    $('winLabel').textContent = 'Time window on ' + longDate(st.date);
    var box = $('wins'); box.innerHTML = '';
    info.windows.forEach(function (w) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.dataset.window = w.id;
      b.disabled = w.left <= 0; b.setAttribute('aria-pressed', String(st.window === w.id));
      var t = document.createElement('span'); t.className = 't'; t.textContent = w.label;
      var d = document.createElement('span'); d.className = 'd'; d.textContent = w.left <= 0 ? 'Full' : w.left + ' left';
      b.append(t, d); box.append(b);
    });
    if (st.window && !info.windows.some(function (w) { return w.id === st.window && w.left > 0; })) st.window = null;
  }
  function pickDate(ds) {
    st.date = ds; st.window = null;
    document.querySelectorAll('.day[data-date]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.date === ds)); });
    renderWindows(); renderSummary(); save();
    var info = dayInfo(ds);
    $('availLive').textContent = longDate(ds) + ': ' + info.windows.map(function (w) { return w.label + ' ' + (w.left > 0 ? w.left + ' left' : 'full'); }).join(', ');
    var firstOpen = $('wins').querySelector('button:not([disabled])'); if (firstOpen) firstOpen.focus();
  }
  function pickWindow(id) {
    st.window = id;
    document.querySelectorAll('#wins [data-window]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.window === id)); });
    $('dateErr').textContent = '';
    renderSummary(); save();
    if ($('s-details').hidden) { scrollTo(show('s-details')); setTimeout(function () { $('name').focus({ preventScroll: true }); }, 350); }
    else if (!$('s-pay').hidden) renderPay();
  }

  // ---------- step 5: details ----------
  function details() {
    return { name: $('name').value.trim(), email: $('email').value.trim(), phone: $('phone').value.trim(), addr1: $('addr1').value.trim(), addr2: $('addr2').value.trim(),
      town: $('town').value.trim(), access: $('access').value.trim(), collection: $('collection').value };
  }
  function validateDetails() {
    var d = details(), bad = null;
    var rules = [
      ['name', !d.name && 'Please enter your name.'],
      ['email', !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) && 'Please enter a valid email address.'],
      ['phone', !/^(?:\+44|0044|0)7\d{9}$/.test(d.phone.replace(/[\s().-]/g, '')) && 'Please enter a UK mobile number, like 07700 900123.'],
      ['addr1', !d.addr1 && 'Please enter your address.'],
      ['town', !d.town && 'Please enter your town.'],
    ];
    rules.forEach(function (r) { var el = $(r[0]); el.setAttribute('aria-invalid', r[1] ? 'true' : 'false'); if (r[1] && !bad) bad = [el, r[1]]; });
    $('detailsErr').textContent = bad ? bad[1] : '';
    if (bad) bad[0].focus();
    return !bad;
  }

  // ---------- step 6: pay ----------
  async function renderPay() {
    var p = lines();
    var when = longDate(st.date) + ', ' + windowLabel(st.window);
    $('plainSummary').textContent = st.plan === 'recurring'
      ? 'Today you pay ' + gbp(p.first) + ' for your first clean on ' + shortDate(st.date) + ', ' + windowLabel(st.window) + '. Then ' + gbp(p.recurring) + ' on the morning of each clean, every 4 weeks. Cancel anytime up to 24 hours before a clean.'
      : 'Today you pay ' + gbp(p.first) + ' for a one-off clean on ' + when + '. Cancel or reschedule free up to 24 hours before.';
    var box = $('payLines'); box.innerHTML = '';
    p.lines.forEach(function (l) {
      var row = document.createElement('div'); row.className = 'ln';
      var a = document.createElement('span'); a.textContent = l.name + (l.qty > 1 ? ' ×' + l.qty : '') + (l.addon && st.plan === 'recurring' ? ' (first clean only)' : '');
      var b = document.createElement('span'); b.textContent = gbp(l.unit * l.qty);
      row.append(a, b); box.append(row);
    });
    var tot = document.createElement('div'); tot.className = 'ln tot';
    var ta = document.createElement('span'); ta.textContent = 'Pay today';
    var tb = document.createElement('span'); tb.textContent = gbp(p.first);
    tot.append(ta, tb); box.append(tot);
    // confirm against the server price (what will actually be charged)
    try {
      var r = await fetch('/api/quote-price', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: st.plan, items: itemsPayload(), deep_clean: st.deep }) });
      var d = await r.json();
      if (r.ok && (d.first_pence !== p.first || d.recurring_pence !== p.recurring)) {
        tb.textContent = gbp(d.first_pence);
        $('payErr').textContent = 'Prices have just changed. Today you pay ' + gbp(d.first_pence) + (st.plan === 'recurring' ? ', then ' + gbp(d.recurring_pence) + ' every 4 weeks.' : '.');
      }
    } catch (e) {}
  }

  async function submit(e) {
    e.preventDefault();
    $('payErr').textContent = '';
    if (!lines().hasMain) { $('binsErr').textContent = 'Choose at least one bin.'; scrollTo($('s-bins')); return; }
    if (!st.date || !st.window) { $('dateErr').textContent = 'Choose a day and a time window.'; scrollTo($('s-date')); return; }
    if (!validateDetails()) return;
    if (!$('terms').checked) { $('payErr').textContent = 'Please tick the box to agree to the terms.'; $('terms').focus(); return; }
    var d = details();
    var body = {
      postcode: st.postcode, plan: st.plan, items: itemsPayload(), deep_clean: st.deep, date: st.date, window: st.window, terms: true,
      'bf-check': $('bf-check').value,
      customer: { name: d.name, email: d.email, phone: d.phone, address_line1: d.addr1, address_line2: d.addr2, town: d.town, postcode: st.postcode, access_notes: d.access, collection_day: d.collection },
    };
    save();
    $('payBtn').disabled = true; $('payBtn').textContent = 'Taking you to payment…';
    try {
      var r = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      var out = await r.json().catch(function () { return {}; });
      if (r.ok && out.url) { location.href = out.url; return; }
      $('payErr').textContent = out.error || 'Something went wrong. Please try again.';
      if (out.code === 'full' || (out.code || '').indexOf('date_') === 0) { AVAIL = null; st.window = null; await loadAvailability(); renderSummary(); }
    } catch (err) { $('payErr').textContent = 'We couldn\'t reach the server. Check your connection and try again.'; }
    $('payBtn').disabled = false; $('payBtn').textContent = 'Continue to secure payment';
  }

  function nextStep() {
    var order = ['s-postcode', 's-plan', 's-bins', 's-date', 's-details', 's-pay'];
    var target = order.find(function (id) {
      if ($(id).hidden) return false;
      if (id === 's-postcode') return !st.postcode;
      if (id === 's-bins') return !lines().hasMain;
      if (id === 's-date') return !st.date || !st.window;
      if (id === 's-details') return $('s-pay').hidden;
      return id === 's-pay';
    }) || order.filter(function (id) { return !$(id).hidden; }).pop();
    scrollTo($(target));
  }

  // ---------- wire up ----------
  $('pcBtn').addEventListener('click', checkPostcode);
  $('postcode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); checkPostcode(); } });
  document.querySelectorAll('[data-plan]').forEach(function (b) { b.addEventListener('click', function () { st.plan = b.dataset.plan; renderPlan(); binsChanged(); }); });
  $('tiers').addEventListener('click', function (e) { var b = e.target.closest('[data-tier]'); if (!b) return; st.tier = st.tier === b.dataset.tier ? null : b.dataset.tier; binsChanged(); });
  $('xlMinus').addEventListener('click', function () { if (st.xl > 0) { st.xl--; binsChanged(); } });
  $('xlPlus').addEventListener('click', function () { if (st.xl < 3) { st.xl++; binsChanged(); } });
  $('deepSwitch').addEventListener('click', function () { st.deep = !st.deep; binsChanged(); });
  $('cal').addEventListener('click', function (e) { var b = e.target.closest('.day[data-date]'); if (b && !b.disabled) pickDate(b.dataset.date); });
  $('wins').addEventListener('click', function (e) { var b = e.target.closest('[data-window]'); if (b && !b.disabled) pickWindow(b.dataset.window); });
  $('detailsBtn').addEventListener('click', function () { if (validateDetails()) { save(); renderPay(); scrollTo(show('s-pay')); } });
  ['name', 'email', 'phone', 'addr1', 'addr2', 'town', 'access', 'collection'].forEach(function (k) { $(k).addEventListener('change', save); });
  $('bookForm').addEventListener('submit', submit);
  $('sheetNext').addEventListener('click', nextStep);

  (async function init() {
    try {
      var r = await fetch('/api/services');
      CAT = await r.json();
    } catch (e) { $('pcErr').textContent = 'Booking is unavailable right now. Please call 07394 536053.'; return; }
    var resumed = params.has('resume') && restore();
    if (resumed && params.get('resume')) st.plan = params.get('resume') === 'one-off' ? 'one-off' : 'recurring';
    renderPlan(); renderBins();
    if (resumed && st.postcode) {
      $('postcode').value = st.postcode; $('pc2').value = st.postcode;
      show('s-plan'); show('s-bins');
      if (lines().hasMain) { show('s-date'); await loadAvailability(); }
      if (st.date && st.window) { show('s-details'); show('s-pay'); renderPay(); }
      $('payErr').textContent = st.date && st.window ? 'Payment wasn\'t completed. Check your details and try again.' : '';
    } else {
      $('postcode').focus({ preventScroll: true });
    }
  })();
})();
