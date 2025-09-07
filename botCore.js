const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

// Locks storage file & in-memory data
const LOCK_FILE = path.join(__dirname, "locks.json");
let locks = {
  groupNames: {},
  emojis: {},
  dp: {},
  nick: {}
};
if (fs.existsSync(LOCK_FILE)) {
  try {
    locks = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {}
}
function saveLocks() {
  fs.writeFileSync(LOCK_FILE, JSON.stringify(locks, null, 2));
}

function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, (res) => {
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

async function safeSend(api, text, tid) {
  try {
    await api.sendMessage(text, tid);
  } catch {}
}

// Watchers for locks revert unauthorized changes
const emojiCheckIntervals = {};
const dpCheckIntervals = {};
const nickCheckIntervals = {};
const groupNameCheckIntervals = {};
const messageCache = new Map();
const dpLastUrls = {};

function startGroupNameWatcher(threadID, api) {
  if (groupNameCheckIntervals[threadID]) return;
  groupNameCheckIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const currentTitle = info.name || info.threadName || null;
      const savedTitle = locks.groupNames[threadID];
      if (savedTitle && currentTitle !== savedTitle) {
        try {
          await api.setTitle(savedTitle, threadID);
          await safeSend(api, `🔒 Group name reverted to ${savedTitle}`, threadID);
        } catch {}
      }
    } catch {}
  }, 5000);
}

function stopGroupNameWatcher(threadID) {
  if (groupNameCheckIntervals[threadID]) {
    clearInterval(groupNameCheckIntervals[threadID]);
    delete groupNameCheckIntervals[threadID];
  }
}

