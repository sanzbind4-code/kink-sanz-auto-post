import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs/promises';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@itsliaaa/baileys';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '12mb' }));

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';
let channelJid = '';
let channelName = '';
let channelState = '';
let lastPost = null;
let reconnectTimer = null;
let sendLock = Promise.resolve();

function inviteCode(link) {
  const m = String(link || '').match(/whatsapp\.com\/channel\/([^/?]+)/i);
  return m ? m[1] : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveChannel() {
  if (!sock) throw new Error('WhatsApp belum terhubung');

  let meta;
  const code = inviteCode(CHANNEL_LINK);

  if (code) {
    meta = await sock.newsletterMetadata('invite', code);
  } else if (CHANNEL_LINK.endsWith('@newsletter')) {
    meta = await sock.newsletterMetadata('jid', CHANNEL_LINK);
  } else {
    throw new Error('CHANNEL_LINK tidak valid');
  }

  if (!meta?.id) {
    throw new Error('Channel ID tidak ditemukan');
  }

  channelJid = meta.id;
  channelName = meta.name || meta.thread_metadata?.name || '';
  channelState =
    meta.state?.type ||
    meta.thread_metadata?.state?.type ||
    '';

  return meta;
}

async function refreshChannel() {
  try {
    const meta = await resolveChannel();

    logger.info(
      {
        channelJid,
        channelName,
        channelState
      },
      'Channel terdeteksi'
    );

    return meta;
  } catch (e) {
    logger.error(
      { err: e },
      'Gagal resolve channel'
    );

    throw e;
  }
}

async function startWhatsApp() {
  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

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

          logger.info(
            'QR WhatsApp tersedia'
          );
        }

        if (connection === 'open') {
          qrDataUrl = '';
          connectionState = 'connected';

          logger.info(
            'WhatsApp berhasil terhubung'
          );

          try {
            await refreshChannel();
          } catch (_) {}
        }

        if (connection === 'close') {
          const code =
            lastDisconnect?.error?.output?.statusCode;

          connectionState = 'disconnected';

          sock = null;
          channelJid = '';
          channelName = '';
          channelState = '';

          if (
            code !== DisconnectReason.loggedOut &&
            !reconnectTimer
          ) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;

              startWhatsApp().catch(
                e =>
                  logger.error(
                    { err: e },
                    'Reconnect gagal'
                  )
              );
            }, 3000);
          }
        }
      }
    );

  } catch (e) {
    connectionState = 'error';

    logger.error(
      { err: e },
      'Gagal menjalankan WhatsApp'
    );

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        startWhatsApp().catch(() => {});
      }, 5000);
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

function caption(order) {
  return String(
    order?.format || ''
  )
    .replace(/\r/g, '')
    .trim();
}

