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
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const PORT = process.env.PORT || 8080;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';

const CHANNEL_JID = '120363406356211250@newsletter';
const CHANNEL_NAME = 'JAPOST KINKSANZ (GRATIS)';
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
  new Promise((resolve) => setTimeout(resolve, ms));

function getMessageId(result) {
  return result?.key?.id || null;
}

function getPhoneFromJid(jid) {
  if (!jid) return null;

  return String(jid)
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');
}

function getContactJids() {
  if (!sock?.store?.contacts) return [];

  return Object.keys(sock.store.contacts)
    .filter((jid) => jid.endsWith('@s.whatsapp.net'));
}

async function sendChannelText(text) {
  if (!sock || !connected) {
    throw new Error('WhatsApp belum terhubung.');
  }

  if (!text || !String(text).trim()) {
    throw new Error('Pesan kosong.');
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
      remoteJid: result?.key?.remoteJid || CHANNEL_JID,
      status: result?.status ?? null
    })
  );

  return {
    ok: true,
    messageId: getMessageId(result),
    destination: CHANNEL_JID,
    channelName: CHANNEL_NAME
  };
}

async function sendChannelImage(buffer, caption = '') {
  if (!sock || !connected) {
    throw new Error('WhatsApp belum terhubung.');
  }

  if (!buffer) {
    throw new Error('Foto tidak tersedia.');
  }

  const result = await sock.sendMessage(
    CHANNEL_JID,
    {
      image: buffer,
      caption: caption || ''
    }
  );

  console.log(
    '[CHANNEL IMAGE RESULT]',
    JSON.stringify({
      id: getMessageId(result),
      remoteJid: result?.key?.remoteJid || CHANNEL_JID,
      status: result?.status ?? null
    })
  );

  return {
    ok: true,
    messageId: getMessageId(result),
    destination: CHANNEL_JID,
    channelName: CHANNEL_NAME
  };
}

function checkSecret(req) {
  if (!CALLBACK_SECRET) return true;

  const headerSecret =
    req.headers['x-japost-secret'] ||
    req.headers['x-callback-secret'] ||
    req.body?.secret;

  return String(headerSecret || '') === String(CALLBACK_SECRET);
}

async function safeSendChannelText(text) {
  while (sending) {
    await sleep(500);
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
          `[CHANNEL RETRY ${attempt}/3]`,
          err?.stack || err?.message || err
        );

        if (attempt < 3) {
          await sleep(1500 * attempt);
        }
      }
    }

    throw lastError || new Error('Gagal mengirim ke Channel.');
  } finally {
    sending = false;
  }
}

async function safeSendChannelImage(buffer, caption = '') {
  while (sending) {
    await sleep(500);
  }

  sending = true;

  try {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await sendChannelImage(buffer, caption);
      } catch (err) {
        lastError = err;

        console.error(
          `[CHANNEL IMAGE RETRY ${attempt}/3]`,
          err?.stack || err?.message || err
        );

        if (attempt < 3) {
          await sleep(1500 * attempt);
        }
      }
    }

    throw lastError || new Error('Gagal mengirim foto ke Channel.');
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
    } = await useMultiFileAuthState(SESSION_DIR);

    let version;

    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = undefined;
    }

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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        currentQR = qr;

        try {
          console.log(
            '[QR] QR baru tersedia.'
          );
        } catch {}
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
          statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log(
            '[WA] Mencoba reconnect...'
          );

          await sleep(3000);

          reconnecting = false;

          connectWhatsApp().catch((err) => {
            console.error(
              '[RECONNECT ERROR]',
              err?.stack || err
            );
          });

          return;
        }

        console.error(
          '[WA] Session logout. Jangan hapus session otomatis.'
        );
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      console.log(
        '[CONTACTS UPSERT]',
        contacts?.length || 0
      );
    });

    sock.ev.on('contacts.update', (contacts) => {
      console.log(
        '[CONTACTS UPDATE]',
        contacts?.length || 0
      );
    });

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
   API STATUS
========================= */

app.get('/api/status', (req, res) => {
  const contacts = getContactJids();

  res.json({
    ok: true,
    connected,
    account: sock?.user?.id || null,

    channel: {
      name: CHANNEL_NAME,
      jid: CHANNEL_JID,
      link: CHANNEL_LINK
    },

    contacts: contacts.length,

    qrAvailable: Boolean(currentQR),

    lastConnectionError
  });
});

/* =========================
   API QR
========================= */

app.get('/api/qr', async (req, res) => {
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
        connected: false,
        error: 'QR belum tersedia.'
      });
    }

    const qrDataUrl = await QRCode.toDataURL(
      currentQR,
      {
        width: 400,
        margin: 2
      }
    );

    res.json({
      ok: true,
      connected: false,
      qr: qrDataUrl
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err)
    });
  }
});

/* =========================
   TEST CHANNEL
========================= */

