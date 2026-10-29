
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
const AUTH_DIR = './auth_info';

const CHANNEL_LINK =
  process.env.CHANNEL_LINK ||
  'https://whatsapp.com/channel/0029VbC8YTVGehEH4EHdMz44';

app.use(express.json({ limit: '20mb' }));

const logger = pino({ level: 'silent' });

let sock = null;
let connection = 'connecting';
let qrText = null;
let channelJid = null;
let channelName = 'JAPOST KINKSANZ (GRATIS)';
let lastPost = null;
let lastError = null;
let starting = false;
let reconnectTimer = null;

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
  if (!sock || connection !== 'connected') {
    throw new Error('WhatsApp belum connected');
  }

  const inviteCode = CHANNEL_LINK.split('/').filter(Boolean).pop();

  const metadata = await sock.newsletterMetadata(
    'invite',
    inviteCode
  );

  channelJid = metadata?.id || null;

  channelName =
    getName(metadata?.name) ||
    getName(metadata?.thread_metadata?.name) ||
    channelName;

  if (!channelJid) {
    throw new Error('Channel JID tidak ditemukan');
  }

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
          console.log('Channel berhasil dideteksi:', channelName);
        } catch (error) {
          lastError = safeError(error);
          console.error('CHANNEL ERROR:', lastError);
        }
      }

      if (update.connection === 'close') {
        const code =
          update.lastDisconnect?.error?.output?.statusCode;

        connection = 'disconnected';
        channelJid = null;
        sock = null;

        console.error('WHATSAPP CLOSED:', code || 'unknown');

        if (code === DisconnectReason.loggedOut) {
          lastError =
            'Sesi WhatsApp logout. Hubungkan kembali melalui QR.';
          return;
        }

        if (reconnectTimer) clearTimeout(reconnectTimer);

        reconnectTimer = setTimeout(() => {
          startWhatsApp().catch(error => {
            lastError = safeError(error);
            console.error('RECONNECT ERROR:', lastError);
          });
        }, 3000);
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
  if (typeof value !== 'string' || !value.trim()) return null;

  const dataUrl = value.match(
    /^data:image\/(jpeg|jpg|png|webp);base64,([\s\S]+)$/i
  );

  if (dataUrl) {
    return {
      image: Buffer.from(dataUrl[2], 'base64'),
      mimetype:
        'image/' +
        dataUrl[1].toLowerCase().replace('jpg', 'jpeg')
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
      throw new Error(
        `Foto gagal diunduh: HTTP ${response.status}`
      );
    }

    const contentType =
      response.headers.get('content-type') || '';

    if (!contentType.startsWith('image/')) {
      throw new Error('URL tidak mengembalikan gambar');
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > 10 * 1024 * 1024) {
      throw new Error('Foto melebihi batas 10 MB');
    }

    return {
      image: buffer,
      mimetype: contentType.split(';')[0]
    };
  }

  if (!parsed.image?.length) {
    throw new Error('Data foto kosong');
  }

  if (parsed.image.length > 10 * 1024 * 1024) {
    throw new Error('Foto melebihi batas 10 MB');
  }

  return parsed;
}

async function sendToChannel(format, photoValue) {
  if (!sock || connection !== 'connected') {
    throw new Error('WhatsApp belum connected');
  }

  if (!channelJid) await resolveChannel();

  const image = await prepareImage(photoValue);

  const payload = image
    ? {
        image: image.image,
        caption: format,
        mimetype: image.mimetype
      }
    : { text: format };

  const result = await sock.sendMessage(channelJid, payload);

  if (!result?.key?.id) {
    throw new Error('ID pesan tidak diterima dari WhatsApp');
  }

  lastPost = {
    time: new Date().toISOString(),
    messageId: result.key.id,
    type: image ? 'image' : 'text'
  };

  lastError = null;

  return {
    messageId: result.key.id,
    channelJid,
    type: image ? 'image' : 'text'
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'Kink Sanz Auto Post' });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: connection === 'connected' && Boolean(channelJid),
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
    return res.status(404).send(
      `QR belum tersedia. Status WhatsApp: ${connection}`
    );
  }

  try {
    const image = await QRCode.toDataURL(qrText);

    res.send(`<!doctype html>
<html lang="id">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Kink Sanz</title>
<body style="font-family:Arial;text-align:center;padding:20px">
<h2>Scan QR Kink Sanz</h2>
<img src="${image}" style="max-width:100%;width:320px">
<p>Buka WhatsApp → Perangkat tertaut → Tautkan perangkat.</p>
</body></html>`);
  } catch (error) {
    res.status(500).send('QR ERROR: ' + safeError(error));
  }
});

