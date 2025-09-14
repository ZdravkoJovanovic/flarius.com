import { NextApiRequest, NextApiResponse } from "next";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";

// Socket.IO Server initialisieren
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(res.socket as any).server.io) {
    console.log("✅ Initialisiere Socket.IO Server...");
    
    const io = new Server((res.socket as any).server, {
      path: "/api/socket",
    });

    io.on("connection", (socket) => {
      console.log("🔌 Client verbunden:", socket.id);
      console.log("🌐 Client-Herkunft:", socket.handshake.headers.origin || "Unbekannt");
      console.log("📧 Client-Headers:", JSON.stringify(socket.handshake.headers));
      
      // Sende Bestätigung an Python-Client
      socket.emit("server:connected", { 
        message: "Verbunden mit Next.js Server",
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });

      socket.on("client:audio", (data) => {
        console.log("🎵 Audio-Daten empfangen von:", socket.id);
        console.log("📝 MIME-Type:", data.mimeType);
        
        try {
          const audioDir = path.join(process.cwd(), 'audio-chunks');
          if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
            console.log("📁 Audio-Chunks Ordner erstellt:", audioDir);
          }
          
          const audioBuffer = Buffer.from(data.audioData);
          const filePath = path.join(audioDir, data.fileName);
          
          fs.writeFileSync(filePath, audioBuffer);
          
          console.log(`💾 Audiodatei gespeichert: ${filePath}`);
          socket.emit("server:ack", { 
            status: 200, 
            message: "Audio empfangen und gespeichert",
            filePath: filePath
          });
        } catch (err) {
          console.error("❌ Fehler beim Speichern der Audiodatei:", err);
          socket.emit("server:ack", { status: 500, message: "Fehler beim Speichern" });
        }
      });

      socket.on("python:message", (data) => {
        console.log("📨 Nachricht von Python:", data);
        socket.emit("server:response", { 
          message: "Nachricht erhalten",
          receivedAt: new Date().toISOString()
        });
      });

      socket.on("disconnect", (reason) => {
        console.log("🔌 Client getrennt:", socket.id, "Grund:", reason);
      });
    });

    (res.socket as any).server.io = io;
    console.log("✅ Socket.IO Server bereit auf Port 3000, Pfad: /api/socket");
  }

  res.end();
}

export const config = {
  api: {
    bodyParser: false,
  },
};