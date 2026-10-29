import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@itsliaaa/baileys';

const app = express();

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({
  extended: true,
  limit: '25mb'
}));

const PORT = process.env.PORT || 8080;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';

const CHANNEL_JID =
  '120363406356211250@newsletter';

const CHANNEL_NAME =
  'JAPOST KINKSANZ (GRATIS)';

const CHANNEL_LINK =
  process.env.CHANNEL_LINK ||
  'https://whatsapp.com/channel/0029VbC8YTVGehEH4EHdMz44';

const SESSION_DIR = './session';

const logger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'warn'
});

let sock = null;
let connected = false;
let currentQR = null;
let reconnecting = false;
let lastConnectionError = null;
let sending = false;

const sleep = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms));

function getMessageId(result) {
  return result?.key?.id || null;
}

function checkSecret(req) {
  if (!CALLBACK_SECRET) return true;

  const secret =
    req.headers['x-japost-secret'] ||
    req.headers['x-callback-secret'] ||
    req.body?.secret;

  return String(secret || '') ===
    String(CALLBACK_SECRET);
}

async function sendChannelText(text) {
  if (!sock || !connected) {
    throw new Error(
      'WhatsApp belum terhubung.'
    );
  }

  const result = await sock.sendMessage(
    CHANNEL_JID,
    {
      text: String(text)
    }
  );

  console.log(
    '[CHANNEL SEND RESULT]',
    JSON.stringify({
      id: getMessageId(result),
      remoteJid:
        result?.key?.remoteJid ||
        CHANNEL_JID,
      status: result?.status ?? null
    })
  );

  return {
    ok: true,
    messageId: getMessageId(result)
  };
}

async function sendChannelImage(
  buffer,
  caption = ''
) {
  if (!sock || !connected) {
    throw new Error(
      'WhatsApp belum terhubung.'
    );
  }

  if (!buffer) {
    throw new Error(
      'Foto tidak tersedia.'
    );
  }

  // Buffer dikirim langsung.
  // Tidak resize, tidak blur, tidak screenshot.
  const result = await sock.sendMessage(
    CHANNEL_JID,
    {
      image: buffer,
      caption: String(caption || '')
    }
  );

  console.log(
    '[CHANNEL IMAGE RESULT]',
    JSON.stringify({
      id: getMessageId(result),
      remoteJid:
        result?.key?.remoteJid ||
        CHANNEL_JID,
      status: result?.status ?? null
    })
  );

  return {
    ok: true,
    messageId: getMessageId(result)
  };
}

async function safeSendChannelText(text) {
  while (sending) {
    await sleep(300);
  }

  sending = true;

  try {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await sendChannelText(text);
      } catch (err) {
        lastError = err;

        console.error(
          `[TEXT RETRY ${attempt}/3]`,
          err?.stack || err
        );

        if (attempt < 3) {
          await sleep(1500 * attempt);
        }
      }
    }

    throw lastError;
  } finally {
    sending = false;
  }
}

async function safeSendChannelImage(
  buffer,
  caption = ''
) {
  while (sending) {
    await sleep(300);
  }

  sending = true;

  try {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await sendChannelImage(
          buffer,
          caption
        );
      } catch (err) {
        lastError = err;

        console.error(
          `[IMAGE RETRY ${attempt}/3]`,
          err?.stack || err
        );

        if (attempt < 3) {
          await sleep(1500 * attempt);
        }
      }
    }

    throw lastError;
  } finally {
    sending = false;
  }
}

async function connectWhatsApp() {
  if (reconnecting) return;

  reconnecting = true;

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      SESSION_DIR
    );

    let version;

    try {
      const latest =
        await fetchLatestBaileysVersion();

      version = latest.version;
    } catch {}

    const options = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          logger
        )
      },

      logger,

      printQRInTerminal: false,

      browser: [
        'Kink Sanz Auto Post',
        'Chrome',
        '1.0.0'
      ],

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false
    };

    if (version) {
      options.version = version;
    }

    sock = makeWASocket(options);

    sock.ev.on(
      'creds.update',
      saveCreds
    );

    sock.ev.on(
      'connection.update',
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          currentQR = qr;
          console.log(
            '[QR] QR tersedia.'
          );
        }

        if (connection === 'open') {
          connected = true;
          currentQR = null;
          lastConnectionError = null;

          console.log(
            'WhatsApp terhubung:',
            sock?.user?.id || 'unknown'
          );
        }

        if (connection === 'close') {
          connected = false;

          const error =
            lastDisconnect?.error ||
            lastDisconnect?.exception ||
            null;

          lastConnectionError =
            error?.message ||
            String(error || 'Connection closed');

          console.error(
            '[WA CLOSED]',
            lastConnectionError
          );

          const statusCode =
            error?.output?.statusCode ||
            error?.statusCode;

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          if (shouldReconnect) {
            await sleep(3000);

            reconnecting = false;

            connectWhatsApp().catch(
              err => {
                console.error(
                  '[RECONNECT ERROR]',
                  err?.stack || err
                );
              }
            );
          }
        }
      }
    );

    console.log(
      '[WA] Socket dibuat.'
    );

  } catch (err) {
    connected = false;

    lastConnectionError =
      err?.message ||
      String(err);

    console.error(
      '[WA CONNECT ERROR]',
      err?.stack || err
    );

  } finally {
    reconnecting = false;
  }
}

