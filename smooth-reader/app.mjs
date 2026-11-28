import { icon } from './icons.mjs';
import { bookmarkSpot, boundPoint, centerAfter, clamp, mod, newView, onPage, onScreen,
  onPaper, parsePageNumber, revealPoint, trackBox, TRACK_DEFAULT, viewAfterSwipe, writingOrientation } from './geometry.mjs';
import { PageRenderer } from './render.mjs';
import { wireGestures } from './gestures.mjs';
import { fileKind, openSource, validateSize } from './source.mjs';
import * as db from './storage.mjs';
import { PageRail } from './page-rail.mjs';
import { wireSettingsCard } from './settings-card.mjs';
import { VerticalPages } from './vertical-pages.mjs';
import { noteRows, paintPrintNotes, saveTextNotes } from './note-export.mjs';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const uid = () => crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(n=>n.toString(16)).join('-');
const copy = value => structuredClone(value);
const trackerColors = [['青緑','#49c7b7'],['黄色','#ffdf45'],['水色','#57bbf4'],['ピンク','#f585ad'],['緑','#83cf80'],['グレー','#52656a']];
const markerColors = [['黄色','#fbd323'],['ピンク','#f16d9d'],['水色','#42acf0'],['緑','#65c762']];
const penColors = [['黒','#20232a'],['青','#1759a8'],['赤','#bd263d'],['緑','#19755b']];
const inkStyles = {
  marker:{color:markerColors[0][1],width:13,min:5,max:30,step:1},
  pen:{color:penColors[0][1],width:2.5,min:1,max:9,step:.5}
};
let books=[], book=null, source=null, view=null, mode='track', items=[], stroke=null, eraseId=null;
let previewPage=null;
let defaults=TRACK_DEFAULT, inkKind='marker';
let opening=false, importing=false, deleting=false, loading=false, pageToken=0;
let undo=[], redo=[], alertKind, toastTimer, seekTimer;
let dialogAction=null, dialogDeletion=null, dialogDismiss=null, priorFocus=null;
const pending=new Map(), failed=new Map();
let saving=null, activeWrite=null, saveTimer;
const noteNodes=new Map();
let highlightedNote=null, highlightTimer;
let notesSnapshot=null, notesRequest=0;
let railNoteScan=null;
const narrowRail=matchMedia('(max-width:759px), (max-width:1100px) and (orientation:portrait), (max-height:500px) and (pointer:coarse)');

for (const node of all('[data-icon]')) node.insertAdjacentHTML('afterbegin',icon(node.dataset.icon));
wireSettingsCard($('stage'),$('settings'),$('settings-drag'));
const renderer=new PageRenderer($('scene'),()=>({view,mode,items,stroke,eraseId,previewPage}),showNotes,(_error,label)=>{
  if (label==='base') pageMessage('このページを表示できませんでした。');
});
const rail=new PageRail($('rail-scroll'),$('rail-pages'),number=>{
  if (narrowRail.matches) toggleRail(false,true);
  goTo(number);
});
const cancelGesture=wireGestures($('stage'),renderer,{
  state:()=>({view,mode,items}), canInteract:()=>Boolean(book && !loading && !hasModal() && !railOverlay()),
  ink:()=>({kind:inkKind,color:inkStyles[inkKind].color,width:inkStyles[inkKind].width}),
  swipeAxis,id:uid,
  continuous:()=>Boolean(renderer.stack),
  targetAt:annotationTarget,
  stackAnchor:point=>renderer.stack?.anchor(view,renderer.size,point),
  pan:(from,to)=>moveStack(renderer.stack?.anchor(view,renderer.size,from),to,view.zoom),
  zoomAt:moveStack,
  view:setView, settled:()=>{ queuePosition(false,0); renderer.scheduleDetail(); },
  preview:(next,erasing,page)=>{ stroke=next; eraseId=erasing; previewPage=page; renderer.invalidate(); },
  stroke:(value,page)=>applyEdit(null,value,page),
  erase:(id,page)=>applyEdit(itemsFor(page)?.find(item=>item.id===id),null,page),
  note:(id,at)=>openNote(id,at),
  turn:turnBySwipe
});
$('stage').addEventListener('pointerdown',event=>{
  if (event.target===renderer.canvas && !$('ink-panel').hidden) toggleInk(false);
},{capture:true});

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent=message;
  $('toast').hidden=false;
  toastTimer=setTimeout(()=>{ $('toast').hidden=true; },2300);
}
function alertUser(message,kind='general') {
  if (alertKind==='save' && kind==='general') { notify(message); return; }
  alertKind=kind;
  $('alert-text').textContent=message;
  $('retry').hidden=kind!=='save' && kind!=='init';
  $('dismiss-alert').hidden=kind==='save';
  $('alert').hidden=false;
}
$('dismiss-alert').onclick=()=>{ $('alert').hidden=true; alertKind=null; };
$('retry').onclick=()=>{
  if (alertKind==='init') { init(); return; }
  for (const [key,entry] of failed) if (!pending.has(key)) pending.set(key,entry);
  failed.clear();
  flush();
};

