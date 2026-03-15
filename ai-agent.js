/**
 * AI Asset Discovery Agent — v3
 * Fixes:
 *  - JSON truncation: tăng timeout + maxOutputTokens, validate đủ fields
 *  - Dầu thô / commodities: thêm commodities strategy dùng CoinGecko
 *  - Auto-retry Gemini 500 với backoff
 *  - Validate plan trước khi fetch giá
 */

const https = require('https');
const http  = require('http');
const url   = require('url');

// ── HTTP helper (timeout 20s cho Gemini) ─────────────────────
function fetchJSON(reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const p   = url.parse(reqUrl);
    const lib = p.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: p.hostname,
      path:     p.path,
      port:     p.port || (p.protocol === 'https:' ? 443 : 80),
      method:   opts.method || 'GET',
      headers:  {
        'User-Agent':   'SmartPriceTracker-AI/3.0',
        'Accept':       'application/json',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      timeout: opts.timeout || 20000,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ── HTML FETCHER ─────────────────────────────────────────────
function fetchHTML(reqUrl) {
  return new Promise((resolve, reject) => {
    const p   = url.parse(reqUrl);
    const lib = p.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: p.hostname,
      path:     p.path,
      port:     p.port || (p.protocol === 'https:' ? 443 : 80),
      method:   'GET',
      headers:  {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
        'Accept':          'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control':   'no-cache',
      },
      timeout: 15000,
    }, res => {
      // Follow redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTML fetch timeout')); });
    req.end();
  });
}

// ── PARSE GASOLINE PRICE FROM HTML ────────────────────────────
function parseGasolinePriceFromHTML(html, productCode = 'RON95-V') {
  // Strip scripts/styles/tags
  const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|\u00a0/g, ' ')
      .replace(/\s+/g, ' ');

  // Keyword sets cho mỗi sản phẩm (lowercase, no diacritics ok)
  const KEYWORDS = {
    'RON95-V': ['ron 95-v', 'ron95-v', 'ron 95-iii', 'ron95-iii', 'ron 95-', 'xang 95', 'xăng 95'],
    'RON92':   ['e5 ron 92', 'e5ron92', 'ron 92', 'ron92', 'xang 92', 'xăng 92'],
    'DO':      ['dầu diesel', 'dau diesel', 'diesel 0.05', 'diesel', 'diezel'],
    'MAZ':     ['mazut', 'mazút', 'dầu mazut'],
  };
  const kws = KEYWORDS[productCode] || KEYWORDS['RON95-V'];

  // Strategy: find keyword then look for price number within 150 chars after it
  const lower = text.toLowerCase();
  for (const kw of kws) {
    let pos = 0;
    while ((pos = lower.indexOf(kw, pos)) !== -1) {
      const snippet = text.slice(pos, pos + 200);
      // Match: 20.151, 25.570, 25,570, 25570
      const numMatch = snippet.match(/(\d{2})[.,](\d{3})(?![\d])/);
      if (numMatch) {
        const price = parseInt(numMatch[1] + numMatch[2]);
        if (price >= 20000 && price <= 45000) {
          console.log(`[html-parser] "${kw}" → ${price.toLocaleString()}đ/lít`);
          return price;
        }
      }
      // Also try plain 5-digit number
      const plain = snippet.match(/\b(1[5-9]\d{3}|2\d{4}|3[0-5]\d{3})\b/);
      if (plain) {
        const price = parseInt(plain[1]);
        if (price >= 20000 && price <= 45000) {
          console.log(`[html-parser] "${kw}" plain → ${price.toLocaleString()}đ/lít`);
          return price;
        }
      }
      pos += kw.length;
    }
  }

  // Fallback: most frequent price near "đồng/lít" in range
  const allPrices = [];
  const re = /(\d{2})[.,](\d{3})\s*(?:đồng|đ)\/lít/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = parseInt(m[1] + m[2]);
    if (p >= 20000 && p <= 45000) allPrices.push(p);
  }
  if (allPrices.length > 0) {
    const freq = {};
    allPrices.forEach(p => freq[p] = (freq[p]||0) + 1);
    const best = Object.entries(freq).sort((a,b) => b[1]-a[1])[0];
    console.log(`[html-parser] Fallback price: ${Number(best[0]).toLocaleString()}đ`);
    return parseInt(best[0]);
  }

  console.log(`[html-parser] No price found for ${productCode}`);
  return 0;
}

