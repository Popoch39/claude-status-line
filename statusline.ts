#!/usr/bin/env bun
/**
 * claude-statusline — status line Claude Code : usage abonnement (5h + hebdo).
 *
 * Deux modes (dispatch en bas de fichier) :
 *   - (aucun arg)  → RENDER : lit le JSON de Claude Code sur stdin, écrit la
 *                    status line sur stdout. C'est le hot path : aucun réseau.
 *   - `init`       → INSTALL : écrit/merge le bloc `statusLine` dans
 *                    ~/.claude/settings.json, en pointant sur CE binaire.
 *   - `--version`  → affiche la version.
 *
 * Distribué en binaire autonome via `bun build --compile`. Un binaire compilé
 * connaît son propre chemin via `process.execPath`, ce qui permet à `init` de
 * s'auto-référencer dans settings.json — l'installeur n'a donc besoin d'aucune
 * dépendance externe.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export const VERSION = "1.0.0";

// --- Types (sous-ensemble du schéma stdin qui nous intéresse) ----------------

interface Window {
  used_percentage?: number;
  resets_at?: number; // epoch Unix en secondes
}

interface StatusInput {
  model?: { display_name?: string };
  workspace?: { current_dir?: string };
  worktree?: { branch?: string };
  rate_limits?: {
    five_hour?: Window;
    seven_day?: Window;
  };
}

// --- Couleurs ANSI -----------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m", // gris
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} as const;

// Seuils validés : vert < 50 % · jaune 50–80 % · rouge > 80 %
function colorFor(pct: number): string {
  if (pct > 80) return C.red;
  if (pct >= 50) return C.yellow;
  return C.green;
}

// --- Rendu d'une barre + son pourcentage -------------------------------------
//
// 👉 ZONE À PERSONNALISER (1/2) : largeur, caractères, arrondi.
const BAR_WIDTH = 10;

function bar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const gauge = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  return `${colorFor(clamped)}${gauge} ${Math.round(clamped)}%${C.reset}`;
}

// --- Formatage du temps de reset ---------------------------------------------
//
// 👉 ZONE À PERSONNALISER (2/2) : > 24h → "3j" · 1–24h → "2h14" · < 1h → "14m".
function fmtReset(epochSec?: number): string {
  if (epochSec == null) return "";
  const delta = epochSec - Date.now() / 1000;
  if (delta <= 0) return "0m";
  if (delta >= 86400) return `${Math.floor(delta / 86400)}j`;
  if (delta >= 3600) {
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    return `${h}h${String(m).padStart(2, "0")}`;
  }
  return `${Math.floor(delta / 60)}m`;
}

// --- Branche git (pas fournie par stdin sauf en worktree) --------------------

function gitBranch(cwd: string, fromInput?: string): string {
  if (fromInput) return fromInput;
  try {
    const proc = Bun.spawnSync(["git", "branch", "--show-current"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    return new TextDecoder().decode(proc.stdout).trim();
  } catch {
    return "";
  }
}

function windowSegment(label: string, win?: Window): string {
  const pct = win?.used_percentage;
  if (pct == null) return `${C.dim}${label} —${C.reset}`;
  const reset = fmtReset(win?.resets_at);
  const resetPart = reset ? ` ${C.dim}(${reset})${C.reset}` : "";
  return `${C.dim}${label}${C.reset} ${bar(pct)}${resetPart}`;
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

// --- Mode RENDER (hot path) --------------------------------------------------

async function render(): Promise<void> {
  const data = (await Bun.stdin.json().catch(() => ({}))) as StatusInput;

  const segments: string[] = [];

  const model = data.model?.display_name;
  if (model) segments.push(`${C.cyan}${model}${C.reset}`);

  const cwd = data.workspace?.current_dir ?? "";
  if (cwd) {
    const branch = gitBranch(cwd, data.worktree?.branch);
    segments.push(
      `${basename(cwd)}${branch ? ` ${C.dim}(${branch})${C.reset}` : ""}`,
    );
  }

  segments.push(windowSegment("5h", data.rate_limits?.five_hour));
  segments.push(windowSegment("sem", data.rate_limits?.seven_day));

  const sep = `${C.dim} · ${C.reset}`;
  // Une seule ligne : Claude Code n'affiche que la première.
  process.stdout.write(segments.join(sep));
}

// --- Mode INIT (configuration de settings.json) ------------------------------

function init(): void {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  // Le binaire pointe sur lui-même. En dev (bun run), execPath est bun : on
  // tombe alors sur le chemin du script source, ce qui reste utilisable.
  const command = process.execPath;

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      // Sauvegarde avant toute écriture.
      writeFileSync(`${settingsPath}.bak`, readFileSync(settingsPath));
    } catch (e) {
      console.error(`⚠️  settings.json illisible (${e}). Abandon.`);
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  settings.statusLine = {
    type: "command",
    command,
    padding: 2,
    refreshInterval: 60,
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log(`✅ claude-statusline v${VERSION} configuré.`);
  console.log(`   settings : ${settingsPath}`);
  console.log(`   binaire  : ${command}`);
  console.log(`   Relance Claude Code (ou ouvre une nouvelle session).`);
}

// --- Dispatch ----------------------------------------------------------------

const cmd = process.argv[2];
if (cmd === "init") {
  init();
} else if (cmd === "--version" || cmd === "version" || cmd === "-v") {
  console.log(VERSION);
} else {
  await render();
}
