/* =====================================================================
   A writing surface for the blog.

   What was here before was a markdown box: you typed ## and got a
   heading in the panel next door. That is fine once you know it, and a
   wall if you do not. This puts the formatting on the screen where the
   words are - press the B, the word goes bold - the way every word
   processor has worked for thirty years.

   The important part is what it does NOT change. Posts are still stored
   as markdown, and the textarea is still what holds them. This editor
   reads that box when it opens and writes back to it after every
   keystroke, then fires the same input event the box would have fired
   itself. Everything downstream - the preview, the reading time, the
   save, the warning about leaving with unsaved work - carries on
   without knowing this exists.

   That is also the safety net. Markdown remains readable text in the
   database, the "Markdown" button hands the raw source straight back,
   and if this file ever failed to load the old box is still underneath,
   still working.

   The one rule everything here obeys: only produce markdown that
   markdown.js can read back. An editor that can write something the
   renderer cannot render is an editor that quietly loses a paragraph.
   ===================================================================== */
(function (root) {

  var BLOCK = { H2:'## ', H3:'### ', H4:'#### ' };

  /* ---- turning the page back into markdown ---------------------------
     Walks what is on screen and writes the markdown for it. Anything it
     does not recognise contributes its text and nothing else, which is
     how a paste from Word loses its fourteen nested spans and keeps the
     sentence. */

  function inlineMd(node) {
    var out = '';
    for (var n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, ' '); continue; }
      if (n.nodeType !== 1) continue;
      var tag = n.nodeName, inner = inlineMd(n);
      switch (tag) {
        case 'BR':     out += '\n'; break;
        case 'B': case 'STRONG':
          // ** around nothing renders as literal asterisks
          out += inner.trim() ? '**' + inner.trim() + '**' + tail(inner) : inner; break;
        case 'I': case 'EM':
          out += inner.trim() ? '*' + inner.trim() + '*' + tail(inner) : inner; break;
        case 'CODE':   out += inner.trim() ? '`' + inner.trim() + '`' + tail(inner) : inner; break;
        case 'A':
          var href = n.getAttribute('href') || '';
          out += href ? '[' + (inner || href) + '](' + href + ')' : inner;
          break;
        case 'IMG':
          out += '![' + (n.getAttribute('alt') || '') + '](' + (n.getAttribute('src') || '') + ')';
          break;
        default:       out += inner;
      }
    }
    return out;
  }
  // emphasis markers must hug the word; any trailing space goes outside
  function tail(s) { return /\s$/.test(s) ? ' ' : ''; }

  /* contenteditable does not produce tidy markup. Pressing Enter and then
     the list button leaves <p><ul><li>...</li></ul></p> - the list wrapped
     in the paragraph it grew out of. Read as inline text that came back
     as "firstsecond", the two items run together with the bullets gone.
     So: a container holding blocks is unwrapped and its children are
     serialised as blocks in their own right. */
  var BLOCKISH = /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|PRE|FIGURE|HR|TABLE)$/;
  var WRAPPER  = /^(P|DIV|SPAN|SECTION|ARTICLE|MAIN)$/;
  function holdsBlocks(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (BLOCKISH.test(c.nodeName)) return true;
    }
    return false;
  }

  function blockMd(el) {
    var tag = el.nodeName;

    if (WRAPPER.test(tag) && holdsBlocks(el)) return htmlToMd(el);

    if (tag === 'HR') return '---';

    if (BLOCK[tag]) return BLOCK[tag] + inlineMd(el).trim();
    if (tag === 'H1') return '## ' + inlineMd(el).trim();   // the title is the only h1
    if (tag === 'H5' || tag === 'H6') return '#### ' + inlineMd(el).trim();

    if (tag === 'BLOCKQUOTE') {
      return inlineMd(el).trim().split('\n')
        .map(function (l) { return '> ' + l; }).join('\n');
    }

    if (tag === 'UL' || tag === 'OL') {
      var i = 0;
      return [].map.call(el.children, function (li) {
        i++;
        return (tag === 'UL' ? '- ' : i + '. ') + inlineMd(li).trim();
      }).filter(function (l) { return l.length > 2; }).join('\n');
    }

    if (tag === 'PRE') return '```\n' + (el.textContent || '').replace(/\n$/, '') + '\n```';

    if (tag === 'FIGURE') {
      var im = el.querySelector('img'), cap = el.querySelector('figcaption');
      if (!im) return '';
      var capText = cap ? (cap.textContent || '').trim() : '';
      return '![' + (im.getAttribute('alt') || '') + '](' + (im.getAttribute('src') || '') +
             (capText ? ' "' + capText.replace(/"/g, "'") + '"' : '') + ')';
    }

    if (tag === 'IMG') {
      return '![' + (el.getAttribute('alt') || '') + '](' + (el.getAttribute('src') || '') + ')';
    }

    return inlineMd(el).trim();
  }

  function htmlToMd(container) {
    var out = [];
    for (var n = container.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        // loose text the browser left outside any block
        var t = n.nodeValue.replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
        continue;
      }
      if (n.nodeType !== 1) continue;
      var md = blockMd(n);
      if (md && md.trim()) out.push(md);
    }
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }


  /* ---- the surface --------------------------------------------------- */

  var TOOLS = [
    { cmd:'bold',        label:'B',  title:'Bold  (Ctrl+B)',      cls:'b' },
    { cmd:'italic',      label:'I',  title:'Italic  (Ctrl+I)',    cls:'i' },
    { sep:true },
    { block:'h2',        label:'H2', title:'Section heading' },
    { block:'h3',        label:'H3', title:'Smaller heading' },
    { block:'p',         label:'\u00b6',  title:'Ordinary paragraph' },
    { sep:true },
    { cmd:'insertUnorderedList', label:'\u2022',  title:'Bulleted list' },
    { cmd:'insertOrderedList',   label:'1.', title:'Numbered list' },
    { block:'blockquote',        label:'\u201C',  title:'Pull quote' },
    { sep:true },
    { act:'link',   label:'Link',    title:'Link  (Ctrl+K)' },
    { act:'image',  label:'Picture', title:'Insert a picture' },
    { act:'code',   label:'Code',    title:'Code' },
    { act:'rule',   label:'Divider', title:'Divider' },
    { act:'source', label:'Markdown', title:'Show the markdown underneath', cls:'src' }
  ];

  function rich(textarea, opts) {
    opts = opts || {};
    if (!textarea || textarea.dataset.rte) return null;
    textarea.dataset.rte = '1';

    var wrap = document.createElement('div');
    wrap.className = 'rte-wrap';
    var bar = document.createElement('div');
    bar.className = 'rte-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Formatting');
    var area = document.createElement('div');
    area.className = 'rte';
    area.contentEditable = 'true';
    area.spellcheck = true;
    area.setAttribute('role', 'textbox');
    area.setAttribute('aria-multiline', 'true');
    area.setAttribute('aria-label', 'The writing');

    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(bar);
    wrap.appendChild(area);
    wrap.appendChild(textarea);
    textarea.classList.add('rte-source');
    textarea.hidden = true;

    TOOLS.forEach(function (t) {
      if (t.sep) {
        var s = document.createElement('span');
        s.className = 'rte-sep'; s.setAttribute('aria-hidden','true');
        bar.appendChild(s); return;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'rte-btn' + (t.cls ? ' rte-' + t.cls : '');
      b.title = t.title;
      b.setAttribute('aria-label', t.title.split('  ')[0]);
      b.textContent = t.label;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the selection
      b.addEventListener('click', function () { run(t); });
      t.el = b;
      bar.appendChild(b);
    });

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}

    // ---- the two directions -------------------------------------------
    var syncing = false;
    function load() {                     // markdown -> screen
      area.innerHTML = root.mdToHtml ? root.mdToHtml(textarea.value || '') : '';
      if (!area.firstChild) area.innerHTML = '<p><br></p>';
    }
    function save() {                     // screen -> markdown
      if (syncing) return;
      syncing = true;
      textarea.value = htmlToMd(area);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      syncing = false;
    }

    area.addEventListener('input', save);
    area.addEventListener('keyup', state);
    area.addEventListener('mouseup', state);

    /* Paste goes through markdown on the way in. Anything Word or a web
       page brought with it that markdown has no word for - fonts, colours,
       a table of nested spans - has nowhere to survive, and what lands is
       the writing. */
    area.addEventListener('paste', function (e) {
      var dt = e.clipboardData; if (!dt) return;
      var html = dt.getData('text/html');
      var text = dt.getData('text/plain');
      e.preventDefault();
      var md;
      if (html) {
        var box = document.createElement('div');
        box.innerHTML = html.replace(/<!--[\s\S]*?-->/g, '');
        box.querySelectorAll('script,style,meta,link,title').forEach(function (n) { n.remove(); });
        md = htmlToMd(box);
      } else {
        md = text || '';
      }
      document.execCommand('insertHTML', false,
        root.mdToHtml ? root.mdToHtml(md) : escapeHtml(md));
      save();
    });

    function escapeHtml(s) {
      return '<p>' + String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>') + '</p>';
    }

    // ---- what the buttons do ------------------------------------------
    function run(t) {
      area.focus();
      if (t.cmd) { document.execCommand(t.cmd, false, null); }
      else if (t.block) { document.execCommand('formatBlock', false, t.block); }
      else if (t.act === 'link') {
        var sel = String(document.getSelection());
        var url = prompt(sel ? 'Link "' + sel + '" to:' : 'Address to link to:', 'https://');
        if (!url) return;
        if (sel) document.execCommand('createLink', false, url);
        else document.execCommand('insertHTML', false,
          '<a href="' + url.replace(/"/g,'&quot;') + '">' + url.replace(/</g,'&lt;') + '</a>');
      }
      else if (t.act === 'code') {
        var s = String(document.getSelection());
        document.execCommand('insertHTML', false,
          '<code>' + (s || 'code').replace(/</g,'&lt;') + '</code>&nbsp;');
      }
      else if (t.act === 'rule') { document.execCommand('insertHorizontalRule'); }
      else if (t.act === 'image') { if (opts.onPickImage) opts.onPickImage(); return; }
      else if (t.act === 'source') { toggleSource(); return; }
      save(); state();
    }

    // ---- the markdown underneath ---------------------------------------
    var showingSource = false;
    function toggleSource() {
      showingSource = !showingSource;
      if (showingSource) { textarea.value = htmlToMd(area); }
      else { load(); }
      area.hidden = showingSource;
      textarea.hidden = !showingSource;
      wrap.classList.toggle('src-on', showingSource);
      [].forEach.call(bar.querySelectorAll('.rte-btn'), function (b) {
        if (!b.classList.contains('rte-src')) b.disabled = showingSource;
      });
      (showingSource ? textarea : area).focus();
    }
    // typing in the raw box and switching back should not lose the typing
    textarea.addEventListener('input', function () { if (!syncing && showingSource) {} });

    // ---- which buttons are lit -----------------------------------------
    function state() {
      TOOLS.forEach(function (t) {
        if (!t.el) return;
        var on = false;
        try {
          if (t.cmd) on = document.queryCommandState(t.cmd);
          else if (t.block) {
            var b = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
            on = b === t.block || (t.block === 'p' && (b === 'div' || b === ''));
          }
        } catch (e) {}
        t.el.classList.toggle('on', !!on);
        t.el.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    area.addEventListener('keydown', function (e) {
      var meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      var k = e.key.toLowerCase();
      if (k === 'b' || k === 'i') { setTimeout(state, 0); return; }  // the browser's own
      if (k === 'k') { e.preventDefault(); run({ act:'link' }); }
    });

    load();
    state();

    return {
      reload: load,
      focus: function () { area.focus(); },
      element: area,
      /* Used by the picture drop. Built as markdown and rendered, so a
         picture put in this way is identical to one that was typed. */
      insertImage: function (url, alt, caption) {
        var md = '![' + (alt || '') + '](' + url +
                 (caption ? ' "' + caption + '"' : '') + ')';
        area.focus();
        document.execCommand('insertHTML', false,
          (root.mdToHtml ? root.mdToHtml(md) : '') + '<p><br></p>');
        save();
      }
    };
  }

  root.htmlToMd = htmlToMd;
  root.richEditor = rich;

})(typeof window !== 'undefined' ? window : globalThis);
