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

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-Japost-Secret'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({
  limit: '12mb'
}));

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';

let channelJid = '';
let channelName = '';
let channelState = '';

let lastPost = null;
let reconnectTimer = null;

/*
  Semua pengiriman ke Channel dibuat antre.
  Jadi kalau ada 2 order masuk bersamaan,
  tidak saling tabrak.
*/
let sendLock = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function inviteCode(link) {
  const match = String(link || '').match(
    /whatsapp\.com\/channel\/([^/?]+)/i
  );

  return match ? match[1] : '';
}

async function resolveChannel() {
  if (!sock) {
    throw new Error('WhatsApp belum terhubung');
  }

  let metadata;

  const code = inviteCode(CHANNEL_LINK);

  if (code) {
    metadata = await sock.newsletterMetadata(
      'invite',
      code
    );
  } else if (
    String(CHANNEL_LINK).endsWith('@newsletter')
  ) {
    metadata = await sock.newsletterMetadata(
      'jid',
      CHANNEL_LINK
    );
  } else {
    throw new Error('CHANNEL_LINK tidak valid');
  }

  if (!metadata?.id) {
    throw new Error('Channel ID tidak ditemukan');
  }

  channelJid = metadata.id;

  channelName =
    metadata.name ||
    metadata.thread_metadata?.name ||
    '';

  channelState =
    metadata.state?.type ||
    metadata.thread_metadata?.state?.type ||
    '';

  return metadata;
}

async function refreshChannel() {
  try {
    const metadata = await resolveChannel();

    logger.info(
      {
        channelJid,
        channelName,
        channelState
      },
      'Channel terdeteksi'
    );

    return metadata;
  } catch (error) {
    logger.error(
      { err: error },
      'Gagal resolve channel'
    );

    throw error;
  }
}

async function startWhatsApp() {
  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
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
      defaultQueryTimeoutMs: 60000
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

        if (qr) {
          qrDataUrl = await QRCode.toDataURL(
            qr,
            {
              margin: 2,
              width: 320
            }
          );

          connectionState = 'scan_qr';
        }

        if (connection === 'open') {
          qrDataUrl = '';
          connectionState = 'connected';

          try {
            await refreshChannel();
          } catch (_) {}
        }

        if (connection === 'close') {
          const code =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          connectionState = 'disconnected';

          sock = null;
          channelJid = '';
          channelName = '';
          channelState = '';

          if (
            code !== DisconnectReason.loggedOut &&
            !reconnectTimer
          ) {
            reconnectTimer = setTimeout(
              () => {
                reconnectTimer = null;

                startWhatsApp()
                  .catch(error => {
                    logger.error(
                      { err: error },
                      'Reconnect gagal'
                    );
                  });
              },
              3000
            );
          }
        }
      }
    );

  } catch (error) {
    connectionState = 'error';

    logger.error(
      { err: error },
      'Gagal menjalankan WhatsApp'
    );

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(
        () => {
          reconnectTimer = null;

          startWhatsApp()
            .catch(() => {});
        },
        5000
      );
    }
  }
}

function auth(req, res, next) {
  if (!CALLBACK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum diset'
    });
  }

  if (
    req.get('X-Japost-Secret') !==
    CALLBACK_SECRET
  ) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  next();
}

function getCaption(order) {
  return String(
    order?.format || ''
  )
    .replace(/\r/g, '')
    .trim();
}

