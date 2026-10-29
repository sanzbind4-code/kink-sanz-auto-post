
import express from 'express';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@itsliaaa/baileys';

import fs from 'node:fs';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';
const CHANNEL_LINK = process.env.CHANNEL_LINK ||
  'https://whatsapp.com/channel/0029VbC8YTVGehEH4EHdMz44';
const AUTH_DIR = './auth_info';

app.use(express.json({ limit: '20mb' }));

const logger = pino({ level: 'silent' });

let sock;
let connection = 'connecting';
let qrText = null;
let channelJid = null;
let channelName = 'JAPOST KINKSANZ (GRATIS)';
let lastPost = null;
let lastError = null;
let starting = false;

function getName(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.text || value.name || value.title || '';
  }
  return '';
}

function safeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 400);
}

function authorized(req) {
  const secret = process.env.CALLBACK_SECRET;
  if (!secret) return false;

  return (
    req.get('x-callback-secret') === secret ||
    req.get('authorization') === `Bearer ${secret}` ||
    req.body?.secret === secret
  );
}

async function resolveChannel() {
  if (!sock) throw new Error('WhatsApp socket belum tersedia');

  const inviteCode = CHANNEL_LINK.split('/').filter(Boolean).pop();
  const metadata = await sock.newsletterMetadata('invite', inviteCode);

  channelJid = metadata?.id || null;
  channelName =
    getName(metadata?.name) ||
    getName(metadata?.thread_metadata?.name) ||
    channelName;

  if (!channelJid) throw new Error('Channel JID tidak ditemukan');

  return { channelJid, channelName };
}

async function startWhatsApp() {
  if (starting) return;
  starting = true;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Kink Sanz Auto Post', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      if (update.qr) {
        qrText = update.qr;
        connection = 'qr';
      }

      if (update.connection === 'open') {
        connection = 'connected';
        qrText = null;
        lastError = null;

        try {
          await resolveChannel();
          console.log('WhatsApp connected; channel:', channelName);
        } catch (error) {
          lastError = safeError(error);
          console.error('CHANNEL ERROR:', lastError);
        }
      }

      if (update.connection === 'close') {
        connection = 'disconnected';
        sock = null;

        const code = update.lastDisconnect?.error?.output?.statusCode;

        console.error('WHATSAPP CLOSED:', code || 'unknown');

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            startWhatsApp().catch(error => {
              lastError = safeError(error);
              console.error('RECONNECT ERROR:', lastError);
            });
          }, 3000);
        }
      }
    });
  } catch (error) {
    connection = 'error';
    lastError = safeError(error);
    console.error('START ERROR:', lastError);
  } finally {
    starting = false;
  }
}

function parseImage(value) {
  if (typeof value !== 'string' || !value) return null;

  const match = value.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,([\s\S]+)$/i
  );

  if (match) {
    return {
      image: Buffer.from(match[2], 'base64'),
      mimetype: `image/${match[1].toLowerCase().replace('jpg', 'jpeg')}`
    };
  }

  if (/^https?:\/\//i.test(value)) {
    return { url: value };
  }

  const raw = value.replace(/^data:[^,]+,/, '');

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(raw) && raw.length > 100) {
    return {
      image: Buffer.from(raw, 'base64'),
      mimetype: 'image/jpeg'
    };
  }

  return null;
}

async function prepareImage(value) {
  const parsed = parseImage(value);
  if (!parsed) return null;

  if (parsed.url) {
    const response = await fetch(parsed.url);

    if (!response.ok) {
      throw new Error(`Gagal mengunduh foto: HTTP ${response.status}`);
    }

    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/')) {
      throw new Error('URL tidak menghasilkan gambar');
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error('Foto melebihi batas 10 MB');
    }

    return { image: buffer, mimetype: type.split(';')[0] };
  }

  if (!parsed.image?.length) throw new Error('Foto kosong');

  if (parsed.image.length > 10 * 1024 * 1024) {
    throw new Error('Foto melebihi batas 10 MB');
  }

  return parsed;
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: connection === 'connected',
    connection,
    qr: Boolean(qrText),
    channelJid,
    channelName,
    lastPost,
    lastError
  });
});

app.get('/qr', async (req, res) => {
  if (!qrText) {
    return res.status(404).send(`QR belum tersedia. Status: ${connection}`);
  }

  try {
    const image = await QRCode.toDataURL(qrText);

    res.send(`<!doctype html>
<html><meta name="viewport" content="width=device-width">
<body style="font-family:sans-serif;text-align:center;padding:20px">
<h2>Scan QR Kink Sanz</h2>
<img src="${image}" style="max-width:100%;width:320px">
<p>Scan dengan WhatsApp yang akan digunakan untuk posting.</p>
</body></html>`);
  } catch {
    res.status(500).send('Gagal membuat QR');
  }
});

