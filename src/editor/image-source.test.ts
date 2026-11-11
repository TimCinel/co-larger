import { describe, expect, it } from 'vitest';
import { bytesOf, chooseSource, LEVEL_RANK } from './image-source';
import { planLevels, type PlanDemand } from './image-plan';

const photo = { width: 4000, height: 3000 };
const flat = { x: 0.5, y: 0.5, zoom: 1 };

describe('chooseSource', () => {
  it('uses the thumbnail while it is not enlarged', () => {
    expect(chooseSource(photo, { width: 200, height: 150 }, flat).level).toBe(
      'thumbnail',
    );
    expect(chooseSource(photo, { width: 256, height: 192 }, flat).level).toBe(
      'thumbnail',
    );
  });

  it('uses the preview for tiles between the thumbnail and the preview', () => {
    expect(chooseSource(photo, { width: 300, height: 225 }, flat).level).toBe(
      'preview',
    );
    expect(chooseSource(photo, { width: 1024, height: 768 }, flat).level).toBe(
      'preview',
    );
  });

  it('decodes a larger image when the tile is bigger than the preview', () => {
    const choice = chooseSource(photo, { width: 2200, height: 1650 }, flat);
    expect(choice.level).toBe('detail');
    expect(choice.size.width).toBeGreaterThanOrEqual(2200);
    expect(choice.size.width).toBeLessThanOrEqual(photo.width);
    expect(choice.size.width / choice.size.height).toBeCloseTo(4 / 3, 2);
  });

  it('rounds up a ladder so small size changes keep the same decode', () => {
    const a = chooseSource(photo, { width: 1500, height: 1125 }, flat);
    const b = chooseSource(photo, { width: 1530, height: 1148 }, flat);
    expect(a.level).toBe('detail');
    expect(b.size).toEqual(a.size);
  });

  it('never goes above the original', () => {
    const choice = chooseSource(photo, { width: 9000, height: 6750 }, flat);
    expect(choice.level).toBe('detail');
    expect(choice.size).toEqual({ width: 4000, height: 3000 });
    // A photo that is no bigger than its preview has nothing more to give.
    expect(
      chooseSource(
        { width: 800, height: 600 },
        { width: 2000, height: 1500 },
        flat,
      ).level,
    ).toBe('preview');
  });

  it('takes the crop zoom into account', () => {
    const tile = { width: 600, height: 450 };
    expect(chooseSource(photo, tile, flat).level).toBe('preview');
    const zoomed = chooseSource(photo, tile, { x: 0.5, y: 0.5, zoom: 4 });
    expect(zoomed.level).toBe('detail');
    expect(zoomed.size.width).toBeGreaterThanOrEqual(2400);
    // A small tile, zoomed, outgrows the thumbnail but not necessarily more.
    expect(
      chooseSource(photo, { width: 100, height: 75 }, { x: 0, y: 0, zoom: 4 })
        .level,
    ).toBe('preview');
  });

  it('caps the size of a detail, drawing a little soft rather than decoding more', () => {
    const cap = 8 * 1024 * 1024;
    const choice = chooseSource(
      photo,
      { width: 4000, height: 3000 },
      flat,
      cap,
    );
    expect(choice.level).toBe('detail');
    expect(bytesOf(choice.size)).toBeLessThanOrEqual(cap);
    // Under the preview's size, the preview is used instead.
    expect(
      chooseSource(photo, { width: 4000, height: 3000 }, flat, 1024).level,
    ).toBe('preview');
  });

  it('copes with unusable sizes', () => {
    expect(chooseSource(photo, { width: 0, height: 0 }, flat).level).toBe(
      'thumbnail',
    );
    expect(
      LEVEL_RANK[
        chooseSource({ width: 0, height: 0 }, { width: 50, height: 50 }, flat)
          .level
      ],
    ).toBeGreaterThanOrEqual(0);
  });
});

function demand(
  id: string,
  priority: number,
  ideal: PlanDemand['ideal'],
  optional = false,
): PlanDemand {
  return {
    id,
    priority,
    ideal,
    optional,
    cost: { thumbnail: 1, preview: 11, detail: 61 },
  };
}

describe('planLevels', () => {
  it('upgrades the biggest tiles first', () => {
    const plan = planLevels(
      [
        demand('small', 10, 'preview'),
        demand('big', 100, 'preview'),
        demand('mid', 50, 'preview'),
      ],
      3 + 20,
    );
    expect(plan.get('big')).toBe('preview');
    expect(plan.get('mid')).toBe('preview');
    expect(plan.get('small')).toBe('thumbnail');
  });

  it('falls back from a detail to a preview when the detail does not fit', () => {
    const plan = planLevels(
      [demand('a', 100, 'detail'), demand('b', 50, 'preview')],
      2 + 10 + 10,
    );
    expect(plan.get('a')).toBe('preview');
    expect(plan.get('b')).toBe('preview');
  });

  it('gives thumbnails to as many photos as fit, most important first', () => {
    const plan = planLevels(
      [demand('a', 1, 'thumbnail'), demand('b', 3, 'thumbnail')],
      1,
    );
    expect([...plan.keys()]).toEqual(['b']);
  });

  it('decodes photos not in view only while half the budget is free', () => {
    const optional = Array.from({ length: 10 }, (_, i) =>
      demand(`p${String(i)}`, 0, 'thumbnail', true),
    );
    const plan = planLevels(optional, 10);
    expect(plan.size).toBe(5);
    const mixed = planLevels([demand('view', 5, 'thumbnail'), ...optional], 10);
    expect(mixed.has('view')).toBe(true);
  });

  it('never plans more than the budget, whatever the demands', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 200; round++) {
      const budget = Math.floor(next() * 300);
      const demands = Array.from(
        { length: 1 + Math.floor(next() * 30) },
        (_, i) => {
          const ideal = (['thumbnail', 'preview', 'detail'] as const)[
            Math.floor(next() * 3)
          ] as PlanDemand['ideal'];
          const t = 1 + Math.floor(next() * 3);
          const p = t + Math.floor(next() * 20);
          return {
            id: `p${String(i)}`,
            priority: next() * 100,
            ideal,
            optional: next() < 0.2,
            cost: {
              thumbnail: t,
              preview: p,
              detail: p + Math.floor(next() * 80),
            },
          } satisfies PlanDemand;
        },
      );
      const plan = planLevels(demands, budget);
      let total = 0;
      for (const d of demands) {
        const level = plan.get(d.id);
        if (level) {
          total += d.cost[level];
          expect(LEVEL_RANK[level]).toBeLessThanOrEqual(
            Math.max(LEVEL_RANK[d.ideal], 0),
          );
        }
      }
      expect(total).toBeLessThanOrEqual(budget);
    }
  });
});
