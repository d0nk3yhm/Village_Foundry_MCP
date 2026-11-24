import * as THREE from './vendor/three.module.js';
import { SoftwareRenderer } from './software-rasterizer.mjs';
import { normalizeOutput, planSpriteFit, fitSprite } from './fit-sprite.mjs';

const DEFAULTS = Object.freeze({
  elevation: 45, azimuth: 0, resolution: 512, scale: 2,
  pixelated: false, outline: true, shadow: true,
});
const OUTLINE = [54, 45, 36];
const MAX_NATIVE_PIXELS = 16777216;
const MAX_PREVIEW_PIXELS = 4194304;
const MAX_PREVIEW_SIDE = 4096;
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function renderError(message, code = 'render_budget_exceeded') {
  const error = new RangeError(message); error.code = code; return error;
}

function makeCanvas(width, height) {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

function boundsCorners(box) {
  const result = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) result.push(new THREE.Vector3(x, y, z));
    }
  }
  return result;
}

function fixedFrame(value) {
  if (!value || !Array.isArray(value.min) || !Array.isArray(value.max) || value.min.length !== 3 || value.max.length !== 3 ||
    [...value.min,...value.max].some(number=>!Number.isFinite(Number(number)))) throw renderError('fixedBounds needs finite min/max coordinate arrays.', 'invalid_geometry');
  const box=new THREE.Box3(new THREE.Vector3(...value.min.map(Number)),new THREE.Vector3(...value.max.map(Number)));
  if(box.isEmpty())throw renderError('fixedBounds must have increasing minimum/maximum coordinates.', 'invalid_geometry');
  return box;
}

function spritePalette(group) {
  const colors=new Set(['#454038','#526d75','#7e8d47','#e8dab8']);
  for(const source of [group.userData?.params,group.userData?.config])if(source)for(const[key,value]of Object.entries(source)) {
    if(/color$/i.test(key)&&typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value))colors.add(value);
  }
  if(colors.size===4)for(const value of ['#928d82','#ab9c80','#a17f50','#b47755'])colors.add(value);
  const palette=[];
  for(const hex of colors){const rgb=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16));
    for(const factor of [.48,.66,.82,.98,1.14,1.30])palette.push(rgb.map(channel=>Math.round(Math.min(255,channel*factor))));
  }
  return palette;
}

// Apply the same palette/outer contour as exports without trimming the viewport.
function finishPreviewRaster(canvas, options, palette, paletteCache = new Map()) {
  if (!options.pixelated && !options.outline) return;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const width = canvas.width, height = canvas.height;
  const image = context.getImageData(0, 0, width, height), data = image.data;
  if (options.pixelated) for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const red=data[i],green=data[i+1],blue=data[i+2],key=((red>>3)<<10)|((green>>3)<<5)|(blue>>3);
    let chosen=paletteCache.get(key);
    if(!chosen){let best=Infinity;for(const color of palette){const dr=red-color[0],dg=green-color[1],db=blue-color[2],distance=dr*dr*.8+dg*dg+db*db*.7;if(distance<best){best=distance;chosen=color;}}paletteCache.set(key,chosen);}
    data[i]=chosen[0];data[i+1]=chosen[1];data[i+2]=chosen[2];
  }
  if (options.outline) {
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const index=y*width+x,i=index*4;
      if (options.pixelated) {
        if (!alpha[index] && (alpha[index-1]>127||alpha[index+1]>127||alpha[index-width]>127||alpha[index+width]>127)) {
          data[i]=OUTLINE[0];data[i+1]=OUTLINE[1];data[i+2]=OUTLINE[2];data[i+3]=255;
        }
      } else if (alpha[index] < 255) {
        const neighbor=Math.max(alpha[index-1],alpha[index+1],alpha[index-width],alpha[index+width],alpha[index-width-1],alpha[index-width+1],alpha[index+width-1],alpha[index+width+1]);
        const a=alpha[index]/255,added=Math.max(0,neighbor-alpha[index])/255*.38*(1-a),result=a+added;
        if(result>0){const contour=[91,72,53];for(let c=0;c<3;c++)data[i+c]=(data[i+c]*a+contour[c]*added)/result;data[i+3]=result*255;}
      }
    }
  }
  context.putImageData(image, 0, 0);
}

/**
 * Orthographic sprite renderer. World axes: X right, Y up, +Z frontage.
 * Houses and supplied textures remain caller-owned. Exports use fixed density,
 * so a larger building occupies more pixels instead of being resized to fit.
 */
