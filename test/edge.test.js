import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForEdge } from '../src/edge.js';

const url = 'https://example.trycloudflare.com';

describe('waitForEdge', () => {
  it('is ready after the edge stops answering 5xx', async () => {
    const statuses = [530, 530, 200];
    const seen = [];
    const result = await waitForEdge(url, {
      intervalMs: 5,
      fetchImpl: async (target) => {
        seen.push(target);
        return { status: statuses.shift() };
      }
    });
    assert.equal(result.ready, true);
    assert.equal(seen.length, 3);
    assert.equal(seen[0], `${url}/__devhop/inspect`);
  });

  it('gives up at the timeout without rejecting', async () => {
    const result = await waitForEdge(url, {
      timeoutMs: 60,
      intervalMs: 10,
      fetchImpl: async () => ({ status: 530 })
    });
    assert.equal(result.ready, false);
    assert.ok(result.ms >= 40);
  });

  it('retries when a probe throws', async () => {
    let calls = 0;
    const result = await waitForEdge(url, {
      intervalMs: 5,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error('ENOTFOUND');
        return { status: 404 };
      }
    });
    assert.equal(result.ready, true);
    assert.equal(calls, 3);
  });
});