function parseImage(imageDataUrl) {
  if (!imageDataUrl) return null;

  const value = String(imageDataUrl);

  const comma = value.indexOf(',');

  const b64 =
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
    Buffer.from(b64, 'base64');

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

  const meta =
    await sock.newsletterMetadata(
      'jid',
      channelJid
    );

  if (!meta?.id) {
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
    sendLock.then(async () => {

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

        } catch (e) {

          lastError = e;

          logger.warn(
            {
              attempt,
              err: e
            },
            'Pengiriman channel gagal'
          );

          if (attempt < 3) {
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
    });

  sendLock =
    job.then(
      () => undefined,
      () => undefined
    );

  return job;
}

app.get('/', (_req, res) =>
  res.send(`<!doctype html>
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
  max-width:650px;
  margin:auto;
  padding:24px
}

.card{
  background:#111c2c;
  padding:22px;
  border-radius:18px
}

a,button{
  display:inline-block;
  background:#10b981;
  color:#fff;
  padding:12px 16px;
  border:0;
  border-radius:10px;
  text-decoration:none;
  margin:5px 0;
  cursor:pointer
}

button.reset{
  background:#ef4444
}

pre{
  white-space:pre-wrap;
  background:#07111f;
  padding:14px;
  border-radius:10px
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
<b id="s">loading</b>
</p>

<p>
Channel:
<b id="c">-</b>
</p>

<p>
Channel state:
<b id="cs">-</b>
</p>

<p>
<a href="/qr">
📱 BUKA QR WHATSAPP
</a>
</p>

<p>
<button
class="reset"
onclick="changeWA()">
🔄 GANTI WA JB / TAMPILKAN QR
</button>
</p>

<p>
<button onclick="testPost()">
TEST POST TEKS
</button>
</p>

<pre id="d">
loading...
</pre>

</div>

<script>

async function st(){

  try{

    const d =
      await (
        await fetch('/api/status')
      ).json();

    s.textContent =
      d.connection;

    c.textContent =
      d.channelName ||
      d.channelJid ||
      '-';

    cs.textContent =
      d.channelState ||
      '-';

    document
      .getElementById('d')
      .textContent =
      JSON.stringify(
        d,
        null,
        2
      );

  }catch(e){

    document
      .getElementById('d')
      .textContent =
      e.message;

  }

}

async function changeWA(){

  const secret =
    prompt(
      'Masukkan CALLBACK_SECRET'
    );

  if(secret === null)
    return;

  const r =
    await fetch(
      '/api/reset-whatsapp',
      {
        method:'POST',

        headers:{
          'Content-Type':
            'application/json',

          'X-Japost-Secret':
            secret
        }
      }
    );

  const d =
    await r.json();

  alert(
    JSON.stringify(
      d,
      null,
      2
    )
  );

  if(d.ok){

    location.href =
      '/qr';

  }else{

    st();

  }

}

async function testPost(){

  const secret =
    prompt(
      'Masukkan CALLBACK_SECRET'
    );

  if(secret === null)
    return;

  const r =
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

        body:
          JSON.stringify({
            text:
              'TEST AUTO POST KINK SANZ ' +
              new Date()
                .toLocaleString(
                  'id-ID'
                )
          })
      }
    );

  alert(
    JSON.stringify(
      await r.json(),
      null,
      2
    )
  );

  st();

}

st();

setInterval(
  st,
  5000
);

</script>

</body>
</html>`)
);

app.get('/qr', (_req, res) => {

  if (!qrDataUrl) {

    return res.send(`
      <h2 style="
        font-family:Arial;
        text-align:center
      ">
        QR belum tersedia
        <br>
        Status:
        ${connectionState}
      </h2>

      <p style="
        text-align:center
      ">
        Halaman akan refresh...
      </p>

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
        Scan WhatsApp
        →
        Perangkat tertaut
      </h2>

      <p>
        Buka WhatsApp JB →
        Perangkat tertaut →
        Tautkan perangkat
      </p>

      <img
        src="${qrDataUrl}"
        style="
          width:320px;
          max-width:90%;
          background:#fff;
          padding:12px;
          border-radius:14px
        "
      >

      <p>
        QR otomatis diperbarui.
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

app.get(
  '/api/status',
  (_req, res) =>
    res.json({
      ok: true,
      connection:
        connectionState,
      qr:
        !!qrDataUrl,
      channelJid,
      channelName,
      channelState,
      lastPost
    })
);

app.post(
  '/api/reset-whatsapp',
  auth,
  async (_req, res) => {

    try {

      if (reconnectTimer) {

        clearTimeout(
          reconnectTimer
        );

        reconnectTimer = null;
      }

      connectionState =
        'resetting';

      qrDataUrl = '';

      channelJid = '';
      channelName = '';
      channelState = '';

      const oldSock =
        sock;

      sock = null;

      try {

        if (oldSock) {
          await oldSock.logout();
        }

      } catch (e) {

        logger.warn(
          {
            err:e
          },
          'Logout WhatsApp lama gagal, lanjut reset session'
        );

      }

      await fs.rm(
        SESSION_DIR,
        {
          recursive:true,
          force:true
        }
      );

      await fs.mkdir(
        SESSION_DIR,
        {
          recursive:true
        }
      );

      connectionState =
        'starting';

      startWhatsApp()
        .catch(
          e =>
            logger.error(
              {err:e},
              'Gagal start WhatsApp setelah reset'
            )
        );

      res.json({
        ok:true,
        message:
          'Session WhatsApp lama direset. QR baru sedang dibuat. Buka /qr.'
      });

    } catch(e) {

      connectionState =
        'error';

      res.status(500).json({
        ok:false,
        error:
          e.message ||
          'Gagal reset WhatsApp'
      });

    }

  }
);

app.post(
  '/api/resolve-channel',
  async (_req, res) => {

    try {

      const m =
        await refreshChannel();

      res.json({
        ok:true,
        id:m.id,
        name:
          m.name ||
          m.thread_metadata?.name ||
          '',
        state:
          m.state ||
          null,
        metadata:m
      });

    } catch(e) {

      res.status(500).json({
        ok:false,
        error:e.message
      });

    }

  }
);

app.post(
  '/api/channel-check',
  auth,
  async (_req, res) => {

    try {

      const m =
        await refreshChannel();

      res.json({
        ok:true,
        id:m.id,
        name:
          m.name ||
          m.thread_metadata?.name ||
          '',
        state:
          m.state ||
          null,
        viewerMetadata:
          m.viewer_metadata ||
          null,
        threadMetadata:
          m.thread_metadata ||
          null
      });

    } catch(e) {

      res.status(500).json({
        ok:false,
        error:e.message
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

        orderId:'TEST',

        orderCode:'TEST',

        type:'TEST',

        at:
          new Date()
            .toISOString(),

        messageId:
          result.key.id,

        attempts,

        mode:'text'

      };

      logger.info(
        {
          channelJid,
          messageId:
            result.key.id,
          attempts
        },
        'TEST POST BERHASIL'
      );

      res.json({

        ok:true,

        channelJid,

        messageId:
          result.key.id,

        attempts

      });

    } catch(e) {

      logger.error(
        {err:e},
        'TEST POST GAGAL'
      );

      res.status(500).json({

        ok:false,

        error:e.message

      });

    }

  }
);

app.post(
  '/api/callback',
  auth,
  async (req, res) => {

    try {

      const o =
        req.body || {};

      const orderId =
        o.orderId ||
        o.queueCode ||
        `KS-${Date.now()}`;

      const orderCode =
        o.orderCode ||
        o.queueCode ||
        orderId;

      const type =
        String(
          o.type || ''
        ).toUpperCase();

      if (
        !['SELL','BUY']
          .includes(type)
      ) {

        return res.status(400).json({

          ok:false,

          error:
            'Type harus SELL atau BUY'

        });

      }

      const text =
        caption(o);

      if (!text) {

        return res.status(400).json({

          ok:false,

          error:
            'Format posting kosong'

        });

      }

      const imageData =
        o.photoData ||
        o.photoDataUrl ||
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
          new Date()
            .toISOString(),

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

        ok:true,

        orderId,

        orderCode,

        type,

        channelJid,

        messageId:
          result.key.id,

        attempts

      });

    } catch(e) {

      logger.error(
        {err:e},
        'Auto post gagal'
      );

      res.status(500).json({

        ok:false,

        error:
          e.message ||
          'Auto post gagal'

      });

    }

  }
);

app.use(
  (_req,res) =>
    res.status(404).json({
      ok:false,
      error:
        'Endpoint tidak ditemukan'
    })
);

app.listen(
  PORT,
  HOST,
  () => {

    logger.info(
      `Kink Sanz Auto Post berjalan di ${HOST}:${PORT}`
    );

    startWhatsApp()
      .catch(
        e =>
          logger.error(
            {err:e},
            'Gagal start WhatsApp'
          )
      );

  }
);
