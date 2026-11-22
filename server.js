const express  = require('express');
const http     = require('http');
const path     = require('path');
const crypto   = require('crypto');
const mongoose = require('mongoose');
const https    = require('https');
const { startEmailImporter } = require('./emailImporter');

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB ───────────────────────────────────
const MONGO_URI = (process.env.MONGO_URI || '').trim();
if (!MONGO_URI) {
  console.error('⚠️ MONGO_URI مش موجود في متغيرات Render — ضيفه من Environment');
} else {
  // بيطبع اسم المستخدم والسيرفر بس (من غير الباسورد) عشان نتأكد إن الرابط الصح هو اللي اتقرا
  const m = MONGO_URI.match(/^mongodb(\+srv)?:\/\/([^:]+):([^@]*)@([^/?]+)/);
  console.log(m
    ? `🔑 MONGO_URI من Render — مستخدم: ${m[2]} | سيرفر: ${m[4]} | طول الباسورد: ${m[3].length}`
    : '⚠️ MONGO_URI موجود بس شكله غلط — لازم يبدأ بـ mongodb+srv://');
}

// ─── Telegram Config ───────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN   || '8714883723:AAEgnEJhS7r7xe9Zk0Yc3Qp-gMxEGs-kbRw';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '1225882653';

async function sendTelegram(msg) {
  return new Promise((resolve) => {
    const text    = encodeURIComponent(msg);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT_ID}&text=${text}&parse_mode=HTML`,
      method: 'GET'
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB متصل'))
  .catch(e => console.error('❌ MongoDB:', e.message));

// ─── Schemas ───────────────────────────────────
const SignalSchema = new mongoose.Schema({
  symbol:         { type: String, required: true },
  action:         { type: String, required: true },
  price:          { type: Number, required: true },
  sl:             Number,
  tp:             Number,
  currentPrice:   Number,
  priceSession:   { type: String, default: null },
  strategy:       { type: String, default: 'TradingView' },
  status:         { type: String, default: 'open', enum: ['open','target','stopped'] },
  closePrice:     Number,
  closedAt:       Date,
  receivedAt:     { type: Date, default: Date.now },
  sentiment:      { type: Number,  default: null },
  sentimentLabel: { type: String,  default: null },
  sentimentNews:  { type: Array,   default: [] },
  sentimentAt:    { type: Date,    default: null },
  analysis:       { type: Object,  default: null },
  analysisAt:     { type: Date,    default: null },
  exchange:       { type: String,  default: null },
  tradeResult:    { type: Object,  default: null },
  // ─── إشارات مستوردة من إيميل TradingView ───
  source:         { type: String,  default: 'webhook' },   // webhook | email
  sourceId:       { type: String,  index: { unique: true, sparse: true } },
  tp2:            Number,
  rsi:            Number
}, { timestamps: true });

const UserSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true },
  password:  { type: String, required: true },
  name:      { type: String, required: true },
  email:     String,
  role:      { type: String, default: 'user', enum: ['user','admin'] },
  active:    { type: Boolean, default: true },
  expiresAt: Date,
  token:     String,
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now }
});

const Signal = mongoose.model('Signal', SignalSchema);
const User   = mongoose.model('User',   UserSchema);

// ─── Admin Init ────────────────────────────────
async function initAdmin() {
  try {
    const exists = await User.findOne({ username: 'admin' });
    if (!exists) {
      await User.create({ username:'admin', password:'admin123', name:'Admin', email:'admin@millionaire.com', role:'admin', active:true });
      console.log('✅ Admin created');
    }
  } catch(e) {}
}

// ─── تحديد جلسة السوق ──────────────────────────
function getMarketSession() {
  const ny       = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day      = ny.getDay();
  const totalMin = ny.getHours() * 60 + ny.getMinutes();
  if (day === 0 || day === 6) return 'closed';
  if (totalMin >= 240  && totalMin < 570)  return 'pre';
  if (totalMin >= 570  && totalMin < 960)  return 'market';
  if (totalMin >= 960  && totalMin < 1200) return 'post';
  return 'closed';
}

// ─── Polygon.io ────────────────────────────────
const POLYGON_KEY = process.env.POLYGON_KEY || 'RBT7Arouh5Y7kfqYWJazzDSKrJqyXZ7w';

async function getPolygonPrice(symbol) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.polygon.io',
      path: `/v2/snapshot/locale/us/markets/stocks/tickers/${symbol.toUpperCase()}?apiKey=${POLYGON_KEY}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json   = JSON.parse(data);
          const ticker = json?.ticker;
          if (!ticker) return resolve(null);
          const price = ticker?.lastTrade?.p || ticker?.day?.c || ticker?.prevDay?.c || null;
          if (price) console.log(`🔷 Polygon: ${symbol} = $${price}`);
          resolve(price ? parseFloat(price) : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function getStockAnalysis(symbol) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.polygon.io',
      path: `/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${POLYGON_KEY}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const r    = json?.results?.[0];
          if (!r) return resolve(null);
          const volume     = r.v || 0;
          const high       = r.h || 0;
          const low        = r.l || 0;
          const close      = r.c || 0;
          const open       = r.o || 0;
          const volatility = close > 0 ? ((high - low) / close * 100).toFixed(2) : 0;
          const change     = open  > 0 ? ((close - open) / open * 100).toFixed(2) : 0;
          const volOk   = volume >= 1000000;
          const atrOk   = parseFloat(volatility) >= 2;
          const priceOk = close >= 1;
          let liquidity = 'ضعيفة';
          if (volume >= 10000000)     liquidity = 'ممتازة';
          else if (volume >= 5000000) liquidity = 'جيدة جداً';
          else if (volume >= 1000000) liquidity = 'جيدة';
          resolve({
            suitable: volOk && atrOk && priceOk, volume,
            volatility: parseFloat(volatility), change: parseFloat(change),
            high, low, close, open, liquidity,
            reasons: { volume: volOk, atr: atrOk, price: priceOk }
          });
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ─── Binance ───────────────────────────────────
async function getBinanceSpotPrice(symbol) {
  return new Promise((resolve) => {
    https.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.price ? parseFloat(json.price) : null);
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─── Bybit Config ──────────────────────────────
const BYBIT_API_KEY    = process.env.BYBIT_API_KEY    || '';
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || '';
const BYBIT_BASE_URL   = process.env.BYBIT_TESTNET === 'true'
  ? 'api-testnet.bybit.com'
  : 'api.bybit.com';

function generateBybitSignature(timestamp, params) {
  const recvWindow  = '5000';
  const queryString = timestamp + BYBIT_API_KEY + recvWindow + JSON.stringify(params);
  return crypto.createHmac('sha256', BYBIT_API_SECRET).update(queryString).digest('hex');
}

function generateBybitGetSignature(timestamp, queryString) {
  const recvWindow = '5000';
  const str        = timestamp + BYBIT_API_KEY + recvWindow + queryString;
  return crypto.createHmac('sha256', BYBIT_API_SECRET).update(str).digest('hex');
}

// ─── جيب سعر Bybit ─────────────────────────────
async function getBybitPrice(symbol) {
  const bybitSymbol = symbol.toUpperCase().endsWith('USDT')
    ? symbol.toUpperCase()
    : symbol.toUpperCase() + 'USDT';

  return new Promise((resolve) => {
    https.get(`https://${BYBIT_BASE_URL}/v5/market/tickers?category=spot&symbol=${bybitSymbol}`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json  = JSON.parse(data);
          const price = json?.result?.list?.[0]?.lastPrice;
          resolve(price ? parseFloat(price) : null);
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─── ✅ جيب رصيد USDT المتاح ───────────────────
async function getBybitBalance() {
  if (!BYBIT_API_KEY || !BYBIT_API_SECRET) return null;

  const timestamp  = Date.now().toString();
  const qs         = 'accountType=UNIFIED';
  const signature  = generateBybitGetSignature(timestamp, qs);

  return new Promise((resolve) => {
    const options = {
      hostname: BYBIT_BASE_URL,
      path:     '/v5/account/wallet-balance?' + qs,
      method:   'GET',
      headers: {
        'X-BAPI-API-KEY':     BYBIT_API_KEY,
        'X-BAPI-TIMESTAMP':   timestamp,
        'X-BAPI-SIGN':        signature,
        'X-BAPI-RECV-WINDOW': '5000'
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json  = JSON.parse(data);
          const coins = json?.result?.list?.[0]?.coin || [];
          const usdt  = coins.find(c => c.coin === 'USDT');
          const avail = parseFloat(usdt?.availableToWithdraw || usdt?.walletBalance || 0);
          console.log(`💰 رصيد USDT المتاح: $${avail}`);
          resolve(avail);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ─── ✅ تنفيذ أوردر Bybit ──────────────────────
async function placeBybitOrder(action, symbol) {
  if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
    console.log('⚠️ Bybit API غير مضبوط');
    return null;
  }

  const bybitSymbol = symbol.toUpperCase().endsWith('USDT')
    ? symbol.toUpperCase()
    : symbol.toUpperCase() + 'USDT';

  // جيب السعر الحالي
  const currentPrice = await getBybitPrice(symbol);
  if (!currentPrice) {
    console.error('❌ مش قادر يجيب السعر من Bybit');
    return null;
  }

  // ─── حساب الكمية ───────────────────────────
  let qty;
  const useAllBalance = process.env.USE_ALL_BALANCE === 'true';

  if (useAllBalance) {
    // اشتري بكل الرصيد المتاح
    const balance = await getBybitBalance();
    if (!balance || balance < 1) {
      console.error('❌ الرصيد غير كافٍ أو لا يمكن جلبه');
      return null;
    }
    const useAmount = balance - 1; // نترك 1 دولار للفيس
    qty = (useAmount / currentPrice).toFixed(6);
    console.log(`💰 شراء بكل الرصيد: $${useAmount} → ${qty} ${bybitSymbol} @ $${currentPrice}`);
  } else {
    // استخدم TRADE_AMOUNT بالدولار
    const tradeAmount = parseFloat(process.env.TRADE_AMOUNT) || 10;
    qty = (tradeAmount / currentPrice).toFixed(6);
    console.log(`💵 شراء بـ $${tradeAmount} → ${qty} ${bybitSymbol} @ $${currentPrice}`);
  }

  const params = {
    category:  'spot',
    symbol:    bybitSymbol,
    side:      action === 'BUY' ? 'Buy' : 'Sell',
    orderType: 'Market',
    qty:       qty
  };

  const timestamp = Date.now().toString();
  const signature = generateBybitSignature(timestamp, params);

  return new Promise((resolve) => {
    const body    = JSON.stringify(params);
    const options = {
      hostname: BYBIT_BASE_URL,
      path:     '/v5/order/create',
      method:   'POST',
      headers: {
        'Content-Type':       'application/json',
        'X-BAPI-API-KEY':     BYBIT_API_KEY,
        'X-BAPI-TIMESTAMP':   timestamp,
        'X-BAPI-SIGN':        signature,
        'X-BAPI-RECV-WINDOW': '5000'
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.retCode === 0) {
            console.log(`✅ Bybit Order نجح: ${action} ${bybitSymbol} qty:${qty}`);
          } else {
            console.error(`❌ Bybit Error: ${json.retMsg}`);
          }
          resolve(json);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('❌ Bybit Request Error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── NewsAPI ────────────────────────────────────
const NEWS_API_KEY = process.env.NEWS_API_KEY || '854ddf963cba41048bf747785ac26ebd';

async function getNewsForSymbol(symbol) {
  const query = symbol.replace(/USDT$/i,'').replace(/USD$/i,'');
  return new Promise((resolve) => {
    const p = `/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_API_KEY}`;
    const options = {
      hostname: 'newsapi.org',
      path: p,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json     = JSON.parse(data);
          const articles = (json.articles || []).map(a => ({
            title:       a.title,
            description: a.description,
            url:         a.url,
            publishedAt: a.publishedAt,
            source:      a.source?.name
          }));
          resolve(articles);
        } catch(e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ─── Claude AI — Sentiment ─────────────────────
async function analyzeSentiment(symbol, articles) {
  if (!articles.length) return { score: 50, label: 'محايد' };
  try {
    const headlines = articles.map((a,i) => `${i+1}. ${a.title}`).join('\n');
    const prompt = `أنت محلل مالي. حلل مشاعر هذه الأخبار المتعلقة بـ ${symbol} وأعطني:
1. نسبة مئوية من 0 إلى 100
2. تصنيف: إيجابي أو سلبي أو محايد

الأخبار:
${headlines}

أجب بـ JSON فقط:
{"score": 75, "label": "إيجابي"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages:   [{ role: 'user', content: prompt }]
      })
    });
    const data  = await response.json();
    const text  = data?.content?.[0]?.text || '{"score":50,"label":"محايد"}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return { score: 50, label: 'محايد' };
  }
}

async function updateSentiment(signal) {
  try {
    const articles = await getNewsForSymbol(signal.symbol);
    const result   = await analyzeSentiment(signal.symbol, articles);
    await Signal.findByIdAndUpdate(signal._id, {
      sentiment:      result.score,
      sentimentLabel: result.label,
      sentimentNews:  articles.slice(0, 5),
      sentimentAt:    new Date()
    });
    console.log(`📰 Sentiment ${signal.symbol}: ${result.score}% ${result.label}`);
  } catch(e) {
    console.error('❌ Sentiment error:', e.message);
  }
}

// ─── Yahoo Finance ─────────────────────────────
async function getYahooPrice(symbol) {
  let yahooSym = symbol;
  if (/USDT$/i.test(symbol)) yahooSym = symbol.replace(/USDT$/i, '') + '-USD';

  const price1 = await new Promise((resolve) => {
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path: `/v7/finance/quote?symbols=${encodeURIComponent(yahooSym)}&region=US`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json  = JSON.parse(data);
          const quote = json?.quoteResponse?.result?.[0];
          if (!quote) return resolve(null);
          const session = getMarketSession();
          if (session === 'pre'  && quote.preMarketPrice)  return resolve(parseFloat(quote.preMarketPrice));
          if (session === 'post' && quote.postMarketPrice) return resolve(parseFloat(quote.postMarketPrice));
          resolve(quote.regularMarketPrice ? parseFloat(quote.regularMarketPrice) : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });

  if (price1) { console.log(`📈 Yahoo v7: ${symbol} = $${price1}`); return price1; }

  const price2 = await new Promise((resolve) => {
    const options = {
      hostname: 'query2.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const meta = json?.chart?.result?.[0]?.meta;
          if (!meta) return resolve(null);
          const session = getMarketSession();
          if (session === 'pre'  && meta.preMarketPrice)  return resolve(parseFloat(meta.preMarketPrice));
          if (session === 'post' && meta.postMarketPrice) return resolve(parseFloat(meta.postMarketPrice));
          resolve(meta.regularMarketPrice ? parseFloat(meta.regularMarketPrice) : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });

  if (price2) { console.log(`📈 Yahoo v8: ${symbol} = $${price2}`); return price2; }
  return null;
}

// ─── Smart Price ───────────────────────────────
async function getStockPrice(symbol) {
  const exchange = process.env.EXCHANGE || 'binance';
  if (exchange === 'bybit' && BYBIT_API_KEY) {
    const bybitPrice = await getBybitPrice(symbol);
    if (bybitPrice) { console.log(`🟡 Bybit: ${symbol} = $${bybitPrice}`); return bybitPrice; }
  }

  const binancePrice = await getBinanceSpotPrice(symbol);
  if (binancePrice) { console.log(`💹 Binance: ${symbol} = $${binancePrice}`); return binancePrice; }

  const yahooPrice = await getYahooPrice(symbol);
  if (yahooPrice) return yahooPrice;

  const polygonPrice = await getPolygonPrice(symbol);
  if (polygonPrice) return polygonPrice;

  console.log(`⚠️ لا سعر متاح لـ ${symbol}`);
  return null;
}

// ─── Auto Update كل 60 ثانية ──────────────────
async function updateCurrentPrices() {
  try {
    const openSignals = await Signal.find({ status: 'open' });
    if (!openSignals.length) return;

    const session = getMarketSession();
    console.log(`🕐 جلسة السوق: ${session}`);

    for (const signal of openSignals) {
      const price = await getStockPrice(signal.symbol);
      if (!price) { console.log(`⚠️ لا سعر لـ ${signal.symbol}`); continue; }

      const update = { currentPrice: price, priceSession: session };

      if (signal.action === 'BUY') {
        if (signal.tp && price >= signal.tp) {
          Object.assign(update, { status:'target', closePrice:price, closedAt:new Date() });
          console.log(`🎯 هدف! ${signal.symbol} @ $${price}`);
        } else if (signal.sl && price <= signal.sl) {
          Object.assign(update, { status:'stopped', closePrice:price, closedAt:new Date() });
          console.log(`🛑 وقف! ${signal.symbol} @ $${price}`);
        }
      } else if (signal.action === 'SELL') {
        if (signal.tp && price <= signal.tp) {
          Object.assign(update, { status:'target', closePrice:price, closedAt:new Date() });
          console.log(`🎯 هدف! ${signal.symbol} @ $${price}`);
        } else if (signal.sl && price >= signal.sl) {
          Object.assign(update, { status:'stopped', closePrice:price, closedAt:new Date() });
          console.log(`🛑 وقف! ${signal.symbol} @ $${price}`);
        }
      }

      await Signal.findByIdAndUpdate(signal._id, update);
    }
    console.log(`🔄 تحديث ${openSignals.length} إشارة — جلسة: ${session}`);
  } catch(e) { console.error('❌ updateCurrentPrices:', e.message); }
}

mongoose.connection.once('open', () => {
  initAdmin();
  updateCurrentPrices();
  setInterval(updateCurrentPrices, 60000);

  // ─── قراءة إيميلات TradingView لحظياً (عرض فقط — بدون تنفيذ صفقات) ───
  startEmailImporter(Signal, {
    onNew: (s) => sendTelegram(
      '📧 إشارة من الإيميل <b>' + s.symbol + '</b>\n\n' +
      '💰 دخول: <b>$' + s.price + '</b>\n' +
      (s.tp  ? '🎯 هدف 1: <b>$' + s.tp  + '</b>\n' : '') +
      (s.tp2 ? '🎯 هدف 2: <b>$' + s.tp2 + '</b>\n' : '') +
      '⚡ ' + s.strategy
    )
  });
});

// ─── Auth ──────────────────────────────────────
async function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  const user = await User.findOne({ token, active: true });
  if (!user) return res.status(401).json({ error: 'جلسة منتهية' });
  if (user.expiresAt && new Date(user.expiresAt) < new Date())
    return res.status(403).json({ error: 'انتهى الاشتراك' });
  req.user = user;
  next();
}
async function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ليس لديك صلاحية' });
  next();
}

// ─── Auth Routes ───────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });
    if (!user.active) return res.status(403).json({ error: 'الحساب موقوف' });
    if (user.expiresAt && new Date(user.expiresAt) < new Date())
      return res.status(403).json({ error: 'انتهى اشتراكك' });
    user.token     = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date();
    await user.save();
    res.json({ token: user.token, name: user.name, role: user.role, expiresAt: user.expiresAt });
  } catch(e) { res.status(500).json({ error: 'خطأ في السيرفر' }); }
});

app.post('/api/logout', auth, async (req, res) => {
  req.user.token = null;
  await req.user.save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ name: req.user.name, role: req.user.role, expiresAt: req.user.expiresAt });
});

app.put('/api/me/password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (req.user.password !== oldPassword) return res.status(400).json({ error: 'كلمة المرور القديمة خاطئة' });
  req.user.password = newPassword;
  await req.user.save();
  res.json({ ok: true });
});

// ─── Signals ───────────────────────────────────
app.get('/api/signals', auth, async (req, res) => {
  const query = { receivedAt: { $gte: req.user.createdAt || new Date(0) } };
  if (req.user.role === 'admin') delete query.receivedAt;
  const signals = await Signal.find(query).sort({ receivedAt: -1 }).limit(500);
  res.json(signals);
});

app.put('/api/signals/:id', auth, async (req, res) => {
  try {
    const { status, closePrice } = req.body;
    const sig = await Signal.findByIdAndUpdate(req.params.id, { status, closePrice, closedAt: new Date() }, { new: true });
    res.json({ ok: true, signal: sig });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/signals/:id', auth, adminOnly, async (req, res) => {
  await Signal.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/signals/delete-many', auth, adminOnly, async (req, res) => {
  const { ids } = req.body;
  await Signal.deleteMany({ _id: { $in: ids } });
  res.json({ ok: true });
});

// ─── Prices API ────────────────────────────────
app.get('/api/prices', auth, async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.json({});
  const syms   = symbols.split(',').filter(Boolean);
  const result = {};
  for (const sym of syms) {
    const price = await getStockPrice(sym);
    if (price) result[sym.toUpperCase()] = price;
  }
  res.json(result);
});

// ─── ✅ TradingView Webhook ─────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    if (!data.action || !data.symbol) return res.status(400).json({ error: 'بيانات ناقصة' });

    if (['STOPPED','CLOSED','CLOSE'].includes(data.action.toUpperCase())) {
      const result    = (data.result || '').toUpperCase();
      const newStatus = result === 'TP' ? 'target' : 'stopped';
      await Signal.findOneAndUpdate(
        { symbol: data.symbol.toUpperCase(), status: 'open' },
        { status: newStatus, closedAt: new Date(), closePrice: data.price }
      );
      console.log(`🔒 ${data.action} ${data.symbol} | Result: ${result} → ${newStatus}`);
      return res.json({ ok: true, status: newStatus });
    }

    const entry    = parseFloat(data.price);
    const sl       = parseFloat(data.sl) || parseFloat((entry * 0.98).toFixed(4));
    const tp       = parseFloat(data.tp) || parseFloat((entry * 1.05).toFixed(4));
    const session  = getMarketSession();
    const exchange = process.env.EXCHANGE || 'binance';

    const signal = await Signal.create({
      symbol:       data.symbol.toUpperCase(),
      action:       data.action.toUpperCase(),
      price:        entry,
      sl, tp,
      currentPrice: entry,
      strategy:     data.strategy || 'TradingView',
      priceSession: session,
      status:       'open',
      receivedAt:   new Date(),
      exchange
    });

    console.log(`📡 ${signal.action} ${signal.symbol} @ $${entry} | جلسة: ${session} | منصة: ${exchange}`);

    // ─── تنفيذ أوردر Bybit ─────────────────────
    const bybitEnabled = process.env.BYBIT_TRADING === 'true';
    if (bybitEnabled && BYBIT_API_KEY && exchange === 'bybit') {
      placeBybitOrder(signal.action, signal.symbol).then(async (result) => {
        if (result) {
          await Signal.findByIdAndUpdate(signal._id, { tradeResult: result });
          console.log(`🤖 Bybit تداول آلي: ${signal.action} ${signal.symbol}`);
        }
      }).catch(console.error);
    }

    // ─── السعر الفوري ──────────────────────────
    getStockPrice(signal.symbol).then(async (livePrice) => {
      if (livePrice) {
        await Signal.findByIdAndUpdate(signal._id, { currentPrice: livePrice, priceSession: session });
        console.log(`⚡ السعر الفوري لـ ${signal.symbol}: $${livePrice}`);
      }
    }).catch(console.error);

    updateSentiment(signal).catch(console.error);

    // ─── Telegram ──────────────────────────────
    const isBuy        = signal.action === 'BUY';
    const slPct        = entry > 0 && sl > 0 ? ((Math.abs(entry - sl) / entry) * 100).toFixed(2) : '0';
    const tpPct        = entry > 0 && tp > 0 ? ((Math.abs(tp - entry) / entry) * 100).toFixed(2) : '0';
    const sessionLabel  = session === 'pre' ? '🌅 قبل السوق' : session === 'post' ? '🌙 بعد السوق' : '📈 خلال السوق';
    const exchangeLabel = exchange === 'bybit' ? '🟡 Bybit' : '🟠 Binance';
    const balanceMode   = process.env.USE_ALL_BALANCE === 'true' ? '💰 كل الرصيد' : `💵 $${process.env.TRADE_AMOUNT || 10}`;
    const tgMsg = (isBuy ? '🟢 شراء' : '🔴 بيع') + ' <b>' + signal.symbol + '</b>\n\n' +
                  '💰 دخول: <b>$' + entry + '</b>\n' +
                  '🎯 هدف: <b>$' + tp + '</b> (+' + tpPct + '%)\n' +
                  '🛑 وقف: <b>$' + sl + '</b> (-' + slPct + '%)\n' +
                  '⚡ استراتيجية: ' + signal.strategy + '\n' +
                  exchangeLabel + ' | ' + balanceMode + '\n' +
                  sessionLabel + '\n\n' +
                  '🕐 ' + new Date().toLocaleString('ar');
    sendTelegram(tgMsg).catch(console.error);

    res.json({ ok: true, signal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin ─────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  res.json(await User.find().select('-token'));
});

app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, name, email, days } = req.body;
    const expiresAt = days ? new Date(Date.now() + days * 86400000) : null;
    const user = await User.create({ username, password, name, email, role:'user', active:true, expiresAt });
    res.json({ ok: true, user });
  } catch(e) {
    if (e.code === 11000) return res.status(400).json({ error: 'اسم المستخدم موجود' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const { active, days, password, name } = req.body;
    const update = {};
    if (active !== undefined) update.active = active;
    if (days)     update.expiresAt = new Date(Date.now() + days * 86400000);
    if (password) update.password = password;
    if (name)     update.name = name;
    await User.findByIdAndUpdate(req.params.id, update);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/signals', auth, adminOnly, async (req, res) => {
  await Signal.deleteMany({});
  res.json({ ok: true });
});

app.post('/api/admin/signals', auth, adminOnly, async (req, res) => {
  try {
    const { symbol, action, price, sl, tp, strategy } = req.body;
    const entry = parseFloat(price);
    const slVal = parseFloat(sl) || parseFloat((entry * 0.98).toFixed(4));
    const tpVal = parseFloat(tp) || parseFloat((entry * 1.05).toFixed(4));
    const signal = await Signal.create({
      symbol: symbol.toUpperCase(), action: action.toUpperCase(),
      price: entry, sl: slVal, tp: tpVal,
      strategy: strategy || 'Manual', status: 'open', receivedAt: new Date()
    });
    res.json({ ok: true, signal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Stats ─────────────────────────────────────
app.get('/api/stats', auth, async (req, res) => {
  const total   = await Signal.countDocuments();
  const open    = await Signal.countDocuments({ status:'open' });
  const target  = await Signal.countDocuments({ status:'target' });
  const stopped = await Signal.countDocuments({ status:'stopped' });
  const winRate = total > 0 ? ((target / (target + stopped)) * 100).toFixed(1) : 0;
  res.json({ total, open, target, stopped, winRate });
});

// ─── Stock Analysis API ─────────────────────────
app.get('/api/analysis/:id', auth, async (req, res) => {
  try {
    const sig = await Signal.findById(req.params.id).select('analysis analysisAt symbol');
    if (!sig) return res.status(404).json({ error: 'مش موجود' });
    const needsUpdate = !sig.analysisAt || (Date.now() - new Date(sig.analysisAt)) > 6 * 3600000;
    if (needsUpdate) {
      const result = await getStockAnalysis(sig.symbol);
      if (result) {
        await Signal.findByIdAndUpdate(req.params.id, { analysis: result, analysisAt: new Date() });
        return res.json({ ok: true, analysis: result, symbol: sig.symbol });
      }
    }
    res.json({ ok: true, analysis: sig.analysis, symbol: sig.symbol });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Sentiment API ──────────────────────────────
app.get('/api/sentiment/:id', auth, async (req, res) => {
  try {
    const sig = await Signal.findById(req.params.id).select('sentiment sentimentLabel sentimentNews sentimentAt symbol');
    if (!sig) return res.status(404).json({ error: 'مش موجود' });
    res.json(sig);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sentiment/:id/refresh', auth, async (req, res) => {
  try {
    const sig = await Signal.findById(req.params.id);
    if (!sig) return res.status(404).json({ error: 'مش موجود' });
    updateSentiment(sig).catch(console.error);
    res.json({ ok: true, message: 'جارٍ التحليل...' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Bybit Status API ──────────────────────────
app.get('/api/bybit/status', auth, adminOnly, async (req, res) => {
  const configured    = !!(BYBIT_API_KEY && BYBIT_API_SECRET);
  const exchange      = process.env.EXCHANGE || 'binance';
  const trading       = process.env.BYBIT_TRADING === 'true';
  const testnet       = process.env.BYBIT_TESTNET === 'true';
  const useAllBalance = process.env.USE_ALL_BALANCE === 'true';
  let balance = null;
  if (configured) balance = await getBybitBalance().catch(() => null);
  res.json({ configured, exchange, trading, testnet, useAllBalance, balance, baseUrl: BYBIT_BASE_URL });
});

// ─── Pages ─────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/reports',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'reports.html')));

// ─── Ping Endpoint ─────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date() }));

// ─── Self-Ping كل 4 دقائق ──────────────────────
function selfPing() {
  https.get('https://sigma-signals-by-mahmoud-ahmed.onrender.com/ping', (res) => {
    console.log(`🏓 Self-ping: ${res.statusCode}`);
  }).on('error', (e) => {
    console.log(`⚠️ Self-ping failed: ${e.message}`);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ MILLIONAIRE شغال على بورت ${PORT}`);
  // ابدأ Self-ping بعد دقيقة من الشغل
  setTimeout(() => {
    selfPing();
    setInterval(selfPing, 4 * 60 * 1000); // كل 4 دقائق
  }, 60000);
});
