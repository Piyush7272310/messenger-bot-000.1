const fs = require("fs");
const path = require("path");
const express = require("express");

const locksPath = path.join(__dirname, "locks.json");
let locks = fs.existsSync(locksPath) ? JSON.parse(fs.readFileSync(locksPath, "utf8")) : {};
function saveLocks() {
  fs.writeFileSync(locksPath, JSON.stringify(locks, null, 2));
}

const app = express();
app.get("/healthz", (req, res) => res.send("OK"));
app.listen(3000, () => console.log("✅ Health check at :3000"));

module.exports = (api) => {
  console.log("🤖 Bot started!");

  let stickerInterval = null;
  let rkbInterval = null;

  api.listenMqtt(async (err, event) => {
    if (err) return console.error(err);

    // Debug events if needed
    // console.log(JSON.stringify(event, null, 2));

    // ===========================
    // 🔹 Message Commands
    // ===========================
    if (event.type === "message" && event.body) {
      const body = event.body.trim();
      const args = body.split(" ");
      const cmd = args[0].toLowerCase();
      const threadID = event.threadID;
      const senderID = event.senderID;

      // 📖 Help
      if (cmd === "/help") {
        const helpMsg = `📖 Bot Commands:
/help → Ye message
/uid → User ID show
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
/exit → Bot exit`;
        api.sendMessage(helpMsg, threadID);
        return;
      }

      // UID
      if (cmd === "/uid") {
        api.sendMessage("🔑 Your UID: " + senderID, threadID);
        return;
      }

      // TID
      if (cmd === "/tid") {
        api.sendMessage("🆔 Thread ID: " + threadID, threadID);
        return;
      }

      // Info
      if (cmd === "/info") {
        const mention = Object.keys(event.mentions || {})[0];
        const uid = mention || senderID;
        const userInfo = await api.getUserInfo(uid);
        const info = userInfo[uid];
        api.sendMessage(
          `ℹ️ Name: ${info.name}\nUID: ${uid}\nGender: ${info.gender}\nIs Friend: ${info.isFriend}`,
          threadID
        );
        return;
      }

      // Kick
      if (cmd === "/kick") {
        const mention = Object.keys(event.mentions || {})[0];
        if (!mention) return api.sendMessage("❌ Mention someone!", threadID);
        try {
          await api.removeUserFromGroup(mention, threadID);
          api.sendMessage(`👢 Kicked UID: ${mention}`, threadID);
        } catch {
          api.sendMessage("❌ Kick failed!", threadID);
        }
        return;
      }

      // Group Name Lock
      if (cmd === "/gclock") {
        const name = args.slice(1).join(" ");
        if (!name) return api.sendMessage("❌ Name do!", threadID);
        locks[threadID] = locks[threadID] || {};
        locks[threadID].gname = name;
        saveLocks();
        api.setTitle(name, threadID);
        api.sendMessage("🔒 Group name locked!", threadID);
        return;
      }

      if (cmd === "/unlockgc") {
        if (locks[threadID]) delete locks[threadID].gname;
        saveLocks();
        api.sendMessage("🔓 Group name unlocked!", threadID);
        return;
      }

      // Theme Lock
      if (cmd === "/locktheme") {
        const color = args[1];
        if (!color) return api.sendMessage("❌ Color code do!", threadID);
        locks[threadID] = locks[threadID] || {};
        locks[threadID].theme = color;
        saveLocks();
        api.changeThreadColor(color, threadID);
        api.sendMessage("🎨 Theme locked!", threadID);
        return;
      }

      if (cmd === "/unlocktheme") {
        if (locks[threadID]) delete locks[threadID].theme;
        saveLocks();
        api.sendMessage("🎨 Theme unlocked!", threadID);
        return;
      }

      // Emoji Lock
      if (cmd === "/lockemoji") {
        const emoji = args[1];
        if (!emoji) return api.sendMessage("❌ Emoji do!", threadID);
        locks[threadID] = locks[threadID] || {};
        locks[threadID].emoji = emoji;
        saveLocks();
        api.changeThreadEmoji(emoji, threadID);
        api.sendMessage("😀 Emoji locked!", threadID);
        return;
      }

      if (cmd === "/unlockemoji") {
        if (locks[threadID]) delete locks[threadID].emoji;
        saveLocks();
        api.sendMessage("😀 Emoji unlocked!", threadID);
        return;
      }

      // DP Lock
      if (cmd === "/lockdp") {
        if (!event.messageReply || !event.messageReply.attachments[0]) {
          return api.sendMessage("❌ Reply to a photo!", threadID);
        }
        const url = event.messageReply.attachments[0].url;
        locks[threadID] = locks[threadID] || {};
        locks[threadID].dp = url;
        saveLocks();
        api.sendMessage("🖼️ DP locked!", threadID);
        return;
      }

      if (cmd === "/unlockdp") {
        if (locks[threadID]) delete locks[threadID].dp;
        saveLocks();
        api.sendMessage("🖼️ DP unlocked!", threadID);
        return;
      }

      // Nick Lock
      if (cmd === "/locknick") {
        const mention = Object.keys(event.mentions || {})[0];
        const nick = args.slice(2).join(" ");
        if (!mention || !nick) return api.sendMessage("❌ Mention + nickname do!", threadID);
        locks[threadID] = locks[threadID] || {};
        locks[threadID].nicks = locks[threadID].nicks || {};
        locks[threadID].nicks[mention] = nick;
        saveLocks();
        api.changeNickname(nick, threadID, mention);
        api.sendMessage(`🔒 Nick locked for ${mention}`, threadID);
        return;
      }

      if (cmd === "/unlocknick") {
        const mention = Object.keys(event.mentions || {})[0];
        if (!mention) return api.sendMessage("❌ Mention do!", threadID);
        if (locks[threadID] && locks[threadID].nicks) delete locks[threadID].nicks[mention];
        saveLocks();
        api.sendMessage("🔓 Nick unlocked!", threadID);
        return;
      }

      // Sticker Spam
      if (cmd.startsWith("/sticker")) {
        const delay = parseInt(cmd.replace("/sticker", "")) || 5;
        if (!fs.existsSync("Sticker.txt")) return api.sendMessage("❌ Sticker.txt missing!", threadID);
        const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").filter(Boolean);
        if (stickerInterval) clearInterval(stickerInterval);
        let i = 0;
        stickerInterval = setInterval(() => {
          if (i >= stickerIDs.length) i = 0;
          api.sendMessage({ sticker: stickerIDs[i] }, threadID);
          i++;
        }, delay * 1000);
        api.sendMessage("😀 Sticker spam started!", threadID);
        return;
      }

      if (cmd === "/stopsticker") {
        if (stickerInterval) clearInterval(stickerInterval);
        stickerInterval = null;
        api.sendMessage("🛑 Sticker spam stopped!", threadID);
        return;
      }

      // RKB Gaali Spam
      if (cmd === "/rkb") {
        const name = args[1] || "Tere";
        if (!fs.existsSync("np.txt")) return api.sendMessage("❌ np.txt missing!", threadID);
        const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
        if (rkbInterval) clearInterval(rkbInterval);
        let index = 0;
        rkbInterval = setInterval(() => {
          if (index >= lines.length) {
            clearInterval(rkbInterval);
            rkbInterval = null;
            return;
          }
          api.sendMessage(`${name} ${lines[index]}`, threadID);
          index++;
        }, 5000);
        api.sendMessage(`🤬 Start gaali on ${name}`, threadID);
        return;
      }

      if (cmd === "/stop") {
        if (rkbInterval) clearInterval(rkbInterval);
        rkbInterval = null;
        api.sendMessage("🛑 Spam stopped!", threadID);
        return;
      }

      // Exit
      if (cmd === "/exit") {
        api.sendMessage("👋 Bot exiting group...", threadID, () => {
          api.removeUserFromGroup(api.getCurrentUserID(), threadID);
        });
        return;
      }
    }

    // ===========================
    // 🔹 Auto Reverts (5 sec delay)
    // ===========================
    if (event.type === "change_thread_image" && locks[event.threadID]?.dp) {
      setTimeout(() => {
        api.changeGroupImageUrl(locks[event.threadID].dp, event.threadID);
      }, 5000);
    }

    if (event.type === "change_thread_emoji" && locks[event.threadID]?.emoji) {
      setTimeout(() => {
        api.changeThreadEmoji(locks[event.threadID].emoji, event.threadID);
      }, 5000);
    }

    if (event.type === "change_thread_nickname" && locks[event.threadID]?.nicks) {
      const userLock = locks[event.threadID].nicks[event.participantID];
      if (userLock) {
        setTimeout(() => {
          api.changeNickname(userLock, event.threadID, event.participantID);
        }, 5000);
      }
    }

    // Anti-Leave
    if (event.type === "event" && event.logMessageType === "log:unsubscribe") {
      if (locks[event.threadID]?.antileft) {
        setTimeout(() => {
          api.addUserToGroup(event.logMessageData.leftParticipantFbId, event.threadID);
        }, 5000);
      }
    }

    // Anti-Delete
    if (event.type === "message_unsend") {
      if (locks[event.threadID]?.antidelete) {
        api.sendMessage("⚠️ Message unsend detected!", event.threadID);
      }
    }
  });
};
