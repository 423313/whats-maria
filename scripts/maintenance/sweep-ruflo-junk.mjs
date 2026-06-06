#!/usr/bin/env node
/**
 * Varredor de arquivos-lixo do ruflo.
 *
 * Um dos hooks do ruflo cria, por engano, arquivos VAZIOS (0 bytes) na raiz do
 * projeto, com nomes tirados de pedaços dos comandos (ex.: "texto", "reference",
 * "p.type"). Eles poluem a pasta e já chegaram a quebrar um `git mv`.
 *
 * Este script NÃO apaga: ele MOVE esses arquivos para a pasta de quarentena
 * `.ruflo-trash/` (gitignored), deixando a raiz limpa mas preservando o lixo
 * caso algum dia seja preciso inspecionar.
 *
 * Roda automaticamente via hook PostToolUse (.claude/settings.json), logo após
 * os hooks do ruflo — assim, qualquer lixo recém-criado é varrido na hora.
 *
 * Segurança: só mexe em arquivos da RAIZ (não recursivo), de 0 bytes, que NÃO
 * sejam dotfiles (.gitignore etc.) nem estejam na whitelist. Qualquer arquivo
 * legítimo do projeto tem conteúdo, então nunca é tocado.
 */
import { readdirSync, statSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join } from 'path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TRASH_DIR = join(root, '.ruflo-trash');

// Arquivos de 0 bytes que PODEM ser legítimos — nunca mover.
const WHITELIST = new Set(['.gitkeep', '.nojekyll', '.keep', 'py.typed']);

function uniqueDest(name) {
  let dest = join(TRASH_DIR, name);
  let i = 1;
  while (existsSync(dest)) {
    dest = join(TRASH_DIR, `${name}.${i}`);
    i += 1;
  }
  return dest;
}

let moved = 0;
try {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue; // ignora dotfiles
    if (WHITELIST.has(entry.name)) continue;
    const full = join(root, entry.name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.size !== 0) continue; // só arquivos vazios
    if (!existsSync(TRASH_DIR)) mkdirSync(TRASH_DIR, { recursive: true });
    try {
      renameSync(full, uniqueDest(entry.name));
      moved += 1;
    } catch {
      // ignora — não pode falhar o pipeline do hook
    }
  }
} catch {
  // silencioso por design (hook não deve poluir nem quebrar)
}

if (moved > 0 && process.argv.includes('--verbose')) {
  console.log(`sweep-ruflo-junk: ${moved} arquivo(s)-lixo movido(s) para .ruflo-trash/`);
}
