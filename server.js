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
    .filter((jid) => jid.endsWith('@s
