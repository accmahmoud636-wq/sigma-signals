// =====================================================================
//  Sahm Bot — تنفيذ إشارات منصة MILLIONAIRE على سهم (السوق الأمريكي)
//  - بيسمع قاعدة البيانات لحظياً: أول ما إشارة BUY توصل المنصة → ينفذ
//  - أمر محدد (Limit) + أمر مرفق: جني الربح / وقف الخسارة
//  - DRY_RUN=true: يملا الأمر ويصوره من غير ما يضغط "إرسال الأمر"
//  - لإيقاف التنفيذ فوراً: اعمل ملف اسمه PAUSE في نفس الفولدر
// =====================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const mongoose = require('mongoose');
const { chromium } = require('playwright');

// الإعدادات بتتقرا من منصة MILLIONAIRE (صفحة 🤖 بوت سهم) قبل كل إشارة
const DEFAULTS = { paused: false, dryRun: true, amount: 100, offsetPct: 0.5, tpPct: 5, slPct: 3,
                   minPrice: 3, maxPrice: 5, maxPerDay: 5, session: '', broker: 'sahm',
                   sizeMode: 'fixed', sizePct: 10, dailyProfitTarget: 0, dailyLossLimit: 0, autoBracket: true };
let C = { ...DEFAULTS };
let Settings; // collection botsettings
async function refreshSettings() {
  const s = await Settings.findOne({ key: 'sahm' });
  C = { ...DEFAULTS, ...(s || {}) };
  C.dry = C.dryRun !== false;
  return C;
}
const URL_PORTFOLIO = 'https://app.sahmcapital.com/portfolios';

// ===== نسخة واحدة بس من البوت =====
const LOCK = path.join(__dirname, 'bot.lock');
try {
  const old = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
  if (old && old !== process.pid) { process.kill(old, 0); console.log('⚠️ البوت شغال بالفعل في نافذة تانية — اقفل النافذة دي'); process.exit(0); }
} catch (_) { /* مفيش نسخة شغالة */ }
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch (_) {} });
process.on('SIGINT', () => process.exit(0));
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- تليجرام ----------
let Logs; // collection botlogs (سجل التطبيق في المنصة)
function log(msg, level = 'info') {
  console.log(level === 'error' ? '✖' : '•', msg);
  if (Logs) Logs.insertOne({ level, msg: String(msg).replace(/<[^>]+>/g, ''), at: new Date() }).catch(() => {});
}
function tg(text, level) {
  log(text, level);
  const token = C.tgToken || process.env.TG_TOKEN, chat = C.tgChatId || process.env.TG_CHAT_ID;
  if (!token || !chat) return;
  const p = `/bot${token}/sendMessage?chat_id=${chat}&parse_mode=HTML&text=${encodeURIComponent(text)}`;
  https.get({ hostname: 'api.telegram.org', path: p }).on('error', () => {});
}

