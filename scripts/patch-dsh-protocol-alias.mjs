import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reproduce the existing OpenAI-completions alias without rewriting provider settings. */
export function patchOpenAiProtocolAlias(target = join(process.cwd(), 'node_modules',
  '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')) {
  const bytes = readFileSync(target);
  let source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const mappings = [
    ['\t"anthropic-messages": anthropicMessagesApi',
      '\t"anthropic-messages": anthropicMessagesApi,', '\t"openai": openAICompletionsApi'],
    ['\tapi: z.union(supportedProtocols()),',
      '\tapi: z.union([...supportedProtocols(), "openai"]),'],
    ['\t"openai-responses"' + eol + ']);',
      '\t"openai-responses",', '\t"openai"', ']);'],
  ];
  let changed = false;
  for (const [needle, ...lines] of mappings) {
    const replacement = lines.join(eol);
    if (source.includes(replacement)) continue;
    const index = source.indexOf(needle);
    if (index < 0 || source.indexOf(needle, index + needle.length) >= 0) {
      throw new Error('Cannot uniquely locate reviewed protocol alias; refusing partial patch');
    }
    source = source.replace(needle, replacement);
    changed = true;
  }
  if (changed) writeFileSync(target, source, 'utf8');
  return changed;
}
