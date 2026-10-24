const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

/* ------------------------------------------------------------------ */
/* Configuration (all secrets come from environment variables)         */
/* ------------------------------------------------------------------ */
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')); // local development only

function fatal(msg) { console.error('FATAL: ' + msg); process.exit(1); }

let TOKEN_SECRET = process.env.ECOSMART_TOKEN_SECRET;
if (!TOKEN_SECRET) {
  if (IS_PROD) fatal('ECOSMART_TOKEN_SECRET is not set.');
  TOKEN_SECRET = 'dev-only-secret-never-use-in-production';
  console.warn('WARNING: using a dev-only token secret. Set ECOSMART_TOKEN_SECRET before deploying.');
}
if (IS_PROD && TOKEN_SECRET.length < 32) fatal('ECOSMART_TOKEN_SECRET must be at least 32 characters.');

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const LEGACY_ADMIN_EMAIL = 'admin@ecosmart.local';
if (IS_PROD && (!ADMIN_EMAIL || ADMIN_PASSWORD.length < 10)) {
  fatal('ADMIN_EMAIL and ADMIN_PASSWORD (min 10 characters) must be set in production.');
}

const TURSO_URL = process.env.TURSO_DATABASE_URL;
if (IS_PROD && !TURSO_URL) fatal('TURSO_DATABASE_URL is not set (the free host erases local files, so a hosted database is required).');

const MAX_BODY = 30 * 1024 * 1024;       // 30 MB per request
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // 3 MB per decoded photo

/* ------------------------------------------------------------------ */
/* Database (Turso / libSQL = hosted SQLite). Locally falls back to a file. */
/* ------------------------------------------------------------------ */
let dbUrl = TURSO_URL;
if (!dbUrl) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbUrl = 'file:' + path.join(DATA_DIR, 'ecosmart.db');
  console.warn('No TURSO_DATABASE_URL set: using local file database ' + dbUrl);
}
const client = createClient({ url: dbUrl, authToken: process.env.TURSO_AUTH_TOKEN });

function rowToObj(columns, row) {
  const o = {};
  columns.forEach((c, i) => {
    let v = row[i];
    if (v instanceof ArrayBuffer || v instanceof Uint8Array) v = Buffer.from(v);
    o[c] = v;
  });
  return o;
}
// Small helper that gives us db.prepare(sql).get/all/run(...) but async.
function wrap(executor) {
  const exec = (sql, args) => executor.execute({ sql, args: args.map(a => (a === undefined ? null : a)) });
  return {
    prepare(sql) {
      return {
        get: async (...args) => { const r = await exec(sql, args); return r.rows.length ? rowToObj(r.columns, r.rows[0]) : undefined; },
        all: async (...args) => { const r = await exec(sql, args); return r.rows.map(x => rowToObj(r.columns, x)); },
        run: async (...args) => {
          const r = await exec(sql, args);
          return { lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : 0, changes: Number(r.rowsAffected || 0) };
        }
      };
    }
  };
}
const db = wrap(client);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  mobile TEXT NOT NULL,
  area TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  eco_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  latitude REAL,
  longitude REAL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pickups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area TEXT NOT NULL,
  address TEXT NOT NULL,
  slot TEXT NOT NULL,
  handover TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  agent_id INTEGER REFERENCES agents(id),
  points INTEGER NOT NULL DEFAULT 0,
  estimated_weight REAL NOT NULL DEFAULT 0,
  notification TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS pickup_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  type_label TEXT NOT NULL,
  condition TEXT NOT NULL,
  issue_details TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  estimated_weight REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pickup_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS photo_data (
  file_name TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_id INTEGER NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS eco_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pickup_id INTEGER REFERENCES pickups(id),
  points INTEGER NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  cost INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id INTEGER NOT NULL REFERENCES rewards(id),
  code TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pickup_id INTEGER NOT NULL UNIQUE REFERENCES pickups(id) ON DELETE CASCADE,
  certificate_code TEXT UNIQUE NOT NULL,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS business_enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  organisation_type TEXT NOT NULL,
  area TEXT NOT NULL,
  estimated_volume TEXT NOT NULL,
  service_needed TEXT NOT NULL,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pickups_user ON pickups(user_id);
CREATE INDEX IF NOT EXISTS idx_items_pickup ON pickup_items(pickup_id);
CREATE INDEX IF NOT EXISTS idx_photos_pickup ON pickup_photos(pickup_id);
CREATE INDEX IF NOT EXISTS idx_history_pickup ON status_history(pickup_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
`;

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */
const pointsByType = { laptop: 100, mobile: 50, tablet: 50, charger: 10, battery: 20, other: 5 };
const weightByType = { laptop: 2.2, mobile: 0.2, tablet: 0.5, charger: 0.25, battery: 0.4, other: 0.5 };
const typeLabels = { laptop: 'Laptop / Desktop', mobile: 'Mobile Phone', tablet: 'Tablet', charger: 'Charger / Adapter', battery: 'Battery', other: 'Other e-waste' };
const areas = ['Shivajinagar','Deccan','Camp','Swargate','Kothrud','Aundh','Baner','Pashan','Hinjewadi','Wakad','Koregaon Park','Kalyani Nagar','Kharadi','Katraj','Bibwewadi','Undri','Akurdi'];
const scheduleDays = { Shivajinagar:'Monday', Deccan:'Monday', Camp:'Monday', Swargate:'Monday', Kothrud:'Tuesday', Aundh:'Tuesday', Baner:'Tuesday', Pashan:'Tuesday', Hinjewadi:'Tuesday', Wakad:'Tuesday', 'Koregaon Park':'Wednesday', 'Kalyani Nagar':'Wednesday', Kharadi:'Wednesday', Katraj:'Thursday', Bibwewadi:'Thursday', Undri:'Thursday', Akurdi:'Friday' };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^[0-9+\-\s]{7,16}$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function nowIso() { return new Date().toISOString(); }
function randomCode(prefix = 'ES') { return `${prefix}-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendError(res, err) {
  const status = err && err.statusCode ? err.statusCode : 500;
  if (status === 500) console.error(err);
  sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
}

async function userFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const data = readToken(token);
  if (!data) return null;
  return (await db.prepare('SELECT id,name,email,mobile,area,role,eco_points,created_at FROM users WHERE id=?').get(data.id)) || null;
}
async function requireUser(req, res) { const user = await userFromRequest(req); if (!user) { sendJson(res, 401, { error: 'Please log in first.' }); return null; } return user; }
async function requireAdmin(req, res) { const user = await requireUser(req, res); if (!user) return null; if (user.role !== 'admin') { sendJson(res, 403, { error: 'Admin access required.' }); return null; } return user; }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', c => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) { failed = true; reject(httpError(413, 'Request too large. Please upload smaller photos.')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const v = raw ? JSON.parse(raw) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(httpError(400, 'Invalid request body.')); }
    });
    req.on('error', reject);
  });
}