app.post('/api/resolve-channel', async (req, res) => {
  try {
    res.json({ ok: true, ...(await resolveChannel()) });
  } catch (error) {
    lastError = safeError(error);
    res.status(500).json({ ok: false, error: lastError });
  }
});

app.post('/api/test-post', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({
      ok: false,
      error: 'CALLBACK_SECRET tidak cocok atau belum disetel'
    });
  }

  try {
    if (!sock || connection !== 'connected') {
      throw new Error('WhatsApp belum connected');
    }

    if (!channelJid) await resolveChannel();

    const result = await sock.sendMessage(channelJid, {
      text: 'TEST AUTO POST KINK SANZ'
    });

    if (!result?.key?.id) {
      throw new Error('ID pesan tidak diterima');
    }

    lastPost = {
      time: new Date().toISOString(),
      messageId: result.key.id,
      type: 'test'
    };

    lastError = null;
    res.json({
      ok: true,
      messageId: result.key.id,
      note: 'Periksa Channel untuk memastikan pesan terlihat'
    });
  } catch (error) {
    lastError = safeError(error);
    console.error('TEST POST ERROR:', lastError);
    res.status(500).json({ ok: false, error: lastError });
  }
});

app.post('/api/callback', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized: secret tidak cocok'
    });
  }

  try {
    if (!sock || connection !== 'connected') {
      throw new Error('WhatsApp belum connected');
    }

    if (!channelJid) await resolveChannel();

    const order = req.body?.order || req.body || {};
    const format = order.format || order.text || order.caption;

    if (typeof format !== 'string' || !format.trim()) {
      throw new Error('Format posting kosong');
    }

    const photo =
      order.photoDataUrl ||
      order.photoData ||
      order.photo ||
      order.image ||
      null;

    const image = await prepareImage(photo);

    const payload = image
      ? {
          image: image.image,
          caption: format.trim(),
          mimetype: image.mimetype
        }
      : { text: format.trim() };

    const result = await sock.sendMessage(channelJid, payload);

    if (!result?.key?.id) {
      throw new Error('WhatsApp tidak mengembalikan ID pesan');
    }

    lastPost = {
      time: new Date().toISOString(),
      messageId: result.key.id,
      type: image ? 'image' : 'text'
    };

    lastError = null;

    console.log('AUTO POST ACCEPTED:', lastPost);

    res.json({
      ok: true,
      messageId: result.key.id,
      channelJid,
      note: 'Periksa Channel untuk memastikan postingan terlihat'
    });
  } catch (error) {
    lastError = safeError(error);
    console.error('AUTO POST FAILED:', lastError);

    res.status(500).json({
      ok: false,
      error: lastError
    });
  }
});

app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kink Sanz Auto Post</title>
<style>
body{font-family:Arial;background:#071629;color:#fff;padding:22px}
main{max-width:650px;margin:auto}
.card{background:#102844;padding:18px;border-radius:14px;margin:12px 0}
button,a{background:#14b8e6;color:#001322;border:0;padding:12px 16px;
border-radius:9px;font-weight:bold;text-decoration:none;display:inline-block}
pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#a9e8ff}
</style>
</head>
<body><main>
<h2>Kink Sanz Auto Post</h2>
<div class="card">
<p>Server: <b>ONLINE</b></p>
<p id="connection">Memuat...</p>
<p id="channel"></p>
<a href="/qr">SCAN QR WHATSAPP</a>
<button onclick="refreshStatus()">REFRESH STATUS</button>
</div>
<div class="card"><h3>Status JSON</h3><pre id="data"></pre></div>
<script>
async function refreshStatus(){
  try {
    const response = await fetch('/api/status',{cache:'no-store'});
    const d = await response.json();
    document.getElementById('connection').textContent =
      'WhatsApp: '+d.connection;
    document.getElementById('channel').textContent =
      'Channel: '+d.channelName;
    document.getElementById('data').textContent =
      JSON.stringify(d,null,2);
  } catch(e) {
    document.getElementById('data').textContent=String(e);
  }
}
refreshStatus();
setInterval(refreshStatus,10000);
</script>
</main></body></html>`);
});

app.listen(PORT, HOST, () => {
  console.log(`Kink Sanz Auto Post listening on ${HOST}:${PORT}`);
  startWhatsApp();
});
      
