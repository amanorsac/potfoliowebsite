/* =====================================================================
   The only code on this site that runs on a server.

   It answers two addresses and nothing else:

     /blog/<post>   a published post, assembled from the database and
                    post-template.html
     /sitemap.xml   the fixed pages plus every published post

   Everything else - every page, image, font and stylesheet - is handed
   straight back to Cloudflare's file server, which is what was serving
   the whole site before this file existed.

   Why assemble a post here rather than in the browser: a page put
   together by JavaScript reaches a search engine, and every link preview
   on every messaging app, as an empty shell. No title, no description,
   no picture. Those readers do not run scripts. Building the page before
   it is sent is what makes the Google result and the WhatsApp card real.

   The rule this file lives by: it must never be able to take the site
   down. Every path through it is wrapped, and anything unexpected ends
   with the request being served exactly as it would have been if this
   file were not here.

   The key below is the publishable one, the same key the public pages
   carry. It can only see published posts, because that is all the
   row-level policy on the table allows. Drafts are not filtered out
   here - they are unreachable with it.
   ===================================================================== */

const SUPABASE_URL = 'https://kdxckigyhpnwhwgjdgqq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PlVBmRgFdhTkVMurXLiBFQ_NjiVssQp';
const SITE = 'https://amanorsac.studio';

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const path = new URL(request.url).pathname;

        if (path === '/sitemap.xml') return await sitemap();

        const m = path.match(/^\/blog\/([^/]+)\/?$/);
        if (m) return await postPage(decodeURIComponent(m[1]), env, request,
                                     new URL(request.url).searchParams.has('diag'));

        // a ticketed installer. A bad or stale ticket falls through to
        // the 404 below, so there is nothing here to probe at.
        if (path === '/download/confirm') {
          const page = await confirmDownload(new URL(request.url), env);
          if (page) return page;
        }

        const d = path.match(/^\/download\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
        if (d) {
          const file = await serveInstaller(d[1], d[2], new URL(request.url), env, request);
          if (file) return file;
        }
      }

      // the only thing on this site that accepts a POST
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/download') {
        return await handoutDownload(request, env);
      }
    } catch (e) {
      // fall through: a broken blog is not a reason for a broken site
    }

    /* Everything else is a file, or is nothing. The asset layer is no
       longer allowed to answer for "nothing" - that setting is what kept
       this Worker from ever running - so the 404 page is served here
       instead, with the status to match. */
    try {
      const res = await env.ASSETS.fetch(request);
      if (res && res.status === 404) return await notFound(env, request);
      return res;
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  }
};


/* ---------------------------------------------------------------------
   handing out an installer

   Two halves, on purpose.

   POST /api/download   an email goes in, the person is recorded, and a
                        ticket comes back: a path with a signature on it,
                        good for fifteen minutes.
   GET  /download/...   checks the signature and streams the file out of
                        R2. Without a valid ticket it is a 404, so there
                        is no address to pass around and no way past the
                        form.

   It is split because these files are 78 MB and 171 MB. Sending one back
   as the answer to a form submission would mean holding it in memory
   before saving it; a normal GET hands it to the browser's own download
   manager, which shows progress and can resume.

   Nothing here holds a key to anything. The bucket arrives as a binding,
   and the mailing list is written through a function that can only
   write. The one secret is the string the ticket is signed with, and the
   worst it could do in the wrong hands is let somebody download a free
   app without leaving an address.
   --------------------------------------------------------------------- */

/* What may be asked for. A fixed map, so no amount of creativity in the
   request can name a file that is not on this list.

   Two keys each, tried in order: in a pulseroom/ folder, or loose at the
   top of the bucket. Uploading a 179 MB file a second time because the
   Worker wanted a folder in front of the name is not a good reason to
   upload a 179 MB file a second time. */
const INSTALLERS = {
  'pulseroom:windows': { keys: ['pulseroom/PulseRoom-Windows.zip', 'PulseRoom-Windows.zip'],
                         as: 'PulseRoom-Windows.zip', title: 'PulseRoom for Windows' },
  'pulseroom:mac':     { keys: ['pulseroom/PulseRoom-macOS.zip', 'PulseRoom-macOS.zip'],
                         as: 'PulseRoom-macOS.zip',   title: 'PulseRoom for Mac' }
};

const TICKET_MINUTES = 15;

/* Deliberately loose. The job is to catch a typo and an empty box, not
   to adjudicate what a valid address is - every strict pattern ever
   written rejects somebody's real email. */
