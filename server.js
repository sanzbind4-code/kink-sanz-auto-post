import 'dotenv/config';
import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const app = express();

app.use(express.json({ limit: '15mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Japost-Secret'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';

const CALLBACK_SECRET =
  process.env.CALLBACK_SECRET || '';

const CHANNEL_LINK =
  process.env.CHANNEL_LINK || '';

let sock = null;
let qrData = null;
let connection = 'starting';
let channelJid = null;
let lastPost = null;

function getInviteCode(link) {
  if (!link) return null;

  const match = String(link).match(
    /whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i
  );

  return match ? match[1] : null;
}

async function resolveChannel() {
  if (!sock) return null;

  try {
    // Kalau JID sudah diketahui, cek ulang metadata channel
    if (channelJid) {
      try {
        const metadata =
          await sock.newsletterMetadata(
            'jid',
            channelJid
          );

        if (metadata?.id) {
          channelJid = metadata.id;
          return channelJid;
        }
      } catch (error) {
        console.log(
          'Gagal cek JID channel:',
          error?.message || error
        );
      }
    }

    // Ambil dari link channel
    const inviteCode =
      getInviteCode(CHANNEL_LINK);

    if (!inviteCode) {
      return channelJid;
    }

    const metadata =
      await sock.newsletterMetadata(
        'invite',
        inviteCode
      );

    if (metadata?.id) {
      channelJid = metadata.id;

      console.log(
        'Channel ditemukan:',
        channelJid
      );

      return channelJid;
    }
  } catch (error) {
    console.error(
      'resolve channel error:',
      error?.message || error
    );
  }

  return channelJid;
}

async function startWhatsApp() {
  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    './session'
  );

  let version;

  try {
    const latest =
      await fetchLatestBaileysVersion();

    version = latest.version;

    console.log(
      'Baileys version:',
      version
    );
  } catch (error) {
    console.log(
      'Tidak bisa mengambil versi terbaru, memakai fallback.'
    );

    version = [
      2,
      3000,
      1023223821
    ];
  }

  sock = makeWASocket({
    version,

    auth: {
      creds: state.creds,

      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({
          level: 'silent'
        })
      )
    },

    logger: pino({
      level: 'silent'
    }),

    browser: Browsers.ubuntu(
      'Chrome'
    ),

    printQRInTerminal: false,

    markOnlineOnConnect: false,

    generateHighQualityLinkPreview: false
  });

  sock.ev.on(
    'creds.update',
    saveCreds
  );

  sock.ev.on(
    'connection.update',
    async ({
      connection: stateConnection,
      lastDisconnect,
      qr
    }) => {

      if (qr) {
        qrData =
          await QRCode.toDataURL(qr);

        console.log(
          'QR baru tersedia.'
        );
      }

      if (
        stateConnection === 'open'
      ) {
        connection =
          'connected';

        qrData = null;

        console.log(
          'WhatsApp berhasil terhubung.'
        );

        await resolveChannel();

        console.log(
          'Channel JID:',
          channelJid
        );
      }

      else if (
        stateConnection === 'close'
      ) {
        connection =
          'disconnected';

        const code =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        console.log(
          'WhatsApp terputus. Code:',
          code
        );

        if (
          code !==
          DisconnectReason.loggedOut
        ) {
          console.log(
            'Mencoba reconnect...'
          );

          setTimeout(
            startWhatsApp,
            3000
          );
        }
      }

      else if (stateConnection) {
        connection =
          stateConnection;
      }
    }
  );
}

function authSecret(
  req,
  res,
  next
) {
  const secret =
    req.get(
      'X-Japost-Secret'
    );

  if (
    !CALLBACK_SECRET ||
    secret !== CALLBACK_SECRET
  ) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  next();
}

async function sendToChannel(text) {
  if (
    !sock ||
    connection !== 'connected'
  ) {
    throw new Error(
      'WhatsApp belum connected'
    );
  }

  const jid =
    await resolveChannel();

  if (!jid) {
    throw new Error(
      'Channel JID belum ditemukan'
    );
  }

  console.log(
    'Mengirim pesan ke:',
    jid
  );

  const result =
    await sock.sendMessage(
      jid,
      {
        text
      }
    );

  console.log(
    'Message ID:',
    result?.key?.id
  );

  return result;
}

/* =========================
   STATUS
========================= */

app.get(
  '/',
  (req, res) => {
    res.json({
      ok: true,
      service:
        'Kink Sanz Auto Post Backend',
      connection,
      channelJid,
      hasQr:
        Boolean(qrData)
    });
  }
);

/* =========================
   QR
========================= */

app.get(
  '/qr',
  (req, res) => {

    if (!qrData) {
      return res
        .status(404)
        .send(
          '<h2>QR tidak tersedia. Cek /api/status.</h2>'
        );
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport"
          content="width=device-width,initial-scale=1">
        <title>WhatsApp QR</title>
      </head>

      <body style="
        font-family:Arial;
        text-align:center;
        background:#07152b;
        color:white;
        padding:30px;
      ">

        <h2>Scan QR WhatsApp</h2>

        <img
          src="${qrData}"
          style="
            width:320px;
            max-width:90vw;
            border-radius:15px;
          "
        >

        <p>
          Scan menggunakan WhatsApp
        </p>

      </body>
      </html>
    `);
  }
);

/* =========================
   API STATUS
========================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({
      ok: true,
      connection,
      channelJid,
      lastPost
    });
  }
);

/* =========================
   RESOLVE CHANNEL
========================= */

app.get(
  '/api/resolve-channel',
  authSecret,
  async (req, res) => {

    try {

      const jid =
        await resolveChannel();

      res.json({
        ok: true,
        channelJid: jid
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        error:
          error?.message ||
          String(error)
      });

    }
  }
);

/* =========================
   TEST POST
========================= */

app.post(
  '/api/test-post',
  authSecret,
  async (req, res) => {

    try {

      const text =
        req.body?.text ||
        'TEST AUTO POST KINK SANZ';

      const result =
        await sendToChannel(
          text
        );

      res.json({
        ok: true,
        sent: true,
        messageId:
          result?.key?.id ||
          null
      });

    } catch (error) {

      console.error(
        'TEST POST ERROR:',
        error
      );

      res.status(500).json({
        ok: false,
        sent: false,
        error:
          error?.message ||
          String(error)
      });

    }
  }
);

/* =========================
   JAPOST CALLBACK
========================= */

app.post(
  '/api/callback',
  authSecret,
  async (req, res) => {

    try {

      const {
        orderId,
        queueCode,
        type,
        format,
        photoDataUrl,
        photoData,
        wa
      } = req.body || {};

      const id =
        orderId ||
        queueCode ||
        `KS-${Date.now()}`;

      const text = [
        '📌 KINK SANZ JAPOST FREE',
        '',
        `NO ANTRIAN: ${id}`,
        `TYPE: ${String(
          type || ''
        ).toUpperCase()}`,
        '',
        format || '',
        '',
        wa
          ? `WA: ${wa}`
          : ''
      ]
        .filter(Boolean)
        .join('\n');

      console.log(
        'AUTO POST:',
        id
      );

      const result =
        await sendToChannel(
          text
        );

      const messageId =
        result?.key?.id ||
        null;

      lastPost = {
        orderId: id,
        orderCode: id,

        type:
          String(
            type || ''
          ).toUpperCase(),

        at:
          new Date()
            .toISOString(),

        messageId
      };

      res.json({
        ok: true,
        sent: true,
        messageId
      });

    } catch (error) {

      console.error(
        'CALLBACK ERROR:',
        error
      );

      res.status(500).json({
        ok: false,
        sent: false,
        error:
          error?.message ||
          String(error)
      });
    }
  }
);

/* =========================
   404
========================= */

app.use(
  (req, res) => {

    res.status(404).json({
      ok: false,
      error:
        'Endpoint tidak ditemukan'
    });

  }
);

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      `Server running on ${HOST}:${PORT}`
    );

    console.log(
      `Channel link: ${CHANNEL_LINK}`
    );
  }
);

/* =========================
   START WHATSAPP
========================= */

startWhatsApp()
  .catch((error) => {

    connection = 'error';

    console.error(
      'WhatsApp startup error:',
      error
    );

  });
