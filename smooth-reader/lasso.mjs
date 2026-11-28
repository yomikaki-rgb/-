import { clamp } from './geometry.mjs';

export function insideLasso([x,y],polygon) {
  let inside=false;
  for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const [ax,ay]=polygon[j], [bx,by]=polygon[i];
    if ((ay>y)!==(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax) inside=!inside;
  }
  return inside;
}

function crosses(a,b,c,d) {
  const side=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  return side(a,b,c)*side(a,b,d)<0 && side(c,d,a)*side(c,d,b)<0;
}

export function lassoItems(items,polygon,noteCenter) {
  const min=[1,1], max=[0,0];
  for (const point of polygon) for (let i=0;i<2;i++) {
    min[i]=Math.min(min[i],point[i]);
    max[i]=Math.max(max[i],point[i]);
  }
  const inBounds=point=>point.every((n,i)=>n>=min[i] && n<=max[i]);
  return items.filter(item=>{
    if (item.type==='note') return [item.at,noteCenter(item)].filter(Boolean).some(point=>insideLasso(point,polygon));
    if (item.type!=='stroke') return false;
    return item.points.some((point,i)=>{
      if (inBounds(point) && insideLasso(point,polygon)) return true;
      const prev=item.points[i-1];
      if (!prev || point.some((n,axis)=>Math.max(n,prev[axis])<min[axis] || Math.min(n,prev[axis])>max[axis])) return false;
      return polygon.some((p,index)=>crosses(prev,point,p,polygon[(index+1)%polygon.length]));
    });
  });
}

export function lassoShift(items,delta) {
  const min=[1,1], max=[0,0];
  for (const item of items) for (const point of item.points || [item.at]) for (let i=0;i<2;i++) {
    min[i]=Math.min(min[i],point[i]);
    max[i]=Math.max(max[i],point[i]);
  }
  return delta.map((n,i)=>clamp(n,-min[i],1-max[i]));
}

export function shiftedLassoItems(items,delta) {
  const move=point=>point.map((n,i)=>n+delta[i]);
  return items.map(item=>item.type==='note' ? {...item,at:move(item.at)} : {...item,points:item.points.map(move)});
}
