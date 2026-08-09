/* =====================================================================
   /sitemap.xml

   The fixed pages of the site, plus every published post. It is built on
   request because the alternative - a file edited by hand - is a file
   that gets forgotten, and a post missing from the sitemap is a post
   search engines find late or not at all.

   If the database cannot be reached the fixed pages are still returned.
   A sitemap that is briefly short is a small problem; one that fails to
   load is reported as an error in Search Console, so this never fails.
   ===================================================================== */

const SUPABASE_URL = 'https://kdxckigyhpnwhwgjdgqq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PlVBmRgFdhTkVMurXLiBFQ_NjiVssQp';
const SITE = 'https://amanorsac.studio';

/* path, how often it tends to change, how it ranks against the others */
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

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const day = iso => {
  const d = iso ? new Date(iso) : new Date();
  return (isNaN(d) ? new Date() : d).toISOString().slice(0, 10);
};

export async function onRequestGet() {
  const today = day();
  const urls = PAGES.map(([path, freq, pri]) =>
    '  <url>\n' +
    '    <loc>' + SITE + path + '</loc>\n' +
    '    <lastmod>' + today + '</lastmod>\n' +
    '    <changefreq>' + freq + '</changefreq>\n' +
    '    <priority>' + pri + '</priority>\n' +
    '  </url>');

  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/rpc/posts_public',
      { method: 'POST',
        headers: { 'content-type': 'application/json',
                   apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
        body: JSON.stringify({ p_limit: 200 }) }
    );
    if (r.ok) {
      for (const p of await r.json()) {
        if (!p || !p.slug) continue;
        urls.push(
          '  <url>\n' +
          '    <loc>' + SITE + '/blog/' + esc(p.slug) + '</loc>\n' +
          '    <lastmod>' + day(p.updated_at || p.published_at) + '</lastmod>\n' +
          '    <changefreq>yearly</changefreq>\n' +
          '    <priority>0.8</priority>\n' +
          '  </url>');
      }
    }
  } catch (e) { /* the fixed pages above are enough to answer with */ }

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') + '\n</urlset>\n';

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600'
    }
  });
}
