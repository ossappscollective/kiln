import { testErrorMessage } from '../../lib/credentials.ts';
import type { TestResult } from '../../lib/types.ts';

export type TesterStatus = 'idle' | 'testing' | 'done' | 'error';

/**
 * The state of one "Test connection" button. `key` says what was tested (a caller-chosen
 * fingerprint of the input), so a result can be hidden once the input has changed. A newer
 * run, or a reset, makes an older request's answer be ignored.
 */
export function createTester() {
  let status = $state<TesterStatus>('idle');
  let result = $state<TestResult | null>(null);
  let error = $state('');
  let key = $state('');
  let latest = 0;

  return {
    get status() {
      return status;
    },
    get result() {
      return result;
    },
    get error() {
      return error;
    },
    get key() {
      return key;
    },
    async run(forKey: string, test: () => Promise<TestResult>) {
      if (status === 'testing') return;
      const mine = ++latest;
      status = 'testing';
      result = null;
      error = '';
      key = forKey;
      try {
        const outcome = await test();
        if (mine !== latest) return;
        result = outcome;
        status = 'done';
      } catch (e) {
        if (mine !== latest) return;
        error = testErrorMessage(e);
        status = 'error';
      }
    },
    reset() {
      latest++;
      status = 'idle';
      result = null;
      error = '';
      key = '';
    },
  };
}

export type Tester = ReturnType<typeof createTester>;
