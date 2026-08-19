require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
// const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const { exec } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

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
// const DB_PATH = process.env.DB_PATH || 'trading_data.db';
// const db = new sqlite3.Database(DB_PATH, (err) => {
//     if (err) {
//         logger.error(`Error opening SQLite database: ${err.message}`);
//     } else {
//         logger.info(`Connected to SQLite database: ${DB_PATH}`);
//         db.run(`CREATE TABLE IF NOT EXISTS active_tickers (
//             ticker TEXT PRIMARY KEY
//         )`);
//     }
// });


const app = express();

// 1. Basic Security Headers
app.use(helmet());
// Replace app.use(express.json()); with this to handle large payloads:
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = 3000;
const SECRET_KEY = process.env.API_KEY;

// Bot Command Listener
const ALLOWED_GROUP_ID = process.env.ALLOWED_GROUP_ID;
const EXPENSES_GROUP_ID = process.env.EXPENSES_GROUP_ID;

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
    authStrategy: new LocalAuth({ dataPath: process.env.SESSION_PATH || './wa_session' }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
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
            logger.info('Extracting groups directly from WhatsApp Web internal Store...');

            // Execute raw JS inside the browser context to collect group data bypassing getChats()
            const groups = await client.pupPage.evaluate(() => {
                if (!window.Store || !window.Store.Chat) return [];

                return window.Store.Chat.models
                    .filter(chat => chat.isGroup === true)
                    .map(group => ({
                        name: group.name || group.formattedTitle || 'Unknown Group',
                        id: group.id._serialized || group.id
                    }));
            });

            logger.info('--- YOUR GROUPS ---');
            if (!groups || groups.length === 0) {
                logger.info('No groups found in the current browser cache. Try receiving or sending a message to a group first.');
            } else {
                groups.forEach(group => {
                    logger.info(`Group Name: ${group.name} | ID: ${group.id}`);
                });
            }
            logger.info('-------------------');

        } catch (error) {
            logger.error(`Failed to extract groups from internal store: ${error.message || error}`);
        }
    }, 15000); // 15 seconds to ensure Store is fully initialized
});

client.on('disconnected', () => {
    logger.warn('WhatsApp disconnected.');
    isReady = false;
});

