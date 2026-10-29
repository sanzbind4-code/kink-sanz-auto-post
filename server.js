import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@itsliaaa/baileys';

const app = express();

const PORT = Number(process.env.PORT) || 8080;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';

let sock = null;
let qrData = null;
let connected = false;
let channelJid = null;
let channelName = null;

let lastPost = null;
let lastError = null;

// EXPRESS
app.use(express.json({limit:'30mb'}));

// CORS
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-callback-secret, X-Japost-Secret, Authorization'
  );

  if(req.method==='OPTIONS') return res.sendStatus(204);

  next();
});

// SECRET CHECK
function checkSecret(req){
  const headerSecret =
    req.headers['x-callback-secret'] ||
    req.headers['x-japost-secret'];

  const auth=req.headers.authorization||'';

  let bearerSecret='';

  if(auth.toLowerCase().startsWith('bearer ')){
    bearerSecret=auth.slice(7);
  }

  const bodySecret=req.body?.secret||'';

  return (
    headerSecret===CALLBACK_SECRET ||
    bearerSecret===CALLBACK_SECRET ||
    bodySecret===CALLBACK_SECRET
  );
}

// CHANNEL
async function resolveChannel(){
  if(!sock)return;

  try{
    if(CHANNEL_LINK){
      const inviteCode=CHANNEL_LINK.split('/').pop();

      if(inviteCode){
        try{
          const meta=await sock.newsletterMetadata(
            'invite',
            inviteCode
          );

          if(meta?.id){
            channelJid=meta.id;
          }

          channelName=
            typeof meta?.name==='string'
              ? meta.name
              : meta?.name?.text ||
                meta?.name?.default ||
                'JAPOST KINKSANZ (GRATIS)';

        }catch(e){
          console.log(
            'Gagal mengambil metadata channel:',
            e.message
          );
        }
      }
    }

    if(!channelJid){
      channelJid='120363406356211250@newsletter';
    }

    if(!channelName){
      channelName='JAPOST KINKSANZ (GRATIS)';
    }

    console.log('CHANNEL JID:',channelJid);
    console.log('CHANNEL NAME:',channelName);

  }catch(e){
    console.log(
      'Resolve channel error:',
      e.message
    );
  }
}

// START WHATSAPP
async function startWhatsApp(){
  const {state,saveCreds}=await useMultiFileAuthState(
    './auth_info'
  );

  sock=makeWASocket({
    auth:state,
    logger:pino({level:'silent'}),
    printQRInTerminal:false,
    browser:['Kink Sanz Japost','Chrome','1.0.0']
  });

  sock.ev.on(
    'creds.update',
    saveCreds
  );

  sock.ev.on(
    'connection.update',
    async(update)=>{
      const {
        connection,
        lastDisconnect,
        qr
      }=update;

      if(qr){
        qrData=await QRCode.toDataURL(qr);
        connected=false;

        console.log('QR tersedia di /qr');
      }

      if(connection==='open'){
        connected=true;
        qrData=null;
        lastError=null;

        console.log('WhatsApp TERHUBUNG');

        await resolveChannel();
      }

      if(connection==='close'){
        connected=false;

        const statusCode=
          lastDisconnect?.error?.output?.statusCode;

        console.log(
          'WhatsApp terputus:',
          statusCode
        );

        if(
          statusCode!==DisconnectReason.loggedOut
        ){
          setTimeout(
            startWhatsApp,
            3000
          );
        }else{
          console.log(
            'WhatsApp logout. Scan QR baru.'
          );
        }
      }
    }
  );
}

