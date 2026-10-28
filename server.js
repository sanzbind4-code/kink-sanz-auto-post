import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = Number(process.env.PORT || 3000);
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';
const sessionDir = './session';

app.use(express.json({ limit: '12mb' }));

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';
let channelJid = '';
let channelName = '';
let lastPost = null;

function channelInviteCode(link) {
  const m = String(link || '').match(/whatsapp\.com\/channel\/([^/?]+)/i);
  return m ? m[1] : '';
}

async function resolveChannel() {
  if (!sock) throw new Error('WhatsApp belum terhubung');
  const code = channelInviteCode(CHANNEL_LINK);
  if (!code) throw new Error('CHANNEL_LINK tidak valid');
  const meta = await sock.newsletterMetadata('invite', code);
  if (!meta?.id) throw new Error('Channel ID tidak ditemukan');
  channelJid = meta.id;
  channelName = meta.name || '';
  return meta;
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
      connectionState = 'scan_qr';
      logger.info('QR baru tersedia di /qr');
    }
    if (connection === 'open') {
      qrDataUrl = '';
      connectionState = 'connected';
      logger.info('WhatsApp terhubung');
      try { await resolveChannel(); logger.info({ channelJid, channelName }, 'Channel terdeteksi'); }
      catch (e) { logger.error({ err: e }, 'Gagal resolve channel'); }
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      connectionState = 'disconnected';
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(connectWhatsApp, 3000);
      }
    }
  });
}

function authCallback(req, res, next) {
  if (!CALLBACK_SECRET || req.get('X-Japost-Secret') !== CALLBACK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function buildCaption(order) {
  return String(order?.format || '')
    .replace(/\r/g, '')
    .trim();
}

app.get('/', (_req, res) => res.send(`
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kink Sanz Auto Post</title>
<style>body{font-family:Arial;background:#07111f;color:#fff;max-width:620px;margin:auto;padding:24px}a,button{background:#10b981;color:#fff;padding:12px 16px;border-radius:10px;border:0;text-decoration:none}pre{white-space:pre-wrap;background:#111c2c;padding:14px;border-radius:10px}.ok{color:#34d399}.bad{color:#fb7185}</style></head>
<body><h1>Kink Sanz Auto Post</h1><p>Status: <b id="s">loading...</b></p><p>Channel: <b id="c">-</b></p><p><a href="/qr">Buka QR WhatsApp</a></p><pre id="l">-</pre>
<script>async function x(){let r=await fetch('/api/status');let d=await r.json();document.querySelector('#s').textContent=d.connection;document.querySelector('#c').textContent=d.channelName||d.channelJid||'-';document.querySelector('#l').textContent=JSON.stringify(d,null,2)}x();setInterval(x,3000)</script></body></html>`));

app.get('/qr', (_req, res) => {
  if (!qrDataUrl) return res.send('<h2 style="font-family:Arial">QR belum tersedia.<br>Cek status WhatsApp.</h2><script>setTimeout(()=>location.reload(),3000)</script>');
  res.send(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan WhatsApp</title><body style="font-family:Arial;text-align:center;background:#07111f;color:#fff;padding:24px"><h2>Scan dari WhatsApp → Perangkat tertaut</h2><img src="${qrDataUrl}" style="width:320px;max-width:90%;background:#fff;padding:12px;border-radius:14px"><p>QR otomatis berubah jika kedaluwarsa.</p><script>setTimeout(()=>location.reload(),15000)</script></body></html>`);
});

app.get('/api/status', (_req, res) => res.json({ ok: true, connection: connectionState, channelJid, channelName, lastPost }));

app.post('/api/resolve-channel', async (_req, res) => {
  try { const meta = await resolveChannel(); res.json({ ok: true, id: meta.id, name: meta.name || '' }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/callback', authCallback, async (req, res) => {
  try {
    const order = req.body || {};
    if (!order.orderId || !order.orderCode || !order.type) return res.status(400).json({ ok: false, error: 'Payload order tidak lengkap' });
    if (!sock || connectionState !== 'connected') return res.status(503).json({ ok: false, error: 'WhatsApp belum terhubung' });

    if (!channelJid) await resolveChannel();
    const caption = buildCaption(order);
    let result;

    if (order.type === 'SELL' && order.photoDataUrl) {
      const comma = order.photoDataUrl.indexOf(',');
      const mimePart = comma >= 0 ? order.photoDataUrl.slice(0, comma) : '';
      const base64 = comma >= 0 ? order.photoDataUrl.slice(comma + 1) : order.photoDataUrl;
      const mime = (mimePart.match(/data:([^;]+);base64/i) || [])[1] || order.photoMime || 'image/jpeg';
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Foto terlalu besar untuk callback (maks 8 MB)');
      result = await sock.sendMessage(channelJid, { image: buffer, mimetype: mime, caption });
    } else {
      result = await sock.sendMessage(channelJid, { text: caption });
    }

    lastPost = { orderId: order.orderId, orderCode: order.orderCode, at: new Date().toISOString() };
    res.json({ ok: true, channelJid, messageId: result?.key?.id || null });
  } catch (e) {
    logger.error({ err: e }, 'Auto post gagal');
    res.status(500).json({ ok: false, error: e.message || 'Auto post gagal' });
  }
});

app.listen(PORT, () => {
  logger.info(`Kink Sanz Auto Post berjalan di port ${PORT}`);
  connectWhatsApp().catch(err => logger.error({ err }, 'Gagal start WhatsApp'));
});
