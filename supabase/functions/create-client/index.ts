// =====================================================================
//  create-client  ·  Supabase Edge Function
//
//  Creates a client login. This CANNOT be done from the browser: it needs
//  the service_role key, which must never reach a public page. The caller
//  must be a signed-in admin — we verify that with their own JWT before
//  touching the service_role client.
//
//  Deploy:
//    supabase functions deploy create-client
//  (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
//   injected by the platform — you do not set them yourself.)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ---- 1. who is calling? (their own token, their own permissions) ----
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Not signed in." }, 401);

  const asCaller = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !user) return json({ error: "Not signed in." }, 401);

  // ---- 2. are they an admin? read the real table, never user_metadata ----
  const { data: me } = await asCaller
    .from("profiles").select("is_admin").eq("id", user.id).single();

  if (!me?.is_admin) return json({ error: "Admins only." }, 403);

  // ---- 3. validate input ----
  let body: { email?: string; full_name?: string; company?: string; password?: string; phone?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }

  const email = String(body.email ?? "").trim().toLowerCase();
  const full_name = String(body.full_name ?? "").trim();
  const company = String(body.company ?? "").trim();
  const phone = String(body.phone ?? "").replace(/[^\d+]/g, "");   // keep digits and a leading +

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "That email address doesn't look right." }, 400);
  }

  // A temporary password they are forced to change on first login.
  const password = String(body.password ?? "").trim() ||
    Array.from(crypto.getRandomValues(new Uint8Array(9)))
      .map((b) => "abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ"[b % 56])
      .join("");

  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters." }, 400);
  }

  // ---- 4. create the login (service_role — server side only) ----
  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,                       // no confirmation email round-trip
    user_metadata: { full_name: full_name || email, must_change_password: true },
  });

  if (createErr) {
    const msg = /already been registered|already exists/i.test(createErr.message)
      ? "Someone already has an account with that email."
      : createErr.message;
    return json({ error: msg }, 400);
  }

  // The on_auth_user_created trigger makes the profile row; fill in the rest.
  const { error: profErr } = await admin.from("profiles")
    .update({
      full_name: full_name || email,
      company: company || null,
      email,
      // phone only sticks if the notifications migration has been run;
      // ignored harmlessly otherwise
      ...(phone ? { phone } : {}),
    })
    .eq("id", created.user!.id);

  if (profErr) return json({ error: profErr.message }, 400);

  // Password is returned ONCE so the admin can pass it on. It is not stored.
  return json({ id: created.user!.id, email, password });
});
