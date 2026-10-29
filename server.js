import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

const app = express();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const PORT = Number(process.env.PORT || 3000);
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';
const sessionDir = './session';

/* =========================
   CORS
========================= */

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-Japost-Secret'
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

/* =========================
   BODY
========================= */

app.use(express.json({
  limit: '12mb'
}));

/* =========================
   VARIABLES
========================= */

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';

let channelJid = '';
let channelName = '';

let lastPost = null;

/* =========================
   CHANNEL
========================= */

function channelInviteCode(link) {
  const m = String(link || '').match(
    /whatsapp\.com\/channel\/([^/?]+)/i
  );

  return m ? m[1] : '';
}

async function resolveChannel() {
  if (!sock) {
    throw new Error('WhatsApp belum terhubung');
  }

  const code = channelInviteCode(CHANNEL_LINK);

  if (!code) {
    throw new Error('CHANNEL_LINK tidak valid');
  }

  const meta = await sock.newsletterMetadata(
    'invite',
    code
  );

  if (!meta?.id) {
    throw new Error('Channel ID tidak ditemukan');
  }

  channelJid = meta.id;
  channelName = meta.name || '';

  return meta;
}

/* =========================
   WHATSAPP
========================= */

async function connectWhatsApp() {
  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      logger: pino({
        level: 'silent'
      })
    });

    sock.ev.on(
      'creds.update',
      saveCreds
    );

    sock.ev.on(
      'connection.update',
      async ({
        connection,
        lastDisconnect,
        qr
      }) => {

        /* QR */

        if (qr) {
          qrDataUrl = await QRCode.toDataURL(
            qr,
            {
              margin: 2,
              width: 320
            }
          );

          connectionState = 'scan_qr';

          logger.info(
            'QR baru tersedia di /qr'
          );
        }

        /* CONNECTED */

        if (connection === 'open') {
          qrDataUrl = '';
          connectionState = 'connected';

          logger.info(
            'WhatsApp terhubung'
          );

          try {
            await resolveChannel();

            logger.info(
              {
                channelJid,
                channelName
              },
              'Channel terdeteksi'
            );

          } catch (e) {

            logger.error(
              {
                err: e
              },
              'Gagal resolve channel'
            );
          }
        }

        /* DISCONNECTED */

        if (connection === 'close') {

          const statusCode =
            lastDisconnect?.error
              ?.output?.statusCode;

          connectionState =
            'disconnected';

          logger.warn(
            {
              statusCode
            },
            'WhatsApp terputus'
          );

          if (
            statusCode !==
            DisconnectReason.loggedOut
          ) {

            setTimeout(
              () => {
                connectWhatsApp().catch(
                  err =>
                    logger.error(
                      {
                        err
                      },
                      'Reconnect gagal'
                    )
                );
              },
              3000
            );

          } else {

            logger.error(
              'WhatsApp logout. Scan QR kembali.'
            );
          }
        }
      }
    );

  } catch (e) {

    connectionState = 'error';

    logger.error(
      {
        err: e
      },
      'Gagal menjalankan WhatsApp'
    );

    setTimeout(
      connectWhatsApp,
      5000
    );
  }
}

/* =========================
   AUTH CALLBACK
========================= */

function authCallback(req, res, next) {

  if (!CALLBACK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum diset di environment'
    });
  }

  const receivedSecret =
    req.get('X-Japost-Secret');

  if (
    receivedSecret !==
    CALLBACK_SECRET
  ) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  next();
}

/* =========================
   CAPTION
========================= */

function buildCaption(order) {

  return String(
    order?.format || ''
  )
    .replace(/\r/g, '')
    .trim();
}

/* =========================
   HOME
========================= */

app.get('/', (_req, res) => {

  res.send(`
<!doctype html>

<html>

<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Kink Sanz Auto Post</title>

<style>

body{
  font-family:Arial;
  background:#07111f;
  color:#fff;
  max-width:620px;
  margin:auto;
  padding:24px;
}

a,button{
  background:#10b981;
  color:#fff;
  padding:12px 16px;
  border-radius:10px;
  border:0;
  text-decoration:none;
}

pre{
  white-space:pre-wrap;
  background:#111c2c;
  padding:14px;
  border-radius:10px;
}

</style>

</head>

<body>

<h1>Kink Sanz Auto Post</h1>

<p>
Status:
<b id="s">loading...</b>
</p>

<p>
Channel:
<b id="c">-</b>
</p>

<p>
<a href="/qr">
Buka QR WhatsApp
</a>
</p>

<pre id="l">-</pre>

<script>

async function loadStatus(){

  try{

    const r =
      await fetch('/api/status');

    const d =
      await r.json();

    document.querySelector('#s')
      .textContent =
      d.connection;

    document.querySelector('#c')
      .textContent =
      d.channelName ||
      d.channelJid ||
      '-';

    document.querySelector('#l')
      .textContent =
      JSON.stringify(
        d,
        null,
        2
      );

  }catch(e){

    document.querySelector('#l')
      .textContent =
      e.message;

  }

}

loadStatus();

setInterval(
  loadStatus,
  5000
);

</script>

</body>

</html>
`);
});

/* =========================
   QR
========================= */

