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
  Browsers,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 10000; // Render ka default port 10000 hota hai
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
      .map(line => line.trim())
      .filter(line => line !== '');

    if (!messageLines.length) {
      return res.status(400).json({ error: 'Message file is empty' });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      // FIX: Modern Chrome browser string jo WhatsApp block nahi karega
      browser: Browsers.appropriate('Chrome'), 
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      keepAliveIntervalMs: 30000, // Render par connection active rakhne ke liye
      defaultQueryTimeoutMs: undefined
    });

    activeSessions[sessionId] = {
      sock,
      isRunning: false,
      sessionPath
    };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log(`[✅] Session started successfully: ${sessionId}`);
        
        if (activeSessions[sessionId] && !activeSessions[sessionId].isRunning) {
          activeSessions[sessionId].isRunning = true;
          startMessageLoop(sessionId, messageLines, name, type, targetID, delayTime);
        }
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        console.log(`[❌] Connection closed (${sessionId}): Code ${reason}`);
        
        // Agar logout nahi hua aur network error hai to automatic reconnect karega
        if (reason !== DisconnectReason.loggedOut && activeSessions[sessionId]) {
          console.log(`[🔄] Attempting auto-reconnect for session: ${sessionId}`);
        } else {
          await removeSession(sessionId, true);
        }
      }
    });

    return res.json({ sessionId });

  } catch (err) {
    console.error('Main error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function startMessageLoop(sessionId, messageLines, name, type, targetID, delayTime) {
  let i = 0;
  
  while (activeSessions[sessionId] && activeSessions[sessionId].isRunning) {
    try {
      const session = activeSessions[sessionId];
      if (!session || !session.sock) break;

      const line = messageLines[i];
      const fullMessage = `${name} ${line}\n`;
      const jid = type === 'gc' ? `${targetID}@g.us` : `${targetID}@s.whatsapp.net`;

      await session.sock.sendMessage(jid, { text: fullMessage });
      console.log(`[📤] Sent to ${jid}: ${line}`);

      i = (i + 1) % messageLines.length;
      
      // Safe exit interval delay (taake stop karne par turant ruk jaye)
      for (let d = 0; d < Number(delayTime); d++) {
        if (!activeSessions[sessionId] || !activeSessions[sessionId].isRunning) break;
        await delay(1000); 
      }

    } catch (err) {
      console.error(`[⛔] Loop broke for session ${sessionId}:`, err.message);
      break;
    }
  }
}

app.post('/stop-session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const session = activeSessions[sessionId];

  if (session) {
    try {
      session.isRunning = false;
      if (session.sock && session.sock.ws) {
        session.sock.ws.close();
      }
      await removeSession(sessionId, false);
      return res.send(`Session ${sessionId} stopped.`);
    } catch (err) {
      return res.status(500).send('Failed to stop.');
    }
  } else {
    return res.status(404).send('Session not found.');
  }
});

async function removeSession(sessionId, log = false) {
  const session = activeSessions[sessionId];
  if (!session) return;

  session.isRunning = false;
  delete activeSessions[sessionId];

  // Timeout lagaya hai taake Render par files asani se delete ho sakein bina kisi error ke
  setTimeout(async () => {
    try {
      await fs.remove(session.sessionPath);
      if (log) console.log(`[🫡] Removed session files: ${sessionId}`);
    } catch (err) {
      console.error(`[⚠️] File clean failure:`, err.message);
    }
  }, 2500);
}

app.listen(PORT, HOST, () => {
  console.log(`Server running on port ${PORT}`);
});
