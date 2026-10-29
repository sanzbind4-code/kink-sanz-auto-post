
import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@itsliaaa/baileys';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';
const SESSION_DIR = './session';

app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Japost-Secret'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

let sock = null;
let connectionState = 'starting';
let qrDataUrl = '';
let channelJid = '';
let channelName = '';
let lastPost = null;
let reconnectTimer = null;
let sendLock = Promise.resolve();
let lastPublicPostAt = 0;

const contacts = new Map();

function normalizeJid(value) {
  return String(value || '').replace(/:\d+(?=@)/, '');
}

function rememberContacts(list = []) {
  for (const item of list) {
    const id = normalizeJid(typeof item === 'string' ? item : item?.id);
    if (id.endsWith('@s.whatsapp.net') || id.endsWith('@lid')) {
      contacts.set(id, true);
    }
  }
}

function inviteCode(link) {
  const match = String(link).match(/whatsapp\.com\/channel\/([^/?]+)/i);
  return match ? match[1] : '';
}

async function refreshChannel() {
  if (!sock) throw new Error('WhatsApp belum terhubung');

  const code = inviteCode(CHANNEL_LINK);
  let meta;

  if (code) {
    meta = await sock.newsletterMetadata('invite', code);
  } else if (CHANNEL_LINK.endsWith('@newsletter')) {
    meta = await sock.newsletterMetadata('jid', CHANNEL_LINK);
  } else {
    throw new Error('CHANNEL_LINK tidak valid');
  }

  if (!meta?.id) throw new Error('Channel tidak ditemukan');
  channelJid = meta.id;
  channelName = meta.name || meta.thread_metadata?.name || '';
  return meta;
}

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('contacts.upsert', rememberContacts);
    sock.ev.on('contacts.update', rememberContacts);
    sock.ev.on('messaging-history.set', data => {
      rememberContacts(data?.contacts || []);
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
        connectionState = 'scan_qr';
      }

      if (connection === 'open') {
        qrDataUrl = '';
        connectionState = 'connected';
        try {
          await refreshChannel();
          logger.info({ channelJid, channelName }, 'WhatsApp dan channel terhubung');
        } catch (e) {
          logger.error({ err: e }, 'Channel belum bisa ditemukan');
        }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        connectionState = 'disconnected';
        sock = null;
        channelJid = '';

        if (code !== DisconnectReason.loggedOut && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startWhatsApp().catch(e => logger.error({ err: e }));
          }, 3000);
        }
      }
    });
  } catch (e) {
    connectionState = 'error';
    logger.error({ err: e }, 'Gagal memulai WhatsApp');
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp().catch(() => {});
      }, 5000);
    }
  }
}

function requireSecret(req, res, next) {
  if (!CALLBACK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum diatur di environment server'
    });
  }

  if (req.get('X-Japost-Secret') !== CALLBACK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Secret tidak cocok' });
  }

  next();
}

function caption(order) {
  return String(order?.format || '').replace(/\r/g, '').trim();
}

function parseImage(dataUrl) {
  if (!dataUrl) return null;

  const value = String(dataUrl);
  const comma = value.indexOf(',');
  const header = comma >= 0 ? value.slice(0, comma) : '';
  const base64 = comma >= 0 ? value.slice(comma + 1) : value;
  const mime = (header.match(/data:([^;]+);base64/i) || [])[1] || 'image/jpeg';

  if (!mime.startsWith('image/')) {
    throw new Error('Data foto bukan format gambar');
  }

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Data foto kosong atau rusak');

  // Batas praktis server untuk mencegah kehabisan memori.
  if (buffer.length > 35 * 1024 * 1024) {
    throw new Error('Foto melebihi batas server 35 MB');
  }

  return { buffer, mime };
}

async function sendToChannel(text, photoData = '') {
  if (!sock || connectionState !== 'connected') {
    throw new Error('WhatsApp belum tersambung');
  }

  if (!channelJid) await refreshChannel();

  const photo = parseImage(photoData);
  const content = photo
    ? { image: photo.buffer, mimetype: photo.mime, caption: text }
    : { text };

  const result = await sock.sendMessage(channelJid, content);
  if (!result?.key?.id) {
    throw new Error('Tidak ada ID pesan dari Saluran WhatsApp');
  }

  return { ok: true, messageId: result.key.id, mode: photo ? 'image' : 'text' };
}

function statusRecipients() {
  const result = new Set(contacts.keys());
  const ownJid = normalizeJid(sock?.user?.id);
  if (ownJid) result.add(ownJid);
  return [...result];
}

