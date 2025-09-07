// botCore.js — Full bot with locks, anti-delete, anti-left, spam, etc.
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

// ---------- Config / Persistent storage ----------
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = {
  groupNames: {},
  themes: {},
  emojis: {},
  dp: {},
  nick: {}
};
if (fs.existsSync(LOCK_FILE)) {
  try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch { }
}
function saveLocks() { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }

// ---------- Helpers ----------
function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close();
      return downloadFile(res.headers.location, dest, cb);
    }
    res.pipe(file);
    file.on("finish", () => file.close(() => cb(null)));
  }).on("error", err => {
    try { fs.unlinkSync(dest); } catch { }
    cb(err);
  });
}

// ---------- Runtime state ----------
const emojiCheckIntervals = {};
const dpCheckIntervals = {};
const nickCheckIntervals = {};
const messageCache = new Map();
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// Spam vars
let stickerInterval = null;
let stickerLoopActive = false;
let rkbInterval = null;
let stopRequested = false;

// ---------- Main ----------
function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) {
    console.error("❌ appstate.json not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in. startBot ready.");

    // ---------- Watchers ----------
    function startEmojiWatcher(threadID) {
      if (emojiCheckIntervals[threadID]) return;
      emojiCheckIntervals[threadID] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const current = info.emoji ?? info.threadEmoji ?? info.icon ?? null;
          const saved = locks.emojis[threadID];
          if (saved && current !== saved) {
            await api.changeThreadEmoji(saved, threadID).catch(() => {});
            console.log(`🔄 [emoji] reverted for ${threadID} -> ${saved}`);
            await api.sendMessage(`😀 Locked emoji reverted to ${saved}`, threadID);
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

    function startDPWatcher(threadID) {
      if (dpCheckIntervals[threadID]) return;
      dpCheckIntervals[threadID] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const currentUrl = info.imageSrc ?? info.image ?? null;
          const saved = locks.dp[threadID]?.path;
          if (saved && fs.existsSync(saved) && currentUrl && !currentUrl.includes(path.basename(saved))) {
            await api.changeGroupImage(fs.createReadStream(saved), threadID).catch(() => {});
            console.log(`🔄 [dp] reverted for ${threadID} using ${saved}`);
            await api.sendMessage("🖼️ Locked group DP reverted.", threadID);
          }
        } catch {}
      }, 5000);
    }
    function stopDPWatcher(threadID) {
      if (dpCheckIntervals[threadID]) {
        clearInterval(dpCheckIntervals[threadID]);
        delete dpCheckIntervals[threadID];
      }
    }

    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const memberNick = (info.nicknames && info.nicknames[uid]) || null;
          const savedNick = locks.nick?.[uid]?.[threadID];
          if (savedNick && memberNick !== savedNick) {
            await api.changeNickname(savedNick, threadID, uid).catch(() => {});
            console.log(`🔄 [nick] reverted for ${uid} in ${threadID} -> ${savedNick}`);
            await api.sendMessage(`✏️ Locked nickname reverted for <@${uid}>`, threadID);
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

    async function safeSend(text, tid) {
      try { await api.sendMessage(text, tid); } catch {}
    }

    // ---------- Event listener ----------
    api.listenMqtt(async (err, event) => {
      if (err || !event) return;

      // Cache messages
      if (event.type === "message" && event.messageID) {
        messageCache.set(event.messageID, {
          sender: event.senderID,
          body: event.body ?? "",
          attachments: event.attachments ?? []
        });
        if (messageCache.size > 500) {
          const keys = Array.from(messageCache.keys()).slice(0, 100);
          keys.forEach(k => messageCache.delete(k));
        }
      }

      // Anti-delete
      if (event.type === "message_unsend") {
        const deleted = messageCache.get(event.messageID);
        const tid = event.threadID;
        if (deleted) {
          await safeSend(`🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media or empty)"}`, tid);
        } else {
          await safeSend("🚫 A message was deleted (no cache available).", tid);
        }
      }

      // Anti-left
      if (event.logMessageType === "log:unsubscribe") {
        const leftUID = event.logMessageData?.leftParticipantFbId;
        const tid = event.threadID;
        if (leftUID) {
          try { await api.addUserToGroup(leftUID, tid); } catch {}
          await safeSend(`👤 Anti-Left: Attempted to add back ${leftUID}`, tid);
        }
      }

      // DP / Emoji direct revert triggers
      if ((event.type === "change_thread_image" || event.logMessageType === "log:thread-image")) {
        const tid = event.threadID;
        if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) {
          await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid).catch(() => {});
          await safeSend("🖼️ Locked group DP reverted.", tid);
        }
      }
      if (event.logMessageType === "log:thread-icon") {
        const tid = event.threadID;
        if (locks.emojis[tid]) {
          await api.changeThreadEmoji(locks.emojis[tid], tid).catch(() => {});
          await safeSend(`😀 Locked emoji reverted to ${locks.emojis[tid]}`, tid);
        }
      }

      // Commands go here (owner-only)
      if (event.type !== "message" || !event.body) return;
      const { threadID, senderID, body, mentions, messageReply } = event;
      if (![ownerUID, LID].includes(senderID)) return;

      // Example command
      if (body.startsWith("/tid")) {
        await safeSend(`🆔 Thread ID: ${threadID}`, threadID);
      }
      // Add all other commands like /help, /lockdp, /lockemoji, /locknick etc.
    });

    // ---------- Init watchers ----------
    (async () => {
      try {
        for (const tid of Object.keys(locks.emojis || {})) startEmojiWatcher(tid);
        for (const tid of Object.keys(locks.dp || {})) {
          if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) startDPWatcher(tid);
        }
        for (const uid of Object.keys(locks.nick || {})) {
          for (const tid of Object.keys(locks.nick[uid] || {})) startNickWatcher(uid, tid);
        }
        console.log("🔒 Watchers initialized from locks.json");
      } catch (e) {
        console.error("init watchers failed:", e?.message || e);
      }
    })();
  });
}

// ---------- Start Bot ----------
startBot(path.join(__dirname, "appstate.json"), "YOUR_OWNER_UID_HERE");

// Export module if needed
module.exports = { startBot };
