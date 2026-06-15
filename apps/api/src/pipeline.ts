import { DexError, type EngineEvent } from '@dex/shared';
import type { Projector } from '@dex/db';

export interface EventSink {
  dispatch(events: EngineEvent[]): void;
}

export interface PipelineOptions {
  /** Called once, after a projection failure poisons the pipeline (fail-stop). */
  onPoison?: (err: unknown) => void;
}

/**
 * Serialized command pipeline: every engine mutation runs inside a single
 * FIFO queue — the synchronous engine op, then durable projection (PGlite),
 * then WS broadcast — so persisted/broadcast event order always matches
 * engine order and DB writes never interleave.
 *
 * DURABILITY (fail-stop): the engine op mutates in-memory state and advances
 * `seq` BEFORE the durable projection runs. If `applyBatch` throws, the engine
 * has already committed but the projection has not — engine and durable store
 * have diverged. Continuing would run later ops on a diverged engine and
 * silently corrupt the projection. So a projection failure POISONS the
 * pipeline: every subsequent run/exec/runDb rejects immediately, and `onPoison`
 * fires so the process can halt and let boot-restore re-establish a consistent
 * engine from the last durable watermark.
 */
export class Pipeline {
  #q: Promise<unknown> = Promise.resolve();
  #poisoned: unknown = null;
  readonly #onPoison: ((err: unknown) => void) | undefined;

  constructor(
    readonly projector: Projector,
    readonly sink: EventSink,
    opts: PipelineOptions = {},
  ) {
    this.#onPoison = opts.onPoison;
  }

  get poisoned(): boolean {
    return this.#poisoned !== null;
  }

  #poison(err: unknown): void {
    if (this.#poisoned !== null) return;
    this.#poisoned = err;
    this.#onPoison?.(err);
  }

  /** Run an engine op returning [result, events]. Rejects with the op's error. */
  run<T>(fn: () => readonly [T, EngineEvent[]]): Promise<T> {
    if (this.#poisoned !== null) {
      return Promise.reject(new DexError('INTERNAL', 'pipeline halted after a projection failure'));
    }
    const task = this.#q.then(async () => {
      const [result, events] = fn();
      if (events.length > 0) {
        try {
          await this.projector.applyBatch(events);
        } catch (err) {
          // engine already mutated + advanced seq; durable projection failed →
          // fail-stop so no later op runs on the now-diverged engine
          this.#poison(err);
          throw err;
        }
        this.sink.dispatch(events);
      }
      return result;
    });
    this.#q = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Run an engine op that only returns events. */
  exec(fn: () => EngineEvent[]): Promise<EngineEvent[]> {
    return this.run(() => {
      const events = fn();
      return [events, events] as const;
    });
  }

  /**
   * Enqueue a DB-only async task (no engine mutation, no events) on the SAME
   * FIFO queue, so it never interleaves with projector writes. Used for
   * retention GC of the durable projection.
   */
  runDb(fn: () => Promise<void>): Promise<void> {
    if (this.#poisoned !== null) {
      return Promise.reject(new DexError('INTERNAL', 'pipeline halted after a projection failure'));
    }
    const task = this.#q.then(() => fn());
    this.#q = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** Resolves after everything currently enqueued has been persisted. */
  async drain(): Promise<void> {
    await this.#q;
  }
}
