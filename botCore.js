const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

// Locks storage
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = { groupNames: {}, emojis: {}, dp: {}, nick: {} };
if (fs.existsSync(LOCK_FILE)) {
  try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch {}
}
function saveLocks() {
  fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2));
}

function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close();
      return downloadFile(res.headers.location, dest, cb);
    }
    res.pipe(file);
    file.on("finish", () => file.close(() => cb(null)));
  }).on("error", (err) => {
    try { fs.unlinkSync(dest); } catch {}
    cb(err);
  });
}

async function safeSend(api, text, tid) {
  try { await api.sendMessage(text, tid); } catch {}
}

// Watchers
const emojiCheckIntervals = {};
const dpCheckIntervals = {};
const nickCheckIntervals = {};
const groupNameCheckIntervals = {};
const messageCache = new Map();
const dpLastUrls = {};

function startGroupNameWatcher(threadID, api) {
  if (groupNameCheckIntervals[threadID]) return;
  groupNameCheckIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const current = info.name || info.threadName || null;
      const saved = locks.groupNames[threadID];
      if (saved && current !== saved) {
        try {
          await api.setTitle(saved, threadID);
          await safeSend(api, `🔒 Group name reverted to ${saved}`, threadID);
        } catch {}
      }
    } catch {}
  }, 5000);
}
function stopGroupNameWatcher(threadID) {
  if (groupNameCheckIntervals[threadID]) {
    clearInterval(groupNameCheckIntervals[threadID]);
    delete groupNameCheckIntervals[threadID];
  }
}
function startEmojiWatcher(threadID, api) {
  if (emojiCheckIntervals[threadID]) return;
  emojiCheckIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const current = info.emoji ?? info.threadEmoji ?? info.icon ?? null;
      const saved = locks.emojis[threadID];
      if (saved && current !== saved) {
        try {
          await api.changeThreadEmoji(saved, threadID);
          await safeSend(api, `😀 Emoji reverted to ${saved}`, threadID);
        } catch {}
      }
    } catch {}
  }, 5000);
}
function stopEmojiWatcher(threadID) {
  if (emojiCheckIntervals[threadID]) {
    clearInterval(emojiCheckIntervals[threadID]);
    delete emojiCheckIntervals[threadID];
  }
}
function startDPWatcher(threadID, api) {
  if (dpCheckIntervals[threadID]) return;
  dpCheckIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const currentUrl = info.imageSrc ?? info.image ?? null;
      const saved = locks.dp[threadID]?.path;
      if (saved && fs.existsSync(saved)) {
        if (!dpLastUrls[threadID]) dpLastUrls[threadID] = currentUrl;
        if (currentUrl !== dpLastUrls[threadID]) {
          dpLastUrls[threadID] = currentUrl;
          try {
            await api.changeGroupImage(fs.createReadStream(saved), threadID);
            await safeSend(api, "🖼️ Locked group DP reverted.", threadID);
          } catch {}
        }
      }
    } catch {}
  }, 5000);
}
function stopDPWatcher(threadID) {
  if (dpCheckIntervals[threadID]) {
    clearInterval(dpCheckIntervals[threadID]);
    delete dpCheckIntervals[threadID];
  }
  if (dpLastUrls[threadID]) delete dpLastUrls[threadID];
}
function startNickWatcher(uid, threadID, api) {
  if (nickCheckIntervals[uid]) return;
  nickCheckIntervals[uid] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const memberNick = (info.nicknames && info.nicknames[uid]) || null;
      const saved = locks.nick?.[uid]?.[threadID];
      if (saved && memberNick !== saved) {
        try {
          await api.changeNickname(saved, threadID, uid);
          await safeSend(api, `✏️ Nick reverted for <@${uid}>`, threadID);
        } catch {}
      }
    } catch {}
  }, 5000);
}
function stopNickWatcher(uid) {
  if (nickCheckIntervals[uid]) {
    clearInterval(nickCheckIntervals[uid]);
    delete nickCheckIntervals[uid];
  }
}

// Spam / Target
let targetUID = null;
let rkbInterval = null;
let stopRequested = false;
let stickerInterval = null;
let stickerLoopActive = false;

function handleTargetSpam(api, senderID, threadID, messageID) {
  if (fs.existsSync("np.txt") && targetUID && senderID === targetUID) {
    const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
    const randomLine = lines[Math.floor(Math.random() * lines.length)];
    api.sendMessage(randomLine, threadID, messageID);
  }
}

