import { camera, clamp, onScreen, pixelScale, trackBox, turned } from './geometry.mjs';

const PAGE_PIXELS = 3_000_000;
const TILE_PIXELS = 2_400_000;
const SCENE_PIXELS = 3_000_000;

function release(surface) {
  if (surface) surface.canvas.width = surface.canvas.height = 1;
}
function makeSurface(region,scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.floor(region.w*scale));
  canvas.height = Math.max(1,Math.floor(region.h*scale));
  return {...region,canvas,scale};
}
function roundRect(ctx,x,y,w,h,radius) {
  const r = Math.min(radius,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}
function drawStroke(ctx,stroke,rotation,w,h,path) {
  // Strokes saved before the pen feature are all markers.
  const pen=stroke.ink==='pen';
  ctx.globalAlpha=pen ? 1 : .39;
  ctx.globalCompositeOperation=pen ? 'source-over' : 'multiply';
  ctx.strokeStyle = ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.weight*Math.min(w,h);
  ctx.lineCap = ctx.lineJoin = 'round';
  if (stroke.points.length === 1) {
    const [x,y] = turned(stroke.points[0],rotation);
    ctx.beginPath();
    ctx.arc(x*w,y*h,ctx.lineWidth/2,0,2*Math.PI);
    ctx.fill();
  } else {
    ctx.stroke(path);
  }
}
function strokePath(points, rotation, w, h) {
  const path = new Path2D();
  for (let i=0;i<points.length;i++) {
    const [x,y] = turned(points[i],rotation);
    if (i===0) path.moveTo(x*w,y*h);
    else path.lineTo(x*w,y*h);
  }
  return path;
}

export class PageRenderer {
  constructor(canvas, getState, updateNotes, onError) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d',{alpha:false});
    this.getState = getState;
    this.updateNotes = updateNotes;
    this.onError = onError;
    this.size = [0,0];
    this.paths = new WeakMap();
    this.serial = Promise.resolve();
    this.epoch = 0;
    this.tiles = 0;
    this.resize = new ResizeObserver(entries => {
      const {width,height} = entries[0].contentRect;
      this.size = [width,height];
      if (width && height) {
        this.invalidate();
        this.scheduleDetail();
      }
    });
    this.resize.observe(canvas);
  }
  get cam() {
    if (this.stack) return this.stackRows().find(row=>row.number===this.getState().view.page)?.cam ?? null;
    return this.page && this.size.every(Boolean) ? camera(this.getState().view,this.page,this.size) : null;
  }
  get page() {
    return this.stack ? this.stack.pages.get(this.getState().view?.page)?.page : this.singlePage;
  }
  get base() {
    return this.stack ? this.stack.pages.get(this.getState().view?.page)?.base : this.singleBase;
  }
  stackRows() {
    const {view}=this.getState();
    return this.stack && view ? this.stack.layout(view,this.size) : [];
  }
  attachStack(stack) {
    this.stack=stack;
    this.invalidate();
  }
  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(()=>{
      this.frame = 0;
      this.draw();
    });
  }
  clear() {
    this.epoch++;
    this.tiles++;
    clearTimeout(this.timer);
    this.task?.cancel();
    const stack=this.stack;
    this.stack=null;
    if (stack) this.serial=Promise.all([this.serial,stack.close()]).then(()=>{});
    const page = this.singlePage;
    if (page) this.serial = this.serial.then(()=>{ page.cleanup(); });
    this.singlePage = null;
    release(this.singleBase);
    release(this.singleDetail);
    this.singleBase = this.singleDetail = null;
    this.paths = new WeakMap();
    this.invalidate();
    return this.serial;
  }
  work(page,region,scale,valid,store) {
    const slot=store==='base' ? 'singleBase' : 'singleDetail';
    this.serial = this.serial.then(async () => {
      if (!valid()) return;
      const surface = makeSurface(region,scale);
      try {
        const context = surface.canvas.getContext('2d',{alpha:false});
        if (!context) throw new Error('Canvas is unavailable.');
        this.task = page.start(context,scale,region.x,region.y);
        await this.task.promise;
        if (valid()) {
          release(this[slot]);
          this[slot] = surface;
          this.invalidate();
          return;
        }
      } catch (error) {
        if (valid() && error.name!=='RenderingCancelledException') this.onError(error,store);
      } finally {
        this.task = null;
        if (this[slot]!==surface) release(surface);
      }
    }).catch(error=>this.onError(error,store));
    return this.serial;
  }
  load(page) {
    this.clear();
    this.singlePage = page;
    const epoch = this.epoch;
    const dpr = Math.min(devicePixelRatio || 1,2);
    const fit = this.cam?.fit || Math.min(1,800/Math.max(page.width,page.height));
    const scale = pixelScale(page.width,page.height,fit*dpr*1.18,PAGE_PIXELS);
    const valid = () => this.epoch===epoch;
    return this.work(page,{x:0,y:0,w:page.width,h:page.height},scale,valid,'base').then(()=>{
      if (valid() && this.base) this.scheduleDetail();
      return valid() && Boolean(this.base);
    });
  }
  scheduleDetail() {
    clearTimeout(this.timer);
    if (!this.base || !this.page) return;
    this.timer = setTimeout(()=>this.renderDetail(),170);
  }
  renderDetail() {
    const cam = this.cam;
    if (!cam || !this.base) return;
    const page = this.page;
    const {view,mode} = this.getState();
    const lens = mode==='track' && view.tracker.visible && view.tracker.shape==='lens' ? view.tracker.magnification : 1;
    if (this.stack) {
      this.stack.requestDetail(view,this.size,lens);
      return;
    }
    const target = cam.scale*Math.min(devicePixelRatio || 1,2)*lens;
    const margin = 120/cam.scale;
    const left = clamp(-cam.x/cam.scale-margin,0,page.width);
    const top = clamp(-cam.y/cam.scale-margin,0,page.height);
    const right = clamp((this.size[0]-cam.x)/cam.scale+margin,0,page.width);
    const bottom = clamp((this.size[1]-cam.y)/cam.scale+margin,0,page.height);
    const region = {x:left,y:top,w:right-left,h:bottom-top};
    const scale = pixelScale(region.w,region.h,target,TILE_PIXELS);
    if (scale<=this.base.scale*1.15) return;
    const prev = this.singleDetail;
    if (prev && scale>=prev.scale*.8 && scale<=prev.scale*1.2 && Math.abs(left-prev.x)<margin*.4 &&
        Math.abs(top-prev.y)<margin*.4 && Math.abs(right-prev.x-prev.w)<margin*.4 &&
        Math.abs(bottom-prev.y-prev.h)<margin*.4) return;
    const epoch = this.epoch, tile = ++this.tiles;
    this.task?.cancel();
    this.work(page,region,scale,()=>this.epoch===epoch && this.tiles===tile,'detail');
  }
  paintPaper(ctx,cam,state,surfaces=[this.singleBase,this.singleDetail]) {
    const {view,items,stroke,erased} = state;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cam.x,cam.y,cam.w,cam.h);
    ctx.clip();
    ctx.fillStyle = 'white';
    ctx.fillRect(cam.x,cam.y,cam.w,cam.h);
    for (const surface of surfaces) {
      if (!surface) continue;
      ctx.drawImage(surface.canvas,cam.x+surface.x*cam.scale,cam.y+surface.y*cam.scale,
        surface.w*cam.scale,surface.h*cam.scale);
    }
    ctx.translate(cam.x,cam.y);
    const key = [view.rotation,cam.w,cam.h].join('/');
    const preview=state.lasso?.page===(state.pageNumber ?? view.page) ? state.lasso.preview : null;
    for (const original of items) {
      const item=preview?.get(original.id) || original;
      if (item.type!=='stroke' || erased?.get(state.pageNumber ?? view.page)?.has(item.id)) continue;
      let cached = this.paths.get(item);
      if (cached?.key !== key) {
        cached = {key,path:strokePath(item.points,view.rotation,cam.w,cam.h)};
        this.paths.set(item,cached);
      }
      drawStroke(ctx,item,view.rotation,cam.w,cam.h,cached.path);
    }
    if (stroke) drawStroke(ctx,stroke,view.rotation,cam.w,cam.h,strokePath(stroke.points,view.rotation,cam.w,cam.h));
    ctx.restore();
  }
  paintLasso(ctx,lasso,cam,rotation) {
    if (!lasso || !cam || lasso.path.length<2) return;
    const path=lasso.path.map(point=>onScreen(point,rotation,cam));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(...path[0]);
    for (let i=1;i<path.length;i++) ctx.lineTo(...path[i]);
    if (lasso.selected) {
      ctx.closePath();
      ctx.fillStyle='#167d7425';
      ctx.fill();
    }
    ctx.strokeStyle='#ffffff';
    ctx.lineWidth=3.5;
    ctx.stroke();
    ctx.setLineDash([5,4]);
    ctx.strokeStyle='#126f68';
    ctx.lineWidth=1.5;
    ctx.stroke();
    ctx.restore();
  }
  paintTracker(ctx,cam,state,rows) {
    const t = state.view.tracker;
    const {x,y,w,h,angle} = trackBox(t,cam,state.view.rotation,this.size);
    ctx.save();
    ctx.translate(x,y);
    ctx.rotate(angle);
    const left = -w/2, top = -h/2;
    if (t.shape==='lens') {
      roundRect(ctx,left,top,w,h,9);
      ctx.save();
      ctx.clip();
      ctx.fillStyle = 'white';
      ctx.fillRect(left,top,w,h);
      ctx.rotate(-angle);
      ctx.scale(t.magnification,t.magnification);
      ctx.translate(-x,-y);
      if (rows) this.paintStack(ctx,state,rows);
      else this.paintPaper(ctx,cam,state);
      ctx.restore();
      roundRect(ctx,left,top,w,h,9);
      ctx.strokeStyle = '#133b42';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = t.opacity/100;
      ctx.lineWidth = 5;
      ctx.strokeStyle = t.color;
      ctx.stroke();
    } else {
      ctx.globalAlpha = t.opacity/100;
      ctx.fillStyle = t.color;
      if (t.shape==='window') {
        const band = Math.max(2,h*.25);
        roundRect(ctx,left,top,w,band,2);
        ctx.fill();
        roundRect(ctx,left,h/2-band,w,band,2);
      } else {
        const line = t.shape==='line';
        const thickness = Math.max(2,h*.19);
        roundRect(ctx,left,line ? h/2-thickness : top,w,line ? thickness : h,4);
      }
      ctx.fill();
    }
    ctx.restore();
  }
  paintStack(ctx,state,rows) {
    for (const {cam,entry,number} of rows) {
      this.paintPaper(ctx,cam,{...state,pageNumber:number,items:entry.items||[],
        stroke:state.previewPage===number ? state.stroke : null,
      },[entry.base,entry.detail]);
    }
  }
  draw() {
    const [w,h] = this.size;
    if (!w || !h) return;
    const ratio = pixelScale(w,h,Math.min(devicePixelRatio || 1,2),SCENE_PIXELS);
    const cw = Math.max(1,Math.floor(w*ratio)), ch = Math.max(1,Math.floor(h*ratio));
    if (this.canvas.width!==cw) this.canvas.width=cw;
    if (this.canvas.height!==ch) this.canvas.height=ch;
    const ctx = this.context;
    ctx.setTransform(cw/w,0,0,ch/h,0,0);
    ctx.fillStyle = '#e8eeef';
    ctx.fillRect(0,0,w,h);
    const state = this.getState();
    if (this.stack && state.view) {
      this.stack.sync(state.view,this.size);
      const rows=this.stackRows().filter(row=>row.cam.y+row.cam.h>0 && row.cam.y<h);
      this.paintStack(ctx,state,rows);
      const active=rows.find(row=>row.number===state.view.page);
      if (active && state.mode==='track' && state.view.tracker.visible) this.paintTracker(ctx,active.cam,state,rows);
      if (state.lasso) this.paintLasso(ctx,state.lasso,rows.find(row=>row.number===state.lasso.page)?.cam,state.view.rotation);
      this.updateNotes(active?.cam,state,rows);
      return;
    }
    const cam = this.cam;
    if (!cam || !this.base || !state.view) {
      this.updateNotes(null,state);
      return;
    }
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#1e373a30';
    ctx.shadowBlur = 10;
    ctx.fillRect(cam.x,cam.y,cam.w,cam.h);
    ctx.restore();
    this.paintPaper(ctx,cam,state);
    if (state.mode==='track' && state.view.tracker.visible) this.paintTracker(ctx,cam,state);
    if (state.lasso?.page===state.view.page) this.paintLasso(ctx,state.lasso,cam,state.view.rotation);
    this.updateNotes(cam,state);
  }
}
