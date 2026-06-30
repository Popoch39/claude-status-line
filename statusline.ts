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
  const resetPart = reset ? ` ${C.dim}(reset dans ${reset})${C.reset}` : "";
  return `${C.dim}${label}${C.reset} ${bar(pct)}${resetPart}`;
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

// --- Cache des derniers rate_limits connus -----------------------------------
//
// Claude Code ne fournit `rate_limits` qu'APRÈS la première réponse de la
// session. Pour afficher les barres « tout le temps », on persiste la dernière
// valeur vue dans ce fichier, et on la relit quand stdin n'en fournit pas.
const CACHE_PATH = join(homedir(), ".claude", ".statusline-cache.json");

type RateLimits = NonNullable<StatusInput["rate_limits"]>;

// Lecture best-effort : tout échec (absent, illisible) → undefined.
function readCache(): RateLimits | undefined {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as RateLimits;
  } catch {
    return undefined;
  }
}

// Écriture best-effort : on n'interrompt jamais le rendu si l'écriture échoue.
function writeCache(rl: RateLimits): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(rl));
  } catch {
    /* le cache est un confort, pas une obligation */
  }
}

// Considère une fenêtre comme « fraîche » si elle porte un pourcentage réel.
function hasFreshData(rl?: RateLimits): boolean {
  return rl?.five_hour?.used_percentage != null;
}

// --- Source fraîche : appel API direct (fenêtre de démarrage uniquement) -----
//
// Claude Code ne met `rate_limits` sur stdin qu'APRÈS la 1ʳᵉ réponse. Pour avoir
// du frais dès le lancement, on interroge l'API avec le token OAuth de Claude
// Code et on lit les en-têtes `anthropic-ratelimit-unified-*` de la réponse.
//
// Découvertes empiriques importantes :
//   - le token OAuth d'abonnement EXIGE le system prompt « You are Claude Code »
//     (sinon 429) ;
//   - `…-utilization` est une fraction 0–1 → × 100 ; `…-reset` est déjà un epoch.
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const FETCH_TIMEOUT_MS = 2500; // borne la latence ajoutée au démarrage

function readOAuthToken(): string | undefined {
  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
    return creds?.claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

function windowFromHeaders(
  headers: Headers,
  prefix: "5h" | "7d",
): Window | undefined {
  const util = headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
  if (util == null) return undefined;
  const reset = headers.get(`anthropic-ratelimit-unified-${prefix}-reset`);
  return {
    used_percentage: Number(util) * 100,
    resets_at: reset != null ? Number(reset) : undefined,
  };
}

// Best-effort : toute erreur (token absent/expiré, hors-ligne, timeout) → undefined.
async function fetchFreshRateLimits(): Promise<RateLimits | undefined> {
  const token = readOAuthToken();
  if (!token) return undefined;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: "user", content: "." }],
      }),
    });
    const five = windowFromHeaders(res.headers, "5h");
    if (!five) return undefined; // pas d'en-têtes utiles → on laisse tomber
    return { five_hour: five, seven_day: windowFromHeaders(res.headers, "7d") };
  } catch {
    return undefined;
  }
}

// Décide quels rate_limits afficher, et tient le cache à jour.
//   1. stdin frais (post-1ʳᵉ réponse) → vérité, on persiste. AUCUN réseau.
//   2. démarrage          → on va chercher du frais via l'API ; à défaut, cache.
async function resolveRateLimits(
  fromStdin?: RateLimits,
): Promise<RateLimits | undefined> {
  if (hasFreshData(fromStdin)) {
    writeCache(fromStdin!);
    return fromStdin;
  }
  const fetched = await fetchFreshRateLimits();
  if (fetched) {
    writeCache(fetched);
    return fetched;
  }
  return readCache() ?? fromStdin;
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

  const rl = await resolveRateLimits(data.rate_limits);
  segments.push(windowSegment("5h", rl?.five_hour));
  segments.push(windowSegment("sem", rl?.seven_day));

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
