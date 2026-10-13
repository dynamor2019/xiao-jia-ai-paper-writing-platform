/** Report an optional patch failure without claiming it is already installed. */
export function runStartupPatch(label, patch, logger = console) {
  try {
    const result = patch();
    const status = typeof result === 'number' ? `更新 ${result} 项` : result ? '已更新' : '无需更新';
    logger.log(`${label}已检查（${status}）。`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`${label}未应用：${message}`);
    return undefined;
  }
}
