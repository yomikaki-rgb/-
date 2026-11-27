export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
export const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const mod = (n, m) => ((n % m) + m) % m;

export const TRACK_DEFAULT = Object.freeze({
  shape:'bar', length:290, width:34, angle:0, orientation:0, color:'#49c7b7',
  opacity:35, magnification:1.8, visible:true, anchor:[.5,.44]
});

export function newView(tracker = TRACK_DEFAULT, page = 1, rotation = 0) {
  return {
    page, rotation, zoom:1, center:[.5,.5],
    tracker:{ ...tracker, anchor:[.5,.44] }
  };
}

// Coordinates are fractions of the original visible page. Intrinsic PDF
// rotation and CropBox are already accounted for by its initial viewport.
export function turned([x, y], rotation) {
  switch (mod(rotation, 360)) {
    case 90: return [1-y, x];
    case 180: return [1-x, 1-y];
    case 270: return [y, 1-x];
    default: return [x, y];
  }
}
export function camera(view, page, size) {
  const pad = size[1] < 360 ? 9 : 14;
  const fit = Math.min(Math.max(1,size[0]-2*pad)/page.width, Math.max(1,size[1]-2*pad)/page.height);
  const scale = fit * view.zoom;
  const w = page.width * scale;
  const h = page.height * scale;
  const [cx,cy] = turned(view.center, view.rotation);
  const position = (length, viewport, c) => length <= viewport-2*pad
    ? (viewport-length)/2 : clamp(viewport/2-c*length, viewport-length-pad, pad);
  return { x:position(w,size[0],cx), y:position(h,size[1],cy), w, h, scale, fit };
}
export function onScreen(point, rotation, cam) {
  const p = turned(point, rotation);
  return [cam.x + p[0]*cam.w, cam.y + p[1]*cam.h];
}
export function onPage(point, rotation, cam) {
  return turned([(point[0]-cam.x)/cam.w,(point[1]-cam.y)/cam.h], -rotation);
}
export function onPaper(point) {
  return point.every(n => n >= 0 && n <= 1);
}
export function boundPoint(point) {
  return point.map(n => clamp(n,0,1));
}
export function centerAfter(view, page, size, anchor, destination, zoom) {
  const next = { ...view, zoom };
  const {w,h} = camera(next,page,size);
  const [x,y] = turned(anchor,view.rotation);
  const center = [x + (size[0]/2-destination[0])/w, y + (size[1]/2-destination[1])/h];
  next.center = boundPoint(turned(center,-view.rotation));
  return next;
}

export function writingOrientation(tracker) {
  if (tracker.orientation === 0 || tracker.orientation === 90) return tracker.orientation;
  // Saved trackers from v1 have only an angle. Use the closest axis.
  const axis = mod(tracker.angle || 0, 180);
  return axis >= 45 && axis < 135 ? 90 : 0;
}

export function bookmarkSpot(bookmark) {
  return bookmark?.at || bookmark?.tracker?.anchor || bookmark?.center;
}

export function revealPoint(view, page, size, at) {
  if (!size.every(n=>n>0)) return view;
  const point = onScreen(at,view.rotation,camera(view,page,size));
  const inset = size.map(n=>Math.min(16,n/4));
  if (point.every((n,i)=>n>=inset[i] && n<=size[i]-inset[i])) return view;
  return {...view,center:boundPoint(at)};
}

export function parsePageNumber(value, count) {
  const ascii = value.trim().replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-65248));
  if (!/^\d+$/.test(ascii)) return null;
  const page = Number(ascii);
  return Number.isSafeInteger(page) && page>=1 && page<=count ? page : null;
}

export function segmentDistance(point, a, b) {
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const len = dx*dx+dy*dy;
  const t = len && clamp(((point[0]-a[0])*dx+(point[1]-a[1])*dy)/len,0,1);
  return Math.hypot(point[0]-a[0]-t*dx, point[1]-a[1]-t*dy);
}
export function trackBox(tracker, cam, rotation, size) {
  const longest = Math.hypot(...size);
  const [x,y] = onScreen(tracker.anchor,rotation,cam);
  return {
    x:clamp(x, Math.min(16,size[0]/2), Math.max(size[0]-16,size[0]/2)),
    y:clamp(y, Math.min(16,size[1]/2), Math.max(size[1]-16,size[1]/2)),
    w:Math.min(tracker.length,longest), h:Math.min(tracker.width,size[1]),
    angle:tracker.angle*Math.PI/180
  };
}
export function hitsTracker(point, box) {
  const x = point[0]-box.x, y = point[1]-box.y;
  const c = Math.cos(box.angle), s = Math.sin(box.angle);
  return Math.abs(x*c+y*s)<=Math.max(22,box.w/2) && Math.abs(-x*s+y*c)<=Math.max(22,box.h/2);
}
export function pixelScale(w,h,wanted,maxArea) {
  return Math.min(wanted, Math.sqrt(maxArea/(w*h)), 4096/Math.max(w,h));
}
