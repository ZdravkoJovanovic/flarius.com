"use client";

import { useEffect, useState, useRef } from "react";
import { io, Socket } from "socket.io-client";

export default function Home() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState(400);
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    const socketIo: Socket = io({
      path: "/api/socket",
    });

    socketIo.on("connect", () => {
      console.log("Verbunden mit Server");
      setStatus(200);
    });
    
    socketIo.on("connect_error", (err) => {
      console.error("Verbindungsfehler:", err);
      setStatus(400);
    });
    
    socketIo.on("server:ack", (data) => {
      console.log("Bestätigung vom Server:", data);
      setStatus(data.status);
    });

    setSocket(socketIo);

    return () => {
      socketIo.disconnect();
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 44100,
          sampleSize: 16,
        }
      });
      
      // Prüfen, welche Formate der Browser unterstützt
      const supportedTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/mpeg'
      ];
      
      let selectedType = '';
      for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          selectedType = type;
          break;
        }
      }
      
      // Wenn kein spezifisches Format unterstützt wird, lasse den Browser das Standardformat wählen
      const options = selectedType ? { mimeType: selectedType } : undefined;
      
      console.log(`Verwende Audioformat: ${selectedType || 'default'}`);
      
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start(1000);
      setRecording(true);
      
    } catch (err) {
      console.error("Mikrofon-Zugriff fehlgeschlagen:", err);
    }
  };

  const stopRecording = async () => {
    if (mediaRecorderRef.current && recording) {
      // Warte auf das 'stop' Event, um alle Daten zu sammeln
      mediaRecorderRef.current.onstop = async () => {
        // Verwende den tatsächlichen MIME-Type des aufgezeichneten Inhalts
        const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        
        // Bestimme die Dateiendung basierend auf dem MIME-Type
        let extension = '.webm';
        if (mimeType.includes('mp4')) extension = '.mp4';
        if (mimeType.includes('mpeg')) extension = '.mp3';
        
        // Konvertiere Blob zu ArrayBuffer für die Übertragung
        const arrayBuffer = await audioBlob.arrayBuffer();
        
        // Sende die Daten an den Server
        if (socket) {
          socket.emit("client:audio", { 
            audioData: Array.from(new Uint8Array(arrayBuffer)),
            fileName: `recording_${Date.now()}${extension}`,
            mimeType: mimeType
          });
          console.log("Audio-Daten an Server gesendet");
        } else {
          console.error("Socket ist nicht verbunden");
        }
        
        // Stoppe alle Audio-Tracks
        mediaRecorderRef.current!.stream.getTracks().forEach(track => track.stop());
      };
      
      mediaRecorderRef.current.stop();
      setRecording(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 bg-gray-900">
      <div className={`text-lg font-mono ${status === 200 ? 'text-green-400' : 'text-red-400'}`}>
        Status: {status === 200 ? 'Verbunden' : 'Nicht verbunden'}
      </div>
      <button
        className="px-6 py-3 font-semibold rounded-md border border-black bg-white text-black transition-colors hover:bg-gray-100"
        onClick={recording ? stopRecording : startRecording}
      >
        {recording ? "Aufnahme beenden" : "Aufnahme starten"}
      </button>
      {recording && (
        <div className="text-white mt-4 flex items-center">
          <span className="relative flex h-3 w-3 mr-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
          </span>
          Aufnahme läuft...
        </div>
      )}
    </div>
  );
}