function parseImage(imageDataUrl) {
  if (!imageDataUrl) {
    return null;
  }

  const value = String(
    imageDataUrl
  );

  const comma =
    value.indexOf(',');

  const base64 =
    comma >= 0
      ? value.slice(comma + 1)
      : value;

  const mimePart =
    comma >= 0
      ? value.slice(0, comma)
      : '';

  const mime =
    (
      mimePart.match(
        /data:([^;]+);base64/i
      ) || []
    )[1] || 'image/jpeg';

  const buffer =
    Buffer.from(
      base64,
      'base64'
    );

  if (!buffer.length) {
    throw new Error(
      'Foto kosong/tidak valid'
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

async function rawSend(
  text,
  imageDataUrl
) {
  if (
    !sock ||
    connectionState !== 'connected'
  ) {
    throw new Error(
      'WhatsApp belum terhubung'
    );
  }

  if (!channelJid) {
    await refreshChannel();
  }

  const verify =
    await sock.newsletterMetadata(
      'jid',
      channelJid
    );

  if (!verify?.id) {
    throw new Error(
      'Channel JID tidak valid'
    );
  }

  const image =
    parseImage(imageDataUrl);

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

  /*
    Kalau tidak ada message ID,
    jangan dianggap berhasil.
  */
  if (!result?.key?.id) {
    throw new Error(
      'WhatsApp tidak mengembalikan ID pesan. Post dianggap gagal.'
    );
  }

  return result;
}

async function sendToChannel(
  text,
  imageDataUrl = ''
) {
  const job =
    sendLock.then(
      async () => {

        let lastError = null;

        for (
          let attempt = 1;
          attempt <= 3;
          attempt++
        ) {
          try {

            const result =
              await rawSend(
                text,
                imageDataUrl
              );

            return {
              result,
              attempts: attempt
            };

          } catch (error) {

            lastError = error;

            logger.warn(
              {
                attempt,
                err: error
              },
              'Pengiriman Channel gagal'
            );

            if (
              attempt < 3
            ) {
              await sleep(
                1200 * attempt
              );
            }
          }
        }

        throw (
          lastError ||
          new Error(
            'Auto post gagal'
          )
        );
      }
    );

  sendLock =
    job.then(
      () => undefined,
      () => undefined
    );

  return job;
}

app.get(
  '/api/status',
  (_req, res) => {
    res.json({
      ok: true,
      connection: connectionState,
      channelJid,
      channelName,
      channelState,
      lastPost
    });
  }
);

app.post(
  '/api/resolve-channel',
  async (_req, res) => {
    try {

      const metadata =
        await refreshChannel();

      res.json({
        ok: true,
        id: metadata.id,
        name:
          metadata.name ||
          metadata.thread_metadata?.name ||
          '',
        state:
          metadata.state ||
          null
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

app.post(
  '/api/channel-check',
  auth,
  async (_req, res) => {
    try {

      const metadata =
        await refreshChannel();

      res.json({
        ok: true,
        id: metadata.id,
        name:
          metadata.name ||
          metadata.thread_metadata?.name ||
          '',
        state:
          metadata.state || null,
        viewerMetadata:
          metadata.viewer_metadata ||
          null,
        threadMetadata:
          metadata.thread_metadata ||
          null
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

app.post(
  '/api/test-post',
  auth,
  async (req, res) => {
    try {

      const text =
        String(
          req.body?.text ||
          'TEST AUTO POST KINK SANZ'
        ).trim();

      const {
        result,
        attempts
      } =
        await sendToChannel(
          text,
          ''
        );

      lastPost = {
        orderId: 'TEST',
        orderCode: 'TEST',
        type: 'TEST',
        at:
          new Date().toISOString(),
        messageId:
          result.key.id,
        attempts,
        mode: 'text'
      };

      res.json({
        ok: true,
        channelJid,
        messageId:
          result.key.id,
        attempts
      });

    } catch (error) {

      logger.error(
        { err: error },
        'TEST POST GAGAL'
      );

      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

app.post(
  '/api/callback',
  auth,
  async (req, res) => {
    try {

      const order =
        req.body || {};

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

      if (
        !['SELL', 'BUY']
          .includes(type)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'Type harus SELL atau BUY'
        });
      }

      const text =
        getCaption(order);

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            'Format posting kosong'
        });
      }

      const imageData =
        order.photoData ||
        order.photoDataUrl ||
        '';

      const {
        result,
        attempts
      } =
        await sendToChannel(
          text,
          imageData
        );

      lastPost = {
        orderId,
        orderCode,
        type,
        at:
          new Date().toISOString(),
        messageId:
          result.key.id,
        attempts,
        mode:
          imageData
            ? 'image+caption'
            : 'text'
      };

      logger.info(
        {
          orderId,
          orderCode,
          type,
          channelJid,
          messageId:
            result.key.id,
          attempts
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
          result.key.id,
        attempts
      });

    } catch (error) {

      logger.error(
        { err: error },
        'Auto post gagal'
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

app.get(
  '/',
  (_req, res) => {
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
  color:white;
  max-width:650px;
  margin:auto;
  padding:24px
}
.card{
  background:#111c2c;
  padding:22px;
  border-radius:18px
}
button,a{
  display:inline-block;
  background:#10b981;
  color:white;
  padding:12px 16px;
  border:0;
  border-radius:10px;
  text-decoration:none
}
</style>
</head>

<body>

<div class="card">

<h1>Kink Sanz Auto Post</h1>

<p>
Server:
<b>ONLINE</b>
</p>

<p>
Port:
<b>${PORT}</b>
</p>

<p>
WhatsApp:
<b id="wa">loading</b>
</p>

<p>
Channel:
<b id="channel">-</b>
</p>

<p>
Channel state:
<b id="state">-</b>
</p>

<p>
<a href="/qr">
Buka QR WhatsApp
</a>
</p>

<p>
<button onclick="testPost()">
TEST POST TEKS
</button>
</p>

<pre id="data">
loading...
</pre>

</div>

<script>

async function status(){

  try{

    const response =
      await fetch(
        '/api/status'
      );

    const data =
      await response.json();

    document.getElementById(
      'wa'
    ).textContent =
      data.connection;

    document.getElementById(
      'channel'
    ).textContent =
      data.channelName ||
      data.channelJid ||
      '-';

    document.getElementById(
      'state'
    ).textContent =
      data.channelState ||
      '-';

    document.getElementById(
      'data'
    ).textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  }catch(error){

    document.getElementById(
      'data'
    ).textContent =
      error.message;
  }
}

async function testPost(){

  const secret =
    prompt(
      'Masukkan CALLBACK_SECRET'
    );

  if(secret === null){
    return;
  }

  const response =
    await fetch(
      '/api/test-post',
      {
        method:'POST',
        headers:{
          'Content-Type':
            'application/json',
          'X-Japost-Secret':
            secret
        },
        body:JSON.stringify({
          text:
            'TEST AUTO POST KINK SANZ ' +
            new Date()
              .toLocaleString(
                'id-ID'
              )
        })
      }
    );

  const data =
    await response.json();

  alert(
    JSON.stringify(
      data,
      null,
      2
    )
  );

  status();
}

status();

setInterval(
  status,
  5000
);

</script>

</body>
</html>
`);
  }
);

app.get(
  '/qr',
  (_req, res) => {

    if (!qrDataUrl) {

      return res.send(`
<h2 style="
font-family:Arial;
text-align:center
">
QR belum tersedia
<br>
Status: ${connectionState}
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

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<body style="
font-family:Arial;
background:#07111f;
color:white;
text-align:center;
padding:24px
">

<h2>
Scan WhatsApp →
Perangkat tertaut
</h2>

<img
src="${qrDataUrl}"
style="
width:320px;
max-width:90%;
background:white;
padding:12px;
border-radius:14px
"
>

<script>
setTimeout(
  () => location.reload(),
  15000
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
      ok: false,
      error:
        'Endpoint tidak ditemukan'
    });
  }
);

app.listen(
  PORT,
  HOST,
  () => {

    logger.info(
      `Kink Sanz Auto Post berjalan di ${HOST}:${PORT}`
    );

    startWhatsApp()
      .catch(error => {
        logger.error(
          { err: error },
          'Gagal start WhatsApp'
        );
      });
  }
);
