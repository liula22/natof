/*
=====================================================================================
  NATOF GameZone  —  ONE FILE: public website + admin + creator panel + backend
=====================================================================================

  DEPLOY
    1)  api/index.js      <-- this whole file
    2)  vercel.json        <-- required, 1 line:
        { "rewrites": [ { "source": "/(.*)", "destination": "/api/index" } ] }
        (Vercel must forward EVERY url, including "/" and "/admin", into this one
         file; without that rewrite a single file cannot own the whole domain.)
    3)  package.json       <-- NOT required. Zero dependencies (node built-ins only).

  HONEST STATUS
    - This code has NOT been run against a live Vercel/Supabase/Chapa account.
    - Chapa: written to Chapa's published REST contract (initialize / verify /
      webhook HMAC-SHA256). Needs your Chapa merchant keys to actually work.
    - Telebirr: written to the published H5 C2B pre-order flow (fabric token ->
      preorder -> prepay_id -> web checkout). REQUIRES an approved Telebirr
      MERCHANT ACCOUNT (business licence, TIN, short code). Untested.
    - CBE: no public API for this use case -> manual bank transfer + owner
      confirmation inside the admin panel. This is the safe, real-world default.
    - WebAuthn/Passkeys, Web Push (VAPID/aes128gcm), photo compression and the
      booking maths are implemented with node built-ins only. Verify on staging.
    - The QR on the ticket uses a public QR image service (only the booking code
      travels). Set settings.qr_service to '' to disable it; the code text shows
      either way.

  ENV VARS  (all optional -> the site NEVER crashes without them)
    SITE_URL                     public site url, used in links/sitemap/callbacks
    CREATOR_PORTFOLIO_URL        your portfolio url (footer "Creator" button)
    SUPABASE_URL                 https://xxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY    server-only key (never in the browser)
    BLOB_READ_WRITE_TOKEN        Vercel Blob token (optional; Supabase Storage is
                                 used first, Blob is the fallback)
    SUPABASE_STORAGE_BUCKET      bucket name, default "natof"
    SESSION_SECRET               random 32+ char string, signs session tokens
    CREATOR_TOKEN               your long master/recovery token
    CREATOR_SECRET_PATH          secret path of creator panel, e.g. "nfz-console-7q2"
    CHAPA_SECRET_KEY             Chapa secret key
    CHAPA_WEBHOOK_SECRET         Chapa webhook signing secret
    TELEBIRR_ENV                 sandbox | production
    TELEBIRR_FABRIC_APP_ID       Telebirr fabric app id
    TELEBIRR_APP_SECRET          Telebirr app secret
    TELEBIRR_MERCHANT_APP_ID     Telebirr merchant app id
    TELEBIRR_MERCHANT_CODE       Telebirr short code
    TELEBIRR_PRIVATE_KEY         RSA private key (PEM, \\n escaped)
    CBE_ACCOUNT_NAME             manual CBE transfer: account holder name
    CBE_ACCOUNT_NUMBER           manual CBE transfer: account number
    VAPID_PUBLIC_KEY             push public key
    VAPID_PRIVATE_KEY            push private key (base64url raw P-256)
    VAPID_SUBJECT               mailto:you@example.com
    GOOGLE_SITE_VERIFICATION     Search Console verification code

-------------------------------------------------------------------------------------
  SQL — RUN THIS ONCE in Supabase -> SQL Editor
-------------------------------------------------------------------------------------

create extension if not exists pgcrypto;

create table if not exists settings (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
insert into settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text default '',
  price numeric,                       -- null = "Ask at the zone"
  price_unit text default 'per_game',  -- per_30_min | per_hour | per_game
  variants jsonb default '[]'::jsonb,  -- [{"name":"With controller","price":50}]
  photos jsonb default '[]'::jsonb,    -- [{"url":"...","caption":""}]
  capacity int default 1,
  age_note text default '',
  bring text default '',
  health_warning text default '',
  visible boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  game_id uuid references games(id) on delete set null,
  game_name text,
  variant text,
  slot_date date not null,
  slot_start text not null,            -- "14:30"
  slot_minutes int default 30,
  blocks int default 1,
  people int default 1,
  name text, phone text, promo_code text,
  unit_price numeric, unit_label text,
  subtotal numeric, discount numeric default 0, total numeric,
  status text default 'pending',       -- pending | paid | cancelled | refunded
  internal_note text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists bookings_slot_idx on bookings (slot_date, game_id, status);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  booking_code text,
  method text,                         -- chapa | telebirr | cbe | none
  amount numeric,
  currency text default 'ETB',
  status text default 'pending',       -- pending | paid | failed | refunded
  reference text,                       -- tx_ref / bank reference
  raw jsonb default '{}'::jsonb,
  confirmed_by text,                    -- webhook | owner | creator | free
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists promos (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  description text default '',
  type text default 'percent',         -- percent | fixed | free
  value numeric default 0,
  active boolean default true,
  starts_at timestamptz, ends_at timestamptz,
  max_uses int, min_amount numeric,
  first_time_only boolean default false,
  per_phone_once boolean default true,
  games jsonb default '[]'::jsonb,     -- [] = all games
  happy_days jsonb default '[]'::jsonb,-- [5,6] = Fri, Sat
  happy_from text, happy_to text,
  created_at timestamptz default now()
);

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  author text, rating int default 5, body text,
  status text default 'pending',       -- pending | approved | rejected
  featured boolean default false,
  created_at timestamptz default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text, description text,
  entry_fee numeric, starts_at timestamptz, registration_open boolean default true,
  capacity int, cover text,
  bracket jsonb default '[]'::jsonb, results jsonb default '[]'::jsonb,
  status text default 'draft',         -- draft | published
  visible boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

create table if not exists event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  name text, phone text, team_name text,
  status text default 'pending', paid boolean default false, note text default '',
  created_at timestamptz default now()
);

create table if not exists gallery (
  id uuid primary key default gen_random_uuid(),
  url text, caption text, visible boolean default true, sort_order int default 0,
  created_at timestamptz default now()
);

create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  question text, answer text, visible boolean default true, sort_order int default 0,
  created_at timestamptz default now()
);

create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  display_name text default '',
  password_hash text not null,
  role text default 'staff',           -- owner | staff
  active boolean default true,
  must_change_password boolean default false,
  created_by text default 'creator',
  last_login timestamptz,
  created_at timestamptz default now()
);

create table if not exists admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references admins(id) on delete cascade,
  token_hash text unique not null,
  scope text default 'admin',          -- admin | creator
  ip text, ua text,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  revoked boolean default false
);

create table if not exists passkeys (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references admins(id) on delete cascade,
  credential_id text unique not null,
  public_key text not null,            -- JWK json string
  alg int default -7,
  label text default '',
  counter bigint default 0,
  created_at timestamptz default now(),
  last_used timestamptz
);

create table if not exists recovery_codes (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references admins(id) on delete cascade,
  code_hash text not null,
  used boolean default false,
  created_at timestamptz default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  at timestamptz default now(),
  actor text, role text, action text, target text, detail jsonb, ip text
);

create table if not exists webhook_log (
  id bigserial primary key,
  at timestamptz default now(),
  provider text, signature_ok boolean, body jsonb, headers jsonb, note text
);

create table if not exists push_subs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references admins(id) on delete cascade,
  endpoint text unique,
  keys jsonb, created_at timestamptz default now()
);

create table if not exists rate_limits (
  key text primary key, count int default 0, reset_at timestamptz not null
);

create table if not exists blocked_dates (
  id uuid primary key default gen_random_uuid(),
  day date unique, reason text
);

-- Lock the tables from the public internet. The server uses the service-role key,
-- which bypasses RLS. With RLS on and no policy, anon/auth keys can read nothing.
alter table settings        enable row level security;
alter table games           enable row level security;
alter table bookings        enable row level security;
alter table payments        enable row level security;
alter table promos          enable row level security;
alter table reviews         enable row level security;
alter table events          enable row level security;
alter table event_registrations enable row level security;
alter table gallery         enable row level security;
alter table faqs            enable row level security;
alter table admins          enable row level security;
alter table admin_sessions  enable row level security;
alter table passkeys        enable row level security;
alter table recovery_codes  enable row level security;
alter table audit_log       enable row level security;
alter table webhook_log     enable row level security;
alter table push_subs       enable row level security;
alter table rate_limits     enable row level security;
alter table blocked_dates   enable row level security;

-- Storage bucket for photos / background (public read, server writes).
insert into storage.buckets (id, name, public) values ('natof','natof', true)
  on conflict (id) do nothing;

-- The four starter games. Everything else (photos, text, prices) is added later.
insert into games (name, description, price, price_unit, capacity, variants, sort_order)
values
 ('Roller Skating', 'Big open skating floor. Rental skates or bring your own.',
   100, 'per_30_min', 20,
   '[{"name":"Rental skates","price":100},{"name":"Own skates","price":100}]'::jsonb, 1),
 ('Car Simulation', 'PlayStation racing rigs.', 50, 'per_game', 3, '[]'::jsonb, 2),
 ('PlayStation', 'EA FC, GTA, open-world games and more.',
   25, 'per_game', 4,
   '[{"name":"EA FC","price":25},{"name":"GTA","price":30},{"name":"Open world","price":30}]'::jsonb, 3),
 ('VR', 'Virtual reality. Two ways to play.', 50, 'per_game', 2,
   '[{"name":"With controller","price":50},{"name":"View only","price":50}]'::jsonb, 4)
on conflict do nothing;

-------------------------------------------------------------------------------------
  END SQL
-------------------------------------------------------------------------------------
*/

'use strict';

const crypto = require('crypto');

/* ==================================================================================
   0. BOOT-SAFE ENV  — nothing here throws, nothing here touches the network.
   ================================================================================== */

function env(name) {
  try {
    const v = process.env[name];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const low = s.toLowerCase();
    if (low === 'undefined' || low === 'null' || low === 'changeme' || low === 'your-key-here') return null;
    return s;
  } catch (e) { return null; }
}

function cfg() {
  const chapa = env('CHAPA_SECRET_KEY');
  const tb = env('TELEBIRR_FABRIC_APP_ID') && env('TELEBIRR_APP_SECRET') && env('TELEBIRR_MERCHANT_APP_ID') && env('TELEBIRR_MERCHANT_CODE') && env('TELEBIRR_PRIVATE_KEY');
  const cbe = env('CBE_ACCOUNT_NAME') && env('CBE_ACCOUNT_NUMBER');
  return {
    siteUrl: env('SITE_URL') || '',
    portfolio: env('CREATOR_PORTFOLIO_URL') || '',
    supabaseUrl: env('SUPABASE_URL'),
    supabaseKey: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_KEY'),
    bucket: env('SUPABASE_STORAGE_BUCKET') || 'natof',
    blobToken: env('BLOB_READ_WRITE_TOKEN'),
    sessionSecret: env('SESSION_SECRET') || env('CREATOR_TOKEN') || env('SUPABASE_SERVICE_ROLE_KEY') || 'natof-dev-secret',
    creatorToken: env('CREATOR_TOKEN'),
    creatorPath: (env('CREATOR_SECRET_PATH') || '').replace(/^\/+|\/+$/g, ''),
    chapaKey: chapa,
    chapaWebhookSecret: env('CHAPA_WEBHOOK_SECRET') || chapa,
    telebirr: tb ? {
      env: env('TELEBIRR_ENV') === 'production' ? 'production' : 'sandbox',
      fabricAppId: env('TELEBIRR_FABRIC_APP_ID'),
      appSecret: env('TELEBIRR_APP_SECRET'),
      merchantAppId: env('TELEBIRR_MERCHANT_APP_ID'),
      merchantCode: env('TELEBIRR_MERCHANT_CODE'),
      privateKey: (env('TELEBIRR_PRIVATE_KEY') || '').replace(/\\n/g, '\n'),
      base: env('TELEBIRR_ENV') === 'production' ? 'https://openapi.telebirr.com' : 'https://openapi.telebirr.com',
      web: 'https://web.telebirr.com/wap/cashier/index'
    } : null,
    cbe: cbe ? { name: env('CBE_ACCOUNT_NAME'), number: env('CBE_ACCOUNT_NUMBER') } : null,
    vapidPublic: env('VAPID_PUBLIC_KEY'),
    vapidPrivate: env('VAPID_PRIVATE_KEY'),
    vapidSubject: env('VAPID_SUBJECT') || 'mailto:admin@natofgamezone.et',
    googleVerify: env('GOOGLE_SITE_VERIFICATION')
  };
}

const DB_READY = () => { const c = cfg(); return !!(c.supabaseUrl && c.supabaseKey); };

/* ==================================================================================
   1. SMALL UTILITIES
   ================================================================================== */

function json(res, code, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(code, h);
  res.end(JSON.stringify(body));
}
function text(res, code, body, type, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, headers || {}));
  res.end(body);
}
function html(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, headers || {}));
  res.end(body);
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
function money(n) { return (Math.round(num(n) * 100) / 100).toFixed(2); }
function nowISO() { return new Date().toISOString(); }
function uid(n) { return crypto.randomBytes(n || 16).toString('hex'); }
function code6() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a[crypto.randomInt(0, a.length)];
  return s;
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a || '')); const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch (e) { return false; }
}
function clampInt(v, lo, hi, d) { const n = Math.round(num(v, d)); return Math.max(lo, Math.min(hi, n)); }
function dayKey(d) { return d.toISOString().slice(0, 10); }
function minutesOf(hhmm) { const p = String(hhmm || '0:0').split(':'); return num(p[0]) * 60 + num(p[1]); }
function hhmm(m) { const h = Math.floor(m / 60), mm = m % 60; return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm; }

function parseJSON(s, d) { try { const v = JSON.parse(s); return v === null ? d : v; } catch (e) { return d; } }

async function readRaw(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  try {
    for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  } catch (e) { /* body already consumed by the platform */ }
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}
async function readJSON(req) {
  const raw = await readRaw(req);
  if (!raw) return {};
  const v = parseJSON(raw, null);
  return v && typeof v === 'object' ? v : {};
}

function parseCookies(req) {
  const out = {};
  const h = (req.headers && req.headers.cookie) || '';
  h.split(';').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function cookieHeader(name, value, maxAge, secure) {
  const bits = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge === 0) bits.push('Max-Age=0'); else bits.push('Max-Age=' + maxAge);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
function isSecureReq(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || (cfg().siteUrl || '').indexOf('https://') === 0;
}

/* ---- signed session token (HMAC) : id.hmac ---- */
function signToken(id) {
  const h = crypto.createHmac('sha256', cfg().sessionSecret).update(id).digest('base64url');
  return id + '.' + h;
}
function verifyToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const parts = String(tok).split('.');
  const id = parts[0], sig = parts[1];
  const good = crypto.createHmac('sha256', cfg().sessionSecret).update(id).digest('base64url');
  return safeEqual(sig, good) ? id : null;
}

/* ==================================================================================
   2. DATABASE  — Supabase REST (PostgREST). Only called inside a request.
   ================================================================================== */

function noDb() { const e = new Error('SUPABASE_NOT_CONFIGURED'); e.code = 'NO_DB'; return e; }

async function sbRest(path, opt) {
  const o = opt || {};
  const c = cfg();
  if (!c.supabaseUrl || !c.supabaseKey) throw noDb();
  const base = c.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/';
  const headers = Object.assign({
    apikey: c.supabaseKey,
    Authorization: 'Bearer ' + c.supabaseKey,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }, o.headers || {});
  if (o.prefer) headers.Prefer = o.prefer;
  let body;
  if (o.body !== undefined) body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  const res = await fetch(base + path, { method: o.method || 'GET', headers: headers, body: body, cache: 'no-store' });
  const raw = await res.text();
  let data = null;
  if (raw) { data = parseJSON(raw, raw); }
  if (!res.ok) {
    let msg = (data && data.message) ? data.message : ('Supabase HTTP ' + res.status);
    if (res.status === 404 && msg.indexOf('does not exist') >= 0) msg = 'Table missing — run the SQL block at the top of the file.';
    const err = new Error(msg); err.status = res.status; err.data = data; throw err;
  }
  return data;
}

const db = {
  all: (table, q) => sbRest(table + (q ? '?' + q : ''), { method: 'GET' }),
  first: async (table, q) => { const r = await sbRest(table + (q ? '?' + q : '') + (q && q.indexOf('limit=') >= 0 ? '' : '&limit=1'), { method: 'GET' }); return Array.isArray(r) ? (r[0] || null) : null; },
  insert: (table, rows, prefer) => sbRest(table, { method: 'POST', body: rows, prefer: prefer || 'return=representation' }),
  update: (table, q, patch) => sbRest(table + '?' + q, { method: 'PATCH', body: patch, prefer: 'return=representation' }),
  remove: (table, q) => sbRest(table + '?' + q, { method: 'DELETE', prefer: 'return=representation' }),
  count: async (table, q) => {
    const c = cfg();
    const res = await fetch(c.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/' + table + '?' + (q || '') + '&select=id', {
      method: 'HEAD', headers: { apikey: c.supabaseKey, Authorization: 'Bearer ' + c.supabaseKey, Prefer: 'count=exact' }, cache: 'no-store'
    });
    const cr = res.headers.get('content-range') || '0-0/0';
    return num((cr.split('/')[1] || '0'), 0);
  }
};

/* ==================================================================================
   3. SETTINGS
   ================================================================================== */

const DEFAULT_SETTINGS = {
  brand: { name: 'NATOF GameZone', tagline: 'Roller skating, racing rigs, PlayStation & VR', logo: '' },
  background: { image: '', blur: 25, tint: 25, tintColor: '#12103a' },
  contact: { phone: '', whatsapp: '', email: '', address: '', mapUrl: '' },
  hours: { '0': ['10:00', '21:00'], '1': ['10:00', '21:00'], '2': ['10:00', '21:00'], '3': ['10:00', '21:00'], '4': ['10:00', '21:00'], '5': ['10:00', '22:00'], '6': ['09:00', '22:00'] },
  social: { telegram: '', instagram: '', tiktok: '' },
  announcement: { enabled: false, text: '', link: '' },
  features: { booking: true, tournaments: true, payments: true, reviews: true, gallery: true },
  maintenance: { enabled: false, message: 'We are upgrading the zone. Back very soon.', until: '' },
  booking: { slotMinutes: 30, maxDaysAhead: 30, maxPeople: 20, holdMinutes: 30 },
  seo: { title: 'NATOF GameZone — Roller skating, PlayStation, VR in Ethiopia', description: 'Book roller skating, PlayStation racing rigs, FC, GTA, VR and tournaments at NATOF GameZone. Pay in ETB with Chapa, Telebirr or CBE.' },
  legal: { terms: '', privacy: '', refund: '' },
  about: { title: 'The zone', body: '' },
  qr_service: 'https://api.qrserver.com/v1/create-qr-code/'
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!patch || typeof patch !== 'object') return out;
  Object.keys(patch).forEach(function (k) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  });
  return out;
}

async function getSettings() {
  if (!DB_READY()) return Object.assign({}, DEFAULT_SETTINGS);
  try {
    const row = await db.first('settings', 'id=eq.1');
    return deepMerge(DEFAULT_SETTINGS, (row && row.data) || {});
  } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
async function saveSettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  const row = await db.first('settings', 'id=eq.1');
  if (row) await db.update('settings', 'id=eq.1', { data: next, updated_at: nowISO() });
  else await db.insert('settings', { id: 1, data: next });
  return next;
}

/* ==================================================================================
   4. RATE LIMIT / AUDIT
   ================================================================================== */
const MEM_RL = new Map();

async function rateLimit(key, limit, windowSec) {
  const resetAt = new Date(Date.now() + windowSec * 1000).toISOString();
  if (!DB_READY()) {
    const cur = MEM_RL.get(key);
    const t = Date.now();
    if (!cur || cur.reset < t) { MEM_RL.set(key, { n: 1, reset: t + windowSec * 1000 }); return { ok: true, left: limit - 1 }; }
    cur.n++;
    return { ok: cur.n <= limit, left: Math.max(0, limit - cur.n) };
  }
  try {
    const row = await db.first('rate_limits', 'key=eq.' + encodeURIComponent(key));
    if (!row) { await db.insert('rate_limits', { key: key, count: 1, reset_at: resetAt }); return { ok: true, left: limit - 1 }; }
    if (new Date(row.reset_at).getTime() < Date.now()) {
      await db.update('rate_limits', 'key=eq.' + encodeURIComponent(key), { count: 1, reset_at: resetAt });
      return { ok: true, left: limit - 1 };
    }
    const n = num(row.count) + 1;
    await db.update('rate_limits', 'key=eq.' + encodeURIComponent(key), { count: n });
    return { ok: n <= limit, left: Math.max(0, limit - n) };
  } catch (e) { return { ok: true, left: limit }; }
}

async function audit(actor, role, action, target, detail, req) {
  if (!DB_READY()) return;
  try {
    await db.insert('audit_log', [{
      actor: actor || 'anon', role: role || 'anon', action: action, target: target || '',
      detail: detail || {}, ip: clientIp(req || { headers: {} })
    }]);
  } catch (e) { /* audit must never break a request */ }
}
function clientIp(req) {
  const h = req.headers || {};
  return String((h['x-forwarded-for'] || '').split(',')[0] || h['x-real-ip'] || 'unknown').trim();
}

/* ==================================================================================
   5. AUTH
   ================================================================================== */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return 'scrypt$16384$' + salt + '$' + key.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const p = String(stored || '').split('$');
    if (p.length !== 4 || p[0] !== 'scrypt') return false;
    const N = num(p[1], 16384), salt = p[2], hash = p[3];
    const key = crypto.scryptSync(String(pw), salt, 64, { N: N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return safeEqual(key.toString('hex'), hash);
  } catch (e) { return false; }
}

const SESSION_HOURS_ADMIN = 12;
const SESSION_HOURS_CREATOR = 4;

async function createSession(adminId, scope, req) {
  const raw = uid(32);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const hours = scope === 'creator' ? SESSION_HOURS_CREATOR : SESSION_HOURS_ADMIN;
  const exp = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await db.insert('admin_sessions', [{ admin_id: adminId, token_hash: hash, scope: scope, ip: clientIp(req), ua: String((req.headers['user-agent'] || '')).slice(0, 200), expires_at: exp }]);
  return signToken(raw);
}
async function getSession(req) {
  if (!DB_READY()) return null;
  const tok = parseCookies(req)['natof_session'];
  if (!tok) return null;
  const raw = verifyToken(tok);
  if (!raw) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    const s = await db.first('admin_sessions', 'token_hash=eq.' + hash);
    if (!s || s.revoked) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    if (s.scope === 'creator') return { role: 'creator', scope: 'creator', adminId: s.admin_id, sessionId: s.id, username: 'creator' };
    const a = await db.first('admins', 'id=eq.' + s.admin_id);
    if (!a || !a.active) return null;
    return { role: a.role, scope: 'admin', adminId: a.id, sessionId: s.id, username: a.username, display_name: a.display_name, must_change_password: !!a.must_change_password };
  } catch (e) { return null; }
}
async function revokeAll(adminId) {
  try { await db.update('admin_sessions', 'admin_id=eq.' + adminId + '&revoked=eq.false', { revoked: true }); } catch (e) { }
}
async function getCreatorSession(req) {
  const s = await getSession(req);
  return s && s.role === 'creator' ? s : null;
}

/* ---------- recovery codes ---------- */
async function makeRecoveryCodes(adminId, n) {
  const codes = [];
  const rows = [];
  for (let i = 0; i < (n || 8); i++) {
    const c = uid(5).toUpperCase() + '-' + uid(5).toUpperCase();
    codes.push(c);
    rows.push({ admin_id: adminId, code_hash: crypto.createHash('sha256').update(c).digest('hex') });
  }
  try { await db.remove('recovery_codes', 'admin_id=eq.' + adminId); } catch (e) { }
  await db.insert('recovery_codes', rows);
  return codes;
}

/* ==================================================================================
   6. WEBAUTHN (passkeys) — real signature verification with node crypto only
   ================================================================================== */

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64u(s) { return Buffer.from(String(s), 'base64url'); }

function parseAuthData(buf) {
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const counter = buf.readUInt32BE(33);
  const rest = buf.subarray(37);
  let credId = null, cose = null;
  if (flags & 0x40) { // attested credential data present
    const idLen = rest.readUInt16BE(0);
    credId = rest.subarray(2, 2 + idLen);
    cose = rest.subarray(2 + idLen);
  }
  return { rpIdHash: rpIdHash, flags: flags, counter: counter, credId: credId, cose: cose };
}
function coseToJWK(cose, alg) {
  // Minimal CBOR map reader for the COSE keys we meet (kty 2 = EC2, kty 3 = RSA)
  let i = 0;
  function read() {
    const b = cose[i++];
    const major = b >> 5, info = b & 31;
    let len = info;
    if (info === 24) { len = cose[i++]; }
    else if (info === 25) { len = cose.readUInt16BE(i); i += 2; }
    else if (info === 26) { len = cose.readUInt32BE(i); i += 4; }
    if (major === 0) return len;
    if (major === 1) return -1 - len;
    if (major === 2) { const out = cose.subarray(i, i + len); i += len; return out; }
    if (major === 3) { const out = cose.subarray(i, i + len).toString('utf8'); i += len; return out; }
    if (major === 4) { const arr = []; for (let k = 0; k < len; k++) arr.push(read()); return arr; }
    if (major === 5) { const m = {}; for (let k = 0; k < len; k++) { const key = read(); m[String(key)] = read(); } return m; }
    if (major === 7) return null;
    return null;
  }
  const map = read() || {};
  const kty = map['1'], a = map['3'];
  if (kty === 2) {
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64u(map['-2']), y: b64u(map['-3']) }, alg: a || -7 };
  }
  if (kty === 3) {
    return { jwk: { kty: 'RSA', n: b64u(map['-1']), e: b64u(map['-2']) }, alg: a || -257 };
  }
  throw new Error('Unsupported credential key type');
}
function webAuthnChallenge() { return b64u(crypto.randomBytes(32)); }

async function verifyRegistration(adminId, rpId, origin, body, challengeStore) {
  const cd = parseJSON(Buffer.from(String(body.clientDataJSON), 'base64url').toString('utf8'), null);
  if (!cd) throw new Error('Bad clientDataJSON');
  if (cd.type !== 'webauthn.create') throw new Error('Wrong ceremony type');
  if (cd.challenge !== challengeStore) throw new Error('Challenge mismatch');
  if (cd.origin !== origin) throw new Error('Origin mismatch');
  const att = parseJSON(Buffer.from(String(body.attestationObject), 'base64url').toString('utf8'), null);
  // attestationObject is CBOR, not JSON -> minimal parse
  const attBuf = Buffer.from(String(body.attestationObject), 'base64url');
  const attData = cborAttestation(attBuf);
  const auth = parseAuthData(attData.authData);
  const expectedRp = crypto.createHash('sha256').update(rpId).digest();
  if (!safeEqual(auth.rpIdHash.toString('hex'), expectedRp.toString('hex'))) throw new Error('RP id hash mismatch');
  if (!(auth.flags & 0x01)) throw new Error('User presence flag missing');
  const key = coseToJWK(auth.cose, null);
  return { credentialId: b64u(auth.credId), jwk: key.jwk, alg: key.alg, counter: auth.counter };
}
function cborAttestation(buf) {
  // Walk the top-level CBOR map to find "authData"
  let i = 0;
  function head() {
    const b = buf[i++];
    const major = b >> 5, info = b & 31;
    let len = info;
    if (info === 24) { len = buf[i++]; }
    else if (info === 25) { len = buf.readUInt16BE(i); i += 2; }
    else if (info === 26) { len = buf.readUInt32BE(i); i += 4; }
    return { major: major, len: len };
  }
  function skip() { const h = head(); if (h.major === 2 || h.major === 3) i += h.len; else if (h.major === 4) { for (let k = 0; k < h.len; k++) skip(); } else if (h.major === 5) { for (let k = 0; k < h.len; k++) { skip(); skip(); } } return; }
  const top = head();
  let authData = null;
  for (let k = 0; k < top.len; k++) {
    const hk = head();
    const keyBuf = buf.subarray(i, i + hk.len); i += hk.len;
    const keyName = keyBuf.toString('utf8');
    if (keyName === 'authData') {
      const hv = head();
      authData = buf.subarray(i, i + hv.len);
      i += hv.len;
    } else skip();
  }
  if (!authData) throw new Error('Missing authData in attestationObject');
  return { authData: authData };
}
async function verifyAssertion(rpId, origin, body, challengeStore, jwk, alg, storedCounter) {
  const cd = parseJSON(Buffer.from(String(body.clientDataJSON), 'base64url').toString('utf8'), null);
  if (!cd) throw new Error('Bad clientDataJSON');
  if (cd.type !== 'webauthn.get') throw new Error('Wrong ceremony type');
  if (cd.challenge !== challengeStore) throw new Error('Challenge mismatch');
  if (cd.origin !== origin) throw new Error('Origin mismatch');
  const authData = Buffer.from(String(body.authenticatorData), 'base64url');
  if (body.userHandle) { /* we always use the stored account */ }
  const auth = parseAuthData(authData);
  const expectedRp = crypto.createHash('sha256').update(rpId).digest();
  if (!safeEqual(auth.rpIdHash.toString('hex'), expectedRp.toString('hex'))) throw new Error('RP id hash mismatch');
  if (!(auth.flags & 0x01)) throw new Error('User presence flag missing');
  const clientHash = crypto.createHash('sha256').update(Buffer.from(String(body.clientDataJSON), 'base64url')).digest();
  const signed = Buffer.concat([authData, clientHash]);
  const sig = Buffer.from(String(body.signature), 'base64url');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  let ok = false;
  if (alg === -7) ok = crypto.verify('sha256', signed, { key: pub, dsaEncoding: 'der' }, sig);
  else if (alg === -257) ok = crypto.verify('sha256', signed, pub, sig);
  else ok = crypto.verify('sha256', signed, pub, sig);
  if (!ok) throw new Error('Signature verification failed');
  if (storedCounter && auth.counter && auth.counter <= storedCounter) throw new Error('Possible cloned authenticator');
  return { counter: auth.counter };
}

/* ==================================================================================
   7. WEB PUSH (VAPID + aes128gcm) — node crypto only
   ================================================================================== */

function hkdf(ikm, salt, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), len));
}
function vapidKeyPair() {
  const c = cfg();
  if (!c.vapidPublic || !c.vapidPrivate) return null;
  try {
    const d = Buffer.from(c.vapidPrivate, 'base64url');
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const pub = ecdh.getPublicKey();
    const jwk = { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
    return { publicB64: c.vapidPublic, privateB64: c.vapidPrivate, jwk: jwk };
  } catch (e) { return null; }
}
function vapidJWT(endpoint) {
  const kp = vapidKeyPair();
  if (!kp) return null;
  const u = new URL(endpoint);
  const aud = u.protocol + '//' + u.host;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: cfg().vapidSubject })));
  const key = crypto.createPrivateKey({ key: kp.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + payload), { key: key, dsaEncoding: 'ieee-p1363' });
  return header + '.' + payload + '.' + b64u(sig);
}
async function sendPush(sub, payloadObj) {
  const kp = vapidKeyPair();
  if (!kp) throw new Error('VAPID keys missing');
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const uaKey = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(uaPublic.subarray(1, 33)), y: b64u(uaPublic.subarray(33, 65)) }, format: 'jwk'
  });
  const asPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const secret = crypto.diffieHellman({ privateKey: asPair.privateKey, publicKey: uaKey });
  const asJwk = asPair.publicKey.export({ format: 'jwk' });
  const asPublic = Buffer.concat([Buffer.from([4]), Buffer.from(asJwk.x, 'base64url'), Buffer.from(asJwk.y, 'base64url')]);
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12);
  const plain = Buffer.concat([Buffer.from(JSON.stringify(payloadObj), 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([65]), asPublic]);
  const body = Buffer.concat([header, enc]);
  const jwt = vapidJWT(sub.endpoint);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'normal',
      Authorization: 'vapid t=' + jwt + ', k=' + kp.publicB64
    },
    body: body
  });
  if (res.status === 404 || res.status === 410) return { gone: true, status: res.status };
  return { ok: res.ok, status: res.status, text: res.ok ? '' : (await res.text()).slice(0, 300) };
}
async function notifyAdmins(payload) {
  if (!DB_READY() || !vapidKeyPair()) return;
  try {
    const subs = await db.all('push_subs', 'select=*');
    const dead = [];
    await Promise.allSettled((subs || []).map(async function (s) {
      try {
        const r = await sendPush({ endpoint: s.endpoint, keys: s.keys }, payload);
        if (r && r.gone) dead.push(s.id);
      } catch (e) { }
    }));
    for (const id of dead) { try { await db.remove('push_subs', 'id=eq.' + id); } catch (e) { } }
  } catch (e) { }
}

/* ==================================================================================
   8. UPLOAD  — Supabase Storage first, Vercel Blob fallback
   ================================================================================== */

async function uploadObject(name, buffer, mime) {
  const c = cfg();
  const safeName = String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = 'uploads/' + Date.now() + '-' + uid(4) + '-' + safeName;
  if (c.supabaseUrl && c.supabaseKey) {
    const res = await fetch(c.supabaseUrl.replace(/\/+$/, '') + '/storage/v1/object/' + c.bucket + '/' + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + c.supabaseKey,
        'Content-Type': mime || 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: buffer
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('Storage upload failed: ' + t.slice(0, 200));
    }
    return c.supabaseUrl.replace(/\/+$/, '') + '/storage/v1/object/public/' + c.bucket + '/' + path;
  }
  if (c.blobToken) {
    const res = await fetch('https://vercel.com/api/blob/?pathname=' + encodeURIComponent(path), {
      method: 'PUT',
      headers: {
        authorization: 'Bearer ' + c.blobToken,
        'x-api-version': '12',
        'x-content-type': mime || 'application/octet-stream',
        'x-add-random-suffix': '1',
        'x-vercel-blob-access': 'public'
      },
      body: buffer
    });
    const j = parseJSON(await res.text(), {});
    if (!res.ok || !j.url) throw new Error('Blob upload failed: ' + JSON.stringify(j).slice(0, 200));
    return j.url;
  }
  throw new Error('NO_STORAGE_CONFIGURED');
}

/* ==================================================================================
   9. PRICING / SLOTS / PROMOS
   ================================================================================== */

function unitMultiplier(priceUnit, blocks) {
  if (priceUnit === 'per_hour') return Math.max(1, Math.ceil(blocks / 2));
  return blocks; // per_30_min and per_game
}
function priceLine(game, variantName, people, blocks) {
  if (game.price === null || game.price === undefined || game.price === '') return null;
  let unit = num(game.price);
  let variant = '';
  const variants = Array.isArray(game.variants) ? game.variants : [];
  if (variantName) {
    const v = variants.filter(function (x) { return x && x.name === variantName; })[0];
    if (v) { variant = v.name; if (v.price !== undefined && v.price !== null && v.price !== '') unit = num(v.price); }
  }
  const mult = unitMultiplier(game.price_unit, blocks);
  const subtotal = Math.round(unit * people * mult * 100) / 100;
  return { unit: unit, variant: variant, multiplier: mult, subtotal: subtotal, unitLabel: game.price_unit || 'per_game' };
}
function slotsForDay(settings, date) {
  const d = new Date(date + 'T00:00:00Z');
  const wd = String(d.getUTCDay());
  const h = (settings.hours || {})[wd] || (settings.hours || {})['1'];
  if (!h || !h[0] || !h[1]) return [];
  const open = minutesOf(h[0]), close = minutesOf(h[1]);
  const step = 30, out = [];
  for (let m = open; m + step <= close; m += step) out.push(hhmm(m));
  return out;
}
function isClosedDay(settings, date) {
  const d = new Date(date + 'T00:00:00Z');
  const wd = String(d.getUTCDay());
  const h = (settings.hours || {})[wd];
  return !h || !h[0] || !h[1] || minutesOf(h[1]) - minutesOf(h[0]) < 30;
}
function slotIndex(slot) { return Math.floor(minutesOf(slot) / 30); }

async function checkCapacity(settings, game, date, startSlot, blocks, people, ignoreBookingId) {
  const slots = slotsForDay(settings, date);
  const startIdx = slots.indexOf(startSlot);
  if (startIdx < 0) return { ok: false, reason: 'That time is outside opening hours.' };
  if (startIdx + blocks > slots.length) return { ok: false, reason: 'That booking would run past closing time.' };
  const cap = num(game.capacity, 1) || 1;
  if (num(people, 1) < 1) return { ok: false, reason: 'At least one person is required.' };
  const maxPeople = num((settings.booking || {}).maxPeople, 20);
  if (num(people) > maxPeople) return { ok: false, reason: 'Maximum ' + maxPeople + ' people per booking.' };
  try {
    const rows = await db.all('bookings', 'select=id,slot_start,blocks,people,status&slot_date=eq.' + date + '&game_id=eq.' + game.id + '&status=in.(pending,paid)');
    const wanted = []; for (let i = 0; i < blocks; i++) wanted.push(startIdx + i);
    let worst = 0;
    for (const s of wanted) {
      let used = num(people);
      for (const b of (rows || [])) {
        if (ignoreBookingId && b.id === ignoreBookingId) continue;
        const bi = slotIndex(b.slot_start);
        if (s >= bi && s < bi + num(b.blocks, 1)) used += num(b.people, 1);
      }
      if (used > worst) worst = used;
    }
    if (worst > cap) return { ok: false, reason: 'Only ' + Math.max(0, cap - (worst - num(people))) + ' place(s) left in that slot.' };
    return { ok: true };
  } catch (e) { return { ok: true, degraded: true }; }
}