// ---------- حالة اليوم (عدد الصفقات والأسهم) ----------
const STATE_FILE = path.join(__dirname, 'state.json');
function loadState() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.day === today) return s;
  } catch (_) {}
  return { day: today, trades: 0, symbols: [] };
}
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// ---------- أدوات ----------
const round = (p) => (p >= 1 ? Math.round(p * 100) / 100 : Math.round(p * 10000) / 10000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- المتصفح ----------
let ctx, page;
async function openBrowser() {
  // ملف شخصي دائم: بتسجل الدخول مرة واحدة وبيفضل محفوظ
  // على السيرفر (Linux) بيشتغل من غير شاشة — على ويندوز بتظهر نافذة
  const headless = process.env.HEADLESS ? process.env.HEADLESS === 'true' : process.platform === 'linux';
  ctx = await chromium.launchPersistentContext(path.join(__dirname, 'sahm-profile'), {
    headless,
    viewport: { width: 1400, height: 900 },
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    // بعض المواقع بترفض المتصفح لما يبان إنه "Headless"
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' });
}

// فحص بدون تنقل: هل فيه زرار "تسجيل الخروج" (يعني مسجل دخول)
async function isLoggedIn() {
  try { return (await page.getByText('تسجيل الخروج').count()) > 0; } catch (_) { return false; }
}

// لو نافذة المتصفح اتقفلت: نفتحها تاني (الجلسة محفوظة في الملف الشخصي)
async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  log('🔄 نافذة المتصفح كانت مقفولة — بفتحها تاني', 'warn');
  try { if (ctx) await ctx.close(); } catch (_) {}
  await openBrowser();
}

async function ensureLoggedIn() {
  await ensureBrowser();
  if (!page.url().startsWith(URL_PORTFOLIO)) await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' });
  // زرار التداول بيظهر حتى من غير تسجيل دخول، فبنعتمد على وجود "تسجيل الخروج"
  for (let i = 0; i < 4; i++) {
    if (await isLoggedIn()) return true;
    await sleep(2000);
  }
  return false;
}

// قفل الجولات التعريفية والنوافذ المنبثقة في سهم
async function dismissPopups() {
  for (let i = 0; i < 5; i++) {
    const skip = page.getByRole('button', { name: /^\s*(تخطي|حسناً|فهمت|تم)\s*$/ }).locator('visible=true').first();
    if (!(await skip.count())) break;
    await skip.click().catch(() => {});
    await sleep(400);
  }
  await page.keyboard.press('Escape').catch(() => {});
}

// اختيار من قائمة Naive UI (n-select) بالترتيب داخل نموذج الأمر
async function pickSelect(index, optionText) {
  const sel = page.locator('.n-select').nth(index);
  await sel.click();
  const opt = page.locator('.n-base-select-option', { hasText: optionText }).first();
  await opt.waitFor({ state: 'visible', timeout: 5000 });
  await opt.click();
  await sleep(300);
}

async function listSelectOptions(index) {
  await page.locator('.n-select').nth(index).click();
  await sleep(500);
  const opts = await page.locator('.n-base-select-option').allInnerTexts();
  await page.keyboard.press('Escape');
  return opts.map((s) => s.trim()).filter(Boolean);
}

// ---------- تنفيذ أمر شراء ----------
async function placeBuy(sig) {
  const symbol = sig.symbol.toUpperCase();
  const limit = round(sig.price * (1 + C.offsetPct / 100));
  let amount = C.amount;
  if (C.sizeMode === 'percent') {
    const net = C.account && C.account.currency === 'USD' ? C.account.netAssets : null;
    if (net) amount = net * C.sizePct / 100;
    else log(`نسبة من المحفظة: قيمة الحساب بالدولار مش معروفة — استخدام المبلغ الثابت ${C.amount}$`, 'warn');
  }
  const qty = Math.floor(amount / limit);
  const tp = round(sig.tp || sig.price * (1 + C.tpPct / 100));
  const sl = round(sig.sl || sig.price * (1 - C.slPct / 100));
  if (qty < 1) throw new Error(`المبلغ ${amount.toFixed(2)}$ أقل من سعر سهم واحد`);

  if (!(await ensureLoggedIn())) throw new Error('مش مسجل دخول في سهم — ادخل يدوي في نافذة البوت');

  // 0) قفل أي جولة تعريفية أو نافذة منبثقة
  await dismissPopups();

  // 1) فتح نموذج التداول (لو مش مفتوح)
  const search = page.getByPlaceholder('رمز أو اسم الشركة').locator('visible=true').first();
  if (!(await search.isVisible().catch(() => false))) {
    await page.locator('button.trade-button').locator('visible=true').first().click();
    await search.waitFor({ state: 'visible', timeout: 10000 });
  }

  // 2) الرمز من تبويب الأمريكي
  await search.click();
  await sleep(500);
  // تبويب "الأمريكي" في نتائج البحث (الظاهر بس)
  const usTab = page.getByText('الأمريكي', { exact: true }).locator('visible=true').first();
  if (await usTab.count()) { await usTab.click(); await sleep(300); }
  await search.fill(symbol);
  await sleep(1500);
  // النتيجة: عنصر ظاهر مكتوب فيه الرمز بالظبط
  const result = page.getByText(symbol, { exact: true }).locator('visible=true').first();
  await result.waitFor({ state: 'visible', timeout: 10000 });
  await result.click();
  await sleep(1500);

  // 3) شراء
  await page.locator('.buy').locator('visible=true').first().click();

  // 4) النوع: محدد (القوائم بالترتيب: 0 المحفظة، 1 النوع، 2 الجلسة، 3 الأمر المرفق)
  const selTexts = await page.locator('.n-select').allInnerTexts();
  if (!/المحدد/.test(selTexts[1] || '')) await pickSelect(1, 'المحدد');

  // 5) السعر والكمية
  await page.getByPlaceholder('أدخل السعر').locator('visible=true').first().fill(String(limit));
  await page.getByPlaceholder('أدخل الكمية').locator('visible=true').first().fill(String(qty));

  // 6) الجلسة: نسجل الاختيارات المتاحة (لضبطها بعد أول تجربة)
  const sessionOpts = await listSelectOptions(2).catch(() => []);
  if (C.session) await pickSelect(2, C.session);

  // 7) الأمر المرفق: جني الربح / وقف الخسارة
  const before = await page.locator('input').count();
  if (C.autoBracket) await pickSelect(3, 'جني الربح/ وقف الخسارة');
  await sleep(600);
  const inputs = page.locator('input');
  const after = await inputs.count();
  const newPh = [];
  for (let i = before; i < after; i++) newPh.push(await inputs.nth(i).getAttribute('placeholder'));
  // أول خانة جديدة = سعر جني الربح، التانية = سعر وقف الخسارة (نتأكد منها في وضع DRY_RUN)
  if (C.autoBracket && after - before >= 2) {
    await inputs.nth(before).fill(String(tp));
    await inputs.nth(before + 1).fill(String(sl));
  }

  const shot = path.join(SHOTS, `${Date.now()}-${symbol}.png`);
  await page.screenshot({ path: shot });
  const info = { symbol, limit, qty, tp, sl, sessionOpts, newFields: newPh, shot };

  if (C.dry) {
    await page.getByText('إرسال الأمر').first().waitFor();
    // نقفل النموذج من غير إرسال
    await page.keyboard.press('Escape');
    return { status: 'dry-run', ...info };
  }

  // 8) إرسال + تأكيد
  await page.getByText('إرسال الأمر', { exact: true }).first().click();
  await sleep(1000);
  if (await page.locator('input[type=password]').count()) {
    throw new Error('سهم طالبة كلمة مرور التداول (قفل التداول) — افتح القفل يدوي في نافذة البوت');
  }
  const confirm = page.getByRole('button', { name: /تأكيد|موافق|إرسال/ }).last();
  if (await confirm.count()) await confirm.click();
  await sleep(1500);
  const after2 = path.join(SHOTS, `${Date.now()}-${symbol}-sent.png`);
  await page.screenshot({ path: after2 });
  return { status: 'sent', ...info, shot: after2 };
}

// ===== تسجيل الدخول من المنصة (رقم الجوال + رمز التحقق) =====
const setLogin = (loginState, loginMsg) =>
  Settings.updateOne({ key: 'sahm' }, { $set: { loginState, loginMsg }, $unset: { command: '' } }).catch(() => {});

// نافذة الدخول في سهم بتفتح جوه iframe — فبندوّر في كل الإطارات
async function inFrames(make, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      const l = make(f).first();
      if (await l.isVisible().catch(() => false)) return l;
    }
    await sleep(500);
  }
  return null;
}

