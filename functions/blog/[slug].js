/* =====================================================================
   /blog/<slug>  -  one published post.

   This is the only piece of the site that runs on a server, and it runs
   on Cloudflare's, next to the visitor. It does three things: look the
   post up, pour it into post-template.html, and send the result.

   The point of doing it here rather than in the browser is what arrives
   first. A page assembled by JavaScript reaches a search engine, and
   every link preview on every messaging app, as an empty shell - no
   title, no description, no picture. Those readers do not run scripts.
   Assembling the page before it is sent means the title in a Google
   result and the card in a WhatsApp message are the real ones.

   The key below is the publishable key, the same one the public pages
   carry. It can only ever see published posts, because that is what the
   row-level policy on the table allows. Drafts are not filtered out
   here; they are unreachable with this key.
   ===================================================================== */

const SUPABASE_URL = 'https://kdxckigyhpnwhwgjdgqq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PlVBmRgFdhTkVMurXLiBFQ_NjiVssQp';
const SITE = 'https://amanorsac.studio';

const FIELDS = 'slug,title,blurb,tag,cover,cover_alt,body_html,read_minutes,' +
               'published_at,updated_at,author_name,og_image';

/* Everything that goes into an attribute or between tags is escaped
   here, even though it was written by the studio. A post is data, and
   data gets escaped on the way out - that is the habit that means a
   quotation mark in a title can never break the markup around it. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Replace what sits between a pair of markers in the template. */
function fill(html, key, value) {
  const re = new RegExp('<!--post:' + key + '-->[\\s\\S]*?<!--\\/post:' + key + '-->', 'g');
  return html.replace(re, value);
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

export async function onRequestGet({ params, env, request }) {
  const slug = String(params.slug || '').toLowerCase();

  // Anything that is not a plausible slug is not worth a database round
  // trip; it is someone probing.
  if (!/^[a-z0-9][a-z0-9-]{0,90}$/.test(slug)) return notFound(env, request);

  let post = null;
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/posts?slug=eq.' + encodeURIComponent(slug) +
      '&select=' + FIELDS + '&limit=1',
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
    );
    if (r.ok) post = (await r.json())[0] || null;
  } catch (e) { /* fall through to the 404 */ }

  if (!post) return notFound(env, request);

  const tpl = await (await env.ASSETS.fetch(new URL('/post-template.html', request.url))).text();

  const url    = SITE + '/blog/' + post.slug;
  const cover  = absolute(post.cover);
  const image  = absolute(post.og_image || post.cover) || SITE + '/images/hero-piano.jpg';
  const author = post.author_name || 'Stephen Amanor Sackey';
  const desc   = post.blurb || '';
  const when   = longDate(post.published_at);
  const mins   = post.read_minutes ? post.read_minutes + ' min read' : '';

  /* Structured data, so a search engine is told what this is rather than
     having to work it out: an article, its headline, when it appeared,
     who wrote it. */
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
  // body_html was rendered and reviewed in the editor before it was saved
  html = fill(html, 'body', post.body_html || '');

  /* The template lives at the site root and links to its assets from
     there, but this page is served a directory deeper. One base element
     is all it takes for every relative path in it - the stylesheet's
     fonts included - to keep pointing at the same files. */
  html = html.replace('<head>', '<head>\n<base href="' + SITE + '/">');

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Long enough to be worth having, short enough that a correction
      // published now is live in a minute rather than tomorrow.
      'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      /* _headers only covers files served straight off disk, so the
         handful of protections it adds are repeated here by hand. */
      'x-content-type-options': 'nosniff',
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains'
    }
  });
}

/* An address that is not a post gets the site's own 404 page, with the
   status code to match - not a blank page, and not a 200 that would let
   a search engine index the mistake. */
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
