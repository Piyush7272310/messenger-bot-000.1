const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { startBot, stopBot, getBotStatus } = require("./botCore");

const app = express();
const upload = multer({ 
    dest: "uploads/",
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

const CONFIG_FILE = "bot-config.json";
let botConfig = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Load config
function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            botConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            return true;
        } catch (e) {
            console.error("Config load error:", e);
            return false;
        }
    }
    return false;
}

// Save config
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return true;
    } catch (e) {
        console.error("Config save error:", e);
        return false;
    }
}

loadConfig();

// Routes
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/status", (req, res) => {
    const status = getBotStatus();
    res.json({
        running: status.isRunning,
        config: botConfig ? {
            hasAppState: true,
            ownerUID: botConfig.ownerUID,
            lastStarted: botConfig.lastStarted
        } : null,
        memory: {
            usage: process.memoryUsage().rss / 1024 / 1024,
            uptime: process.uptime()
        },
        stats: {
            restarts: status.restartCount,
            hasApi: status.currentApi
        }
    });
});

app.post("/api/start", upload.single("appstate"), async (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, message: "❌ Please upload appstate.txt file" });
        }

        if (!req.body.ownerUID) {
            return res.json({ success: false, message: "❌ Admin UID is required" });
        }

        const ownerUID = req.body.ownerUID.trim();
        
        if (!/^\d+$/.test(ownerUID)) {
            return res.json({ success: false, message: "❌ Invalid UID format" });
        }

        const status = getBotStatus();
        if (status.isRunning) {
            return res.json({ success: false, message: "❌ Bot is already running" });
        }

        const appStatePath = req.file.path;
        let appState;
        try {
            const fileContent = fs.readFileSync(appStatePath, "utf8");
            appState = JSON.parse(fileContent);
            
            if (!Array.isArray(appState) || appState.length === 0) {
                throw new Error("Invalid appstate format");
            }
        } catch (e) {
            fs.unlinkSync(appStatePath);
            return res.json({ success: false, message: "❌ Invalid appstate file format" });
        }

        botConfig = {
            appStatePath: appStatePath,
            ownerUID: ownerUID,
            lastStarted: new Date().toISOString()
        };
        
        if (!saveConfig(botConfig)) {
            return res.json({ success: false, message: "❌ Failed to save configuration" });
        }

        startBot(appStatePath, ownerUID);
        
        res.json({ 
            success: true, 
            message: "✅ Bot started successfully!",
            config: {
                ownerUID: ownerUID,
                lastStarted: botConfig.lastStarted
            }
        });

    } catch (error) {
        console.error("Start error:", error);
        res.json({ 
            success: false, 
            message: "❌ Server error: " + error.message 
        });
    }
});

app.post("/api/stop", (req, res) => {
    try {
        stopBot();
        res.json({ 
            success: true, 
            message: "🛑 Bot stopped successfully" 
        });
    } catch (error) {
        res.json({ 
            success: false, 
            message: "❌ Stop failed: " + error.message 
        });
    }
});

app.post("/api/clear", (req, res) => {
    try {
        const status = getBotStatus();
        if (status.isRunning) {
            return res.json({ 
                success: false, 
                message: "❌ Stop bot before clearing config" 
            });
        }

        if (botConfig && botConfig.appStatePath && fs.existsSync(botConfig.appStatePath)) {
            fs.unlinkSync(botConfig.appStatePath);
        }

        if (fs.existsSync(CONFIG_FILE)) {
            fs.unlinkSync(CONFIG_FILE);
        }

        botConfig = null;
        res.json({ 
            success: true, 
            message: "🧹 Configuration cleared successfully" 
        });
    } catch (error) {
        res.json({ 
            success: false, 
            message: "❌ Clear failed: " + error.message 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Bot Panel running on http://localhost:${PORT}`);
    console.log(`📁 Upload your appstate.txt file to start the bot`);
});