/* ---- Simple in-memory rate limiter (per IP) ---- */
const rateBuckets = new Map();
function clientIp(req) {
  // Behind Render's proxy the LAST x-forwarded-for entry is the one the proxy added (not spoofable).
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
}
function rateLimited(req, res, key, max, windowMs) {
  const k = `${key}:${clientIp(req)}`;
  const now = Date.now();
  let b = rateBuckets.get(k);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(k, b); }
  b.count++;
  if (b.count > max) {
    res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
    sendJson(res, 429, { error: 'Too many attempts. Please wait a while and try again.' });
    return true;
  }
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of rateBuckets) if (b.reset < now) rateBuckets.delete(k); }, 60 * 1000).unref();

/* ---- Image validation: check the real file signature, not just the claimed type ---- */
function detectImageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function publicUser(user) { return { id: user.id, name: user.name, email: user.email, mobile: user.mobile, area: user.area, role: user.role, ecoPoints: user.eco_points }; }
async function addNotification(userId, title, message, d = db) { await d.prepare('INSERT INTO notifications(user_id,title,message) VALUES(?,?,?)').run(userId, title, message); }
async function addHistory(pickupId, status, note = '', d = db) { await d.prepare('INSERT INTO status_history(pickup_id,status,note) VALUES(?,?,?)').run(pickupId, status, note); }

