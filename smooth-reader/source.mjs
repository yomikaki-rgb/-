import { nearbyTextSize, pageTextGeometry } from './note-style.mjs';

const MiB = 1024 ** 2;
let pdfModule;

export async function fileKind(file) {
  const data = new Uint8Array(await file.slice(0,1024).arrayBuffer());
  if (data[0]===255 && data[1]===216 && data[2]===255) return 'jpeg';
  const png = [137,80,78,71,13,10,26,10];
  if (png.every((part,i)=>data[i]===part)) return 'png';
  if (new TextDecoder().decode(data).includes('%PDF-')) return 'pdf';
  throw new Error('PDF・JPEG・PNGを選んでください。');
}

async function pdfEngine() {
  if (!pdfModule) {
    pdfModule = import('./vendor/pdf.mjs').then(pdf => {
      pdf.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
      return pdf;
    }).catch(error=>{ pdfModule = undefined; throw error; });
  }
  return pdfModule;
}

// Read only requested ranges from the stored Blob. The PDF worker owns the
// PDF byte cache. It never fetches the document from an HTTP URL.
async function openPdf(blob, askPassword) {
  const pdf = await pdfEngine();
  class BlobRange extends pdf.PDFDataRangeTransport {
    stopped = false;
    requestDataRange(begin,end) {
      blob.slice(begin,end).arrayBuffer().then(bytes => {
        if (!this.stopped) this.onDataRange(begin,new Uint8Array(bytes));
      }).catch(error => {
        if (!this.stopped) {
          readError = error;
          task.destroy().catch(()=>{});
        }
      });
    }
    abort() { this.stopped = true; }
  }
  let readError;
  let passwordAborted = false;
  const initial = new Uint8Array(await blob.slice(0,65536).arrayBuffer());
  const range = new BlobRange(blob.size, initial, true);
  const vendor = new URL('./vendor/',import.meta.url);
  const task = pdf.getDocument({
    range, length:blob.size, disableStream:true, disableAutoFetch:true, rangeChunkSize:65536,
    cMapUrl:new URL('cmaps/',vendor).href, cMapPacked:true,
    standardFontDataUrl:new URL('standard_fonts/',vendor).href,
    wasmUrl:new URL('wasm/',vendor).href, iccUrl:new URL('iccs/',vendor).href, useSystemFonts:true,
    isEvalSupported:false, stopAtErrors:true, enableXfa:false,
    canvasMaxAreaInBytes:24*MiB, maxImageSize:36_000_000
  });
  let backend;
  try {
    task.onPassword = (submit,reason) => {
      Promise.resolve(askPassword(reason===pdf.PasswordResponses.INCORRECT_PASSWORD)).then(value=>{
        if (value === null) {
          passwordAborted = true;
          submit(new Error('Password entry cancelled.'));
        } else submit(value);
      }).catch(error=>submit(error));
    };
    backend = await task.promise;
  } catch (error) {
    await task.destroy().catch(()=>{});
    if (passwordAborted) throw new DOMException('パスワード入力を中止しました。','AbortError');
    if (readError) throw new Error('端末内のPDFを読み取れませんでした。',{cause:readError});
    throw new Error('PDFを開けませんでした。ファイルを確認してください。',{cause:error});
  }
  const textPages=new Map();
  return {
    count:backend.numPages,
    async noteSizeAt(number,at) {
      let geometry=textPages.get(number);
      if (!geometry) {
        geometry=backend.getPage(number).then(async page=>
          pageTextGeometry(await page.getTextContent(),page.getViewport({scale:1}))
        ).catch(()=>null);
        textPages.set(number,geometry);
        if (textPages.size>6) textPages.delete(textPages.keys().next().value);
      }
      const text=await geometry;
      return text ? nearbyTextSize(text,at) : undefined;
    },
    async page(number, rotation) {
      const page = await backend.getPage(number);
      const viewport = page.getViewport({scale:1,rotation:(page.rotate+rotation)%360});
      return {
        width:viewport.width, height:viewport.height,
        cleanup:()=>page.cleanup(),
        start(context,scale,x,y) {
          return page.render({
            canvasContext:context, canvas:context.canvas, viewport,
            transform:[scale,0,0,scale,-x*scale,-y*scale],
            isEditing:false, annotationMode:pdf.AnnotationMode.ENABLE, background:'#fff'
          });
        }
      };
    },
    close:()=>task.destroy()
  };
}

async function openImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((resolve,reject)=>{
      img.onload = resolve;
      img.onerror = () => reject(new Error('画像を開けませんでした。ファイルを確認してください。'));
      img.src = url;
    });
    if (img.naturalWidth*img.naturalHeight > 36_000_000) {
      throw new Error('画像が大きすぎます。3600万画素以下にしてください。');
    }
    return {
      count:1,
      async page(_number, rotation) {
        const w = img.naturalWidth, h = img.naturalHeight;
        return {
          width:rotation%180 ? h:w, height:rotation%180 ? w:h,
          cleanup() {},
          start(context,scale,x,y) {
            context.fillStyle='#fff';
            context.fillRect(0,0,context.canvas.width,context.canvas.height);
            context.setTransform(scale,0,0,scale,-x*scale,-y*scale);
            if (rotation===90) context.translate(h,0);
            if (rotation===180) context.translate(w,h);
            if (rotation===270) context.translate(0,w);
            context.rotate(rotation*Math.PI/180);
            context.drawImage(img,0,0);
            context.resetTransform();
            return {promise:Promise.resolve(), cancel(){}};
          }
        };
      },
      async close() { img.removeAttribute('src'); URL.revokeObjectURL(url); }
    };
  } catch (error) {
    img.removeAttribute('src');
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function validateSize(file,kind) {
  const limit = kind==='pdf' ? 160:35;
  if (file.size > limit*MiB) throw new Error(limit + ' MB以下のファイルを選んでください。');
}
export const openSource = (blob,kind,askPassword) =>
  kind==='pdf' ? openPdf(blob,askPassword) : openImage(blob);
