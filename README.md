# claude-statusline

Status line pour [Claude Code](https://code.claude.com) qui affiche ton **usage d'abonnement** sous la zone de saisie : la fenêtre glissante **5 heures** et la limite **hebdomadaire**, avec barres de progression colorées.

```
Opus 4.8 · mon-projet (main) · 5h ███████░░░ 68% (2h14) · sem ████░░░░░░ 41% (3j)
```
- Pourcentages **officiels** lus dans `rate_limits` du JSON fourni par Claude Code (abonnés Pro/Max) — aucune estimation.

## Installation

```sh
curl -fsSL https://raw.githubusercontent.com/Popoch39/claude-status-line/main/install.sh | sh
```

Le script détecte ton OS/archi, télécharge le binaire depuis les [Releases](https://github.com/Popoch39/claude-status-line/releases/latest), puis configure `~/.claude/settings.json`. **Relance Claude Code** ensuite.

> Les barres n'apparaissent qu'après la **première réponse** de Claude dans une session (avant, un placeholder grisé `5h —` s'affiche — normal).

## Mise à jour

Relance la **même** commande d'installation : elle récupère la dernière release.

## Plateformes

Linux (x64/arm64), macOS (Intel/Apple Silicon), Windows (x64).
Sur Windows natif : télécharge `claude-statusline-windows-x64.exe` depuis les Releases et lance-le une fois avec l'argument `init`.

## Développement

```sh
bun statusline.ts                 # render (attend du JSON sur stdin)
bun statusline.ts init            # configure settings.json
bun run build                     # binaire local → dist/
bun run build:all                 # tous les binaires (cross-compile)
```
