import * as THREE from './vendor/three.module.js';

// A deterministic Canvas2D rasterizer for the app's ordinary/instanced meshes.
// Uses the same geometry, materials, textures and orthographic cameras as WebGL.
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, index) => {
  const value = index / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const srgb = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

function colorTable(toneMapping, exposure) {
  const table = new Uint8Array(4096);
  for (let i = 0; i < table.length; i += 1) {
    let value = i / 1024 * exposure;
    if (toneMapping !== THREE.NoToneMapping) {
      value = (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14);
    }
    table[i] = Math.round(clamp01(srgb(Math.max(0, value))) * 255);
  }
  return table;
}

function transformPoint(matrix, x, y, z, output, offset, width = 0, height = 0) {
  const denominator = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const inverse = denominator ? 1 / denominator : 1;
  const a = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) * inverse;
  const b = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) * inverse;
  output[offset] = width ? (a + 1) * width / 2 : a;
  output[offset + 1] = height ? (1 - b) * height / 2 : b;
  output[offset + 2] = (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) * inverse;
}

function wrapCoordinate(value, wrapping) {
  if (wrapping === THREE.RepeatWrapping) return value - Math.floor(value);
  if (wrapping === THREE.MirroredRepeatWrapping) {
    const whole = Math.floor(value), fraction = value - whole;
    return (Math.abs(whole) % 2) ? 1 - fraction : fraction;
  }
  return clamp01(value);
}

function textureIndex(index, length, wrapping) {
  if (wrapping === THREE.RepeatWrapping) return ((index % length) + length) % length;
  if (wrapping === THREE.MirroredRepeatWrapping) {
    const period = length * 2, value = ((index % period) + period) % period;
    return value < length ? value : period - 1 - value;
  }
  return Math.max(0, Math.min(length - 1, index));
}

function irradiance(lighting,shadow,nx,ny,nz,unlit=false){
  const ambient=unlit?[Math.PI,Math.PI,Math.PI]:lighting.ambient.slice(),key=[0,0,0];
  if(!unlit){
    for(const light of lighting.hemispheres){const mix=clamp01((nx*light.direction.x+ny*light.direction.y+nz*light.direction.z)*.5+.5);
      ambient[0]+=(light.sky.r*mix+light.ground.r*(1-mix))*light.intensity;
      ambient[1]+=(light.sky.g*mix+light.ground.g*(1-mix))*light.intensity;
      ambient[2]+=(light.sky.b*mix+light.ground.b*(1-mix))*light.intensity;
    }
    for(const light of lighting.directional){const amount=Math.max(0,nx*light.direction.x+ny*light.direction.y+nz*light.direction.z)*light.intensity,target=shadow&&light.object===shadow.light?key:ambient;
      target[0]+=light.color.r*amount;target[1]+=light.color.g*amount;target[2]+=light.color.b*amount;
    }
  }
  return[ambient,key];
}

function triangleSetup(vertices, a, b, c, width, height) {
  const ai = a * 3, bi = b * 3, ci = c * 3;
  const x0 = vertices[ai], y0 = vertices[ai + 1];
  const x1 = vertices[bi], y1 = vertices[bi + 1];
  const x2 = vertices[ci], y2 = vertices[ci + 1];
  const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  if (!Number.isFinite(area) || Math.abs(area) < 1e-8) return null;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)) - 1);
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)) - 1);
  if (maxX < minX || maxY < minY) return null;
  const inverse = 1 / area;
  return {
    ai, bi, ci, area, minX, maxX, minY, maxY,
    a0: (y1 - y2) * inverse, b0: (x2 - x1) * inverse,
    c0: (x1 * y2 - x2 * y1) * inverse,
    a1: (y2 - y0) * inverse, b1: (x0 - x2) * inverse,
    c1: (x2 * y0 - x0 * y2) * inverse,
  };
}

export class SoftwareRenderer {
  constructor({ canvas = document.createElement('canvas') } = {}) {
    this.domElement = canvas;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
    if (!this.context) throw new Error('A Canvas2D rendering context is required.');
    this.isSoftwareRenderer = true;
    this.shadowMap = { enabled: true, needsUpdate: true, type: THREE.PCFSoftShadowMap };
    this.outputColorSpace = THREE.SRGBColorSpace;
    this.toneMapping = THREE.ACESFilmicToneMapping;
    this.toneMappingExposure = 1;
    this.info = { render: { calls: 0, triangles: 0 }, memory: {} };
    this._imageCache = new WeakMap();
    this._plainTable = colorTable(THREE.NoToneMapping, 1);
    this._tableKey = '';
    this.setSize(1, 1);
  }

