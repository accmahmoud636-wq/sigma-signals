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
                   sizeMode: 'fixed', sizePct: 10, market: 'US', dailyProfitTarget: 0, dailyLossLimit: 0, autoBracket: true };
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
  page.on('crash', () => log('💥 صفحة سهم وقعت (crash)', 'warn'));
  ctx.on('close', () => log('المتصفح اتقفل', 'warn'));
  // نسجّل بيانات الحساب اللي سهم بتجيبها (المحفظة، الأسهم، الرصيد) — عشان نعرضها في المنصة
  page.on('response', async (r) => {
    try {
      const u = r.url();
      if (!/sahmcapital\.com/.test(u) || /quoteapi|recaptcha|\/hq\//.test(u)) return;
      const t = r.request().resourceType(); if (t !== 'xhr' && t !== 'fetch') return;
      const body = await r.text(); if (!body || body[0] !== '{' || body.length > 200000) return;
      const p = u.replace(/^https?:\/\//, '').split('?')[0];
      const query = u.split('?')[1] || '', req = (r.request().postData() || '').slice(0, 1000);
      // محفظتي: نحفظ بيانات كل سوق لوحده (SA / US) عشان المنصة تعرضها
      const pm = p.match(/(queryAllAsset|queryHoldsList|queryTodayProfitLoss|queryTodayOrder|queryAssetInfo|queryAccountAsset)$/);
      if (pm) {
        const ex = (req.match(/exchangeType=(\w+)/) || [])[1] || lastExchange;
        const mk = ex ? (ex === 'S' ? 'SA' : 'US') : null;
        let data = null; try { data = JSON.parse(body).data; } catch (_) {}
        if (mk && data) await mongoose.connection.collection('sahmportfolio').updateOne({ key: 'sahm' },
          { $set: { [`${mk}.${pm[1]}`]: data, [`${mk}.at`]: new Date(), [`${mk}.fund`]: (req.match(/fundAccount=(\d+)/) || [])[1] || lastFund } }, { upsert: true });
      }
      if (/queryAllAsset/.test(p)) lastAssetAt = Date.now();
      if (/queryAllAsset/.test(p)) { lastExchange = (req.match(/exchangeType=(\w+)/) || [])[1] || lastExchange; lastFund = (req.match(/fundAccount=(\d+)/) || [])[1] || lastFund; }
      await mongoose.connection.collection('sahmapi').updateOne({ path: p }, { $set: { path: p, body, query, req, method: r.request().method(), at: new Date() } }, { upsert: true });
    } catch (_) {}
  });
  await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' });
}

// السوق المختار من المنصة: US أمريكي / SA سعودي
// بنعرف الصفحة على أنهي سوق من طلبات سهم نفسها (exchangeType=S يعني السعودي)
let lastExchange = null, lastFund = null, lastAssetAt = 0;
const onMarket = (want) => lastExchange && (want === 'SA' ? lastExchange === 'S' : lastExchange !== 'S');
async function ensureUSMarket() {
  const want = C.market === 'SA' ? 'SA' : 'US', other = want === 'US' ? 'SA' : 'US';
  if (onMarket(want)) return true;
  if (!lastExchange) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(6000); if (onMarket(want)) return true; }
  const before = `${lastExchange}/${lastFund}`;
  // زرار السوق فوق في الهيدر: "SA ⇆" — الضغط عليه بيبدّل السوق
  const label = page.getByText(new RegExp('^\\s*' + other + '\\s*$')).locator('visible=true').first();
  if (await label.count()) {
    // نضغط على الحاوية (العلم + SA + ⇆) مش النص بس
    const box = label.locator('xpath=ancestor::*[self::div or self::button][1]');
    await (await box.count() ? box : label).click().catch(() => {});
    await sleep(2500);
    if (!onMarket(want)) {
      // لو فتحت قائمة: نختار السوق المطلوب منها
      const o = page.locator(':is(li,div,span,a,button):visible', { hasText: new RegExp('^\\s*(' + (want === 'US' ? 'US|الأمريكي|السوق الأمريكي|الولايات المتحدة' : 'SA|السعودي|السوق السعودي') + ')\\s*$') }).last();
      if (await o.count()) await o.click().catch(() => {});
    }
    for (let i = 0; i < 8 && !onMarket(want); i++) await sleep(1000);
  }
  if (onMarket(want)) { log(`${want === 'US' ? '🇺🇸' : '🇸🇦'} اتحوّلت لسوق ${want} — المحفظة ${lastFund}`); await pushShot('اتحوّلت لـ ' + want); return true; }
  log(`⚠️ ما قدرتش أتحوّل لسوق ${want} | كان ${before} بقى ${lastExchange}/${lastFund}`, 'warn');
  await pushShot('فشل التحويل لـ ' + want);
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

// لقطة شاشة من صفحة سهم على السيرفر — بتظهر في المنصة (عشان نشوف البوت شايف إيه)
async function pushShot(note) {
  try {
    if (!page || page.isClosed()) return;
    const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
    await mongoose.connection.collection('botshots').updateOne({ key: 'sahm' },
      { $set: { key: 'sahm', img: buf.toString('base64'), url: page.url(), note: note || '', market: `${lastExchange || '?'}/${lastFund || '?'}`, at: new Date() } }, { upsert: true });
  } catch (_) {}
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
  lastSession = null; // نرجّع الجلسة المحفوظة على المتصفح الجديد
  await applySession().catch((e) => log('نقل الجلسة: ' + e.message, 'warn'));
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
  if (!(await ensureUSMarket())) throw new Error('صفحة سهم مش على السوق المختار (' + (C.market || 'US') + ')');

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
  const usTab = page.getByText(C.market === 'SA' ? 'السعودي' : 'الأمريكي', { exact: true }).locator('visible=true').first();
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

// ---------- بيع من المنصة (زرار "بيع" في محفظتي) ----------
// confirm=false: يملا التذكرة ويصوّرها من غير إرسال (معاينة) — confirm=true: يبعت الأمر فعلاً
const setOrder = (orderState, orderMsg) => Settings.updateOne({ key: 'sahm' }, { $set: { orderState, orderMsg, orderAt: new Date() }, $unset: { command: '' } }).catch(() => {});
async function sellOrder({ symbol, qty, price, confirm }) {
  symbol = String(symbol || '').toUpperCase(); qty = Math.floor(Number(qty)); price = Number(price);
  if (!symbol || !(qty > 0) || !(price > 0)) return setOrder('error', 'بيانات البيع ناقصة');
  await setOrder('working', `${confirm ? 'جاري إرسال' : 'جاري تجهيز معاينة'} بيع ${qty} ${symbol} @ ${price}...`);
  working = true;
  try {
    if (!(await ensureLoggedIn())) throw new Error('مش مسجل دخول في سهم');
    await dismissPopups();
    if (!(await ensureUSMarket())) throw new Error('صفحة سهم مش على السوق المختار');
    if (!page.url().startsWith(URL_PORTFOLIO)) { await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' }); await sleep(4000); }
    // 1) زرار "بيع" في صف السهم في جدول الأسهم المملوكة
    const row = page.locator('tr:visible', { hasText: symbol }).filter({ has: page.getByText('بيع', { exact: true }) }).first();
    if (await row.count()) await row.getByText('بيع', { exact: true }).first().click();
    else {
      // بديل: تذكرة التداول + البحث عن الرمز + بيع
      const search = page.getByPlaceholder('رمز أو اسم الشركة').locator('visible=true').first();
      if (!(await search.isVisible().catch(() => false))) { await page.locator('button.trade-button').locator('visible=true').first().click(); await search.waitFor({ state: 'visible', timeout: 10000 }); }
      await search.fill(symbol); await sleep(1500);
      await page.getByText(symbol, { exact: true }).locator('visible=true').first().click(); await sleep(1500);
      await page.locator('.sell').locator('visible=true').first().click();
    }
    await sleep(1500);
    // 2) نوع الأمر: محدد
    const priceIn = page.getByPlaceholder('أدخل السعر').locator('visible=true').first();
    if (!(await priceIn.count())) { const t = page.locator('.n-select').nth(1); if (await t.count()) await pickSelect(1, 'المحدد').catch(() => {}); }
    await priceIn.waitFor({ state: 'visible', timeout: 8000 });
    // 3) السعر والكمية
    await priceIn.fill(String(price));
    await page.getByPlaceholder('أدخل الكمية').locator('visible=true').first().fill(String(qty));
    await sleep(800);
    const ticket = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const sideOk = /بيع/.test(ticket);
    await pushShot(`معاينة بيع ${qty} ${symbol} @ ${price}`);
    if (!confirm) {
      await page.keyboard.press('Escape').catch(() => {});
      return setOrder('preview', `📸 المعاينة جاهزة: بيع ${qty} ${symbol} بسعر ${price} — شوف الصورة، ولو كله صح اضغط "تأكيد البيع"`);
    }
    if (!sideOk) throw new Error('مش متأكد إن التذكرة على "بيع" — اتلغى');
    // 4) إرسال + تأكيد
    await page.getByText('إرسال الأمر', { exact: true }).locator('visible=true').first().click();
    await sleep(1500);
    if (await page.locator('input[type=password]').locator('visible=true').count()) throw new Error('سهم طالبة كلمة مرور التداول — افتح قفل التداول');
    const ok = page.getByRole('button', { name: /^\s*(تأكيد|موافق|إرسال|تأكيد الأمر)\s*$/ }).locator('visible=true').last();
    if (await ok.count()) { await ok.click(); await sleep(2500); }
    await pushShot(`بعد إرسال بيع ${qty} ${symbol}`);
    const after = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const err = (after.match(/(فشل|مرفوض|رفض|غير كافي|خطأ)[^.،]{0,60}/) || [])[0];
    tg(`🔴 <b>بيع من المنصة</b>\n${symbol} | كمية ${qty} | محدد ${price}` + (err ? `\n⚠️ ${err}` : ''));
    return setOrder(err ? 'error' : 'sent', err ? 'سهم ردّت: ' + err : `✅ اتبعت أمر بيع ${qty} ${symbol} بسعر ${price} — راجع "أوامر اليوم"`);
  } catch (e) {
    await pushShot('خطأ في البيع');
    await page.keyboard.press('Escape').catch(() => {});
    log('بيع: ' + e.message, 'error');
    return setOrder('error', 'فشل: ' + e.message.split('\n')[0].slice(0, 140));
  } finally { working = false; }
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
  if (!page.url().startsWith(URL_PORTFOLIO)) {
    await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(1500);
  }
  if (await isLoggedIn()) return 'already';
  await dismissPopups();
  const findPhone = (t) => inFrames((f) => f.getByPlaceholder('رقم الهاتف'), t);
  let phoneIn = await findPhone(1500);
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

async function loginFrame() {
  for (const f of page.frames()) if (await f.getByPlaceholder('رقم الهاتف').count().catch(() => 0)) return f;
  return null;
}
async function pickSaudiCode() {
  const f = await loginFrame(); if (!f) return;
  const phoneIn = f.getByPlaceholder('رقم الهاتف').first();
  // الحاوية اللي فيها خانة الرقم + زرار مفتاح الدولة
  const box = phoneIn.locator('xpath=ancestor::*[contains(normalize-space(.),"+") or .//img][1]');
  const boxText = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const m = boxText.match(/\+\s?(\d{1,4})/);
  const cur = m ? '+' + m[1] : '?';
  if (cur === '+966') return log('مفتاح الدولة +966 ✔');
  // نضغط على المفتاح الظاهر (أي عنصر جوه الحاوية فيه +رقم)
  const trigger = box.getByText(/\+\s?\d{1,4}/).locator('visible=true').first();
  if (await trigger.count()) await trigger.click().catch(() => {});
  else await box.locator('xpath=./*[1]').click().catch(() => {});
  await sleep(1000);
  // خانة بحث في قائمة الدول (لو موجودة)
  const searchIn = f.locator('input:visible').filter({ hasNot: f.locator('[placeholder="رقم الهاتف"]') });
  for (let i = 0; i < await searchIn.count(); i++) {
    const ph = await searchIn.nth(i).getAttribute('placeholder').catch(() => '');
    if (ph !== 'رقم الهاتف') { await searchIn.nth(i).fill('966').catch(() => {}); await sleep(700); break; }
  }
  const opt = f.locator(':is(li,div,span,a,p):visible', { hasText: /(\+?\s?966)/ }).filter({ hasNotText: /\+358/ }).last();
  if (await opt.count()) await opt.click().catch(() => {});
  await sleep(700);
  const after = (await box.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const now = (after.match(/\+\s?(\d{1,4})/) || [])[1];
  log(`مفتاح الدولة: كان ${cur} → بقى +${now || '?'}`, now === '966' ? 'info' : 'warn');
  if (now !== '966') {
    const html = (await box.evaluate((e) => e.outerHTML).catch(() => '')).replace(/\s+/g, ' ').slice(0, 900);
    log('🔍 حاوية الرقم: ' + boxText.slice(0, 100) + ' | HTML: ' + html, 'warn');
    const list = (await f.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    log('🔍 النافذة: ' + list, 'warn');
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error('ما قدرتش أختار مفتاح السعودية +966');
  }
}

async function startLogin(phone, method) {
  if (!phone) return setLogin('error', 'رقم الجوال مش محفوظ — اكتبه في المنصة');
  const phoneIn = await openLoginModal();
  if (phoneIn === 'already') { loggedIn = true; return setLogin('success', 'مسجل دخول بالفعل'); }
  // مفتاح الدولة: سهم بتختاره حسب مكان السيرفر (فنلندا +358) — لازم نخليه السعودية +966
  await pickSaudiCode();
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
  // ردّ سهم على طلب الكود: لو رفضت نعرض السبب في المنصة بدل "اتبعت"
  const sendR = resp.find((x) => x.includes('auth-code/send'));
  if (sendR && !/"code"\s*:\s*"10000000"/.test(sendR)) {
    const msg = (sendR.match(/"msg"\s*:\s*"([^"]*)"/) || [])[1] || 'سهم رفضت إرسال الرمز';
    log('🔍 ' + sendR, 'warn');
    // سهم بترفض إرسال الكود للسيرفر، بس نافذة الدخول بتفضل مستنية كود —
    // فالكود اللي بتطلبه من موقع سهم في المتصفح بيشتغل هنا عادي
    return setLogin('awaiting_otp', 'افتح موقع سهم في المتصفح واطلب الرمز هناك، وبعدين اكتبه هنا واضغط تأكيد');
  }
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
      await ensureUSMarket().catch(() => {});
      await saveSession().catch((e) => log('حفظ الجلسة: ' + e.message, 'warn'));
      return setLogin('success', 'تم تسجيل الدخول في سهم');
    }
    if (await page.locator('input[type=password]').locator('visible=true').count())
      return setLogin('error', 'سهم طالبة كلمة مرور — كمّلها في نافذة البوت على الجهاز');
  }
  const shot = path.join(SHOTS, `${Date.now()}-login-error.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  setLogin('error', 'الرمز غلط أو انتهى — جرب "دخول سهم" تاني');
}

// ---------- نقل جلسة سهم من الكمبيوتر ----------
// سهم بترفض طلب الكود من السيرفر (reCAPTCHA) — فبندخل من الكمبيوتر
// وسكربت export-session.js بيرفع الجلسة، والبوت هنا بيستخدمها
let lastSession = null;
// حفظ الجلسة في قاعدة البيانات: لو البوت اتعمله ريستارت يرجع مسجل من غير كود
async function saveSession() {
  if (!ctx) return;
  let state; try { state = await ctx.storageState({ indexedDB: true }); } catch (_) { state = await ctx.storageState(); }
  const at = new Date();
  await mongoose.connection.collection('sahmsessions').updateOne({ key: 'sahm' }, { $set: { key: 'sahm', state, at, from: 'server' } }, { upsert: true });
  lastSession = String(at.getTime());
}
async function applySession() {
  const doc = await mongoose.connection.collection('sahmsessions').findOne({ key: 'sahm' });
  if (!doc || !doc.state) return;
  const stamp = String(new Date(doc.at).getTime());
  if (stamp === lastSession) return;
  if (doc.from === 'server' && loggedIn && lastSession) { lastSession = stamp; return; } // دي نسختنا إحنا
  lastSession = stamp;
  await ensureBrowser();
  const st = doc.state;
  if (st.cookies && st.cookies.length) await ctx.addCookies(st.cookies);
  // localStorage لمواقع سهم بس — بنحطه قبل ما الصفحة تحمّل (من غير ما نفتح كل موقع لوحده)
  const ls = (st.origins || []).filter((o) => /sahmcapital\.com/.test(o.origin) && o.localStorage && o.localStorage.length)
    .map((o) => ({ origin: o.origin, items: o.localStorage }));
  if (ls.length) await ctx.addInitScript((data) => {
    const d = data.find((x) => x.origin === location.origin);
    if (d && !sessionStorage.getItem('__mm_ls')) { for (const { name, value } of d.items) localStorage.setItem(name, value); sessionStorage.setItem('__mm_ls', '1'); }
  }, ls);
  await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(2000);
  if (await isLoggedIn()) {
    loggedIn = true;
    await ensureUSMarket().catch(() => {});
    tg(doc.from === 'server' ? '✅ رجعت جلسة سهم المحفوظة — البوت مسجل دخول' : '✅ جلسة سهم اتنقلت من الكمبيوتر — البوت مسجل دخول على السيرفر');
    await setLogin('success', 'تم تسجيل الدخول (جلسة منقولة من الكمبيوتر)');
  } else {
    log('⚠️ الجلسة المنقولة ما نفعتش — سجّل دخول تاني على الكمبيوتر وشغّل export-session', 'warn');
    await setLogin('error', 'الجلسة المنقولة ما نفعتش — شغّل نقل الجلسة تاني');
  }
}

// قطع الاتصال: تسجيل خروج من سهم + مسح الجلسة المحفوظة
async function logoutSahm() {
  await mongoose.connection.collection('sahmsessions').deleteMany({});
  try {
    await ensureBrowser();
    const out = page.getByText('تسجيل الخروج').first();
    if (await out.count()) { await out.click({ force: true }).catch(() => {}); await sleep(1500);
      const yes = page.getByRole('button', { name: /^\s*(تأكيد|نعم|تسجيل الخروج|حسناً)\s*$/ }).locator('visible=true').last();
      if (await yes.count()) await yes.click().catch(() => {}); }
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (_) {} }).catch(() => {});
    await ctx.clearCookies();
    await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  } catch (e) { log('قطع الاتصال: ' + e.message, 'warn'); }
  loggedIn = false; lastSession = null;
  await Settings.updateOne({ key: 'sahm' }, { $set: { brokerLoggedIn: false, account: null } });
  tg('🔌 تم قطع الاتصال بسهم — البوت متوقف ومش هينفذ لحد ما تدخل تاني');
  await setLogin('idle', 'تم قطع الاتصال بسهم');
}

// تحديث البوت من GitHub (زرار في المنصة) — بيتأكد إن الملف سليم قبل ما يستبدله
async function selfUpdate() {
  const url = 'https://api.github.com/repos/accmahmoud636-wq/sigma-signals/contents/sahm-bot/bot.js?ref=main';
  await setLogin('sending', 'جاري تحميل آخر نسخة من البوت...');
  const code = await new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'sahm-bot', Accept: 'application/vnd.github.raw' } }, (r) => {
      if (r.statusCode !== 200) return reject(new Error('GitHub ' + r.statusCode));
      let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c)); r.on('end', () => resolve(d));
    }).on('error', reject);
  });
  const tmp = path.join(__dirname, 'bot.new.js');
  fs.writeFileSync(tmp, code);
  const chk = require('child_process').spawnSync(process.execPath, ['--check', tmp]);
  if (chk.status !== 0) { fs.unlinkSync(tmp); return setLogin('error', 'ملف البوت على GitHub فيه خطأ — التحديث اتلغى'); }
  if (code === fs.readFileSync(__filename, 'utf8')) { fs.unlinkSync(tmp); return setLogin(loggedIn ? 'success' : 'idle', 'البوت أصلاً على آخر نسخة'); }
  fs.renameSync(tmp, __filename);
  await setLogin('sending', 'اتحدّث — البوت بيعيد التشغيل (دقيقة)...');
  tg('⬆️ البوت اتحدّث من GitHub وبيعيد التشغيل');
  await sleep(1500);
  try { await ctx.close(); } catch (_) {}
  process.exit(0); // systemd بيشغّله تاني بالنسخة الجديدة
}

let lastCmd = null;
async function checkCommands() {
  try { await applySession(); } catch (e) { log('نقل الجلسة: ' + e.message, 'error'); }
  const s = await Settings.findOne({ key: 'sahm' }, { projection: { command: 1, sahmPhone: 1, sahmMethod: 1 } });
  const cmd = s && s.command;
  if (!cmd || cmd.id === lastCmd) return;
  lastCmd = cmd.id;
  // أمر قديم (من قبل إعادة التشغيل) ما ننفذوش تاني
  if (cmd.at && Date.now() - new Date(cmd.at).getTime() > 2 * 60 * 1000) return;
  try {
    if (cmd.type === 'login') await startLogin(s.sahmPhone, s.sahmMethod);
    else if (cmd.type === 'otp') await submitOtp(cmd.code);
    else if (cmd.type === 'logout') await logoutSahm();
    else if (cmd.type === 'update') await selfUpdate();
    else if (cmd.type === 'sell') await sellOrder(cmd);
    else if (cmd.type === 'shot') { await pushShot('طلب من المنصة'); await setLogin(loggedIn ? 'success' : 'idle', 'اتصوّرت صفحة سهم'); }
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
    // تشخيص: إيه اللي ظاهر في صفحة سهم ساعة الخطأ
    try {
      const frames = page.frames().map((f) => f.url().replace(/^https?:\/\//, '').slice(0, 50)).filter((u) => u && !/google|linkedin|recaptcha|about:blank|facebook|clarity/.test(u));
      const modal = await page.locator('.n-modal, .n-dialog, .n-drawer').locator('visible=true').allInnerTexts().catch(() => []);
      const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      log(`🔍 خطأ ${sig.symbol} | الرابط: ${page.url().slice(0, 80)} | الإطارات: ${frames.join(' , ')} | نافذة مفتوحة: ${modal.join(' ').replace(/\s+/g, ' ').slice(0, 250) || 'لا'} | الصفحة: ${body.slice(0, 350)}`, 'warn');
      log(`🔍 زراير التداول: ${await page.locator('button.trade-button').count()} | مسجل: ${await isLoggedIn()}`, 'warn');
    } catch (_) {}
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
  // لما السوق يتغير من المنصة: نحوّل صفحة سهم فوراً (من غير ما نستنى الريفرش الدوري)
  let appliedMarket = null, lastTry = 0;
  setInterval(async () => {
    await refreshSettings().catch(() => {});
    const want = C.market === 'SA' ? 'SA' : 'US';
    if (loggedIn && !working && want !== appliedMarket && Date.now() - lastTry > 90 * 1000) {
      lastTry = Date.now();
      busy = busy.then(async () => { if (await ensureUSMarket().catch(() => false)) appliedMarket = want; }).catch(() => {});
    }
  }, 20 * 1000);
  // تحديث المحفظة تلقائياً كل دقيقة: ضغطة على "المحافظ" (أخف من ريفرش الصفحة كلها)
  setInterval(() => {
    if (!loggedIn || working) return;
    busy = busy.then(async () => {
      if (!page || page.isClosed() || working) return;
      const t0 = Date.now();
      const nav = page.getByText('المحافظ', { exact: true }).locator('visible=true').first();
      if (await nav.count()) await nav.click().catch(() => {});
      for (let i = 0; i < 6 && lastAssetAt < t0; i++) await sleep(1000);
      if (lastAssetAt < t0) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(5000); }
    }).catch(() => {});
  }, 60 * 1000);
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
      if (ok) await ensureUSMarket().catch(() => {});
      await pushShot('تحديث دوري');
      if (ok) await saveSession().catch(() => {});
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
