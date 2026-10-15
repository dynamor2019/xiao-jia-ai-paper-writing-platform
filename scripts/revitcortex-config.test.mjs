import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { evaluate } from '@deepseek-ai/cordis-plugin-loader';
import { parse } from 'yaml';

const profile = parse(readFileSync(new URL('../config/dsh/web/cordis.patch.yml', import.meta.url), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (expr) => ({ expr }) }],
});
const entry = profile.flatMap((item) => item.insert || []).find((item) => item.id === 'revitcortex-mcp');

/** Resolve the same JS expressions as the runtime loader without launching Revit. */
function resolve_entry(env, platform = 'win32') {
  const ctx = { process: { env, platform } };
  return {
    disabled: evaluate(ctx, entry.disabled.expr),
    command: evaluate(ctx, entry.config.command.expr),
    cwd: evaluate(ctx, entry.config.cwd.expr),
  };
}

test('Revit MCP is opt-in and disabled outside Windows', () => {
  assert.equal(resolve_entry({ USERPROFILE: 'C:/Users/Other' }).disabled, true);
  assert.equal(resolve_entry({ REVITCORTEX_ENABLED: '1' }, 'linux').disabled, true);
  assert.equal(resolve_entry({ REVITCORTEX_ENABLED: '0' }).disabled, true);
  assert.equal(entry.config.failOnStartupError, false);
  assert.equal(entry.config.reconnect.enabled, false);
});

test('Revit MCP resolves the actual user home rather than a developer path', () => {
  const result = resolve_entry({ USERPROFILE: 'C:/Users/Another User', REVITCORTEX_ENABLED: '1' });
  assert.equal(result.disabled, false);
  assert.equal(result.cwd, 'C:/Users/Another User/.revitcortex/server');
  assert.equal(result.command, `${result.cwd}/RevitCortex.Server.exe`);
  assert.equal(entry.config.transport, 'stdio');
});

test('Revit MCP accepts a custom server directory without a shell command', () => {
  const result = resolve_entry({ REVITCORTEX_ENABLED: '1', REVITCORTEX_SERVER_DIR: 'D:/My Tools/Cortex' });
  assert.equal(result.cwd, 'D:/My Tools/Cortex');
  assert.equal(result.command, 'D:/My Tools/Cortex/RevitCortex.Server.exe');
});
