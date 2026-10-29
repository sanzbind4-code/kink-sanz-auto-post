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

const PORT = process.env.PORT || 8080;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const CHANNEL_JID = '120363406356211250@newsletter';
const CHANNEL_NAME = 'JAPOST KINKSANZ (GRATIS)';
const CHANNEL_LINK =
  process.env.CHANNEL_LINK ||
  'https://whatsapp.com/channel/0029VbC8YTVGehEH4EHdMz44';

const SESSION_DIR = './session';

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const logger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'warn'
});

let sock = null;
let connected = false;
let currentQR = null;
let reconnecting = false;
let lastConnectionError = null;
let sending = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkSecret(req) {
  if (!CALLBACK_SECRET) return true;

  const secret =
    req.headers['x-japost-secret'] ||
    req.headers['x-callback-secret'] ||
    req.body?.secret;

  return String(secret || '') === String(CALLBACK_SECRET);
}

function getMessageId(result) {
  return result?.key?.id || null;
}

function getFourLast(whatsapp) {
  const clean = String(whatsapp || '').replace(/\D/g, '');

  if (clean.length < 4) {
    throw new Error('Nomor WhatsApp tidak valid.');
  }

  return clean.slice(-4);
}

/* =========================
   CHANNEL
========================= */

async function sendChannelText(text) {
  if (!sock || !connected) {
    throw new Error('WhatsApp belum terhubung.');
  }

  const result = await sock.sendMessage(CHANNEL_JID, {
    text: String(text)
  });

  console.log('[CHANNEL SEND]', {
    id: getMessageId(result),
    jid: result?.key?.remoteJid || CHANNEL_JID
  });

  return {
    ok: true,
    messageId: getMessageId(result),
    destination: CHANNEL_JID,
    channelName: CHANNEL_NAME,
    channelLink: CHANNEL_LINK
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
      } catch (error) {
        lastError = error;

        console.error(
          `[CHANNEL RETRY ${attempt}/3]`,
          error?.message || error
        );

        if (attempt < 3) {
          await sleep(1200 * attempt);
        }
      }
    }

    throw lastError || new Error('Gagal mengirim ke Channel.');
  } finally {
    sending = false;
  }
}

/* =========================
   WHATSAPP CONNECTION
========================= */

async function connectWhatsApp() {
  if (reconnecting) return;

  reconnecting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_DIR);

    let version;

    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {}

    const options = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: false,
      browser: ['Kink Sanz Auto Post', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    };

    if (version) options.version = version;

    sock = makeWASocket(options);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({
      connection,
      lastDisconnect,
      qr
    }) => {
      if (qr) {
        currentQR = qr;
        console.log('[QR] QR baru tersedia.');
      }

      if (connection === 'open') {
        connected = true;
        currentQR = null;
        lastConnectionError = null;

        console.log(
          '[WA] Terhubung:',
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

        const code =
          error?.output?.statusCode ||
          error?.statusCode;

        console.error('[WA CLOSED]', lastConnectionError);

        if (code !== DisconnectReason.loggedOut) {
          await sleep(3000);
          reconnecting = false;
          connectWhatsApp().catch((err) => {
            console.error('[RECONNECT]', err);
          });
        }
      }
    });
  } catch (error) {
    connected = false;
    lastConnectionError =
      error?.message || String(error);

    console.error('[WA CONNECT]', error);
  } finally {
    reconnecting = false;
  }
}