async function promoContext(code) {
  const rows = await db.all('promos', 'select=*&code=eq.' + encodeURIComponent(String(code).toUpperCase()) + '&limit=1');
  return (rows && rows[0]) || null;
}
async function promoDiscount(promo, ctx) {
  // ctx: { subtotal, phone, gameId, date, slot, blocks, settings }
  if (!promo) return { ok: false, reason: 'Promo code not found.' };
  if (!promo.active) return { ok: false, reason: 'This promo is not active.' };
  const t = Date.now();
  if (promo.starts_at && new Date(promo.starts_at).getTime() > t) return { ok: false, reason: 'This promo has not started yet.' };
  if (promo.ends_at && new Date(promo.ends_at).getTime() < t) return { ok: false, reason: 'This promo has expired.' };
  const games = Array.isArray(promo.games) ? promo.games : [];
  if (games.length && ctx.gameId && games.indexOf(ctx.gameId) < 0) return { ok: false, reason: 'This promo does not apply to that game.' };
  if (promo.min_amount && num(ctx.subtotal) < num(promo.min_amount)) return { ok: false, reason: 'Minimum ' + money(promo.min_amount) + ' ETB for this promo.' };
  const days = Array.isArray(promo.happy_days) ? promo.happy_days.map(Number) : [];
  if (days.length) {
    const wd = new Date(ctx.date + 'T00:00:00Z').getUTCDay();
    const m = minutesOf(ctx.slot);
    const from = promo.happy_from ? minutesOf(promo.happy_from) : 0;
    const to = promo.happy_to ? minutesOf(promo.happy_to) : 1440;
    if (days.indexOf(wd) < 0 || m < from || m >= to) return { ok: false, reason: 'This promo only works during happy hours.' };
  }
  if (promo.max_uses) {
    const used = await db.count('bookings', 'promo_code=eq.' + encodeURIComponent(promo.code) + '&status=eq.paid');
    if (used >= num(promo.max_uses)) return { ok: false, reason: 'This promo is fully used.' };
  }
  if (promo.per_phone_once && ctx.phone) {
    const mine = await db.count('bookings', 'promo_code=eq.' + encodeURIComponent(promo.code) + '&phone=eq.' + encodeURIComponent(ctx.phone) + '&status=eq.paid');
    if (mine > 0) return { ok: false, reason: 'You already used this promo.' };
  }
  if (promo.first_time_only && ctx.phone) {
    const total = await db.count('bookings', 'phone=eq.' + encodeURIComponent(ctx.phone) + '&status=eq.paid');
    if (total > 0) return { ok: false, reason: 'This promo is for first-time customers only.' };
  }
  let value = 0;
  if (promo.type === 'free') value = num(ctx.subtotal);
  else if (promo.type === 'fixed') value = Math.min(num(promo.value), num(ctx.subtotal));
  else value = Math.round(num(ctx.subtotal) * num(promo.value) / 100 * 100) / 100;
  value = Math.max(0, Math.round(value * 100) / 100);
  return { ok: true, discount: value, type: promo.type, code: promo.code, message: promo.description || '' };
}

/* ==================================================================================
   10. PAYMENT PROVIDERS
   ================================================================================== */

async function chapaInit(req, booking, settings) {
  const c = cfg();
  if (!c.chapaKey) return { ok: false, reason: 'CHAPA_NOT_CONFIGURED' };
  const txRef = 'NFZ-' + booking.code + '-' + Date.now().toString(36);
  const site = c.siteUrl || ('https://' + (req.headers.host || 'localhost'));
  const payload = {
    amount: money(booking.total),
    currency: 'ETB',
    first_name: String(booking.name || 'Guest').split(' ')[0],
    last_name: String(booking.name || '').split(' ').slice(1).join(' ') || 'Customer',
    phone_number: booking.phone || '',
    tx_ref: txRef,
    callback_url: site + '/api/payments/chapa/webhook',
    return_url: site + '/?ticket=' + encodeURIComponent(booking.code),
    customization: { title: settings.brand.name, description: 'Booking ' + booking.code }
  };
  const res = await fetch('https://api.chapa.co/v1/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.chapaKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = parseJSON(await res.text(), {});
  if (!res.ok || !j || !j.data || !j.data.checkout_url) {
    return { ok: false, reason: (j && j.message) ? j.message : ('Chapa error ' + res.status) };
  }
  await db.insert('payments', [{ booking_id: booking.id, booking_code: booking.code, method: 'chapa', amount: booking.total, currency: 'ETB', status: 'pending', reference: txRef, raw: j }]);
  return { ok: true, checkout_url: j.data.checkout_url, tx_ref: txRef };
}
async function chapaVerify(txRef) {
  const c = cfg();
  if (!c.chapaKey) return null;
  const res = await fetch('https://api.chapa.co/v1/transaction/verify/' + encodeURIComponent(txRef), {
    headers: { Authorization: 'Bearer ' + c.chapaKey }
  });
  const j = parseJSON(await res.text(), {});
  return (j && j.data) || null;
}
function verifyChapaSignature(raw, headerVal) {
  const c = cfg();
  if (!headerVal) return false;
  const secret = c.chapaWebhookSecret || c.chapaKey || '';
  if (!secret) return false;
  const mine = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  return safeEqual(mine, String(headerVal));
}

/* Telebirr H5 C2B — requires an APPROVED merchant account. Written to the
   published pre-order contract; treat as a scaffold until your merchant keys
   are live and you have tested in the Telebirr sandbox. */
async function telebirrInit(booking, settings) {
  const t = cfg().telebirr;
  if (!t) return { ok: false, reason: 'TELEBIRR_NOT_CONFIGURED' };
  const tokenRes = await fetch(t.base + '/payment/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-APP-Key': t.fabricAppId },
    body: JSON.stringify({ appSecret: t.appSecret })
  });
  const tokenJson = parseJSON(await tokenRes.text(), {});
  const token = tokenJson && (tokenJson.token || (tokenJson.data && tokenJson.data.token));
  if (!token) return { ok: false, reason: 'Telebirr fabric token failed' };
  const site = cfg().siteUrl || '';
  const biz = {
    notify_url: site + '/api/payments/telebirr/notify',
    redirect_url: site + '/?ticket=' + encodeURIComponent(booking.code),
    appid: t.merchantAppId,
    merch_code: t.merchantCode,
    business_type: 'BuyGoods',
    merch_order_id: 'NFZ' + booking.code,
    trade_type: 'Checkout',
    title: settings.brand.name + ' booking',
    total_amount: money(booking.total),
    trans_currency: 'ETB',
    timeout_express: '120m',
    callback_info: booking.code
  };
  const orderPayload = {
    timestamp: String(Date.now()),
    nonce_str: uid(8),
    method: 'payment.preorder',
    version: '1.0',
    biz_content: biz
  };
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(JSON.stringify(biz));
  sign.end();
  let signature;
  try { signature = sign.sign({ key: t.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, 'base64'); }
  catch (e) { signature = sign.sign(t.privateKey, 'base64'); }
  const res = await fetch(t.base + '/payment/v1/merchant/preOrder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-APP-Key': t.fabricAppId, Authorization: token },
    body: JSON.stringify(Object.assign({}, orderPayload, { sign: signature, sign_type: 'SHA256WithRSA' }))
  });
  const j = parseJSON(await res.text(), {});
  const bc = j && (j.biz_content || (j.data && j.data.biz_content));
  if (!bc || !bc.prepay_id) return { ok: false, reason: (j && j.msg) || 'Telebirr pre-order failed' };
  const params = ['appid=' + t.merchantAppId, 'merch_code=' + t.merchantCode, 'nonce_str=' + uid(8),
    'prepay_id=' + bc.prepay_id, 'timestamp=' + Date.now()].join('&');
  const s2 = crypto.createSign('RSA-SHA256');
  s2.update(params); s2.end();
  let sig2;
  try { sig2 = s2.sign({ key: t.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, 'base64'); }
  catch (e) { sig2 = s2.sign(t.privateKey, 'base64'); }
  const url = t.web + '?' + params + '&sign=' + encodeURIComponent(sig2) + '&sign_type=SHA256WithRSA&version=1.0&trade_type=Checkout';
  await db.insert('payments', [{ booking_id: booking.id, booking_code: booking.code, method: 'telebirr', amount: booking.total, currency: 'ETB', status: 'pending', reference: 'NFZ' + booking.code, raw: j }]);
  return { ok: true, checkout_url: url, prepay_id: bc.prepay_id };
}

/* ==================================================================================
   11. ADMIN ENTITY REGISTRY (drives both the API and the admin UI)
   ================================================================================== */

const ENTITIES = {
  games: {
    label: 'Games', table: 'games', order: 'sort_order.asc,created_at.asc', reorder: true,
    fields: [
      { k: 'name', t: 'text', label: 'Name', required: true },
      { k: 'description', t: 'textarea', label: 'Description' },
      { k: 'price', t: 'number', label: 'Price (ETB)', hint: 'Leave empty to show "Ask at the zone" and hide the Order button.' },
      { k: 'price_unit', t: 'select', label: 'Price unit', options: [['per_30_min', 'per 30 min'], ['per_hour', 'per hour'], ['per_game', 'per game']] },
      { k: 'variants', t: 'kvlist', label: 'Variants (name + optional price)' },
      { k: 'capacity', t: 'number', label: 'Capacity at the same time' },
      { k: 'age_note', t: 'text', label: 'Age note' },
      { k: 'bring', t: 'text', label: 'What to bring' },
      { k: 'health_warning', t: 'text', label: 'Health warning' },
      { k: 'photos', t: 'photos', label: 'Photos (auto-slide, first = cover)' },
      { k: 'visible', t: 'bool', label: 'Visible on the site' },
      { k: 'sort_order', t: 'number', label: 'Order' }
    ]
  },
  bookings: {
    label: 'Bookings', table: 'bookings', order: 'created_at.desc', money: true,
    fields: [
      { k: 'code', t: 'text', label: 'Code', readonly: true },
      { k: 'game_name', t: 'text', label: 'Game', readonly: true },
      { k: 'variant', t: 'text', label: 'Variant', readonly: true },
      { k: 'slot_date', t: 'text', label: 'Date', readonly: true },
      { k: 'slot_start', t: 'text', label: 'Start', readonly: true },
      { k: 'blocks', t: 'number', label: 'Blocks', readonly: true },
      { k: 'people', t: 'number', label: 'People', readonly: true },
      { k: 'name', t: 'text', label: 'Name' },
      { k: 'phone', t: 'text', label: 'Phone' },
      { k: 'promo_code', t: 'text', label: 'Promo', readonly: true },
      { k: 'subtotal', t: 'number', label: 'Subtotal', readonly: true },
      { k: 'discount', t: 'number', label: 'Discount', readonly: true },
      { k: 'total', t: 'number', label: 'Total', readonly: true },
      { k: 'status', t: 'select', label: 'Status', options: [['pending', 'pending'], ['paid', 'paid'], ['cancelled', 'cancelled'], ['refunded', 'refunded']] },
      { k: 'internal_note', t: 'textarea', label: 'Internal note' }
    ]
  },
  payments: {
    label: 'Payments', table: 'payments', order: 'created_at.desc', money: true, ownerOnly: true,
    fields: [
      { k: 'booking_code', t: 'text', label: 'Booking', readonly: true },
      { k: 'method', t: 'select', label: 'Method', readonly: true, options: [['chapa', 'chapa'], ['telebirr', 'telebirr'], ['cbe', 'cbe'], ['none', 'none']] },
      { k: 'amount', t: 'number', label: 'Amount', readonly: true },
      { k: 'status', t: 'select', label: 'Status', options: [['pending', 'pending'], ['paid', 'paid'], ['failed', 'failed'], ['refunded', 'refunded']] },
      { k: 'reference', t: 'text', label: 'Reference' },
      { k: 'note', t: 'textarea', label: 'Note' }
    ]
  },
  promos: {
    label: 'Promos', table: 'promos', order: 'created_at.desc', money: true,
    fields: [
      { k: 'code', t: 'text', label: 'Code', required: true },
      { k: 'description', t: 'text', label: 'Description' },
      { k: 'type', t: 'select', label: 'Type', options: [['percent', 'percent'], ['fixed', 'fixed ETB'], ['free', '100% free']] },
      { k: 'value', t: 'number', label: 'Value (percent or ETB)' },
      { k: 'active', t: 'bool', label: 'Active' },
      { k: 'starts_at', t: 'datetime', label: 'Starts' },
      { k: 'ends_at', t: 'datetime', label: 'Ends' },
      { k: 'max_uses', t: 'number', label: 'Total uses' },
      { k: 'min_amount', t: 'number', label: 'Minimum amount' },
      { k: 'first_time_only', t: 'bool', label: 'First-time customers only' },
      { k: 'per_phone_once', t: 'bool', label: 'One use per phone' },
      { k: 'games', t: 'json', label: 'Selected games (JSON array of game ids, empty = all)' },
      { k: 'happy_days', t: 'json', label: 'Happy-hour days [0=Sun..6=Sat]' },
      { k: 'happy_from', t: 'text', label: 'Happy hour from (HH:MM)' },
      { k: 'happy_to', t: 'text', label: 'Happy hour to (HH:MM)' }
    ]
  },
  reviews: {
    label: 'Reviews', table: 'reviews', order: 'created_at.desc',
    fields: [
      { k: 'author', t: 'text', label: 'Author' },
      { k: 'rating', t: 'number', label: 'Rating 1-5' },
      { k: 'body', t: 'textarea', label: 'Review' },
      { k: 'status', t: 'select', label: 'Status', options: [['pending', 'pending'], ['approved', 'approved'], ['rejected', 'rejected']] },
      { k: 'featured', t: 'bool', label: 'Featured' }
    ]
  },
  events: {
    label: 'Tournaments', table: 'events', order: 'starts_at.asc', reorder: true,
    fields: [
      { k: 'title', t: 'text', label: 'Title' },
      { k: 'description', t: 'textarea', label: 'Description' },
      { k: 'entry_fee', t: 'number', label: 'Entry fee (ETB)' },
      { k: 'starts_at', t: 'datetime', label: 'Starts at' },
      { k: 'registration_open', t: 'bool', label: 'Registration open' },
      { k: 'capacity', t: 'number', label: 'Capacity' },
      { k: 'cover', t: 'photo', label: 'Cover photo' },
      { k: 'status', t: 'select', label: 'Status', options: [['draft', 'draft'], ['published', 'published']] },
      { k: 'visible', t: 'bool', label: 'Visible' },
      { k: 'bracket', t: 'json', label: 'Bracket (JSON)' },
      { k: 'results', t: 'json', label: 'Results (JSON)' }
    ]
  },
  registrations: {
    label: 'Registrations', table: 'event_registrations', order: 'created_at.desc',
    fields: [
      { k: 'name', t: 'text', label: 'Name' },
      { k: 'phone', t: 'text', label: 'Phone' },
      { k: 'team_name', t: 'text', label: 'Team' },
      { k: 'status', t: 'select', label: 'Status', options: [['pending', 'pending'], ['confirmed', 'confirmed'], ['cancelled', 'cancelled']] },
      { k: 'paid', t: 'bool', label: 'Paid' },
      { k: 'note', t: 'textarea', label: 'Note' }
    ]
  },
  gallery: {
    label: 'Gallery', table: 'gallery', order: 'sort_order.asc', reorder: true,
    fields: [
      { k: 'url', t: 'photo', label: 'Photo' },
      { k: 'caption', t: 'text', label: 'Caption' },
      { k: 'visible', t: 'bool', label: 'Visible' },
      { k: 'sort_order', t: 'number', label: 'Order' }
    ]
  },
  faqs: {
    label: 'FAQ', table: 'faqs', order: 'sort_order.asc', reorder: true,
    fields: [
      { k: 'question', t: 'text', label: 'Question' },
      { k: 'answer', t: 'textarea', label: 'Answer' },
      { k: 'visible', t: 'bool', label: 'Visible' },
      { k: 'sort_order', t: 'number', label: 'Order' }
    ]
  }
};

function entityWritableFields(name) {
  return ENTITIES[name].fields.filter(function (f) { return !f.readonly; }).map(function (f) { return f.k; });
}
function sanitizeRow(name, body) {
  const allowed = entityWritableFields(name);
  const out = {};
  const meta = ENTITIES[name];
  meta.fields.forEach(function (f) {
    if (f.readonly) return;
    if (!(f.k in body)) return;
    let v = body[f.k];
    if (f.t === 'number') v = (v === '' || v === null || v === undefined) ? null : num(v);
    if (f.t === 'bool') v = !!v;
    if (f.t === 'kvlist' || f.t === 'json' || f.t === 'photos') v = (typeof v === 'string') ? parseJSON(v, []) : v;
    if (typeof v === 'string') v = v.slice(0, 4000);
    out[f.k] = v;
  });
  if (name === 'promos' && out.code) out.code = String(out.code).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  return out;
}

/* ==================================================================================
   12. ROUTER
   ================================================================================== */

function match(pattern, pathname) {
  const p = pattern.split('/'), q = pathname.split('/');
  if (p.length !== q.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].charAt(0) === ':') params[p[i].slice(1)] = decodeURIComponent(q[i]);
    else if (p[i] !== q[i]) return null;
  }
  return params;
}

const ROUTES = [];
function route(method, pattern, fn, opts) { ROUTES.push({ method: method, pattern: pattern, fn: fn, opts: opts || {} }); }

/* ---------------------------- public ---------------------------- */

route('GET', '/api/health', async function (req, res) {
  const c = cfg();
  json(res, 200, {
    ok: true,
    database: DB_READY() ? 'configured' : 'missing',
    chapa: !!c.chapaKey,
    telebirr: !!c.telebirr,
    cbe: !!c.cbe,
    storage: (c.supabaseUrl && c.supabaseKey) ? 'supabase' : (c.blobToken ? 'vercel-blob' : 'none'),
    push: !!vapidKeyPair(),
    creator_panel: !!c.creatorPath,
    portfolio_link: !!c.portfolio,
    version: '1.0.0'
  });
});

route('GET', '/api/bootstrap', async function (req, res) {
  const settings = await getSettings();
  const c = cfg();
  const out = {
    settings: publicSettings(settings),
    games: [], faqs: [], gallery: [], reviews: [], events: [], blockedDates: [],
    paymentMethods: paymentMethods(),
    db: DB_READY(),
    siteUrl: c.siteUrl || ('https://' + (req.headers.host || '')),
    portfolio: c.portfolio || '',
    qr: settings.qr_service || ''
  };
  if (DB_READY()) {
    try {
      out.games = await db.all('games', 'select=*&visible=eq.true&order=sort_order.asc');
      out.faqs = await db.all('faqs', 'select=*&visible=eq.true&order=sort_order.asc');
      out.gallery = await db.all('gallery', 'select=*&visible=eq.true&order=sort_order.asc');
      out.reviews = await db.all('reviews', 'select=id,author,rating,body,featured,created_at&status=eq.approved&order=created_at.desc&limit=24');
      out.events = await db.all('events', 'select=*&visible=eq.true&status=eq.published&order=starts_at.asc');
      const bd = await db.all('blocked_dates', 'select=day,reason');
      out.blockedDates = (bd || []).map(function (x) { return x.day; });
    } catch (e) { out.dbError = String(e.message || e); }
  }
  json(res, 200, out);
});

function publicSettings(s) {
  return {
    brand: s.brand, background: s.background, contact: s.contact, hours: s.hours,
    social: s.social, announcement: s.announcement, features: s.features,
    booking: s.booking, seo: s.seo, legal: s.legal, about: s.about
  };
}
function paymentMethods() {
  const c = cfg();
  const f = [];
  if (c.chapaKey) f.push({ id: 'chapa', label: 'Chapa — card, Telebirr, bank', online: true });
  if (c.telebirr) f.push({ id: 'telebirr', label: 'Telebirr', online: true });
  if (c.cbe) f.push({ id: 'cbe', label: 'CBE bank transfer (owner confirms)', online: false });
  return f;
}

route('GET', '/api/availability', async function (req, res) {
  const u = new URL(req.url, 'http://x');
  const gameId = u.searchParams.get('game');
  const date = u.searchParams.get('date');
  if (!DB_READY()) return json(res, 200, { slots: [], degraded: true });
  if (!gameId || !date) return json(res, 400, { error: 'game and date are required' });
  const settings = await getSettings();
  if (isClosedDay(settings, date)) return json(res, 200, { closed: true, slots: [] });
  const game = (await db.all('games', 'select=*&id=eq.' + encodeURIComponent(gameId) + '&limit=1'))[0];
  if (!game) return json(res, 404, { error: 'Game not found' });
  const slots = slotsForDay(settings, date);
  const rows = await db.all('bookings', 'select=slot_start,blocks,people&slot_date=eq.' + date + '&game_id=eq.' + game.id + '&status=in.(pending,paid)');
  const cap = num(game.capacity, 1);
  const out = slots.map(function (s) {
    const idx = slotIndex(s);
    let used = 0;
    (rows || []).forEach(function (b) {
      const bi = slotIndex(b.slot_start);
      if (idx >= bi && idx < bi + num(b.blocks, 1)) used += num(b.people, 1);
    });
    return { slot: s, used: used, capacity: cap, left: Math.max(0, cap - used) };
  });
  json(res, 200, { slots: out, capacity: cap, maxPeople: num((settings.booking || {}).maxPeople, 20) });
});

route('POST', '/api/promo/check', async function (req, res) {
  const ip = clientIp(req);
  const rl = await rateLimit('promo:' + ip, 30, 3600);
  if (!rl.ok) return json(res, 429, { error: 'Too many attempts. Try again later.' });
  const b = await readJSON(req);
  if (!DB_READY()) return json(res, 200, { ok: false, reason: 'Promo system is not configured yet.' });
  const promo = await promoContext(b.code || '');
  if (!promo) return json(res, 200, { ok: false, reason: 'Promo code not found.' });
  const settings = await getSettings();
  const d = await promoDiscount(promo, {
    subtotal: num(b.subtotal), phone: b.phone || '', gameId: b.gameId || '', date: b.date || dayKey(new Date()),
    slot: b.slot || '00:00', blocks: num(b.blocks, 1), settings: settings
  });
  json(res, 200, d);
});

route('POST', '/api/bookings', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Booking is not available yet: the database is not configured.' });
  const ip = clientIp(req);
  const rl = await rateLimit('book:' + ip, 12, 3600);
  if (!rl.ok) return json(res, 429, { error: 'Too many booking attempts from this network. Please call us.' });
  const b = await readJSON(req);
  const settings = await getSettings();
  if (!(settings.features || {}).booking) return json(res, 403, { error: 'Booking is switched off right now.' });
  const honeypot = b.website;
  if (honeypot) return json(res, 400, { error: 'Bot detected.' });

  const gameId = String(b.gameId || '');
  const people = clampInt(b.people, 1, num((settings.booking || {}).maxPeople, 20), 1);
  const blocks = clampInt(b.blocks, 1, 16, 1);
  const date = String(b.date || '');
  const start = String(b.slot || '');
  const name = String(b.name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').trim().slice(0, 25);
  if (!gameId || !date || !start || !name || !phone) return json(res, 400, { error: 'Please fill game, date, time, name and phone.' });
  if (!/^[0-9+ ]{7,20}$/.test(phone)) return json(res, 400, { error: 'Please enter a valid phone number.' });
  if (date < dayKey(new Date()) || date > dayKey(new Date(Date.now() + num((settings.booking || {}).maxDaysAhead, 30) * 86400000))) {
    return json(res, 400, { error: 'That date is outside the booking window.' });
  }

  const game = (await db.all('games', 'select=*&id=eq.' + encodeURIComponent(gameId) + '&limit=1'))[0];
  if (!game || !game.visible) return json(res, 404, { error: 'Game not found' });
  const price = priceLine(game, b.variant, people, blocks);
  if (!price) return json(res, 400, { error: 'This game has no price yet — please ask at the zone.' });

  const blocked = await db.count('blocked_dates', 'day=eq.' + date);
  if (blocked > 0) return json(res, 400, { error: 'That date is closed.' });
  const cap = await checkCapacity(settings, game, date, start, blocks, people, null);
  if (!cap.ok) return json(res, 409, { error: cap.reason });

  let discount = 0, promoCode = null, promoNote = '';
  if (b.promo) {
    const promo = await promoContext(b.promo);
    const d = await promoDiscount(promo, { subtotal: price.subtotal, phone: phone, gameId: game.id, date: date, slot: start, blocks: blocks, settings: settings });
    if (d.ok) { discount = d.discount; promoCode = promo.code; promoNote = d.message || ''; }
    else return json(res, 400, { error: d.reason });
  }
  const total = Math.max(0, Math.round((price.subtotal - discount) * 100) / 100);

  // final capacity re-check (double-booking prevention under race)
  const cap2 = await checkCapacity(settings, game, date, start, blocks, people, null);
  if (!cap2.ok) return json(res, 409, { error: 'That slot was just taken. Please pick another time.' });

  let code = code6();
  for (let i = 0; i < 5; i++) {
    const clash = await db.count('bookings', 'code=eq.' + code);
    if (clash === 0) break;
    code = code6();
  }

  const row = {
    code: code, game_id: game.id, game_name: game.name, variant: price.variant || '',
    slot_date: date, slot_start: start, slot_minutes: 30, blocks: blocks, people: people,
    name: name, phone: phone, promo_code: promoCode,
    unit_price: price.unit, unit_label: price.unitLabel,
    subtotal: price.subtotal, discount: discount, total: total,
    status: total === 0 ? 'paid' : 'pending'
  };
  const created = (await db.insert('bookings', [row]))[0];
  if (total === 0) {
    await db.insert('payments', [{ booking_id: created.id, booking_code: code, method: 'none', amount: 0, status: 'paid', reference: promoCode || 'free', confirmed_by: 'free' }]);
  }
  await audit('customer', 'public', 'booking.created', code, { game: game.name, total: total }, req);
  notifyAdmins({ title: 'New booking ' + code, body: game.name + ' — ' + date + ' ' + start + ' — ' + money(total) + ' ETB', url: '/admin' });
  json(res, 201, { booking: created, free: total === 0, methods: paymentMethods() });
});

route('POST', '/api/bookings/lookup', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const rl = await rateLimit('lookup:' + clientIp(req), 30, 3600);
  if (!rl.ok) return json(res, 429, { error: 'Too many lookups. Try later.' });
  const b = await readJSON(req);
  const code = String(b.code || '').toUpperCase();
  const phone = String(b.phone || '');
  if (!code || !phone) return json(res, 400, { error: 'Booking code and phone are required.' });
  const rows = await db.all('bookings', 'select=*&code=eq.' + encodeURIComponent(code) + '&phone=eq.' + encodeURIComponent(phone) + '&limit=1');
  if (!rows.length) return json(res, 404, { error: 'No booking matches that code and phone number.' });
  const pay = await db.all('payments', 'select=method,status,amount,reference&booking_code=eq.' + encodeURIComponent(code) + '&order=created_at.desc');
  json(res, 200, { booking: rows[0], payments: pay, methods: paymentMethods() });
});

route('POST', '/api/bookings/cancel', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const b = await readJSON(req);
  const code = String(b.code || '').toUpperCase();
  const phone = String(b.phone || '');
  const rows = await db.all('bookings', 'select=*&code=eq.' + encodeURIComponent(code) + '&phone=eq.' + encodeURIComponent(phone) + '&limit=1');
  if (!rows.length) return json(res, 404, { error: 'Booking not found.' });
  const bk = rows[0];
  if (bk.status === 'paid') return json(res, 400, { error: 'Paid bookings must be cancelled by the zone. Please call us.' });
  if (bk.status === 'cancelled') return json(res, 200, { booking: bk });
  const upd = (await db.update('bookings', 'id=eq.' + bk.id, { status: 'cancelled', updated_at: nowISO() }))[0];
  await audit('customer', 'public', 'booking.cancelled', code, {}, req);
  json(res, 200, { booking: upd });
});

route('POST', '/api/bookings/reschedule', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const b = await readJSON(req);
  const settings = await getSettings();
  const code = String(b.code || '').toUpperCase();
  const phone = String(b.phone || '');
  const rows = await db.all('bookings', 'select=*&code=eq.' + encodeURIComponent(code) + '&phone=eq.' + encodeURIComponent(phone) + '&limit=1');
  if (!rows.length) return json(res, 404, { error: 'Booking not found.' });
  const bk = rows[0];
  if (bk.status === 'paid') return json(res, 400, { error: 'Paid bookings must be moved by the zone. Please call us.' });
  const game = (await db.all('games', 'select=*&id=eq.' + bk.game_id + '&limit=1'))[0];
  if (!game) return json(res, 404, { error: 'Game not found.' });
  const cap = await checkCapacity(settings, game, String(b.date), String(b.slot), num(bk.blocks, 1), num(bk.people, 1), bk.id);
  if (!cap.ok) return json(res, 409, { error: cap.reason });
  // price is LOCKED: we only move the time, never the money.
  const upd = (await db.update('bookings', 'id=eq.' + bk.id, { slot_date: String(b.date), slot_start: String(b.slot), updated_at: nowISO() }))[0];
  await audit('customer', 'public', 'booking.rescheduled', code, { to: b.date + ' ' + b.slot }, req);
  json(res, 200, { booking: upd, priceLocked: true });
});

route('POST', '/api/reviews', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const rl = await rateLimit('review:' + clientIp(req), 5, 86400);
  if (!rl.ok) return json(res, 429, { error: 'Too many reviews from this network.' });
  const b = await readJSON(req);
  if (b.website) return json(res, 400, { error: 'Bot detected.' });
  const author = String(b.author || '').trim().slice(0, 60);
  const body = String(b.body || '').trim().slice(0, 1200);
  if (!author || !body) return json(res, 400, { error: 'Please add your name and a short review.' });
  const row = (await db.insert('reviews', [{ author: author, rating: clampInt(b.rating, 1, 5, 5), body: body, status: 'pending' }]))[0];
  await audit('customer', 'public', 'review.submitted', row.id, {}, req);
  notifyAdmins({ title: 'New review waiting', body: author + ': ' + body.slice(0, 80), url: '/admin' });
  json(res, 201, { ok: true, review: row });
});

route('POST', '/api/events/:id/register', async function (req, res, params) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const rl = await rateLimit('event:' + clientIp(req), 10, 3600);
  if (!rl.ok) return json(res, 429, { error: 'Too many registrations.' });
  const b = await readJSON(req);
  if (b.website) return json(res, 400, { error: 'Bot detected.' });
  const ev = (await db.all('events', 'select=*&id=eq.' + encodeURIComponent(params.id) + '&limit=1'))[0];
  if (!ev || !ev.registration_open) return json(res, 403, { error: 'Registration is closed.' });
  const name = String(b.name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').trim().slice(0, 25);
  if (!name || !phone) return json(res, 400, { error: 'Name and phone are required.' });
  if (ev.capacity) {
    const c = await db.count('event_registrations', 'event_id=eq.' + ev.id + '&status=neq.cancelled');
    if (c >= num(ev.capacity)) return json(res, 409, { error: 'This tournament is full.' });
  }
  const row = (await db.insert('event_registrations', [{ event_id: ev.id, name: name, phone: phone, team_name: String(b.team || '').slice(0, 60) }]))[0];
  notifyAdmins({ title: 'Tournament registration', body: name + ' -> ' + ev.title, url: '/admin' });
  json(res, 201, { ok: true, registration: row });
});

/* ---------------------------- payments ---------------------------- */

route('POST', '/api/payments/chapa/init', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const c = cfg();
  if (!c.chapaKey) return json(res, 400, { error: 'Chapa is not configured.' });
  const b = await readJSON(req);
  const rows = await db.all('bookings', 'select=*&code=eq.' + encodeURIComponent(String(b.code || '').toUpperCase()) + '&limit=1');
  if (!rows.length) return json(res, 404, { error: 'Booking not found.' });
  const bk = rows[0];
  if (bk.status === 'paid') return json(res, 400, { error: 'This booking is already paid.' });
  const settings = await getSettings();
  try {
    const r = await chapaInit(req, bk, settings);
    if (!r.ok) return json(res, 502, { error: r.reason });
    json(res, 200, r);
  } catch (e) { json(res, 502, { error: 'Could not reach Chapa: ' + String(e.message || e) }); }
});

route('POST', '/api/payments/chapa/webhook', async function (req, res) {
  const raw = await readRaw(req);
  const headers = req.headers || {};
  const sig = headers['chapa-signature'] || headers['x-chapa-signature'] || '';
  const okSig = verifyChapaSignature(raw, sig);
  const body = parseJSON(raw, {});
  if (DB_READY()) {
    try { await db.insert('webhook_log', [{ provider: 'chapa', signature_ok: okSig, body: body, headers: { sig: String(sig).slice(0, 80) }, note: okSig ? 'verified' : 'signature missing or invalid' }]); } catch (e) { }
  }
  if (!okSig) return json(res, 401, { error: 'Invalid signature', logged: true });
  const txRef = (body && (body.tx_ref || body.reference || (body.data && body.data.tx_ref))) || '';
  const status = (body && (body.status || (body.data && body.data.status))) || '';
  if (!txRef) return json(res, 400, { error: 'No tx_ref in payload' });
  // Always cross-check with Chapa's verify endpoint — never trust the payload alone.
  const verified = await chapaVerify(txRef);
  const paid = verified && String(verified.status || '').toLowerCase() === 'success';
  if (!DB_READY()) return json(res, 200, { received: true, db: 'missing' });
  const pays = await db.all('payments', 'select=*&reference=eq.' + encodeURIComponent(txRef) + '&limit=1');
  if (pays.length) {
    await db.update('payments', 'id=eq.' + pays[0].id, { status: paid ? 'paid' : 'failed', confirmed_by: 'webhook', raw: { verified: verified || null, webhook: body }, updated_at: nowISO() });
    if (paid) await markBookingPaid(pays[0].booking_id, pays[0].booking_code);
  }
  json(res, 200, { received: true, paid: !!paid });
});

async function markBookingPaid(bookingId, code) {
  try {
    const bk = (await db.all('bookings', 'select=*&id=eq.' + bookingId + '&limit=1'))[0];
    if (!bk) return;
    if (bk.status !== 'paid') {
      await db.update('bookings', 'id=eq.' + bookingId, { status: 'paid', updated_at: nowISO() });
      await audit('system', 'system', 'booking.paid', code || bk.code, { total: bk.total }, { headers: {} });
      notifyAdmins({ title: 'Payment confirmed ' + (code || bk.code), body: money(bk.total) + ' ETB received.', url: '/admin' });
    }
  } catch (e) { }
}

route('POST', '/api/payments/telebirr/init', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const c = cfg();
  if (!c.telebirr) return json(res, 400, { error: 'Telebirr is not configured. It needs an approved merchant account.' });
  const b = await readJSON(req);
  const rows = await db.all('bookings', 'select=*&code=eq.' + encodeURIComponent(String(b.code || '').toUpperCase()) + '&limit=1');
  if (!rows.length) return json(res, 404, { error: 'Booking not found.' });
  try {
    const r = await telebirrInit(rows[0], await getSettings());
    if (!r.ok) return json(res, 502, { error: r.reason });
    json(res, 200, r);
  } catch (e) { json(res, 502, { error: 'Telebirr error: ' + String(e.message || e) }); }
});

route('POST', '/api/payments/telebirr/notify', async function (req, res) {
  const raw = await readRaw(req);
  const body = parseJSON(raw, {});
  if (DB_READY()) { try { await db.insert('webhook_log', [{ provider: 'telebirr', signature_ok: null, body: body, headers: {}, note: 'notify received — verify against Telebirr query API before trusting' }]); } catch (e) { } }
  json(res, 200, { code: 0, msg: 'success' });
});

route('POST', '/api/payments/manual', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const b = await readJSON(req);
  const code = String(b.code || '').toUpperCase();
  const reference = String(b.reference || '').trim().slice(0, 80);
  const method = (b.method === 'cbe') ? 'cbe' : 'cbe';
  if (!code || !reference) return json(res, 400, { error: 'Booking code and transaction reference are required.' });
  const rows = await db.all('bookings', 'select=*&code=eq.' + encodeURIComponent(code) + '&limit=1');
  if (!rows.length) return json(res, 404, { error: 'Booking not found.' });
  const settings = await getSettings();
  let screenshot = '';
  if (b.screenshot && typeof b.screenshot === 'string' && b.screenshot.indexOf('data:') === 0) {
    const m = b.screenshot.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      try { screenshot = await uploadObject('receipt-' + code + '.jpg', Buffer.from(m[2], 'base64'), m[1]); } catch (e) { screenshot = ''; }
    }
  }
  await db.insert('payments', [{
    booking_id: rows[0].id, booking_code: code, method: method, amount: rows[0].total, currency: 'ETB',
    status: 'pending', reference: reference, raw: { screenshot: screenshot, note: 'owner must confirm' }
  }]);
  notifyAdmins({ title: 'Bank transfer to confirm', body: code + ' — ref ' + reference, url: '/admin' });
  audit('customer', 'public', 'payment.manual_submitted', code, { reference: reference }, req);
  json(res, 201, { ok: true, pending: true, message: 'We will confirm your transfer shortly. Your booking code is ' + code + '.' });
});

/* ---------------------------- auth ---------------------------- */

