import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/store/local';

describe('safe default settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the model built-in search instead of an unconfigured external credential', () => {
    expect(DEFAULT_SETTINGS.searchProvider).toBe('provider');
    expect(DEFAULT_SETTINGS.serperApiKey).toBe('');
  });

  it('migrates the former shared-key selection to built-in search when the model supports it', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(JSON.stringify({
        kind: 'glm',
        searchProvider: 'serper',
        serperApiKey: '',
      })),
    });

    expect(loadSettings().searchProvider).toBe('provider');
  });

  it('preserves Serper when the user has provided their own key', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(JSON.stringify({
        kind: 'glm',
        searchProvider: 'serper',
        serperApiKey: 'user-owned-key',
      })),
    });

    expect(loadSettings().searchProvider).toBe('serper');
  });
});