function enqueue(entry,delay=0) {
  pending.set(entry.key,entry);
  if (!delay) {
    clearTimeout(saveTimer);
    saveTimer=null;
    flush();
  } else if (!saveTimer) {
    saveTimer=setTimeout(()=>{ saveTimer=null; flush(); },delay);
  }
}
function flush() {
  if (saving) return saving;
  saving=(async()=>{
    while (pending.size) {
      const [key,entry]=pending.entries().next().value;
      pending.delete(key);
      activeWrite=entry;
      try {
        await entry.run();
        failed.delete(key);
      } catch (error) {
        failed.set(key,entry);
        alertUser(db.storageMessage(error) + ' 編集中の内容はこの画面に保持しています。','save');
      } finally { activeWrite=null; }
    }
    if (!failed.size && alertKind==='save') {
      $('alert').hidden=true;
      alertKind=null;
      notify('保存しました');
    }
  })().finally(()=>{ saving=null; if (pending.size) flush(); });
  return saving;
}
function queuePosition(touch=false, delay=200) {
  if (!book || !view) return;
  book={...book,last:copy(view),updated:touch ? Date.now() : book.updated};
  books=books.map(item=>item.id===book.id ? book : item);
  const value=book;
  enqueue({key:'book/'+value.id,run:()=>db.saveBook(value)},delay);
}
function queueMarks(page,value) {
  if (!book) return;
  const id=book.id;
  enqueue({key:'marks/'+id+'/'+page,value,run:()=>db.saveMarks(id,page,value)});
}
async function loadMarks(id,page) {
  const key='marks/'+id+'/'+page;
  const local=pending.get(key) || (activeWrite?.key===key ? activeWrite : null) || failed.get(key);
  return local ? local.value : db.readMarks(id,page);
}
function setView(next, detail=true) {
  const changedPage=next.page!==view.page;
  view=next;
  if (changedPage) {
    refreshPageControls();
    pageMessage('');
  }
  renderer.invalidate();
  if (detail) renderer.scheduleDetail();
  queuePosition();
}
function moveStack(anchor,point,ratio) {
  const stack=renderer.stack;
  if (!stack || !anchor) return false;
  setView(stack.place(view,renderer.size,anchor,point,ratio));
  return true;
}
function itemsFor(page=view?.page) {
  if (renderer.stack) return renderer.stack.pages.get(page)?.items ?? null;
  return page===view?.page && renderer.base ? items : null;
}
function annotationTarget(point,number) {
  if (!renderer.stack) return {number:view.page,cam:renderer.cam,items};
  const row=renderer.stackRows().find(({number:page,cam,entry})=>entry.base && entry.items &&
    (number ? number===page : onPaper(onPage(point,view.rotation,cam))));
  return row && {number:row.number,cam:row.cam,items:row.entry.items};
}
function setTracker(changes) {
  const t={...view.tracker,orientation:writingOrientation(view.tracker),...changes};
  setView({...view,tracker:t});
  const value={...t,anchor:[.5,.44]};
  defaults=value;
  enqueue({key:'settings',run:()=>db.saveTracker(value)},200);
  refreshTools();
}
function pageMessage(message) {
  $('page-state').textContent=message;
  $('page-state').hidden=!message;
}
function refreshPageControls() {
  if (!book) return;
  $('page-status').textContent=view.page+' / '+book.count;
  $('page-status').setAttribute('aria-label',view.page+' / '+book.count+' ページ');
  $('progress').max=book.count;
  $('progress').value=view.page;
  $('progress').disabled=book.count===1;
  $('progress').setAttribute('aria-valuetext',view.page+' / '+book.count+' ページ');
  $('prev').disabled=view.page<=1;
  $('next').disabled=view.page>=book.count;
  $('swipe-direction').disabled=book.count===1;
  const vertical=swipeAxis()==='vertical';
  $('swipe-symbol').textContent=vertical ? '↕' : '↔';
  $('swipe-label').textContent=vertical ? '上下' : '左右';
  $('swipe-direction').setAttribute('aria-label',vertical ?
    'ページ送りは上下。左右に切り替える' : 'ページ送りは左右。上下に切り替える');
  const mark=book.bookmark;
  $('set-bookmark-label').textContent=mark ? 'しおりを更新' : 'しおりを付ける';
  $('bookmark-info').hidden=!mark;
  $('bookmark-info').textContent=mark ? mark.page+'ページ' : '';
  $('goto-bookmark').disabled=$('clear-bookmark').disabled=!mark;
  $('set-bookmark').disabled=loading || !renderer.base;
  $('jump-open').disabled=book.count===1;
  rail.update(view.page,mark?.page,view.rotation);
}
function refreshTools() {
  $('stage').dataset.mode=mode;
  for (const button of all('[data-mode].mode')) button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  $('ink-options').hidden=mode!=='mark';
  $('adjust').hidden=mode!=='track';
  $('visibility').hidden=mode!=='track';
  $('undo').disabled=!undo.length || loading;
  $('redo').disabled=!redo.length || loading;
  refreshInk();
  if (!view) return;
  const t=view.tracker;
  $('visibility').setAttribute('aria-pressed',String(t.visible));
  $('visibility').setAttribute('aria-label',t.visible ? 'トラッカーを隠す' : 'トラッカーを表示');
  $('visibility').innerHTML=icon(t.visible?'eye':'eyeOff')+(t.visible?'表示中':'非表示');
  for (const b of all('[data-shape]')) b.setAttribute('aria-pressed',String(b.dataset.shape===t.shape));
  for (const b of all('[data-angle]')) b.setAttribute('aria-pressed',String(Number(b.dataset.angle)===writingOrientation(t)));
  for (const b of all('#tracker-colors button')) b.setAttribute('aria-pressed',String(b.dataset.color===t.color));
  const units={length:'',width:'',angle:'°',opacity:'%',magnification:'倍'};
  for (const [name,unit] of Object.entries(units)) {
    $(name).value=t[name];
    $(name+'-val').textContent=t[name]+unit;
    $(name).setAttribute('aria-valuetext',t[name]+unit);
  }
  $('magnification-row').hidden=t.shape!=='lens';
}
function showNotes(cam,state,stackRows) {
  const marker=$('line-bookmark');
  const bookmark=book?.bookmark;
  let markerVisible=false;
  const rows=stackRows || (cam && state.view ? [{number:state.view.page,cam,entry:{items:state.items}}] : []);
  const savedRow=rows.find(row=>row.number===bookmark?.page);
  if (savedRow) {
    const at=bookmarkSpot(bookmark);
    if (at) {
      const [x,y]=onScreen(at,state.view.rotation,savedRow.cam);
      const [w,h]=renderer.size;
      if (x>=0 && x<=w && y>=0 && y<=h) {
        marker.style.left=clamp(x,11,w-11)+'px';
        marker.style.top=clamp(y,24,h)+'px';
        markerVisible=true;
      }
    }
  }
  marker.hidden=!markerVisible;
  const seen=new Set();
  for (const row of rows) for (const note of row.entry.items||[]) {
    if (note.type!=='note') continue;
    seen.add(note.id);
    let button=noteNodes.get(note.id);
    if (!button) {
      button=document.createElement('button');
      button.className='note-icon';
      button.dataset.id=note.id;
      button.dataset.page=row.number;
      button.innerHTML='<span>'+icon('note')+'</span>';
      button.onclick=event=>{ if (event.detail===0 && (mode==='track'||mode==='note')) openNote(note.id,undefined,row.number); };
      $('note-layer').append(button);
      noteNodes.set(note.id,button);
    }
    const point=onScreen(note.at,state.view.rotation,row.cam);
    button.style.left=point[0]+'px';
    button.style.top=point[1]+'px';
    button.hidden=point[0]<0 || point[1]<0 || point[0]>renderer.size[0] || point[1]>renderer.size[1];
    button.tabIndex=state.mode==='mark'||state.mode==='erase' ? -1 : 0;
    button.classList.toggle('is-target',note.id===highlightedNote);
    if (note.id===highlightedNote && !button.hidden && !highlightTimer) {
      highlightTimer=setTimeout(()=>{
        highlightedNote=null;
        highlightTimer=null;
        renderer.invalidate();
      },3000);
    }
    button.setAttribute('aria-label','メモを開く');
  }
  for (const [id,node] of noteNodes) if (!seen.has(id)) {
    node.remove();
    noteNodes.delete(id);
  }
}