// Event: Message handling (Using message_create to capture both incoming and outgoing messages)
client.on('message_create', async (msg) => {
    // Determine the chat context:
    // If sent by me, the target group is in 'msg.to'
    // If received from others, the target group is in 'msg.from'
    const chatContext = msg.fromMe ? msg.to : msg.from;

    // Strict filter: only process messages within allowed groups
    if (chatContext !== ALLOWED_GROUP_ID && chatContext !== EXPENSES_GROUP_ID) {
        return;
    }
    // Prevent circular loops: do not process the bot's own confirmation messages
    if (msg.body && (msg.body.startsWith('✅') || msg.body.startsWith('❌'))) {
        return;
    }
    logger.info(`Processing message from group: ${chatContext}`);
    // --- Expenses Automation Logic ---
    if (chatContext === EXPENSES_GROUP_ID) {

        logger.info(`Processing message from expenses group: ${chatContext}`);
        try {
            logger.info(`Full message content from ${chatContext}: hasMedia: ${msg.hasMedia}, type: ${msg.type}, body: ${msg.body} , to: ${msg.to}, from: ${msg.from} `);
            // Handle audio/voice messages
            if (msg.hasMedia && (msg.type === 'audio' || msg.type === 'voice' || msg.type === 'ptt')) {
                logger.info(`Processing voice message from expenses group: ${chatContext}`);
                const media = await msg.downloadMedia();
                if (media) {
                    const formData = new FormData();
                    const buffer = Buffer.from(media.data, 'base64');
                    formData.append('file', buffer, {
                        filename: media.filename || 'voice_expense.ogg',
                        contentType: media.mimetype,
                    });

                    await axios.post('http://localhost:8000/process-audio', formData, {
                        headers: formData.getHeaders(),
                    });
                    logger.info('Voice message successfully sent to expenses API.');
                    await msg.reply('✅ Voice expense received and sent for processing.');
                    return; // Stop further processing for this message
                } else {
                    await msg.reply('❌ Failed to download audio media.');
                    return;
                }
            }

            // Handle text messages in format: "Price - Description"
            if (msg.body && !msg.body.startsWith('/')) {
                const expensePattern = /([\d.,]+)\s+([a-záéíóúñ\d\s]+?)(?=\s+[\d.,]+|$)/g;
                msg.body = msg.body.toLowerCase();
                if (expensePattern.test(msg.body)) {
                    const formattedText = msg.body.replace(/([a-zA-ZáéíóúñÁÉÍÓÚÑ])\s+(?=\d)/g, '$1, ');
                    logger.info(`Processing text expense from group ${chatContext}: ${formattedText}`);
                    await axios.post('http://localhost:8000/process-text', {
                        body: formattedText
                    });
                    logger.info('Text expense successfully sent to API.');
                    await msg.reply(`✅ Expense registered: ${formattedText}`);
                    return; // Stop further processing for this message
                } else {
                    // Not matching the pattern - inform the user about the expected format
                    logger.info(`Malformed expense received in ${chatContext}: ${msg.body}`);
                    await msg.reply('❌ Invalid format. Please use "Price Description" (e.g., "15000 almuerzo").');
                    return;
                }
            }
        } catch (error) {
            logger.error(`Expenses API Error: ${error.message}`);
            await msg.reply(`❌ Error processing expense: ${error.message}`);
            return;
        }
    } else {

        // --- Bot Command Logic ---
        // Ignore messages that do not start with the command prefix '/' or are not from the main allowed group
        if (chatContext !== ALLOWED_GROUP_ID || !msg.body || !msg.body.startsWith('/')) {
            return;
        }

        // Parse command and arguments
        const args = msg.body.trim().split(/\s+/);
        const command = args.shift().toLowerCase();

        logger.info(`Processing command: ${command} in group: ${chatContext}`);

        // Command: /list
        // if (command === '/list') {
        //     db.all("SELECT ticker FROM active_tickers", [], (err, rows) => {
        //         if (err) {
        //             logger.error(`DB Error: ${err.message}`);
        //             return msg.reply("Error accessing database.");
        //         }
        //         const tickers = rows.map(r => r.ticker).sort().join(', ');
        //         msg.reply(tickers ? `📋 Active Tickers: ${tickers}` : "No active tickers found.");
        //     });
        // }

        if (command === '/scan') {

        }

        // Command: /add [TICKER]
        // if (command === '/add' && args.length > 0) {
        //     const ticker = args[0].toUpperCase();
        //     db.run("INSERT OR IGNORE INTO active_tickers (ticker) VALUES (?)", [ticker], (err) => {
        //         if (err) {
        //             logger.error(`DB Error: ${err.message}`);
        //             return msg.reply("Error saving ticker.");
        //         }
        //         msg.reply(`✅ Ticker ${ticker} added successfully.`);
        //     });
        // }

        // Command: /remove [TICKER]
        // if (command === '/remove' && args.length > 0) {
        //     const ticker = args[0].toUpperCase();
        //     db.run("DELETE FROM active_tickers WHERE ticker = ?", [ticker], (err) => {
        //         if (err) return msg.reply("Error removing ticker.");
        //         msg.reply(`🗑️ Ticker ${ticker} removed.`);
        //     });
        // }

        // Command: /scan
        if (command === '/scan') {
            msg.reply('🔄 Running stock scan...');
            const scanCmd = 'PYTHONIOENCODING=utf-8 /home/diego/repos/stock-notification/.venv/bin/python /home/diego/repos/stock-notification/src/main.py >> /mnt/disco/mylogs/stock-notification/main.log 2>&1';
            exec(scanCmd, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`Scan process error: ${error.message}`);
                    msg.reply(`❌ Scan failed: ${error.message}`);
                    return;
                }
                logger.info('Scan process completed successfully.');
                msg.reply('✅ Stock scan completed.');
            });
        }
    }
});

// Captura el ID de cualquier grupo en el momento exacto en que tenga actividad
client.on('message_create', (msg) => {
    try {
        // 1. Validar de forma segura si el mensaje proviene de un grupo sin invocar promesas pesadas
        // En whatsapp-web.js, los identificadores de grupos siempre terminan en '@g.us'
        const remoteId = msg.id?.remote?._serialized || msg.id?.remote || '';
        const isGroup = remoteId.endsWith('@g.us');

        if (isGroup) {
            // 2. Determinar la dirección usando la propiedad nativa que ya viene en el payload
            const direction = msg.fromMe ? 'SENT BY ME' : 'RECEIVED';

            // 3. Intentar obtener el nombre del remitente o del grupo si ya viene en los metadatos del mensaje
            // Usamos fallbacks seguros para evitar que cualquier propiedad indefinida rompa el hilo
            const author = msg.author || msg.from || 'Unknown';

            logger.info(`[Group Activity][${direction}] ID: ${remoteId} | Msg Author: ${author}`);
        }
    } catch (error) {
        // Esta captura previene de manera absoluta que un fallo en un mensaje detenga el servidor
        logger.error(`Error processing message_create event safely: ${error.message || error}`);
    }
});