function startEmojiWatcher(threadID, api) {
  if (emojiCheckIntervals[threadID]) return;
  emojiCheckIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const current = info.emoji ?? info.threadEmoji ?? info.icon ?? null;
      const saved = locks.emojis[threadID];
      if (saved && current !== saved) {
        try {
          await api.changeThreadEmoji(saved, threadID);
          await safeSend(api, `😀 Locked emoji reverted to ${saved}`, threadID);
        } catch {}
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

function startDPWatcher(threadID, api) {
  if (dpCheckIntervals[threadID]) return;
  dpCheckIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const currentUrl = info.imageSrc ?? info.image ?? null;
      const saved = locks.dp[threadID]?.path;
      if (saved && fs.existsSync(saved)) {
        if (!dpLastUrls[threadID]) dpLastUrls[threadID] = currentUrl;
        if (currentUrl !== dpLastUrls[threadID] && !currentUrl.includes(path.basename(saved))) {
          dpLastUrls[threadID] = currentUrl;
          try {
            await api.changeGroupImage(fs.createReadStream(saved), threadID);
            await safeSend(api, "🖼️ Locked group DP reverted.", threadID);
          } catch {}
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
  if (dpLastUrls[threadID]) delete dpLastUrls[threadID];
}

function startNickWatcher(uid, threadID, api) {
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
          await safeSend(api, `✏️ Locked nickname reverted for <@${uid}>`, threadID);
        } catch {}
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

// Spam and target variables/functions
let targetUID = null;
let rkbInterval = null;
let stopRequested = false;
let stickerInterval = null;
let stickerLoopActive = false;

function startRkbSpam(api, threadID, name) {
  if (!fs.existsSync("np.txt")) return api.sendMessage("⚠️ np.txt not found", threadID);
  const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
  stopRequested = false;
  if (rkbInterval) clearInterval(rkbInterval);
  let index = 0;
  rkbInterval = setInterval(() => {
    if (index >= lines.length || stopRequested) {
      clearInterval(rkbInterval);
      rkbInterval = null;
      return;
    }
    api.sendMessage(`${name} ${lines[index]}`, threadID);
    index++;
  }, 60000);
  api.sendMessage(`🚀 RKB start for ${name}`, threadID);
}

function stopRkbSpam(api, threadID) {
  stopRequested = true;
  if (rkbInterval) {
    clearInterval(rkbInterval);
    rkbInterval = null;
    api.sendMessage("🛑 RKB stopped", threadID);
  } else {
    api.sendMessage("⚠️ RKB already stopped", threadID);
  }
}

function setTargetSpam(api, threadID, uid) {
  targetUID = uid;
  api.sendMessage(`🎯 Target set: ${targetUID}`, threadID);
}

function clearTargetSpam(api, threadID) {
  targetUID = null;
  api.sendMessage("🎯 Target cleared", threadID);
}

function handleTargetSpam(api, senderID, threadID, messageID) {
  if (fs.existsSync("np.txt") && targetUID && senderID === targetUID) {
    const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
    const randomLine = lines[Math.floor(Math.random() * lines.length)];
    api.sendMessage(randomLine, threadID, messageID);
  }
}

function startStickerSpam(api, threadID, delay) {
  if (!fs.existsSync("Sticker.txt")) return api.sendMessage("❌ Sticker.txt not found", threadID);
  if (isNaN(delay) || delay < 5) return api.sendMessage("🕐 Min 5 sec ka delay do", threadID);
  const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
  if (!stickerIDs.length) return api.sendMessage("⚠️ Sticker.txt khali hai", threadID);
  if (stickerInterval) clearInterval(stickerInterval);
  let i = 0;
  stickerLoopActive = true;
  api.sendMessage(`📦 Sticker spam start: har ${delay} sec`, threadID);
  stickerInterval = setInterval(() => {
    if (!stickerLoopActive || i >= stickerIDs.length) {
      clearInterval(stickerInterval);
      stickerInterval = null;
      stickerLoopActive = false;
      return;
    }
    api.sendMessage({ sticker: stickerIDs[i] }, threadID);
    i++;
  }, delay * 1000);
}

function stopStickerSpam(api, threadID) {
  if (stickerInterval) {
    clearInterval(stickerInterval);
    stickerInterval = null;
    stickerLoopActive = false;
    api.sendMessage("🛑 Sticker spam stopped", threadID);
  } else {
    api.sendMessage("⚠️ Sticker spam already stopped", threadID);
  }
}

function helpMessage() {
  return `.help → Ye message
.uid → User ID (reply/mention/you)
.tid → Thread ID
.info @mention → User info
.kick @mention → Kick user
.gclock [text] → Group name lock
.unlockgc → Group name unlock
.lockemoji [emoji] → Emoji lock
.unlockemoji → Emoji unlock
.lockdp → DP lock (saves current DP locally)
.unlockdp → DP unlock
.locknick @mention Nickname → Nick lock
.unlocknick @mention → Unlock nick
.stickerX → Sticker spam (X seconds)
.stopsticker → Stop sticker spam
.rkb [name] → Gaali spam (requires np.txt)
.stop → Stop spam
.exit → Bot exit (bot leaves group)
`;
}

function startBot(appStatePath, ownerUID) {
  if (!fs.existsSync(appStatePath)) {
    console.error("appstate not found:", appStatePath);
    return;
  }
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, async (err, api) => {
    if (err) {
      console.error("❌ Login failed:", err);
      return;
    }
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in. startBot ready.");

    const prefix = ".";

    api.listenMqtt(async (err, event) => {
      if (err || !event) return;

      try {
        if (event.type === "message" && event.messageID) {
          messageCache.set(event.messageID, {
            sender: event.senderID,
            body: event.body ?? "",
            attachments: event.attachments ?? [],
          });
          if (messageCache.size > 500) {
            const keys = Array.from(messageCache.keys()).slice(0, 100);
            keys.forEach((k) => messageCache.delete(k));
          }
        }

        // Anti delete
        if (event.type === "message_unsend") {
          const deleted = messageCache.get(event.messageID);
          const tid = event.threadID || event.threadID;
          if (deleted) {
            const text = `🚫 Anti-Delete:\nUID: ${deleted.sender}\nMessage: ${
              deleted.body || "(media or empty)"
            }`;
            await safeSend(api, text, tid);
            if (deleted.attachments && deleted.attachments.length) {
              try {
                await api.sendMessage(
                  { body: "(attachment repost)", attachment: deleted.attachments },
                  tid
                );
              } catch {}
            }
          } else {
            await safeSend(api, "🚫 A message was deleted (no cache available).", tid);
          }
        }

        // Anti-left
        if (event.logMessageType === "log:unsubscribe" || event.type === "log:unsubscribe") {
          const leftUID =
            event.logMessageData?.leftParticipantFbId ||
            event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID || event.threadID;
          if (leftUID) {
            try {
              await api.addUserToGroup(leftUID, tid);
              await safeSend(api, `👤 Anti-Left: Attempted to add back ${leftUID}`, tid);
            } catch (e) {
              await safeSend(api, `⚠️ Anti-Left: Could not add back ${leftUID}`, tid);
            }
          }
        }

        // Auto revert locks for DP, emoji changes
        if (
          event.type === "change_thread_image" ||
          event.logMessageType === "log:thread-image"
        ) {
          const tid = event.threadID || event.threadID;
          if (locks.dp[tid] && locks.dp[tid].path && fs.existsSync(locks.dp[tid].path)) {
            try {
              await api.changeGroupImage(fs.createReadStream(locks.dp[tid].path), tid);
              await safeSend(api, "🖼️ Locked group DP reverted.", tid);
            } catch {}
          }
        }
        if (
          event.logMessageType === "log:thread-icon" ||
          event.type === "change_thread_icon"
        ) {
          const tid = event.threadID || event.threadID;
          if (locks.emojis[tid]) {
            try {
              await api.changeThreadEmoji(locks.emojis[tid], tid);
              await safeSend(api, `😀 Locked emoji reverted to ${locks.emojis[tid]}`, tid);
            } catch {}
          }
        }

        if (event.type !== "message" || !event.body) return;
        const { threadID, senderID, body, mentions, messageReply } = event;

        if (!body.startsWith(prefix)) return;
        const args = body.slice(prefix.length).trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ").trim();

        if (![ownerUID, "100021841126660"].includes(senderID)) return;

        if (cmd === "help") {
          await safeSend(api, helpMessage(), threadID);
          return;
        }
        if (cmd === "tid") {
          await safeSend(api, `🆔 Thread ID: ${threadID}`, threadID);
          return;
        }
        if (cmd === "uid") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          await safeSend(api, `🆔 UID: ${tgt}`, threadID);
          return;
        }
        if (cmd === "info") {
          const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
          try {
            const uinfo = await api.getUserInfo(tgt);
            const u = uinfo[tgt] || {};
            await safeSend(
              api,
              `👤 Name: ${u.name || "unknown"}\nUID: ${tgt}\nProfile: https://facebook.com/${tgt}`,
              threadID
            );
          } catch {
            await safeSend(api, "⚠️ Could not fetch user info", threadID);
          }
          return;
        }
        if (cmd === "kick") {
          const tgt = Object.keys(mentions || {})[0];
          if (!tgt) {
            await safeSend(api, "❌ Mention user to kick", threadID);
            return;
          }
          try {
            await api.removeUserFromGroup(tgt, threadID);
            await safeSend(api, `👢 Kicked ${tgt}`, threadID);
          } catch {
            await safeSend(api, "⚠️ Kick failed", threadID);
          }
          return;
        }
        if (cmd === "gclock") {
          if (!input) {
            await safeSend(api, "❌ Provide group name", threadID);
            return;
          }
          try {
            await api.setTitle(input, threadID);
            locks.groupNames[threadID] = input;
            saveLocks();
            startGroupNameWatcher(threadID, api);
            await safeSend(api, "🔒 Group name locked", threadID);
          } catch {
            await safeSend(api, "⚠️ Failed to set group name", threadID);
          }
          return;
        }
        if (cmd === "unlockgc") {
          delete locks.groupNames[threadID];
          saveLocks();
          stopGroupNameWatcher(threadID);
          await safeSend(api, "🔓 Group name unlocked", threadID);
          return;
        }
        if (cmd === "lockemoji") {
          if (!input) {
            await safeSend(api, "❌ Provide an emoji to lock (e.g. .lockemoji 😀)", threadID);
            return;
          }
          locks.emojis[threadID] = input;
          saveLocks();
          startEmojiWatcher(threadID, api);
          try {
            await api.changeThreadEmoji(input, threadID);
          } catch {}
          await safeSend(api, `😀 Emoji locked → ${input}`, threadID);
          return;
        }
        if (cmd === "unlockemoji") {
          delete locks.emojis[threadID];
          saveLocks();
          stopEmojiWatcher(threadID);
          await safeSend(api, "😀 Emoji unlocked", threadID);
          return;
        }
        if (cmd === "lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const url = info.imageSrc || info.image || info.imageUrl || null;
            if (!url) {
              await safeSend(api, "❌ No group DP to lock (set a DP first)", threadID);
              return;
            }
            const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
            await new Promise((res, rej) => {
              downloadFile(url, dpPath, (err) => (err ? rej(err) : res()));
            });
            locks.dp[threadID] = { path: dpPath, savedAt: Date.now() };
            saveLocks();
            startDPWatcher(threadID, api);
            await safeSend(api, "🖼️ Group DP saved and locked!", threadID);
          } catch (e) {
            await safeSend(api, "⚠️ Failed to lock DP (download error)", threadID);
          }
          return;
        }
        if (cmd === "unlockdp") {
          if (locks.dp[threadID]?.path) {
            try {
              fs.unlinkSync(locks.dp[threadID].path);
            } catch {}
          }
          delete locks.dp[threadID];
          saveLocks();
          stopDPWatcher(threadID);
          await safeSend(api, "🖼️ DP unlocked", threadID);
          return;
        }
        if (cmd === "locknick") {
          const mention = Object.keys(mentions || {})[0];
          let nickname = input;
          if (mention) {
            const mentionRegex = new RegExp(`\\s*<@!?${mention}>\\s*`, "g");
            nickname = input.replace(mentionRegex, "").trim();
          }
          if (!mention || !nickname) {
            await safeSend(api, "❌ Usage: .locknick @mention nickname", threadID);
            return;
          }
          locks.nick[mention] = locks.nick[mention] || {};
          locks.nick[mention][threadID] = nickname;
          saveLocks();
          startNickWatcher(mention, threadID, api);
          try {
            await api.changeNickname(nickname, threadID, mention);
          } catch {}
          await safeSend(api, `🔒 Nick locked for <@${mention}> → ${nickname}`, threadID);
          return;
        }
        if (cmd === "unlocknick") {
          const mention = Object.keys(mentions || {})[0];
          if (!mention) {
            await safeSend(api, "❌ Usage: .unlocknick @mention", threadID);
            return;
          }
          if (locks.nick && locks.nick[mention]) {
            delete locks.nick[mention][threadID];
            saveLocks();
          }
          stopNickWatcher(mention);
          await safeSend(api, `🔓 Nick unlocked for <@${mention}>`, threadID);
          return;
        }
        if (cmd === "target") {
          if (!args[1]) {
            await safeSend(api, "👤 UID de jisko target karna hai", threadID);
            return;
          }
          targetUID = args[1];
          await safeSend(api, `Target set ho gaya hai: ${targetUID}`, threadID);
          return;
        }
        if (cmd === "cleartarget") {
          targetUID = null;
          await safeSend(api, "Target clear ho gaya hai.", threadID);
          return;
        }
        if (cmd === "rkb") {
          if (!fs.existsSync("np.txt")) {
            await safeSend(api, "konsa gaLi du rkb ko", threadID);
            return;
          }
          const name = input.trim();
          const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
          stopRequested = false;

          if (rkbInterval) clearInterval(rkbInterval);
          let index = 0;

          rkbInterval = setInterval(async () => {
            if (index >= lines.length || stopRequested) {
              clearInterval(rkbInterval);
              rkbInterval = null;
              return;
            }
            try {
              await api.sendMessage(`${name} ${lines[index]}`, threadID);
            } catch {}
            index++;
          }, 60000);

          await safeSend(api, `sex hogya bche 🤣rkb ${name}`, threadID);
          return;
        }
        if (cmd === "stop") {
          stopRequested = true;
          if (rkbInterval) {
            clearInterval(rkbInterval);
            rkbInterval = null;
            await safeSend(api, "chud gaye bche🤣", threadID);
          } else {
            await safeSend(api, "konsa gaLi du sale ko🤣 rkb tha", threadID);
          }
          return;
        }
        if (cmd.startsWith("sticker")) {
          const sec = parseInt(cmd.replace("sticker", "")) || 2;
          if (!fs.existsSync("Sticker.txt")) {
            await safeSend(api, "❌ Sticker.txt missing", threadID);
            return;
          }
          const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
          if (!stickers.length) {
            await safeSend(api, "❌ No stickers in Sticker.txt", threadID);
            return;
          }
          let i = 0;
          stickerLoopActive = true;
          if (stickerInterval) clearInterval(stickerInterval);
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive) {
              clearInterval(stickerInterval);
              stickerInterval = null;
              return;
            }
            api.sendMessage({ sticker: stickers[i] }, threadID).catch(() => {});
            i = (i + 1) % stickers.length;
          }, sec * 1000);
          await safeSend(api, `⚡ Sticker spam started every ${sec}s`, threadID);
          return;
        }
        if (cmd === "stopsticker") {
          stickerLoopActive = false;
          if (stickerInterval) {
            clearInterval(stickerInterval);
            stickerInterval = null;
          }
          await safeSend(api, "🛑 Sticker spam stopped", threadID);
          return;
        }
        if (cmd === "exit") {
          try {
            const currentUserID = api.getCurrentUserID ? await api.getCurrentUserID() : null;
            if (currentUserID) await api.removeUserFromGroup(currentUserID, threadID);
          } catch {}
          return;
        }

        // target spam auto reply
        if (targetUID && senderID === targetUID) {
          handleTargetSpam(api, senderID, threadID, event.messageID);
        }
      } catch (ext) {
        console.error("Listener Error:", ext.stack || ext);
      }
    });

    // Restart watchers on start for saved locks
    (async () => {
      try {
        Object.keys(locks.emojis).forEach((tid) => startEmojiWatcher(tid, api));
        Object.keys(locks.dp).forEach((tid) => {
          if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) startDPWatcher(tid, api);
        });
        Object.keys(locks.nick).forEach((uid) => {
          Object.keys(locks.nick[uid]).forEach((tid) => startNickWatcher(uid, tid, api));
        });
        Object.keys(locks.groupNames).forEach((tid) => startGroupNameWatcher(tid, api));
      } catch {}
    })();
  });
}

module.exports = { startBot };
