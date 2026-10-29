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
  res.setHeader('Access-Control-Allow-Headers','Content-Type, x-callback-secret, X-Japost-Secret, Authorization');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

// SECRET CHECK
function checkSecret(req){
  const headerSecret=req.headers['x-callback-secret']||req.headers['x-japost-secret'];
  const auth=req.headers.authorization||'';
  let bearerSecret='';
  if(auth.toLowerCase().startsWith('bearer ')) bearerSecret=auth.slice(7);
  const bodySecret=req.body?.secret||'';
  return headerSecret===CALLBACK_SECRET||bearerSecret===CALLBACK_SECRET||bodySecret===CALLBACK_SECRET;
}

// CHANNEL
async function resolveChannel(){
  if(!sock)return;
  try{
    if(CHANNEL_LINK){
      const inviteCode=CHANNEL_LINK.split('/').pop();
      if(inviteCode){
        try{
          const meta=await sock.newsletterMetadata('invite',inviteCode);
          if(meta?.id)channelJid=meta.id;
          channelName=typeof meta?.name==='string'?meta.name:meta?.name?.text||meta?.name?.default||'JAPOST KINKSANZ (GRATIS)';
        }catch(e){console.log('Gagal mengambil metadata channel:',e.message);}
      }
    }
    if(!channelJid)channelJid='120363406356211250@newsletter';
    if(!channelName)channelName='JAPOST KINKSANZ (GRATIS)';
    console.log('CHANNEL JID:',channelJid);
    console.log('CHANNEL NAME:',channelName);
  }catch(e){console.log('Resolve channel error:',e.message);}
}

// START WHATSAPP
async function startWhatsApp(){
  const {state,saveCreds}=await useMultiFileAuthState('./auth_info');
  sock=makeWASocket({
    auth:state,
    logger:pino({level:'silent'}),
    printQRInTerminal:false,
    browser:['Kink Sanz Japost','Chrome','1.0.0']
  });
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async(update)=>{
    const {connection,lastDisconnect,qr}=update;

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
      const statusCode=lastDisconnect?.error?.output?.statusCode;
      console.log('WhatsApp terputus:',statusCode);

      if(statusCode!==DisconnectReason.loggedOut){
        setTimeout(startWhatsApp,3000);
      }else{
        console.log('WhatsApp logout. Scan QR baru.');
      }
    }
  });
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
        console.log('Logout WA:',e.message);
      }

      sock=null;
    }

    try{
      await fs.rm('./auth_info',{
        recursive:true,
        force:true
      });
    }catch(e){
      console.log('Hapus session:',e.message);
    }

    console.log('WhatsApp berhasil dilepas.');

    setTimeout(()=>{
      startWhatsApp().catch(e=>{
        lastError=e.message;
        console.error('Gagal membuat koneksi baru:',e);
      });
    },1000);

    return true;

  }catch(e){
    lastError=e.message;
    console.error('DISCONNECT ERROR:',e);
    return false;
  }
}

// SEND TO CHANNEL
async function sendToChannel(text,imageData){
  if(!sock||!connected)throw new Error('WhatsApp belum terhubung');
  if(!channelJid)await resolveChannel();
  if(!channelJid)throw new Error('Channel JID belum ditemukan');

  // FOTO
  if(imageData){
    let imageBuffer;

    if(typeof imageData==='string'&&imageData.startsWith('data:')){
      const base64=imageData.split(',')[1];
      imageBuffer=Buffer.from(base64,'base64');

    }else if(typeof imageData==='string'&&imageData.startsWith('http')){
      const response=await fetch(imageData);
      if(!response.ok)throw new Error('Gagal mengambil foto dari URL');
      imageBuffer=Buffer.from(await response.arrayBuffer());
    }

    if(!imageBuffer)throw new Error('Format foto tidak valid');

    return await sock.sendMessage(channelJid,{
      image:imageBuffer,
      caption:text||''
    });
  }

  // TEXT
  return await sock.sendMessage(channelJid,{
    text:text||''
  });
}

// HOME
app.get('/',(req,res)=>{
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Kink Sanz Auto Post</title>
<style>
body{font-family:Arial,sans-serif;background:#07152e;color:white;padding:30px}
.box{max-width:700px;margin:auto;background:#0d2347;padding:25px;border-radius:15px}
input,button{width:100%;padding:13px;margin-top:10px;box-sizing:border-box;border-radius:8px;border:0}
button{background:#16a9ff;color:white;font-weight:bold;cursor:pointer}
pre{background:#061226;padding:15px;border-radius:10px;overflow:auto}
</style>
</head>
<body>
<div class="box">
<h2>Kink Sanz Auto Post</h2>
<p>Status server:</p>
<pre id="status">Loading...</pre>
<input id="secret" type="password" placeholder="CALLBACK_SECRET">
<button onclick="testPost()">KIRIM TEST POST</button>
<pre id="result"></pre>
</div>

<script>
async function loadStatus(){
  try{
    const r=await fetch('/api/status');
    const d=await r.json();
    document.getElementById('status').textContent=JSON.stringify(d,null,2);
  }catch(e){
    document.getElementById('status').textContent=e.message;
  }
}

async function testPost(){
  const secret=document.getElementById('secret').value;

  try{
    const r=await fetch('/api/test-post',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-callback-secret':secret
      }
    });

    const text=await r.text();
    document.getElementById('result').textContent=text;

  }catch(e){
    document.getElementById('result').textContent=e.message;
  }
}

loadStatus();
setInterval(loadStatus,5000);
</script>
</body>
</html>
  `);
});

// QR
app.get('/qr',(req,res)=>{
  if(!qrData){
    return res.send('QR tidak tersedia. WhatsApp mungkin sudah terhubung.');
  }

  res.send(`
<!DOCTYPE html>
<html>
<body style="background:#07152e;color:white;text-align:center;font-family:Arial;padding:30px;">
<h2>Scan QR WhatsApp</h2>
<img src="${qrData}" style="max-width:350px;">
</body>
</html>
  `);
});

// STATUS
app.get('/api/status',(req,res)=>{
  res.json({
    ok:true,
    connection:connected?'connected':'disconnected',
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
      message:'WhatsApp berhasil dilepas. Silakan scan QR baru.',
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
      return res.status(401).json({ok:false,error:'Unauthorized'});
    }

    const message='TEST AUTO POST KINK SANZ';

    const sent=await sendToChannel(message);

    lastPost={
      time:new Date().toISOString(),
      messageId:sent?.key?.id||null,
      type:'text'
    };

    lastError=null;

    res.json({
      ok:true,
      messageId:sent?.key?.id||null,
      channelJid,
      type:'text',
      note:'Periksa Channel untuk memastikan pesan terlihat'
    });

  }catch(e){
    lastError=e.message;
    console.error('TEST POST ERROR:',e);

    res.status(500).json({
      ok:false,
      error:e.message
    });
  }
});

// CALLBACK WEBSITE
app.post('/api/callback',async(req,res)=>{
  console.log('========== CALLBACK MASUK ==========');
  console.log('TIME:',new Date().toISOString());
  console.log('BODY KEYS:',Object.keys(req.body||{}));

  try{
    if(!checkSecret(req)){
      console.log('CALLBACK DITOLAK: SECRET SALAH');

      return res.status(401).json({
        ok:false,
        error:'Unauthorized'
      });
    }

    const order=req.body?.order||req.body||{};

    const text=order.format||order.text||order.caption||'';
    const image=order.photoDataUrl||order.photoData||order.photo||order.image||null;

    if(!text&&!image){
      console.log('CALLBACK DITOLAK: FORMAT K
