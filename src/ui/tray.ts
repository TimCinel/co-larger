import type { Photo, PhotoStore } from '../photos';

/**
 * The tray: a toolbar ("N / M selected", add/remove all, and a button to
 * expand or collapse it) and the thumbnails, each a toggle button showing
 * whether the photo is included. Collapsed (the default) the thumbnails are
 * one scrolling row, so the collage keeps most of the page; expanded they
 * wrap into a grid showing every photo.
 */
export function createTray(doc: Document, store: PhotoStore): HTMLElement {
  const tray = doc.createElement('section');
  tray.className = 'tray';
  tray.setAttribute('aria-label', 'Photo tray');

  const toolbar = doc.createElement('div');
  toolbar.className = 'tray-toolbar';

  const count = doc.createElement('span');
  count.className = 'tray-count';
  count.setAttribute('role', 'status');

  const addAll = doc.createElement('button');
  addAll.type = 'button';
  addAll.textContent = 'Add all to collage';
  addAll.addEventListener('click', () => {
    store.setAllIncluded(true);
  });

  const removeAll = doc.createElement('button');
  removeAll.type = 'button';
  removeAll.textContent = 'Remove all';
  removeAll.addEventListener('click', () => {
    store.setAllIncluded(false);
  });

  const grid = doc.createElement('ul');
  grid.className = 'tray-grid';
  grid.id = 'tray-grid';

  const expand = doc.createElement('button');
  expand.type = 'button';
  expand.className = 'tray-expand';
  expand.setAttribute('aria-controls', grid.id);
  let expanded = false;
  const showExpanded = (): void => {
    tray.classList.toggle('expanded', expanded);
    expand.setAttribute('aria-expanded', String(expanded));
    expand.textContent = expanded ? 'Show one row' : 'Show all';
    expand.title = expanded
      ? 'Collapse the tray to a single row of photos'
      : 'Expand the tray to show every photo';
  };
  expand.addEventListener('click', () => {
    expanded = !expanded;
    showExpanded();
  });
  showExpanded();

  toolbar.append(count, addAll, removeAll, expand);

  const empty = doc.createElement('p');
  empty.className = 'tray-empty';
  empty.textContent = 'No photos yet. Added photos appear here.';

  tray.append(toolbar, grid, empty);

  interface Item {
    readonly li: HTMLLIElement;
    readonly button: HTMLButtonElement;
    readonly url: string;
  }
  const items = new Map<string, Item>();

  // The thumbnails are one tab stop (roving tabindex): Tab enters the tray
  // at the current thumbnail, and the arrow keys move between them, so a
  // tray of hundreds of photos does not take hundreds of Tab presses to
  // cross. Enter and Space toggle the focused photo (they are buttons).
  let activeId: string | null = null;
  const setActive = (id: string | null): void => {
    activeId = id;
    for (const [itemId, item] of items) {
      item.button.tabIndex = itemId === id ? 0 : -1;
    }
  };

  function createItem(photo: Photo): HTMLLIElement {
    const li = doc.createElement('li');
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'thumb';
    button.setAttribute('aria-label', photo.file.name);
    button.title = photo.file.name;
    button.style.aspectRatio = String(photo.aspect);
    li.style.setProperty('--aspect', String(photo.aspect));

    const img = doc.createElement('img');
    img.alt = '';
    img.draggable = false;
    const url = URL.createObjectURL(photo.thumbnail);
    img.src = url;

    const tick = doc.createElement('span');
    tick.className = 'tick';
    tick.setAttribute('aria-hidden', 'true');

    button.append(img, tick);
    button.addEventListener('click', () => {
      const current = store.getPhoto(photo.id);
      if (current) store.setIncluded(photo.id, !current.included);
    });
    button.tabIndex = -1;
    button.addEventListener('focus', () => {
      if (activeId !== photo.id) setActive(photo.id);
    });
    items.set(photo.id, { li, button, url });
    li.append(button);
    return li;
  }

  function sync(): void {
    const photos = store.getPhotos();
    const present = new Set(photos.map((photo) => photo.id));
    // Release object URLs of photos that were removed from the store.
    for (const [id, item] of items) {
      if (present.has(id)) continue;
      URL.revokeObjectURL(item.url);
      item.li.remove();
      items.delete(id);
    }
    const fresh = photos.filter((photo) => !items.has(photo.id));
    if (fresh.length > 0) grid.append(...fresh.map(createItem));
    for (const photo of photos) {
      const button = items.get(photo.id)?.button;
      if (!button) continue;
      button.setAttribute('aria-pressed', String(photo.included));
      button.classList.toggle('included', photo.included);
    }
    if (activeId === null || !items.has(activeId)) {
      setActive(photos[0]?.id ?? null);
    } else if (fresh.length > 0) {
      setActive(activeId);
    }
    const selected = store.getSelectedCount();
    const total = store.getTotalCount();
    count.textContent = `${String(selected)} / ${String(total)} selected`;
    addAll.disabled = total === 0 || selected === total;
    removeAll.disabled = selected === 0;
    empty.hidden = total > 0;
    expand.hidden = total === 0;
    grid.hidden = total === 0;
  }

  grid.addEventListener('keydown', (event) => {
    const keys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ];
    if (!keys.includes(event.key)) return;
    const buttons = [...items.values()].map((item) => item.button);
    const from = buttons.findIndex((b) => b === doc.activeElement);
    if (from < 0) return;
    let to = from;
    if (event.key === 'ArrowLeft') to = from - 1;
    else if (event.key === 'ArrowRight') to = from + 1;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = buttons.length - 1;
    else {
      // Up and Down: the nearest thumbnail in the next row (when expanded).
      const here = buttons[from]?.getBoundingClientRect();
      if (!here) return;
      const down = event.key === 'ArrowDown';
      let best = Infinity;
      for (const [i, b] of buttons.entries()) {
        const r = b.getBoundingClientRect();
        const dy = down ? r.top - here.top : here.top - r.top;
        if (dy < here.height / 2) continue;
        const score = dy * 10000 + Math.abs(r.left - here.left);
        if (score < best) {
          best = score;
          to = i;
        }
      }
    }
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, to))]?.focus();
  });

  store.subscribe(sync);
  sync();
  // Remaining object URLs are released with the page.
  doc.defaultView?.addEventListener('pagehide', () => {
    for (const item of items.values()) URL.revokeObjectURL(item.url);
  });
  return tray;
}
