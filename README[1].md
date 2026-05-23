# SIGMA · لوحة إشارات التداول

## رفع على Render.com (مجاني)

1. ارفع هذا المجلد على GitHub
2. اذهب لـ render.com ← New Web Service
3. اربط الـ Repository
4. Build Command: `npm install`
5. Start Command: `npm start`
6. اضغط Deploy

## الـ Webhook URL
بعد الرفع هيكون:
```
https://sigma-signals.onrender.com/webhook
```
حطّه في TradingView Alert

## JSON المطلوب من TradingView
```json
{
  "action": "BUY",
  "symbol": "{{ticker}}",
  "price": {{close}},
  "sl": 0,
  "tp": 0,
  "strategy": "EMA Cross"
}
```
