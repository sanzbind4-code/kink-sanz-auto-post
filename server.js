import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} from '@itsliaaa/baileys';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';
const CHANNEL_JID = '120363406356211250@newsletter';
const CHANNEL_NAME = 'JAPOST KINKSANZ (GRATIS)';

app.use(express.json({ limit: '50mb' }));

let sock;
let connected = false;
let qrText = '';
let lastTest = null;
let contacts = new Set();
let reconnecting = false;

const logger = pino({ level: 'silent' });

function requireSecret(req, res, next) {
  if (!CALLBACK_SECRET) {
    return res.status(500).json({
      ok: false,
      error: 'CALLBACK_SECRET belum diatur di Environment Variables.'
    });
  }

  if (req.get('X-Japost-Secret') !== CALLBACK_SECRET) {
    return res.status(401).json({
      ok: false,
      error: 'Secret salah.'
    });
  }

  next();
}

function getContactJids() {
  const result = new Set(contacts);

  if (sock?.user?.id) {
    result.add(sock.user.id);
  }

  return [...result].filter(jid =>
    typeof jid === 'string' && jid.includes('@')
  );
}

async function connectWhatsApp() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState('./session');

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Kink Sanz Auto Post', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', items => {
      for (const item of items || []) {
        if (item.id) contacts.add(item.id);
      }
    });

    sock.ev.on('contacts.update', items => {
      for (const item of items || []) {
        if (item.id) contacts.add(item.id);
      }
    });

    sock.ev.on('messaging-history.set', data => {
      for (const item of data.contacts || []) {
        if (item.id) contacts.add(item.id);
      }
    });

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrText = qr;
        console.log('QR tersedia. Buka halaman server untuk melihat QR.');
      }

      if (connection === 'open') {
        connected = true;
        qrText = '';
        console.log('WhatsApp terhubung:', sock.user?.id || 'connected');
      }

      if (connection === 'close') {
        connected = false;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log('Koneksi terputus. Kode:', statusCode || 'unknown');

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            reconnecting = false;
            connectWhatsApp();
          }, 3000);
        } else {
          console.log(
            'Sesi logout. Periksa sesi WhatsApp dan lakukan pairing ulang.'
          );
        }
      }
    });
  } catch (err) {
    connected = false;
    console.error('Gagal membuat koneksi WhatsApp:', err.message);

    setTimeout(() => {
      reconnecting = false;
      connectWhatsApp();
    }, 5000);

    return;
  }

  reconnecting = false;
}

async function sendChannelText(text) {
  if (!connected || !sock) {
    throw new Error('WhatsApp belum terhubung.');
  }

  const result = await sock.sendMessage(CHANNEL_JID, { text });

  return {
    ok: true,
    messageId: result?.key?.id || null,
    destination: CHANNEL_JID,
    note: 'Pesan dikirim ke API Saluran; periksa Saluran untuk memastikan tampil.'
  };
}

async function sendStatusText(text) {
  if (!connected || !sock) {
    throw new Error('WhatsApp belum terhubung.');
  }

  const recipients = getContactJids();

  if (recipients.length === 0) {
    throw new Error(
      'Daftar kontak penerima kosong. Status belum dicoba dikirim.'
    );
  }

  const result = await sock.sendMessage(
    'status@broadcast',
    { text },
    { statusJidList: recipients }
  );

  return {
    ok: true,
    messageId: result?.key?.id || null,
    recipients: recipients.length,
    destination: 'status@broadcast',
    note: 'API mengembalikan hasil kirim. Periksa WhatsApp untuk memastikan Status benar-benar muncul.'
  };
}

app.get('/api/status', (req, res) => {
  res.json({
    connected,
    status: connected ? 'connected' : 'disconnected',
    channelName: CHANNEL_NAME,
    channelJid: CHANNEL_JID,
    contactCount: contacts.size,
    lastTest
  });
});

app.get('/api/qr', async (req, res) => {
  if (connected) {
    return res.type('text').send('WhatsApp sudah terhubung.');
  }

  if (!qrText) {
    return res.status(404).type('text').send(
      'QR belum tersedia. Tunggu beberapa detik lalu muat ulang.'
    );
  }

  try {
    const image = await QRCode.toBuffer(qrText, {
      type: 'png',
      width: 320,
      margin: 2
    });

    res.type('png').send(image);
  } catch {
    res.status(500).type('text').send('Gagal membuat gambar QR.');
  }
});

app.post('/api/test-channel', requireSecret, async (req, res) => {
  try {
    const text = String(req.body?.text || 'TES SALURAN KINK SANZ');

    const result = await sendChannelText(text);

    lastTest = {
      time: new Date().toISOString(),
      type: 'CHANNEL',
      result
    };

    res.json(lastTest);
  } catch (err) {
    lastTest = {
      time: new Date().toISOString(),
      type: 'CHANNEL',
      ok: false,
      error: err.message
    };

    res.status(500).json(lastTest);
  }
});

app.post('/api/test-status', requireSecret, async (req, res) => {
  try {
    const text = String(req.body?.text || 'TES STATUS KINK SANZ');

    const result = await sendStatusText(text);

    lastTest = {
      time: new Date().toISOString(),
      type: 'STATUS',
      result
    };

    res.json(lastTest);
  } catch (err) {
    lastTest = {
      time: new Date().toISOString(),
      type: 'STATUS',
      ok: false,
      error: err.message
    };

    res.status(500).json(lastTest);
  }
});