function looksLikeEmail(v) {
  return typeof v === 'string' && v.length <= 254 &&
         /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v.trim());
}

function b64url(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(secret, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

/* Compared a character at a time with no early exit, so how long the
   comparison takes says nothing about how much of the guess was right. */
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handoutDownload(request, env) {
  const say = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

  /* A reader gets the same sentence either way. The studio, opening this
     with ?setup, is told which piece is missing - because "not set up
     yet" is true of all of them and useful for none. */
  const setup = new URL(request.url).searchParams.has('setup');
  const missing = [];
  if (!env.DOWNLOADS)       missing.push('the R2 bucket is not bound (wrangler.jsonc names it amanorsac-downloads)');
  if (!env.DOWNLOAD_SECRET) missing.push('DOWNLOAD_SECRET is not set as a secret on the Worker');
  if (!env.RESEND_API_KEY)  missing.push('RESEND_API_KEY is not set as a secret on the Worker');
  if (missing.length) {
    return say({ error: setup ? ('Missing: ' + missing.join('; ') + '.')
                              : 'Downloads are not set up yet.' }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}

  const email    = String(body.email || '').trim().toLowerCase();
  const app      = String(body.app || '').toLowerCase().slice(0, 40);
  const platform = String(body.platform || '').toLowerCase().slice(0, 20);
  const source   = String(body.source || '').slice(0, 200);

  if (!looksLikeEmail(email)) return say({ error: 'That does not look like an email address.' }, 400);
  if (!body.consent)          return say({ error: 'Please tick the box to continue.' }, 400);
  const item = INSTALLERS[app + ':' + platform];
  if (!item) return say({ error: 'No such download.' }, 404);

  /* Recorded now, but not yet confirmed. An address that never gets
     clicked stays in the list marked unconfirmed and is never written
     to - which is the point of doing it this way. */
  try {
    await fetch(SUPABASE_URL + '/rest/v1/rpc/record_subscriber', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ p_email: email, p_app: app, p_source: source, p_consent: true })
    });
  } catch (e) {}

  /* The letter carries a signed link. Signed over the address as well as
     the file, so it opens the download for that person and nobody else,
     and cannot be edited into a link for the other app. A day to use it:
     long enough for someone who reads their email in the evening. */
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  const claim = ['confirm', email, app, platform, expires].join(':');
  const sig = await sign(env.DOWNLOAD_SECRET, claim);
  const link = SITE + '/download/confirm?a=' + encodeURIComponent(app) +
               '&p=' + encodeURIComponent(platform) +
               '&m=' + encodeURIComponent(email) +
               '&x=' + expires + '&s=' + sig;

  const sent = await sendConfirmation(env, email, item, link);
  if (!sent) return say({ error: 'The confirmation email would not send. Try again shortly.' }, 502);

  return say({ sent: true, email: email });
}

/* The letter. Plain, short, and it says what it is for in the first line,
   because a message that buries its purpose reads like a trap. */
async function sendConfirmation(env, email, item, link) {
  const text =
    'Confirm your email to download ' + item.title + '.\n\n' +
    link + '\n\n' +
    'The link works for 24 hours. If you did not ask for this, ignore it - ' +
    'nothing is sent to an address that is never confirmed.\n\n' +
    'Amanorsac Studio\n' + SITE + '\n';

  const html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;' +
    'line-height:1.6;color:#1C1916;max-width:520px">' +
    '<p style="margin:0 0 18px">Confirm your email and your download of <b>' +
      esc(item.title) + '</b> starts.</p>' +
    '<p style="margin:0 0 22px"><a href="' + esc(link) + '" ' +
      'style="display:inline-block;background:#1C1916;color:#fff;text-decoration:none;' +
      'padding:13px 22px;border-radius:9px;font-weight:600">Confirm and download</a></p>' +
    '<p style="margin:0 0 18px;color:#6B655C;font-size:14px">' +
      'The link works for 24 hours. If you did not ask for this, ignore it &mdash; ' +
      'nothing is ever sent to an address that is not confirmed.</p>' +
    '<p style="margin:0;color:#6B655C;font-size:13px">Amanorsac Studio &middot; ' +
      '<a href="' + SITE + '" style="color:#6B655C">amanorsac.studio</a></p></div>';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 Authorization: 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || 'Amanorsac Studio <hello@amanorsac.studio>',
        to: [email],
        subject: 'Confirm your email to download ' + item.title,
        text: text, html: html
      })
    });
    return r.ok;
  } catch (e) { return false; }
}