export class HouseRenderer {
  constructor(displayCanvas) {
    if (!displayCanvas?.getContext) throw new TypeError('HouseRenderer needs a display canvas.');
    this.displayCanvas = displayCanvas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    const gpuCanvas = makeCanvas(1, 1);
    const contextOptions = { alpha: true, antialias: false,
      preserveDrawingBuffer: true, premultipliedAlpha: true, powerPreference: 'high-performance' };
    try {
      const context = gpuCanvas.getContext('webgl2', contextOptions);
      if (!context) throw new Error('WebGL2 is unavailable.');
      this.webgl = new THREE.WebGLRenderer({ canvas: gpuCanvas, context, ...contextOptions });
    } catch {
      this.webgl = new SoftwareRenderer({ canvas: makeCanvas(1, 1) });
    }
    this.backend = this.webgl.isSoftwareRenderer ? 'software' : 'webgl';
    this.webgl.setPixelRatio(1);
    this.webgl.setClearColor(0x000000, 0);
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 0.80;
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;

    this.ambient = new THREE.AmbientLight(0xfffefa, 0.40);
    this.hemisphere = new THREE.HemisphereLight(0xf0f3f5, 0x7e7262, 1.00);
    this.key = new THREE.DirectionalLight(0xfffdf6, 2.15);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.00015;
    this.key.shadow.normalBias = 0.016;
    this.key.shadow.radius = 1.3;
    this.fill = new THREE.DirectionalLight(0xd7dfe3, 0.35);
    this.scene.add(this.ambient, this.hemisphere, this.key, this.key.target, this.fill, this.fill.target);

    this.groundMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, metalness: 0,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.ground.name = 'preview-ground-only';
    this.scene.add(this.ground);
    this.groundTexture = null;
    this.house = null;
    this.lastMeta = null;
    this.lastOptions = { ...DEFAULTS };
    // Preview navigation is independent of the sprite camera and export size.
    this.previewZoom = 1;
    this.previewOffset = { x: 0, y: 0 };
    this.previewSnapshot = null;
    this.previewFrame = null;
    this.previewDetail = null;
    this.lastPreviewMeta = null;
    this.disposed = false;
  }

  setHouse(group) {
    this._assertAlive();
    if (this.house) this.scene.remove(this.house);
    this.house = group || null;
    if (this.house) this.scene.add(this.house);
    return this;
  }

  setGroundTexture(textureOrNull) {
    this._assertAlive();
    // Only this clone is disposed; the caller can continue using the original.
    if (this.groundTexture) this.groundTexture.dispose();
    this.groundTexture = textureOrNull ? textureOrNull.clone() : null;
    if (this.groundTexture) {
      this.groundTexture.wrapS = THREE.RepeatWrapping;
      this.groundTexture.wrapT = THREE.RepeatWrapping;
      this.groundTexture.magFilter = THREE.NearestFilter;
      this.groundTexture.minFilter = THREE.NearestFilter;
      this.groundTexture.generateMipmaps = false;
      this.groundTexture.needsUpdate = true;
    }
    this.groundMaterial.map = this.groundTexture;
    this.groundMaterial.needsUpdate = true;
    this.ground.visible = false;
    return this;
  }

  _assertAlive() {
    if (this.disposed) throw new Error('This HouseRenderer has been disposed.');
  }

  render(options = {}, { previewGround = true } = {}) {
    try { return this._renderSprite(options, { previewGround }); }
    catch (error) {
      if (!error.code && error instanceof RangeError && /too large|too small|cannot contain|needs at least|exceeds|padding must leave/i.test(error.message)) error.code='render_budget_exceeded';
      throw error;
    }
  }

