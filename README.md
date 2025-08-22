# ioBroker Gira-Endpoint Adapter

Der Gira-Endpoint-Adapter ermöglicht die Anbindung eines Gira Homeservers an ioBroker über WebSocket (WS/WSS).
Er verbindet sich direkt mit dem Homeserver und erlaubt so den Austausch von Datenpunkten in Echtzeit.

Damit können Werte wie Schaltzustände, Sensoren oder Szenen aus dem Gira-System nahtlos in ioBroker integriert und weiterverarbeitet werden.

Funktionen

Verbindung per WebSocket oder WebSocket Secure (WSS)

Empfang und Senden von Datenpunkten zwischen Gira Homeserver und ioBroker

Echtzeitkommunikation für schnelle Reaktionen und Automatisierungen

Einfache Integration in bestehende Smart-Home-Szenarien

Grundlage

Der Adapter wurde inspiriert und umgesetzt auf Basis von
👉 node-red-contrib-gira-endpoint

## Installation (lokal)

```bash
Variante A (empfohlen): per Tarball installieren 
# im Projektordner
cd ~/iobroker.gira-endpoint
git pull --ff-only
npm run build
npm pack                   # erzeugt z.B. iobroker.gira-endpoint-0.0.1.tgz

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