async function getPickup(id, userId = null) {
  const where = userId ? 'WHERE p.id=? AND p.user_id=?' : 'WHERE p.id=?';
  const args = userId ? [id, userId] : [id];
  const p = await db.prepare(`SELECT p.*, u.name AS user_name,u.email AS user_email,u.mobile AS user_mobile,a.name AS agent_name,a.phone AS agent_phone,a.latitude AS agent_latitude,a.longitude AS agent_longitude,a.updated_at AS agent_location_updated FROM pickups p JOIN users u ON u.id=p.user_id LEFT JOIN agents a ON a.id=p.agent_id ${where}`).get(...args);
  if (!p) return null;
  const [items, photos, history] = await Promise.all([
    db.prepare('SELECT * FROM pickup_items WHERE pickup_id=? ORDER BY id').all(p.id),
    db.prepare('SELECT id,file_name,file_url FROM pickup_photos WHERE pickup_id=? ORDER BY id').all(p.id),
    db.prepare('SELECT status,note,created_at FROM status_history WHERE pickup_id=? ORDER BY id').all(p.id)
  ]);
  p.items = items; p.photos = photos; p.history = history;
  if (p.agent_latitude != null) p.gps = { latitude: p.agent_latitude, longitude: p.agent_longitude, lastUpdated: p.agent_location_updated }; else p.gps = null;
  delete p.agent_latitude; delete p.agent_longitude; delete p.agent_location_updated;
  return p;
}

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */
async function ensureSeeds() {
  const agentCount = (await db.prepare('SELECT COUNT(*) AS c FROM agents').get()).c;
  if (!agentCount) {
    await db.prepare('INSERT INTO agents(name,phone,status,latitude,longitude,updated_at) VALUES(?,?,?,?,?,?)')
      .run(process.env.AGENT_NAME || 'Rahul Sharma', process.env.AGENT_PHONE || '+91 90000 10001', 'available', 18.5204, 73.8567, nowIso());
  }
  const rewardCount = (await db.prepare('SELECT COUNT(*) AS c FROM rewards').get()).c;
  if (!rewardCount) {
    const ins = db.prepare('INSERT INTO rewards(name,description,cost) VALUES(?,?,?)');
    await ins.run('₹50 Eco Clothing Voucher', 'Sustainable clothing partner reward.', 200);
    await ins.run('10% Sustainable Food Discount', 'Organic and eco-food partner reward.', 350);
    await ins.run('₹150 Green Lifestyle Voucher', 'Eco home, refill and lifestyle reward.', 500);
  }

  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    // Admin account is controlled by environment variables.
    const row = await db.prepare('SELECT id,password_hash,role FROM users WHERE email=?').get(ADMIN_EMAIL);
    if (!row) {
      await db.prepare('INSERT INTO users(name,email,mobile,area,password_hash,role) VALUES(?,?,?,?,?,?)')
        .run('EcoSmart Admin', ADMIN_EMAIL, '0000000000', 'Pune', hashPassword(ADMIN_PASSWORD), 'admin');
      console.log('Admin account created for ' + ADMIN_EMAIL);
    } else {
      if (row.role !== 'admin') await db.prepare("UPDATE users SET role='admin' WHERE id=?").run(row.id);
      if (!verifyPassword(ADMIN_PASSWORD, row.password_hash)) {
        await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(ADMIN_PASSWORD), row.id);
        console.log('Admin password updated from ADMIN_PASSWORD.');
      }
    }
    // Remove the old public demo admin so its known password can never be used.
    if (ADMIN_EMAIL !== LEGACY_ADMIN_EMAIL) {
      await db.prepare("DELETE FROM users WHERE email=? AND role='admin'").run(LEGACY_ADMIN_EMAIL);
    }
  } else {
    // Local development only.
    const admin = await db.prepare('SELECT id FROM users WHERE email=?').get(LEGACY_ADMIN_EMAIL);
    if (!admin) {
      await db.prepare('INSERT INTO users(name,email,mobile,area,password_hash,role) VALUES(?,?,?,?,?,?)')
        .run('EcoSmart Admin', LEGACY_ADMIN_EMAIL, '9000000000', 'Pune', hashPassword('Admin@123'), 'admin');
    }
    console.warn('WARNING: ADMIN_EMAIL / ADMIN_PASSWORD not set. Using the demo admin (local development only).');
  }
}

/* ------------------------------------------------------------------ */
/* Pickup slots                                                        */
/* ------------------------------------------------------------------ */
function nextSlots(area) {
  const day = scheduleDays[area] || 'Saturday';
  const dayNums = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const today = new Date(); const d = (dayNums[day] - today.getDay() + 7) % 7 || 7;
  const date = new Date(today); date.setDate(today.getDate() + d);
  const date2 = new Date(date); date2.setDate(date.getDate() + 7);
  const fmt = x => x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  return [`${day} · ${fmt(date)} · 10:00 AM – 2:00 PM`, `${day} · ${fmt(date)} · 2:00 PM – 5:00 PM`, `${day} · ${fmt(date2)} · 10:00 AM – 2:00 PM`, `${day} · ${fmt(date2)} · 2:00 PM – 5:00 PM`];
}

/* ------------------------------------------------------------------ */
/* Static files (allow-list: never expose server.js, the database, etc.) */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const BLOCKED_DIRS = new Set(['data', 'node_modules', 'uploads']);
const BLOCKED_FILES = new Set(['server.js']);

