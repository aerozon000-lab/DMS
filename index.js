import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto; // Baileys needs this global; not all Node versions expose it by default

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import baileysPkg from '@whiskeysockets/baileys';
const makeWASocket = baileysPkg.default ?? baileysPkg.makeWASocket ?? baileysPkg;
const { useMultiFileAuthState, DisconnectReason } = baileysPkg;
import { google } from 'googleapis';

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const STOP_KEYWORD = (process.env.STOP_KEYWORD || 'DONE').trim().toUpperCase();
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info';
const JOBS_FILE = process.env.JOBS_FILE || './jobs.json';
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './service-account.json';

const logger = pino({ level: 'info' });

// ---------- job store ----------
// jobs keyed by `${spreadsheetId}::${rowIndex}` so multiple sheets/rows never collide
let jobs = loadJobs();
const timers = new Map(); // same key -> setInterval handle

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveJobs() {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function jobKey(spreadsheetId, rowIndex) {
  return `${spreadsheetId}::${rowIndex}`;
}

function normalizeNumber(raw) {
  return String(raw).replace(/[^0-9]/g, ''); // strip +, spaces, dashes
}

// ---------- Google Sheets write-back ----------
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function updateRemark(spreadsheetId, sheetName, rowIndex, remarkText) {
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!E${rowIndex}`, // column E = Remark
      valueInputOption: 'RAW',
      requestBody: { values: [[remarkText]] }
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update Remark column');
  }
}

// ---------- WhatsApp (Baileys) ----------
let sock;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'warn' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with the WhatsApp account you are dedicating to reminders:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      // Log the FULL error, not just the status code, so we can see the real cause
      logger.warn(
        { statusCode, errorMessage: lastDisconnect?.error?.message, fullError: lastDisconnect?.error },
        'Connection closed'
      );
      if (shouldReconnect) {
        // wait 5s before retrying instead of hammering reconnects instantly
        setTimeout(() => startWhatsApp(), 5000);
      } else {
        logger.error('Logged out — delete the auth_info folder and restart to re-scan a QR code.');
      }
    } else if (connection === 'open') {
      logger.info('WhatsApp connected.');
      rescheduleAllJobs(); // resume any jobs that were running before a restart
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';
      if (!text) continue;

      const senderNumber = normalizeNumber(msg.key.remoteJid.split('@')[0]);
      handleIncomingReply(senderNumber, text.trim());
    }
  });
}

async function sendMessage(number, text) {
  const jid = `${normalizeNumber(number)}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

// ---------- reminder scheduling ----------
function scheduleJob(key, job) {
  clearExistingTimer(key);

  const intervalMs = job.intervalHours * 60 * 60 * 1000;

  const fire = async () => {
    // stop automatically if the deadline has passed
    if (job.deadline && Date.now() > new Date(job.deadline).getTime()) {
      await sendMessage(
        job.whatsappNumber,
        `⏰ Deadline passed for task: "${job.task}". Please update as soon as possible.`
      );
      await stopJob(key, 'Deadline passed (no response)');
      return;
    }
    await sendMessage(
      job.whatsappNumber,
      `🔔 Reminder for ${job.name}: "${job.task}"${job.deadline ? `\nDeadline: ${new Date(job.deadline).toLocaleString()}` : ''}\n\nReply "${STOP_KEYWORD}" once this is complete.`
    );
  };

  fire(); // send the first reminder immediately
  const timer = setInterval(fire, intervalMs);
  timers.set(key, timer);
}

function clearExistingTimer(key) {
  const existing = timers.get(key);
  if (existing) clearInterval(existing);
  timers.delete(key);
}

async function stopJob(key, remarkText) {
  clearExistingTimer(key);
  const job = jobs[key];
  if (job) {
    await updateRemark(job.spreadsheetId, job.sheetName, job.rowIndex, remarkText);
    delete jobs[key];
    saveJobs();
  }
}

function rescheduleAllJobs() {
  for (const [key, job] of Object.entries(jobs)) {
    scheduleJob(key, job);
  }
}

// If one employee has multiple active tasks and replies DONE, this stops
// their oldest active job (since replies aren't tied to a specific task).
// For most "one task at a time" workflows this is exactly right.
async function handleIncomingReply(senderNumber, text) {
  if (text.trim().toUpperCase() !== STOP_KEYWORD) return;

  const matches = Object.entries(jobs)
    .filter(([, job]) => normalizeNumber(job.whatsappNumber) === senderNumber)
    .sort((a, b) => new Date(a[1].startedAt) - new Date(b[1].startedAt));

  if (matches.length === 0) return;

  const [key, job] = matches[0];
  await stopJob(key, `Completed by employee at ${new Date().toLocaleString()}`);
  await sendMessage(senderNumber, `✅ Got it — marked "${job.task}" as done. Reminders stopped.`);
}

// ---------- HTTP server (receives the Apps Script webhook) ----------
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/webhook', async (req, res) => {
  const { spreadsheetId, sheetName, rowIndex, name, whatsappNumber, task, deadline, intervalHours } = req.body;

  if (!spreadsheetId || !rowIndex || !whatsappNumber || !task || !intervalHours) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const key = jobKey(spreadsheetId, rowIndex);
  jobs[key] = {
    spreadsheetId,
    sheetName: sheetName || 'Sheet1',
    rowIndex,
    name,
    whatsappNumber,
    task,
    deadline,
    intervalHours: Number(intervalHours),
    startedAt: new Date().toISOString()
  };
  saveJobs();
  scheduleJob(key, jobs[key]);

  res.json({ ok: true, message: `Reminders scheduled for ${name}` });
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  startWhatsApp();
});
