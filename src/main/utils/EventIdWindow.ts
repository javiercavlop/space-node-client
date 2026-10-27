import { EventDeduplicationOptions } from '../types/events';

/**
 * Remembers the `eventId`s seen recently, so that a second copy of one SPACE event can be
 * dropped. Memory is bounded: an id is forgotten `windowMs` after it was first seen, or earlier
 * when more than `maxEntries` ids are held (oldest first).
 *
 * SPACE sends one copy of an event per connection and the copies of one event are emitted
 * together, so a short window is enough. Ids are compared for equality only; they do not order
 * events.
 */
export class EventIdWindow {
  public static readonly DEFAULT_MAX_ENTRIES = 10_000;
  public static readonly DEFAULT_WINDOW_MS = 10 * 60_000;

  public readonly maxEntries: number;
  public readonly windowMs: number;

  /** id -> time it was first seen; a Map keeps insertion order, so the oldest id comes first. */
  private readonly seen = new Map<string, number>();

  constructor(
    options: Omit<EventDeduplicationOptions, 'enabled'> = {},
    private readonly now: () => number = Date.now
  ) {
    const maxEntries = options.maxEntries ?? EventIdWindow.DEFAULT_MAX_ENTRIES;
    const windowMs = options.windowMs ?? EventIdWindow.DEFAULT_WINDOW_MS;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError(`eventDeduplication.maxEntries must be a positive integer, got ${maxEntries}`);
    }
    if (!(windowMs > 0)) {
      throw new RangeError(`eventDeduplication.windowMs must be a positive number, got ${windowMs}`);
    }
    this.maxEntries = maxEntries;
    this.windowMs = windowMs;
  }

  /** The number of ids currently remembered. */
  get size(): number {
    return this.seen.size;
  }

  /**
   * Records `eventId` and returns `true` the first time it is seen within the window, `false` for
   * a repeat (which the caller should drop).
   */
  accept(eventId: string): boolean {
    const now = this.now();
    this.evictExpired(now);
    if (this.seen.has(eventId)) {
      return false;
    }
    this.seen.set(eventId, now);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** Forgets every id. */
  clear(): void {
    this.seen.clear();
  }

  private evictExpired(now: number): void {
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt <= this.windowMs) {
        break;
      }
      this.seen.delete(id);
    }
  }
}
