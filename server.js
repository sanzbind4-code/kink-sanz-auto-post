import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@itsliaaa/baileys';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const SESSION_DIR = './session';

const CHANNEL_JID = '120363406356211250@newsletter';
const CHANNEL_NAME = 'JAPOST KINKSANZ (GRATIS)';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';
let lastPost = null;
let reconnectTimer = null;
let sendLock = false;

const contacts = new Map();

/* JSON tanpa batas ukuran dari middleware Express.
   Hosting/server tetap bisa memiliki batas resource sendiri. */
app.use(express.json({ limit: Infinity }));
app.use(express.urlencoded({ extended: true, limit: Infinity }));

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeJid(value) {
  const jid = clean(value);
  if (!jid) return '';

  // Hilangkan device suffix, jika ada.
  return jid.replace(/:\d+(?=@)/, '');
}

function rememberContacts(list = []) {
  for (const item of list) {
    const id = normalizeJid(
      typeof item === 'string' ? item : item?.id
    );

    if (
      id.endsWith('@s.whatsapp.net') ||
      id.endsWith('@lid')
    ) {
      contacts.set(id, true);
    }
  }
}

function statusRecipients() {
  const ownJid = normalizeJid(sock?.user?.id);
  const result = new Set(contacts.keys());

  if (ownJid) result.add(ownJid);

  return [...result];
}

/* Membaca foto asli: tanpa resize, canvas, atau konversi JPEG. */
function parseImage(value) {
  if (!value) return null;

  const source = String(value).trim();
  if (!source) return null;

  let base64 = source;
  let mime = 'image/jpeg';

  if (source.startsWith('data:')) {
    const comma = source.indexOf(',');
    if (comma < 0) throw new Error('Format foto tidak valid.');

    const header = source.slice(0, comma);
    base64 = source.slice(comma + 1);

    const match = header.match(/^data:([^;]+);base64$/i);
    if (!match) throw new Error('Format foto harus base64.');

    mime = match[1];
  }

  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length) throw new Error('Foto kosong atau tidak valid.');

  return { buffer, mime };
}

function makeCaption(order) {
  const queueNo = clean(order.queueNo);
  const orderCode = clean(order.orderCode);
  const format = clean(order.format);

  let text = '';

  if (queueNo) text += `NO ANTREAN: #${queueNo}\n`;
  if (orderCode) text += `KODE: ${orderCode}\n`;
  if (text) text += '\n';

  text += format;
  return text.trim();
}

/* KIRIM KE SALURAN */
async function sendToChannel(text, imageData = '') {
  if (!sock || connectionState !== 'connected') {
    throw new Error('WhatsApp belum tersambung.');
  }

  const image = parseImage(imageData);
  const content = image
    ? { image: image.buffer, mimetype: image.mime, caption: text }
    : { text };

  const result = await sock.sendMessage(CHANNEL_JID, content, {
    mediaUploadTimeoutMs: 120000
  });

  return {
    ok: true,
    messageId: result?.key?.id || null,
    mode: image ? 'image' : 'text'
  };
}

/* KIRIM KE STATUS WHATSAPP */
async function sendToStatus(text, imageData = '') {
  if (!sock || connectionState !== 'connected') {
    throw new Error('WhatsApp belum tersambung.');
  }

  const recipients = statusRecipients();

  // Jangan mengaku berhasil kalau kontak belum termuat.
  if (recipients.length < 2) {
    throw new Error(
      'Kontak WhatsApp belum termuat. Tunggu sinkronisasi kontak lalu tes lagi.'
    );
  }

  const image = parseImage(imageData);
  const content = image
    ? { image: image.buffer, mimetype: image.mime, caption: text }
    : { text };

  const result = await sock.sendMessage(
    'status@broadcast',
    content,
    {
      broadcast: true,
      statusJidList: recipients,
      mediaUploadTimeoutMs: 120000
    }
  );

  return {
    ok: true,
    messageId: result?.key?.id || null,
    mode: image ? 'image' : 'text',
    recipients: recipients.length
  };
}

/* SALURAN DAN STATUS DILAPORKAN TERPISAH */
async function processPost(order) {
  if (sendLock) {
    throw new Error('Server sedang memproses post lain. Coba lagi.');
  }

  sendLock = true;

  try {
    const text = makeCaption(order);
    if (!text) throw new Error('Format post kosong.');

    const imageData = order.photoData || order.photoDataUrl || '';

    const channelPromise = sendToChannel(text, imageData)
      .then(result => ({ ok: true, result }))
      .catch(error => ({ ok: false, error: error.message }));

    const statusPromise = sendToStatus(text, imageData)
      .then(result => ({ ok: true, result }))
      .catch(error => ({ ok: false, error: error.message }));

    const [channel, status] = await Promise.all([
      channelPromise,
      statusPromise
    ]);

    lastPost = {
      orderId: clean(order.orderId),
      orderCode: clean(order.orderCode),
      at: new Date().toISOString(),
      channel,
      status
    };

    return {
      ok: channel.ok && status.ok,
      orderId: clean(order.orderId),
      orderCode: clean(order.orderCode),
      channel,
      status
    };
  } finally {
    sendLock = false;
  }
}

