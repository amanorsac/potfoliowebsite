/* =====================================================================
   The download gate.

   Any link carrying data-dl opens this instead of downloading. An email
   goes in, a signed link comes back, the download starts. The link is
   good for five minutes and the file has no public address, so there is
   nothing here to walk around - which is the difference between asking
   for an address and requiring one.

   Two things it tries not to be: a wall, and a trick.

   Not a wall - the address is remembered, so the second download, and
   the one after that, do not ask again. Someone who has already given it
   is not asked to prove it twice.

   Not a trick - it says plainly what the address is for and that it can
   be stopped at any time, and the box is not ticked in advance. A list
   built by catching people out is a list that does not open anything.
   ===================================================================== */
(function () {
  var links = document.querySelectorAll('[data-dl]');
  if (!links.length) return;

  var PLATFORM = { win: 'windows', mac: 'mac' };
  var STORE = 'as-dl-email';

  var remembered = '';
  try { remembered = localStorage.getItem(STORE) || ''; } catch (e) {}

  // ---- the panel ------------------------------------------------------
  var el = document.createElement('div');
  el.className = 'dlg';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'dlg-h');
  el.hidden = true;
  el.innerHTML =
    '<div class="dlg-back" data-close></div>' +
    '<div class="dlg-box">' +
      '<button class="dlg-x" type="button" data-close aria-label="Close">&times;</button>' +
      '<p class="dlg-eyebrow" id="dlg-app"></p>' +
      '<h2 id="dlg-h">Where should it go?</h2>' +
      '<p class="dlg-sub">Your download starts as soon as you continue. ' +
        'The address is so I can tell you when the app is updated.</p>' +
      '<form novalidate>' +
        '<label for="dlg-email">Email</label>' +
        '<input id="dlg-email" type="email" autocomplete="email" ' +
               'placeholder="you@example.com" required>' +
        '<label class="dlg-check">' +
          '<input id="dlg-ok" type="checkbox">' +
          '<span>Email me about updates to this app, and occasionally about new ' +
                'writing and releases. One click to stop, any time.</span>' +
        '</label>' +
        '<button class="cta dlg-go" type="submit">Download</button>' +
        '<p class="dlg-msg" role="status"></p>' +
      '</form>' +
    '</div>';
  document.body.appendChild(el);

  var box   = el.querySelector('.dlg-box');
  var form  = el.querySelector('form');
  var email = el.querySelector('#dlg-email');
  var okBox = el.querySelector('#dlg-ok');
  var msg   = el.querySelector('.dlg-msg');
  var go    = el.querySelector('.dlg-go');
  var appEl = el.querySelector('#dlg-app');

  var pending = null;      // {app, platform}
  var lastFocus = null;

  function open(app, platform, label) {
    pending = { app: app, platform: platform };
    appEl.textContent = label || '';
    msg.textContent = '';
    msg.className = 'dlg-msg';
    email.value = remembered;
    okBox.checked = !!remembered;   // already agreed once; do not re-ask
    go.disabled = false;
    go.textContent = 'Download';
    lastFocus = document.activeElement;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function(){ (remembered ? go : email).focus(); }, 30);
  }

  function close() {
    el.hidden = true;
    document.body.style.overflow = '';
    pending = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  el.addEventListener('click', function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-close')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (el.hidden) return;
    if (e.key === 'Escape') { close(); return; }
    // keep tab inside the panel while it is open
    if (e.key === 'Tab') {
      var f = box.querySelectorAll('button, input, [href]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---- the buttons ----------------------------------------------------
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function (e) {
      var a = e.currentTarget;
      var app = (a.getAttribute('data-dl-app') || document.body.getAttribute('data-app') || '').toLowerCase();
      var platform = PLATFORM[a.getAttribute('data-dl')] || '';
      if (!app || !platform) return;          // not configured: leave the link alone
      e.preventDefault();
      open(app, platform, (a.textContent || '').trim());
    });
  }

  // ---- asking for it --------------------------------------------------
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!pending) return;

    var address = email.value.trim();
    if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(address)) {
      say('That does not look like an email address.', true); email.focus(); return;
    }
    if (!okBox.checked) { say('Please tick the box to continue.', true); return; }

    go.disabled = true; go.textContent = 'One moment';
    say('');

    fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: address, app: pending.app, platform: pending.platform,
        consent: true, source: location.pathname
      })
    })
    .then(function (r) { return r.json().catch(function(){ return {}; }); })
    .then(function (j) {
      if (!j || !j.url) {
        say((j && j.error) || 'Something went wrong. Try again in a moment.', true);
        go.disabled = false; go.textContent = 'Download';
        return;
      }
      remembered = address;
      try { localStorage.setItem(STORE, address); } catch (err) {}
      if (window.track) window.track('download', pending.app + ' / ' + pending.platform);

      /* Navigating straight to the link would leave the page. An anchor
         clicked in the background starts the download and leaves the
         reader where they were. */
      var a = document.createElement('a');
      a.href = j.url;
      a.setAttribute('download', '');
      document.body.appendChild(a);
      a.click();
      a.remove();

      go.textContent = 'Downloading';
      say('On its way. Check your downloads folder.');
      setTimeout(close, 2200);
    })
    .catch(function () {
      say('Could not reach the studio. Check your connection and try again.', true);
      go.disabled = false; go.textContent = 'Download';
    });
  });

  function say(text, bad) {
    msg.textContent = text;
    msg.className = 'dlg-msg' + (bad ? ' bad' : '');
  }
})();
