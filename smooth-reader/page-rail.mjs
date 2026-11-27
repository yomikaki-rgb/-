import { icon } from './icons.mjs';

const ROW_HEIGHT = 166;
const OVERSCAN = 2;

export function visiblePages(scrollTop, height, count) {
  const first = Math.max(1, Math.floor(scrollTop / ROW_HEIGHT) + 1 - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  return { first, last };
}

export class PageRail {
  constructor(scroll, list, onChoose) {
    this.scroll = scroll;
    this.list = list;
    this.onChoose = onChoose;
    this.rows = new Map();
    this.notePages = new Set();
    this.open = false;
    this.ready = false;
    scroll.addEventListener('scroll', () => this.paint(), {passive:true});
    scroll.addEventListener('keydown', event => this.handleKey(event));
    new ResizeObserver(() => this.paint()).observe(scroll);
  }

  setSource(source) {
    this.setOpen(false);
    this.source = source;
    this.ready = false;
    this.state = null;
    this.notePages.clear();
    this.list.style.height = (source?.count || 0) * ROW_HEIGHT + 'px';
  }

  setOpen(open) {
    this.open = open;
    if (open) this.reveal(this.state.page);
    else this.clear();
  }

  setReady(ready) {
    this.ready = ready;
    if (ready) this.schedule();
    else {
      clearTimeout(this.timer);
      this.timer = null;
      this.job?.task?.cancel();
    }
  }

  update(page, bookmark, rotation) {
    const previous = this.state;
    this.state = {page, bookmark, rotation};
    if (!this.open) return;
    if (previous?.rotation !== rotation) this.clear();
    if (previous?.page !== page) this.reveal(page);
    else this.paint();
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const [page, row] of this.rows) this.remove(page,row);
  }

  setNotePages(pages) {
    this.notePages = new Set(pages);
    for (const [page,row] of this.rows) this.updateBadges(page,row);
  }

  setNotePage(page,present) {
    if (present) this.notePages.add(page);
    else this.notePages.delete(page);
    const row = this.rows.get(page);
    if (row) this.updateBadges(page,row);
  }

  updateBadges(page,row) {
    const bookmarked = page === this.state.bookmark;
    const hasNotes = this.notePages.has(page);
    row.mark.hidden = !bookmarked;
    row.note.hidden = !hasNotes;
    row.button.setAttribute('aria-label',page+'ページ'+
      (bookmarked ? '、しおりあり' : '')+(hasNotes ? '、メモあり' : ''));
  }

  remove(page, row) {
    if (this.job?.row === row) this.job.task?.cancel();
    if (row.canvas) row.canvas.width = row.canvas.height = 1;
    row.node.remove();
    this.rows.delete(page);
  }

  reveal(page) {
    const top = (page - 1) * ROW_HEIGHT;
    const height = this.scroll.clientHeight;
    if (top < this.scroll.scrollTop || top + ROW_HEIGHT > this.scroll.scrollTop + height) {
      this.scroll.scrollTop = Math.max(0, top - Math.max(0, height - ROW_HEIGHT) / 2);
    }
    this.paint();
  }

  makeRow(page) {
    const node = document.createElement('div');
    node.setAttribute('role','listitem');
    node.className = 'rail-row';
    node.style.top = (page - 1) * ROW_HEIGHT + 'px';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-page';
    button.dataset.page = page;
    button.onclick = () => this.onChoose(page);
    const frame = document.createElement('span');
    frame.className = 'rail-frame';
    const caption = document.createElement('span');
    caption.className = 'rail-caption';
    const label = document.createElement('span');
    label.textContent = page + 'ページ';
    const mark = document.createElement('span');
    mark.className = 'rail-bookmark';
    const markerIcon = document.createElement('img');
    markerIcon.src = './app-icon.png';
    markerIcon.alt = '';
    markerIcon.width = markerIcon.height = 18;
    mark.append(markerIcon);
    const note = document.createElement('span');
    note.className = 'rail-note';
    note.setAttribute('aria-hidden','true');
    note.innerHTML = icon('note');
    caption.append(label,mark,note);
    button.append(frame,caption);
    node.append(button);
    return { node, button, frame, mark, note };
  }

  paint() {
    if (!this.open || !this.source || !this.scroll.clientHeight) return;
    const {first,last} = visiblePages(this.scroll.scrollTop,this.scroll.clientHeight,this.source.count);
    for (const [page,row] of this.rows) {
      if (page < first || page > last) this.remove(page,row);
    }
    let after = null;
    for (let page = last; page >= first; page--) {
      let row = this.rows.get(page);
      if (!row) {
        row = this.makeRow(page);
        this.rows.set(page,row);
        this.list.insertBefore(row.node,after);
      }
      after = row.node;
      const current = page === this.state.page;
      this.updateBadges(page,row);
      if (current) row.button.setAttribute('aria-current','page');
      else row.button.removeAttribute('aria-current');
    }
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.open || !this.ready) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextPreview();
    }, 100);
  }

  async nextPreview() {
    if (this.job || !this.open || !this.ready) return;
    const midpoint = (this.scroll.scrollTop + this.scroll.clientHeight/2)/ROW_HEIGHT + .5;
    const target = [...this.rows].filter(([,row])=>!row.done)
      .sort(([a],[b])=>Math.abs(a-midpoint)-Math.abs(b-midpoint))[0];
    if (!target) return;
    const [number,row] = target;
    const source = this.source;
    const rotation = this.state.rotation;
    const job = {row};
    this.job = job;
    let page, canvas;
    const relevant = () => this.open && this.ready && this.source === source &&
      this.state.rotation === rotation && this.rows.get(number) === row;
    try {
      page = await source.page(number,rotation);
      if (!relevant()) return;
      const cssScale = Math.min(118/page.width,120/page.height);
      const scale = cssScale * Math.min(devicePixelRatio || 1,2);
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(page.width * scale));
      canvas.height = Math.max(1,Math.round(page.height * scale));
      canvas.style.width = (page.width * cssScale) + 'px';
      canvas.style.height = (page.height * cssScale) + 'px';
      job.task = page.start(canvas.getContext('2d',{alpha:false}),scale,0,0);
      await job.task.promise;
      if (!relevant()) return;
      row.frame.append(canvas);
      row.canvas = canvas;
      row.done = true;
    } catch (error) {
      if (relevant() && error.name !== 'RenderingCancelledException') row.done = true;
    } finally {
      if (canvas && row.canvas !== canvas) canvas.width = canvas.height = 1;
      // The main reader owns cleanup for its active page.
      if (page && this.source === source && number !== this.state?.page) page.cleanup();
      this.job = null;
      if (!this.timer && this.open && this.ready) this.nextPreview();
    }
  }

  handleKey(event) {
    const current = Number(event.target.dataset.page);
    if (!current) return;
    const step = Math.max(1, Math.floor(this.scroll.clientHeight / ROW_HEIGHT));
    const target = {ArrowUp:current-1, ArrowDown:current+1, Home:1,
      End:this.source.count, PageUp:current-step, PageDown:current+step}[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const page = Math.min(this.source.count,Math.max(1,target));
    this.reveal(page);
    this.rows.get(page)?.button.focus({preventScroll:true});
  }
}

