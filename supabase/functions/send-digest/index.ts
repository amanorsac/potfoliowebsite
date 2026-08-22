// =====================================================================
//  send-digest  ·  Supabase Edge Function
//
//  Folds everything queued for one project into one email. The studio
//  presses the button on the project page; the client gets a single
//  letter that starts with the name of their song, instead of five
//  letters about the same week of work.
//
//  Deploy:  name it exactly  send-digest
//  Secrets: shares the project-wide ones notify-client already uses -
//           RESEND_API_KEY, NOTIFY_FROM, SITE_URL. Nothing new to set.
//
//  Only a signed-in admin may call it. The check is the same one
//  delete-client uses: the caller's own token, then their profile row.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* The event's noun, for the summary line at the top of the letter. */
const NOUN: Record<string, string> = {
  stage: "progress", file: "a new file", message: "a note from the studio",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ---- caller must be a signed-in admin ----
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Not signed in." }, 401);
  const asCaller = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await asCaller.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);
  const { data: me } = await asCaller
    .from("profiles").select("is_admin").eq("id", user.id).single();
  if (!me?.is_admin) return json({ error: "Admins only." }, 403);

  let body: { project_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
  const projectId = String(body.project_id ?? "");
  if (!projectId) return json({ error: "project_id required." }, 400);

  const db = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- the project, its client, and everything waiting to be said ----
  const { data: project } = await db.from("projects")
    .select("title, client_id, profiles!projects_client_id_fkey(full_name,email,notify_email)")
    .eq("id", projectId).single();
  if (!project) return json({ error: "No such project." }, 404);

  const client = (project as any).profiles;
  if (!client?.email) return json({ error: "That project has no client email." }, 400);
  if (!client.notify_email) {
    return json({ error: "This client has switched email notifications off." }, 400);
  }

  const { data: queued } = await db.from("notifications")
    .select("id, event, subject, body, created_at")
    .eq("project_id", projectId).eq("status", "queued").eq("channel", "digest")
    .order("created_at", { ascending: true });
  if (!queued || !queued.length) {
    return json({ error: "Nothing queued for this project." }, 400);
  }

  const key = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!key) return json({ error: "RESEND_API_KEY is not set." }, 500);

  // ---- one letter ----
  // The subject starts with the song, because the song is what the
  // client cares about, and an inbox sorts itself when every letter
  // about a song starts with its name.
  const title = String(project.title ?? "Your project");
  const n = queued.length;
  const subject = n === 1
    ? `${title}: an update from the studio`
    : `${title}: ${n} updates from the studio`;

  const first = (client.full_name || "").split(" ")[0] || "there";
  const when = (iso: string) => new Date(iso).toLocaleDateString("en-US",
    { month: "short", day: "numeric" });

  const rows = queued.map(q => `
      <tr>
        <td style="padding:12px 14px 12px 0;font-size:11px;color:#9a938a;
            font-family:ui-monospace,Menlo,monospace;white-space:nowrap;
            vertical-align:top">${when(String(q.created_at))}</td>
        <td style="padding:12px 0;font-size:15px;line-height:1.55;color:#1A1830">
          ${escapeHtml(String(q.body ?? q.subject ?? "")).replace(/\n/g,
            '<br><span style="color:#6B6358;font-size:14px">')}
        </td>
      </tr>`).join(`
      <tr><td colspan="2" style="border-top:1px solid #EDEAE2"></td></tr>`);

  const portal = `${Deno.env.get("SITE_URL") ?? "https://amanorsac.studio"}/portal/dashboard.html`;
  const html = `
<div style="background:#F7F6F2;padding:32px 0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:540px;margin:0 auto;background:#fff;border-radius:18px;padding:34px 32px">
    <p style="margin:0 0 22px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6B6358">
      Studio Amanorsac</p>
    <h1 style="margin:0 0 6px;font-size:26px;line-height:1.2;color:#1A1830;letter-spacing:-.02em">
      ${escapeHtml(title)}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#6B6358">
      Hi ${escapeHtml(first)}, here is everything that moved on your song since the last letter.</p>
    <table style="border-collapse:collapse;width:100%">${rows}</table>
    <a href="${portal}" style="display:inline-block;margin-top:24px;background:#EF9F27;color:#fff;
       text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:999px">
      Open your project</a>
    <p style="margin:26px 0 0;font-size:12px;line-height:1.7;color:#9a938a">
      One email per batch of updates, when the studio presses send.
      Reply to this email if you'd rather not get them.</p>
  </div>
</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("NOTIFY_FROM") || "Studio Amanorsac <onboarding@resend.dev>",
      to: [client.email],
      subject,
      html,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: "Resend refused: " + JSON.stringify(out).slice(0, 300) }, 502);
  }

  // Only after the letter is away do the rows stop being owed.
  const ids = queued.map(q => q.id);
  await db.from("notifications").update({
    status: "sent", channel: "email", detail: "digest " + String(out.id ?? ""),
  }).in("id", ids);

  return json({ ok: true, sent: n, subject });
});
