/** Exact transparent export framing, independent of scene/model geometry. */
export const MAX_SPRITE_PIXELS = 33554432;
export const OUTPUT_DEFAULTS = Object.freeze({sizeMode:'auto',width:512,height:512,padding:8,fit:'contain'});

function integer(value,fallback,name,min,max){
  const n=value===undefined?fallback:Number(value);
  if(!Number.isFinite(n)||!Number.isInteger(n)||n<min||n>max)throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

/** Pure validation shared by browser tools and non-DOM callers. */
export function normalizeOutput(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new TypeError('Output settings must be an object.');
  const out={
    sizeMode:raw.sizeMode??OUTPUT_DEFAULTS.sizeMode,
    width:integer(raw.width,512,'Output width',16,8192),
    height:integer(raw.height,512,'Output height',16,8192),
    padding:integer(raw.padding,8,'Output padding',0,128),
    fit:raw.fit??OUTPUT_DEFAULTS.fit,
  };
  if(!['auto','fixed'].includes(out.sizeMode))throw new RangeError('Output size mode must be auto or fixed.');
  if(!['contain','pad'].includes(out.fit))throw new RangeError('Output fit must be contain or pad.');
  if(out.sizeMode==='fixed'){
    if(out.width*out.height>MAX_SPRITE_PIXELS)throw new RangeError('The fixed PNG exceeds 33,554,432 pixels. Reduce its width or height.');
    if(out.padding*2>=Math.min(out.width,out.height))throw new RangeError('Output padding must leave at least one pixel of usable width and height.');
  }
  return out;
}

/**
 * Calculate a uniform native-pixel transform without allocating a canvas.
 * Pixel contain can request a lower-resolution scene render; it never silently
 * shrinks native pixels or uses a fractional pixel-art enlargement.
 */
export function planSpriteFit(nativeWidth,nativeHeight,raw={}){
  if(!Number.isInteger(nativeWidth)||!Number.isInteger(nativeHeight)||nativeWidth<1||nativeHeight<1)throw new RangeError('A rendered sprite needs positive integer dimensions.');
  const output=normalizeOutput(raw),scale=Number(raw.scale??1),pixelated=raw.pixelated===true;
  if(!Number.isFinite(scale)||scale<1||scale>8||!Number.isInteger(scale))throw new RangeError('Sprite enlargement scale must be an integer from 1 to 8.');
  if(output.sizeMode==='auto'){
    const width=nativeWidth*scale,height=nativeHeight*scale;
    if(width>8192||height>8192||width*height>MAX_SPRITE_PIXELS)throw new RangeError('The enlarged PNG is too large. Reduce its scale or resolution.');
    return{...output,width,height,factor:scale,x:0,y:0,contentWidth:width,contentHeight:height,needsRerender:false,pixelated,requestedScale:scale};
  }
  const availableWidth=output.width-output.padding*2,availableHeight=output.height-output.padding*2;
  let factor=output.fit==='pad'?scale:Math.min(availableWidth/nativeWidth,availableHeight/nativeHeight);
  if(output.fit==='pad'&&(nativeWidth*scale>availableWidth||nativeHeight*scale>availableHeight)){
    throw new RangeError(`This sprite needs at least ${nativeWidth*scale+output.padding*2} × ${nativeHeight*scale+output.padding*2} pixels at its current scale. The requested ${output.width} × ${output.height} canvas cannot contain it. Choose Contain, reduce the detail/scale, or enlarge the canvas.`);
  }
  const nativeFit=Math.min(availableWidth/nativeWidth,availableHeight/nativeHeight);
  if(pixelated&&output.fit==='contain')factor=Math.floor(factor+1e-10);
  const needsRerender=factor<1&&pixelated;
  if(needsRerender)return{...output,availableWidth,availableHeight,nativeFit,needsRerender:true,pixelated,requestedScale:scale};
  const contentWidth=nativeWidth*factor,contentHeight=nativeHeight*factor;
  // Integer offsets preserve the pixel grid; illustrated imagery can be
  // centered at fractional pixels because its resampling is continuous.
  const x=pixelated?Math.floor((output.width-contentWidth)/2):(output.width-contentWidth)/2;
  const y=pixelated?Math.floor((output.height-contentHeight)/2):(output.height-contentHeight)/2;
  return{...output,availableWidth,availableHeight,factor,x,y,contentWidth,contentHeight,needsRerender:false,pixelated,requestedScale:scale};
}

function canvasFactory(width,height){
  const canvas=typeof document!=='undefined'?document.createElement('canvas'):
    typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(width,height):null;
  if(!canvas)throw new Error('Sprite framing needs a Canvas or OffscreenCanvas implementation.');
  canvas.width=width;canvas.height=height;return canvas;
}

/**
 * Fit a native renderer canvas into the requested output frame.
 * meta.anchor_px and meta.pixelsPerUnit are in this input canvas's coordinates.
 * Result metadata records the complete transform. nativeWidth/nativeHeight
 * describe the final frame in native-grid coordinates; they may be fractional
 * when exact output edges fall between native pixel boundaries. The original
 * integer source grid remains in sourceRender.nativeWidth/nativeHeight.
 */
export function fitSprite(native,meta={},raw={},makeCanvas=canvasFactory){
  const plan=planSpriteFit(native.width,native.height,raw);
  if(plan.needsRerender){const error=new RangeError('The native pixel grid is larger than the fixed canvas. Render it at a lower resolution before fitting.');error.code='SPRITE_NEEDS_LOWER_RESOLUTION';error.plan=plan;throw error;}
  const canvas=makeCanvas(plan.width,plan.height),context=canvas.getContext('2d');
  if(!context)throw new Error('A 2D canvas context is required to frame a sprite.');
  context.clearRect(0,0,canvas.width,canvas.height);
  context.imageSmoothingEnabled=!plan.pixelated;context.imageSmoothingQuality='high';
  context.drawImage(native,0,0,native.width,native.height,plan.x,plan.y,plan.contentWidth,plan.contentHeight);
  const factor=plan.factor,sourceAnchor=Array.isArray(meta.anchor_px)?meta.anchor_px:[0,0];
  const ppu=Number(meta.nativePixelsPerUnit??meta.pixelsPerUnit??1),anchor=[sourceAnchor[0]*factor+plan.x,sourceAnchor[1]*factor+plan.y];
  const sourceRender={width:native.width*plan.requestedScale,height:native.height*plan.requestedScale,
    nativeWidth:native.width,nativeHeight:native.height,scale:plan.requestedScale,resolution:meta.resolution,
    pixelsPerUnit:ppu*plan.requestedScale,nativePixelsPerUnit:ppu,
    anchor_px:sourceAnchor.map(v=>v*plan.requestedScale)};
  const resultMeta={...meta,width:plan.width,height:plan.height,
    nativeWidth:plan.width/factor,nativeHeight:plan.height/factor,
    pixelsPerUnit:ppu*factor,outputPixelsPerUnit:ppu*factor,nativePixelsPerUnit:ppu,
    scale:factor,requestedScale:plan.requestedScale,renderScale:factor,fitScale:factor/plan.requestedScale,
    sizeMode:plan.sizeMode,fit:plan.fit,padding:plan.sizeMode==='fixed'?plan.padding:(meta.padding??3)*factor,
    anchor_px:anchor,native_anchor_px:anchor.map(v=>v/factor),
    contentRect:{x:plan.x,y:plan.y,width:plan.contentWidth,height:plan.contentHeight},sourceRender,
    fitDisplay:{width:plan.width,height:plan.height,nativePixelSize:factor,gridOrigin:[plan.x,plan.y]},
  };
  return{canvas,meta:resultMeta,plan};
}
