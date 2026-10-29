import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@itsliaaa/baileys';

const app = express();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';

const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';

const SESSION_DIR = './session';

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';

let channelJid = '';
let channelName = '';

let lastPost = null;
let reconnectTimer = null;
let sendLock = false;

/* =========================
   BASIC HELPERS
========================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeType(value) {
  const type = cleanText(value).toUpperCase();

  if (type === 'SELL') return 'SELL';
  if (type === 'BUY') return 'BUY';

  return '';
}

/* =========================
   IMAGE PARSER
========================= */

function parseImage(value) {
  if (!value) return null;

  const source = String(value).trim();

  if (!source) return null;

  let base64 = source;
  let mime = 'image/jpeg';

  /*
    Kalau dikirim dari FileReader.readAsDataURL()
    bentuknya:
    data:image/jpeg;base64,AAAA...
  */

  const comma = source.indexOf(',');

  if (source.startsWith('data:') && comma >= 0) {
    const header = source.slice(0, comma);
    base64 = source.slice(comma + 1);

    const match = header.match(/^data:([^;]+);base64$/i);

    if (match) {
      mime = match[1];
    }
  }

  base64 = base64.replace(/\s/g, '');

  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length) {
    throw new Error('Foto kosong atau tidak valid.');
  }

  /*
    Batas binary 15 MB.
    Tidak resize.
    Tidak re-encode.
    Tidak blur dari server.
  */

  const MAX_IMAGE_SIZE = 15 * 1024 * 1024;

  if (buffer.length > MAX_IMAGE_SIZE) {
    throw new Error('Foto terlalu besar. Maksimal 15 MB.');
  }

  return {
    buffer,
    mime
  };
}

/* =========================
   FORMAT POST
========================= */

function caption(order) {
  const type = normalizeType(order.type);

  const queueNo = cleanText(order.queueNo);
  const orderCode = cleanText(order.orderCode);
  const format = cleanText(order.format);

  let result = '';

  if (queueNo) {
    result += `NO ANTREAN: #${queueNo}\n`;
  }

  if (orderCode) {
    result += `KODE: ${orderCode}\n`;
  }

  if (result) {
    result += '\n';
  }

  if (format) {
    result += format;
  }

  if (type === 'SELL' && !result) {
    result =
      'FORMAT JASA POST KINK SANZ!\n' +
      '( BUKAN MILIK ADMIN )';
  }

  if (type === 'BUY' && !result) {
    result =
      'FORMAT JP NEED KINK SANZ';
  }

  return result.trim();
}

/* =========================
   FIND CHANNEL
========================= */

async function resolveChannel() {
  if (!sock) {
    throw new Error('WhatsApp belum tersambung.');
  }

  /*
    Kalau JID sudah diketahui,
    langsung gunakan.
  */

  if (channelJid) {
    return {
      jid: channelJid,
      name: channelName || 'JAPOST KINKSANZ (GRATIS)'
    };
  }

  /*
    JID channel kamu.
    Ini sengaja dibuat tetap supaya tidak
    bergantung pada pencarian channel.
  */

  channelJid = '120363406356211250@newsletter';

  channelName = 'JAPOST KINKSANZ (GRATIS)';

  return {
    jid: channelJid,
    name: channelName
  };
}

/* =========================
   SEND TO CHANNEL
========================= */

async function rawSendChannel(text, imageData) {
  if (!sock) {
    throw new Error('WhatsApp belum tersambung.');
  }

  const channel = await resolveChannel();

  if (!channel.jid) {
    throw new Error('JID channel tidak ditemukan.');
  }

  let result;

  const image = parseImage(imageData);

  if (image) {
    result = await sock.sendMessage(
      channel.jid,
      {
        image: image.buffer,
        mimetype: image.mime,
        caption: text
      }
    );
  } else {
    result = await sock.sendMessage(
      channel.jid,
      {
        text
      }
    );
  }

  return {
    ok: true,
    messageId: result?.key?.id || null,
    mode: image ? 'image' : 'text'
  };
}

async function sendToChannel(text, imageData) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await rawSendChannel(text, imageData);

      return {
        ...result,
        attempts: attempt
      };
    } catch (error) {
      lastError = error;

      logger.error({
        attempt,
        error: error?.message || String(error)
      }, 'Channel post gagal');

      if (attempt < 3) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastError || new Error('Gagal mengirim ke channel.');
}

/* =========================
   SEND TO WHATSAPP STATUS
========================= */

async function rawSendStatus(text, imageData) {
  if (!sock) {
    throw new Error('WhatsApp belum tersambung.');
  }

  let result;

  const image = parseImage(imageData);

  if (image) {
    result = await sock.sendMessage(
      'status@broadcast',
      {
        image: image.buffer,
        mimetype: image.mime,
        caption: text
      }
    );
  } else {
    result = await sock.sendMessage(
      'status@broadcast',
      {
        text
      }
    );
  }

  return {
    ok: true,
    messageId: result?.key?.id || null,
    mode: image ? 'image' : 'text'
  };
}

