import 'dotenv/config';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@itsliaaa/baileys';

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const CHANNEL_LINK = process.env.CHANNEL_LINK || '';
const SESSION_DIR = './session';

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Origin, X-Requested-With, Content-Type, Accept, X-Japost-Secret');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({limit:'12mb'}));

let sock=null, qrDataUrl='', connectionState='starting';
let channelJid='', channelName='', channelState='', lastPost=null;
let reconnectTimer=null, sendLock=Promise.resolve();
const rateMap=new Map();

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function inviteCode(link){const m=String(link||'').match(/whatsapp\.com\/channel\/([^/?]+)/i);return m?m[1]:'';}
function auth(req,res,next){
  if(!CALLBACK_SECRET) return res.status(500).json({ok:false,error:'CALLBACK_SECRET belum diset di server'});
  if(req.get('X-Japost-Secret')!==CALLBACK_SECRET) return res.status(401).json({ok:false,error:'Unauthorized'});
  next();
}
function publicRateLimit(req,res,next){
  const now=Date.now(), key=req.ip||req.headers['x-forwarded-for']||'unknown';
  const arr=(rateMap.get(key)||[]).filter(t=>now-t<60000);
  if(arr.length>=5) return res.status(429).json({ok:false,error:'Terlalu banyak kiriman. Coba lagi sebentar.'});
  arr.push(now); rateMap.set(key,arr); next();
}
function caption(order){return String(order?.format||'').replace(/\r/g,'').trim();}
function parseImage(value){
  if(!value) return null;
  const s=String(value), comma=s.indexOf(','), b64=comma>=0?s.slice(comma+1):s;
  const mimePart=comma>=0?s.slice(0,comma):'';
  const mime=(mimePart.match(/data:([^;]+);base64/i)||[])[1]||'image/jpeg';
  const buffer=Buffer.from(b64,'base64');
  if(!buffer.length) throw new Error('Foto kosong/tidak valid');
  if(buffer.length>8*1024*1024) throw new Error('Foto terlalu besar. Maksimal 8 MB.');
  return {buffer,mime};
}

async function resolveChannel(){
  if(!sock) throw new Error('WhatsApp belum terhubung');
  let meta;
  const code=inviteCode(CHANNEL_LINK);
  if(code) meta=await sock.newsletterMetadata('invite',code);
  else if(CHANNEL_LINK.endsWith('@newsletter')) meta=await sock.newsletterMetadata('jid',CHANNEL_LINK);
  else throw new Error('CHANNEL_LINK tidak valid');
  if(!meta?.id) throw new Error('Channel ID tidak ditemukan');
  channelJid=meta.id;
  channelName=meta.name||meta.thread_metadata?.name||'';
  channelState=meta.state?.type||meta.thread_metadata?.state?.type||'';
  return meta;
}
async function refreshChannel(){const m=await resolveChannel();logger.info({channelJid,channelName,channelState},'Channel terdeteksi');return m;}

async function startWhatsApp(){
  try{
    const {state,saveCreds}=await useMultiFileAuthState(SESSION_DIR);
    sock=makeWASocket({auth:state,logger:pino({level:'silent'}),markOnlineOnConnect:false,syncFullHistory:false,connectTimeoutMs:60000,defaultQueryTimeoutMs:60000});
    sock.ev.on('creds.update',saveCreds);
    sock.ev.on('connection.update',async({connection,lastDisconnect,qr})=>{
      if(qr){qrDataUrl=await QRCode.toDataURL(qr,{margin:2,width:320});connectionState='scan_qr';}
      if(connection==='open'){qrDataUrl='';connectionState='connected';try{await refreshChannel();}catch(e){logger.warn({err:e},'Channel belum ter-resolve');}}
      if(connection==='close'){
        const code=lastDisconnect?.error?.output?.statusCode;
        connectionState='disconnected';sock=null;channelJid='';channelName='';channelState='';
        if(code!==DisconnectReason.loggedOut&&!reconnectTimer){reconnectTimer=setTimeout(()=>{reconnectTimer=null;startWhatsApp().catch(e=>logger.error({err:e},'Reconnect gagal'));},3000);}
      }
    });
  }catch(e){
    connectionState='error';logger.error({err:e},'Gagal menjalankan WhatsApp');
    if(!reconnectTimer) reconnectTimer=setTimeout(()=>{reconnectTimer=null;startWhatsApp().catch(()=>{});},5000);
  }
}

