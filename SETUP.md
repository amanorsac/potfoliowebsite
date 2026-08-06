# Client portal — setup

Roughly 40 minutes end to end. Do it in this order.

---

## 1 · Database (10 min)

1. Open your Supabase project → **SQL Editor** → **New query**
2. Paste the whole of `supabase-setup.sql` → **Run**
3. Go to **Authentication → Sign In / Providers** and turn **"Allow new users to sign up" OFF**

That last step matters. Without it, anyone could register themselves.

## 2 · Make yourself the admin (2 min)

1. **Authentication → Users → Add user**
2. Your email, a password, and tick **Auto Confirm User**
3. Back in **SQL Editor**, run:

```sql
update public.profiles set is_admin = true where email = 'amanorsac@gmail.com';
```

Admin is what lets you see every client's projects instead of just your own.

## 3 · Connect the site to Supabase (2 min)

1. **Project Settings → API**
2. Copy the **Project URL** and the **publishable / anon** key
3. Open `assets/portal.js` and paste both into the two lines at the top

**Only the anon key.** Never the `service_role` or `secret` key — that one bypasses every security rule and would be readable by anyone who views your page source.

## 4 · Redirect URLs (3 min)

**Authentication → URL Configuration**

- **Site URL:** `https://your-site.pages.dev`
- **Redirect URLs:** add both
  - `https://your-site.pages.dev/portal/reset.html`
  - `https://your-site.pages.dev/portal/**`

If you end up on GitHub Pages at a subpath (`username.github.io/portfolio`), include the subpath in every entry. Password resets are known to misbehave on subpaths, which is one reason a Cloudflare custom domain at the root is the safer home.

## 5 · Deploy

Push to GitHub, connect Cloudflare Pages to the repo. Build command empty, output directory `/`.

## 6 · Test before you let a client in (10 min)

1. **Authentication → Users → Add user** — make a fake client, tick Auto Confirm
2. **SQL Editor:** set them up with a project

```sql
insert into public.projects (client_id, title, artist, service)
values ((select id from public.profiles where email = 'test@example.com'),
        'Test Song', 'Test Artist', 'Mixing & Mastering');
```

3. Open the portal in a **private window**, log in as the test client
4. Check every one of these:

- [ ] They see their project and no one else's
- [ ] Changing a stage in **Table Editor → project_stages** updates the page live, without a refresh
- [ ] Submitting a revision works, and the counter drops
- [ ] Submitting a **fourth** revision is refused
- [ ] Logged out, `dashboard.html` bounces to login
- [ ] Dark mode toggle persists across a refresh

Point 4 is the one that matters most. If a test client can see another client's work, stop and fix RLS before going further.

---

---

## 7 · Admin dashboard (one-time setup)

The dashboard lives at `portal/admin.html` and only opens for a profile with
`is_admin = true`. Anyone else is bounced to their own project list. The
**Admin** link appears in the portal nav automatically once you are admin.

> **Two different places.** Anything SQL goes in the **SQL Editor** in your
> browser. Anything starting with `supabase ...` is a **terminal** command on
> your own computer — pasting it into the SQL Editor gives you
> `syntax error at or near "supabase"`. Step (b) can be done without a
> terminal at all; see the dashboard route below.

### a. File storage (2 min) — SQL Editor

SQL Editor → paste the **contents of `supabase-storage-setup.sql`** → Run.

That makes a **private** `deliverables` bucket. Files are never public: the
portal hands out signed links that expire after an hour, and a client can
only reach files under their own project's folder.

### b. The create-client function (5 min) — **optional**

Creating a login needs the `service_role` key, which must never sit in a
public page — so it runs server side instead.

**Easiest route, no terminal:** Supabase → **Edge Functions** → **Create a
function** → name it exactly `create-client` → paste the contents of
`supabase/functions/create-client/index.ts` → Deploy.

**Or, if you have the Supabase CLI installed,** run these in a **terminal on
your computer** (not the SQL Editor):

```bash
supabase login
supabase link --project-ref kdxckigyhpnwhwgjdgqq
supabase functions deploy create-client
```

The function checks the caller's own JWT and refuses anyone who is not admin
before it touches the service key. Keys are injected by the platform; you do
not paste any into the code.

Skip this step and everything else still works — you would just add the login
under **Authentication → Add user** by hand, as before.

