const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 30000;
const HOST = '0.0.0.0';

app.use(fileUpload());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const activeSessions = {};

app.post('/send-message', async (req, res) => {
  try {
    const { name, targetID, type, delayTime } = req.body;
    const creds = req.files?.creds;
    const messageFile = req.files?.messageFile;

    if (!creds || !messageFile || !targetID || !type || !delayTime || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sessionId = Date.now().toString();
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    await fs.ensureDir(sessionPath);

    const credsPath = path.join(sessionPath, 'creds.json');
    await creds.mv(credsPath);

    const messagePath = path.join(sessionPath, 'message.txt');
    await messageFile.mv(messagePath);

    const messageLines = (await fs.readFile(messagePath, 'utf-8'))
      .split('\n')
      .filter(line => line.trim() !== '');

    if (!messageLines.length) {
      return res.status(400).json({ error: 'Message file is empty' });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      browser: Browsers.macOS('Safari'),
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false
    });

    activeSessions[sessionId] = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log(`[✅] Session started: ${sessionId}`);
        try {
          let i = 0;
          while (true) {
            const line = messageLines[i];
            const fullMessage = `${name} ${line.trim()}\n`;
            const jid = type === 'gc' ? `${targetID}@g.us` : `${targetID}@s.whatsapp.net`;

            await sock.sendMessage(jid, { text: fullMessage });
            console.log(`[📤] Sent to ${jid}: ${line.trim()}`);

            await delay(Number(delayTime) * 1000);
            i = (i + 1) % messageLines.length; // loop back when end is reached
          }
        } catch (err) {
          console.error(`[⛔] Error in session ${sessionId}:`, err.message);
          try {
            await sock.ws.close();
          } catch {}
          await removeSession(sessionId, true);
        }
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        console.log(`[❌] Connection closed (${sessionId}): ${reason}`);
        await removeSession(sessionId, true);
      }
    });

    return res.json({ sessionId });

  } catch (err) {
    console.error('Main error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/stop-session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const sock = activeSessions[sessionId];

  if (sock) {
    try {
      await sock.ws.close();
      await removeSession(sessionId, false);
      return res.send(`Session ${sessionId} stopped successfully.`);
    } catch (err) {
      console.error('Error stopping session:', err);
      return res.status(500).send('Failed to stop session.');
    }
  } else {
    return res.status(404).send('Session not found.');
  }
});

async function removeSession(sessionId, log = false) {
  delete activeSessions[sessionId];
  const sessionPath = path.join(__dirname, 'sessions', sessionId);
  await fs.remove(sessionPath);
  if (log) console.log(`[🫡] Removed session: ${sessionId}`);
}

app.listen(PORT, HOST, () => {
  console.log(`NonStop running on http://${HOST}:${PORT}`);
});
