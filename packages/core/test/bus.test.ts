import { afterEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../src/index.js';

describe('bus', () => {
  afterEach(() => bus._reset());

  it('emit fans out to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.emit({ x: 1 });
    expect(a).toHaveBeenCalledWith({ x: 1 });
    expect(b).toHaveBeenCalledWith({ x: 1 });
  });

  it('subscribe is idempotent', () => {
    const a = vi.fn();
    bus.subscribe(a);
    bus.subscribe(a);
    bus.emit('e');
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes a subscriber', () => {
    const a = vi.fn();
    bus.subscribe(a);
    bus.unsubscribe(a);
    bus.emit('e');
    expect(a).not.toHaveBeenCalled();
  });

  it('every subscriber runs even if one throws; first error is re-thrown', () => {
    const order: string[] = [];
    const first = () => {
      order.push('first');
      throw new Error('boom-first');
    };
    const second = () => {
      order.push('second');
      throw new Error('boom-second');
    };
    const third = () => order.push('third');
    bus.subscribe(first);
    bus.subscribe(second);
    bus.subscribe(third);
    expect(() => bus.emit('e')).toThrow('boom-first');
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('a subscriber can unsubscribe during emit without corrupting iteration', () => {
    const seen: string[] = [];
    const self = () => {
      seen.push('self');
      bus.unsubscribe(self);
    };
    const other = () => seen.push('other');
    bus.subscribe(self);
    bus.subscribe(other);
    bus.emit('e');
    bus.emit('e');
    expect(seen).toEqual(['self', 'other', 'other']);
  });
});
