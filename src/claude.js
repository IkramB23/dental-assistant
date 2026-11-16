// Calls Claude through the locally installed Claude Code CLI in headless mode (-p).
// Auth = the Claude subscription you are logged into with `claude` (no API key needed).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false };
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return { cmd: exe, shell: false };
  }
  return { cmd: 'claude', shell: process.platform === 'win32' };
}

/**
 * Ask Claude for a JSON object matching `schema`.
 * The (long) user prompt goes through stdin to avoid command-line length limits.
 */
function askClaudeJSON({ systemPrompt, userPrompt, schema, model = process.env.CLAUDE_MODEL || 'sonnet', timeoutMs = 240000 }) {
  const { cmd, shell } = resolveClaudeBin();
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', systemPrompt,
    '--tools', '',               // pure text-in / JSON-out: no file, shell or web tools
    '--strict-mcp-config',       // ignore any MCP servers
    '--setting-sources', '',     // ignore user/project settings and CLAUDE.md
    '--no-session-persistence',
  ];

  // Make sure the subscription login is used, not a pay-as-you-go API key.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell, env, cwd: require('os').tmpdir(), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude timed out')); }, timeoutMs);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(timer); reject(new Error('Cannot start Claude Code CLI: ' + e.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      let res;
      try { res = JSON.parse(out); } catch {
        return reject(new Error(`Claude CLI failed (exit ${code}): ${(err || out).slice(0, 800)}`));
      }
      if (res.is_error) return reject(new Error('Claude error: ' + (res.result || res.subtype)));
      if (res.structured_output) return resolve(res.structured_output);
      try { return resolve(JSON.parse(res.result)); } catch {
        return reject(new Error('Claude did not return valid JSON: ' + String(res.result).slice(0, 500)));
      }
    });
    child.stdin.end(userPrompt);
  });
}

module.exports = { askClaudeJSON };
