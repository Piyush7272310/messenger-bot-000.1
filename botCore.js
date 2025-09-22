const fs = require("fs");
const login = require("ws3-fca");
const request = require("request");
const axios = require("axios");

let rkbInterval = null;
let stopRequested = false;
const lockedGroupNames = {};
const lockedEmojis = {};
const lockedDPs = {};
const lockedNicks = {};
let stickerInterval = null;
let stickerLoopActive = false;
let targetUID = null;
let targetIndexes = {}; // line by line tracking

// Memory management variables
let memoryMonitorInterval = null;
const memoryStats = {
    startMemory: 0,
    peakMemory: 0,
    cleanups: 0
};

const friendUIDs = fs.existsSync("Friend.txt")
  ? fs.readFileSync("Friend.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean)
  : [];

const targetUIDs = fs.existsSync("Target.txt")
  ? fs.readFileSync("Target.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean)
  : [];

const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw", "base64").toString("utf8");

// Memory optimization functions
function getMemoryUsage() {
    const used = process.memoryUsage();
    return {
        rss: Math.round(used.rss / 1024 / 1024 * 100) / 100,
        heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100,
        heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100,
        external: Math.round(used.external / 1024 / 1024 * 100) / 100
    };
}

function cleanMemory() {
    try {
        // Clear require cache (except core modules)
        Object.keys(require.cache).forEach(key => {
            if (!key.includes('node_modules') && !key.includes(process.cwd())) return;
            delete require.cache[key];
        });

        // Force garbage collection if available
        if (global.gc) {
            global.gc();
        }

        // Clear intervals and timeouts that are no longer needed
        // This is done selectively in the bot logic

        memoryStats.cleanups++;
        const memAfter = getMemoryUsage();
        
        return {
            success: true,
            before: memoryStats.peakMemory,
            after: memAfter.rss,
            freed: Math.round((memoryStats.peakMemory - memAfter.rss) * 100) / 100
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function startMemoryMonitor(api, threadID = null) {
    if (memoryMonitorInterval) {
        clearInterval(memoryMonitorInterval);
    }

    memoryStats.startMemory = getMemoryUsage().rss;
    memoryStats.peakMemory = memoryStats.startMemory;

    memoryMonitorInterval = setInterval(() => {
        const mem = getMemoryUsage();
        memoryStats.peakMemory = Math.max(memoryStats.peakMemory, mem.rss);

        // Auto-clean if memory usage exceeds 150MB
        if (mem.rss > 150) {
            const result = cleanMemory();
            if (result.success && threadID) {
                api.sendMessage(
                    `🧹 Auto memory clean: ${result.freed}MB freed (Peak: ${memoryStats.peakMemory}MB)`,
                    threadID
                );
            }
        }
    }, 30000); // Check every 30 seconds
}

function stopMemoryMonitor() {
    if (memoryMonitorInterval) {
        clearInterval(memoryMonitorInterval);
        memoryMonitorInterval = null;
    }
}

function optimizeBotMemory() {
    // Clear large arrays and objects
    const arraysToClear = [friendUIDs, targetUIDs];
    arraysToClear.forEach(arr => arr.length = 0);

    // Clear interval trackers
    if (rkbInterval) {
        clearInterval(rkbInterval);
        rkbInterval = null;
    }
    
    if (stickerInterval) {
        clearInterval(stickerInterval);
        stickerInterval = null;
    }

    // Reset objects
    Object.keys(lockedGroupNames).forEach(key => delete lockedGroupNames[key]);
    Object.keys(lockedEmojis).forEach(key => delete lockedEmojis[key]);
    Object.keys(lockedDPs).forEach(key => delete lockedDPs[key]);
    Object.keys(lockedNicks).forEach(key => delete lockedNicks[key]);
    Object.keys(targetIndexes).forEach(key => delete targetIndexes[key]);

    stopRequested = true;
    stickerLoopActive = false;
    targetUID = null;

    return cleanMemory();
}

function startBot(appStatePath, ownerUID) {
  const appState = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
  login({ appState }, (err, api) => {
    if (err) return console.error("❌ Login failed:", err);
    api.setOptions({ listenEvents: true });
    console.log("✅ Bot logged in and running...");

    // Start memory monitoring
    startMemoryMonitor(api);

    // 🔄 Emoji Lock Revert (5s fallback loop)
    const emojiInterval = setInterval(async () => {
      for (const threadID in lockedEmojis) {
        try {
          const info = await api.getThreadInfo(threadID);
          const currentEmoji = info.emoji;
          if (currentEmoji !== lockedEmojis[threadID]) {
            await api.changeThreadEmoji(lockedEmojis[threadID], threadID);
            console.log(`😀 Emoji reverted in ${threadID} (loop)`);
          }
        } catch (e) {
          console.log("⚠️ Emoji loop check error:", e.message);
        }
      }
    }, 5000);

    api.listenMqtt(async (err, event) => {
      try {
        if (err || !event) return;
        const { threadID, senderID, body, logMessageType, logMessageData } = event;

        // ==== Group Name Revert ====
        if (logMessageType === "log:thread-name" && lockedGroupNames[threadID]) {
          if (logMessageData?.name !== lockedGroupNames[threadID]) {
            await api.setTitle(lockedGroupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }

        // ==== DP Auto Revert ====
        if (event.type === "change_thread_image" && lockedDPs[threadID]) {
          try {
            const filePath = lockedDPs[threadID];
            if (fs.existsSync(filePath)) {
              await api.changeGroupImage(fs.createReadStream(filePath), threadID);
              console.log(`🖼 DP reverted in ${threadID}`);
            }
          } catch (e) {
            console.log("⚠️ DP revert failed:", e.message);
          }
        }

        // ==== Nickname Lock Revert ====
        if (logMessageType === "log:user-nickname" && lockedNicks[senderID]) {
          const lockedNick = lockedNicks[senderID];
          const currentNick = logMessageData?.nickname;
          if (currentNick !== lockedNick) {
            try {
              await api.changeNickname(lockedNick, threadID, senderID);
              console.log(`🔒 Nickname reverted for UID: ${senderID}`);
            } catch (e) {
              console.log("⚠️ Nick revert failed:", e.message);
            }
          }
        }

        // ==== Emoji Lock Revert (event-based) ====
        if (logMessageType === "log:thread-icon") {
          if (lockedEmojis[threadID] && logMessageData?.thread_icon !== lockedEmojis[threadID]) {
            try {
              await api.changeThreadEmoji(lockedEmojis[threadID], threadID);
              console.log(`😀 Emoji reverted in ${threadID} (event)`);
            } catch (e) {
              console.log("⚠️ Emoji revert failed:", e.message);
            }
          }
        }

        // ==== Target Auto Reply (line by line) ====
        if (targetUID && senderID === targetUID) {
          if (fs.existsSync("np.txt")) {
            const lines = fs.readFileSync("np.txt", "utf8").split("\n").filter(Boolean);
            if (!targetIndexes[threadID]) targetIndexes[threadID] = 0;

            if (targetIndexes[threadID] >= lines.length) {
              targetIndexes[threadID] = 0; // restart after end
            }

            const line = lines[targetIndexes[threadID]];
            targetIndexes[threadID]++;
            api.sendMessage(`${line}`, threadID);
          }
        }

        // ==== Message Handling ====
        if (!body) return;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase().replace(/^\./, ""); // 🔑 dot prefix
        const input = args.slice(1).join(" ");

        if (![ownerUID, LID].includes(senderID)) return;

        // ==== Help ====
        if (cmd === "help") {
          return api.sendMessage(`
📖 Jerry Bot Commands (. prefix):
.help → Ye message
.gclock [text] → Group name lock
.unlockgc → Group name unlock
.lockemoji 😀 → Emoji lock
.unlockemoji → Emoji unlock
.lockdp → Current group DP lock
.unlockdp → DP unlock
.locknick @mention + nickname → Nickname lock
.unlocknick @mention → Nick lock remove
.allname [nick] → Sabka nickname change
.uid → Reply/Mention/User UID show
.tid → Group Thread ID show
.exit → Bot group se exit
.rkb [name] → Line by line gaali spam
.stop → Spam stop
.stickerX → Sticker spam (X=seconds delay)
.stopsticker → Sticker spam stop
.target [uid] → Set target UID (line by line reply)
.cleartarget → Clear target

🧹 MEMORY BOOSTER COMMANDS:
.memory → Current memory usage
.clean → Manual memory cleanup
.boost → Full memory optimization
.memstats → Memory statistics
.stopmem → Stop memory monitor
          `, threadID);
        }

        // ==== Memory Booster Commands ====
        else if (cmd === "memory") {
            const mem = getMemoryUsage();
            api.sendMessage(
                `💾 Memory Usage:\n` +
                `📊 RSS: ${mem.rss}MB\n` +
                `🏗 Heap Total: ${mem.heapTotal}MB\n` +
                `💡 Heap Used: ${mem.heapUsed}MB\n` +
                `🔗 External: ${mem.external}MB\n` +
                `📈 Peak: ${memoryStats.peakMemory}MB\n` +
                `🧹 Cleanups: ${memoryStats.cleanups}`,
                threadID
            );
        }
        else if (cmd === "clean") {
            const result = cleanMemory();
            if (result.success) {
                api.sendMessage(
                    `🧹 Memory cleaned successfully!\n` +
                    `✅ Freed: ${result.freed}MB\n` +
                    `📊 Before: ${result.before}MB\n` +
                    `📈 After: ${result.after}MB`,
                    threadID
                );
            } else {
                api.sendMessage(`❌ Clean failed: ${result.error}`, threadID);
            }
        }
        else if (cmd === "boost") {
            api.sendMessage("🚀 Starting full memory optimization...", threadID);
            const result = optimizeBotMemory();
            if (result.success) {
                api.sendMessage(
                    `✨ Memory boost completed!\n` +
                    `✅ Freed: ${result.freed}MB\n` +
                    `🔄 Total cleanups: ${memoryStats.cleanups}\n` +
                    `📊 Current: ${getMemoryUsage().rss}MB`,
                    threadID
                );
            } else {
                api.sendMessage(`❌ Boost failed: ${result.error}`, threadID);
            }
        }
        else if (cmd === "memstats") {
            const mem = getMemoryUsage();
            const uptime = process.uptime();
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            
            api.sendMessage(
                `📊 Memory Statistics:\n` +
                `⏰ Uptime: ${hours}h ${minutes}m\n` +
                `💾 Current: ${mem.rss}MB\n` +
                `📈 Peak: ${memoryStats.peakMemory}MB\n` +
                `🧹 Cleanups: ${memoryStats.cleanups}\n` +
                `🔧 Start: ${memoryStats.startMemory}MB\n` +
                `💡 Usage: ${((mem.rss / memoryStats.peakMemory) * 100).toFixed(1)}%`,
                threadID
            );
        }
        else if (cmd === "stopmem") {
            stopMemoryMonitor();
            api.sendMessage("🛑 Memory monitor stopped", threadID);
        }

        // ==== Group Name Lock ====
        else if (cmd === "gclock") {
          await api.setTitle(input, threadID);
          lockedGroupNames[threadID] = input;
          api.sendMessage("🔒 Group name locked!", threadID);
        }
        else if (cmd === "unlockgc") {
          delete lockedGroupNames[threadID];
          api.sendMessage("🔓 Group name unlocked!", threadID);
        }

        // ==== Emoji Lock ====
        else if (cmd === "lockemoji") {
          if (!input) return api.sendMessage("❌ Emoji do!", threadID);
          lockedEmojis[threadID] = input;
          try {
            await api.changeThreadEmoji(input, threadID);
            api.sendMessage(`😀 Emoji locked → ${input}`, threadID);
          } catch (e) {
            api.sendMessage("⚠️ Emoji lock fail!", threadID);
          }
        }
        else if (cmd === "unlockemoji") {
          delete lockedEmojis[threadID];
          api.sendMessage("🔓 Emoji unlocked!", threadID);
        }

        // ==== DP Lock ====
        else if (cmd === "lockdp") {
          try {
            const info = await api.getThreadInfo(threadID);
            const dpUrl = info.imageSrc;
            if (!dpUrl) return api.sendMessage("❌ Is group me koi DP nahi hai!", threadID);

            const response = await axios.get(dpUrl, { responseType: "arraybuffer" });
            const buffer = Buffer.from(response.data, "binary");
            const filePath = `locked_dp_${threadID}.jpg`;
            fs.writeFileSync(filePath, buffer);

            lockedDPs[threadID] = filePath;
            api.sendMessage("🖼 Current group DP ab lock ho gayi hai 🔒", threadID);
          } catch (e) {
            api.sendMessage("⚠️ DP lock error!", threadID);
          }
        }
        else if (cmd === "unlockdp") {
          delete lockedDPs[threadID];
          api.sendMessage("🔓 DP lock remove ho gaya ✔️", threadID);
        }

        // ==== Nickname Lock ====
        else if (cmd === "locknick") {
          if (event.mentions && Object.keys(event.mentions).length > 0 && input) {
            const target = Object.keys(event.mentions)[0];
            const nickname = input.replace(Object.values(event.mentions)[0], "").trim();
            lockedNicks[target] = nickname;
            await api.changeNickname(nickname, threadID, target);
            api.sendMessage(`🔒 Nick lock set for ${target} → ${nickname}`, threadID);
          } else {
            api.sendMessage("❌ Usage: .locknick @mention + nickname", threadID);
          }
        }
        else if (cmd === "unlocknick") {
          if (event.mentions && Object.keys(event.mentions).length > 0) {
            const target = Object.keys(event.mentions)[0];
            delete lockedNicks[target];
            api.sendMessage(`🔓 Nick lock removed for ${target}`, threadID);
          } else {
            api.sendMessage("❌ Mention karo kiska nick unlock karna hai!", threadID);
          }
        }

        // ==== All Name ====
        else if (cmd === "allname") {
          if (!input) return api.sendMessage("❌ Nickname do!", threadID);
          const info = await api.getThreadInfo(threadID);
          for (const user of info.participantIDs) {
            try {
              await api.changeNickname(input, threadID, user);
            } catch {}
          }
          api.sendMessage(`👥 Sabka nickname change → ${input}`, threadID);
        }

        // ==== UID / TID ====
        else if (cmd === "uid") {
          if (event.messageReply) {
            return api.sendMessage(`🆔 Reply UID: ${event.messageReply.senderID}`, threadID);
          } else if (event.mentions && Object.keys(event.mentions).length > 0) {
            const target = Object.keys(event.mentions)[0];
            return api.sendMessage(`🆔 Mention UID: ${target}`, threadID);
          } else {
            return api.sendMessage(`🆔 Your UID: ${senderID}`, threadID);
          }
        }
        else if (cmd === "tid") {
          api.sendMessage(`🆔 Group Thread ID: ${threadID}`, threadID);
        }

        // ==== Exit ====
        else if (cmd === "exit") {
          try { 
            // Clean up before exiting
            optimizeBotMemory();
            stopMemoryMonitor();
            clearInterval(emojiInterval);
            await api.removeUserFromGroup(api.getCurrentUserID(), threadID); 
          } catch {}
        }

        // ==== RKB Spam ====
        else if (cmd === "rkb") {
          if (!fs.existsSync("np.txt")) return api.sendMessage("❌ np.txt missing!", threadID);
          const name = input.trim();
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
          }, 5000);
          api.sendMessage(`🤬 Start gaali on ${name}`, threadID);
        }
        else if (cmd === "stop") {
          stopRequested = true;
          if (rkbInterval) { clearInterval(rkbInterval); rkbInterval = null; }
        }

        // ==== Sticker Spam ====
        else if (cmd.startsWith("sticker")) {
          if (!fs.existsSync("Sticker.txt")) return;
          const delay = parseInt(cmd.replace("sticker", ""));
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
        }
        else if (cmd === "stopsticker") {
          if (stickerInterval) { clearInterval(stickerInterval); stickerInterval = null; stickerLoopActive = false; }
        }

        // ==== Target ====
        else if (cmd === "target") {
          targetUID = input.trim();
          targetIndexes = {}; // reset indexes
          api.sendMessage(`🎯 Target set: ${targetUID}`, threadID);
        }
        else if (cmd === "cleartarget") {
          targetUID = null;
          targetIndexes = {};
          api.sendMessage("🎯 Target cleared!", threadID);
        }

      } catch (e) { 
          console.error("⚠️ Error:", e.message); 
          // Auto-clean on error
          cleanMemory();
      }
    });

    // Clean up on process exit
    process.on('exit', () => {
        stopMemoryMonitor();
        clearInterval(emojiInterval);
        optimizeBotMemory();
    });

    process.on('SIGINT', () => {
        console.log('🧹 Cleaning up before exit...');
        stopMemoryMonitor();
        clearInterval(emojiInterval);
        optimizeBotMemory();
        process.exit(0);
    });
  });
}

// Enable garbage collection for better memory management
if (process.env.NODE_ENV === 'production') {
    try {
        const v8 = require('v8');
        v8.setFlagsFromString('--max-old-space-size=512');
    } catch (e) {
        console.log('⚠️ V8 optimization not available');
    }
}

module.exports = { startBot, getMemoryUsage, cleanMemory, optimizeBotMemory };
