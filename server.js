// MailTracker Pro - Tracking Server
// Deploy to Railway (railway.app) or Render (render.com) for free
//
// HOW IT WORKS:
// 1. Extension embeds a pixel: <img src="https://YOUR-SERVER/pixel/TRACKING_ID.gif">
// 2. When recipient opens email & loads images, this server receives the request
// 3. Server records the open and stores it
// 4. Extension polls /api/opens/poll every 30s to fetch new opens
// 5. Extension shows notification + updates UI

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory store (persists as long as server runs) ────────────────────────
// For production, swap this with a real DB (Postgres, SQLite, etc.)
const opens = new Map(); // trackingId -> [{ timestamp, userAgent, ip }]
const pendingOpens = new Map(); // extensionKey -> [openEvent] (for polling)

// ─── 1x1 transparent GIF bytes ────────────────────────────────────────────────
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── TRACKING PIXEL ENDPOINT ──────────────────────────────────────────────────
// This is the URL embedded in emails as a 1x1 image
// URL format: /pixel/TRACKING_ID.gif
app.get('/pixel/:trackingId', (req, res) => {
  const trackingId = req.params.trackingId
    .replace('.gif', '')
    .replace('.png', '')
    .trim();

  if (!trackingId || trackingId.length < 5) {
    return sendPixel(res);
  }

  const openEvent = {
    trackingId,
    timestamp: new Date().toISOString(),
    userAgent: req.headers['user-agent'] || 'Unknown',
    ip: req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'Unknown',
  };

  // Store this open
  if (!opens.has(trackingId)) {
    opens.set(trackingId, []);
  }
  opens.get(trackingId).push(openEvent);

  // Queue for all polling extensions
  // (In production, you'd match by user account. Here we broadcast to all pollers.)
  for (const [key, queue] of pendingOpens.entries()) {
    queue.push(openEvent);
  }

  console.log(`📬 Opened: ${trackingId} | ${openEvent.userAgent.slice(0, 60)} | ${openEvent.ip}`);

  sendPixel(res);
});

function sendPixel(res) {
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(TRANSPARENT_GIF);
}

// ─── POLLING ENDPOINT ─────────────────────────────────────────────────────────
// Extension calls this every 30s to check for new opens
// Returns opens since last poll, then clears the queue

app.get('/api/opens/poll', (req, res) => {
  // Use a session key from the extension (or create one)
  const sessionKey = req.headers['x-session-key'] || 'default';

  if (!pendingOpens.has(sessionKey)) {
    pendingOpens.set(sessionKey, []);
  }

  const queue = pendingOpens.get(sessionKey);
  const newOpens = [...queue];
  pendingOpens.set(sessionKey, []); // Clear the queue

  res.json({ opens: newOpens });
});

// ─── GET ALL OPENS FOR A TRACKING ID ─────────────────────────────────────────
app.get('/api/opens/:trackingId', (req, res) => {
  const trackingId = req.params.trackingId;
  const openList = opens.get(trackingId) || [];
  res.json({ trackingId, opens: openList, count: openList.length });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    totalTracked: opens.size,
    totalOpens: [...opens.values()].reduce((sum, arr) => sum + arr.length, 0),
    timestamp: new Date().toISOString(),
  });
});

// ─── ROOT ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const totalTracked = opens.size;
  const totalOpens = [...opens.values()].reduce((sum, arr) => sum + arr.length, 0);
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MailTracker Pro Server</title>
      <style>
        body { font-family: monospace; background: #0a0a0f; color: #e8e8f0; padding: 40px; }
        h1 { color: #6366f1; } code { background: #18181f; padding: 2px 8px; border-radius: 4px; color: #10b981; }
        .stat { display: inline-block; margin: 8px 16px 8px 0; }
        .val { font-size: 2em; font-weight: bold; color: #10b981; }
        .lbl { font-size: 0.8em; color: #6b6b80; }
        a { color: #6366f1; }
      </style>
    </head>
    <body>
      <h1>📬 MailTracker Pro Server</h1>
      <p>Status: <code>running</code> | Uptime: <code>${Math.floor(process.uptime())}s</code></p>
      <div class="stat"><div class="val">${totalTracked}</div><div class="lbl">EMAILS TRACKED</div></div>
      <div class="stat"><div class="val">${totalOpens}</div><div class="lbl">TOTAL OPENS</div></div>
      <hr style="border-color:#22222e; margin: 24px 0">
      <p><strong>Pixel URL format:</strong> <code>GET /pixel/{trackingId}.gif</code></p>
      <p><strong>Poll for new opens:</strong> <code>GET /api/opens/poll</code> (with header <code>x-session-key</code>)</p>
      <p><strong>Health check:</strong> <a href="/health">/health</a></p>
    </body>
    </html>
  `);
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ MailTracker Server running on port ${PORT}`);
  console.log(`   Pixel URL: http://localhost:${PORT}/pixel/{trackingId}.gif`);
  console.log(`   Poll URL:  http://localhost:${PORT}/api/opens/poll`);
});
