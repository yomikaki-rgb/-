import { camera, centerAfter, clamp, onPage, pixelScale, turned } from './geometry.mjs';

const GAP=16;
const RADIUS=3;
const BASE_PIXELS=1_250_000;
const DETAIL_PIXELS=2_400_000;

export function verticalLayout(view,size,pages,count=Infinity) {
  if (!size.every(Boolean) || !pages.get(view.page)?.page) return [];
  const rows=[];
  let first=view.page;
  while (pages.get(first-1)?.page) first--;
  for (let number=first; pages.get(number)?.page; number++) {
    const entry=pages.get(number);
    rows.push({number,entry,cam:camera(view,entry.page,size)});
  }
  const active=rows.find(row=>row.number===view.page);
  const center=turned(view.center,view.rotation);
  const before=rows.filter(row=>row.number<view.page).reduce((sum,row)=>sum+row.cam.h+GAP,0);
  const height=rows.reduce((sum,row)=>sum+row.cam.h,0)+(rows.length-1)*GAP;
  const desired=size[1]/2-center[1]*active.cam.h-before;
  const pad=active.cam.pad;
  let top;
  if (height>size[1]-2*pad) {
    top=clamp(desired,size[1]-height-pad,pad);
  } else if (first===1 && rows.at(-1).number===count) {
    top=(size[1]-height)/2;
  } else {
    // A short, partial window can occur while neighboring pages are loading.
    const middle=size[1]/2;
    const min=rows.at(-1).number===count ? size[1]-pad-height : middle-height;
    const max=first===1 ? pad : middle;
    top=clamp(desired,Math.min(min,max),max);
  }
  for (const row of rows) {
    row.cam.y=top;
    top+=row.cam.h+GAP;
  }
  return rows;
}

export function rowNear(rows,y) {
  let best, bestDistance=Infinity;
  for (const row of rows) {
    const distance=Math.max(row.cam.y-y,y-row.cam.y-row.cam.h,0);
    if (distance<bestDistance) {
      best=row;
      bestDistance=distance;
    }
  }
  return best;
}

export function placeVertical(view,size,pages,anchor,point,zoom,count=Infinity) {
  const page=pages.get(anchor?.number)?.page;
  if (!page) return view;
  const draft=centerAfter({...view,page:anchor.number},page,size,anchor.at,point,zoom);
  const x=turned(draft.center,view.rotation)[0];
  const y=turned(anchor.at,view.rotation)[1]+(size[1]/2-point[1])/camera(draft,page,size).h;
  draft.center=turned([x,y],-view.rotation);
  const row=rowNear(verticalLayout(draft,size,pages,count),size[1]/2);
  if (!row) return view;
  return {...draft,page:row.number,center:turned([x,(size[1]/2-row.cam.y)/row.cam.h],-view.rotation)};
}

function dispose(surface) {
  if (surface) surface.canvas.width=surface.canvas.height=1;
}

export class VerticalPages {
  constructor(source,rotation,readMarks,changed) {
    this.source=source;
    this.rotation=rotation;
    this.readMarks=readMarks;
    this.changed=changed;
    this.pages=new Map();
    this.jobs=new Set();
    this.closed=false;
  }

  seed(number,page,items) {
    this.pages.set(number,{number,page,items});
  }

  sync(view,size) {
    this.view=view;
    this.size=size;
    const min=Math.max(1,view.page-RADIUS), max=Math.min(this.source.count,view.page+RADIUS);
    if (this.detailNumber!==view.page) {
      this.detailRequest=null;
      this.detailNumber=view.page;
      if (this.running?.store==='detail' && this.running.entry.number!==view.page) this.running.task?.cancel();
    }
    for (const [number,entry] of this.pages) {
      if (number<min || number>max) this.drop(entry);
      else if (number!==view.page && entry.detail) {
        dispose(entry.detail);
        entry.detail=null;
      }
    }
    for (let number=min;number<=max;number++) {
      if (!this.pages.has(number)) this.fetch(number);
    }
    this.pump();
  }

  fetch(number) {
    const entry={number,page:null,items:null};
    this.pages.set(number,entry);
    const work=Promise.allSettled([this.source.page(number,this.rotation),this.readMarks(number)]).then(([page,marks])=>{
      if (this.closed || this.pages.get(number)!==entry) {
        if (page.status==='fulfilled') page.value.cleanup();
        return;
      }
      if (page.status==='fulfilled') entry.page=page.value;
      if (marks.status==='fulfilled' && entry.items===null) entry.items=marks.value;
      this.changed();
      this.pump();
    }).finally(()=>this.jobs.delete(work));
    this.jobs.add(work);
  }

