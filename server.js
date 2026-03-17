require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');

// Logger configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'server.log' })
    ],
});

// Database setup
const DB_PATH = process.env.DB_PATH || 'trading_data.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        logger.error(`Error opening SQLite database: ${err.message}`);
    } else {
        logger.info(`Connected to SQLite database: ${DB_PATH}`);
        db.run(`CREATE TABLE IF NOT EXISTS active_tickers (
            ticker TEXT PRIMARY KEY
        )`);
    }
});


const app = express();

// 1. Basic Security Headers
app.use(helmet());
// Reemplaza app.use(express.json()); con esto:
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = 3000;
const SECRET_KEY = process.env.API_KEY;

// 2. Security Middleware: API Key & IP Filtering
const securityCheck = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const clientIp = req.ip || req.connection.remoteAddress;

    const allowedIps = (process.env.ALLOWED_IPS || '127.0.0.1,::ffff:127.0.0.1,::1').split(',');
    const isAllowed = allowedIps.includes(clientIp);

    if (!isAllowed) {
        logger.warn(`Blocked unauthorized external access attempt from: ${clientIp}`);
        return res.status(403).json({ error: 'Access denied: IP not allowed' });
    }

    if (apiKey !== SECRET_KEY) {
        logger.warn(`Invalid API Key attempt from: ${clientIp}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    next();
};

// 3. Initialize WhatsApp Client ONCE
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa_session' }),
    puppeteer: {
        handleSIGINT: false, // Important for systemd, prevents Chromium from closing when server restarts
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
    logger.info('Scan QR code requested.');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    logger.info('WhatsApp API Server is READY!');
    isReady = true;

    logger.info('Waiting 10 seconds for WhatsApp to sync chats into memory...');

    // Add a delay before fetching the heavy chat list
    setTimeout(async () => {
        try {
            logger.info('Fetching chats now...');
            const chats = await client.getChats();

            // Filter only the groups
            const groups = chats.filter(chat => chat.isGroup);

            logger.info('--- YOUR GROUPS ---');
            if (groups.length === 0) {
                logger.info('No groups found. Sync might be incomplete.');
            } else {
                groups.forEach(group => {
                    logger.info(`Group Name: ${group.name} | ID: ${group.id._serialized}`);
                });
            }
            logger.info('-------------------');

        } catch (error) {
            logger.error(`Error trying to fetch groups: ${error.message}`);
        }
    }, 10000); // 10000 ms = 10 seconds
});

client.on('disconnected', () => {
    logger.warn('WhatsApp disconnected.');
    isReady = false;
});

client.initialize();

// Bot Command Listener
const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID;

client.on('message', async msg => {
    // GLOBAL LOG: This will tell us if the event is even firing
    logger.info(`Message received from: ${msg.from} | Content: ${msg.body}`);

    if (!msg.body || !msg.body.startsWith('/')) return;

    if (msg.from !== ALLOWED_GROUP_ID) {
        logger.warn(`Ignored message from unauthorized source: ${msg.from}`);
        return;
    }

    const args = msg.body.trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    if (command === '/start') {
        await msg.reply(
            "Welcome to the Stock Notification Bot!\n\n" +
            "Commands:\n" +
            "/add [ticker] - Add a ticker to the active list\n" +
            "/remove [ticker] - Remove a ticker from the active list\n" +
            "/list - List all active tickers"
        );
        return;
    }

    if (command === '/add') {
        if (args.length === 0) {
            await msg.reply("Usage: /add [ticker]");
            return;
        }

        const ticker = args[0].toUpperCase();
        logger.info(`Adding ticker: ${ticker}`);

        db.run("INSERT INTO active_tickers (ticker) VALUES (?)", [ticker], function (err) {
            if (err) {
                if (err.message.includes("UNIQUE constraint failed") || err.code === 'SQLITE_CONSTRAINT') {
                    logger.warn(`Ticker ${ticker} already exists.`);
                    msg.reply(`⚠️ ${ticker} is already in the list.`);
                } else {
                    logger.error(`DB error adding ticker: ${err.message}`);
                    msg.reply(`❌ Error: ${err.message}`);
                }
            } else {
                logger.info(`Successfully added ticker: ${ticker}`);
                msg.reply(`✅ Added ${ticker} to active tickers.`);
            }
        });
        return;
    }

    if (command === '/remove') {
        if (args.length === 0) {
            await msg.reply("Usage: /remove [ticker]");
            return;
        }

        const ticker = args[0].toUpperCase();
        logger.info(`Removing ticker: ${ticker}`);

        db.run("DELETE FROM active_tickers WHERE ticker = ?", [ticker], function (err) {
            if (err) {
                logger.error(`DB error removing ticker: ${err.message}`);
                msg.reply(`❌ Error: ${err.message}`);
            } else if (this.changes > 0) {
                logger.info(`Successfully removed ticker: ${ticker}`);
                msg.reply(`✅ Removed ${ticker} from active tickers.`);
            } else {
                logger.warn(`Ticker ${ticker} not found for removal.`);
                msg.reply(`⚠️ ${ticker} was not found in the list.`);
            }
        });
        return;
    }

    if (command === '/list') {
        logger.info('Listing active tickers');
        db.all("SELECT ticker FROM active_tickers ORDER BY ticker", [], (err, rows) => {
            if (err) {
                logger.error(`DB error listing tickers: ${err.message}`);
                msg.reply(`❌ Error: ${err.message}`);
                return;
            }

            if (rows && rows.length > 0) {
                const tickers = rows.map(r => r.ticker).join('\n');
                const message = `📋 *Active Tickers:*\n\n${tickers}`;
                logger.info(`Found ${rows.length} tickers.`);
                msg.reply(message);
            } else {
                logger.info('Active tickers list is empty.');
                msg.reply("📋 The active tickers list is empty.");
            }
        });
        return;
    }
});

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
        logger.info(`Processing message to ${chatId}...`);
        const media = await getMedia(req.body);

        if (media) {
            await client.sendMessage(chatId, media, { caption: message });
            logger.info('Message with media sent successfully!');
        } else {
            await client.sendMessage(chatId, message);
            logger.info('Sent text-only message.');
        }

        logger.info('Success!');
        res.status(200).json({ status: 'sent', target: chatId });

    } catch (err) {
        logger.error(`Failed to send: ${err.message}`);
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
                logger.info(`Image found at: ${absolutePath}`);
                return MessageMedia.fromFilePath(absolutePath);
            } else {
                logger.warn(`Image path NOT found: ${absolutePath}.`);
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
            logger.info('Base64 image data received.');
            return new MessageMedia(mimetype, base64Data, filename);
        }
        return null;
    });
});

// 6. Start the server on port 3000
app.listen(PORT, () => {
    logger.info(`Local API listening on http://localhost:${PORT}`);
});