async function openLoginModal() {
  await ensureBrowser();
  await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(3000);
  if (await isLoggedIn()) return 'already';
  await dismissPopups();
  const findPhone = (t) => inFrames((f) => f.getByPlaceholder('رقم الهاتف'), t);
  let phoneIn = await findPhone(3000);
  if (!phoneIn) {
    // زرار التداول بيفتح نافذة الدخول لما تكون مش مسجل
    const btn = page.getByText(/التسجيل\s*\/\s*تسجيل الدخول/).locator('visible=true').first();
    const tb = page.locator('button.trade-button').locator('visible=true').first();
    if (await btn.count()) await btn.click();
    else if (await tb.count()) await tb.click();
    else throw new Error('صفحة سهم ما فتحتش زي المتوقع');
    phoneIn = await findPhone(20000);
    if (!phoneIn) throw new Error('خانة رقم الجوال ما ظهرتش');
  }
  return phoneIn;
}

async function startLogin(phone, method) {
  if (!phone) return setLogin('error', 'رقم الجوال مش محفوظ — اكتبه في المنصة');
  const phoneIn = await openLoginModal();
  if (phoneIn === 'already') { loggedIn = true; return setLogin('success', 'مسجل دخول بالفعل'); }
  await phoneIn.fill(phone);
  const m = await inFrames((f) => f.getByText(method === 'whatsapp' ? 'واتساب' : 'الرسائل النصية', { exact: true }), 3000);
  if (m) await m.click();
  const send = await inFrames((f) => f.getByText('إرسال الرمز', { exact: true }), 5000);
  if (!send) throw new Error('زرار "إرسال الرمز" مش ظاهر');
  // نسجّل ردود سيرفر سهم بعد الضغط عشان نعرف لو رفض الطلب
  const resp = [];
  const onResp = async (r) => {
    const t = r.request().resourceType();
    if (t !== 'xhr' && t !== 'fetch') return;
    if (/google|analytics|sentry|clarity|facebook/i.test(r.url())) return;
    let body = ''; try { body = (await r.text()).slice(0, 200); } catch (_) {}
    resp.push(`${r.status()} ${r.url().replace(/^https?:\/\//, '').slice(0, 70)} → ${body}`);
  };
  page.on('response', onResp);
  await send.click();
  await sleep(6000);
  page.off('response', onResp);
  try {
    let raw = '';
    for (const f of page.frames()) {
      if (await f.getByPlaceholder('رقم الهاتف').count().catch(() => 0)) {
        raw = await f.locator('body').innerText().catch(() => ''); log(`🔍 إطار الدخول: ${f.url().slice(0, 80)}`, 'warn'); break;
      }
    }
    log(`🔍 نص النافذة: ${raw.replace(/\s+/g, ' ').slice(0, 400) || '(فاضي)'}`, 'warn');
    log(`🔍 ردود سهم (${resp.length}): ${resp.join(' || ').slice(0, 1200) || 'مفيش طلبات اتبعتت'}`, 'warn');
    await page.screenshot({ path: path.join(SHOTS, `${Date.now()}-after-send.png`) });
  } catch (_) {}
  await setLogin('awaiting_otp', `اتبعت رمز التحقق على ${method === 'whatsapp' ? 'واتساب' : 'رسالة SMS'} — اكتبه في المنصة`);
  tg('📩 سهم بعتت رمز التحقق — اكتبه في صفحة التداول الآلي في المنصة');
}