async function sendToStatus(text, photoData = '') {
  if (!sock || connectionState !== 'connected') {
    throw new Error('WhatsApp belum tersambung');
  }

  const recipients = statusRecipients();
  if (recipients.length < 2) {
    throw new Error('Kontak belum tersinkron; Status tidak dicoba');
  }

  const photo = parseImage(photoData);
  const content = photo
    ? { image: photo.buffer, mimetype: photo.mime, caption: text }
    : { text };

  const result = await sock.sendMessage(
    'status@broadcast',
    content,
    {
      broadcast: true,
      statusJidList: recipients,
      backgroundColor: '#075985',
      font: 2
    }
  );

  if (!result?.key?.id) {
    throw new Error('WhatsApp tidak mengembalikan ID Status');
  }

  return {
    ok: true,
    messageId: result.key.id,
    mode: photo ? 'image' : 'text',
    recipients: recipients.length
  };
}

async function postBoth(order) {
  const text = caption(order);
  if (!text) throw new Error('Format Japost kosong');

  const photoData = order.photoData || order.photoDataUrl || '';

  // Saluran dan Status dicoba terpisah supaya satu kegagalan tidak
  // menyembunyikan hasil pengiriman yang lain.
  let channel;
  let status;

  try {
    channel = await sendToChannel(text, photoData);
  } catch (e) {
    channel = { ok: false, error: e.message || String(e) };
  }

  try {
    status = await sendToStatus(text, photoData);
  } catch (e) {
    status = { ok: false, error: e.message || String(e) };
  }

  lastPost = {
    orderId: order.orderId || 'TEST',
    orderCode: order.orderCode || order.queueCode || 'TEST',
    at: new Date().toISOString(),
    channel,
    status
  };

  logger.info(lastPost, 'Hasil percobaan auto-post');

  if (!channel.ok && !status.ok) {
    throw new Error(
      `Saluran gagal: ${channel.error || '-'} | Status gagal: ${status.error || '-'}`
    );
  }

  return {
    ok: true,
    orderId: lastPost.orderId,
    orderCode: lastPost.orderCode,
    messageId: channel.messageId || status.messageId,
    channel,
    status,
    partial: !channel.ok || !status.ok
  };
}

app.get('/', (_req, res) => {
  res.type('html').send(`
    <!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Kink Sanz Auto Post</title>
    </head><body style="font-family:Arial;background:#07111f;color:white;padding:24px">
    <h2>Kink Sanz Auto Post</h2>
    <p>Status: <b>${connectionState}</b></p>
    <p>Channel: ${channelName || channelJid || 'belum terdeteksi'}</p>
    ${qrDataUrl ? `<img alt="QR WhatsApp" src="${qrDataUrl}" style="max-width:320px;width:100%">` : ''}
    <pre style="white-space:pre-wrap">${JSON.stringify(lastPost, null, 2)}</pre>
    </body></html>
  `);
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    connectionState,
    channelJid,
    channelName,
    contactCount: contacts.size,
    lastPost
  });
});

app.get('/qr', (_req, res) => {
  if (!qrDataUrl) {
    return res.status(404).send('QR tidak tersedia. Status: ' + connectionState);
  }
  res.type('html').send(
    `<meta name="viewport" content="width=device-width,initial-scale=1"><img src="${qrDataUrl}" style="width:100%;max-width:380px">`
  );
});

// Endpoint dipakai index.html. Ada jeda global untuk mengurangi spam.
app.post('/api/japost', async (req, res) => {
  const now = Date.now();
  if (now - lastPublicPostAt < 8000) {
    return res.status(429).json({
      ok: false,
      error: 'Tunggu beberapa detik sebelum mengirim antrean berikutnya'
    });
  }

  const order = req.body || {};
  if (!['SELL', 'BUY'].includes(String(order.type || '').toUpperCase())) {
    return res.status(400).json({ ok: false, error: 'Jenis harus SELL atau BUY' });
  }
  if (!caption(order)) {
    return res.status(400).json({ ok: false, error: 'Format Japost kosong' });
  }

  lastPublicPostAt = now;
  try {
    const result = await postBoth(order);
    res.json(result);
  } catch (e) {
    logger.error({ err: e }, 'Japost gagal');
    res.status(502).json({
      ok: false,
      error: e.message || 'Auto-post gagal',
      channel: lastPost?.channel || null,
      status: lastPost?.status || null
    });
  }
});

// Endpoint tes harus dipanggil dengan X-Japost-Secret.
app.post('/api/test-post', requireSecret, async (req, res) => {
  try {
    const result = await postBoth({
      orderId: 'TEST',
      orderCode: 'TEST',
      type: 'SELL',
      format: String(req.body?.text || 'TEST AUTO POST KINK SANZ')
    });
    res.json(result);
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: e.message || 'Tes gagal',
      channel: lastPost?.channel || null,
      status: lastPost?.status || null
    });
  }
});

app.listen(PORT, HOST, () => {
  logger.info(`Kink Sanz Auto Post berjalan pada port ${PORT}`);
  startWhatsApp().catch(e => logger.error({ err: e }));
});
    