async function displayPage(focusAt) {
  const token=++pageToken, currentSource=source, desired=copy(view);
  cancelGesture();
  toggleInk(false);
  renderer.clear();
  items=[];
  loading=true;
  rail.setReady(false);
  refreshPageControls();
  refreshTools();
  pageMessage('読み込み中…');
  try {
    const results=await Promise.allSettled([currentSource.page(desired.page,desired.rotation),loadMarks(book.id,desired.page)]);
    if (token!==pageToken) return;
    if (results[1].status==='rejected') {
      pageMessage('書き込みを読み込めませんでした。本棚から開き直してください。');
      return;
    }
    if (results[0].status==='rejected') throw results[0].reason;
    items=results[1].value;
    const page=results[0].value;
    if (swipeAxis()==='vertical' && book.count>1) {
      const id=book.id;
      if (focusAt) { view={...view,center:boundPoint(focusAt)}; queuePosition(false,0); }
      const stack=new VerticalPages(currentSource,desired.rotation,number=>loadMarks(id,number),()=>{
        if (renderer.stack!==stack || token!==pageToken) return;
        const active=stack.pages.get(view.page);
        if (active?.base) pageMessage('');
        else if (active?.baseFailed) pageMessage('このページを表示できませんでした。');
        $('set-bookmark').disabled=!renderer.base;
        renderer.invalidate();
        renderer.scheduleDetail();
      });
      stack.seed(desired.page,page,items);
      renderer.attachStack(stack);
      return;
    }
    if (focusAt) {
      const {width,height}=renderer.canvas.getBoundingClientRect();
      const adjusted=revealPoint(view,page,[width,height],focusAt);
      if (adjusted!==view) { view=adjusted; queuePosition(false,0); }
    }
    if (await renderer.load(page) && token===pageToken) pageMessage('');
  } catch (_error) {
    if (token===pageToken) pageMessage('このページを表示できませんでした。');
  } finally {
    if (token===pageToken) {
      loading=false;
      rail.setReady(true);
      refreshPageControls();
      refreshTools();
    }
  }
}
function goTo(page,restore,focusAt) {
  if (!book || !source) return;
  const n=clamp(page,1,book.count);
  if (n===view.page && !restore) { refreshPageControls(); return; }
  clearTimeout(seekTimer);
  $('seek-value').hidden=true;
  const next=restore ? copy(restore) : newView(view.tracker,n,view.rotation);
  // Keep the line guide near the same place when turning a page.
  if (!restore) next.tracker.anchor=copy(view.tracker.anchor);
  view=next;
  queuePosition(true,0);
  displayPage(focusAt);
}
function swipeAxis() {
  return book?.swipeAxis==='vertical' ? 'vertical' : 'horizontal';
}
function turnBySwipe(delta,axis) {
  if (!book || !view || loading) return;
  const page=view.page+delta;
  if (page<1 || page>book.count) return;
  goTo(page,viewAfterSwipe(view,page,axis,delta));
}
function zoom(next) {
  if (!renderer.cam || !renderer.base || loading) return;
  const at=renderer.size.map(n=>n/2);
  if (next===1) { setView({...view,zoom:1,center:[.5,.5]}); return; }
  if (renderer.stack && moveStack(renderer.stack.anchor(view,renderer.size,at),at,clamp(next,1,8))) return;
  setView(centerAfter(view,renderer.page,renderer.size,onPage(at,view.rotation,renderer.cam),at,clamp(next,1,8)));
}
function rotatePage() {
  if (!view || !source) return;
  view={...view,rotation:mod(view.rotation+90,360)};
  queuePosition(true,0);
  displayPage();
}
function toggleSettings(open) {
  $('settings').hidden=!open;
  $('adjust').setAttribute('aria-expanded',String(open));
}
function toggleInk(open) {
  $('ink-panel').hidden=!open;
  $('write').setAttribute('aria-expanded',String(open));
  $('ink-options').setAttribute('aria-expanded',String(open));
}
function refreshInk() {
  const pen=inkKind==='pen';
  const {color,width,min,max,step}=inkStyles[inkKind];
  $('ink-label').textContent=pen ? 'ペン' : 'マーカー';
  $('mark-colors').hidden=pen;
  $('pen-colors').hidden=!pen;
  for (const button of all('[data-ink]')) {
    button.setAttribute('aria-pressed',String(button.dataset.ink===inkKind));
  }
  for (const button of all('#pen-colors button,#mark-colors button')) {
    button.setAttribute('aria-pressed',String(button.dataset.color===color));
  }
  const slider=$('ink-width');
  slider.min=min;
  slider.max=max;
  slider.step=step;
  slider.value=width;
  slider.setAttribute('aria-valuetext',String(width));
  $('ink-width-value').textContent=width;
}
function hasModal() {
  return ['dialog','jump-dialog','notes-dialog'].some(id=>$(id).open);
}
function railOverlay() {
  return narrowRail.matches && rail.open;
}
function syncRailOverlay() {
  $('rail-shade').hidden=!railOverlay();
  $('stage').inert=railOverlay();
}
function toggleRail(open,restoreFocus=false) {
  if (open) cancelGesture();
  $('page-rail').hidden=!open;
  $('rail-toggle').setAttribute('aria-expanded',String(open));
  rail.setOpen(open);
  syncRailOverlay();
  if (open) {
    loadRailNotePages();
    $('rail-close').focus({preventScroll:true});
  }
  if (!open && restoreFocus) $('rail-toggle').focus({preventScroll:true});
}
function setMode(next) {
  cancelGesture();
  mode=next;
  if (next!=='track') toggleSettings(false);
  if (next!=='mark') toggleInk(false);
  refreshTools();
  renderer.invalidate();
  renderer.scheduleDetail();
}

