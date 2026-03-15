const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');


const app = express();
app.use(express.json()); // Allow JSON requests

// 1. Initialize WhatsApp Client ONCE
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

client.on('ready', () => {
    console.log('✅ WhatsApp API Server is READY!');
    isReady = true;
});

client.on('disconnected', () => {
    console.log('❌ WhatsApp disconnected.');
    isReady = false;
});

client.initialize();

// 2. Create the Local API Endpoint for Python
app.post('/send', async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp is not ready yet.' });
    }

    const { phone, message, imagePath } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message are required.' });
    }

    // Clean phone number for Colombia format
    const cleanNumber = phone.replace(/\D/g, '');
    const chatId = `${cleanNumber}@c.us`;

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

// 3. Start the server on port 3000
app.listen(3000, () => {
    console.log('🚀 Local API listening on http://localhost:3000');
});