import { describe, expect, it, vi } from 'vitest';
import { warmUpBackend } from '../../../src/server/engine.js';
import type { Engine } from '../../../src/server/engine.js';

const noSleep = async () => {};
// Minimal {search, lifecycle.listTransports} stand-in for the warm-up.
const engineLike = (search: Engine['search'], listTransports: () => Promise<unknown>) =>
  ({ search, lifecycle: { listTransports } }) as unknown as Pick<Engine, 'search' | 'lifecycle'>;

describe('warmUpBackend', () => {
  it('loops search until it yields a hit, then warms the CTS path once', async () => {
    let i = 0;
    const search = vi.fn(async () => (i++ < 2 ? [] : [{ name: 'CL_ABAP_TYPEDESCR' }])) as unknown as Engine['search'];
    const listTransports = vi.fn(async () => ({ transports: [] }));
    await warmUpBackend(engineLike(search, listTransports), { sleep: noSleep });
    expect(search).toHaveBeenCalledTimes(3); // empty, empty, hit → stop
    expect(listTransports).toHaveBeenCalledWith({ limit: 1 });
  });

  it('swallows cold search throws and still warms CTS, bounded by attempts', async () => {
    const search = vi.fn(async () => {
      throw new Error('Internal error');
    }) as unknown as Engine['search'];
    const listTransports = vi.fn(async () => ({}));
    await warmUpBackend(engineLike(search, listTransports), { attempts: 3, sleep: noSleep });
    expect(search).toHaveBeenCalledTimes(3); // exhausts attempts without throwing
    expect(listTransports).toHaveBeenCalledTimes(1);
  });

  it('never rejects, even if the CTS warm-up itself fails', async () => {
    const search = vi.fn(async () => [{ name: 'X' }]) as unknown as Engine['search'];
    const listTransports = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(warmUpBackend(engineLike(search, listTransports), { sleep: noSleep })).resolves.toBeUndefined();
  });
});
