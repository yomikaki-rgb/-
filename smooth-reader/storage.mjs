const NAME = 'yomu-tracker-v1';
let connection;

function request(r) {
  return new Promise((resolve,reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export function openStorage() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('books', {keyPath:'id'});
      db.createObjectStore('originals');
      const marks = db.createObjectStore('marks', {keyPath:['book','page']});
      marks.createIndex('book','book');
      db.createObjectStore('settings');
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('別の画面で本棚が開いています。'));
  }).catch(error => {
    connection = undefined;
    throw error;
  });
  return connection;
}
async function read(store, get) {
  const db = await openStorage();
  return request(get(db.transaction(store).objectStore(store)));
}
async function write(stores, operation) {
  const db = await openStorage();
  let tx;
  try { tx=db.transaction(stores,'readwrite',{durability:'strict'}); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    tx=db.transaction(stores,'readwrite');
  }
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('保存を完了できませんでした。'));
  });
  try { operation(tx); }
  catch (error) {
    tx.abort();
    await done.catch(() => {});
    throw error;
  }
  return done;
}
export const listBooks = () => read('books',s=>s.getAll());
export const original = id => read('originals',s=>s.get(id));
export const readMarks = async (id,page) => (await read('marks',s=>s.get([id,page])))?.items ?? [];
export const readTracker = () => read('settings',s=>s.get('tracker'));
async function scanBookMarks(book,visit) {
  const db = await openStorage();
  const tx = db.transaction('marks');
  return new Promise((resolve,reject)=>{
    const cursor = tx.objectStore('marks').index('book').openCursor(IDBKeyRange.only(book));
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      visit(row.value);
      row.continue();
    };
  });
}
export async function readBookNotes(book) {
  const byPage = new Map();
  await scanBookMarks(book,({page,items})=>{
    const notes = items.filter(item=>item.type==='note');
    if (notes.length) byPage.set(page,notes);
  });
  return byPage;
}
export async function readNotePages(book) {
  const pages = new Set();
  await scanBookMarks(book,({page,items})=>{
    if (items.some(item=>item.type==='note')) pages.add(page);
  });
  return pages;
}
export function addBook(book,blob) {
  return write(['books','originals'],tx => {
    tx.objectStore('books').add(book);
    tx.objectStore('originals').add(blob,book.id);
  });
}
export function saveBook(book) {
  return write(['books'],tx => tx.objectStore('books').put(book));
}
export function saveTracker(tracker) {
  return write(['settings'],tx => tx.objectStore('settings').put(tracker,'tracker'));
}
export function saveMarks(book,page,items) {
  return write(['marks'],tx => {
    const store = tx.objectStore('marks');
    if (items.length) store.put({book,page,items});
    else store.delete([book,page]);
  });
}
export function deleteBook(id) {
  return write(['books','originals','marks'],tx => {
    tx.objectStore('books').delete(id);
    tx.objectStore('originals').delete(id);
    const cursor = tx.objectStore('marks').index('book').openKeyCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      tx.objectStore('marks').delete(cursor.result.primaryKey);
      cursor.result.continue();
    };
  });
}

export function storageMessage(error) {
  if (error?.name === 'QuotaExceededError') return '端末の保存容量が不足しています。空き容量を確認してください。';
  return '端末に保存できませんでした。ブラウザの設定と空き容量を確認してください。';
}