function editPage(before,after,index,page=view.page) {
  const id=(before||after).id;
  const current=itemsFor(page);
  if (!current) return;
  const remaining=current.filter(item=>item.id!==id);
  if (after) remaining.splice(index,0,after);
  if (renderer.stack) renderer.stack.pages.get(page).items=remaining;
  if (page===view.page) items=remaining;
  if (before?.type==='note' || after?.type==='note') {
    const present=remaining.some(item=>item.type==='note');
    railNoteScan?.changes?.set(page,present);
    rail.setNotePage(page,present);
  }
  queueMarks(page,remaining);
  renderer.invalidate();
}
function applyEdit(before,after,page=view?.page) {
  if (!book || loading || !(before||after)) return;
  const current=itemsFor(page);
  if (!current) return;
  const index=before ? current.findIndex(item=>item.id===before.id) : current.length;
  if (index<0) return;
  editPage(before,after,index,page);
  undo.push({page,before,after,index});
  if (undo.length>80) undo.shift();
  redo=[];
  refreshTools();
}
async function historyAction(reverse) {
  const from=reverse?undo:redo, to=reverse?redo:undo;
  if (!book || loading || !from.length) return;
  const action=from.pop(), id=book.id;
  if (view.page!==action.page && !itemsFor(action.page)) {
    view={...newView(view.tracker,action.page,view.rotation),tracker:copy(view.tracker)};
    queuePosition(true,0);
    await displayPage();
  }
  if (book?.id!==id || !itemsFor(action.page)) {
    if (book?.id===id) from.push(action);
    refreshTools();
    return;
  }
  editPage(reverse?action.after:action.before,reverse?action.before:action.after,action.index,action.page);
  to.push(action);
  refreshTools();
}

