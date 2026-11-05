import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT } from './project-paths.mjs';

const CLIENT_BUNDLE = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js');
const TIMEOUT_MARKER = 'model catalog request timed out';
const LATENCY_MARKER = 'xiaojia-model-latency-v1';

function replaceOnce(source, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`无法唯一定位模型列表修复点: ${needle}`);
  }
  return source.replace(needle, replacement);
}

function replaceWhenPresent(source, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0) return source;
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`无法唯一定位模型列表修复点: ${needle}`);
  }
  return source.replace(needle, replacement);
}

export function patchModelCatalog(filePath = CLIENT_BUNDLE) {
  if (!existsSync(filePath)) return false;
  let source = readFileSync(filePath, 'utf8');
  if (source.includes(TIMEOUT_MARKER)) {
    const upgraded = source.replaceAll(
      'new Error("model catalog request timed out")), 10000)',
      'new Error("model catalog request timed out")), 30000)',
    );
    if (upgraded === source) return false;
    writeFileSync(filePath, upgraded, 'utf8');
    return true;
  }

  source = replaceOnce(
    source,
    'const operation = this.ctx.remote.session.modelCatalog().then((response) => {',
    `const operation = Promise.race([this.ctx.remote.session.modelCatalog(), new Promise((_, reject) => setTimeout(() => reject(new Error("${TIMEOUT_MARKER}")), 30000))]).then((response) => {`,
  );
  source = replaceOnce(
    source,
    'if (catalog.status !== "ready" || catalog.value === null || projected === void 0) {',
    'if (catalog.status !== "ready" || catalog.value === null) {',
  );
  source = replaceWhenPresent(source, 'const current = projected.next ?? catalog.value.default;', 'const current = projected?.next ?? catalog.value.default;');
  source = replaceWhenPresent(source, 'const selection = projected.next ?? catalog.value.default;', 'const selection = projected?.next ?? catalog.value.default;');
  writeFileSync(filePath, source, 'utf8');
  return true;
}

export function patchModelLatency(filePath = CLIENT_BUNDLE) {
  if (!existsSync(filePath)) return false;
  let source = readFileSync(filePath, 'utf8');
  if (source.includes(LATENCY_MARKER)) return false;

  source = replaceOnce(source, 'var ModelDirectory = class {', `// ${LATENCY_MARKER}
		const modelLatencies = new Map();
		function latencyKey(provider, model) { return provider + "/" + model; }
		function signalLevel(ms) {
			if (!Number.isFinite(ms) || ms < 0) return 0;
			if (ms <= 800) return 4;
			if (ms <= 1600) return 3;
			if (ms <= 3000) return 2;
			return 1;
		}
		function signalGlyph(ms) {
			const bars = ["\\u2582", "\\u2584", "\\u2586", "\\u2588"];
			const level = signalLevel(ms);
			return level === 0 ? "\\u00b7\\u00b7\\u00b7\\u00b7" : bars.map((bar, index) => index < level ? bar : "\\u00b7").join("");
		}
		function latencyOf(provider, model) { return modelLatencies.get(latencyKey(provider, model)); }
		var ModelDirectory = class {`);
  source = replaceOnce(source, '			dispose() {\n				this.disposed = true;', `			observeLatency(eventSource) {
				let route;
				const steps = new Map();
				const consume = (entries) => {
					let changed = false;
					for (const entry of entries) {
						if (entry.type !== "event") continue;
						const event = entry.event;
						if (event.type === "request/header") route = event.data.header.config;
						const step = event.data?.turn + ":" + event.data?.step;
						if (event.type === "step/start") steps.set(step, event.time);
						if (event.type === "step/end") steps.delete(step);
						if (event.type !== "assistant/chunk" || !steps.has(step) || !route?.provider || !route?.model) continue;
						const elapsed = event.time - steps.get(step);
						steps.delete(step);
						if (!Number.isFinite(elapsed) || elapsed < 0) continue;
						modelLatencies.set(latencyKey(route.provider, route.model), elapsed);
						changed = true;
					}
					if (changed) this.store.update((state) => { state.latencyRevision = (state.latencyRevision || 0) + 1; });
				};
				consume(eventSource.getSnapshot().entries);
				this.latencyStop = eventSource.subscribe(() => {
					const change = eventSource.getSnapshot().change;
					if (change.kind === "replace") { route = void 0; steps.clear(); consume(change.entries); }
					else if (change.kind === "append") consume(change.entries);
				});
			}
			dispose() {
				this.latencyStop?.();
				this.disposed = true;`);
  source = replaceOnce(source, 'live.directories.set(binding, directory);', 'directory.observeLatency(binding.session.eventSource);\n\t\t\t\tlive.directories.set(binding, directory);');
  if (source.includes('const renderModelLabel = (provider, model, placement, selected)')) {
    source = replaceOnce(source, 'fallback: model.badge === void 0 ? model.name :',
      'fallback: model.badge === void 0 ? model.name + " " + signalGlyph(latencyOf(provider.id, model.id)) :');
    source = replaceOnce(source, 'children: model.name\n',
      'children: model.name + " " + signalGlyph(latencyOf(provider.id, model.id))\n');
  } else {
    source = replaceOnce(source, 'className: ModelSelect_module_css_default.triggerLabel,\n\t\t\t\t\t\t\t\tchildren: modelLabel', 'className: ModelSelect_module_css_default.triggerLabel,\n\t\t\t\t\t\t\t\tchildren: modelLabel + (state.current ? " " + signalGlyph(latencyOf(state.current.provider, state.current.model)) : "")');
    source = replaceOnce(source, 'className: ModelSelect_module_css_default.cellValue,\n\t\t\t\t\t\t\t\t\t\tchildren: modelLabel', 'className: ModelSelect_module_css_default.cellValue,\n\t\t\t\t\t\t\t\t\t\tchildren: modelLabel + (state.current ? " " + signalGlyph(latencyOf(state.current.provider, state.current.model)) : "")');
    source = replaceOnce(source, 'children: model.name\n', 'children: model.name + " " + signalGlyph(latencyOf(group.id, model.id))\n');
  }
  source = replaceOnce(source, 'title: model.name,', 'title: model.name + (latencyOf(group.id, model.id) === void 0 ? " · 未测量" : " · 首响应约 " + latencyOf(group.id, model.id) + " ms"),');
  source = replaceOnce(source, 'label: model.name,', 'label: model.name + " " + signalGlyph(latencyOf(group.id, model.id)),');
  source = replaceWhenPresent(source, 'detail: model.description !== void 0 ? `${group.name} · ${model.description}` : group.name,', 'detail: (model.description !== void 0 ? `${group.name} · ${model.description}` : group.name) + (latencyOf(group.id, model.id) === void 0 ? " · 未测量" : " · 首响应约 " + latencyOf(group.id, model.id) + " ms"),');
  source = replaceWhenPresent(source, 'detail: description !== void 0 ? `${name} · ${description}` : name,', 'detail: (description !== void 0 ? `${name} · ${description}` : name) + (latencyOf(group.id, model.id) === void 0 ? " · 未测量" : " · 首响应约 " + latencyOf(group.id, model.id) + " ms"),');
  writeFileSync(filePath, source, 'utf8');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(patchModelCatalog() ? '模型列表加载修复已安装。' : '模型列表加载修复已存在或未安装。');
  console.log(patchModelLatency() ? '模型延迟信号已安装。' : '模型延迟信号已存在或未安装。');
}
