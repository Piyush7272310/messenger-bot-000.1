const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { startBot } = require("./botCore");

const app = express();
const upload = multer({ 
    dest: "uploads/",
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// Config storage
const CONFIG_FILE = "bot-config.json";

let botRunning = false;
let botConfig = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static("public"));

// Load existing config
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

// Initialize config
loadConfig();

// ==================== ROUTES ====================

// Serve panel
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Get current status
app.get("/api/status", (req, res) => {
    res.json({
        running: botRunning,
        config: botConfig ? {
            hasAppState: true,
            ownerUID: botConfig.ownerUID,
            lastStarted: botConfig.lastStarted
        } : null,
        memory: {
            usage: process.memoryUsage().rss / 1024 / 1024,
            uptime: process.uptime()
        }
    });
});

// Upload appstate and start bot
app.post("/api/start", upload.single("appstate"), async (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, message: "❌ Please upload appstate.txt file" });
        }

        if (!req.body.ownerUID) {
            return res.json({ success: false, message: "❌ Admin UID is required" });
        }

        const ownerUID = req.body.ownerUID.trim();
        
        // Validate UID format
        if (!/^\d+$/.test(ownerUID)) {
            return res.json({ success: false, message: "❌ Invalid UID format" });
        }

        // Stop bot if already running
        if (botRunning) {
            return res.json({ success: false, message: "❌ Bot is already running" });
        }

        // Read and validate appstate file
        const appStatePath = req.file.path;
        let appState;
        try {
            const fileContent = fs.readFileSync(appStatePath, "utf8");
            appState = JSON.parse(fileContent);
            
            // Basic validation
            if (!Array.isArray(appState) || appState.length === 0) {
                throw new Error("Invalid appstate format");
            }
        } catch (e) {
            fs.unlinkSync(appStatePath); // Clean up invalid file
            return res.json({ success: false, message: "❌ Invalid appstate file format" });
        }

        // Save config
        botConfig = {
            appStatePath: appStatePath,
            ownerUID: ownerUID,
            lastStarted: new Date().toISOString()
        };
        
        if (!saveConfig(botConfig)) {
            return res.json({ success: false, message: "❌ Failed to save configuration" });
        }

        // Start bot
        try {
            startBot(appStatePath, ownerUID);
            botRunning = true;
            
            res.json({ 
                success: true, 
                message: "✅ Bot started successfully!",
                config: {
                    ownerUID: ownerUID,
                    lastStarted: botConfig.lastStarted
                }
            });
        } catch (botError) {
            botRunning = false;
            res.json({ 
                success: false, 
                message: "❌ Bot startup failed: " + botError.message 
            });
        }

    } catch (error) {
        console.error("Start error:", error);
        res.json({ 
            success: false, 
            message: "❌ Server error: " + error.message 
        });
    }
});

// Stop bot
app.post("/api/stop", (req, res) => {
    try {
        // Note: You'll need to implement stopBot function in botCore.js
        // For now, we'll just set the flag
        botRunning = false;
        
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

// Get bot logs (if you implement logging)
app.get("/api/logs", (req, res) => {
    // Implement log retrieval if you have logging system
    res.json({ logs: [] });
});

// Clear config
app.post("/api/clear", (req, res) => {
    try {
        if (botRunning) {
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

const PORT = process.env.PORT || 20782;
app.listen(PORT, () => {
    console.log(`🌐 Bot Panel running on http://localhost:${PORT}`);
    console.log(`📁 Config file: ${CONFIG_FILE}`);
});