// ── API STRATEGIES ────────────────────────────────────────────
const STRATEGIES = {

  coingecko: async (coinId) => {
    const symbolMap = {
      'bitcoin':'BTC','ethereum':'ETH','solana':'SOL','dogecoin':'DOGE',
      'ripple':'XRP','cardano':'ADA','polkadot':'DOT','chainlink':'LINK',
      'uniswap':'UNI','avalanche-2':'AVAX','matic-network':'MATIC',
      'shiba-inu':'SHIB','litecoin':'LTC','bitcoin-cash':'BCH',
      'stellar':'XLM','tron':'TRX','monero':'XMR','cosmos':'ATOM',
      'near':'NEAR','algorand':'ALGO','vechain':'VET','filecoin':'FIL',
      'internet-computer':'ICP','aptos':'APT','arbitrum':'ARB',
      'optimism':'OP','sui':'SUI','injective-protocol':'INJ',
      'pepe':'PEPE','floki':'FLOKI','bonk':'BONK','wif':'WIF',
    };
    const ticker = symbolMap[coinId] || coinId.toUpperCase().replace(/-/g,'').replace(/[^A-Z0-9]/g,'');

    // ── Source 1: CoinGecko ──
    try {
      const r = await fetchJSON(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`
      );
      if (r.status === 200 && r.data?.[coinId]?.usd) {
        const d = r.data[coinId];
        console.log(`[crypto] CoinGecko OK: ${coinId} = $${d.usd}`);
        return { price: d.usd, change24h: +(d.usd_24h_change||0).toFixed(4), currency: 'USD', source: 'coingecko' };
      }
      console.log(`[crypto] CoinGecko ${r.status} for ${coinId} → trying Binance...`);
    } catch(e) {
      console.log(`[crypto] CoinGecko error: ${e.message} → trying Binance...`);
    }

    // ── Source 2: Binance (no key, very generous rate limit) ──
    try {
      const pair = `${ticker}USDT`;
      const r2 = await fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
      if (r2.status === 200 && r2.data?.lastPrice) {
        const price = parseFloat(r2.data.lastPrice);
        const ch    = parseFloat(r2.data.priceChangePercent || 0);
        console.log(`[crypto] Binance OK: ${pair} = $${price}`);
        return { price, change24h: +ch.toFixed(4), currency: 'USD', source: 'binance' };
      }
      console.log(`[crypto] Binance ${r2.status} for ${pair} → trying CryptoCompare...`);
    } catch(e) {
      console.log(`[crypto] Binance error: ${e.message} → trying CryptoCompare...`);
    }

    // ── Source 3: CryptoCompare ──
    try {
      const r3 = await fetchJSON(
          `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${ticker}&tsyms=USD`
      );
      const raw = r3.data?.RAW?.[ticker]?.USD;
      if (raw?.PRICE) {
        const price = raw.PRICE;
        const ch    = raw.CHANGEPCT24HOUR || 0;
        console.log(`[crypto] CryptoCompare OK: ${ticker} = $${price}`);
        return { price, change24h: +ch.toFixed(4), currency: 'USD', source: 'cryptocompare' };
      }
      console.log(`[crypto] CryptoCompare no data for ${ticker}`);
    } catch(e) {
      console.log(`[crypto] CryptoCompare error: ${e.message}`);
    }

    throw new Error(`Không lấy được giá "${coinId}". Cả 3 nguồn (CoinGecko/Binance/CryptoCompare) đều thất bại. Thử lại sau.`);
  },

  goldApi: async (symbol) => {
    const r = await fetchJSON(`https://api.gold-api.com/price/${symbol.toUpperCase()}`);
    if (!r.data?.price) throw new Error(`"${symbol}" not found on gold-api.com`);
    return { price: +parseFloat(r.data.price).toFixed(2), change24h: 0, currency: 'USD/oz', source: 'gold-api.com' };
  },

  exchangeRate: async (from, to = 'VND') => {
    const r = await fetchJSON(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`);
    if (r.data?.result !== 'success') throw new Error(`ExchangeRate API error`);
    const rate = r.data.rates?.[to.toUpperCase()];
    if (!rate) throw new Error(`Rate ${from}/${to} not found`);
    return { price: +rate.toFixed(4), change24h: 0, currency: to.toUpperCase(), source: 'exchangerate-api' };
  },

  // Xăng dầu VN — lấy từ Petrolimex API công khai
  petrolimex: async (productCode = 'RON95-V') => {
    // ── Source 1: VnExpress — trang báo lớn, HTML tĩnh, có bảng giá ──
    // URL search theo từ khoá
    const today = new Date();
    const vnexpressUrls = [
      `https://vnexpress.net/chu-de/gia-xang-dau-3026`,
      `https://vnexpress.net/gia-xang-dau-moi-nhat-hom-nay-${today.getDate()}-${today.getMonth()+1}-5049651.html`,
    ];
    for (const u of vnexpressUrls) {
      try {
        const html = await fetchHTML(u);
        if (html) {
          const price = parseGasolinePriceFromHTML(html, productCode);
          if (price > 20000) {
            console.log(`[vnexpress] ✅ ${productCode}: ${price.toLocaleString()}đ/lít`);
            return { price, change24h: 0, currency: 'VND', source: 'vnexpress.net' };
          }
        }
      } catch(e) { console.log(`[vnexpress] ${u} failed: ${e.message}`); }
    }

    // ── Source 2: Petrolimex JSON API ─────────────────────────────
    try {
      const r = await fetchJSON('https://www.petrolimex.com.vn/api/petrolprice', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });
      const items = Array.isArray(r.data) ? r.data
          : Array.isArray(r.data?.data) ? r.data.data : null;
      if (items?.length > 0) {
        const kwMap = {
          'RON95-V': ['ron95-v','ron 95-v','ron 95-iii','ron95-iii','95-v','95-iii'],
          'RON92':   ['e5 ron92','e5ron92','ron 92','ron92'],
          'DO':      ['diesel','diezel','d.o 0.05'],
          'MAZ':     ['mazut'],
        };
        const kws = kwMap[productCode] || kwMap['RON95-V'];
        const item = items.find(i => {
          const n = (i.TenNhienLieu || i.name || '').toLowerCase();
          return kws.some(k => n.includes(k));
        }) || items[0];
        const priceFields = ['GiaBanLe','giaBanLe','price','GiaBan','retail_price','gia'];
        for (const f of priceFields) {
          const p = parseFloat(item[f]);
          if (p > 20000) {
            console.log(`[petrolimex-api] ✅ ${productCode}: ${p.toLocaleString()}đ/lít`);
            return { price: p, change24h: 0, currency: 'VND', source: 'petrolimex-api' };
          }
        }
      }
    } catch(e) { console.log(`[petrolimex-api] failed: ${e.message}`); }

    // ── Source 3: xangdau.net ─────────────────────────────────────
    try {
      const html = await fetchHTML('https://www.xangdau.net/thi-truong-xang-dau-viet-nam');
      if (html) {
        const price = parseGasolinePriceFromHTML(html, productCode);
        if (price > 20000) {
          console.log(`[xangdau.net] ✅ ${productCode}: ${price.toLocaleString()}đ/lít`);
          return { price, change24h: 0, currency: 'VND', source: 'xangdau.net' };
        }
        console.log(`[xangdau.net] price ${price} invalid, skipping`);
      }
    } catch(e) { console.log(`[xangdau.net] failed: ${e.message}`); }

    // ── Source 4: Giá chính thức kỳ điều hành gần nhất ──────────
    // Kỳ điều hành 12/03/2026 (Liên bộ Công Thương - Tài chính)
    // RON95-III = 25,570đ | E5RON92 = 22,500đ | Diesel = 27,020đ | Mazut = 22,400đ
    const OFFICIAL = {
      'RON95-V': 25570,
      'RON92':   22500,
      'DO':      27020,
      'MAZ':     22400,
    };
    const p = OFFICIAL[productCode] || OFFICIAL['RON95-V'];
    console.log(`[petrolimex] Official price kỳ 12/03/2026: ${p.toLocaleString()}đ/lít`);
    return {
      price:     p,
      change24h: 0,
      currency:  'VND',
      source:    'official-12032026',
      note:      'Giá chính thức kỳ điều hành 12/03/2026 (Liên Bộ CT-TC)',
    };
  },

  // Yahoo Finance — hỗ trợ mọi thứ: metals, commodities, stocks, ETF, forex
  // Ticker examples: GC=F (gold futures), SI=F (silver), HG=F (copper), CL=F (crude oil)
  //                  NG=F (natural gas), PL=F (platinum), PA=F (palladium)
  //                  AAPL, MSFT (stocks), BTC-USD (crypto fallback)
  yahooFinance: async (ticker, currency = 'USD') => {
    // Yahoo Finance v8 chart API — free, no key needed
    const r = await fetchJSON(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
    );
    const result = r.data?.chart?.result?.[0];
    if (!result) throw new Error(`"${ticker}" not found on Yahoo Finance`);

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prev  = meta.previousClose || meta.chartPreviousClose || price;
    if (!price) throw new Error(`No price data for "${ticker}"`);

    const change24h = prev ? +((price - prev) / prev * 100).toFixed(4) : 0;
    return {
      price:     +price.toFixed(4),
      change24h,
      currency:  currency || meta.currency || 'USD',
      source:    'yahoo-finance',
    };
  },

  // VNStock — Cổ phiếu Việt Nam (HOSE, HNX, UPCOM)
  // Dùng SSI iBoard public API — miễn phí, không cần key
  vnStock: async (ticker) => {
    const sym = ticker.toUpperCase().trim();

    // Try SSI iBoard API first
    try {
      const r = await fetchJSON(
          `https://iboard-query.ssi.com.vn/v2/stock/ticker/${sym}`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://iboard.ssi.com.vn', 'Referer': 'https://iboard.ssi.com.vn/' } }
      );
      const d = r.data?.data;
      if (d && d.lastPrice) {
        // SSI lastPrice đơn vị 1000 VND (26.65 → 26,650 VND/cp)
        const rawSSI   = parseFloat(d.lastPrice);
        const price    = rawSSI < 1000 ? rawSSI * 1000 : rawSSI;
        const rawRef   = parseFloat(d.refPrice || d.lastPrice);
        const refPrice = rawRef < 1000 ? rawRef * 1000 : rawRef;
        const change24h = refPrice ? +((price - refPrice) / refPrice * 100).toFixed(2) : 0;
        return { price, change24h, currency: 'VND', source: 'ssi-iboard' };
      }
    } catch(e) {
      console.log(`[vnStock] SSI failed for ${sym}:`, e.message);
    }

    // Fallback: TCBS API
    try {
      const r2 = await fetchJSON(
          `https://apipubaws.tcbs.com.vn/stock-insight/v1/stock/second-chart?ticker=${sym}&type=stock`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
      );
      const d2 = r2.data;
      if (d2 && d2.p) {
        // TCBS p field is already in VND units
        return { price: parseFloat(d2.p), change24h: 0, currency: 'VND', source: 'tcbs' };
      }
    } catch(e) {
      console.log(`[vnStock] TCBS failed for ${sym}:`, e.message);
    }

    // Fallback: VietStock API
    try {
      const r3 = await fetchJSON(
          `https://api.vietstock.vn/ta/history?symbol=${sym}&resolution=D&from=${Math.floor(Date.now()/1000)-86400*3}&to=${Math.floor(Date.now()/1000)}&countback=2&type=stock&cat=10`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://vietstock.vn' } }
      );
      const closes = r3.data?.c;
      if (closes && closes.length > 0) {
        const price = closes[closes.length - 1] * 1000;
        const prev  = closes.length > 1 ? closes[closes.length - 2] * 1000 : price;
        const change24h = prev ? +((price - prev) / prev * 100).toFixed(2) : 0;
        return { price, change24h, currency: 'VND', source: 'vietstock' };
      }
    } catch(e) {
      console.log(`[vnStock] VietStock failed for ${sym}:`, e.message);
    }

    // Final fallback: MSN Finance (Yahoo-compatible endpoint cho VN stocks)
    const r4 = await fetchJSON(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.VN?interval=1d&range=2d`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
    );
    const meta = r4.data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) throw new Error(`Không tìm thấy cổ phiếu "${sym}" trên sàn VN`);
    // Yahoo Finance .VN trả giá đơn vị nghìn đồng (26.65 = 26,650 VND)
    const rawYF = meta.regularMarketPrice;
    const prevYF = meta.previousClose || rawYF;
    // Nếu giá < 1000 thì đang ở đơn vị nghìn đồng → nhân 1000
    const price    = rawYF < 1000 ? rawYF * 1000 : rawYF;
    const prev     = prevYF < 1000 ? prevYF * 1000 : prevYF;
    const change24h = prev ? +((price - prev) / prev * 100).toFixed(2) : 0;
    return { price, change24h, currency: 'VND', source: 'yahoo-finance-vn' };
  },

};
// ─── DANH SÁCH QUỸ MỞ VN ─────────────────────────────────────
const VN_FUND_MAP = {
  'SSISCA':   { name: 'Quỹ SSI-SCA (Tăng Trưởng)',       manager: 'SSIAM' },
  'SSIBF':    { name: 'Quỹ SSI Bond Fund',                manager: 'SSIAM' },
  'SSIICO':   { name: 'Quỹ SSI ICO',                      manager: 'SSIAM' },
  'VESAF':    { name: 'VinaCapital VEF',                   manager: 'VinaCapital' },
  'VIBF':     { name: 'VinaCapital Bond',                  manager: 'VinaCapital' },
  'VEOF':     { name: 'VinaCapital Equity Open',           manager: 'VinaCapital' },
  'DCDS':     { name: 'DCVFM VN Diamond ETF',              manager: 'DCVFM' },
  'E1VFVN30': { name: 'ETF VN30 DCVFM',                   manager: 'DCVFM' },
  'TCEF':     { name: 'Techcom Capital Equity',            manager: 'Techcom Capital' },
  'TCBF':     { name: 'Techcom Capital Bond',              manager: 'Techcom Capital' },
  'MBVF':     { name: 'MB Capital Value Fund',             manager: 'MB Capital' },
  'VFMVN30':  { name: 'VFM VN30 ETF',                     manager: 'VFM' },
  'VFMVSF':   { name: 'VFM VN Small Cap ETF',              manager: 'VFM' },
  'MAFPF1':   { name: 'Manulife Flexible Portfolio',       manager: 'Manulife' },
  'MABF':     { name: 'Manulife Bond Fund',                manager: 'Manulife' },
};

// Fallback NAV values (approximate, tính đến 12/03/2026)
const KNOWN_NAV = {
  'SSISCA':   27450,  'SSIBF':    13820,  'SSIICO':   18900,
  'VESAF':    48200,  'VIBF':     11250,  'VEOF':     16780,
  'TCEF':     22100,  'TCBF':     10450,  'MAFPF1':   14600,
  'E1VFVN30': 15800,  'VFMVN30':  16200,  'VFMVSF':   12400,
  'DCDS':     19600,  'MBVF':     13200,
};

// ── vnFund: fetch NAV quỹ mở VN ──────────────────────────────
// NAV/CCQ công bố T+1. Sources ưu tiên theo độ tin cậy thực tế:
// 1. TCBS (cùng server với vnStock - đã proven)
// 2. VNDirect public API (domain stable)
// 3. SSI iBoard API
// 4. fmarket.vn
// 5. FiinTrade
// 6. Fallback hardcoded
STRATEGIES['vnFund'] = async (fundCode) => {
  const sym = fundCode.toUpperCase().trim();

  // ── Source 1: TCBS API ────────────────────────────────────
  // TCBS hỗ trợ cả cổ phiếu lẫn quỹ mở, cùng endpoint đã dùng cho vnStock
  try {
    const r = await fetchJSON(
        `https://apipubaws.tcbs.com.vn/fund-insight/v1/fund/${sym}/nav?page=0&size=2`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://tcbs.com.vn' } }
    );
    const items = r.data?.listNavData || r.data?.data || r.data?.items || [];
    if (items.length > 0) {
      // TCBS sort desc, item[0] = mới nhất
      const latest   = items[0];
      const prev     = items[1];
      const navCCQ   = parseFloat(latest.nav || latest.navPerUnit || latest.value || 0);
      const prevCCQ  = prev ? parseFloat(prev.nav || prev.navPerUnit || prev.value || navCCQ) : navCCQ;
      const change24h = prevCCQ ? +((navCCQ - prevCCQ) / prevCCQ * 100).toFixed(4) : 0;
      if (navCCQ > 1000) {
        console.log(`[vnFund] TCBS OK ${sym}: ${navCCQ.toLocaleString('vi-VN')}d/CCQ`);
        return { price: navCCQ, change24h, currency: 'VND', source: 'tcbs' };
      }
    }
  } catch(e) { console.log(`[vnFund] TCBS failed ${sym}: ${e.message}`); }

  // ── Source 2: VNDirect public API ────────────────────────
  // Endpoint public, không cần auth, trả NAV theo ngày
  try {
    const today   = new Date();
    const from    = new Date(today - 7 * 86400000).toISOString().slice(0,10);
    const to      = today.toISOString().slice(0,10);
    const r = await fetchJSON(
        `https://api.vndirect.com.vn/v4/fund_nav?q=fundCode:${sym}~navDate:gte:${from}~navDate:lte:${to}&sort=navDate:desc&size=2`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vndirect.com.vn' } }
    );
    const items = r.data?.data || r.data?.items || [];
    if (items.length > 0) {
      const latest   = items[0];
      const prev     = items[1];
      const navCCQ   = parseFloat(latest.navPerCcq || latest.nav || latest.navPerUnit || 0);
      const prevCCQ  = prev ? parseFloat(prev.navPerCcq || prev.nav || prev.navPerUnit || navCCQ) : navCCQ;
      const change24h = prevCCQ ? +((navCCQ - prevCCQ) / prevCCQ * 100).toFixed(4) : 0;
      if (navCCQ > 1000) {
        console.log(`[vnFund] VNDirect OK ${sym}: ${navCCQ.toLocaleString('vi-VN')}d/CCQ (${latest.navDate})`);
        return { price: navCCQ, change24h, currency: 'VND', source: 'vndirect', navDate: latest.navDate };
      }
    }
  } catch(e) { console.log(`[vnFund] VNDirect failed ${sym}: ${e.message}`); }

  // ── Source 3: SSI iBoard REST API ────────────────────────
  // Dùng cho tất cả quỹ (không chỉ SSI), endpoint mới hơn
  try {
    const r = await fetchJSON(
        `https://iboard-query.ssi.com.vn/v2/fund/ccq-nav?symbol=${sym}&size=2`,
        { headers: {
            'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0',
            'Origin': 'https://iboard.ssi.com.vn', 'Referer': 'https://iboard.ssi.com.vn/',
            'X-Requested-With': 'XMLHttpRequest',
          }}
    );
    const items = r.data?.data || r.data?.items || (Array.isArray(r.data) ? r.data : []);
    if (items.length > 0) {
      const latest   = items[0];
      const prev     = items[1];
      const navCCQ   = parseFloat(latest.navPerCCQ || latest.nav || latest.navPerShare || 0);
      const prevCCQ  = prev ? parseFloat(prev.navPerCCQ || prev.nav || prev.navPerShare || navCCQ) : navCCQ;
      const change24h = prevCCQ ? +((navCCQ - prevCCQ) / prevCCQ * 100).toFixed(4) : 0;
      if (navCCQ > 1000) {
        console.log(`[vnFund] SSI iBoard OK ${sym}: ${navCCQ.toLocaleString('vi-VN')}d/CCQ`);
        return { price: navCCQ, change24h, currency: 'VND', source: 'ssi-iboard' };
      }
    }
  } catch(e) { console.log(`[vnFund] SSI iBoard failed ${sym}: ${e.message}`); }

  // ── Source 4: fmarket.vn search + NAV ────────────────────
  try {
    const searchR = await fetchJSON(
        `https://fmarket.vn/api/v2/fund/search?query=${sym}&type=OPEN_END_FUND`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://fmarket.vn', 'Referer': 'https://fmarket.vn/' } }
    );
    const funds = searchR.data?.data || searchR.data?.items || [];
    const fund  = funds.find(f => (f.shortName || f.code || '').toUpperCase() === sym) || funds[0];
    if (fund) {
      const fundId = fund.id || fund.fundId;
      const navR = await fetchJSON(
          `https://fmarket.vn/api/v2/fund/${fundId}/nav-histories?page=1&pageSize=2&sort=navDate:desc`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://fmarket.vn' } }
      );
      const navItems = navR.data?.data || navR.data?.items || [];
      if (navItems.length > 0) {
        const latest   = navItems[0];
        const prevItem = navItems[1];
        const navCCQ   = parseFloat(latest.navPerShare || latest.navPerUnit || latest.nav || 0);
        const prevCCQ  = prevItem ? parseFloat(prevItem.navPerShare || prevItem.navPerUnit || prevItem.nav || navCCQ) : navCCQ;
        const change24h = prevCCQ ? +((navCCQ - prevCCQ) / prevCCQ * 100).toFixed(4) : 0;
        if (navCCQ > 1000) {
          console.log(`[vnFund] fmarket OK ${sym}: ${navCCQ.toLocaleString('vi-VN')}d/CCQ`);
          return { price: navCCQ, change24h, currency: 'VND', source: 'fmarket.vn' };
        }
      }
    }
  } catch(e) { console.log(`[vnFund] fmarket failed ${sym}: ${e.message}`); }

  // ── Source 5: FiinTrade ───────────────────────────────────
  try {
    const r = await fetchJSON(
        `https://restv2.fiintrade.vn/fund-management/funds/${sym}/nav-histories?pageIndex=1&pageSize=2&orderBy=NavDate&orderDir=desc`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://fiintrade.vn' } }
    );
    const items = r.data?.items || r.data?.data || [];
    if (items.length > 0) {
      const latest   = items[0];
      const prev     = items[1];
      const navCCQ   = parseFloat(latest.navPerCertificate || latest.NavPerCertificate || latest.nav || 0);
      const prevCCQ  = prev ? parseFloat(prev.navPerCertificate || prev.NavPerCertificate || prev.nav || navCCQ) : navCCQ;
      const change24h = prevCCQ ? +((navCCQ - prevCCQ) / prevCCQ * 100).toFixed(4) : 0;
      if (navCCQ > 1000) {
        console.log(`[vnFund] FiinTrade OK ${sym}: ${navCCQ.toLocaleString('vi-VN')}d/CCQ`);
        return { price: navCCQ, change24h, currency: 'VND', source: 'fiintrade' };
      }
    }
  } catch(e) { console.log(`[vnFund] FiinTrade failed ${sym}: ${e.message}`); }

  // ── Source 6: Fallback hardcoded (NAV tham khảo) ─────────
  // Được cập nhật mỗi lần release. User có thể cập nhật thủ công trong app.
  if (KNOWN_NAV[sym]) {
    const nav = KNOWN_NAV[sym];
    console.log(`[vnFund] Fallback NAV ${sym}: ${nav.toLocaleString('vi-VN')}d/CCQ`);
    return {
      price:    nav,
      change24h: 0,
      currency: 'VND',
      source:   'fallback-nav',
      note:     `NAV tham khao 12/03/2026 — nen cap nhat thu cong trong Them Asset`,
    };
  }

  throw new Error(
      `Khong tim duoc NAV quy "${sym}". ` +
      `Ho tro: ${Object.keys(VN_FUND_MAP).join(', ')}. ` +
      `Them thu cong trong menu Them Asset.`
  );
};


// ── REQUIRED FIELDS cho plan hợp lệ ──────────────────────────
const REQUIRED_FIELDS = ['name', 'symbol', 'fetchStrategy', 'fetchParam', 'confidence'];

function validatePlan(plan) {
  for (const f of REQUIRED_FIELDS) {
    if (plan[f] === undefined || plan[f] === null || plan[f] === '') {
      return `Missing required field: "${f}"`;
    }
  }
  if (!['coingecko', 'goldApi', 'exchangeRate', 'yahooFinance', 'vnStock', 'petrolimex', 'vnFund'].includes(plan.fetchStrategy)) {
    return `Invalid fetchStrategy: "${plan.fetchStrategy}".`;
  }
  return null; // valid
}

// ── GEMINI CALL với retry ─────────────────────────────────────
async function askGemini(userQuery, geminiKey) {

  // Compact prompt → ít token hơn → ít bị truncate
  const prompt = `Asset price tracker assistant. Return ONLY a JSON object, no markdown, no explanation.

Available fetchStrategies:
1. "coingecko" — any cryptocurrency (auto-fallback to Binance/CryptoCompare if rate limited)
   fetchParam = CoinGecko coin ID: bitcoin, ethereum, dogecoin, ripple, cardano, shiba-inu, polkadot, chainlink, avalanche-2, matic-network, near, sui, aptos, arbitrum, optimism, pepe, floki, bonk

2. "goldApi" — precious metals: XAU=gold, XAG=silver, XPT=platinum, XPD=palladium, ALU=aluminium

3. "exchangeRate" — fiat currencies to VND
   fetchParam = ISO code: CNY,KRW,GBP,THB,SGD,AUD,CAD,CHF,INR,BRL,MXN,ZAR
   fetchParam2 = "VND"

4. "yahooFinance" — commodities, international stocks, ETF (Yahoo tickers)
   Commodities: CL=F (dầu thô WTI), NG=F (khí đốt), HG=F (đồng/copper), ZC=F (ngô), ZW=F (lúa mì), ZS=F (đậu nành), GC=F (gold futures), SI=F (silver futures)
   Stocks: AAPL, TSLA, MSFT, AMZN, GOOGL, NVDA, BABA, 005930.KS (Samsung)
   fetchParam = Yahoo ticker, fetchParam2 = "USD"

5. "vnStock" — cổ phiếu Việt Nam (HOSE, HNX, UPCOM), currency = VND
   fetchParam = mã CK: VIC, VHM, VNM, TCB, VCB, FPT, MWG, HPG, MSN, ACB, BID, CTG, VPB, MBB, SSI, VND, HCM, BSI, REE, PNJ, DGW, SAB, GAS, PLX, VJC, HVN

6. "petrolimex" — giá xăng dầu VN (lấy từ Petrolimex), currency = VND (VND/lít)

7. "vnFund" — Quỹ mở VN (NAV/CCQ), currency = VND
   fetchParam = mã quỹ: SSISCA, SSIBF, SSIICO, VESAF, VIBF, VEOF, DCDS, E1VFVN30, TCEF, TCBF, MBVF, VFMVN30, VFMVSF, MAFPF1, MABF
   USE THIS for: quỹ đầu tư, quỹ mở, NAV CCQ, SSISCA, VESAF, quỹ VinaCapital, quỹ SSI, quỹ Techcom
   fetchParam = RON95-V | RON92 | DO (diesel) | MAZ (mazut)
   USE THIS for: xăng, xăng ron95, xăng ron92, xăng A95, xăng e5, dầu diesel, giá xăng VN

Required JSON — ALL fields non-null for supported assets:
{"name":"...","symbol":"...","category":"crypto|metal|currency|commodity|stock|fund","icon":"emoji","color":"#hex","currency":"USD|USD/oz|VND","fetchStrategy":"coingecko|goldApi|exchangeRate|yahooFinance|vnStock|petrolimex","fetchParam":"...","fetchParam2":null,"confidence":0.95,"reasoning":"Vietnamese sentence"}

Key examples:
- "xăng ron95"/"xăng" → {"name":"Xăng RON95-V","symbol":"RON95-V","category":"commodity","icon":"⛽","color":"#e53935","currency":"VND","fetchStrategy":"petrolimex","fetchParam":"RON95-V","fetchParam2":null,"confidence":1,"reasoning":"Giá xăng RON95-V từ Petrolimex VN"}
- "xăng ron92"/"e5" → {"name":"Xăng E5 RON92","symbol":"RON92","category":"commodity","icon":"⛽","color":"#fb8c00","currency":"VND","fetchStrategy":"petrolimex","fetchParam":"RON92","fetchParam2":null,"confidence":1,"reasoning":"Giá xăng E5 RON92 từ Petrolimex"}
- "dầu diesel"/"diesel" → {"name":"Dầu Diesel","symbol":"DO","category":"commodity","icon":"🛢️","color":"#546e7a","currency":"VND","fetchStrategy":"petrolimex","fetchParam":"DO","fetchParam2":null,"confidence":1,"reasoning":"Giá dầu diesel từ Petrolimex VN"}
- "dầu thô"/"crude oil" → {"name":"Crude Oil WTI","symbol":"CL=F","category":"commodity","icon":"🛢️","color":"#2c2c2c","currency":"USD","fetchStrategy":"yahooFinance","fetchParam":"CL=F","fetchParam2":"USD","confidence":1,"reasoning":"Dầu thô WTI futures"}
- "Dogecoin"/"DOGE" → {"name":"Dogecoin","symbol":"DOGE","category":"crypto","icon":"🐕","color":"#c2a633","currency":"USD","fetchStrategy":"coingecko","fetchParam":"dogecoin","fetchParam2":null,"confidence":1,"reasoning":"Dogecoin crypto"}
- "XRP"/"Ripple" → {"name":"Ripple","symbol":"XRP","category":"crypto","icon":"🌊","color":"#0099cc","currency":"USD","fetchStrategy":"coingecko","fetchParam":"ripple","fetchParam2":null,"confidence":1,"reasoning":"XRP crypto"}
- "HPG"/"Hòa Phát" → {"name":"Hoa Phat Group","symbol":"HPG","category":"stock","icon":"🏭","color":"#37474f","currency":"VND","fetchStrategy":"vnStock","fetchParam":"HPG","fetchParam2":null,"confidence":1,"reasoning":"HPG cổ phiếu Hòa Phát HOSE"}
- "đồng"/"copper" → {"name":"Copper","symbol":"HG=F","category":"metal","icon":"🥉","color":"#b87333","currency":"USD","fetchStrategy":"yahooFinance","fetchParam":"HG=F","fetchParam2":"USD","confidence":1,"reasoning":"Đồng HG=F Yahoo Finance"}
- "nhân dân tệ" → {"name":"Chinese Yuan","symbol":"CNY","category":"currency","icon":"🇨🇳","color":"#de2910","currency":"VND","fetchStrategy":"exchangeRate","fetchParam":"CNY","fetchParam2":"VND","confidence":1,"reasoning":"CNY/VND"}

User request: "${userQuery}"`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:     0.05,  // rất thấp → output ổn định
      maxOutputTokens: 2048,  // đủ lớn để không bị cắt
    },
  };

  // Retry 3 lần khi gặp 5xx
  let r, lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      r = await fetchJSON(endpoint, { method: 'POST', headers: {}, body, timeout: 25000 });
      if (r.status < 500) break;
      lastErr = `HTTP ${r.status}: ${r.data?.error?.message || ''}`;
      console.log(`[AI Agent] Attempt ${attempt}/3 → ${r.status}, retry in ${attempt * 3}s...`);
      await new Promise(res => setTimeout(res, attempt * 3000));
    } catch(e) {
      lastErr = e.message;
      console.log(`[AI Agent] Attempt ${attempt}/3 → ${e.message}, retry in ${attempt * 3}s...`);
      await new Promise(res => setTimeout(res, attempt * 3000));
    }
  }
  if (!r) throw new Error(`Gemini unreachable after 3 attempts: ${lastErr}`);
  if (r.status !== 200) {
    throw new Error(`Gemini API error ${r.status}: ${r.data?.error?.message || JSON.stringify(r.data).slice(0,150)}`);
  }

  // ── Extract text from response ────────────────────────────
  const parts   = r.data?.candidates?.[0]?.content?.parts || [];
  const allText = parts.filter(p => p.text).map(p => p.text).join('').trim();
  if (!allText) throw new Error('Gemini returned empty response');

  console.log(`[AI Agent] Raw (${allText.length} chars): ${allText.slice(0, 400)}`);

  // ── Clean & extract JSON ──────────────────────────────────
  const cleaned = allText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

  const start = cleaned.indexOf('{');
  const end   = cleaned.lastIndexOf('}');

  if (start === -1) throw new Error(`No JSON object in response: ${cleaned.slice(0, 200)}`);

  // If JSON is truncated (missing closing }), rebuild with required fields
  let jsonStr;
  if (end === -1 || end < start) {
    console.log(`[AI Agent] ⚠️ JSON truncated — attempting field extraction`);
    // Extract individual fields using regex as fallback
    const extract = (key) => {
      const m = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'i'))
          || cleaned.match(new RegExp(`"${key}"\\s*:\\s*([\\d.]+)`, 'i'));
      return m ? m[1] : null;
    };
    const plan = {
      name:          extract('name')         || userQuery,
      symbol:        extract('symbol')       || null,
      category:      extract('category')     || 'unknown',
      icon:          extract('icon')         || '📊',
      color:         extract('color')        || '#888888',
      currency:      extract('currency')     || 'USD',
      fetchStrategy: extract('fetchStrategy')|| null,
      fetchParam:    extract('fetchParam')   || null,
      fetchParam2:   extract('fetchParam2')  || null,
      confidence:    parseFloat(extract('confidence') || '0'),
      reasoning:     extract('reasoning')    || '',
    };
    console.log(`[AI Agent] Extracted fields:`, JSON.stringify(plan));
    return plan;
  }

  jsonStr = cleaned.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch(e) {
    // Try sanitizing control chars
    try {
      parsed = JSON.parse(jsonStr.replace(/[\x00-\x1F\x7F]/g, ' '));
    } catch(e2) {
      throw new Error(`JSON parse failed: ${e2.message}\nRaw: ${jsonStr.slice(0, 200)}`);
    }
  }

  console.log(`[AI Agent] Plan:`, JSON.stringify(parsed));
  return parsed;
}

