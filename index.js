const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

// ✅ Hardcoded MongoDB URI (LOCAL)
const MONGO_URI = 'mongodb://aliabbaszounr1:Aliabbas321@cluster1-shard-00-00.rpo2r.mongodb.net:27017,cluster1-shard-00-01.rpo2r.mongodb.net:27017,cluster1-shard-00-02.rpo2r.mongodb.net:27017/whatsapp_sessions?replicaSet=atlas-14bnbx-shard-0&ssl=true&authSource=admin';

// ✅ MongoDB Model for API Key Storage
const SessionSchema = new mongoose.Schema({
    sessionId: String,
    apiKey: String
});
const Session = mongoose.model('Session', SessionSchema);

// ✅ MongoDB Connection (FIXED)
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
}).then(() => {
    console.log('✅ MongoDB connected successfully.');
    initializeClient();
}).catch(err => {
    console.error('❌ MongoDB connection error:', err);
});

// MongoDB Connection Event Listeners
mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB disconnected! Retrying...'));
mongoose.connection.on('error', err => console.error('❌ MongoDB error:', err));

// Middleware to parse JSON payloads
app.use(express.json());

// Serve a minimal frontend page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ✅ Initialize WhatsApp Client
let client;
let clientReady = false;
let qrCodeData = null;
let apiKey = '';

const initializeClient = async () => {
    const store = new MongoStore({ mongoose });

    // Fetch stored API key or generate a new one
    let sessionData = await Session.findOne({ sessionId: 'whatsapp' });
    if (!sessionData) {
        apiKey = crypto.randomBytes(16).toString('hex');
        await new Session({ sessionId: 'whatsapp', apiKey }).save();
    } else {
        apiKey = sessionData.apiKey;
    }
    console.log('🔑 Current API Key:', apiKey);

    client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000, // Sync session every 5 min
        }),
    });

    client.on('qr', (qr) => {
        console.log('⚡ QR Code received');
        qrCodeData = qr;
        qrcode.toDataURL(qr, (err, qrImage) => {
            if (!err) io.emit('qr', qrImage);
        });
    });

    client.on('authenticated', async () => {
        console.log('✅ Client authenticated successfully!');
        io.emit('status', { ready: true, apiKey });
    });

    client.on('ready', () => {
        console.log('🎉 WhatsApp client is ready!');
        clientReady = true;
        qrCodeData = null;
        io.emit('status', { ready: true, apiKey });
    });

    client.on('disconnected', async (reason) => {
        console.log('❌ WhatsApp client disconnected:', reason);
        clientReady = false;
        qrCodeData = null;
        io.emit('status', { ready: false });

        // Auto-reinitialize client on disconnect
        setTimeout(() => {
            console.log('♻️ Reinitializing client...');
            initializeClient();
        }, 5000);
    });

    client.on('call', async (call) => {
        console.log(`📞 Incoming call from ${call.from}. Rejecting...`);
        try {
            await call.reject();
            console.log(`✅ Call from ${call.from} rejected.`);
        } catch (error) {
            console.error(`❌ Failed to reject call:`, error);
        }
    });

    client.initialize();
};

// Handle client connection
io.on('connection', (socket) => {
    console.log('⚡ Client connected');
    socket.emit('status', { ready: clientReady, apiKey });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected');
    });
});

// ✅ Message Sending API
app.post('/send-message', async (req, res) => {
    const { apiKey: reqApiKey, phoneNumber, message } = req.body;

    if (reqApiKey !== apiKey) {
        return res.status(403).json({
            success: false,
            message: '⛔ Invalid API key.',
        });
    }

    if (!clientReady) {
        return res.status(503).json({
            success: false,
            message: '⚠️ WhatsApp client is not ready.',
        });
    }

    if (!phoneNumber || !message) {
        return res.status(400).json({
            success: false,
            message: '❌ Phone number and message are required.',
        });
    }

    try {
        const numberId = await client.getNumberId(phoneNumber);
        if (!numberId) {
            return res.status(400).json({
                success: false,
                message: '⚠️ Number is not on WhatsApp.',
            });
        }

        const response = await client.sendMessage(numberId._serialized, message);
        res.status(200).json({
            success: true,
            message: '✅ Message sent successfully!',
            data: response,
        });
    } catch (error) {
        console.error('❌ Error sending message:', error);
        res.status(500).json({
            success: false,
            message: '🚨 Failed to send the message.',
        });
    }
});

// ✅ Logout API
app.post('/logout', async (req, res) => {
    try {
        await client.destroy();
        console.log('🚪 Client destroyed.');

        clientReady = false;
        io.emit('status', { ready: false });

        setTimeout(() => {
            console.log('♻️ Reinitializing client...');
            initializeClient();
        }, 5000);

        res.status(200).json({
            success: true,
            message: '✅ Logged out successfully. Scan QR code again to reconnect.',
        });
    } catch (error) {
        console.error('❌ Error during logout:', error);
        res.status(500).json({
            success: false,
            message: '🚨 An error occurred while logging out.',
        });
    }
});

// ✅ Start the server
server.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});
