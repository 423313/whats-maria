#!/usr/bin/env node
/**
 * Liga/desliga o "peso" do ruflo no contexto do Claude Code SEM desinstalar nada.
 *
 * Por que existe: o ruflo injeta em TODA sessão ~300 ferramentas MCP + 23 agentes +
 * dezenas de skills/comandos + hooks por-turno. Isso só compensa em tarefas grandes
 * (swarm/orquestração). No dia a dia (perguntas, ajustes pequenos) vira um "pedágio"
 * de tokens caro. Este toggle move o tooling do ruflo para uma quarentena e desabilita
 * o servidor MCP + os hooks, deixando as sessões leves. A MEMÓRIA (.swarm/memory.db) e
 * a chave de criptografia (no .mcp.json) ficam INTACTAS.
 *
 * Uso:
 *   node scripts/maintenance/ruflo-toggle.mjs status
 *   node scripts/maintenance/ruflo-toggle.mjs disable   (deixa o ruflo dormindo)
 *   node scripts/maintenance/ruflo-toggle.mjs enable     (reativa tudo)
 *
 * Reversível 100%: 'enable' devolve cada arquivo de onde veio.
 * Efeito vale a partir da PRÓXIMA sessão (o contexto atual já foi carregado).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const claudeDir = path.join(projectRoot, '.claude');
const quarantine = path.join(claudeDir, '.ruflo-disabled');

// Itens do ruflo a mover. Tudo que NÃO está aqui (ex.: atualizar.md, skill dual-mode)
// é considerado SEU e nunca é tocado.
const RUFLO_COMMANDS = [
  'agents', 'analysis', 'automation', 'coordination', 'github', 'hive-mind',
  'hooks', 'memory', 'monitoring', 'optimization', 'pair', 'sparc',
  'stream-chain', 'swarm', 'training', 'truth', 'verify', 'workflows',
  'claude-flow-help.md', 'claude-flow-memory.md', 'claude-flow-swarm.md',
];
const RUFLO_SKILLS = [
  'agentdb-advanced', 'agentdb-learning', 'agentdb-memory-patterns',
  'agentdb-optimization', 'agentdb-vector-search', 'browser', 'find-skills',
  'flow-nexus-neural', 'flow-nexus-platform', 'flow-nexus-swarm',
  'github-code-review', 'github-multi-repo', 'github-project-management',
  'github-release-management', 'github-workflow-automation', 'hooks-automation',
  'pair-programming', 'reasoningbank-agentdb', 'reasoningbank-intelligence',
  'skill-builder', 'sparc-methodology', 'stream-chain', 'swarm-advanced',
  'swarm-orchestration', 'v3-cli-modernization', 'v3-core-implementation',
  'v3-ddd-architecture', 'v3-integration-deep', 'v3-mcp-optimization',
  'v3-memory-unification', 'v3-performance-optimization', 'v3-security-overhaul',
  'v3-swarm-coordination', 'verification-quality',
];
// 'agents/' inteiro é do ruflo (23 agentes). Movido como pasta.

const action = (process.argv[2] || 'status').toLowerCase();

function move(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(src, dst);
  return true;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function disable() {
  let moved = 0;
  // 1) agentes (pasta inteira)
  if (move(path.join(claudeDir, 'agents'), path.join(quarantine, 'agents'))) moved++;
  // 2) comandos do ruflo
  for (const name of RUFLO_COMMANDS) {
    if (move(path.join(claudeDir, 'commands', name), path.join(quarantine, 'commands', name))) moved++;
  }
  // 3) skills do ruflo
  for (const name of RUFLO_SKILLS) {
    if (move(path.join(claudeDir, 'skills', name), path.join(quarantine, 'skills', name))) moved++;
  }
  // 4) desabilita o servidor MCP ruflo (mantém o .mcp.json e a chave intactos)
  const localPath = path.join(claudeDir, 'settings.local.json');
  const local = readJson(localPath) || {};
  const dis = new Set(local.disabledMcpjsonServers || []);
  dis.add('ruflo');
  local.disabledMcpjsonServers = [...dis];
  writeJson(localPath, local);
  // 5) remove os hooks do ruflo do settings.json (backup do original)
  const settingsPath = path.join(claudeDir, 'settings.json');
  const backupPath = path.join(quarantine, 'settings.full.json');
  const settings = readJson(settingsPath);
  if (settings && settings.hooks) {
    if (!fs.existsSync(backupPath)) writeJson(backupPath, settings);
    const stripped = { ...settings };
    delete stripped.hooks; // tira o overhead por-turno; permissions + env ficam
    writeJson(settingsPath, stripped);
  }
  console.log(`✅ ruflo DESLIGADO. ${moved} itens movidos p/ .claude/.ruflo-disabled/`);
  console.log('   MCP ruflo desabilitado, hooks removidos. Memória e chave intactas.');
  console.log('   Vale a partir da PRÓXIMA sessão. Reativar: node scripts/maintenance/ruflo-toggle.mjs enable');
}

function enable() {
  let moved = 0;
  if (move(path.join(quarantine, 'agents'), path.join(claudeDir, 'agents'))) moved++;
  for (const name of RUFLO_COMMANDS) {
    if (move(path.join(quarantine, 'commands', name), path.join(claudeDir, 'commands', name))) moved++;
  }
  for (const name of RUFLO_SKILLS) {
    if (move(path.join(quarantine, 'skills', name), path.join(claudeDir, 'skills', name))) moved++;
  }
  // reabilita MCP
  const localPath = path.join(claudeDir, 'settings.local.json');
  const local = readJson(localPath) || {};
  if (Array.isArray(local.disabledMcpjsonServers)) {
    local.disabledMcpjsonServers = local.disabledMcpjsonServers.filter((s) => s !== 'ruflo');
    if (local.disabledMcpjsonServers.length === 0) delete local.disabledMcpjsonServers;
    writeJson(localPath, local);
  }
  // restaura hooks
  const settingsPath = path.join(claudeDir, 'settings.json');
  const backupPath = path.join(quarantine, 'settings.full.json');
  if (fs.existsSync(backupPath)) {
    writeJson(settingsPath, readJson(backupPath));
    fs.rmSync(backupPath, { force: true });
  }
  console.log(`✅ ruflo RELIGADO. ${moved} itens restaurados. Vale a partir da PRÓXIMA sessão.`);
}

function status() {
  const disabled = fs.existsSync(quarantine);
  const local = readJson(path.join(claudeDir, 'settings.local.json')) || {};
  const mcpOff = (local.disabledMcpjsonServers || []).includes('ruflo');
  console.log(`Quarentena .ruflo-disabled existe: ${disabled ? 'sim' : 'não'}`);
  console.log(`MCP ruflo desabilitado: ${mcpOff ? 'sim' : 'não'}`);
  console.log(`Estado: ruflo ${disabled || mcpOff ? 'DESLIGADO (sessões leves)' : 'LIGADO (sessões pesadas)'}`);
}

if (action === 'disable') disable();
else if (action === 'enable') enable();
else status();
