// =====================================================================
//  delete-client  ·  Supabase Edge Function
//
//  Removes a client COMPLETELY: their login, and — through the
//  on-delete-cascade chain (auth.users → profiles → projects →
//  everything) — every project, stage, file record, review, message
//  and invoice they ever had. This is the testing-cleanup and
//  right-to-be-forgotten button. There is no undo.
//
//  Runs server side because deleting a login needs the service_role
//  key. Caller must be a signed-in admin — same check as create-client.
//
//  Deploy:  name it exactly  delete-client
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

  let body: { client_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad JSON." }, 400); }
  const clientId = String(body.client_id ?? "");
  if (!clientId) return json({ error: "client_id required." }, 400);

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- guard rails ----
  // Never yourself: locking the only admin out of their own studio via
  // a mis-click is not a recoverable mistake.
  if (clientId === user.id) return json({ error: "You cannot delete yourself." }, 400);

  // Never another admin either. Admin logins are removed by hand in the
  // dashboard, deliberately, not through the client list.
  const { data: target } = await admin.from("profiles")
    .select("is_admin, email").eq("id", clientId).single();
  if (!target) return json({ error: "No such client." }, 404);
  if (target.is_admin) return json({ error: "That is an admin, not a client." }, 400);

  // ---- the deletion: auth user first; the cascade does the rest ----
  const { error } = await admin.auth.admin.deleteUser(clientId);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, deleted: target.email });
});
