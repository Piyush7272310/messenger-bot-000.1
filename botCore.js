const fs = require("fs");
const path = require("path");
const login = require("ws3-fca");

const appStatePath = path.join(__dirname, "appstate.json");
if (!fs.existsSync(appStatePath)) {
  console.error("❌ appstate.json missing!");
  process.exit(1);
}

login({ appState: JSON.parse(fs.readFileSync(appStatePath, "utf8")) }, (err, api) => {
  if (err) return console.error("❌ Login failed:", err);
  api.setOptions({ listenEvents: true });
  require("./botCore")(api);
});