/* The link in the letter. Checks the signature, marks the address
   confirmed, and hands over a short ticket for the file itself - so the
   long-lived link in an inbox is only ever an introduction, never the
   file. */
async function confirmDownload(url, env) {
  if (!env.DOWNLOAD_SECRET) return null;

  const app = (url.searchParams.get('a') || '').toLowerCase();
  const platform = (url.searchParams.get('p') || '').toLowerCase();
  const email = (url.searchParams.get('m') || '').toLowerCase();
  const expires = parseInt(url.searchParams.get('x') || '0', 10);
  const sig = url.searchParams.get('s') || '';

  const item = INSTALLERS[app + ':' + platform];
  if (!item || !expires) return confirmPage('That link is not one of ours.', null, null);
  if (Date.now() > expires) {
    return confirmPage('That link has expired.',
      'Links last a day. Ask for the download again and a fresh one is on its way.', null);
  }
  const want = await sign(env.DOWNLOAD_SECRET, ['confirm', email, app, platform, expires].join(':'));
  if (!sameString(sig, want)) return confirmPage('That link is not one of ours.', null, null);

  try {
    await fetch(SUPABASE_URL + '/rest/v1/rpc/confirm_subscriber', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ p_email: email, p_app: app, p_platform: platform })
    });
  } catch (e) {}

  const t = Date.now() + TICKET_MINUTES * 60 * 1000;
  const path = '/download/' + app + '/' + platform;
  const ticket = path + '?e=' + t + '&s=' + (await sign(env.DOWNLOAD_SECRET, path + ':' + t));
  return confirmPage('Thank you — that’s confirmed.',
    item.title + ' is downloading now. If nothing happens, use the button.', ticket);
}