  _renderSprite(options = {}, { previewGround = true } = {}) {
    this._assertAlive();
    if (!this.house) throw new Error('Choose a house before rendering.');
    if (this.webgl.getContext().isContextLost()) throw new Error('The graphics context was lost. Reload the workbench to render again.');
    const o = { ...DEFAULTS, ...options, ...(options.output||{}) };
    o.elevation = clamp(finite(o.elevation, 55), 0, 90);
    o.azimuth = finite(o.azimuth, 0) % 360;
    o.resolution = clamp(finite(o.resolution, 512), 32, 4096);
    o.scale = clamp(Math.round(finite(o.scale, 2)), 1, 8);
    o.pixelated = o.style === 'pixel' ? true : o.style === 'illustrated' ? false : o.pixelated !== false;
    o.outline = o.outline !== false;
    o.shadow = o.shadow !== false;
    const output=normalizeOutput(o);Object.assign(o,output);
    // A requested fixed character canvas is a stable animation frame, even
    // when a caller did not explicitly supply the animation export flags.
    if(output.sizeMode==='fixed'&&this.house.userData?.kind==='character'){
      o.fixedBounds=typeof o.fixedBounds==='object'?o.fixedBounds:true;o.trim=false;
    }
    this.lastOptions = {...o};
    // Illustrated enlargement is sampled from geometry. Pixel enlargement keeps
    // the requested native grid. Contain chooses its final density from the box.
    const fitScale=o.pixelated?o.scale:1;
    let effectiveResolution=o.resolution*(!o.pixelated&&(output.sizeMode==='auto'||output.fit==='pad')?o.scale:1);
    let result=null,plan=null,attempts=0;
    for(;;){
      result=this._renderNative({...o,resolution:effectiveResolution},{previewGround});
      plan=planSpriteFit(result.canvas.width,result.canvas.height,{...output,scale:fitScale,pixelated:o.pixelated});
      if(!o.pixelated && plan.factor>1+1e-9){
        if(attempts++>=8)throw renderError('This fixed HD canvas could not be sampled within the renderer budget. Reduce its dimensions or use automatic sizing.');
        effectiveResolution=Math.ceil(effectiveResolution*plan.factor*1.02);
        continue;
      }
      if(!plan.needsRerender)break;
      if(effectiveResolution<=8||attempts++>=8)throw renderError(`The ${output.width} × ${output.height} canvas is too small for this pixel sprite and its ${output.padding}-pixel padding. Increase the canvas, reduce the padding, or choose illustrated output.`);
      // Fixed renderer margins do not shrink with world-space density.
      const reserved=result.meta.trimmed?result.meta.nativeBorder*2:result.meta.nativeBorder*2+8;
      const ratio=Math.min((plan.availableWidth-reserved)/Math.max(1,result.canvas.width-reserved),
        (plan.availableHeight-reserved)/Math.max(1,result.canvas.height-reserved));
      effectiveResolution=Math.max(8,Math.min(effectiveResolution-1,Math.floor(effectiveResolution*Math.max(.05,ratio)*.98)));
    }
    const fitted=fitSprite(result.canvas,result.meta,{...output,scale:fitScale,pixelated:o.pixelated},makeCanvas);
    this._lastPixelPalette={palette:result.palette,cache:result.paletteCache};
    this.lastMeta={...fitted.meta,requestedResolution:o.resolution,resolution:effectiveResolution,
      resolutionReduced:effectiveResolution<o.resolution,
      resolutionIncreased:effectiveResolution>o.resolution,requestedScale:o.scale,
      sampling:o.pixelated?'native-pixel-grid':'native-geometry',rasterUpscaled:!o.pixelated&&fitted.plan.factor>1+1e-9,
      nativePixelBudget:MAX_NATIVE_PIXELS,
      output:{...output},sourceRender:{...fitted.meta.sourceRender,requestedResolution:o.resolution,requestedScale:o.scale}};
    return fitted.canvas;
  }

