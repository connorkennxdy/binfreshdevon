/* Bin Fresh Devon — site behaviour. No dependencies. */

/* Bookings: every "Book" button links to /book (our own booking page). */

(function () {
  // Header: navy at top → frosted white + colour logo after scrolling
  var header = document.getElementById('site-header');
  var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 24); };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Mobile menu
  var toggle = document.querySelector('.menu-toggle');
  var menu = document.getElementById('mobile-menu');
  var setMenu = function (open) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close' : 'Menu';
    menu.hidden = !open;
  };
  toggle.addEventListener('click', function () { setMenu(menu.hidden); });
  menu.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); toggle.focus(); } });
  window.matchMedia('(min-width: 1080px)').addEventListener('change', function (m) { if (m.matches) setMenu(false); });

  // Mobile sticky booking bar: only after the hero has scrolled away
  var bar = document.querySelector('.mobile-bar');
  var hero = document.getElementById('top');
  if (bar && hero) {
    var onBar = function () { bar.classList.toggle('is-visible', hero.getBoundingClientRect().bottom < 0); };
    onBar();
    window.addEventListener('scroll', onBar, { passive: true });
  }

  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  // Quote form — client validation + Netlify Forms AJAX submit
  var form = document.getElementById('quote-form');
  if (!form) return;
  // Out-of-area postcodes from /book arrive as /?postcode=EX1%201AA#contact: prefill the quote form.
  try {
    var pc = new URLSearchParams(location.search).get('postcode');
    if (pc && form.elements.postcode && !form.elements.postcode.value) form.elements.postcode.value = pc.toUpperCase().slice(0, 10);
  } catch (e) {}
  var success = document.getElementById('form-success');
  var alertBox = document.getElementById('form-alert');
  var submitBtn = form.querySelector('.btn-submit');
  var touched = false;

  var rules = {
    name: function (v) { return v ? '' : 'Please enter your name.'; },
    email: function (v) {
      if (!v) return 'Please enter your email address.';
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'Please enter a valid email address, like name@example.com.';
    },
    phone: function (v) { return !v || /^[0-9 +()-]{10,16}$/.test(v) ? '' : 'Please enter a valid UK phone number.'; },
    postcode: function (v) {
      if (!v) return 'Please enter your postcode.';
      return /^[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}$/i.test(v) ? '' : 'Please enter a full UK postcode, like EX1 1AA.';
    },
    message: function (v) { return v ? '' : 'Please tell us a little about what you need.'; }
  };

  function validate() {
    var firstBad = null;
    Object.keys(rules).forEach(function (name) {
      var input = form.elements[name];
      var msg = rules[name](input.value.trim());
      var err = document.getElementById(input.id + '-err');
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (err) { err.textContent = msg; err.hidden = !msg; }
      if (msg && !firstBad) firstBad = input;
    });
    return firstBad;
  }

  form.addEventListener('input', function () {
    if (touched) validate();
    alertBox.hidden = true;
  });

  function setLoading(on) {
    submitBtn.disabled = on;
    submitBtn.setAttribute('aria-busy', String(on));
    submitBtn.textContent = on ? 'Sending…' : 'Send enquiry';
  }

  // Make.com webhook: sends each genuine enquiry alongside Netlify Forms
  var MAKE_WEBHOOK = 'https://hook.eu1.make.com/k2xdbl3n6lku33rhid51jbjvkqyif5yb';
  function sendToMake(data) {
    if (String(data.get('bf-check') || '').trim()) return; // honeypot filled: spam
    var p = new URLSearchParams();
    ['name', 'email', 'phone', 'postcode', 'bins', 'message', 'subject'].forEach(function (k) {
      p.append(k, String(data.get(k) || '').trim());
    });
    p.set('postcode', p.get('postcode').toUpperCase());
    p.append('form', 'quote');
    p.append('page', location.href);
    p.append('submitted_at', new Date().toISOString());
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(MAKE_WEBHOOK, p)) return;
    } catch (e) {}
    try {
      fetch(MAKE_WEBHOOK, { method: 'POST', mode: 'no-cors', keepalive: true, body: p });
    } catch (e) {}
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    touched = true;
    var bad = validate();
    if (bad) { bad.focus(); return; }
    var subj = document.getElementById('f-subject');
    if (subj) subj.value = 'New enquiry: ' + form.elements.name.value.trim() + ' (' + form.elements.postcode.value.trim().toUpperCase() + ')';
    setLoading(true);
    alertBox.hidden = true;
    var data = new FormData(form);
    var body = new URLSearchParams();
    data.forEach(function (v, k) { body.append(k, typeof v === 'string' ? v : ''); });
    sendToMake(data);
    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }).then(function (res) {
      if (!res.ok) throw new Error(res.status);
      document.getElementById('success-name').textContent = form.elements.name.value.trim().split(' ')[0] || 'there';
      form.hidden = true;
      success.hidden = false;
      success.focus();
    }).catch(function (err) {
      // Network or fetch problem (some mobile browsers/in-app browsers): fall back to a normal form post
      if (!(err && /^\d+$/.test(err.message))) { HTMLFormElement.prototype.submit.call(form); return; }
      alertBox.hidden = false;
    }).finally(function () { setLoading(false); });
  });

  document.getElementById('form-reset').addEventListener('click', function () {
    form.reset();
    touched = false;
    form.querySelectorAll('[aria-invalid]').forEach(function (i) { i.setAttribute('aria-invalid', 'false'); });
    form.querySelectorAll('.field-error').forEach(function (p) { p.hidden = true; });
    success.hidden = true;
    form.hidden = false;
    form.elements.name.focus();
  });
})();
