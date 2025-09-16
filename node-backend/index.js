// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5000;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  // groß genug für kurze Aufnahmen
  maxHttpBufferSize: 1e8, // ~100 MB
});

const AUDIO_DIR = path.resolve(__dirname, "audio-chunks");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

let connected = 0;

io.on("connection", (socket) => {
  connected += 1;
  console.log(`[conn] ${socket.id} — total: ${connected}`);

  socket.on("client:audio", async (payload = {}) => {
    try {
      const { audioData, fileName, mimeType } = payload;

      if (!Array.isArray(audioData) || audioData.length === 0) {
        throw new Error("no audio data");
      }

      // Dateiname säubern / fallback
      const safeName =
        typeof fileName === "string" && fileName.trim()
          ? fileName.trim().replace(/[^\w.\-]/g, "_")
          : `recording_${Date.now()}.webm`;

      const buf = Buffer.from(Uint8Array.from(audioData));
      const savePath = path.join(AUDIO_DIR, safeName);

      await fs.promises.writeFile(savePath, buf);

      console.log(`[SAVE OK] ${safeName} (${buf.length} bytes)`);
      socket.emit("server:save_ack", {
        ok: true,
        fileName: safeName,
        bytes: buf.length,
        mimeType: mimeType || null,
      });
    } catch (err) {
      console.error(`[SAVE FAIL] ${err?.message || err}`);
      socket.emit("server:save_ack", { ok: false, error: String(err?.message || err) });
    }
  });

  socket.on("disconnect", () => {
    connected -= 1;
    console.log(`[disc] ${socket.id} — total: ${connected}`);
  });
});

server.listen(PORT, "localhost", () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
});
