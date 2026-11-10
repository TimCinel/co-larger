import { describe, expect, it } from 'vitest';
import { APP_NAME, renderApp } from './app';

// Tests run in plain Node with no DOM library, so this uses the smallest
// stand-in that satisfies what renderApp touches.
interface FakeElement {
  tagName: string;
  textContent: string;
  children: FakeElement[];
  ownerDocument: { createElement(tagName: string): FakeElement };
  append(...nodes: FakeElement[]): void;
  replaceChildren(...nodes: FakeElement[]): void;
}

function createElement(tagName: string): FakeElement {
  return {
    tagName,
    textContent: '',
    children: [],
    ownerDocument: { createElement },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
  };
}

describe('renderApp', () => {
  it('replaces the root contents with the placeholder page', () => {
    const root = createElement('div');
    root.append(createElement('span'));

    renderApp(root as unknown as HTMLElement);

    expect(root.children).toHaveLength(1);
    const [main] = root.children;
    expect(main?.tagName).toBe('main');
    expect(main?.children.map((child) => child.tagName)).toEqual(['h1', 'p']);
    expect(main?.children[0]?.textContent).toBe(APP_NAME);
  });
});
