# Outils de vérification du spike « effets shader »

Branche de référence, jamais fusionnée. Le code livré est dans les PR #1199 (contrat v1 et passe
Windows) et #1202 (document et outils agent). La spec est `docs/shader-effects.md`.

Ces scripts ont servi à valider le spike sous Windows. Leurs chemins sont ceux de cette machine :
les adapter avant de les lancer ailleurs.

| Script | Ce qu'il fait |
|---|---|
| `make-clicks.mjs` | Copie une vidéo de test et écrit à côté une piste curseur (`<video>.cursor.json`) avec trois clics. |
| `fx-loop.mjs` | Une itération d'agent contre la CLI `openscreen mcp` : `init <video>`, puis `apply <effect.wgsl> <start> <end> [params] [times]` (`addEffect` ou `setEffect`, export, `getFrames`). |
| `mcp-e2e.mjs` | La boucle complète en un run : projet, export sans effet, code cassé refusé, code corrigé, export, frames. |
| `preview-vs-export.mjs` | Charge l'addon dans Node, pilote la vue live sans fenêtre (`createView`, `setScene`, `setPlaying(false)`, `presentTime`, `readFrame`) et compare ses frames à celles du MP4 exporté, décodé en BT.709. Mesure aussi la cadence en lecture. |
| `export-time.mjs` | `exportMulti` avec et sans effet, passes alternées. |
| `bench.py` | Banc D3D11 brut par ctypes (Windows seulement) : temps de `D3DCompile`, coût d'une passe plein cadre. |
| `ripple.wgsl`, `heavy.wgsl` | L'effet écrit à partir du prompt « effet ripple lors du clic », et un effet lourd de banc. |
| `spike-resultats.md` | Le compte rendu du spike. |
| `macos/` | Les mêmes vérifications pour la passe Metal (PR 3), adaptées aux outils de la PR 2, avec leurs résultats. |

**Pièges :**
- **Profil séparé.** La CLI de dev écrit dans le profil de l'app installée : passer
  `--user-data-dir=<profil de test>` AVANT la sous-commande.
- **Checkpoints.** Ils vivent dans le processus du serveur : un `createCheckpoint` par lancement,
  avant d'éditer.
- **La vue live démarre en lecture.** Faire `setPlaying(id, false)` avant `presentTime`.
- **La vue live sans l'éditeur n'a pas ses réglages.** Lui pousser ceux de l'inspecteur par
  `setParam`, comme `pushAllNativeParams` : sinon son curseur garde sa taille par défaut et
  diffère de l'export.