function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) return console.error("appstate not found");
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, async (err, api) => {
    if (err) return console.error("❌ Login failed:", err);

    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in.");

    const prefix = ".";

    api.listenMqtt(async (err, event) => {
      if (err || !event) return;

      try {
        if (event.type === "message" && event.messageID) {
          messageCache.set(event.messageID, {
            sender: event.senderID,
            body: event.body ?? "",
            attachments: event.attachments ?? [],
          });
          if (messageCache.size > 500) {
            const keys = Array.from(messageCache.keys()).slice(0, 100);
            keys.forEach((k) => messageCache.delete(k));
          }
        }

        // Anti delete
        if (event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID;
          if (deleted) {
            const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${
              deleted.body || "(media/empty)"
            }`;
            await safeSend(api, text, tid);
            if (deleted.attachments?.length) {
              try {
                await api.sendMessage({ body: "(attachment)", attachment: deleted.attachments }, tid);
              } catch {}
            }
          }
        }

        // Anti left
        if (event.logMessageType === "log:unsubscribe") {
          const leftUID = event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID;
          if (leftUID) {
            try {
              await api.addUserToGroup(leftUID, tid);
              await safeSend(api, `👤 Anti-Left: added back ${leftUID}`, tid);
            } catch {
              await safeSend(api, `⚠️ Could not add back ${leftUID}`, tid);
            }
          }
        }

        // Locks auto revert
        if (event.type === "change_thread_image" && locks.dp[event.threadID]) {
          try {
            await api.changeGroupImage(fs.createReadStream(locks.dp[event.threadID].path), event.threadID);
            await safeSend(api, "🖼️ DP reverted.", event.threadID);
          } catch {}
        }
        if (event.logMessageType === "log:thread-icon" && locks.emojis[event.threadID]) {
          try {
            await api.changeThreadEmoji(locks.emojis[event.threadID], event.threadID);
            await safeSend(api, `😀 Emoji reverted to ${locks.emojis[event.threadID]}`, event.threadID);
          } catch {}
        }

        if (event.type !== "message" || !event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();

        if (![ownerUID, "100021841126660"].includes(senderID)) return;

        // === Help ===
        if (cmd === "help") {
          const helpMsg = `
📜 Available Commands:

🔒 Locks:
.gclock <name> | .unlockgc
.lockemoji <emoji> | .unlockemoji
.lockdp | .unlockdp
.locknick @user <n> | .unlocknick @user

🚫 Protection:
(anti-delete & anti-left auto)

🚀 Spam:
.rkb <name> | .stop
.target <uid> | .cleartarget
.sticker10 (sec) | .stopsticker

🆔 IDs:
.tid | .uid (@mention)
          `;
          return safeSend(api, helpMsg.trim(), threadID);
        }

        if (cmd === "tid") return safeSend(api, `🆔 ThreadID: ${threadID}`, threadID);
        if (cmd === "uid") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          return safeSend(api, `🆔 UID: ${tgt}`, threadID);
        }

        // Kick
        if (cmd === "kick") {
          const tgt = Object.keys(mentions || {})[0];
          if (!tgt) return safeSend(api, "❌ Mention user", threadID);
          try { await api.removeUserFromGroup(tgt, threadID); } catch {}
          return safeSend(api, `👢 Kicked ${tgt}`, threadID);
        }

        // Group name lock/unlock
        if (cmd === "gclock") {
          if (!input) return safeSend(api, "❌ Provide name", threadID);
          try {
            await api.setTitle(input, threadID);
            locks.groupNames[threadID] = input; saveLocks();
            startGroupNameWatcher(threadID, api);
            return safeSend(api, "🔒 Group name locked", threadID);
          } catch { return safeSend(api, "⚠️ Failed", threadID); }
        }
        if (cmd === "unlockgc") {
          delete locks.groupNames[threadID]; saveLocks();
          stopGroupNameWatcher(threadID);
          return safeSend(api, "🔓 Group name unlocked", threadID);
        }

        // Emoji lock/unlock
        if (cmd === "lockemoji") {
          if (!input) return safeSend(api, "❌ Provide emoji", threadID);
          locks.emojis[threadID] = input; saveLocks();
          startEmojiWatcher(threadID, api);
          try { await api.changeThreadEmoji(input, threadID); } catch {}
          return safeSend(api, `😀 Emoji locked → ${input}`, threadID);
        }
        if (cmd === "unlockemoji") {
          delete locks.emojis[threadID]; saveLocks();
          stopEmojiWatcher(threadID);
          return safeSend(api, "😀 Emoji unlocked", threadID);
        }

        // DP lock/unlock
        if (cmd === "lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const url = info.imageSrc || null;
            if (!url) return safeSend(api, "❌ No DP", threadID);
            const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
            await new Promise((res, rej) => downloadFile(url, dpPath, (err) => err ? rej(err) : res()));
            locks.dp[threadID] = { path: dpPath }; saveLocks();
            startDPWatcher(threadID, api);
            return safeSend(api, "🖼️ DP locked", threadID);
          } catch { return safeSend(api, "⚠️ DP lock failed", threadID); }
        }
        if (cmd === "unlockdp") {
          if (locks.dp[threadID]?.path) try { fs.unlinkSync(locks.dp[threadID].path); } catch {}
          delete locks.dp[threadID]; saveLocks(); stopDPWatcher(threadID);
          return safeSend(api, "🖼️ DP unlocked", threadID);
        }

        // Nick lock/unlock
        if (cmd === "locknick") {
          const mention = Object.keys(mentions || {})[0];
          let nickname = input;
          if (mention) nickname = nickname.replace(new RegExp(`@${mention}`), "").trim();
          if (!mention || !nickname) return safeSend(api, "❌ Usage: .locknick @mention nick", threadID);
          locks.nick[mention] = locks.nick[mention] || {};
          locks.nick[mention][threadID] = nickname; saveLocks();
          startNickWatcher(mention, threadID, api);
          try { await api.changeNickname(nickname, threadID, mention); } catch {}
          return safeSend(api, `🔒 Nick locked for <@${mention}> → ${nickname}`, threadID);
        }
        if (cmd === "unlocknick") {
          const mention = Object.keys(mentions || {})[0];
          if (!mention) return safeSend(api, "❌ Usage: .unlocknick @mention", threadID);
          if (locks.nick[mention]) delete locks.nick[mention][threadID];
          saveLocks(); stopNickWatcher(mention);
          return safeSend(api, `🔓 Nick unlocked for <@${mention}>`, threadID);
        }

        // Target / RKB
        if (cmd === "target") {
          if (!args[1]) return safeSend(api, "👤 UID de", threadID);
          targetUID = args[1]; return safeSend(api, `Target set: ${targetUID}`, threadID);
        }
        if (cmd === "cleartarget") {
          targetUID = null; return safeSend(api, "Target cleared", threadID);
        }
        if (cmd === "rkb") {
          if (!fs.existsSync("np.txt")) return safeSend(api, "np.txt missing", threadID);
          const name = input.trim(); const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          stopRequested = false; if (rkbInterval) clearInterval(rkbInterval);
          let index = 0;
          rkbInterval = setInterval(async () => {
            if (index >= lines.length || stopRequested) { clearInterval(rkbInterval); rkbInterval = null; return; }
            try { await api.sendMessage(`${name} ${lines[index]}`, threadID); } catch {}
            index++;
          }, 6000);
          return safeSend(api, `🚀 RKB started for ${name}`, threadID);
        }
        if (cmd === "stop") {
          stopRequested = true;
          if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; return safeSend(api, "🛑 RKB stopped", threadID); }
          else return safeSend(api, "⚠️ No RKB running", threadID);
        }

        // Sticker spam
        if (cmd.startsWith("sticker")) {
          const sec = parseInt(cmd.replace("sticker", "")) || 2;
          if (!fs.existsSync("Sticker.txt")) return safeSend(api, "❌ Sticker.txt missing", threadID);
          const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean);
          if (!stickers.length) return safeSend(api, "❌ No stickers", threadID);
          let i = 0; stickerLoopActive = true;
          if (stickerInterval) clearInterval(stickerInterval);
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive || i >= stickers.length) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; return; }
            try { api.sendMessage({ sticker: stickers[i] }, threadID); } catch {}
            i++;
          }, sec * 1000);
          return safeSend(api, `📦 Sticker spam started (${sec} sec)`, threadID);
        }
        if (cmd === "stopsticker") {
          if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; return safeSend(api, "🛑 Sticker spam stopped", threadID); }
          else return safeSend(api, "⚠️ No sticker spam running", threadID);
        }

        // 🔥 Target spam trigger
        handleTargetSpam(api, senderID, threadID, event.messageID);

      } catch (e) { console.error("⚠️ Error:", e); }
    });
  });
}

module.exports = { startBot };
