// =====================================================================
//  notify-client  ·  Supabase Edge Function
//
//  Called by Database Webhooks whenever something a client should hear
//  about changes. Works out what happened, writes the message, and
//  sends it by email (Resend) and/or WhatsApp/SMS (Twilio).
//
//  Deploy:  name it exactly  notify-client
//
//  Secrets (Edge Functions → notify-client → Secrets):
//    NOTIFY_SECRET     required — must match the x-notify-secret header
//                      you set on each webhook
//    SITE_URL          required — e.g. https://yoursite.com  (no trailing /)
//    RESEND_API_KEY    email — from resend.com
//    NOTIFY_FROM       email — e.g. "Studio Amanorsac <studio@yourdomain.com>"
//    TWILIO_SID        optional, for WhatsApp/SMS
//    TWILIO_TOKEN      optional
//    TWILIO_FROM       optional — "whatsapp:+14155238886" or a plain +1...
//
//  Nothing here throws on a missing provider: if RESEND_API_KEY is
//  absent, email is skipped and logged as skipped. The portal keeps
//  working either way — notifications are an addition, never a
//  dependency.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Hook = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
};

type Plan = {
  event: string;
  project_id: string;
  subject: string;
  line: string;      // one sentence, used for WhatsApp/SMS and the email lede
  detail?: string;   // optional second line
};

/** Human wording for each stage state. */
const STAGE_WORD: Record<string, string> = {
  active: "is underway",
  done: "is finished",
  blocked: "needs something from you",
  pending: "is queued",
};

// ─────────────────────────────────────────── decide what (if anything) to say
async function planFor(hook: Hook): Promise<Plan | null> {
  const r = hook.record ?? {};
  const o = hook.old_record ?? {};

  if (hook.table === "project_stages" && hook.type === "UPDATE") {
    // Only speak when the state actually moved. Editing a note, or
    // re-saving the same value, is not news.
    if (r.state === o.state) return null;
    const name = String(r.name ?? "A stage");
    const word = STAGE_WORD[String(r.state)] ?? `is now ${r.state}`;
    return {
      event: "stage",
      project_id: String(r.project_id),
      subject: `${name} — ${r.state === "blocked" ? "we need you" : "update"}`,
      line: `${name} ${word}.`,
      detail: r.note ? String(r.note) : undefined,
    };
  }

  if (hook.table === "deliverables" && hook.type === "INSERT") {
    // Files the client sent us are not news to the client.
    if (r.direction !== "to_client") return null;
    return {
      event: "file",
      project_id: String(r.project_id),
      subject: "A new file is ready",
      line: `${r.label ?? "A file"} is waiting for you in the portal.`,
    };
  }

  if (hook.table === "projects" && hook.type === "INSERT") {
    // The welcome: a new song just went on the desk with their name on it.
    return {
      event: "project",
      project_id: String(r.id),
      subject: "Your project is set up",
      line: `“${r.title ?? "Your project"}” is on the studio's desk.`,
      detail: "Follow every stage, send reference notes, and pick up files in your portal.",
    };
  }

  if (hook.table === "invoices") {
    const dollars = "$" + (Number(r.amount_cents ?? 0) / 100).toFixed(2);
    if (hook.type === "INSERT") {
      return {
        event: "invoice",
        project_id: String(r.project_id),
        subject: "Invoice from the studio",
        line: `${r.label ?? "An invoice"} — ${dollars}.`,
        detail: r.pay_url
          ? "You can pay online from your billing page."
          : "Payment details are on your billing page.",
      };
    }
    // A receipt when it flips to paid — and only on that flip, so
    // re-saving a paid invoice stays silent.
    if (hook.type === "UPDATE" && r.status === "paid" && o.status !== "paid") {
      return {
        event: "receipt",
        project_id: String(r.project_id),
        subject: "Payment received — thank you",
        line: `${r.label ?? "Your invoice"} (${dollars}) is settled.`,
      };
    }
    return null;
  }

  if (hook.table === "messages" && hook.type === "INSERT") {
    // Only messages from the studio. A client's own message must not
    // bounce back at them.
    const { data: sender } = await db.from("profiles")
      .select("is_admin").eq("id", String(r.sender_id)).single();
    if (!sender?.is_admin) return null;
    const body = String(r.body ?? "");
    return {
      event: "message",
      project_id: String(r.project_id),
      subject: "A message from the studio",
      line: body.length > 160 ? body.slice(0, 157) + "…" : body,
    };
  }

  return null;
}

