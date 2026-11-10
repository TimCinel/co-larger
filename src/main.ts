import { renderApp } from './app';
import './style.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('Missing #app root element');
}
renderApp(root);