function showDialog({title,body='',field=null,initial='',ok='閉じる',cancel='閉じる',onAction=null,onDelete=null,onDismiss=null}) {
  if ($('dialog').open) return false;
  priorFocus=document.activeElement;
  dialogAction=onAction;
  dialogDeletion=onDelete;
  dialogDismiss=onDismiss;
  $('dialog-title').textContent=title;
  $('dialog-body').textContent=body;
  $('dialog-body').hidden=!body;
  $('note-field').hidden=!field;
  $('note-text').value=initial;
  $('note-text').placeholder='メモを書く';
  $('note-text').autofocus=Boolean(field);
  $('dialog-ok').textContent=ok;
  $('dialog-delete').hidden=!onDelete;
  $('dialog-cancel').hidden=!onAction && !onDismiss;
  $('dialog-cancel').textContent=cancel;
  $('dialog').showModal();
  if (field) $('note-text').focus();
  else $('dialog-ok').focus();
  return true;
}
function closeDialog(result='dismiss') {
  if (!$('dialog').open) return;
  const dismiss=dialogDismiss, focus=priorFocus;
  dialogAction=dialogDeletion=dialogDismiss=priorFocus=null;
  $('dialog').close(result);
  if (result==='dismiss') dismiss?.();
  if (focus?.isConnected) focus.focus({preventScroll:true});
}
$('dialog-form').onsubmit=event=>{
  event.preventDefault();
  if (!dialogAction) closeDialog('done');
  else dialogAction($('note-text').value);
};
$('dialog-cancel').onclick=()=>closeDialog();
$('dialog-delete').onclick=()=>dialogDeletion?.();
$('dialog').addEventListener('cancel',event=>{ event.preventDefault(); closeDialog(); });
async function askPassword(retry) {
  return new Promise(resolve=>{
    const field=document.createElement('input');
    field.type='password';
    field.autocomplete='off';
    field.setAttribute('aria-label','パスワード');
    field.style.cssText='width:100%;padding:10px;border:1px solid #9bb8b5;border-radius:8px;margin-top:10px;font-size:1rem';
    const opened=showDialog({
      title:'PDFのパスワード',body:retry?'パスワードを確認してください。':'このPDFにはパスワードが必要です。',
      ok:'開く',cancel:'中止',
      onAction:()=>{
        if (!field.value) { field.focus(); return; }
        const value=field.value;
        field.remove();
        closeDialog('done');
        resolve(value);
      },
      onDismiss:()=>{ field.remove(); resolve(null); }
    });
    if (!opened) { resolve(null); return; }
    $('dialog-body').after(field);
    field.focus();
  });
}
function openNote(id,at,page=view?.page) {
  if (!book || loading) return;
  const existing=id && itemsFor(page)?.find(item=>item.id===id);
  if (!existing && !at) return;
  const currentBook=book.id;
  const allowed=()=>book?.id===currentBook && itemsFor(page)!==null;
  showDialog({
    title:existing ? 'メモ' : '新しいメモ',field:'note',initial:existing?.text || '',
    ok:'保存',cancel:'閉じる',
    onAction:text=>{
      const content=text.trim();
      if (!content) { $('note-text').focus(); return; }
      closeDialog('done');
      if (allowed() && content!==existing?.text) {
        applyEdit(existing||null,{type:'note',id:existing?.id||uid(),at:existing?.at||boundPoint(at),text:content},page);
      }
    },
    onDelete: existing ? ()=>{ closeDialog('done'); if (allowed()) applyEdit(existing,null,page); } : null
  });
}

function notesOverrides(id) {
  const pages=new Map();
  const prefix='marks/'+id+'/';
  for (const entry of [...failed.values(),activeWrite,...pending.values()]) {
    if (entry?.key.startsWith(prefix)) {
      pages.set(Number(entry.key.slice(prefix.length)),entry.value);
    }
  }
  if (!loading && renderer.base && itemsFor()) pages.set(view.page,itemsFor());
  return pages;
}

async function loadRailNotePages() {
  if (!book || railNoteScan) return;
  const id=book.id;
  const scan={changes:new Map()};
  railNoteScan=scan;
  for (const [page,marks] of notesOverrides(id)) {
    scan.changes.set(page,marks.some(item=>item.type==='note'));
  }
  try {
    const pages=await db.readNotePages(id);
    if (railNoteScan!==scan) return;
    for (const [page,present] of scan.changes) {
      if (present) pages.add(page);
      else pages.delete(page);
    }
    scan.changes=null;
    rail.setNotePages(pages);
  } catch (_error) {
    if (railNoteScan!==scan) return;
    railNoteScan=null;
    if (rail.open) notify('メモの印を読み込めませんでした。');
  }
}

async function openNotesList() {
  if (!book || hasModal()) return;
  cancelGesture();
  const {id,name}=book;
  const request=++notesRequest;
  const local=notesOverrides(id);
  notesSnapshot=null;
  $('notes-book').textContent=name;
  $('notes-status').textContent='読み込み中…';
  $('notes-list').replaceChildren();
  $('notes-save').disabled=$('notes-print-button').disabled=true;
  $('notes-dialog').showModal();
  const stillOpen=()=>notesRequest===request && $('notes-dialog').open && book?.id===id;
  try {
    const byPage=await db.readBookNotes(id);
    if (!stillOpen()) return;
    for (const [page,notes] of local) byPage.set(page,notes);
    const rows=noteRows(byPage);
    notesSnapshot={name,rows};
    $('notes-status').textContent=rows.length ? '' : 'この本にメモはありません。';
    $('notes-save').disabled=$('notes-print-button').disabled=!rows.length;
    const content=document.createDocumentFragment();
    for (const note of rows) {
      const row=document.createElement('li');
      const header=document.createElement('div');
      header.className='note-row-head';
      const label=document.createElement('strong');
      label.textContent=note.page+'ページ';
      const go=document.createElement('button');
      go.type='button';
      go.className='button';
      go.textContent='本文へ';
      go.setAttribute('aria-label',note.page+'ページのメモの位置へ');
      go.onclick=()=>jumpToNote(note);
      header.append(label,go);
      const text=document.createElement('p');
      text.textContent=note.text;
      row.append(header,text);
      content.append(row);
    }
    $('notes-list').append(content);
  } catch (_error) {
    if (stillOpen()) $('notes-status').textContent='メモを読み込めませんでした。';
  }
}

