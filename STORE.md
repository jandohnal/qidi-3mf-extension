# Chrome Web Store submission

Everything needed to fill in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).

## Before uploading

1. `npm test`
2. `npm run profiles` (only after a QIDI Studio update; never publish a build made with `--include-user`)
3. Bump `version` in both `package.json` and `extension/manifest.json`
4. `npm run package` → upload `dist/qidi-3mf-extension-<version>.zip`

One-time: register a developer account (one-off US$5 fee), and publish `PRIVACY.md` at a public URL
(e.g. make this repository public, or use GitHub Pages / a gist) for the privacy policy field.

## Store listing

**Name** (from `_locales`): 3MF to QIDI – MakerWorld & Printables converter
**Category:** Tools (or Productivity) · **Language:** English, Czech

**Summary** (132 chars max, from `_locales/en`):
> Converts 3MF projects from MakerWorld (Bambu Studio) and Printables (PrusaSlicer) to QIDI Studio profiles for your QIDI printer.

**Description (EN):**

> Download a 3MF project from MakerWorld or Printables and open it in QIDI Studio ready for your QIDI printer.
>
> When you download a .3mf, the extension asks what to save – the converted file, the original plus a QIDI copy, or
> just the original – and shows a full report of every change against the original file.
>
> What the conversion does:
> • Replaces the printer, process and filament settings with QIDI Studio presets for your printer
>   (Q1 Pro, Q2, Q2C, X-Plus 3/4, X-Max 3/4, X-Smart 3; 0.2–0.8 mm nozzles).
> • Keeps what the designer tuned for the model – layer height, walls, infill, supports, brim, ironing – and per-object
>   settings and modifiers. Speeds, accelerations and temperatures come from the QIDI presets.
> • Keeps filament colours for multi-colour models and maps each filament by material (configurable).
> • Moves objects from the Bambu/Prusa bed layout onto your QIDI bed (multiple plates, prime tower, rotation by 90°
>   when that makes a plate fit) and warns when something does not fit.
> • Removes G-code sliced for the original printer.
> • Rebuilds PrusaSlicer projects (parts, modifiers, painted colours/supports/seams) in the QIDI Studio format.
>
> You can also import your own QIDI Studio process and filament presets, or drop any 3MF file into the popup.
> Everything runs locally in your browser; no data leaves your computer.
>
> Not affiliated with QIDI, Bambu Lab or Prusa Research. QIDI Studio presets are distributed under the AGPL-3.0.

**Description (CS):**

> Stáhni 3MF projekt z MakerWorld nebo Printables a otevři ho v QIDI Studiu rovnou pro svou tiskárnu QIDI.
>
> Při stažení .3mf se rozšíření zeptá, co uložit – převedený soubor, originál i kopii pro QIDI, nebo jen originál –
> a ukáže úplný přehled všech změn proti originálu.
>
> • Nahradí tiskárnu, proces a filamenty profily QIDI Studia (Q1 Pro, Q2, Q2C, X-Plus 3/4, X-Max 3/4, X-Smart 3;
>   trysky 0,2–0,8 mm).
> • Zachová nastavení autora pro model (vrstvy, stěny, výplň, podpory, brim, žehlení) i nastavení jednotlivých objektů.
> • Zachová barvy vícebarevných modelů a namapuje filamenty podle materiálu.
> • Přesune objekty na podložku QIDI (více desek, čistící věž, otočení o 90°) a upozorní, když se něco nevejde.
> • Odstraní G-code pro původní tiskárnu a převede i projekty z PrusaSliceru.
>
> Lze importovat i vlastní profily z QIDI Studia. Vše běží lokálně v prohlížeči.

## Graphics

- Icon 128×128: `extension/icons/icon128.png` (already in the package)
- Screenshots (1280×800, at least one): run `node scripts/preview-server.mjs 5198 --sample <some.3mf>` and capture
  `http://localhost:5198/dialog.html?job=demo&lang=en` and `http://localhost:5198/popup.html?lang=en` in a
  1280×800 window, or take them from the real extension.
- Small promo tile 440×280 (optional).

## Privacy practices tab

**Single purpose:** Convert 3MF 3D-printing projects downloaded from MakerWorld and Printables into QIDI Studio
projects for the user's QIDI printer.

**Permission justifications:**

| Permission | Justification |
|---|---|
| downloads | Detects .3mf downloads started on MakerWorld/Printables and saves the original and/or converted file the user chooses. |
| storage | Stores the user's settings (printer, presets, file name), imported QIDI Studio presets and a short conversion history. |
| offscreen | Runs the conversion in an offscreen document that can create blob URLs for the download manager (service workers cannot). |
| scripting | When a site creates the 3MF as a blob: URL in the page, reads that blob from the page so it can be converted. |
| notifications | Informs the user when a file could not be converted or was saved unchanged. |
| Host permissions (makerworld.com, bblmw.com, bambulab.com/.cn, printables.com, prusa3d.com) | Downloads the 3MF file the user requested from these sites and their file servers so it can be converted locally. |

**Remote code:** No, all code is in the package.

**Data usage:** the extension does not collect or transmit user data. Tick none of the data categories; certify that
data is not sold, not used for unrelated purposes and not used for creditworthiness.

**Privacy policy URL:** public URL of `PRIVACY.md`.
