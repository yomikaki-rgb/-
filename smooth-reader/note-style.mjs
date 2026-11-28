import { boundPoint, clamp, onPage, onScreen, segmentDistance } from './geometry.mjs';

export const NOTE_SIZE = .024;
export const NOTE_COLOR = '#243444';
export const noteSize = value => Number.isFinite(value) ? clamp(value,.008,.12) : NOTE_SIZE;
export const noteColor = value => /^#[a-f0-9]{6}$/i.test(value) ? value.toLowerCase() : NOTE_COLOR;
export const notePixels = (value,cam) => noteSize(value)*Math.min(cam.w,cam.h);
export const noteWidth = (pixels,x,cam,stageWidth) =>
  Math.min(24*pixels,Math.max(6*pixels,cam.x+cam.w-x),Math.max(24,stageWidth-8));

export function moveNote(at,rotation,cam,dx,dy) {
  const [x,y]=onScreen(at,rotation,cam);
  return boundPoint(onPage([x+dx,y+dy],rotation,cam));
}

export function noteSheetOffset(x,y,width,height,stageWidth,top,bottom) {
  const right=Math.max(4,stageWidth-width-4);
  const low=Math.max(top+4,bottom-height-4);
  return [clamp(x,4,right)-x,clamp(y,top+4,low)-y];
}

export function pageTextGeometry(content, viewport) {
  const [a,b,c,d]=viewport.transform;
  const unit=Math.hypot(a,b);
  const lines=[];
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const [xx,xy,yx,yy,x,y]=item.transform;
    const font=Math.hypot(a*yx+c*yy,b*yx+d*yy);
    const vertical=content.styles[item.fontName]?.vertical;
    const length=Math.abs(vertical ? item.height : item.width)*unit;
    if (!(font>0 && length>0)) continue;
    const angle=Math.atan2(b*xx+d*xy,a*xx+c*xy)+(vertical ? Math.PI/2 : 0);
    const dx=Math.cos(angle), dy=Math.sin(angle);
    const origin=viewport.convertToViewportPoint(x,y);
    // Measure from within the glyph band rather than from the baseline.
    const start=[origin[0]+dy*font*.35,origin[1]-dx*font*.35];
    lines.push({font,start,end:[start[0]+dx*length,start[1]+dy*length]});
  }
  return {lines,width:viewport.width,height:viewport.height};
}

export function nearbyTextSize({lines,width,height}, at) {
  const shortSide=Math.min(width,height);
  const point=[at[0]*width,at[1]*height];
  let best=Infinity, size;
  for (const {font,start,end} of lines) {
    const distance=segmentDistance(point,start,end);
    if (distance<best && distance<=Math.min(font*2.2,shortSide*.055)) {
      best=distance;
      size=noteSize(font/shortSide);
    }
  }
  return size;
}