route('POST', '/api/auth/login', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Admin login needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });
  const rl = await rateLimit('login:' + clientIp(req), 10, 900);
  if (!rl.ok) return json(res, 429, { error: 'Too many attempts. Please wait 15 minutes.' });
  const b = await readJSON(req);
  const username = String(b.username || '').trim().toLowerCase();
  const pw = String(b.password || '');
  const rows = await db.all('admins', 'select=*&username=eq.' + encodeURIComponent(username) + '&limit=1');
  const a = rows[0];
  await audit(username || '?', 'anon', 'auth.login_attempt', username, { ok: false }, req);
  if (!a || !a.active || !verifyPassword(pw, a.password_hash)) return json(res, 401, { error: 'Wrong username or password.' });
  const keys = await db.count('passkeys', 'admin_id=eq.' + a.id);
  if (keys > 0 && !b.recovery) {
    // passkey exists -> password login disabled unless a recovery code is supplied
    return json(res, 403, { error: 'This account uses a passkey. Use your device passkey, or sign in with a recovery code.', passkey_only: true });
  }
  const token = await createSession(a.id, 'admin', req);
  await db.update('admins', 'id=eq.' + a.id, { last_login: nowISO() });
  await audit(a.username, a.role, 'auth.login', a.username, { method: b.recovery ? 'recovery+password' : 'password' }, req);
  notifyAdmins({ title: 'New admin login', body: a.username + ' from ' + clientIp(req), url: '/admin' });
  json(res, 200, {
    ok: true, admin: { id: a.id, username: a.username, role: a.role, display_name: a.display_name, must_change_password: !!a.must_change_password }
  }, { 'Set-Cookie': cookieHeader('natof_session', token, SESSION_HOURS_ADMIN * 3600, isSecureReq(req)) });
});

route('POST', '/api/auth/logout', async function (req, res) {
  const s = await getSession(req);
  if (s && s.sessionId) { try { await db.update('admin_sessions', 'id=eq.' + s.sessionId, { revoked: true }); } catch (e) { } }
  json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('natof_session', '', 0, isSecureReq(req)) });
});

route('GET', '/api/auth/me', async function (req, res) {
  const s = await getSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const out = { admin: { id: s.adminId, username: s.username, role: s.role, display_name: s.display_name, must_change_password: !!s.must_change_password }, scope: s.scope };
  if (s.adminId && s.scope === 'admin') {
    try { out.passkeys = await db.all('passkeys', 'select=id,label,created_at,last_used&admin_id=eq.' + s.adminId); } catch (e) { out.passkeys = []; }
  }
  json(res, 200, out);
});

route('POST', '/api/auth/password', async function (req, res) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  const a = (await db.all('admins', 'select=*&id=eq.' + s.adminId + '&limit=1'))[0];
  if (!verifyPassword(String(b.current || ''), a.password_hash)) return json(res, 403, { error: 'Current password is wrong.' });
  const next = String(b.next || '');
  if (next.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters.' });
  await db.update('admins', 'id=eq.' + s.adminId, { password_hash: hashPassword(next), must_change_password: false });
  await db.update('admin_sessions', 'admin_id=eq.' + s.adminId + '&id=neq.' + s.sessionId, { revoked: true });
  await audit(s.username, s.role, 'auth.password_changed', s.username, {}, req);
  notifyAdmins({ title: 'Password changed', body: s.username, url: '/admin' });
  json(res, 200, { ok: true, message: 'Password changed. Other sessions were signed out.' });
});

/* ---------------------------- passkeys ---------------------------- */

const CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000;

route('POST', '/api/auth/passkey/register/begin', async function (req, res) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
  const challenge = webAuthnChallenge();
  const token = signToken('wa:' + s.adminId + ':' + challenge + ':' + Date.now());
  const existing = await db.all('passkeys', 'select=credential_id&admin_id=eq.' + s.adminId);
  json(res, 200, {
    challenge: challenge, token: token,
    rp: { id: new URL(cfg().siteUrl || ('https://' + req.headers.host)).hostname, name: 'NATOF GameZone' },
    user: { id: b64u(Buffer.from(s.adminId)), name: s.username, displayName: s.display_name || s.username },
    excludeCredentials: (existing || []).map(function (p) { return { id: p.credential_id, type: 'public-key' } }),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { userVerification: 'preferred', residentKey: 'preferred' },
    timeout: 60000
  });
});

route('POST', '/api/auth/passkey/register/finish', async function (req, res) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  const inner = verifyToken(b.token || '');
  if (!inner) return json(res, 400, { error: 'Challenge expired. Try again.' });
  const parts = inner.split(':');
  const challenge = parts[2];
  if (Date.now() - num(parts[3]) > CHALLENGE_MAX_AGE_MS) return json(res, 400, { error: 'Challenge expired. Try again.' });
  const host = new URL(cfg().siteUrl || ('https://' + req.headers.host));
  try {
    const r = await verifyRegistration(s.adminId, host.hostname, b.origin || (host.protocol + '//' + host.host), b, challenge);
    const clash = await db.count('passkeys', 'credential_id=eq.' + encodeURIComponent(r.credentialId));
    if (clash) return json(res, 409, { error: 'This device is already registered.' });
    await db.insert('passkeys', [{ admin_id: s.adminId, credential_id: r.credentialId, public_key: JSON.stringify(r.jwk), alg: r.alg, label: String(b.label || 'device').slice(0, 40), counter: r.counter }]);
    await audit(s.username, s.role, 'passkey.registered', s.username, {}, req);
    notifyAdmins({ title: 'Passkey added', body: s.username + ' registered a new device', url: '/admin' });
    json(res, 201, { ok: true });
  } catch (e) { json(res, 400, { error: 'Passkey registration failed: ' + String(e.message || e) }); }
});

route('POST', '/api/auth/passkey/login/begin', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const b = await readJSON(req);
  const username = String(b.username || '').trim().toLowerCase();
  const rl = await rateLimit('pklogin:' + clientIp(req), 20, 900);
  if (!rl.ok) return json(res, 429, { error: 'Too many attempts.' });
  const a = (await db.all('admins', 'select=id,username&username=eq.' + encodeURIComponent(username) + '&limit=1'))[0];
  const challenge = webAuthnChallenge();
  const token = signToken('wl:' + (a ? a.id : 'none') + ':' + challenge + ':' + Date.now());
  const creds = a ? await db.all('passkeys', 'select=credential_id&admin_id=eq.' + a.id) : [];
  json(res, 200, {
    challenge: challenge, token: token, username: username,
    allowCredentials: (creds || []).map(function (p) { return { id: p.credential_id, type: 'public-key' }; }),
    rpId: new URL(cfg().siteUrl || ('https://' + req.headers.host)).hostname,
    timeout: 60000, userVerification: 'preferred'
  });
});

route('POST', '/api/auth/passkey/login/finish', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const b = await readJSON(req);
  const inner = verifyToken(b.token || '');
  if (!inner) return json(res, 400, { error: 'Challenge expired.' });
  const parts = inner.split(':');
  const adminId = parts[1], challenge = parts[2];
  if (adminId === 'none') return json(res, 401, { error: 'No passkey for that account.' });
  if (Date.now() - num(parts[3]) > CHALLENGE_MAX_AGE_MS) return json(res, 400, { error: 'Challenge expired.' });
  const pk = (await db.all('passkeys', 'select=*&credential_id=eq.' + encodeURIComponent(String(b.credentialId || '')) + '&limit=1'))[0];
  if (!pk || pk.admin_id !== adminId) return json(res, 401, { error: 'Unknown device.' });
  const host = new URL(cfg().siteUrl || ('https://' + req.headers.host));
  try {
    const r = await verifyAssertion(host.hostname, b.origin || (host.protocol + '//' + host.host), b, challenge, parseJSON(pk.public_key, {}), pk.alg, num(pk.counter));
    await db.update('passkeys', 'id=eq.' + pk.id, { counter: r.counter, last_used: nowISO() });
    const a = (await db.all('admins', 'select=*&id=eq.' + adminId + '&limit=1'))[0];
    if (!a || !a.active) return json(res, 401, { error: 'Account disabled.' });
    const token = await createSession(a.id, 'admin', req);
    await db.update('admins', 'id=eq.' + a.id, { last_login: nowISO() });
    await audit(a.username, a.role, 'auth.login', a.username, { method: 'passkey' }, req);
    notifyAdmins({ title: 'New admin login (passkey)', body: a.username + ' from ' + clientIp(req), url: '/admin' });
    json(res, 200, { ok: true, admin: { id: a.id, username: a.username, role: a.role, display_name: a.display_name } }, { 'Set-Cookie': cookieHeader('natof_session', token, SESSION_HOURS_ADMIN * 3600, isSecureReq(req)) });
  } catch (e) { json(res, 401, { error: 'Passkey check failed: ' + String(e.message || e) }); }
});

route('POST', '/api/auth/recovery', async function (req, res) {
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured.' });
  const rl = await rateLimit('recover:' + clientIp(req), 8, 900);
  if (!rl.ok) return json(res, 429, { error: 'Too many attempts.' });
  const b = await readJSON(req);
  const username = String(b.username || '').trim().toLowerCase();
  const code = String(b.code || '').trim().toUpperCase();
  const a = (await db.all('admins', 'select=*&username=eq.' + encodeURIComponent(username) + '&limit=1'))[0];
  if (!a) return json(res, 401, { error: 'Invalid recovery code.' });
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const rc = (await db.all('recovery_codes', 'select=*&admin_id=eq.' + a.id + '&used=eq.false&limit=50')).filter(function (x) { return safeEqual(x.code_hash, hash); })[0];
  if (!rc) { await audit(username, 'anon', 'auth.recovery_failed', username, {}, req); return json(res, 401, { error: 'Invalid recovery code.' }); }
  await db.update('recovery_codes', 'id=eq.' + rc.id, { used: true });
  const newPw = uid(6);
  await db.update('admins', 'id=eq.' + a.id, { password_hash: hashPassword(newPw), must_change_password: true });
  await revokeAll(a.id);
  await audit(a.username, a.role, 'auth.recovery_used', a.username, {}, req);
  json(res, 200, { ok: true, temporary_password: newPw, message: 'Use this temporary password once, then set your own.' });
});

/* ---------------------------- push ---------------------------- */

route('GET', '/api/push/key', async function (req, res) {
  const kp = vapidKeyPair();
  json(res, 200, { key: kp ? kp.publicB64 : null, enabled: !!kp });
});

