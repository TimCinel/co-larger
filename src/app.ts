export const APP_NAME = 'co-larger';

/** Renders the placeholder page into `root`, replacing its contents. */
export function renderApp(root: HTMLElement): void {
  const doc = root.ownerDocument;

  const heading = doc.createElement('h1');
  heading.textContent = APP_NAME;

  const tagline = doc.createElement('p');
  tagline.textContent =
    'A photo collage maker that runs entirely in your browser. Coming soon.';

  const main = doc.createElement('main');
  main.append(heading, tagline);
  root.replaceChildren(main);
}
