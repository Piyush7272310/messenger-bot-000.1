const express = require("express");
const multer = require("multer");
const { startBot, stopBot } = require("./botCore");

const app = express();
const upload = multer({ dest: "uploads/" });

let botRunning = false;
let botOwnerUID = null;
let botAppState = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Lovers Panel UI
app.use("/", express.static("public"));

// ===== API =====

// Status
app.get("/status", (req, res) => {
  res.json({ running: botRunning, owner: botOwnerUID });
});

// Start bot
app.post("/start", upload.single("appstate"), (req, res) => {
  if (!req.file || !req.body.owner) {
    return res.json({ success: false, message: "❌ AppState & Owner UID required" });
  }

  botAppState = req.file.path;
  botOwnerUID = req.body.owner.trim();

  try {
    startBot(botAppState, botOwnerUID);
    botRunning = true;
    res.json({ success: true, message: "✅ Bot started!" });
  } catch (e) {
    res.json({ success: false, message: "❌ Failed to start bot" });
  }
});

// Stop bot
app.post("/stop", (req, res) => {
  try {
    stopBot();
  } catch {}
  botRunning = false;
  res.json({ success: true, message: "🛑 Bot stopped" });
});

// Health check
app.get("/healthz", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 20782;
app.listen(PORT, () => console.log(`🌐 Lovers Panel running on http://localhost:${PORT}`));