  setPixelRatio() {}
  setClearColor(color, alpha = 0) { this.clearAlpha = alpha; }
  getContext() { return { isContextLost: () => false }; }
  forceContextLoss() {}

  setSize(width, height) {
    width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
    if (this.width === width && this.height === height) return;
    this.width = width; this.height = height;
    this.domElement.width = width; this.domElement.height = height;
    this.imageData = this.context.createImageData(width, height);
    this.depth = new Float32Array(width * height);
  }

  _texture(texture) {
    if (!texture?.image) return null;
    const source = texture.image;
    let cached = this._imageCache.get(source);
    const width = source.width || source.naturalWidth, height = source.height || source.naturalHeight;
    if (!width || !height) return null;
    if (!cached || cached.width !== width || cached.height !== height || cached.version !== texture.version) {
      let data;
      if (source.data && source.data.length === width * height * 4) data = source.data;
      else {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(source, 0, 0, width, height);
        data = ctx.getImageData(0, 0, width, height).data;
      }
      cached = { data, width, height, version: texture.version };
      this._imageCache.set(source, cached);
    }
    if (texture.matrixAutoUpdate) texture.updateMatrix();
    return { ...cached, matrix: texture.matrix.elements.slice(), wrapS: texture.wrapS,
      wrapT: texture.wrapT, flipY: texture.flipY, srgb: texture.colorSpace === THREE.SRGBColorSpace,
      linear: texture.magFilter !== THREE.NearestFilter };
  }

  _lighting(scene) {
    const ambient = [0, 0, 0], hemispheres = [], directional = [];
    scene.traverseVisible((object) => {
      if (object.isAmbientLight) {
        ambient[0] += object.color.r * object.intensity;
        ambient[1] += object.color.g * object.intensity;
        ambient[2] += object.color.b * object.intensity;
      } else if (object.isHemisphereLight) {
        hemispheres.push({ direction: object.getWorldPosition(new THREE.Vector3()).normalize(),
          sky: object.color, ground: object.groundColor, intensity: object.intensity });
      } else if (object.isDirectionalLight) {
        const direction = object.getWorldPosition(new THREE.Vector3())
          .sub(object.target.getWorldPosition(new THREE.Vector3())).normalize();
        directional.push({ object, direction, color: object.color, intensity: object.intensity });
      }
    });
    return { ambient, hemispheres, directional };
  }

