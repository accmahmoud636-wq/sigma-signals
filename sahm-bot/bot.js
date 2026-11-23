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
                   sizeMode: 'fixed', sizePct: 10, market: 'US', orderType: 'market', fundAccount: '', dailyProfitTarget: 0, dailyLossLimit: 0, autoBracket: true };
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
  // أي ضغطة/تحميل ليه حد أقصى — من غيره ممكن البوت يستنى للأبد ويقف
  ctx.setDefaultTimeout(20000); ctx.setDefaultNavigationTimeout(45000);
  await preloadSession().catch((e) => console.log('preload:', e.message));
  page = ctx.pages()[0] || (await ctx.newPage());
  page.on('crash', () => log('💥 صفحة سهم وقعت (crash)', 'warn'));
  // تسجيل طلب "إرسال الأمر" الحقيقي (العنوان + البيانات) — عشان نبني التنفيذ المباشر الأسرع
  page.on('request', async (rq) => {
    try {
      const u = rq.url();
      if (rq.method() === 'GET' || !/sahmcapital\.com/.test(u) || !/trade\/order/i.test(u) || /query/i.test(u)) return;
      const h = rq.headers(); for (const k of Object.keys(h)) if (/cookie|authorization|token/i.test(k)) h[k] = '(موجود)';
      await mongoose.connection.collection('sahmorderreq').insertOne({ url: u, method: rq.method(), headers: h, post: (rq.postData() || '').slice(0, 3000), at: new Date() });
      log('🧩 اتسجّل طلب الأمر: ' + u.replace(/^https?:\/\//, '').split('?')[0]);
    } catch (_) {}
  });
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
        if (mk && data) {
          const set = { [`${mk}.${pm[1]}`]: data, [`${mk}.at`]: new Date(), [`${mk}.fund`]: (req.match(/fundAccount=(\d+)/) || [])[1] || lastFund };
          // متوسط تكلفة كل سهم بنحفظه دايماً — عشان نحسب ربح/خسارة البيع بعد ما السهم يخرج من المحفظة
          for (const h of (data.holdsList || [])) if (h.stockCode && Number(h.costPrice) > 0) set[`${mk}.costs.${String(h.stockCode).replace(/\./g, '_')}`] = Number(h.costPrice);
          await mongoose.connection.collection('sahmportfolio').updateOne({ key: 'sahm' }, { $set: set }, { upsert: true });
        }
      }
      // سجل الأوامر (اليوم + سجل الأوامر القديم لو اتفتح): بنحفظ كل أمر مرة واحدة للتحليلات
      if (/order/i.test(p) && !/Statistic/i.test(p)) {
        let d = null; try { d = JSON.parse(body).data; } catch (_) {}
        const list = d && (Array.isArray(d) ? d : d.dataList || d.list || d.records);
        if (Array.isArray(list) && list.length && (list[0].orderInfo || list[0].entrustBs || list[0].stockCode)) {
          const ex = (req.match(/exchangeType=(\w+)/) || [])[1] || lastExchange;
          await storeOrders(list, ex ? (ex === 'S' ? 'SA' : 'US') : 'US').catch(() => {});
        }
      }
      if (/queryAllAsset/.test(p) && /"code":"10000000"/.test(body)) lastAssetAt = Date.now();
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
  const okMarket = await ensureMarketOnly();
  if (!okMarket) return false;
  return ensureFund();
}
// اختيار المحفظة المحددة في المنصة (مثلاً 800906239 الهامش) من قائمة المحافظ في صفحة سهم
const isDemo = async () => (await page.getByText('التداول التجريبي').locator('visible=true').count().catch(() => 0)) > 0;
async function ensureFund() {
  const want = String(C.fundAccount || '').trim();
  // ممنوع نفضل على "التداول التجريبي" — لو مفيش رقم محفظة محدد بنختار أول محفظة حقيقية
  if (!want) {
    if (!(await isDemo())) return true;
    const cur = lastFund ? page.getByText(lastFund).locator('visible=true').first() : null;
    if (cur && await cur.count()) {
      await cur.click().catch(() => {}); await sleep(1000);
      const real = page.locator(':is(li,div,span,a,button):visible', { hasText: /\d{8,10}/ }).filter({ hasNotText: 'التجريبي' }).last();
      if (await real.count()) await real.click().catch(() => {});
      await sleep(4000);
    }
    const ok = !(await isDemo());
    log(ok ? `💼 خرجت من التداول التجريبي — المحفظة ${lastFund}` : '⚠️ الصفحة على التداول التجريبي ومش قادر أطلع منه', ok ? 'info' : 'warn');
    return ok;
  }
  if (lastFund === want && !(await isDemo())) return true;
  const before = lastFund;
  const cur = before ? page.getByText(before).locator('visible=true').first() : null;
  if (cur && await cur.count()) {
    await cur.click().catch(() => {}); await sleep(1000);
    const opt = page.locator(':is(li,div,span,a,button):visible', { hasText: want }).last();
    if (await opt.count()) await opt.click().catch(() => {});
    for (let i = 0; i < 10 && lastFund !== want; i++) await sleep(1000);
  }
  const ok = lastFund === want;
  log(ok ? `💼 اتحوّلت للمحفظة ${want}` : `⚠️ ما قدرتش أختار المحفظة ${want} (الحالية ${lastFund})`, ok ? 'info' : 'warn');
  if (!ok) { await page.keyboard.press('Escape').catch(() => {}); await pushShot('فشل اختيار المحفظة ' + want); }
  return ok;
}
async function ensureMarketOnly() {
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

// تحميل الجلسة المحفوظة قبل أول فتح للصفحة → البوت يفتح سهم مسجّل دخول على طول (من غير ما يستنى)
async function preloadSession() {
  if (mongoose.connection.readyState !== 1) return;
  const doc = await mongoose.connection.collection('sahmsessions').findOne({ key: 'sahm' });
  if (!doc || !doc.state) return;
  const st = doc.state;
  if (st.cookies && st.cookies.length) await ctx.addCookies(st.cookies);
  const ls = (st.origins || []).filter((o) => /sahmcapital\.com/.test(o.origin) && o.localStorage && o.localStorage.length).map((o) => ({ origin: o.origin, items: o.localStorage }));
  if (ls.length) await ctx.addInitScript((data) => {
    const d = data.find((x) => x.origin === location.origin);
    if (d && !sessionStorage.getItem('__mm_ls')) { for (const { name, value } of d.items) localStorage.setItem(name, value); sessionStorage.setItem('__mm_ls', '1'); }
  }, ls);
  lastSession = String(new Date(doc.at).getTime());
}

// فحص بدون تنقل: هل فيه زرار "تسجيل الخروج" (يعني مسجل دخول)
async function isLoggedIn() {
  // سهم ردّت ببيانات الحساب بنجاح في آخر 3 دقايق = الجلسة شغالة (أدق من البحث عن زرار في الصفحة)
  if (typeof lastAssetAt === 'number' && Date.now() - lastAssetAt < 3 * 60 * 1000) return true;
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

// خانات سهم (Naive UI): الـ placeholder مش attribute — بيبقى span جوه .n-input
// فبنلاقي الخانة بالـ placeholder لو موجود، أو بالـ span، أو بالعنوان اللي جنبها (السعر / الكمية)
async function phInput(scope, re) {
  const a = scope.getByPlaceholder(re).locator('visible=true').first();
  if (await a.count()) return a;
  const b = scope.locator('.n-input:visible', { hasText: re }).locator('input').first();
  if (await b.count()) return b;
  return null;
}
function fieldByLabel(panel, label) {
  return panel.locator(`xpath=.//*[normalize-space(text())="${label}"]/ancestor::*[.//input][1]//input`).locator('visible=true').first();
}

// فتح تذكرة التداول ولقي خانة البحث عن السهم (بأكتر من شكل) — ولو فشل: صورة + أسماء الخانات في السجل
async function openTicketSearch() {
  const ph = /(رمز أو اسم الشركة|رمز|اسم الشركة|ابحث|بحث|Symbol|Search)/;
  const find = async () => { if (await ticketPanel()) return (await ticketPanel()).locator('input:visible').first(); for (const f of page.frames()) { const l = await phInput(f, ph); if (l) return l; } return null; };
  let el = await find(); if (el) return el;
  const triggers = [page.locator('button.trade-button'), page.locator('[class*=trade-button],[class*=tradeButton],[class*=trade-btn]'), page.getByRole('button', { name: /تداول|Trade/ })];
  for (const t of triggers) {
    const b = t.locator('visible=true').first();
    if (!(await b.count())) continue;
    await b.click().catch(() => {});
    for (let i = 0; i < 8 && !el; i++) { await sleep(1000); el = await find(); }
    if (el) return el;
  }
  // الدايرة الخضرا فوق على الشمال (زرار التداول) — بنضغط على مكانها مباشرة
  for (const [x, y] of [[42, 40], [40, 38], [44, 42]]) {
    await page.mouse.click(x, y).catch(() => {});
    for (let i = 0; i < 6 && !el; i++) { await sleep(1000); el = await find(); }
    if (el) { log('🎫 فتحت التذكرة من الدايرة الخضرا'); return el; }
  }
  const inputs = [];
  for (const f of page.frames()) { const ins = f.locator('input:visible'); const n = Math.min(await ins.count(), 15);
    for (let i = 0; i < n; i++) inputs.push((await ins.nth(i).getAttribute('placeholder').catch(() => '')) || '(بدون)'); }
  const btns = (await page.locator('button:visible').allInnerTexts().catch(() => [])).map((x) => x.trim()).filter(Boolean).slice(0, 25);
  log(`🔍 تذكرة التداول: الخانات الظاهرة: ${inputs.join(' ¦ ')} | الأزرار: ${btns.join(' ¦ ')}`, 'warn');
  await pushShot('تذكرة التداول ما فتحتش');
  throw new Error('خانة البحث عن السهم ما ظهرتش في تذكرة التداول');
}

// الجلسة الأمريكية العادية (9:30 – 16:00 نيويورك، الإثنين–الجمعة) — أمر السوق بيشتغل فيها بس
function usRegularSession() {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = ny.getDay(), m = ny.getHours() * 60 + ny.getMinutes();
  return d >= 1 && d <= 5 && m >= 9 * 60 + 30 && m < 16 * 60;
}
const useMarketOrder = () => C.orderType !== 'limit' && (C.market === 'SA' || usRegularSession());

// ---------- الخروج التلقائي: بيع سوق فوراً عند الهدف الأول أو الوقف ----------
// السعر اللحظي من Yahoo (كل ثانيتين) — مع ما قبل/بعد الافتتاح
function livePrice(symbol) {
  return new Promise((resolve) => {
    const req = https.get({ hostname: 'query1.finance.yahoo.com', path: `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`,
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
        try {
          const x = JSON.parse(d).chart.result[0];
          const closes = (x.indicators.quote[0].close || []).filter((v) => v != null);
          resolve(closes.length ? closes[closes.length - 1] : x.meta.regularMarketPrice || null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// بيع فوري من التذكرة المفتوحة: سوق في الجلسة العادية، وبرّها محدد تحت السعر بـ 1% (عشان يتنفذ على طول)
async function sellNow(symbol, qty, price) {
  const t0 = Date.now();
  const mkt = useMarketOrder();
  const panel = await prepareTicket();
  await setSide(panel, 'بيع');
  await pickIn(panel, 1, mkt ? /السوق/ : /المحدد/);
  await selectSymbol(panel, symbol);
  await setSide(panel, 'بيع');
  if (!mkt) await fieldByLabel(panel, 'السعر').fill(String(round(price * 0.99)));
  await fieldByLabel(panel, 'الكمية').fill(String(qty));
  const txt = await panel.innerText().catch(() => '');
  if (!/بيع/.test(txt)) throw new Error('التذكرة مش على بيع');
  if (await isDemo()) throw new Error('الصفحة على التداول التجريبي — البيع اتلغى');
  await panel.getByText('إرسال الأمر').locator('visible=true').first().click();
  await sleep(600);
  const ok = page.getByRole('button', { name: /^\s*(تأكيد|موافق|إرسال|تأكيد الأمر)\s*$/ }).locator('visible=true').last();
  if (await ok.count()) await ok.click();
  log(`⚡ بيع ${mkt ? 'سوق' : 'محدد'} ${qty} ${symbol} — اتبعت بعد ${((Date.now() - t0) / 1000).toFixed(1)} ث`);
  await sleep(700);
  pushShot(`بعد بيع ${qty} ${symbol}`).catch(() => {});
  await setSide(panel, 'شراء').catch(() => {}); // نرجّع التذكرة جاهزة للشراء
  return mkt;
}

const closingNow = new Set();
let monitorWarned = false;
async function monitorPositions() {
  const col = mongoose.connection.collection('botpositions');
  const open = await col.find({ status: 'open' }).toArray();
  if (!open.length) return;
  const Signals = mongoose.connection.collection('signals');
  await Promise.all(open.map(async (p) => {
    if (closingNow.has(String(p._id))) return;
    let px = await livePrice(p.symbol);
    if (px == null) {
      // احتياطي: آخر سعر من محفظة سهم (بيتحدّث كل دقيقة)
      const pf = await mongoose.connection.collection('sahmportfolio').findOne({ key: 'sahm' }, { projection: { [`${p.market}.queryHoldsList`]: 1 } });
      const h = ((pf && pf[p.market] && pf[p.market].queryHoldsList && pf[p.market].queryHoldsList.holdsList) || []).find((x) => x.stockCode === p.symbol);
      px = h ? Number(h.lastPrice) : null;
      if (!monitorWarned) { monitorWarned = true; log('⚠️ مصدر السعر اللحظي مش راد — بستخدم سعر محفظة سهم (أبطأ)', 'warn'); }
    }
    let reason = null;
    if (px != null && p.tp && px >= p.tp) reason = '🎯 الهدف الأول';
    else if (px != null && p.sl && px <= p.sl) reason = '🛑 الوقف';
    else {
      const sg = p.signalId ? await Signals.findOne({ _id: p.signalId }, { projection: { status: 1 } }) : null;
      if (sg && sg.status && sg.status !== 'open') reason = '📡 تنبيه خروج من TradingView';
    }
    if (px != null) await col.updateOne({ _id: p._id }, { $set: { lastPrice: px, lastAt: new Date() } });
    if (!reason) return;
    closingNow.add(String(p._id));
    await col.updateOne({ _id: p._id }, { $set: { status: 'closing', reason, triggerPrice: px } });
    working = true;
    tradeChain = tradeChain.then(async () => {
      working = true;
      try {
        if (C.dry) { tg(`🧪 تجربة: كان هيبيع ${p.qty} ${p.symbol} (${reason}) عند ${px}`); await col.updateOne({ _id: p._id }, { $set: { status: 'closed', exitPrice: px, closedAt: new Date(), dry: true } }); return; }
        const mkt = await sellNow(p.symbol, p.qty, px);
        const pnl = (px - p.entry) * p.qty, pct = ((px - p.entry) / p.entry) * 100;
        await col.updateOne({ _id: p._id }, { $set: { status: 'closed', exitPrice: px, closedAt: new Date(), pnl, pct, orderType: mkt ? 'market' : 'limit' } });
        tg(`${reason === '🛑 الوقف' ? '🛑' : '🎯'} <b>اتباع ${p.symbol}</b> — ${reason}\nكمية ${p.qty} | دخول ${p.entry} → خروج ~${px}\n${pnl >= 0 ? '🟢' : '🔴'} ${pnl.toFixed(2)}$ (${pct.toFixed(2)}%) تقريبي قبل العمولة`);
      } catch (e) {
        const tries = (p.tries || 0) + 1;
        await col.updateOne({ _id: p._id }, { $set: { status: tries >= 3 ? 'error' : 'open', tries } });
        tg(`❌ فشل البيع التلقائي ${p.symbol} (محاولة ${tries}/3): ${String(e.message).split('\n')[0].slice(0, 120)}` + (tries >= 3 ? '\n⚠️ بيعه بإيدك من المنصة أو من سهم' : ' — هيحاول تاني'), 'error');
        await pushShot('خطأ في البيع التلقائي ' + p.symbol);
      } finally { working = false; closingNow.delete(String(p._id)); }
    }).catch(() => { working = false; closingNow.delete(String(p._id)); });
  }));
}

// ---------- تذكرة التداول الدائمة ----------
// بنفتحها مرة واحدة ونجهّزها (المحفظة + محدد + شراء)، ولما الإشارة توصل بنكتب الرمز والسعر والكمية بس
async function ticketPanel() {
  // التذكرة = أصغر div فيه "إرسال الأمر" + خانات إدخال + اختيار المحفظة
  // لازم الخانات نفسها تكون ظاهرة (سهم فيها نسخة مخفية من التذكرة)
  const p = page.locator('div:visible', { has: page.getByText('إرسال الأمر').locator('visible=true') }).filter({ has: page.locator('input:visible') }).filter({ has: page.locator('.n-select:visible') }).last();
  return (await p.count()) ? p : null;
}
async function setSide(panel, side) {
  const b = panel.getByText(side, { exact: true }).locator('visible=true').first();
  if (await b.count()) await b.click().catch(() => {});
}
async function pickIn(panel, idx, re) {
  const sel = panel.locator('.n-select:visible').nth(idx);
  if (!(await sel.count())) return false;
  const cur = (await sel.innerText().catch(() => '')).trim();
  if (re.test(cur)) return true;
  await sel.click().catch(() => {});
  await sleep(500);
  // نختار من القايمة المفتوحة بالـ JavaScript مباشرة (القايمة بتتحرك/بتتعمل animation فالضغط العادي بيفشل)
  const res = await page.evaluate(({ src, flags }) => {
    const r = new RegExp(src, flags);
    const opts = [...document.querySelectorAll('.n-base-select-option')].filter((e) => e.offsetParent !== null || e.getClientRects().length);
    const texts = opts.map((e) => e.innerText.trim());
    const hit = opts.find((e) => r.test(e.innerText.trim()));
    if (hit) { hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); hit.click(); }
    return { ok: !!hit, texts };
  }, { src: re.source, flags: re.flags }).catch((e) => ({ ok: false, texts: [String(e.message)] }));
  await sleep(400);
  const now = (await sel.innerText().catch(() => '')).trim();
  if (!re.test(now)) {
    log(`⚠️ اختيار "${re.source}" في القايمة ${idx + 1} ما نفعش — الاختيارات المتاحة: ${res.texts.join(' ¦ ') || '(القايمة ما فتحتش)'} — المختار دلوقتي: ${now || '—'}`, 'warn');
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  return true;
}
let ticketAt = 0;
async function prepareTicket() {
  let panel = await ticketPanel();
  if (!panel) { await openTicketSearch(); panel = await ticketPanel(); }
  if (!panel) throw new Error('تذكرة التداول ما فتحتش');
  // المحفظة (الأمريكي = رقم المحفظة الحالية، مثلاً 800906239 الهامش)
  const fund = String(C.fundAccount || lastFund || '').trim();
  await pickIn(panel, 0, fund ? new RegExp(fund) : /الهامش|الرئيسية/);
  await pickIn(panel, 1, useMarketOrder() ? /السوق/ : /المحدد/);
  await setSide(panel, 'شراء');
  if (Date.now() - ticketAt > 10 * 60 * 1000) { ticketAt = Date.now(); log('🎫 تذكرة التداول مفتوحة وجاهزة — مستنية الإشارة'); }
  return panel;
}

// اختيار السهم في التذكرة: نكتب الرمز، ونختار النتيجة من قايمة البحث (بأكتر من طريقة)
async function selectSymbol(panel, symbol) {
  const search = panel.locator('input:visible').first();
  await search.click(); await search.fill(''); await search.pressSequentially(symbol, { delay: 15 });
  const sym = symbol.toUpperCase();
  const tryPick = () => page.evaluate((sym) => {
    // كل العناصر الظاهرة اللي نصها بيبدأ بالرمز بالظبط (أو الرمز لوحده) — من قايمة البحث المنبثقة
    const vis = (e) => e.offsetParent !== null || e.getClientRects().length;
    const re = new RegExp('^\\s*' + sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$|\\.|\\b)');
    const all = [...document.querySelectorAll('body *')].filter((e) => vis(e) && e.children.length <= 3 && re.test((e.innerText || '').trim()));
    // نفضّل اللي جوه نافذة منبثقة/قايمة بحث (مش جدول المحفظة)
    const score = (e) => (e.closest('.v-binder-follower-content,.n-popover,.n-base-select-menu,[class*=search],[class*=dropdown],[class*=popup],[class*=result]') ? 0 : 1) + (e.closest('table') ? 2 : 0);
    all.sort((a, b) => score(a) - score(b));
    const hit = all[0];
    if (hit) { (hit.closest('li,[role=option],.n-base-select-option,[class*=item]') || hit).click(); }
    return { ok: !!hit, texts: all.slice(0, 6).map((e) => (e.innerText || '').trim().slice(0, 30)) };
  }, sym).catch(() => ({ ok: false, texts: [] }));
  let res = { ok: false, texts: [] };
  for (let i = 0; i < 10 && !res.ok; i++) { await sleep(400); res = await tryPick(); }
  if (!res.ok) {
    // آخر محاولة: أول نتيجة بالكيبورد
    await search.press('ArrowDown').catch(() => {}); await search.press('Enter').catch(() => {});
  }
  await sleep(700);
  const txt = (await panel.innerText().catch(() => '')).toUpperCase();
  if (!txt.includes(sym)) {
    await pushShot('ما لقيتش ' + sym + ' في البحث');
    throw new Error(`السهم ${sym} ما اتختارش في التذكرة (نتايج البحث: ${res.texts.join(' ¦ ') || 'مفيش'})`);
  }
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
  const qty = Math.floor(amount / (C.orderType === 'limit' ? limit : sig.price * 1.01));
  const tp = round(sig.tp || sig.price * (1 + C.tpPct / 100));
  const sl = round(sig.sl || sig.price * (1 - C.slPct / 100));
  if (qty < 1) throw new Error(`المبلغ ${amount.toFixed(2)}$ أقل من سعر سهم واحد`);

  // ⚡ المسار السريع: لو التذكرة مفتوحة والسوق صح → على طول للتنفيذ (من غير تحميل صفحات)
  const want = C.market === 'SA' ? 'SA' : 'US';
  const ready = loggedIn && onMarket(want) && (!C.fundAccount || lastFund === String(C.fundAccount)) && !(await isDemo()) && (await ticketPanel());
  if (!ready) {
    if (!(await ensureLoggedIn())) throw new Error('مش مسجل دخول في سهم — ادخل يدوي في نافذة البوت');
    await dismissPopups();
    if (!(await ensureUSMarket())) throw new Error('صفحة سهم مش على السوق المختار (' + (C.market || 'US') + ')');
  }

  // 1-5) التذكرة جاهزة ومفتوحة (المحفظة + محدد + شراء) → الرمز والسعر والكمية بس
  const t0 = Date.now();
  const panel = await prepareTicket();
  await selectSymbol(panel, symbol);
  await setSide(panel, 'شراء');
  let mkt = useMarketOrder();
  if (mkt && !(await pickIn(panel, 1, /السوق/))) { log('⚠️ نوع "السوق" مش متاح — هستخدم أمر محدد', 'warn'); mkt = false; }
  if (!mkt) await pickIn(panel, 1, /المحدد/);
  const priceField = fieldByLabel(panel, 'السعر');
  if (!mkt) await priceField.fill(String(limit));
  else if (await priceField.isEditable().catch(() => false)) await priceField.fill(String(limit)).catch(() => {});
  await fieldByLabel(panel, 'الكمية').fill(String(qty));
  log(`⚡ التذكرة اتملت في ${((Date.now() - t0) / 1000).toFixed(1)} ث`);
  const selCount = await panel.locator('.n-select:visible').count();
  // 6) الجلسة: نسجل الاختيارات المتاحة (لضبطها بعد أول تجربة)
  const sessionOpts = [];
  if (C.session && selCount > 2) await pickIn(panel, 2, new RegExp(C.session)).catch(() => {});

  // 7) الأمر المرفق: جني الربح / وقف الخسارة
  const before = await panel.locator('input:visible').count();
  let bracketOk = false;
  if (C.autoBracket && selCount > 3) bracketOk = await pickIn(panel, 3, /جني الربح/).catch(() => false);
  if (C.autoBracket && !bracketOk) log('⚠️ خانة الأمر المرفق (هدف/وقف) مش موجودة في التذكرة — الشراء من غير هدف/وقف تلقائي', 'warn');
  await sleep(600);
  const inputs = panel.locator('input:visible');
  const after = await inputs.count();
  const newPh = [];
  for (let i = before; i < after; i++) newPh.push(await inputs.nth(i).getAttribute('placeholder'));
  // أول خانة جديدة = سعر جني الربح، التانية = سعر وقف الخسارة (نتأكد منها في وضع DRY_RUN)
  if (bracketOk && after - before >= 2) {
    await inputs.nth(before).fill(String(tp));
    await inputs.nth(before + 1).fill(String(sl));
  }

  const shot = null;
  const info = { symbol, limit, qty, tp, sl, mkt, sessionOpts, newFields: newPh, shot };
  if (C.dry) await pushShot(`تجربة: شراء ${qty} ${symbol} @ ${limit} | هدف ${tp} | وقف ${sl}`);

  if (C.dry) {
    // وضع التجربة: من غير إرسال — التذكرة تفضل مفتوحة للإشارة الجاية
    return { status: 'dry-run', ...info };
  }

  // 8) إرسال + تأكيد
  if (await isDemo()) throw new Error('الصفحة على التداول التجريبي — الأمر اتلغى');
  await panel.getByText('إرسال الأمر').locator('visible=true').first().click();
  log(`${mkt ? '⚡ أمر سوق' : '🎯 أمر محدد'} — اتضغط "إرسال الأمر" بعد ${((Date.now() - t0) / 1000).toFixed(1)} ث من وصول الإشارة للبوت`);
  await sleep(600);
  if (await page.locator('input[type=password]').count()) {
    throw new Error('سهم طالبة كلمة مرور التداول (قفل التداول) — افتح القفل يدوي في نافذة البوت');
  }
  const confirm = page.getByRole('button', { name: /تأكيد|موافق|إرسال/ }).last();
  if (await confirm.count()) await confirm.click();
  await sleep(800);
  pushShot(`بعد إرسال شراء ${qty} ${symbol}`).catch(() => {});
  return { status: 'sent', ...info };
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
      const search = await openTicketSearch();
      await search.click(); await search.pressSequentially(symbol, { delay: 30 }); await sleep(1500);
      await page.locator(`xpath=//*[normalize-space(text())="${symbol}"][not(ancestor::tr)][not(ancestor::table)]`).locator('visible=true').first().click(); await sleep(1200);
    }
    await sleep(1500);
    // 2) نوع الأمر: محدد
    const sp = await ticketPanel(); if (!sp) throw new Error('تذكرة البيع ما فتحتش');
    await pickIn(sp, 0, lastFund ? new RegExp(lastFund) : /الهامش|الرئيسية/).catch(() => {});
    await pickIn(sp, 1, /المحدد/).catch(() => {});
    await setSide(sp, 'بيع');
    const priceIn = fieldByLabel(sp, 'السعر');
    // 3) السعر والكمية
    await priceIn.fill(String(price));
    await fieldByLabel(sp, 'الكمية').fill(String(qty));
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
    await sp.getByText('إرسال الأمر').locator('visible=true').first().click();
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

// ---------- سجل الأوامر للتحليلات (collection: sahmorders) ----------
async function storeOrders(list, mk) {
  const col = mongoose.connection.collection('sahmorders');
  const pf = await mongoose.connection.collection('sahmportfolio').findOne({ key: 'sahm' }, { projection: { [`${mk}.costs`]: 1 } });
  const costs = (pf && pf[mk] && pf[mk].costs) || {};
  for (const x of list) {
    const o = x.orderInfo || x;
    const id = String(o.entrustId || o.id || x.id || ''); if (!id) continue;
    const side = String(o.entrustBs || '') === '1' ? 'BUY' : String(o.entrustBs || '') === '2' ? 'SELL' : String(o.entrustBs || '');
    const qty = Number(o.entrustQty || o.entrustAmount || 0), filled = Number(o.businessAmount || o.filledQty || 0);
    const avg = Number(o.businessPrice || 0), fee = Number(o.totalFee || 0);
    const t = Number(o.originalEntrustTime || o.originalBusinessTime || o.updateTime || 0);
    const symbol = String(o.stockCode || '');
    const doc = { id, market: mk, fund: String(o.fundAccount || x.fundAccount || ''), symbol, side, qty, price: Number(o.entrustPrice || 0),
      filled, avg, fee, status: String(x.status || o.status || ''), statusDesc: x.statusDesc || o.statusDesc || '',
      time: t ? new Date(t) : null, tradeDate: String(o.tradeDate || ''), updatedAt: new Date() };
    const prev = await col.findOne({ id }, { projection: { cost: 1 } });
    // تكلفة البيع: بنثبّتها أول مرة نشوف الأمر (قبل ما متوسط التكلفة يتغير)
    if (side === 'SELL' && filled > 0 && avg > 0) {
      const cost = prev && prev.cost ? prev.cost : Number(costs[symbol.replace(/\./g, '_')]) || null;
      doc.cost = cost;
      doc.pl = cost ? (avg - cost) * filled - fee : null;
      doc.plPct = cost ? ((avg - cost) / cost) * 100 : null;
      doc.basis = cost ? cost * filled : null;
    }
    await col.updateOne({ id }, { $set: doc }, { upsert: true });
  }
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
  // ⚡ لو متصل أصلاً → "متصل" فوراً
  if (loggedIn && (await isLoggedIn())) { await Settings.updateOne({ key: 'sahm' }, { $set: { brokerLoggedIn: true } }); return setLogin('success', '✅ متصل بسهم'); }
  // ⚡ نجرّب الجلسة المحفوظة الأول (ثواني) قبل ما نطلب كود
  lastSession = null;
  const t = Date.now();
  await applySession().catch(() => {});
  for (let i = 0; i < 16 && lastAssetAt < t; i++) await sleep(500);
  if (lastAssetAt >= t || (await page.getByText('تسجيل الخروج').count().catch(() => 0))) {
    loggedIn = true; await Settings.updateOne({ key: 'sahm' }, { $set: { brokerLoggedIn: true } });
    return setLogin('success', '✅ متصل بسهم (من غير كود)');
  }
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
    else if (cmd.type === 'history') {
      const h = page.getByText('سجل الأوامر').locator('visible=true').first();
      if (await h.count()) { await h.click().catch(() => {}); await sleep(6000); await pushShot('سجل الأوامر'); }
      await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await setLogin(loggedIn ? 'success' : 'idle', 'اتسحب سجل الأوامر من سهم');
    }
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
let busy = Promise.resolve(), tradeChain = Promise.resolve();
// طابور المهام: كل مهمة ليها حد أقصى للوقت — لو علّقت، الطابور يكمّل وما يقفش البوت كله
function enqueue(fn, ms = 3 * 60 * 1000, name = '') {
  busy = busy.then(() => Promise.race([
    Promise.resolve().then(async () => { while (working && !/أوامر/.test(name)) await sleep(300); return fn(); }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + name)), ms)),
  ])).catch((e) => { if (/timeout/.test(e.message)) log(`⏱️ مهمة علّقت واتلغت: ${name}`, 'warn'); working = false; });
  return busy;
}
let loggedIn = false, working = false;
async function handle(sig, Signals) {
  const tag = `${sig.symbol} @ $${sig.price}`;
  // أي تخطي بيتسجّل على الإشارة نفسها عشان يبان في المنصة (سجل التداول)
  const skip = async (msg, level) => {
    await Signals.updateOne({ _id: sig._id }, { $set: { tradeResult: { broker: 'sahm', status: 'skipped', error: msg.replace(/<[^>]+>/g, ''), at: new Date() } } }).catch(() => {});
    return log(msg, level);
  };
  await refreshSettings();
  if (sig.action !== 'BUY') return;
  if (C.paused || fs.existsSync(path.join(__dirname, 'PAUSE'))) return skip(`⏸ البوت متوقف — تخطي ${tag}`);
  // 'sahm-vps' = بوت السيرفر بس (البوت القديم على الكمبيوتر بيتجاهل الإشارات)
  if (!['sahm', 'sahm-vps'].includes(C.broker)) return skip(`الوسيط المختار (${C.broker}) مش مدعوم في البوت ده — تخطي ${tag}`, 'warn');
  if (sig.price < C.minPrice || sig.price > C.maxPrice)
    return skip(`↷ تخطي ${tag}: السعر خارج ${C.minPrice}-${C.maxPrice}$`);
  const pnl = await todayPnl(Signals);
  if (C.dailyProfitTarget > 0 && pnl >= C.dailyProfitTarget) return tg(`🎯 هدف الربح اليومي اتحقق (${pnl.toFixed(2)}$) — تخطي ${tag}`);
  if (C.dailyLossLimit > 0 && pnl <= -C.dailyLossLimit) return tg(`⛔ حد الخسارة اليومي (${pnl.toFixed(2)}$) — تخطي ${tag}`, 'warn');

  const st = loadState();
  if (st.trades >= C.maxPerDay) { tg(`⛔ حد الصفقات اليومي (${C.maxPerDay}) — تخطي ${tag}`); return skip(`⛔ حد الصفقات اليومي (${C.maxPerDay})`); }
  if (st.symbols.includes(sig.symbol)) return skip(`↷ تخطي ${tag}: اتشرى النهارده`);

  try {
    const r = await placeBuy(sig);
    if (r.status === 'sent') { st.trades++; st.symbols.push(sig.symbol); saveState(st); }
    if (r.status === 'sent') await mongoose.connection.collection('botpositions').insertOne({
      symbol: r.symbol, qty: r.qty, entry: Number(sig.price), tp: r.tp, sl: r.sl, signalId: sig._id,
      market: C.market === 'SA' ? 'SA' : 'US', status: 'open', openedAt: new Date() });
    await Signals.updateOne({ _id: sig._id }, { $set: { tradeResult: { broker: 'sahm', ...r, at: new Date() } } });
    tg(
      (r.status === 'sent' ? '✅ <b>اتنفذ على سهم</b>' : '🧪 <b>تجربة (من غير إرسال)</b>') +
      `\n${r.symbol} | كمية ${r.qty} | ${r.mkt ? 'أمر سوق' : 'محدد $' + r.limit}\n🎯 $${r.tp} | 🛑 $${r.sl}` +
      (r.status === 'dry-run' ? `\nالجلسات: ${r.sessionOpts.join(' / ')}\nخانات الهدف/الوقف: ${r.newFields.join(' / ')}` : '')
    );

  } catch (e) {

    await page.screenshot({ path: path.join(SHOTS, `${Date.now()}-${sig.symbol}-error.png`) }).catch(() => {});
    await pushShot(`خطأ في شراء ${sig.symbol}: ${String(e.message).split('\n')[0].slice(0, 80)}`);
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
    const want = (C.market === 'SA' ? 'SA' : 'US') + '|' + (C.fundAccount || '');
    const drift = C.fundAccount && lastFund && lastFund !== String(C.fundAccount);
    if (loggedIn && !working && (want !== appliedMarket || drift) && Date.now() - lastTry > 90 * 1000) {
      lastTry = Date.now();
      enqueue(async () => { if (await ensureUSMarket().catch(() => false)) { appliedMarket = want; await prepareTicket().catch((e) => log('تجهيز التذكرة: ' + e.message, 'warn')); } }, 2 * 60 * 1000, 'تحويل السوق');
    }
  }, 20 * 1000);
  // تحديث المحفظة تلقائياً كل دقيقة: ضغطة على "المحافظ" (أخف من ريفرش الصفحة كلها)
  setInterval(() => {
    if (!loggedIn || working) return;
    enqueue(async () => {
      if (!page || page.isClosed() || working) return;
      const t0 = Date.now();
      const nav = page.getByText('المحافظ', { exact: true }).locator('visible=true').first();
      if (await nav.count()) await nav.click().catch(() => {});
      for (let i = 0; i < 6 && lastAssetAt < t0; i++) await sleep(1000);
      // ريفرش كامل بس لو البيانات واقفة أكتر من 5 دقايق (الريفرش بيقفل التذكرة)
      if (Date.now() - lastAssetAt > 5 * 60 * 1000) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); }
      if (!(await ticketPanel())) await prepareTicket().catch((e) => log('تجهيز التذكرة: ' + e.message, 'warn'));
    }, 90 * 1000, 'تحديث المحفظة');
  }, 60 * 1000);
  beat(); setInterval(async () => { await refreshSettings().catch(() => {}); beat(); }, 60 * 1000);
  await openBrowser();
  // أوامر المنصة (تسجيل الدخول/الرمز) — كل ثانيتين
  let cmdQueued = false;
  setInterval(() => { if (cmdQueued) return; cmdQueued = true; enqueue(() => checkCommands().finally(() => { cmdQueued = false; }), 4 * 60 * 1000, 'أوامر المنصة').then(() => { cmdQueued = false; }); }, 2000);

  // ثواني بس: لو الجلسة المحفوظة اشتغلت، سهم بترد ببيانات الحساب على طول
  for (let i = 0; i < 20 && !lastAssetAt; i++) await sleep(500);
  if (lastAssetAt) { loggedIn = true; await Settings.updateOne({ key: 'sahm' }, { $set: { loginState: 'success', loginMsg: 'متصل (الجلسة المحفوظة)', brokerLoggedIn: true } }); }
  if (!loggedIn && !(await ensureLoggedIn())) {
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
  const seen = new Set();
  const onSignal = (doc) => {
    const id = String(doc._id); if (seen.has(id)) return; seen.add(id);
    log(`📥 إشارة وصلت: ${doc.symbol} @ $${doc.price}`);
    // أولوية: الإشارة ما تستناش في طابور المهام — بتتنفذ فوراً، والمهام التانية بتستنى
    working = true;
    tradeChain = tradeChain.then(async () => { working = true; const t = Date.now(); try { await handle(doc, Signals); } finally { working = false; log(`⏱️ ${doc.symbol}: ${((Date.now() - t) / 1000).toFixed(1)} ث من استلام الإشارة لحد النهاية`); } }).catch(() => { working = false; });
  };
  stream.on('change', (ch) => onSignal(ch.fullDocument));
  // احتياطي: كل 15 ثانية نشوف لو فيه إشارة جديدة (آخر 3 دقايق) ما اتعالجتش — لو الاتصال اللحظي وقع
  const startedAt = new Date();
  setInterval(async () => {
    try {
      // آخر 3 دقايق — حتى اللي وصلت والبوت لسه بيشتغل (بعد ريستارت) بتتنفذ
      const since = new Date(Date.now() - 3 * 60 * 1000);
      const list = await Signals.find({ action: 'BUY', source: { $ne: 'email' }, tradeResult: { $exists: false }, _id: { $gt: mongoose.Types.ObjectId.createFromTime(Math.floor(since.getTime() / 1000)) } }).toArray();
      list.forEach(onSignal);
    } catch (_) {}
  }, 15 * 1000);
  stream.on('error', (e) => { console.error('stream:', e.message); tg('⚠️ انقطع اتصال البوت بقاعدة البيانات — أعد تشغيله'); });

  // مراقبة الصفقات المفتوحة كل ثانيتين: بيع سوق فوراً عند الهدف الأول أو الوقف
  let monBusy = false;
  setInterval(async () => { if (monBusy || !loggedIn) return; monBusy = true; try { await monitorPositions(); } catch (e) { log('مراقبة الصفقات: ' + e.message, 'warn'); } finally { monBusy = false; } }, 2000);

  // ===== إبقاء الجلسة حية =====
  // كل 4 دقايق (لو مفيش أمر شغال): ريفرش لصفحة المحافظ = نشاط على الحساب، فالجلسة ما تقفلش من الخمول
  let sessionStart = Date.now();
  setInterval(async () => {
    if (working) return;
    try {
      await ensureBrowser();
      // لو التذكرة مفتوحة ما نعملش ريفرش (التحديث الدوري كل دقيقة كفاية كنشاط للجلسة)
      if (!(await ticketPanel().catch(() => null))) { await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}); }
      const ok = await ensureLoggedIn();
      if (ok && !loggedIn) { sessionStart = Date.now(); tg('✅ رجع تسجيل الدخول في سهم'); }
      if (ok) await ensureUSMarket().catch(() => {});
      await pushShot('تحديث دوري');
      if (ok) await saveSession().catch(() => {});
      let really = !ok && loggedIn;
      if (really) {
        // تأكيد قبل ما نقول الجلسة انتهت: ريفرش كامل ونستنى بيانات الحساب
        const t = Date.now();
        await page.goto(URL_PORTFOLIO, { waitUntil: 'domcontentloaded' }).catch(() => {});
        for (let i = 0; i < 15 && lastAssetAt < t; i++) await sleep(1000);
        if (lastAssetAt >= t || (await page.getByText('تسجيل الخروج').count().catch(() => 0))) { really = false; log('🔄 الجلسة لسه شغالة (كان إنذار غلط)'); }
      }
      if (really) {
        const hrs = ((Date.now() - sessionStart) / 3600000).toFixed(1);
        tg(`🔐 جلسة سهم انتهت بعد ${hrs} ساعة — هيوصلك رمز تحقق، اكتبه في صفحة التداول الآلي في المنصة`, 'warn');
        // نبدأ تسجيل الدخول تلقائياً بالرقم المحفوظ
        await Settings.updateOne({ key: 'sahm', sahmPhone: { $nin: ['', null] } },
          { $set: { command: { id: Date.now().toString(36), type: 'login', at: new Date() }, loginState: 'sending', loginMsg: 'الجلسة انتهت — جاري طلب رمز جديد' } });
      }
      loggedIn = ok || (loggedIn && !really);
    } catch (e) { log('keep-alive: ' + e.message, 'warn'); }
  }, 4 * 60 * 1000);
})();