async function sendToStatus(text, imageData) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await rawSendStatus(text, imageData);

      return {
        ...result,
        attempts: attempt
      };
    } catch (error) {
      lastError = error;

      logger.error({
        attempt,
        error: error?.message || String(error)
      }, 'Status post gagal');

      if (attempt < 3) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastError || new Error('Gagal mengirim ke status.');
}

/* =========================
   POST KE CHANNEL + STATUS
========================= */

async function processPost(req, res) {
  if (sendLock) {
    return res.status(429).json({
      ok: false,
      error: 'Server sedang memproses post lain. Tunggu sebentar.'
    });
  }

  sendLock = true;

  try {
    const order = req.body || {};

    const type = normalizeType(order.type);

    if (type !== 'SELL' && type !== 'BUY') {
      return res.status(400).json({
        ok: false,
        error: 'Type harus SELL atau BUY.'
      });
    }

    const text = caption(order);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'Format post kosong.'
      });
    }

    const imageData =
      order.photoData ||
      order.photoDataUrl ||
      '';

    /*
      KIRIM KE:
      1. Saluran WhatsApp
      2. Status WhatsApp

      Dilakukan bersamaan.
    */

    const [channelResult, statusResult] =
      await Promise.all([
        sendToChannel(text, imageData),
        sendToStatus(text, imageData)
      ]);

    lastPost = {
      orderId: cleanText(order.orderId),
      orderCode: cleanText(order.orderCode),
      type,
      at: new Date().toISOString(),

      channel: {
        ok: true,
        messageId: channelResult.messageId,
        mode: channelResult.mode,
        attempts: channelResult.attempts
      },

      status: {
        ok: true,
        messageId: statusResult.messageId,
        mode: statusResult.mode,
        attempts: statusResult.attempts
      }
    };

    return res.json({
      ok: true,
      message: 'Berhasil post ke Saluran dan Status WhatsApp.',

      channel: channelResult,
      status: statusResult,

      orderId: cleanText(order.orderId),
      orderCode: cleanText(order.orderCode),
      type
    });

  } catch (error) {
    logger.error({
      error: error?.stack || error?.message || String(error)
    }, 'Process post error');

    return res.status(500).json({
      ok: false,
      error: error?.message || 'Gagal mengirim post.'
    });

  } finally {
    sendLock = false;
  }
}

/* =========================
   SECRET CHECK
========================= */

function checkSecret(req, res, next) {
  if (!CALLBACK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum diset di environment.'
    });
  }

  const received =
    req.get('X-Japost-Secret') || '';

  if (received !== CALLBACK_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized.'
    });
  }

  next();
}

/* =========================
   RATE LIMIT
========================= */

const rateMap = new Map();

function publicRateLimit(req, res, next) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const now = Date.now();

  const old = rateMap.get(ip);

  if (!old || now - old.start > 60_000) {
    rateMap.set(ip, {
      start: now,
      count: 1
    });

    return next();
  }

  old.count++;

  if (old.count > 5) {
    return res.status(429).json({
      ok: false,
      error: 'Terlalu banyak request. Tunggu sebentar.'
    });
  }

  next();
}

/* =========================
   WHATSAPP CONNECTION
========================= */

async function startWhatsApp() {
  try {
    connectionState = 'starting';

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,

      logger,

      printQRInTerminal: false,

      browser: [
        'Kink Sanz Japost',
        'Chrome',
        '1.0.0'
      ],

      syncFullHistory: false,

      markOnlineOnConnect: false
    });

    sock.ev.on(
      'creds.update',
      saveCreds
    );

    sock.ev.on(
      'connection.update',
      async update => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          qrDataUrl =
            await QRCode.toDataURL(qr);

          connectionState = 'qr';
        }

        if (connection === 'connecting') {
          connectionState = 'connecting';
        }

        if (connection === 'open') {
          connectionState = 'connected';

          qrDataUrl = '';

          try {
            await resolveChannel();

            logger.info({
              channelJid,
              channelName
            }, 'Channel berhasil ditemukan');

          } catch (error) {
            logger.error({
              error: error?.message || String(error)
            }, 'Gagal resolve channel');
          }
        }

        if (connection === 'close') {
          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          connectionState = 'closed';

          logger.warn({
            statusCode,
            shouldReconnect
          }, 'WhatsApp disconnected');

          if (shouldReconnect) {
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
            }

            reconnectTimer = setTimeout(() => {
              startWhatsApp().catch(error => {
                logger.error({
                  error: error?.message || String(error)
                }, 'Reconnect gagal');
              });
            }, 3000);
          }
        }
      }
    );

  } catch (error) {
    connectionState = 'error';

    logger.error({
      error: error?.stack || error?.message || String(error)
    }, 'WhatsApp start error');

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      startWhatsApp().catch(() => {});
    }, 5000);
  }
}

/* =========================
   EXPRESS
========================= */

app.use(
  express.json({
    limit: '32mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '32mb'
  })
);

/* =========================
   HOME
========================= */

