// emailImporter.js
// يقرأ إيميلات تنبيهات TradingView من Gmail تلقائياً، ويحفظها كإشارات في MongoDB
// - أول تشغيل: يستورد إشارات آخر N يوم (الأسبوع اللي فات مثلاً)
// - بعد كده: يسمع الإيميل لحظياً (IMAP IDLE) ويضيف أي إشارة أول ما توصل
// - الإشارات المستوردة عليها source = "email" ولا يتم تنفيذ أي صفقة منها
//
// المتطلبات:  npm i imapflow mailparser
// متغيرات البيئة على Render:
//   GMAIL_USER=you@gmail.com
//   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   (App Password من إعدادات Google، مش باسورد الإيميل)
//   EMAIL_IMPORT_DAYS=7        (عدد الأيام اللي يستوردها أول مرة)

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const num = (m) => (m ? parseFloat(m[1]) : null);

// ===== قراءة نص التنبيه =====
// يدعم صيغتين: رسالة JSON (صيغة المنصة) أو رسالة المؤشر العربية
function parseAlert(text) {
  if (!text) return null;

  // 1) JSON: {"action":"BUY","symbol":"HIHO","price":1.58,"sl":..,"tp":..,"strategy":".."}
  const j = text.match(/\{[\s\S]*?"action"[\s\S]*?\}/);
  if (j) {
    try {
      const o = JSON.parse(j[0]);
      if (o.symbol || o.ticker) {
        return {
          action: String(o.action || 'BUY').toUpperCase(),
          symbol: String(o.symbol || o.ticker).toUpperCase(),
          price: Number(o.price ?? o.signalPrice) || null,
          sl: o.sl != null ? Number(o.sl) : null,
          tp: o.tp != null ? Number(o.tp) : null,
          tp2: null,
          strategy: o.strategy || 'TradingView',
        };
      }
    } catch (_) { /* مش JSON صالح — نجرب الصيغة العربية */ }
  }

  // 2) رسالة المؤشر: "🟢 إشارة شراء: HIHO / سعر الدخول المقترح: 1.58 / الهدف الأول (+5%): 1.66 ..."
  const sym = text.match(/إشارة شراء:\s*([A-Z0-9.\-]+)/i);
  if (!sym) return null;
  return {
    action: 'BUY',
    symbol: sym[1].toUpperCase(),
    price: num(text.match(/سعر الدخول المقترح:\s*([\d.]+)/)),
    sl: null,
    tp: num(text.match(/الهدف الأول[^:]*:\s*([\d.]+)/)),
    tp2: num(text.match(/الهدف الثاني[^:]*:\s*([\d.]+)/)),
    rsi: num(text.match(/RSI:\s*([\d.]+)/)),
    strategy: 'RSI7 Buy',
  };
}

// ===== حفظ رسالة واحدة =====
async function saveMessage(SignalModel, msg, onNew) {
  const mail = await simpleParser(msg.source);
  const sig = parseAlert(mail.text || '');
  if (!sig || !sig.price) return false;

  const when = mail.date || msg.internalDate || new Date();
  const sourceId = mail.messageId || `${msg.uid}-${when}`;

  // نفس الإشارة وصلت بالـ Webhook قبل كده (نفس السهم والسعر خلال ±3 دقايق)؟ → تجاهل
  const t = new Date(when).getTime();
  const dup = await SignalModel.findOne({
    symbol: sig.symbol,
    price: sig.price,
    receivedAt: { $gte: new Date(t - 180000), $lte: new Date(t + 180000) },
  }).lean();
  if (dup) return false;

  // upsert بالـ sourceId → نفس الإيميل ما يتسجلش مرتين
  // نشيل الحقول الفاضية (مثلاً المؤشر ما بيبعتش وقف خسارة)
  const fields = Object.fromEntries(Object.entries(sig).filter(([, v]) => v != null));
  const res = await SignalModel.updateOne(
    { sourceId },
    {
      $setOnInsert: {
        ...fields,
        sourceId,
        source: 'email',
        currentPrice: sig.price,
        status: 'open',
        receivedAt: when,
      },
    },
    { upsert: true }
  );
  if (res.upsertedCount) {
    console.log(`📧 إشارة من الإيميل: ${sig.symbol} @ $${sig.price}`);
    if (onNew) onNew(sig).catch(() => {});
    return true;
  }
  return false;
}

const newClient = () =>
  new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });

const FETCH_FIELDS = { source: true, envelope: true, internalDate: true, uid: true };

// ===== استيراد القديم (مرة واحدة عند التشغيل) =====
async function backfill(SignalModel, sinceDate) {
  const client = newClient();
  let added = 0;
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    for await (const msg of client.fetch({ from: 'tradingview.com', since: sinceDate }, FETCH_FIELDS)) {
      if (await saveMessage(SignalModel, msg)) added++;
    }
  } finally {
    lock.release();
    await client.logout();
  }
  console.log(`[email-import] الاستيراد الأولي: ${added} إشارة`);
}

// ===== الاستماع اللحظي (IMAP IDLE) =====
// اتصال مفتوح دايماً مع Gmail؛ أول ما إيميل يوصل، Gmail يبلّغ السيرفر فوراً
let lastUid = 0; // محفوظ بين مرات إعادة الاتصال عشان ما يفوتش إيميل وصل وقت الانقطاع

async function listen(SignalModel, onNew) {
  const client = newClient();
  let busy = false;

  const fetchNew = async () => {
    if (busy) return;
    busy = true;
    try {
      for await (const msg of client.fetch(
        { uid: `${lastUid + 1}:*`, from: 'tradingview.com' },
        FETCH_FIELDS,
        { uid: true }
      )) {
        if (msg.uid <= lastUid) continue;
        lastUid = msg.uid;
        await saveMessage(SignalModel, msg, onNew);
      }
    } catch (e) {
      console.error('[email-import] خطأ في القراءة:', e.message);
    } finally {
      busy = false;
    }
  };

  client.on('exists', fetchNew); // إيميل جديد وصل
  client.on('error', (e) => console.error('[email-import] خطأ اتصال:', e.message));
  client.on('close', () => {
    console.log('[email-import] الاتصال اتقفل — إعادة الاتصال بعد 5 ثواني');
    setTimeout(() => listen(SignalModel, onNew).catch(() => {}), 5000);
  });

  await client.connect();
  const box = await client.mailboxOpen('INBOX');
  if (!lastUid) lastUid = (box.uidNext || 1) - 1; // أول مرة: نبدأ من اللي هيوصل بعد اللحظة دي
  else await fetchNew(); // بعد انقطاع: نجيب اللي وصل وقت ما كان الاتصال مقفول
  console.log('[email-import] بيسمع الإيميلات لحظياً...');
  // imapflow بيدخل وضع IDLE تلقائياً وبيجدده قبل ما Gmail يقفله
}

// ===== التشغيل =====
function startEmailImporter(SignalModel, { onNew } = {}) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('[email-import] متوقف: GMAIL_USER / GMAIL_APP_PASSWORD مش موجودين');
    return;
  }
  const days = Number(process.env.EMAIL_IMPORT_DAYS || 7);

  backfill(SignalModel, new Date(Date.now() - days * 24 * 60 * 60 * 1000))
    .catch((e) => console.error('[email-import] خطأ في الاستيراد الأولي:', e.message))
    .finally(() =>
      listen(SignalModel, onNew).catch((e) => {
        console.error('[email-import] فشل الاتصال:', e.message);
        setTimeout(() => startEmailImporter(SignalModel, { onNew }), 30000);
      })
    );
}

module.exports = { startEmailImporter, parseAlert };
