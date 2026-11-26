import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownWideNarrow, ArrowRight, ArrowUpNarrowWide, ChevronLeft, ChevronRight, File as FileIcon,
  Folder, Image as ImageIcon, Images, Info, Search, Settings, Workflow, X,
} from 'lucide-react';
import MetadataViewer from './MetadataViewer';
import MetadataSearch from './MetadataSearch';

type LibraryItem = {
  name: string;
  path: string;
  kind: 'directory' | 'image' | 'file';
  size: number;
  modifiedAt: string;
  hasComfyUiMetadata: boolean;
  width?: number | null;
  height?: number | null;
};
type LibraryRoot = { name: string; path: string };
type SortKey = 'name' | 'modified' | 'size';
type SortOrder = 'asc' | 'desc';
type BrowseResult = {
  path: string;
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  hasMore: boolean;
  incomplete?: boolean;
  fileNames?: string[];
  items: LibraryItem[];
};
type ImageDetails = {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  width: number | null;
  height: number | null;
  format: string | null;
  orientation: number | null;
  pages: number | null;
  hasComfyUiMetadata: boolean;
};

// Keep in step with foldersPerSlot in the API, which pages by gallery slot.
const foldersPerStack = 4;
const folderRefreshMs = 5000;
const notificationKey = 'imgbae.newFileNotifications';
const sortLabels: Record<SortKey, string> = { name: 'Name', modified: 'Date modified', size: 'File size' };

