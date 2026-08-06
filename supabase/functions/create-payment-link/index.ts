// =====================================================================
//  create-payment-link  ·  Supabase Edge Function
//
//  Turns an invoice row into a Stripe Payment Link, so the admin never
//  pastes one by hand. Runs server side because it uses your STRIPE
//  SECRET key, which must never reach a public page — same rule as the
//  service_role key.
//
//  Deploy:  name it exactly  create-payment-link   (Verify JWT can stay
//  ON for this one — callers are signed-in admins.)
//
//  Secrets:
//    STRIPE_SECRET_KEY   sk_live_... (or sk_test_... while testing)
//
//  Flow: the dashboard inserts the invoice, then calls this with the
//  invoice id. We create a price and a payment link at Stripe, stamp
//  the invoice's id into the link's metadata (that metadata comes back
//  to us on the stripe-webhook when it's paid — it is how the payment
//  finds its way home), and save the URL onto the invoice row.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });

/** Stripe's API takes form encoding, not JSON. */
async function stripe(path: string, params: Record<string, string>) {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + Deno.env.get("STRIPE_SECRET_KEY"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out?.error?.message ?? "Stripe said no.");
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  if (!Deno.env.get("STRIPE_SECRET_KEY")) {
    return json({ error: "Stripe is not connected yet: add STRIPE_SECRET_KEY to this function's secrets." }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ---- caller must be a signed-in admin (same check as create-client) ----
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

  let body: { invoice_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
  const invoiceId = String(body.invoice_id ?? "");
  if (!invoiceId) return json({ error: "invoice_id required." }, 400);

  // ---- the invoice is the source of truth for what to charge ----
  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: inv, error: invErr } = await admin.from("invoices")
    .select("id, label, amount_cents, currency, status, pay_url, projects(title)")
    .eq("id", invoiceId).single();
  if (invErr || !inv) return json({ error: "No such invoice." }, 404);
  if (inv.status === "paid") return json({ error: "Already paid." }, 400);
  if (inv.pay_url) return json({ pay_url: inv.pay_url, note: "Already had a link." });

  try {
    const title = (inv as any).projects?.title;
    const price = await stripe("prices", {
      currency: inv.currency || "usd",
      unit_amount: String(inv.amount_cents),
      "product_data[name]": inv.label + (title ? " — " + title : ""),
    });
    const link = await stripe("payment_links", {
      "line_items[0][price]": price.id,
      "line_items[0][quantity]": "1",
      // This is the thread the webhook follows back to the invoice.
      "metadata[invoice_id]": inv.id,
    });

    const { error: upErr } = await admin.from("invoices")
      .update({ pay_url: link.url }).eq("id", inv.id);
    if (upErr) return json({ error: upErr.message }, 500);

    return json({ pay_url: link.url });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
