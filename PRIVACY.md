# Privacy policy – 3MF to QIDI

_Last updated: 15 October 2026_

**3MF to QIDI** is a browser extension that converts 3MF project files for QIDI 3D printers. It does not collect,
transmit, sell or share any personal data.

## What the extension processes

- **3MF files you download** from makerworld.com or printables.com (and their file servers), or that you drop into
  the extension popup. The files are read and converted **locally in your browser**. They are never uploaded anywhere.
- **Your settings** (chosen printer, process, filament mapping, file name suffix, language) are stored with
  `chrome.storage.sync`, so Chrome may sync them between your own browsers if you have Chrome sync turned on.
- **QIDI Studio presets you import** and a **list of the last 15 conversions** (file names and conversion notes) are
  stored locally with `chrome.storage.local`. You can remove imported presets in the popup; uninstalling the
  extension deletes all of it.

## Network access

The extension only connects to the MakerWorld and Printables domains listed in its manifest, and only to download the
3MF file you started downloading yourself (using your existing browser session, exactly like the original download).
It has no analytics, no tracking, no remote code and no server of its own.

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Notice 3MF downloads from MakerWorld/Printables and save the original and/or converted file. |
| `storage` | Keep your settings, imported presets and conversion history. |
| `offscreen` | Convert files in a background document that can hand the result to the download manager. |
| `scripting` | Read a downloaded file that the website created in the page itself (a `blob:` link). |
| `notifications` | Tell you when a file could not be converted or was saved unchanged. |
| Host access to MakerWorld and Printables | Download the 3MF file you requested so it can be converted. |

## Contact

Questions or problems: open an issue at https://github.com/jandohnal/qidi-3mf-extension/issues

---

# Zásady ochrany soukromí – 3MF do QIDI

Rozšíření **3MF do QIDI** převádí soubory 3MF pro 3D tiskárny QIDI. Neshromažďuje, neodesílá, neprodává ani nesdílí
žádné osobní údaje.

- **Soubory 3MF**, které stáhneš z makerworld.com nebo printables.com nebo přetáhneš do rozšíření, se čtou a převádějí
  **jen lokálně v prohlížeči** a nikam se neodesílají.
- **Nastavení** (tiskárna, proces, filamenty, přípona, jazyk) se ukládá přes `chrome.storage.sync`; při zapnuté
  synchronizaci Chrome ho může přenést mezi tvými prohlížeči.
- **Importované profily QIDI Studia** a **seznam posledních 15 převodů** se ukládají lokálně (`chrome.storage.local`).
  Odinstalováním rozšíření se vše smaže.
- Rozšíření se připojuje jen k doménám MakerWorld a Printables uvedeným v manifestu, a to jen kvůli stažení souboru,
  který jsi sám začal stahovat. Nemá analytiku, sledování, vzdálený kód ani vlastní server.