app.get('/qr', (_req, res) => {

  if (!qrDataUrl) {

    return res.send(`
      <h2 style="font-family:Arial">
        QR belum tersedia.<br>
        Cek status WhatsApp.
      </h2>

      <script>
        setTimeout(
          () => location.reload(),
          3000
        );
      </script>
    `);
  }

  res.send(`
<!doctype html>

<html>

<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Scan WhatsApp</title>

</head>

<body
style="
font-family:Arial;
text-align:center;
background:#07111f;
color:#fff;
padding:24px;
">

<h2>
Scan dari WhatsApp →
Perangkat tertaut
</h2>

<img
src="${qrDataUrl}"
style="
width:320px;
max-width:90%;
background:#fff;
padding:12px;
border-radius:14px;
">

<p>
QR otomatis berubah
jika kedaluwarsa.
</p>

<script>

setTimeout(
  () => location.reload(),
  15000
);

</script>

</body>

</html>
`);
});

/* =========================
   STATUS
========================= */

app.get('/api/status', (_req, res) => {

  res.json({
    ok: true,
    connection: connectionState,
    channelJid,
    channelName,
    lastPost
  });

});

/* =========================
   RESOLVE CHANNEL
========================= */

app.post(
  '/api/resolve-channel',
  async (_req, res) => {

    try {

      const meta =
        await resolveChannel();

      res.json({
        ok: true,
        id: meta.id,
        name: meta.name || ''
      });

    } catch (e) {

      res.status(500).json({
        ok: false,
        error: e.message
      });

    }

  }
);

/* =========================
   AUTO POST CALLBACK
========================= */

app.post(
  '/api/callback',
  authCallback,
  async (req, res) => {

    try {

      const order =
        req.body || {};

      /*
        Mendukung:
        orderId / queueCode
        orderCode / queueCode
      */

      const orderId =
        order.orderId ||
        order.queueCode ||
        `KS-${Date.now()}`;

      const orderCode =
        order.orderCode ||
        order.queueCode ||
        orderId;

      const type =
        String(
          order.type || ''
        ).toUpperCase();

      if (!type) {

        return res.status(400).json({
          ok: false,
          error: 'Type order tidak ada'
        });

      }

      if (
        type !== 'SELL' &&
        type !== 'BUY'
      ) {

        return res.status(400).json({
          ok: false,
          error:
            'Type harus SELL atau BUY'
        });

      }

      if (
        !sock ||
        connectionState !==
        'connected'
      ) {

        return res.status(503).json({
          ok: false,
          error:
            'WhatsApp belum terhubung'
        });

      }

      if (!channelJid) {
        await resolveChannel();
      }

      const caption =
        buildCaption(order);

      if (!caption) {

        return res.status(400).json({
          ok: false,
          error:
            'Format posting kosong'
        });

      }

      let result;

      /* =====================
         SELL + FOTO
      ===================== */

      if (
        type === 'SELL' &&
        order.photoDataUrl
      ) {

        const comma =
          order.photoDataUrl.indexOf(',');

        const mimePart =
          comma >= 0
            ? order.photoDataUrl.slice(
                0,
                comma
              )
            : '';

        const base64 =
          comma >= 0
            ? order.photoDataUrl.slice(
                comma + 1
              )
            : order.photoDataUrl;

        const mime =
          (
            mimePart.match(
              /data:([^;]+);base64/i
            ) || []
          )[1] ||
          order.photoMime ||
          'image/jpeg';

        const buffer =
          Buffer.from(
            base64,
            'base64'
          );

        if (
          buffer.length >
          8 * 1024 * 1024
        ) {

          throw new Error(
            'Foto terlalu besar. Maksimal 8 MB.'
          );

        }

        result =
          await sock.sendMessage(
            channelJid,
            {
              image: buffer,
              mimetype: mime,
              caption
            }
          );

      }

      /* =====================
         BUY / TANPA FOTO
      ===================== */

      else {

        result =
          await sock.sendMessage(
            channelJid,
            {
              text: caption
            }
          );

      }

      /* =====================
         LAST POST
      ===================== */

      lastPost = {

        orderId,
        orderCode,

        type,

        at:
          new Date()
            .toISOString(),

        messageId:
          result?.key?.id ||
          null
      };

      logger.info(
        {
          orderId,
          orderCode,
          type,
          messageId:
            result?.key?.id
        },
        'Auto post berhasil'
      );

      res.json({

        ok: true,

        orderId,

        orderCode,

        type,

        channelJid,

        messageId:
          result?.key?.id ||
          null

      });

    } catch (e) {

      logger.error(
        {
          err: e
        },
        'Auto post gagal'
      );

      res.status(500).json({

        ok: false,

        error:
          e.message ||
          'Auto post gagal'

      });

    }

  }
);

/* =========================
   404
========================= */

app.use(
  (_req, res) => {

    res.status(404).json({
      ok: false,
      error: 'Endpoint tidak ditemukan'
    });

  }
);

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  () => {

    logger.info(
      `Kink Sanz Auto Post berjalan di port ${PORT}`
    );

    connectWhatsApp()
      .catch(err => {

        logger.error(
          {
            err
          },
          'Gagal start WhatsApp'
        );

      });

  }
);