async function rawSend(text,imageData){
  if(!sock||connectionState!=='connected') throw new Error('WhatsApp belum terhubung');
  if(!channelJid) await refreshChannel();
  const meta=await sock.newsletterMetadata('jid',channelJid);
  if(!meta?.id) throw new Error('Channel JID tidak valid');
  const image=parseImage(imageData);
  const result=image?await sock.sendMessage(channelJid,{image:image.buffer,mimetype:image.mime,caption:text}):await sock.sendMessage(channelJid,{text});
  if(!result?.key?.id) throw new Error('WhatsApp tidak mengembalikan ID pesan');
  return result;
}
async function sendToChannel(text,imageData=''){
  const job=sendLock.then(async()=>{
    let lastError=null;
    for(let attempt=1;attempt<=3;attempt++){
      try{return {result:await rawSend(text,imageData),attempts:attempt};}
      catch(e){lastError=e;logger.warn({attempt,err:e},'Pengiriman channel gagal');if(attempt<3)await sleep(1200*attempt);}
    }
    throw lastError||new Error('Auto post gagal');
  });
  sendLock=job.then(()=>undefined,()=>undefined); return job;
}

async function processPost(req,res){
  try{
    const o=req.body||{};
    const type=String(o.type||'').toUpperCase();
    if(!['SELL','BUY','TEST'].includes(type)) return res.status(400).json({ok:false,error:'Type harus SELL atau BUY'});
    const text=caption(o)||String(o.text||'').trim();
    if(!text) return res.status(400).json({ok:false,error:'Format posting kosong'});
    const imageData=o.photoData||o.photoDataUrl||'';
    const {result,attempts}=await sendToChannel(text,imageData);
    const orderId=o.orderId||o.queueCode||`KS-${Date.now()}`;
    const orderCode=o.orderCode||o.queueCode||orderId;
    lastPost={orderId,orderCode,type,at:new Date().toISOString(),messageId:result.key.id,attempts,mode:imageData?'image+caption':'text'};
    logger.info({orderId,orderCode,type,channelJid,messageId:result.key.id,attempts},'Auto post berhasil');
    res.json({ok:true,orderId,orderCode,type,channelJid,messageId:result.key.id,attempts});
  }catch(e){logger.error({err:e},'Auto post gagal');res.status(500).json({ok:false,error:e.message||'Auto post gagal'});}
}

app.get('/',(_req,res)=>res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kink Sanz Auto Post</title><body style="font-family:Arial;background:#07111f;color:#fff;padding:24px;max-width:650px;margin:auto"><div style="background:#111c2c;padding:22px;border-radius:18px"><h1>Kink Sanz Auto Post</h1><p>WhatsApp: <b id="s">...</b></p><p>Channel: <b id="c">...</b></p><p>State: <b id="cs">...</b></p><p><a href="/qr" style="background:#10b981;color:#fff;padding:12px 16px;border-radius:10px;text-decoration:none">Buka QR WhatsApp</a></p><pre id="d" style="white-space:pre-wrap;background:#07111f;padding:14px;border-radius:10px">loading</pre></div><script>async function st(){try{let d=await(await fetch('/api/status')).json();document.getElementById('s').textContent=d.connection;document.getElementById('c').textContent=d.channelName||d.channelJid||'-';document.getElementById('cs').textContent=d.channelState||'-';document.getElementById('d').textContent=JSON.stringify(d,null,2)}catch(e){document.getElementById('d').textContent=e.message}}st();setInterval(st,4000)</script>`));
app.get('/qr',(_req,res)=>{if(!qrDataUrl)return res.send(`<h2 style="font-family:Arial;text-align:center">QR belum tersedia<br>Status: ${connectionState}</h2><script>setTimeout(()=>location.reload(),3000)</script>`);res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;background:#07111f;color:#fff;text-align:center;padding:24px"><h2>Scan WhatsApp → Perangkat tertaut</h2><img src="${qrDataUrl}" style="width:320px;max-width:90%;background:#fff;padding:12px;border-radius:14px"><script>setTimeout(()=>location.reload(),15000)</script>`)});
app.get('/api/status',(_req,res)=>res.json({ok:true,connection:connectionState,qr:!!qrDataUrl,channelJid,channelName,channelState,lastPost}));
app.post('/api/callback',auth,processPost);
app.post('/api/japost',publicRateLimit,processPost);
app.post('/api/test-post',auth,async(req,res)=>{req.body={type:'TEST',text:String(req.body?.text||'TEST AUTO POST KINK SANZ')};return processPost(req,res);});
app.use((_req,res)=>res.status(404).json({ok:false,error:'Endpoint tidak ditemukan'}));
app.listen(PORT,HOST,()=>{logger.info(`Kink Sanz Auto Post berjalan di ${HOST}:${PORT}`);startWhatsApp().catch(e=>logger.error({err:e},'Gagal start WhatsApp'));});
