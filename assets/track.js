/* =====================================================================
   Analytics for amanorsac.studio

   Records three things and nothing else:
     1. the page view, with how the visitor arrived and what they are on
     2. how long they stayed and how far they scrolled, sent as they leave
     3. named events - an enquiry sent, a download asked for

   It talks straight to three Postgres functions through Supabase's REST
   endpoint, so there is no client library to download. Those functions
   can only write; the key below cannot read anything back.

   Storage is first-party and modest: a session id in sessionStorage
   that dies with the tab, and a visitor id in localStorage so returning
   visitors can be told apart from new ones. No cookies, no third party,
   nothing shared with anyone.

   Nothing here may block or break a page. Every call is fired after
   load, every failure is swallowed, and the whole file is wrapped in a
   try so a surprise cannot take the site down with it.
   ===================================================================== */
(function () {
  var URL = 'https://kdxckigyhpnwhwgjdgqq.supabase.co';
  var KEY = 'sb_publishable_PlVBmRgFdhTkVMurXLiBFQ_NjiVssQp';

  /* a no-op stand-in, so pages can call track() even if we bail out */
  window.track = function () {};

  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    var host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') return;

    // ---------- who and when ------------------------------------------
    var sid = null, vid = null, fresh = true, returning = false;
    try {
      sid = sessionStorage.getItem('as-sid');
      if (sid) fresh = false; else { sid = rnd(); sessionStorage.setItem('as-sid', sid); }
    } catch (e) {}
    try {
      vid = localStorage.getItem('as-vid');
      if (vid) returning = true; else { vid = rnd(); localStorage.setItem('as-vid', vid); }
    } catch (e) {}
    sid = sid || rnd();

    function rnd() {
      return (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(36).slice(2);
    }

    // ---------- how they got here -------------------------------------
    /* Only the referring host. A full referrer URL can carry someone's
       search terms or a private share link, and that should never land
       in a database. */
    var ref = '';
    try {
      if (document.referrer) {
        var r = new window.URL(document.referrer);
        if (r.hostname && r.hostname !== host) ref = r.hostname.replace(/^www\./, '');
      }
    } catch (e) {}

    var q = new URLSearchParams(location.search);
    var utm = {
      source:   q.get('utm_source')   || (q.get('gclid') ? 'google' : ''),
      medium:   q.get('utm_medium')   || (q.get('gclid') ? 'cpc'    : ''),
      campaign: q.get('utm_campaign') || ''
    };

    // ---------- what they are on --------------------------------------
    var ua = navigator.userAgent || '';
    var w  = window.innerWidth || 0;
    var device = /iPad|Tablet/i.test(ua) || (w >= 700 && w < 1100) ? 'tablet'
               : (w && w < 700) || /Mobi|Android|iPhone/i.test(ua)  ? 'phone'
               : 'desktop';

    var browser =
        /Edg\//.test(ua)                      ? 'Edge'
      : /OPR\/|Opera/.test(ua)                ? 'Opera'
      : /Chrome\//.test(ua)                   ? 'Chrome'
      : /Firefox\//.test(ua)                  ? 'Firefox'
      : /Safari\//.test(ua)                   ? 'Safari'
      :                                         'Other';

    var os =
        /Windows/.test(ua)                    ? 'Windows'
      : /iPhone|iPad|iPod/.test(ua)           ? 'iOS'
      : /Mac OS X/.test(ua)                   ? 'macOS'
      : /Android/.test(ua)                    ? 'Android'
      : /Linux/.test(ua)                      ? 'Linux'
      :                                         'Other';

    /* How long the page took to become usable. Slow pages lose people
       and rank worse, so it is worth knowing. */
    var loadMs = null;
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.duration) loadMs = Math.round(nav.duration);
    } catch (e) {}

    // ---------- one page, one clean name ------------------------------
    var path = location.pathname.replace(/index\.html$/, '').replace(/\.html$/, '');
    if (path.length > 1) path = path.replace(/\/$/, '');
    if (!path) path = '/';

    // ---------- talking to the database -------------------------------
    function call(fn, body) {
      var url = URL + '/rest/v1/rpc/' + fn;
      var payload = JSON.stringify(body);
      try {
        /* keepalive is what lets a request outlive the page being
           closed. sendBeacon looks like the obvious tool here, but it
           cannot set the JSON content type without a preflight it is
           not allowed to make, and PostgREST needs that header - so a
           beacon would fail silently, which is worse than not trying. */
        return fetch(url, {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY },
          body: payload
        }).then(function (r) { return r.ok ? r.json().catch(function () { return null; }) : null; })
          .catch(function () { return null; });
      } catch (e) { return Promise.resolve(null); }
    }

    // ---------- named events ------------------------------------------
    window.track = function (name, label) {
      if (!name) return;
      call('track_event', {
        p_name: String(name).slice(0, 60),
        p_path: path,
        p_label: label ? String(label).slice(0, 160) : null,
        p_session: sid, p_visitor: vid
      });
    };

    // ---------- how far down they got ---------------------------------
    var maxScroll = 0;
    function onScroll() {
      try {
        var h = document.documentElement.scrollHeight - window.innerHeight;
        var pct = h > 0 ? Math.round((window.scrollY / h) * 100) : 100;
        if (pct > maxScroll) maxScroll = Math.min(100, Math.max(0, pct));
      } catch (e) {}
    }
    addEventListener('scroll', onScroll, { passive: true });

    // ---------- the view, then the goodbye ----------------------------
    var viewId = null, started = Date.now(), sent = false;

    function record() {
      call('track_view', {
        p_path: path,
        p_title: (document.title || '').slice(0, 200),
        p_ref_host: ref || null,
        p_device: device,
        p_session: sid,
        p_is_new: fresh,
        p_visitor: vid,
        p_returning: returning,
        p_entry: fresh,                 // the first page of this visit
        p_utm_source: utm.source || null,
        p_utm_medium: utm.medium || null,
        p_utm_campaign: utm.campaign || null,
        p_browser: browser,
        p_os: os,
        p_load_ms: loadMs
      }).then(function (id) { viewId = (typeof id === 'number') ? id : null; });
    }

    function farewell() {
      if (sent || !viewId) return;
      sent = true;
      onScroll();
      call('track_engagement', {
        p_id: viewId,
        p_duration_ms: Math.min(3600000, Date.now() - started),
        p_max_scroll: maxScroll
      });
    }

    /* pagehide is the reliable one on iOS; visibilitychange catches the
       tab being switched away from and never coming back. */
    addEventListener('pagehide', farewell);
    addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') farewell();
    });

    // ---------- the things worth calling conversions ------------------
    /* Anything marked data-track fires by name. On top of that, a few
       are wired here so the pages themselves stay clean. */
    addEventListener('click', function (e) {
      try {
        var el = e.target.closest('[data-track], a');
        if (!el) return;

        var named = el.closest('[data-track]');
        if (named) { window.track(named.getAttribute('data-track'),
                                  (named.textContent || '').trim().slice(0, 80)); return; }

        var href = el.getAttribute('href') || '';
        if (/#access|early access/i.test(href + ' ' + el.textContent)) window.track('early_access', path);
        else if (/^\/client|client\.html/.test(href))                  window.track('client_login');
        else if (/^mailto:/.test(href))                                window.track('email_click');
        else if (/^https?:/.test(href) && href.indexOf(host) === -1)   window.track('outbound', href.slice(0, 160));
      } catch (err) {}
    }, true);

    /* The enquiry form is the one that really matters. */
    addEventListener('submit', function (e) {
      try { if (e.target && e.target.id === 'contact-form') window.track('enquiry', path); } catch (err) {}
    }, true);

    if (document.readyState === 'complete') setTimeout(record, 200);
    else addEventListener('load', function () { setTimeout(record, 200); });
  } catch (e) { /* analytics never breaks a page */ }
})();