**Deleting clients** works the same way: deploy a function named exactly
**`delete-client`** from `supabase/functions/delete-client/index.ts` (same
route, no extra secrets). The "Delete this client…" button in each client's
Edit panel calls it after you type their email back to confirm. It removes
the login, and the cascade takes their projects, files, reviews, messages
and invoices with it. It refuses to delete you or any other admin.

### What the dashboard does

- **Add a client** — creates the login and shows a temporary password **once**.
  Pass it on; they must change it at first sign in.
- **Start a project** — pick the client, title, artist, service, due date and
  revision cap. The seven stages are seeded automatically.
- **Progress** — change a stage's state or note; it saves as you change it and
  the client's tracker updates live.
- **Send a file** — upload it or paste a link. It appears on their project page.
- **Mix reviews** — read each round's notes (timecode, element, what they hear,
  what they want, reference) and move it open → in progress → done.
- **Messages** — reply to the client in the project thread.

---

## 8 · Telling clients when something changes (optional)

Out of the box the portal is a place clients *check*. This makes it a thing
that *tells them* — an email (and optionally WhatsApp/SMS) whenever a stage
moves, a file lands, or you send a message.

It runs off **Database Webhooks**, not the dashboard's buttons, so it fires
whether you moved the stage in the admin UI or edited the row by hand in the
Table Editor.

### a. Database (2 min) — SQL Editor

Paste the contents of **`supabase-notifications.sql`** → Run. It adds `phone`
and per-client on/off switches to `profiles`, a `notifications` log, and a
small helper that stops four stage changes on one project from sending four
emails.

### b. Email provider (10 min)

1. Sign up at **resend.com** (free tier covers a working studio comfortably)
2. Add and verify your sending domain — or skip that and use their
   `onboarding@resend.dev` address while testing
3. Create an API key and keep it handy

### c. Deploy the function

**Edge Functions → Deploy a new function → Via Editor**, named exactly
**`notify-client`**, pasting `supabase/functions/notify-client/index.ts`.
Turn **Verify JWT off** — webhooks don't carry a user token.

Then open the function's **Secrets** and add:

| Secret | Value |
|---|---|
| `NOTIFY_SECRET` | any long random string you invent — you'll paste it into each webhook |
| `SITE_URL` | `https://amanorsac.studio` (no trailing slash) |
| `RESEND_API_KEY` | from step (b) |
| `NOTIFY_FROM` | `Studio Amanorsac <hello@amanorsac.studio>` |

### d. Three webhooks (5 min)

**Recommended — SQL Editor.** Open `supabase-webhooks.sql` **in a text
editor**, replace the single `PASTE_YOUR_NOTIFY_SECRET_HERE` with your
`NOTIFY_SECRET` from step (c), then paste the finished file into the SQL
Editor and Run. It ends by listing the three triggers back to you, so you can
see they landed.

Do the replacing before you paste, not after. Pasting the secret into the SQL
Editor on its own gets you `syntax error at or near "..."` — a bare secret is
not a SQL statement.

That script builds the triggers with `pg_net` directly rather than through the
dashboard's webhook machinery, which sidesteps two snags: the Webhooks page is
no longer in the Database sidebar, and the `supabase_functions` schema it
relies on does not exist until you have created a hook by hand at least once
(`ERROR: schema "supabase_functions" does not exist`).

**UI route**, if you would rather click. Webhooks now lives under
**Integrations → Database Webhooks**, or go straight to
`https://supabase.com/dashboard/project/kdxckigyhpnwhwgjdgqq/integrations/webhooks/overview`.
Create a new hook three times. Each one:

- **Type:** HTTP Request · **Method:** POST
- **URL:** `https://kdxckigyhpnwhwgjdgqq.supabase.co/functions/v1/notify-client`
- **HTTP Header:** `x-notify-secret` = the same `NOTIFY_SECRET` from step (c)

| # | Table | Events |
|---|---|---|
| 1 | `project_stages` | Update |
| 2 | `deliverables` | Insert |
| 3 | `messages` | Insert |

A "Database Webhook" is only a trigger that POSTs a row to a URL — the two
routes build the same thing by different names, so mixing them is fine. Don't
run both for the same table, though, or the function gets told twice.

### e. Test it

Set a client's own email on their profile temporarily, move one of their
stages, and watch your inbox. Then check **Table Editor → notifications** —
every attempt is logged there with `sent`, `failed`, or `skipped` and the
reason. That table is the first place to look if a client says they never
got anything.

### What it does and doesn't send

- **Stage moved** → only when the state actually changes; editing a note
  silently is not news