// DISCONNECT WHATSAPP
async function disconnectWhatsApp(){
  try{
    connected=false;
    qrData=null;
    channelJid=null;
    channelName=null;

    if(sock){
      try{
        await sock.logout();
      }catch(e){
        console.log(
          'Logout WA:',
          e.message
        );
      }

      sock=null;
    }

    try{
      await fs.rm(
        './auth_info',
        {
          recursive:true,
          force:true
        }
      );
    }catch(e){
      console.log(
        'Hapus session:',
        e.message
      );
    }

    console.log(
      'WhatsApp berhasil dilepas.'
    );

    setTimeout(()=>{
      startWhatsApp().catch(e=>{
        lastError=e.message;

        console.error(
          'Gagal membuat koneksi baru:',
          e
        );
      });
    },1000);

    return true;

  }catch(e){
    lastError=e.message;

    console.error(
      'DISCONNECT ERROR:',
      e
    );

    return false;
  }
}

// SEND TO CHANNEL
async function sendToChannel(
  text,
  imageData
){
  if(!sock || !connected){
    throw new Error(
      'WhatsApp belum terhubung'
    );
  }

  if(!channelJid){
    await resolveChannel();
  }

  if(!channelJid){
    throw new Error(
      'Channel JID belum ditemukan'
    );
  }

  // FOTO
  if(imageData){
    let imageBuffer;

    if(
      typeof imageData==='string' &&
      imageData.startsWith('data:')
    ){
      const base64=
        imageData.split(',')[1];

      imageBuffer=
        Buffer.from(
          base64,
          'base64'
        );

    }else if(
      typeof imageData==='string' &&
      imageData.startsWith('http')
    ){
      const response=
        await fetch(imageData);

      if(!response.ok){
        throw new Error(
          'Gagal mengambil foto dari URL'
        );
      }

      imageBuffer=
        Buffer.from(
          await response.arrayBuffer()
        );
    }

    if(!imageBuffer){
      throw new Error(
        'Format foto tidak valid'
      );
    }

    return await sock.sendMessage(
      channelJid,
      {
        image:imageBuffer,
        caption:text||''
      }
    );
  }

  // TEXT
  return await sock.sendMessage(
    channelJid,
    {
      text:text||''
    }
  );
}

