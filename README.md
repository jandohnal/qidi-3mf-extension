# 3MF → QIDI

A Chrome extension that converts 3MF projects downloaded from **MakerWorld** (Bambu Studio) and **Printables**
(PrusaSlicer) into **QIDI Studio** projects for your QIDI printer: Q1 Pro, Q2, Q2C, X-Plus 3/4, X-Max 3/4 and
X-Smart 3, each with 0.2–0.8 mm nozzles.

_Česky: rozšíření pro Chrome, které převádí 3MF z MakerWorld a Printables na profily QIDI Studia pro tvou tiskárnu
QIDI. UI je v češtině i angličtině podle jazyka prohlížeče._

## What it does

When you download a `.3mf` from MakerWorld or Printables, a window asks what to save:

- **Convert for QIDI**: saves `name (Q1 Pro).3mf` (the suffix is configurable).
- **Original + QIDI copy**: saves both files.
- **Original only**: saves the file unchanged.
- **Save nothing**, or close the window.

Below the choice is a report of every change against the original: warnings and a summary, the files in the archive
(changed, added, removed, unchanged), the model header and object placement, and the project settings. The settings
part has a table of the key values and lists of every changed key by category, plus the removed and added keys.

The conversion does the following:

- Replaces the printer, process and filament settings with QIDI Studio presets. The process is picked by layer height,
  and filaments are mapped by material. Both are configurable per printer.
- Keeps the designer's model settings: layer height, walls, infill, supports, brim, ironing and the like. For Bambu
  projects only what the designer actually changed is kept, which Bambu Studio records in
  `different_settings_to_system`. Per-object settings and modifiers are kept too. Speeds, accelerations and
  temperatures always come from the QIDI presets.
- Keeps filament colours and the filament count of multi-colour models.
- Moves objects from the source plate grid onto the QIDI bed. It handles multiple plates, excluded bed areas and the
  prime tower, and rotates a plate by 90° when that makes it fit. It warns when a plate still does not fit.
- Removes G-code and embedded presets made for the original printer.
- Rebuilds PrusaSlicer projects in the QIDI Studio layout, including parts, modifiers, support blockers and enforcers,
  and painted colours, supports and seams.

You can also drop any 3MF into the popup. You can import your own QIDI Studio process and filament presets: they are
the JSON files in the QIDI Studio `user` folder.

## Install

- **From the Chrome Web Store** (once published).
- **From source:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the
  `extension/` folder.

## Development

```bash
npm install
npm test                                      # unit tests on synthetic 3MF files
npm run try -- --slice [--printer "X-Max 3 0.4 nozzle"] file.3mf ...   # convert + check by slicing in the QIDI Studio CLI
npm run preview                               # popup in a normal tab (stubbed chrome API), port 5199
node scripts/preview-server.mjs 5198 --sample file.3mf   # + the save dialog: /dialog.html?job=demo
npm run profiles                              # rebuild extension/profiles from a local QIDI Studio (macOS)
npm run package                               # dist/qidi-3mf-extension-<version>.zip for the Chrome Web Store
```

`npm run profiles` reads the presets of the installed QIDI Studio. It uses the QIDI Studio CLI for default values
and per-filament keys, and a project saved from the QIDI Studio GUI of the same version as a template:
`scripts/templates/QIDIStudio-<version>.json`, or pass `--template file.3mf`. `--include-user` adds your own presets,
for personal builds only; `npm run package` refuses such a build.

Layout:

| Path | Role |
|---|---|
| `extension/lib/convert.js` | Builds the QIDI project config; the Bambu Studio path |
| `extension/lib/prusa.js` | Maps PrusaSlicer settings |
| `extension/lib/prusa-model.js` | Rebuilds the PrusaSlicer model layout |
| `extension/lib/layout.js` | Beds, plates and placement |
| `extension/lib/diff.js` | Compares the result with the original |
| `extension/lib/report-view.js` | Renders the report |
| `extension/lib/i18n.js` | English and Czech texts |
| `extension/lib/settings.js` | Settings, profile bundles and imported presets |
| `extension/background.js` | Intercepts downloads and runs jobs |
| `extension/offscreen.js` | Converts and holds the blobs until you choose |
| `extension/dialog.*` | The save window |
| `extension/popup.*` | The popup |

Publishing checklist: [STORE.md](STORE.md). Privacy policy: [PRIVACY.md](PRIVACY.md).

## License

AGPL-3.0-or-later (see [LICENSE](LICENSE)). The bundled printer presets in `extension/profiles` are derived from
QIDI Studio, © QIDI Technology, licensed under the AGPL-3.0. [fflate](https://github.com/101arrowz/fflate) is MIT
licensed (`extension/vendor/fflate.LICENSE`).

Not affiliated with QIDI, Bambu Lab or Prusa Research.
