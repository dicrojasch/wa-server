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

    // Only allow localhost (127.0.0.1 or ::1)
    const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::ffff:127.0.0.1' || clientIp === '::1';

    if (!isLocalhost) {
        console.warn(`🚨 Blocked unauthorized external access attempt from: ${clientIp}`);
        return res.status(403).json({ error: 'Access denied: Localhost only' });
    }

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

    // --- TEMPORAL: Log all group IDs to find yours ---
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);

    console.log('\n--- YOUR GROUPS ---');
    groups.forEach(group => {
        console.log(`Group Name: ${group.name} | ID: ${group.id._serialized}`);
    });
    console.log('-------------------\n');
});


client.on('disconnected', () => {
    console.log('❌ WhatsApp disconnected.');
    isReady = false;
});

client.initialize();

// 4. Create the Local API Endpoint for Python
app.post('/send', securityCheck, async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp is not ready yet.' });
    }

    const { phone, message, imagePath } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required.' });
    }

    // Clean phone number for Colombia format
    let chatId;
    if (phone.includes('@g.us')) {
        chatId = phone; // It's already a Group ID
    } else {
        const cleanNumber = phone.replace(/\D/g, '');
        chatId = `${cleanNumber}@c.us`; // Standard contact
    }

    try {
        console.log(`Sending image to ${chatId}...`);

        // Send Image if path is provided (since Python and Node are on the same Pi)
        if (imagePath) {
            const absolutePath = path.resolve(imagePath);
            if (fs.existsSync(absolutePath)) {
                console.log(`✅ Image found at: ${absolutePath}. Sending image...`);
                const media = MessageMedia.fromFilePath(path.resolve(imagePath));
                await client.sendMessage(chatId, media, { caption: message });
                console.log('✅ Image sent successfully!');
            } else {
                console.warn(`🛑 Image path NOT found: ${absolutePath}. Skipping image send.`);
            }
        } else {
            // If there is no file, just send the plain text message
            await client.sendMessage(chatId, message);
            console.log('ℹ️ No imagePath provided, sending text only.');
        }

        console.log('✅ Success!');
        res.status(200).json({ status: 'sent', target: chatId });

    } catch (err) {
        console.error('Failed to send:', err);
        res.status(500).json({ error: err.message });
    }
});

// 5. Start the server on port 3000
app.listen(PORT, () => {
    console.log(`🚀 Local API listening on http://localhost:${PORT}`);
});