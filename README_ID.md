# KINK SANZ AUTO POST

Backend untuk menerima callback dari web Japost lalu mengirim posting ke WhatsApp Channel.

## 1. Siapkan Node.js
Gunakan Node.js 24.x.

## 2. Install
```bash
npm install
```

## 3. Buat `.env`
Copy `.env.example` menjadi `.env`, lalu isi:
```env
PORT=3000
CALLBACK_SECRET=buat-secret-random-panjang
CHANNEL_LINK=https://whatsapp.com/channel/0029VbC8YTVGehEH4EHdMz44
```

Jangan masukkan `.env` ke GitHub atau kirim API/secret ke orang lain.

## 4. Jalankan
```bash
npm start
```

Buka:
- `/` untuk status
- `/qr` untuk QR login WhatsApp
- `/api/status` untuk status JSON

Setelah akun WhatsApp yang menjadi admin/owner Channel tersambung, backend akan mencoba membaca ID Channel dari link.

## 5. Hubungkan HTML Japost
Di HTML, isi:
```js
const AUTO_POST_WEBHOOK_URL="https://DOMAIN-BACKEND-KAMU/api/callback";
const AUTO_POST_SECRET="SAMA_PERSIS_DENGAN_CALLBACK_SECRET";
```

HTML mengirim `photoDataUrl` langsung ke backend sehingga backend tidak perlu Firebase Admin untuk mengambil foto.

## Catatan
Ini memakai Baileys/WhatsApp Web secara tidak resmi. WhatsApp dapat mengubah protokol atau membatasi akun. Pakai nomor khusus yang kamu kontrol, jangan untuk spam/broadcast massal. Dukungan media ke Channel juga dapat berubah/bermasalah pada versi tertentu.
