from flask import Flask, request, jsonify
import ffmpeg
from datetime import datetime
import os

app = Flask(__name__)

# Pfad zur Original-Audio-Datei
ORIGINAL_AUDIO_FILE = "./PAF.mp3"
print(f"Original audio exists: {os.path.exists(ORIGINAL_AUDIO_FILE)}")

# Zielordner für die geschnittenen Dateien
OUTPUT_DIR = "./VAF"
os.makedirs(OUTPUT_DIR, exist_ok=True)

@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.json
    print("========== Diarization result received ==========")
    print(data)

    diarization = data.get('output', {}).get('diarization', [])
    if not diarization:
        print("No diarization data found in webhook payload.")
        return jsonify({"status": "no diarization data"}), 400

    # Sprecher-Daten gruppieren
    speakers = {}
    for segment in diarization:
        spk = segment['speaker']
        start = segment['start']
        end = segment['end']
        print(f"Segment detected: {spk}, {start:.3f}s – {end:.3f}s")
        if spk not in speakers:
            speakers[spk] = []
        speakers[spk].append((start, end))

    # Für jeden Sprecher Audio schneiden und exportieren
    for spk, intervals in speakers.items():
        print(f"\nProcessing speaker {spk} with {len(intervals)} intervals.")
        timestamp = datetime.now().strftime("%Y_%m_%d_%H_%M_%S")
        output_file = os.path.join(OUTPUT_DIR, f"{spk}_{timestamp}.mp3")

        # ffmpeg concat für mehrere Intervalle
        temp_files = []
        for i, (start, end) in enumerate(intervals):
            temp_file = os.path.join(OUTPUT_DIR, f"{spk}_temp_{i}.mp3")
            try:
                (
                    ffmpeg
                    .input(ORIGINAL_AUDIO_FILE, ss=start, to=end)
                    .output(temp_file, format='mp3', acodec='mp3')
                    .overwrite_output()
                    .run(quiet=True)
                )
                print(f"  - Segment {i}: {start:.3f}s – {end:.3f}s saved to {temp_file}")
                temp_files.append(temp_file)
            except Exception as e:
                print(f"Error exporting segment {i} for {spk}: {e}")

        # Alle Segmente zusammenführen
        if temp_files:
            try:
                input_streams = [ffmpeg.input(f) for f in temp_files]
                ffmpeg.concat(*input_streams, v=0, a=1).output(output_file).overwrite_output().run(quiet=True)
                print(f"Saved merged speaker audio: {output_file}")
            except Exception as e:
                print(f"Error merging segments for {spk}: {e}")

            # Temp-Dateien löschen
            for f in temp_files:
                try:
                    os.remove(f)
                except:
                    pass
        else:
            print(f"No audio segments found for {spk}, skipping export.")

    print("========== Webhook processing finished ==========\n")
    return jsonify({"status": "received"}), 200

if __name__ == "__main__":
    print(f"Starting Flask server on port 4000...")
    app.run(host="0.0.0.0", port=4000)
