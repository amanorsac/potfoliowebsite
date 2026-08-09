/* =====================================================================
   Markdown for the blog.

   Small on purpose. It understands the handful of things a post is
   actually made of - headings, paragraphs, emphasis, links, pictures,
   lists, pull quotes, code - and produces exactly the markup the post
   template is already styled for. Anything it does not recognise comes
   through as plain text rather than as a surprise.

   Everything is escaped before any pattern is applied, so a stray < in a
   sentence stays a stray < and a pasted script tag stays visible text.
   Link targets are checked too: only http, https, mailto and relative
   paths survive, which is what stops javascript: reaching an href.

   It runs in the portal, not on the server. The editor renders as you
   type and stores the result alongside what you wrote, so serving a post
   is a lookup rather than a re-render, and what you previewed is exactly
   what gets published.
   ===================================================================== */
(function (root) {

  /* Markers used to lift code out of the text before anything else looks
     at it. They are private-use characters, chosen because they cannot
     occur in real writing - an earlier version used a plain number
     between spaces, which would have mangled any sentence containing
     one. */
  var C0 = '', C1 = '', F0 = '', F1 = '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function attr(s) { return esc(s).replace(/"/g, '&quot;'); }

  /* A link may point out at the web, at an inbox, or somewhere on this
     site. Nothing else - and in particular nothing that executes. */
  function safeUrl(raw) {
    var u = String(raw == null ? '' : raw).trim();
    if (!u) return '';
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '';   // some other scheme: refuse
    return u;                                        // relative, or an anchor
  }

  // ---- inside a line -------------------------------------------------
  function inline(s) {
    var out = esc(s);

    var code = [];
    out = out.replace(/`([^`]+)`/g, function (_, c) {
      return C0 + (code.push(c) - 1) + C1;
    });

    // pictures before links, or the leading ! would be left behind
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      function (whole, alt, src, title) {
        var u = safeUrl(src);
        if (!u) return whole;
        return '<img src="' + attr(u) + '" alt="' + attr(alt) + '"' +
               (title ? ' title="' + attr(title) + '"' : '') + ' loading="lazy">';
      });

    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (whole, text, href) {
      var u = safeUrl(href);
      // a refused target comes back as the markdown that was typed, so it
      // is obvious something is wrong rather than quietly half-rendered
      if (!u) return whole;
      var away = /^https?:/i.test(u) && u.indexOf('amanorsac.studio') < 0;
      return '<a href="' + attr(u) + '"' +
             (away ? ' target="_blank" rel="noopener"' : '') + '>' + text + '</a>';
    });

    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
             .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
             .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');

    return out.replace(new RegExp(C0 + '(\\d+)' + C1, 'g'), function (_, i) {
      return '<code>' + code[+i] + '</code>';
    });
  }

  // ---- a block at a time ---------------------------------------------
  function mdToHtml(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var html = [];

    var fences = [];
    text = text.replace(/```[a-z0-9]*\n([\s\S]*?)```/gi, function (_, body) {
      return '\n\n' + F0 + (fences.push(body) - 1) + F1 + '\n\n';
    });

    var fenceRe = new RegExp('^' + F0 + '(\\d+)' + F1 + '$');

    text.split(/\n{2,}/).forEach(function (raw) {
      var block = raw.replace(/^\n+|\n+$/g, '');
      if (!block) return;

      var fence = block.match(fenceRe);
      if (fence) {
        html.push('<pre><code>' + esc(fences[+fence[1]].replace(/\n$/, '')) + '</code></pre>');
        return;
      }

      if (/^(-{3,}|\*{3,})$/.test(block)) { html.push('<hr>'); return; }

      var head = block.match(/^(#{1,4})\s+(.*)$/);
      if (head && block.indexOf('\n') < 0) {
        /* The post's own h1 is its title, set by the page, so nothing in
           the body may be one: two first-level headings on a page is a
           real problem for anyone reading by structure. A lone # is
           therefore demoted to h2, and ## - which is what most people
           reach for as a section heading - is h2 as well. */
        var level = Math.min(4, Math.max(2, head[1].length));
        html.push('<h' + level + '>' + inline(head[2]) + '</h' + level + '>');
        return;
      }

      if (/^>\s?/.test(block)) {
        var lines = block.split('\n').map(function (l) { return l.replace(/^>\s?/, ''); });
        html.push('<blockquote><p>' + inline(lines.join(' ')) + '</p></blockquote>');
        return;
      }

      if (/^[-*]\s+/.test(block)) {
        html.push('<ul>' + block.split('\n').map(function (l) {
          return '<li>' + inline(l.replace(/^[-*]\s+/, '')) + '</li>';
        }).join('') + '</ul>');
        return;
      }

      if (/^\d+[.)]\s+/.test(block)) {
        html.push('<ol>' + block.split('\n').map(function (l) {
          return '<li>' + inline(l.replace(/^\d+[.)]\s+/, '')) + '</li>';
        }).join('') + '</ol>');
        return;
      }

      /* A picture alone on its line becomes a figure, and the markdown
         title becomes its caption. A picture inside a sentence stays
         where it is. */
      var lone = block.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
      if (lone) {
        var u = safeUrl(lone[2]);
        if (!u) return;
        html.push('<figure><img src="' + attr(u) + '" alt="' + attr(lone[1]) + '" loading="lazy">' +
          (lone[3] ? '<figcaption>' + esc(lone[3]) + '</figcaption>' : '') + '</figure>');
        return;
      }

      html.push('<p>' + inline(block).replace(/\n/g, '<br>') + '</p>');
    });

    return html.join('\n');
  }

  /* Reading time the way every blog counts it: words over a comfortable
     pace, never less than a minute. */
  function readMinutes(src) {
    var words = String(src || '').replace(/[#>*`_\[\]()]/g, ' ').split(/\s+/).filter(Boolean);
    return Math.max(1, Math.round(words.length / 220));
  }

  /* Title to address. Accents fold down, punctuation goes, and what is
     left is the part of the URL a reader actually sees. */
  function slugify(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['\u2018\u2019]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70)
      .replace(/-+$/, '');
  }

  root.mdToHtml = mdToHtml;
  root.readMinutes = readMinutes;
  root.slugify = slugify;

})(typeof window !== 'undefined' ? window : globalThis);
