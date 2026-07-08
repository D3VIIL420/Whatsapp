const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  AuthenticationState,
  delay,
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

app.use(fileUpload());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const activeSessions = {};

// Custom function to create state directly from uploaded json content
async function useUploadedAuthState(credsContent) {
  let creds;
  try {
    creds = JSON.parse(credsContent, BufferJSON.reviver);
  } catch (e) {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => { return {}; }, // Uploaded single creds file doesn't have extra keys info
        set: (data) => { } 
      }
    },
    saveCreds: () => {
      // Internal update placeholder
    }
  };
}

async function connectWhatsApp(sessionId, sessionPath, credsContent, messageLines, name, type, targetID, delayTime) {
  // CRITICAL FIX: Direct parsed object structure use kar rahe hain taake file path/permission issue na aaye
  const { state } = await useUploadedAuthState(credsContent);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    // Ekdum clean generic browser jo data block nahi karega
    browser: ['Mac OS', 'Safari', '17.0'], 
    printQRInTerminal: false,
    keepAliveIntervalMs: 25000, 
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });

  activeSessions[sessionId] = {
    sock,
    isRunning: false,
    sessionPath
  };

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(`[✅] Session connected successfully: ${sessionId}`);
      
      if (activeSessions[sessionId] && !activeSessions[sessionId].isRunning) {
        activeSessions[sessionId].isRunning = true;
        startMessageLoop(sessionId, messageLines, name, type, targetID, delayTime);
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      console.log(`[❌] Connection closed (${sessionId}): Code ${reason}`);
      
      // Agar error 405 ya koi aur permanent block hai, toh directly remove karenge taake infinite restart log na bane
      if (reason === 405 || reason === DisconnectReason.loggedOut) {
        console.log(`[⚠️] Session invalid or rejected by WhatsApp. Stopping.`);
        await removeSession(sessionId, true);
      } else if (activeSessions[sessionId]) {
        console.log(`[🔄] Retrying dynamic connection...`);
        setTimeout(() => {
          if (activeSessions[sessionId]) {
            connectWhatsApp(sessionId, sessionPath, credsContent, messageLines, name, type, targetID, delayTime);
          }
        }, 5000);
      }
    }
  });

  return sock;
}

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

    // File ko read kar rahe hain text format mein, disk path dependency hatane ke liye
    const credsContent = creds.data.toString('utf-8');

    const messagePath = path.join(sessionPath, 'message.txt');
    await messageFile.mv(messagePath);

    const messageLines = (await fs.readFile(messagePath, 'utf-8'))
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '');

    if (!messageLines.length) {
      return res.status(400).json({ error: 'Message file is empty' });
    }
    
    // Naya static connector trigger kiya
    await connectWhatsApp(sessionId, sessionPath, credsContent, messageLines, name, type, targetID, delayTime);

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

  setTimeout(async () => {
    try {
      await fs.remove(session.sessionPath);
      if (log) console.log(`[🫡] Cleaned up session: ${sessionId}`);
    } catch (err) {
      console.error(`[⚠️] File clean failure:`, err.message);
    }
  }, 2500);
}

app.listen(PORT, HOST, () => {
  console.log(`Server running on port ${PORT}`);
});