// ── MAIN: discover & add asset ────────────────────────────────
async function discoverAndAddAsset(userQuery, geminiKey, existingAssets) {
  console.log(`[AI Agent] Processing: "${userQuery}"`);

  // Step 1: Ask Gemini
  let plan;
  try {
    plan = await askGemini(userQuery, geminiKey);
  } catch(e) {
    throw new Error(`Gemini analysis failed: ${e.message}`);
  }

  // Step 2: Check unsupported
  if (plan.fetchStrategy === 'unsupported' || plan.confidence < 0.3) {
    throw new Error(
        plan.reasoning
            ? `Không hỗ trợ: ${plan.reasoning}`
            : `Không thể xác định "${userQuery}". Thử: tên crypto (Dogecoin), kim loại (đồng, bạch kim), hoặc tiền tệ (nhân dân tệ, won).`
    );
  }

  // Step 3: Validate all required fields present
  const err = validatePlan(plan);
  if (err) throw new Error(`AI trả về dữ liệu không đủ (${err}). Thử lại.`);

  // Step 4: Duplicate check
  const dup = existingAssets.find(a =>
      a.symbol?.toLowerCase() === plan.symbol?.toLowerCase() ||
      a.name?.toLowerCase()   === plan.name?.toLowerCase()
  );
  if (dup) throw new Error(`"${plan.name}" đã tồn tại trong tracker.`);

  // Step 5: Fetch real price
  let priceData;
  try {
    switch (plan.fetchStrategy) {
      case 'coingecko':     priceData = await STRATEGIES.coingecko(plan.fetchParam); break;
      case 'goldApi':       priceData = await STRATEGIES.goldApi(plan.fetchParam); break;
      case 'exchangeRate':  priceData = await STRATEGIES.exchangeRate(plan.fetchParam, plan.fetchParam2 || 'VND'); break;
      case 'yahooFinance':  priceData = await STRATEGIES.yahooFinance(plan.fetchParam, plan.fetchParam2 || 'USD'); break;
      case 'vnStock':       priceData = await STRATEGIES.vnStock(plan.fetchParam); break;
      case 'petrolimex':    priceData = await STRATEGIES.petrolimex(plan.fetchParam || 'RON95-V'); break;
      case 'vnFund':        priceData = await STRATEGIES['vnFund'](plan.fetchParam); break;
      default: throw new Error(`Unknown fetchStrategy: "${plan.fetchStrategy}"`);
    }
  } catch(e) {
    throw new Error(`Không lấy được giá cho "${plan.name}": ${e.message}`);
  }

  // Step 6: Build asset object
  const newId = Math.max(0, ...existingAssets.map(a => a.id || 0)) + 1;
  const asset = {
    id:            newId,
    name:          plan.name,
    sym:           plan.symbol,
    cat:           plan.category || 'crypto',
    icon:          plan.icon     || '📊',
    color:         plan.color    || '#888888',
    price:         priceData.price,
    prev:          priceData.price,
    cur:           priceData.currency || 'USD',
    change24h:     priceData.change24h || 0,
    source:        priceData.source,
    fetchStrategy: plan.fetchStrategy,
    fetchParam:    plan.fetchParam,
    fetchParam2:   plan.fetchParam2 || null,
    addedBy:       'ai-agent',
    addedAt:       new Date().toISOString(),
    reasoning:     plan.reasoning || '',
  };

  console.log(`[AI Agent] ✅ Created: ${asset.name} (${asset.sym}) @ ${asset.price} ${asset.cur}`);
  return asset;
}

// ── REFRESH price for a dynamic asset ────────────────────────
async function refreshDynamicAssetPrice(asset) {
  try {
    switch (asset.fetchStrategy) {
      case 'coingecko':    return await STRATEGIES.coingecko(asset.fetchParam);
      case 'goldApi':      return await STRATEGIES.goldApi(asset.fetchParam);
      case 'exchangeRate': return await STRATEGIES.exchangeRate(asset.fetchParam, asset.fetchParam2 || 'VND');
      case 'yahooFinance': return await STRATEGIES.yahooFinance(asset.fetchParam, asset.fetchParam2 || 'USD');
      case 'vnStock':      return await STRATEGIES.vnStock(asset.fetchParam);
      case 'petrolimex':   return await STRATEGIES.petrolimex(asset.fetchParam || 'RON95-V');
      case 'vnFund':       return await STRATEGIES['vnFund'](asset.fetchParam);
      default:             return null;
    }
  } catch(e) {
    console.error(`[AI Agent] Refresh failed for ${asset.name}:`, e.message);
    return null;
  }
}

module.exports = { discoverAndAddAsset, refreshDynamicAssetPrice };