function jumpToNote(note) {
  $('notes-dialog').close();
  if (railOverlay()) toggleRail(false);
  if (mode==='mark' || mode==='erase') setMode('track');
  toggleSettings(false);
  highlightedNote=note.id;
  clearTimeout(highlightTimer);
  highlightTimer=null;
  const next={...copy(view),page:note.page,center:boundPoint(note.at)};
  goTo(note.page,next,note.at);
}

$('notes-open').onclick=openNotesList;
$('notes-close').onclick=()=>$('notes-dialog').close();
$('notes-dialog').addEventListener('close',()=>{
  if ($('notes-dialog').open) return;
  ++notesRequest;
  notesSnapshot=null;
  document.documentElement.classList.remove('print-notes');
  $('notes-print').replaceChildren();
  $('notes-print').hidden=true;
});
$('notes-save').onclick=()=>{
  if (notesSnapshot?.rows.length) saveTextNotes(notesSnapshot.name,notesSnapshot.rows);
};
$('notes-print-button').onclick=()=>{
  if (!notesSnapshot?.rows.length) return;
  const print=$('notes-print');
  paintPrintNotes(print,notesSnapshot.name,notesSnapshot.rows);
  print.hidden=false;
  document.documentElement.classList.add('print-notes');
  window.print();
};

function renderShelf() {
  const sorted=[...books].sort((a,b)=>b.updated-a.updated);
  $('empty').hidden=sorted.length>0;
  $('books').replaceChildren();
  for (const item of sorted) {
    const row=document.createElement('li');
    row.className='book';
    const open=document.createElement('button');
    open.type='button';
    open.className='book-open';
    const art=document.createElement('span');
    art.className='book-art';
    art.innerHTML=icon('file');
    art.append(item.kind==='jpeg'?'JPEG':item.kind.toUpperCase());
    const detail=document.createElement('span');
    detail.className='book-detail';
    const title=document.createElement('strong');
    title.textContent=item.name;
    title.title=item.name;
    const pages=document.createElement('small');
    pages.textContent=item.last.page+' / '+item.count+' ページ'+(item.bookmark ? '　·　しおりあり':'');
    detail.append(title,pages);
    open.append(art,detail);
    open.onclick=()=>openBook(item.id);
    const remove=document.createElement('button');
    remove.className='button danger';
    remove.innerHTML=icon('trash');
    remove.setAttribute('aria-label',item.name+'を本棚から削除');
    remove.title='本棚から削除';
    remove.onclick=()=>confirmDelete(item);
    row.append(open,remove);
    $('books').append(row);
  }
}
async function openBook(id) {
  if (opening || importing || deleting || source) return;
  const item=books.find(candidate=>candidate.id===id);
  if (!item) return;
  opening=true;
  notify('本を開いています…');
  try {
    const blob=await db.original(id);
    if (!blob) throw new Error('原本が見つかりません。本を追加し直してください。');
    source=await openSource(blob,item.kind,askPassword);
    rail.setSource(source);
    book=item;
    view=copy(item.last);
    mode='track';
    undo=[];
    redo=[];
    $('library').hidden=true;
    $('reader').hidden=false;
    $('toast').hidden=true;
    queuePosition(true,0);
    await displayPage();
  } catch (error) {
    if (error.name!=='AbortError') alertUser(error.message || '本を開けませんでした。');
  } finally { opening=false; }
}
async function closeBook() {
  if (!source) return;
  clearTimeout(seekTimer);
  $('seek-value').hidden=true;
  const current=source;
  queuePosition(false,0);
  ++pageToken;
  cancelGesture();
  const idle=renderer.clear();
  clearTimeout(highlightTimer);
  highlightedNote=highlightTimer=null;
  toggleRail(false);
  railNoteScan=null;
  rail.setSource(null);
  source=book=view=null;
  items=[];
  toggleSettings(false);
  $('reader').hidden=true;
  $('library').hidden=false;
  renderShelf();
  try { await idle; await current.close(); }
  catch (_error) { /* The previous worker may already have closed. */ }
  $('add').focus({preventScroll:true});
}
function confirmDelete(item) {
  if (opening||importing||deleting) return;
  showDialog({
    title:'本棚から削除',body:item.name+'\nこの本のしおりと書き込みも削除します。',ok:'削除',cancel:'キャンセル',
    onAction:async()=>{
      deleting=true;
      closeDialog('done');
      try {
        await flush();
        await db.deleteBook(item.id);
        failed.delete('book/'+item.id);
        for (const key of failed.keys()) if (key.startsWith('marks/'+item.id+'/')) failed.delete(key);
        if (alertKind==='save' && !failed.size) { $('alert').hidden=true; alertKind=null; }
        books=books.filter(value=>value.id!==item.id);
        renderShelf();
        notify('本棚から削除しました');
      } catch (error) { alertUser(db.storageMessage(error)); }
      finally { deleting=false; }
    }
  });
}
async function importBooks(files) {
  if (!files.length || importing || opening || deleting) return;
  importing=true;
  $('add').disabled=true;
  $('add').lastChild.textContent='読み込み中…';
  navigator.storage?.persist?.().catch(()=>{});
  const errors=[];
  let added=0;
  for (const file of files) {
    let candidate;
    try {
      const kind=await fileKind(file);
      validateSize(file,kind);
      candidate=await openSource(file,kind,askPassword);
      const count=candidate.count;
      if (!Number.isSafeInteger(count) || count<1) throw new Error('ページのないファイルです。');
      const entry={id:uid(),name:file.name||'名前のない本',kind,count,
        last:newView(defaults),bookmark:null,updated:Date.now()};
      try { await db.addBook(entry,file); }
      catch (error) { throw new Error(db.storageMessage(error),{cause:error}); }
      books.push(entry);
      added++;
    } catch (error) {
      if (error.name!=='AbortError') errors.push(file.name+' — '+error.message);
    } finally {
      if (candidate) await candidate.close().catch(()=>{});
    }
  }
  $('add').lastChild.textContent='本を追加';
  $('add').disabled=false;
  importing=false;
  renderShelf();
  if (added) notify(added+'冊を本棚に追加しました');
  if (errors.length) alertUser(errors.slice(0,3).join('　')+(errors.length>3 ? '　ほか'+(errors.length-3)+'件':''));
}

