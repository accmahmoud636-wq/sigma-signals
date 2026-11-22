#!/usr/bin/env bash
# =====================================================================
#  تثبيت بوت سهم على سيرفر Ubuntu — أمر واحد:
#  curl -fsSL https://raw.githubusercontent.com/accmahmoud636-wq/sigma-signals/main/sahm-bot/install.sh | sudo bash
# =====================================================================
set -e
REPO="https://raw.githubusercontent.com/accmahmoud636-wq/sigma-signals/main/sahm-bot"
DIR="/opt/sahm-bot"

echo "==> [1/5] تحديث النظام وتثبيت Node.js"
apt-get update -y >/dev/null
apt-get install -y curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
echo "    Node $(node -v)"

echo "==> [2/5] تحميل البوت"
mkdir -p "$DIR"
for f in bot.js package.json; do curl -fsSL "$REPO/$f" -o "$DIR/$f"; done

echo "==> [3/5] بيانات الاتصال"
if [ ! -f "$DIR/.env" ]; then
  read -r -p "الصق MONGO_URI (نفس اللي على Render) واضغط Enter: " MONGO < /dev/tty
  echo "MONGO_URI=$MONGO" > "$DIR/.env"
  echo "HEADLESS=true" >> "$DIR/.env"
  chmod 600 "$DIR/.env"
fi

echo "==> [4/5] تثبيت المكتبات والمتصفح (دقايق)"
cd "$DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null
npx -y playwright install --with-deps chromium >/dev/null

echo "==> [5/5] تشغيل البوت كخدمة دائمة"
cat > /etc/systemd/system/sahm-bot.service <<SVC
[Unit]
Description=Sahm Bot (MILLIONAIRE)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload
systemctl enable sahm-bot >/dev/null 2>&1
systemctl restart sahm-bot
sleep 5
systemctl --no-pager --lines=5 status sahm-bot || true

echo ""
echo "✅ خلاص! البوت شغال 24 ساعة."
echo "   افتح المنصة → التداول الآلي → 🔑 دخول سهم"
echo "   متابعة السجل:   journalctl -u sahm-bot -f"
echo "   إعادة تشغيل:    systemctl restart sahm-bot"
echo "   تحديث البوت:    curl -fsSL $REPO/install.sh | sudo bash"