  drop(entry) {
    this.pages.delete(entry.number);
    dispose(entry.base);
    dispose(entry.detail);
    if (this.running?.entry===entry) this.running.task?.cancel();
    else entry.page?.cleanup();
  }

  close() {
    this.closed=true;
    for (const entry of this.pages.values()) this.drop(entry);
    return Promise.allSettled([...this.jobs]);
  }

  layout(view,size) {
    return verticalLayout(view,size,this.pages,this.source.count);
  }

  anchor(view,size,point) {
    const row=rowNear(this.layout(view,size),point[1]);
    return row && {number:row.number,at:onPage(point,view.rotation,row.cam)};
  }

  place(view,size,anchor,point,zoom) {
    return placeVertical(view,size,this.pages,anchor,point,zoom,this.source.count);
  }

  requestDetail(view,size,lens) {
    const row=this.layout(view,size).find(item=>item.number===view.page);
    if (!row?.entry.base) return;
    const {cam,entry}=row;
    const page=entry.page;
    const margin=120/cam.scale;
    const x=clamp(-cam.x/cam.scale-margin,0,page.width);
    const y=clamp(-cam.y/cam.scale-margin,0,page.height);
    const w=clamp((size[0]-cam.x)/cam.scale+margin,0,page.width)-x;
    const h=clamp((size[1]-cam.y)/cam.scale+margin,0,page.height)-y;
    if (w<=0 || h<=0) return;
    const scale=pixelScale(w,h,cam.scale*Math.min(devicePixelRatio || 1,2)*lens,DETAIL_PIXELS);
    if (scale<=entry.base.scale*1.15) return;
    const fits=tile=>tile && scale>=tile.scale*.8 && scale<=tile.scale*1.2 &&
      Math.abs(tile.x-x)<margin*.4 && Math.abs(tile.y-y)<margin*.4 &&
      Math.abs(tile.w-w)<margin*.4 && Math.abs(tile.h-h)<margin*.4;
    if (fits(entry.detail) || (this.detailRequest?.entry===entry && fits(this.detailRequest.region)) ||
        (this.running?.entry===entry && this.running.store==='detail' && fits(this.running.region))) return;
    this.detailRequest={entry,region:{x,y,w,h,scale},store:'detail'};
    this.pump();
  }

  pump() {
    if (this.closed || this.running || !this.view || !this.size.every(Boolean)) return;
    const rows=this.layout(this.view,this.size);
    const visible=row=>row.cam.y<this.size[1]+GAP && row.cam.y+row.cam.h>-GAP;
    const pending=row=>row.entry.page && !row.entry.base && !row.entry.baseFailed;
    const needed=rows.filter(row=>visible(row) && pending(row))
      .sort((a,b)=>Math.abs(a.number-this.view.page)-Math.abs(b.number-this.view.page))[0];
    if (needed) {
      this.renderBase(needed);
      return;
    }
    const detail=this.detailRequest;
    if (detail) {
      this.detailRequest=null;
      this.render(detail.entry,detail.region,detail.store);
      return;
    }
    const nearby=rows.filter(pending).sort((a,b)=>Math.abs(a.number-this.view.page)-Math.abs(b.number-this.view.page))[0];
    if (nearby) this.renderBase(nearby);
  }

  renderBase({entry,cam}) {
    const {width:w,height:h}=entry.page;
    const wanted=Math.max(cam.fit,Math.min(cam.scale,cam.fit*1.8))*Math.min(devicePixelRatio || 1,2);
    this.render(entry,{x:0,y:0,w,h,scale:pixelScale(w,h,wanted,BASE_PIXELS)},'base');
  }

  render(entry,region,store) {
    const running={entry,store,region};
    this.running=running;
    const work=(async()=>{
      let surface;
      try {
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.floor(region.w*region.scale));
        canvas.height=Math.max(1,Math.floor(region.h*region.scale));
        surface={...region,canvas};
        running.task=entry.page.start(canvas.getContext('2d',{alpha:false}),region.scale,region.x,region.y);
        await running.task.promise;
        const kept=!this.closed && this.pages.get(entry.number)===entry;
        if (kept && (store==='base' || entry.number===this.view.page)) {
          dispose(entry[store]);
          entry[store]=surface;
          this.changed();
        }
      } catch (error) {
        if (store==='base' && error.name!=='RenderingCancelledException') {
          entry.baseFailed=true;
          if (!this.closed) this.changed();
        }
      } finally {
        if (surface && entry[store]!==surface) dispose(surface);
        if (this.closed || this.pages.get(entry.number)!==entry) entry.page.cleanup();
        this.running=null;
        this.pump();
      }
    })();
    this.jobs.add(work);
    work.then(()=>this.jobs.delete(work),()=>this.jobs.delete(work));
  }
}
