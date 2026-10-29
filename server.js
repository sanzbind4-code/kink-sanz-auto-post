
import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@itsliaaa/baileys';

const app = express();
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';
const SESSION = './session';

app.use(express.json({ limit: '50mb' }));

let sock;
let state = 'starting';
let qr = '';
let channelJid = '';
let channelName = '';
let lastTest = null;
let contacts = new Set();
let starting = false;

function normalizeJid(value) {
  return String(value || '').replace(/:\d+(?=@)/, '');
}

function getChannelId(meta) {
  if (typeof meta?.id === 'string') return meta.id;
  if (typeof meta?.id?._serialized === 'string') {
    return meta.id._serialized;
  }
  return '';
}

function rememberContacts(list = []) {
  for (const item of list) {
    const id = normalizeJid(typeof item === 'string' ? item : item?.id);
    if (id.endsWith('@s.whatsapp.net') || id.endsWith('@lid')) {
      contacts.add(id);
    }
  }
}

function getInviteCode(link) {
  return link.match(/whatsapp\.com\/channel\/([^/?]+)/i)?.[1] || '';
}

async function refreshChannel() {
  if (!sock) throw new Error('WhatsApp belum terhubung');

  const code = getInviteCode(CHANNEL_LINK);
  let meta;

  if (code) {
    meta = await sock.newsletterMetadata('invite', code);
  } else if (CHANNEL_LINK.endsWith('@newsletter')) {
    meta = await sock.newsletterMetadata('jid', CHANNEL_LINK);
  } else {
    throw new Error('CHANNEL_LINK tidak valid');
  }

  const jid = getChannelId(meta);
  if (!jid || !jid.endsWith('@newsletter')) {
    throw new Error('ID Saluran tidak valid: ' + JSON.stringify(meta?.id ?? null));
  }

  channelJid = jid;
  channelName =
    typeof meta.name === 'string'
      ? meta.name
      : typeof meta.thread_metadata?.name === 'string'
        ? meta.thread_metadata.name
        : 'Saluran WhatsApp';

  return { jid: channelJid, name: channelName };
}

async function connectWhatsApp() {
  if (starting) return;
  starting = true;

  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION);

    sock = makeWASocket({
      auth,
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

    sock.ev.on('connection.update', async update => {
      if (update.qr) {
        qr = await QRCode.toDataURL(update.qr);
        state = 'scan_qr';
      }

      if (update.connection === 'open') {
        state = 'connected';
        qr = '';
        try {
          await refreshChannel();
          log.info({ channelJid, channelName }, 'Channel siap');
        } catch (err) {
          log.error({ err: err.message }, 'Channel belum siap');
        }
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        state = 'disconnected';
        sock = null;
        channelJid = '';
        starting = false;

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => connectWhatsApp().catch(err => log.error({ err })), 3000);
        }
      }
    });
  } catch (err) {
    starting = false;
    state = 'error';
    log.error({ err }, 'Koneksi WhatsApp gagal');
    setTimeout(() => connectWhatsApp().catch(() => {}), 5000);
  }
}

function auth(req, res, next) {
  if (!SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum diatur di environment'
    });
  }
  if (req.get('X-Japost-Secret') !== SECRET) {
    return res.status(401).json({ ok: false, error: 'Secret tidak cocok' });
  }
  next();
}

function parsePhoto(data) {
  if (!data) return null;

  const value = String(data);
  const comma = value.indexOf(',');
  const header = comma >= 0 ? value.slice(0, comma) : '';
  const base64 = comma >= 0 ? value.slice(comma + 1) : value;
  const mime = header.match(/data:([^;]+);base64/i)?.[1] || 'image/jpeg';

  if (!mime.startsWith('image/')) throw new Error('File bukan gambar');

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Foto kosong/rusak');
  if (buffer.length > 35 * 1024 * 1024) {
    throw new Error('Foto melebihi batas server 35 MB');
  }

  // Tidak melakukan resize atau kompresi pada foto.
  return { buffer, mime };
}

function getContent(text, photoData) {
  const photo = parsePhoto(photoData);
  return photo
    ? { image: photo.buffer, mimetype: photo.mime, caption: text }
    : { text };
}

async function testChannel(text, photoData = '') {
  if (!sock || state !== 'connected') throw new Error('WhatsApp belum terhubung');
  await refreshChannel();

  const result = await sock.sendMessage(
    channelJid,
    getContent(text, photoData)
  );

  if (!result?.key?.id) throw new Error('ID pesan Saluran tidak dikembalikan');

  return {
    ok: true,
    channelJid,
    channelName,
    messageId: result.key.id,
    mode: photoData ? 'image' : 'text'
  };
}

