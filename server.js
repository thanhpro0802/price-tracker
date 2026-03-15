/**
 * Smart Price Tracker — Backend v4
 * Auth: JWT + bcrypt-like (PBKDF2 via Node crypto)
 * DB:   JSON file (db.json) — không cần cài thêm package
 */
const http   = require('http');
const https  = require('https');
const urlMod = require('url');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { discoverAndAddAsset, refreshDynamicAssetPrice } = require('./ai-agent');

// ─── Load .env file (không cần cài dotenv package) ───────────
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;        // bỏ comment
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim()
      .replace(/^["']/, '').replace(/["']$/, '');            // bỏ quotes
    if (key && !process.env[key]) {                          // không ghi đè env đã có
      process.env[key] = val;
    }
  }
  console.log('[Config] Loaded .env file');
})();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'spt-secret-change-in-production-' + crypto.randomBytes(16).toString('hex');
const DB_FILE    = path.join(__dirname, 'db.json');

// ─── CONFIG ──────────────────────────────────────────────────
const CFG = {
  GEMINI_API_KEY:  process.env.GEMINI_API_KEY || '',
  HISTORY_TTL_MS:     60 * 60 * 1000,
  UPDATE_INTERVAL_MS:  5 * 60 * 1000,
  HISTORY_DELAY_MS:   8000,
};

// ─── JSON DATABASE ───────────────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return { users: {}, watchlists: {}, alerts: {}, hiddenAssets: {}, dynamicAssets: {} };
}

// Hidden assets — per user
function getHiddenAssets(userId) {
  DB = loadDB();
  return (DB.hiddenAssets || {})[userId] || [];
}
function hideAsset(userId, id) {
  DB = loadDB();
  if (!DB.hiddenAssets) DB.hiddenAssets = {};
  if (!DB.hiddenAssets[userId]) DB.hiddenAssets[userId] = [];
  if (!DB.hiddenAssets[userId].includes(id)) {
    DB.hiddenAssets[userId].push(id);
    saveDB(DB);
  }
}
function unhideAsset(userId, id) {
  DB = loadDB();
  if (!DB.hiddenAssets) DB.hiddenAssets = {};
  if (!DB.hiddenAssets[userId]) DB.hiddenAssets[userId] = [];
  DB.hiddenAssets[userId] = DB.hiddenAssets[userId].filter(x => x !== id);
  saveDB(DB);
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let DB = loadDB();

// ─── DYNAMIC ASSETS — per user ───────────────────────────────
function loadDynamicAssets(userId) {
  DB = loadDB();
  return ((DB.dynamicAssets || {})[userId]) || [];
}
function saveDynamicAsset(userId, asset) {
  DB = loadDB();
  if (!DB.dynamicAssets) DB.dynamicAssets = {};
  if (!DB.dynamicAssets[userId]) DB.dynamicAssets[userId] = [];
  // Upsert by id
  DB.dynamicAssets[userId] = DB.dynamicAssets[userId].filter(a => a.id !== asset.id);
  DB.dynamicAssets[userId].push(asset);
  saveDB(DB);
}
function deleteDynamicAsset(userId, id) {
  DB = loadDB();
  if (!DB.dynamicAssets) DB.dynamicAssets = {};
  if (!DB.dynamicAssets[userId]) return;
  DB.dynamicAssets[userId] = DB.dynamicAssets[userId].filter(a => a.id !== id);
  saveDB(DB);
}
// Generate unique asset ID per user (không conflict giữa users)
function nextAssetId(userId) {
  const assets = loadDynamicAssets(userId);
  const maxDyn = assets.length > 0 ? Math.max(...assets.map(a => a.id)) : 0;
  // User-scoped IDs: userId hash prefix để tránh conflict
  // Dùng 1000 + index để không đụng static IDs (1-11)
  return Math.max(maxDyn + 1, 1000 + assets.length + 1);
}
// Store dynamic asset prices in main cache
async function refreshAllDynamicAssets() {
  DB = loadDB();
  const allUserAssets = DB.dynamicAssets || {};
  // Deduplicate by asset id (same asset added by multiple users → fetch once)
  const seen = new Set();
  const uniqueAssets = [];
  for (const userAssets of Object.values(allUserAssets)) {
    for (const asset of userAssets) {
      if (!seen.has(asset.id)) { seen.add(asset.id); uniqueAssets.push(asset); }
    }
  }
  for (const asset of uniqueAssets) {
    const p = await refreshDynamicAssetPrice(asset);
    if (p) {
      const prev = cache.prices[asset.id]?.price || asset.price;
      cache.prices[asset.id] = {
        price:     p.price,
        change24h: prev ? +((p.price - prev) / prev * 100).toFixed(4) : 0,
        updatedAt: Date.now(),
        source:    p.source,
        dynamic:   true,
        name:      asset.name,  sym:   asset.sym,
        cat:       asset.cat,   icon:  asset.icon,
        color:     asset.color, cur:   asset.cur,
        fetchStrategy: asset.fetchStrategy,
        fetchParam:    asset.fetchParam,
        fetchParam2:   asset.fetchParam2,
      };
    }
  }
}

// ─── PASSWORD HASHING (PBKDF2 — built-in Node.js) ───────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

// ─── JWT (manual implementation — no jsonwebtoken package) ──
function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function signJWT(payload, expiresInSec = 7 * 24 * 3600) {
  const header  = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + expiresInSec }));
  const sig     = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now()/1000)) return null; // expired
    return payload;
  } catch(e) { return null; }
}
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
function authMiddleware(req) {
  const token = extractToken(req);
  if (!token) return null;
  return verifyJWT(token);
}

