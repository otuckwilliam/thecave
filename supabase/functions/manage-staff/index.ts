// The Cave Ledger — "manage-staff": lets an Admin create logins, reset passwords and turn people off.
// Runs on Supabase (Edge Functions). Uses the project's secret key, which never leaves Supabase.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const DOMAIN = "staff.thecave.local"; // usernames become username@staff.thecave.local behind the scenes
// deno-lint-ignore no-explicit-any
const info = (b: any) => ({
  phone: b.phone ? String(b.phone).trim().slice(0, 40) : null,
  notes: b.notes ? String(b.notes).trim().slice(0, 500) : null,
  started_on: /^\d{4}-\d{2}-\d{2}$/.test(String(b.started_on || "")) ? b.started_on : null,
});
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    let service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!service) { try { service = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch (_) { /* ignore */ } }
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
    if (whoErr || !who?.user) return json({ error: "Please sign in again" }, 401);
    const me = who.user;
    const { data: mine } = await admin.from("profiles").select("role,active").eq("user_id", me.id).maybeSingle();
    if (!mine || mine.role !== "admin" || mine.active === false) return json({ error: "Only an Admin can manage logins" }, 403);

    const b = await req.json().catch(() => ({}));
    const pw = String(b.password || "");

    if (b.action === "create") {
      const username = String(b.username || "").trim().toLowerCase();
      const name = String(b.name || "").trim() || username;
      if (!/^[a-z0-9._-]{2,30}$/.test(username)) return json({ error: "Username: 2–30 letters or numbers, no spaces" }, 400);
      if (pw.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const role = b.role === "admin" ? "admin" : "seller";
      const { data: taken } = await admin.from("profiles").select("user_id").ilike("username", username).maybeSingle();
      if (taken) return json({ error: "That username is already taken" }, 400);
      const { data: made, error } = await admin.auth.admin.createUser({
        email: `${username}@${DOMAIN}`, password: pw, email_confirm: true, user_metadata: { name, username },
      });
      if (error) return json({ error: /already|registered|exists/i.test(error.message) ? "That username is already taken" : error.message }, 400);
      const { error: pe } = await admin.from("profiles").insert({ user_id: made.user.id, role, label: name, username, active: true });
      if (pe) { await admin.auth.admin.deleteUser(made.user.id); return json({ error: pe.message }, 400); }
      await admin.from("staff_info").upsert({ user_id: made.user.id, ...info(b), updated_at: new Date().toISOString() });
      return json({ ok: true, user_id: made.user.id });
    }

    if (b.action === "password") {
      if (pw.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(String(b.user_id), { password: pw });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (b.action === "active") {
      const id = String(b.user_id), on = !!b.active;
      if (id === me.id) return json({ error: "You can't turn off your own login" }, 400);
      if (!on) {
        const { data: t } = await admin.from("profiles").select("role").eq("user_id", id).maybeSingle();
        if (t?.role === "admin") {
          const { count } = await admin.from("profiles").select("user_id", { count: "exact", head: true }).eq("role", "admin").eq("active", true);
          if ((count || 0) <= 1) return json({ error: "There must always be at least one Admin" }, 400);
        }
      }
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: on ? "none" : "876000h" });
      if (error) return json({ error: error.message }, 400);
      await admin.from("profiles").update({ active: on }).eq("user_id", id);
      return json({ ok: true });
    }

    if (b.action === "update") {
      const id = String(b.user_id);
      const { data: cur } = await admin.from("profiles").select("role,username").eq("user_id", id).maybeSingle();
      if (!cur) return json({ error: "Login not found" }, 404);
      // deno-lint-ignore no-explicit-any
      const patch: any = {};
      if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) return json({ error: "Add a name" }, 400); patch.label = n.slice(0, 80); }
      if (b.role !== undefined && b.role !== cur.role) {
        if (id === me.id) return json({ error: "You can't change your own access" }, 400);
        const role = b.role === "admin" ? "admin" : "seller";
        if (cur.role === "admin" && role !== "admin") {
          const { count } = await admin.from("profiles").select("user_id", { count: "exact", head: true }).eq("role", "admin").eq("active", true);
          if ((count || 0) <= 1) return json({ error: "There must always be at least one Admin" }, 400);
        }
        patch.role = role;
      }
      if (b.username !== undefined && cur.username && String(b.username).trim().toLowerCase() !== cur.username) {
        const username = String(b.username).trim().toLowerCase();
        if (!/^[a-z0-9._-]{2,30}$/.test(username)) return json({ error: "Username: 2–30 letters or numbers, no spaces" }, 400);
        const { data: taken } = await admin.from("profiles").select("user_id").ilike("username", username).neq("user_id", id).maybeSingle();
        if (taken) return json({ error: "That username is already taken" }, 400);
        const { error } = await admin.auth.admin.updateUserById(id, { email: `${username}@${DOMAIN}`, email_confirm: true });
        if (error) return json({ error: error.message }, 400);
        patch.username = username;
      }
      if (Object.keys(patch).length) {
        const { error } = await admin.from("profiles").update(patch).eq("user_id", id);
        if (error) return json({ error: error.message }, 400);
      }
      await admin.from("staff_info").upsert({ user_id: id, ...info(b), updated_at: new Date().toISOString() });
      return json({ ok: true });
    }

    if (b.action === "delete") {
      const id = String(b.user_id);
      if (id === me.id) return json({ error: "You can't delete your own login" }, 400);
      const { data: t } = await admin.from("profiles").select("role").eq("user_id", id).maybeSingle();
      if (t?.role === "admin") {
        const { count } = await admin.from("profiles").select("user_id", { count: "exact", head: true }).eq("role", "admin").eq("active", true);
        if ((count || 0) <= 1) return json({ error: "There must always be at least one Admin" }, 400);
      }
      const { error } = await admin.auth.admin.deleteUser(id); // profile + details go with it; past sales keep the name
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (b.action === "list") {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) return json({ error: error.message }, 400);
      return json({ users: data.users.map((u) => ({ id: u.id, last_sign_in_at: u.last_sign_in_at || null })) });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
