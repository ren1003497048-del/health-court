import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSerperSearch } from '../src/providers/serper';

describe('Serper search credentials', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to search without a user-provided key and never calls fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(createSerperSearch().search('卫生法庭')).rejects.toThrow(/SERPER_KEY_REQUIRED.*设置/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses only the user-provided key for Serper requests', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ organic: [] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await createSerperSearch({ userApiKey: 'user-owned-key' }).search('connectivity test');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({ 'X-API-KEY': 'user-owned-key' });
  });
});