// --- Startup Cleanup and Initialization ---
const cleanupLock = () => {
    const sessionPath = process.env.SESSION_PATH || './wa_session';
    const lockPath = path.join(sessionPath, 'session', 'SingletonLock');
    if (fs.existsSync(lockPath)) {
        try {
            logger.info('Removing stale Puppeteer lock file...');
            fs.unlinkSync(lockPath);
            logger.info('Lock file removed.');
        } catch (err) {
            logger.warn(`Could not remove lock file: ${err.message}`);
        }
    }
};

cleanupLock();
client.initialize();

// --- Graceful Shutdown Handler ---
const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);

    try {
        if (isReady && client) {
            logger.info('Destroying WhatsApp client...');
            await client.destroy();
            logger.info('WhatsApp client destroyed successfully.');
        }

        // 1. Si tienes un servidor Express corriendo (ej. const server = express().listen(...))
        if (typeof server !== 'undefined' && server.close) {
            logger.info('Closing Express server...');
            await new Promise((resolve) => server.close(resolve));
            logger.info('Express server closed.');
        }

        // 2. Si tienes la base de datos SQLite abierta (ej. const db = new sqlite3.Database(...))
        if (typeof db !== 'undefined' && db.close) {
            logger.info('Closing SQLite database...');
            await new Promise((resolve) => {
                db.close((err) => {
                    if (err) logger.error(`Error closing DB: ${err.message}`);
                    resolve();
                });
            });
            logger.info('SQLite database closed.');
        }

        logger.info('Shutdown complete. Exiting process.');
        // Fuerza la salida exitosa (código 0) una vez que todo se limpió
        process.exit(0);

    } catch (err) {
        logger.error(`Error during shutdown: ${err.message}`);
        process.exit(1);
    }
};

// Handle termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));


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

app.post('/send-video', securityCheck, async (req, res) => {
    await handleMessageRequest(req, res, async (body) => {
        const { videoPath, videoBase64, mimetype = 'video/mp4', filename = 'video.mp4' } = body;
        if (videoPath) {
            const absolutePath = path.resolve(videoPath);
            if (fs.existsSync(absolutePath)) {
                logger.info(`Video found at: ${absolutePath}`);
                return MessageMedia.fromFilePath(absolutePath);
            } else {
                logger.warn(`Video path NOT found: ${absolutePath}.`);
            }
        } else if (videoBase64) {
            const base64Data = videoBase64.replace(/^data:[^;]+;base64,/, "");
            logger.info('Base64 video data received.');
            return new MessageMedia(mimetype, base64Data, filename);
        }
        return null;
    });
});

app.get('/groups', securityCheck, async (req, res) => {
    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp is not ready yet.' });
    }
    try {
        logger.info('Fetching groups via GET /groups endpoint (direct page eval)...');

        // getChats() uses window.require('WAWebCollections') which WhatsApp has renamed
        // in newer builds. Instead we scan the webpack module registry at runtime to
        // find whichever module currently exposes a Chat collection with getModelsArray().
        const groups = await client.pupPage.evaluate(() => {
            const results = [];
            try {
                // Walk every registered webpack module looking for a Chat store
                const moduleIds = Object.keys(window.webpackChunkwhatsapp_web_client?.[0]?.[1] || {});
                for (const id of moduleIds) {
                    try {
                        const mod = window.require(id);
                        if (mod && mod.Chat && typeof mod.Chat.getModelsArray === 'function') {
                            mod.Chat.getModelsArray().forEach(chat => {
                                if (chat && chat.isGroup) {
                                    results.push({
                                        name: chat.formattedTitle || chat.name || '',
                                        id: chat.id && chat.id._serialized ? chat.id._serialized : String(chat.id)
                                    });
                                }
                            });
                            break; // found the right module
                        }
                    } catch (_) { /* skip modules that can't be required */ }
                }
            } catch (e) {
                throw new Error('Module scan failed: ' + e.message);
            }
            return results;
        });

        logger.info(`Successfully fetched ${groups.length} groups.`);
        res.status(200).json(groups);
    } catch (err) {
        logger.error(`Error fetching groups endpoint: ${err.stack || err.message || err}`);
        res.status(500).json({ error: err.message || String(err) });
    }
});

// 6. Start the server on port 3000
app.listen(PORT, () => {
    logger.info(`Local API listening on http://localhost:${PORT}`);
});