require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');


const app = express();
app.use(express.json()); // Allow JSON requests

// 1. Basic Security Headers
app.use(helmet());
app.use(express.json());

const PORT = 3000;
const SECRET_KEY = process.env.API_KEY;

// 2. Security Middleware: API Key & IP Filtering
const securityCheck = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const clientIp = req.ip || req.connection.remoteAddress;

    const allowedIps = (process.env.ALLOWED_IPS || '127.0.0.1,::ffff:127.0.0.1,::1').split(',');
    const isAllowed = allowedIps.includes(clientIp);

    if (!isAllowed) {
        console.warn(`🚨 Blocked unauthorized external access attempt from: ${clientIp}`);
        return res.status(403).json({ error: 'Access denied: IP not allowed' });
    }
    console.log("apiKey", apiKey)
    console.log("SECRET_KEY", SECRET_KEY)

    if (apiKey !== SECRET_KEY) {
        console.warn(`🚨 Invalid API Key attempt from: ${clientIp}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    next();
};

// 3. Initialize WhatsApp Client ONCE
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa_session' }),
    puppeteer: {
        executablePath: '/usr/bin/chromium-browser',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

let isReady = false;

client.on('qr', (qr) => {
    console.log('\nScan this QR code:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('✅ WhatsApp API Server is READY!');
    isReady = true;

    console.log('⏳ Waiting 10 seconds for WhatsApp to sync chats into memory...');

    // Add a delay before fetching the heavy chat list
    setTimeout(async () => {
        try {
            console.log('Fetching chats now...');
            const chats = await client.getChats();

            // Filter only the groups
            const groups = chats.filter(chat => chat.isGroup);

            console.log('\n--- YOUR GROUPS ---');
            if (groups.length === 0) {
                console.log('No groups found. Sync might be incomplete.');
            } else {
                groups.forEach(group => {
                    console.log(`Group Name: ${group.name} | ID: ${group.id._serialized}`);
                });
            }
            console.log('-------------------\n');

        } catch (error) {
            console.error('❌ Error trying to fetch groups:', error.message);
        }
    }, 10000); // 10000 ms = 10 seconds
});


client.on('disconnected', () => {
    console.log('❌ WhatsApp disconnected.');
    isReady = false;
});

client.initialize();

// 4. Shared helper for sending messages
const handleMessageRequest = async (req, res, getMedia) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp is not ready yet.' });
    }

    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required.' });
    }

    // Clean phone number
    let chatId;
    if (phone.includes('@g.us')) {
        chatId = phone; // Group ID
    } else {
        const cleanNumber = phone.replace(/\D/g, '');
        chatId = `${cleanNumber}@c.us`; // Standard contact
    }

    try {
        console.log(`Processing message to ${chatId}...`);
        const media = await getMedia(req.body);

        if (media) {
            await client.sendMessage(chatId, media, { caption: message });
            console.log('✅ Message with media sent successfully!');
        } else {
            await client.sendMessage(chatId, message);
            console.log('ℹ️ Sent text-only message.');
        }

        console.log('✅ Success!');
        res.status(200).json({ status: 'sent', target: chatId });

    } catch (err) {
        console.error('❌ Failed to send:', err);
        res.status(500).json({ error: err.message });
    }
};

// 5. API Endpoints
app.post('/send', securityCheck, async (req, res) => {
    await handleMessageRequest(req, res, async (body) => {
        const { imagePath } = body;
        if (imagePath) {
            const absolutePath = path.resolve(imagePath);
            if (fs.existsSync(absolutePath)) {
                console.log(`✅ Image found at: ${absolutePath}`);
                return MessageMedia.fromFilePath(absolutePath);
            } else {
                console.warn(`🛑 Image path NOT found: ${absolutePath}.`);
            }
        }
        return null;
    });
});

app.post('/send-base64', securityCheck, async (req, res) => {
    await handleMessageRequest(req, res, async (body) => {
        const { imageBase64, mimetype = 'image/png', filename = 'image.png' } = body;
        if (imageBase64) {
            const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, "");
            console.log(`✅ Base64 image data received.`);
            return new MessageMedia(mimetype, base64Data, filename);
        }
        return null;
    });
});

// 6. Start the server on port 3000
app.listen(PORT, () => {
    console.log(`🚀 Local API listening on http://localhost:${PORT}`);
});