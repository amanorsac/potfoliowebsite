/* =====================================================================
   The download gate.

   Any link carrying data-dl opens this instead of downloading. An
   address goes in and a link goes to that inbox; clicking it confirms
   the address and starts the download. The file has no public address of
   its own, so there is nothing to walk around.

   The cost of doing it this way is real and worth naming: some people
   will not bother, and the download numbers will be lower than a form
   that hands the file over on the spot. What is bought with it is a list
   where every address exists and its owner asked to be there - which is
   the only kind worth writing to, because made-up addresses bounce and
   bounces are what stop the real ones arriving.

   It tries not to be a trick. It says plainly what the address is for,
   that it can be stopped at any time, and the box is not ticked in
   advance.
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
      '<p class="dlg-sub">I will send a link to confirm the address, and ' +
        'that link starts your download. It keeps the list to people who ' +
        'actually asked to be on it.</p>' +
      '<form novalidate>' +
        '<label class="dlg-field" for="dlg-email">Email</label>' +
        '<input id="dlg-email" type="email" autocomplete="email" ' +
               'placeholder="you@example.com" required>' +
        '<label class="dlg-check">' +
          '<input id="dlg-ok" type="checkbox">' +
          '<span>Email me about updates to this app, and occasionally about new ' +
                'writing and releases. One click to stop, any time.</span>' +
        '</label>' +
        '<button class="cta dlg-go" type="submit">Send me the link</button>' +
        '<p class="dlg-size" id="dlg-size"></p>' +
        '<p class="dlg-msg" role="status"></p>' +
      '</form>' +
      '<div class="dlg-done" hidden>' +
        '<p class="dlg-tick" aria-hidden="true">&#10003;</p>' +
        '<h3>Check your email</h3>' +
        '<p>A link is on its way to <b class="dlg-addr"></b>. Clicking it ' +
          'confirms the address and starts the download.</p>' +
        '<p class="dlg-small">Nothing in the junk folder either? Give it a minute, ' +
          'then try again &mdash; a typo in the address is the usual reason.</p>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);

  var box   = el.querySelector('.dlg-box');
  var form  = el.querySelector('form');
  var email = el.querySelector('#dlg-email');
  var okBox = el.querySelector('#dlg-ok');
  var msg   = el.querySelector('.dlg-msg');
  var go    = el.querySelector('.dlg-go');
  var appEl = el.querySelector('#dlg-app');
  var sizeEl = el.querySelector('#dlg-size');
  var done   = el.querySelector('.dlg-done');
  var doneAddr = el.querySelector('.dlg-addr');

  var pending = null;      // {app, platform}
  var lastFocus = null;

  function open(app, platform, label, size) {
    pending = { app: app, platform: platform };
    appEl.textContent = label || '';
    // 171 MB is worth knowing before the download starts, not after
    sizeEl.textContent = size || '';
    msg.textContent = '';
    msg.className = 'dlg-msg';
    email.value = remembered;
    okBox.checked = !!remembered;   // already agreed once; do not re-ask
    go.disabled = false;
    go.textContent = 'Send me the link';
    form.hidden = false;
    done.hidden = true;
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
      open(app, platform, (a.textContent || '').trim(), a.getAttribute('data-dl-size') || '');
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

    go.disabled = true; go.textContent = 'Sending';
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
      if (!j || !j.sent) {
        say((j && j.error) || 'Something went wrong. Try again in a moment.', true);
        go.disabled = false; go.textContent = 'Send me the link';
        return;
      }
      remembered = address;
      try { localStorage.setItem(STORE, address); } catch (err) {}
      if (window.track) window.track('download_requested', pending.app + ' / ' + pending.platform);

      /* The form goes and the instruction takes its place. Leaving the
         form on screen invites a second submission from someone who is
         not sure anything happened. */
      form.hidden = true;
      done.hidden = false;
      doneAddr.textContent = address;
    })
    .catch(function () {
      say('Could not reach the studio. Check your connection and try again.', true);
      go.disabled = false; go.textContent = 'Send me the link';
    });
  });

  function say(text, bad) {
    msg.textContent = text;
    msg.className = 'dlg-msg' + (bad ? ' bad' : '');
  }
})();