function palette(id,colors,handler) {
  for (const [name,color] of colors) {
    const button=document.createElement('button');
    button.className='swatch';
    button.dataset.color=color;
    button.title=name;
    button.setAttribute('aria-label',name);
    button.style.setProperty('--swatch',color);
    button.append(document.createElement('span'));
    button.onclick=()=>handler(color);
    $(id).append(button);
  }
}
palette('mark-colors',markerColors,color=>{ inkStyles.marker.color=color; refreshInk(); });
palette('pen-colors',penColors,color=>{ inkStyles.pen.color=color; refreshInk(); });
palette('tracker-colors',trackerColors,color=>setTracker({color}));
$('files').onchange=event=>{ importBooks([...event.target.files]); event.target.value=''; };
$('add').onclick=()=>{
  navigator.storage?.persist?.().catch(()=>{});
  $('files').click();
};
$('back').onclick=closeBook;
$('fit').onclick=()=>zoom(1);
$('zoom-in').onclick=()=>zoom(view.zoom*1.28);
$('zoom-out').onclick=()=>zoom(Math.max(1,view.zoom/1.28));
$('rotate-page').onclick=rotatePage;
$('prev').onclick=()=>goTo(view.page-1);
$('next').onclick=()=>goTo(view.page+1);
$('swipe-direction').onclick=()=>{
  if (!book) return;
  const next=swipeAxis()==='vertical' ? 'horizontal' : 'vertical';
  cancelGesture();
  book={...book,swipeAxis:next};
  if (next==='horizontal') view={...view,center:boundPoint(view.center)};
  queuePosition(false,0);
  displayPage();
  notify(next==='vertical' ? 'ページ送り：上下' : 'ページ送り：左右');
};
$('rail-toggle').onclick=()=>toggleRail(!rail.open);
$('rail-close').onclick=$('rail-shade').onclick=()=>toggleRail(false,true);
narrowRail.addEventListener('change',syncRailOverlay);
$('jump-open').onclick=()=>{
  if (!book || hasModal()) return;
  cancelGesture();
  const input=$('page-number');
  input.value=String(view.page);
  $('jump-range').textContent='1〜'+book.count+'ページ';
  clearJumpError();
  $('jump-dialog').showModal();
  input.focus();
  input.select();
};
function clearJumpError() {
  $('jump-error').hidden=true;
  $('page-number').removeAttribute('aria-invalid');
}
$('page-number').oninput=clearJumpError;
$('jump-close').onclick=()=>$('jump-dialog').close();
$('page-form').onsubmit=event=>{
  event.preventDefault();
  if (!book) return;
  const input=$('page-number');
  const page=parsePageNumber(input.value,book.count);
  if (page===null) {
    $('jump-error').textContent='1〜'+book.count+'のページ番号を入力してください。';
    $('jump-error').hidden=false;
    input.setAttribute('aria-invalid','true');
    input.focus();
    input.select();
    return;
  }
  $('jump-dialog').close();
  if (railOverlay()) toggleRail(false);
  goTo(page);
};
$('progress').oninput=event=>{
  const n=Number(event.target.value);
  $('progress').setAttribute('aria-valuetext',n+' / '+book.count+' ページ');
  $('seek-value').textContent=n+' / '+book.count;
  $('seek-value').hidden=false;
  clearTimeout(seekTimer);
  seekTimer=setTimeout(()=>{ if (view) goTo(n); $('seek-value').hidden=true; },360);
};
$('progress').onchange=event=>{
  clearTimeout(seekTimer);
  $('seek-value').hidden=true;
  goTo(Number(event.target.value));
};
$('set-bookmark').onclick=()=>{
  if (!book || !view || loading || !renderer.base) return;
  if (mode!=='track' || !view.tracker.visible || (view.tracker.opacity===0 && view.tracker.shape!=='lens')) {
    setMode('track');
    setTracker({visible:true,...(view.tracker.opacity===0 ? {opacity:TRACK_DEFAULT.opacity} : {})});
    notify('読み終えた行にトラッカーを合わせて、もう一度押してください。');
    return;
  }
  const cam=renderer.cam;
  if (!cam) return;
  const box=trackBox(view.tracker,cam,view.rotation,renderer.size);
  const at=boundPoint(onPage([box.x,box.y],view.rotation,cam));
  const hadBookmark=Boolean(book.bookmark);
  const bookmark={...copy(view),at,tracker:{...copy(view.tracker),anchor:at}};
  book={...book,bookmark};
  queuePosition(false,0);
  refreshPageControls();
  renderer.invalidate();
  notify(hadBookmark ? 'しおりを更新しました' : 'しおりを付けました');
};
$('clear-bookmark').onclick=()=>{
  if (!book?.bookmark || hasModal()) return;
  const id=book.id;
  showDialog({
    title:'しおり '+book.bookmark.page+'ページ',body:'このしおりを外しますか？',ok:'外す',
    onAction:()=>{
      closeDialog('done');
      if (book?.id!==id) return;
      book={...book,bookmark:null};
      queuePosition(false,0);
      refreshPageControls();
      renderer.invalidate();
      $('set-bookmark').focus({preventScroll:true});
      notify('しおりを外しました');
    }
  });
};
$('goto-bookmark').onclick=()=>{
  if (!book?.bookmark) return;
  const {at,...saved}=book.bookmark;
  if (railOverlay()) toggleRail(false);
  toggleSettings(false);
  setMode('track');
  goTo(saved.page,saved,at || bookmarkSpot(saved));
};
$('adjust').onclick=()=>{
  const open=$('settings').hidden;
  if (open && mode!=='track') setMode('track');
  if (open && !view.tracker.visible) setTracker({visible:true});
  toggleSettings(open);
};
$('close-settings').onclick=()=>{ toggleSettings(false); $('adjust').focus(); };
$('visibility').onclick=()=>{
  const visible=!view.tracker.visible;
  setTracker({visible});
  if (!visible) toggleSettings(false);
};
$('reset').onclick=()=>setTracker({...TRACK_DEFAULT,anchor:[...TRACK_DEFAULT.anchor]});
for (const button of all('[data-mode].mode:not(#write)')) button.onclick=()=>setMode(button.dataset.mode);
$('write').onclick=()=>{
  const open=mode!=='mark' || $('ink-panel').hidden;
  if (mode!=='mark') setMode('mark');
  toggleInk(open);
};
$('ink-options').onclick=()=>toggleInk($('ink-panel').hidden);
$('ink-close').onclick=()=>{ toggleInk(false); $('write').focus(); };
for (const button of all('[data-ink]')) button.onclick=()=>{
  cancelGesture();
  inkKind=button.dataset.ink;
  refreshInk();
};
$('ink-width').oninput=event=>{
  inkStyles[inkKind].width=Number(event.target.value);
  $('ink-width-value').textContent=event.target.value;
  event.target.setAttribute('aria-valuetext',event.target.value);
};
for (const button of all('[data-shape]')) button.onclick=()=>setTracker({shape:button.dataset.shape,visible:true});
for (const button of all('[data-angle]')) button.onclick=()=>{
  const orientation=Number(button.dataset.angle);
  setTracker({angle:orientation,orientation});
};
for (const button of all('[data-reset]')) button.onclick=()=>{
  const key=button.dataset.reset;
  setTracker({[key]:key==='angle' ? writingOrientation(view.tracker) : TRACK_DEFAULT[key]});
};
for (const button of all('[data-angle-step]')) button.onclick=()=>setTracker({angle:clamp(view.tracker.angle+Number(button.dataset.angleStep),-180,180)});
for (const name of ['length','width','angle','opacity','magnification']) {
  $(name).oninput=event=>setTracker({[name]:Number(event.target.value)});
}
$('undo').onclick=()=>historyAction(true);
$('redo').onclick=()=>historyAction(false);
document.addEventListener('keydown',event=>{
  if (!book || hasModal() || event.target.matches('input,textarea,select')) return;
  if (event.key==='Escape') {
    if (!$('ink-panel').hidden) toggleInk(false);
    else if (!$('settings').hidden) toggleSettings(false);
    else if (rail.open) toggleRail(false,true);
    return;
  }
  if ((event.metaKey||event.ctrlKey) && ['z','y'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    historyAction(event.key.toLowerCase()==='z' && !event.shiftKey);
    return;
  }
  if (event.metaKey||event.ctrlKey||event.altKey) return;
  if (event.key==='ArrowLeft'||event.key==='ArrowRight') {
    event.preventDefault();
    goTo(view.page+(event.key==='ArrowRight'?1:-1));
  }
});

document.addEventListener('visibilitychange',()=>{ if (document.hidden) { queuePosition(false,0); flush(); } });
window.addEventListener('pagehide',()=>{ queuePosition(false,0); flush(); });

async function init() {
  $('add').disabled=true;
  try {
    [books,defaults]=await Promise.all([db.listBooks(),db.readTracker()]);
    defaults={...TRACK_DEFAULT,...defaults,orientation:writingOrientation(defaults||TRACK_DEFAULT)};
    renderShelf();
    $('add').disabled=false;
    if (alertKind==='init') { $('alert').hidden=true; alertKind=null; }
  } catch (error) {
    alertUser(db.storageMessage(error),'init');
  }
}
init();
if ('serviceWorker' in navigator && !document.querySelector('meta[name="smooth-reader-preview"]')) {
  navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});
}
