const fs = require("fs");
const express = require("express");
const multer = require("multer");
const { startBot, stopBot } = require("./botCore"); // 👈 stopBot bhi import

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let botRunning = false;
let botAppState = null;
let botOwnerUID = null;

app.use("/", express.static("public"));

// ===== Status =====
app.get("/status", (_, res) => res.json({ running: botRunning }));

// ===== Healthz =====
app.get("/healthz", (_, res) => res.status(200).send("OK"));

// ===== Start Bot =====
app.post("/start", upload.single("appstate"), (req, res) => {
  try {
    if (!req.file || !req.body.owner)
      return res.json({ message: "❌ AppState and Owner UID required" });

    botAppState = req.file.path;
    botOwnerUID = req.body.owner.trim();

    startBot(botAppState, botOwnerUID);
    botRunning = true;

    res.json({ message: "✅ Bot started!" });
  } catch (err) {
    console.error("Start error:", err);
    res.json({ message: "❌ Failed to start bot" });
  }
});

// ===== Stop Bot =====
app.post("/stop", (_, res) => {
  try {
    if (botRunning) {
      stopBot(); // 👈 botCore.js me ek stopBot() function banana hoga
      botRunning = false;
      res.json({ message: "🛑 Bot stopped" });
    } else {
      res.json({ message: "⚠️ Bot is not running" });
    }
  } catch (err) {
    console.error("Stop error:", err);
    res.json({ message: "❌ Failed to stop bot" });
  }
});

const PORT = process.env.PORT || 20782;
app.listen(PORT, () =>
  console.log(`🌐 Panel running: http://localhost:${PORT}`)
);