/* TES TANPA FIRESTORE */
app.get('/api/test-post', async (req, res) => {
  const result = await processPost({
    orderId: 'TEST',
    orderCode: 'TEST',
    queueNo: 'TEST',
    format: [
      '🧪 TEST POST KINK SANZ',
      '',
      'Tes pengiriman Saluran dan Status WhatsApp.',
      'Jika Status gagal, lihat detail error di bawah.'
    ].join('\n')
  }).catch(error => ({
    ok: false,
    error: error.message
  }));

  res.status(result.ok ? 200 : 500).json(result);
});

/* HTML mengirim POST ke endpoint ini */
app.post('/api/japost', async (req, res) => {
  const result = await processPost(req.body || {})
    .catch(error => ({
      ok: false,
      error: error.message
    }));

  res.status(result.ok ? 200 : 500).json(result);
});

/* Endpoint callback yang membutuhkan secret server */
app.post('/api/callback', async (req, res) => {
  if (!CALLBACK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum disetel.'
    });
  }

  if ((req.get('X-Japost-Secret') || '') !== CALLBACK_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized.'
    });
  }

  const result = await processPost(req.body || {})
    .catch(error => ({
      ok: false,
      error: error.message
    }));

  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    connection: connectionState,
    qr: Boolean(qrDataUrl),
    channelJid: CHANNEL_JID,
    channelName: CHANNEL_NAME,
    channelLink: CHANNEL_LINK,
    contactsLoaded: contacts.size,
    statusRecipients: statusRecipients().length,
    lastPost
  });
});

/* QR WHATSAPP */
app.get('/qr', (req, res) => {
  if (!qrDataUrl) {
    return res.status(200).send(`
      <!doctype html>
      <html lang="id">
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>QR Kink Sanz</title>
      <body style="background:#061329;color:white;font-family:Arial;text-align:center;padding:40px">
        <h2>QR belum tersedia</h2>
        <p>WhatsApp sedang tersambung atau menunggu QR.</p>
        <a style="color:white" href="/qr">Refresh</a>
        <p><a style="color:white" href="/">Kembali</a></p>
      </body>
      </html>
    `);
  }

  res.send(`
    <!doctype html>
    <html lang="id">
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Scan QR Kink Sanz</title>
    <body style="background:#061329;color:white;font-family:Arial;text-align:center;padding:25px">
      <h2>SCAN QR WHATSAPP</h2>
      <img src="${qrDataUrl}" style="width:min(360px,90vw);background:white;padding:12px;border-radius:18px">
      <p>Scan menggunakan WhatsApp JB yang ingin dipakai.</p>
      <a style="color:white" href="/">Kembali</a>
    </body>
    </html>
  `);
});

app.get('/', (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="id">
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Kink Sanz Auto Post</title>
    <body style="background:#061329;color:white;font-family:Arial;padding:25px">
      <h1>KINK SANZ</h1>
      <p>Auto Post Japost</p>
      <p>WhatsApp: <b id="conn">Memuat...</b></p>
      <p>Kontak termuat: <b id="contacts">-</b></p>
      <p><a style="color:white" href="/qr">Tampilkan QR WhatsApp</a></p>
      <p><a style="color:white" href="/api/test-post">TEST POST SALURAN + STATUS</a></p>
      <pre id="last" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <script>
        async function refresh(){
          try{
            const r = await fetch('/api/status');
            const d = await r.json();
            document.querySelector('#conn').textContent = d.connection;
            document.querySelector('#contacts').textContent =
              d.contactsLoaded + ' (penerima Status: ' + d.statusRecipients + ')';
            document.querySelector('#last').textContent =
              JSON.stringify(d.lastPost, null, 2);
          }catch(e){}
        }
        refresh();
        setInterval(refresh, 5000);
      </script>
    </body>
    </html>
  `);
});

/* KONEKSI BAILEYS */
async function startWhatsApp() {
  try {
    connectionState = 'starting';

    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Kink Sanz Japost', 'Chrome', '1.0.0'],
      syncFullHistory: true,
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', list => {
      rememberContacts(list);
    });

    sock.ev.on('contacts.update', list => {
      rememberContacts(list);
    });

    sock.ev.on('messaging-history.set', update => {
      rememberContacts(update?.contacts || []);
    });

    sock.ev.on('connection.update', async update => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr);
        connectionState = 'qr';
      }

      if (connection === 'connecting') {
        connectionState = 'connecting';
      }

      if (connection === 'open') {
        connectionState = 'connected';
        qrDataUrl = '';
        logger.info({
          ownJid: normalizeJid(sock?.user?.id),
          contactsLoaded: contacts.size
        }, 'WhatsApp tersambung');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        connectionState = 'closed';

        logger.error({
          code,
          shouldReconnect
        }, 'WhatsApp terputus');

        if (shouldReconnect) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            startWhatsApp().catch(err => logger.error(err));
          }, 3000);
        }
      }
    });
  } catch (error) {
    connectionState = 'error';
    logger.error(error?.stack || error?.message || String(error));

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      startWhatsApp().catch(err => logger.error(err));
    }, 5000);
  }
}

app.listen(PORT, HOST, () => {
  logger.info(`Server berjalan di ${HOST}:${PORT}`);
});

startWhatsApp().catch(error => logger.error(error));