  _renderNative(o, {previewGround}) {

    this.house.updateMatrixWorld(true);
    const houseBounds = new THREE.Box3().setFromObject(this.house);
    if (houseBounds.isEmpty()) throw renderError('The scene has no visible geometry.', 'invalid_geometry');
    const suppliedFrame=typeof o.fixedBounds==='object'?o.fixedBounds:
      (o.fixedBounds===true||o.trim===false)?this.house.userData?.frameBounds:null;
    if(o.fixedBounds===true&&!suppliedFrame)throw renderError('fixedBounds:true requires group.userData.frameBounds.', 'invalid_geometry');
    const framingBounds=suppliedFrame?fixedFrame(suppliedFrame):houseBounds;
    if(suppliedFrame&&!framingBounds.clone().expandByScalar(.01).containsBox(houseBounds))throw renderError('The fixed frame does not contain all scene geometry. Increase frameBounds.', 'invalid_geometry');
    const center = framingBounds.getCenter(new THREE.Vector3());
    const size = framingBounds.getSize(new THREE.Vector3());
    const fitBounds = framingBounds.clone();
    const groundIncluded = Boolean(previewGround && this.groundTexture);
    this.ground.visible = groundIncluded;
    if (groundIncluded) {
      const width = size.x + 2.2, depth = size.z + 2.2;
      const y = houseBounds.min.y - 0.025;
      this.ground.position.set(center.x, y, center.z);
      this.ground.scale.set(width, depth, 1);
      this.groundTexture.repeat.set(width / 3, depth / 3);
      fitBounds.expandByPoint(new THREE.Vector3(center.x - width / 2, y, center.z - depth / 2));
      fitBounds.expandByPoint(new THREE.Vector3(center.x + width / 2, y, center.z + depth / 2));
    }

    const elevation = THREE.MathUtils.degToRad(o.elevation);
    const azimuth = THREE.MathUtils.degToRad(o.azimuth);
    const ca = Math.cos(azimuth), sa = Math.sin(azimuth);
    const ce = Math.cos(elevation), se = Math.sin(elevation);
    const right = new THREE.Vector3(ca, 0, -sa);
    const up = new THREE.Vector3(-sa * se, ce, -ca * se);
    const towardCamera = new THREE.Vector3(sa * ce, se, ca * ce);
    const kind=this.house.userData?.kind||'house';
    const referenceSpan=kind==='map'?Math.max(24,this.house.userData.config?.width||size.x,this.house.userData.config?.depth||size.z):kind==='character'?3:12;
    const ppu = o.resolution / referenceSpan;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const corner of boundsCorners(fitBounds)) {
      corner.sub(center);
      const x = corner.dot(right), y = corner.dot(up);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const left = Math.floor(minX * ppu) - 4, rightEdge = Math.ceil(maxX * ppu) + 4;
    const bottom = Math.floor(minY * ppu) - 4, top = Math.ceil(maxY * ppu) + 4;
    const frameWidth = Math.max(1, rightEdge - left), frameHeight = Math.max(1, top - bottom);
    const supersample = o.pixelated || frameWidth * frameHeight * 4 > MAX_NATIVE_PIXELS || Math.max(frameWidth,frameHeight)*2>8192 ? 1 : 2;
    if (frameWidth > 8192 || frameHeight > 8192 || frameWidth * frameHeight > MAX_NATIVE_PIXELS) {
      throw renderError(`This HD render needs ${frameWidth} × ${frameHeight} native pixels. The renderer supports at most 8,192 per side and 16,777,216 native pixels. Reduce the detail resolution, export scale, or fixed canvas dimensions.`);
    }

    const span = Math.max(3, size.length());
    this.camera.left = left / ppu;
    this.camera.right = rightEdge / ppu;
    this.camera.bottom = bottom / ppu;
    this.camera.top = top / ppu;
    this.camera.near = 0.1;
    this.camera.far = span * 8 + 30;
    this.camera.position.copy(center).addScaledVector(towardCamera, span * 3 + 10);
    this.camera.up.copy(up); // Remains well-defined at exactly 90 degrees.
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    this.key.position.copy(center).add(new THREE.Vector3(-0.7, 1.35, 0.9).multiplyScalar(span));
    this.key.target.position.copy(center);
    this.fill.position.copy(center).add(new THREE.Vector3(0.8, 0.5, -0.7).multiplyScalar(span));
    this.fill.target.position.copy(center);
    const shadowCamera = this.key.shadow.camera;
    shadowCamera.left = shadowCamera.bottom = -span * 0.75;
    shadowCamera.right = shadowCamera.top = span * 0.75;
    shadowCamera.near = 0.1;
    shadowCamera.far = span * 5;
    shadowCamera.updateProjectionMatrix();
    this.key.castShadow = o.shadow;
    this.webgl.shadowMap.enabled = o.shadow;
    this.webgl.shadowMap.needsUpdate = true;
    this.scene.updateMatrixWorld(true);
    this.webgl.setSize(frameWidth * supersample, frameHeight * supersample, false);
    this.webgl.render(this.scene, this.camera);

    const raw = makeCanvas(frameWidth, frameHeight);
    const rawContext = raw.getContext('2d', { willReadFrequently: true });
    rawContext.imageSmoothingEnabled = !o.pixelated;
    rawContext.imageSmoothingQuality = 'high';
    rawContext.drawImage(this.webgl.domElement, 0, 0, frameWidth, frameHeight);
    const pixels = rawContext.getImageData(0, 0, frameWidth, frameHeight);
    const palette=o.pixelated?spritePalette(this.house):null, paletteCache=new Map();
    let cropLeft = frameWidth, cropTop = frameHeight, cropRight = -1, cropBottom = -1;
    for (let y = 0; y < frameHeight; y += 1) {
      for (let x = 0; x < frameWidth; x += 1) {
        const i = (y * frameWidth + x) * 4;
        if (pixels.data[i + 3] === 0) continue;
        cropLeft = Math.min(cropLeft, x); cropRight = Math.max(cropRight, x);
        cropTop = Math.min(cropTop, y); cropBottom = Math.max(cropBottom, y);
        if (o.pixelated) {
          // Stable six-band material ramps, rather than channel-wise posterizing.
          const red=pixels.data[i],green=pixels.data[i+1],blue=pixels.data[i+2],key=((red>>3)<<10)|((green>>3)<<5)|(blue>>3);
          let chosen=paletteCache.get(key);
          if(!chosen){let best=Infinity;for(const color of palette){const dr=red-color[0],dg=green-color[1],db=blue-color[2],distance=dr*dr*.8+dg*dg+db*db*.7;if(distance<best){best=distance;chosen=color;}}paletteCache.set(key,chosen);}
          pixels.data[i]=chosen[0];pixels.data[i+1]=chosen[1];pixels.data[i+2]=chosen[2];
        }
      }
    }
    if (cropRight < cropLeft) throw renderError('The scene rendered as an empty image.', 'invalid_geometry');
    if(o.trim===false){cropLeft=0;cropTop=0;cropRight=frameWidth-1;cropBottom=frameHeight-1;}
    rawContext.putImageData(pixels, 0, 0);
    const border = 3 + (o.outline ? 1 : 0);
    const nativeWidth = cropRight - cropLeft + 1 + border * 2;
    const nativeHeight = cropBottom - cropTop + 1 + border * 2;
    const native = makeCanvas(nativeWidth, nativeHeight);
    const nativeContext = native.getContext('2d', { willReadFrequently: true });
    nativeContext.imageSmoothingEnabled = false;
    nativeContext.drawImage(raw, cropLeft, cropTop, cropRight - cropLeft + 1, cropBottom - cropTop + 1,
      border, border, cropRight - cropLeft + 1, cropBottom - cropTop + 1);
    if (o.outline) {
      const image = nativeContext.getImageData(0, 0, nativeWidth, nativeHeight);
      const alpha = new Uint8Array(nativeWidth * nativeHeight);
      for (let index = 0; index < alpha.length; index += 1) alpha[index] = image.data[index * 4 + 3];
      for (let y = 1; y < nativeHeight - 1; y += 1) {
        for (let x = 1; x < nativeWidth - 1; x += 1) {
          const index = y * nativeWidth + x;
          if (!o.pixelated) {
            if (alpha[index] === 255) continue;
            const neighbor = Math.max(alpha[index-1],alpha[index+1],alpha[index-nativeWidth],alpha[index+nativeWidth],
              alpha[index-nativeWidth-1],alpha[index-nativeWidth+1],alpha[index+nativeWidth-1],alpha[index+nativeWidth+1]);
            const a = alpha[index] / 255, behind = Math.max(0, neighbor - alpha[index]) / 255 * 0.38;
            const added = behind * (1-a), result = a + added;
            if (result > 0) {
              const i = index * 4, contour = [91, 72, 53];
              for(let channel=0;channel<3;channel++) image.data[i+channel]=(image.data[i+channel]*a+contour[channel]*added)/result;
              image.data[i+3]=result*255;
            }
            continue;
          }
          if (alpha[index] > 0) continue;
          if (alpha[index - 1] > 127 || alpha[index + 1] > 127 || alpha[index - nativeWidth] > 127 || alpha[index + nativeWidth] > 127) {
            const i = index * 4;
            image.data[i] = OUTLINE[0]; image.data[i + 1] = OUTLINE[1]; image.data[i + 2] = OUTLINE[2]; image.data[i + 3] = 255;
          }
        }
      }
      nativeContext.putImageData(image, 0, 0);
    }

    const originRelative = center.clone().negate();
    const anchorX = originRelative.dot(right) * ppu - left - cropLeft + border;
    const anchorY = top - originRelative.dot(up) * ppu - cropTop + border;
    const meta = {
      width:nativeWidth, height:nativeHeight, nativeWidth, nativeHeight,
      pixelsPerUnit: ppu, nativePixelsPerUnit: ppu,
      referenceSpan,kind,style:o.pixelated?'pixel':'illustrated',trimmed:o.trim!==false,boundsMode:suppliedFrame?'fixed':'automatic',
      scale: 1, resolution: o.resolution,
      elevation: o.elevation, azimuth: o.azimuth,
      projection: 'orthographic', transparent: true, groundIncluded,
      renderer: this.backend, shadows: o.shadow ? (this.backend === 'software' ? 'cpu-directional-depth-map' : 'gpu-directional-depth-map') : 'off',
      padding: 3, nativeBorder:border, outlineNativePixels: o.outline ? 1 : 0,
      anchor_px: [anchorX, anchorY], anchor_world: [0, 0, 0],
      world_bounds: { min: houseBounds.min.toArray(), max: houseBounds.max.toArray() },
    };
    return {canvas:native,meta,palette,paletteCache};
  }

