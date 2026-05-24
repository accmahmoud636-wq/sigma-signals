const express  = require('express');
const http     = require('http');
const path     = require('path');
const crypto   = require('crypto');
const mongoose = require('mongoose');


const https = require('https');

// ─── Binance Testnet Config ───────────────────
const BINANCE_KEY    = process.env.BINANCE_API_KEY    || 'viqClNFfTWvMWwUjUHJZaho0g2JSSfaffcF8F1Ww08e5AfYrRrljTzaBMwuW5qJn';
const BINANCE_SECRET = process.env.BINANCE_API_SECRET || 'SH5NWccgetoxGMFXmGTWm7x4EI8X43firno9NF5O4p1tzZgKshciEyHcI0wKRJxQ';
const BINANCE_BASE   = 'https://testnet.binance.vision';
const TRADE_AMOUNT   = process.env.TRADE_AMOUNT || '10'; // USDT per trade

function binanceRequest(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const query = Object.entries(params).map(([k,v]) => k+'='+v).join('&');
    const signature = crypto.createHmac('sha256', BINANCE_SECRET).update(query).digest('hex');
    const fullQuery = query + '&signature=' + signature;
    const options = {
      hostname: 'testnet.binance.vision',
      path: path + '?' + fullQuery,
      method,
      headers: { 'X-MBX-APIKEY': BINANCE_KEY, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getBinancePrice(symbol) {
  return new Promise((resolve) => {
    https.get(`${BINANCE_BASE}/api/v3/ticker/price?symbol=${symbol}`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(parseFloat(JSON.parse(data).price)); }
        catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function placeBinanceOrder(symbol, side, quantity) {
  try {
    const result = await binanceRequest('POST', '/api/v3/order', {
      symbol: symbol.toUpperCase(),
      side,
      type: 'MARKET',
      quantity
    });
    console.log(`✅ Binance Order: ${side} ${quantity} ${symbol} →`, result.orderId || result);
    return result;
  } catch(e) {
    console.error('❌ Binance Order Error:', e.message);
    return null;
  }
}

// تتبع المراكز المفتوحة
const openPositions = {};

async function executeTradeFromSignal(signal) {
  try {
    const sym    = signal.symbol.toUpperCase();
    const action = signal.action.toUpperCase();

    // ── شراء ──────────────────────────────────
    if (action === 'BUY') {
      // لو في مركز مفتوح بالفعل على نفس السهم — تجاهل
      if (openPositions[sym]) {
        console.log(`⚠️ مركز مفتوح بالفعل على ${sym} — تم التجاهل`);
        return;
      }
      const price = await getBinancePrice(sym);
      if (!price) { console.log('❌ مش قادر أجيب سعر:', sym); return; }
      const qty = (parseFloat(TRADE_AMOUNT) / price).toFixed(5);
      const order = await placeBinanceOrder(sym, 'BUY', qty);
      if (order && order.orderId) {
        openPositions[sym] = { qty, entryPrice: price, orderId: order.orderId };
        console.log(`✅ فتح مركز شراء: ${qty} ${sym} @ $${price}`);
      }
    }

    // ── بيع / إغلاق / وقف الخسارة / الهدف ────
    else if (['SELL','STOPPED','TARGET','CLOSE'].includes(action)) {
      const pos = openPositions[sym];
      if (!pos) {
        console.log(`⚠️ مفيش مركز مفتوح على ${sym}`);
        return;
      }
      const order = await placeBinanceOrder(sym, 'SELL', pos.qty);
      if (order && order.orderId) {
        const currentPrice = await getBinancePrice(sym);
        const profit = currentPrice ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2) : '?';
        const profitSign = parseFloat(profit) >= 0 ? '+' : '';
        console.log(`✅ إغلاق مركز ${sym} @ $${currentPrice} | ربح/خسارة: ${profitSign}${profit}%`);
        delete openPositions[sym];
      }
    }
  } catch(e) {
    console.error('Trade Error:', e.message);
  }
}

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB Connection ───────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://millionaire:Mm1234512345@cluster0.w50zpog.mongodb.net/millionaire?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB متصل'))
  .catch(e => console.error('❌ MongoDB خطأ:', e.message));

// ─── Schemas ──────────────────────────────────
const SignalSchema = new mongoose.Schema({
  symbol:     { type: String, required: true },
  action:     { type: String, required: true },
  price:      { type: Number, required: true },
  sl:         Number,
  tp:         Number,
  strategy:   { type: String, default: 'TradingView' },
  status:     { type: String, default: 'open', enum: ['open','target','stopped'] },
  closePrice: Number,
  closedAt:   Date,
  receivedAt: { type: Date, default: Date.now }
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

// إنشاء Admin لو مش موجود
async function initAdmin() {
  try {
    const exists = await User.findOne({ username: 'admin' });
    if (!exists) {
      await User.create({
        username: 'admin', password: 'admin123',
        name: 'Admin', email: 'admin@millionaire.com',
        role: 'admin', active: true, expiresAt: null
      });
      console.log('✅ Admin account created');
    }
  } catch(e) {}
}
mongoose.connection.once('open', initAdmin);

// ─── Auth Middleware ──────────────────────────
async function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  const user = await User.findOne({ token, active: true });
  if (!user) return res.status(401).json({ error: 'جلسة منتهية' });
  if (user.expiresAt && new Date(user.expiresAt) < new Date())
    return res.status(403).json({ error: 'انتهى الاشتراك — تواصل مع الإدارة' });
  req.user = user;
  next();
}

async function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ليس لديك صلاحية' });
  next();
}

// ─── Auth Routes ─────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });
    if (!user.active) return res.status(403).json({ error: 'الحساب موقوف — تواصل مع الإدارة' });
    if (user.expiresAt && new Date(user.expiresAt) < new Date())
      return res.status(403).json({ error: 'انتهى اشتراكك — تواصل مع الإدارة' });
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

// تغيير الباسورد
app.put('/api/me/password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (req.user.password !== oldPassword) return res.status(400).json({ error: 'كلمة المرور القديمة خاطئة' });
  req.user.password = newPassword;
  await req.user.save();
  res.json({ ok: true });
});

// ─── Signals Routes ───────────────────────────
app.get('/api/signals', auth, async (req, res) => {
  // المشتركين يشوفون الإشارات من تاريخ اشتراكهم فقط
  const query = { receivedAt: { $gte: req.user.createdAt || new Date(0) } };
  // الأدمن يشوف كل الإشارات
  if (req.user.role === 'admin') delete query.receivedAt;
  const signals = await Signal.find(query).sort({ receivedAt: -1 }).limit(500);
  res.json(signals);
});

app.put('/api/signals/:id', auth, async (req, res) => {
  try {
    const { status, closePrice } = req.body;
    const sig = await Signal.findByIdAndUpdate(
      req.params.id,
      { status, closePrice, closedAt: new Date() },
      { new: true }
    );
    res.json({ ok: true, signal: sig });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TradingView Webhook
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    if (!data.action || !data.symbol) return res.status(400).json({ error: 'بيانات ناقصة' });

    if (data.action === 'STOPPED' || data.action === 'CLOSED') {
      await Signal.findOneAndUpdate(
        { symbol: data.symbol.toUpperCase(), status: 'open' },
        { status: data.action === 'STOPPED' ? 'stopped' : 'closed', closedAt: new Date(), closePrice: data.price }
      );
      return res.json({ ok: true });
    }

    const entry  = parseFloat(data.price);
    const sl     = parseFloat(data.sl) || entry * 0.99;
    let   tp     = parseFloat(data.tp);
    const slDist = Math.abs(entry - sl);
    if (!tp || Math.abs(tp - entry) < 0.00001) tp = data.action.toUpperCase() === 'BUY' ? entry + slDist * 2 : entry - slDist * 2;

    const signal = await Signal.create({
      symbol: data.symbol.toUpperCase(), action: data.action.toUpperCase(),
      price: entry, sl, tp, strategy: data.strategy || 'TradingView',
      status: 'open', receivedAt: new Date()
    });

    console.log(`📡 ${signal.action} ${signal.symbol} @ ${signal.price}`);
    // تنفيذ الصفقة تلقائياً على Binance Testnet
    if (process.env.BINANCE_TRADING === 'true') {
      executeTradeFromSignal(signal).catch(console.error);
    }
    res.json({ ok: true, signal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin Routes ─────────────────────────────
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const users = await User.find().select('-token');
  res.json(users);
});

app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, name, email, days } = req.body;
    const expiresAt = days ? new Date(Date.now() + days * 86400000) : null;
    const user = await User.create({ username, password, name, email, role: 'user', active: true, expiresAt });
    res.json({ ok: true, user });
  } catch(e) {
    if (e.code === 11000) return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const { active, days, password, name } = req.body;
    const update = {};
    if (active !== undefined) update.active = active;
    if (days) update.expiresAt = new Date(Date.now() + days * 86400000);
    if (password) update.password = password;
    if (name) update.name = name;
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

// إضافة إشارة يدوية من الـ Admin
app.post('/api/admin/signals', auth, adminOnly, async (req, res) => {
  try {
    const { symbol, action, price, sl, tp, strategy } = req.body;
    const entry  = parseFloat(price);
    const slVal  = parseFloat(sl) || entry * 0.99;
    let   tpVal  = parseFloat(tp);
    const slDist = Math.abs(entry - slVal);
    if (!tpVal) tpVal = action === 'BUY' ? entry + slDist * 2 : entry - slDist * 2;
    const signal = await Signal.create({
      symbol: symbol.toUpperCase(), action: action.toUpperCase(),
      price: entry, sl: slVal, tp: tpVal,
      strategy: strategy || 'Manual', status: 'open', receivedAt: new Date()
    });
    res.json({ ok: true, signal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Stats ────────────────────────────────────
app.get('/api/stats', auth, async (req, res) => {
  const total   = await Signal.countDocuments();
  const open    = await Signal.countDocuments({ status: 'open' });
  const target  = await Signal.countDocuments({ status: 'target' });
  const stopped = await Signal.countDocuments({ status: 'stopped' });
  const winRate = total > 0 ? ((target / (target + stopped)) * 100).toFixed(1) : 0;
  res.json({ total, open, target, stopped, winRate });
});

// ─── Pages ────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/reports', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reports.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ MILLIONAIRE Server شغال على بورت ${PORT}`));