app.post('/api/resolve-channel', async (req, res) => {
  try {
    res.json({
      ok: true,
      ...(await resolveChannel())
    });
  } catch (error) {
    lastError = safeError(error);
    res.status(500).json({
      ok: false,
      error: lastError
    });
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
    const result = await sendToChannel(
      'TEST AUTO POST KINK SANZ',
      null
    );

    res.json({
      ok: true,
      ...result,
      note: 'Periksa Channel untuk memastikan pesan terlihat'
    });
  } catch (error) {
    lastError = safeError(error);
    console.error('TEST POST ERROR:', lastError);

    res.status(500).json({
      ok: false,
      error: lastError
    });
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
    const order = req.body?.order || req.body || {};

    const format =
      order.format ||
      order.text ||
      order.caption;

    if (typeof format !== 'string' || !format.trim()) {
      throw new Error('Format posting kosong');
    }

    const photo =
      order.photoDataUrl ||
      order.photoData ||
      order.photo ||
      order.image ||
      null;

    const result = await sendToChannel(format.trim(), photo);

    console.log('AUTO POST ACCEPTED:', result);

    res.json({
      ok: true,
      ...result,
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
<html lang="id">
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kink Sanz Auto Post</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;background:#071629;color:#fff;padding:18px}
main{max-width:650px;margin:auto}
.card{background:#102844;padding:18px;border-radius:14px;margin:12px 0}
button,a{background:#14b8e6;color:#001322;border:0;padding:12px 16px;
border-radius:9px;font-weight:bold;text-decoration:none;display:inline-block;
margin:4px 2px;cursor:pointer}
input{width:100%;padding:12px;border-radius:8px;border:1px solid #496780;
background:#071629;color:#fff;margin:8px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#a9e8ff}
small{color:#c1d4e5}
button:disabled{opacity:.5}
</style>
</head>
<body><main>
<h2>Kink Sanz Auto Post</h2>

<div class="card">
<p>Server: <b>ONLINE</b></p>
<p id="connection">Memuat status...</p>
<p id="channel"></p>
<a href="/qr">SCAN QR WHATSAPP</a>
<button onclick="refreshStatus()">REFRESH STATUS</button>
</div>

<div class="card">
<h3>TEST POST</h3>
<p>Mengirim teks percobaan ke Channel WhatsApp.</p>
<label for="secret">CALLBACK_SECRET FadeHost</label>
<input id="secret" type="password" autocomplete="off"
placeholder="Masukkan secret yang sudah tersimpan">
<small>Jangan bagikan secret kepada siapa pun.</small>
<p><button id="testButton" onclick="testPost()">KIRIM TEST POST</button></p>
<pre id="testResult">Belum ada tes.</pre>
</div>

<div class="card">
<h3>Status JSON</h3>
<pre id="data"></pre>
</div>

<script>
async function refreshStatus(){
  try{
    const response=await fetch('/api/status',{cache:'no-store'});
    const d=await response.json();

    document.getElementById('connection').textContent=
      'WhatsApp: '+d.connection;
    document.getElementById('channel').textContent=
      'Channel: '+d.channelName;
    document.getElementById('data').textContent=
      JSON.stringify(d,null,2);
  }catch(error){
    document.getElementById('data').textContent=String(error);
  }
}

async function testPost(){
  const secret=document.getElementById('secret').value.trim();
  const button=document.getElementById('testButton');
  const output=document.getElementById('testResult');

  if(!secret){
    output.textContent='Masukkan CALLBACK_SECRET terlebih dahulu.';
    return;
  }

  button.disabled=true;
  output.textContent='Mengirim tes...';

  try{
    const response=await fetch('/api/test-post',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-callback-secret':secret
      },
      body:JSON.stringify({})
    });

    const data=await response.json();
    output.textContent=JSON.stringify(data,null,2);

    if(data.ok){
      output.textContent +=
        '\\nPeriksa Channel untuk memastikan pesan terlihat.';
    }

    await refreshStatus();
  }catch(error){
    output.textContent='Request gagal: '+String(error);
  }finally{
    button.disabled=false;
  }
}

refreshStatus();
setInterval(refreshStatus,10000);
</script>
</main></body></html>`);
});

app.listen(PORT, HOST, () => {
  console.log(`Kink Sanz Auto Post listening on ${HOST}:${PORT}`);

  startWhatsApp().catch(error => {
    lastError = safeError(error);
    console.error('WHATSAPP START ERROR:', lastError);
  });
});
    
