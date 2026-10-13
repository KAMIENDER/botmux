import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCommand } from './registry.js';
import { parseDebugModelsJson } from './model-catalog-json.js';
import type { CliAdapter } from './types.js';

/**
 * Thin adapter paired with RemoteRunnerBackend.
 *
 * The backend owns the structured JSONL protocol and receives turns through
 * SessionBackend.submitTurn(). This adapter only supplies the provider binary
 * and ordinary launch args; its terminal write fallback rejects instead of
 * silently degrading a structured turn into keystrokes.
 */
export function createRemoteRunnerAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'botmux-remote-runner';
  let cachedBin: string | undefined;
  return {
    id: 'remote-runner',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    allowExtraArgs: true,
    buildArgs() { return []; },
    buildResumeCommand() { return null; },
    // Optional CLI metadata entrypoint, separate from the session JSONL channel.
    // Reuse the other adapters' catalog format; older providers fail soft.
    async detectModels(): Promise<readonly string[] | null> {
      try {
        const { stdout } = await promisify(execFile)(this.resolvedBin, ['debug', 'models'], {
          timeout: 8000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        const models = parseDebugModelsJson(stdout);
        return models.length > 0 ? models : null;
      } catch {
        return null;
      }
    },
    async writeInput() {
      return {
        submitted: false,
        submissionDisposition: 'untouched' as const,
        failureReason: 'remote-runner requires a structured backend turn channel',
      };
    },
    supportsTypeAhead: false,
    reliableTurnTerminal: true,
    completionPattern: undefined,
    systemHints: [],
    altScreen: false,
  };
}

export const create = createRemoteRunnerAdapter;
