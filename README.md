# ioBroker.gira-endpoint

Minimaler Gira-Endpoint-Adapter (WS/WSS-Client). Reconnect mit Backoff, Events → States, kein MaxListeners-Warnspam.

Basis:
https://github.com/luckyy0815/node-red-contrib-gira-endpoint

## Installation (lokal)

```bash
Variante A (empfohlen): per Tarball installieren *geht*
# im Projektordner
cd ~/iobroker.gira-endpoint
git pull --ff-only
npm run build
npm pack                   # erzeugt z.B. iobroker.gira-endpoint-0.0.1.tgz

# ins ioBroker-Verzeichnis und dort installieren (als iobroker-User)
cd /opt/iobroker
sudo -u iobroker -H npm i --omit=dev ~/iobroker.gira-endpoint/iobroker.gira-endpoint-0.0.1.tgz

# Dateien hochladen & Instanz anlegen
iobroker upload gira-endpoint
## optional hinzufügen
#iobroker add gira-endpoint


Variante B: per npm link (für Dev bequem)
# im Projektordner
cd ~/iobroker.gira-endpoint
npm link

# ins ioBroker-Verzeichnis und verlinken
cd /opt/iobroker
sudo -u iobroker -H npm link iobroker.gira-endpoint

iobroker upload gira-endpoint
iobroker add gira-endpoint

Alternative: dev-server (ohne Installation testen)
npm i -g @iobroker/dev-server
cd ~/iobroker.gira-endpoint
dev-server setup
dev-server watch

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
MIT License