  show(options = {}) {
    const output = this.render(options, { previewGround: true });
    // Exports also call render() and replace lastMeta/lastOptions. Keep a
    // separate snapshot so wheel navigation always redraws the visible scene.
    this.previewSnapshot = {
      canvas: output, pixelated: this.lastOptions.pixelated,
      house: this.house, state: this._captureRenderState(), options: {...this.lastOptions},
      anchor: [...this.lastMeta.anchor_px], pixelsPerUnit: this.lastMeta.pixelsPerUnit,
      palette: this._lastPixelPalette?.palette,
      paletteCache: new Map(this._lastPixelPalette?.cache || []),
      fitDisplay: { nativePixelSize: this.lastMeta.fitDisplay?.nativePixelSize || 1,
        gridOrigin: [...(this.lastMeta.fitDisplay?.gridOrigin || [0, 0])] },
    };
    this.previewDetail = null;
    this.lastPreviewMeta = null;
    this.repaintPreview();
    return output;
  }

  _captureRenderState() {
    return {
      camera:this.camera.clone(),
      keyPosition:this.key.position.clone(),keyTarget:this.key.target.position.clone(),
      fillPosition:this.fill.position.clone(),fillTarget:this.fill.target.position.clone(),
      shadowCamera:this.key.shadow.camera.clone(),castShadow:this.key.castShadow,
      shadowEnabled:this.webgl.shadowMap.enabled,shadowNeedsUpdate:this.webgl.shadowMap.needsUpdate,
      groundVisible:this.ground.visible,groundPosition:this.ground.position.clone(),
      groundQuaternion:this.ground.quaternion.clone(),groundScale:this.ground.scale.clone(),
      groundRepeat:this.groundTexture?.repeat.clone(),
      width:this.webgl.domElement.width,height:this.webgl.domElement.height,
    };
  }