// ─── PRICE CACHE ─────────────────────────────────────────────
const cache = {
  prices: {}, history: {}, inFlight: {}, lastFetch: null,
  status: { crypto: 'idle', currency: 'idle', metal: 'idle' },
};

// ─── HTTP HELPER ─────────────────────────────────────────────
function fetchJSON(reqUrl, headers = {}, retries = 0) {
  return new Promise((resolve, reject) => {
    const p = urlMod.parse(reqUrl);
    const lib = p.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: p.hostname, path: p.path,
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      headers: { 'User-Agent': 'SmartPriceTracker/4.0', 'Accept': 'application/json', ...headers },
      timeout: 12000,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const obj = JSON.parse(raw);
          if (res.statusCode === 429 && retries < 2) {
            const wait = 15000 * Math.pow(2, retries);
            console.log(`[${ts()}] ⏳ 429 — retry in ${wait/1000}s`);
            setTimeout(() => fetchJSON(reqUrl, headers, retries + 1).then(resolve).catch(reject), wait);
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(obj);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 100)}`));
          }
        } catch(e) { reject(new Error(`JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function ts() { return new Date().toISOString().slice(11, 19); }

// ─── PRICE FETCHERS ──────────────────────────────────────────
async function fetchCryptoPrices() {
  cache.status.crypto = 'loading';
  try {
    const d = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true');
    const map = { bitcoin: 1, ethereum: 2, solana: 3 };
    for (const [coin, id] of Object.entries(map)) {
      if (!d[coin]) continue;
      cache.prices[id] = { price: d[coin].usd, change24h: +(d[coin].usd_24h_change||0).toFixed(4), updatedAt: Date.now(), source: 'coingecko' };
    }
    cache.status.crypto = 'ok';
    console.log(`[${ts()}] ✅ Crypto BTC:$${Math.round(cache.prices[1]?.price).toLocaleString('en-US')}`);
  } catch(e) { cache.status.crypto = 'error'; console.error(`[${ts()}] ❌ Crypto:`, e.message); }
}

async function fetchCryptoHistory(coinId, assetId, days) {
  const key = `${assetId}_${days}d`;
  const cached = cache.history[key];
  if (cached && Date.now() - cached.fetchedAt < CFG.HISTORY_TTL_MS) return;
  if (cache.inFlight[key]) { await cache.inFlight[key]; return; }
  const doFetch = async () => {
    try {
      const d = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`);
      if (d.prices?.length > 0) {
        cache.history[key] = { data: d.prices.map(([t,p]) => ({ time:t, price:+p.toFixed(4) })), fetchedAt: Date.now(), source: 'coingecko' };
        console.log(`[${ts()}] ✅ History: ${coinId} ${days}d (${d.prices.length} pts)`);
      }
    } catch(e) { console.error(`[${ts()}] ❌ History ${coinId} ${days}d:`, e.message); }
    finally { delete cache.inFlight[key]; }
  };
  cache.inFlight[key] = doFetch();
  await cache.inFlight[key];
}

async function prefetchPriorityHistory() {
  const coins = [{ coin: 'bitcoin', id: 1 }, { coin: 'ethereum', id: 2 }, { coin: 'solana', id: 3 }];
  let fetched = 0;
  for (const { coin, id } of coins) {
    for (const days of [1, 7]) {
      const key = `${id}_${days}d`;
      if (cache.history[key] && Date.now() - cache.history[key].fetchedAt < CFG.HISTORY_TTL_MS) continue;
      await fetchCryptoHistory(coin, id, days);
      fetched++;
      if (fetched < coins.length * 2) await sleep(CFG.HISTORY_DELAY_MS);
    }
  }
  console.log(`[${ts()}] ✅ History prefetch done`);
}

async function fetchCurrency() {
  cache.status.currency = 'loading';
  try {
    const d = await fetchJSON('https://open.er-api.com/v6/latest/USD');
    if (d.result !== 'success') throw new Error('non-success');
    const { VND, JPY, EUR } = d.rates;
    cache.prices[4] = { price: Math.round(VND), change24h: 0, updatedAt: Date.now(), source: 'exchangerate-api' };
    cache.prices[5] = { price: +((VND/JPY).toFixed(2)), change24h: 0, updatedAt: Date.now(), source: 'exchangerate-api' };
    cache.prices[6] = { price: Math.round(VND/EUR), change24h: 0, updatedAt: Date.now(), source: 'exchangerate-api' };
    cache.status.currency = 'ok';
    console.log(`[${ts()}] ✅ Currency USD/VND:${Math.round(VND).toLocaleString('en-US')}`);
  } catch(e) {
    cache.status.currency = 'error'; console.error(`[${ts()}] ❌ Currency:`, e.message);
    try {
      const fb = await fetchJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,JPY');
      const vnd = cache.prices[4]?.price || 25000;
      if (fb.rates?.EUR) cache.prices[6] = { price: Math.round(vnd/fb.rates.EUR), change24h:0, updatedAt:Date.now(), source:'frankfurter' };
      if (fb.rates?.JPY) cache.prices[5] = { price: +((vnd/fb.rates.JPY).toFixed(2)), change24h:0, updatedAt:Date.now(), source:'frankfurter' };
      cache.status.currency = 'fallback';
    } catch(e2) {}
  }
}

// ─── METALS — api.gold-api.com (FREE, không cần key) ─────────
// Cache 1 phút theo khuyến cáo của API docs để tránh bị block IP
const metalCache = { fetchedAt: 0, TTL: 60 * 1000 };

async function fetchMetals() {
  const remaining = metalCache.TTL - (Date.now() - metalCache.fetchedAt);
  if (metalCache.fetchedAt && remaining > 0) {
    console.log(`[${ts()}] ⚡ Metals cache fresh (${Math.round(remaining/1000)}s left)`);
    return;
  }

  cache.status.metal = 'loading';
  try {
    // GET https://api.gold-api.com/price/{symbol} — no auth, no rate limit
    const [g, s] = await Promise.all([
      fetchJSON('https://api.gold-api.com/price/XAU'),
      fetchJSON('https://api.gold-api.com/price/XAG'),
    ]);

    // Response: { name, price, symbol, updatedAt, updatedAtReadable }
    // price là USD per troy oz
    const goldPrice   = +parseFloat(g.price).toFixed(2);
    const silverPrice = +parseFloat(s.price).toFixed(2);

    // Tính change từ giá fetch trước
    const prevGold   = cache.prices[7]?.price;
    const prevSilver = cache.prices[8]?.price;
    const goldCh   = prevGold   ? +((goldPrice   - prevGold)   / prevGold   * 100).toFixed(2) : 0;
    const silverCh = prevSilver ? +((silverPrice - prevSilver) / prevSilver * 100).toFixed(2) : 0;

    cache.prices[7] = { price: goldPrice,   change24h: goldCh,   updatedAt: Date.now(), source: 'gold-api.com', lastUpdated: g.updatedAtReadable };
    cache.prices[8] = { price: silverPrice, change24h: silverCh, updatedAt: Date.now(), source: 'gold-api.com', lastUpdated: s.updatedAtReadable };

    metalCache.fetchedAt = Date.now();
    cache.status.metal = 'ok';
    console.log(`[${ts()}] ✅ Metals — Gold: $${goldPrice}/oz, Silver: $${silverPrice}/oz`);
  } catch(e) {
    cache.status.metal = 'error';
    console.error(`[${ts()}] ❌ gold-api.com:`, e.message);
    if (!cache.prices[7]) {
      cache.prices[7] = { price: 3100.00, change24h: 0, updatedAt: Date.now(), source: 'mock' };
      cache.prices[8] = { price: 34.50,   change24h: 0, updatedAt: Date.now(), source: 'mock' };
    }
  }
}

function initProducts() {
  cache.prices[9]  = { price: 29990000, change24h: 0.0, updatedAt: Date.now(), source: 'static' };
  cache.prices[10] = { price: 62900000, change24h: -2.1, updatedAt: Date.now(), source: 'static' };
  cache.prices[11] = { price: 45000000, change24h: -4.3, updatedAt: Date.now(), source: 'static' };
}

async function fetchAll() {
  console.log(`[${ts()}] 🔄 Fetching prices...`);
  await Promise.allSettled([fetchCryptoPrices(), fetchCurrency(), fetchMetals(), refreshAllDynamicAssets()]);
  cache.lastFetch = Date.now();
  console.log(`[${ts()}] ✅ Prices done`);
  prefetchPriorityHistory().catch(() => {});
}

function mockHistory(base, days, vol = 0.03) {
  const pts = days <= 1 ? 24 : days;
  const iv  = days <= 1 ? 3600000 : 86400000;
  const now = Date.now();
  let p = base * 0.9;
  const data = Array.from({ length: pts + 1 }, (_, i) => {
    p = p * (1 + (Math.random() - 0.48) * vol);
    return { time: now - (pts - i) * iv, price: +p.toFixed(4) };
  });
  data[data.length - 1].price = base;
  return data;
}

// ─── HTTP SERVER ─────────────────────────────────────────────
function cors(res, req) {
  // Allow any origin in dev, restrict to own domain in prod
  const origin = req?.headers?.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}
function sendJSON(res, data, status = 200, req = null) {
  cors(res, req); res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = urlMod.parse(req.url, true);
  if (req.method === 'OPTIONS') { cors(res, req); res.writeHead(204); res.end(); return; }

  // ══════════════════════════════════════════════════
  // AUTH ROUTES
  // ══════════════════════════════════════════════════

  // POST /api/auth/register
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const { email, password, name } = await readBody(req);
      if (!email || !password) return sendJSON(res, { ok: false, error: 'Email và password là bắt buộc' }, 400);
      if (password.length < 6) return sendJSON(res, { ok: false, error: 'Password tối thiểu 6 ký tự' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, { ok: false, error: 'Email không hợp lệ' }, 400);

      DB = loadDB();
      const existingUser = Object.values(DB.users).find(u => u.email === email.toLowerCase());
      if (existingUser) return sendJSON(res, { ok: false, error: 'Email đã được sử dụng' }, 409);

      const id = crypto.randomUUID();
      DB.users[id] = {
        id, email: email.toLowerCase(),
        name: name || email.split('@')[0],
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      DB.watchlists[id] = [1, 7]; // default watchlist: BTC + Gold
      DB.alerts[id] = [];
      saveDB(DB);

      const token = signJWT({ userId: id, email: email.toLowerCase() });
      console.log(`[${ts()}] ✅ Register: ${email}`);
      return sendJSON(res, {
        ok: true,
        token,
        user: { id, email: DB.users[id].email, name: DB.users[id].name, createdAt: DB.users[id].createdAt }
      }, 201);
    } catch(e) { return sendJSON(res, { ok: false, error: 'Server error' }, 500); }
  }

  // POST /api/auth/login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return sendJSON(res, { ok: false, error: 'Email và password là bắt buộc' }, 400);

      DB = loadDB();
      const user = Object.values(DB.users).find(u => u.email === email.toLowerCase());
      if (!user) return sendJSON(res, { ok: false, error: 'Email hoặc password không đúng' }, 401);

      const valid = verifyPassword(password, user.passwordHash);
      if (!valid) return sendJSON(res, { ok: false, error: 'Email hoặc password không đúng' }, 401);

      const token = signJWT({ userId: user.id, email: user.email });
      console.log(`[${ts()}] ✅ Login: ${email}`);
      return sendJSON(res, {
        ok: true, token,
        user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt }
      });
    } catch(e) { return sendJSON(res, { ok: false, error: 'Server error' }, 500); }
  }

  // GET /api/auth/me
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    DB = loadDB();
    const user = DB.users[payload.userId];
    if (!user) return sendJSON(res, { ok: false, error: 'User not found' }, 404);
    return sendJSON(res, { ok: true, user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } });
  }

  // ══════════════════════════════════════════════════
  // WATCHLIST ROUTES (auth required)
  // ══════════════════════════════════════════════════

  // GET /api/watchlist
  if (pathname === '/api/watchlist' && req.method === 'GET') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    DB = loadDB();
    return sendJSON(res, { ok: true, watchlist: DB.watchlists[payload.userId] || [] });
  }

  // POST /api/watchlist/:assetId
  if (pathname.match(/^\/api\/watchlist\/\d+$/) && req.method === 'POST') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    const assetId = parseInt(pathname.split('/').pop());
    DB = loadDB();
    if (!DB.watchlists[payload.userId]) DB.watchlists[payload.userId] = [];
    if (!DB.watchlists[payload.userId].includes(assetId)) {
      DB.watchlists[payload.userId].push(assetId);
      saveDB(DB);
    }
    return sendJSON(res, { ok: true, watchlist: DB.watchlists[payload.userId] });
  }

  // DELETE /api/watchlist/:assetId
  if (pathname.match(/^\/api\/watchlist\/\d+$/) && req.method === 'DELETE') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    const assetId = parseInt(pathname.split('/').pop());
    DB = loadDB();
    if (DB.watchlists[payload.userId]) {
      DB.watchlists[payload.userId] = DB.watchlists[payload.userId].filter(id => id !== assetId);
      saveDB(DB);
    }
    return sendJSON(res, { ok: true, watchlist: DB.watchlists[payload.userId] || [] });
  }

  // ══════════════════════════════════════════════════
  // ALERTS ROUTES (auth required)
  // ══════════════════════════════════════════════════

  // GET /api/alerts
  if (pathname === '/api/alerts' && req.method === 'GET') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    DB = loadDB();
    return sendJSON(res, { ok: true, alerts: DB.alerts[payload.userId] || [] });
  }

  // POST /api/alerts
  if (pathname === '/api/alerts' && req.method === 'POST') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    try {
      const { assetId, assetName, condition, targetPrice, currency } = await readBody(req);
      if (!assetId || !condition || !targetPrice) return sendJSON(res, { ok: false, error: 'Thiếu thông tin alert' }, 400);
      DB = loadDB();
      if (!DB.alerts[payload.userId]) DB.alerts[payload.userId] = [];
      const alert = { id: Date.now(), assetId, assetName, condition, targetPrice, currency, createdAt: new Date().toISOString(), triggered: false };
      DB.alerts[payload.userId].push(alert);
      saveDB(DB);
      return sendJSON(res, { ok: true, alert }, 201);
    } catch(e) { return sendJSON(res, { ok: false, error: 'Server error' }, 500); }
  }

  // DELETE /api/alerts/:id
  if (pathname.match(/^\/api\/alerts\/\d+$/) && req.method === 'DELETE') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    const alertId = parseInt(pathname.split('/').pop());
    DB = loadDB();
    if (DB.alerts[payload.userId]) {
      DB.alerts[payload.userId] = DB.alerts[payload.userId].filter(a => a.id !== alertId);
      saveDB(DB);
    }
    return sendJSON(res, { ok: true });
  }

  // ══════════════════════════════════════════════════
  // PRICE ROUTES (public)
  // ══════════════════════════════════════════════════

  if (pathname === '/api/prices') {
    const pricePayload = authMiddleware(req);
    return sendJSON(res, { ok: true, updatedAt: cache.lastFetch, status: cache.status, prices: cache.prices,
      hiddenAssets: pricePayload ? getHiddenAssets(pricePayload.userId) : [] });
  }

  const pm = pathname.match(/^\/api\/prices\/(\d+)$/);
  if (pm) {
    const p = cache.prices[parseInt(pm[1])];
    return p ? sendJSON(res, { ok: true, ...p }) : sendJSON(res, { ok: false, error: 'Not found' }, 404);
  }

  const hm = pathname.match(/^\/api\/history\/(\d+)$/);
  if (hm) {
    const id = parseInt(hm[1]);
    const period = query.period || '7d';
    const daysN = { '24h': 1, '7d': 7, '30d': 30, '1y': 365 }[period] || 7;
    const key   = `${id}_${daysN}d`;
    const cm    = { 1: 'bitcoin', 2: 'ethereum', 3: 'solana' };
    if (cache.history[key])
      return sendJSON(res, { ok: true, id, period, data: cache.history[key].data, source: cache.history[key].source });
    if (cm[id]) {
      await fetchCryptoHistory(cm[id], id, daysN);
      if (cache.history[key])
        return sendJSON(res, { ok: true, id, period, data: cache.history[key].data, source: cache.history[key].source });
    }
    const base = cache.prices[id]?.price || 1000;
    return sendJSON(res, { ok: true, id, period, data: mockHistory(base, daysN, id <= 3 ? 0.03 : 0.005), source: 'mock' });
  }

  if (pathname === '/api/status')
    return sendJSON(res, { ok: true, uptime: Math.floor(process.uptime()) + 's', lastFetch: cache.lastFetch, status: cache.status, users: Object.keys(DB.users).length });

  if (pathname === '/api/refresh') { fetchAll().catch(() => {}); return sendJSON(res, { ok: true }); }

  if (pathname === '/' || pathname === '/index.html') {
    const fp = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(fp)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(fp)); }
  }

  // ══════════════════════════════════════════════════
  // AI AGENT ROUTES
  // ══════════════════════════════════════════════════

  // POST /api/ai/discover  — AI tìm + fetch giá, KHÔNG lưu DB (user chưa confirm)
  if (pathname === '/api/ai/discover' && req.method === 'POST') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    if (!CFG.GEMINI_API_KEY) return sendJSON(res, { ok: false, error: 'GEMINI_API_KEY chưa được cấu hình' }, 503);
    try {
      const { query } = await readBody(req);
      if (!query || !query.trim()) return sendJSON(res, { ok: false, error: 'Vui lòng nhập tên asset' }, 400);

      // Check duplicate against ALREADY SAVED assets only
      const existingDynamic = loadDynamicAssets(payload.userId);
      const allExisting = [
        ...existingDynamic,
        { id:1,name:'Bitcoin',sym:'BTC' }, { id:2,name:'Ethereum',sym:'ETH' },
        { id:3,name:'Solana',sym:'SOL' }, { id:4,name:'US Dollar',sym:'USD/VND' },
        { id:5,name:'Japanese Yen',sym:'JPY/VND' }, { id:6,name:'Euro',sym:'EUR/VND' },
        { id:7,name:'Gold',sym:'XAU' }, { id:8,name:'Silver',sym:'XAG' },
        { id:9,name:'iPhone 16 Pro',sym:'AAPL-IP16' }, { id:10,name:'MacBook Pro M3',sym:'AAPL-MBP' },
        { id:11,name:'Gaming Laptop',sym:'ROG-G16' },
      ];

      // discoverAsset = phân tích + fetch giá thật, KHÔNG lưu DB
      const asset = await discoverAndAddAsset(query.trim(), CFG.GEMINI_API_KEY, allExisting);

      console.log(`[${ts()}] 🔍 AI discovered: ${asset.name} (${asset.sym}) @ ${asset.price} ${asset.cur} — awaiting user confirm`);
      // Trả về asset để frontend hiển thị preview — CHƯA lưu DB
      return sendJSON(res, { ok: true, asset });
    } catch(e) {
      console.error(`[${ts()}] ❌ AI Agent:`, e.message);
      return sendJSON(res, { ok: false, error: e.message }, 400);
    }
  }

  // POST /api/ai/confirm  — User xác nhận thêm asset vào tracker (mới lưu DB)
  if (pathname === '/api/ai/confirm' && req.method === 'POST') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    try {
      const { asset } = await readBody(req);
      if (!asset || !asset.id || !asset.name) return sendJSON(res, { ok: false, error: 'Invalid asset data' }, 400);

      // Final duplicate check before saving
      const existing = loadDynamicAssets(payload.userId);
      const dup = existing.find(a => a.sym?.toLowerCase() === asset.sym?.toLowerCase() || a.name?.toLowerCase() === asset.name?.toLowerCase());
      if (dup) return sendJSON(res, { ok: false, error: `"${asset.name}" đã tồn tại trong tracker của bạn.` }, 409);

      // Assign user-specific ID to avoid conflicts between users
      asset.id = nextAssetId(payload.userId);
      asset.ownerId = payload.userId;

      // NOW save to DB
      saveDynamicAsset(payload.userId, asset);

      // Add to live price cache
      cache.prices[asset.id] = {
        price:     asset.price,
        change24h: asset.change24h || 0,
        updatedAt: Date.now(),
        source:    asset.source,
        dynamic:   true,
        name:      asset.name,  sym: asset.sym,
        cat:       asset.cat,   icon: asset.icon,
        color:     asset.color, cur:  asset.cur,
        fetchStrategy: asset.fetchStrategy,
        fetchParam:    asset.fetchParam,
        fetchParam2:   asset.fetchParam2,
      };

      console.log(`[${ts()}] ✅ AI Agent confirmed: ${asset.name} (${asset.sym}) @ ${asset.price} ${asset.cur}`);
      return sendJSON(res, { ok: true, asset }, 201);
    } catch(e) {
      console.error(`[${ts()}] ❌ AI confirm:`, e.message);
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  }

  // GET /api/ai/assets  — Danh sách dynamic assets
  if (pathname === '/api/ai/assets' && req.method === 'GET') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    const assets = loadDynamicAssets(payload.userId);
    const withPrices = assets.map(a => ({
      ...a,
      price:     cache.prices[a.id]?.price     || a.price,
      change24h: cache.prices[a.id]?.change24h || a.change24h || 0,
    }));
    return sendJSON(res, { ok: true, assets: withPrices });
  }

  // DELETE /api/ai/assets/:id  — Xoá dynamic asset
  if (pathname.match(/^\/api\/ai\/assets\/\d+$/) && req.method === 'DELETE') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    const id = parseInt(pathname.split('/').pop());
    deleteDynamicAsset(payload.userId, id);
    // Only remove from cache if no other user has this asset
    DB = loadDB();
    const allUsers = DB.dynamicAssets || {};
    const stillUsed = Object.values(allUsers).some(arr => arr.some(a => a.id === id));
    if (!stillUsed) delete cache.prices[id];
    return sendJSON(res, { ok: true });
  }

  // GET /api/ai/status  — Kiểm tra Claude API key
  if (pathname === '/api/ai/status' && req.method === 'GET') {
    return sendJSON(res, {
      ok:           true,
      hasApiKey:    !!CFG.GEMINI_API_KEY,
      dynamicCount: authMiddleware(req) ? loadDynamicAssets(authMiddleware(req).userId).length : 0,
      message:      CFG.GEMINI_API_KEY
        ? 'AI Agent ready ✅'
        : 'Thêm GEMINI_API_KEY=AIza... khi chạy server',
    });
  }

    // DELETE /api/assets/:id  — Ẩn static asset (soft delete)
  if (pathname.match(/^\/api\/assets\/\d+$/) && req.method === 'DELETE') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    const id = parseInt(pathname.split('/').pop());
    hideAsset(payload.userId, id);
    console.log(`[${ts()}] 🗑️ Asset ${id} hidden by ${payload.email}`);
    return sendJSON(res, { ok: true, hiddenAssets: getHiddenAssets(payload.userId) });
  }

  // POST /api/assets/:id/restore  — Khôi phục static asset
  if (pathname.match(/^\/api\/assets\/\d+\/restore$/) && req.method === 'POST') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    const id = parseInt(pathname.split('/')[3]);
    unhideAsset(payload.userId, id);
    return sendJSON(res, { ok: true, hiddenAssets: getHiddenAssets(payload.userId) });
  }

  // GET /api/assets/hidden  — Danh sách assets đang bị ẩn
  if (pathname === '/api/assets/hidden' && req.method === 'GET') {
    const payload = authMiddleware(req);
    if (!payload) return sendJSON(res, { ok: false, error: 'Unauthorized' }, 401);
    return sendJSON(res, { ok: true, hiddenAssets: getHiddenAssets() });
  }

    sendJSON(res, { ok: false, error: 'Not found' }, 404);
});

initProducts();
// Load dynamic asset prices into cache on startup
refreshAllDynamicAssets().catch(()=>{});
fetchAll();
setInterval(fetchAll, CFG.UPDATE_INTERVAL_MS);

const HOST = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Smart Price Tracker — Backend v4        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  🚀  ${HOST.padEnd(42)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  AUTH:                                   ║');
  console.log('║   POST /api/auth/register                ║');
  console.log('║   POST /api/auth/login                   ║');
  console.log('║   GET  /api/auth/me                      ║');
  console.log('║  USER DATA:                              ║');
  console.log('║   GET/POST/DELETE /api/watchlist/:id     ║');
  console.log('║   GET/POST/DELETE /api/alerts/:id        ║');
  console.log('║  PRICES:                                 ║');
  console.log('║   GET /api/prices                        ║');
  console.log('║   GET /api/history/:id?period=           ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`❌ Port ${PORT} bận`);
  else console.error('Server error:', e);
  process.exit(1);
});
