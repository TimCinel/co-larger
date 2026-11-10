import { renderApp } from './app';
import './style.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('Missing #app root element');
}
const app = renderApp(root);

// Lets the local browser check (scripts/browser-check.ts) inspect the photo
// store and the editor. Dev server only: removed from production builds.
if (import.meta.env.DEV) {
  const hooks = window as unknown as { __store: unknown; __app: unknown };
  hooks.__store = app.store;
  hooks.__app = app;
}
