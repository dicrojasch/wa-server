# WhatsApp API Gateway for Invoice Bot

This server acts as a persistent bridge between your Python logic and the WhatsApp Web protocol. By running a standalone **Express.js** server, we avoid the overhead of reopening Chromium for every message, ensuring high stability on Raspberry Pi hardware.

---

## 🛠 Prerequisites

* **Hardware:** Raspberry Pi (3, 4, or 5 recommended).
* **OS:** Raspberry Pi OS (Debian-based).
* **Environment:** * Node.js (v18+ recommended).
    * Chromium Browser (`sudo apt install chromium-browser`).

---

## 🚀 Installation

1.  **Clone or create the project folder:**
    ```bash
    mkdir -p ~/invoice-whatsapp-web
    cd ~/invoice-whatsapp-web
    ```

2.  **Install dependencies:**
    ```bash
    npm install whatsapp-web.js qrcode-terminal express dotenv helmet sqlite3
    ```

---

## 🤖 WhatsApp Bot Commands
The server now includes a built-in bot to manage active stock tickers directly from WhatsApp messages.

*   `/start`: Welcome message and command list.
*   `/add [ticker]`: Add a ticker to the active list (e.g., `/add AAPL`).
*   `/remove [ticker]`: Remove a ticker from the list (e.g., `/remove AAPL`).
*   `/list`: Display all currently active tickers.

> [!NOTE]
> Bot commands are restricted to the `ALLOWED_GROUP_ID` defined in your environment variables for security.

---

## 📝 Logging
The server uses **Winston** for professional logging. Logs are displayed in the console and saved to `server.log` in the root directory.

---

## ⚙️ Process Management (Systemd)
To ensure the server runs 24/7 and starts automatically on boot, follow these steps to set up a Systemd service.

### 1. Create the service file
Run the following command to create the configuration file:
```bash
sudo nano /etc/systemd/system/wa-invoice-server.service
```

#### Paste the configuration
Copy and paste the content from file @wa-invoice-server.service.ini

#### Enable and start the service
```bash
# Reload the systemd manager
sudo systemctl daemon-reload

# Enable the service to start on boot
sudo systemctl enable wa-invoice-server.service

# Start the service now
sudo systemctl start wa-invoice-server.service
```
#### Verification and logs 
```bash
# PM2 is also an option if preferred
pm2 start server.js --name wa-invoice-server
```

---

## 🚦 API Endpoints

The server listens on **port 3000**. All endpoints require `x-api-key` in headers.

#### `POST /send`
Sends a text message and an optional local image.
* **Body (JSON):** `{"phone": "...", "message": "...", "imagePath": "..."}`

#### `POST /send-base64`
Sends a message with a base64 encoded image.
* **Body (JSON):** `{"phone": "...", "message": "...", "imageBase64": "...", "mimetype": "image/png"}`

---

## 🐍 Python Integration

```python
import requests

def send_whatsapp(phone, message, image=None):
    url = "http://localhost:3000/send"
    headers = {"x-api-key": "YOUR_SECRET_KEY"}
    payload = {
        "phone": phone,
        "message": message,
        "imagePath": image
    }
    r = requests.post(url, json=payload, headers=headers)
    return r.json()
```