/* =========================
   STATUS
========================= */

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      ok: true,
      connected,
      account:
        sock?.user?.id || null,

      channel: {
        name: CHANNEL_NAME,
        jid: CHANNEL_JID,
        link: CHANNEL_LINK
      },

      qrAvailable:
        Boolean(currentQR),

      lastConnectionError
    });
  }
);

/* =========================
   QR
========================= */

app.get(
  '/api/qr',
  async (req, res) => {
    try {
      if (connected) {
        return res.json({
          ok: true,
          connected: true,
          qr: null
        });
      }

      if (!currentQR) {
        return res.status(404).json({
          ok: false,
          error:
            'QR belum tersedia.'
        });
      }

      const qr =
        await QRCode.toDataURL(
          currentQR,
          {
            width: 400,
            margin: 2
          }
        );

      res.json({
        ok: true,
        connected: false,
        qr
      });

    } catch (err) {
      res.status(500).json({
        ok: false,
        error:
          err?.message ||
          String(err)
      });
    }
  }
);

/* =========================
   TEST CHANNEL
========================= */

app.post(
  '/api/test-channel',
  async (req, res) => {
    try {
      const text =
        req.body?.text ||
        'TES AUTO POST KINK SANZ';

      const result =
        await safeSendChannelText(text);

      res.json({
        ok: true,
        result
      });

    } catch (err) {
      console.error(
        '[TEST CHANNEL ERROR]',
        err?.stack || err
      );

      res.status(500).json({
        ok: false,
        error:
          err?.message ||
          String(err)
      });
    }
  }
);

/* =========================
   AUTO POST
========================= */

app.post(
  '/api/japost',
  async (req, res) => {
    try {
      if (!checkSecret(req)) {
        return res.status(401).json({
          ok: false,
          error: 'Secret salah.'
        });
      }

      const body = req.body || {};

      const type =
        String(body.type || 'SELL')
          .toUpperCase();

      const queue =
        body.queue ||
        body.noAntrean ||
        '-';

      const code =
        body.code ||
        body.kode ||
        '-';

      let format = '';

      if (type === 'BUY') {
        format =
`NO ANTREAN: ${queue}
KODE: ${code}

FORMAT JASA POST KINK SANZ!
( BUKAN MILIK ADMIN )

*NEED*: ${body.need || '-'}
*HARGA*: ${body.harga || '-'}
*LOG*: ${body.log || '-'}
*MC*: KINK SANZ
*4 NO BELAKANG LU*: ${body.last4 || '-'}

WAJIB MENGGUNAKAN REKBER KINK SANZ AGAR TERHINDAR DARI PENIPUAN

WA REKBER KINK SANZ 085236988992`;

      } else {
        format =
`NO ANTREAN: ${queue}
KODE: ${code}

FORMAT JASA POST KINK SANZ!
( BUKAN MILIK ADMIN )

*SPEK*: ${body.spek || '-'}
*DANA*: ${body.dana || '-'}
*4 NO BELAKANG LU*: ${body.last4 || '-'}

WAJIB MENGGUNAKAN REKBER KINK SANZ AGAR TERHINDAR DARI PENIPUAN

WA REKBER KINK SANZ 085236988992`;
      }

      const imageUrl =
        body.photo ||
        body.image ||
        body.imageUrl ||
        null;

      let result;

      if (
        imageUrl &&
        typeof imageUrl === 'string'
      ) {
        const response =
          await fetch(imageUrl);

        if (!response.ok) {
          throw new Error(
            `Foto gagal diambil: HTTP ${response.status}`
          );
        }

        const arrayBuffer =
          await response.arrayBuffer();

        const buffer =
          Buffer.from(arrayBuffer);

        result =
          await safeSendChannelImage(
            buffer,
            format
          );

      } else {
        result =
          await safeSendChannelText(
            format
          );
      }

      res.json({
        ok: true,
        autoPost: true,
        result
      });

    } catch (err) {
      console.error(
        '[JAPOST ERROR]',
        err?.stack || err
      );

      res.status(500).json({
        ok: false,
        autoPost: false,
        error:
          err?.message ||
          String(err)
      });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Kink Sanz Auto Post berjalan di port ${PORT}`
    );

    console.log(
      'Channel:',
      CHANNEL_NAME
    );

    console.log(
      'Channel JID:',
      CHANNEL_JID
    );
  }
);

connectWhatsApp().catch(
  (err) => {
    console.error(
      '[INITIAL CONNECT ERROR]',
      err?.stack || err
    );
  }
);
