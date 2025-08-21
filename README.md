# ioBroker.gira-endpoint

Minimaler Gira-Endpoint-Adapter (WS/WSS-Client). Reconnect mit Backoff, Events → States, kein MaxListeners-Warnspam.

## Installation (lokal)

```bash
cd iobroker.gira-endpoint
npm install
npm run build
# Variante A: lokale Quelle hinzufügen
iobroker add ./
# oder, falls bereits als Adaptername erkannt:
# iobroker upload gira-endpoint && iobroker add gira-endpoint
```

Danach Instanz in Admin öffnen und Verbindung einstellen (Host/Port/Path/TLS/Benutzer).

## Mapping anpassen

Die Payload-Struktur deines Gira-Endpoints in `src/lib/GiraClient.ts` (Parsing) und `src/main.ts` (Mapping) anpassen.

## Hinweise

- Node >= 18 (empfohlen 20/22)
- Bei TLS ggf. Zertifikate/Truststore je nach Umgebung ergänzen.
