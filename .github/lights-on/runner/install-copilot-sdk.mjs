import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCopilotTools } from './install-copilot-tools.mjs';

export function installCopilotSdk(directory) {
  return installCopilotTools(directory, 'sdk');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--directory') {
      throw new Error('Usage: install-copilot-sdk.mjs --directory ABSOLUTE_PATH');
    }
    installCopilotSdk(process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