  _restoreRenderState(state, resize = false) {
    this.camera.copy(state.camera);
    this.key.position.copy(state.keyPosition);this.key.target.position.copy(state.keyTarget);
    this.fill.position.copy(state.fillPosition);this.fill.target.position.copy(state.fillTarget);
    this.key.shadow.camera.copy(state.shadowCamera);this.key.castShadow=state.castShadow;
    this.webgl.shadowMap.enabled=state.shadowEnabled;this.webgl.shadowMap.needsUpdate=state.shadowNeedsUpdate;
    this.ground.visible=state.groundVisible;this.ground.position.copy(state.groundPosition);
    this.ground.quaternion.copy(state.groundQuaternion);this.ground.scale.copy(state.groundScale);
    if(this.groundTexture&&state.groundRepeat)this.groundTexture.repeat.copy(state.groundRepeat);
    this.scene.updateMatrixWorld(true);
    if(resize)this.webgl.setSize(state.width,state.height,false);
  }

  _previewPixelRatio(width, height) {
    const requested=this.previewSnapshot.pixelated?1:clamp(finite(globalThis.devicePixelRatio,1),1,2);
    return Math.min(requested,(MAX_PREVIEW_SIDE-8)/width,(MAX_PREVIEW_SIDE-8)/height,Math.sqrt(MAX_PREVIEW_PIXELS*.99/(width*height)));
  }

  _previewFrameMatches(a, b) {
    return a&&b&&['x','y','ratio','width','height','pixelRatio'].every(key=>a[key]===b[key]);
  }

  /** Plan a cropped camera from the final PNG's world anchor, including padding. */
  previewDetailPlan() {
    const snapshot=this.previewSnapshot,frame=this.previewFrame;
    if(!snapshot?.state?.camera||!frame||snapshot.house!==this.house)return null;
    const ppu=snapshot.pixelsPerUnit*frame.ratio;
    if(!Number.isFinite(ppu)||ppu<=0)return null;
    const screenOrigin=[frame.x+snapshot.anchor[0]*frame.ratio,frame.y+snapshot.anchor[1]*frame.ratio];
    let width,height,x,y,drawWidth,drawHeight,density;
    if(snapshot.pixelated){
      const cell=snapshot.fitDisplay.nativePixelSize*frame.ratio;
      const gridX=frame.x+snapshot.fitDisplay.gridOrigin[0]*frame.ratio;
      const gridY=frame.y+snapshot.fitDisplay.gridOrigin[1]*frame.ratio;
      const firstX=Math.floor(-gridX/cell)-2,firstY=Math.floor(-gridY/cell)-2;
      width=Math.ceil((frame.width-gridX)/cell)+2-firstX;
      height=Math.ceil((frame.height-gridY)/cell)+2-firstY;
      x=gridX+firstX*cell;y=gridY+firstY*cell;
      drawWidth=width*cell;drawHeight=height*cell;density=1/cell;
    }else{
      density=frame.pixelRatio;
      width=Math.ceil(frame.width*density)+4;height=Math.ceil(frame.height*density)+4;
      x=-2/density;y=-2/density;drawWidth=width/density;drawHeight=height/density;
    }
    const limited=width>MAX_PREVIEW_SIDE||height>MAX_PREVIEW_SIDE||width*height>MAX_PREVIEW_PIXELS;
    const camera=snapshot.state.camera.clone();
    const origin=new THREE.Vector3().applyMatrix4(camera.matrixWorldInverse);
    camera.left=origin.x+(x-screenOrigin[0])/ppu;
    camera.right=camera.left+drawWidth/ppu;
    camera.top=origin.y-(y-screenOrigin[1])/ppu;
    camera.bottom=camera.top-drawHeight/ppu;
    camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    return{camera,width,height,x,y,drawWidth,drawHeight,density,screenPixelsPerUnit:ppu,
      worldWidth:camera.right-camera.left,worldHeight:camera.top-camera.bottom,
      frame:{...frame},limited,pixelated:snapshot.pixelated};
  }

