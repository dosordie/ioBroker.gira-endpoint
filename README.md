# ioBroker Gira-Endpoint Adapter
## Gira Endpoint Adapter

Der **Gira-Endpoint-Adapter** verbindet ioBroker über **WebSocket (WS/WSS)** mit einem **Gira Homeserver**.  
Damit können Datenpunkte in Echtzeit zwischen dem Homeserver und ioBroker ausgetauscht werden.  

So lassen sich Schaltzustände, Sensorwerte oder Szenen aus dem Gira-System nahtlos in ioBroker integrieren und dort weiterverarbeiten.

### Features
- Verbindung über WebSocket (WS/WSS)  
- Senden und Empfangen von Datenpunkten  
- Echtzeitkommunikation für schnelle Automatisierungen  
- Einfache Integration in bestehende Smart-Home-Szenarien  

### Usage
Eingabewerte können sein:  true | false | toggle | String | Number

- `true` / `false` → werden zu `1` / `0` im HomeServer umgewandelt  
- `toggle` → schaltet den aktuellen Wert im HomeServer um  
- `String` und `Number` → werden direkt durchgereicht  

### Grundlage
Der Adapter wurde nachgebaut auf Basis von:  
👉 [node-red-contrib-gira-endpoint](https://github.com/luckyy0815/node-red-contrib-gira-endpoint)

---

## Lizenz
[GPLv3](LICENSE)

## Installation (lokal)

```bash
Variante A (empfohlen): per Tarball installieren 
# im Projektordner
cd ~/iobroker.gira-endpoint
git pull --ff-only
npm run build
npm pack                   # erzeugt z.B. iobroker.gira-endpoint-0.1.0.tgz

# ins ioBroker-Verzeichnis und dort installieren (als iobroker-User)
cd /opt/iobroker
sudo -u iobroker -H npm i --omit=dev ~/iobroker.gira-endpoint/iobroker.gira-endpoint-0.1.0.tgz

# Dateien hochladen & Instanz anlegen
iobroker upload gira-endpoint
## optional hinzufügen
#iobroker add gira-endpoint

```

Danach Instanz in Admin öffnen und Verbindung einstellen (Host/Port/Path/TLS/Benutzer).

## Mapping anpassen

Die Payload-Struktur deines Gira-Endpoints in `src/lib/GiraClient.ts` (Parsing) und `src/main.ts` (Mapping) anpassen.

## Hinweise

- Node >= 18 (empfohlen 20/22)
- Bei TLS ggf. Zertifikate/Truststore je nach Umgebung ergänzen.

## Changelog

### 0.1.0
* Adapter basically working and tested

### 0.0.1
* Initial version (WS client, reconnect, basic event mapping)

## License
GNU General Public License v3.0