async function testStatus(text, photoData = '') {
  if (!sock || state !== 'connected') throw new Error('WhatsApp belum terhubung');

  const recipients = new Set(contacts);
  const ownJid = normalizeJid(sock.user?.id);
  if (ownJid) recipients.add(ownJid);

  if (recipients.size < 2) {
    throw new Error('Kontak belum tersinkron. Status tidak dikirim.');
  }

  const result = await sock.sendMessage(
    'status@broadcast',
    getContent(text, photoData),
    {
      broadcast: true,
      statusJidList: [...recipients],
      backgroundColor: '#075985',
      font: 2
    }
  );

  if (!result?.key?.id) throw new Error('ID pesan Status tidak dikembalikan');

  return {
    ok: true,
    messageId: result.key.id,
    mode: photoData ? 'image' : 'text',
    recipients: recipients.size
  };
}

app.get('/', (_req, res) => {
  res.type('html').send(`
    <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:Arial;background:#07111f;color:white;padding:24px">
    <h2>Kink Sanz Auto Post</h2>
    <p>Status koneksi: <b>${state}</b></p>
    <p>Channel: ${channelName || 'Belum terbaca'}</p>
    <p>Channel ID: ${channelJid || 'Belum tersedia'}</p>
    ${qr ? `<img src="${qr}" style="max-width:320px;width:100%">` : ''}
    <h3>Hasil tes terakhir</h3><pre>${JSON.stringify(lastTest, null, 2)}</pre>
    <p>Tes API: POST /api/test-channel dan POST /api/test-status</p>
    </body></html>
  `);
});

app.get('/qr', (_req, res) => {
  if (!qr) return res.status(404).send('QR tidak tersedia. Status: ' + state);
  res.type('html').send(`<img src="${qr}" style="width:100%;max-width:320px">`);
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    connection: state,
    channelJid,
    channelName,
    contactsLoaded: contacts.size,
    lastTest
  });
});

// Tes Saluran: POST /api/test-channel
app.post('/api/test-channel', auth, async (req, res) => {
  try {
    const result = await testChannel(
      String(req.body?.text || 'TES SALURAN KINK SANZ'),
      req.body?.photoData || ''
    );
    lastTest = { at: new Date().toISOString(), target: 'channel', ...result };
    log.info(lastTest, 'Tes Saluran selesai');
    res.json(lastTest);
  } catch (err) {
    lastTest = {
      at: new Date().toISOString(),
      target: 'channel',
      ok: false,
      error: err.message
    };
    log.error(lastTest, 'Tes Saluran gagal');
    res.status(502).json(lastTest);
  }
});

// Tes SW/Status: POST /api/test-status
app.post('/api/test-status', auth, async (req, res) => {
  try {
    const result = await testStatus(
      String(req.body?.text || 'TES STATUS KINK SANZ'),
      req.body?.photoData || ''
    );
    lastTest = { at: new Date().toISOString(), target: 'status', ...result };
    log.info(lastTest, 'Tes Status selesai');
    res.json(lastTest);
  } catch (err) {
    lastTest = {
      at: new Date().toISOString(),
      target: 'status',
      ok: false,
      error: err.message
    };
    log.error(lastTest, 'Tes Status gagal');
    res.status(502).json(lastTest);
  }
});

// Endpoint yang dipanggil index.html
app.post('/api/japost', async (req, res) => {
  try {
    const order = req.body || {};
    const text = String(order.format || '').trim();

    if (!['SELL', 'BUY'].includes(String(order.type || '').toUpperCase())) {
      return res.status(400).json({ ok: false, error: 'Jenis harus SELL atau BUY' });
    }
    if (!text) return res.status(400).json({ ok: false, error: 'Format kosong' });

    const results = {};

    try {
      results.channel = await testChannel(text, order.photoData || '');
    } catch (err) {
      results.channel = { ok: false, error: err.message };
    }

    try {
      results.status = await testStatus(text, order.photoData || '');
    } catch (err) {
      results.status = { ok: false, error: err.message };
    }

    lastTest = {
      at: new Date().toISOString(),
      target: 'japost',
      orderId: order.orderId || '',
      orderCode: order.orderCode || '',
      ...results
    };

    const anyOk = results.channel.ok || results.status.ok;
    res.status(anyOk ? 200 : 502).json({
      ok: anyOk,
      partial: anyOk && !(results.channel.ok && results.status.ok),
      ...lastTest
    });
  } catch (err) {
    log.error({ err }, 'Japost gagal');
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan' });
});

app.listen(PORT, '0.0.0.0', () => {
  log.info(`Kink Sanz Auto Post berjalan di port ${PORT}`);
  connectWhatsApp().catch(err => log.error({ err }));
});
    
