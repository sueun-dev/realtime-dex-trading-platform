import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@dex/shared';
import type { Projector } from '@dex/db';
import { Pipeline, type EventSink } from '../src/pipeline.js';

function evt(seq: number): EngineEvent {
  return { kind: 'markPrice', seq, ts: seq, marketId: 'BTC-PERP', price: 1n };
}

function makePipeline(applyBatch: (e: EngineEvent[]) => Promise<void>) {
  const dispatched: EngineEvent[][] = [];
  const sink: EventSink = { dispatch: (e) => dispatched.push(e) };
  const projector = { applyBatch } as unknown as Projector;
  const onPoison = vi.fn();
  return { pipeline: new Pipeline(projector, sink, { onPoison }), dispatched, onPoison };
}

describe('Pipeline fail-stop on projection failure', () => {
  it('happy path persists then broadcasts, in order', async () => {
    const seen: EngineEvent[][] = [];
    const { pipeline, dispatched } = makePipeline(async (e) => {
      seen.push(e);
    });
    await pipeline.exec(() => [evt(1)]);
    expect(seen).toEqual([[evt(1)]]);
    expect(dispatched).toEqual([[evt(1)]]); // broadcast only after persist resolved
  });

  it('poisons the pipeline when applyBatch throws — never broadcasts the failed batch', async () => {
    const { pipeline, dispatched, onPoison } = makePipeline(async () => {
      throw new Error('PGlite down');
    });
    await expect(pipeline.exec(() => [evt(1)])).rejects.toThrow('PGlite down');
    expect(dispatched).toEqual([]); // failed batch is NOT broadcast as if durable
    expect(pipeline.poisoned).toBe(true);
    expect(onPoison).toHaveBeenCalledOnce();
  });

  it('rejects every subsequent op after poisoning (no op runs on the diverged engine)', async () => {
    const { pipeline } = makePipeline(async () => {
      throw new Error('boom');
    });
    await expect(pipeline.exec(() => [evt(1)])).rejects.toThrow('boom');

    // the engine op must NOT even execute once poisoned
    const laterOp = vi.fn(() => [evt(2)] as EngineEvent[]);
    await expect(pipeline.exec(laterOp)).rejects.toThrow(/halted/);
    expect(laterOp).not.toHaveBeenCalled();

    await expect(pipeline.runDb(async () => {})).rejects.toThrow(/halted/);
  });

  it('onPoison fires exactly once even across multiple failures', async () => {
    const { pipeline, onPoison } = makePipeline(async () => {
      throw new Error('x');
    });
    await expect(pipeline.exec(() => [evt(1)])).rejects.toThrow();
    await expect(pipeline.exec(() => [evt(2)])).rejects.toThrow();
    expect(onPoison).toHaveBeenCalledOnce();
  });
});