app.get('/', (req, res) => {
  res.send(`
<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kink Sanz Auto Post</title>

<style>
*{
  box-sizing:border-box;
}

body{
  margin:0;
  min-height:100vh;
  font-family:Arial,sans-serif;
  background:
    radial-gradient(circle at top,#123a75,#061329 45%,#020711);
  color:white;
  display:flex;
  justify-content:center;
  padding:30px 15px;
}

.card{
  width:min(700px,100%);
  background:rgba(8,22,48,.92);
  border:1px solid rgba(80,180,255,.25);
  border-radius:22px;
  padding:25px;
  box-shadow:0 20px 60px rgba(0,0,0,.4);
}

h1{
  margin:0 0 8px;
}

p{
  color:#b9c8dc;
}

.status{
  margin-top:20px;
  padding:15px;
  border-radius:14px;
  background:#071a36;
}

a,button{
  display:inline-block;
  margin-top:15px;
  padding:12px 17px;
  border-radius:12px;
  border:0;
  text-decoration:none;
  cursor:pointer;
  font-weight:bold;
}

a{
  color:white;
  background:#1267d8;
}

button{
  color:white;
  background:#16a085;
}
</style>
</head>

<body>

<div class="card">

<h1>KINK SANZ</h1>

<p>
Pusat Auto Post Japost
</p>

<div class="status">
<b>Status WhatsApp:</b>
<span id="connection">Loading...</span>
<br><br>

<b>Channel:</b>
<span id="channel">Loading...</span>
</div>

<a href="/qr">
  TAMPILKAN QR / GANTI WA JB
</a>

</div>

<script>
async function loadStatus(){

  try{

    const res =
      await fetch('/api/status');

    const data =
      await res.json();

    document.getElementById('connection')
      .textContent =
      data.connection || '-';

    document.getElementById('channel')
      .textContent =
      data.channelName || '-';

  }catch(error){

    document.getElementById('connection')
      .textContent =
      'ERROR';

  }
}

loadStatus();

setInterval(loadStatus,5000);
</script>

</body>
</html>
  `);
});

/* =========================
   QR PAGE
========================= */

app.get('/qr', (req, res) => {

  if (!qrDataUrl) {

    return res.send(`
<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Kink Sanz</title>

<style>
body{
  margin:0;
  min-height:100vh;
  background:#061329;
  color:white;
  font-family:Arial;
  display:flex;
  align-items:center;
  justify-content:center;
  text-align:center;
}

.box{
  padding:30px;
}

a{
  display:inline-block;
  margin-top:20px;
  color:white;
}
</style>
</head>

<body>

<div class="box">

<h2>QR belum tersedia</h2>

<p>
WhatsApp sedang tersambung atau QR sedang dibuat.
</p>

<a href="/qr">
Refresh QR
</a>

</div>

</body>
</html>
    `);
  }

  res.send(`
<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>Scan QR Kink Sanz</title>

<style>
body{
  margin:0;
  min-height:100vh;
  background:#061329;
  color:white;
  font-family:Arial;
  display:flex;
  justify-content:center;
  align-items:center;
  text-align:center;
}

.box{
  padding:25px;
}

img{
  width:min(360px,90vw);
  background:white;
  padding:15px;
  border-radius:20px;
}

a{
  display:block;
  margin-top:20px;
  color:white;
}
</style>
</head>

<body>

<div class="box">

<h2>SCAN QR WHATSAPP</h2>

<img src="${qrDataUrl}" alt="QR WhatsApp">

<p>
Scan menggunakan WhatsApp JB yang mau dipakai.
</p>

<a href="/">
Kembali
</a>

</div>

</body>
</html>
  `);
});

/* =========================
   STATUS API
========================= */

app.get('/api/status', async (req, res) => {

  res.json({
    ok: true,

    connection:
      connectionState,

    qr:
      Boolean(qrDataUrl),

    channelJid:
      channelJid || null,

    channelName:
      channelName || null,

    channelLink:
      CHANNEL_LINK || null,

    channelState:
      channelJid
        ? 'ACTIVE'
        : 'NOT_READY',

    lastPost:
      lastPost
  });

});

/* =========================
   CALLBACK
========================= */

app.post(
  '/api/callback',
  checkSecret,
  processPost
);

/* =========================
   PUBLIC JAPOST
========================= */

app.post(
  '/api/japost',
  publicRateLimit,
  processPost
);

/* =========================
   ERROR HANDLER
========================= */

app.use((error, req, res, next) => {

  logger.error({
    error:
      error?.stack ||
      error?.message ||
      String(error)
  }, 'Express error');

  res.status(500).json({
    ok:false,
    error:
      error?.message ||
      'Internal server error.'
  });

});

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  HOST,
  () => {

    logger.info(
      `Server berjalan di ${HOST}:${PORT}`
    );

  }
);

startWhatsApp().catch(error => {

  logger.error({
    error:
      error?.stack ||
      error?.message ||
      String(error)
  }, 'Gagal menjalankan WhatsApp');

});