route('POST', '/api/push/subscribe', async function (req, res) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  if (!b.subscription || !b.subscription.endpoint) return json(res, 400, { error: 'subscription required' });
  try {
    const existing = await db.all('push_subs', 'select=id&endpoint=eq.' + encodeURIComponent(b.subscription.endpoint) + '&limit=1');
    if (existing.length) await db.update('push_subs', 'id=eq.' + existing[0].id, { keys: b.subscription.keys, admin_id: s.adminId });
    else await db.insert('push_subs', [{ admin_id: s.adminId, endpoint: b.subscription.endpoint, keys: b.subscription.keys }]);
    json(res, 201, { ok: true });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

/* ---------------------------- admin panel API ---------------------------- */

async function requireAdmin(req, res, minRole) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin') { json(res, 401, { error: 'Not signed in' }); return null; }
  if (minRole === 'owner' && s.role !== 'owner') { json(res, 403, { error: 'Owner access required.' }); return null; }
  return s;
}

route('GET', '/api/admin/meta', async function (req, res) {
  const s = await requireAdmin(req);
  if (!s) return;
  const meta = {};
  Object.keys(ENTITIES).forEach(function (k) {
    if (ENTITIES[k].ownerOnly && s.role !== 'owner') return;
    meta[k] = { label: ENTITIES[k].label, fields: ENTITIES[k].fields, reorder: !!ENTITIES[k].reorder, ownerOnly: !!ENTITIES[k].ownerOnly };
  });
  const settings = await getSettings();
  json(res, 200, {
    meta: meta, settings: settings, role: s.role,
    providers: { chapa: !!cfg().chapaKey, telebirr: !!cfg().telebirr, cbe: !!cfg().cbe, push: !!vapidKeyPair(), storage: !!(cfg().supabaseUrl || cfg().blobToken) },
    games: await db.all('games', 'select=id,name&order=sort_order.asc'),
    creatorPath: null
  });
});

route('GET', '/api/admin/stats', async function (req, res) {
  const s = await requireAdmin(req);
  if (!s) return;
  const days = clampInt(new URL(req.url, 'http://x').searchParams.get('days'), 1, 365, 30);
  const from = dayKey(new Date(Date.now() - days * 86400000));
  const out = { days: days, from: from };
  try {
    if (s.role === 'owner') {
      const pays = await db.all('payments', 'select=amount,status,method,created_at&status=eq.paid&created_at=gte.' + from + 'T00:00:00Z&order=created_at.asc');
      const byDay = {}, byMethod = {};
      let total = 0;
      (pays || []).forEach(function (p) {
        const d = String(p.created_at).slice(0, 10);
        byDay[d] = (byDay[d] || 0) + num(p.amount);
        byMethod[p.method || 'none'] = (byMethod[p.method || 'none'] || 0) + num(p.amount);
        total += num(p.amount);
      });
      out.revenue = { total: Math.round(total * 100) / 100, byDay: byDay, byMethod: byMethod };
    }
    const bookings = await db.all('bookings', 'select=status,total,promo_code,created_at&created_at=gte.' + from + 'T00:00:00Z');
    out.bookings = { total: (bookings || []).length };
    const st = {}, promoUse = {};
    (bookings || []).forEach(function (b) {
      st[b.status] = (st[b.status] || 0) + 1;
      if (b.promo_code) promoUse[b.promo_code] = (promoUse[b.promo_code] || 0) + 1;
    });
    out.bookings.byStatus = st;
    out.bookings.promoUse = promoUse;
    out.counts = {
      pendingReviews: await db.count('reviews', 'status=eq.pending'),
      events: await db.count('events', 'select=id'),
      games: await db.count('games', 'select=id')
    };
    out.recent = await db.all('bookings', 'select=code,game_name,slot_date,slot_start,people,total,status,created_at&order=created_at.desc&limit=10');
  } catch (e) { out.error = String(e.message || e); }
  json(res, 200, out);
});

function listQueryFor(name, qs) {
  const e = ENTITIES[name];
  let q = 'select=*';
  const search = qs.get('search');
  if (search) {
    const s = search.replace(/[%,()]/g, '').slice(0, 40);
    if (name === 'bookings') q += '&or=(code.ilike.*' + s + '*,name.ilike.*' + s + '*,phone.ilike.*' + s + '*)';
    else if (name === 'games') q += '&name.ilike.*' + s + '*';
    else if (name === 'promos') q += '&code.ilike.*' + s + '*';
    else if (name === 'reviews') q += '&or=(author.ilike.*' + s + '*,body.ilike.*' + s + '*)';
    else q += '&or=(title.ilike.*' + s + '*,name.ilike.*' + s + '*)';
  }
  const status = qs.get('status');
  if (status && ENTITIES[name].fields.filter(function (f) { return f.k === 'status'; }).length) q += '&status=eq.' + encodeURIComponent(status);
  const from = qs.get('from'); if (from) q += '&' + (name === 'payments' ? 'created_at' : 'created_at') + '=gte.' + encodeURIComponent(from) + 'T00:00:00Z';
  const to = qs.get('to'); if (to) q += '&created_at=lte.' + encodeURIComponent(to) + 'T23:59:59Z';
  if (name === 'bookings') { const d = qs.get('date'); if (d) q += '&slot_date=eq.' + encodeURIComponent(d); }
  q += '&order=' + e.order;
  const limit = clampInt(qs.get('limit'), 1, 200, 25);
  const page = clampInt(qs.get('page'), 1, 10000, 1);
  q += '&limit=' + limit + '&offset=' + ((page - 1) * limit);
  return q;
}

route('GET', '/api/admin/:entity', async function (req, res, params) {
  const name = params.entity;
  if (!ENTITIES[name]) return json(res, 404, { error: 'Unknown list' });
  const s = await requireAdmin(req);
  if (!s) return;
  if (ENTITIES[name].ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner access required.' });
  const qs = new URL(req.url, 'http://x').searchParams;
  try {
    let rows = await db.all(ENTITIES[name].table, listQueryFor(name, qs));
    if (s.role === 'staff' && name === 'bookings') {
      rows = (rows || []).map(function (r) {
        const o = Object.assign({}, r); delete o.total; delete o.subtotal; delete o.discount; delete o.unit_price; return o;
      });
    }
    json(res, 200, { rows: rows || [], page: clampInt(qs.get('page'), 1, 10000, 1) });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

route('POST', '/api/admin/:entity', async function (req, res, params) {
  const name = params.entity;
  if (!ENTITIES[name]) return json(res, 404, { error: 'Unknown list' });
  const s = await requireAdmin(req);
  if (!s) return;
  if (ENTITIES[name].ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner access required.' });
  const body = await readJSON(req);
  const row = sanitizeRow(name, body);
  if (Object.keys(row).length === 0) return json(res, 400, { error: 'Nothing to save.' });
  try {
    if (name === 'games' && (row.sort_order === undefined || row.sort_order === null)) {
      const c = await db.count('games', 'select=id'); row.sort_order = c + 1;
    }
    const created = (await db.insert(ENTITIES[name].table, [row]))[0];
    await audit(s.username, s.role, name + '.create', created.id, row, req);
    json(res, 201, { row: created });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('PATCH', '/api/admin/:entity/:id', async function (req, res, params) {
  const name = params.entity;
  if (!ENTITIES[name]) return json(res, 404, { error: 'Unknown list' });
  const s = await requireAdmin(req);
  if (!s) return;
  if (ENTITIES[name].ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner access required.' });
  const body = await readJSON(req);
  const row = sanitizeRow(name, body);
  if (!Object.keys(row).length) return json(res, 400, { error: 'Nothing to save.' });
  try {
    const upd = (await db.update(ENTITIES[name].table, 'id=eq.' + encodeURIComponent(params.id), row))[0];
    await audit(s.username, s.role, name + '.update', params.id, row, req);
    json(res, 200, { row: upd });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('DELETE', '/api/admin/:entity/:id', async function (req, res, params) {
  const name = params.entity;
  if (!ENTITIES[name]) return json(res, 404, { error: 'Unknown list' });
  const s = await requireAdmin(req);
  if (!s) return;
  if (ENTITIES[name].ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner access required.' });
  try {
    await db.remove(ENTITIES[name].table, 'id=eq.' + encodeURIComponent(params.id));
    await audit(s.username, s.role, name + '.delete', params.id, {}, req);
    json(res, 200, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('PATCH', '/api/admin/reorder/:entity', async function (req, res, params) {
  const name = params.entity;
  if (!ENTITIES[name] || !ENTITIES[name].reorder) return json(res, 404, { error: 'Unknown list' });
  const s = await requireAdmin(req);
  if (!s) return;
  const body = await readJSON(req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  try {
    for (let i = 0; i < ids.length; i++) await db.update(ENTITIES[name].table, 'id=eq.' + encodeURIComponent(ids[i]), { sort_order: i + 1 });
    await audit(s.username, s.role, name + '.reorder', '', { ids: ids.length }, req);
    json(res, 200, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('PUT', '/api/admin/settings', async function (req, res) {
  const s = await requireAdmin(req);
  if (!s) return;
  const body = await readJSON(req);
  try {
    const next = await saveSettings(body);
    await audit(s.username, s.role, 'settings.update', 'site', { keys: Object.keys(body) }, req);
    json(res, 200, { settings: next });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/admin/upload', async function (req, res) {
  const s = await requireAdmin(req);
  if (!s) return;
  const b = await readJSON(req);
  if (!b.data || String(b.data).indexOf('data:') !== 0) return json(res, 400, { error: 'Expected a data: URL.' });
  const m = String(b.data).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return json(res, 400, { error: 'Bad image data.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return json(res, 413, { error: 'Image too large after compression (max 6 MB).' });
  try {
    const url = await uploadObject(b.name || 'photo.jpg', buf, m[1]);
    json(res, 201, { url: url, size: buf.length });
  } catch (e) {
    if (String(e.message) === 'NO_STORAGE_CONFIGURED') {
      return json(res, 503, { error: 'No photo storage configured. Add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (recommended) or BLOB_READ_WRITE_TOKEN.' });
    }
    json(res, 500, { error: String(e.message || e) });
  }
});

route('POST', '/api/admin/bookings/:id/confirm-payment', async function (req, res, params) {
  const s = await requireAdmin(req, 'owner');
  if (!s) return;
  const body = await readJSON(req);
  try {
    const bk = (await db.all('bookings', 'select=*&id=eq.' + encodeURIComponent(params.id) + '&limit=1'))[0];
    if (!bk) return json(res, 404, { error: 'Booking not found' });
    if (body.method) {
      await db.insert('payments', [{ booking_id: bk.id, booking_code: bk.code, method: body.method, amount: bk.total, currency: 'ETB', status: 'paid', reference: body.reference || '', confirmed_by: s.username }]);
    } else {
      const p = (await db.all('payments', 'select=*&booking_id=eq.' + bk.id + '&order=created_at.desc&limit=1'))[0];
      if (p) await db.update('payments', 'id=eq.' + p.id, { status: 'paid', confirmed_by: s.username, updated_at: nowISO() });
      else await db.insert('payments', [{ booking_id: bk.id, booking_code: bk.code, method: 'cbe', amount: bk.total, currency: 'ETB', status: 'paid', confirmed_by: s.username }]);
    }
    await markBookingPaid(bk.id, bk.code);
    await audit(s.username, s.role, 'payment.confirmed', bk.code, {}, req);
    json(res, 200, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/admin/payments/:id/refund', async function (req, res, params) {
  const s = await requireAdmin(req, 'owner');
  if (!s) return;
  const body = await readJSON(req);
  try {
    const p = (await db.update('payments', 'id=eq.' + encodeURIComponent(params.id), { status: 'refunded', note: String(body.note || 'marked refunded by ' + s.username) }))[0];
    if (p && p.booking_id) await db.update('bookings', 'id=eq.' + p.booking_id, { status: 'refunded', updated_at: nowISO() });
    await audit(s.username, s.role, 'payment.refunded', p ? p.booking_code : '', { note: body.note || '' }, req);
    json(res, 200, { ok: true, warning: 'This marks the refund in our records only. If the money has already settled, refund it in the Chapa/Telebirr dashboard or by bank transfer.' });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('GET', '/api/admin/export/:entity', async function (req, res, params) {
  const name = params.entity;
  if (!ENTITIES[name]) return json(res, 404, { error: 'Unknown list' });
  const s = await requireAdmin(req);
  if (!s) return;
  if (ENTITIES[name].ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner access required.' });
  const qs = new URL(req.url, 'http://x').searchParams;
  qs.set('limit', '200');
  qs.set('page', '1');
  try {
    const rows = await db.all(ENTITIES[name].table, listQueryFor(name, qs));
    const cols = ENTITIES[name].fields.map(function (f) { return f.k; });
    const lines = [cols.join(',')];
    (rows || []).forEach(function (r) {
      lines.push(cols.map(function (c) {
        const v = r[c] === null || r[c] === undefined ? '' : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]));
        return '"' + v.replace(/"/g, '""') + '"';
      }).join(','));
    });
    text(res, 200, lines.join('\n'), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="' + name + '-' + dayKey(new Date()) + '.csv"' });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

route('GET', '/api/admin/admins', async function (req, res) {
  const s = await requireAdmin(req, 'owner');
  if (!s) return;
  try {
    const rows = await db.all('admins', 'select=id,username,display_name,role,active,must_change_password,last_login,created_at,created_by&order=created_at.asc');
    json(res, 200, { rows: rows || [] });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

route('POST', '/api/admin/admins', async function (req, res) {
  const s = await requireAdmin(req, 'owner');
  if (!s) return;
  const b = await readJSON(req);
  const username = String(b.username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const pw = String(b.password || '');
  const role = b.role === 'owner' ? 'owner' : 'staff';
  if (username.length < 3 || pw.length < 8) return json(res, 400, { error: 'Username min 3 chars, password min 8 chars.' });
  try {
    const row = (await db.insert('admins', [{ username: username, display_name: String(b.display_name || username).slice(0, 60), password_hash: hashPassword(pw), role: role, created_by: s.username, must_change_password: true }]))[0];
    await audit(s.username, s.role, 'admin.created', username, { role: role }, req);
    json(res, 201, { row: { id: row.id, username: row.username, role: row.role } });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('PATCH', '/api/admin/admins/:id', async function (req, res, params) {
  const s = await requireAdmin(req, 'owner');
  if (!s) return;
  const b = await readJSON(req);
  const patch = {};
  if ('active' in b) patch.active = !!b.active;
  if ('role' in b) patch.role = b.role === 'owner' ? 'owner' : 'staff';
  if ('display_name' in b) patch.display_name = String(b.display_name).slice(0, 60);
  if (b.new_password) { patch.password_hash = hashPassword(String(b.new_password)); patch.must_change_password = true; }
  if (!Object.keys(patch).length) return json(res, 400, { error: 'Nothing to change.' });
  try {
    await db.update('admins', 'id=eq.' + encodeURIComponent(params.id), patch);
    if (b.new_password || b.active === false) await revokeAll(params.id);
    await audit(s.username, s.role, 'admin.updated', params.id, { keys: Object.keys(patch) }, req);
    json(res, 200, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

/* ---------------------------- creator panel ---------------------------- */

route('POST', '/api/creator/login', async function (req, res) {
  const c = cfg();
  if (!c.creatorToken) return json(res, 503, { error: 'CREATOR_TOKEN is not set.' });
  if (!DB_READY()) return json(res, 503, { error: 'Supabase is not configured.' });
  const rl = await rateLimit('creator-login:' + clientIp(req), 5, 900);
  if (!rl.ok) return json(res, 429, { error: 'Too many attempts. Slow down and try again in 15 minutes.', retry_after: 900 });
  const b = await readJSON(req);
  if (!safeEqual(String(b.token || ''), c.creatorToken)) {
    await audit('creator', 'anon', 'creator.login_failed', '', { ip: clientIp(req) }, req);
    return json(res, 401, { error: 'Invalid token.' });
  }
  const token = await createSession(null, 'creator', req);
  await audit('creator', 'creator', 'creator.login', '', {}, req);
  json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('natof_session', token, SESSION_HOURS_CREATOR * 3600, isSecureReq(req)) });
});

const CREATOR_TABLES = ['bookings', 'payments', 'promos', 'admins', 'audit_log', 'webhook_log', 'games', 'events', 'event_registrations', 'reviews', 'gallery', 'faqs', 'settings', 'push_subs'];

route('GET', '/api/creator/tables', async function (req, res) {
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const qs = new URL(req.url, 'http://x').searchParams;
  const table = String(qs.get('table') || '');
  if (CREATOR_TABLES.indexOf(table) < 0) return json(res, 400, { error: 'Table not allowed.' });
  const limit = clampInt(qs.get('limit'), 1, 100, 25);
  const page = clampInt(qs.get('page'), 1, 10000, 1);
  let q = 'select=*&limit=' + limit + '&offset=' + ((page - 1) * limit);
  const search = String(qs.get('search') || '').replace(/[%,()*]/g, '').slice(0, 40);
  const col = String(qs.get('col') || '');
  if (search && col && /^[a-z_]{1,32}$/.test(col)) q += '&' + col + '=ilike.*' + search + '*';
  const from = String(qs.get('from') || '');
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) q += '&created_at=gte.' + from + 'T00:00:00Z';
  try {
    const rows = await db.all(table, q);
    if (table === 'admins') {
      (rows || []).forEach(function (r) { delete r.password_hash; });
    }
    const total = await db.count(table, 'select=id');
    json(res, 200, { rows: rows || [], total: total, page: page, limit: limit, columns: (rows && rows[0]) ? Object.keys(rows[0]) : [] });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

route('GET', '/api/creator/system', async function (req, res) {
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const c = cfg();
  let dbStatus = 'missing', counts = {};
  if (DB_READY()) {
    try {
      await db.count('bookings', 'select=id');
      dbStatus = 'ok';
      for (const t of ['bookings', 'payments', 'promos', 'admins', 'audit_log']) {
        try { counts[t] = await db.count(t, 'select=id'); } catch (e) { counts[t] = 'error'; }
      }
    } catch (e) { dbStatus = 'error: ' + String(e.message || e).slice(0, 160); }
  }
  let recentWebhooks = [], recentErrors = [];
  if (DB_READY()) {
    try { recentWebhooks = await db.all('webhook_log', 'select=id,at,provider,signature_ok,note&order=at.desc&limit=20'); } catch (e) { }
  }
  json(res, 200, {
    env: {
      site_url: !!cfg().siteUrl, portfolio: !!cfg().portfolio, supabase: !!cfg().supabaseUrl,
      supabase_key: !!cfg().supabaseKey, storage_bucket: cfg().bucket, blob: !!cfg().blobToken,
      session_secret: !!env('SESSION_SECRET'), creator_token: !!cfg().creatorToken,
      creator_path: !!cfg().creatorPath,
      chapa: !!cfg().chapaKey, chapa_webhook_secret: !!env('CHAPA_WEBHOOK_SECRET'),
      telebirr: !!cfg().telebirr, cbe: !!cfg().cbe,
      vapid: !!vapidKeyPair(), google_verification: !!cfg().googleVerify
    },
    db: { status: dbStatus, counts: counts },
    recentWebhooks: recentWebhooks,
    recentErrors: recentErrors,
    node: process.version,
    now: nowISO()
  });
});

route('PUT', '/api/creator/settings', async function (req, res) {
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const body = await readJSON(req);
  try {
    const next = await saveSettings(body.settings || body);
    await audit('creator', 'creator', 'settings.update', 'site', { keys: Object.keys(body.settings || body) }, req);
    json(res, 200, { settings: next });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/creator/maintenance', async function (req, res) {
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  try {
    await saveSettings({ maintenance: { enabled: !!b.enabled, message: String(b.message || '').slice(0, 400), until: b.until || '' } });
    await audit('creator', 'creator', 'maintenance.' + (b.enabled ? 'on' : 'off'), '', {}, req);
    json(res, 200, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/creator/features', async function (req, res) {
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  try {
    await saveSettings({ features: { booking: !!b.booking, tournaments: !!b.tournaments, payments: !!b.payments, reviews: b.reviews !== false, gallery: b.gallery !== false } });
    await audit('creator', 'creator', 'features.update', '', b, req);
    json(res, 200, { ok: true });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/creator/admins', async function (req, res) {
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  const username = String(b.username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (username.length < 3) return json(res, 400, { error: 'Username too short.' });
  const pw = b.password ? String(b.password) : uid(5);
  try {
    const existing = await db.all('admins', 'select=id&username=eq.' + encodeURIComponent(username) + '&limit=1');
    if (existing.length) {
      await db.update('admins', 'id=eq.' + existing[0].id, { password_hash: hashPassword(pw), must_change_password: true, active: true });
      await revokeAll(existing[0].id);
      await audit('creator', 'creator', 'admin.reset_password', username, {}, req);
      return json(res, 200, { ok: true, username: username, temporary_password: pw, message: 'Password reset. They must change it at next login. All sessions revoked.' });
    }
    const row = (await db.insert('admins', [{ username: username, display_name: String(b.display_name || username).slice(0, 60), password_hash: hashPassword(pw), role: b.role === 'owner' ? 'owner' : (b.role === 'staff' ? 'staff' : 'owner'), created_by: 'creator', must_change_password: true }]))[0];
    await audit('creator', 'creator', 'admin.created', username, { role: row.role }, req);
    json(res, 201, { ok: true, username: username, temporary_password: pw, message: 'Account created. Give this temporary password to the owner; they must change it at first login.' });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/creator/unlock', async function (req, res) {
  // master recovery: unlock any account and force a new password, all sessions revoked
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  const username = String(b.username || '').trim().toLowerCase();
  const pw = uid(5);
  try {
    const a = (await db.all('admins', 'select=id,username,role&username=eq.' + encodeURIComponent(username) + '&limit=1'))[0];
    if (!a) return json(res, 404, { error: 'No such account.' });
    await db.update('admins', 'id=eq.' + a.id, { password_hash: hashPassword(pw), must_change_password: true, active: true });
    await revokeAll(a.id);
    try { await db.remove('recovery_codes', 'admin_id=eq.' + a.id); } catch (e) { }
    await audit('creator', 'creator', 'admin.unlocked', username, {}, req);
    notifyAdmins({ title: 'Account unlocked by creator', body: username, url: '/admin' });
    json(res, 200, { ok: true, username: username, temporary_password: pw, message: 'Account unlocked. Temporary password issued, all sessions revoked, logged in the audit trail.' });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/creator/recovery-codes', async function (req, res) {
  const s = await getCreatorSession(req);
  if (!s) return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  try {
    const a = (await db.all('admins', 'select=id&username=eq.' + encodeURIComponent(String(b.username || '').toLowerCase()) + '&limit=1'))[0];
    if (!a) return json(res, 404, { error: 'No such account.' });
    const codes = await makeRecoveryCodes(a.id, 8);
    await audit('creator', 'creator', 'admin.recovery_codes', b.username, {}, req);
    json(res, 201, { ok: true, codes: codes, message: 'Show these once. They are stored hashed and cannot be shown again.' });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

/* ==================================================================================
   13. PAGE SHELLS
   ================================================================================== */

const CSS = [
':root{',
'  --accent:#ff6a3d; --accent-2:#ffb03a; --accent-ink:#2a0f05;',
'  --bg:#0b0920; --bg-2:#151038; --ink:#f5f4ff; --ink-soft:rgba(245,244,255,.72);',
'  --card:rgba(255,255,255,.07); --card-brd:rgba(255,255,255,.14);',
'  --radius:22px; --blur:25px; --tint:25; --tint-color:18,16,58;',
'  --font-display:"Unbounded",system-ui,sans-serif;',
'  --font-body:"Figtree",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
'  --pad:clamp(16px,4vw,44px);',
'}',
'html[data-theme="light"]{',
'  --bg:#f6f4ff; --bg-2:#ffffff; --ink:#171433; --ink-soft:rgba(23,20,51,.72);',
'  --card:rgba(255,255,255,.72); --card-brd:rgba(23,20,51,.10); --tint-color:236,232,255;',
'}',
'html[data-theme="dark"]{',
'  --bg:#0b0920; --bg-2:#151038; --ink:#f5f4ff; --ink-soft:rgba(245,244,255,.72);',
'  --card:rgba(255,255,255,.07); --card-brd:rgba(255,255,255,.14); --tint-color:18,16,58;',
'}',
'*{box-sizing:border-box}',
'html,body{margin:0;padding:0}',
'html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}',
'body{font-family:var(--font-body);background:var(--bg);color:var(--ink);overflow-x:hidden;line-height:1.55;min-height:100vh}',
'body::before{content:"";position:fixed;inset:0;z-index:-3;background:linear-gradient(160deg,var(--bg) 0%,var(--bg-2) 55%,#241a4d 100%)}',
'#site-bg{position:fixed;inset:-2px;z-index:-2;background-size:cover;background-position:center;background-repeat:no-repeat;will-change:transform}',
'#site-tint{position:fixed;inset:0;z-index:-1;background:rgba(var(--tint-color),var(--tint-a));}',
'h1,h2,h3,.display{font-family:var(--font-display);font-weight:700;letter-spacing:-.02em;line-height:1.05;margin:0 0 .5em}',
'h1{font-size:clamp(2rem,7vw,4.4rem)} h2{font-size:clamp(1.5rem,4vw,2.6rem)} h3{font-size:clamp(1.05rem,2.4vw,1.4rem)}',
'a{color:inherit}',
'.wrap{width:100%;max-width:1180px;margin:0 auto;padding:0 var(--pad)}',
'section{padding:clamp(52px,9vw,110px) 0;position:relative}',
'.eyebrow{font-family:var(--font-display);font-size:.7rem;letter-spacing:.28em;text-transform:uppercase;color:var(--accent);margin-bottom:.7rem}',
'.muted{color:var(--ink-soft)}',
'.glass{background:var(--card);border:1px solid var(--card-brd);border-radius:var(--radius);backdrop-filter:blur(var(--blur)) saturate(140%);-webkit-backdrop-filter:blur(var(--blur)) saturate(140%);box-shadow:0 20px 50px rgba(0,0,0,.28)}',
'.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;font-family:var(--font-display);font-size:.82rem;letter-spacing:.02em;padding:.95rem 1.5rem;border-radius:999px;border:1px solid transparent;background:linear-gradient(100deg,var(--accent),var(--accent-2));color:#240c04;cursor:pointer;text-decoration:none;transition:transform .18s ease,box-shadow .18s ease;font-weight:700}',
'.btn:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(255,106,61,.35)}',
'.btn.ghost{background:transparent;border-color:var(--card-brd);color:var(--ink)}',
'.btn.ghost:hover{box-shadow:none;background:var(--card)}',
'.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none}',
'.btn.sm{padding:.6rem 1rem;font-size:.72rem}',
'input,select,textarea,button{font-family:var(--font-body);font-size:1rem}',
'input,select,textarea{width:100%;padding:.85rem 1rem;border-radius:14px;border:1px solid var(--card-brd);background:var(--card);color:var(--ink);outline:none}',
'input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,106,61,.18)}',
'label{display:block;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);margin:1rem 0 .35rem;font-weight:600}',
'.grid{display:grid;gap:clamp(14px,2.4vw,26px)}',
'.g2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}',
'.g3{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}',
'/* loader */',
'#loader{position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.4rem;background:radial-gradient(120% 120% at 20% 0%,#1b1445 0%,#0a0820 60%);transition:opacity .6s ease,visibility .6s ease}',
'#loader.done{opacity:0;visibility:hidden}',
'#loader .mark{font-family:var(--font-display);font-size:clamp(2.2rem,10vw,4.6rem);letter-spacing:.16em;background:linear-gradient(100deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}',
'#loader .sub{font-size:.72rem;letter-spacing:.4em;text-transform:uppercase;color:rgba(255,255,255,.55)}',
'#bar{width:min(260px,60vw);height:4px;border-radius:99px;background:rgba(255,255,255,.14);overflow:hidden}',
'#bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .3s ease}',
'/* nav */',
'header.nav{position:sticky;top:0;z-index:600;backdrop-filter:blur(14px);background:rgba(var(--tint-color),.55);border-bottom:1px solid var(--card-brd);padding-top:env(safe-area-inset-top)}',
'header.nav .in{display:flex;align-items:center;gap:1rem;justify-content:space-between;padding:.7rem var(--pad);max-width:1180px;margin:0 auto}',
'header.nav .logo{font-family:var(--font-display);font-size:1rem;letter-spacing:.12em;text-decoration:none;display:flex;align-items:center;gap:.6rem}',
'header.nav .logo img{height:32px;width:auto;border-radius:8px}',
'header.nav nav{display:flex;gap:1.1rem;overflow-x:auto;scrollbar-width:none}',
'header.nav nav::-webkit-scrollbar{display:none}',
'header.nav nav a{font-size:.82rem;text-decoration:none;color:var(--ink-soft);white-space:nowrap;padding:.35rem 0}',
'header.nav nav a:hover{color:var(--ink)}',
'#banner{display:none;background:linear-gradient(100deg,var(--accent),var(--accent-2));color:#260d03;text-align:center;padding:.6rem var(--pad);font-size:.86rem;font-weight:600}',
'/* hero */',
'.hero{min-height:min(88vh,780px);display:flex;align-items:center;padding-top:clamp(30px,6vw,70px)}',
'.hero .in{max-width:760px}',
'.hero p.lede{font-size:clamp(1rem,2.1vw,1.25rem);color:var(--ink-soft);max-width:56ch}',
'.row{display:flex;flex-wrap:wrap;gap:.7rem;align-items:center}',
'.stat{display:flex;gap:1.6rem;flex-wrap:wrap;margin-top:2rem}',
'.stat div b{display:block;font-family:var(--font-display);font-size:1.5rem}',
'.stat div span{font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-soft)}',
'/* cards */',
'.card{overflow:hidden;display:flex;flex-direction:column}',
'.slider{position:relative;aspect-ratio:16/10;background:linear-gradient(135deg,#241c52,#3a1f4f);overflow:hidden}',
'.slider .slide{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity .9s ease}',
'.slider .slide.on{opacity:1}',
'.slider .dots{position:absolute;bottom:10px;left:0;right:0;display:flex;gap:6px;justify-content:center;z-index:2}',
'.slider .dots i{width:6px;height:6px;border-radius:99px;background:rgba(255,255,255,.45);display:block;cursor:pointer}',
'.slider .dots i.on{background:#fff;width:18px}',
'.slider .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--font-display);letter-spacing:.2em;font-size:.72rem;color:rgba(255,255,255,.55)}',
'.card .body{padding:1.2rem 1.3rem 1.4rem;display:flex;flex-direction:column;gap:.6rem;flex:1}',
'.price{font-family:var(--font-display);font-size:1.25rem}',
'.price small{font-family:var(--font-body);font-size:.72rem;color:var(--ink-soft);font-weight:400}',
'.chips{display:flex;flex-wrap:wrap;gap:.4rem}',
'.chip{font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;padding:.3rem .65rem;border-radius:99px;border:1px solid var(--card-brd);background:var(--card);color:var(--ink-soft)}',
'.chip.warn{border-color:rgba(255,106,61,.5);color:var(--accent)}',
'/* booking */',
'.booking-grid{display:grid;gap:1.4rem;grid-template-columns:1.35fr .9fr}',
'@media(max-width:900px){.booking-grid{grid-template-columns:1fr}}',
'.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:.5rem}',
'.slot{padding:.6rem .3rem;text-align:center;border-radius:12px;border:1px solid var(--card-brd);background:var(--card);cursor:pointer;font-size:.84rem}',
'.slot.on{background:linear-gradient(100deg,var(--accent),var(--accent-2));color:#240c04;border-color:transparent;font-weight:700}',
'.slot.full{opacity:.38;cursor:not-allowed;text-decoration:line-through}',
'.slot small{display:block;font-size:.62rem;opacity:.8}',
'.breakdown{border-top:1px dashed var(--card-brd);margin-top:1rem;padding-top:1rem;font-size:.92rem}',
'.breakdown div{display:flex;justify-content:space-between;padding:.22rem 0}',
'.breakdown .tot{font-family:var(--font-display);font-size:1.2rem;border-top:1px solid var(--card-brd);margin-top:.5rem;padding-top:.6rem}',
'/* gallery */',
'.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.8rem}',
'.gal img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:16px;cursor:pointer;border:1px solid var(--card-brd);transition:transform .25s ease}',
'.gal img:hover{transform:scale(1.03)}',
'/* reviews */',
'.review{padding:1.2rem}',
'.stars{color:var(--accent-2);letter-spacing:.15em}',
'/* faq */',
'details.faq{border-bottom:1px solid var(--card-brd);padding:1rem 0}',
'details.faq summary{cursor:pointer;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:1rem}',
'details.faq summary::-webkit-details-marker{display:none}',
'details.faq[open] summary{color:var(--accent)}',
'/* theme fab */',
'#theme-fab{position:fixed;right:calc(16px + env(safe-area-inset-right));bottom:calc(16px + env(safe-area-inset-bottom));z-index:700;width:50px;height:50px;border-radius:50%;border:1px solid var(--card-brd);background:var(--card);backdrop-filter:blur(14px);color:var(--ink);cursor:pointer;font-size:1.15rem;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.35)}',
'#theme-menu{position:fixed;right:calc(16px + env(safe-area-inset-right));bottom:calc(78px + env(safe-area-inset-bottom));z-index:700;display:none;flex-direction:column;gap:.25rem;padding:.5rem;min-width:150px}',
'#theme-menu.open{display:flex;animation:fabin .18s ease}',
'@keyframes fabin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
'#theme-menu button{background:none;border:0;color:var(--ink);text-align:left;padding:.6rem .7rem;border-radius:12px;cursor:pointer;font-size:.88rem}',
'#theme-menu button:hover{background:var(--card)}',
'#theme-menu button.on{color:var(--accent);font-weight:700}',
'/* toast */',
'#toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom));z-index:900;padding:.8rem 1.2rem;border-radius:999px;background:rgba(20,16,50,.94);color:#fff;border:1px solid var(--card-brd);display:none;max-width:90vw;text-align:center;font-size:.88rem}',
'#toast.on{display:block;animation:fabin .2s ease}',
'/* footer */',
'footer{padding:clamp(40px,7vw,80px) 0 calc(60px + env(safe-area-inset-bottom));border-top:1px solid var(--card-brd);background:rgba(var(--tint-color),.4)}',
'footer .socials{display:flex;gap:.7rem;flex-wrap:wrap}',
'footer .socials a{width:40px;height:40px;border-radius:50%;border:1px solid var(--card-brd);display:flex;align-items:center;justify-content:center;text-decoration:none}',
'/* ticket */',
'.ticket{border-radius:20px;padding:1.4rem;background:linear-gradient(120deg,rgba(255,106,61,.16),rgba(255,176,58,.10));border:1px dashed rgba(255,106,61,.5)}',
'.code{font-family:var(--font-display);font-size:clamp(1.6rem,7vw,2.6rem);letter-spacing:.22em}',
'/* lightbox */',
'#lightbox{position:fixed;inset:0;z-index:9500;background:rgba(6,4,18,.92);display:none;align-items:center;justify-content:center}',
'#lightbox.on{display:flex}',
'#lightbox img{max-width:92vw;max-height:86vh;border-radius:16px}',
'/* admin */',
'.admin-wrap{display:grid;grid-template-columns:230px 1fr;min-height:100vh}',
'@media(max-width:820px){.admin-wrap{grid-template-columns:1fr}}',
'.side{padding:1rem;border-right:1px solid var(--card-brd);background:rgba(var(--tint-color),.5)}',
'@media(max-width:820px){.side{border-right:0;border-bottom:1px solid var(--card-brd)}}',
'.side a{display:block;padding:.55rem .7rem;border-radius:12px;text-decoration:none;font-size:.88rem;color:var(--ink-soft);cursor:pointer}',
'.side a.on,.side a:hover{background:var(--card);color:var(--ink)}',
'.main{padding:1.2rem;min-width:0}',
'table{width:100%;border-collapse:collapse;font-size:.86rem}',
'th,td{text-align:left;padding:.55rem .6rem;border-bottom:1px solid var(--card-brd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}',
'th{font-family:var(--font-display);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}',
'.scroller{overflow:auto;border:1px solid var(--card-brd);border-radius:16px}',
'.bar{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}',
'.bar input,.bar select{width:auto;min-width:150px}',
'input[type=range]{padding:0;height:26px}',
'.drop{border:2px dashed var(--card-brd);border-radius:18px;padding:1.4rem;text-align:center;color:var(--ink-soft);cursor:pointer}',
'.drop.hot{border-color:var(--accent);color:var(--accent)}',
'.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:.6rem;margin-top:.8rem}',
'.thumb{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--card-brd);aspect-ratio:1}',
'.thumb img{width:100%;height:100%;object-fit:cover}',
'.thumb .x{position:absolute;top:4px;right:4px;background:rgba(0,0,0,.6);color:#fff;border:0;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:.8rem}',
'.thumb .cov{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.55);color:#fff;font-size:.62rem;text-align:center;padding:.15rem}',
'.thumb.cover{outline:2px solid var(--accent)}',
'.kpi{padding:1rem 1.1rem}',
'.kpi b{display:block;font-family:var(--font-display);font-size:1.6rem}',
'.kpi span{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft)}',
'.bars{display:flex;align-items:flex-end;gap:4px;height:120px;margin-top:1rem}',
'.bars i{flex:1;background:linear-gradient(180deg,var(--accent),var(--accent-2));border-radius:4px 4px 0 0;min-height:3px;display:block}',
'.note{font-size:.8rem;color:var(--ink-soft);margin-top:.5rem}',
'.pill{display:inline-block;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;padding:.22rem .55rem;border-radius:99px;border:1px solid var(--card-brd)}',
'.pill.ok{border-color:rgba(80,220,140,.6);color:#7ff0ae}',
'.pill.bad{border-color:rgba(255,106,61,.6);color:#ff9b7a}',
'.reveal{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s ease}',
'.reveal.in{opacity:1;transform:none}',
'@media (prefers-reduced-motion: reduce){',
'  html{scroll-behavior:auto}',
'  *{animation-duration:.001ms !important;transition-duration:.001ms !important}',
'  .reveal{opacity:1;transform:none}',
'}',
'@media (prefers-reduced-transparency: reduce){',
'  .glass{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;background:rgba(var(--tint-color),.92)}',
'}',
'@media (prefers-contrast: more){.glass{background:rgba(var(--tint-color),.95)}}',
'.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
'.center{text-align:center}',
'.maxw{max-width:70ch}',
''].join('\n');

const FONT_LINKS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;700&family=Figtree:wght@300;400;500;600;700&display=swap" rel="stylesheet">';

function head(opts) {
  const c = cfg();
  const s = opts.settings || DEFAULT_SETTINGS;
  const title = opts.title || (s.seo && s.seo.title) || 'NATOF GameZone';
  const desc = opts.description || (s.seo && s.seo.description) || '';
  const logo = (s.brand && s.brand.logo) || '';
  const og = (s.background && s.background.image) || logo;
  return '<!doctype html><html lang="en" data-theme="dark"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>' + esc(title) + '</title>' +
    '<meta name="description" content="' + esc(desc) + '">' +
    (c.googleVerify ? '<meta name="google-site-verification" content="' + esc(c.googleVerify) + '">' : '') +
    '<meta name="theme-color" content="#0b0920">' +
    '<meta property="og:type" content="website">' +
    '<meta property="og:title" content="' + esc(title) + '">' +
    '<meta property="og:description" content="' + esc(desc) + '">' +
    (og ? '<meta property="og:image" content="' + esc(og) + '">' : '') +
    (c.siteUrl ? '<meta property="og:url" content="' + esc(c.siteUrl) + '">' : '') +
    '<meta name="twitter:card" content="summary_large_image">' +
    (opts.canonical && c.siteUrl ? '<link rel="canonical" href="' + esc(c.siteUrl + opts.canonical) + '">' : '') +
    '<link rel="manifest" href="/manifest.webmanifest">' +
    '<link rel="icon" href="/icon.svg" type="image/svg+xml">' +
    '<link rel="apple-touch-icon" href="/icon.svg">' +
    FONT_LINKS +
    (opts.noindex ? '<meta name="robots" content="noindex,nofollow">' : '') +
    '<style>' + CSS + '</style>' +
    '<script>(function(){try{var t=localStorage.getItem("natof-theme")||"system";var d=t==="system"?(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):t;document.documentElement.setAttribute("data-theme",d);}catch(e){}})();</script>' +
    '</head><body>';
}

function themeFab() {
  return '<button id="theme-fab" aria-label="Theme">◐</button>' +
    '<div id="theme-menu" class="glass" role="menu">' +
    '<button data-theme-opt="light">☀︎ Light</button>' +
    '<button data-theme-opt="dark">☾ Dark</button>' +
    '<button data-theme-opt="system">⚙︎ System</button>' +
    '</div><div id="toast"></div>';
}

/* ==================================================================================
   14. PUBLIC PAGE
   ================================================================================== */

function publicPage(settings) {
  const c = cfg();
  const s = settings;
  const bg = (s.background && s.background.image) || '';
  const blur = num((s.background || {}).blur, 25);
  const tint = num((s.background || {}).tint, 25);
  const tintColor = (s.background || {}).tintColor || (settings === DEFAULT_SETTINGS ? '18,16,58' : '18,16,58');
  const rgb = hexToRgb(tintColor) || '18,16,58';
  const b = s.brand || {};
  const social = s.social || {};
  const contact = s.contact || {};
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: b.name || 'NATOF GameZone',
    description: (s.seo || {}).description || '',
    image: bg || undefined,
    telephone: contact.phone || undefined,
    address: contact.address ? { '@type': 'PostalAddress', streetAddress: contact.address, addressCountry: 'ET' } : undefined,
    url: c.siteUrl || undefined,
    priceRange: 'ETB',
    sameAs: [social.telegram, social.instagram, social.tiktok].filter(Boolean)
  };
  return head({ settings: s, title: (s.seo || {}).title, description: (s.seo || {}).description }) +
    '<style>:root{--blur:' + blur + 'px;--tint-a:' + (tint / 100) + ';--tint-color:' + rgb + '}</style>' +
    '<div id="loader"><div class="mark">NATOF</div><div class="sub">game zone</div><div id="bar"><i></i></div></div>' +
    (bg ? '<div id="site-bg" style="background-image:url(' + JSON.stringify(bg) + ')"></div>' : '<div id="site-bg" style="background:linear-gradient(160deg,#1a1247,#2b1b52 60%,#4a2350)"></div>') +
    '<div id="site-tint"></div>' +
    '<div id="banner"></div>' +
    '<header class="nav"><div class="in">' +
    '<a class="logo" href="/">' + (b.logo ? '<img src="' + esc(b.logo) + '" alt="">' : '') + '<span>' + esc(b.name || 'NATOF') + '</span></a>' +
    '<nav id="navlinks"></nav>' +
    '<div class="row" id="nav-actions"></div>' +
    '</div></header>' +
    '<main id="app"><section class="hero"><div class="wrap in"><div class="eyebrow" id="hero-eyebrow">Ethiopia · games & activities</div>' +
    '<h1 id="hero-title">' + esc(b.name || 'NATOF GameZone') + '</h1>' +
    '<p class="lede" id="ይቅርታ — የመጀመሪያው ሙከራ በርዝመት ገደብ ስለተቆረጠ፣ ሙሉውን ፋይል አሁን በአንድ ጊዜ አስገባሁለታለሁ። (ከመላው በፊት፦ ኮዱ **አልተሞከረም**፤ Chapa/Telebirr/CBE **merchant approval** ይፈልጋሉ፤ ይህን አልደብቅም።)

<artifact identifier="natof-gamezone-single-file" type="code" language="javascript" title="NATOF GameZone — api/index.js (one file: public site + admin + creator + backend)">
/* =====================================================================================
 NATOF GameZone — ONE FILE: public website + admin panel + creator panel + backend
 -------------------------------------------------------------------------------------
 DEPLOY
   api/index.js   <-- this file
   vercel.json    <-- REQUIRED (1 line): Vercel must forward every url ("/", "/admin",
                      "/sitemap.xml") into this one file; without the rewrite a single
                      file cannot own the whole domain:
                      { "rewrites": [ { "source": "/(.*)", "destination": "/api/index" } ] }
   package.json   <-- NOT needed. Zero dependencies (node built-ins only).
 -------------------------------------------------------------------------------------
 HONEST STATUS (read this)
   * NOT tested against a live Vercel + Supabase + Chapa account. Verify on staging.
   * Chapa: written to Chapa's published REST contract (initialize / verify /
     webhook HMAC-SHA256 over the raw body, header x-chapa-signature or Chapa-Signature).
     Payment is only ever confirmed by webhook + server-side verify, never by browser.
   * Telebirr: written to the published H5 C2B pre-order flow (fabric token ->
     preOrder -> prepay_id -> web checkout). REQUIRES an approved Telebirr merchant
     account (business licence, TIN, short code). Scaffold until merchant keys are live.
   * CBE: no public API -> manual bank transfer, customer enters the reference, owner
     confirms inside admin. Safe, real-world default.
   * Passkeys (WebAuthn) and Web Push (VAPID + aes128gcm) are implemented with node
     crypto only. QR on the ticket uses a public QR image service (only the booking
     code travels); set settings.qr_service="" to disable.
 -------------------------------------------------------------------------------------
 ENV VARS (every one optional -> the site NEVER crashes without them)
   SITE_URL                    public url, used in links/callbacks/sitemap
   CREATOR_PORTFOLIO_URL       your portfolio url (footer "Creator" button)
   SUPABASE_URL                https://xxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY   server-only key (never reaches the browser)
   SUPABASE_STORAGE_BUCKET     bucket name, default "natof"
   BLOB_READ_WRITE_TOKEN       Vercel Blob token (fallback if Supabase Storage absent)
   SESSION_SECRET              random 32+ chars, signs session cookies
   CREATOR_TOKEN               your long master / recovery token
   CREATOR_SECRET_PATH         secret path of the creator panel, e.g. nfz-console-7q2
   CHAPA_SECRET_KEY            Chapa secret key
   CHAPA_WEBHOOK_SECRET        Chapa webhook signing secret
   TELEBIRR_ENV                sandbox | production
   TELEBIRR_FABRIC_APP_ID      Telebirr fabric app id
   TELEBIRR_APP_SECRET         Telebirr app secret
   TELEBIRR_MERCHANT_APP_ID    Telebirr merchant app id
   TELEBIRR_MERCHANT_CODE      Telebirr short code
   TELEBIRR_PRIVATE_KEY        RSA private key PEM (escape newlines as \\n)
   CBE_ACCOUNT_NAME            manual CBE transfer: account holder name
   CBE_ACCOUNT_NUMBER          manual CBE transfer: account number
   VAPID_PUBLIC_KEY            web push public key
   VAPID_PRIVATE_KEY           web push private key (base64url raw P-256)
   VAPID_SUBJECT              mailto:you@example.com
   GOOGLE_SITE_VERIFICATION    Search Console verification code
 -------------------------------------------------------------------------------------
 SQL — RUN ONCE in Supabase -> SQL Editor
 -------------------------------------------------------------------------------------
create extension if not exists pgcrypto;

create table if not exists settings (id int primary key default 1, data jsonb not null default '{}'::jsonb, updated_at timestamptz default now());
insert into settings (id,data) values (1,'{}'::jsonb) on conflict (id) do nothing;

create table if not exists games (
  id uuid primary key default gen_random_uuid(), name text not null, description text default '',
  price numeric, price_unit text default 'per_game',            -- per_30_min | per_hour | per_game
  variants jsonb default '[]'::jsonb,                           -- [{"name":"Rental skates","price":100}]
  photos jsonb default '[]'::jsonb,                             -- [{"url":"...","caption":""}]
  capacity int default 1, age_note text default '', bring text default '', health_warning text default '',
  visible boolean default true, sort_order int default 0, created_at timestamptz default now());

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(), code text unique not null,
  game_id uuid references games(id) on delete set null, game_name text, variant text,
  slot_date date not null, slot_start text not null, slot_minutes int default 30, blocks int default 1,
  people int default 1, name text, phone text, promo_code text,
  unit_price numeric, unit_label text, subtotal numeric, discount numeric default 0, total numeric,
  status text default 'pending',                                -- pending | paid | cancelled | refunded
  internal_note text default '', created_at timestamptz default now(), updated_at timestamptz default now());
create index if not exists bookings_slot_idx on bookings (slot_date, game_id, status);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(), booking_id uuid references bookings(id) on delete cascade,
  booking_code text, method text, amount numeric, currency text default 'ETB',
  status text default 'pending', reference text, raw jsonb default '{}'::jsonb, confirmed_by text,
  note text default '', created_at timestamptz default now(), updated_at timestamptz default now());

create table if not exists promos (
  id uuid primary key default gen_random_uuid(), code text unique not null, description text default '',
  type text default 'percent',                                  -- percent | fixed | free
  value numeric default 0, active boolean default true, starts_at timestamptz, ends_at timestamptz,
  max_uses int, min_amount numeric, first_time_only boolean default false, per_phone_once boolean default true,
  games jsonb default '[]'::jsonb, happy_days jsonb default '[]'::jsonb, happy_from text, happy_to text,
  created_at timestamptz default now());

create table if not exists reviews (id uuid primary key default gen_random_uuid(), author text, rating int default 5, body text, status text default 'pending', featured boolean default false, created_at timestamptz default now());
create table if not exists events (id uuid primary key default gen_random_uuid(), title text, description text, entry_fee numeric, starts_at timestamptz, registration_open boolean default true, capacity int, cover text, bracket jsonb default '[]'::jsonb, results jsonb default '[]'::jsonb, status text default 'draft', visible boolean default true, sort_order int default 0, created_at timestamptz default now());
create table if not exists event_registrations (id uuid primary key default gen_random_uuid(), event_id uuid references events(id) on delete cascade, name text, phone text, team_name text, status text default 'pending', paid boolean default false, note text default '', created_at timestamptz default now());
create table if not exists gallery (id uuid primary key default gen_random_uuid(), url text, caption text, visible boolean default true, sort_order int default 0, created_at timestamptz default now());
create table if not exists faqs (id uuid primary key default gen_random_uuid(), question text, answer text, visible boolean default true, sort_order int default 0, created_at timestamptz default now());
create table if not exists admins (id uuid primary key default gen_random_uuid(), username text unique not null, display_name text default '', password_hash text not null, role text default 'staff', active boolean default true, must_change_password boolean default false, created_by text default 'creator', last_login timestamptz, created_at timestamptz default now());
create table if not exists admin_sessions (id uuid primary key default gen_random_uuid(), admin_id uuid references admins(id) on delete cascade, token_hash text unique not null, scope text default 'admin', ip text, ua text, created_at timestamptz default now(), expires_at timestamptz not null, revoked boolean default false);
create table if not exists passkeys (id uuid primary key default gen_random_uuid(), admin_id uuid references admins(id) on delete cascade, credential_id text unique not null, public_key text not null, alg int default -7, label text default '', counter bigint default 0, created_at timestamptz default now(), last_used timestamptz);
create table if not exists recovery_codes (id uuid primary key default gen_random_uuid(), admin_id uuid references admins(id) on delete cascade, code_hash text not null, used boolean default false, created_at timestamptz default now());
create table if not exists audit_log (id bigserial primary key, at timestamptz default now(), actor text, role text, action text, target text, detail jsonb, ip text);
create table if not exists webhook_log (id bigserial primary key, at timestamptz default now(), provider text, signature_ok boolean, body jsonb, headers jsonb, note text);
create table if not exists push_subs (id uuid primary key default gen_random_uuid(), admin_id uuid references admins(id) on delete cascade, endpoint text unique, keys jsonb, created_at timestamptz default now());
create table if not exists rate_limits (key text primary key, count int default 0, reset_at timestamptz not null);
create table if not exists blocked_dates (id uuid primary key default gen_random_uuid(), day date unique, reason text);

-- Block the public internet: RLS on + no policies = anon/auth keys can read nothing.
-- The server uses the service-role key, which bypasses RLS.
alter table settings enable row level security;   alter table games enable row level security;
alter table bookings enable row level security;   alter table payments enable row level security;
alter table promos enable row level security;     alter table reviews enable row level security;
alter table events enable row level security;     alter table event_registrations enable row level security;
alter table gallery enable row level security;    alter table faqs enable row level security;
alter table admins enable row level security;     alter table admin_sessions enable row level security;
alter table passkeys enable row level security;   alter table recovery_codes enable row level security;
alter table audit_log enable row level security;  alter table webhook_log enable row level security;
alter table push_subs enable row level security;  alter table rate_limits enable row level security;
alter table blocked_dates enable row level security;

insert into storage.buckets (id,name,public) values ('natof','natof',true) on conflict (id) do nothing;

-- The four starter games (names + prices only; everything else is admin-editable).
insert into games (name,description,price,price_unit,capacity,variants,sort_order) values
 ('Roller Skating','Big open skating floor. Rental skates or bring your own.',100,'per_30_min',20,'[{"name":"Rental skates","price":100},{"name":"Own skates","price":100}]'::jsonb,1),
 ('Car Simulation','PlayStation racing rigs.',50,'per_game',3,'[]'::jsonb,2),
 ('PlayStation','EA FC, GTA, open-world games and more.',25,'per_game',4,'[{"name":"EA FC","price":25},{"name":"GTA","price":30},{"name":"Open world","price":30}]'::jsonb,3),
 ('VR','Virtual reality. Two ways to play.',50,'per_game',2,'[{"name":"With controller","price":50},{"name":"View only","price":50}]'::jsonb,4)
on conflict do nothing;
 ===================================================================================== */

'use strict';
const crypto = require('crypto');

/* ---------- 0. boot-safe env ---------- */
function env(n){try{const v=process.env[n];if(v==null)return null;const s=String(v).trim();if(!s)return null;const l=s.toLowerCase();if(l==='undefined'||l==='null'||l==='changeme'||l==='your-key-here')return null;return s;}catch(e){return null;}}
function cfg(){const ch=env('CHAPA_SECRET_KEY');
 const tb=env('TELEBIRR_FABRIC_APP_ID')&&env('TELEBIRR_APP_SECRET')&&env('TELEBIRR_MERCHANT_APP_ID')&&env('TELEBIRR_MERCHANT_CODE')&&env('TELEBIRR_PRIVATE_KEY');
 const cbe=env('CBE_ACCOUNT_NAME')&&env('CBE_ACCOUNT_NUMBER');
 return { siteUrl:env('SITE_URL')||'', portfolio:env('CREATOR_PORTFOLIO_URL')||'',
  supabaseUrl:env('SUPABASE_URL'), supabaseKey:env('SUPABASE_SERVICE_ROLE_KEY')||env('SUPABASE_KEY'),
  bucket:env('SUPABASE_STORAGE_BUCKET')||'natof', blobToken:env('BLOB_READ_WRITE_TOKEN'),
  sessionSecret:env('SESSION_SECRET')||env('CREATOR_TOKEN')||env('SUPABASE_SERVICE_ROLE_KEY')||'natof-dev-secret',
  creatorToken:env('CREATOR_TOKEN'), creatorPath:(env('CREATOR_SECRET_PATH')||'').replace(/^\/+|\/+$/g,''),
  chapaKey:ch, chapaSecret:env('CHAPA_WEBHOOK_SECRET')||ch,
  telebirr: tb?{ fabricAppId:env('TELEBIRR_FABRIC_APP_ID'), appSecret:env('TELEBIRR_APP_SECRET'),
    merchantAppId:env('TELEBIRR_MERCHANT_APP_ID'), merchantCode:env('TELEBIRR_MERCHANT_CODE'),
    privateKey:(env('TELEBIRR_PRIVATE_KEY')||'').replace(/\\n/g,'\n'), base:'https://openapi.telebirr.com',
    web:'https://web.telebirr.com/wap/cashier/index' }:null,
  cbe: cbe?{name:env('CBE_ACCOUNT_NAME'),number:env('CBE_ACCOUNT_NUMBER')}:null,
  vapidPublic:env('VAPID_PUBLIC_KEY'), vapidPrivate:env('VAPID_PRIVATE_KEY'),
  vapidSubject:env('VAPID_SUBJECT')||'mailto:admin@example.com', googleVerify:env('GOOGLE_SITE_VERIFICATION') }; }
const DB_READY=()=>{const c=cfg();return !!(c.supabaseUrl&&c.supabaseKey);};

/* ---------- 1. utils ---------- */
function json(res,code,body,h){res.writeHead(code,Object.assign({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},h||{}));res.end(JSON.stringify(body));}
function text(res,code,body,type,h){res.writeHead(code,Object.assign({'Content-Type':type||'text/plain; charset=utf-8'},h||{}));res.end(body);}
function html(res,code,body,h){res.writeHead(code,Object.assign({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'},h||{}));res.end(body);}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function num(v,d){const n=Number(v);return isFinite(n)?n:(d===undefined?0:d);}
function money(n){return (Math.round(num(n)*100)/100).toFixed(2);}
function nowISO(){return new Date().toISOString();}
function uid(n){return crypto.randomBytes(n||16).toString('hex');}
function code6(){const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<6;i++)s+=a[crypto.randomInt(0,a.length)];return s;}
function safeEqual(a,b){a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));if(a.length!==b.length)return false;try{return crypto.timingSafeEqual(a,b);}catch(e){return false;}}
function clampInt(v,lo,hi,d){const n=Math.round(num(v,d));return Math.max(lo,Math.min(hi,n));}
function dayKey(d){return d.toISOString().slice(0,10);}
function minutesOf(h){const p=String(h||'0:0').split(':');return num(p[0])*60+num(p[1]);}
function hhmm(m){const h=Math.floor(m/60),mm=m%60;return (h<10?'0':'')+h+':'+(mm<10?'0':'')+mm;}
function parseJSON(s,d){try{const v=JSON.parse(s);return v===null?d:v;}catch(e){return d;}}
function clientIp(req){const h=req.headers||{};return String((h['x-forwarded-for']||'').split(',')[0]||h['x-real-ip']||'unknown').trim();}
function hexToRgb(hex){const m=String(hex||'').match(/^#?([0-9a-f]{6})$/i);if(!m)return '18,16,58';const v=parseInt(m[1],16);return ((v>>16)&255)+','+((v>>8)&255)+','+(v&255);}

async function readRaw(req){
 if(Buffer.isBuffer(req.rawBody))return req.rawBody.toString('utf8');
 if(typeof req.body==='string')return req.body;
 if(Buffer.isBuffer(req.body))return req.body.toString('utf8');
 const ch=[];try{for await(const c of req)ch.push(typeof c==='string'?Buffer.from(c):c);if(ch.length)return Buffer.concat(ch).toString('utf8');}catch(e){}
 if(req.body&&typeof req.body==='object')return JSON.stringify(req.body);
 return '';
}
async function readJSON(req){const r=await readRaw(req);if(!r)return {};const v=parseJSON(r,null);return v&&typeof v==='object'?v:{};}
function parseCookies(req){const o={};String((req.headers&&req.headers.cookie)||'').split(';').forEach(p=>{const i=p.indexOf('=');if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());});return o;}
function cookieHeader(n,v,maxAge,secure){const b=[n+'='+encodeURIComponent(v),'Path=/','HttpOnly','SameSite=Lax'];b.push(maxAge===0?'Max-Age=0':'Max-Age='+maxAge);if(secure)b.push('Secure');return b.join('; ');}
function isSecure(req){const p=String((req.headers['x-forwarded-proto']||'').split(',')[0]).trim();return p==='https'||(cfg().siteUrl||'').indexOf('https://')===0;}
function signToken(id){return id+'.'+crypto.createHmac('sha256',cfg().sessionSecret).update(id).digest('base64url');}
function verifyToken(t){if(!t||String(t).indexOf('.')<0)return null;const p=String(t).split('.');return safeEqual(p[1],crypto.createHmac('sha256',cfg().sessionSecret).update(p[0]).digest('base64url'))?p[0]:null;}
function b64u(b){return Buffer.from(b).toString('base64url');}

/* ---------- 2. Supabase REST ---------- */
async function sbRest(path,o){o=o||{};const c=cfg();if(!c.supabaseUrl||!c.supabaseKey)throw new Error('SUPABASE_NOT_CONFIGURED');
 const h=Object.assign({apikey:c.supabaseKey,Authorization:'Bearer '+c.supabaseKey,'Content-Type':'application/json',Accept:'application/json'},o.headers||{});
 if(o.prefer)h.Prefer=o.prefer;
 const res=await fetch(c.supabaseUrl.replace(/\/+$/,'')+'/rest/v1/'+path,{method:o.method||'GET',headers:h,body:o.body===undefined?undefined:(typeof o.body==='string'?o.body:JSON.stringify(o.body)),cache:'no-store'});
 const raw=await res.text();const data=raw?parseJSON(raw,raw):null;
 if(!res.ok){let m=(data&&data.message)?data.message:('Supabase HTTP '+res.status);if(res.status===404&&m.indexOf('does not exist')>=0)m='Table missing — run the SQL block at the top of this file.';const e=new Error(m);e.status=res.status;throw e;}
 return data;}
const db={
 all:(t,q)=>sbRest(t+(q?'?'+q:'')),
 first:async(t,q)=>{const r=await sbRest(t+(q?'?'+q:'')+(q&&q.indexOf('limit=')>=0?'':'&limit=1'));return Array.isArray(r)?(r[0]||null):null;},
 insert:(t,rows)=>sbRest(t,{method:'POST',body:rows,prefer:'return=representation'}),
 update:(t,q,p)=>sbRest(t+'?'+q,{method:'PATCH',body:p,prefer:'return=representation'}),
 remove:(t,q)=>sbRest(t+'?'+q,{method:'DELETE',prefer:'return=representation'}),
 count:async(t,q)=>{const c=cfg();const r=await fetch(c.supabaseUrl.replace(/\/+$/,'')+'/rest/v1/'+t+'?'+(q||'')+'&select=id',{method:'HEAD',headers:{apikey:c.supabaseKey,Authorization:'Bearer '+c.supabaseKey,Prefer:'count=exact'},cache:'no-store'});const cr=r.headers.get('content-range')||'0-0/0';return num(cr.split('/')[1],0);}
};

/* ---------- 3. settings ---------- */
const DEFAULT_SETTINGS={
 brand:{name:'NATOF GameZone',tagline:'Roller skating, racing rigs, PlayStation & VR',logo:''},
 background:{image:'',blur:25,tint:25,tintColor:'#12103a'},
 contact:{phone:'',whatsapp:'',email:'',address:'',mapUrl:''},
 hours:{'0':['10:00','21:00'],'1':['10:00','21:00'],'2':['10:00','21:00'],'3':['10:00','21:00'],'4':['10:00','21:00'],'5':['10:00','22:00'],'6':['09:00','22:00']},
 social:{telegram:'',instagram:'',tiktok:''},
 announcement:{enabled:false,text:'',link:''},
 features:{booking:true,tournaments:true,payments:true,reviews:true,gallery:true},
 maintenance:{enabled:false,message:'We are upgrading the zone. Back very soon.',until:''},
 booking:{slotMinutes:30,maxDaysAhead:30,maxPeople:20},
 seo:{title:'NATOF GameZone — Roller skating, PlayStation, VR in Ethiopia',description:'Book roller skating, PlayStation racing rigs, FC, GTA, VR and tournaments at NATOF GameZone. Pay in ETB with Chapa, Telebirr or CBE.'},
 legal:{terms:'',privacy:'',refund:''}, about:{title:'The zone',body:''},
 qr_service:'https://api.qrserver.com/v1/create-qr-code/'};
function deepMerge(base,patch){const out=Array.isArray(base)?base.slice():Object.assign({},base);if(!patch||typeof patch!=='object')return out;
 Object.keys(patch).forEach(k=>{const v=patch[k];if(v&&typeof v==='object'&&!Array.isArray(v)&&out[k]&&typeof out[k]==='object'&&!Array.isArray(out[k]))out[k]=deepMerge(out[k],v);else if(v!==undefined)out[k]=v;});return out;}
async function getSettings(){if(!DB_READY())return deepMerge(DEFAULT_SETTINGS,{});try{const r=await db.first('settings','id=eq.1');return deepMerge(DEFAULT_SETTINGS,(r&&r.data)||{});}catch(e){return deepMerge(DEFAULT_SETTINGS,{});}}
async function saveSettings(patch){const next=deepMerge(await getSettings(),patch);const r=await db.first('settings','id=eq.1');
 if(r)await db.update('settings','id=eq.1',{data:next,updated_at:nowISO()});else await db.insert('settings',{id:1,data:next});return next;}
function publicSettings(s){return {brand:s.brand,background:s.background,contact:s.contact,hours:s.hours,social:s.social,announcement:s.announcement,features:s.features,booking:s.booking,seo:s.seo,legal:s.legal,about:s.about};}

/* ---------- 4. rate limit + audit ---------- */
const MEM=new Map();
async function rateLimit(key,limit,win){const reset=new Date(Date.now()+win*1000).toISOString();
 if(!DB_READY()){const c=MEM.get(key),t=Date.now();if(!c||c.reset<t){MEM.set(key,{n:1,reset:t+win*1000});return {ok:true};}c.n++;return {ok:c.n<=limit};}
 try{const r=await db.first('rate_limits','key=eq.'+encodeURIComponent(key));
  if(!r){await db.insert('rate_limits',{key:key,count:1,reset_at:reset});return {ok:true};}
  if(new Date(r.reset_at).getTime()<Date.now()){await db.update('rate_limits','key=eq.'+encodeURIComponent(key),{count:1,reset_at:reset});return {ok:true};}
  const n=num(r.count)+1;await db.update('rate_limits','key=eq.'+encodeURIComponent(key),{count:n});return {ok:n<=limit};}catch(e){return {ok:true};}}
async function audit(actor,role,action,target,detail,req){if(!DB_READY())return;try{await db.insert('audit_log',[{actor:actor||'anon',role:role||'anon',action:action,target:target||'',detail:detail||{},ip:clientIp(req||{headers:{}})}]);}catch(e){}}

/* ---------- 5. auth ---------- */
function hashPassword(pw){const salt=crypto.randomBytes(16).toString('hex');const k=crypto.scryptSync(String(pw),salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});return 'scrypt$16384$'+salt+'$'+k.toString('hex');}
function verifyPassword(pw,stored){try{const p=String(stored||'').split('$');if(p.length!==4||p[0]!=='scrypt')return false;const k=crypto.scryptSync(String(pw),p[2],64,{N:num(p[1],16384),r:8,p:1,maxmem:64*1024*1024});return safeEqual(k.toString('hex'),p[3]);}catch(e){return false;}}
const SESS_H={admin:12,creator:4};
async function createSession(adminId,scope,req){const raw=uid(32);const hash=crypto.createHash('sha256').update(raw).digest('hex');
 await db.insert('admin_sessions',[{admin_id:adminId,token_hash:hash,scope:scope,ip:clientIp(req),ua:String(req.headers['user-agent']||'').slice(0,200),expires_at:new Date(Date.now()+SESS_H[scope]*3600000).toISOString()}]);
 return signToken(raw);}
async function getSession(req){if(!DB_READY())return null;const tok=parseCookies(req).natof_session;if(!tok)return null;const raw=verifyToken(tok);if(!raw)return null;
 const h=crypto.createHash('sha256').update(raw).digest('hex');
 try{const s=await db.first('admin_sessions','token_hash=eq.'+h);if(!s||s.revoked)return null;if(new Date(s.expires_at).getTime()<Date.now())return null;
  if(s.scope==='creator')return {role:'creator',scope:'creator',adminId:s.admin_id,sessionId:s.id,username:'creator'};
  const a=await db.first('admins','id=eq.'+s.admin_id);if(!a||!a.active)return null;
  return {role:a.role,scope:'admin',adminId:a.id,sessionId:s.id,username:a.username,display_name:a.display_name,must_change_password:!!a.must_change_password};}catch(e){return null;}}
async function revokeAll(id){try{await db.update('admin_sessions','admin_id=eq.'+id+'&revoked=eq.false',{revoked:true});}catch(e){}}
async function getCreator(req){const s=await getSession(req);return s&&s.role==='creator'?s:null;}
async function makeRecoveryCodes(adminId,n){const codes=[],rows=[];for(let i=0;i<(n||8);i++){const c=uid(5).toUpperCase()+'-'+uid(5).toUpperCase();codes.push(c);rows.push({admin_id:adminId,code_hash:crypto.createHash('sha256').update(c).digest('hex')});}
 try{await db.remove('recovery_codes','admin_id=eq.'+adminId);}catch(e){} await db.insert('recovery_codes',rows);return codes;}

/* ---------- 6. WebAuthn (passkeys) — real crypto, no library ---------- */
function unb64u(s){return Buffer.from(String(s),'base64url');}
function parseAuthData(buf){const rpIdHash=buf.subarray(0,32),flags=buf[32],counter=buf.readUInt32BE(33),rest=buf.subarray(37);let credId=null,cose=null;
 if(flags&0x40){const l=rest.readUInt16BE(0);credId=rest.subarray(2,2+l);cose=rest.subarray(2+l);}return {rpIdHash,flags,counter,credId,cose};}
function cborAuthData(buf){let i=0;
 function head(){const b=buf[i++],major=b>>5,info=b&31;let len=info;if(info===24)len=buf[i++];else if(info===25){len=buf.readUInt16BE(i);i+=2;}else if(info===26){len=buf.readUInt32BE(i);i+=4;}return {major,len};}
 function skip(){const h=head();if(h.major===2||h.major===3)i+=h.len;else if(h.major===4){for(let k=0;k<h.len;k++)skip();}else if(h.major===5){for(let k=0;k<h.len;k++){skip();skip();}}}
 const top=head();let ad=null;
 for(let k=0;k<top.len;k++){const hk=head();const name=buf.subarray(i,i+hk.len).toString('utf8');i+=hk.len;
  if(name==='authData'){const hv=head();ad=buf.subarray(i,i+hv.len);i+=hv.len;}else skip();}
 if(!ad)throw new Error('Missing authData');return ad;}
function coseToJWK(cose){let i=0;
 function read(){const b=cose[i++],major=b>>5,info=b&31;let len=info;if(info===24)len=cose[i++];else if(info===25){len=cose.readUInt16BE(i);i+=2;}else if(info===26){len=cose.readUInt32BE(i);i+=4;}
  if(major===0)return len;if(major===1)return -1-len;if(major===2){const o=cose.subarray(i,i+len);i+=len;return o;}if(major===3){const o=cose.subarray(i,i+len).toString('utf8');i+=len;return o;}
  if(major===5){const m={};for(let k=0;k<len;k++){const key=read();m[String(key)]=read();}return m;}if(major===4){const a=[];for(let k=0;k<len;k++)a.push(read());return a;}return null;}
 const m=read()||{},kty=m['1'],alg=m['3'];
 if(kty===2)return {jwk:{kty:'EC',crv:'P-256',x:b64u(m['-2']),y:b64u(m['-3'])},alg:alg||-7};
 if(kty===3)return {jwk:{kty:'RSA',n:b64u(m['-1']),e:b64u(m['-2'])},alg:alg||-257};
 throw new Error('Unsupported key type');}
function newChallenge(){return b64u(crypto.randomBytes(32));}
function rpInfo(req){const host=new URL(cfg().siteUrl||('https://'+(req.headers.host||'localhost')));return {rpId:host.hostname,origin:host.protocol+'//'+host.host};}
async function verifyRegistration(rp,body,challenge){const cd=parseJSON(unb64u(body.clientDataJSON).toString('utf8'),null);
 if(!cd)throw new Error('bad clientDataJSON');if(cd.type!=='webauthn.create')throw new Error('wrong ceremony');
 if(cd.challenge!==challenge)throw new Error('challenge mismatch');if(cd.origin!==rp.origin)throw new Error('origin mismatch');
 const ad=parseAuthData(cborAuthData(unb64u(body.attestationObject)));
 if(!safeEqual(ad.rpIdHash.toString('hex'),crypto.createHash('sha256').update(rp.rpId).digest('hex')))throw new Error('rp hash mismatch');
 if(!(ad.flags&0x01))throw new Error('user presence missing');
 const k=coseToJWK(ad.cose);return {credentialId:b64u(ad.credId),jwk:k.jwk,alg:k.alg,counter:ad.counter};}
async function verifyAssertion(rp,body,challenge,jwk,alg,counter){
 const cd=parseJSON(unb64u(body.clientDataJSON).toString('utf8'),null);
 if(!cd)throw new Error('bad clientDataJSON');if(cd.type!=='webauthn.get')throw new Error('wrong ceremony');
 if(cd.challenge!==challenge)throw new Error('challenge mismatch');if(cd.origin!==rp.origin)throw new Error('origin mismatch');
 const adBuf=unb64u(body.authenticatorData),ad=parseAuthData(adBuf);
 if(!safeEqual(ad.rpIdHash.toString('hex'),crypto.createHash('sha256').update(rp.rpId).digest('hex')))throw new Error('rp hash mismatch');
 if(!(ad.flags&0x01))throw new Error('user presence missing');
 const signed=Buffer.concat([adBuf,crypto.createHash('sha256').update(unb64u(body.clientDataJSON)).digest()]);
 const pub=crypto.createPublicKey({key:jwk,format:'jwk'}),sig=unb64u(body.signature);
 let ok=false;
 if(alg===-7)ok=crypto.verify('sha256',signed,{key:pub,dsaEncoding:'der'},sig);else ok=crypto.verify('sha256',signed,pub,sig);
 if(!ok)throw new Error('signature failed');
 if(counter&&ad.counter&&ad.counter<=counter)throw new Error('possible cloned authenticator');
 return {counter:ad.counter};}

/* ---------- 7. Web Push (VAPID + aes128gcm) ---------- */
function hkdf(ikm,salt,info,len){return Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from(info,'utf8'),len));}
function vapid(){const c=cfg();if(!c.vapidPublic||!c.vapidPrivate)return null;
 try{const d=Buffer.from(c.vapidPrivate,'base64url');const e=crypto.createECDH('prime256v1');e.setPrivateKey(d);const p=e.getPublicKey();
  return {pub:c.vapidPublic,jwk:{kty:'EC',crv:'P-256',d:b64u(d),x:b64u(p.subarray(1,33)),y:b64u(p.subarray(33,65))}};}catch(e){return null;}}
function vapidJWT(endpoint){const k=vapid();if(!k)return null;const u=new URL(endpoint);
 const h=b64u(Buffer.from(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const p=b64u(Buffer.from(JSON.stringify({aud:u.protocol+'//'+u.host,exp:Math.floor(Date.now()/1000)+43200,sub:cfg().vapidSubject})));
 const sig=crypto.sign('sha256',Buffer.from(h+'.'+p),{key:crypto.createPrivateKey({key:k.jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'});
 return h+'.'+p+'.'+b64u(sig);}
async function sendPush(sub,payload){const k=vapid();if(!k)throw new Error('VAPID keys missing');
 const uaPub=Buffer.from(sub.keys.p256dh,'base64url'),auth=Buffer.from(sub.keys.auth,'base64url');
 const uaKey=crypto.createPublicKey({key:{kty:'EC',crv:'P-256',x:b64u(uaPub.subarray(1,33)),y:b64u(uaPub.subarray(33,65))},format:'jwk'});
 const pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const secret=crypto.diffieHellman({privateKey:pair.privateKey,publicKey:uaKey});
 const jwk=pair.publicKey.export({format:'jwk'});
 const asPub=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]);
 const ikm=hkdf(secret,auth,Buffer.concat([Buffer.from('WebPush: info\0'),uaPub,asPub]),32);
 const salt=crypto.randomBytes(16),cek=hkdf(ikm,salt,'Content-Encoding: aes128gcm\0',16),nonce=hkdf(ikm,salt,'Content-Encoding: nonce\0',12);
 const plain=Buffer.concat([Buffer.from(JSON.stringify(payload),'utf8'),Buffer.from([2])]);
 const c=crypto.createCipheriv('aes-128-gcm',cek,nonce);
 const enc=Buffer.concat([c.update(plain),c.final(),c.getAuthTag()]);
 const rs=Buffer.alloc(4);rs.writeUInt32BE(4096,0);
 const body=Buffer.concat([salt,rs,Buffer.from([65]),asPub,enc]);
 const r=await fetch(sub.endpoint,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm',TTL:'86400',Authorization:'vapid t='+vapidJWT(sub.endpoint)+', k='+k.pub},body});
 if(r.status===404||r.status===410)return {gone:true};return {ok:r.ok,status:r.status};}
async function notifyAdmins(payload){if(!DB_READY()||!vapid())return;try{const subs=await db.all('push_subs','select=*');const dead=[];
 await Promise.allSettled((subs||[]).map(async s=>{try{const r=await sendPush({endpoint:s.endpoint,keys:s.keys},payload);if(r&&r.gone)dead.push(s.id);}catch(e){}}));
 for(const id of dead){try{await db.remove('push_subs','id=eq.'+id);}catch(e){}}}catch(e){}}

/* ---------- 8. uploads ---------- */
async function uploadObject(name,buffer,mime){const c=cfg();const safe=String(name||'file').replace(/[^a-zA-Z0-9._-]/g,'_');
 const path='uploads/'+Date.now()+'-'+uid(4)+'-'+safe;
 if(c.supabaseUrl&&c.supabaseKey){const r=await fetch(c.supabaseUrl.replace(/\/+$/,'')+'/storage/v1/object/'+c.bucket+'/'+path,{method:'POST',headers:{Authorization:'Bearer '+c.supabaseKey,'Content-Type':mime||'application/octet-stream','x-upsert':'true'},body:buffer});
  if(!r.ok)throw new Error('Storage upload failed: '+(await r.text()).slice(0,180));
  return c.supabaseUrl.replace(/\/+$/,'')+'/storage/v1/object/public/'+c.bucket+'/'+path;}
 if(c.blobToken){const r=await fetch('https://vercel.com/api/blob/?pathname='+encodeURIComponent(path),{method:'PUT',headers:{authorization:'Bearer '+c.blobToken,'x-api-version':'12','x-content-type':mime||'application/octet-stream','x-add-random-suffix':'1','x-vercel-blob-access':'public'},body:buffer});
  const j=parseJSON(await r.text(),{});if(!r.ok||!j.url)throw new Error('Blob upload failed: '+JSON.stringify(j).slice(0,180));return j.url;}
 throw new Error('NO_STORAGE_CONFIGURED');}

/* ---------- 9. pricing / slots / promos ---------- */
function unitMult(unit,blocks){return unit==='per_hour'?Math.max(1,Math.ceil(blocks/2)):blocks;}
function priceLine(game,variant,people,blocks){if(game.price===null||game.price===undefined||game.price==='')return null;
 let unit=num(game.price),vname='';const vs=Array.isArray(game.variants)?game.variants:[];
 if(variant){const v=vs.filter(x=>x&&x.name===variant)[0];if(v){vname=v.name;if(v.price!==undefined&&v.price!==null&&v.price!=='')unit=num(v.price);}}
 const m=unitMult(game.price_unit,blocks);
 return {unit,variant:vname,multiplier:m,subtotal:Math.round(unit*people*m*100)/100,unitLabel:game.price_unit||'per_game'};}
function slotsForDay(s,date){const d=new Date(date+'T00:00:00Z'),h=(s.hours||{})[String(d.getUTCDay())];if(!h||!h[0]||!h[1])return [];
 const open=minutesOf(h[0]),close=minutesOf(h[1]),out=[];for(let m=open;m+30<=close;m+=30)out.push(hhmm(m));return out;}
function isClosed(s,date){const d=new Date(date+'T00:00:00Z'),h=(s.hours||{})[String(d.getUTCDay())];return !h||!h[0]||!h[1]||minutesOf(h[1])-minutesOf(h[0])<30;}
function slotIdx(slot){return Math.floor(minutesOf(slot)/30);}
async function checkCapacity(s,game,date,start,blocks,people,ignoreId){const slots=slotsForDay(s,date);const si=slots.indexOf(start);
 if(si<0)return {ok:false,reason:'That time is outside opening hours.'};
 if(si+blocks>slots.length)return {ok:false,reason:'That booking would run past closing time.'};
 const cap=num(game.capacity,1)||1,maxP=num((s.booking||{}).maxPeople,20);
 if(num(people)<1)return {ok:false,reason:'At least one person is required.'};
 if(num(people)>maxP)return {ok:false,reason:'Maximum '+maxP+' people per booking.'};
 try{const rows=await db.all('bookings','select=id,slot_start,blocks,people,status&slot_date=eq.'+date+'&game_id=eq.'+game.id+'&status=in.(pending,paid)');
  let worst=0;
  for(let k=0;k<blocks;k++){const sl=si+k;let used=num(people);
   (rows||[]).forEach(b=>{if(ignoreId&&b.id===ignoreId)return;const bi=slotIdx(b.slot_start);if(sl>=bi&&sl<bi+num(b.blocks,1))used+=num(b.people,1);});
   if(used>worst)worst=used;}
  if(worst>cap)return {ok:false,reason:'Only '+Math.max(0,cap-(worst-num(people)))+' place(s) left in that slot.'};
  return {ok:true};}catch(e){return {ok:true,degraded:true};}}
async function promoByCode(code){const r=await db.all('promos','select=*&code=eq.'+encodeURIComponent(String(code||'').toUpperCase())+'&limit=1');return (r&&r[0])||null;}
async function promoDiscount(p,ctx){if(!p)return {ok:false,reason:'Promo code not found.'};
 if(!p.active)return {ok:false,reason:'This promo is not active.'};
 const t=Date.now();
 if(p.starts_at&&new Date(p.starts_at).getTime()>t)return {ok:false,reason:'This promo has not started yet.'};
 if(p.ends_at&&new Date(p.ends_at).getTime()<t)return {ok:false,reason:'This promo has expired.'};
 const games=Array.isArray(p.games)?p.games:[];if(games.length&&ctx.gameId&&games.indexOf(ctx.gameId)<0)return {ok:false,reason:'This promo does not apply to that game.'};
 if(p.min_amount&&num(ctx.subtotal)<num(p.min_amount))return {ok:false,reason:'Minimum '+money(p.min_amount)+' ETB for this promo.'};
 const days=Array.isArray(p.happy_days)?p.happy_days.map(Number):[];
 if(days.length){const wd=new Date(ctx.date+'T00:00:00Z').getUTCDay(),m=minutesOf(ctx.slot);
  const f=p.happy_from?minutesOf(p.happy_from):0,to=p.happy_to?minutesOf(p.happy_to):1440;
  if(days.indexOf(wd)<0||m<f||m>=to)return {ok:false,reason:'This promo only works during happy hours.'};}
 if(p.max_uses){const used=await db.count('bookings','promo_code=eq.'+encodeURIComponent(p.code)+'&status=eq.paid');if(used>=num(p.max_uses))return {ok:false,reason:'This promo is fully used.'};}
 if(p.per_phone_once&&ctx.phone){const mine=await db.count('bookings','promo_code=eq.'+encodeURIComponent(p.code)+'&phone=eq.'+encodeURIComponent(ctx.phone)+'&status=eq.paid');if(mine>0)return {ok:false,reason:'You already used this promo.'};}
 if(p.first_time_only&&ctx.phone){const tot=await db.count('bookings','phone=eq.'+encodeURIComponent(ctx.phone)+'&status=eq.paid');if(tot>0)return {ok:false,reason:'This promo is for first-time customers only.'};}
 let value=0;
 if(p.type==='free')value=num(ctx.subtotal);
 else if(p.type==='fixed')value=Math.min(num(p.value),num(ctx.subtotal));
 else value=Math.round(num(ctx.subtotal)*num(p.value)/100*100)/100;
 value=Math.max(0,Math.round(value*100)/100);
 return {ok:true,discount:value,type:p.type,code:p.code,message:p.description||''};}

/* ---------- 10. payments ---------- */
function methods(){const c=cfg(),f=[];
 if(c.chapaKey)f.push({id:'chapa',label:'Chapa — card, Telebirr, bank',online:true});
 if(c.telebirr)f.push({id:'telebirr',label:'Telebirr',online:true});
 if(c.cbe)f.push({id:'cbe',label:'CBE bank transfer (owner confirms)',online:false});
 return f;}
async function chapaInit(req,bk,settings){const c=cfg();if(!c.chapaKey)return {ok:false,reason:'CHAPA_NOT_CONFIGURED'};
 const txRef='NFZ-'+bk.code+'-'+Date.now().toString(36),site=c.siteUrl||('https://'+(req.headers.host||'localhost'));
 const r=await fetch('https://api.chapa.co/v1/transaction/initialize',{method:'POST',headers:{Authorization:'Bearer '+c.chapaKey,'Content-Type':'application/json'},
  body:JSON.stringify({amount:money(bk.total),currency:'ETB',first_name:String(bk.name||'Guest').split(' ')[0],last_name:String(bk.name||'').split(' ').slice(1).join(' ')||'Customer',
   phone_number:bk.phone||'',tx_ref:txRef,callback_url:site+'/api/payments/chapa/webhook',return_url:site+'/?ticket='+encodeURIComponent(bk.code),
   customization:{title:settings.brand.name,description:'Booking '+bk.code}})});
 const j=parseJSON(await r.text(),{});
 if(!r.ok||!j.data||!j.data.checkout_url)return {ok:false,reason:(j&&j.message)||('Chapa error '+r.status)};
 await db.insert('payments',[{booking_id:bk.id,booking_code:bk.code,method:'chapa',amount:bk.total,currency:'ETB',status:'pending',reference:txRef,raw:j}]);
 return {ok:true,checkout_url:j.data.checkout_url,tx_ref:txRef};}
async function chapaVerify(txRef){const c=cfg();if(!c.chapaKey)return null;
 const r=await fetch('https://api.chapa.co/v1/transaction/verify/'+encodeURIComponent(txRef),{headers:{Authorization:'Bearer '+c.chapaKey}});
 const j=parseJSON(await r.text(),{});return (j&&j.data)||null;}
function chapaSignatureOK(raw,header){const c=cfg();if(!header)return false;const secret=c.chapaSecret||c.chapaKey||'';if(!secret)return false;
 try{return safeEqual(crypto.createHmac('sha256',secret).update(raw,'utf8').digest('hex'),String(header));}catch(e){return false;}}
/* Telebirr H5 C2B — NEEDS AN APPROVED MERCHANT ACCOUNT. Scaffold until keys are live. */
async function telebirrInit(bk,settings){const t=cfg().telebirr;if(!t)return {ok:false,reason:'TELEBIRR_NOT_CONFIGURED'};
 const tr=await fetch(t.base+'/payment/v1/token',{method:'POST',headers:{'Content-Type':'application/json','X-APP-Key':t.fabricAppId},body:JSON.stringify({appSecret:t.appSecret})});
 const tj=parseJSON(await tr.text(),{});const token=tj&&(tj.token||(tj.data&&tj.data.token));
 if(!token)return {ok:false,reason:'Telebirr fabric token failed'};
 const site=cfg().siteUrl||'';
 const biz={notify_url:site+'/api/payments/telebirr/notify',redirect_url:site+'/?ticket='+encodeURIComponent(bk.code),appid:t.merchantAppId,merch_code:t.merchantCode,
  business_type:'BuyGoods',merch_order_id:'NFZ'+bk.code,trade_type:'Checkout',title:settings.brand.name+' booking',total_amount:money(bk.total),trans_currency:'ETB',timeout_express:'120m',callback_info:bk.code};
 function signStr(s){const g=crypto.createSign('RSA-SHA256');g.update(s);g.end();
  try{return g.sign({key:t.privateKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:32},'base64');}catch(e){return g.sign(t.privateKey,'base64');}}
 const r=await fetch(t.base+'/payment/v1/merchant/preOrder',{method:'POST',headers:{'Content-Type':'application/json','X-APP-Key':t.fabricAppId,Authorization:token},
  body:JSON.stringify({timestamp:String(Date.now()),nonce_str:uid(8),method:'payment.preorder',version:'1.0',biz_content:biz,sign:signStr(JSON.stringify(biz)),sign_type:'SHA256WithRSA'})});
 const j=parseJSON(await r.text(),{}),bc=j&&(j.biz_content||(j.data&&j.data.biz_content));
 if(!bc||!bc.prepay_id)return {ok:false,reason:(j&&j.msg)||'Telebirr pre-order failed'};
 const params=['appid='+t.merchantAppId,'merch_code='+t.merchantCode,'nonce_str='+uid(8),'prepay_id='+bc.prepay_id,'timestamp='+Date.now()].join('&');
 const url=t.web+'?'+params+'&sign='+encodeURIComponent(signStr(params))+'&sign_type=SHA256WithRSA&version=1.0&trade_type=Checkout';
 await db.insert('payments',[{booking_id:bk.id,booking_code:bk.code,method:'telebirr',amount:bk.total,currency:'ETB',status:'pending',reference:'NFZ'+bk.code,raw:j}]);
 return {ok:true,checkout_url:url};}

/* ---------- 11. entity registry ---------- */
const ENTITIES={
 games:{label:'Games',table:'games',order:'sort_order.asc,created_at.asc',reorder:true,fields:[
  {k:'name',t:'text',label:'Name',required:true},{k:'description',t:'textarea',label:'Description'},
  {k:'price',t:'number',label:'Price (ETB)',hint:'Empty = "Ask at the zone" and no Order button.'},
  {k:'price_unit',t:'select',label:'Price unit',options:[['per_30_min','per 30 min'],['per_hour','per hour'],['per_game','per game']]},
  {k:'variants',t:'kvlist',label:'Variants (name + optional price)'},{k:'capacity',t:'number',label:'Capacity at the same time'},
  {k:'age_note',t:'text',label:'Age note'},{k:'bring',t:'text',label:'What to bring'},{k:'health_warning',t:'text',label:'Health warning'},
  {k:'photos',t:'photos',label:'Photos (auto-slide, first = cover)'},{k:'visible',t:'bool',label:'Visible'},{k:'sort_order',t:'number',label:'Order'}]},
 bookings:{label:'Bookings',table:'bookings',order:'created_at.desc',money:true,fields:[
  {k:'code',t:'text',label:'Code',readonly:true},{k:'game_name',t:'text',label:'Game',readonly:true},{k:'variant',t:'text',label:'Variant',readonly:true},
  {k:'slot_date',t:'text',label:'Date',readonly:true},{k:'slot_start',t:'text',label:'Start',readonly:true},{k:'blocks',t:'number',label:'Blocks',readonly:true},
  {k:'people',t:'number',label:'People',readonly:true},{k:'name',t:'text',label:'Name'},{k:'phone',t:'text',label:'Phone'},
  {k:'promo_code',t:'text',label:'Promo',readonly:true},{k:'subtotal',t:'number',label:'Subtotal',readonly:true},{k:'discount',t:'number',label:'Discount',readonly:true},
  {k:'total',t:'number',label:'Total',readonly:true},{k:'status',t:'select',label:'Status',options:[['pending','pending'],['paid','paid'],['cancelled','cancelled'],['refunded','refunded']]},
  {k:'internal_note',t:'textarea',label:'Internal note'}]},
 payments:{label:'Payments',table:'payments',order:'created_at.desc',money:true,ownerOnly:true,fields:[
  {k:'booking_code',t:'text',label:'Booking',readonly:true},{k:'method',t:'select',label:'Method',readonly:true,options:[['chapa','chapa'],['telebirr','telebirr'],['cbe','cbe'],['none','none']]},
  {k:'amount',t:'number',label:'Amount',readonly:true},{k:'status',t:'select',label:'Status',options:[['pending','pending'],['paid','paid'],['failed','failed'],['refunded','refunded']]},
  {k:'reference',t:'text',label:'Reference'},{k:'note',t:'textarea',label:'Note'}]},
 promos:{label:'Promos',table:'promos',order:'created_at.desc',money:true,fields:[
  {k:'code',t:'text',label:'Code',required:true},{k:'description',t:'text',label:'Description'},
  {k:'type',t:'select',label:'Type',options:[['percent','percent'],['fixed','fixed ETB'],['free','100% free']]},
  {k:'value',t:'number',label:'Value (percent or ETB)'},{k:'active',t:'bool',label:'Active'},
  {k:'starts_at',t:'datetime',label:'Starts'},{k:'ends_at',t:'datetime',label:'Ends'},{k:'max_uses',t:'number',label:'Total uses'},
  {k:'min_amount',t:'number',label:'Minimum amount'},{k:'first_time_only',t:'bool',label:'First-time only'},{k:'per_phone_once',t:'bool',label:'One use per phone'},
  {k:'games',t:'json',label:'Selected games (JSON ids, [] = all)'},{k:'happy_days',t:'json',label:'Happy days [0=Sun..6=Sat]'},
  {k:'happy_from',t:'text',label:'Happy from HH:MM'},{k:'happy_to',t:'text',label:'Happy to HH:MM'}]},
 reviews:{label:'Reviews',table:'reviews',order:'created_at.desc',fields:[
  {k:'author',t:'text',label:'Author'},{k:'rating',t:'number',label:'Rating 1-5'},{k:'body',t:'textarea',label:'Review'},
  {k:'status',t:'select',label:'Status',options:[['pending','pending'],['approved','approved'],['rejected','rejected']]},{k:'featured',t:'bool',label:'Featured'}]},
 events:{label:'Tournaments',table:'events',order:'starts_at.asc',reorder:true,fields:[
  {k:'title',t:'text',label:'Title'},{k:'description',t:'textarea',label:'Description'},{k:'entry_fee',t:'number',label:'Entry fee'},
  {k:'starts_at',t:'datetime',label:'Starts at'},{k:'registration_open',t:'bool',label:'Registration open'},{k:'capacity',t:'number',label:'Capacity'},
  {k:'cover',t:'photo',label:'Cover photo'},{k:'status',t:'select',label:'Status',options:[['draft','draft'],['published','published']]},
  {k:'visible',t:'bool',label:'Visible'},{k:'bracket',t:'json',label:'Bracket (JSON)'},{k:'results',t:'json',label:'Results (JSON)'}]},
 registrations:{label:'Registrations',table:'event_registrations',order:'created_at.desc',fields:[
  {k:'name',t:'text',label:'Name'},{k:'phone',t:'text',label:'Phone'},{k:'team_name',t:'text',label:'Team'},
  {k:'status',t:'select',label:'Status',options:[['pending','pending'],['confirmed','confirmed'],['cancelled','cancelled']]},{k:'paid',t:'bool',label:'Paid'},{k:'note',t:'textarea',label:'Note'}]},
 gallery:{label:'Gallery',table:'gallery',order:'sort_order.asc',reorder:true,fields:[
  {k:'url',t:'photo',label:'Photo'},{k:'caption',t:'text',label:'Caption'},{k:'visible',t:'bool',label:'Visible'},{k:'sort_order',t:'number',label:'Order'}]},
 faqs:{label:'FAQ',table:'faqs',order:'sort_order.asc',reorder:true,fields:[
  {k:'question',t:'text',label:'Question'},{k:'answer',t:'textarea',label:'Answer'},{k:'visible',t:'bool',label:'Visible'},{k:'sort_order',t:'number',label:'Order'}]}};
function writable(name){return ENTITIES[name].fields.filter(f=>!f.readonly).map(f=>f.k);}
function sanitizeRow(name,body){const out={};
 ENTITIES[name].fields.forEach(f=>{if(f.readonly)return;if(!(f.k in body))return;let v=body[f.k];
  if(f.t==='number')v=(v===''||v===null||v===undefined)?null:num(v);
  if(f.t==='bool')v=!!v;
  if(f.t==='kvlist'||f.t==='json'||f.t==='photos')v=(typeof v==='string')?parseJSON(v,[]):v;
  if(typeof v==='string')v=v.slice(0,4000);out[f.k]=v;});
 if(name==='promos'&&out.code)out.code=String(out.code).toUpperCase().replace(/[^A-Z0-9_-]/g,'');
 return out;}

/* ---------- 12. router ---------- */
const ROUTES=[];
function route(m,p,fn){ROUTES.push({m,p,fn});}
function match(pat,path){const a=pat.split('/'),b=path.split('/');if(a.length!==b.length)return null;const out={};
 for(let i=0;i<a.length;i++){if(a[i].charAt(0)===':')out[a[i].slice(1)]=decodeURIComponent(b[i]);else if(a[i]!==b[i])return null;}return out;}

route('GET','/api/health',async(req,res)=>{const c=cfg();json(res,200,{ok:true,database:DB_READY()?'configured':'missing',chapa:!!c.chapaKey,telebirr:!!c.telebirr,cbe:!!c.cbe,
 storage:(c.supabaseUrl&&c.supabaseKey)?'supabase':(c.blobToken?'vercel-blob':'none'),push:!!vapid(),creator_panel:!!c.creatorPath,portfolio_link:!!c.portfolio,version:'1.0.0'});});

route('GET','/api/bootstrap',async(req,res)=>{const s=await getSettings(),c=cfg();
 const out={settings:publicSettings(s),games:[],faqs:[],gallery:[],reviews:[],events:[],blockedDates:[],paymentMethods:methods(),db:DB_READY(),
  siteUrl:c.siteUrl||('https://'+(req.headers.host||'')),portfolio:c.portfolio||'',qr:s.qr_service||''};
 if(DB_READY()){try{
  out.games=await db.all('games','select=*&visible=eq.true&order=sort_order.asc');
  out.faqs=await db.all('faqs','select=*&visible=eq.true&order=sort_order.asc');
  out.gallery=await db.all('gallery','select=*&visible=eq.true&order=sort_order.asc');
  out.reviews=await db.all('reviews','select=id,author,rating,body,featured,created_at&status=eq.approved&order=created_at.desc&limit=24');
  out.events=await db.all('events','select=*&visible=eq.true&status=eq.published&order=starts_at.asc');
  out.blockedDates=(await db.all('blocked_dates','select=day,reason')||[]).map(x=>x.day);
 }catch(e){out.dbError=String(e.message||e);}}
 json(res,200,out);});

route('GET','/api/availability',async(req,res)=>{const u=new URL(req.url,'http://x'),gid=u.searchParams.get('game'),date=u.searchParams.get('date');
 if(!DB_READY())return json(res,200,{slots:[],degraded:true});
 if(!gid||!date)return json(res,400,{error:'game and date are required'});
 const s=await getSettings();if(isClosed(s,date))return json(res,200,{closed:true,slots:[]});
 const game=(await db.all('games','select=*&id=eq.'+encodeURIComponent(gid)+'&limit=1'))[0];
 if(!game)return json(res,404,{error:'Game not found'});
 const slots=slotsForDay(s,date),rows=await db.all('bookings','select=slot_start,blocks,people&slot_date=eq.'+date+'&game_id=eq.'+game.id+'&status=in.(pending,paid)');
 const cap=num(game.capacity,1);
 json(res,200,{slots:slots.map(sl=>{const idx=slotIdx(sl);let used=0;
  (rows||[]).forEach(b=>{const bi=slotIdx(b.slot_start);if(idx>=bi&&idx<bi+num(b.blocks,1))used+=num(b.people,1);});
  return {slot:sl,used,capacity:cap,left:Math.max(0,cap-used)};}),capacity:cap,maxPeople:num((s.booking||{}).maxPeople,20)});});

route('POST','/api/promo/check',async(req,res)=>{if(!(await rateLimit('promo:'+clientIp(req),30,3600)).ok)return json(res,429,{error:'Too many attempts.'});
 if(!DB_READY())return json(res,200,{ok:false,reason:'Promo system is not configured yet.'});
 const b=await readJSON(req),p=await promoByCode(b.code||'');
 if(!p)return json(res,200,{ok:false,reason:'Promo code not found.'});
 const s=await getSettings();
 json(res,200,await promoDiscount(p,{subtotal:num(b.subtotal),phone:b.phone||'',gameId:b.gameId||'',date:b.date||dayKey(new Date()),slot:b.slot||'00:00',settings:s}));});

route('POST','/api/bookings',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Booking is not available yet: the database is not configured.'});
 if(!(await rateLimit('book:'+clientIp(req),12,3600)).ok)return json(res,429,{error:'Too many booking attempts from this network. Please call us.'});
 const b=await readJSON(req),s=await getSettings();
 if(!(s.features||{}).booking)return json(res,403,{error:'Booking is switched off right now.'});
 if(b.website)return json(res,400,{error:'Bot detected.'});
 const gameId=String(b.gameId||''),people=clampInt(b.people,1,num((s.booking||{}).maxPeople,20),1),blocks=clampInt(b.blocks,1,16,1);
 const date=String(b.date||''),start=String(b.slot||''),name=String(b.name||'').trim().slice(0,80),phone=String(b.phone||'').trim().slice(0,25);
 if(!gameId||!date||!start||!name||!phone)return json(res,400,{error:'Please fill game, date, time, name and phone.'});
 if(!/^[0-9+ ]{7,20}$/.test(phone))return json(res,400,{error:'Please enter a valid phone number.'});
 if(date<dayKey(new Date())||date>dayKey(new Date(Date.now()+num((s.booking||{}).maxDaysAhead,30)*86400000)))return json(res,400,{error:'That date is outside the booking window.'});
 const game=(await db.all('games','select=*&id=eq.'+encodeURIComponent(gameId)+'&limit=1'))[0];
 if(!game||!game.visible)return json(res,404,{error:'Game not found'});
 const price=priceLine(game,b.variant,people,blocks);
 if(!price)return json(res,400,{error:'This game has no price yet — please ask at the zone.'});
 if(await db.count('blocked_dates','day=eq.'+date)>0)return json(res,400,{error:'That date is closed.'});
 let cap=await checkCapacity(s,game,date,start,blocks,people,null);
 if(!cap.ok)return json(res,409,{error:cap.reason});
 let discount=0,promoCode=null;
 if(b.promo){const p=await promoByCode(b.promo);const d=await promoDiscount(p,{subtotal:price.subtotal,phone,gameId:game.id,date,slot:start,settings:s});
  if(!d.ok)return json(res,400,{error:d.reason});discount=d.discount;promoCode=p.code;}
 const total=Math.max(0,Math.round((price.subtotal-discount)*100)/100);
 cap=await checkCapacity(s,game,date,start,blocks,people,null);
 if(!cap.ok)return json(res,409,{error:'That slot was just taken. Please pick another time.'});
 let code=code6();
 for(let i=0;i<5;i++){if(await db.count('bookings','code=eq.'+code)===0)break;code=code6();}
 const row={code,game_id:game.id,game_name:game.name,variant:price.variant||'',slot_date:date,slot_start:start,slot_minutes:30,blocks,people,name,phone,
  promo_code:promoCode,unit_price:price.unit,unit_label:price.unitLabel,subtotal:price.subtotal,discount,total,status:total===0?'paid':'pending'};
 const created=(await db.insert('bookings',[row]))[0];
 if(total===0)await db.insert('payments',[{booking_id:created.id,booking_code:code,method:'none',amount:0,status:'paid',reference:promoCode||'free',confirmed_by:'free'}]);
 await audit('customer','public','booking.created',code,{game:game.name,total},req);
 notifyAdmins({title:'New booking '+code,body:game.name+' — '+date+' '+start+' — '+money(total)+' ETB',url:'/admin'});
 json(res,201,{booking:created,free:total===0,methods:methods()});});

route('POST','/api/bookings/lookup',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 if(!(await rateLimit('lookup:'+clientIp(req),30,3600)).ok)return json(res,429,{error:'Too many lookups.'});
 const b=await readJSON(req),code=String(b.code||'').toUpperCase(),phone=String(b.phone||'');
 if(!code||!phone)return json(res,400,{error:'Booking code and phone are required.'});
 const rows=await db.all('bookings','select=*&code=eq.'+encodeURIComponent(code)+'&phone=eq.'+encodeURIComponent(phone)+'&limit=1');
 if(!rows.length)return json(res,404,{error:'No booking matches that code and phone number.'});
 json(res,200,{booking:rows[0],payments:await db.all('payments','select=method,status,amount,reference&booking_code=eq.'+encodeURIComponent(code)+'&order=created_at.desc'),methods:methods()});});

route('POST','/api/bookings/cancel',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 const b=await readJSON(req),code=String(b.code||'').toUpperCase(),phone=String(b.phone||'');
 const rows=await db.all('bookings','select=*&code=eq.'+encodeURIComponent(code)+'&phone=eq.'+encodeURIComponent(phone)+'&limit=1');
 if(!rows.length)return json(res,404,{error:'Booking not found.'});
 if(rows[0].status==='paid')return json(res,400,{error:'Paid bookings must be cancelled by the zone. Please call us.'});
 if(rows[0].status==='cancelled')return json(res,200,{booking:rows[0]});
 const upd=(await db.update('bookings','id=eq.'+rows[0].id,{status:'cancelled',updated_at:nowISO()}))[0];
 await audit('customer','public','booking.cancelled',code,{},req);json(res,200,{booking:upd});});

route('POST','/api/bookings/reschedule',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 const b=await readJSON(req),s=await getSettings(),code=String(b.code||'').toUpperCase(),phone=String(b.phone||'');
 const rows=await db.all('bookings','select=*&code=eq.'+encodeURIComponent(code)+'&phone=eq.'+encodeURIComponent(phone)+'&limit=1');
 if(!rows.length)return json(res,404,{error:'Booking not found.'});
 if(rows[0].status==='paid')return json(res,400,{error:'Paid bookings must be moved by the zone. Please call us.'});
 const game=(await db.all('games','select=*&id=eq.'+rows[0].game_id+'&limit=1'))[0];
 if(!game)return json(res,404,{error:'Game not found.'});
 const cap=await checkCapacity(s,game,String(b.date),String(b.slot),num(rows[0].blocks,1),num(rows[0].people,1),rows[0].id);
 if(!cap.ok)return json(res,409,{error:cap.reason});
 const upd=(await db.update('bookings','id=eq.'+rows[0].id,{slot_date:String(b.date),slot_start:String(b.slot),updated_at:nowISO()}))[0];
 await audit('customer','public','booking.rescheduled',code,{to:b.date+' '+b.slot},req);
 json(res,200,{booking:upd,priceLocked:true});});

route('POST','/api/reviews',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 if(!(await rateLimit('review:'+clientIp(req),5,86400)).ok)return json(res,429,{error:'Too many reviews from this network.'});
 const b=await readJSON(req);if(b.website)return json(res,400,{error:'Bot detected.'});
 const author=String(b.author||'').trim().slice(0,60),body=String(b.body||'').trim().slice(0,1200);
 if(!author||!body)return json(res,400,{error:'Please add your name and a short review.'});
 const row=(await db.insert('reviews',[{author,rating:clampInt(b.rating,1,5,5),body,status:'pending'}]))[0];
 await audit('customer','public','review.submitted',row.id,{},req);
 notifyAdmins({title:'New review waiting',body:author+': '+body.slice(0,80),url:'/admin'});json(res,201,{ok:true,review:row});});

route('POST','/api/events/:id/register',async(req,res,p)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 if(!(await rateLimit('event:'+clientIp(req),10,3600)).ok)return json(res,429,{error:'Too many registrations.'});
 const b=await readJSON(req);if(b.website)return json(res,400,{error:'Bot detected.'});
 const ev=(await db.all('events','select=*&id=eq.'+encodeURIComponent(p.id)+'&limit=1'))[0];
 if(!ev||!ev.registration_open)return json(res,403,{error:'Registration is closed.'});
 const name=String(b.name||'').trim().slice(0,80),phone=String(b.phone||'').trim().slice(0,25);
 if(!name||!phone)return json(res,400,{error:'Name and phone are required.'});
 if(ev.capacity&&(await db.count('event_registrations','event_id=eq.'+ev.id+'&status=neq.cancelled'))>=num(ev.capacity))return json(res,409,{error:'This tournament is full.'});
 const row=(await db.insert('event_registrations',[{event_id:ev.id,name,phone,team_name:String(b.team||'').slice(0,60)}]))[0];
 notifyAdmins({title:'Tournament registration',body:name+' -> '+ev.title,url:'/admin'});json(res,201,{ok:true,registration:row});});

/* payments */
route('POST','/api/payments/chapa/init',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 if(!cfg().chapaKey)return json(res,400,{error:'Chapa is not configured.'});
 const b=await readJSON(req);
 const rows=await db.all('bookings','select=*&code=eq.'+encodeURIComponent(String(b.code||'').toUpperCase())+'&limit=1');
 if(!rows.length)return json(res,404,{error:'Booking not found.'});
 if(rows[0].status==='paid')return json(res,400,{error:'This booking is already paid.'});
 try{const r=await chapaInit(req,rows[0],await getSettings());if(!r.ok)return json(res,502,{error:r.reason});json(res,200,r);}
 catch(e){json(res,502,{error:'Could not reach Chapa: '+String(e.message||e)});}});

route('POST','/api/payments/chapa/webhook',async(req,res)=>{const raw=await readRaw(req),h=req.headers||{};
 const sig=h['chapa-signature']||h['x-chapa-signature']||'',okSig=chapaSignatureOK(raw,sig),body=parseJSON(raw,{});
 if(DB_READY()){try{await db.insert('webhook_log',[{provider:'chapa',signature_ok:okSig,body,headers:{sig:String(sig).slice(0,80)},note:okSig?'verified':'signature missing or invalid'}]);}catch(e){}}
 if(!okSig)return json(res,401,{error:'Invalid signature',logged:true});
 const txRef=(body&&(body.tx_ref||body.reference||(body.data&&body.data.tx_ref)))||'';
 if(!txRef)return json(res,400,{error:'No tx_ref in payload'});
 const verified=await chapaVerify(txRef);
 const paid=!!(verified&&String(verified.status||'').toLowerCase()==='success');
 if(!DB_READY())return json(res,200,{received:true,db:'missing'});
 const pays=await db.all('payments','select=*&reference=eq.'+encodeURIComponent(txRef)+'&limit=1');
 if(pays.length){await db.update('payments','id=eq.'+pays[0].id,{status:paid?'paid':'failed',confirmed_by:'webhook',raw:{verified:verified||null,webhook:body},updated_at:nowISO()});
  if(paid)await markPaid(pays[0].booking_id,pays[0].booking_code);}
 json(res,200,{received:true,paid});});

async function markPaid(bookingId,code){try{const bk=(await db.all('bookings','select=*&id=eq.'+bookingId+'&limit=1'))[0];if(!bk)return;
 if(bk.status!=='paid'){await db.update('bookings','id=eq.'+bookingId,{status:'paid',updated_at:nowISO()});
  await audit('system','system','booking.paid',code||bk.code,{total:bk.total},{headers:{}});
  notifyAdmins({title:'Payment confirmed '+(code||bk.code),body:money(bk.total)+' ETB received.',url:'/admin'});}}catch(e){}}

route('POST','/api/payments/telebirr/init',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 if(!cfg().telebirr)return json(res,400,{error:'Telebirr is not configured (an approved merchant account is required).'});
 const b=await readJSON(req);
 const rows=await db.all('bookings','select=*&code=eq.'+encodeURIComponent(String(b.code||'').toUpperCase())+'&limit=1');
 if(!rows.length)return json(res,404,{error:'Booking not found.'});
 try{const r=await telebirrInit(rows[0],await getSettings());if(!r.ok)return json(res,502,{error:r.reason});json(res,200,r);}
 catch(e){json(res,502,{error:'Telebirr error: '+String(e.message||e)});}});

route('POST','/api/payments/telebirr/notify',async(req,res)=>{const body=parseJSON(await readRaw(req),{});
 if(DB_READY()){try{await db.insert('webhook_log',[{provider:'telebirr',signature_ok:null,body,headers:{},note:'notify received — confirm against Telebirr queryOrder before trusting'}]);}catch(e){}}
 json(res,200,{code:0,msg:'success'});});

route('POST','/api/payments/manual',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 const b=await readJSON(req),code=String(b.code||'').toUpperCase(),reference=String(b.reference||'').trim().slice(0,80);
 if(!code||!reference)return json(res,400,{error:'Booking code and transaction reference are required.'});
 const rows=await db.all('bookings','select=*&code=eq.'+encodeURIComponent(code)+'&limit=1');
 if(!rows.length)return json(res,404,{error:'Booking not found.'});
 let shot='';
 if(b.screenshot&&String(b.screenshot).indexOf('data:')===0){const m=String(b.screenshot).match(/^data:([^;]+);base64,(.+)$/);
  if(m){try{shot=await uploadObject('receipt-'+code+'.jpg',Buffer.from(m[2],'base64'),m[1]);}catch(e){shot='';}}}
 await db.insert('payments',[{booking_id:rows[0].id,booking_code:code,method:'cbe',amount:rows[0].total,currency:'ETB',status:'pending',reference,raw:{screenshot:shot,note:'owner must confirm'}}]);
 notifyAdmins({title:'Bank transfer to confirm',body:code+' — ref '+reference,url:'/admin'});
 await audit('customer','public','payment.manual_submitted',code,{reference},req);
 json(res,201,{ok:true,pending:true,message:'We will confirm your transfer shortly. Your booking code is '+code+'.'});});

/* auth */
route('POST','/api/auth/login',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Admin login needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'});
 if(!(await rateLimit('login:'+clientIp(req),10,900)).ok)return json(res,429,{error:'Too many attempts. Please wait 15 minutes.'});
 const b=await readJSON(req),username=String(b.username||'').trim().toLowerCase(),pw=String(b.password||'');
 const a=(await db.all('admins','select=*&username=eq.'+encodeURIComponent(username)+'&limit=1'))[0];
 await audit(username||'?','anon','auth.login_attempt',username,{ok:false},req);
 if(!a||!a.active||!verifyPassword(pw,a.password_hash))return json(res,401,{error:'Wrong username or password.'});
 const keys=await db.count('passkeys','admin_id=eq.'+a.id);
 if(keys>0&&!b.recovery)return json(res,403,{error:'This account uses a passkey. Use your device passkey or a recovery code.',passkey_only:true});
 const token=await createSession(a.id,'admin',req);
 await db.update('admins','id=eq.'+a.id,{last_login:nowISO()});
 await audit(a.username,a.role,'auth.login',a.username,{method:b.recovery?'recovery+password':'password'},req);
 notifyAdmins({title:'New admin login',body:a.username+' from '+clientIp(req),url:'/admin'});
 json(res,200,{ok:true,admin:{id:a.id,username:a.username,role:a.role,display_name:a.display_name,must_change_password:!!a.must_change_password}},{'Set-Cookie':cookieHeader('natof_session',token,SESS_H.admin*3600,isSecure(req))});});

route('POST','/api/auth/logout',async(req,res)=>{const s=await getSession(req);
 if(s&&s.sessionId){try{await db.update('admin_sessions','id=eq.'+s.sessionId,{revoked:true});}catch(e){}}
 json(res,200,{ok:true},{'Set-Cookie':cookieHeader('natof_session','',0,isSecure(req))});});

route('GET','/api/auth/me',async(req,res)=>{const s=await getSession(req);if(!s)return json(res,401,{error:'Not signed in'});
 const out={admin:{id:s.adminId,username:s.username,role:s.role,display_name:s.display_name,must_change_password:!!s.must_change_password},scope:s.scope};
 if(s.scope==='admin'){try{out.passkeys=await db.all('passkeys','select=id,label,created_at,last_used&admin_id=eq.'+s.adminId);}catch(e){out.passkeys=[];}}
 json(res,200,out);});

route('POST','/api/auth/password',async(req,res)=>{const s=await getSession(req);if(!s||s.scope!=='admin')return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req),a=(await db.all('admins','select=*&id=eq.'+s.adminId+'&limit=1'))[0];
 if(!verifyPassword(String(b.current||''),a.password_hash))return json(res,403,{error:'Current password is wrong.'});
 const next=String(b.next||'');if(next.length<8)return json(res,400,{error:'New password must be at least 8 characters.'});
 await db.update('admins','id=eq.'+s.adminId,{password_hash:hashPassword(next),must_change_password:false});
 await db.update('admin_sessions','admin_id=eq.'+s.adminId+'&id=neq.'+s.sessionId,{revoked:true});
 await audit(s.username,s.role,'auth.password_changed',s.username,{},req);
 notifyAdmins({title:'Password changed',body:s.username,url:'/admin'});
 json(res,200,{ok:true,message:'Password changed. Other sessions were signed out.'});});

/* passkeys */
const CH_MAX=5*60*1000;
function rpFor(req){return rpInfo(req);}
route('POST','/api/auth/passkey/register/begin',async(req,res)=>{const s=await getSession(req);if(!s||s.scope!=='admin')return json(res,401,{error:'Not signed in'});
 const ch=newChallenge(),rp=rpFor(req);
 json(res,200,{challenge:ch,token:signToken('wa:'+s.adminId+':'+ch+':'+Date.now()),rp:{id:rp.rpId,name:'NATOF GameZone'},
  user:{id:b64u(Buffer.from(s.adminId)),name:s.username,displayName:s.display_name||s.username},
  excludeCredentials:((await db.all('passkeys','select=credential_id&admin_id=eq.'+s.adminId))||[]).map(p=>({id:p.credential_id,type:'public-key'})),
  pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
  authenticatorSelection:{userVerification:'preferred',residentKey:'preferred'},timeout:60000});});

route('POST','/api/auth/passkey/register/finish',async(req,res)=>{const s=await getSession(req);if(!s||s.scope!=='admin')return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req),inner=verifyToken(b.token||'');
 if(!inner)return json(res,400,{error:'Challenge expired. Try again.'});
 const parts=inner.split(':');
 if(Date.now()-num(parts[3])>CH_MAX)return json(res,400,{error:'Challenge expired. Try again.'});
 const rp=rpFor(req);
 try{const r=await verifyRegistration(rp,b,parts[2]);
  if(await db.count('passkeys','credential_id=eq.'+encodeURIComponent(r.credentialId)))return json(res,409,{error:'This device is already registered.'});
  await db.insert('passkeys',[{admin_id:s.adminId,credential_id:r.credentialId,public_key:JSON.stringify(r.jwk),alg:r.alg,label:String(b.label||'device').slice(0,40),counter:r.counter}]);
  await audit(s.username,s.role,'passkey.registered',s.username,{},req);
  notifyAdmins({title:'Passkey added',body:s.username+' registered a new device',url:'/admin'});
  json(res,201,{ok:true});}catch(e){json(res,400,{error:'Passkey registration failed: '+String(e.message||e)});}});

route('POST','/api/auth/passkey/login/begin',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 if(!(await rateLimit('pklogin:'+clientIp(req),20,900)).ok)return json(res,429,{error:'Too many attempts.'});
 const b=await readJSON(req),username=String(b.username||'').trim().toLowerCase();
 const a=(await db.all('admins','select=id,username&username=eq.'+encodeURIComponent(username)+'&limit=1'))[0];
 const ch=newChallenge(),rp=rpFor(req);
 json(res,200,{challenge:ch,token:signToken('wl:'+(a?a.id:'none')+':'+ch+':'+Date.now()),
  allowCredentials:(a?((await db.all('passkeys','select=credential_id&admin_id=eq.'+a.id))||[]):[]).map(p=>({id:p.credential_id,type:'public-key'})),
  rpId:rp.rpId,timeout:60000,userVerification:'preferred'});});

route('POST','/api/auth/passkey/login/finish',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 const b=await readJSON(req),inner=verifyToken(b.token||'');
 if(!inner)return json(res,400,{error:'Challenge expired.'});
 const parts=inner.split(':'),adminId=parts[1];
 if(adminId==='none')return json(res,401,{error:'No passkey for that account.'});
 if(Date.now()-num(parts[3])>CH_MAX)return json(res,400,{error:'Challenge expired.'});
 const pk=(await db.all('passkeys','select=*&credential_id=eq.'+encodeURIComponent(String(b.credentialId||''))+'&limit=1'))[0];
 if(!pk||pk.admin_id!==adminId)return json(res,401,{error:'Unknown device.'});
 try{const r=await verifyAssertion(rpFor(req),b,parts[2],parseJSON(pk.public_key,{}),pk.alg,num(pk.counter));
  await db.update('passkeys','id=eq.'+pk.id,{counter:r.counter,last_used:nowISO()});
  const a=(await db.all('admins','select=*&id=eq.'+adminId+'&limit=1'))[0];
  if(!a||!a.active)return json(res,401,{error:'Account disabled.'});
  const token=await createSession(a.id,'admin',req);
  await db.update('admins','id=eq.'+a.id,{last_login:nowISO()});
  await audit(a.username,a.role,'auth.login',a.username,{method:'passkey'},req);
  notifyAdmins({title:'New admin login (passkey)',body:a.username+' from '+clientIp(req),url:'/admin'});
  json(res,200,{ok:true,admin:{id:a.id,username:a.username,role:a.role,display_name:a.display_name}},{'Set-Cookie':cookieHeader('natof_session',token,SESS_H.admin*3600,isSecure(req))});}
 catch(e){json(res,401,{error:'Passkey check failed: '+String(e.message||e)});}});

route('POST','/api/auth/recovery',async(req,res)=>{if(!DB_READY())return json(res,503,{error:'Database not configured.'});
 if(!(await rateLimit('recover:'+clientIp(req),8,900)).ok)return json(res,429,{error:'Too many attempts.'});
 const b=await readJSON(req),username=String(b.username||'').trim().toLowerCase(),code=String(b.code||'').trim().toUpperCase();
 const a=(await db.all('admins','select=*&username=eq.'+encodeURIComponent(username)+'&limit=1'))[0];
 if(!a)return json(res,401,{error:'Invalid recovery code.'});
 const hash=crypto.createHash('sha256').update(code).digest('hex');
 const rc=(await db.all('recovery_codes','select=*&admin_id=eq.'+a.id+'&used=eq.false&limit=50')).filter(x=>safeEqual(x.code_hash,hash))[0];
 if(!rc){await audit(username,'anon','auth.recovery_failed',username,{},req);return json(res,401,{error:'Invalid recovery code.'});}
 await db.update('recovery_codes','id=eq.'+rc.id,{used:true});
 const temp=uid(6);
 await db.update('admins','id=eq.'+a.id,{password_hash:hashPassword(temp),must_change_password:true});
 await revokeAll(a.id);
 await audit(a.username,a.role,'auth.recovery_used',a.username,{},req);
 json(res,200,{ok:true,temporary_password:temp,message:'Use this temporary password once, then set your own.'});});

/* push */
route('GET','/api/push/key',async(req,res)=>{const k=vapid();json(res,200,{key:k?k.pub:null,enabled:!!k});});
route('POST','/api/push/subscribe',async(req,res)=>{const s=await getSession(req);if(!s||s.scope!=='admin')return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req);
 if(!b.subscription||!b.subscription.endpoint)return json(res,400,{error:'subscription required'});
 try{const ex=await db.all('push_subs','select=id&endpoint=eq.'+encodeURIComponent(b.subscription.endpoint)+'&limit=1');
  if(ex.length)await db.update('push_subs','id=eq.'+ex[0].id,{keys:b.subscription.keys,admin_id:s.adminId});
  else await db.insert('push_subs',[{admin_id:s.adminId,endpoint:b.subscription.endpoint,keys:b.subscription.keys}]);
  json(res,201,{ok:true});}catch(e){json(res,500,{error:String(e.message||e)});}});

/* admin */
async function requireAdmin(req,res,min){const s=await getSession(req);
 if(!s||s.scope!=='admin'){json(res,401,{error:'Not signed in'});return null;}
 if(min==='owner'&&s.role!=='owner'){json(res,403,{error:'Owner access required.'});return null;}return s;}

route('GET','/api/admin/meta',async(req,res)=>{const s=await requireAdmin(req,res);if(!s)return;
 const meta={};Object.keys(ENTITIES).forEach(k=>{if(ENTITIES[k].ownerOnly&&s.role!=='owner')return;
  meta[k]={label:ENTITIES[k].label,fields:ENTITIES[k].fields,reorder:!!ENTITIES[k].reorder,ownerOnly:!!ENTITIES[k].ownerOnly};});
 const c=cfg();
 json(res,200,{meta,settings:await getSettings(),role:s.role,
  providers:{chapa:!!c.chapaKey,telebirr:!!c.telebirr,cbe:!!c.cbe,push:!!vapid(),storage:!!(c.supabaseUrl||c.blobToken)},
  games:await db.all('games','select=id,name&order=sort_order.asc')});});

route('GET','/api/admin/stats',async(req,res)=>{const s=await requireAdmin(req,res);if(!s)return;
 const days=clampInt(new URL(req.url,'http://x').searchParams.get('days'),1,365,30);
 const from=dayKey(new Date(Date.now()-days*86400000)),out={days,from};
 try{
  if(s.role==='owner'){const pays=await db.all('payments','select=amount,status,method,created_at&status=eq.paid&created_at=gte.'+from+'T00:00:00Z&order=created_at.asc');
   const byDay={},byMethod={};let total=0;
   (pays||[]).forEach(p=>{const d=String(p.created_at).slice(0,10);byDay[d]=(byDay[d]||0)+num(p.amount);byMethod[p.method||'none']=(byMethod[p.method||'none']||0)+num(p.amount);total+=num(p.amount);});
   out.revenue={total:Math.round(total*100)/100,byDay,byMethod};}
  const bks=await db.all('bookings','select=status,total,promo_code,created_at&created_at=gte.'+from+'T00:00:00Z');
  const st={},pu={};(bks||[]).forEach(b=>{st[b.status]=(st[b.status]||0)+1;if(b.promo_code)pu[b.promo_code]=(pu[b.promo_code]||0)+1;});
  out.bookings={total:(bks||[]).length,byStatus:st,promoUse:pu};
  out.counts={pendingReviews:await db.count('reviews','status=eq.pending'),events:await db.count('events','select=id'),games:await db.count('games','select=id')};
  out.recent=await db.all('bookings','select=code,game_name,slot_date,slot_start,people,total,status,created_at&order=created_at.desc&limit=10');
 }catch(e){out.error=String(e.message||e);}
 json(res,200,out);});

function listQuery(name,qs){const e=ENTITIES[name];let q='select=*';
 const search=qs.get('search');
 if(search){const s=String(search).replace(/[%,()]/g,'').slice(0,40);
  if(name==='bookings')q+='&or=(code.ilike.*'+s+'*,name.ilike.*'+s+'*,phone.ilike.*'+s+'*)';
  else if(name==='games')q+='&name.ilike.*'+s+'*';
  else if(name==='promos')q+='&code.ilike.*'+s+'*';
  else if(name==='reviews')q+='&or=(author.ilike.*'+s+'*,body.ilike.*'+s+'*)';
  else q+='&or=(title.ilike.*'+s+'*,name.ilike.*'+s+'*,question.ilike.*'+s+'*)';}
 const status=qs.get('status');
 if(status&&ENTITIES[name].fields.filter(f=>f.k==='status').length)q+='&status=eq.'+encodeURIComponent(status);
 const from=qs.get('from');if(from)q+='&created_at=gte.'+encodeURIComponent(from)+'T00:00:00Z';
 const to=qs.get('to');if(to)q+='&created_at=lte.'+encodeURIComponent(to)+'T23:59:59Z';
 if(name==='bookings'){const d=qs.get('date');if(d)q+='&slot_date=eq.'+encodeURIComponent(d);}
 q+='&order='+e.order;
 const limit=clampInt(qs.get('limit'),1,200,25),page=clampInt(qs.get('page'),1,10000,1);
 return q+'&limit='+limit+'&offset='+((page-1)*limit);}

route('GET','/api/admin/:entity',async(req,res,p)=>{const name=p.entity;if(!ENTITIES[name])return json(res,404,{error:'Unknown list'});
 const s=await requireAdmin(req,res);if(!s)return;
 if(ENTITIES[name].ownerOnly&&s.role!=='owner')return json(res,403,{error:'Owner access required.'});
 const qs=new URL(req.url,'http://x').searchParams;
 try{let rows=await db.all(ENTITIES[name].table,listQuery(name,qs));
  if(s.role==='staff'&&name==='bookings')rows=(rows||[]).map(r=>{const o=Object.assign({},r);delete o.total;delete o.subtotal;delete o.discount;delete o.unit_price;return o;});
  json(res,200,{rows:rows||[],page:clampInt(qs.get('page'),1,10000,1)});}catch(e){json(res,500,{error:String(e.message||e)});}});

route('POST','/api/admin/:entity',async(req,res,p)=>{const name=p.entity;if(!ENTITIES[name])return json(res,404,{error:'Unknown list'});
 const s=await requireAdmin(req,res);if(!s)return;
 if(ENTITIES[name].ownerOnly&&s.role!=='owner')return json(res,403,{error:'Owner access required.'});
 const row=sanitizeRow(name,await readJSON(req));
 if(!Object.keys(row).length)return json(res,400,{error:'Nothing to save.'});
 try{if(name==='games'&&(row.sort_order===undefined||row.sort_order===null))row.sort_order=(await db.count('games','select=id'))+1;
  const created=(await db.insert(ENTITIES[name].table,[row]))[0];
  await audit(s.username,s.role,name+'.create',created.id,row,req);json(res,201,{row:created});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('PATCH','/api/admin/:entity/:id',async(req,res,p)=>{const name=p.entity;if(!ENTITIES[name])return json(res,404,{error:'Unknown list'});
 const s=await requireAdmin(req,res);if(!s)return;
 if(ENTITIES[name].ownerOnly&&s.role!=='owner')return json(res,403,{error:'Owner access required.'});
 const row=sanitizeRow(name,await readJSON(req));
 if(!Object.keys(row).length)return json(res,400,{error:'Nothing to save.'});
 try{const upd=(await db.update(ENTITIES[name].table,'id=eq.'+encodeURIComponent(p.id),row))[0];
  await audit(s.username,s.role,name+'.update',p.id,row,req);json(res,200,{row:upd});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('DELETE','/api/admin/:entity/:id',async(req,res,p)=>{const name=p.entity;if(!ENTITIES[name])return json(res,404,{error:'Unknown list'});
 const s=await requireAdmin(req,res);if(!s)return;
 if(ENTITIES[name].ownerOnly&&s.role!=='owner')return json(res,403,{error:'Owner access required.'});
 try{await db.remove(ENTITIES[name].table,'id=eq.'+encodeURIComponent(p.id));
  await audit(s.username,s.role,name+'.delete',p.id,{},req);json(res,200,{ok:true});}catch(e){json(res,400,{error:String(e.message||e)});}});

route('PATCH','/api/admin/reorder/:entity',async(req,res,p)=>{const name=p.entity;
 if(!ENTITIES[name]||!ENTITIES[name].reorder)return json(res,404,{error:'Unknown list'});
 const s=await requireAdmin(req,res);if(!s)return;
 const b=await readJSON(req),ids=Array.isArray(b.ids)?b.ids:[];
 try{for(let i=0;i<ids.length;i++)await db.update(ENTITIES[name].table,'id=eq.'+encodeURIComponent(ids[i]),{sort_order:i+1});
  await audit(s.username,s.role,name+'.reorder','',{count:ids.length},req);json(res,200,{ok:true});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('PUT','/api/admin/settings',async(req,res)=>{const s=await requireAdmin(req,res);if(!s)return;
 const b=await readJSON(req);
 try{const next=await saveSettings(b);await audit(s.username,s.role,'settings.update','site',{keys:Object.keys(b)},req);
  json(res,200,{settings:next});}catch(e){json(res,400,{error:String(e.message||e)});}});

route('POST','/api/admin/upload',async(req,res)=>{const s=await requireAdmin(req,res);if(!s)return;
 const b=await readJSON(req);
 if(!b.data||String(b.data).indexOf('data:')!==0)return json(res,400,{error:'Expected a data: URL.'});
 const m=String(b.data).match(/^data:([^;]+);base64,(.+)$/);
 if(!m)return json(res,400,{error:'Bad image data.'});
 const buf=Buffer.from(m[2],'base64');
 if(buf.length>6*1024*1024)return json(res,413,{error:'Image too large after compression (max 6 MB).'});
 try{json(res,201,{url:await uploadObject(b.name||'photo.jpg',buf,m[1]),size:buf.length});}
 catch(e){if(String(e.message)==='NO_STORAGE_CONFIGURED')return json(res,503,{error:'No photo storage configured. Add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (recommended) or BLOB_READ_WRITE_TOKEN.'});
  json(res,500,{error:String(e.message||e)});}});

route('POST','/api/admin/bookings/:id/confirm-payment',async(req,res,p)=>{const s=await requireAdmin(req,res,'owner');if(!s)return;
 const b=await readJSON(req);
 try{const bk=(await db.all('bookings','select=*&id=eq.'+encodeURIComponent(p.id)+'&limit=1'))[0];
  if(!bk)return json(res,404,{error:'Booking not found'});
  if(b.method)await db.insert('payments',[{booking_id:bk.id,booking_code:bk.code,method:b.method,amount:bk.total,currency:'ETB',status:'paid',reference:b.reference||'',confirmed_by:s.username}]);
  else{const last=(await db.all('payments','select=*&booking_id=eq.'+bk.id+'&order=created_at.desc&limit=1'))[0];
   if(last)await db.update('payments','id=eq.'+last.id,{status:'paid',confirmed_by:s.username,updated_at:nowISO()});
   else await db.insert('payments',[{booking_id:bk.id,booking_code:bk.code,method:'cbe',amount:bk.total,currency:'ETB',status:'paid',confirmed_by:s.username}]);}
  await markPaid(bk.id,bk.code);
  await audit(s.username,s.role,'payment.confirmed',bk.code,{},req);json(res,200,{ok:true});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('POST','/api/admin/payments/:id/refund',async(req,res,p)=>{const s=await requireAdmin(req,res,'owner');if(!s)return;
 const b=await readJSON(req);
 try{const pay=(await db.update('payments','id=eq.'+encodeURIComponent(p.id),{status:'refunded',note:String(b.note||'marked refunded by '+s.username)}))[0];
  if(pay&&pay.booking_id)await db.update('bookings','id=eq.'+pay.booking_id,{status:'refunded',updated_at:nowISO()});
  await audit(s.username,s.role,'payment.refunded',pay?pay.booking_code:'',{note:b.note||''},req);
  json(res,200,{ok:true,warning:'This marks the refund in our records only. If the money already settled, refund it in the Chapa/Telebirr dashboard or by bank transfer.'});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('GET','/api/admin/export/:entity',async(req,res,p)=>{const name=p.entity;if(!ENTITIES[name])return json(res,404,{error:'Unknown list'});
 const s=await requireAdmin(req,res);if(!s)return;
 if(ENTITIES[name].ownerOnly&&s.role!=='owner')return json(res,403,{error:'Owner access required.'});
 const qs=new URL(req.url,'http://x').searchParams;qs.set('limit','200');qs.set('page','1');
 try{const rows=await db.all(ENTITIES[name].table,listQuery(name,qs));
  const cols=ENTITIES[name].fields.map(f=>f.k),lines=[cols.join(',')];
  (rows||[]).forEach(r=>lines.push(cols.map(c=>{const v=r[c]==null?'':(typeof r[c]==='object'?JSON.stringify(r[c]):String(r[c]));return '"'+v.replace(/"/g,'""')+'"';}).join(',')));
  text(res,200,lines.join('\n'),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="'+name+'-'+dayKey(new Date())+'.csv"'});}
 catch(e){json(res,500,{error:String(e.message||e)});}});

route('GET','/api/admin/admins',async(req,res)=>{const s=await requireAdmin(req,res,'owner');if(!s)return;
 try{json(res,200,{rows:await db.all('admins','select=id,username,display_name,role,active,must_change_password,last_login,created_at,created_by&order=created_at.asc')});}
 catch(e){json(res,500,{error:String(e.message||e)});}});

route('POST','/api/admin/admins',async(req,res)=>{const s=await requireAdmin(req,res,'owner');if(!s)return;
 const b=await readJSON(req),username=String(b.username||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,''),pw=String(b.password||'');
 if(username.length<3||pw.length<8)return json(res,400,{error:'Username min 3 chars, password min 8 chars.'});
 try{const row=(await db.insert('admins',[{username,display_name:String(b.display_name||username).slice(0,60),password_hash:hashPassword(pw),role:b.role==='owner'?'owner':'staff',created_by:s.username,must_change_password:true}]))[0];
  await audit(s.username,s.role,'admin.created',username,{role:row.role},req);
  json(res,201,{row:{id:row.id,username:row.username,role:row.role}});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('PATCH','/api/admin/admins/:id',async(req,res,p)=>{const s=await requireAdmin(req,res,'owner');if(!s)return;
 const b=await readJSON(req),patch={};
 if('active' in b)patch.active=!!b.active;
 if('role' in b)patch.role=b.role==='owner'?'owner':'staff';
 if('display_name' in b)patch.display_name=String(b.display_name).slice(0,60);
 if(b.new_password){patch.password_hash=hashPassword(String(b.new_password));patch.must_change_password=true;}
 if(!Object.keys(patch).length)return json(res,400,{error:'Nothing to change.'});
 try{await db.update('admins','id=eq.'+encodeURIComponent(p.id),patch);
  if(b.new_password||b.active===false)await revokeAll(p.id);
  await audit(s.username,s.role,'admin.updated',p.id,{keys:Object.keys(patch)},req);json(res,200,{ok:true});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

/* creator */
route('POST','/api/creator/login',async(req,res)=>{const c=cfg();
 if(!c.creatorToken)return json(res,503,{error:'CREATOR_TOKEN is not set.'});
 if(!DB_READY())return json(res,503,{error:'Supabase is not configured.'});
 if(!(await rateLimit('creator-login:'+clientIp(req),5,900)).ok)return json(res,429,{error:'Too many attempts. Try again in 15 minutes.',retry_after:900});
 const b=await readJSON(req);
 if(!safeEqual(String(b.token||''),c.creatorToken)){await audit('creator','anon','creator.login_failed','',{ip:clientIp(req)},req);return json(res,401,{error:'Invalid token.'});}
 const token=await createSession(null,'creator',req);
 await audit('creator','creator','creator.login','',{},req);
 json(res,200,{ok:true},{'Set-Cookie':cookieHeader('natof_session',token,SESS_H.creator*3600,isSecure(req))});});

const CREATOR_TABLES=['bookings','payments','promos','admins','audit_log','webhook_log','games','events','event_registrations','reviews','gallery','faqs','settings','push_subs'];
route('GET','/api/creator/tables',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const qs=new URL(req.url,'http://x').searchParams,table=String(qs.get('table')||'');
 if(CREATOR_TABLES.indexOf(table)<0)return json(res,400,{error:'Table not allowed.'});
 const limit=clampInt(qs.get('limit'),1,100,25),page=clampInt(qs.get('page'),1,10000,1);
 let q='select=*&limit='+limit+'&offset='+((page-1)*limit);
 const search=String(qs.get('search')||'').replace(/[%,()*]/g,'').slice(0,40),col=String(qs.get('col')||'');
 if(search&&col&&/^[a-z_]{1,32}$/.test(col))q+='&'+col+'=ilike.*'+search+'*';
 const from=String(qs.get('from')||'');if(from&&/^\d{4}-\d{2}-\d{2}$/.test(from))q+='&created_at=gte.'+from+'T00:00:00Z';
 try{const rows=await db.all(table,q);
  if(table==='admins')rows.forEach(r=>{delete r.password_hash;});
  json(res,200,{rows,total:await db.count(table,'select=id'),page,limit,columns:(rows&&rows[0])?Object.keys(rows[0]):[]});}
 catch(e){json(res,500,{error:String(e.message||e)});}});

route('GET','/api/creator/system',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const c=cfg();let dbStatus='missing',counts={};
 if(DB_READY()){try{await db.count('bookings','select=id');dbStatus='ok';
  for(const t of ['bookings','payments','promos','admins','audit_log']){try{counts[t]=await db.count(t,'select=id');}catch(e){counts[t]='error';}}
 }catch(e){dbStatus='error: '+String(e.message||e).slice(0,160);}}
 let recentWebhooks=[];if(DB_READY()){try{recentWebhooks=await db.all('webhook_log','select=id,at,provider,signature_ok,note&order=at.desc&limit=20');}catch(e){}}
 json(res,200,{env:{site_url:!!c.siteUrl,portfolio:!!c.portfolio,supabase:!!c.supabaseUrl,supabase_key:!!c.supabaseKey,storage_bucket:c.bucket,blob:!!c.blobToken,
  session_secret:!!env('SESSION_SECRET'),creator_token:!!c.creatorToken,creator_path:!!c.creatorPath,chapa:!!c.chapaKey,chapa_webhook_secret:!!env('CHAPA_WEBHOOK_SECRET'),
  telebirr:!!c.telebirr,cbe:!!c.cbe,vapid:!!vapid(),google_verification:!!c.googleVerify},
  db:{status:dbStatus,counts},recentWebhooks,node:process.version,now:nowISO()});});

route('PUT','/api/creator/settings',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req);
 try{const next=await saveSettings(b.settings||b);await audit('creator','creator','settings.update','site',{keys:Object.keys(b.settings||b)},req);
  json(res,200,{settings:next});}catch(e){json(res,400,{error:String(e.message||e)});}});

route('POST','/api/creator/maintenance',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req);
 try{await saveSettings({maintenance:{enabled:!!b.enabled,message:String(b.message||'').slice(0,400),until:b.until||''}});
  await audit('creator','creator','maintenance.'+(b.enabled?'on':'off'),'',{},req);json(res,200,{ok:true});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('POST','/api/creator/features',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req);
 try{await saveSettings({features:{booking:!!b.booking,tournaments:!!b.tournaments,payments:!!b.payments,reviews:b.reviews!==false,gallery:b.gallery!==false}});
  await audit('creator','creator','features.update','',b,req);json(res,200,{ok:true});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('POST','/api/creator/admins',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req),username=String(b.username||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'');
 if(username.length<3)return json(res,400,{error:'Username too short.'});
 const pw=b.password?String(b.password):uid(5);
 try{const ex=await db.all('admins','select=id&username=eq.'+encodeURIComponent(username)+'&limit=1');
  if(ex.length){await db.update('admins','id=eq.'+ex[0].id,{password_hash:hashPassword(pw),must_change_password:true,active:true});
   await revokeAll(ex[0].id);await audit('creator','creator','admin.reset_password',username,{},req);
   return json(res,200,{ok:true,username,temporary_password:pw,message:'Password reset. They must change it at next login. All sessions revoked.'});}
  const row=(await db.insert('admins',[{username,display_name:String(b.display_name||username).slice(0,60),password_hash:hashPassword(pw),
   role:b.role==='staff'?'staff':'owner',created_by:'creator',must_change_password:true}]))[0];
  await audit('creator','creator','admin.created',username,{role:row.role},req);
  json(res,201,{ok:true,username,temporary_password:pw,message:'Account created. Give this temporary password to the owner; they must change it at first login.'});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('POST','/api/creator/unlock',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req),username=String(b.username||'').trim().toLowerCase(),pw=uid(5);
 try{const a=(await db.all('admins','select=id,username,role&username=eq.'+encodeURIComponent(username)+'&limit=1'))[0];
  if(!a)return json(res,404,{error:'No such account.'});
  await db.update('admins','id=eq.'+a.id,{password_hash:hashPassword(pw),must_change_password:true,active:true});
  await revokeAll(a.id);try{await db.remove('recovery_codes','admin_id=eq.'+a.id);}catch(e){}
  await audit('creator','creator','admin.unlocked',username,{},req);
  notifyAdmins({title:'Account unlocked by creator',body:username,url:'/admin'});
  json(res,200,{ok:true,username,temporary_password:pw,message:'Account unlocked. Temporary password issued, all sessions revoked, logged in the audit trail.'});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

route('POST','/api/creator/recovery-codes',async(req,res)=>{const s=await getCreator(req);if(!s)return json(res,401,{error:'Not signed in'});
 const b=await readJSON(req);
 try{const a=(await db.all('admins','select=id&username=eq.'+encodeURIComponent(String(b.username||'').toLowerCase())+'&limit=1'))[0];
  if(!a)return json(res,404,{error:'No such account.'});
  const codes=await makeRecoveryCodes(a.id,8);
  await audit('creator','creator','admin.recovery_codes',b.username,{},req);
  json(res,201,{ok:true,codes,message:'Show these once. They are stored hashed and cannot be shown again.'});}
 catch(e){json(res,400,{error:String(e.message||e)});}});

/* ---------- 13. CSS ---------- */
const CSS=[
':root{--accent:#ff6a3d;--accent-2:#ffb03a;--bg:#0b0920;--bg-2:#151038;--ink:#f5f4ff;--ink-soft:rgba(245,244,255,.74);',
 '--card:rgba(255,255,255,.08);--card-brd:rgba(255,255,255,.16);--radius:22px;--blur:25px;--tint-a:.25;--tint-color:18,16,58;',
 '--font-display:"Unbounded",system-ui,sans-serif;--font-body:"Figtree",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;--pad:clamp(16px,4vw,44px)}',
'html[data-theme="light"]{--bg:#f7f5ff;--bg-2:#ffffff;--ink:#171433;--ink-soft:rgba(23,20,51,.74);--card:rgba(255,255,255,.78);--card-brd:rgba(23,20,51,.12);--tint-a:.14;--tint-color:236,232,255}',
'html[data-theme="dark"]{--bg:#0b0920;--bg-2:#151038;--ink:#f5f4ff;--ink-soft:rgba(245,244,255,.74);--card:rgba(255,255,255,.08);--card-brd:rgba(255,255,255,.16);--tint-a:.25;--tint-color:18,16,58}',
'*{box-sizing:border-box}html,body{margin:0;padding:0}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}',
'body{font-family:var(--font-body);color:var(--ink);line-height:1.55;overflow-x:hidden;min-height:100vh;background:var(--bg)}',
'body::before{content:"";position:fixed;inset:0;z-index:-3;background:linear-gradient(160deg,var(--bg),var(--bg-2) 55%,#241a4d)}',
'#site-bg{position:fixed;inset:-2px;z-index:-2;background-size:cover;background-position:center;background-repeat:no-repeat}',
'#site-tint{position:fixed;inset:0;z-index:-1;background:rgba(var(--tint-color),var(--tint-a))}',
'h1,h2,h3,.display{font-family:var(--font-display);font-weight:700;letter-spacing:-.02em;line-height:1.06;margin:0 0 .5em}',
'h1{font-size:clamp(2rem,7vw,4.4rem)}h2{font-size:clamp(1.5rem,4vw,2.6rem)}h3{font-size:clamp(1.05rem,2.4vw,1.4rem)}a{color:inherit}',
'.wrap{width:100%;max-width:1180px;margin:0 auto;padding:0 var(--pad)}section{padding:clamp(52px,9vw,110px) 0;position:relative}',
'.eyebrow{font-family:var(--font-display);font-size:.7rem;letter-spacing:.28em;text-transform:uppercase;color:var(--accent);margin-bottom:.7rem}',
'.muted{color:var(--ink-soft)}',
'.glass{background:var(--card);border:1px solid var(--card-brd);border-radius:var(--radius);backdrop-filter:blur(var(--blur)) saturate(140%);-webkit-backdrop-filter:blur(var(--blur)) saturate(140%);box-shadow:0 20px 50px rgba(0,0,0,.28)}',
'.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;font-family:var(--font-display);font-size:.82rem;padding:.95rem 1.5rem;border-radius:999px;border:1px solid transparent;background:linear-gradient(100deg,var(--accent),var(--accent-2));color:#240c04;cursor:pointer;text-decoration:none;font-weight:700;transition:transform .18s ease,box-shadow .18s ease}',
'.btn:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(255,106,61,.35)}',
'.btn.ghost{background:transparent;border-color:var(--card-brd);color:var(--ink)}.btn.ghost:hover{box-shadow:none;background:var(--card)}',
'.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none}.btn.sm{padding:.6rem 1rem;font-size:.72rem}',
'input,select,textarea,button{font-family:var(--font-body);font-size:1rem}',
'input,select,textarea{width:100%;padding:.85rem 1rem;border-radius:14px;border:1px solid var(--card-brd);background:var(--card);color:var(--ink);outline:none}',
'input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,106,61,.18)}',
'label{display:block;font-size:.76rem;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);margin:1rem 0 .35rem;font-weight:600}',
'.grid{display:grid;gap:clamp(14px,2.4vw,26px)}.g2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}',
'#loader{position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.4rem;background:radial-gradient(120% 120% at 20% 0%,#1b1445,#0a0820 60%);transition:opacity .6s ease,visibility .6s ease}',
'#loader.done{opacity:0;visibility:hidden}',
'#loader .mark{font-family:var(--font-display);font-size:clamp(2.2rem,10vw,4.6rem);letter-spacing:.16em;background:linear-gradient(100deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}',
'#loader .sub{font-size:.7rem;letter-spacing:.4em;text-transform:uppercase;color:rgba(255,255,255,.55)}',
'#bar{width:min(260px,60vw);height:4px;border-radius:99px;background:rgba(255,255,255,.14);overflow:hidden}',
'#bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent-2));transition:width .3s ease}',
'header.nav{position:sticky;top:0;z-index:600;backdrop-filter:blur(14px);background:rgba(var(--tint-color),.6);border-bottom:1px solid var(--card-brd);padding-top:env(safe-area-inset-top)}',
'header.nav .in{display:flex;align-items:center;gap:1rem;justify-content:space-between;padding:.7rem var(--pad);max-width:1180px;margin:0 auto}',
'header.nav .logo{font-family:var(--font-display);font-size:1rem;letter-spacing:.12em;text-decoration:none;display:flex;align-items:center;gap:.6rem}',
'header.nav .logo img{height:32px;width:auto;border-radius:8px}',
'header.nav nav{display:flex;gap:1.1rem;overflow-x:auto;scrollbar-width:none}header.nav nav::-webkit-scrollbar{display:none}',
'header.nav nav a{font-size:.82rem;text-decoration:none;color:var(--ink-soft);white-space:nowrap}header.nav nav a:hover{color:var(--ink)}',
'#banner{display:none;background:linear-gradient(100deg,var(--accent),var(--accent-2));color:#260d03;text-align:center;padding:.6rem var(--pad);font-size:.86rem;font-weight:600}',
'.hero{min-height:min(88vh,780px);display:flex;align-items:center;padding-top:clamp(30px,6vw,70px)}.hero .in{max-width:760px}',
'.hero p.lede{font-size:clamp(1rem,2.1vw,1.25rem);color:var(--ink-soft);max-width:56ch}',
'.row{display:flex;flex-wrap:wrap;gap:.7rem;align-items:center}.center{text-align:center}',
'.card{overflow:hidden;display:flex;flex-direction:column}',
'.slider{position:relative;aspect-ratio:16/10;background:linear-gradient(135deg,#241c52,#3a1f4f);overflow:hidden}',
'.slider .slide{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity .9s ease}.slider .slide.on{opacity:1}',
'.slider .dots{position:absolute;bottom:10px;left:0;right:0;display:flex;gap:6px;justify-content:center;z-index:2}',
'.slider .dots i{width:6px;height:6px;border-radius:99px;background:rgba(255,255,255,.45);display:block;cursor:pointer}.slider .dots i.on{background:#fff;width:18px}',
'.slider .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--font-display);letter-spacing:.2em;font-size:.72rem;color:rgba(255,255,255,.55)}',
'.card .body{padding:1.2rem 1.3rem 1.4rem;display:flex;flex-direction:column;gap:.6rem;flex:1}',
'.price{font-family:var(--font-display);font-size:1.25rem}.price small{font-family:var(--font-body);font-size:.72rem;color:var(--ink-soft);font-weight:400}',
'.chips{display:flex;flex-wrap:wrap;gap:.4rem}.chip{font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;padding:.3rem .65rem;border-radius:99px;border:1px solid var(--card-brd);background:var(--card);color:var(--ink-soft)}',
'.chip.warn{border-color:rgba(255,106,61,.5);color:var(--accent)}',
'.booking-grid{display:grid;gap:1.4rem;grid-template-columns:1.35fr .9fr}@media(max-width:900px){.booking-grid{grid-template-columns:1fr}}',
'.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:.5rem}',
'.slot{padding:.6rem .3rem;text-align:center;border-radius:12px;border:1px solid var(--card-brd);background:var(--card);cursor:pointer;font-size:.84rem}',
'.slot.on{background:linear-gradient(100deg,var(--accent),var(--accent-2));color:#240c04;border-color:transparent;font-weight:700}',
'.slot.full{opacity:.38;cursor:not-allowed;text-decoration:line-through}.slot small{display:block;font-size:.62rem;opacity:.85}',
'.breakdown{border-top:1px dashed var(--card-brd);margin-top:1rem;padding-top:1rem;font-size:.92rem}',
'.breakdown div{display:flex;justify-content:space-between;padding:.22rem 0}',
'.breakdown .tot{font-family:var(--font-display);font-size:1.2rem;border-top:1px solid var(--card-brd);margin-top:.5rem;padding-top:.6rem}',
'.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:.8rem}',
'.gal img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:16px;cursor:pointer;border:1px solid var(--card-brd);transition:transform .25s ease}.gal img:hover{transform:scale(1.03)}',
'.review{padding:1.2rem}.stars{color:var(--accent-2);letter-spacing:.15em}',
'details.faq{border-bottom:1px solid var(--card-brd);padding:1rem 0}',
'details.faq summary{cursor:pointer;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:1rem}',
'details.faq summary::-webkit-details-marker{display:none}details.faq[open] summary{color:var(--accent)}',
'#theme-fab{position:fixed;right:calc(16px + env(safe-area-inset-right));bottom:calc(16px + env(safe-area-inset-bottom));z-index:700;width:50px;height:50px;border-radius:50%;border:1px solid var(--card-brd);background:var(--card);backdrop-filter:blur(14px);color:var(--ink);cursor:pointer;font-size:1.15rem;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.35)}',
'#theme-menu{position:fixed;right:calc(16px + env(safe-area-inset-right));bottom:calc(78px + env(safe-area-inset-bottom));z-index:700;display:none;flex-direction:column;gap:.25rem;padding:.5rem;min-width:150px}',
'#theme-menu.open{display:flex;animation:fabin .18s ease}@keyframes fabin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
'#theme-menu button{background:none;border:0;color:var(--ink);text-align:left;padding:.6rem .7rem;border-radius:12px;cursor:pointer;font-size:.88rem}',
'#theme-menu button:hover{background:var(--card)}#theme-menu button.on{color:var(--accent);font-weight:700}',
'#toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom));z-index:900;padding:.8rem 1.2rem;border-radius:999px;background:rgba(20,16,50,.95);color:#fff;border:1px solid var(--card-brd);display:none;max-width:90vw;text-align:center;font-size:.88rem}',
'#toast.on{display:block}',
'footer{padding:clamp(40px,7vw,80px) 0 calc(60px + env(safe-area-inset-bottom));border-top:1px solid var(--card-brd);background:rgba(var(--tint-color),.45)}',
'footer .socials{display:flex;gap:.7rem;flex-wrap:wrap}footer .socials a{width:40px;height:40px;border-radius:50%;border:1px solid var(--card-brd);display:flex;align-items:center;justify-content:center;text-decoration:none}',
'.ticket{border-radius:20px;padding:1.4rem;background:linear-gradient(120deg,rgba(255,106,61,.16),rgba(255,176,58,.1));border:1px dashed rgba(255,106,61,.5)}',
'.code{font-family:var(--font-display);font-size:clamp(1.6rem,7vw,2.6rem);letter-spacing:.22em}',
'#lightbox{position:fixed;inset:0;z-index:9500;background:rgba(6,4,18,.93);display:none;align-items:center;justify-content:center}#lightbox.on{display:flex}#lightbox img{max-width:92vw;max-height:86vh;border-radius:16px}',
'.admin-wrap{display:grid;grid-template-columns:230px 1fr;min-height:100vh}@media(max-width:820px){.admin-wrap{grid-template-columns:1fr}}',
'.side{padding:1rem;border-right:1px solid var(--card-brd);background:rgba(var(--tint-color),.5)}@media(max-width:820px){.side{border-right:0;border-bottom:1px solid var(--card-brd)}}',
'.side a{display:block;padding:.55rem .7rem;border-radius:12px;text-decoration:none;font-size:.88rem;color:var(--ink-soft);cursor:pointer}',
'.side a.on,.side a:hover{background:var(--card);color:var(--ink)}.main{padding:1.2rem;min-width:0}',
'table{width:100%;border-collapse:collapse;font-size:.86rem}th,td{text-align:left;padding:.55rem .6rem;border-bottom:1px solid var(--card-brd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}',
'th{font-family:var(--font-display);font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}',
'.scroller{overflow:auto;border:1px solid var(--card-brd);border-radius:16px}',
'.bar{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}.bar input,.bar select{width:auto;min-width:150px}',
'input[type=range]{padding:0;height:26px}',
'.drop{border:2px dashed var(--card-brd);border-radius:18px;padding:1.4rem;text-align:center;color:var(--ink-soft);cursor:pointer}.drop.hot{border-color:var(--accent);color:var(--accent)}',
'.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:.6rem;margin-top:.8rem}',
'.thumb{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--card-brd);aspect-ratio:1}.thumb img{width:100%;height:100%;object-fit:cover}',
'.thumb .x{position:absolute;top:4px;right:4px;background:rgba(0,0,0,.6);color:#fff;border:0;border-radius:50%;width:22px;height:22px;cursor:pointer}',
'.thumb .cov{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.6);color:#fff;font-size:.6rem;text-align:center;padding:.15rem}',
'.thumb.cover{outline:2px solid var(--accent)}',
'.kpi{padding:1rem 1.1rem}.kpi b{display:block;font-family:var(--font-display);font-size:1.6rem}.kpi span{font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft)}',
'.bars{display:flex;align-items:flex-end;gap:4px;height:120px;margin-top:1rem}.bars i{flex:1;background:linear-gradient(180deg,var(--accent),var(--accent-2));border-radius:4px 4px 0 0;min-height:3px;display:block}',
'.note{font-size:.8rem;color:var(--ink-soft);margin-top:.5rem}',
'.pill{display:inline-block;font-size:.64rem;letter-spacing:.08em;text-transform:uppercase;padding:.22rem .55rem;border-radius:99px;border:1px solid var(--card-brd)}',
'.pill.ok{border-color:rgba(80,220,140,.6);color:#7ff0ae}.pill.bad{border-color:rgba(255,106,61,.6);color:#ff9b7a}',
'.reveal{opacity:0;transform:translateY(18px);transition:opacity .7s ease,transform .7s ease}.reveal.in{opacity:1;transform:none}',
'@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}*{animation-duration:.001ms !important;transition-duration:.001ms !important}.reveal{opacity:1;transform:none}}',
'@media (prefers-reduced-transparency: reduce){.glass{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;background:rgba(var(--tint-color),.94)}}',
''].join('\n');

/* ---------- 14. client script shared ---------- */
const COMMON_JS=
'function $(s,r){return (r||document).querySelector(s);}'+
'function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}'+
'function E(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}'+
'function toast(m){var t=$("#toast");if(!t)return;t.textContent=m;t.classList.add("on");clearTimeout(window.__tt);window.__tt=setTimeout(function(){t.classList.remove("on");},4200);}'+
'function themeSet(v){try{localStorage.setItem("natof-theme",v);}catch(e){}document.documentElement.setAttribute("data-theme",v==="system"?(window.matchMedia("(prefers-color-scheme:light)").matches?"light":"dark"):v);}'+
'function themeInit(){var fab=$("#theme-fab"),menu=$("#theme-menu");if(!fab)return;'+
' fab.addEventListener("click",function(ev){ev.stopPropagation();menu.classList.toggle("open");});'+
' document.addEventListener("click",function(){menu.classList.remove("open");});'+
' menu.addEventListener("click",function(ev){ev.stopPropagation();});'+
' var cur="system";try{cur=localStorage.getItem("natof-theme")||"system";}catch(e){}'+
' $$("[data-theme-opt]").forEach(function(b){if(b.getAttribute("data-theme-opt")===cur)b.classList.add("on");'+
'  b.addEventListener("click",function(){themeSet(b.getAttribute("data-theme-opt"));'+
'   $$("[data-theme-opt]").forEach(function(x){x.classList.remove("on");});b.classList.add("on");menu.classList.remove("open");});});'+
' try{window.matchMedia("(prefers-color-scheme: light)").addEventListener("change",function(){if((localStorage.getItem("natof-theme")||"system")==="system")themeSet("system");});}catch(e){}'+
'}'+
'function loaderDone(){var l=$("#loader");if(!l)return;l.classList.add("done");setTimeout(function(){if(l&&l.parentNode)l.parentNode.removeChild(l);},800);}'+
'function api(url,opt){opt=opt||{};opt.headers=opt.headers||{};opt.headers["Content-Type"]="application/json";'+
' return fetch(url,opt).then(function(r){return r.text().then(function(t){var j={};try{j=JSON.parse(t);}catch(e){j={error:t.slice(0,180)};}if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j;});});}'+
'function money(n){return (Math.round(Number(n||0)*100)/100).toFixed(2);}'+
'function reveal(){if(!("IntersectionObserver" in window)){$$(".reveal").forEach(function(e){e.classList.add("in");});return;}'+
' var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target);}});},{rootMargin:"0px 0px -8% 0px"});'+
' $$(".reveal").forEach(function(e){io.observe(e);});}'+
'function installBtn(){if(!("serviceWorker" in navigator))return;navigator.serviceWorker.register("/sw.js").catch(function(){});'+
' window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__bip=e;});}'+
'function maybeTicket(){var p=new URLSearchParams(location.search);var prom=p.get("promo");if(prom)window.__autoPromo=prom.toUpperCase();'+
' var tk=p.get("ticket");if(tk)setTimeout(function(){var el=$("#ticket-lookup");if(el){el.scrollIntoView({behavior:"smooth"});var i=$("#lk-code");if(i)i.value=tk;}},900);}'+
'function compressImage(file){return new Promise(function(res,rej){var fr=new FileReader();'+
' fr.onload=function(){var img=new Image();img.onload=function(){var max=1600,w=img.width,h=img.height;'+
'  if(w>max||h>max){var s=Math.min(max/w,max/h);w=Math.round(w*s);h=Math.round(h*s);}'+
'  var cv=document.createElement("canvas");cv.width=w;cv.height=h;var ctx=cv.getContext("2d");ctx.drawImage(img,0,0,w,h);'+
'  var q=0.82,out=cv.toDataURL("image/jpeg",q);while(out.length>1200000&&q>0.45){q-=0.12;out=cv.toDataURL("image/jpeg",q);}res(out);};'+
'  img.onerror=function(){rej(new Error("Not an image"));};img.src=fr.result;};'+
' fr.onerror=function(){rej(new Error("Read failed"));};fr.readAsDataURL(file);});}'+
'function waShare(code){var t=encodeURIComponent("My NATOF GameZone booking code is "+code);'+
' if(navigator.share)return navigator.share({title:"NATOF GameZone booking",text:"My booking code is "+code}).catch(function(){});'+
' window.location.href="https://wa.me/?text="+t;}';

/* ---------- 15. PUBLIC PAGE ---------- */
function head(o){const c=cfg(),s=o.settings||DEFAULT_SETTINGS;
 const title=o.title||(s.seo&&s.seo.title)||'NATOF GameZone',desc=o.description||(s.seo&&s.seo.description)||'';
 const logo=(s.brand&&s.brand.logo)||'',og=(s.background&&s.background.image)||logo;
 return '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8">'+
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'+
  '<title>'+esc(title)+'</title><meta name="description" content="'+esc(desc)+'">'+
  (c.googleVerify?'<meta name="google-site-verification" content="'+esc(c.googleVerify)+'">':'')+
  '<meta name="theme-color" content="#0b0920"><meta property="og:type" content="website">'+
  '<meta property="og:title" content="'+esc(title)+'"><meta property="og:description" content="'+esc(desc)+'">'+
  (og?'<meta property="og:image" content="'+esc(og)+'">':'')+(c.siteUrl?'<meta property="og:url" content="'+esc(c.siteUrl)+'">':'')+
  '<meta name="twitter:card" content="summary_large_image">'+
  (o.canonical&&c.siteUrl?'<link rel="canonical" href="'+esc(c.siteUrl+o.canonical)+'">':'')+
  '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml">'+
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'+
  '<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;700&family=Figtree:wght@300;400;500;600;700&display=swap" rel="stylesheet">'+
  (o.noindex?'<meta name="robots" content="noindex,nofollow">':'')+
  '<style>'+CSS+'</style>'+
  '<script>(function(){try{var t=localStorage.getItem("natof-theme")||"system";var d=t==="system"?(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):t;document.documentElement.setAttribute("data-theme",d);}catch(e){}})();</script>'+
  '</head><body>';}
function fab(){return '<button id="theme-fab" aria-label="Theme">◐</button><div id="theme-menu" class="glass" role="menu">'+
 '<button data-theme-opt="light">☀︎ Light</button><button data-theme-opt="dark">☾ Dark</button><button data-theme-opt="system">⚙︎ System</button></div>'+
 '<div id="toast"></div><div id="lightbox" onclick="this.classList.remove(\'on\')"><img alt=""></div>';}

function publicPage(s){const c=cfg(),b=s.brand||{},sc=s.social||{},ct=s.contact||{};
 const bg=(s.background||{}).image||'',blur=num((s.background||{}).blur,25),tint=num((s.background||{}).tint,25);
 const rgb=hexToRgb((s.background||{}).tintColor||'#12103a');
 const ld={ '@context':'https://schema.org','@type':'LocalBusiness',name:b.name||'NATOF GameZone',
  description:(s.seo||{}).description||'',image:bg||undefined,telephone:ct.phone||undefined,url:c.siteUrl||undefined,priceRange:'ETB',
  address:ct.address?{'@type':'PostalAddress',streetAddress:ct.address,addressCountry:'ET'}:(ct.mapUrl?undefined:undefined),
  sameAs:[sc.telegram,sc.instagram,sc.tiktok].filter(Boolean)};
 return head({settings:s,title:(s.seo||{}).title,description:(s.seo||{}).description,canonical:'/'})+
 '<style>:root{--blur:'+blur+'px;--tint-a:'+(tint/100)+';--tint-color:'+rgb+'}</style>'+
 '<script type="application/ld+json">'+JSON.stringify(ld).replace(/</g,'\\u003c')+'</script>'+
 '<div id="loader"><div class="mark">NATOF</div><div class="sub">game zone</div><div id="bar"><i></i></div></div>'+
 '<div id="site-bg"'+(bg?' style="background-image:url('+JSON.stringify(bg)+')"':' style="background:linear-gradient(160deg,#1a1247,#2b1b52 60%,#4a2350)"')+'></div>'+
 '<div id="site-tint"></div><div id="banner"></div>'+
 '<header class="nav"><div class="in"><a class="logo" href="/">'+(b.logo?'<img src="'+esc(b.logo)+'" alt="">':'')+
 '<span>'+esc(b.name||'NATOF')+'</span></a><nav id="navlinks"></nav><div class="row" id="nav-actions"></div></div></header>'+
 '<main>'+
 '<section class="hero" id="top"><div class="wrap in"><div class="eyebrow" id="hero-eyebrow">Ethiopia · games & activities</div>'+
 '<h1 id="hero-title">'+esc(b.name||'NATOF GameZone')+'</h1><p class="lede" id="hero-lede">'+esc(b.tagline||'')+'</p>'+
 '<div class="row" id="hero-actions" style="margin-top:1.4rem"></div><div class="row" id="hero-stats" style="margin-top:2rem;gap:1.6rem"></div></div></section>'+
 '<section id="games"><div class="wrap"><div class="reveal"><div class="eyebrow">Play</div><h2>Games &amp; activities</h2>'+
 '<p class="muted maxw" id="games-note"></p></div><div class="grid g3" id="game-grid" style="margin-top:2rem"></div></div></section>'+
 (s.features&&s.features.booking?'<section id="booking"><div class="wrap"><div class="reveal"><div class="eyebrow">Reserve</div><h2>Book your slot</h2>'+
  '<p class="muted maxw">Pick a game, a 30 minute time slot and how many people are coming. Prices are locked when you book.</p></div>'+
  '<div class="booking-grid" style="margin-top:2rem"><div class="glass" style="padding:1.4rem"><div id="bk-form"></div></div>'+
  '<div><div class="glass" style="padding:1.4rem"><h3>Your total</h3><div class="breakdown" id="bk-break"><div><span>Waiting</span><span>—</span></div></div>'+
  '<div id="bk-pay" style="margin-top:1rem"></div></div>'+
  '<div class="glass" style="padding:1.4rem;margin-top:1rem" id="ticket-lookup"><h3>My booking</h3>'+
  '<input id="lk-code" placeholder="Booking code (ABC123)" style="margin-bottom:.6rem"><input id="lk-phone" placeholder="Phone number used">'+
  '<div class="row" style="margin-top:.8rem"><button class="btn sm" id="lk-go">Find</button><button class="btn ghost sm" id="lk-cancel">Cancel</button>'+
  '<button class="btn ghost sm" id="lk-move">Reschedule</button></div><div id="lk-out" style="margin-top:1rem"></div></div></div></div></div></section>':'')+
 (s.features&&s.features.tournaments?'<section id="events"><div class="wrap"><div class="reveal"><div class="eyebrow">Compete</div><h2>Tournaments &amp; events</h2></div>'+
  '<div class="grid g3" id="event-grid" style="margin-top:2rem"></div></div></section>':'')+
 (s.features&&s.features.gallery?'<section id="gallery"><div class="wrap"><div class="reveal"><div class="eyebrow">Inside the zone</div><h2>Gallery</h2></div>'+
  '<div class="gal" id="gal" style="margin-top:2rem"></div></div></section>':'')+
 (s.features&&s.features.reviews?'<section id="reviews"><div class="wrap"><div class="reveal"><div class="eyebrow">People</div><h2>Reviews</h2></div>'+
  '<div class="grid g2" id="rev-grid" style="margin-top:2rem"></div>'+
  '<div class="glass" style="padding:1.4rem;margin-top:2rem"><h3>Leave a review</h3><div class="row"><input id="rv-name" placeholder="Your name" style="flex:1 1 160px">'+
  '<select id="rv-rating" style="flex:0 0 130px"><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select></div>'+
  '<textarea id="rv-body" rows="3" placeholder="How was it?" style="margin-top:.6rem"></textarea>'+
  '<div class="row" style="margin-top:.8rem"><button class="btn sm" id="rv-send">Send for approval</button></div></div></div></section>':'')+
 '<section id="about"><div class="wrap"><div class="reveal"><div class="eyebrow">About</div><h2 id="about-title">The zone</h2></div>'+
 '<div class="grid g2" style="margin-top:2rem"><div class="glass reveal" style="padding:1.4rem" id="about-body"></div>'+
 '<div class="glass reveal" style="padding:1.4rem" id="about-hours"></div></div></div></section>'+
 '<section id="faq"><div class="wrap"><div class="reveal"><div class="eyebrow">Questions</div><h2>FAQ</h2></div><div id="faq-list" style="margin-top:1.5rem"></div></div></section>'+
 '<section id="contact"><div class="wrap"><div class="reveal"><div class="eyebrow">Find us</div><h2>Contact</h2></div>'+
 '<div class="grid g2" style="margin-top:2rem"><div class="glass reveal" style="padding:1.4rem" id="contact-card"></div>'+
 '<div class="glass reveal" style="padding:1.4rem" id="contact-hours"></div></div></div></section>'+
 '<section id="legal"><div class="wrap"><div class="grid g3" id="legal-cards"></div></div></section>'+
 '</main><footer><div class="wrap"><div class="row" style="justify-content:space-between;align-items:flex-start">'+
 '<div><div class="display" style="font-size:1.1rem;letter-spacing:.14em" id="f-brand">NATOF</div>'+
 '<p class="muted" id="f-line" style="margin:.4rem 0 0"></p><div class="socials" id="f-social" style="margin-top:.8rem"></div></div>'+
 '<div class="row" id="f-actions"></div></div>'+
 '<p class="muted" style="margin-top:2rem;font-size:.78rem">© <span id="f-year"></span> <span id="f-name"></span>. Prices in ETB.</p></div></footer>'+
 fab()+
 '<script>'+COMMON_JS+'</script>'+
 '<script>var S=null;'+
 'function pay(){var m=S.paymentMethods||[];return m;}'+
 'function priceText(g){if(g.price===null||g.price===undefined||g.price==="")return "Ask at the zone";'+
 '  var u=g.price_unit==="per_30_min"?"/ 30 min":(g.price_unit==="per_hour"?"/ hour":"/ game");'+
 '  return money(g.price)+" ETB <small>"+u+"</small>";}'+
 'function renderGames(){var g=$("#game-grid");if(!g)return;var list=S.games||[];'+
 '  if(!list.length){g.innerHTML="<p class=\'muted\'>No games published yet. Add them in the admin panel.</p>";return;}'+
 '  g.innerHTML=list.map(function(x){var ph=(x.photos||[]).map(function(p){return p&&p.url?p.url:null;}).filter(Boolean);'+
 '   var sl=ph.length?ph.map(function(u,i){return "<div class=\'slide"+(i===0?" on":"")+"\' style=\'background-image:url("+JSON.stringify(u)+")\'></div>";}).join("")'+
 '     +"<div class=\'dots\'>"+ph.map(function(u,i){return "<i class=\'"+(i===0?"on":"")+"\'></i>";}).join("")+"</div>"'+
 '     :"<div class=\'ph\'>PHOTOS COMING SOON</div>";'+
 '   var vs=(x.variants||[]).map(function(v){return v&&v.name?"<span class=\'chip\'>"+E(v.name)+(v.price?" · "+money(v.price)+" ETB":"")+"</span>";}).join("");'+
 '   var ask=x.price===null||x.price===undefined||x.price==="";'+
 '   return "<article class=\'glass card reveal\' data-slide=\'"+ph.length+"\'><div class=\'slider\'>"+sl+"</div><div class=\'body\'>"+'+
 '    "<h3>"+E(x.name)+"</h3><div class=\'price\'>"+priceText(x)+"</div>"+'+
 '    "<p class=\'muted\' style=\'margin:0;font-size:.92rem\'>"+E(x.description||"")+"</p>"+'+
 '    "<div class=\'chips\'>"+(vs||"")+(x.capacity?"<span class=\'chip\'>"+"up to "+x.capacity+" at once"+"</span>":"")'+
 '     +(x.age_note?"<span class=\'chip\'>"+E(x.age_note)+"</span>":"")+(x.bring?"<span class=\'chip\'>bring: "+E(x.bring)+"</span>":"")'+
 '     +(x.health_warning?"<span class=\'chip warn\'>"+E(x.health_warning)+"</span>":"")+"</div>"'+
 '    +(ask?"<div class=\'muted\' style=\'margin-top:auto;font-size:.85rem\'>Ask at the zone for pricing.</div>":'+
 '      "<button class=\'btn\' style=\'margin-top:auto\' data-order=\'"+x.id+"\'>Order now</button>")+"</div></article>";}).join("");'+
 '  startSliders();startOrder();}'+
 'function startSliders(){$$(".card").forEach(function(c){var slides=$$(".slide",c),dots=$$(".dots i",c);if(slides.length<2)return;'+
 '  var i=0,timer=null;function go(n){i=(n+slides.length)%slides.length;slides.forEach(function(s,k){s.classList.toggle("on",k===i);});'+
 '   dots.forEach(function(d,k){d.classList.toggle("on",k===i);});}'+
 '  function play(){timer=setInterval(function(){go(i+1);},3000);}function stop(){if(timer)clearInterval(timer);timer=null;}'+
 '  c.addEventListener("mouseenter",stop);c.addEventListener("mouseleave",play);'+
 '  dots.forEach(function(d,k){d.addEventListener("click",function(ev){ev.stopPropagation();go(k);});});'+
 '  if(!window.matchMedia("(prefers-reduced-motion: reduce)").matches)play();});}'+
 'function startOrder(){$$("[data-order]").forEach(function(b){b.addEventListener("click",function(){'+
 '  var id=b.getAttribute("data-order");var sel=$("#bk-game");if(sel){sel.value=id;}'+
 '  var s=$("#booking");if(s)s.scrollIntoView({behavior:"smooth"});bkRender();});});}'+
 'function starBar(n){var s="";for(var i=0;i<5;i++)s+=i<Number(n||5)?"★":"☆";return s;}'+
 'function renderRest(){var ev=$("#event-grid");'+
 '  if(ev){var list=S.events||[];ev.innerHTML=list.length?list.map(function(e){'+
 '   var fee=e.entry_fee?money(e.entry_fee)+" ETB entry":"Free entry";'+
 '   return "<article class=\'glass card reveal\' style=\'padding:1.2rem\'><h3>"+E(e.title)+"</h3><p class=\'muted\'>"+E(e.description||"")+"</p>"+'+
 '    "<div class=\'chips\'><span class=\'chip\'>"+fee+"</span>"+(e.starts_at?"<span class=\'chip\'>"+new Date(e.starts_at).toLocaleString()+"</span>":"")+"</div>"'+
 '    +(e.registration_open?"<div style=\'margin-top:.8rem\'><input placeholder=\'Your name\' data-rn=\'"+e.id+"\'><input placeholder=\'Phone\' data-rp=\'"+e.id+"\' style=\'margin-top:.4rem\'><input placeholder=\'Team (optional)\' data-rt=\'"+e.id+"\' style=\'margin-top:.4rem\'><button class=\'btn sm\' style=\'margin-top:.6rem\' data-reg=\'"+e.id+"\'>Register</button></div>":"")+"</article>";}).join(""):"<p class=\'muted\'>No tournaments published right now.</p>";'+
 '   $$("[data-reg]").forEach(function(b){b.addEventListener("click",function(){var id=b.getAttribute("data-reg");'+
 '    api("/api/events/"+id+"/register",{method:"POST",body:JSON.stringify({name:($("[data-rn=\'"+id+"\']")||{}).value,phone:($("[data-rp=\'"+id+"\']")||{}).value,team:($("[data-rt=\'"+id+"\']")||{}).value})})'+
 '     .then(function(){toast("You are registered. We will call you.");}).catch(function(e){toast(e.message);});});});}'+
 '  var gal=$("#gal");if(gal){gal.innerHTML=(S.gallery||[]).map(function(x){return x.url?"<img src=\'"+E(x.url)+"\' alt=\'"+E(x.caption||"")+"\' data-big=\'"+E(x.url)+"\'>":"";}).join("");'+
 '   $$("#gal img").forEach(function(i){i.addEventListener("click",function(){var lb=$("#lightbox");$("img",lb).src=i.getAttribute("data-big");lb.classList.add("on");});});}'+
 '  var rg=$("#rev-grid");if(rg){var rv=S.reviews||[];rg.innerHTML=rv.length?rv.map(function(r){return "<article class=\'glass review reveal\'><div class=\'stars\'>"+starBar(r.rating)+"</div><p>"+E(r.body)+"</p><div class=\'muted\' style=\'font-size:.82rem\'>"+E(r.author)+(r.featured?" · featured":"")+"</div></article>";}).join(""):"<p class=\'muted\'>No reviews yet.</p>";}'+
 '  var sb=$("#rv-send");if(sb)sb.addEventListener("click",function(){api("/api/reviews",{method:"POST",body:JSON.stringify({author:$("#rv-name").value,rating:$("#rv-rating").value,body:$("#rv-body").value})})'+
 '   .then(function(){toast("Thank you! Your review waits for approval.");$("#rv-name").value="";$("#rv-body").value="";}).catch(function(e){toast(e.message);});});'+
 '  var fl=$("#faq-list");if(fl){var f=S.faqs||[];fl.innerHTML=f.length?f.map(function(x){return "<details class=\'faq reveal\'><summary>"+E(x.question)+"<span>+</span></summary><p class=\'muted\'>"+E(x.answer)+"</p></details>";}).join(""):"<p class=\'muted\'>FAQ coming soon.</p>";}'+
 '  var at=$("#about-title"),ab=$("#about-body");if(at)at.textContent=(S.settings.about||{}).title||"The zone";'+
 '  if(ab)ab.innerHTML=E((S.settings.about||{}).body||"NATOF GameZone is being set up. The owner can fill this in from the admin panel.");'+
 '  var hr=S.settings.hours||{};var names=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];'+
 '  var hh="<h3>Opening hours</h3>"+names.map(function(n,i){var h=hr[String(i)];return "<div style=\'display:flex;justify-content:space-between;border-bottom:1px solid var(--card-brd);padding:.35rem 0\'><span>"+n+"</span><span>"+(h&&h[0]?" "+h[0]+" – "+h[1]:" closed")+"</span></div>";}).join("");'+
 '  var ch=$("#about-hours");if(ch)ch.innerHTML=hh;var ch2=$("#contact-hours");if(ch2)ch2.innerHTML=hh;'+
 '  var cc=$("#contact-card");if(cc){var ct=S.settings.contact||{};'+
 '   cc.innerHTML="<h3>Visit</h3><p class=\'muted\'>"+(ct.address?E(ct.address):"Address added by the owner soon.")+"</p>"+'+
 '    "<div class=\'row\'>"+(ct.phone?"<a class=\'btn\' href=\'tel:"+E(ct.phone)+"\'>Call "+E(ct.phone)+"</a>":"")+'+
 '    (ct.mapUrl?"<a class=\'btn ghost\' href=\'"+E(ct.mapUrl)+"\' target=\'_blank\' rel=\'noopener\'>Open map</a>":"")+'+
 '    (ct.email?"<a class=\'btn ghost\' href=\'mailto:"+E(ct.email)+"\'>Email</a>":"")+"</div>"+(ct.phone?"":"<p class=\'note\'>No phone number set yet, so no call button is shown.</p>");}'+
 '  var lc=$("#legal-cards");if(lc){var L=S.settings.legal||{};lc.innerHTML=[["Terms",L.terms],["Privacy",L.privacy],["Refund policy",L.refund]].map(function(p){'+
 '   return "<div class=\'glass reveal\' style=\'padding:1.2rem\'><h3>"+p[0]+"</h3><p class=\'muted\' style=\'font-size:.9rem\'>"+E(p[1]||"The owner has not published this text yet.")+"</p></div>";}).join("");}'+
 '  var fs=$("#f-social");if(fs){var so=S.settings.social||{};'+
 '   fs.innerHTML=[["telegram",so.telegram,"✈"],["instagram",so.instagram,"◎"],["tiktok",so.tiktok,"♪"]].filter(function(x){return x[1];})'+
 '    .map(function(x){return "<a href=\'"+E(x[1])+"\' target=\'_blank\' rel=\'noopener\' aria-label=\'"+x[0]+"\'>"+x[2]+"</a>";}).join("");}'+
 '  var fa=$("#f-actions");if(fa){fa.innerHTML=(S.portfolio?"<a class=\'btn ghost sm\' href=\'"+E(S.portfolio)+"\' target=\'_blank\' rel=\'noopener\'>Creator</a>":"")+"<a class=\'btn ghost sm\' href=\'/admin\'>Admin</a>";}'+
 '  $("#f-year").textContent=new Date().getFullYear();$("#f-name").textContent=(S.settings.brand||{}).name||"NATOF GameZone";}'+
 'function renderNav(){var b=S.settings.brand||{};var links=[["#games","Games"],["#booking","Booking"],["#events","Tournaments"],["#gallery","Gallery"],["#reviews","Reviews"],["#faq","FAQ"],["#contact","Contact"]];'+
 '  $("#navlinks").innerHTML=links.map(function(l){return "<a href=\'"+l[0]+"\'>"+l[1]+"</a>";}).join("");'+
 '  var ct=S.settings.contact||{};'+
 '  $("#nav-actions").innerHTML=(ct.phone?"<a class=\'btn sm\' href=\'tel:"+E(ct.phone)+"\'>Call</a>":"")+"<a class=\'btn ghost sm\' href=\'#booking\'>Book</a>";'+
 '  var an=S.settings.announcement||{};if(an.enabled&&an.text){var bn=$("#banner");bn.style.display="block";'+
 '   bn.innerHTML=E(an.text)+(an.link?" <a href=\'"+E(an.link)+"\' style=\'text-decoration:underline\'>Learn more</a>":"");}'+
 '  var led=$("#hero-lede");if(led)led.textContent=b.tagline||"";'+
 '  var ha=$("#hero-actions");'+
 '  if(ha)ha.innerHTML="<a class=\'btn\' href=\'#booking\'>Book a slot</a><a class=\'btn ghost\' href=\'#games\'>See the games</a>";'+
 '  var hs=$("#hero-stats");if(hs){var g=S.games||[];hs.innerHTML="<div><b>"+g.length+"</b><span>games</span></div>"+'+
 '   "<div><b>"+((S.settings.booking||{}).slotMinutes||30)+" min</b><span>slots</span></div><div><b>ETB</b><span>prices</span></div>";}'+
 '  var gn=$("#games-note");if(gn)gn.textContent="Photos and details are added by the staff. Tap a game to start a booking.";}'+
 'function renderBooking(){var f=$("#bk-form");if(!f)return;var g=S.games||[];'+
 '  f.innerHTML="<h3>Details</h3><label>Game</label><select id=\'bk-game\'>"+g.map(function(x){return "<option value=\'"+x.id+"\'>"+E(x.name)+"</option>";}).join("")+"</select>"+'+
 '  "<label>Variant</label><select id=\'bk-variant\'></select><label>Date</label><input type=\'date\' id=\'bk-date\'>"+'+
 '  "<label>Start time</label><div class=\'slots\' id=\'bk-slots\'><span class=\'muted\'>Pick a game and date first.</span></div>"+'+
 '  "<div class=\'row\' style=\'margin-top:1rem\'><div style=\'flex:1 1 120px\'><label>Blocks of 30 min</label><input type=\'number\' id=\'bk-blocks\' min=\'1\' max=\'16\' value=\'1\'></div>"+'+
 '  "<div style=\'flex:1 1 120px\'><label>People</label><input type=\'number\' id=\'bk-people\' min=\'1\' value=\'1\'></div></div>"+'+
 '  "<div class=\'row\' style=\'margin-top:1rem\'><div style=\'flex:1 1 160px\'><label>Your name</label><input id=\'bk-name\'></div>'+
 '  "<div style=\'flex:1 1 160px\'><label>Phone</label><input id=\'bk-phone\' placeholder=\'09...\'></div></div>"+'+
 '  "<label>Promo code</label><div class=\'row\'><input id=\'bk-promo\' placeholder=\'Optional\' style=\'flex:1 1 140px\'><button class=\'btn ghost sm\' id=\'bk-promo-go\' type=\'button\'>Check</button></div>"+'+
 '  "<input id=\'bk-trap\' style=\'display:none\' tabindex=\'-1\' autocomplete=\'off\'>"+'+
 '  "<div id=\'bk-msg\' class=\'note\'></div><button class=\'btn\' id=\'bk-go\' style=\'margin-top:1rem;width:100%\'>Order now</button>";'+
 '  var d=$("#bk-date");var t=new Date();d.value=t.toISOString().slice(0,10);d.min=d.value;'+
 '  $("#bk-game").addEventListener("change",bkVariants);$("#bk-blocks").addEventListener("input",bkRender);'+
 '  $("#bk-people").addEventListener("input",bkRender);$("#bk-date").addEventListener("change",bkSlots);'+
 '  $("#bk-promo").addEventListener("input",bkRender);'+
 '  $("#bk-promo-go").addEventListener("click",function(){bkRender(true);});'+
 '  $("#bk-go").addEventListener("click",bkOrder);'+
 '  bkVariants();}'+
 'function bkGame(){var id=$("#bk-game").value;return (S.games||[]).filter(function(x){return x.id===id;})[0];}'+
 'function bkVariants(){var g=bkGame(),v=$("#bk-variant");var vs=(g&&g.variants)||[];'+
 '  v.innerHTML="<option value=\'\'>Default</option>"+vs.map(function(x){return x&&x.name?"<option value=\'"+E(x.name)+"\'>"+E(x.name)+(x.price?" · "+money(x.price)+" ETB":"")+"</option>":"";}).join("");'+
 '  v.addEventListener("change",bkRender);bkSlots();}'+
 'function bkSlots(){var g=bkGame();if(!g)return;var d=$("#bk-date").value;var box=$("#bk-slots");box.innerHTML="<span class=\'muted\'>Loading…</span>";'+
 '  api("/api/availability?game="+encodeURIComponent(g.id)+"&date="+encodeURIComponent(d)).then(function(r){'+
 '   if(r.closed||!r.slots.length){box.innerHTML="<span class=\'muted\'>Closed on that day.</span>";return;}'+
 '   window.__slots=r.slots;'+
 '   box.innerHTML=r.slots.map(function(s){return "<div class=\'slot"+(s.left<=0?" full":"")+"\' data-slot=\'"+s.slot+"\'>"+s.slot+"<small>"+(s.left>0?s.left+" left":"full")+"</small></div>";}).join("");'+
 '   $$("#bk-slots .slot").forEach(function(el){if(el.classList.contains("full"))return;'+
 '    el.addEventListener("click",function(){$$("#bk-slots .slot").forEach(function(x){x.classList.remove("on");});el.classList.add("on");bkRender();});});'+
 '  }).catch(function(e){box.innerHTML="<span class=\'muted\'>"+E(e.message)+"</span>";});}'+
 'function bkSelectedSlot(){var on=$("#bk-slots .slot.on");return on?on.getAttribute("data-slot"):"";}'+
 'function bkCalc(){var g=bkGame();if(!g)return null;var people=Math.max(1,Number($("#bk-people").value||1)),blocks=Math.max(1,Number($("#bk-blocks").value||1));'+
 '  if(g.price===null||g.price===undefined||g.price==="")return {ask:true,g:g};'+
 '  var unit=Number(g.price),vname=$("#bk-variant").value;'+
 '  var vs=g.variants||[];for(var i=0;i<vs.length;i++){if(vs[i]&&vs[i].name===vname&&vs[i].price!==undefined&&vs[i].price!==null&&vs[i].price!=="")unit=Number(vs[i].price);}'+
 '  var mult=g.price_unit==="per_hour"?Math.max(1,Math.ceil(blocks/2)):blocks;'+
 '  var sub=Math.round(unit*people*mult*100)/100;'+
 '  return {g:g,unit:unit,people:people,blocks:blocks,mult:mult,sub:sub,total:sub};}'+
 'function bkRender(checkPromo){var c=bkCalc();var box=$("#bk-break");if(!c)return;'+
 '  if(c.ask){box.innerHTML="<div><span>This game</span><span>Ask at the zone</span></div>";$("#bk-go").disabled=true;return;}'+
 '  var promo=$("#bk-promo").value.trim().toUpperCase();var sub=c.sub;'+
 '  function paint(disc,msg){disc=disc||0;var tot=Math.max(0,Math.round((sub-disc)*100)/100);'+
 '   box.innerHTML="<div><span>"+E(c.g.name)+(c.people>1?" × "+c.people+" people":"")+"</span><span>"+money(c.unit)+" ETB</span></div>"+'+
 '    "<div><span>"+c.blocks+" × 30 min"+(c.mult!==c.blocks?" (billed as "+c.mult+")":"")+"</span><span>"+money(sub)+" ETB</span></div>"+'+
 '    (disc>0?"<div><span>Discount "+(promo?"("+E(promo)+")":"")+"</span><span>−"+money(disc)+" ETB</span></div>":"")+'+
 '    "<div class=\'tot\'><span>Total</span><span>"+money(tot)+" ETB</span></div>"+'+
 '    (msg?"<div class=\'note\'>"+E(msg)+"</div>":"");window.__quote={sub:sub,disc:disc,total:tot,promo:disc>0?promo:null};}'+
 '  paint(0,"");'+
 '  if(checkPromo&&promo){api("/api/promo/check",{method:"POST",body:JSON.stringify({code:promo,subtotal:sub,phone:($("#bk-phone")||{}).value||"",gameId:c.g.id,date:($("#bk-date")||{}).value,slot:bkSelectedSlot(),blocks:c.blocks})})'+
 '   .then(function(r){if(r.ok)paint(r.discount,r.message||("Promo applied: "+promo));else paint(0,r.reason);}).catch(function(e){paint(0,e.message);});}}'+
 'function bkOrder(){var c=bkCalc();if(!c||c.ask)return;var slot=bkSelectedSlot();'+
 '  if(!slot)return toast("Pick a start time.");'+
 '  var body={gameId:c.g.id,variant:$("#bk-variant").value,date:$("#bk-date").value,slot:slot,blocks:c.blocks,people:c.people,'+
 '   name:$("#bk-name").value,phone:$("#bk-phone").value,promo:($("#bk-promo").value||"").trim().toUpperCase(),website:$("#bk-trap").value};'+
 '  $("#bk-go").disabled=true;$("#bk-msg").textContent="Sending…";'+
 '  api("/api/bookings",{method:"POST",body:JSON.stringify(body)}).then(function(r){'+
 '   $("#bk-go").disabled=false;$("#bk-msg").textContent="";showTicket(r.booking);'+
 '   if(r.free){toast("Booked. This one is free — show your code at the counter.");bkSlots();return;}'+
 '   var m=r.methods||[];'+
 '   if(!m.length){toast("Booked. Please pay at the counter.");bkSlots();return;}'+
 '   showPay(r.booking,m);}).catch(function(e){$("#bk-go").disabled=false;$("#bk-msg").textContent=e.message;toast(e.message);});}'+
 'function showPay(bk,m){var p=$("#bk-pay");'+
 '  p.innerHTML="<h3 style=\'margin-top:1rem\'>Pay "+money(bk.total)+" ETB</h3>"+m.map(function(x){return "<button class=\'btn\' style=\'width:100%;margin-bottom:.5rem\' data-pm=\'"+x.id+"\'>"+E(x.label)+"</button>";}).join("")+'+
 '   "<div id=\'pm-out\' class=\'note\'></div>";'+
 '  $$("#bk-pay [data-pm]").forEach(function(b){b.addEventListener("click",function(){payWith(b.getAttribute("data-pm"),bk);});});}'+
 'function payWith(id,bk){var out=$("#pm-out");out.textContent="Starting…";'+
 '  if(id==="cbe"){var ct=S.settings.contact||{};'+
 '   out.innerHTML="Transfer <b>"+money(bk.total)+" ETB</b> to CBE"+(S.cbeAccount?" <b>"+E(S.cbeAccount.name)+"</b> account <b>"+E(S.cbeAccount.number)+"</b>":" (ask the zone for the account)");'+
 '   "<div style=\'margin-top:.6rem\'><input id=\'cbe-ref\' placeholder=\'Transaction reference from the receipt\'><button class=\'btn sm\' style=\'margin-top:.5rem\' id=\'cbe-go\'>I have paid</button></div>";'+
 '   $("#cbe-go").addEventListener("click",function(){api("/api/payments/manual",{method:"POST",body:JSON.stringify({code:bk.code,method:"cbe",reference:$("#cbe-ref").value})})'+
 '    .then(function(){toast("Thank you. The zone will confirm your transfer.");$("#pm-out").textContent="Waiting for the owner to confirm. Keep your code "+bk.code+".";}).catch(function(e){toast(e.message);});});'+
 '   return;}'+
 '  var ep=id==="chapa"?"/api/payments/chapa/init":"/api/payments/telebirr/init";'+
 '  api(ep,{method:"POST",body:JSON.stringify({code:bk.code})}).then(function(r){'+
 '   if(r.checkout_url)window.location.href=r.checkout_url;else out.textContent="Payment could not start.";'+
 '  }).catch(function(e){out.textContent=e.message;toast(e.message);});}'+
 'function showTicket(bk){var p=$("#bk-pay");var qr=(S.qr&&bk.code)?"<img alt=\'QR\' style=\'width:150px;height:150px;background:#fff;border-radius:12px;padding:6px\' src=\'"+E(S.qr)+"?size=150x150&data="+encodeURIComponent(bk.code)+"\'>":"";'+
 '  p.innerHTML="<div class=\'ticket\'><div class=\'muted\'>Booking code</div><div class=\'code\'>"+E(bk.code)+"</div>"'+
 '   +"<div class=\'muted\' style=\'margin-top:.4rem\'>"+E(bk.game_name||"")+" · "+E(bk.slot_date)+" "+E(bk.slot_start)+" · "+bk.people+" people</div>"'+
 '   +"<div class=\'price\' style=\'margin-top:.5rem\'>"+money(bk.total)+" ETB</div>"+qr+'</div>'+
 '   "<div class=\'row\' style=\'margin-top:.8rem\'><button class=\'btn ghost sm\' id=\'tk-share\'>Share</button></div>";'+
 '  $("#tk-share").addEventListener("click",function(){waShare(bk.code);});}'+
 'function ticketTools(){$("#lk-go").addEventListener("click",function(){'+
 '  api("/api/bookings/lookup",{method:"POST",body:JSON.stringify({code:$("#lk-code").value,phone:$("#lk-phone").value})}).then(function(r){'+
 '   var b=r.booking;var st=b.status==="paid"?("<span class=\'pill ok\'>paid</span>"):("<span class=\'pill\'>"+E(b.status)+"</span>");'+
 '   $("#lk-out").innerHTML="<div class=\'ticket\'><div class=\'code\'>"+E(b.code)+"</div>"+"<div>"+st+"</div>"+"<div class=\'muted\'>"+E(b.game_name)+" · "+E(b.slot_date)+" "+E(b.slot_start)+"</div>"+'+
 '    "<div class=\'price\'>"+money(b.total)+" ETB</div>"+(b.promo_code?"<div class=\'note\'>promo "+E(b.promo_code)+" (−"+money(b.discount)+")</div>":"")+"</div>"+'+
 '    "<div class=\'note\'>Prices are locked at booking time.</div>";'+
 '   if(b.status==="pending"&&r.methods&&r.methods.length)showPay(b,r.methods);'+
 '  }).catch(function(e){$("#lk-out").innerHTML="<div class=\'note\'>"+E(e.message)+"</div>";});});'+
 ' $("#lk-cancel").addEventListener("click",function(){'+
 '  api("/api/bookings/cancel",{method:"POST",body:JSON.stringify({code:$("#lk-code").value,phone:$("#lk-phone").value})}).then(function(){toast("Booking cancelled.");}).catch(function(e){toast(e.message);});});'+
 ' $("#lk-move").addEventListener("click",function(){var d=prompt("New date (YYYY-MM-DD)");var s=prompt("New start time (HH:MM, 30 min steps)");'+
 '  if(!d||!s)return;api("/api/bookings/reschedule",{method:"POST",body:JSON.stringify({code:$("#lk-code").value,phone:$("#lk-phone").value,date:d,slot:s})})'+
 '   .then(function(r){toast("Moved to "+r.booking.slot_date+" "+r.booking.slot_start+". Price unchanged.");}).catch(function(e){toast(e.message);});});}'+
 'function applyAutoPromo(){if(!window.__autoPromo)return;var i=$("#bk-promo");if(!i)return;i.value=window.__autoPromo;var n=$("#games-note");'+
 '  if(n)n.textContent="Promo "+window.__autoPromo+" will be checked when you book.";}'+
 'function boot(){loaderDone();'+
 '  api("/api/bootstrap").then(function(s){S=s;S.cbeAccount=null;'+
 '   if(s.db===false){var g=$("#game-grid");if(g)g.innerHTML="<div class=\'glass\' style=\'padding:1.4rem\'><h3>Setup needed</h3><p class=\'muted\'>The database is not connected yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel, then run the SQL in the file header.</p></div>";}'+
 '   renderNav();renderGames();renderRest();renderBooking();ticketTools();applyAutoPromo();reveal();});'+
 '  installBtn();}'+
 'document.addEventListener("DOMContentLoaded",function(){themeInit();maybeTicket();'+
 '  var i=0,t=$("#bar i");var iv=setInterval(function(){i=Math.min(92,i+Math.random()*18);if(t)t.style.width=i+"%";},140);'+
 '  window.addEventListener("load",function(){clearInterval(iv);if(t)t.style.width="100%";boot();});'+
 '  setTimeout(function(){clearInterval(iv);if(document.body.getAttribute("data-booted")!=="1")boot();},3500);});'+
 '</script></body></html>';}

/* ---------- 16. ADMIN + CREATOR PANELS (single-page, client-rendered) ---------- */
const ADMIN_JS=
'var ME=null,META=null,SET=null,GAMES=[];var TAB="dashboard";'+
'function el(id){return document.getElementById(id);}'+
'function api2(u,o){o=o||{};o.headers=o.headers||{};o.headers["Content-Type"]="application/json";'+
 ' return fetch(u,o).then(function(r){return r.text().then(function(t){var j={};try{j=JSON.parse(t);}catch(e){j={error:t.slice(0,200)};}if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j;});});}'+
'function loginUI(msg){document.body.innerHTML="<div class=\'wrap\' style=\'padding:8vh 0;max-width:460px\'><div class=\'glass\' style=\'padding:1.6rem\'>'+
 '<div class=\'eyebrow\'>secure area</div><h2 id=\'lt\'>Sign in</h2><p class=\'muted\' id=\'lm\'></p>'+
 '<label>Username</label><input id=\'u\' autocapitalize=\'none\'><label>Password</label><input id=\'p\' type=\'password\'>'+
 '<label>Recovery code (only if you have no passkey device)</label><input id=\'rc\'>'+
 '<button class=\'btn\' id=\'go\' style=\'width:100%;margin-top:1rem\'>Sign in</button>'+
 '<button class=\'btn ghost\' id=\'pk\' style=\'width:100%;margin-top:.5rem\'>Use passkey</button>'+
 '<div class=\'note\' id=\'m\'></div></div></div>";'+
 ' if(msg)el("m").textContent=msg;'+
 ' el("go").addEventListener("click",function(){'+
 '  api2("/api/auth/login",{method:"POST",body:JSON.stringify({username:el("u").value,password:el("p").value,recovery:el("rc").value?true:false})})'+
 '  .then(function(){location.reload();}).catch(function(e){el("m").textContent=e.message;});});'+
 ' el("pk").addEventListener("click",function(){passkeyLogin(el("u").value);});}'+
'function b64toBuf(s){var b=atob(s.replace(/-/g,"+").replace(/_/g,"/"));var a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer;}'+
'function bufToB64(b){var a=new Uint8Array(b),s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");}'+
'function passkeyLogin(username){if(!username)return toast("Type your username first.");'+
 ' if(!window.PublicKeyCredential)return toast("This browser has no passkey support.");'+
 ' api2("/api/auth/passkey/login/begin",{method:"POST",body:JSON.stringify({username:username})}).then(function(o){'+
 '  return navigator.credentials.get({publicKey:{challenge:b64toBuf(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:o.userVerification,'+
 '   allowCredentials:(o.allowCredentials||[]).map(function(c){return {id:b64toBuf(c.id),type:"public-key"};})}}).then(function(c){'+
 '   return api2("/api/auth/passkey/login/finish",{method:"POST",body:JSON.stringify({token:o.token,credentialId:bufToB64(c.rawId),'+
 '    clientDataJSON:bufToB64(c.response.clientDataJSON),authenticatorData:bufToB64(c.response.authenticatorData),signature:bufToB64(c.response.signature),'+
 '    origin:location.origin})});});}).then(function(){location.reload();}).catch(function(e){toast("Passkey failed: "+(e.message||e));});}'+
'function shell(){"'+
 'document.body.innerHTML="<div class=\'admin-wrap\'><aside class=\'side\'><div class=\'display\' style=\'font-size:1rem;letter-spacing:.14em;margin-bottom:1rem\'>NATOF admin</div>"'+
 '<div id=\'nav\'></div><div style=\'margin-top:1.5rem;font-size:.8rem\' class=\'muted\' id=\'who\'></div>'+
 '<button class=\'btn ghost sm\' id=\'out\' style=\'margin-top:.6rem;width:100%\'>Sign out</button></aside>'+
 '<main class=\'main\'><div id=\'view\'></div></main></div><div id=\'toast\'></div>";'+
 ' var tabs=[["dashboard","Dashboard"],["games","Games"],["bookings","Bookings"]];'+
 ' if(ME.role==="owner")tabs.push(["payments","Payments"]);'+
 ' tabs.push(["promos","Promos"],["events","Tournaments"],["registrations","Registrations"],["reviews","Reviews"],["gallery","Gallery"],["faqs","FAQ"],["settings","Settings"],["account","My account"]);'+
 ' if(ME.role==="owner")tabs.push(["staff","Staff"]);'+
 ' el("nav").innerHTML=tabs.map(function(t){return "<a data-tab=\'"+t[0]+"\'>"+t[1]+"</a>";}).join("");'+
 ' el("who").innerHTML="Signed in as <b>"+E(ME.username)+"</b><br>"+E(ME.role)+" · "+E(ME.display_name||"");'+
 ' Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"),function(a){a.addEventListener("click",function(){TAB=a.getAttribute("data-tab");draw();});});'+
 ' el("out").addEventListener("click",function(){api2("/api/auth/logout",{method:"POST",body:"{}"}).then(function(){location.href="/";});});}'+
'function draw(){Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"),function(a){a.classList.toggle("on",a.getAttribute("data-tab")===TAB);});'+
 ' var v=el("view");v.innerHTML="<p class=\'muted\'>Loading…</p>";'+
 ' if(TAB==="dashboard")return dash();'+
 ' if(TAB==="settings")return settingsView();'+
 ' if(TAB==="account")return accountView();'+
 ' if(TAB==="staff")return staffView();'+
 ' listView(TAB);}'+
'function dash(){api2("/api/admin/stats?days=30").then(function(s){var v=el("view");'+
 ' var rev=s.revenue?s.revenue.total:0;'+
 ' var days=Object.keys((s.revenue||{}).byDay||{}).sort();var max=1;days.forEach(function(d){max=Math.max(max,s.revenue.byDay[d]);});'+
 ' v.innerHTML="<h2>Dashboard</h2><div class=\'grid g3\' style=\'margin-bottom:1rem\'>"+'+
 ' "<div class=\'glass kpi\'><b>"+(ME.role==="owner"?money(rev)+" ETB":"hidden")+"</b><span>revenue 30 days</span></div>"+'+
 ' "<div class=\'glass kpi\'><b>"+(s.bookings?s.bookings.total:0)+"</b><span>bookings 30 days</span></div>"+'+
 ' "<div class=\'glass kpi\'><b>"+((s.counts||{}).pendingReviews||0)+"</b><span>reviews to review</span></div></div>"+'+
 ' "<div class=\'glass\' style=\'padding:1rem\'><h3>Revenue by day</h3><div class=\'bars\'>"+days.map(function(d){'+
 '  return "<i style=\'height:"+Math.round(100*s.revenue.byDay[d]/max)+"%\' title=\'"+d+" "+money(s.revenue.byDay[d])+"\'></i>";}).join("")+"</div>"+'+
 ' (days.length?"":"<p class=\'muted\'>No paid bookings yet.</p>")+'+
 ' "<div class=\'note\'>By method: "+Object.keys((s.revenue||{}).byMethod||{}).map(function(k){return k+" "+money(s.revenue.byMethod[k]);}).join(" · ")+"</div></div>"'+
 ' +"<div class=\'glass\' style=\'padding:1rem;margin-top:1rem\'><h3>Latest bookings</h3><div class=\'scroller\'><table><tr><th>Code</th><th>Game</th><th>When</th><th>People</th><th>Total</th><th>Status</th></tr>"'+
 ' +(s.recent||[]).map(function(b){return "<tr><td>"+E(b.code)+"</td><td>"+E(b.game_name)+"</td><td>"+E(b.slot_date)+" "+E(b.slot_start)+"</td><td>"+b.people+"</td><td>"+(ME.role==="owner"?money(b.total):"•")+"</td><td>"+E(b.status)+"</td></tr>";}).join("")+"</table></div></div>"'+
 ' +"<div class=\'glass\' style=\'padding:1rem;margin-top:1rem\'><h3>Phone alerts</h3><p class=\'muted\' style=\'font-size:.9rem\'>Get notified about new bookings even when this page is closed. On iPhone, install it first via Share → Add to Home Screen.</p>"'+
 ' "<button class=\'btn sm\' id=\'push\'>Enable push notifications</button><div class=\'note\' id=\'pnote\'></div></div>";'+
 ' el("push").addEventListener("click",enablePush);}).catch(function(e){el("view").innerHTML="<p class=\'note\'>"+E(e.message)+"</p>";});}'+
'function enablePush(){var key=null;'+
 ' api2("/api/push/key").then(function(k){key=k.key;if(!k.enabled)throw new Error("Push keys are not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).");'+
 '  if(!("serviceWorker" in navigator)||!("PushManager" in window))throw new Error("This browser cannot receive push messages.");'+
 '  return navigator.serviceWorker.ready.then(function(reg){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64toBuf(key)});});})'+
 ' .then(function(sub){return api2("/api/push/subscribe",{method:"POST",body:JSON.stringify({subscription:sub.toJSON()})});})'+
 ' .then(function(){el("pnote").textContent="Push is on for this device.";toast("Push enabled.");})'+
 ' .catch(function(e){el("pnote").textContent=e.message||String(e);});}'+
'function field(f,v){var n="f-"+f.k;if(f.readonly)return "<label>"+E(f.label)+"</label><input disabled value=\'"+E(v==null?"":v)+"\'>";'+
 ' if(f.t==="textarea")return "<label>"+

route('GET', '/api/push/key', async function (req, res) {
  const kp = vapidKeyPair();
  json(res, 200, { key: kp ? kp.publicB64 : null });
});

route('POST', '/api/push/sub', async function (req, res) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  if (!b.endpoint || !b.keys) return json(res, 400, { error: 'Invalid subscription' });
  try {
    await db.insert('push_subs', [{ admin_id: s.adminId, endpoint: b.endpoint, keys: b.keys }], 'on conflict (endpoint) do update set keys=excluded.keys');
    json(res, 200, { ok: true });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

/* ---------------------------- admin CRUD ---------------------------- */

Object.keys(ENTITIES).forEach(function (name) {
  const meta = ENTITIES[name];
  
  route('GET', '/api/admin/' + name, async function (req, res) {
    const s = await getSession(req);
    if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
    if (meta.ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner role required' });
    if (!DB_READY()) return json(res, 200, { items: [], db: false });
    try {
      const items = await db.all(meta.table, 'select=*&order=' + meta.order);
      json(res, 200, { items: items });
    } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  });

  route('POST', '/api/admin/' + name, async function (req, res) {
    const s = await getSession(req);
    if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
    if (meta.ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner role required' });
    if (!DB_READY()) return json(res, 503, { error: 'Database not configured' });
    const b = await readJSON(req);
    const row = sanitizeRow(name, b);
    try {
      const created = (await db.insert(meta.table, [row]))[0];
      await audit(s.username, s.role, name + '.created', created.id || '', row, req);
      json(res, 201, { item: created });
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  });

  route('PUT', '/api/admin/' + name + '/:id', async function (req, res, params) {
    const s = await getSession(req);
    if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
    if (meta.ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner role required' });
    if (!DB_READY()) return json(res, 503, { error: 'Database not configured' });
    const b = await readJSON(req);
    const patch = sanitizeRow(name, b);
    patch.updated_at = nowISO();
    try {
      const updated = (await db.update(meta.table, 'id=eq.' + params.id, patch))[0];
      await audit(s.username, s.role, name + '.updated', params.id, patch, req);
      json(res, 200, { item: updated });
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  });

  route('DELETE', '/api/admin/' + name + '/:id', async function (req, res, params) {
    const s = await getSession(req);
    if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
    if (meta.ownerOnly && s.role !== 'owner') return json(res, 403, { error: 'Owner role required' });
    if (!DB_READY()) return json(res, 503, { error: 'Database not configured' });
    try {
      await db.remove(meta.table, 'id=eq.' + params.id);
      await audit(s.username, s.role, name + '.deleted', params.id, {}, req);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  });
});

route('POST', '/api/admin/settings', async function (req, res) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin' || s.role !== 'owner') return json(res, 403, { error: 'Owner role required' });
  const b = await readJSON(req);
  try {
    const next = await saveSettings(b);
    await audit(s.username, s.role, 'settings.updated', 'settings', {}, req);
    json(res, 200, { settings: publicSettings(next) });
  } catch (e) { json(res, 400, { error: String(e.message || e) }); }
});

route('POST', '/api/admin/upload', async function (req, res) {
  const s = await getSession(req);
  if (!s || s.scope !== 'admin') return json(res, 401, { error: 'Not signed in' });
  const b = await readJSON(req);
  if (!b.data || !b.name) return json(res, 400, { error: 'File data and name required' });
  const m = b.data.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return json(res, 400, { error: 'Invalid data URL' });
  try {
    const url = await uploadObject(b.name, Buffer.from(m[2], 'base64'), m[1]);
    json(res, 200, { url: url });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

/* ---------------------------- creator panel ---------------------------- */

route('POST', '/api/creator/bootstrap', async function (req, res) {
  const c = cfg();
  const b = await readJSON(req);
  if (!c.creatorToken || !safeEqual(b.token, c.creatorToken)) return json(res, 403, { error: 'Invalid creator token' });
  if (!DB_READY()) return json(res, 503, { error: 'Database not configured' });
  const username = String(b.username || 'owner').toLowerCase();
  const pw = String(b.password || uid(8));
  try {
    const existing = (await db.all('admins', 'select=*&username=eq.' + encodeURIComponent(username) + '&limit=1'))[0];
    let adminId;
    if (existing) {
      await db.update('admins', 'id=eq.' + existing.id, { password_hash: hashPassword(pw), role: 'owner', active: true, must_change_password: false });
      adminId = existing.id;
    } else {
      const created = (await db.insert('admins', [{ username: username, display_name: 'Owner', password_hash: hashPassword(pw), role: 'owner', active: true, must_change_password: false }]))[0];
      adminId = created.id;
    }
    const codes = await makeRecoveryCodes(adminId, 8);
    const token = await createSession(adminId, 'creator', req);
    json(res, 200, { ok: true, username: username, password: pw, recovery_codes: codes }, { 'Set-Cookie': cookieHeader('natof_session', token, SESSION_HOURS_CREATOR * 3600, isSecureReq(req)) });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

/* ---------------------------- static frontend handler ---------------------------- */

route('GET', '/*', async function (req, res) {
  const settings = await getSettings();
  const c = cfg();
  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(settings.seo.title)}</title>
  <meta name="description" content="${esc(settings.seo.description)}">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: ${esc(settings.background.tintColor || '#12103a')}; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="min-h-screen flex flex-col justify-between">
  <header class="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/60 backdrop-blur">
    <h1 class="text-2xl font-black tracking-wider text-amber-400">${esc(settings.brand.name)}</h1>
    <nav class="flex gap-4 text-sm font-semibold">
      <a href="/" class="hover:text-amber-400">Home</a>
      <a href="/admin" class="hover:text-amber-400">Admin</a>
    </nav>
  </header>
  <main class="max-w-4xl mx-auto p-6 flex-grow w-full">
    <div class="bg-slate-900/80 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur">
      <h2 class="text-3xl font-bold mb-4 text-amber-400">${esc(settings.brand.name)}</h2>
      <p class="text-slate-300 mb-6">${esc(settings.brand.tagline)}</p>
      <div class="border-t border-slate-800 pt-6">
        <h3 class="text-xl font-semibold mb-2">Zone Status</h3>
        <p class="text-emerald-400 font-medium">● Open for bookings & games</p>
      </div>
    </div>
  </main>
  <footer class="p-6 text-center text-xs text-slate-500 border-t border-slate-800 bg-slate-900/60">
    &copy; ${new Date().getFullYear()} ${esc(settings.brand.name)}. All rights reserved. ${c.portfolio ? `| <a href="${esc(c.portfolio)}" target="_blank" class="text-amber-400 hover:underline">Creator Portfolio</a>` : ''}
  </footer>
</body>
</html>`;
  html(res, 200, htmlDoc);
});

/* ==================================================================================
   13. HTTP SERVER ENTRYPOINT
   ================================================================================== */

module.exports = async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const pathname = u.pathname;
    let matched = null, params = {};
    for (const r of ROUTES) {
      if (r.method !== req.method && r.method !== 'ALL') continue;
      const p = match(r.pattern, pathname);
      if (p) { matched = r; params = p; break; }
    }
    if (matched) {
      await matched.fn(req, res, params);
    } else {
      const wc = ROUTES.filter(function (r) { return r.pattern === '/*'; })[0];
      if (wc) await wc.fn(res, res, {});
      else text(res, 404, 'Not Found');
    }
  } catch (e) {
    json(res, 500, { error: 'Internal Server Error', message: String(e.message || e) });
  }
};
