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
   request can name a file that is not on this list. */
const INSTALLERS = {
  'pulseroom:windows': { key: 'pulseroom/PulseRoom-Windows.zip', as: 'PulseRoom-Windows.zip' },
  'pulseroom:mac':     { key: 'pulseroom/PulseRoom-macOS.zip',   as: 'PulseRoom-macOS.zip' }
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
     with ?setup, is told which of the two pieces is missing - because
     "not set up yet" is true of both and useful for neither. */
  const setup = new URL(request.url).searchParams.has('setup');
  const missing = [];
  if (!env.DOWNLOADS)       missing.push('the R2 bucket is not bound (wrangler.jsonc names it amanorsac-downloads)');
  if (!env.DOWNLOAD_SECRET) missing.push('DOWNLOAD_SECRET is not set as a secret on the Worker');
  if (missing.length) {
    return say({ error: setup ? ('Missing: ' + missing.join('; ') + '.')
                              : 'Downloads are not set up yet.' }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}

  const email    = String(body.email || '').trim();
  const app      = String(body.app || '').toLowerCase().slice(0, 40);
  const platform = String(body.platform || '').toLowerCase().slice(0, 20);
  const source   = String(body.source || '').slice(0, 200);

  if (!looksLikeEmail(email)) return say({ error: 'That does not look like an email address.' }, 400);
  if (!body.consent)          return say({ error: 'Please tick the box to continue.' }, 400);
  if (!INSTALLERS[app + ':' + platform]) return say({ error: 'No such download.' }, 404);

  /* Record the person first, so a success really is one. If the database
     is having a bad moment the download still goes ahead - somebody who
     just gave their address should not be turned away for it. */
  try {
    await fetch(SUPABASE_URL + '/rest/v1/rpc/record_subscriber', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ p_email: email, p_app: app, p_source: source, p_consent: true })
    });
  } catch (e) {}

  const expires = Date.now() + TICKET_MINUTES * 60 * 1000;
  const path = '/download/' + app + '/' + platform;
  const sig = await sign(env.DOWNLOAD_SECRET, path + ':' + expires);
  return say({ url: path + '?e=' + expires + '&s=' + sig });
}

async function serveInstaller(app, platform, url, env, request) {
  const item = INSTALLERS[app + ':' + platform];
  if (!item || !env.DOWNLOADS || !env.DOWNLOAD_SECRET) return null;

  const expires = parseInt(url.searchParams.get('e') || '0', 10);
  const sig = url.searchParams.get('s') || '';
  if (!expires || Date.now() > expires) return null;

  const want = await sign(env.DOWNLOAD_SECRET, url.pathname + ':' + expires);
  if (!sameString(sig, want)) return null;

  const object = await env.DOWNLOADS.get(item.key,
    { range: request.headers, onlyIf: request.headers });
  if (!object) return null;

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
