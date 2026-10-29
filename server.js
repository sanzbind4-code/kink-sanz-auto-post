import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@itsliaaa/baileys';

const app = express();

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';

const CALLBACK_SECRET =
  process.env.CALLBACK_SECRET || '';

const CHANNEL_LINK =
  process.env.CHANNEL_LINK ||
  'https://whatsapp.com/channel/0029VbC8YTVGehEH4EHdMz44';

const SESSION_DIR = './session';

const logger = pino({
  level: 'info'
});

app.use(express.json({
  limit: '12mb'
}));

app.use((req, res, next) => {
  res.header(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Japost-Secret'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

let sock = null;

let connectionState = 'starting';
let qrDataUrl = '';

let channelJid = '';
let channelName = '';

let lastPost = null;

let reconnectTimer = null;

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function getInviteCode(link) {
  const match = String(link).match(
    /whatsapp\.com\/channel\/([^/?]+)/i
  );

  return match ? match[1] : '';
}

async function resolveChannel() {
  if (!sock) {
    throw new Error(
      'WhatsApp belum terhubung'
    );
  }

  const code =
    getInviteCode(CHANNEL_LINK);

  if (!code) {
    throw new Error(
      'CHANNEL_LINK tidak valid'
    );
  }

  const metadata =
    await sock.newsletterMetadata(
      'invite',
      code
    );

  if (!metadata?.id) {
    throw new Error(
      'Channel tidak ditemukan'
    );
  }

  channelJid = metadata.id;

  channelName =
    metadata.name ||
    metadata.thread_metadata?.name ||
    'Kink Sanz';

  console.log('');
  console.log(
    '================================'
  );
  console.log(
    'CHANNEL BERHASIL DITEMUKAN'
  );
  console.log(
    'Nama :',
    channelName
  );
  console.log(
    'JID  :',
    channelJid
  );
  console.log(
    '================================'
  );
  console.log('');

  return metadata;
}

async function connectWhatsApp() {

  try {

    connectionState = 'starting';

    console.log('');
    console.log(
      '================================'
    );
    console.log(
      'MEMULAI WHATSAPP'
    );
    console.log(
      '================================'
    );

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        SESSION_DIR
      );

    sock = makeWASocket({
      auth: state,

      logger: pino({
        level: 'silent'
      }),

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      printQRInTerminal: true
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

        console.log(
          'Connection:',
          connection || '-'
        );

        /*
          QR BARU
        */
        if (qr) {

          console.log('');
          console.log(
            '================================'
          );
          console.log(
            'QR WHATSAPP TERSEDIA'
          );
          console.log(
            'Buka /qr untuk scan'
          );
          console.log(
            '================================'
          );
          console.log('');

          qrDataUrl =
            await QRCode.toDataURL(
              qr,
              {
                width: 400,
                margin: 2
              }
            );

          connectionState =
            'scan_qr';
        }

        /*
          CONNECTED
        */
        if (connection === 'open') {

          console.log('');
          console.log(
            '================================'
          );
          console.log(
            'WHATSAPP CONNECTED'
          );
          console.log(
            '================================'
          );
          console.log('');

          connectionState =
            'connected';

          qrDataUrl = '';

          try {
            await resolveChannel();
          } catch (error) {

            console.error(
              'Channel error:',
              error.message
            );
          }
        }

        /*
          CLOSED
        */
        if (connection === 'close') {

          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          console.log('');
          console.log(
            '================================'
          );
          console.log(
            'WHATSAPP DISCONNECTED'
          );
          console.log(
            'CODE:',
            statusCode
          );
          console.log(
            '================================'
          );
          console.log('');

          connectionState =
            'disconnected';

          /*
            Kalau logout,
            session tidak bisa dipakai lagi.
          */
          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {

            console.log(
              'WhatsApp logout.'
            );

            qrDataUrl = '';

            return;
          }

          /*
            Reconnect otomatis
          */
          if (!reconnectTimer) {

            reconnectTimer =
              setTimeout(
                async () => {

                  reconnectTimer =
                    null;

                  try {

                    await connectWhatsApp();

                  } catch (error) {

                    console.error(
                      'Reconnect error:',
                      error.message
                    );
                  }

                },
                3000
              );
          }
        }
      }
    );

  } catch (error) {

    console.error('');
    console.error(
      '================================'
    );
    console.error(
      'WHATSAPP START ERROR'
    );
    console.error(
      error
    );
    console.error(
      '================================'
    );
    console.error('');

    connectionState =
      'error';

    sock = null;

    if (!reconnectTimer) {

      reconnectTimer =
        setTimeout(
          async () => {

            reconnectTimer =
              null;

            try {
              await connectWhatsApp();
            } catch (_) {}

          },
          5000
        );
    }
  }
}

/*
  AUTH CALLBACK
*/
function checkSecret(
  req,
  res,
  next
) {

  if (!CALLBACK_SECRET) {

    return res.status(500).json({
      ok: false,
      error:
        'CALLBACK_SECRET belum diisi'
    });
  }

  if (
    req.get(
      'X-Japost-Secret'
    ) !== CALLBACK_SECRET
  ) {

    return res.status(401).json({
      ok: false,
      error:
        'Unauthorized'
    });
  }

  next();
}

/*
  FOTO BASE64
*/
function decodeImage(
  imageData
) {

  if (!imageData) {
    return null;
  }

  const value =
    String(imageData);

  const comma =
    value.indexOf(',');

  const base64 =
    comma >= 0
      ? value.slice(
          comma + 1
        )
      : value;

  const header =
    comma >= 0
      ? value.slice(
          0,
          comma
        )
      : '';

  const mime =
    (
      header.match(
        /data:([^;]+);base64/i
      ) || []
    )[1] ||
    'image/jpeg';

  const buffer =
    Buffer.from(
      base64,
      'base64'
    );

  if (!buffer.length) {
    throw new Error(
      'Foto tidak valid'
    );
  }

  if (
    buffer.length >
    8 * 1024 * 1024
  ) {
    throw new Error(
      'Foto terlalu besar. Maksimal 8 MB.'
    );
  }

  return {
    buffer,
    mime
  };
}

/*
  KIRIM KE CHANNEL
*/
async function sendToChannel(
  text,
  imageData = ''
) {

  if (
    !sock ||
    connectionState !==
      'connected'
  ) {
    throw new Error(
      'WhatsApp belum terhubung'
    );
  }

  if (!channelJid) {
    await resolveChannel();
  }

  const check =
    await sock.newsletterMetadata(
      'jid',
      channelJid
    );

  if (!check?.id) {
    throw new Error(
      'Channel JID tidak valid'
    );
  }

  const image =
    decodeImage(imageData);

  let result;

  if (image) {

    console.log(
      'Mengirim foto + format...'
    );

    result =
      await sock.sendMessage(
        channelJid,
        {
          image:
            image.buffer,

          mimetype:
            image.mime,

          caption:
            text
        }
      );

  } else {

    console.log(
      'Mengirim format...'
    );

    result =
      await sock.sendMessage(
        channelJid,
        {
          text
        }
      );
  }

  if (!result?.key?.id) {

    throw new Error(
      'WhatsApp tidak memberikan message ID'
    );
  }

  console.log(
    'POST BERHASIL:',
    result.key.id
  );

  return result;
}

/*
  STATUS
*/
app.get(
  '/api/status',
  (_req, res) => {

    res.json({
      ok: true,

      connection:
        connectionState,

      qr:
        Boolean(qrDataUrl),

      channelJid,

      channelName,

      lastPost
    });
  }
);

/*
  QR
*/
app.get(
  '/qr',
  (_req, res) => {

    if (qrDataUrl) {

      return res.send(`
<!DOCTYPE html>

<html>

<head>

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>Scan WhatsApp</title>

</head>

<body style="
margin:0;
padding:30px;
background:#07111f;
color:white;
font-family:Arial;
text-align:center;
">

<h2>
Scan QR WhatsApp
</h2>

<p>
Buka WhatsApp →
Perangkat tertaut →
Tautkan perangkat
</p>

<img
src="${qrDataUrl}"
style="
width:320px;
max-width:90%;
background:white;
padding:10px;
border-radius:15px;
">

<p>
Status:
<b>
${connectionState}
</b>
</p>

<script>
setTimeout(
  () => location.reload(),
  10000
);
</script>

</body>

</html>
`);

    }

    res.send(`
<!DOCTYPE html>

<html>

<head>

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>WhatsApp</title>

</head>

<body style="
font-family:Arial;
text-align:center;
padding:30px;
">

<h3>
QR belum tersedia
</h3>

<p>
Status:
<b>
${connectionState}
</b>
</p>

<p>
Halaman akan otomatis mengecek QR...
</p>

<script>

setTimeout(
  () => location.reload(),
  2000
);

</script>

</body>

</html>
`);
  }
);

/*
  RESOLVE CHANNEL
*/
app.post(
  '/api/resolve-channel',
  checkSecret,
  async (_req, res) => {

    try {

      const data =
        await resolveChannel();

      res.json({
        ok: true,
        id:
          data.id,
        name:
          data.name ||
          channelName
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/*
  TEST POST
*/
app.post(
  '/api/test-post',
  checkSecret,
  async (req, res) => {

    try {

      const text =
        String(
          req.body?.text ||
          'TEST AUTO POST KINK SANZ'
        );

      const result =
        await sendToChannel(
          text
        );

      lastPost = {
        type: 'TEST',
        time:
          new Date().toISOString(),
        messageId:
          result.key.id
      };

      res.json({
        ok: true,
        messageId:
          result.key.id
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/*
  AUTO POST DARI WEBSITE
*/
app.post(
  '/api/callback',
  checkSecret,
  async (req, res) => {

    try {

      const order =
        req.body || {};

      const type =
        String(
          order.type || ''
        ).toUpperCase();

      if (
        type !== 'SELL' &&
        type !== 'BUY'
      ) {

        return res.status(400).json({
          ok: false,
          error:
            'Jenis order harus SELL atau BUY'
        });
      }

      const format =
        String(
          order.format || ''
        ).trim();

      if (!format) {

        return res.status(400).json({
          ok: false,
          error:
            'Format kosong'
        });
      }

      const photo =
        order.photoData ||
        order.photoDataUrl ||
        '';

      const result =
        await sendToChannel(
          format,
          photo
        );

      const code =
        order.orderCode ||
        order.queueCode ||
        `KS-${Date.now()}`;

      lastPost = {

        type,

        orderCode:
          code,

        time:
          new Date().toISOString(),

        messageId:
          result.key.id
      };

      res.json({

        ok: true,

        orderCode:
          code,

        messageId:
          result.key.id
      });

    } catch (error) {

      console.error(
        'AUTO POST GAGAL:',
        error
      );

      res.status(500).json({

        ok: false,

        error:
          error.message ||
          'Auto post gagal'
      });
    }
  }
);

/*
  HOME
*/
app.get(
  '/',
  (_req, res) => {

    res.send(`
<!DOCTYPE html>

<html>

<head>

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
Kink Sanz Auto Post
</title>

<style>

body{
  margin:0;
  padding:25px;
  background:#07111f;
  color:white;
  font-family:Arial;
}

.card{
  max-width:600px;
  margin:auto;
  padding:25px;
  background:#111d30;
  border-radius:18px;
}

button,a{
  border:0;
  border-radius:10px;
  padding:12px 16px;
  background:#08b981;
  color:white;
  text-decoration:none;
  cursor:pointer;
}

</style>

</head>

<body>

<div class="card">

<h2>
Kink Sanz Auto Post
</h2>

<p>
Server:
<b>ONLINE</b>
</p>

<p>
WhatsApp:
<b id="wa">
loading...
</b>
</p>

<p>
Channel:
<b id="channel">
-
</b>
</p>

<br>

<a href="/qr">
SCAN QR WHATSAPP
</a>

<br><br>

<button
onclick="refresh()"
>
REFRESH STATUS
</button>

<pre id="status">
loading...
</pre>

</div>

<script>

async function refresh(){

  try{

    const r =
      await fetch(
        '/api/status'
      );

    const d =
      await r.json();

    document.getElementById(
      'wa'
    ).textContent =
      d.connection;

    document.getElementById(
      'channel'
    ).textContent =
      d.channelName ||
      d.channelJid ||
      '-';

    document.getElementById(
      'status'
    ).textContent =
      JSON.stringify(
        d,
        null,
        2
      );

  }catch(e){

    document.getElementById(
      'status'
    ).textContent =
      e.message;
  }
}

refresh();

setInterval(
  refresh,
  3000
);

</script>

</body>

</html>
`);
  }
);

app.use(
  (_req, res) => {

    res.status(404).json({
      ok:false,
      error:
        'Endpoint tidak ditemukan'
    });
  }
);

app.listen(
  PORT,
  HOST,
  () => {

    console.log('');
    console.log(
      '================================'
    );
    console.log(
      'KINK SANZ AUTO POST SERVER'
    );
    console.log(
      `PORT: ${PORT}`
    );
    console.log(
      `HOST: ${HOST}`
    );
    console.log(
      '================================'
    );
    console.log('');

    connectWhatsApp();
  }
);
