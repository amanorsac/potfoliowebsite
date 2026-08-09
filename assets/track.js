/* =====================================================================
   Page-view tracking for amanorsac.studio

   Deliberately tiny and deliberately dumb. It sends one row per page
   view and then goes quiet - no cookies, no fingerprinting, no third
   party, nothing that follows a person between visits. The "session" is
   a random string kept in sessionStorage, which the browser throws away
   when the tab closes.

   It talks straight to one Postgres function through Supabase's REST
   endpoint, so there is no client library to download. The key below is
   the publishable one; the function it calls can only write.

   Nothing here blocks the page: the request is fired with keepalive
   after load, and every failure is swallowed. Analytics must never be
   the reason a page is slow or broken.
   ===================================================================== */
(function () {
  var URL = 'https://kdxckigyhpnwhwgjdgqq.supabase.co';
  var KEY = 'sb_publishable_PlVBmRgFdhTkVMurXLiBFQ_NjiVssQp';

  try {
    /* Honour Do Not Track, and stay out of the way of local work. */
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    var host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') return;

    /* A session is one tab, and it dies with the tab. */
    var key = 'as-sid', sid = null, fresh = true;
    try {
      sid = sessionStorage.getItem(key);
      if (sid) { fresh = false; }
      else {
        sid = (crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : String(Date.now()) + Math.random().toString(36).slice(2);
        sessionStorage.setItem(key, sid);
      }
    } catch (e) { /* private mode: still counts, just always looks new */ }

    /* Where they came from - the host only. Never the full URL, which
       can carry someone's search terms or a private link. */
    var ref = '';
    try {
      if (document.referrer) {
        var r = new window.URL(document.referrer);
        if (r.hostname && r.hostname !== host) ref = r.hostname.replace(/^www\./, '');
      }
    } catch (e) {}

    /* Coarse enough to be useful, coarse enough to be harmless. */
    var w = window.innerWidth || 0;
    var device = w && w < 700 ? 'phone' : (w < 1100 ? 'tablet' : 'desktop');

    /* Clean paths so /mixing and /mixing.html count as one page. */
    var path = location.pathname.replace(/index\.html$/, '').replace(/\.html$/, '');
    if (path.length > 1) path = path.replace(/\/$/, '');
    if (!path) path = '/';

    var send = function () {
      try {
        fetch(URL + '/rest/v1/rpc/track_view', {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY },
          body: JSON.stringify({
            p_path: path,
            p_title: (document.title || '').slice(0, 200),
            p_ref_host: ref || null,
            p_device: device,
            p_session: sid,
            p_is_new: fresh
          })
        }).catch(function () {});
      } catch (e) {}
    };

    /* After the page has settled, so it never competes with the content. */
    if (document.readyState === 'complete') setTimeout(send, 300);
    else window.addEventListener('load', function () { setTimeout(send, 300); });
  } catch (e) { /* analytics never breaks a page */ }
})();