  /** Render only the visible world window; never rebuild or mutate the model. */
  renderPreviewDetail() {
    this._assertAlive();
    this.repaintPreview();
    const snapshot=this.previewSnapshot,plan=this.previewDetailPlan();
    if(!plan)return null;
    if(this.previewDetail?.snapshot===snapshot&&this._previewFrameMatches(this.previewDetail.frame,plan.frame))return this.lastPreviewMeta;
    if(plan.limited){
      this.lastPreviewMeta={status:'limited',style:snapshot.pixelated?'pixel':'illustrated',
        message:snapshot.pixelated?'Native pixel grid retained; this overview exceeds the detail window budget.':'Preview detail is limited by the viewport pixel budget.',
        maxPixels:MAX_PREVIEW_PIXELS};
      return this.lastPreviewMeta;
    }
    const before=this._captureRenderState(),lastMeta=this.lastMeta,lastOptions=this.lastOptions;
    let canvas;
    const supersample=!snapshot.pixelated&&plan.width*plan.height*4<=MAX_PREVIEW_PIXELS&&Math.max(plan.width,plan.height)*2<=MAX_PREVIEW_SIDE?2:1;
    try{
      this._restoreRenderState(snapshot.state);
      this.key.castShadow=snapshot.options.shadow;
      this.webgl.shadowMap.enabled=snapshot.options.shadow;this.webgl.shadowMap.needsUpdate=true;
      this.webgl.setSize(plan.width*supersample,plan.height*supersample,false);
      this.webgl.render(this.scene,plan.camera);
      canvas=makeCanvas(plan.width,plan.height);
      const context=canvas.getContext('2d',{willReadFrequently:true});
      context.imageSmoothingEnabled=!snapshot.pixelated;context.imageSmoothingQuality='high';
      context.drawImage(this.webgl.domElement,0,0,plan.width,plan.height);
      finishPreviewRaster(canvas,snapshot.options,snapshot.palette,new Map(snapshot.paletteCache));
    }finally{
      this._restoreRenderState(before,true);
      this.lastMeta=lastMeta;this.lastOptions=lastOptions;
    }
    if(this.previewSnapshot!==snapshot||this.house!==snapshot.house)return null;
    this.previewDetail={canvas,snapshot,frame:plan.frame,x:plan.x,y:plan.y,drawWidth:plan.drawWidth,drawHeight:plan.drawHeight};
    this.lastPreviewMeta={status:'ready',style:snapshot.pixelated?'pixel':'illustrated',
      width:plan.width,height:plan.height,renderWidth:plan.width*supersample,renderHeight:plan.height*supersample,
      pixelsPerUnit:plan.screenPixelsPerUnit*plan.density,nativePixelsPerUnit:plan.screenPixelsPerUnit*plan.density*supersample,
      screenPixelsPerUnit:plan.screenPixelsPerUnit,viewportWidth:plan.frame.width,viewportHeight:plan.frame.height,
      deviceScale:plan.frame.pixelRatio,worldWidth:plan.worldWidth,worldHeight:plan.worldHeight,
      camera:{left:plan.camera.left,right:plan.camera.right,top:plan.camera.top,bottom:plan.camera.bottom},
      groundIncluded:snapshot.state.groundVisible,shadow:snapshot.options.shadow,outline:snapshot.options.outline,
      sameGeometry:true,source:'geometry-window',maxPixels:MAX_PREVIEW_PIXELS,
      densityLimited:!snapshot.pixelated&&plan.frame.pixelRatio<clamp(finite(globalThis.devicePixelRatio,1),1,2)};
    this.repaintPreview();
    return this.lastPreviewMeta;
  }

