# Astro Weather · Norge

Denne versjonen av God's Eye View har et nytt datalag: **Astro Weather · Norge**.

## Innhold

- Ringshaug som fast hovedpunkt (59.28064, 10.49167)
- Observatoriet som fast punkt (59.29139502027921, 9.995156084450006)
- et landsdekkende, semitransparent planleggingsrutenett over Fastlands-Norge, Svalbard og Jan Mayen
- 49 prognosetrinn: nå til +48 timer
- Astro-score 0–100 basert på skydekke, nedbør, luftfuktighet, duggpunktsmargin og vind
- Fargeskala fra grønt til rødt, med transparens som øker når forholdene begrenser sikten
- Klikk på et værfelt for lokal detalj
- Klikk Ringshaug eller Observatoriet i panelet for å fly kameraet dit
- Værdata fra Open-Meteo

## Starte lokalt

Fra prosjektmappen:

```bash
npm install
npm run dev
```

Åpne adressen Vite viser i Terminal. I datalag-panelet slår du på **Astro Weather · Norge**.

Hvis prosjektet allerede har `node_modules`, trenger du normalt bare:

```bash
npm run dev
```

## Viktig

ZIP-filen inneholder ikke `.env` eller API-nøkler. Behold din eksisterende `.env` når du erstatter prosjektfilene.