function storedSort(): { sort: SortKey; order: SortOrder } {
  try {
    const saved = JSON.parse(localStorage.getItem('imgbae.sort') || '{}') as { sort?: string; order?: string };
    return {
      sort: saved.sort && saved.sort in sortLabels ? saved.sort as SortKey : 'name',
      order: saved.order === 'desc' ? 'desc' : 'asc',
    };
  } catch { return { sort: 'name', order: 'asc' }; }
}
function storedNotifications(): boolean {
  try { return localStorage.getItem(notificationKey) === 'true'; }
  catch { return false; }
}
function desktopPermission(): NotificationPermission | 'unavailable' {
  return window.isSecureContext && typeof window.Notification === 'function'
    ? window.Notification.permission : 'unavailable';
}
function currentHashPath(): string {
  try { return decodeURIComponent(window.location.hash.replace(/^#\/?/, '')); }
  catch { return ''; }
}
function resourceUrl(route: string, item: LibraryItem): string {
  return '/api/' + route + '?path=' + encodeURIComponent(item.path) +
    '&v=' + encodeURIComponent(item.modifiedAt);
}
function friendlySize(value: number): string {
  if (!value) return '0B';
  const units = ['B', 'K', 'M', 'G', 'T'];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return (value / (1024 ** power)).toFixed(power === 0 ? 0 : 1) + units[power];
}
function friendlyDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function friendlyDimensions(image: { width?: number | null; height?: number | null } | null): string | null {
  if (!image?.width || !image.height) return null;
  return image.width + '×' + image.height;
}
function friendlyMegapixels(image: { width?: number | null; height?: number | null } | null): string | null {
  if (!image?.width || !image.height) return null;
  const megapixels = (image.width * image.height) / 1_000_000;
  return megapixels < 0.05 ? '<0.1MP' : megapixels.toFixed(1) + 'MP';
}
function viewUrl(item: LibraryItem): string {
  return resourceUrl(/\.(png|jpe?g|webp|gif|avif)$/i.test(item.name) ? 'image' : 'preview', item);
}
function breadcrumbs(path: string) {
  const parts = path.split('/').filter(Boolean);
  return [{ name: 'Library', path: '' }, ...parts.map((name, i) => ({
    name, path: parts.slice(0, i + 1).join('/'),
  }))];
}

export default function App() {
  const [folder, setFolder] = useState(currentHashPath);
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [page, setPage] = useState(0);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [{ sort, order }, setSorting] = useState(storedSort);
  const [hasLibraryComfyMetadata, setHasLibraryComfyMetadata] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<ImageDetails | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(storedNotifications);
  const [permission, setPermission] = useState(desktopPermission);
  const fileSnapshot = useRef<{ folder: string; names: Set<string> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/roots', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load library roots');
        return await response.json() as { roots: LibraryRoot[] };
      })
      .then(({ roots }) => { if (!controller.signal.aborted) setRoots(roots); })
      .catch(() => { /* Folder browsing has its own error display. */ });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onHashChange = () => { setFolder(currentHashPath()); setSearch(''); setPage(0); setFilter(''); setSelected(null); };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setBrowse(null);
    const query = search ? new URLSearchParams(search) : new URLSearchParams({ path: folder, sort, order });
    query.set('page', String(page));
    if (!search && notificationsEnabled) query.set('includeFileNames', '1');
    const url = (search ? '/api/search?' : '/api/browse?') + query;
    if (!notificationsEnabled || search || fileSnapshot.current?.folder !== folder) {
      fileSnapshot.current = null;
    }
    let refreshTimer: number | undefined;
    let hasListing = false;

    async function loadListing() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          const action = search ? 'Could not search the library' : 'Could not open this folder';
          throw new Error(action + ' (' + response.status + ')');
        }
        const result = await response.json() as BrowseResult;
        if (controller.signal.aborted) return;
        if (notificationsEnabled && result.fileNames) {
          const snapshot = fileSnapshot.current;
          const added = snapshot ? result.fileNames.filter((name) => !snapshot.names.has(name)) : [];
          fileSnapshot.current = { folder, names: new Set(result.fileNames) };
          if (added.length && (document.hidden || !document.hasFocus()) && desktopPermission() === 'granted') {
            const message = added.length === 1 ? 'New file: ' + added[0] : added.length + ' new files';
            try {
              new window.Notification('imgbae', { body: message, tag: 'imgbae-new-files' });
            } catch { setPermission('unavailable'); }
          }
        }
        const lastPage = Math.max(0, result.totalPages - 1);
        if (!search && page > lastPage) {
          setSelected(null);
          setPage(lastPage);
          return;
        }
        hasListing = true;
        setBrowse(result);
        setError('');
        if (!search) {
          setSelected((path) => path && result.items.some((item) => item.path === path && item.kind === 'image') ? path : null);
        }
      } catch (cause: unknown) {
        if (!controller.signal.aborted && !hasListing) {
          setError(cause instanceof Error ? cause.message : 'Unable to connect to imgbae API');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (!search) scheduleRefresh();
        }
      }
    }

    function scheduleRefresh() {
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        if (document.hidden && !(notificationsEnabled && desktopPermission() === 'granted')) scheduleRefresh();
        else void loadListing();
      }, folderRefreshMs);
    }

    function refreshOnReturn() {
      if (document.hidden || refreshTimer === undefined) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
      void loadListing();
    }

    if (!search && notificationsEnabled) document.addEventListener('visibilitychange', refreshOnReturn);
    void loadListing();
    return () => {
      document.removeEventListener('visibilitychange', refreshOnReturn);
      window.clearTimeout(refreshTimer);
      controller.abort();
    };
  }, [folder, page, search, sort, order, notificationsEnabled]);

  useEffect(() => {
    if (search) return;
    const controller = new AbortController();
    fetch('/api/search?presence=1', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not check library metadata');
        return await response.json() as { hasComfyUiMetadata: boolean };
      })
      .then(({ hasComfyUiMetadata }) => {
        if (!controller.signal.aborted) setHasLibraryComfyMetadata(hasComfyUiMetadata);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHasLibraryComfyMetadata(false);
      });
    return () => controller.abort();
  }, [folder, page, search]);

  useEffect(() => {
    if (!selected) { setDetails(null); return; }
    const controller = new AbortController();
    setDetails(null);
    fetch('/api/details?path=' + encodeURIComponent(selected), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Details unavailable');
        return await response.json() as ImageDetails;
      })
      .then(setDetails)
      .catch(() => { /* Image stays viewable even if metadata cannot be loaded. */ });
    return () => controller.abort();
  }, [selected]);

  const visible = useMemo(() => {
    return (browse?.items || []).filter((item) => item.name.toLowerCase().includes(filter.toLowerCase()));
  }, [browse, filter]);
  const folderStacks = useMemo(() => {
    const folders = visible.filter((item) => item.kind === 'directory');
    return Array.from({ length: Math.ceil(folders.length / foldersPerStack) },
      (_, i) => folders.slice(i * foldersPerStack, (i + 1) * foldersPerStack));
  }, [visible]);
  const images = useMemo(() => (browse?.items || []).filter((item) => item.kind === 'image'), [browse]);
  const selectedIndex = images.findIndex((item) => item.path === selected);
  const selectedItem = selectedIndex >= 0 ? images[selectedIndex] : null;
  const measuredImage = details?.path === selected ? details : selectedItem;
  const selectedDimensions = friendlyDimensions(measuredImage);
  const selectedMegapixels = friendlyMegapixels(measuredImage);

  function changeSearch(criteria: string) {
    setSelected(null);
    setPage(0);
    setFilter('');
    setSearch(criteria);
  }

  function toggleNotifications(enabled: boolean) {
    fileSnapshot.current = null;
    setNotificationsEnabled(enabled);
    try { localStorage.setItem(notificationKey, String(enabled)); }
    catch { /* The setting still applies for this visit. */ }
    if (enabled) {
      const current = desktopPermission();
      setPermission(current);
      if (current === 'default') {
        void window.Notification.requestPermission().then(setPermission, () => setPermission('unavailable'));
      }
    }
  }

  function navigate(path: string) {
    setSearch('');
    setSelected(null);
    setPage(0);
    setFilter('');
    if (path === folder) return;
    window.location.hash = '/' + encodeURIComponent(path);
  }
  function changePage(next: number) {
    setSelected(null);
    setFilter('');
    setPage(next);
    window.scrollTo(0, 0);
  }
  function changeSort(next: { sort: SortKey; order: SortOrder }) {
    setSelected(null);
    setPage(0);
    setSorting(next);
    try { localStorage.setItem('imgbae.sort', JSON.stringify(next)); } catch { /* Sorting still applies for this visit. */ }
  }
  function moveViewer(direction: number) {
    if (!images.length || selectedIndex < 0) return;
    const next = (selectedIndex + direction + images.length) % images.length;
    setSelected(images[next].path);
  }

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
      if (event.target instanceof Element && event.target.closest('.metadata-viewer')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (selectedIndex >= 0 && images.length) setSelected(images[(selectedIndex - 1 + images.length) % images.length].path);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (selectedIndex >= 0 && images.length) setSelected(images[(selectedIndex + 1) % images.length].path);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected, selectedIndex, images]);

  const imageCount = browse?.items.filter((item) => item.kind === 'image').length || 0;
  const totalPages = browse?.totalPages ?? 1;
  const activeRoot = folder.split('/', 1)[0];
  const folderTrail = breadcrumbs(folder);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="identity"><span className="mark"><Images size={23} strokeWidth={1.8} /></span>
          <span className="brand">imgbae<span className="brand-dot">.</span></span>
        </div>
        <div className="side-label">WORKSPACE</div>
        <nav className="library-nav" aria-label="Library folders">
          <button className={'side-entry' + (!folder && !search ? ' active' : '')}
            aria-current={!folder && !search ? 'page' : undefined} onClick={() => navigate('')}>
            <Images size={17} strokeWidth={1.7} aria-hidden="true" /> <span>Image library</span>
          </button>
          {roots.map((root) => {
            const active = !search && activeRoot === root.path;
            return (
              <button key={root.path} className={'side-entry root-entry' + (active ? ' active' : '')}
                aria-current={active ? 'location' : undefined} title={root.name} onClick={() => navigate(root.path)}>
                <Folder size={17} strokeWidth={1.7} aria-hidden="true" /> <span>{root.name}</span>
              </button>
            );
          })}
        </nav>
        <div className="side-footer">
          <div className="side-label">MILESTONE 01</div>
          <p>Browse and view</p>
          <small>Read-only mode</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <nav className="pathbar" aria-label="Folder path">
            <ol>
              {folderTrail.map((crumb, index) => (
                <li className="path-part" key={crumb.path}>
                  {index > 0 && <ChevronRight size={15} className="path-chevron" aria-hidden="true" />}
                  {index === folderTrail.length - 1 && !search
                    ? <span className="path-current" aria-current="page">{crumb.name}</span>
                    : <button onClick={() => navigate(crumb.path)}>{crumb.name}</button>}
                </li>
              ))}
            </ol>
          </nav>
          <div className="topbar-actions">
            <span className="read-only"><span className="status-dot" /> READ ONLY</span>
            <details className="settings">
              <summary aria-label="Settings" title="Settings"><Settings size={19} aria-hidden="true" /></summary>
              <div className="settings-panel">
                <label>
                  <input type="checkbox" checked={notificationsEnabled}
                    onChange={(event) => toggleNotifications(event.target.checked)} />
                  New file notifications
                </label>
                <p>Send a browser notification for new files in the open folder while imgbae is inactive.</p>
                {notificationsEnabled && permission === 'denied' &&
                  <p>To receive desktop alerts, allow notifications in your browser’s site settings.</p>}
                {notificationsEnabled && permission === 'unavailable' &&
                  <p>Desktop alerts require a supported browser on HTTPS or localhost.</p>}
              </div>
            </details>
          </div>
        </header>

        <div className="content">
          <div className="heading">
            <div>
              <div className="eyebrow">YOUR COLLECTION</div>
              <h1>{search ? 'Search results' : folder ? folder.split('/').pop() : 'Image library'}</h1>
              <p className="subtitle">{search ? 'Matching ComfyUI images across the library.' : 'Browse your images, explore folders, and view details.'}</p>
            </div>
          </div>

          {hasLibraryComfyMetadata && (
            <MetadataSearch active={Boolean(search)} onSearch={changeSearch} onClear={() => changeSearch('')} />
          )}
          {browse?.incomplete && <p className="search-incomplete" role="status">Some files could not be fully searched.</p>}

          <div className="toolbar">
            <div className="filter-wrap"><Search size={17} /><input
              aria-label="Filter files on this page" placeholder="Filter this page..."
              value={filter} onChange={(event) => setFilter(event.target.value)}
            />{filter && <button aria-label="Clear filter" onClick={() => setFilter('')}><X size={15} /></button>}</div>
            {!search && (
              <div className="sort-wrap">
                <select aria-label="Sort by" value={sort}
                  onChange={(event) => changeSort({ sort: event.target.value as SortKey, order })}>
                  {(Object.keys(sortLabels) as SortKey[]).map((key) => <option key={key} value={key}>{sortLabels[key]}</option>)}
                </select>
                <button aria-label={order === 'asc' ? 'Sorted ascending; switch to descending' : 'Sorted descending; switch to ascending'}
                  title={order === 'asc' ? 'Ascending' : 'Descending'}
                  onClick={() => changeSort({ sort, order: order === 'asc' ? 'desc' : 'asc' })}>
                  {order === 'asc' ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}
                </button>
              </div>
            )}
            <span className="counter">{browse ? browse.total.toLocaleString() + (search ? ' matches' : ' entries') + ' · ' + imageCount + ' images on page' : search ? 'Searching library' : 'Loading library'}</span>
          </div>

          {error && <div className="message error"><strong>Unable to open library</strong><p>{error}</p><small>Check that the API is running and the library folders configured with IMGBAE_CONFIG, IMGBAE_ROOTS, or IMGBAE_ROOT are readable.</small></div>}
          {loading && !error && <div className="message">{search ? 'Searching the library…' : 'Loading folder...'}</div>}
          {!loading && !error && visible.length === 0 && <div className="message">
            <ImageIcon size={28} strokeWidth={1.4}/><strong>{filter || search ? 'No matching items' : 'This folder is empty'}</strong>
            <p>{filter ? 'Try a different filename filter.' : search ? 'Try fewer search criteria.' : 'Navigate to another folder to find images.'}</p>
          </div>}

          <div className="gallery">
            {folderStacks.map((stack) => (
              <div key={stack[0].path} className="folder-stack">
                {stack.map((item) => (
                  <button key={item.path} className="tile folder-tile" onClick={() => navigate(item.path)} title={item.name}>
                    <Folder size={22} strokeWidth={1.4} />
                    <span className="tile-name">{item.name}</span>
                  </button>
                ))}
              </div>
            ))}
            {visible.filter((item) => item.kind !== 'directory').map((item) => {
              const dimensions = friendlyDimensions(item);
              const megapixels = friendlyMegapixels(item);
              return (
                <button key={item.path} className="tile"
                  onClick={() => item.kind === 'image' ? setSelected(item.path) : undefined}
                  disabled={item.kind === 'file'} title={item.name}>
                  <div className="tile-preview">
                    {item.kind === 'image'
                      ? <img src={resourceUrl('thumbnail', item)} loading="lazy" alt="" />
                      : <FileIcon size={38} strokeWidth={1.1} />}
                  </div>
                  <div className="tile-info">
                    <div className="tile-name">{item.name}</div>
                    {search && <div className="tile-location" title={item.path}>
                      {item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : 'Library'}
                    </div>}
                    <div className="tile-sub">
                      {item.hasComfyUiMetadata && (
                        <img className="tile-comfy-logo" src={import.meta.env.BASE_URL + 'comfyui.svg'}
                          width={20} height={20} alt="ComfyUI metadata detected" title="ComfyUI metadata detected" />
                      )}
                      <span>{friendlySize(item.size)}</span>
                      {megapixels && <span>{megapixels}</span>}
                      {dimensions && <span>{dimensions}</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {browse && totalPages > 1 && <div className="pagination">
            <button onClick={() => changePage(Math.max(0, page - 1))} disabled={page === 0}><ChevronLeft size={16} /> Previous</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button onClick={() => changePage(page + 1)} disabled={!browse.hasMore}>Next <ChevronRight size={16} /></button>
          </div>}
        </div>
      </main>


      {selectedItem && <div className="lightbox" role="dialog" aria-modal="true" aria-label={'Viewing ' + selectedItem.name} onClick={() => setSelected(null)}>
        <div className="viewer-header" onClick={(event) => event.stopPropagation()}>
          <div className="viewer-title">
            <ImageIcon size={18} /><span title={selectedItem.name}>{selectedItem.name}</span>
            {selectedItem.hasComfyUiMetadata && <span className="provenance-chip viewer-chip"
              title="Recognized embedded ComfyUI metadata found."
            ><Workflow size={12} strokeWidth={1.7} /> ComfyUI metadata</span>}
          </div>
          <button className="icon-button" aria-label="Close image viewer" onClick={() => setSelected(null)}><X size={22} /></button>
        </div>
        <div className="viewer-body" onClick={(event) => event.stopPropagation()}>
          <div className="viewer-canvas">
            <button className="viewer-arrow prev" aria-label="Previous image" onClick={() => moveViewer(-1)}><ChevronLeft size={26} /></button>
            <img src={viewUrl(selectedItem)} alt={selectedItem.name} key={selectedItem.path}/>
            <button className="viewer-arrow next" aria-label="Next image" onClick={() => moveViewer(1)}><ChevronRight size={26} /></button>
          </div>
          <aside className="inspector">
            <div className="inspector-heading"><Info size={17} /> Image details</div>
            <div className="inspector-row"><span>Name</span><strong className="wrap-value">{selectedItem.name}</strong></div>
            <div className="inspector-row"><span>Dimensions</span><strong>{selectedDimensions ?? '—'}</strong></div>
            <div className="inspector-row"><span>Megapixels</span><strong>{selectedMegapixels ?? '—'}</strong></div>
            <div className="inspector-row"><span>Format</span><strong>{details?.format?.toUpperCase() || '—'}</strong></div>
            <div className="inspector-row"><span>Size</span><strong>{friendlySize(selectedItem.size)}</strong></div>
            <div className="inspector-row"><span>Modified</span><strong>{friendlyDate(selectedItem.modifiedAt)}</strong></div>
            {selectedItem.name.toLowerCase().endsWith('.png') && <div className="inspector-row">
              <span>ComfyUI metadata</span>
              <strong>{(details?.hasComfyUiMetadata ?? selectedItem.hasComfyUiMetadata) ? 'Detected' : 'Not detected'}</strong>
            </div>}
            {(details?.hasComfyUiMetadata ?? selectedItem.hasComfyUiMetadata) && <p className="inspector-provenance-note">
              Embedded metadata can survive image edits or conversion. This indicator does not verify image history.
            </p>}
            {selectedItem.name.toLowerCase().endsWith('.png') && (
              <MetadataViewer key={resourceUrl('metadata', selectedItem)} url={resourceUrl('metadata', selectedItem)} />
            )}
            <div className="inspector-note">Viewing only. This app does not modify the selected file.</div>
          </aside>
        </div>
        <div className="viewer-footer" onClick={(event) => event.stopPropagation()}>
          <span>{selectedIndex + 1} / {images.length} images on this page</span>
          <span><kbd>←</kbd> <kbd>→</kbd> navigate <span className="divider-dot">·</span> <kbd>Esc</kbd> close</span>
        </div>
      </div>}
    </div>
  );
}
