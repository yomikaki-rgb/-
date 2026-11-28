import {
  boundPoint, centerAfter, clamp, distance, hitsTracker, midpoint, onPage,
  onPaper, onScreen, pageEdges, segmentDistance, swipeTurn, trackBox
} from './geometry.mjs';

const STRAIGHT_HOLD_MS=500;
const TIP_SLOP=3;

export function straightenStroke(points,rotation,cam) {
  const screen=points.map(point=>onScreen(point,rotation,cam));
  const first=screen[0], last=screen.at(-1);
  const length=distance(first,last);
  if (length<16) return null;
  let travelled=0;
  const tolerance=clamp(length*.18,6,24);
  for (let i=1;i<screen.length;i++) {
    travelled+=distance(screen[i-1],screen[i]);
    if (segmentDistance(screen[i],first,last)>tolerance) return null;
  }
  if (travelled>length*1.35) return null;
  const dx=Math.abs(last[0]-first[0]), dy=Math.abs(last[1]-first[1]);
  const end=[...last];
  if (dy<dx*.09) end[1]=first[1];
  else if (dx<dy*.09) end[0]=first[0];
  return [points[0],boundPoint(onPage(end,rotation,cam))];
}

export function wireGestures(stage, renderer, ui) {
  const pointers = new Map();
  let gesture, straightTimer;
  function position(event) {
    const rect = stage.getBoundingClientRect();
    return [event.clientX-rect.left,event.clientY-rect.top];
  }
  const canonical = p => onPage(p,ui.state().view.rotation,renderer.cam);
  const current = () => ui.state().view;
  function beginPinch() {
    clearTimeout(straightTimer);
    const [a,b] = pointers.values();
    const center = midpoint(a,b);
    gesture = {type:'pinch',anchor:canonical(center),size:Math.max(distance(a,b),1),zoom:current().zoom};
    ui.preview(null,null);
  }
  function begin(event) {
    if (event.button!==0 && event.pointerType==='mouse') return;
    const note = event.target.closest('.note-icon')?.dataset.id;
    if (event.target!==renderer.canvas && !note) return;
    if (!renderer.base || !renderer.cam || !ui.canInteract()) return;
    const point = position(event);
    pointers.set(event.pointerId,point);
    stage.setPointerCapture(event.pointerId);
    if (pointers.size===2) {
      beginPinch();
      return;
    }
    if (pointers.size!==1) return;
    const {view,mode} = ui.state();
    const anchor = canonical(point);
    const common = {start:point,anchor,time:performance.now(),pointer:event.pointerType,far:false};
    if (note && (mode==='track'||mode==='note')) {
      gesture = {...common,type:'note',note};
    } else if (mode==='track') {
      const axis=ui.swipeAxis();
      const box = trackBox(view.tracker,renderer.cam,view.rotation,renderer.size);
      const canGrab = view.tracker.visible && (view.tracker.opacity>0 || view.tracker.shape==='lens');
      gesture = canGrab && hitsTracker(point,box)
        ? {...common,type:'tracker',offset:[box.x-point[0],box.y-point[1]]}
        : {...common,type:'pan',axis,edges:pageEdges(renderer.cam,renderer.size,axis)};
    } else if (mode==='mark' && onPaper(anchor)) {
      const {kind,color,width}=ui.ink();
      const weight=width/Math.min(renderer.cam.w,renderer.cam.h);
      const raw=[anchor];
      const stroke={type:'stroke',ink:kind,id:ui.id(),color,weight,points:raw};
      gesture={...common,type:'mark',stroke,raw,holdAt:point};
      ui.preview(stroke,null);
    } else if (mode==='erase') {
      gesture = {...common,type:'erase',eraseId:findStroke(point,point)};
      ui.preview(null,gesture.eraseId);
    } else if (mode==='note' && onPaper(anchor)) {
      gesture = {...common,type:'note'};
    } else {
      gesture = {...common,type:'ignore'};
    }
  }
  function findStroke(start,finish) {
    const {items,view} = ui.state();
    const cam = renderer.cam;
    const center = midpoint(start,finish);
    const travel = distance(start,finish)/2;
    for (let i=items.length-1;i>=0;i--) {
      const s = items[i];
      if (s.type!=='stroke') continue;
      const tolerance = s.weight*Math.min(cam.w,cam.h)/2+8;
      let a = onScreen(s.points[0],view.rotation,cam);
      if (segmentDistance(a,start,finish)<=tolerance) return s.id;
      for (let j=1;j<s.points.length;j++) {
        const b = onScreen(s.points[j],view.rotation,cam);
        if (segmentDistance(center,a,b)<=tolerance+travel &&
            (segmentDistance(start,a,b)<=tolerance || segmentDistance(finish,a,b)<=tolerance ||
              segmentDistance(b,start,finish)<=tolerance || crosses(start,finish,a,b))) return s.id;
        a=b;
      }
    }
    return null;
  }
  function crosses(a,b,c,d) {
    const side = (a,b,p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
    return side(a,b,c)*side(a,b,d)<0 && side(c,d,a)*side(c,d,b)<0;
  }
  function extendInk(event,g,view) {
    const samples=event.getCoalescedEvents?.();
    const cam=renderer.cam;
    for (const sample of samples?.length ? samples : [event]) {
      const point=position(sample);
      const p=boundPoint(canonical(point));
      if (distance(onScreen(p,view.rotation,cam),onScreen(g.raw.at(-1),view.rotation,cam))>=1.25) g.raw.push(p);
      if (distance(point,g.holdAt)<TIP_SLOP) continue;
      g.holdAt=point;
      g.stroke.points=g.raw;
      clearTimeout(straightTimer);
      straightTimer=setTimeout(()=>{
        if (gesture!==g || pointers.size!==1 || !renderer.cam) return;
        const straight=straightenStroke(g.raw,current().rotation,renderer.cam);
        if (!straight) return;
        g.stroke.points=straight;
        ui.preview(g.stroke,null);
      },STRAIGHT_HOLD_MS);
    }
    ui.preview(g.stroke,null);
  }
  function move(event) {
    if (!pointers.has(event.pointerId) || !gesture || !renderer.cam) return;
    const last = pointers.get(event.pointerId);
    const point = position(event);
    pointers.set(event.pointerId,point);
    if (gesture.type==='pinch') {
      if (pointers.size<2) return;
      const [a,b]=pointers.values();
      const zoom=clamp(gesture.zoom*distance(a,b)/gesture.size,1,8);
      ui.view(centerAfter(current(),renderer.page,renderer.size,gesture.anchor,midpoint(a,b),zoom));
      return;
    }
    if (!gesture.start || pointers.size!==1) return;
    if (distance(point,gesture.start)>9) gesture.far=true;
    const view=current();
    if (gesture.type==='pan' && view.zoom>1) {
      ui.view(centerAfter(view,renderer.page,renderer.size,gesture.anchor,point,view.zoom));
    } else if (gesture.type==='tracker') {
      const anchor=boundPoint(canonical([point[0]+gesture.offset[0],point[1]+gesture.offset[1]]));
      ui.view({...view,tracker:{...view.tracker,anchor}},false);
    } else if (gesture.type==='mark') {
      extendInk(event,gesture,view);
    } else if (gesture.type==='erase' && !gesture.eraseId) {
      gesture.eraseId=findStroke(last,point);
      ui.preview(null,gesture.eraseId);
    }
  }
  function end(event) {
    if (!pointers.has(event.pointerId)) return;
    if (event.type==='pointerup') move(event);
    const g=gesture;
    clearTimeout(straightTimer);
    pointers.delete(event.pointerId);
    if (pointers.size) {
      if (pointers.size>=2 && g?.type==='pinch') beginPinch();
      else gesture={type:'ignore'};
      return;
    }
    gesture=null;
    ui.preview(null,null);
    if (!g || event.type!=='pointerup') { ui.settled(); return; }
    if (g.type==='mark') ui.stroke(g.stroke);
    if (g.type==='erase' && g.eraseId) ui.erase(g.eraseId);
    if (g.type==='note' && !g.far) ui.note(g.note,g.anchor);
    if (g.type==='pan' && g.pointer!=='mouse' && performance.now()-g.time<900) {
      const delta=swipeTurn(g.start,position(event),g.axis,g.edges);
      if (delta) ui.turn(delta,g.axis);
    }
    ui.settled();
  }
  stage.addEventListener('pointerdown',begin);
  stage.addEventListener('pointermove',move);
  stage.addEventListener('pointerup',end);
  stage.addEventListener('pointercancel',end);
  stage.addEventListener('lostpointercapture',end);
  stage.addEventListener('contextmenu',event=>{
    if (event.target===renderer.canvas || event.target.closest('.note-icon')) event.preventDefault();
  });
  stage.addEventListener('wheel',event=>{
    if (event.target!==renderer.canvas || !renderer.base || !ui.canInteract()) return;
    const view=current();
    const zooming=event.ctrlKey || event.metaKey;
    if (view.zoom<=1 && !zooming) return;
    event.preventDefault();
    const unit=event.deltaMode===1 ? 16 : event.deltaMode===2 ? renderer.size[1] : 1;
    const p=position(event);
    const mid=renderer.size.map(n=>n/2);
    if (zooming) {
      const next=clamp(view.zoom*Math.exp(-event.deltaY*unit*.006),1,8);
      ui.view(centerAfter(view,renderer.page,renderer.size,canonical(p),p,next));
    } else {
      const x=event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const y=event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      ui.view(centerAfter(view,renderer.page,renderer.size,canonical(mid),[mid[0]-x*unit,mid[1]-y*unit],view.zoom));
    }
  },{passive:false});
  return () => {
    for (const id of pointers.keys()) {
      if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    }
    pointers.clear();
    clearTimeout(straightTimer);
    gesture=null;
    ui.preview(null,null);
  };
}
