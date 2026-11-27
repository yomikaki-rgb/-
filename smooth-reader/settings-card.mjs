const INSET = 8;
const step = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};

export function placeSettingsCard(x,y,stageWidth,stageHeight,cardWidth,cardHeight) {
  const inside = (value,available) => Math.min(Math.max(value,INSET),Math.max(0,available-INSET));
  return [inside(x,stageWidth-cardWidth),inside(y,stageHeight-cardHeight)];
}

export function wireSettingsCard(stage,card,handle) {
  let position, drag;
  function moveTo(x,y) {
    if (card.hidden) return;
    position = placeSettingsCard(x,y,stage.clientWidth,stage.clientHeight,card.offsetWidth,card.offsetHeight);
    card.style.left = position[0]+'px';
    card.style.top = position[1]+'px';
    card.style.right = 'auto';
  }
  function keepInside() {
    if (position) moveTo(...position);
  }
  const resize = new ResizeObserver(keepInside);
  resize.observe(stage);
  resize.observe(card);

  handle.addEventListener('pointerdown',event=>{
    if (event.button!==0 || drag) return;
    drag = {
      id:event.pointerId, at:[event.clientX,event.clientY],
      start:[card.offsetLeft,card.offsetTop],
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove',event=>{
    if (drag?.id!==event.pointerId) return;
    moveTo(drag.start[0]+event.clientX-drag.at[0],drag.start[1]+event.clientY-drag.at[1]);
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) {
    handle.addEventListener(type,event=>{
      if (drag?.id!==event.pointerId) return;
      drag = null;
      handle.classList.remove('is-dragging');
    });
  }
  handle.addEventListener('keydown',event=>{
    if (!Object.hasOwn(step,event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const [dx,dy] = step[event.key];
    const amount = event.shiftKey ? 32 : 8;
    moveTo(card.offsetLeft+dx*amount,card.offsetTop+dy*amount);
  });
}
