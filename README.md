# 3MF → QIDI

Chrome rozšíření, které 3MF projekty stažené z **MakerWorld** (Bambu Studio) a **Printables**
(PrusaSlicer) převede na projekt **QIDI Studia** pro tvou tiskárnu (výchozí: QIDI Q1 Pro, tryska 0,4).

Co se při převodu děje:

- **Tiskárna, proces a filamenty** se nahradí QIDI profily vygenerovanými z tvé instalace QIDI Studia
  (systémové i tvoje vlastní profily, ★ v nabídce).
  - Proces se volí automaticky podle výšky vrstvy (nebo pevně v popupu).
  - Filamenty se mapují podle materiálu (PLA, PLA Silk, PETG, ABS, ASA, TPU…), mapování jde změnit v popupu.
  - Barvy filamentů a jejich počet zůstanou zachovány (vícebarevné modely).
- **Nastavení autora** se přenese: u Bambu projektů jen to, co autor změnil oproti svému profilu
  (stěny, výplň, podpory, brim, žehlení…), u PrusaSliceru klíčové volby. Rychlosti, akcelerace a teploty
  jdou vždy z QIDI profilů. Jde vypnout.
- **Nastavení u jednotlivých objektů** (modifikátory, stěny u dílu…) zůstane; co QIDI Studio nezná, vypadne s varováním.
- **Rozložení desek** se přepočítá na menší podložku (Q1 Pro 245×245 mm, s vyloučenými zadními rohy):
  objekty se posunou, deska se případně otočí o 90°, čistící věž se přesune s nimi.
  Když se deska nevejde, dostaneš varování a v QIDI Studiu ji přeskládej (Arrange).
- Odstraní se G-code a vložené Bambu profily pro původní tiskárnu.
- PrusaSlicer projekty se přestaví do struktury QIDI Studia (díly, modifikátory, podpěrné bloky,
  namalované barvy/podpory/šev).

## Instalace

1. Profily jsou v `extension/profiles/printer.json` (vygenerované pro Q1 Pro 0,4).
2. Chrome → `chrome://extensions` → zapni **Režim pro vývojáře** → **Načíst rozbalené** → vyber složku `extension/`.
3. Klikni na ikonu kostky: tam je přepínač, výběr procesu, mapování filamentů a ruční převod (přetáhni 3MF).

Stažení `.3mf` z MakerWorld/Printables se pak automaticky zachytí, převede a uloží jako
`název (Q1 Pro).3mf` (příponu jde změnit). Když převod selže, stáhne se původní soubor.

## Aktualizace profilů

Po aktualizaci QIDI Studia nebo úpravě vlastních profilů:

```bash
npm run profiles
```

Skript čte presety z `~/Library/Application Support/QIDIStudio`, přes CLI QIDI Studia zjistí, které klíče
jsou „per filament“, a jako šablonu použije nejnovější projekt uložený z GUI QIDI Studia stejné verze pro
danou tiskárnu (najde ho přes Spotlight; jinak `--template soubor.3mf`). Jiná tiskárna: `--printer "Plus4 0.4 nozzle"`.
Pak v `chrome://extensions` rozšíření obnov.

## Vývoj

```bash
npm test                                   # unit testy na syntetických 3MF
npm run try -- --slice soubor.3mf ...      # převod + kontrolní slicování v QIDI Studio CLI
npm run preview                            # popup v běžném prohlížeči (stub chrome API), port 5199
```

Struktura: `extension/lib/convert.js` (sestavení projektu, Bambu cesta), `prusa.js` + `prusa-model.js`
(PrusaSlicer), `layout.js` (podložka, desky, umístění), `background.js` (zachytávání stahování),
`offscreen.js` (převod a uložení přes blob URL), `popup.*`.
