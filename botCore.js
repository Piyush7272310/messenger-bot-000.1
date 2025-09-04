const fs = require("fs");
const login = require("ws3-fca");

// ===== JSON Storage =====
const STATE_FILE = "locks.json";
let state = { groupNames: {}, themes: {}, emojis: {}, dp: {}, nicks: {}, antiDelete: false, antiLeft: false };

if (fs.existsSync(STATE_FILE)) {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

// ===== Global Variables =====
let rkbInterval = null;
let stopRequested = false;
let stickerInterval = null;
let stickerLoopActive = false;

// ===== Start Bot =====
function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    api.listenMqtt(async (err, event) => {
      if (err || !event) return;

      // Debug Raw Event
      // console.log("===== RAW EVENT =====");
      // console.log(JSON.stringify(event, null, 2));

      const { type, threadID, senderID, body, logMessageType, logMessageData } = event;

      // ====== Anti Delete ======
      if (state.antiDelete && type === "message_unsend") {
        api.sendMessage(`⚠️ Anti-Delete: User ${event.senderID} tried to delete a message!`, threadID);
      }

      // ====== Anti Left ======
      if (state.antiLeft && logMessageType === "log:unsubscribe") {
        const leftUser = logMessageData?.leftParticipantFbId;
        if (leftUser) {
          try {
            await api.addUserToGroup(leftUser, threadID);
            api.sendMessage(`⚠️ Anti-Left: ${leftUser} ko wapas la diya gaya ✅`, threadID);
          } catch { }
        }
      }

      // ====== Reverts ======
      if (logMessageType === "log:thread-name" && state.groupNames[threadID]) {
        if (logMessageData?.name !== state.groupNames[threadID]) {
          await api.setTitle(state.groupNames[threadID], threadID);
          console.log(`🔒 Group name reverted in ${threadID}`);
        }
      }
      if (logMessageType === "log:thread-color" && state.themes[threadID]) {
        if (logMessageData?.theme_color !== state.themes[threadID]) {
          await api.changeThreadColor(state.themes[threadID], threadID);
          console.log(`🎨 Theme reverted in ${threadID}`);
        }
      }
      if (logMessageType === "log:thread-icon" && state.emojis[threadID]) {
        if (logMessageData?.thread_icon !== state.emojis[threadID]) {
          await api.changeThreadEmoji(state.emojis[threadID], threadID);
          console.log(`😀 Emoji reverted in ${threadID}`);
        }
      }
      if (type === "change_thread_image" && state.dp[threadID]) {
        try {
          const stream = fs.createReadStream(state.dp[threadID]);
          await api.changeGroupImage(stream, threadID);
          console.log(`🖼 DP reverted in ${threadID}`);
        } catch (e) { console.error("DP revert error:", e.message); }
      }

      // ====== Nick Lock Revert ======
      if (logMessageType === "log:user-nickname" && state.nicks[threadID]) {
        const changedUID = Object.keys(logMessageData?.nickname || {})[0];
        if (changedUID && state.nicks[threadID][changedUID]) {
          const lockedNick = state.nicks[threadID][changedUID];
          if (logMessageData.nickname[changedUID] !== lockedNick) {
            await api.changeNickname(lockedNick, threadID, changedUID);
            console.log(`🔒 Nick reverted for ${changedUID} in ${threadID}`);
          }
        }
      }

      // ===== Commands =====
      if (!body) return;
      if (![ownerUID].includes(senderID)) return;

      const args = body.trim().split(" ");
      const cmd = args[0].toLowerCase();
      const input = args.slice(1).join(" ");

      // 📖 Help
      if (cmd === "/help") {
        return api.sendMessage(`
📖 Bot Commands:
/help → Ye message
/uid → Group ID show
/tid → Thread ID show
/info @mention → User info
/kick @mention → Kick user
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → DP lock (reply to photo or current dp)
/unlockdp → DP unlock
/locknick @mention Nick → Nick lock
/unlocknick @mention → Unlock nick
/stickerX → Sticker spam (X=seconds)
/stopsticker → Stop sticker spam
/rkb [name] → Gaali spam
/stop → Stop spam
/antidelete on/off → Anti delete toggle
/antileft on/off → Anti left toggle
/exit → Bot exit
        `, threadID);
      }

      // 🔹 UID + TID
      else if (cmd === "/uid") return api.sendMessage(`🆔 Group ID: ${threadID}`, threadID);
      else if (cmd === "/tid") return api.sendMessage(`🆔 Thread ID: ${threadID}`, threadID);

      // 🔹 Info
      else if (cmd === "/info") {
        const mentionID = Object.keys(event.mentions || {})[0] || (event.messageReply && event.messageReply.senderID);
        if (!mentionID) return api.sendMessage("❌ Mention or reply required!", threadID);
        return api.sendMessage(`ℹ️ Info:\nUID: ${mentionID}`, threadID);
      }

      // 🔹 Kick
      else if (cmd === "/kick") {
        const mentionID = Object.keys(event.mentions || {})[0];
        if (!mentionID) return api.sendMessage("❌ Mention required!", threadID);
        try {
          await api.removeUserFromGroup(mentionID, threadID);
          api.sendMessage(`👢 User kicked: ${mentionID}`, threadID);
        } catch { api.sendMessage("❌ Kick failed!", threadID); }
      }

      // 🔹 Group Name Lock
      else if (cmd === "/gclock") {
        state.groupNames[threadID] = input;
        saveState();
        await api.setTitle(input, threadID);
        api.sendMessage("🔒 Group name locked!", threadID);
      } else if (cmd === "/unlockgc") {
        delete state.groupNames[threadID];
        saveState();
        api.sendMessage("🔓 Group name unlocked!", threadID);
      }

      // 🔹 Theme Lock
      else if (cmd === "/locktheme") {
        if (!input) return api.sendMessage("❌ Color code do!", threadID);
        state.themes[threadID] = input;
        saveState();
        await api.changeThreadColor(input, threadID);
        api.sendMessage("🎨 Theme locked!", threadID);
      } else if (cmd === "/unlocktheme") {
        delete state.themes[threadID];
        saveState();
        api.sendMessage("🎨 Theme unlocked!", threadID);
      }

      // 🔹 Emoji Lock
      else if (cmd === "/lockemoji") {
        if (!input) return api.sendMessage("❌ Emoji do!", threadID);
        state.emojis[threadID] = input;
        saveState();
        await api.changeThreadEmoji(input, threadID);
        api.sendMessage("😀 Emoji locked!", threadID);
      } else if (cmd === "/unlockemoji") {
        delete state.emojis[threadID];
        saveState();
        api.sendMessage("😀 Emoji unlocked!", threadID);
      }

      // 🔹 DP Lock
      else if (cmd === "/lockdp") {
        if (event.messageReply && event.messageReply.attachments?.[0]) {
          const file = event.messageReply.attachments[0];
          const filePath = `dp_${threadID}.jpg`;
          const stream = fs.createWriteStream(filePath);
          file.pipe(fs.createWriteStream(filePath));
          state.dp[threadID] = filePath;
          saveState();
          api.sendMessage("🖼 DP locked from replied image!", threadID);
        } else {
          state.dp[threadID] = `dp_${threadID}.jpg`;
          saveState();
          api.sendMessage("🖼 Current DP locked (will revert on change)!", threadID);
        }
      } else if (cmd === "/unlockdp") {
        delete state.dp[threadID];
        saveState();
        api.sendMessage("🖼 DP unlocked!", threadID);
      }

      // 🔹 Nick Lock
      else if (cmd === "/locknick") {
        const mentionID = Object.keys(event.mentions || {})[0];
        if (!mentionID || !input.split(" ")[1]) return api.sendMessage("❌ Mention + Nickname required!", threadID);
        const nick = input.split(" ").slice(1).join(" ");
        if (!state.nicks[threadID]) state.nicks[threadID] = {};
        state.nicks[threadID][mentionID] = nick;
        saveState();
        await api.changeNickname(nick, threadID, mentionID);
        api.sendMessage(`🔒 Nick locked for <@${mentionID}> = ${nick}`, threadID);
      } else if (cmd === "/unlocknick") {
        const mentionID = Object.keys(event.mentions || {})[0];
        if (!mentionID) return api.sendMessage("❌ Mention required!", threadID);
        if (state.nicks[threadID]) delete state.nicks[threadID][mentionID];
        saveState();
        api.sendMessage(`🔓 Nick unlocked for ${mentionID}`, threadID);
      }

      // 🔹 Sticker Spam
      else if (cmd.startsWith("/sticker")) {
        if (!fs.existsSync("Sticker.txt")) return;
        const delay = parseInt(cmd.replace("/sticker", ""));
        const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
        if (stickerInterval) clearInterval(stickerInterval);
        let i = 0; stickerLoopActive = true;
        stickerInterval = setInterval(() => {
          if (!stickerLoopActive || i >= stickerIDs.length) {
            clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; return;
          }
          api.sendMessage({ sticker: stickerIDs[i] }, threadID);
          i++;
        }, delay * 1000);
        api.sendMessage(`🤖 Sticker spam started (delay ${delay}s)!`, threadID);
      } else if (cmd === "/stopsticker") {
        if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; }
        api.sendMessage("🛑 Sticker spam stopped!", threadID);
      }

      // 🔹 Gaali Spam
      else if (cmd === "/rkb") {
        if (!fs.existsSync("np.txt")) return api.sendMessage("❌ np.txt missing!", threadID);
        const name = input.trim();
        const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
        stopRequested = false;
        if (rkbInterval) clearInterval(rkbInterval);
        let index = 0;
        rkbInterval = setInterval(() => {
          if (index >= lines.length || stopRequested) { clearInterval(rkbInterval); rkbInterval = null; return; }
          api.sendMessage(`${name} ${lines[index]}`, threadID);
          index++;
        }, 5000);
        api.sendMessage(`🤬 Start gaali on ${name}`, threadID);
      } else if (cmd === "/stop") {
        stopRequested = true;
        if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; }
        api.sendMessage("🛑 Spam stopped!", threadID);
      }

      // 🔹 Anti Delete / Anti Left
      else if (cmd === "/antidelete") {
        if (input === "on") { state.antiDelete = true; saveState(); api.sendMessage("✅ Anti-Delete ON", threadID); }
        else if (input === "off") { state.antiDelete = false; saveState(); api.sendMessage("🛑 Anti-Delete OFF", threadID); }
      } else if (cmd === "/antileft") {
        if (input === "on") { state.antiLeft = true; saveState(); api.sendMessage("✅ Anti-Left ON", threadID); }
        else if (input === "off") { state.antiLeft = false; saveState(); api.sendMessage("🛑 Anti-Left OFF", threadID); }
      }

      // 🔹 Exit
      else if (cmd === "/exit") {
        try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch { }
      }

    });
  });
}

function stopBot() {
  console.log("🛑 Bot stopped.");
}

module.exports = { startBot, stopBot };
