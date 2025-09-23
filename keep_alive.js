// Simple keep-alive script
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is alive!');
});
server.listen(3000);
