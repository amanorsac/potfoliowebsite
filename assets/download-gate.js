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
      '<h2 id="dlg-h">Verify your email</h2>' +
      /* Say what the button does before it is pressed. The old wording
         promised the download started "as soon as you continue", which
         was not what happened next, and being surprised by a website is
         how people decide it is broken. */
      /* No app name and no price here: this one panel now opens on
         every app page, and a claim that is true of one app becomes a
         lie on the next. The page behind it does the selling. */
      '<p class="dlg-sub">Enter your email and I will send a verification ' +
        'link &mdash; opening it verifies the address and starts the ' +
        'download.</p>' +
      '<form novalidate>' +
        '<label class="dlg-field" for="dlg-email">Email</label>' +
        '<input id="dlg-email" type="email" autocomplete="email" ' +
               'placeholder="you@example.com" required>' +
        '<label class="dlg-check">' +
          '<input id="dlg-ok" type="checkbox">' +
          '<span>Email me about updates to this app, and occasionally about new ' +
                'writing and releases. One click to stop, any time.</span>' +
        '</label>' +
        '<button class="cta dlg-go" type="submit">Send verification link</button>' +
        '<p class="dlg-size" id="dlg-size"></p>' +
        '<p class="dlg-msg" role="status"></p>' +
      '</form>' +
      '<div class="dlg-done" hidden>' +
        '<p class="dlg-tick" aria-hidden="true">&#9993;</p>' +
        /* No heading of its own. The one at the top of the panel changes
           instead - two headings stacked up, one of them still asking
           for an address that has just been given, is how a panel starts
           reading like a form that failed. */
        '<p>A verification link is on its way to <b class="dlg-addr"></b>. ' +
          'Opening it verifies your email and the download begins.</p>' +
        '<p class="dlg-small">No sign of it? Look in spam or promotions first.</p>' +
        /* The two things anyone actually needs at this point: send it
           again, or admit the address was wrong. Without them the only
           way out of this panel is to close it and start over, which is
           where people give up. */
        '<div class="dlg-again">' +
          '<button class="dlg-link dlg-resend" type="button">Resend link</button>' +
          '<span class="dlg-dot" aria-hidden="true">&middot;</span>' +
          '<button class="dlg-link dlg-edit" type="button">Use a different address</button>' +
        '</div>' +
        '<p class="dlg-msg dlg-msg2" role="status"></p>' +
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
  var head   = el.querySelector('#dlg-h');
  var sub    = el.querySelector('.dlg-sub');
  var resend = el.querySelector('.dlg-resend');
  var editBtn = el.querySelector('.dlg-edit');
  var msg2   = el.querySelector('.dlg-msg2');
  var cooldown = 0;      // seconds left before another letter may be sent
  var ticking = null;

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
    go.textContent = 'Send verification link';
    showForm();
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
  function ask(address) {
    return fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: address, app: pending.app, platform: pending.platform,
        consent: true, source: location.pathname
      })
    })
    .then(function (r) { return r.json().catch(function(){ return {}; }); });
  }

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

    ask(address).then(function (j) {
      if (!j || !j.sent) {
        say((j && j.error) || 'The link would not send. Try again in a moment.', true);
        go.disabled = false; go.textContent = 'Send verification link';
        return;
      }
      remembered = address;
      try { localStorage.setItem(STORE, address); } catch (err) {}
      if (window.track) window.track('download_requested', pending.app + ' / ' + pending.platform);

      /* The form goes and the instruction takes its place. Leaving the
         form on screen invites a second submission from someone who is
         not sure anything happened. */
      doneAddr.textContent = address;
      showDone();
      startClock();
    })
    .catch(function () {
      say('Could not reach the studio. Check your connection and try again.', true);
      go.disabled = false; go.textContent = 'Send verification link';
    });
  });

  /* Sending again is the first thing anyone reaches for when a letter is
     slow, and the second is sending it four more times. The wait is
     there so the fourth press does not turn one person into four
     identical letters that all arrive at once. */
  resend.addEventListener('click', function () {
    if (cooldown > 0 || !pending) return;
    var address = doneAddr.textContent;
    resend.disabled = true;
    note('Sending');
    ask(address).then(function (j) {
      note(j && j.sent ? 'Sent again. It can take a minute.'
                       : ((j && j.error) || 'That did not send. Try again shortly.'),
           !(j && j.sent));
      if (j && j.sent) startClock(); else resend.disabled = false;
    }).catch(function () {
      note('Could not reach the studio.', true);
      resend.disabled = false;
    });
  });

  // wrong address typed: back to the form with it loaded, ready to fix
  editBtn.addEventListener('click', function () {
    note('');
    email.value = doneAddr.textContent;
    showForm();
    email.focus();
    email.select();
  });

  /* The heading carries the state, so the panel reads as one step that
     moved on rather than two panels fighting over the same box. */
  function showForm() {
    stopClock();
    head.textContent = 'Verify your email';
    sub.hidden = false;
    done.hidden = true;
    form.hidden = false;
    go.disabled = false;
    go.textContent = 'Send verification link';
  }
  function showDone() {
    head.textContent = 'Check your inbox';
    sub.hidden = true;
    form.hidden = true;
    done.hidden = false;
  }

  function startClock() {
    cooldown = 30;
    stopClock(true);
    tick();
    ticking = setInterval(tick, 1000);
  }
  function tick() {
    if (cooldown <= 0) { stopClock(); return; }
    resend.disabled = true;
    resend.textContent = 'Resend link in ' + cooldown + 's';
    cooldown--;
  }
  function stopClock(keepCount) {
    if (ticking) { clearInterval(ticking); ticking = null; }
    if (!keepCount) cooldown = 0;
    resend.disabled = false;
    resend.textContent = 'Resend link';
  }

  function say(text, bad) {
    msg.textContent = text;
    msg.className = 'dlg-msg' + (bad ? ' bad' : '');
  }
  function note(text, bad) {
    msg2.textContent = text;
    msg2.className = 'dlg-msg dlg-msg2' + (bad ? ' bad' : '');
  }
})();