app.post('/api/test-channel', async (req, res) => {
  try {
    const text =
      req.body?.text ||
      'TES AUTO POST KINK SANZ';

    const result =
      await safeSendChannelText(text);

    res.json({
      time: new Date().toISOString(),
      type: 'CHANNEL',
      result
    });

  } catch (err) {
    console.error(
      '[TEST CHANNEL ERROR]',
      err?.stack || err
    );

    res.status(500).json({
      time: new Date().toISOString(),
      type: 'CHANNEL',
      result: {
        ok: false,
        error:
          err?.message ||
          String(err)
      }
    });
  }
});

/* =========================
   TEST POST
========================= */

app.post('/api/test-post', async (req, res) => {
  try {
    const text =
      req.body?.text ||
      `🔥 JAPOST FREE KINK SANZ

TES AUTO POST

MC: KINK SANZ`;

    const result =
      await safeSendChannelText(text);

    res.json({
      time: new Date().toISOString(),
      type: 'TEST_POST',
      result
    });

  } catch (err) {
    console.error(
      '[TEST POST ERROR]',
      err?.stack || err
    );

    res.status(500).json({
      time: new Date().toISOString(),
      type: 'TEST_POST',
      result: {
        ok: false,
        error:
          err?.message ||
          String(err)
      }
    });
  }
});

/* =========================
   CALLBACK JAPOST
========================= */

app.post('/api/callback', async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Secret callback salah.'
      });
    }

    const body = req.body || {};

    const text =
      body.text ||
      body.message ||
      body.format ||
      body.caption ||
      '';

    if (!String(text).trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Format/pesan kosong.'
      });
    }

    console.log(
      '[CALLBACK]',
      JSON.stringify({
        type: body.type || 'JAPOST',
        hasPhoto: Boolean(
          body.photo ||
          body.image ||
          body.imageUrl
        ),
        textLength: String(text).length
      })
    );

    /*
      Jika callback mengirim foto sebagai URL,
      server mencoba mengambil URL tersebut.
    */

    const imageUrl =
      body.photo ||
      body.image ||
      body.imageUrl ||
      null;

    let result;

    if (
      imageUrl &&
      typeof imageUrl === 'string' &&
      /^https?:\/\//i.test(imageUrl)
    ) {
      try {
        const response = await fetch(imageUrl);

        if (!response.ok) {
          throw new Error(
            `Gagal mengambil foto: HTTP ${response.status}`
          );
        }

        const arrayBuffer =
          await response.arrayBuffer();

        const buffer =
          Buffer.from(arrayBuffer);

        result =
          await safeSendChannelImage(
            buffer,
            String(text)
          );

      } catch (imageError) {
        console.error(
          '[CALLBACK IMAGE ERROR]',
          imageError?.stack ||
          imageError
        );

        /*
          Kalau foto gagal, tetap coba
          kirim format sebagai teks.
        */

        result =
          await safeSendChannelText(
            String(text)
          );
      }

    } else {
      result =
        await safeSendChannelText(
          String(text)
        );
    }

    res.json({
      ok: true,
      type: 'JAPOST',
      result
    });

  } catch (err) {
    console.error(
      '[CALLBACK ERROR]',
      err?.stack || err
    );

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        String(err)
    });
  }
});

/* =========================
   JAPOST ENDPOINT
========================= */

app.post('/api/japost', async (req, res) => {
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

    let text = '';

    if (type === 'BUY') {
      text = `FORMAT JAPOST KINK SANZ

NEED: ${body.need || '-'}
HARGA: ${body.harga || '-'}
LOG: ${body.log || '-'}
MC: KINK SANZ
4 NO BELAKANG LU: ${body.last4 || '-'}

WAJIB MENGGUNAKAN REKBER KINK SANZ.`;

    } else {
      text = `FORMAT JAPOST KINK SANZ

SPEK: ${body.spek || '-'}
DANA: ${body.dana || '-'}
4 NO BELAKANG LU: ${body.last4 || '-'}

MC: KINK SANZ

WAJIB MENGGUNAKAN REKBER KINK SANZ.`;
    }

    const result =
      await safeSendChannelText(text);

    res.json({
      ok: true,
      type,
      result
    });

  } catch (err) {
    console.error(
      '[JAPOST ERROR]',
      err?.stack || err
    );

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        String(err)
    });
  }
});

/* =========================
   HOME
========================= */

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1.0">

<title>Kink Sanz Auto Post</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background:
    radial-gradient(
      circle at top,
      #0c4a6e,
      #020617 55%
    );
  color: white;
  min-height: 100vh;
}

.container {
  width: min(950px, 94%);
  margin: auto;
  padding: 25px 0 50px;
}

.header {
  background: rgba(2, 6, 23, .78);
  border: 1px solid rgba(56,189,248,.25);
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 18px;
}

.logo {
  font-size: 28px;
  font-weight: 900;
}

.subtitle {
  color: #7dd3fc;
  margin-top: 5px;
}

.card {
  background: rgba(2, 6, 23, .75);
  border: 1px solid rgba(56,189,248,.2);
  border-radius: 18px;
  padding: 18px;
  margin-top: 15px;
}

