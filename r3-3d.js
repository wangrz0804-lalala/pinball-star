/* ============================================================
   R3 —— 真 3D 渲染层（Three.js）
   ------------------------------------------------------------
   设计原则：**物理与玩法一行不动**，只把"画台面"换成 3D。
   弹珠台的真实物理本来就是平面 + 高度场（Space Cadet 同款），
   所以这里把逻辑坐标 (x, y) 与高度 h 映射到世界坐标即可：
       wx = (x - 240) * S
       wz = (y - 400) * S
       wy = h * S
   透视相机从近端上方俯视，得到真实的近大远小、投影、材质高光。
   2D 画布保留 HUD（背板/蓄力条/暂停），叠在 WebGL 之上。
   ============================================================ */
(function () {
  'use strict';

  const PS = window.__PS;
  if (!PS || typeof THREE === 'undefined') return null;

  const S = 1 / 100;                 // 逻辑像素 → 世界单位（480x800 → 4.8x8.0）
  const CX = 240, CY = 400;          // 逻辑坐标中心
  const wx = x => (x - CX) * S;
  const wz = y => (y - CY) * S;
  const wh = h => (h || 0) * S;

  let renderer = null, scene = null, camera = null, glCanvas = null;
  let glowTex = null;
  function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,.55)');
    grd.addColorStop(0.55, 'rgba(255,255,255,.16)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }
  // 在逻辑坐标处放一片始终朝向相机的加色光晕
  function addGlow(x, y, h, sizeW, color, opacity) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: new THREE.Color(color), transparent: true,
      opacity: opacity === undefined ? 0.8 : opacity,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    spr.position.set(wx(x), wh(h) + 0.02, wz(y));
    spr.scale.set(sizeW, sizeW, 1);
    scene.add(spr);
    return spr;
  }
  let ballMesh = null, ball2Mesh = null, rampMesh = null, deckGroup = null;
  const bumperGroups = [];       // {g, ring, base, pop}
  const flipperMeshes = [];      // {m, f}
  const lampMeshes = [];
  const tmpV = new THREE.Vector3();

  /* ---------------- 程序化材质贴图 ---------------- */

  // 台面：深空底色 + 细网格 + 中轴冷光，全部程序生成，不占包体
  function makePlayfieldTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 854;
    const g = c.getContext('2d');
    const bg = g.createRadialGradient(256, 300, 30, 256, 460, 620);
    bg.addColorStop(0, '#101a3a');
    bg.addColorStop(0.55, '#0a1028');
    bg.addColorStop(1, '#05070f');
    g.fillStyle = bg; g.fillRect(0, 0, 512, 854);

    // 冷光晕（上区偏青，下区偏暖）
    const n1 = g.createRadialGradient(150, 180, 0, 150, 180, 260);
    n1.addColorStop(0, 'rgba(70,120,255,.16)');
    n1.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = n1; g.fillRect(0, 0, 512, 854);
    const n2 = g.createRadialGradient(360, 640, 0, 360, 640, 300);
    n2.addColorStop(0, 'rgba(255,140,80,.10)');
    n2.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = n2; g.fillRect(0, 0, 512, 854);

    // 细网格（提供"表面"感，几乎没有性能成本）
    g.strokeStyle = 'rgba(120,170,255,.055)';
    g.lineWidth = 1;
    for (let x = 0; x <= 512; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 854); g.stroke(); }
    for (let y = 0; y <= 854; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  // 环境反射：一条竖向渐变当作"星空 + 顶灯"，让金属球有真实高光
  function makeEnvTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0.0, '#8fb8ff');
    grd.addColorStop(0.30, '#2a3a78');
    grd.addColorStop(0.55, '#101634');
    grd.addColorStop(0.80, '#2a1a3c');
    grd.addColorStop(1.0, '#05070f');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 64);
    // 两个亮点当作灯
    const l1 = g.createRadialGradient(38, 14, 0, 38, 14, 16);
    l1.addColorStop(0, 'rgba(255,255,255,.95)');
    l1.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = l1; g.fillRect(0, 0, 128, 64);
    const l2 = g.createRadialGradient(96, 22, 0, 96, 22, 12);
    l2.addColorStop(0, 'rgba(180,220,255,.8)');
    l2.addColorStop(1, 'rgba(180,220,255,0)');
    g.fillStyle = l2; g.fillRect(0, 0, 128, 64);

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  }

  /* ---------------- 台面底部轮廓 ---------------- */
  // 与游戏本体一致的机壳：左墙 24、顶部穹顶 R216@(240,264)、右墙 456、底部 782
  function buildFloorShape() {
    const sh = new THREE.Shape();
    const push = (x, y) => sh.lineTo(wx(x), -wz(y));
    sh.moveTo(wx(24), -wz(636));
    push(24, 264);
    const R = 216, cxx = 240, cyy = 264;
    for (let i = 0; i <= 48; i++) {
      const a = Math.PI + Math.PI * (i / 48);
      push(cxx + Math.cos(a) * R, cyy + Math.sin(a) * R);
    }
    push(456, 1020);   // 台面下方（排水区/机柜前沿）一并铺满，避免画面底部出现黑带
    push(24, 1020);
    sh.closePath();
    return sh;
  }

  /* ---------------- 建场景 ---------------- */

  function init(canvas) {
    glCanvas = canvas;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.toneMappingExposure = 0.92;

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(42, 480 / 940, 0.1, 60);
    camera.position.set(0, 9.4, 9.2);
    camera.lookAt(0, -0.15, 0.15);

    const env = makeEnvTexture();
    glowTex = makeGlowTexture();

    /* ---- 灯光 ---- */
    scene.add(new THREE.AmbientLight(0x1c2748, 0.8));

    const key = new THREE.DirectionalLight(0xd6e4ff, 1.05);
    key.position.set(2.2, 9.0, 4.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -4; sc.right = 4; sc.top = 5; sc.bottom = -5; sc.near = 0.5; sc.far = 20;
    key.shadow.bias = -0.0012;
    scene.add(key);

    const rimCyan = new THREE.PointLight(0x3fd8ff, 4.2, 7.5, 2);
    rimCyan.position.set(-1.9, 1.5, -1.2);
    scene.add(rimCyan);

    const rimMag = new THREE.PointLight(0xff5ecb, 2.8, 6.5, 2);
    rimMag.position.set(2.0, 1.3, 0.9);
    scene.add(rimMag);

    const warm = new THREE.PointLight(0xffa860, 1.6, 6, 2);
    warm.position.set(0.3, 1.0, 3.6);
    scene.add(warm);

    const topCyan = new THREE.PointLight(0x9fe8ff, 1.8, 6, 2);
    topCyan.position.set(0.2, 2.4, -2.2);
    scene.add(topCyan);

    /* ---- 台面 ---- */
    const floorShape = buildFloorShape();
    const floorGeo = new THREE.ExtrudeGeometry(floorShape, {
      depth: 0.26, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2
    });
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, -0.26, 0);
    const floorMat = new THREE.MeshStandardMaterial({
      map: makePlayfieldTexture(),
      color: 0x94a2c8,
      roughness: 0.6,
      metalness: 0.4
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    // ExtrudeGeometry 的 UV 需要映射到 0..1 才能贴图
    floorGeo.computeBoundingBox();
    const bb = floorGeo.boundingBox;
    const uv = floorGeo.attributes.uv;
    const pos = floorGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i);
      uv.setXY(i,
        (px - bb.min.x) / (bb.max.x - bb.min.x),
        1 - (pz - bb.min.z) / (bb.max.z - bb.min.z));
    }
    uv.needsUpdate = true;
    floor.receiveShadow = true;
    scene.add(floor);

    /* ---- 立体墙：与物理墙体一一对应 ---- */
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x141d3e, emissive: 0x3f7cff, emissiveIntensity: 0.85,
      roughness: 0.26, metalness: 0.8
    });
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const walls = PS.WALLS;
    const inst = new THREE.InstancedMesh(unitBox, wallMat, walls.length);
    inst.castShadow = true; inst.receiveShadow = true;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(),
          p3 = new THREE.Vector3(), s3 = new THREE.Vector3(), axisY = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      const dx = (w.bx - w.ax) * S, dz = (w.by - w.ay) * S;
      const len = Math.hypot(dx, dz) || 0.001;
      const th = Math.atan2(-dz, dx);
      q.setFromAxisAngle(axisY, th);
      p3.set(wx((w.ax + w.bx) / 2), 0.17, wz((w.ay + w.by) / 2));
      s3.set(len + 0.06, 0.34, Math.max(0.06, w.r * 2 * S));
      m4.compose(p3, q, s3);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);

    /* ---- 穹顶霓虹环（顶部弧线的发光带）---- */
    const domeCurve = new THREE.EllipseCurve(
      wx(240), -wz(264), 216 * S, 216 * S, Math.PI, Math.PI * 2, false
    );
    const domePts = domeCurve.getPoints(64).map(p => new THREE.Vector3(p.x, 0.34, -p.y));
    const domeGeo = new THREE.BufferGeometry().setFromPoints(domePts);
    const domeLine = new THREE.Line(domeGeo, new THREE.LineBasicMaterial({
      color: 0x6fd4ff, transparent: true, opacity: 0.9
    }));
    scene.add(domeLine);

    /* ---- 中央军衔环 ---- */
    const ringGeo = new THREE.TorusGeometry(PS.RING.rad * S, 0.022, 8, 64);
    ringGeo.rotateX(Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({
      color: 0x0d1838, emissive: 0x4fe0ff, emissiveIntensity: 1.5,
      roughness: 0.28, metalness: 0.6
    }));
    ring.position.set(wx(PS.RING.cx), 0.02, wz(PS.RING.cy));
    scene.add(ring);

    /* ---- 缓冲器：真 3D 圆柱 + 发光环 ---- */
    for (let i = 0; i < PS.BUMPERS.length; i++) {
      const b = PS.BUMPERS[i];
      const col = new THREE.Color(b.c);
      const g = new THREE.Group();
      g.position.set(wx(b.x), 0, wz(b.y));

      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(b.r * S * 0.92, b.r * S, 0.34, 24),
        new THREE.MeshStandardMaterial({
          color: 0x151d40, emissive: col.clone().multiplyScalar(0.5),
          emissiveIntensity: 1.0, roughness: 0.32, metalness: 0.8
        })
      );
      body.position.y = 0.17;
      body.castShadow = true;
      g.add(body);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(b.r * S * 0.62, b.r * S * 0.62, 0.06, 24),
        new THREE.MeshStandardMaterial({
          color: col, emissive: col, emissiveIntensity: 1.7, roughness: 0.22, metalness: 0.4
        })
      );
      cap.position.y = 0.37;
      g.add(cap);

      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(b.r * S, 0.026, 8, 32),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95 })
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.35;
      g.add(halo);

      scene.add(g);
      const gl2 = addGlow(b.x, b.y, 0.36, b.r * S * 5.0, b.c, 0.3);
      bumperGroups.push({ g: g, halo: halo, cap: cap, pop: 0, glow: gl2 });
    }

    /* ---- 挡板 ---- */
    [[PS.leftF], [PS.rightF]].forEach(function (pair) {
      const f = pair[0];
      const lenW = f.len * S;
      const geo = new THREE.BoxGeometry(lenW, 0.13, 0.24);
      geo.translate(lenW / 2, 0, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2c3a7a, emissive: 0xb46cff, emissiveIntensity: 0.8,
        roughness: 0.28, metalness: 0.75
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.position.set(wx(f.px), 0.1, wz(f.py));
      scene.add(m);
      flipperMeshes.push({ m: m, f: f });
    });

    /* ---- 支柱 / 碰撞柱 ---- */
    PS.POSTS.forEach(function (p) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(p.r * S, p.r * S * 1.1, 0.22, 16),
        new THREE.MeshStandardMaterial({
          color: 0x1a2650, emissive: 0x5a8cff, emissiveIntensity: 0.9,
          roughness: 0.28, metalness: 0.8
        })
      );
      post.position.set(wx(p.x), 0.11, wz(p.y));
      post.castShadow = true;
      scene.add(post);
    });

    /* ---- 虫洞 / 黑洞：立起来的发光环 ---- */
    (PS.WORMS || []).forEach(function (w) {
      const col = new THREE.Color(w.c || '#5ee7ff');
      const t = new THREE.Mesh(
        new THREE.TorusGeometry((w.r || 16) * S, 0.032, 8, 28),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 2.2, roughness: 0.3 })
      );
      t.rotation.x = Math.PI / 2;
      t.position.set(wx(w.x), 0.04, wz(w.y));
      scene.add(t);
      addGlow(w.x, w.y, 0.05, (w.r || 16) * S * 4.6, w.c || '#5ee7ff', 0.26);
    });
    if (PS.BLACKHOLE) {
      const bh = PS.BLACKHOLE;
      const t = new THREE.Mesh(
        new THREE.TorusGeometry(bh.r * S, 0.03, 8, 32),
        new THREE.MeshStandardMaterial({ color: 0x0a0a14, emissive: 0x6a4aff, emissiveIntensity: 1.6, roughness: 0.4 })
      );
      t.rotation.x = Math.PI / 2;
      t.position.set(wx(bh.x), 0.04, wz(bh.y));
      scene.add(t);
      addGlow(bh.x, bh.y, 0.05, bh.r * S * 4.8, 0x8a5cff, 0.3);
    }

    /* ---- 坡道：沿中心线抬升的真实立体滑槽 ---- */
    const ramp = PS.RAMP;
    if (ramp && ramp.path && ramp.path.length > 2) {
      const N = 72;
      const verts = [], idx = [];
      const halfAt = function (t) { return 22 - 14 * (t * t * (3 - 2 * t)); };
      const H = PS.DECK3D ? PS.DECK3D.z : 52;
      const pts = ramp.path;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const fi = t * (pts.length - 1);
        const i0 = Math.floor(fi), i1 = Math.min(pts.length - 1, i0 + 1);
        const f = fi - i0;
        const x = pts[i0].x + (pts[i1].x - pts[i0].x) * f;
        const y = pts[i0].y + (pts[i1].y - pts[i0].y) * f;
        // 切线求法向
        const x2 = pts[Math.min(pts.length - 1, i0 + 1)].x, y2 = pts[Math.min(pts.length - 1, i0 + 1)].y;
        const dx = x2 - x, dy = y2 - y;
        const L = Math.hypot(dx, dy) || 1;
        const nx = -dy / L, ny = dx / L;
        const hw = halfAt(t) * S;
        const h = (H * Math.pow(t, 1.35)) * S + 0.02;
        verts.push(wx(x) + nx * hw, h, wz(y) + ny * hw);
        verts.push(wx(x) - nx * hw, h, wz(y) - ny * hw);
        if (i < N) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      rg.setIndex(idx);
      rg.computeVertexNormals();
      const rmat = new THREE.MeshStandardMaterial({
        color: 0x17224c, emissive: 0x3f7cff, emissiveIntensity: 0.6,
        roughness: 0.24, metalness: 0.9, side: THREE.DoubleSide,
        transparent: true, opacity: 0.9
      });
      rampMesh = new THREE.Mesh(rg, rmat);
      rampMesh.castShadow = true;
      rampMesh.receiveShadow = true;
      scene.add(rampMesh);

      // 坡道两侧导轨
      const railMat = new THREE.MeshStandardMaterial({
        color: 0x5ee7ff, emissive: 0x5ee7ff, emissiveIntensity: 1.3, roughness: 0.3
      });
      [-1, 1].forEach(function (side) {
        const rp = [];
        for (let i = 0; i <= N; i += 2) {
          const t = i / N;
          const fi = t * (pts.length - 1);
          const i0 = Math.floor(fi), i1 = Math.min(pts.length - 1, i0 + 1);
          const f = fi - i0;
          const x = pts[i0].x + (pts[i1].x - pts[i0].x) * f;
          const y = pts[i0].y + (pts[i1].y - pts[i0].y) * f;
          const x2 = pts[Math.min(pts.length - 1, i0 + 1)].x, y2 = pts[Math.min(pts.length - 1, i0 + 1)].y;
          const dx = x2 - x, dy = y2 - y, L = Math.hypot(dx, dy) || 1;
          const nx = -dy / L, ny = dx / L;
          const hw = halfAt(t) * S;
          const h = (H * Math.pow(t, 1.35)) * S + 0.055;
          rp.push(new THREE.Vector3(wx(x) + nx * hw * side, h, wz(y) + ny * hw * side));
        }
        const rl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp),
          new THREE.LineBasicMaterial({ color: 0x7fe8ff, transparent: true, opacity: 0.95 }));
        scene.add(rl);
      });
    }

    /* ---- 二层平台 ---- */
    const D = PS.DECK2;
    if (D && D.poly) {
      deckGroup = new THREE.Group();
      const shp = new THREE.Shape();
      shp.moveTo(wx(D.poly[0].x), -wz(D.poly[0].y));
      for (let i = 1; i < D.poly.length; i++) shp.lineTo(wx(D.poly[i].x), -wz(D.poly[i].y));
      shp.closePath();
      const dg = new THREE.ExtrudeGeometry(shp, {
        depth: wh(D.z), bevelEnabled: false
      });
      dg.rotateX(-Math.PI / 2);
      const dm = new THREE.Mesh(dg, new THREE.MeshStandardMaterial({
        color: 0x121a3a, emissive: 0x3f7cff, emissiveIntensity: 0.45,
        roughness: 0.3, metalness: 0.85, transparent: true, opacity: 0.94
      }));
      dm.castShadow = true; dm.receiveShadow = true;
      deckGroup.add(dm);
      scene.add(deckGroup);
    }

    /* ---- 弹射器（SLINGS）：三角棱柱，物理里是最活跃的击打件 ---- */
    const slingMat = new THREE.MeshStandardMaterial({
      color: 0x2a2f6e, emissive: 0x9b6bff, emissiveIntensity: 0.9,
      roughness: 0.3, metalness: 0.7
    });
    PS.SLINGS.forEach(function (sl) {
      const shp = new THREE.Shape();
      const ax = wx(sl.x1), az = -wz(sl.y1);
      const bx2 = wx(sl.x2), bz2 = -wz(sl.y2);
      // 以两点为底边，向场地内侧展开成三角形
      const mx = (ax + bx2) / 2, mz = (az + bz2) / 2;
      const nx = (bz2 - az), nz = -(bx2 - ax);
      const nl = Math.hypot(nx, nz) || 1;
      const inx = mx + (nx / nl) * 0.30 * (sl.x1 < 240 ? 1 : -1);
      const inz = mz + (nz / nl) * 0.30 * (sl.x1 < 240 ? 1 : -1);
      shp.moveTo(ax, az); shp.lineTo(bx2, bz2); shp.lineTo(inx, inz); shp.closePath();
      const g2 = new THREE.ExtrudeGeometry(shp, { depth: 0.30, bevelEnabled: false });
      g2.rotateX(-Math.PI / 2);
      const m2 = new THREE.Mesh(g2, slingMat);
      m2.castShadow = true;
      scene.add(m2);
      addGlow((sl.x1 + sl.x2) / 2, (sl.y1 + sl.y2) / 2, 0.3, 0.85, 0xb98cff, 0.22);
    });

    /* ---- 任务灯（顶部弧内一排 4 盏）---- */
    for (let i = 0; i < 4; i++) {
      const lx = 240 + (i - 1.5) * 30;
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.075, 0.05, 16),
        new THREE.MeshStandardMaterial({
          color: 0x3a2a10, emissive: 0xffb84d, emissiveIntensity: 1.6, roughness: 0.4
        })
      );
      m.position.set(wx(lx), 0.03, wz(100));
      scene.add(m);
      addGlow(lx, 100, 0.05, 0.5, 0xffc35e, 0.28);
      lampMeshes.push(m);
    }

    /* ---- 顶部任务站（DOCK）---- */
    if (PS.DOCK_POSTS) {
      const dock = new THREE.Mesh(
        new THREE.CylinderGeometry(0.20, 0.22, 0.24, 24),
        new THREE.MeshStandardMaterial({
          color: 0x3a2f14, emissive: 0xffc35e, emissiveIntensity: 1.2,
          roughness: 0.32, metalness: 0.8
        })
      );
      dock.position.set(wx(240), 0.12, wz(132));
      dock.castShadow = true;
      scene.add(dock);
      addGlow(240, 132, 0.2, 1.5, 0xffc35e, 0.34);
    }

    /* ---- 任务靶点（弧上三个）---- */
    (PS.MISSION_TARGETS || []).forEach(function (t) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.06, 0.10, 12),
        new THREE.MeshStandardMaterial({
          color: 0x123050, emissive: 0x5ee7ff, emissiveIntensity: 1.4, roughness: 0.35
        })
      );
      m.position.set(wx(t.x), 0.06, wz(t.y));
      scene.add(m);
    });

    /* ---- 弹球 ---- */
    const ballGeo = new THREE.SphereGeometry(9 * S, 32, 24);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 1.0, roughness: 0.06,
      envMap: env, envMapIntensity: 2.6
    });
    ballMesh = new THREE.Mesh(ballGeo, ballMat);
    ballMesh.castShadow = true;
    ballMesh.visible = false;
    scene.add(ballMesh);

    ball2Mesh = new THREE.Mesh(ballGeo, ballMat);
    ball2Mesh.castShadow = true;
    ball2Mesh.visible = false;
    scene.add(ball2Mesh);

    resize(480, 940);
    return true;
  }

  function resize(cssW, cssH) {
    if (!renderer || !camera) return;
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    renderer.setSize(w, h, false);
    camera.aspect = 480 / 940;       // 逻辑画面比例固定；显示区按 480:940 渲染后由 CSS 缩放
    camera.updateProjectionMatrix();
  }

  /* ---------------- 每帧 ---------------- */
  function heightOf(b) {
    if (b.rampT !== undefined) return b.rampZ || 0;
    if (b.deck === 'upper') return (PS.DECK3D ? PS.DECK3D.z : 52) + 1;
    return 0;
  }

  function frame() {
    if (!renderer) return;
    const st = PS.state;
    const balls = PS.balls || [];

    // 弹球
    const meshes = [ballMesh, ball2Mesh];
    let visibleCount = 0;
    for (let i = 0; i < balls.length && visibleCount < 2; i++) {
      const b = balls[i];
      if (b.hidden) continue;
      const m = meshes[visibleCount++];
      m.visible = true;
      m.position.set(wx(b.x), wh(heightOf(b)) + 9 * S, wz(b.y));
    }
    for (let i = visibleCount; i < 2; i++) meshes[i].visible = false;

    // 挡板
    for (let i = 0; i < flipperMeshes.length; i++) {
      const fm = flipperMeshes[i];
      fm.m.rotation.y = -fm.f.angle;
    }

    // 缓冲器：击中时整体抬升 + 光环变亮
    for (let i = 0; i < bumperGroups.length; i++) {
      const bg = bumperGroups[i];
      const src = PS.BUMPERS[i];
      const pop = src ? Math.max(0, src.pop || 0) : 0;
      const target = pop * 0.09;
      bg.pop += (target - bg.pop) * 0.35;
      bg.g.scale.setScalar(1 + bg.pop * 1.6);
      bg.halo.material.opacity = 0.55 + Math.min(0.45, pop * 0.9);
      bg.cap.material.emissiveIntensity = 1.4 + Math.min(2.4, pop * 3);
      if (bg.glow) bg.glow.material.opacity = 0.26 + Math.min(0.34, pop * 0.6);
    }

    // 轻微相机呼吸：让"3D"可感知，但不影响操作（幅度极小）
    const t = (st && st.time) || 0;
    camera.position.x = Math.sin(t * 0.23) * 0.09;
    camera.position.y = 9.4 + Math.sin(t * 0.31) * 0.05;
    camera.lookAt(0, -0.15, 0.15);

    renderer.render(scene, camera);
    drawFx();
  }

  /* 粒子与飘分：物理坐标→投影→画在 2D 画布上（文字保持清晰，且跟着台面透视走） */
  let hudCtx = null;
  function drawFx() {
    if (!hudCtx) {
      const c2 = document.getElementById('c');
      if (!c2) return;
      hudCtx = c2.getContext('2d');
    }
    const g = hudCtx;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    g.save();
    g.setTransform(DPR, 0, 0, DPR, 0, 0);

    const parts = PS.parts || [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const sp = project(p.x, p.y, 8);
      if (!sp) continue;
      g.globalAlpha = Math.max(0, p.life) * 0.9;
      g.fillStyle = p.c;
      g.beginPath();
      g.arc(sp.x, sp.y, Math.max(0.8, p.r * p.life), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;

    const pops = PS.pops || [];
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 13px ui-monospace,Menlo,monospace';
    for (let i = 0; i < pops.length; i++) {
      const p = pops[i];
      const sp = project(p.x, p.y, 26);
      if (!sp) continue;
      g.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      g.fillStyle = p.c;
      g.fillText(p.text, sp.x, sp.y);
    }
    g.globalAlpha = 1;
    g.restore();
  }

  /* ---------------- 逻辑坐标 → 屏幕坐标（给飘字用） ---------------- */
  function project(x, y, h) {
    if (!camera) return null;
    tmpV.set(wx(x), wh(h || 0) + 0.05, wz(y));
    tmpV.project(camera);
    return {
      x: (tmpV.x * 0.5 + 0.5) * 480,
      y: (-tmpV.y * 0.5 + 0.5) * 940
    };
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    const gl = document.getElementById('gl');
    if (!gl) return;
    let ok = false;
    try { ok = !!init(gl); } catch (e) {
      console.log('R3 init failed: ' + (e && e.message));
      ok = false;
    }
    window.__R3 = ok ? {
      ready: true, frame: frame, resize: resize, project: project,
      renderer: renderer, scene: scene, camera: camera
    } : { ready: false };
    if (ok) console.log('R3 3D ready');
  }

  // 运行期错误显示到标题，无头截图时可直接读出
  window.addEventListener('error', function (e) {
    document.title = 'ERR ' + (e && e.message ? e.message : 'unknown');
  });

  function boot() {
    const gl = document.getElementById('gl');
    if (!gl) return;
    let ok = false;
    try { ok = !!init(gl); } catch (e) {
      console.log('R3 init failed: ' + (e && e.message));
      ok = false;
    }
    window.__R3 = ok ? {
      ready: true, frame: frame, resize: resize, project: project,
      renderer: renderer, scene: scene, camera: camera
    } : { ready: false };
    if (ok) console.log('R3 3D ready');
    if (ok) driveIfAsked();
  }

  // #auto3d：发球并让物理跑起来，用于无头验证 3D 下的实际对局
  function driveIfAsked() {
    if (location.hash !== '#auto3d') return;
    const st = PS.state;
    PS.restart('classic');
    st.paused = false;
    if (typeof PS.startCharge === 'function') PS.startCharge();
    st.charge = 1;
    if (typeof PS.releaseCharge === 'function') PS.releaseCharge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();