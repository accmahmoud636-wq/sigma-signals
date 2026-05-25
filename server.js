const express  = require('express');
const http     = require('http');
const path     = require('path');
const crypto   = require('crypto');
const mongoose = require('mongoose');
const https    = require('https');

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB ───────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://millionaire:Mm1234512345@cluster0.w50zpog.mongodb.net/millionaire?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB متصل'))
  .catch(e => console.error('❌ MongoDB:', e.message));

// ─── Schemas ───────────────────────────────────
const SignalSchema = new mongoose.Schema({
  symbol:       { type: String, required: true },
  action:       { type: String, required: true },
  price:        { type: Number, required: true },
  sl:           Number,
  tp:           Number,
  currentPrice: Number,
  strategy:     { type: String, default: 'TradingView' },
  status:       { type: String, default: 'open', enum: ['open','target','stopped'] },
  closePrice:   Number,
  closedAt:     Date,
  receivedAt:   { type: Date, default: Date.now }
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

// ─── Yahoo Finance ─────────────────────────────
// يدعم الأسهم الأمريكية: AAPL, TSLA, NVDA ...
// ويدعم الكريبتو: BTC-USD, ETH-USD ...
async function getStockPrice(symbol) {
  // حوّل الرمز: BTCUSDT → BTC-USD | AAPL → AAPL
  let yahooSym = symbol;
  if (/USDT$/i.test(symbol)) {
    yahooSym = symbol.replace(/USDT$/i, '') + '-USD';
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json  = JSON.parse(data);
          const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
          resolve(price ? parseFloat(price) : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ─── Auto Update كل 60 ثانية ──────────────────
async function updateCurrentPrices() {
  try {
    const openSignals = await Signal.find({ status: 'open' });
    if (!openSignals.length) return;

    for (const signal of openSignals) {
      const price = await getStockPrice(signal.symbol);
      if (!price) { console.log(`⚠️ لا سعر لـ ${signal.symbol}`); continue; }

      const update = { currentPrice: price };

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
    console.log(`🔄 تحديث ${openSignals.length} إشارة`);
  } catch(e) { console.error('❌ updateCurrentPrices:', e.message); }
}

mongoose.connection.once('open', () => {
  initAdmin();
  updateCurrentPrices();
  setInterval(updateCurrentPrices, 60000);
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

// ─── Prices API (للفرونت-إند) ─────────────────
// الفرونت يكلم سيرفرنا بدل ما يكلم Yahoo مباشرة
app.get('/api/prices', auth, async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.json({});
  const syms = symbols.split(',').filter(Boolean);
  const result = {};
  for (const sym of syms) {
    const price = await getStockPrice(sym);
    if (price) result[sym.toUpperCase()] = price;
  }
  res.json(result);
});

// ─── TradingView Webhook ───────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    if (!data.action || !data.symbol) return res.status(400).json({ error: 'بيانات ناقصة' });

    if (['STOPPED','CLOSED'].includes(data.action.toUpperCase())) {
      await Signal.findOneAndUpdate(
        { symbol: data.symbol.toUpperCase(), status: 'open' },
        { status: 'stopped', closedAt: new Date(), closePrice: data.price }
      );
      return res.json({ ok: true });
    }

    const entry = parseFloat(data.price);
    const sl    = parseFloat(data.sl) || parseFloat((entry * 0.98).toFixed(4));
    const tp    = parseFloat(data.tp) || parseFloat((entry * 1.05).toFixed(4));

    const signal = await Signal.create({
      symbol: data.symbol.toUpperCase(), action: data.action.toUpperCase(),
      price: entry, sl, tp,
      strategy: data.strategy || 'TradingView',
      status: 'open', receivedAt: new Date()
    });

    console.log(`📡 ${signal.action} ${signal.symbol} @ $${entry} | SL:$${sl} | TP:$${tp}`);
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

// ─── Pages ─────────────────────────────────────
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/reports',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'reports.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ MILLIONAIRE شغال على بورت ${PORT}`));