function sendFile(req, res, filePath, ext, cacheControl) {
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return sendJson(res, 400, { error: 'Bad request' }); }
  if (pathname.includes('\0')) return sendJson(res, 400, { error: 'Bad request' });

  // Uploaded photos are stored in the database (the free host's disk is erased on restart)
  if (pathname.startsWith('/uploads/')) {
    const name = path.basename(pathname);
    const row = await db.prepare('SELECT mime,data FROM photo_data WHERE file_name=?').get(name);
    if (!row) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': row.data.length, 'Cache-Control': 'private, max-age=3600' });
    return res.end(req.method === 'HEAD' ? undefined : row.data);
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, rel);
  if (!filePath.startsWith(ROOT + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  const parts = path.relative(ROOT, filePath).split(path.sep);
  const ext = path.extname(filePath).toLowerCase();
  if (parts.some(p => p.startsWith('.')) ||
      BLOCKED_DIRS.has(parts[0].toLowerCase()) ||
      BLOCKED_FILES.has(parts[parts.length - 1].toLowerCase()) ||
      !MIME[ext]) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
    sendFile(req, res, filePath, ext, ext === '.html' ? 'no-cache' : 'public, max-age=3600');
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function api(req, res) {
  const url = new URL(req.url, 'http://localhost'); const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    await db.prepare('SELECT 1 AS ok').get();
    return sendJson(res, 200, { ok: true, service: 'EcoSmart', time: nowIso() });
  }

  if (req.method === 'POST' && pathname === '/api/business-enquiries') {
    if (rateLimited(req, res, 'enquiry', 10, 60 * 60 * 1000)) return;
    const b = await parseBody(req);
    const required = ['organisation', 'contactName', 'email', 'phone', 'organisationType', 'area', 'estimatedVolume', 'serviceNeeded'];
    if (required.some(k => !String(b[k] || '').trim())) return sendJson(res, 400, { error: 'Please complete all required organisation details.' });
    const email = str(b.email, 200); if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'Please enter a valid email address.' });
    const result = await db.prepare('INSERT INTO business_enquiries(organisation,contact_name,email,phone,organisation_type,area,estimated_volume,service_needed,notes) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(str(b.organisation, 200), str(b.contactName, 120), email, str(b.phone, 30), str(b.organisationType, 100), str(b.area, 100), str(b.estimatedVolume, 100), str(b.serviceNeeded, 200), str(b.notes, 2000));
    return sendJson(res, 201, { ok: true, enquiryId: result.lastInsertRowid, message: 'Your enquiry has been saved. EcoSmart will review it and contact you to discuss a suitable collection plan.' });
  }

  if (req.method === 'GET' && pathname === '/api/admin/business-enquiries') {
    const u = await requireAdmin(req, res); if (!u) return;
    return sendJson(res, 200, { enquiries: await db.prepare('SELECT * FROM business_enquiries ORDER BY id DESC').all() });
  }

  if (req.method === 'GET' && pathname === '/api/areas') return sendJson(res, 200, { areas, slots: Object.fromEntries(areas.map(a => [a, nextSlots(a)])) });

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    if (rateLimited(req, res, 'register', 10, 60 * 60 * 1000)) return;
    const b = await parseBody(req);
    if (!b.name || !b.email || !b.mobile || !b.area || !b.password) return sendJson(res, 400, { error: 'Please complete all required fields.' });
    if (!areas.includes(b.area)) return sendJson(res, 400, { error: 'Please select a valid service area.' });
    const password = String(b.password);
    if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    if (password.length > 200) return sendJson(res, 400, { error: 'Password is too long.' });
    const email = str(b.email, 200).toLowerCase();
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'Please enter a valid email address.' });
    const mobile = str(b.mobile, 20);
    if (!MOBILE_RE.test(mobile)) return sendJson(res, 400, { error: 'Please enter a valid mobile number.' });
    try {
      const result = await db.prepare('INSERT INTO users(name,email,mobile,area,password_hash) VALUES(?,?,?,?,?)').run(str(b.name, 100), email, mobile, b.area, hashPassword(password));
      const user = await db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
      return sendJson(res, 201, { token: createToken(user), user: publicUser(user) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return sendJson(res, 409, { error: 'An account with that email already exists.' });
      throw e;
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (rateLimited(req, res, 'login', 10, 15 * 60 * 1000)) return;
    const b = await parseBody(req);
    const raw = str(b.identifier, 200); const identifier = raw.toLowerCase(); const password = String(b.password || '').slice(0, 200);
    const rows = await db.prepare('SELECT * FROM users WHERE lower(email)=? OR mobile=?').all(identifier, raw);
    if (!rows.length) hashPassword(password); // keep timing similar whether or not the account exists
    const user = rows.find(r => verifyPassword(password, r.password_hash));
    if (!user) return sendJson(res, 401, { error: 'Incorrect email/mobile or password.' });
    return sendJson(res, 200, { token: createToken(user), user: publicUser(user) });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') { const u = await requireUser(req, res); if (!u) return; return sendJson(res, 200, { user: publicUser(u) }); }

  if (req.method === 'GET' && pathname === '/api/pickups') {
    const u = await requireUser(req, res); if (!u) return;
    const rows = await db.prepare('SELECT id FROM pickups WHERE user_id=? ORDER BY id DESC').all(u.id);
    return sendJson(res, 200, { pickups: await Promise.all(rows.map(x => getPickup(x.id, u.id))) });
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/pickups\/\d+\/(cancel|reschedule)$/)) {
    const u = await requireUser(req, res); if (!u) return;
    const parts = pathname.split('/'); const id = Number(parts[3]); const action = parts[4];
    const pickup = await db.prepare('SELECT * FROM pickups WHERE id=? AND user_id=?').get(id, u.id);
    if (!pickup) return sendJson(res, 404, { error: 'Pickup not found.' });
    if (pickup.status !== 'pending') return sendJson(res, 400, { error: 'Only pending requests can be changed here. Please contact support for an assigned pickup.' });
    if (action === 'cancel') {
      const r = await db.prepare("UPDATE pickups SET status='rejected',notification=? WHERE id=? AND status='pending'").run('Pickup cancelled by user.', id);
      if (!r.changes) return sendJson(res, 400, { error: 'This pickup can no longer be cancelled.' });
      await addHistory(id, 'rejected', 'Cancelled by user before assignment.');
      await addNotification(u.id, 'Pickup cancelled', `Your pickup ${pickup.tracking_id} was cancelled.`);
      return sendJson(res, 200, { ok: true, pickup: await getPickup(id, u.id) });
    }
    const b = await parseBody(req);
    if (!b.area || !b.slot || !areas.includes(b.area)) return sendJson(res, 400, { error: 'Choose a valid area and pickup slot.' });
    if (!nextSlots(b.area).includes(b.slot)) return sendJson(res, 400, { error: 'That slot is no longer available. Please choose another slot.' });
    await db.prepare('UPDATE pickups SET area=?,slot=?,notification=? WHERE id=?').run(b.area, b.slot, 'Your pickup has been rescheduled and is awaiting verification.', id);
    await addHistory(id, 'pending', `Rescheduled to ${b.area}, ${b.slot}.`);
    await addNotification(u.id, 'Pickup rescheduled', `Pickup ${pickup.tracking_id} is now scheduled for ${b.slot} in ${b.area}.`);
    return sendJson(res, 200, { ok: true, pickup: await getPickup(id, u.id) });
  }

  if (req.method === 'GET' && pathname === '/api/pickups/latest') {
    const u = await requireUser(req, res); if (!u) return;
    const row = await db.prepare('SELECT id FROM pickups WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
    return sendJson(res, 200, { pickup: row ? await getPickup(row.id, u.id) : null });
  }

  if (req.method === 'POST' && pathname === '/api/pickups') {
    const u = await requireUser(req, res); if (!u) return;
    if (rateLimited(req, res, 'pickup', 20, 60 * 60 * 1000)) return;
    const b = await parseBody(req);
    if (!b.area || !b.address || !b.slot || !b.handover || !Array.isArray(b.items) || !b.items.length) return sendJson(res, 400, { error: 'Please complete the pickup details.' });
    if (!areas.includes(b.area)) return sendJson(res, 400, { error: 'Invalid service area.' });
    if (!nextSlots(b.area).includes(b.slot)) return sendJson(res, 400, { error: 'That slot is no longer available. Please choose another slot.' });
    if (b.items.length > 20) return sendJson(res, 400, { error: 'Please add at most 20 items per pickup.' });
    if (b.items.some(x => !x || !Object.prototype.hasOwnProperty.call(pointsByType, x.type))) return sendJson(res, 400, { error: 'One of the items has an invalid type.' });

    const items = b.items.map(x => ({
      type: x.type, typeLabel: typeLabels[x.type], condition: str(x.condition, 100), issueDetails: str(x.issueDetails, 500),
      points: pointsByType[x.type], estimatedWeight: weightByType[x.type]
    }));
    const totalPoints = items.reduce((s, x) => s + x.points, 0);
    const totalWeight = items.reduce((s, x) => s + x.estimatedWeight, 0);
    const tracking = randomCode();

    // Validate photos before touching the database
    const photoFiles = [];
    const photos = Array.isArray(b.photos) ? b.photos.slice(0, 8) : [];
    for (const dataUrl of photos) {
      const match = String(dataUrl).match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) continue;
      const buf = Buffer.from(match[2], 'base64');
      if (buf.length > MAX_PHOTO_BYTES) return sendJson(res, 413, { error: 'Each photo must be under 3 MB.' });
      const ext = detectImageExt(buf);
      if (!ext) continue; // not a real png/jpg/webp
      photoFiles.push({ buf, ext });
    }

    // Everything is saved in one transaction: all of it succeeds or none of it does.
    const tx = await client.transaction('write');
    const t = wrap(tx);
    let pid;
    try {
      const result = await t.prepare('INSERT INTO pickups(tracking_id,user_id,area,address,slot,handover,description,status,points,estimated_weight,notification) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(tracking, u.id, b.area, str(b.address, 500), b.slot, str(b.handover, 100), str(b.description, 1000), 'pending', totalPoints, totalWeight, 'Your request is awaiting admin verification.');
      pid = result.lastInsertRowid;
      const itemStmt = t.prepare('INSERT INTO pickup_items(pickup_id,type,type_label,condition,issue_details,points,estimated_weight) VALUES(?,?,?,?,?,?,?)');
      for (const x of items) await itemStmt.run(pid, x.type, x.typeLabel, x.condition, x.issueDetails, x.points, x.estimatedWeight);
      for (let i = 0; i < photoFiles.length; i++) {
        const p = photoFiles[i];
        const fileName = `${tracking}-${i + 1}.${p.ext}`;
        await t.prepare('INSERT INTO photo_data(file_name,mime,data) VALUES(?,?,?)').run(fileName, IMAGE_MIME[p.ext], p.buf);
        await t.prepare('INSERT INTO pickup_photos(pickup_id,file_name,file_url) VALUES(?,?,?)').run(pid, fileName, `/uploads/${fileName}`);
      }
      await addHistory(pid, 'pending', 'Request submitted by user.', t);
      await addNotification(u.id, 'Pickup request submitted', `Request ${tracking} is waiting for verification.`, t);
      await tx.commit();
    } catch (e) {
      try { await tx.rollback(); } catch {}
      throw e;
    } finally {
      tx.close();
    }
    return sendJson(res, 201, { pickup: await getPickup(pid, u.id) });
  }

  if (req.method === 'GET' && pathname === '/api/rewards') {
    const u = await requireUser(req, res); if (!u) return;
    return sendJson(res, 200, { rewards: await db.prepare('SELECT id,name,description,cost FROM rewards WHERE active=1 ORDER BY cost').all() });
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/rewards\/\d+\/redeem$/)) {
    const u = await requireUser(req, res); if (!u) return;
    const id = Number(pathname.split('/')[3]);
    const reward = await db.prepare('SELECT * FROM rewards WHERE id=? AND active=1').get(id);
    if (!reward) return sendJson(res, 404, { error: 'Reward not found.' });
    // Atomic: only deducts if the user still has enough points (prevents double-spending)
    const spent = await db.prepare('UPDATE users SET eco_points=eco_points-? WHERE id=? AND eco_points>=?').run(reward.cost, u.id, reward.cost);
    if (!spent.changes) return sendJson(res, 400, { error: 'Not enough EcoPoints yet.' });
    const code = `ECO-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await db.prepare('INSERT INTO redemptions(user_id,reward_id,code) VALUES(?,?,?)').run(u.id, id, code);
    await db.prepare('INSERT INTO eco_transactions(user_id,points,type,note) VALUES(?,?,?,?)').run(u.id, -reward.cost, 'reward_redemption', reward.name);
    await addNotification(u.id, 'Reward redeemed', `${reward.name} is ready. Voucher code: ${code}`);
    const fresh = await db.prepare('SELECT eco_points FROM users WHERE id=?').get(u.id);
    return sendJson(res, 200, { code, reward: reward.name, newBalance: fresh.eco_points });
  }

  if (req.method === 'GET' && pathname === '/api/notifications') {
    const u = await requireUser(req, res); if (!u) return;
    return sendJson(res, 200, { notifications: await db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(u.id) });
  }
  if (req.method === 'POST' && pathname === '/api/notifications/read') {
    const u = await requireUser(req, res); if (!u) return;
    await db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(u.id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/dashboard') {
    const u = await requireUser(req, res); if (!u) return;
    const [agg, devRow, lapRow] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(estimated_weight),0) AS w FROM pickups WHERE user_id=? AND status='recycled'").get(u.id),
      db.prepare("SELECT COUNT(*) AS c FROM pickup_items pi JOIN pickups p ON p.id=pi.pickup_id WHERE p.user_id=? AND p.status='recycled'").get(u.id),
      db.prepare("SELECT 1 AS x FROM pickup_items pi JOIN pickups p ON p.id=pi.pickup_id WHERE p.user_id=? AND p.status='recycled' AND pi.type='laptop' LIMIT 1").get(u.id)
    ]);
    const completedCount = agg.n; const weight = agg.w; const devices = devRow.c; const laptopDone = !!lapRow;
    const impact = Math.round(weight * 42);
    const points = u.eco_points;
    let level = '🌱 Seedling', next = 200, base = 0;
    if (points >= 1000) { level = '🌎 Planet Protector'; next = null; base = 1000; }
    else if (points >= 500) { level = '🌳 Eco Champion'; next = 1000; base = 500; }
    else if (points >= 200) { level = '🌿 Green Starter'; next = 500; base = 200; }
    const progress = next === null ? 100 : Math.max(0, Math.min(100, ((points - base) / (next - base)) * 100));
    const achievements = [
      { icon: '♻️', name: 'First Recycler', desc: 'Complete your first pickup', earned: completedCount >= 1 },
      { icon: '💻', name: 'Tech Recycler', desc: 'Recycle a device', earned: laptopDone },
      { icon: '🌍', name: 'Planet Protector', desc: 'Recycle 10 kg', earned: weight >= 10 },
      { icon: '🏆', name: 'Eco Regular', desc: 'Complete 5 pickups', earned: completedCount >= 5 }
    ];
    return sendJson(res, 200, { user: publicUser(u), stats: { weight: Number(weight.toFixed(1)), devices, completedPickups: completedCount, impactScore: impact }, level: { name: level, next, progress }, achievements });
  }

  if (req.method === 'GET' && pathname === '/api/admin/pickups') {
    const u = await requireAdmin(req, res); if (!u) return;
    const rows = await db.prepare("SELECT id FROM pickups ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC").all();
    return sendJson(res, 200, { pickups: await Promise.all(rows.map(x => getPickup(x.id))) });
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/approve$/)) {
    const u = await requireAdmin(req, res); if (!u) return;
    const id = Number(pathname.split('/')[4]); const p = await getPickup(id);
    if (!p) return sendJson(res, 404, { error: 'Pickup not found.' });
    if (p.status !== 'pending') return sendJson(res, 400, { error: 'Only pending pickups can be approved.' });
    const agent = (await db.prepare("SELECT * FROM agents WHERE status='available' ORDER BY id LIMIT 1").get()) || (await db.prepare('SELECT * FROM agents ORDER BY id LIMIT 1').get());
    if (!agent) return sendJson(res, 500, { error: 'No collection agent is configured.' });
    const r = await db.prepare("UPDATE pickups SET status='assigned',agent_id=?,notification=? WHERE id=? AND status='pending'").run(agent.id, `Agent ${agent.name} has been assigned. Tracking ID: ${p.tracking_id}.`, id);
    if (!r.changes) return sendJson(res, 400, { error: 'Only pending pickups can be approved.' });
    await db.prepare("UPDATE agents SET status='assigned',updated_at=? WHERE id=?").run(nowIso(), agent.id);
    await addHistory(id, 'assigned', `Assigned to ${agent.name}.`);
    await addNotification(p.user_id, 'Agent assigned', `Agent ${agent.name} has been assigned to pickup ${p.tracking_id}.`);
    return sendJson(res, 200, { pickup: await getPickup(id) });
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/collect$/)) {
    const u = await requireAdmin(req, res); if (!u) return;
    const id = Number(pathname.split('/')[4]); const p = await getPickup(id);
    if (!p) return sendJson(res, 404, { error: 'Pickup not found.' });
    if (p.status !== 'assigned') return sendJson(res, 400, { error: 'Only assigned pickups can be marked as collected.' });
    const r = await db.prepare("UPDATE pickups SET status='collected',notification=? WHERE id=? AND status='assigned'").run(`Your e-waste has been collected by ${p.agent_name || 'the EcoSmart agent'}.`, id);
    if (!r.changes) return sendJson(res, 400, { error: 'Only assigned pickups can be marked as collected.' });
    await addHistory(id, 'collected', 'Items handed over to collection agent.');
    await addNotification(p.user_id, 'Pickup collected', 'Your e-waste has been collected successfully.');
    return sendJson(res, 200, { pickup: await getPickup(id) });
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/recycle$/)) {
    const u = await requireAdmin(req, res); if (!u) return;
    const id = Number(pathname.split('/')[4]); const p = await getPickup(id);
    if (!p) return sendJson(res, 404, { error: 'Pickup not found.' });
    if (p.status === 'recycled') return sendJson(res, 200, { pickup: p });
    if (p.status !== 'collected') return sendJson(res, 400, { error: 'Only collected pickups can be marked as recycled.' });
    // The "AND status='collected'" makes sure points can only be awarded once, even with two clicks at once.
    const r = await db.prepare("UPDATE pickups SET status='recycled',completed_at=?,notification=? WHERE id=? AND status='collected'").run(nowIso(), `Your e-waste has been responsibly processed. You earned ${p.points} EcoPoints.`, id);
    if (!r.changes) return sendJson(res, 400, { error: 'This pickup has already been processed.' });
    await db.prepare('UPDATE users SET eco_points=eco_points+? WHERE id=?').run(p.points, p.user_id);
    await db.prepare('INSERT INTO eco_transactions(user_id,pickup_id,points,type,note) VALUES(?,?,?,?,?)').run(p.user_id, id, p.points, 'recycling_reward', `Points for ${p.tracking_id}`);
    await addHistory(id, 'recycled', `Recycling completed. ${p.points} points credited.`);
    await addNotification(p.user_id, '♻️ Recycling completed', `You earned ${p.points} EcoPoints for pickup ${p.tracking_id}.`);
    const cert = randomCode('CERT');
    await db.prepare('INSERT INTO certificates(user_id,pickup_id,certificate_code) VALUES(?,?,?)').run(p.user_id, id, cert);
    if (p.agent_id) await db.prepare("UPDATE agents SET status='available',updated_at=? WHERE id=?").run(nowIso(), p.agent_id);
    return sendJson(res, 200, { pickup: await getPickup(id), certificate: cert });
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/admin\/pickups\/\d+\/reject$/)) {
    const u = await requireAdmin(req, res); if (!u) return;
    const id = Number(pathname.split('/')[4]); const b = await parseBody(req); const p = await getPickup(id);
    if (!p) return sendJson(res, 404, { error: 'Pickup not found.' });
    if (p.status === 'recycled' || p.status === 'rejected') return sendJson(res, 400, { error: 'This pickup can no longer be rejected.' });
    const reason = str(b.reason, 300);
    await db.prepare("UPDATE pickups SET status='rejected',notification=? WHERE id=?").run(`Request rejected: ${reason || 'Please contact EcoSmart support.'}`, id);
    if (p.agent_id) await db.prepare("UPDATE agents SET status='available',updated_at=? WHERE id=?").run(nowIso(), p.agent_id);
    await addHistory(id, 'rejected', reason || 'Request rejected by admin.');
    await addNotification(p.user_id, 'Pickup request needs attention', `Request ${p.tracking_id} was rejected. ${reason}`);
    return sendJson(res, 200, { pickup: await getPickup(id) });
  }

  if (req.method === 'POST' && pathname === '/api/admin/agent/location') {
    const u = await requireAdmin(req, res); if (!u) return;
    const b = await parseBody(req); const id = Number(b.agentId); const lat = Number(b.latitude); const lng = Number(b.longitude);
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return sendJson(res, 400, { error: 'Invalid location.' });
    await db.prepare('UPDATE agents SET latitude=?,longitude=?,updated_at=? WHERE id=?').run(lat, lng, nowIso(), id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/certificate/latest') {
    const u = await requireUser(req, res); if (!u) return;
    const row = await db.prepare('SELECT c.*,p.tracking_id,p.points,p.estimated_weight FROM certificates c JOIN pickups p ON p.id=c.pickup_id WHERE c.user_id=? ORDER BY c.id DESC LIMIT 1').get(u.id);
    return sendJson(res, 200, { certificate: row || null });
  }

  if (req.method === 'GET' && pathname === '/api/public/impact') {
    const [w, d, us] = await Promise.all([
      db.prepare("SELECT COALESCE(SUM(estimated_weight),0) AS w FROM pickups WHERE status='recycled'").get(),
      db.prepare("SELECT COUNT(*) AS c FROM pickup_items pi JOIN pickups p ON p.id=pi.pickup_id WHERE p.status='recycled'").get(),
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='user'").get()
    ]);
    return sendJson(res, 200, { weight: Number(w.w.toFixed(1)), devices: d.c, users: us.c });
  }

  return sendJson(res, 404, { error: 'API endpoint not found.' });
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (IS_PROD) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      // Redirect plain http to https (the host's proxy tells us which one the visitor used)
      if (req.headers['x-forwarded-proto'] === 'http' && !req.url.startsWith('/api/health')) {
        res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
        return res.end();
      }
    }
    if (req.url.startsWith('/api/')) return await api(req, res);
    return await serveStatic(req, res);
  } catch (e) { return sendError(res, e); }
});

(async () => {
  try {
    await client.executeMultiple(SCHEMA);
    await ensureSeeds();
  } catch (e) {
    console.error(e);
    fatal('Could not connect to or set up the database. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`EcoSmart running on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
    console.log(`Database: ${TURSO_URL ? 'Turso (hosted)' : dbUrl}`);
  });
})();

function shutdown() {
  server.close(() => { try { client.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);