  _previewLayout(width, height) {
    const { canvas: output, pixelated, fitDisplay } = this.previewSnapshot;
    const padding = Math.min(44, Math.max(18, Math.min(width, height) * 0.08));
    const fit = Math.min((width - padding * 2) / output.width, (height - padding * 2) / output.height);
    const cell = fitDisplay.nativePixelSize;
    const desired = Math.max(.01, fit * this.previewZoom);
    const ratio = pixelated && desired * cell >= 1 ? Math.floor(desired * cell) / cell : desired;
    const drawWidth = output.width * ratio, drawHeight = output.height * ratio;
    return { width, height, ratio, drawWidth, drawHeight,
      centerX: (width - drawWidth) / 2, centerY: (height - drawHeight) / 2 };
  }

  repaintPreview() {
    if (!this.previewSnapshot || this.disposed) return null;
    const display = this.displayCanvas;
    const width = Math.max(1, Math.round(display.clientWidth || display.parentElement?.clientWidth || 768));
    const height = Math.max(1, Math.round(display.clientHeight || display.parentElement?.clientHeight || 576));
    const pixelRatio=this._previewPixelRatio(width,height);
    const backingWidth=Math.max(1,Math.round(width*pixelRatio)),backingHeight=Math.max(1,Math.round(height*pixelRatio));
    if (display.width !== backingWidth) display.width = backingWidth;
    if (display.height !== backingHeight) display.height = backingHeight;
    const context = display.getContext('2d');
    context.setTransform?.(pixelRatio,0,0,pixelRatio,0,0);
    context.clearRect(0, 0, width, height);
    const frame = this._previewLayout(width, height);
    const { canvas: output, pixelated, fitDisplay } = this.previewSnapshot;
    context.imageSmoothingEnabled = !pixelated;
    // Keep a small scene inside the viewport and a magnified scene covering it.
    this.previewOffset.x = clamp(this.previewOffset.x, -Math.abs(frame.centerX), Math.abs(frame.centerX));
    this.previewOffset.y = clamp(this.previewOffset.y, -Math.abs(frame.centerY), Math.abs(frame.centerY));
    let x = frame.centerX + this.previewOffset.x, y = frame.centerY + this.previewOffset.y;
    if (pixelated) {
      const origin = fitDisplay.gridOrigin;
      x = Math.round(x + origin[0] * frame.ratio) - origin[0] * frame.ratio;
      y = Math.round(y + origin[1] * frame.ratio) - origin[1] * frame.ratio;
    }
    this.previewFrame = { ...frame, x, y, pixelRatio };
    const detail=this.previewDetail;
    if(detail?.snapshot===this.previewSnapshot&&this._previewFrameMatches(detail.frame,this.previewFrame)){
      context.drawImage(detail.canvas,detail.x,detail.y,detail.drawWidth,detail.drawHeight);
    }else context.drawImage(output, x, y, frame.drawWidth, frame.drawHeight);
    return this.previewFrame;
  }

  setPreviewZoom(value, x, y) {
    const previous = this.previewFrame || this.repaintPreview();
    const nextZoom = clamp(finite(value, this.previewZoom), .25, 8);
    if (nextZoom === this.previewZoom) return this.previewFrame;
    this.previewZoom = nextZoom;
    if (previous) {
      const pointX = finite(x, previous.width / 2), pointY = finite(y, previous.height / 2);
      const next = this._previewLayout(previous.width, previous.height);
      const ratio = next.ratio / previous.ratio;
      this.previewOffset.x = pointX - (pointX - previous.x) * ratio - next.centerX;
      this.previewOffset.y = pointY - (pointY - previous.y) * ratio - next.centerY;
    }
    return this.repaintPreview();
  }

  panPreview(dx, dy) {
    this.previewOffset.x += finite(dx, 0);
    this.previewOffset.y += finite(dy, 0);
    return this.repaintPreview();
  }

  resetPreview() {
    this.previewZoom = 1;
    this.previewOffset = { x: 0, y: 0 };
    return this.repaintPreview();
  }

  dispose() {
    if (this.disposed) return;
    if (this.house) this.scene.remove(this.house);
    this.house = null;
    if (this.groundTexture) this.groundTexture.dispose();
    this.ground.geometry.dispose();
    this.groundMaterial.dispose();
    if (this.key.shadow.map) this.key.shadow.map.dispose();
    this.scene.clear();
    this.webgl.dispose();
    this.webgl.forceContextLoss();
    this.previewSnapshot = null;
    this.previewFrame = null;
    this.previewDetail = null;
    this.lastPreviewMeta = null;
    this.disposed = true;
  }
}
