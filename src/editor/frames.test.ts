import { describe, expect, it } from 'vitest';
import { FrameScheduler } from './frames';

function setup() {
  const callbacks: FrameRequestCallback[] = [];
  const frames = new FrameScheduler({
    requestAnimationFrame: (cb) => callbacks.push(cb),
  });
  const tick = (): void => {
    for (const cb of callbacks.splice(0)) cb(0);
  };
  return { frames, callbacks, tick };
}

describe('FrameScheduler', () => {
  it('runs each kind of task once per frame, the latest one queued', () => {
    const { frames, callbacks, tick } = setup();
    const log: string[] = [];
    frames.request('render', () => log.push('render 1'));
    frames.request('render', () => log.push('render 2'));
    frames.request('dial', () => log.push('dial'));
    expect(callbacks).toHaveLength(1);
    tick();
    expect(log).toEqual(['dial', 'render 2']);
  });

  it('runs a render queued by an earlier task in the same frame', () => {
    const { frames, tick } = setup();
    const log: string[] = [];
    frames.request('dial', () => {
      log.push('dial');
      frames.request('render', () => log.push('render'));
    });
    tick();
    expect(log).toEqual(['dial', 'render']);
  });

  it('cancels and flushes', () => {
    const { frames, tick } = setup();
    const log: string[] = [];
    frames.request('dial', () => log.push('dial'));
    frames.request('render', () => log.push('render'));
    frames.cancel('dial');
    frames.flush();
    expect(log).toEqual(['render']);
    tick();
    expect(log).toEqual(['render']);
  });
});
