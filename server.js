const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const opens = new Map();        // trackingId -> [openEvent]
const sentMeta = new Map();     // trackingId -> { sentAt, senderIp, sessionKey }
const pendingOpens = new Map(); // sessionKey -> [openEvent]

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// Bots/scanners that are never real recipients
const BOT_UA = [
  'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'facebookexternalhit',
  'twitterbot', 'linkedinbot', 'whatsapp', 'telegrambot', 'applebot',
  'scanner', 'crawler', 'spider', 'headlesschrome', 'phantomjs',
];

function isBot(ua) {
  const u = ua.toLowerCase();
  return BOT_UA.some(b => u.includes(b));
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Register sent email + sender IP ─────────────────────────────────────────
// Called by extension immediately after sending
app.post('/api/sent', (req, res) => {
  const { trackingId, sentAt, sessionKey } = req.body;
  const senderIp = getIp(req);
  if (trackingId) {
    sentMeta.set(trackingId, {
      sentAt: sentAt ? new Date(sentAt).getTime() : Date.now(),
      senderIp,
      sessionKey: sessionKey || null,
    });
    console.log(`📤 Registered: ${trackingId} | sender IP: ${senderIp}`);
  }
  res.json({ success: true });
});

// ─── TRACKING PIXEL ───────────────────────────────────────────────────────────
app.get('/pixel/:trackingId', (req, res) => {
  // Always send pixel immediately — don't make recipient wait
  sendPixel(res);

  const trackingId = req.params.trackingId.replace(/\.(gif|png|jpg)$/i, '').trim();
  if (!trackingId || trackingId.length < 5) return;

  const ua = req.headers['user-agent'] || 'Unknown';
  const ip = getIp(req);
  const now = Date.now();

  // Skip bots/scanners
  if (isBot(ua)) {
    console.log(`🤖 Bot ignored: ${trackingId} | ${ua.slice(0, 50)}`);
    return;
  }

  const meta = sentMeta.get(trackingId);

  // Skip if open happens within 15 seconds of sending (self-open on send)
  if (meta && (now - meta.sentAt) < 15000) {
    console.log(`⏱ Too soon after send (${now - meta.sentAt}ms), ignored: ${trackingId}`);
    return;
  }

  // Skip if IP matches sender's IP (sender viewing their own sent mail)
  if (meta?.senderIp && ip === meta.senderIp) {
    console.log(`🚫 Sender self-open ignored: ${trackingId} | IP: ${ip}`);
    return;
  }

  // Deduplicate: same IP+UA within 5 minutes = same open event
  if (!opens.has(trackingId)) opens.set(trackingId, []);
  const existing = opens.get(trackingId);
  const isDupe = existing.some(o => {
    const age = now - new Date(o.timestamp).getTime();
    return o.ip === ip && age < 300000; // 5 min
  });
  if (isDupe) {
    console.log(`🔁 Duplicate ignored: ${trackingId}`);
    return;
  }

  const openEvent = { trackingId, timestamp: new Date().toISOString(), userAgent: ua, ip };
  existing.push(openEvent);

  // Queue for polling
  for (const queue of pendingOpens.values()) queue.push(openEvent);

  console.log(`📬 OPEN: ${trackingId} | ${ua.slice(0, 60)} | ${ip}`);
});

function sendPixel(res) {
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(TRANSPARENT_GIF);
}

// ─── POLLING ─────────────────────────────────────────────────────────────────
app.get('/api/opens/poll', (req, res) => {
  const sessionKey = req.headers['x-session-key'] || 'default';
  if (!pendingOpens.has(sessionKey)) pendingOpens.set(sessionKey, []);
  const newOpens = [...pendingOpens.get(sessionKey)];
  pendingOpens.set(sessionKey, []);
  res.json({ opens: newOpens });
});

app.get('/api/opens/:trackingId', (req, res) => {
  const list = opens.get(req.params.trackingId) || [];
  res.json({ trackingId: req.params.trackingId, opens: list, count: list.length });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    totalTracked: opens.size,
    totalOpens: [...opens.values()].reduce((s, a) => s + a.length, 0),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  const total = [...opens.values()].reduce((s, a) => s + a.length, 0);
  res.send(`<html><body style="font-family:monospace;background:#0a0a0f;color:#e8e8f0;padding:40px">
    <h1 style="color:#6366f1">📬 MailTracker Pro</h1>
    <p>Status: <code style="background:#18181f;padding:2px 8px;color:#10b981">running</code> | Uptime: ${Math.floor(process.uptime())}s</p>
    <p>Tracked: <b style="color:#10b981">${opens.size}</b> emails &nbsp;·&nbsp; <b style="color:#10b981">${total}</b> opens</p>
    <p><a href="/health" style="color:#6366f1">/health</a></p>
  </body></html>`);
});

app.listen(PORT, () => console.log(`✅ MailTracker Server on port ${PORT}`));
