const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let signals = [];

// TradingView بيبعت هنا
app.post('/webhook', (req, res) => {
  const data = req.body;
  console.log('إشارة واردة:', JSON.stringify(data));
  data.receivedAt = new Date().toISOString();
  signals.unshift(data);
  if (signals.length > 100) signals.pop();
  io.emit('signal', data);
  res.json({ ok: true });
});

app.get('/signals', (req, res) => {
  res.json(signals);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('SIGMA Server شغال على بورت', PORT));