// HOME
app.get('/',(req,res)=>{
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>Kink Sanz Auto Post</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  min-height:100vh;
  font-family:Arial,sans-serif;
  background:
    radial-gradient(
      circle at top,
      #12366b 0%,
      #07152e 45%,
      #030b18 100%
    );
  color:white;
  padding:25px 15px;
}

.box{
  width:100%;
  max-width:700px;
  margin:auto;
  background:#0d2347;
  border:1px solid #1b4d88;
  padding:25px;
  border-radius:18px;
  box-shadow:
    0 15px 40px rgba(0,0,0,.35);
}

h2{
  margin-top:0;
  margin-bottom:5px;
}

.subtitle{
  color:#9fc8ef;
  margin-top:0;
  margin-bottom:25px;
}

.status-box{
  background:#061226;
  padding:15px;
  border-radius:12px;
  border:1px solid #17375f;
  margin-bottom:15px;
}

.status-title{
  font-weight:bold;
  margin-bottom:8px;
}

pre{
  background:#020b18;
  padding:15px;
  border-radius:10px;
  overflow:auto;
  white-space:pre-wrap;
  word-break:break-word;
  margin:0;
  color:#bfe5ff;
}

input,
button{
  width:100%;
  padding:13px;
  margin-top:10px;
  box-sizing:border-box;
  border-radius:9px;
  border:0;
  font-size:15px;
}

input{
  background:#061a35;
  color:white;
  border:1px solid #205183;
  outline:none;
}

button{
  background:#16a9ff;
  color:white;
  font-weight:bold;
  cursor:pointer;
}

button:hover{
  opacity:.9;
}

.qr-btn{
  background:#168cff;
}

.disconnect-btn{
  background:#d93636;
}

.result{
  margin-top:15px;
}

</style>
</head>

<body>

<div class="box">

<h2>Kink Sanz Auto Post</h2>

<p class="subtitle">
Panel koneksi WhatsApp & Auto Post
</p>

<div class="status-box">

<div class="status-title">
Status Server
</div>

<pre id="status">
Loading...
</pre>

</div>

<input
  id="secret"
  type="password"
  placeholder="CALLBACK_SECRET"
>

<button
  class="qr-btn"
  onclick="openQR()"
>
  CETAK QR / HUBUNGKAN WA
</button>

<button
  class="disconnect-btn"
  onclick="disconnectWA()"
>
  LEPASKAN SAMBUNGAN WA
</button>

<button
  onclick="testPost()"
>
  KIRIM TEST POST
</button>

<pre
  id="result"
  class="result"
></pre>

</div>

<script>

async function loadStatus(){

  try{

    const r=
      await fetch('/api/status');

    const d=
      await r.json();

    document.getElementById(
      'status'
    ).textContent=
      JSON.stringify(
        d,
        null,
        2
      );

  }catch(e){

    document.getElementById(
      'status'
    ).textContent=
      e.message;

  }

}

function openQR(){

  window.open(
    '/qr',
    '_blank'
  );

}

async function disconnectWA(){

  const secret=
    document.getElementById(
      'secret'
    ).value;

  if(!secret){

    document.getElementById(
      'result'
    ).textContent=
      'Isi CALLBACK_SECRET dulu.';

    return;

  }

  if(
    !confirm(
      'Lepaskan sambungan WhatsApp?'
    )
  ){

    return;

  }

  try{

    const r=
      await fetch(
        '/api/disconnect',
        {
          method:'POST',
          headers:{
            'Content-Type':
              'application/json',

            'x-callback-secret':
              secret
          }
        }
      );

    const text=
      await r.text();

    document.getElementById(
      'result'
    ).textContent=
      text;

    setTimeout(
      loadStatus,
      1000
    );

  }catch(e){

    document.getElementById(
      'result'
    ).textContent=
      e.message;

  }

}

async function testPost(){

  const secret=
    document.getElementById(
      'secret'
    ).value;

  try{

    const r=
      await fetch(
        '/api/test-post',
        {
          method:'POST',

          headers:{
            'Content-Type':
              'application/json',

            'x-callback-secret':
              secret
          }
        }
      );

    const text=
      await r.text();

    document.getElementById(
      'result'
    ).textContent=
      text;

  }catch(e){

    document.getElementById(
      'result'
    ).textContent=
      e.message;

  }

}

loadStatus();

setInterval(
  loadStatus,
  5000
);

</script>

</body>
</html>
  `);
});

// QR
app.get('/qr',(req,res)=>{

  if(!qrData){

    return res.send(`
<!DOCTYPE html>
<html>
<body style="
  background:#07152e;
  color:white;
  text-align:center;
  font-family:Arial;
  padding:30px;
">

<h2>QR WhatsApp</h2>

<p>
QR belum tersedia.
</p>

<p>
Cek status WhatsApp atau tunggu beberapa detik.
</p>

<script>
setTimeout(()=>{
  location.reload();
},3000);
</script>

</body>
</html>
    `);
  }

  res.send(`
<!DOCTYPE html>
<html>

<head>
<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>QR Kink Sanz</title>

</head>

<body style="
  margin:0;
  min-height:100vh;
  background:#07152e;
  color:white;
  text-align:center;
  font-family:Arial;
  padding:30px;
">

<h2>Scan QR WhatsApp</h2>

<p>
Buka WhatsApp → Perangkat tertaut → Tautkan perangkat
</p>

<img
  src="${qrData}"
  style="
    width:350px;
    max-width:90vw;
    background:white;
    padding:10px;
    border-radius:15px;
  "
>

<p>
QR akan diperbarui otomatis jika diperlukan.
</p>

</body>
</html>
  `);
});

// STATUS
app.get('/api/status',(req,res)=>{
  res.json({
    ok:true,
    connection:
      connected
        ? 'connected'
        : 'disconnected',

    qr:!!qrData,

    channelJid,
    channelName,

    lastPost,
    lastError
  });
});

// DISCONNECT WA
app.post('/api/disconnect',async(req,res)=>{

  try{

    if(!checkSecret(req)){

      return res.status(401).json({
        ok:false,
        error:'Unauthorized'
      });

    }

    await disconnectWhatsApp();

    res.json({
      ok:true,
      message:
        'WhatsApp berhasil dilepas. Silakan scan QR baru.',
      connection:'disconnected'
    });

  }catch(e){

    lastError=e.message;

    res.status(500).json({
      ok:false,
      error:e.message
    });

  }

});

// TEST POST
app.post('/api/test-post',async(req,res)=>{

  try{

    if(!checkSecret(req)){

      return res.status(401).json({
        ok:false,
        error:'Unauthorized'
      });

    }

    const message=
      'TEST AUTO POST KINK SANZ';

    const sent=
      await sendToChannel(
        message
      );

    lastPost={
      time:
        new Date().toISOString(),

      messageId:
        sent?.key?.id||null,

      type:'text'
    };

    lastError=null;

    res.json({
      ok:true,

      messageId:
        sent?.key?.id||null,

      channelJid,

      type:'text',

      note:
        'Periksa Channel untuk memastikan pesan terlihat'
    });

  }catch(e){

    lastError=e.message;

    console.error(
      'TEST POST ERROR:',
      e
    );

    res.status(500).json({
      ok:false,
      error:e.message
    });

  }

});

// CALLBACK WEBSITE
app.post('/api/callback',async(req,res)=>{

  console.log(
    '========== CALLBACK MASUK =========='
  );

  console.log(
    'TIME:',
    new Date().toISOString()
  );

  console.log(
    'BODY KEYS:',
    Object.keys(req.body||{})
  );

  try{

    if(!checkSecret(req)){

      console.log(
        'CALLBACK DITOLAK: SECRET SALAH'
      );

      return res.status(401).json({
        ok:false,
        error:'Unauthorized'
      });

    }

    const order=
      req.body?.order ||
      req.body ||
      {};

    const text=
      order.format ||
      order.text ||
      order.caption ||
      '';

    const image=
      order.photoDataUrl ||
      order.photoData ||
      order.photo ||
      order.image ||
      null;

    if(!text && !image){

      console.log(
        'CALLBACK DITOLAK: FORMAT KOSONG'
      );

      return res.status(400).json({
        ok:false,
        error:'Format/order kosong'
      });

    }

    console.log(
      'FORMAT:',
      text ? 'ADA' : 'TIDAK ADA'
    );

    console.log(
      'FOTO:',
      image ? 'ADA' : 'TIDAK ADA'
    );

    const sent=
      await sendToChannel(
        text,
        image
      );

    const messageId=
      sent?.key?.id ||
      null;

    lastPost={
      time:
        new Date().toISOString(),

      messageId,

      type:
        image
          ? 'image'
          : 'text'
    };

    lastError=null;

    console.log(
      'AUTO POST BERHASIL:',
      messageId
    );

    res.json({
      ok:true,
      messageId,
      channelJid,
      type:
        image
          ? 'image'
          : 'text'
    });

  }catch(e){

    lastError=e.message;

    console.error(
      '========== CALLBACK ERROR =========='
    );

    console.error(e);

    res.status(500).json({
      ok:false,
      error:e.message
    });

  }

});

// 404
app.use((req,res)=>{

  res.status(404).json({
    ok:false,
    error:
      'Endpoint tidak ditemukan'
  });

});

// START SERVER
app.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log(
      \`Server berjalan di port \${PORT}\`
    );

    console.log(
      'Auto-post endpoint:',
      '/api/callback'
    );

    startWhatsApp().catch((e)=>{

      lastError=e.message;

      console.error(
        'Gagal start WhatsApp:',
        e
      );

    });

  }
);
