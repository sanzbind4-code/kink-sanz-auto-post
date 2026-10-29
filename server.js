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

const CALLBACK_SECRET =
  process.env.CALLBACK_SECRET || '';

const CHANNEL_LINK =
  process.env.CHANNEL_LINK || '';

const SESSION_DIR = './session';

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';

let channelJid =
  '120363406356211250@newsletter';

let channelName =
  'JAPOST KINKSANZ (GRATIS)';

let lastPost = null;
let reconnectTimer = null;
let sendLock = false;

/* =========================
   EXPRESS
========================= */

app.use(express.json({
  limit: '32mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '32mb'
}));

/* =========================
   HELPER
========================= */

function clean(value) {
  return String(value ?? '').trim();
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function parseImage(value) {
  if (!value) return null;

  let source = String(value).trim();

  if (!source) return null;

  let mime = 'image/jpeg';
  let base64 = source;

  const comma = source.indexOf(',');

  if (
    source.startsWith('data:') &&
    comma !== -1
  ) {
    const header =
      source.slice(0, comma);

    base64 =
      source.slice(comma + 1);

    const match =
      header.match(
        /^data:([^;]+);base64$/i
      );

    if (match) {
      mime = match[1];
    }
  }

  base64 =
    base64.replace(/\s/g, '');

  const buffer =
    Buffer.from(base64, 'base64');

  if (!buffer.length) {
    throw new Error(
      'Foto kosong atau tidak valid.'
    );
  }

  const MAX =
    15 * 1024 * 1024;

  if (buffer.length > MAX) {
    throw new Error(
      'Foto terlalu besar. Maksimal 15 MB.'
    );
  }

  return {
    buffer,
    mime
  };
}

/* =========================
   CAPTION
========================= */

function makeCaption(order) {
  const queueNo =
    clean(order.queueNo);

  const orderCode =
    clean(order.orderCode);

  const format =
    clean(order.format);

  let text = '';

  if (queueNo) {
    text +=
      `NO ANTREAN: #${queueNo}\n`;
  }

  if (orderCode) {
    text +=
      `KODE: ${orderCode}\n`;
  }

  if (text) {
    text += '\n';
  }

  text += format;

  return text.trim();
}

/* =========================
   CHANNEL
========================= */

async function sendToChannel(
  text,
  imageData = ''
) {
  if (!sock) {
    throw new Error(
      'WhatsApp belum tersambung.'
    );
  }

  const image =
    parseImage(imageData);

  let result;

  if (image) {

    result =
      await sock.sendMessage(
        channelJid,
        {
          image: image.buffer,
          mimetype: image.mime,
          caption: text
        }
      );

  } else {

    result =
      await sock.sendMessage(
        channelJid,
        {
          text
        }
      );
  }

  return {
    ok: true,
    messageId:
      result?.key?.id || null,
    mode:
      image ? 'image' : 'text'
  };
}

/* =========================
   STATUS
========================= */

async function sendToStatus(
  text,
  imageData = ''
) {
  if (!sock) {
    throw new Error(
      'WhatsApp belum tersambung.'
    );
  }

  const image =
    parseImage(imageData);

  let result;

  if (image) {

    result =
      await sock.sendMessage(
        'status@broadcast',
        {
          image: image.buffer,
          mimetype: image.mime,
          caption: text
        }
      );

  } else {

    result =
      await sock.sendMessage(
        'status@broadcast',
        {
          text
        }
      );
  }

  return {
    ok: true,
    messageId:
      result?.key?.id || null,
    mode:
      image ? 'image' : 'text'
  };
}

/* =========================
   POST CHANNEL + STATUS
========================= */

async function processPost(
  order
) {
  if (sendLock) {
    throw new Error(
      'Server sedang memproses post lain.'
    );
  }

  sendLock = true;

  try {

    const text =
      makeCaption(order);

    if (!text) {
      throw new Error(
        'Format kosong.'
      );
    }

    const imageData =
      order.photoData ||
      order.photoDataUrl ||
      '';

    const [
      channel,
      status
    ] = await Promise.all([
      sendToChannel(
        text,
        imageData
      ),
      sendToStatus(
        text,
        imageData
      )
    ]);

    lastPost = {
      orderId:
        clean(order.orderId),

      orderCode:
        clean(order.orderCode),

      type:
        clean(order.type),

      at:
        new Date().toISOString(),

      channel,

      status
    };

    return {
      ok: true,
      channel,
      status
    };

  } finally {

    sendLock = false;

  }
}

/* =========================
   TEST POST
========================= */

app.get(
  '/api/test-post',
  async (req, res) => {

    try {

      const result =
        await processPost({
          orderId: 'TEST',
          orderCode: 'TEST',
          type: 'TEST',

          format:
`🧪 TEST POST KINK SANZ

SERVER BERHASIL TERHUBUNG.

SALURAN + STATUS
AUTO POST AKTIF ✅`
        });

      res.json({
        ok: true,
        message:
          'TEST BERHASIL dikirim ke Saluran + Status.',
        ...result
      });

    } catch (error) {

      logger.error(
        error?.stack ||
        error?.message ||
        String(error)
      );

      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          'Test post gagal.'
      });
    }
  }
);

/* =========================
   API JAPOST
========================= */

app.post(
  '/api/japost',
  async (req, res) => {

    try {

      const order =
        req.body || {};

      const result =
        await processPost(order);

      res.json({
        ok: true,
        message:
          'Berhasil post ke Saluran + Status.',
        orderId:
          clean(order.orderId),
        orderCode:
          clean(order.orderCode),
        ...result
      });

    } catch (error) {

      logger.error(
        error?.stack ||
        error?.message ||
        String(error)
      );

      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          'Gagal auto post.'
      });
    }
  }
);

