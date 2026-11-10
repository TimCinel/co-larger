import type { Photo, PhotoStore } from '../photos';

/**
 * The tray: a toolbar ("N / M selected", add/remove all) and a grid of
 * thumbnails, each a toggle button showing whether the photo is included.
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

  toolbar.append(count, addAll, removeAll);

  const grid = doc.createElement('ul');
  grid.className = 'tray-grid';

  const empty = doc.createElement('p');
  empty.className = 'tray-empty';
  empty.textContent = 'No photos yet. Added photos appear here.';

  tray.append(toolbar, grid, empty);

  const items = new Map<string, HTMLButtonElement>();
  const urls: string[] = [];

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
    urls.push(url);
    img.src = url;

    const tick = doc.createElement('span');
    tick.className = 'tick';
    tick.setAttribute('aria-hidden', 'true');

    button.append(img, tick);
    button.addEventListener('click', () => {
      const current = store.getPhoto(photo.id);
      if (current) store.setIncluded(photo.id, !current.included);
    });
    items.set(photo.id, button);
    li.append(button);
    return li;
  }

  function sync(): void {
    const photos = store.getPhotos();
    const fresh = photos.filter((photo) => !items.has(photo.id));
    if (fresh.length > 0) grid.append(...fresh.map(createItem));
    for (const photo of photos) {
      const button = items.get(photo.id);
      if (!button) continue;
      button.setAttribute('aria-pressed', String(photo.included));
      button.classList.toggle('included', photo.included);
    }
    const selected = store.getSelectedCount();
    const total = store.getTotalCount();
    count.textContent = `${String(selected)} / ${String(total)} selected`;
    addAll.disabled = total === 0 || selected === total;
    removeAll.disabled = selected === 0;
    empty.hidden = total > 0;
    grid.hidden = total === 0;
  }

  store.subscribe(sync);
  sync();
  // Object URLs are released with the page; photos are never removed in v1.
  doc.defaultView?.addEventListener('pagehide', () => {
    for (const url of urls) URL.revokeObjectURL(url);
  });
  return tray;
}
