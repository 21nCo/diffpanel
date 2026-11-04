/** Prefix of each kind of id the store assigns. */
export const ID_PREFIXES = Object.freeze({ feedback: "fb", reply: "rp", attachment: "at" } as const);

export type IdKind = keyof typeof ID_PREFIXES;

const TIME_WIDTH = 9;
const SEQUENCE_WIDTH = 4;
const MAX_TIME = 36 ** TIME_WIDTH - 1;
const MAX_SEQUENCE = 36 ** SEQUENCE_WIDTH - 1;
const GENERATED_ID = /^(?:fb|rp|at)_([0-9a-z]{9})_([0-9a-z]{4})$/;

/** One step of the store clock: a millisecond time and a sequence number within it. */
export interface Tick {
  readonly ms: number;
  readonly sequence: number;
}

function compare(left: Tick, right: Tick): number {
  return left.ms - right.ms || left.sequence - right.sequence;
}

/**
 * The store's logical clock. Every tick is strictly greater than every earlier tick and every observed id or
 * timestamp, even when the wall clock stands still or moves backwards, so ids and timestamps are monotonic
 * across restarts once the store has observed its existing records.
 *
 * Ids are `<prefix>_<time>_<sequence>` in fixed-width lowercase base 36, so their byte order is their
 * creation order and they always satisfy the `iterbar` id rules.
 */
export class StoreClock {
  #last: Tick = { ms: 0, sequence: -1 };
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Raises the clock to at least `tick`. */
  #raise(tick: Tick): void {
    if (compare(tick, this.#last) > 0) this.#last = tick;
  }

  /** Raises the clock past an existing id; ids the store did not generate are ignored. */
  observeId(id: string): void {
    const match = GENERATED_ID.exec(id);
    if (match?.[1] && match[2]) this.#raise({ ms: parseInt(match[1], 36), sequence: parseInt(match[2], 36) });
  }

  /** Raises the clock to at least an existing ISO timestamp. */
  observeTimestamp(timestamp: string): void {
    const ms = Date.parse(timestamp);
    if (Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_TIME) this.#raise({ ms, sequence: -1 });
  }

  /** The next tick: the wall clock, unless it has not passed the last tick. */
  tick(): Tick {
    const wall = Math.floor(this.#now());
    if (!Number.isSafeInteger(wall) || wall < 0) throw new RangeError(`The store clock returned ${wall}`);
    let next: Tick = wall > this.#last.ms
      ? { ms: wall, sequence: 0 }
      : { ms: this.#last.ms, sequence: this.#last.sequence + 1 };
    if (next.sequence > MAX_SEQUENCE) next = { ms: next.ms + 1, sequence: 0 };
    if (next.ms > MAX_TIME) throw new RangeError("The store clock is past the largest id time");
    this.#last = next;
    return next;
  }
}

/** The id of `kind` for `tick`. */
export function formatId(kind: IdKind, tick: Tick): string {
  return `${ID_PREFIXES[kind]}_${tick.ms.toString(36).padStart(TIME_WIDTH, "0")}_${tick.sequence
    .toString(36)
    .padStart(SEQUENCE_WIDTH, "0")}`;
}

/** The ISO timestamp of `tick`. */
export function formatTimestamp(tick: Tick): string {
  return new Date(tick.ms).toISOString();
}
