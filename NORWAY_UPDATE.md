# Astro Weather · Norge — oppdatering

Dette er en oppgradering av den tidligere Vestfold-versjonen.

## Hva som er nytt

- Astro Weather-laget heter nå **Astro Weather · Norge**.
- Prognosefeltene dekker Fastlands-Norge fra Sørlandet til Finnmark.
- Svalbard og Jan Mayen er også inkludert i det landsdekkende planleggingslaget.
- Ringshaug og observatoriet beholdes som faste hovedpunkter.
- Tidslinjen er fortsatt 0–48 timer, time for time.
- Open-Meteo-forespørsler deles i mindre grupper for å holde URL-er og belastning på et fornuftig nivå.
- Fargeskala, transparens og Astro-score fungerer på samme måte som før.

## Installere over eksisterende versjon

Stopp Vite med Ctrl+C. Kopier innholdet i denne mappen inn i rotmappen til `gods-eye-view` og erstatt filer når macOS spør. Start deretter på nytt med:

```bash
npm run dev
```

Hvis nettleseren allerede står åpen, bruk Cmd+Shift+R etter omstart.

## Om kartdekningen

Det landsdekkende laget er et grovt planleggingsrutenett. Celler langs kysten og riksgrensen kan derfor strekke seg noe over sjø eller naboland. Dette er tilsiktet for oversiktsvisning og skal ikke tolkes som en meteorologisk administrativ grense.
