import { describe, expect, it, vi } from 'vitest';
import { PhotoStore, fileFingerprint, type PhotoStoreChange } from './store';
import { makeFile, makeNewPhoto } from './test-helpers';

describe('PhotoStore', () => {
  it('adds photos, included by default, with a stable unique id and aspect', () => {
    const store = new PhotoStore();
    const [a, b] = store.addPhotos([
      makeNewPhoto('a.jpg', 400, 300),
      makeNewPhoto('b.jpg', 300, 400),
    ]);
    expect(a?.id).not.toBe(b?.id);
    expect(a?.included).toBe(true);
    expect(a?.aspect).toBeCloseTo(4 / 3);
    expect(b?.aspect).toBeCloseTo(3 / 4);
    expect(store.getPhotos().map((p) => p.file.name)).toEqual([
      'a.jpg',
      'b.jpg',
    ]);
    expect(store.getSelectedCount()).toBe(2);
    expect(store.getTotalCount()).toBe(2);
  });

  it('keeps the original file object', () => {
    const store = new PhotoStore();
    const input = makeNewPhoto('a.jpg');
    const [photo] = store.addPhotos([input]);
    expect(photo?.file).toBe(input.file);
  });

  it('does not reuse ids', () => {
    const store = new PhotoStore();
    const ids = [
      ...store.addPhotos([makeNewPhoto('a.jpg')]),
      ...store.addPhotos([makeNewPhoto('b.jpg')]),
    ].map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('skips a file that was already added (same name, size, modified time)', () => {
    const store = new PhotoStore();
    store.addPhotos([
      { ...makeNewPhoto('a.jpg'), file: makeFile('a.jpg', 10, 5) },
    ]);
    const again = store.addPhotos([
      { ...makeNewPhoto('a.jpg'), file: makeFile('a.jpg', 10, 5) },
      { ...makeNewPhoto('a.jpg'), file: makeFile('a.jpg', 11, 5) },
      { ...makeNewPhoto('a.jpg'), file: makeFile('a.jpg', 10, 6) },
      { ...makeNewPhoto('c.jpg'), file: makeFile('c.jpg', 10, 5) },
    ]);
    expect(again).toHaveLength(3);
    expect(store.getTotalCount()).toBe(4);
    expect(store.hasFile(makeFile('a.jpg', 10, 5))).toBe(true);
    expect(store.hasFile(makeFile('zzz.jpg', 10, 5))).toBe(false);
    expect(fileFingerprint(makeFile('a.jpg', 10, 5))).not.toBe(
      fileFingerprint(makeFile('a.jpg', 10, 6)),
    );
  });

  it('rejects non-positive dimensions', () => {
    const store = new PhotoStore();
    expect(() => store.addPhotos([makeNewPhoto('a.jpg', 0, 10)])).toThrow(
      RangeError,
    );
    expect(() =>
      store.addPhotos([makeNewPhoto('a.jpg', 10, Number.NaN)]),
    ).toThrow(RangeError);
    expect(store.getTotalCount()).toBe(0);
  });

  it('toggles one photo and updates the selected count', () => {
    const store = new PhotoStore();
    const [a] = store.addPhotos([makeNewPhoto('a.jpg'), makeNewPhoto('b.jpg')]);
    store.setIncluded(a?.id ?? '', false);
    expect(store.getSelectedCount()).toBe(1);
    expect(store.getPhoto(a?.id ?? '')?.included).toBe(false);
    store.setIncluded(a?.id ?? '', true);
    expect(store.getSelectedCount()).toBe(2);
  });

  it('supports add all and remove all', () => {
    const store = new PhotoStore();
    store.addPhotos([makeNewPhoto('a.jpg'), makeNewPhoto('b.jpg')]);
    store.setAllIncluded(false);
    expect(store.getSelectedCount()).toBe(0);
    expect(store.getTotalCount()).toBe(2);
    store.setAllIncluded(true);
    expect(store.getSelectedCount()).toBe(2);
  });

  it('exposes included photos in the shape assignPhotos takes', () => {
    const store = new PhotoStore();
    const [a, b] = store.addPhotos([
      makeNewPhoto('a.jpg', 200, 100),
      makeNewPhoto('b.jpg', 100, 200),
    ]);
    store.setIncluded(a?.id ?? '', false);
    expect(store.getPlacementPhotos()).toEqual([{ id: b?.id, aspect: 0.5 }]);
  });

  it('notifies subscribers of changes, and only real changes', () => {
    const store = new PhotoStore();
    const changes: PhotoStoreChange[] = [];
    const unsubscribe = store.subscribe((change) => changes.push(change));

    const [a, b] = store.addPhotos([
      makeNewPhoto('a.jpg'),
      makeNewPhoto('b.jpg'),
    ]);
    store.setIncluded(a?.id ?? '', true); // already included: no-op
    store.setIncluded('nope', false); // unknown: no-op
    store.setAllIncluded(true); // already all included: no-op
    store.addPhotos([]); // nothing added: no-op
    store.setIncluded(b?.id ?? '', false);
    store.setAllIncluded(false); // only a changes
    store.setAllIncluded(true);

    expect(changes).toEqual([
      { kind: 'added', ids: [a?.id, b?.id] },
      { kind: 'included', ids: [b?.id] },
      { kind: 'included', ids: [a?.id] },
      { kind: 'included', ids: [a?.id, b?.id] },
    ]);

    unsubscribe();
    store.setAllIncluded(false);
    expect(changes).toHaveLength(4);
  });

  it('gives subscribers a consistent snapshot and does not mutate old arrays', () => {
    const store = new PhotoStore();
    store.addPhotos([makeNewPhoto('a.jpg')]);
    const before = store.getPhotos();
    const listener = vi.fn(() => {
      expect(store.getSelectedCount()).toBe(0);
    });
    store.subscribe(listener);
    store.setAllIncluded(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(before[0]?.included).toBe(true);
    expect(store.getPhotos()).not.toBe(before);
  });

  describe('batch include/exclude', () => {
    it('includes or excludes many photos with one change event', () => {
      const store = new PhotoStore();
      const [a, b, c] = store.addPhotos([
        makeNewPhoto('a.jpg'),
        makeNewPhoto('b.jpg'),
        makeNewPhoto('c.jpg'),
      ]);
      const changes: PhotoStoreChange[] = [];
      store.subscribe((change) => changes.push(change));
      store.setIncluded([a?.id ?? '', c?.id ?? '', 'unknown'], false);
      expect(changes).toEqual([{ kind: 'included', ids: [a?.id, c?.id] }]);
      expect(store.getIncludedIds()).toEqual([b?.id]);
      store.setIncluded(new Set([a?.id ?? '', b?.id ?? '']), true); // only a changes
      expect(changes).toHaveLength(2);
      expect(store.getIncludedIds()).toEqual([a?.id, b?.id]);
    });

    it('getIncludedIds supports restoring a selection in one call', () => {
      const store = new PhotoStore();
      store.addPhotos([makeNewPhoto('a.jpg'), makeNewPhoto('b.jpg')]);
      const before = store.getIncludedIds();
      store.setAllIncluded(false);
      store.setIncluded(before, true);
      expect(store.getIncludedIds()).toEqual(before);
    });
  });

  describe('restoring photos', () => {
    it('keeps a given id and included flag, and mints ids past it', () => {
      const store = new PhotoStore();
      const [restored] = store.addPhotos([
        { ...makeNewPhoto('a.jpg'), id: 'photo-7', included: false },
      ]);
      expect(restored?.id).toBe('photo-7');
      expect(restored?.included).toBe(false);
      const minted = store.addPhotos(
        Array.from({ length: 8 }, (_, n) => makeNewPhoto(`m${String(n)}.jpg`)),
      );
      const ids = [restored, ...minted].map((p) => p?.id);
      expect(new Set(ids).size).toBe(9);
    });

    it('rejects a clashing id and adds nothing', () => {
      const store = new PhotoStore();
      store.addPhotos([{ ...makeNewPhoto('a.jpg'), id: 'x' }]);
      expect(() =>
        store.addPhotos([
          makeNewPhoto('b.jpg'),
          { ...makeNewPhoto('c.jpg'), id: 'x' },
        ]),
      ).toThrow(RangeError);
      expect(store.getTotalCount()).toBe(1);
    });
  });

  describe('removal', () => {
    it('removes photos, emits one removed change, and allows re-adding', () => {
      const store = new PhotoStore();
      const [a, b] = store.addPhotos([
        makeNewPhoto('a.jpg'),
        makeNewPhoto('b.jpg'),
      ]);
      const changes: PhotoStoreChange[] = [];
      store.subscribe((change) => changes.push(change));
      store.removePhotos([a?.id ?? '', 'unknown']);
      expect(changes).toEqual([{ kind: 'removed', ids: [a?.id] }]);
      expect(store.getPhotos().map((p) => p.id)).toEqual([b?.id]);
      store.removePhotos(['unknown']); // no-op
      expect(changes).toHaveLength(1);
      expect(store.addPhotos([makeNewPhoto('a.jpg')])).toHaveLength(1);
    });

    it('clear removes everything with one change', () => {
      const store = new PhotoStore();
      store.addPhotos([makeNewPhoto('a.jpg'), makeNewPhoto('b.jpg')]);
      const changes: PhotoStoreChange[] = [];
      store.subscribe((change) => changes.push(change));
      store.clear();
      expect(store.getTotalCount()).toBe(0);
      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe('removed');
      store.clear();
      expect(changes).toHaveLength(1);
    });
  });

  describe('atomic addPhotos', () => {
    it('adds nothing and marks nothing as seen if a later item is invalid', () => {
      const store = new PhotoStore();
      const changes: PhotoStoreChange[] = [];
      store.subscribe((change) => changes.push(change));
      expect(() =>
        store.addPhotos([makeNewPhoto('a.jpg'), makeNewPhoto('b.jpg', 0, 0)]),
      ).toThrow(RangeError);
      expect(store.getTotalCount()).toBe(0);
      expect(changes).toEqual([]);
      expect(store.hasFile(makeFile('a.jpg'))).toBe(false);
      expect(store.addPhotos([makeNewPhoto('a.jpg')])).toHaveLength(1);
    });

    it('skips duplicates within one call', () => {
      const store = new PhotoStore();
      expect(
        store.addPhotos([makeNewPhoto('a.jpg'), makeNewPhoto('a.jpg')]),
      ).toHaveLength(1);
    });
  });

  describe('listener errors', () => {
    it('isolates a throwing listener from the store and other listeners', () => {
      const errors: unknown[] = [];
      const store = new PhotoStore({ onListenerError: (e) => errors.push(e) });
      const boom = new Error('boom');
      store.subscribe(() => {
        throw boom;
      });
      const later = vi.fn();
      store.subscribe(later);
      expect(() => store.addPhotos([makeNewPhoto('a.jpg')])).not.toThrow();
      expect(store.getTotalCount()).toBe(1);
      expect(later).toHaveBeenCalledOnce();
      expect(errors).toEqual([boom]);
    });

    it('survives a throwing error handler', () => {
      const store = new PhotoStore({
        onListenerError: () => {
          throw new Error('handler');
        },
      });
      store.subscribe(() => {
        throw new Error('listener');
      });
      expect(() => store.addPhotos([makeNewPhoto('a.jpg')])).not.toThrow();
    });
  });
});