- **File sent** → only files going *to* the client, never their own uploads
- **Message** → only messages from you; a client's own message never bounces
  back at them
- **Same event twice in 3 minutes, on the same project** → the second is
  skipped. Two of a client's songs moving the same evening still send twice

Clients can be switched off individually with `notify_email` /
`notify_whatsapp` on their profile row.

### WhatsApp — read this before you promise it to anyone

WhatsApp is supported in the function (via Twilio: set `TWILIO_SID`,
`TWILIO_TOKEN`, `TWILIO_FROM`, and turn on `notify_whatsapp` for the client),
but the hard part isn't code. Meta requires business-initiated messages to
use **pre-approved templates**, which means a Meta Business account,
verification, and a template review that takes days. Twilio's sandbox lets
you test immediately, but only to numbers that have opted in by messaging
the sandbox first.

Plain **SMS** through the same Twilio settings has no template approval —
set `TWILIO_FROM` to a normal `+1…` number instead of a `whatsapp:` one. It
costs per message but works the day you set it up.

Sensible order: **email first** (works today), SMS if clients want their
phone buzzing, WhatsApp only once it's worth the paperwork.

---

## Running it day to day

Everything below can also be done in **Supabase → Table Editor** if you prefer
the raw rows — the dashboard just does the same writes with fewer clicks.

**New client:** Authentication → Add user → Auto Confirm. Send them the email and temporary password. They're forced to set their own on first login.

**New project:** insert a row in `projects` with their `client_id`. The seven stages are created automatically.

**Move a project along:** edit `project_stages` — set the finished stage to `done` and the next one to `active`. The client's screen updates within a second.

**Waiting on the client:** set the stage to `blocked` and write what you need in the `note` field. Their tracker turns amber and says "Waiting on you."

**Send a file:** insert into `deliverables` with a link.

**Bill them:** create a Stripe Payment Link, then insert into `invoices` with `pay_url` set to it. Mark `status` = `paid` when it clears.

## 9 · Stripe — automatic invoicing (optional)

With this connected, sending an invoice from a project page creates the
Stripe Payment Link by itself, and a client paying marks the invoice paid
by itself (which also sends them their receipt email). Without it,
everything still works — you paste Payment Links by hand and click Mark
paid yourself.

### a. The link maker

**Edge Functions → Deploy a new function → Via Editor**, named exactly
**`create-payment-link`**, pasting
`supabase/functions/create-payment-link/index.ts`. Verify JWT can stay ON.

Add one secret to it:

| Secret | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → **Developers → API keys** → *Secret key* (`sk_live_…`, or `sk_test_…` to try it safely) |

### b. The payment listener

Same again: a function named exactly **`stripe-webhook`**, pasting
`supabase/functions/stripe-webhook/index.ts`. **Verify JWT OFF** — Stripe
is not a signed-in user; the function checks Stripe's own signature
instead.

Then tell Stripe to call it: Stripe → **Developers → Webhooks → Add
endpoint**:

- **URL:** `https://kdxckigyhpnwhwgjdgqq.supabase.co/functions/v1/stripe-webhook`
- **Events:** just `checkout.session.completed`

Stripe shows a **Signing secret** (`whsec_…`) — add it to the
`stripe-webhook` function's secrets as `STRIPE_WEBHOOK_SECRET`.

### c. Test with nobody's money

Use your `sk_test_…` key first. Send yourself an invoice, open the Pay
now link, and pay with Stripe's test card `4242 4242 4242 4242` (any
future date, any CVC). The invoice should flip to paid on its own within
a few seconds. Then swap the secret to `sk_live_…` and add a live-mode
webhook endpoint the same way.

For a 50/50 split, send two invoices: "Deposit (50%)" and "Balance on
delivery."

### d. Paid another way — receipts

Clients who pay by bank transfer, mobile money or cash can attach a
receipt instead: run **`supabase-receipts.sql`** in the SQL Editor once.
Their billing page then grows an "Attach your receipt" option on unpaid
invoices. The invoice goes to **receipt in review**, lands in your bell,
and you confirm it with one click (which also sends their receipt email).
"I sent it" and "it arrived" are different events — nothing is marked
paid until you say so.

## Costs

Supabase free, Cloudflare Pages free, GitHub free. Stripe takes 2.9% + 30¢ per payment.

One catch: **a free Supabase project pauses after about 7 days with no database activity.** Logging in yourself once a week is enough to prevent it.
