import { useState } from "react";
import { Heart, Play, Square, FileUp, User } from "lucide-react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import axios from "axios";

export default function LoversPanel() {
  const [status, setStatus] = useState("🔴 Stopped");
  const [logs, setLogs] = useState([]);
  const [owner, setOwner] = useState("");
  const [file, setFile] = useState(null);

  const pushLog = (msg) => setLogs((prev) => [...prev, `💌 ${msg}`]);

  const handleStart = async () => {
    if (!file || !owner) {
      pushLog("❌ AppState aur Owner UID required!");
      setStatus("⚠️ Failed");
      return;
    }

    const formData = new FormData();
    formData.append("appstate", file);
    formData.append("owner", owner);

    try {
      const res = await axios.post("http://localhost:5000/start", formData);
      if (res.data.success) {
        setStatus("🟢 Running");
        pushLog(res.data.message);
      } else {
        setStatus("⚠️ Failed");
        pushLog(res.data.message);
      }
    } catch {
      pushLog("❌ Backend connection failed!");
    }
  };

  const handleStop = async () => {
    try {
      const res = await axios.post("http://localhost:5000/stop");
      if (res.data.success) {
        setStatus("🔴 Stopped");
        pushLog(res.data.message);
      }
    } catch {
      pushLog("❌ Failed to stop bot!");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-pink-300 via-red-200 to-rose-400">
      <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-3xl p-6">
        
        {/* Title */}
        <div className="text-center mb-6">
          <h1 className="text-4xl font-bold text-white drop-shadow-md flex items-center justify-center gap-2">
            <Heart className="text-red-600" fill="red" /> Lovers Bot Panel{" "}
            <Heart className="text-red-600" fill="red" />
          </h1>
          <p className="text-white/80 mt-2">Romantic Styled Bot Control Dashboard</p>
        </div>

        {/* Main Card */}
        <Card className="bg-white/20 backdrop-blur-xl rounded-2xl shadow-xl border border-white/40">
          <CardContent className="p-6 space-y-6">
            
            {/* Inputs */}
            <div className="grid grid-cols-1 gap-4">
              {/* Owner UID */}
              <div className="flex items-center gap-2 bg-white/30 p-3 rounded-xl">
                <User className="text-rose-700" />
                <input
                  type="text"
                  placeholder="Enter Owner UID"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  className="w-full bg-transparent outline-none text-rose-900 placeholder-rose-600"
                />
              </div>

              {/* File Upload */}
              <div className="flex items-center gap-2 bg-white/30 p-3 rounded-xl">
                <FileUp className="text-rose-700" />
                <input
                  type="file"
                  accept=".json"
                  onChange={(e) => setFile(e.target.files[0])}
                  className="w-full bg-transparent outline-none text-rose-900"
                />
              </div>
            </div>

            {/* Status + Buttons */}
            <div className="text-center">
              <h2 className="text-lg font-semibold text-rose-800">Bot Status</h2>
              <p className="text-2xl mt-2">{status}</p>
              <div className="flex gap-3 mt-4 justify-center">
                <Button onClick={handleStart} className="bg-rose-600 hover:bg-rose-700 rounded-full px-6 shadow-lg">
                  <Play className="mr-1 h-4 w-4" /> Start
                </Button>
                <Button onClick={handleStop} className="bg-gray-600 hover:bg-gray-700 rounded-full px-6 shadow-lg">
                  <Square className="mr-1 h-4 w-4" /> Stop
                </Button>
              </div>
            </div>

            {/* Logs */}
            <div className="bg-black/40 text-green-300 p-4 rounded-xl h-40 overflow-y-auto font-mono text-sm">
              {logs.length === 0 ? (
                <p className="text-white/50">💤 No logs yet...</p>
              ) : (
                logs.map((log, i) => <p key={i}>{log}</p>)
              )}
            </div>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="text-center mt-6 text-white/80 text-sm">Made with ❤️ Lovers Theme</div>
      </motion.div>
    </div>
  );
}
