# Vérification de la passe macOS (Metal)

Les scripts du dossier parent, repris pour macOS et pour les outils de la PR 2 (#1202). Ils ont
validé la PR 3 (#1206) le 14/10/2026 sur un Mac mini M1, macOS 26.5. Les chiffres sont dans
`resultats/`, et repris dans la spec (H.3) et dans `rendering-performance.md`.

## Préparer

1. Un worktree d'essai : `feat/shader-effects-macos` avec #1202 fusionnée en local, jamais poussé.
   Y ajouter une ligne qui écrit la scène de chaque export, dans
   `CompositorViewService.exportMulti` (`electron/native-bridge/services/compositorViewService.ts`) :

   ```ts
   if (process.env.OPENSCREEN_DUMP_SCENE && sceneJson) {
   	fs.writeFileSync(process.env.OPENSCREEN_DUMP_SCENE, resolveSceneAssetPaths(sceneJson));
   }
   ```

2. `npm ci`, puis l'addon : `node scripts/build-macos-compositor-addon.mjs`, avec `MAC_FFMPEG_DIR` et
   `DYLD_FALLBACK_LIBRARY_PATH=<ffmpeg>/lib`. Lancé par `node` et non par `npm run`, qui retire les
   variables `DYLD_*`. Vérifier ensuite qu'il porte le nouveau code : la chaîne `no Metal device`
   doit être dans `compositor_view.node`.
3. `npm run build-vite`.
4. `FFMPEG` et `FFPROBE` : l'ffmpeg LGPL du dépôt, appelé par un petit script qui pose
   `DYLD_LIBRARY_PATH` lui-même.

Les scripts écrivent à côté d'eux, dans `media/`, `e2e/`, `profile/` et `tmp/` (ignorés par git).

## Les scripts

| Script | Ce qu'il fait |
|---|---|
| `make-clicks.mjs` | Une mire de 6 s en 1920×1080 à 30 i/s (VideoToolbox), et sa piste curseur à trois clics. |
| `mcp-e2e.mjs <worktree>` | La boucle de l'agent par `electron . --user-data-dir=profile mcp` : projet, export sans effet, `addEffect` avec une faute (refusé), le ripple de la spec C.6 (accepté), export avec effet, `getFrames`. |
| `mcp-noise.mjs <worktree>` | Le même projet sans effet exporté deux fois, pour le plancher du codec. |
| `preview-vs-export.mjs <worktree>` | La vue live sans fenêtre contre les exports, aux mêmes instants, avec et sans effet ; puis la cadence de la preview en lecture. |
| `noise-floor.mjs` | Sur les pixels où l'effet agit : l'écart de la preview à l'export avec effet, contre le même écart sans effet. |
| `export-time.mjs <worktree>` | `exportMulti` sans effet, avec le ripple sur toute la vidéo et avec `heavy.wgsl`, en passes alternées. |
| `heavy.wgsl` | L'effet lourd du spike, réécrit pour le contrat v1 (`params.strength`, `ctx.region.x`). |

## Pièges

- **`setParam`.** L'éditeur pousse les réglages de l'inspecteur à la vue live
  (`pushAllNativeParams`). Sans eux, le curseur de la vue garde sa taille par défaut, et la preview
  semble différer de l'export. Le script du spike Windows ne le faisait pas.
- **La première frame.** La vue met plus de 1,5 s à rendre sa première frame : le script attend 5 s
  au premier `presentTime`.
- **Un effet local se juge sur ses pixels.** Le ripple ne change qu'un anneau autour du clic : la
  moyenne sur l'image entière ne le voit pas. `noise-floor.mjs` compare donc, sur ces pixels seuls,
  l'écart avec effet à l'écart sans effet.
- **TMPDIR.** `mcp-e2e.mjs` donne au processus son propre `TMPDIR`, où vit le verrou d'instance
  unique : l'app de l'utilisateur, ouverte ou non, ne gêne pas.

## Résultats

- `log.json` : la boucle MCP, appel par appel.
- `preview-vs-export.json`, `noise-floor.json`, `export-time.json` : les mesures.
- `preview-export-2.9s.png` : la vue live (à gauche) et l'export (à droite), 0,3 s après le
  deuxième clic.
- `effet-preview-export-2.9s.png` : l'effet seul (avec moins sans, contraste ×4), dans la preview et
  dans l'export. Même anneau au même endroit ; le grain de l'export sur la mire en damier, c'est
  l'encodeur qui réalloue ses bits quand l'effet change le contenu.
- `getFrames-1.3s.jpg` : ce que l'agent voit 0,3 s après le premier clic.
