import type { ImportSummary } from '../photos';

const MAX_NAMES = 5;

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).join(', ');
  const more = names.length - MAX_NAMES;
  return more > 0 ? `${shown} and ${String(more)} more` : shown;
}

/** Human-readable messages for what an import skipped. Empty if all was fine. */
export function summaryMessages(summary: ImportSummary): string[] {
  const messages: string[] = [];
  const failed = summary.failures.map((failure) => failure.name);
  if (failed.length > 0) {
    messages.push(
      `Skipped ${String(failed.length)} ${failed.length === 1 ? 'file' : 'files'} this browser cannot read as an image: ${nameList(failed)}`,
    );
  }
  if (summary.duplicates.length > 0) {
    messages.push(
      `Skipped ${String(summary.duplicates.length)} already added ${summary.duplicates.length === 1 ? 'photo' : 'photos'}: ${nameList(summary.duplicates)}`,
    );
  }
  return messages;
}

/** A non-blocking, dismissible list of messages. */
export function createNotices(doc: Document): {
  element: HTMLElement;
  show(message: string): void;
} {
  const element = doc.createElement('div');
  element.className = 'notices';
  element.setAttribute('role', 'status');
  return {
    element,
    show(message) {
      const notice = doc.createElement('p');
      notice.className = 'notice';
      const text = doc.createElement('span');
      text.textContent = message;
      const dismiss = doc.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => {
        notice.remove();
      });
      notice.append(text, dismiss);
      element.append(notice);
    },
  };
}