app.post('/api/japost', async (req, res) => {
  try {
    if (!connected || !sock) {
      return res.status(503).json({
        ok: false,
        error: 'WhatsApp belum terhubung.'
      });
    }

    const text = String(req.body?.text || '').trim();

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'Teks Japost kosong.'
      });
    }

    const results = {
      channel: { ok: false },
      status: { ok: false }
    };

    try {
      results.channel = {
        ok: true,
        result: await sendChannelText(text)
      };
    } catch (err) {
      results.channel = {
        ok: false,
        error: err.message
      };
    }

    try {
      results.status = {
        ok: true,
        result: await sendStatusText(text)
      };
    } catch (err) {
      results.status = {
        ok: false,
        error: err.message
      };
    }

    const ok = results.channel.ok || results.status.ok;

    lastTest = {
      time: new Date().toISOString(),
      type: 'JAPOST',
      results
    };

    res.status(ok ? 200 : 500).json({
      ok,
      partial: results.channel.ok !== results.status.ok,
      results
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/callback', requireSecret, async (req, res) => {
  const text = String(req.body?.text || req.body?.format || '').trim();

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: 'Field text atau format wajib diisi.'
    });
  }

  try {
    const results = {};

    try {
      results.channel = {
        ok: true,
        result: await sendChannelText(text)
      };
    } catch (err) {
      results.channel = { ok: false, error: err.message };
    }

    try {
      results.status = {
        ok: true,
        result: await sendStatusText(text)
      };
    } catch (err) {
      results.status = { ok: false, error: err.message };
    }

    const ok = results.channel.ok || results.status.ok;

    lastTest = {
      time: new Date().toISOString(),
      type: 'CALLBACK',
      results
    };

    res.status(ok ? 200 : 500).json({
      ok,
      partial: results.channel.ok !== results.status.ok,
      results
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kink Sanz Auto Post</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:18px;background:#061426;color:#eef6ff;font-family:Arial,sans-serif}
main{max-width:540px;margin:15px auto;background:#10243c;padding:22px;border-radius:18px;border:1px solid #214768}
h1{color:#38bdf8;margin-top:0}
.card{background:#071a2e;padding:14px;border-radius:10px;margin:12px 0;overflow-wrap:anywhere}
input,button{width:100%;padding:13px;margin-top:10px;border-radius:9px;font-size:15px}
input{background:#061426;color:white;border:1px solid #34516e}
button{border:0;background:#0284c7;color:white;font-weight:bold;cursor:pointer}
button:disabled{opacity:.5}
.small{font-size:13px;color:#b7cce0;line-height:1.5}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#061426;padding:12px;border-radius:8px}
.green{color:#4ade80;font-weight:bold}
img{max-width:100%;height:auto;border-radius:10px}
</style>
</head>
<body>
<main>
<h1>Kink Sanz Auto Post</h1>
<div class="card">Status koneksi: <span id="connection">Memuat...</span></div>
<div class="card">Channel: ${CHANNEL_NAME}</div>
<div class="card">Channel ID: ${CHANNEL_JID}</div>
<div class="card">Kontak penerima status: <span id="contacts">-</span></div>

<div id="qrbox" class="card" hidden>
<p>Scan QR melalui Perangkat Tertaut WhatsApp.</p>
<img src="/api/qr" alt="QR WhatsApp" id="qrimg">
<button onclick="refreshQR()">Muat ulang QR</button>
</div>

<label>Callback Secret</label>
<input id="secret" type="password" autocomplete="off"
placeholder="Masukkan CALLBACK_SECRET FadeHost">

<label>Pesan tes</label>
<input id="message" value="TES AUTO POST KINK SANZ">

<button onclick="test('/api/test-channel')">TES SALURAN WHATSAPP</button>
<button onclick="test('/api/test-status')">TES STATUS WHATSAPP</button>

<h3>Hasil tes terakhir</h3>
<pre id="result">Belum ada tes. Tekan salah satu tombol.</pre>
<p class="small">Tes akan mengirim pesan sungguhan. Respons API sukses belum menjamin Status terlihat di semua perangkat.</p>
</main>
<script>
async function refreshStatus(){
  try{
    const r=await fetch('/api/status');
    const d=await r.json();
    const el=document.getElementById('connection');
    el.textContent=d.connected?'connected':'disconnected';
    el.className=d.connected?'green':'';
    document.getElementById('contacts').textContent=d.contactCount ?? 0;
    document.getElementById('qrbox').hidden=!!d.connected;
    if(!d.connected) document.getElementById('qrimg').src='/api/qr?t='+Date.now();
    if(d.lastTest) document.getElementById('result').textContent=JSON.stringify(d.lastTest,null,2);
  }catch(e){
    document.getElementById('connection').textContent='Gagal membaca status';
  }
}
function refreshQR(){
  document.getElementById('qrimg').src='/api/qr?t='+Date.now();
}
async function test(endpoint){
  const secret=document.getElementById('secret').value.trim();
  const text=document.getElementById('message').value.trim();
  const out=document.getElementById('result');
  if(!secret){out.textContent='Isi CALLBACK_SECRET terlebih dahulu.';return;}
  if(!text){out.textContent='Pesan tes kosong.';return;}
  const buttons=[...document.querySelectorAll('button')];
  buttons.forEach(b=>b.disabled=true);
  out.textContent='Sedang mengirim tes...';
  try{
    const r=await fetch(endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Japost-Secret':secret},
      body:JSON.stringify({text})
    });
    const data=await r.json().catch(()=>({error:'Respons bukan JSON'}));
    out.textContent='HTTP '+r.status+'\\n'+JSON.stringify(data,null,2);
  }catch(e){
    out.textContent='Gagal menghubungi server: '+e.message;
  }finally{
    buttons.forEach(b=>b.disabled=false);
    refreshStatus();
  }
}
refreshStatus();
setInterval(refreshStatus,10000);
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Kink Sanz Auto Post berjalan di port', PORT);
  connectWhatsApp();
});
