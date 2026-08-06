/* =====================================================================
   PORTAL CONFIG  —  the only part you edit
   Get both values from Supabase → Project Settings → API.
   The publishable/anon key is SAFE in this file. Row Level Security is
   what protects the data. NEVER put the service_role / secret key here.
   ===================================================================== */
const SUPABASE_URL = "https://kdxckigyhpnwhwgjdgqq.supabase.co";
const SUPABASE_KEY = "sb_publishable_PlVBmRgFdhTkVMurXLiBFQ_NjiVssQp";

// Where the portal lives once deployed. Used for password-reset links.
const PORTAL_BASE  = window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '');

/* ==================== stop editing here ==================== */

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- theme (light default, dark optional) ---------- */
const Theme = {
  get(){ try { return localStorage.getItem('portal-theme'); } catch(e){ return null; } },
  set(v){ try { localStorage.setItem('portal-theme', v); } catch(e){} },
  apply(v){ document.documentElement.setAttribute('data-theme', v); },
  toggle(){
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    Theme.apply(next); Theme.set(next); Theme.icon();
  },
  icon(){
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('[data-theme-icon]').forEach(el => {
      el.innerHTML = dark
        ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
      el.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }
};

/* ---------- small helpers ---------- */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [].slice.call((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/** Only ever return http/https URLs. Blocks javascript: and data: */
function safeUrl(raw){
  if(!raw) return null;
  try { const u = new URL(String(raw).trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}
function linkHtml(raw, text){
  const u = safeUrl(raw);
  if(!u) return esc(text || raw || '');
  return '<a href="'+esc(u)+'" target="_blank" rel="noopener noreferrer nofollow">'+esc(text || u)+'</a>';
}
const money = c => '$' + (c/100).toLocaleString('en-US',{minimumFractionDigits:2});
const when  = d => d ? new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';

function say(el, text, kind){
  if(!el) return;
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

/* ---------- auth guard ---------- */
async function requireSession(){
  const { data:{ session } } = await sb.auth.getSession();
  if(!session){ location.replace('login.html'); return null; }
  return session;
}
async function currentProfile(){
  const { data:{ user } } = await sb.auth.getUser();
  if(!user) return null;
  const { data } = await sb.from('profiles').select('*').eq('id', user.id).single();
  return Object.assign({ email:user.email, must_change: !!(user.user_metadata||{}).must_change_password }, data||{});
}

/* ---------- shared chrome ---------- */
async function mountChrome(active){
  const bar = $('#topbar');
  if(!bar) return null;
  const p = await currentProfile();
  const name = p && (p.full_name || p.email) || '';
  bar.innerHTML =
    '<a class="brand" href="dashboard.html">S\u00b7A\u00b7S Studio</a>'+
    '<nav>'+
      '<a href="dashboard.html" class="'+(active==='projects'?'on':'')+'">Projects</a>'+
      '<a href="billing.html"   class="'+(active==='billing' ?'on':'')+'">Billing</a>'+
      '<a href="account.html"   class="'+(active==='account' ?'on':'')+'">Account</a>'+
      (p && p.is_admin ? '<a href="admin.html" class="'+(active==='admin'?'on':'')+'">Admin</a>' : '')+
      '<a href="../index.html">Studio site</a>'+
    '</nav>'+
    '<span class="who">'+esc(name)+'</span>'+
    '<button class="icon-btn" data-theme-icon onclick="Theme.toggle()"></button>'+
    '<button class="icon-btn" title="Sign out" onclick="signOut()">'+
      '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>'+
    '</button>';
  Theme.icon();

  // force password change on first login
  if(p && p.must_change && !/set-password/.test(location.pathname)){
    location.replace('set-password.html');
  }
  return p;
}
async function signOut(){ await sb.auth.signOut(); location.replace('login.html'); }

/** Admin-only guard. Bounces clients back to their own dashboard. */
async function requireAdmin(){
  const session = await requireSession();
  if(!session) return null;
  const p = await currentProfile();
  if(!p || !p.is_admin){ location.replace('dashboard.html'); return null; }
  return p;
}

/** A working href for a deliverable: a pasted link, or a short-lived
 *  signed URL for a file sitting in the private storage bucket. */
async function fileHref(f){
  if(!f) return null;
  if(f.url) return safeUrl(f.url);
  if(f.storage_path){
    const { data } = await sb.storage.from('deliverables')
      .createSignedUrl(f.storage_path, 60 * 60);   // one hour
    return data ? data.signedUrl : null;
  }
  return null;
}

/* ---------- avatars ----------
   The bucket is private, so a stored path is turned into a signed link
   on demand. Signed links are cached for the life of the page: a thread
   of twenty messages should not mean twenty round trips for one face. */
const _avCache = new Map();
async function avatarUrl(path){
  if(!path) return null;
  if(_avCache.has(path)) return _avCache.get(path);
  const { data } = await sb.storage.from('avatars').createSignedUrl(path, 60 * 60);
  const url = data ? data.signedUrl : null;
  _avCache.set(path, url);
  return url;
}

/* Initials are the fallback, not a grey silhouette — a name says who it
   is, and everyone in this portal has one. */
function initialsOf(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return '?';
  return esc((parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase());
}

/* ---------- progress tracker ---------- */
const CHECK = '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';

function renderTrack(el, stages, project){
  if(!stages || !stages.length){ el.innerHTML = '<p class="empty">No stages yet.</p>'; return; }
  stages.sort((a,b)=>a.sort_order-b.sort_order);
  const doneCount = stages.filter(s=>s.state==='done').length;
  const activeIdx = stages.findIndex(s=>s.state==='active');
  const pos = activeIdx >= 0 ? activeIdx : doneCount;
  const pct = stages.length > 1 ? (pos/(stages.length-1))*100 : 0;

  el.innerHTML =
    '<div class="track">'+
      '<div class="track-rail"><div class="track-fill" style="width:0%"></div></div>'+
      '<div class="track-steps">'+ stages.map(s =>
        '<div class="step '+esc(s.state)+'">'+
          '<span class="dot">'+ (s.state==='done'?CHECK:'') +'</span>'+
          '<span class="label">'+esc(s.name)+'</span>'+
        '</div>').join('') +
      '</div>'+
    '</div>';

  // animate the fill after paint so the transition actually runs
  requestAnimationFrame(()=>{ const f=$('.track-fill',el); if(f) f.style.width = pct+'%'; });

  const cur = stages[pos] || stages[stages.length-1];
  const note = $('#track-note');
  if(note && cur){
    let text;
    if(cur.state === 'blocked')      text = '<b>Waiting on you.</b> ' + esc(cur.note || 'We need something from you before this moves on.');
    else if(cur.state === 'done')    text = '<b>Delivered.</b> Everything is finished and your files are below.';
    else                             text = '<b>Currently: '+esc(cur.name)+'.</b> ' + esc(cur.note || 'In progress. You will get an email the moment this stage changes.');
    note.innerHTML = text;
    note.setAttribute('aria-live','polite');
  }
}

/* ---------- init ---------- */
(function(){
  // theme is set pre-paint by an inline script in each page's <head>;
  // this only syncs the icon once the DOM is up.
  document.addEventListener('DOMContentLoaded', Theme.icon);
})();
