const express = require('express');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATA FILES ───────────────────────────────
const SIGNALS_FILE = path.join(__dirname, 'signals.json');
const USERS_FILE   = path.join(__dirname, 'users.json');

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e) { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── INIT DATA ────────────────────────────────
if (!fs.existsSync(SIGNALS_FILE)) writeJSON(SIGNALS_FILE, []);
if (!fs.existsSync(USERS_FILE)) writeJSON(USERS_FILE, [
  {
    id: '1',
    username: 'admin',
    password: 'admin123',
    role: 'admin',
    name: 'Admin',
    email: 'admin@millionaire.com',
    active: true,
    expiresAt: null,
    createdAt: new Date().toISOString()
  }
]);

// ─── AUTH MIDDLEWARE ──────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  const users = readJSON(USERS_FILE, []);
  const user  = users.find(u => u.token === token && u.active);
  if (!user) return res.status(401).json({ error: 'جلسة منتهية' });
  if (user.expiresAt && new Date(user.expiresAt) < new Date())
    return res.status(403).json({ error: 'انتهى الاشتراك' });
  req.user = user;
  next();
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ليس لديك صلاحية' });
  next();
}

// ─── AUTH ROUTES ──────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(USERS_FILE, []);
  const user  = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور خاطئة' });
  if (!user.active) return res.status(403).json({ error: 'الحساب موقوف' });
  if (user.expiresAt && new Date(user.expiresAt) < new Date())
    return res.status(403).json({ error: 'انتهى اشتراكك — تواصل مع الإدارة' });
  user.token = crypto.randomBytes(32).toString('hex');
  user.lastLogin = new Date().toISOString();
  writeJSON(USERS_FILE, users);
  res.json({ token: user.token, name: user.name, role: user.role, expiresAt: user.expiresAt });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const users = readJSON(USERS_FILE, []);
  const user  = users.find(u => u.id === req.user.id);
  if (user) { user.token = null; writeJSON(USERS_FILE, users); }
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ name: req.user.name, role: req.user.role, expiresAt: req.user.expiresAt });
});

// ─── SIGNALS ROUTES ───────────────────────────
app.get('/api/signals', authMiddleware, (req, res) => {
  const signals = readJSON(SIGNALS_FILE, []);
  res.json(signals);
});

// TradingView Webhook
app.post('/webhook', (req, res) => {
  const data = req.body;
  if (!data.action || !data.symbol) return res.status(400).json({ error: 'بيانات ناقصة' });
  const signals = readJSON(SIGNALS_FILE, []);

  // لو إشارة STOPPED أو CLOSED — حدّث الصفقة الموجودة
  if (data.action === 'STOPPED' || data.action === 'CLOSED') {
    const sig = signals.find(s => s.symbol === data.symbol.toUpperCase() && s.status === 'open');
    if (sig) {
      sig.status    = data.action === 'STOPPED' ? 'stopped' : 'closed';
      sig.closedAt  = new Date().toISOString();
      sig.closePrice = data.price;
    }
    writeJSON(SIGNALS_FILE, signals);
    return res.json({ ok: true });
  }

  // إشارة جديدة
  const entry  = parseFloat(data.price);
  const sl     = parseFloat(data.sl) || entry * 0.99;
  let   tp     = parseFloat(data.tp);
  const slDist = Math.abs(entry - sl);
  if (!tp || tp === sl || tp === entry) {
    tp = data.action === 'BUY' ? entry + slDist * 2 : entry - slDist * 2;
  }

  const signal = {
    id:         Date.now().toString(),
    symbol:     data.symbol.toUpperCase(),
    action:     data.action.toUpperCase(),
    price:      entry,
    sl:         sl,
    tp:         tp,
    strategy:   data.strategy || 'TradingView',
    status:     'open',
    receivedAt: new Date().toISOString(),
    closedAt:   null,
    closePrice: null
  };

  signals.unshift(signal);
  if (signals.length > 200) signals.pop();
  writeJSON(SIGNALS_FILE, signals);
  console.log(`📡 ${signal.action} ${signal.symbol} @ ${signal.price}`);
  res.json({ ok: true, signal });
});

// ─── ADMIN ROUTES ─────────────────────────────
// جلب كل المشتركين
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = readJSON(USERS_FILE, []);
  res.json(users.map(u => ({ ...u, password: '***', token: undefined })));
});

// إضافة مشترك
app.post('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const { username, password, name, email, days } = req.body;
  const users = readJSON(USERS_FILE, []);
  if (users.find(u => u.username === username))
    return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
  const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  const newUser = {
    id:        Date.now().toString(),
    username, password, name,
    email:     email || '',
    role:      'user',
    active:    true,
    expiresAt,
    createdAt: new Date().toISOString(),
    token:     null
  };
  users.push(newUser);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true, user: { ...newUser, password: '***' } });
});

// تعديل مشترك
app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const users = readJSON(USERS_FILE, []);
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'مستخدم غير موجود' });
  const { active, days, password, name } = req.body;
  if (active !== undefined) users[idx].active = active;
  if (days) users[idx].expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  if (password) users[idx].password = password;
  if (name) users[idx].name = name;
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

// حذف مشترك
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  let users = readJSON(USERS_FILE, []);
  users = users.filter(u => u.id !== req.params.id);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

// مسح الإشارات
app.delete('/api/admin/signals', authMiddleware, adminMiddleware, (req, res) => {
  writeJSON(SIGNALS_FILE, []);
  res.json({ ok: true });
});

// ─── PAGES ────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ MILLIONAIRE Server شغال على بورت ${PORT}`));
