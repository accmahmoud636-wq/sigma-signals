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
// بيانات تليجرام: من صفحة البوت في المنصة (لو اتحطت) وإلا من متغيرات Render
let TG = { token: process.env.TG_TOKEN || '', chat: process.env.TG_CHAT_ID || '' };
function setTelegramFromSettings(s) {
  if (s && s.tgToken)  TG.token = s.tgToken;
  if (s && s.tgChatId) TG.chat  = s.tgChatId;
}

async function sendTelegram(msg) {
  if (!TG.token || !TG.chat) return null;
  return new Promise((resolve) => {
    const text    = encodeURIComponent(msg);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TG.token}/sendMessage?chat_id=${TG.chat}&text=${text}&parse_mode=HTML`,
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

// ─── إعدادات بوت سهم (بيقرأها البوت اللي على الكمبيوتر لحظياً) ───
const BotSettingsSchema = new mongoose.Schema({
  key:        { type: String, unique: true, default: 'sahm' },
  paused:     { type: Boolean, default: false },   // إيقاف طارئ
  dryRun:     { type: Boolean, default: true },    // تجربة من غير إرسال
  amount:     { type: Number,  default: 100 },     // مبلغ الصفقة $
  offsetPct:  { type: Number,  default: 0.5 },
  orderType:  { type: String,  default: 'market' },
  fundAccount:{ type: String,  default: '' },       // رقم المحفظة في سهم (مثلاً 800906239) // market أمر سوق / limit محدد     // سعر المحدد فوق الإشارة %
  tpPct:      { type: Number,  default: 5 },
  slPct:      { type: Number,  default: 3 },
  trailOn:    { type: Boolean, default: false },   // هدف متحرك (Trailing)
  trailStart: { type: Number,  default: 5 },       // يبدأ لما الربح يوصل %
  trailPct:   { type: Number,  default: 2 },       // يبيع لو السعر رجع % من أعلى سعر
  minPrice:   { type: Number,  default: 3 },
  maxPrice:   { type: Number,  default: 5 },
  maxPerDay:  { type: Number,  default: 5 },
  session:    { type: String,  default: '' },      // نص اختيار الجلسة في سهم (فاضي = الافتراضي)
  heartbeat:  { type: Date,    default: null },    // آخر مرة البوت أكد إنه شغال
  botMode:    { type: String,  default: null },
  broker:     { type: String,  default: 'sahm' },  // الوسيط
  market:     { type: String,  default: 'US' },    // السوق: US أمريكي / SA سعودي
  sizeMode:   { type: String,  default: 'fixed', enum: ['fixed','percent'] },
  sizePct:    { type: Number,  default: 10 },      // % من المحفظة لو sizeMode=percent
  dailyProfitTarget: { type: Number, default: 0 }, // $ — 0 = بدون حد
  dailyLossLimit:    { type: Number, default: 0 }, // $ — 0 = بدون حد
  autoBracket:{ type: Boolean, default: true },    // إغلاق تلقائي: جني الربح/وقف الخسارة مع الشراء
  tgToken:    { type: String,  default: '' },
  tgChatId:   { type: String,  default: '' },
  brokerLoggedIn: { type: Boolean, default: false },
  account:    { type: Object,  default: null },    // {netAssets, buyingPower, currency, at} من البوت
  // ─── تسجيل دخول سهم من المنصة ───
  sahmPhone:  { type: String,  default: '' },      // رقم الجوال (بدون +966)
  sahmMethod: { type: String,  default: 'sms' },   // sms | whatsapp
  command:    { type: Object,  default: null },    // أمر للبوت: {id, type:'login'|'otp', code?}
  loginState: { type: String,  default: 'idle' },  // idle|sending|awaiting_otp|verifying|success|error
  loginMsg:   { type: String,  default: '' },
  orderState: { type: String,  default: '' },  // بيع من المنصة: working / preview / sent / error
  orderMsg:   { type: String,  default: '' },
  orderAt:    { type: Date }
}, { timestamps: true, collection: 'botsettings' });
const BotSettings = mongoose.model('BotSettings', BotSettingsSchema);
const BotLog = mongoose.model('BotLog', new mongoose.Schema({
  level: { type: String, default: 'info' }, msg: String, at: { type: Date, default: Date.now }
}, { collection: 'botlogs' }));
async function getBotSettings() {
  return BotSettings.findOneAndUpdate({ key: 'sahm' }, { $setOnInsert: { key: 'sahm' } }, { upsert: true, new: true });
}
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
  getBotSettings().then(setTelegramFromSettings).catch(() => {});
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
// Webhook: بيقبل JSON حتى لو TradingView بعته كنص (text/plain) أو فيه كلام زيادة حوالين الـ JSON
// وكل طلب بيتسجّل في webhooklogs عشان نعرف TradingView وصل ولا لأ
app.post('/webhook', express.text({ type: () => true, limit: '64kb' }), async (req, res) => {
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  const wlog = (result) => mongoose.connection.collection('webhooklogs').insertOne({
    at: new Date(), ip: req.headers['x-forwarded-for'] || req.ip, ctype: req.headers['content-type'] || '', raw: raw.slice(0, 2000), result }).catch(() => {});
  try {
    let data = {};
    try { data = JSON.parse(raw); } catch (_) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { data = JSON.parse(m[0]); } catch (_) {} } }
    // رسالة مؤشر RSI7 Buy النصية (اللي بتروح الإيميل): "🟢 إشارة شراء: SOUN / سعر الدخول المقترح: 2.61 / الهدف الأول (+5%): 2.74"
    if (!data.action && /إشارة شراء/.test(raw)) {
      const num = (re) => { const m = raw.match(re); return m ? parseFloat(m[1]) : NaN; };
      const sym = (raw.match(/إشارة شراء:\s*([A-Z0-9.\-:]+)/i) || [])[1];
      const price = num(/سعر الدخول المقترح:\s*([\d.]+)/), tp = num(/الهدف الأول[^:]*:\s*([\d.]+)/);
      if (sym && price > 0) {
        const bs = await BotSettings.findOne({ key: 'sahm' }).lean().catch(() => null);
        const slPct = (bs && bs.slPct) || 3;
        data = { action: 'BUY', symbol: sym, price, tp: tp > 0 ? tp : undefined, sl: +(price * (1 - slPct / 100)).toFixed(4), strategy: 'RSI7 Buy (مؤشر)' };
      }
    }
    // تنبيه "حقق الهدف الأول" من المؤشر = خروج
    if (!data.action && /حقق الهدف الأول/.test(raw)) {
      const sym = (raw.match(/✓\s*([A-Z0-9.\-:]+)\s*حقق/i) || [])[1];
      const px = parseFloat((raw.match(/حقق الهدف الأول:\s*([\d.]+)/) || [])[1]);
      if (sym) data = { action: 'CLOSE', symbol: sym, price: px, result: 'TP' };
    }
    // تنبيه "حقق الهدف الثاني" = معلومة بس (البوت بيكون باع عند الأول)
    if (!data.action && /حقق الهدف الثاني/.test(raw)) { wlog('ℹ️ هدف تاني — للعلم بس'); return res.json({ ok: true, ignored: 'tp2' }); }
    // أي رسالة مش مفهومة: بنرد 200 (مش 400) عشان TradingView ما يعتبرش الـ webhook بايظ ويوقّفه
    if (!data.action || !data.symbol) { wlog('⚠️ رسالة مش مفهومة — اتسجلت بس'); return res.json({ ok: true, ignored: 'unrecognized' }); }
    data.action = String(data.action); data.symbol = String(data.symbol).replace(/^[A-Z]+:/i, '');
    wlog('✅ ' + data.action.toUpperCase() + ' ' + data.symbol.toUpperCase() + ' @ ' + data.price);

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
app.get('/bot',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'bot.html')));

// ─── بوت سهم: الإعدادات والصفقات ─────────────
const maskSettings = (s) => {
  const o = s.toObject ? s.toObject() : { ...s };
  o.tgTokenSet = !!o.tgToken;
  o.tgToken = o.tgToken ? '••••' + o.tgToken.slice(-4) : '';
  if (o.command) o.command = { type: o.command.type };
  return o;
};

app.get('/api/bot/settings', auth, adminOnly, async (req, res) => {
  try { res.json(maskSettings(await getBotSettings())); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot/settings', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
    const bool = (v) => typeof v === 'boolean' ? v : undefined;
    const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : undefined;
    const upd = {
      paused: bool(b.paused), dryRun: bool(b.dryRun), autoBracket: bool(b.autoBracket),
      broker:    ['sahm','sahm-vps'].includes(b.broker) ? b.broker : undefined,
      market:    ['US','SA'].includes(b.market) ? b.market : undefined,
      sizeMode:  ['fixed','percent'].includes(b.sizeMode) ? b.sizeMode : undefined,
      sizePct:   num(b.sizePct, 0.1, 100),
      amount:    num(b.amount, 1, 1000000),
      offsetPct: num(b.offsetPct, 0, 5),
      orderType: ['market','limit'].includes(b.orderType) ? b.orderType : undefined,
      fundAccount: typeof b.fundAccount === 'string' ? b.fundAccount.replace(/\D/g, '').slice(0, 15) : undefined,
      tpPct:     num(b.tpPct, 0.1, 100),
      slPct:     num(b.slPct, 0.1, 100),
      trailOn:   bool(b.trailOn),
      trailStart: num(b.trailStart, 0, 100),
      trailPct:  num(b.trailPct, 0.1, 50),
      minPrice:  num(b.minPrice, 0, 100000),
      maxPrice:  num(b.maxPrice, 0, 100000),
      maxPerDay: num(b.maxPerDay, 0, 100),
      dailyProfitTarget: num(b.dailyProfitTarget, 0, 10000000),
      dailyLossLimit:    num(b.dailyLossLimit, 0, 10000000),
      session:   str(b.session, 60),
      tgChatId:  str(b.tgChatId, 40)
    };
    // التوكن: بيتحفظ بس لو اتكتب توكن جديد (مش النسخة المخفية)
    if (typeof b.tgToken === 'string' && b.tgToken.trim() && !b.tgToken.startsWith('••••')) upd.tgToken = b.tgToken.trim();
    Object.keys(upd).forEach(k => upd[k] === undefined && delete upd[k]);
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: upd }, { upsert: true, new: true });
    setTelegramFromSettings(s);
    if ('paused' in upd || 'dryRun' in upd) {
      const m = `🤖 بوت سهم: ${s.paused ? '⏸ متوقف' : '▶️ شغال'} | ${s.dryRun ? '🧪 تجربة' : '💵 تنفيذ حقيقي'}`;
      sendTelegram(m).catch(() => {});
      BotLog.create({ msg: 'من المنصة: ' + m }).catch(() => {});
    }
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot/test-telegram', auth, adminOnly, async (req, res) => {
  const r = await sendTelegram('✅ تجربة: تليجرام متصل بمنصة MILLIONAIRE');
  res.json({ ok: !!(r && r.ok), error: r && !r.ok ? r.description : (r ? null : 'بيانات تليجرام ناقصة') });
});

// إحصائيات اليوم: الصفقات المنفذة + ربح/خسارة تقديرية من الأسعار اللي المنصة بتتابعها
app.get('/api/bot/stats', auth, adminOnly, async (req, res) => {
  try {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const sent = await Signal.find({ 'tradeResult.broker': 'sahm', 'tradeResult.status': 'sent' })
      .select('status closePrice currentPrice tradeResult').lean();
    let today = 0, pnlToday = 0, reserved = 0;
    for (const s of sent) {
      const t = s.tradeResult, qty = t.qty || 0, entry = t.limit || 0;
      const isToday = t.at && new Date(t.at) >= dayStart;
      if (isToday) today++;
      if (s.status === 'open') reserved += qty * entry;
      const exit = s.status === 'open' ? s.currentPrice : s.closePrice;
      if (isToday && exit) pnlToday += qty * (exit - entry);
    }
    res.json({ totalTrades: sent.length, todayTrades: today, pnlToday: +pnlToday.toFixed(2), reserved: +reserved.toFixed(2) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot/logs', auth, adminOnly, async (req, res) => {
  try { res.json(await BotLog.find().sort({ at: -1 }).limit(100).lean()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── تسجيل دخول سهم من المنصة (البوت بينفذ على الجهاز) ─────────────
app.post('/api/bot/sahm-login', auth, adminOnly, async (req, res) => {
  try {
    const phone = String(req.body.phone || '').replace(/\D/g, '').replace(/^966/, '').replace(/^0/, '');
    const method = req.body.method === 'whatsapp' ? 'whatsapp' : 'sms';
    if (!/^5\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الجوال لازم يكون 9 أرقام ويبدأ بـ 5' });
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: {
      sahmPhone: phone, sahmMethod: method,
      command: { id: Date.now().toString(36), type: 'login', at: new Date() },
      loginState: 'sending', loginMsg: 'جاري إرسال الطلب للبوت...'
    } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot/sahm-otp', auth, adminOnly, async (req, res) => {
  try {
    const code = String(req.body.code || '').replace(/\D/g, '');
    if (code.length < 4 || code.length > 8) return res.status(400).json({ error: 'رمز التحقق غير صحيح' });
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: {
      command: { id: Date.now().toString(36), type: 'otp', code, at: new Date() },
      loginState: 'verifying', loginMsg: 'جاري التحقق من الرمز...'
    } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// بيع من المنصة: confirm=false معاينة (من غير إرسال) / confirm=true إرسال فعلي
app.post('/api/bot/sell', auth, adminOnly, async (req, res) => {
  try {
    const symbol = String(req.body.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
    const qty = Math.floor(Number(req.body.qty)), price = Number(req.body.price), confirm = req.body.confirm === true;
    if (!symbol || !(qty > 0) || !(price > 0)) return res.status(400).json({ error: 'الرمز والكمية والسعر مطلوبين' });
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: {
      command: { id: Date.now().toString(36), type: 'sell', symbol, qty, price, confirm, at: new Date() },
      orderState: 'sending', orderMsg: (confirm ? 'جاري إرسال أمر البيع للبوت...' : 'جاري تجهيز المعاينة...'), orderAt: new Date()
    } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// سجل الأوامر + تحليلات الفترة (من/إلى) — من sahmorders اللي البوت بيحفظها
app.get('/api/bot/orders', auth, adminOnly, async (req, res) => {
  try {
    const q = { market: req.query.market === 'SA' ? 'SA' : 'US' };
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00+03:00') : null;
    const to = req.query.to ? new Date(req.query.to + 'T23:59:59+03:00') : null;
    if (from || to) { q.time = {}; if (from) q.time.$gte = from; if (to) q.time.$lte = to; }
    const list = await mongoose.connection.collection('sahmorders').find(q).sort({ time: -1 }).limit(2000).toArray();
    const done = list.filter((o) => o.filled > 0);
    const sells = done.filter((o) => o.side === 'SELL' && typeof o.pl === 'number');
    const sum = (a, f) => a.reduce((t, o) => t + (Number(f(o)) || 0), 0);
    const pl = sum(sells, (o) => o.pl), basis = sum(sells, (o) => o.basis);
    const wins = sells.filter((o) => o.pl > 0), losses = sells.filter((o) => o.pl <= 0);
    const bySym = {};
    for (const o of done) {
      const b = bySym[o.symbol] || (bySym[o.symbol] = { symbol: o.symbol, buys: 0, sells: 0, boughtValue: 0, soldValue: 0, pl: 0, fees: 0 });
      if (o.side === 'BUY') { b.buys++; b.boughtValue += o.filled * o.avg; } else if (o.side === 'SELL') { b.sells++; b.soldValue += o.filled * o.avg; b.pl += o.pl || 0; }
      b.fees += o.fee || 0;
    }
    const best = sells.slice().sort((a, b) => b.pl - a.pl)[0] || null, worst = sells.slice().sort((a, b) => a.pl - b.pl)[0] || null;
    res.json({
      orders: list,
      summary: {
        orders: list.length, executed: done.length, buys: done.filter((o) => o.side === 'BUY').length, sells: done.filter((o) => o.side === 'SELL').length,
        boughtValue: sum(done.filter((o) => o.side === 'BUY'), (o) => o.filled * o.avg), soldValue: sum(done.filter((o) => o.side === 'SELL'), (o) => o.filled * o.avg),
        fees: sum(done, (o) => o.fee), realizedPL: pl, realizedPct: basis ? (pl / basis) * 100 : null,
        wins: wins.length, losses: losses.length, winRate: sells.length ? (wins.length / sells.length) * 100 : null,
        avgWin: wins.length ? sum(wins, (o) => o.pl) / wins.length : null, avgLoss: losses.length ? sum(losses, (o) => o.pl) / losses.length : null,
        best: best && { symbol: best.symbol, pl: best.pl, pct: best.plPct }, worst: worst && { symbol: worst.symbol, pl: worst.pl, pct: worst.plPct },
        unknownCost: done.filter((o) => o.side === 'SELL' && typeof o.pl !== 'number').length
      },
      bySymbol: Object.values(bySym).sort((a, b) => b.pl - a.pl)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bot/history', auth, adminOnly, async (req, res) => {
  try {
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: { command: { id: Date.now().toString(36), type: 'history', at: new Date() } } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// آخر طلبات وصلت على الـ Webhook (للتشخيص)
app.get('/api/bot/webhooklog', auth, adminOnly, async (req, res) => {
  try { res.json(await mongoose.connection.collection('webhooklogs').find({}).sort({ at: -1 }).limit(20).toArray()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// محفظتي: بيانات محافظ سهم (SA / US) اللي البوت بيقراها
app.get('/api/bot/portfolio', auth, adminOnly, async (req, res) => {
  try {
    const x = await mongoose.connection.collection('sahmportfolio').findOne({ key: 'sahm' });
    res.json(x || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// صفقات البوت المفتوحة (للشارت)
app.get('/api/bot/positions', auth, adminOnly, async (req, res) => {
  try {
    const open = await mongoose.connection.collection('botpositions')
      .find({ status: { $in: ['open', 'closing'] } }).sort({ openedAt: -1 }).limit(20).toArray();
    res.json(open);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// شموع السهم (دقيقة، مع البري ماركت والافتر) — من Yahoo
app.get('/api/bot/candles', auth, adminOnly, (req, res) => {
  const sym = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
  const iv = ['1m', '2m', '5m', '15m'].includes(req.query.interval) ? req.query.interval : '1m';
  if (!sym) return res.status(400).json({ error: 'symbol' });
  const r2 = https.get({ hostname: 'query1.finance.yahoo.com',
    path: `/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${iv === '1m' ? '1d' : '5d'}&includePrePost=true`,
    headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
      try {
        const x = JSON.parse(d).chart.result[0];
        const q = x.indicators.quote[0];
        const out = [];
        x.timestamp.forEach((t, i) => {
          if (q.open[i] == null || q.close[i] == null) return;
          out.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
        });
        res.json({ symbol: sym, candles: out, last: x.meta.regularMarketPrice });
      } catch (e) { res.status(502).json({ error: 'yahoo' }); }
    });
  });
  r2.on('error', () => res.status(502).json({ error: 'yahoo' }));
  r2.on('timeout', () => r2.destroy());
});

// لقطة شاشة صفحة سهم من البوت
app.get('/api/bot/shot', auth, adminOnly, async (req, res) => {
  try {
    const x = await mongoose.connection.collection('botshots').findOne({ key: 'sahm' });
    if (!x) return res.json({ none: true });
    res.json({ img: x.img, url: x.url, note: x.note, market: x.market, at: x.at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bot/shot', auth, adminOnly, async (req, res) => {
  try {
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: {
      command: { id: Date.now().toString(36), type: 'shot', at: new Date() } } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// تحديث المحفظة فوراً (البوت يعمل ريفرش لصفحة سهم)
app.post('/api/bot/refreshpf', auth, adminOnly, async (req, res) => {
  try {
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: {
      command: { id: Date.now().toString(36), type: 'refreshpf', at: new Date() } } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// تحديث البوت على السيرفر من GitHub
app.post('/api/bot/update', auth, adminOnly, async (req, res) => {
  try {
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: {
      command: { id: Date.now().toString(36), type: 'update', at: new Date() },
      loginState: 'sending', loginMsg: 'جاري إرسال أمر التحديث للبوت...'
    } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// قطع الاتصال بسهم: البوت بيسجل خروج ويمسح الجلسة المحفوظة ويوقف التنفيذ
app.post('/api/bot/sahm-logout', auth, adminOnly, async (req, res) => {
  try {
    const s = await BotSettings.findOneAndUpdate({ key: 'sahm' }, { $set: {
      paused: true,
      command: { id: Date.now().toString(36), type: 'logout', at: new Date() },
      loginState: 'sending', loginMsg: 'جاري قطع الاتصال بسهم...'
    } }, { upsert: true, new: true });
    res.json(maskSettings(s));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bot/trades', auth, adminOnly, async (req, res) => {
  try {
    const list = await Signal.find({ 'tradeResult.broker': 'sahm' })
      .sort({ 'tradeResult.at': -1 }).limit(50)
      .select('symbol price tp sl status strategy receivedAt tradeResult closePrice currentPrice').lean();
    // نربط كل شراء بصفقته في البوت (التنفيذ الفعلي + البيع + الربح)
    const ids = list.map((s) => s._id);
    const pos = await mongoose.connection.collection('botpositions').find({ signalId: { $in: ids } }).toArray();
    const byId = {}; pos.forEach((p) => { byId[String(p.signalId)] = p; });
    list.forEach((s) => { const p = byId[String(s._id)]; if (p) s.position = { status: p.status, qty: p.qty, entry: p.entry, filledAt: p.filledAt, exitPrice: p.exitPrice, closedAt: p.closedAt, pnl: p.pnl, pct: p.pct, reason: p.reason, tp: p.tp, sl: p.sl, lastPrice: p.lastPrice }; });
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