/* =========================
   CALLBACK LAMA
========================= */

app.post(
  '/api/callback',
  async (req, res) => {

    if (!CALLBACK_SECRET) {
      return res.status(500).json({
        ok: false,
        error:
          'CALLBACK_SECRET belum diset.'
      });
    }

    const secret =
      req.get('X-Japost-Secret') || '';

    if (
      secret !== CALLBACK_SECRET
    ) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized.'
      });
    }

    try {

      const result =
        await processPost(
          req.body || {}
        );

      res.json(result);

    } catch (error) {

      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          'Callback gagal.'
      });
    }
  }
);

/* =========================
   STATUS API
========================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({
      ok: true,

      connection:
        connectionState,

      qr:
        Boolean(qrDataUrl),

      channelJid,

      channelName,

      channelLink:
        CHANNEL_LINK,

      channelState:
        channelJid
          ? 'ACTIVE'
          : 'NOT_READY',

      lastPost
    });
  }
);

/* =========================
   HOME
========================= */

app.get(
  '/',
  (req, res) => {

    res.send(`
<!doctype html>

<html lang="id">

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>Kink Sanz Auto Post</title>

<style>

*{
 box-sizing:border-box;
}

body{
 margin:0;
 min-height:100vh;
 background:
 radial-gradient(
   circle at top,
   #123b75,
   #061329 45%,
   #020711
 );
 color:white;
 font-family:Arial,sans-serif;
 display:flex;
 justify-content:center;
 padding:30px 15px;
}

.box{
 width:min(700px,100%);
 padding:25px;
 border-radius:22px;
 background:
 rgba(7,22,48,.95);
 border:
 1px solid rgba(80,180,255,.25);
 box-shadow:
 0 20px 60px rgba(0,0,0,.45);
}

h1{
 margin-top:0;
}

.status{
 margin-top:20px;
 padding:16px;
 border-radius:14px;
 background:#071a36;
 line-height:1.8;
}

a{
 display:block;
 margin-top:15px;
 padding:13px;
 border-radius:12px;
 background:#1267d8;
 color:white;
 text-decoration:none;
 text-align:center;
 font-weight:bold;
}

.test{
 background:#16a085;
}

</style>

</head>

<body>

<div class="box">

<h1>KINK SANZ</h1>

<p>
Auto Post Japost
</p>

<div class="status">

<b>WhatsApp:</b>
<span id="connection">
loading...
</span>

<br>

<b>Channel:</b>
<span id="channel">
loading...
</span>

<br>

<b>QR:</b>
<span id="qr">
loading...
</span>

</div>

<a href="/qr">
TAMPILKAN QR / GANTI WA JB
</a>

<a
class="test"
href="/api/test-post"
target="_blank">

🧪 TEST POST SALURAN + STATUS

</a>

</div>

<script>

async function load(){

 try{

   const r =
     await fetch('/api/status');

   const d =
     await r.json();

   document
     .getElementById('connection')
     .textContent =
     d.connection || '-';

   document
     .getElementById('channel')
     .textContent =
     d.channelName || '-';

   document
     .getElementById('qr')
     .textContent =
     d.qr ? 'TERSEDIA' : 'TIDAK';

 }catch(e){

   console.error(e);

 }

}

load();

setInterval(
 load,
 5000
);

</script>

</body>

</html>
`);
  }
);

/* =========================
   QR
========================= */

app.get(
  '/qr',
  (req, res) => {

    if (!qrDataUrl) {

      return res.send(`
<!doctype html>

<html>

<head>

<meta
charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

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
 color:white;
}

</style>

</head>

<body>

<div class="box">

<h2>QR BELUM TERSEDIA</h2>

<p>
WhatsApp sudah tersambung
atau QR sedang dibuat.
</p>

<a href="/qr">
Refresh
</a>

</div>

</body>

</html>
`);

    }

    res.send(`
<!doctype html>

<html>

<head>

<meta
charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>Scan WhatsApp</title>

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

<img
src="${qrDataUrl}">

<p>
Scan menggunakan WhatsApp JB
yang mau digunakan.
</p>

<a href="/">
Kembali
</a>

</div>

</body>

</html>
`);
  }
);

/* =========================
   WHATSAPP
========================= */

async function startWhatsApp() {

  try {

    connectionState =
      'starting';

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        SESSION_DIR
      );

    sock =
      makeWASocket({

        auth: state,

        logger,

        printQRInTerminal:
          false,

        browser: [
          'Kink Sanz Japost',
          'Chrome',
          '1.0.0'
        ],

        syncFullHistory:
          false,

        markOnlineOnConnect:
          false

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
            await QRCode.toDataURL(
              qr
            );

          connectionState =
            'qr';
        }

        if (
          connection ===
          'connecting'
        ) {

          connectionState =
            'connecting';
        }

        if (
          connection ===
          'open'
        ) {

          connectionState =
            'connected';

          qrDataUrl = '';

          logger.info(
            'WhatsApp connected'
          );
        }

        if (
          connection ===
          'close'
        ) {

          const code =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          const reconnect =
            code !==
            DisconnectReason.loggedOut;

          connectionState =
            'closed';

          if (reconnect) {

            if (reconnectTimer) {
              clearTimeout(
                reconnectTimer
              );
            }

            reconnectTimer =
              setTimeout(
                () => {
                  startWhatsApp()
                    .catch(() => {});
                },
                3000
              );
          }
        }

      }
    );

  } catch (error) {

    connectionState =
      'error';

    logger.error(
      error?.stack ||
      error?.message ||
      String(error)
    );

    reconnectTimer =
      setTimeout(
        () => {
          startWhatsApp()
            .catch(() => {});
        },
        5000
      );
  }
}

/* =========================
   START
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

startWhatsApp()
  .catch(() => {});
