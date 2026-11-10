import { renderApp } from './app';
import './style.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('Missing #app root element');
}
const store = renderApp(root);

// Lets the local browser check (scripts/browser-check.ts) inspect the store.
// Dev server only: removed from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __store: unknown }).__store = store;
}
