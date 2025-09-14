import socketio
import time

# Socket.IO Python Client erstellen
sio = socketio.Client()

@sio.event
def connect():
    print('✅ Verbunden mit Next.js Server')
    print(f'📧 Meine Session ID: {sio.sid}')
    
    # Testnachricht senden
    sio.emit('python:message', {
        'message': 'Hallo von Python!',
        'port': 5002,
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S')
    })

@sio.event
def disconnect():
    print('❌ Verbindung zum Next.js Server getrennt')

@sio.event
def server_connected(data):
    print(f'📨 Bestätigung vom Server: {data}')

@sio.event
def server_response(data):
    print(f'📨 Antwort vom Server: {data}')

if __name__ == '__main__':
    try:
        print('🚀 Verbinde mit Next.js Server...')
        sio.connect('http://localhost:3000', 
                   socketio_path='/api/socket',
                   headers={'User-Agent': 'Python-SocketIO-Client', 'X-Custom-Header': 'Python-App'})
        
        # Verbindung aufrechterhalten
        print('⏳ Verbindung läuft. Drücke Ctrl+C zum Beenden.')
        while True:
            time.sleep(1)
            
    except socketio.exceptions.ConnectionError as e:
        print(f'❌ Verbindungsfehler: {e}')
    except KeyboardInterrupt:
        print('\n🛑 Beende Verbindung...')
        sio.disconnect()
    except Exception as e:
        print(f'❌ Fehler: {e}')