// ────────────────────────────────────────────────────────────── senders
async function sendEmail(to: string, name: string, plan: Plan, project: string, url: string) {
  const key = env("RESEND_API_KEY");
  if (!key) return { status: "skipped", detail: "RESEND_API_KEY not set" };

  const first = (name || "").split(" ")[0] || "there";
  const html = `
<div style="background:#F7F6F2;padding:32px 0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;padding:34px 32px">
    <p style="margin:0 0 22px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6B6358">
      Studio Amanorsac</p>
    <h1 style="margin:0 0 14px;font-size:26px;line-height:1.2;color:#1A1830;letter-spacing:-.02em">
      ${escapeHtml(plan.subject)}</h1>
    <p style="margin:0 0 10px;font-size:16px;line-height:1.6;color:#1A1830">
      Hi ${escapeHtml(first)} — ${escapeHtml(plan.line)}</p>
    ${plan.detail ? `<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#6B6358">${escapeHtml(plan.detail)}</p>` : ""}
    <p style="margin:0 0 26px;font-size:15px;color:#6B6358">Project: ${escapeHtml(project)}</p>
    <a href="${url}" style="display:inline-block;background:#EF9F27;color:#fff;text-decoration:none;
       font-weight:600;font-size:15px;padding:14px 26px;border-radius:999px">Open your project</a>
    <p style="margin:26px 0 0;font-size:12px;line-height:1.7;color:#9a938a">
      You're getting this because you have a project with the studio.
      Reply to this email if you'd rather not.</p>
  </div>
</div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env("NOTIFY_FROM") || "Studio Amanorsac <onboarding@resend.dev>",
      to: [to],
      subject: plan.subject,
      html,
    }),
  });
  const out = await res.json().catch(() => ({}));
  return res.ok
    ? { status: "sent", detail: String(out.id ?? "") }
    : { status: "failed", detail: JSON.stringify(out).slice(0, 400) };
}

async function sendTwilio(to: string, plan: Plan, url: string) {
  const sid = env("TWILIO_SID"), token = env("TWILIO_TOKEN"), from = env("TWILIO_FROM");
  if (!sid || !token || !from) return { status: "skipped", detail: "Twilio not configured" };

  // WhatsApp addresses carry a scheme; SMS numbers do not.
  const dest = from.startsWith("whatsapp:") ? `whatsapp:${to}` : to;
  const body = `${plan.line}\n\n${url}`;

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${token}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: dest, Body: body }),
  });
  const out = await res.json().catch(() => ({}));
  return res.ok
    ? { status: "sent", detail: String(out.sid ?? "") }
    : { status: "failed", detail: JSON.stringify(out).slice(0, 400) };
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ───────────────────────────────────────────────────────────────── entry
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST." }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }

  // Only our own webhooks may call this.
  const secret = env("NOTIFY_SECRET");
  if (!secret || req.headers.get("x-notify-secret") !== secret) {
    return new Response(JSON.stringify({ error: "Forbidden." }), {
      status: 403, headers: { "Content-Type": "application/json" },
    });
  }

  let hook: Hook;
  try { hook = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }

  const plan = await planFor(hook);
  if (!plan) return json({ skipped: "nothing worth saying" });

  // Who is this for?
  const { data: project } = await db.from("projects")
    .select("title, client_id, profiles!projects_client_id_fkey(full_name,email,phone,notify_email,notify_whatsapp)")
    .eq("id", plan.project_id).single();

  const client = (project as any)?.profiles;
  if (!client) return json({ skipped: "no client on that project" });

  // Don't stack up messages when several things change at once — but only
  // within one project. Two of a client's songs moving on the same evening
  // are two pieces of news, not a repeat.
  const { data: recent } = await db.rpc("notified_recently", {
    p_client: project!.client_id, p_event: plan.event, p_project: plan.project_id,
  });
  if (recent) return json({ skipped: "already notified recently" });

  const url = `${env("SITE_URL")}/portal/dashboard.html`;
  const results: Record<string, unknown> = {};

  if (client.notify_email && client.email) {
    const r = await sendEmail(client.email, client.full_name ?? "", plan, project!.title, url);
    results.email = r;
    await db.from("notifications").insert({
      project_id: plan.project_id, client_id: project!.client_id, event: plan.event,
      channel: "email", subject: plan.subject, body: plan.line,
      status: r.status, detail: r.detail,
    });
  }

  if (client.notify_whatsapp && client.phone) {
    const r = await sendTwilio(client.phone, plan, url);
    results.whatsapp = r;
    await db.from("notifications").insert({
      project_id: plan.project_id, client_id: project!.client_id, event: plan.event,
      channel: env("TWILIO_FROM").startsWith("whatsapp:") ? "whatsapp" : "sms",
      subject: plan.subject, body: plan.line, status: r.status, detail: r.detail,
    });
  }

  return json({ ok: true, event: plan.event, results });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}