/* =========================
   STATUS / QR
========================= */

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    connected,
    account: sock?.user?.id || null,
    qrAvailable: Boolean(currentQR),
    lastConnectionError,
    channel: {
      name: CHANNEL_NAME,
      jid: CHANNEL_JID,
      link: CHANNEL_LINK
    }
  });
});

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
        error: 'QR belum tersedia.'
      });
    }

    const qr = await QRCode.toDataURL(currentQR, {
      width: 400,
      margin: 2
    });

    res.json({
      ok: true,
      connected: false,
      qr
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

/* =========================
   ADMIN LOGIN
   FIX: SELALU JSON
========================= */

app.post('/api/admin/login', (req, res) => {
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({
        ok: false,
        error: 'ADMIN_PASSWORD belum diatur di environment.'
      });
    }

    const password = String(req.body?.password || '');

    if (!password) {
      return res.status(400).json({
        ok: false,
        error: 'Password wajib diisi.'
      });
    }

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        ok: false,
        error: 'Password admin salah.'
      });
    }

    return res.json({
      ok: true,
      message: 'Login admin berhasil.'
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

/* =========================
   ADMIN QUEUE
   Tanpa data.json.
   Queue dibaca dari Firebase/index lama.
   Endpoint ini hanya kompatibilitas.
========================= */

app.post('/api/admin/verify', (req, res) => {
  const password = String(req.body?.password || '');

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: 'Password admin salah.'
    });
  }

  res.json({ ok: true });
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

    const result = await safeSendChannelText(text);

    res.json({
      ok: true,
      type: 'TEST_POST',
      result
    });
  } catch (error) {
    console.error('[TEST POST]', error);

    res.status(500).json({
      ok: false,
      type: 'TEST_POST',
      error: error?.message || String(error)
    });
  }
});

app.post('/api/test-channel', async (req, res) => {
  try {
    const text =
      req.body?.text ||
      'TES CHANNEL KINK SANZ';

    const result = await safeSendChannelText(text);

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

/* =========================
   JAPOST
   FOTO TIDAK DIKIRIM.
   SERVER KIRIM TEKS SAJA.
   4 NO BELAKANG OTOMATIS.
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
      String(body.type || 'SELL').toUpperCase();

    const whatsapp =
      String(body.whatsapp || '').trim();

    if (!whatsapp) {
      throw new Error('Nomor WhatsApp wajib diisi.');
    }

    const four = getFourLast(whatsapp);

    let format;

    if (type === 'SELL') {
      format = `FORMAT JASA POST KINK SANZ!
( BUKAN MILIK ADMIN )

*SPEK*: ${body.spek || '-'}
*DANA*: ${body.dana || '-'}
*4 NO BELAKANG LU*: ${four}

WAJIB MENGGUNAKAN REKBER KINK SANZ AGAR TERHINDAR DARI PENIPUAN

WA REKBER KINK SANZ
085236988992`;
    } else if (type === 'BUY') {
      format = `FORMAT JP NEED KINK SANZ

*NEED*: ${body.need || '-'}
*HARGA*: ${body.harga || '-'}
*LOG*: ${body.log || '-'}
*MC*: KINK SANZ
*4 NO BELAKANG LU*: ${four}

➖ NOMOR REKBER HANYA DI
085236988992

➖ WAJIB MENGGUNAKAN MC KINK SANZ`;
    } else {
      throw new Error('Tipe Japost tidak valid.');
    }

    const result = await safeSendChannelText(format);

    console.log('[JAPOST]', {
      type,
      whatsapp,
      four
    });

    return res.json({
      ok: true,
      type,
      whatsapp,
      four,
      format,
      autoPost: 'TERKIRIM',
      result
    });
  } catch (error) {
    console.error('[JAPOST ERROR]', error);

    return res.status(400).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

/* =========================
   CALLBACK
========================= */

app.post('/api/callback', async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Secret callback salah.'
      });
    }

    const text =
      req.body?.text ||
      req.body?.message ||
      req.body?.format ||
      '';

    if (!String(text).trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Format kosong.'
      });
    }

    const result =
      await safeSendChannelText(String(text));

    return res.json({
      ok: true,
      result
    });
  } catch (error) {
    console.error('[CALLBACK]', error);

    return res.status(500).json({
      ok: false,
      error: error?.message || String(error)
    });
  }
});

/* =========================
   HEALTH
========================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    server: 'Kink Sanz Auto Post',
    connected
  });
});

/*
  JANGAN KIRIM HTML DARI SERVER.JS.
  Index.html tetap file lama milik lu.
  Server ini fokus API saja.
*/

app.listen(PORT, () => {
  console.log(`Kink Sanz Auto Post berjalan di port ${PORT}`);
  console.log(`Channel: ${CHANNEL_NAME}`);
  console.log(`JID: ${CHANNEL_JID}`);
});

connectWhatsApp().catch((error) => {
  console.error('[INITIAL CONNECT]', error);
});
'''

path = "/mnt/data/server.js"
Path(path).write_text(server_js, encoding="utf-8")
print(path)
  