  _collect(scene, camera, shadow) {
    const triangles = [], materialCache = new Map();
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const local = new THREE.Matrix4(), worldMatrix = new THREE.Matrix4();
    const descriptor = (material) => {
      if (!materialCache.has(material)) materialCache.set(material, {
        material, texture: this._texture(material.map),
        color: material.color || new THREE.Color(1, 1, 1),
        opacity: material.opacity ?? 1,
        emissive: material.emissive ? [material.emissive.r, material.emissive.g, material.emissive.b]
          .map(value => value * (material.emissiveIntensity ?? 1)) : [0, 0, 0],
        unlit: Boolean(material.isMeshBasicMaterial),
        toneMapped: material.toneMapped !== false,
      });
      return materialCache.get(material);
    };
    scene.traverseVisible((mesh) => {
      if (!mesh.isMesh || !mesh.geometry || !camera.layers.test(mesh.layers)) return;
      const geometry = mesh.geometry, positions = geometry.attributes.position;
      if (!positions) return;
      const index = geometry.index, uv = geometry.attributes.uv;
      const normalAttribute=geometry.attributes.normal;
      const smoothNeeded=normalAttribute&&(Array.isArray(mesh.material)?mesh.material.some(material=>material&&!material.flatShading):!mesh.material.flatShading);
      const vertexColors = geometry.attributes.color;
      const uvTransforms = geometry.attributes.spriteUvTransform;
      const count = index ? index.count : positions.count;
      const drawStart = Math.max(0, geometry.drawRange.start || 0);
      const drawEnd = Math.min(count, drawStart + geometry.drawRange.count);
      const groups = Array.isArray(mesh.material)
        ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
      const instanceCount = mesh.isInstancedMesh ? mesh.count : 1;
      for (let instance = 0; instance < instanceCount; instance += 1) {
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(instance, local);
          worldMatrix.multiplyMatrices(mesh.matrixWorld, local);
        } else worldMatrix.copy(mesh.matrixWorld);
        const world = new Float32Array(positions.count * 3);
        const screen = new Float32Array(positions.count * 3);
        const light = shadow ? new Float32Array(positions.count * 3) : null;
        const normals=smoothNeeded?new Float32Array(positions.count*3):null;
        const normalMatrix=smoothNeeded?new THREE.Matrix3().getNormalMatrix(worldMatrix).elements:null;
        const matrix = worldMatrix.elements;
        for (let vertex = 0; vertex < positions.count; vertex += 1) {
          const offset = vertex * 3;
          transformPoint(matrix, positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex), world, offset);
          const x = world[offset], y = world[offset + 1], z = world[offset + 2];
          transformPoint(viewProjection.elements, x, y, z, screen, offset, this.width, this.height);
          if (shadow) transformPoint(shadow.matrix.elements, x, y, z, light, offset, shadow.size, shadow.size);
          if(normals){const nx=normalAttribute.getX(vertex),ny=normalAttribute.getY(vertex),nz=normalAttribute.getZ(vertex),m=normalMatrix;
            const a=m[0]*nx+m[3]*ny+m[6]*nz,b=m[1]*nx+m[4]*ny+m[7]*nz,c=m[2]*nx+m[5]*ny+m[8]*nz,length=Math.hypot(a,b,c)||1;
            normals[offset]=a/length;normals[offset+1]=b/length;normals[offset+2]=c/length;
          }
        }
        const color = mesh.instanceColor
          ? [mesh.instanceColor.getX(instance), mesh.instanceColor.getY(instance), mesh.instanceColor.getZ(instance)] : [1, 1, 1];
        const spriteUv = uvTransforms
          ? [uvTransforms.getX(instance), uvTransforms.getY(instance), uvTransforms.getZ(instance), uvTransforms.getW(instance)] : null;
        const batch = { world, screen, light, normals, uv, vertexColors, color, spriteUv,
          receiveShadow: mesh.receiveShadow, castShadow: mesh.castShadow };
        for (const group of groups) {
          const material = Array.isArray(mesh.material) ? mesh.material[group.materialIndex] : mesh.material;
          if (!material || material.visible === false || material.opacity === 0) continue;
          const desc = descriptor(material);
          const start = Math.max(drawStart, group.start), end = Math.min(drawEnd, group.start + group.count);
          for (let offset = start; offset + 2 < end; offset += 3) {
            const a = index ? index.getX(offset) : offset;
            const b = index ? index.getX(offset + 1) : offset + 1;
            const c = index ? index.getX(offset + 2) : offset + 2;
            triangles.push({ a, b, c, batch, desc });
          }
        }
      }
    });
    return triangles;
  }

  _shadowPass(triangles, shadow) {
    const size = shadow.size, depth = shadow.depth;
    depth.fill(Infinity);
    for (const tri of triangles) {
      if (!tri.batch.castShadow || tri.desc.opacity < 0.95) continue;
      const p = tri.batch.light, s = triangleSetup(p, tri.a, tri.b, tri.c, size, size);
      if (!s) continue;
      const z0 = p[s.ai + 2], z1 = p[s.bi + 2], z2 = p[s.ci + 2];
      for (let y = s.minY; y <= s.maxY; y += 1) {
        let w0 = s.a0 * (s.minX + 0.5) + s.b0 * (y + 0.5) + s.c0;
        let w1 = s.a1 * (s.minX + 0.5) + s.b1 * (y + 0.5) + s.c1;
        let at = y * size + s.minX;
        for (let x = s.minX; x <= s.maxX; x += 1, at += 1, w0 += s.a0, w1 += s.a1) {
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * z0 + w1 * z1 + w2 * z2;
          if (z >= -1 && z <= 1 && z < depth[at]) depth[at] = z;
        }
      }
    }
  }

  _drawTriangle(tri, lighting, shadow) {
    const { batch, desc, a, b, c } = tri, p = batch.screen;
    const s = triangleSetup(p, a, b, c, this.width, this.height);
    if (!s) return;
    const material = desc.material;
    // Screen Y points down, so a visible counterclockwise face has negative area.
    if ((material.side === THREE.FrontSide && s.area >= 0) ||
      (material.side === THREE.BackSide && s.area <= 0)) return;
    const world = batch.world, ai = s.ai, bi = s.bi, ci = s.ci;
    const abx = world[bi] - world[ai], aby = world[bi + 1] - world[ai + 1], abz = world[bi + 2] - world[ai + 2];
    const acx = world[ci] - world[ai], acy = world[ci + 1] - world[ai + 1], acz = world[ci + 2] - world[ai + 2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength < 1e-12) return;
    const normalScale = (s.area > 0 ? -1 : 1) / normalLength;
    nx *= normalScale; ny *= normalScale; nz *= normalScale;
    let[ambient,key]=irradiance(lighting,shadow,nx,ny,nz,desc.unlit);
    const vertexColor = [1, 1, 1];
    if (material.vertexColors && batch.vertexColors) {
      const vc = batch.vertexColors;
      vertexColor[0] = (vc.getX(a) + vc.getX(b) + vc.getX(c)) / 3;
      vertexColor[1] = (vc.getY(a) + vc.getY(b) + vc.getY(c)) / 3;
      vertexColor[2] = (vc.getZ(a) + vc.getZ(b) + vc.getZ(c)) / 3;
    }
    const base = [desc.color.r, desc.color.g, desc.color.b].map((value, channel) =>
      value * batch.color[channel] * vertexColor[channel] / Math.PI);
    ambient = ambient.map((value, channel) => value * base[channel]);
    key = key.map((value, channel) => value * base[channel]);
    let smoothAmbient=null,smoothKey=null;
    if(batch.normals&&!material.flatShading){
      smoothAmbient=[];smoothKey=[];const flip=s.area>0?-1:1;
      for(const vertex of[a,b,c]){const ni=vertex*3,n=batch.normals;const[amb,dir]=irradiance(lighting,shadow,n[ni]*flip,n[ni+1]*flip,n[ni+2]*flip,desc.unlit);
        const cv=material.vertexColors&&batch.vertexColors?[batch.vertexColors.getX(vertex),batch.vertexColors.getY(vertex),batch.vertexColors.getZ(vertex)]:[1,1,1];
        const vertexBase=[desc.color.r,desc.color.g,desc.color.b].map((v,channel)=>v*batch.color[channel]*cv[channel]/Math.PI);
        smoothAmbient.push(amb.map((v,channel)=>v*vertexBase[channel]));smoothKey.push(dir.map((v,channel)=>v*vertexBase[channel]));
      }
    }
    const texture = desc.texture, uv = batch.uv;
    let u0 = 0, v0 = 0, u1 = 0, v1 = 0, u2 = 0, v2 = 0;
    if (texture && uv) {
      const transformUv = (index) => {
        let u = uv.getX(index), v = uv.getY(index);
        if (material.userData.spriteRoofUv && batch.spriteUv) {
          u = u * batch.spriteUv[0] + batch.spriteUv[2];
          v = v * batch.spriteUv[1] + batch.spriteUv[3];
        }
        const m = texture.matrix;
        return [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]];
      };
      [u0, v0] = transformUv(a); [u1, v1] = transformUv(b); [u2, v2] = transformUv(c);
    }
    const lp = batch.light, receiveShadow = shadow && batch.receiveShadow && !desc.unlit;
    let dzdx = 0, dzdy = 0;
    if (receiveShadow) {
      const ls = triangleSetup(lp, a, b, c, shadow.size, shadow.size);
      if (ls) {
        dzdx = ls.a0 * (lp[ai + 2] - lp[ci + 2]) + ls.a1 * (lp[bi + 2] - lp[ci + 2]);
        dzdy = ls.b0 * (lp[ai + 2] - lp[ci + 2]) + ls.b1 * (lp[bi + 2] - lp[ci + 2]);
      }
    }
    const data = this.imageData.data, depth = this.depth;
    const table = desc.toneMapped ? this._toneTable : this._plainTable;
    const z0 = p[ai + 2], z1 = p[bi + 2], z2 = p[ci + 2];
    for (let y = s.minY; y <= s.maxY; y += 1) {
      let w0 = s.a0 * (s.minX + 0.5) + s.b0 * (y + 0.5) + s.c0;
      let w1 = s.a1 * (s.minX + 0.5) + s.b1 * (y + 0.5) + s.c1;
      let at = y * this.width + s.minX;
      for (let x = s.minX; x <= s.maxX; x += 1, at += 1, w0 += s.a0, w1 += s.a1) {
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        if (z < -1 || z > 1 || (material.depthTest !== false && z >= depth[at] - 1e-7)) continue;
        let tr = 1, tg = 1, tb = 1, alpha = desc.opacity;
        if (texture && uv) {
          const u = wrapCoordinate(w0 * u0 + w1 * u1 + w2 * u2, texture.wrapS);
          let v = wrapCoordinate(w0 * v0 + w1 * v1 + w2 * v2, texture.wrapT);
          if (texture.flipY) v = 1 - v;
          const texels = texture.data;
          if (texture.linear) {
            const fx = u * texture.width - 0.5, fy = v * texture.height - 0.5;
            const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy;
            const x0 = textureIndex(ix, texture.width, texture.wrapS), x1 = textureIndex(ix + 1, texture.width, texture.wrapS);
            const y0 = textureIndex(iy, texture.height, texture.wrapT), y1 = textureIndex(iy + 1, texture.height, texture.wrapT);
            const t00 = (y0 * texture.width + x0) * 4, t10 = (y0 * texture.width + x1) * 4;
            const t01 = (y1 * texture.width + x0) * 4, t11 = (y1 * texture.width + x1) * 4;
            const q00 = (1-dx)*(1-dy), q10 = dx*(1-dy), q01 = (1-dx)*dy, q11 = dx*dy;
            alpha *= (texels[t00+3]*q00+texels[t10+3]*q10+texels[t01+3]*q01+texels[t11+3]*q11) / 255;
            if (texture.srgb) {
              tr=SRGB_TO_LINEAR[texels[t00]]*q00+SRGB_TO_LINEAR[texels[t10]]*q10+SRGB_TO_LINEAR[texels[t01]]*q01+SRGB_TO_LINEAR[texels[t11]]*q11;
              tg=SRGB_TO_LINEAR[texels[t00+1]]*q00+SRGB_TO_LINEAR[texels[t10+1]]*q10+SRGB_TO_LINEAR[texels[t01+1]]*q01+SRGB_TO_LINEAR[texels[t11+1]]*q11;
              tb=SRGB_TO_LINEAR[texels[t00+2]]*q00+SRGB_TO_LINEAR[texels[t10+2]]*q10+SRGB_TO_LINEAR[texels[t01+2]]*q01+SRGB_TO_LINEAR[texels[t11+2]]*q11;
            } else {
              tr=(texels[t00]*q00+texels[t10]*q10+texels[t01]*q01+texels[t11]*q11)/255;
              tg=(texels[t00+1]*q00+texels[t10+1]*q10+texels[t01+1]*q01+texels[t11+1]*q11)/255;
              tb=(texels[t00+2]*q00+texels[t10+2]*q10+texels[t01+2]*q01+texels[t11+2]*q11)/255;
            }
          } else {
            const tx=Math.min(texture.width-1,Math.max(0,Math.floor(u*texture.width)));
            const ty=Math.min(texture.height-1,Math.max(0,Math.floor(v*texture.height)));
            const ti=(ty*texture.width+tx)*4;
            alpha*=texels[ti+3]/255;
            if(texture.srgb){tr=SRGB_TO_LINEAR[texels[ti]];tg=SRGB_TO_LINEAR[texels[ti+1]];tb=SRGB_TO_LINEAR[texels[ti+2]];}
            else{tr=texels[ti]/255;tg=texels[ti+1]/255;tb=texels[ti+2]/255;}
          }
          if (alpha <= Math.max(material.alphaTest || 0, 0.001)) continue;
        }
        let visibility = 1;
        if (receiveShadow) {
          const sx = w0 * lp[ai] + w1 * lp[bi] + w2 * lp[ci];
          const sy = w0 * lp[ai + 1] + w1 * lp[bi + 1] + w2 * lp[ci + 1];
          const sz = w0 * lp[ai + 2] + w1 * lp[bi + 2] + w2 * lp[ci + 2];
          const ix = Math.floor(sx) - 1, iy = Math.floor(sy) - 1;
          let blocked = 0;
          // A small tent-filtered 3x3 shadow softens eaves without a blurry halo.
          for (let oy = 0; oy < 3; oy += 1) for (let ox = 0; ox < 3; ox += 1) {
            const xx = ix + ox, yy = iy + oy;
            if (xx < 0 || yy < 0 || xx >= shadow.size || yy >= shadow.size) continue;
            const receiver = sz + dzdx * (xx + 0.5 - sx) + dzdy * (yy + 0.5 - sy);
            if (receiver - 0.00065 > shadow.depth[yy * shadow.size + xx]) blocked += (ox === 1 ? 2 : 1) * (oy === 1 ? 2 : 1);
          }
          visibility = 1 - blocked / 16;
        }
        let ar=ambient[0],ag=ambient[1],ab=ambient[2],kr=key[0],kg=key[1],kb=key[2];
        if(smoothAmbient){const a=smoothAmbient,k=smoothKey;ar=w0*a[0][0]+w1*a[1][0]+w2*a[2][0];ag=w0*a[0][1]+w1*a[1][1]+w2*a[2][1];ab=w0*a[0][2]+w1*a[1][2]+w2*a[2][2];kr=w0*k[0][0]+w1*k[1][0]+w2*k[2][0];kg=w0*k[0][1]+w1*k[1][1]+w2*k[2][1];kb=w0*k[0][2]+w1*k[1][2]+w2*k[2][2];}
        const red = table[Math.min(4095, Math.max(0, Math.round((tr * (ar + kr * visibility) + desc.emissive[0]) * 1024)))];
        const green = table[Math.min(4095, Math.max(0, Math.round((tg * (ag + kg * visibility) + desc.emissive[1]) * 1024)))];
        const blue = table[Math.min(4095, Math.max(0, Math.round((tb * (ab + kb * visibility) + desc.emissive[2]) * 1024)))];
        const offset = at * 4;
        if (alpha >= 0.999) {
          data[offset] = red; data[offset + 1] = green; data[offset + 2] = blue; data[offset + 3] = 255;
        } else {
          const oldAlpha = data[offset + 3] / 255, resultAlpha = alpha + oldAlpha * (1 - alpha);
          const remainder = oldAlpha * (1 - alpha);
          data[offset] = (red * alpha + data[offset] * remainder) / resultAlpha;
          data[offset + 1] = (green * alpha + data[offset + 1] * remainder) / resultAlpha;
          data[offset + 2] = (blue * alpha + data[offset + 2] * remainder) / resultAlpha;
          data[offset + 3] = resultAlpha * 255;
        }
        if (material.depthWrite !== false) depth[at] = z;
      }
    }
    this.info.render.calls += 1;
  }

  render(scene, camera) {
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    this.imageData.data.fill(0); this.depth.fill(Infinity);
    const key = `${this.toneMapping}:${this.toneMappingExposure}`;
    if (key !== this._tableKey) {
      this._toneTable = colorTable(this.toneMapping, this.toneMappingExposure);
      this._tableKey = key;
    }
    const lighting = this._lighting(scene);
    const caster = this.shadowMap.enabled ? lighting.directional.find((item) => item.object.castShadow) : null;
    let shadow = null;
    if (caster) {
      caster.object.shadow.updateMatrices(caster.object);
      const camera = caster.object.shadow.camera;
      const extent=Math.max(this.width,this.height),size=extent>=1000?1024:extent>=500?512:256;
      shadow = { light: caster.object, size, depth: new Float32Array(size * size),
        matrix: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse) };
    }
    const triangles = this._collect(scene, camera, shadow);
    this.info.render.calls = 0; this.info.render.triangles = triangles.length;
    if (shadow) this._shadowPass(triangles, shadow);
    const transparent = [];
    for (const triangle of triangles) {
      if (triangle.desc.material.transparent || triangle.desc.opacity < 0.999) transparent.push(triangle);
      else this._drawTriangle(triangle, lighting, shadow);
    }
    transparent.sort((a, b) => {
      const az = a.batch.screen[a.a * 3 + 2] + a.batch.screen[a.b * 3 + 2] + a.batch.screen[a.c * 3 + 2];
      const bz = b.batch.screen[b.a * 3 + 2] + b.batch.screen[b.b * 3 + 2] + b.batch.screen[b.c * 3 + 2];
      return bz - az;
    });
    for (const triangle of transparent) this._drawTriangle(triangle, lighting, shadow);
    this.context.putImageData(this.imageData, 0, 0);
  }

  dispose() {
    this.depth = null; this.imageData = null;
    this._imageCache = new WeakMap();
    this.domElement.width = this.domElement.height = 1;
  }
}
