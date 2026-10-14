# Spike : effets shader écrits par l'agent

14/10/2026, Windows (RTX 4070 Ti, D3D11). Code dans le worktree `custom-shader-fx-spike`,
branche `worktree-custom-shader-fx-spike`, non commité.

## Verdict

**Ça tient.** Un agent écrit un effet en WGSL via le MCP. Il est compilé hors du thread de
rendu, puis appliqué à l'identique en preview et à l'export. Le coût en FPS et en temps d'export
n'est pas mesurable.

## Ce qui a été mesuré

### Boucle de l'agent

Mesurée via la CLI `openscreen mcp` du worktree, en stdio.

| Étape | Résultat |
|---|---|
| `addShaderEffect` avec une faute de frappe (`strenght`) | Refusé en 7 ms. L'erreur de naga pointe la ligne 4, colonne 44, et l'identifiant inconnu |
| `addShaderEffect` corrigé | Accepté en 12 ms, `validated: true` |
| `exportVideo` puis `getFrames` | L'effet est visible dans la région, absent hors de la région |

### Performance

**Banc du compositeur.** Release, 300 frames, scène minimale, effet lourd : aberration,
barillet, grain, scanlines, anneau, vignette.

| Résolution | Sans effet | Avec effet | Écart |
|---|---|---|---|
| 1080p | 0,060 ms/frame | 0,100 ms/frame | **+0,04 ms** |
| 4K | 0,199 ms/frame | 0,314 ms/frame | **+0,12 ms** |

**Export natif réel.** `exportMulti`, 180 frames en 1752×1080, moyenne de 3 passes alternées.

| Cas | Temps |
|---|---|
| Sans effet | 520 ms |
| Effet de l'agent | 523 ms |
| Effet lourd | 521 ms |

**Preview en lecture.** Vue live réelle, source à 30 i/s.

- Avec effet : 29,7 à 30 i/s.
- Sans effet : 29,7 i/s.
- Aucune frame perdue.

**Compilation.** L'effet est prêt 13 ms après la pose de la scène (build debug). La preview
saute l'effet le temps de la compilation, puis recompose. L'export attend le binaire.

### SSOT pixels

Même frame dans la vue live de l'éditeur et dans le MP4 exporté, décodée en BT.709.

| Instant | Preview contre export avec effet | Preview contre export sans effet |
|---|---|---|
| 0,5 s (hors région) | 2,6 / 255 | 2,6 / 255 |
| 2 s | **2,3 / 255** (33 dB) | 25,3 / 255 |
| 3 s | **2,2 / 255** (34 dB) | 35,5 / 255 |
| 4,5 s | **2,7 / 255** (32 dB) | 14,1 / 255 |

- **Lecture :** dans la région, l'écart preview/export reste au niveau du bruit du codec H.264,
  le même que hors de la région. L'effet n'ajoute aucune divergence.
- **Image :** `e2e/comparaison-3s.png`.

## Ce que le spike a construit

- **`crates/compositor/src/shader_fx.rs` :**
  - le contrat WGSL (`frame(uv)`, `ctx.time`, `ctx.progress`, `ctx.resolution`, `param(i)`) ;
  - la traduction naga vers HLSL ;
  - FXC sur un thread de fond ;
  - 6 tests.
- **`compositor_windows.rs` :**
  - la passe plein cadre en fin de `compose_frame` ;
  - le cache par hash ;
  - le mode bloquant pour l'export et non bloquant pour la preview ;
  - 3 tests GPU et un banc opt-in.
- **`live.rs` :** la preview recompose quand un effet finit de compiler.
- **Scène et TS :**
  - régions dans `legacyEditor.shaderEffects`, projetées comme les autres régions ;
  - outils `addShaderEffect` et `setShaderEffect` ;
  - `removeModifier` les supprime aussi ;
  - validation par l'addon (`validateShaderEffect`).
- **Dépendances :** naga 24, déjà tiré par wgpu, et la feature FXC de `windows`.
  `Cargo.lock` ne gagne qu'une ligne.

## Ce qui manque avant une vraie fonctionnalité

- **macOS et Linux.**
  - La passe n'est dessinée que sur Windows.
  - Linux : le WGSL passe tel quel dans wgpu.
  - macOS : naga vers MSL, puis `newLibraryWithSource`.
- **Timeline.** L'éditeur n'affiche pas encore les régions d'effet : on ne peut ni les voir ni
  les déplacer à la souris.
- **Agent intégré.** Le chat de l'app a les outils, mais pas le validateur
  (`chat-service` ne le passe pas). Ses effets sont stockés sans vérification.
- **Sécurité GPU.** Les boucles ne sont pas bornées : une boucle infinie provoque un TDR. naga 24
  n'a pas `force_loop_bounding`. Il faut borner nous-mêmes, ou refuser `loop`/`while`.
- **Un seul effet par frame.** Il faudra une pile d'effets, et des effets par calque (webcam
  seule, écran seul).
- **Cache jamais évincé.** Il faudra un LRU.

## Effets de bord du test

- **Profil réel touché, puis nettoyé.** La CLI de dev écrit par défaut dans le profil de l'app
  installée (`%APPDATA%\openscreen`). Un premier run y a créé un projet `shader-fx-spike`.
  - Je l'ai supprimé.
  - Les runs suivants utilisent `--user-data-dir=%APPDATA%\openscreen-shader-fx-spike`.
- **Profil de test conservé.** `%APPDATA%\openscreen-shader-fx-spike` garde le projet de test,
  si tu veux l'ouvrir dans une app de dev.
- **Disque.** Le worktree pèse ~4 Go : `crates/target` et les binaires natifs copiés depuis
  l'app installée.

## Rejouer

Les scripts sont dans ce dossier :

- `mcp-e2e.mjs` : la boucle de l'agent ;
- `preview-vs-export.mjs` : la SSOT et les FPS ;
- `export-time.mjs` : le temps d'export ;
- `bench.bat` : le banc du compositeur.