.title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 12px;
}

.info {
  line-height: 1.8;
  color: #dbeafe;
}

.status {
  display: inline-block;
  padding: 6px 10px;
  border-radius: 999px;
  background: #172554;
  margin-bottom: 10px;
}

button {
  border: 0;
  border-radius: 12px;
  padding: 12px 16px;
  margin: 5px 4px 5px 0;
  background: #0284c7;
  color: white;
  font-weight: 800;
  cursor: pointer;
}

button:hover {
  background: #0369a1;
}

input, textarea {
  width: 100%;
  border: 1px solid #164e63;
  background: #020617;
  color: white;
  border-radius: 10px;
  padding: 12px;
  margin: 7px 0;
  outline: none;
}

textarea {
  min-height: 120px;
  resize: vertical;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: #020617;
  padding: 14px;
  border-radius: 12px;
  overflow: auto;
  color: #bae6fd;
}

a {
  color: #38bdf8;
}
</style>
</head>

<body>

<div class="container">

  <div class="header">
    <div class="logo">
      Kink Sanz
    </div>

    <div class="subtitle">
      Auto Post Japost
    </div>
  </div>

  <div class="card">
    <div class="title">
      Status WhatsApp
    </div>

    <div id="status"
         class="status">
      Mengecek...
    </div>

    <div id="info"
         class="info">
      -
    </div>
  </div>

  <div class="card">
    <div class="title">
      Channel
    </div>

    <div class="info">
      <b>${CHANNEL_NAME}</b>
      <br>
      ${CHANNEL_JID}
      <br><br>

      <a
        href="${CHANNEL_LINK}"
        target="_blank">
        Buka Channel
      </a>
    </div>
  </div>

  <div class="card">
    <div class="title">
      Test Auto Post
    </div>

    <textarea
      id="message"
      placeholder="Tulis pesan untuk test Channel...">TES AUTO POST KINK SANZ</textarea>

    <button onclick="testChannel()">
      TES CHANNEL
    </button>

    <button onclick="testPost()">
      TES POST
    </button>

    <pre id="result">Belum ada hasil.</pre>
  </div>

  <div class="card"
       id="qrCard"
       style="display:none">

    <div class="title">
      Scan QR WhatsApp
    </div>

    <img
      id="qr"
      style="
        width:100%;
        max-width:400px;
        border-radius:15px;
        background:white;
        padding:10px;
      "
    >

  </div>

</div>

<script>

async function refreshStatus() {
  try {
    const response =
      await fetch('/api/status');

    const data =
      await response.json();

    const status =
      document.getElementById('status');

    const info =
      document.getElementById('info');

    if (data.connected) {
      status.textContent =
        '🟢 WhatsApp TERHUBUNG';

      info.innerHTML =
        'Akun: ' +
        (data.account || '-') +
        '<br>' +
        'Kontak: ' +
        (data.contacts || 0) +
        '<br>' +
        'Channel: ' +
        '${CHANNEL_NAME}';

      document.getElementById(
        'qrCard'
      ).style.display = 'none';

    } else {
      status.textContent =
        '🔴 WhatsApp BELUM TERHUBUNG';

      info.innerHTML =
        'QR tersedia: ' +
        (data.qrAvailable ? 'YA' : 'BELUM') +
        '<br>' +
        'Error terakhir: ' +
        (data.lastConnectionError || '-');

      loadQR();
    }

  } catch (error) {
    document.getElementById(
      'status'
    ).textContent =
      '⚠️ SERVER ERROR';
  }
}

async function loadQR() {
  try {
    const response =
      await fetch('/api/qr');

    if (!response.ok) return;

    const data =
      await response.json();

    if (!data.qr) return;

    document.getElementById(
      'qrCard'
    ).style.display = 'block';

    document.getElementById(
      'qr'
    ).src = data.qr;

  } catch {}
}

async function testChannel() {
  const text =
    document.getElementById(
      'message'
    ).value;

  const result =
    document.getElementById(
      'result'
    );

  result.textContent =
    'Mengirim ke Channel...';

  try {
    const response =
      await fetch('/api/test-channel', {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          text
        })
      });

    const data =
      await response.json();

    result.textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  } catch (error) {
    result.textContent =
      error.message;
  }
}

async function testPost() {
  const text =
    document.getElementById(
      'message'
    ).value;

  const result =
    document.getElementById(
      'result'
    );

  result.textContent =
    'Mengirim test post...';

  try {
    const response =
      await fetch('/api/test-post', {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          text
        })
      });

    const data =
      await response.json();

    result.textContent =
      JSON.stringify(
        data,
        null,
        2
      );

  } catch (error) {
    result.textContent =
      error.message;
  }
}

refreshStatus();

setInterval(
  refreshStatus,
  5000
);

</script>

</body>
</html>`);
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
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

  console.log(
    'Channel Link:',
    CHANNEL_LINK
  );
});

connectWhatsApp().catch((err) => {
  console.error(
    '[INITIAL CONNECT ERROR]',
    err?.stack || err
  );
});
