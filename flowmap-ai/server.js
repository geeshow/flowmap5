#!/usr/bin/env node
// server.js — local stand-in for the production AI-model API.
//
// In production, change-impact analysis calls a hosted AI-model endpoint. That
// endpoint is unavailable here, so this server mimics it: it accepts the same
// request shape and, instead of calling a hosted model, shells out to the local
// `claude` CLI in print mode. To migrate to production, the driver simply points
// at the real API URL — nothing else changes.
//
//   POST /analyze   { prompt, system?, repoPath?, model?, timeoutMs? }
//                 → { markdown, durationMs, repoPath, exitCode }
//   GET  /health  → { ok: true, claude: "<version>" }
//
// claude flags: read-only tools only (Read/Grep/Glob/git log|show), run with
// cwd = repoPath so the model can inspect full source around the diffs.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.FLOWMAP_AI_PORT || 8790);
const DEFAULT_TIMEOUT = Number(process.env.FLOWMAP_AI_TIMEOUT_MS || 600000);
const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)'];

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function runClaude({ prompt, system, repoPath, model, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const cwd = repoPath && existsSync(repoPath) ? repoPath : process.cwd();
    const args = [
      '-p',
      '--allowedTools',
      ...READONLY_TOOLS,
      '--permission-mode',
      'bypassPermissions',
    ];
    if (system) args.push('--append-system-prompt', system);
    if (model) args.push('--model', model);

    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 2000)}`));
      } else {
        resolve({ markdown: out.trim(), exitCode: code, cwd });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { ok: true, claude: claudeVersion() });
  }
  if (req.method === 'POST' && req.url === '/analyze') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.prompt) return json(400, { error: 'prompt required' });
      const started = Date.now();
      const r = await runClaude({
        prompt: body.prompt,
        system: body.system,
        repoPath: body.repoPath,
        model: body.model,
        timeoutMs: body.timeoutMs || DEFAULT_TIMEOUT,
      });
      return json(200, {
        markdown: r.markdown,
        exitCode: r.exitCode,
        repoPath: r.cwd,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      return json(500, { error: String(e.message || e) });
    }
  }
  json(404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[flowmap-ai] AI-model stand-in listening on http://localhost:${PORT}`);
  console.log(`[flowmap-ai] claude: ${claudeVersion() || 'NOT FOUND on PATH'}`);
});