async function submitOtp(code) {
  const otpIn = await inFrames((f) => f.getByPlaceholder('رمز التحقق'), 5000);
  if (!otpIn) return setLogin('error', 'نافذة الدخول اتقفلت — اضغط "دخول سهم" تاني');
  await otpIn.fill(code);
  const sub = await inFrames((f) => f.getByRole('button', { name: /التسجيل\s*\/\s*تسجيل الدخول|تسجيل الدخول|تأكيد/ }), 5000)
    || await inFrames((f) => f.getByText(/التسجيل\s*\/\s*تسجيل الدخول/).last(), 3000);
  if (!sub) throw new Error('زرار تأكيد الدخول مش ظاهر');
  await sub.click();
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    if (await isLoggedIn()) {
      await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' }).catch(() => {});
      loggedIn = true;
      tg('✅ تم تسجيل الدخول في سهم من المنصة');
      return setLogin('success', 'تم تسجيل الدخول في سهم');
    }
    if (await page.locator('input[type=password]').locator('visible=true').count())
      return setLogin('error', 'سهم طالبة كلمة مرور — كمّلها في نافذة البوت على الجهاز');
  }
  const shot = path.join(SHOTS, `${Date.now()}-login-error.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  setLogin('error', 'الرمز غلط أو انتهى — جرب "دخول سهم" تاني');
}

let lastCmd = null;
async function checkCommands() {
  const s = await Settings.findOne({ key: 'sahm' }, { projection: { command: 1, sahmPhone: 1, sahmMethod: 1 } });
  const cmd = s && s.command;
  if (!cmd || cmd.id === lastCmd) return;
  lastCmd = cmd.id;
  try {
    if (cmd.type === 'login') await startLogin(s.sahmPhone, s.sahmMethod);
    else if (cmd.type === 'otp') await submitOtp(cmd.code);
  } catch (e) {
    log('تسجيل الدخول: ' + e.message, 'error');
    // تشخيص: إيه اللي ظاهر في الصفحة
    try {
      const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
      log(`🔍 الصفحة: ${page.url()} | العنوان: ${await page.title()} | النص: ${txt || '(فاضية)'}`, 'warn');
      await page.screenshot({ path: path.join(SHOTS, `${Date.now()}-login-fail.png`) });
    } catch (_) {}
    setLogin('error', 'فشل: ' + e.message.split('\n')[0].slice(0, 120));
  }
}

// ربح/خسارة اليوم التقديري من صفقات البوت المنفذة (بأسعار المنصة)
async function todayPnl(Signals) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const list = await Signals.find({ 'tradeResult.broker': 'sahm', 'tradeResult.status': 'sent', 'tradeResult.at': { $gte: d } }).toArray();
  return list.reduce((sum, s) => {
    const t = s.tradeResult, exit = s.status === 'open' ? s.currentPrice : s.closePrice;
    return sum + (exit && t.qty ? t.qty * (exit - t.limit) : 0);
  }, 0);
}

// قراءة قيمة الحساب والقوة الشرائية من صفحة المحافظ (لو مفيش أمر شغال)
async function readAccount() {
  if (!page || !page.url().startsWith(URL_PORTFOLIO)) return null;
  const txt = await page.locator('body').innerText().catch(() => '');
  const grab = (label) => {
    const m = txt.match(new RegExp(label + '\\s*\\(([^)]+)\\)\\s*\\n?\\s*([\\d,\\.]+)'));
    return m ? { cur: m[1].trim(), val: parseFloat(m[2].replace(/,/g, '')) } : null;
  };
  const net = grab('صافي الأصول'), bp = grab('القوة الشرائية');
  if (!net && !bp) return null;
  const cur = (net || bp).cur;
  return { netAssets: net ? net.val : null, buyingPower: bp ? bp.val : null,
           currency: /\$|دولار|USD/i.test(cur) ? 'USD' : cur, at: new Date() };
}

// ---------- معالجة إشارة ----------
let busy = Promise.resolve();
let loggedIn = false, working = false;
async function handle(sig, Signals) {
  const tag = `${sig.symbol} @ $${sig.price}`;
  await refreshSettings();
  if (sig.action !== 'BUY') return;
  if (C.paused || fs.existsSync(path.join(__dirname, 'PAUSE'))) return log(`⏸ البوت متوقف — تخطي ${tag}`);
  if (C.broker !== 'sahm') return log(`الوسيط المختار (${C.broker}) مش مدعوم في البوت ده — تخطي ${tag}`, 'warn');
  if (sig.price < C.minPrice || sig.price > C.maxPrice)
    return log(`↷ تخطي ${tag}: السعر خارج ${C.minPrice}-${C.maxPrice}$`);
  const pnl = await todayPnl(Signals);
  if (C.dailyProfitTarget > 0 && pnl >= C.dailyProfitTarget) return tg(`🎯 هدف الربح اليومي اتحقق (${pnl.toFixed(2)}$) — تخطي ${tag}`);
  if (C.dailyLossLimit > 0 && pnl <= -C.dailyLossLimit) return tg(`⛔ حد الخسارة اليومي (${pnl.toFixed(2)}$) — تخطي ${tag}`, 'warn');

  const st = loadState();
  if (st.trades >= C.maxPerDay) return tg(`⛔ حد الصفقات اليومي (${C.maxPerDay}) — تخطي ${tag}`);
  if (st.symbols.includes(sig.symbol)) return log(`↷ تخطي ${tag}: اتشرى النهارده`);

  try {
    const r = await placeBuy(sig);
    if (r.status === 'sent') { st.trades++; st.symbols.push(sig.symbol); saveState(st); }
    await Signals.updateOne({ _id: sig._id }, { $set: { tradeResult: { broker: 'sahm', ...r, at: new Date() } } });
    tg(
      (r.status === 'sent' ? '✅ <b>اتنفذ على سهم</b>' : '🧪 <b>تجربة (من غير إرسال)</b>') +
      `\n${r.symbol} | كمية ${r.qty} | محدد $${r.limit}\n🎯 $${r.tp} | 🛑 $${r.sl}` +
      (r.status === 'dry-run' ? `\nالجلسات: ${r.sessionOpts.join(' / ')}\nخانات الهدف/الوقف: ${r.newFields.join(' / ')}` : '')
    );

  } catch (e) {

    await page.screenshot({ path: path.join(SHOTS, `${Date.now()}-${sig.symbol}-error.png`) }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await Signals.updateOne({ _id: sig._id }, { $set: { tradeResult: { broker: 'sahm', status: 'error', error: e.message, at: new Date() } } });
    tg(`❌ <b>فشل التنفيذ</b> ${tag}\n${e.message}`, 'error');
  }
}

// ---------- التشغيل ----------
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  Settings = mongoose.connection.collection('botsettings');
  Logs = mongoose.connection.collection('botlogs');
  await Settings.updateOne({ key: 'sahm' }, { $setOnInsert: { key: 'sahm', ...DEFAULTS } }, { upsert: true });
  await refreshSettings();
  console.log(`🚀 Sahm Bot | ${C.dry ? 'وضع التجربة' : 'تنفيذ حقيقي'} | ${C.amount}$ | سعر ${C.minPrice}-${C.maxPrice}`);
  // نبضة كل دقيقة: المنصة بتعرض "البوت متصل"
  working = false;
  const beat = async () => {
    const set = { heartbeat: new Date(), botMode: C.dry ? 'dry' : 'live', brokerLoggedIn: loggedIn };
    if (!working) { const acc = await readAccount().catch(() => null); if (acc) set.account = acc; }
    await Settings.updateOne({ key: 'sahm' }, { $set: set }).catch(() => {});
  };
  beat(); setInterval(async () => { await refreshSettings().catch(() => {}); beat(); }, 60 * 1000);
  await openBrowser();
  // أوامر المنصة (تسجيل الدخول/الرمز) — كل ثانيتين
  setInterval(() => { busy = busy.then(() => checkCommands()).catch(() => {}); }, 2000);

  if (!(await ensureLoggedIn())) {
    console.log('🔐 سجّل الدخول: من المنصة (صفحة التداول الآلي → دخول سهم) أو من نافذة المتصفح');
    tg('🔐 بوت سهم محتاج تسجيل دخول — ادخل من صفحة التداول الآلي في المنصة');
    await Settings.updateOne({ key: 'sahm' }, { $set: { loginState: 'idle', loginMsg: 'البوت محتاج تسجيل دخول' } });
    while (!(await isLoggedIn())) await sleep(3000);
    await sleep(2000);
    await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  loggedIn = true; beat();
  log('✅ مسجل دخول في سهم');

  const Signals = mongoose.connection.collection('signals');
  log('✅ البوت متصل بالمنصة — مستني الإشارات');
  tg(`🤖 بوت سهم شغال (${C.dry ? 'تجربة' : 'تنفيذ حقيقي'})`);

  // سماع لحظي لأي إشارة جديدة (من الـ Webhook بس، مش من الإيميل)
  const stream = Signals.watch(
    [{ $match: { operationType: 'insert', 'fullDocument.action': 'BUY', 'fullDocument.source': { $ne: 'email' } } }],
    { fullDocument: 'updateLookup' }
  );
  stream.on('change', (ch) => {
    busy = busy.then(async () => { working = true; try { await handle(ch.fullDocument, Signals); } finally { working = false; } });
  });
  stream.on('error', (e) => { console.error('stream:', e.message); tg('⚠️ انقطع اتصال البوت بقاعدة البيانات — أعد تشغيله'); });

  // ===== إبقاء الجلسة حية =====
  // كل 4 دقايق (لو مفيش أمر شغال): ريفرش لصفحة المحافظ = نشاط على الحساب، فالجلسة ما تقفلش من الخمول
  let sessionStart = Date.now();
  setInterval(async () => {
    if (working) return;
    try {
      await ensureBrowser();
      await page.reload({ waitUntil: "domcontentloaded" });
      const ok = await ensureLoggedIn();
      if (ok && !loggedIn) { sessionStart = Date.now(); tg('✅ رجع تسجيل الدخول في سهم'); }
      if (!ok && loggedIn) {
        const hrs = ((Date.now() - sessionStart) / 3600000).toFixed(1);
        tg(`🔐 جلسة سهم انتهت بعد ${hrs} ساعة — هيوصلك رمز تحقق، اكتبه في صفحة التداول الآلي في المنصة`, 'warn');
        // نبدأ تسجيل الدخول تلقائياً بالرقم المحفوظ
        await Settings.updateOne({ key: 'sahm', sahmPhone: { $nin: ['', null] } },
          { $set: { command: { id: Date.now().toString(36), type: 'login', at: new Date() }, loginState: 'sending', loginMsg: 'الجلسة انتهت — جاري طلب رمز جديد' } });
      }
      loggedIn = ok;
    } catch (e) { log('keep-alive: ' + e.message, 'warn'); }
  }, 4 * 60 * 1000);
})();
