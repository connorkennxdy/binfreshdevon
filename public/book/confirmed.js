(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var gbp = function (p) { return '£' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var sid = new URLSearchParams(location.search).get('session_id') || '';
  try { sessionStorage.removeItem('bf_book'); } catch (e) {}
  var started = Date.now();
  function row(a, b, tot) {
    var r = document.createElement('div'); r.className = 'ln' + (tot ? ' tot' : '');
    var x = document.createElement('span'); x.textContent = a; var y = document.createElement('span'); y.textContent = b;
    r.append(x, y); return r;
  }
  async function poll() {
    try {
      var r = await fetch('/api/booking-status?session_id=' + encodeURIComponent(sid));
      var d = await r.json();
      if (d.status === 'confirmed') {
        $('waiting').hidden = true; $('done').hidden = false;
        $('doneTitle').textContent = 'You\'re booked in, ' + d.first_name + '.';
        $('doneWhen').textContent = (d.plan_confirm ? 'Your next clean is on ' : 'We\'ll clean your bins on ') + d.date_label + ', ' + d.window_label + '.';
        var box = $('doneLines');
        box.append(row('What', d.items));
        if (!d.plan_confirm) box.append(row('Paid today', gbp(d.paid_pence), true));
        if (d.plan) box.append(row('Every 4 weeks', gbp(d.recurring_pence) + ', charged the morning of each clean'));
        $('done').focus && $('doneTitle').setAttribute('tabindex', '-1'); $('doneTitle').focus();
        return;
      }
    } catch (e) {}
    if (Date.now() - started > 20000) { $('waiting').hidden = true; $('slow').hidden = false; return; }
    setTimeout(poll, 2000);
  }
  if (!/^cs_/.test(sid)) { $('waiting').hidden = true; $('slow').hidden = false; return; }
  poll();
})();
