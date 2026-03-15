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
    npm install whatsapp-web.js qrcode-terminal express dotenv helmet
    ```

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
sudo systemctl status wa-invoice-server.service
journalctl -u wa-invoice-server.service -f
```

#### Maintenance Commands

| Action            | Command                                            |
| ----------------- | -------------------------------------------------- |
| Stop Server       | `sudo systemctl stop wa-invoice-server.service`    |
| Restart Server    | `sudo systemctl restart wa-invoice-server.service` |
| View Last 50 Logs | `journalctl -u wa-invoice-server.service -n 50`    |

### Service Configuration
The service file is located at: `/etc/systemd/system/wa-invoice-server.service`

### Common Commands
* **Start Server:** `sudo systemctl start wa-invoice-server`
* **Stop Server:** `sudo systemctl stop wa-invoice-server`
* **Restart Server:** `sudo systemctl restart wa-invoice-server`
* **Check Status:** `sudo systemctl status wa-invoice-server`
* **View Real-time Logs:** `journalctl -u wa-invoice-server -f`

---

## 🚦 API Endpoints

The server listens on **port 3000**.

#### `POST /send`
Sends a text message and an optional PDF document.

* **URL:** `http://localhost:3000/send`
* **Method:** `POST`
* **Body (JSON):**
    ```json
    {
      "phone": "573204973157",
      "message": "Hello! This is your invoice.",
      "pdfPath": "/home/diego/invoices/inv_001.pdf"
    }
    ```

---

## 🐍 Python Integration

```python
import requests

def send_whatsapp(phone, message, pdf=None):
    url = "http://localhost:3000/send"
    payload = {
        "phone": phone,
        "message": message,
        "pdfPath": pdf
    }
    try:
        r = requests.post(url, json=payload)
        return r.json()
    except Exception as e:
        return {"error": str(e)}

# Usage:
# send_whatsapp("573204973157", "Test from Python", "/path