function confirmPage(heading, note, ticket, status) {
  const page =
'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<meta name="robots" content="noindex">' +
'<title>' + esc(heading) + ' &middot; Amanorsac Studio</title>' +
'<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;' +
'background:#0C0E12;color:#e9ebf1;font-family:-apple-system,Segoe UI,Roboto,sans-serif;' +
'text-align:center}main{max-width:430px}h1{font-size:27px;line-height:1.2;margin:0 0 12px}' +
'p{color:#a2a9b8;line-height:1.65;margin:0 0 24px}' +
'a.b{display:inline-block;background:#3fd3e4;color:#06131a;text-decoration:none;' +
'padding:13px 26px;border-radius:999px;font-weight:700}' +
'a.s{display:block;margin-top:22px;color:#6d7488;font-size:13px}</style></head><body><main>' +
'<h1>' + esc(heading) + '</h1>' +
(note ? '<p>' + esc(note) + '</p>' : '') +
(ticket ? '<a class="b" href="' + esc(ticket) + '" download>Download now</a>' +
          '<script>setTimeout(function(){location.href=' + JSON.stringify(ticket) + ';},700);<\/script>'
        : '<a class="b" href="' + SITE + '/pulseroom">Back to PulseRoom</a>') +
'<a class="s" href="' + SITE + '">amanorsac.studio</a>' +
'</main></body></html>';
  return new Response(page, {
    status: status || (ticket ? 200 : 410),
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function serveInstaller(app, platform, url, env, request) {
  const item = INSTALLERS[app + ':' + platform];
  if (!item || !env.DOWNLOADS || !env.DOWNLOAD_SECRET) return null;

  const expires = parseInt(url.searchParams.get('e') || '0', 10);
  const sig = url.searchParams.get('s') || '';
  if (!expires || Date.now() > expires) return null;

  const want = await sign(env.DOWNLOAD_SECRET, url.pathname + ':' + expires);
  if (!sameString(sig, want)) return null;

  let object = null;
  for (const key of item.keys) {
    object = await env.DOWNLOADS.get(key, { range: request.headers, onlyIf: request.headers });
    if (object) break;
  }
  /* The ticket was good and the file is not in the bucket. That is the
     studio's mistake, not the visitor's, and answering it with the same
     blank 404 that a forged ticket gets means nobody ever finds out
     which of the two happened. */
  if (!object) {
    return confirmPage('That file is not where it should be.',
      'The link was good - the installer is missing from storage. It should be at ' +
      item.keys[0] + ' in the amanorsac-downloads bucket. Try again shortly.', null, 503);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-type', 'application/zip');
  headers.set('content-disposition', 'attachment; filename="' + item.as + '"');
  // a ticket is personal and short-lived; nothing in between should keep this
  headers.set('cache-control', 'private, no-store');
  headers.set('accept-ranges', 'bytes');

  // a range request - a resumed download - comes back as a partial
  const partial = object.range && ('body' in object);
  return new Response(object.body,
    { status: partial && request.headers.has('range') ? 206 : 200, headers: headers });
}


/* ---------------------------------------------------------------------
   one post
   --------------------------------------------------------------------- */

/* Every column, rather than a list of names. Naming a column the table
   does not have is a 400 from PostgREST, and a 400 here is dangerously
   indistinguishable from "no such post" - the reader sees the same 404
   either way. A post row is small; asking for all of it costs nothing. */
const FIELDS = '*';

async function postPage(slug, env, request, diag) {
  slug = String(slug || '').toLowerCase();
  /* Adding ?diag to a post address reports which step failed instead of
     rendering. Nothing secret passes through it - the key it uses is the
     publishable one and can only read published posts - and when a post
     will not appear it turns an afternoon of guessing into one line. */
  const note = [];

  // not a plausible address: not worth a database round trip
  note.push('slug: ' + JSON.stringify(slug) + ' (' + slug.length + ' chars)');
  if (!/^[a-z0-9][a-z0-9-]{0,90}$/.test(slug)) {
    note.push('REJECTED: not a plausible slug');
    return diag ? report(note) : notFound(env, request);
  }

  let post = null;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/posts?slug=eq.' + encodeURIComponent(slug) +
      '&select=' + FIELDS + '&limit=1',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
    );
    const body = await r.text();
    note.push('database: HTTP ' + r.status);
    note.push('database said: ' + body.slice(0, 400));
    if (r.ok) {
      try { post = JSON.parse(body)[0] || null; }
      catch (e) { note.push('could not read that as JSON: ' + e.message); }
    }
  } catch (e) {
    note.push('database call threw: ' + e.message);
  }
  note.push('post found: ' + (post ? 'yes' : 'NO'));

  if (!post) return diag ? report(note) : notFound(env, request);

  const tplRes = await env.ASSETS.fetch(new URL('/post-template.html', request.url));
  note.push('template: HTTP ' + (tplRes ? tplRes.status : 'no response'));
  if (!tplRes || !tplRes.ok) return diag ? report(note) : notFound(env, request);
  const tpl = await tplRes.text();
  note.push('template: ' + tpl.length + ' bytes, ' +
            (tpl.match(/<!--post:[a-z]+-->/g) || []).length + ' markers');
  if (diag) return report(note);

  const url    = SITE + '/blog/' + post.slug;
  const cover  = absolute(post.cover);
  const image  = absolute(post.og_image || post.cover) || SITE + '/images/hero-piano.jpg';
  const author = post.author_name || 'Stephen Amanor Sackey';
  const desc   = post.blurb || '';
  const when   = longDate(post.published_at);
  const mins   = post.read_minutes ? post.read_minutes + ' min read' : '';

  /* Structured data, so a search engine is told what this is rather than
     left to work it out: an article, its headline, when, and by whom. */
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: desc,
    image: image,
    datePublished: post.published_at,
    dateModified: post.updated_at || post.published_at,
    author: { '@type': 'Person', name: author, url: SITE + '/about' },
    publisher: { '@type': 'Organization', name: 'Amanorsac Studio', url: SITE },
    mainEntityOfPage: url,
    inLanguage: 'en'
  };

  const head =
    // AdSense checks for this on the pages adverts run on, and a post page
    // builds its whole head here, so it goes in here too
    '<meta name="google-adsense-account" content="ca-pub-6190327414594776">\n' +
    '<title>' + esc(post.title) + ' | The Modern Musician</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    '<meta property="og:type" content="article">\n' +
    '<meta property="og:title" content="' + esc(post.title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:image" content="' + esc(image) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<meta property="og:site_name" content="Amanorsac Studio">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta name="twitter:title" content="' + esc(post.title) + '">\n' +
    '<meta name="twitter:description" content="' + esc(desc) + '">\n' +
    '<meta name="twitter:image" content="' + esc(image) + '">\n' +
    '<meta property="article:published_time" content="' + esc(post.published_at) + '">\n' +
    '<script type="application/ld+json">' +
      JSON.stringify(jsonld).replace(/</g, '\\u003c') + '</script>';

  const byline = '<b>' + esc(author) + '</b>' +
    (when ? ' &middot; ' + esc(when) : '') +
    (mins ? ' &middot; ' + esc(mins) : '');

  const coverBlock = cover
    ? '<div class="wrap"><div class="cover"><img src="' + esc(cover) + '" alt="' +
      esc(post.cover_alt || '') + '" fetchpriority="high"></div></div>'
    : '';

  let html = tpl;
  html = fill(html, 'head', head);
  html = fill(html, 'tag', esc(post.tag || ''));
  html = fill(html, 'title', esc(post.title));
  html = fill(html, 'byline', byline);
  html = fill(html, 'cover', coverBlock);
  // body_html was rendered and read in the editor before it was saved
  html = fill(html, 'body', post.body_html || '');

  /* The template sits at the site root and reaches its assets from
     there; this page is served a directory deeper. One base element
     keeps every relative path in it - the stylesheet's fonts included -
     pointing at the same files. */
  html = html.replace('<head>', '<head>\n<base href="' + SITE + '/">');

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // long enough to be worth having, short enough that a correction
      // published now is live in a minute rather than tomorrow
      'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      // _headers covers files served off disk; this page is not one
      'x-content-type-options': 'nosniff',
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains'
    }
  });
}


