require('dotenv').config();
const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const port = process.env.PORT || 3000;
const MONGO_URI = 'mongodb://aliabbaszounr1:Aliabbas321@cluster1-shard-00-00.rpo2r.mongodb.net:27017,cluster1-shard-00-01.rpo2r.mongodb.net:27017,cluster1-shard-00-02.rpo2r.mongodb.net:27017/whatsapp_sessions?replicaSet=atlas-14bnbx-shard-0&ssl=true&authSource=admin';

const sendLimiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 10,
  message: '⛔ Too many requests — try again later.'
});
app.use('/send-message', sendLimiter);

app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const SessionSchema = new mongoose.Schema({
  sessionId: String,
  apiKey: String
});
const Session = mongoose.model('Session', SessionSchema);

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000
})
.then(() => {
  console.log('✅ MongoDB connected successfully.');
  initializeClient();
})
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
});
mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB disconnected!'));
mongoose.connection.on('error', err => console.error('❌ MongoDB error:', err));

const numberCache = new Map();
async function getCachedNumberId(phone) {
  if (numberCache.has(phone)) {
    return numberCache.get(phone);
  }
  const id = await client.getNumberId(phone);
  numberCache.set(phone, id);
  return id;
}

let client;
let clientReady = false;
let apiKey = '';
let reconnecting = false;

async function initializeClient() {
  const store = new MongoStore({ mongoose });

  let session = await Session.findOne({ sessionId: 'whatsapp' });
  if (!session) {
    apiKey = crypto.randomBytes(16).toString('hex');
    await new Session({ sessionId: 'whatsapp', apiKey }).save();
  } else {
    apiKey = session.apiKey;
  }
  console.log('🔑 Current API Key:', apiKey);

  client = new Client({
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    authStrategy: new RemoteAuth({
      store,
      backupSyncIntervalMs: 300000
    })
  });

  client.on('qr', qr => {
    console.log('⚡ QR Code received');
    qrcode.toDataURL(qr, (err, qrImage) => {
      if (!err) io.emit('qr', qrImage);
    });
  });

  client.on('authenticated', () => {
    console.log('✅ Client authenticated');
    io.emit('status', { ready: true, apiKey });
  });

  client.on('ready', async () => {
    console.log('🎉 WhatsApp client is ready!');
    clientReady = true;
    io.emit('status', { ready: true, apiKey });

    try {
      const page = client.pupPage || client._page;
      if (page) {
        await page.setRequestInterception(true);
        page.on('request', req => {
          const type = req.resourceType();
          if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
            req.abort();
          } else {
            req.continue();
          }
        });
      }
    } catch (e) {
      console.error('❌ Request interception setup failed:', e);
    }
  });

  client.on('disconnected', reason => {
    console.log('❌ Client disconnected:', reason);
    clientReady = false;
    io.emit('status', { ready: false });

    if (!reconnecting) {
      reconnecting = true;
      setTimeout(() => {
        reconnecting = false;
        console.log('♻️ Reinitializing client...');
        initializeClient();
      }, 60 * 1000);
    }
  });

  client.on('call', async call => {
    console.log(`📞 Incoming call from ${call.from}, rejecting...`);
    try {
      await call.reject();
      console.log(`✅ Call rejected.`);
    } catch (err) {
      console.error('❌ Failed to reject call:', err);
    }
  });

  client.initialize();
}

io.on('connection', socket => {
  console.log('⚡ Client connected via Socket.IO');
  socket.emit('status', { ready: clientReady, apiKey });
  socket.on('disconnect', () => console.log('🔌 Socket disconnected'));
});

app.post('/send-message', async (req, res) => {
  const { apiKey: key, phoneNumber, message } = req.body;

  if (key !== apiKey) {
    return res.status(403).json({ success: false, message: '⛔ Invalid API key.' });
  }
  if (!clientReady) {
    return res.status(503).json({ success: false, message: '⚠️ WhatsApp client is not ready.' });
  }
  if (!phoneNumber || !message) {
    return res.status(400).json({ success: false, message: '❌ Phone number and message are required.' });
  }

  try {
    const numberId = await getCachedNumberId(phoneNumber);
    if (!numberId) {
      return res.status(400).json({ success: false, message: '⚠️ Number is not on WhatsApp.' });
    }
    const response = await client.sendMessage(numberId._serialized, message);
    res.status(200).json({ success: true, message: '✅ Message sent successfully!', data: response });
  } catch (error) {
    console.error('❌ Error sending message:', error);
    res.status(500).json({ success: false, message: '🚨 Failed to send the message.' });
  }
});

app.post('/logout', async (req, res) => {
  try {
    if (client) {
      await client.destroy();
      client = null;
      console.log('🚪 Client destroyed.');
    }
    const result = await mongoose.connection.db.collection('whatsapp_sessions').deleteMany({});
    console.log('🧹 Cleared whatsapp_sessions. Count:', result.deletedCount);

    clientReady = false;
    io.emit('status', { ready: false });

    setTimeout(() => {
      console.log('♻️ Reinitializing client...');
      initializeClient();
    }, 10000);

    res.status(200).json({ success: true, message: '✅ Logged out successfully. Scan QR to reconnect.' });
  } catch (error) {
    console.error('❌ Error during logout:', error);
    res.status(500).json({ success: false, message: '🚨 An error occurred while logging out.' });
  }
});

server.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
