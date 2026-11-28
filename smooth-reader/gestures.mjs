import {
  boundPoint, centerAfter, clamp, distance, hitsTracker, midpoint, onPage,
  onPaper, onScreen, pageEdges, segmentDistance, swipeTurn, trackBox
} from './geometry.mjs';

const STRAIGHT_HOLD_MS=500;
const FINGER_SLOP=3;
const PENCIL_SLOP=7;

export function straightenStroke(points,rotation,cam,pencil=false) {
  const screen=points.map(point=>onScreen(point,rotation,cam));
  const first=screen[0], last=screen.at(-1);
  const length=distance(first,last);
  if (length<(pencil ? 12 : 16)) return null;
  let travelled=0;
  const tolerance=pencil ? clamp(length*.24,8,28) : clamp(length*.18,6,24);
  for (let i=1;i<screen.length;i++) {
    travelled+=distance(screen[i-1],screen[i]);
    if (segmentDistance(screen[i],first,last)>tolerance) return null;
  }
  if (travelled>length*(pencil ? 1.8 : 1.35)) return null;
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
  function targetAt(point,number) {
    if (ui.targetAt) return ui.targetAt(point,number);
    const {view,items}=ui.state();
    return {number:view.page,cam:renderer.cam,items};
  }
  function beginMultiple() {
    clearTimeout(straightTimer);
    clearTimeout(gesture?.intentTimer);
    const [a,b] = pointers.values();
    const center = midpoint(a,b);
    const axis=ui.swipeAxis();
    gesture={type:'multi',a,b,start:center,last:center,anchor:canonical(center),
      stackAnchor:ui.stackAnchor?.(center),span:Math.max(distance(a,b),1),zoom:current().zoom,
      axis,edges:pageEdges(renderer.cam,renderer.size,axis),time:performance.now()};
    ui.preview(null,null);
  }
  function begin(event) {
    if (event.button!==0 && event.pointerType==='mouse') return;
    const note = event.target.closest('.note-icon')?.dataset;
    if (event.target!==renderer.canvas && !note?.id) return;
    if (!renderer.base || !renderer.cam || !ui.canInteract()) return;
    const {view,mode}=ui.state();
    if (gesture?.type==='mark' && gesture.pointer==='pen') return;
    if (mode==='mark' && event.pointerType==='pen' && pointers.size===1) {
      const first=pointers.keys().next().value;
      pointers.clear();
      clearTimeout(straightTimer);
      if (stage.hasPointerCapture(first)) stage.releasePointerCapture(first);
      ui.preview(null,null);
    }
    const point = position(event);
    pointers.set(event.pointerId,point);
    stage.setPointerCapture(event.pointerId);
    if (pointers.size===2) {
      beginMultiple();
      return;
    }
    if (pointers.size!==1) return;
    const target=targetAt(point,Number(note?.page)||undefined);
    const anchor=target && onPage(point,view.rotation,target.cam);
    const common = {start:point,anchor,time:performance.now(),pointer:event.pointerType,far:false};
    if (note?.id && target && (mode==='track'||mode==='note')) {
      gesture = {...common,type:'note',note:note.id,target};
    } else if (mode==='track') {
      const axis=ui.swipeAxis();
      const box = trackBox(view.tracker,renderer.cam,view.rotation,renderer.size);
      const canGrab = view.tracker.visible && (view.tracker.opacity>0 || view.tracker.shape==='lens');
      gesture = canGrab && hitsTracker(point,box)
        ? {...common,type:'tracker',offset:[box.x-point[0],box.y-point[1]]}
        : {...common,type:'pan',axis,edges:pageEdges(renderer.cam,renderer.size,axis)};
    } else if (mode==='mark' && anchor && onPaper(anchor)) {
      const {kind,color,width}=ui.ink();
      const weight=width/Math.min(target.cam.w,target.cam.h);
      const raw=[anchor];
      const stroke={type:'stroke',ink:kind,id:ui.id(),color,weight,points:raw};
      gesture={...common,type:'mark',stroke,raw,holdAt:point,target};
      ui.preview(stroke,null,target.number);
    } else if (mode==='erase' && target) {
      gesture = {...common,type:'erase',target,eraseId:findStroke(point,point,target)};
      ui.preview(null,gesture.eraseId,target.number);
    } else if (mode==='note' && anchor && onPaper(anchor)) {
      gesture = {...common,type:'note',target};
    } else {
      gesture = {...common,type:'ignore'};
    }
  }
  function findStroke(start,finish,target) {
    const {items,cam}=target;
    const view=current();
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
  function correctInk(g) {
    const points=g.raw.slice(0,g.heldSamples);
    if (points.length>1) points[points.length-1]=g.raw.at(-1);
    const straight=straightenStroke(points,current().rotation,g.target.cam,g.pointer==='pen');
    if (straight) g.stroke.points=straight;
  }
  function extendInk(event,g,view) {
    const samples=event.getCoalescedEvents?.();
    const cam=g.target.cam;
    for (const sample of [...(samples||[]),event]) {
      const point=position(sample);
      const p=boundPoint(onPage(point,view.rotation,cam));
      if (distance(onScreen(p,view.rotation,cam),onScreen(g.raw.at(-1),view.rotation,cam))>=1.25) g.raw.push(p);
    }
    const point=position(event);
    const slop=g.pointer==='pen' ? PENCIL_SLOP : FINGER_SLOP;
    if (distance(point,g.holdAt)>=slop) {
      g.holdAt=point;
      g.heldSamples=g.raw.length;
      g.holdSince=performance.now();
      g.stroke.points=g.raw;
      clearTimeout(straightTimer);
      straightTimer=setTimeout(()=>{
        if (gesture!==g || pointers.size!==1 || !renderer.cam) return;
        correctInk(g);
        ui.preview(g.stroke,null,g.target.number);
      },STRAIGHT_HOLD_MS);
    }
    ui.preview(g.stroke,null,g.target.number);
  }
  function moveMultiple(g,allowSingle=false) {
    const [a,b]=pointers.values();
    const center=midpoint(a,b);
    const span=distance(a,b);
    if (!g.kind) {
      const spread=Math.abs(span-g.span), moved=distance(center,g.start);
      const aMove=distance(a,g.a), bMove=distance(b,g.b);
      const bothMoved=Math.min(aMove,bMove)>=4;
      // Pointer updates arrive separately even during a coordinated two-finger swipe.
      if (bothMoved && moved>=9 && spread<=Math.max(12,moved*.65)) g.kind='pan';
      else if (spread>=Math.max(14,g.span*.14)) {
        if (bothMoved || allowSingle) g.kind='pinch';
        else {
          // Give the other pointer a frame or two to report the same pan.
          g.intentTimer ||= setTimeout(()=>{
            g.intentTimer=null;
            if (gesture===g && pointers.size>=2) moveMultiple(g,true);
          },40);
          return;
        }
      } else return;
      clearTimeout(g.intentTimer);
    }
    if (g.kind==='pan') {
      if (!ui.pan?.(g.last,center) && g.zoom>1) {
        ui.view(centerAfter(current(),renderer.page,renderer.size,g.anchor,center,g.zoom));
      }
      g.last=center;
    } else {
      const zoom=clamp(g.zoom*span/g.span,1,8);
      if (!ui.zoomAt?.(g.stackAnchor,center,zoom)) {
        ui.view(centerAfter(current(),renderer.page,renderer.size,g.anchor,center,zoom));
      }
    }
  }
  function move(event) {
    if (!pointers.has(event.pointerId) || !gesture || !renderer.cam) return;
    const last = pointers.get(event.pointerId);
    const point = position(event);
    pointers.set(event.pointerId,point);
    if (gesture.type==='multi') {
      if (pointers.size<2) return;
      moveMultiple(gesture,event.type==='pointerup');
      return;
    }
    if (!gesture.start || pointers.size!==1) return;
    if (distance(point,gesture.start)>9) gesture.far=true;
    const view=current();
    if (gesture.type==='pan') {
      if (!ui.pan?.(last,point) && view.zoom>1) {
        ui.view(centerAfter(view,renderer.page,renderer.size,gesture.anchor,point,view.zoom));
      }
    } else if (gesture.type==='tracker') {
      const anchor=boundPoint(canonical([point[0]+gesture.offset[0],point[1]+gesture.offset[1]]));
      ui.view({...view,tracker:{...view.tracker,anchor}},false);
    } else if (gesture.type==='mark') {
      extendInk(event,gesture,view);
    } else if (gesture.type==='erase' && !gesture.eraseId) {
      gesture.eraseId=findStroke(last,point,gesture.target);
      ui.preview(null,gesture.eraseId,gesture.target.number);
    }
  }
  function end(event) {
    if (!pointers.has(event.pointerId)) return;
    if (event.type==='pointerup') move(event);
    const g=gesture;
    clearTimeout(straightTimer);
    clearTimeout(g?.intentTimer);
    pointers.delete(event.pointerId);
    if (pointers.size) {
      if (pointers.size>=2 && g?.type==='multi') beginMultiple();
      else gesture={type:'ignore'};
      if (pointers.size===1 && event.type==='pointerup' && g?.kind==='pan' && !ui.continuous?.() &&
          performance.now()-g.time<900) {
        const delta=swipeTurn(g.start,g.last,g.axis,g.edges);
        if (delta) ui.turn(delta,g.axis);
      }
      return;
    }
    gesture=null;
    ui.preview(null,null);
    if (!g || event.type!=='pointerup') { ui.settled(); return; }
    if (g.type==='mark') {
      if (g.holdSince!==undefined && performance.now()-g.holdSince>=STRAIGHT_HOLD_MS) correctInk(g);
      ui.stroke(g.stroke,g.target.number);
    }
    if (g.type==='erase' && g.eraseId) ui.erase(g.eraseId,g.target.number);
    if (g.type==='note' && !g.far) ui.note(g.note,g.anchor,g.target.number);
    if (g.type==='pan' && g.pointer!=='mouse' && !ui.continuous?.() && performance.now()-g.time<900) {
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
    if (view.zoom<=1 && !zooming && !ui.continuous?.()) return;
    event.preventDefault();
    const unit=event.deltaMode===1 ? 16 : event.deltaMode===2 ? renderer.size[1] : 1;
    const p=position(event);
    const mid=renderer.size.map(n=>n/2);
    if (zooming) {
      const next=clamp(view.zoom*Math.exp(-event.deltaY*unit*.006),1,8);
      if (!ui.zoomAt?.(ui.stackAnchor?.(p),p,next)) ui.view(centerAfter(view,renderer.page,renderer.size,canonical(p),p,next));
    } else {
      const x=event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const y=event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      const destination=[mid[0]-x*unit,mid[1]-y*unit];
      if (!ui.pan?.(mid,destination)) ui.view(centerAfter(view,renderer.page,renderer.size,canonical(mid),destination,view.zoom));
    }
  },{passive:false});
  return () => {
    for (const id of pointers.keys()) {
      if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    }
    pointers.clear();
    clearTimeout(straightTimer);
    clearTimeout(gesture?.intentTimer);
    gesture=null;
    ui.preview(null,null);
  };
}