/* ---------------------------------------------------------------------
   the sitemap
   Built on request, because a file edited by hand is a file that gets
   forgotten, and a post missing from the sitemap is a post found late.
   If the database cannot be reached the fixed pages still go out: a
   sitemap that is briefly short is a small problem, one that fails to
   load is an error in Search Console.
   --------------------------------------------------------------------- */

const PAGES = [
  ['/',            'weekly',  '1.0'],
  ['/mixing',      'monthly', '0.9'],
  ['/apps',        'monthly', '0.9'],
  ['/blog',        'weekly',  '0.9'],
  ['/about',       'monthly', '0.8'],
  ['/performlive', 'monthly', '0.7'],
  ['/pulseroom',   'monthly', '0.7'],
  ['/harmoniemd',  'monthly', '0.7'],
  ['/nebulatide',  'monthly', '0.7'],
  ['/live',        'yearly',  '0.5']
];

async function sitemap() {
  const today = day();
  const urls = PAGES.map(([path, freq, pri]) =>
    '  <url>\n' +
    '    <loc>' + SITE + path + '</loc>\n' +
    '    <lastmod>' + today + '</lastmod>\n' +
    '    <changefreq>' + freq + '</changefreq>\n' +
    '    <priority>' + pri + '</priority>\n' +
    '  </url>');

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/posts_public', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ p_limit: 200 })
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows)) {
        for (const p of rows) {
          if (!p || !p.slug) continue;
          urls.push(
            '  <url>\n' +
            '    <loc>' + SITE + '/blog/' + xml(p.slug) + '</loc>\n' +
            '    <lastmod>' + day(p.updated_at || p.published_at) + '</lastmod>\n' +
            '    <changefreq>yearly</changefreq>\n' +
            '    <priority>0.8</priority>\n' +
            '  </url>');
        }
      }
    }
  } catch (e) { /* the fixed pages are enough to answer with */ }

  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>\n',
    { headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=600, s-maxage=3600'
    } });
}


/* ---------------------------------------------------------------------
   odds and ends
   --------------------------------------------------------------------- */

/* Everything that lands in an attribute or between tags is escaped, even
   though the studio wrote it. A post is data, and data is escaped on the
   way out - which is why a quotation mark in a title can never break the
   markup around it. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function xml(s) {
  return esc(s).replace(/'/g, '&apos;');
}

/* Replace whatever sits between a pair of markers in the template. */
function fill(html, key, value) {
  return html.replace(
    new RegExp('<!--post:' + key + '-->[\\s\\S]*?<!--\\/post:' + key + '-->', 'g'),
    value);
}

function absolute(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return SITE + '/' + String(u).replace(/^\/+/, '');
}

function longDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function day(iso) {
  const d = iso ? new Date(iso) : new Date();
  return (isNaN(d) ? new Date() : d).toISOString().slice(0, 10);
}

function report(lines) {
  return new Response(lines.join('\n') + '\n',
    { headers: { 'content-type': 'text/plain; charset=utf-8',
                 'cache-control': 'no-store' } });
}

/* An address that is not a post gets the site's own 404 page, with the
   status to match - not a blank page, and not a 200 that would let a
   search engine index the mistake. */
async function notFound(env, request) {
  try {
    const r = await env.ASSETS.fetch(new URL('/404.html', request.url));
    return new Response(await r.text(), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
}
