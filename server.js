import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

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
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '12mb' }));

let sock = null;
let qrDataUrl = '';
let connectionState = 'starting';
let channelJid = '';
let channelName = '';
let lastPost = null;
let reconnectTimer = null;

function getChannelCode(link) {
  const match = String(link).match(
    /whatsapp\.com\/channel\/([^/?]+)/i
  );
  return match ? match[1] : '';
}

async function resolveChannel() {
  if (!sock) throw new Error('WhatsApp belum terhubung');

  const code = getChannelCode(CHANNEL_LINK);
  if (!code) throw new Error('CHANNEL_LINK tidak valid');

  const meta = await sock.newsletterMetadata('invite', code);

  if (!meta?.id) {
    throw new Error('Channel ID tidak ditemukan');
  }

  channelJid = meta.id;
  channelName = meta.name || '';

  return meta;
}

async function startWhatsApp() {
  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr, {
          margin: 2,
          width: 320
        });
        connectionState = 'scan_qr';
        logger.info('QR tersedia di /qr');
      }

      if (connection === 'open') {
        qrDataUrl = '';
        connectionState = 'connected';

        logger.info('WhatsApp terhubung');

        try {
          const meta = await resolveChannel();
          logger.info(
            {
              channelJid: meta.id,
              channelName: meta.name || ''
            },
            'Channel terdeteksi'
          );
        } catch (error) {
          logger.error(
            { err: error },
            'Gagal resolve channel'
          );
        }
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        connectionState = 'disconnected';
        sock = null;

        logger.warn(
          { statusCode },
          'WhatsApp terputus'
        );

        if (
          statusCode !== DisconnectReason.loggedOut &&
          !reconnectTimer
        ) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startWhatsApp().catch(error => {
              logger.error(
                { err: error },
                'Reconnect gagal'
              );
            });
          }, 3000);
        }
      }
    });
  } catch (error) {
    connectionState = 'error';
    logger.error(
      { err: error },
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

function checkSecret(req, res, next) {
  if (!CALLBACK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum diset'
    });
  }

  if (req.get('X-Japost-Secret') !== CALLBACK_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  next();
}

function buildCaption(order) {
  return String(order?.format || '')
    .replace(/\r/g, '')
    .trim();
}

app.get('/', (_req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kink Sanz Auto Post</title>
<style>
body{
  font-family:Arial,sans-serif;
  background:#07111f;
  color:#fff;
  max-width:620px;
  margin:auto;
  padding:24px;
}
.card{
  background:#111c2c;
  border-radius:16px;
  padding:20px;
}
a{
  display:inline-block;
  background:#10b981;
  color:#fff;
  padding:12px 16px;
  border-radius:10px;
  text-decoration:none;
}
pre{
  white-space:pre-wrap;
  background:#07111f;
  padding:14px;
  border-radius:10px;
  overflow:auto;
}
</style>
</head>
<body>
<div class="card">
<h1>Kink Sanz Auto Post</h1>
<p>Server: <b>ONLINE</b></p>
<p>Port: <b>${PORT}</b></p>
<p>WhatsApp: <b id="status">loading...</b></p>
<p>Channel: <b id="channel">-</b></p>
<p><a href="/qr">Buka QR WhatsApp</a></p>
<pre id="data">loading...</pre>
</div>
<script>
async function loadStatus(){
  try{
    const r = await fetch('/api/status');
    const d = await r.json();
    document.getElementById('status').textContent = d.connection;
    document.getElementById('channel').textContent =
      d.channelName || d.channelJid || '-';
    document.getElementById('data').textContent =
      JSON.stringify(d,null,2);
  }catch(e){
    document.getElementById('data').textContent = e.message;
  }
}
loadStatus();
setInterval(loadStatus,5000);
</script>
</body>
</html>
  `);
});

app.get('/qr', (_req, res) => {
  if (!qrDataUrl) {
    return res.send(`
<!doctype html>
<html>
<body style="
font-family:Arial;
background:#07111f;
color:#fff;
text-align:center;
padding:30px;
">
<h2>QR belum tersedia</h2>
<p>Status: ${connectionState}</p>
<script>
setTimeout(()=>location.reload(),3000);
</script>
</body>
</html>
`);
  }

  res.send(`
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scan WhatsApp</title>
</head>
<body style="
font-family:Arial;
background:#07111f;
color:#fff;
text-align:center;
padding:24px;
">
<h2>Scan WhatsApp → Perangkat tertaut</h2>
<img src="${qrDataUrl}" style="
width:320px;
max-width:90%;
background:#fff;
padding:12px;
border-radius:14px;
">
<p>QR otomatis diperbarui.</p>
<script>
setTimeout(()=>location.reload(),15000);
</script>
</body>
</html>
`);
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    connection: connectionState,
    channelJid,
    channelName,
    lastPost
  });
});

app.post('/api/resolve-channel', async (_req, res) => {
  try {
    const meta = await resolveChannel();
    res.json({
      ok: true,
      id: meta.id,
      name: meta.name || ''
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/api/callback', checkSecret, async (req, res) => {
  try {
    const order = req.body || {};

    const orderId =
      order.orderId ||
      order.queueCode ||
      `KS-${Date.now()}`;

    const orderCode =
      order.orderCode ||
      order.queueCode ||
      orderId;

    const type = String(order.type || '').toUpperCase();

    if (!['SELL', 'BUY'].includes(type)) {
      return res.status(400).json({
        ok: false,
        error: 'Type harus SELL atau BUY'
      });
    }

    if (!sock || connectionState !== 'connected') {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp belum terhubung'
      });
    }

    if (!channelJid) {
      await resolveChannel();
    }

    const caption = buildCaption(order);

    if (!caption) {
      return res.status(400).json({
        ok: false,
        error: 'Format posting kosong'
      });
    }

    let result;

    if (type === 'SELL' && order.photoDataUrl) {
      const comma = order.photoDataUrl.indexOf(',');

      const mimePart =
        comma >= 0
          ? order.photoDataUrl.slice(0, comma)
          : '';

      const base64 =
        comma >= 0
          ? order.photoDataUrl.slice(comma + 1)
          : order.photoDataUrl;

      const mime =
        (
          mimePart.match(/data:([^;]+);base64/i) || []
        )[1] ||
        order.photoMime ||
        'image/jpeg';

      const buffer = Buffer.from(base64, 'base64');

      if (buffer.length > 8 * 1024 * 1024) {
        throw new Error('Foto terlalu besar. Maksimal 8 MB.');
      }

      result = await sock.sendMessage(channelJid, {
        image: buffer,
        mimetype: mime,
        caption
      });
    } else {
      result = await sock.sendMessage(channelJid, {
        text: caption
      });
    }

    lastPost = {
      orderId,
      orderCode,
      type,
      at: new Date().toISOString(),
      messageId: result?.key?.id || null
    };

    logger.info(
      { orderId, orderCode, type },
      'Auto post berhasil'
    );

    res.json({
      ok: true,
      orderId,
      orderCode,
      type,
      channelJid,
      messageId: result?.key?.id || null
    });
  } catch (error) {
    logger.error(
      { err: error },
      'Auto post gagal'
    );

    res.status(500).json({
      ok: false,
      error: error.message || 'Auto post gagal'
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Endpoint tidak ditemukan'
  });
});

app.listen(PORT, HOST, () => {
  logger.info(
    `Kink Sanz Auto Post berjalan di http://${HOST}:${PORT}`
  );

  startWhatsApp().catch(error => {
    logger.error(
      { err: error },
      'Gagal start WhatsApp'
    );
  });
});
'''

path = Path("/mnt/data/server.js")
path.write_text(server, encoding="utf-8")
print("Selesai:", path)
  
