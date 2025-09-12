import os
from dotenv import load_dotenv
import requests

# .env laden
load_dotenv()

API_KEY = os.getenv("PYNOTE_API_KEY")

url = "https://api.pyannote.ai/v1/diarize"
file_url = "https://drive.google.com/uc?export=download&id=1M14A0srvzOtuViJbe1R7NI9Drxj6Jtpl"
webhook_url = 'https://a53e2784398a.ngrok.app/webhook'

headers = {
   "Authorization": f"Bearer {API_KEY}"
}
data = {
    'webhook': webhook_url,
    'url': file_url
}
response = requests.post(url, headers=headers, json=data)

print(response.status_code)
# 200

print(response.json()) 

# VAF = verarbeitete Audio File