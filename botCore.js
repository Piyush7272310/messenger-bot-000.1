const fs = require("fs");
const login = require("ws3-fca");

function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);

    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // 🟢 DEBUG: Sab event ka JSON Render ke logs me print hoga
        console.log("📩 EVENT:", JSON.stringify(event, null, 2));

        const { threadID, senderID, body, logMessageType, logMessageData } = event;

        // Example basic reply (sirf check ke liye)
        if (body && body.toLowerCase() === "/ping") {
          api.sendMessage("🏓 Pong!", threadID);
        }

        // Yahan baad me DP lock / Emoji lock ka final fix aayega
        // Lekin abhi purpose hai logs collect karna ✅

      } catch (e) {
        console.error("⚠️ Error:", e.message);
      }
    });
  });
}

module.exports = { startBot };
