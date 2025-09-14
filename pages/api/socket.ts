import { NextApiRequest, NextApiResponse } from "next";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";

// Socket.IO Server initialisieren
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(res.socket as any).server.io) {
    console.log("Initialisiere Socket.IO Server...");
    
    const io = new Server((res.socket as any).server, {
      path: "/api/socket",
    });

    io.on("connection", (socket) => {
      console.log("Client verbunden:", socket.id);
      
      socket.on("client:audio", (data) => {
        console.log("Audio-Daten empfangen, speichere Datei...");
        console.log("MIME-Type:", data.mimeType);
        
        try {
          // Erstelle den audio-chunks Ordner, falls nicht vorhanden
          const audioDir = path.join(process.cwd(), 'audio-chunks');
          if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
            console.log("Audio-Chunks Ordner erstellt:", audioDir);
          }
          
          // Konvertiere Daten zurück zu Buffer
          const audioBuffer = Buffer.from(data.audioData);
          const filePath = path.join(audioDir, data.fileName);
          
          // Speichere die Audiodatei
          fs.writeFileSync(filePath, audioBuffer);
          
          console.log(`Audiodatei gespeichert: ${filePath}`);
          socket.emit("server:ack", { 
            status: 200, 
            message: "Audio empfangen und gespeichert",
            filePath: filePath
          });
        } catch (err) {
          console.error("Fehler beim Speichern der Audiodatei:", err);
          socket.emit("server:ack", { status: 500, message: "Fehler beim Speichern" });
        }
      });

      socket.on("disconnect", () => {
        console.log("Client getrennt:", socket.id);
      });
    });

    (res.socket as any).server.io = io;
  }

  res.end();
}

export const config = {
  api: {
    bodyParser: false,
  },
};