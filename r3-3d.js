/* ============================================================
   R3 —— 透视渲染层（对齐原版 Space Cadet 的机制）
   ------------------------------------------------------------
   读原版 SpaceCadetPinball 源码（render.cpp / proj.cpp）后的结论：
     原版**不是** 3D 网格渲染，而是
       ① 一张 2D 背景位图当台面
       ② 每个物件是独立精灵，带 z 深度图（zdrv）做遮挡
       ③ 球是预先缩放的位图，按深度排序合成
       ④ 全部经一个透视矩阵投影（proj::xform_to_2d，倾斜约 24°）
   所以"像原版"的唯一正解是：**别重画美术**。
   本文件的做法：
     · 用游戏自己的 2D 绘制函数，把每一层（台面/缓冲器/弹射器/挡板/坡道/二层）
       原样烘焙成贴图 —— 视觉 100% 等于 2D 版，一个像素都不改；
     · 各层作为面片放在不同高度，用透视相机投影 —— 由此得到真实的纵深与视差；
     · 球是真正的 3D 金属球（原版也是用缩放的球位图，这一步等价且更好）；
     · 关闭色调映射、台面用 MeshBasicMaterial —— 颜色不会被灯光改写。
   ============================================================ */
(function () {
  'use strict';

  const PS = window.__PS;
  if (!PS || typeof THREE === 'undefined') return null;

  const S = 1 / 100;                 // 逻辑像素 → 世界单位
  const CX = 240, CY = 400;
  const wx = x => (x - CX) * S;
  const wz = y => (y - CY) * S;
  const hz = h => (h || 0) * S;
  // 2D 版的"抬升 52px"是视觉位移，不是真实物理高度；压缩后既保纵深又不挡后方台面。
  // 球/二层/坡道共用同一系数，保证球始终贴在平台表面上。
  const HSCALE = 0.62;
  const hzS = h => (h || 0) * S * HSCALE;

  // 相机倾角：原版矩阵约 24°，但我们的美术是为"正俯视"画的，
  // 角度一大就会明显失真、和 2D 版拉开差距。取 14° 兼顾纵深感与原版观感。
  let TILT_DEG = 20;
  (function () {
    const m = /#.*tilt=(\d+(?:\.\d+)?)/.exec(location.hash);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= 0 && v <= 55) TILT_DEG = v;
    }
  })();
  const CAM_DIST = 19.6;
  const VIEW_SHIFT_Y = -72;     // 台面下移：2D 版台面从 y=140（HEAD）开始

  let renderer = null, scene = null, camera = null;
  let ballMesh = null, ball2Mesh = null;
  const ballShadows = [];
  let shadowTex = null, glowTex = null;
  const bumperPops = [];
  let flipCanvas = null, flipTex = null, flipCtx = null;
  const flipScale = 2;
  // 挡板占用区域（逻辑坐标）：两支挡板 + 转轴 + 一点点余量
  const FLIP_RECT = { x: 50, y: 620, w: 380, h: 170 };
  let ready = false;

  /* ---------------- 小工具 ---------------- */
  function makeTexFromCanvas(c) {
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    t.encoding = THREE.sRGBEncoding;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  }

  function makeShadowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,.52)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 96, 96);
    return new THREE.CanvasTexture(c);
  }

  function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.22, 'rgba(255,255,255,.5)');
    grd.addColorStop(0.55, 'rgba(255,255,255,.14)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  /* 由某层烘焙图生成一张模糊投影贴图。
     这是"看得出高度"的关键：抬高的元素在台面上有影子，眼睛立刻读出悬浮/抬升；
     比加侧壁更省事，也不会挡住台面美术。 */
  function makeShadowLayer(canvas, blurPx, alpha) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d');
    try {
      g.filter = 'blur(' + blurPx + 'px)';
      g.globalAlpha = alpha === undefined ? 0.62 : alpha;
      // 先把原图压成纯黑：用 source-in 只保留 alpha 形状
      g.drawImage(canvas, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
    } catch (e) {
      // 不支持 filter 的环境就退化成一圈淡暗影
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = (alpha === undefined ? 0.62 : alpha) * 0.5;
      g.drawImage(canvas, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
    }
    return c;
  }

  /* 把一层烘焙图做成一块面片（整张 480x800 → 世界 4.8x8） */
  function addLayer(canvas, z, order, opacity) {
    const tex = makeTexFromCanvas(canvas);
    const geo = new THREE.PlaneGeometry(4.8, 8, 1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: opacity === undefined ? 1 : opacity,
      side: THREE.DoubleSide
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, hz(z), 0);
    m.renderOrder = order;
    scene.add(m);
    return m;
  }

  /* ============================================================
     初始化
     ============================================================ */
  function init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x05070f, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.NoToneMapping;   // 美术原色，不做任何压缩

    scene = new THREE.Scene();

    const tilt = TILT_DEG * Math.PI / 180;
    camera = new THREE.PerspectiveCamera(27.6, 480 / 940, 0.1, 90);
    camera.position.set(0, CAM_DIST * Math.cos(tilt), CAM_DIST * Math.sin(tilt));
    camera.up.set(0, Math.cos(tilt), -Math.sin(tilt));
    camera.lookAt(0, 0, 0);
    // 台面贴齐 2D 版心：整体下移，背板区留给 2D HUD
    camera.setViewOffset(480, 940, 0, VIEW_SHIFT_Y, 480, 940);

    shadowTex = makeShadowTexture();
    glowTex = makeGlowTexture();

    /* ---------- ⓪ 台体侧壁：机台厚度 ----------
       这是"看得出是 3D"的关键：斜视时台面边缘出现真实的侧壁厚度与受光，
       而台面上所有美术仍在 z=0 原位，不会位移。 */
    (function () {
      const outline = [];
      outline.push([24, 636], [24, 264]);
      for (let i = 0; i <= 40; i++) {
        const a = Math.PI + Math.PI * (i / 40);
        outline.push([240 + Math.cos(a) * 216, 264 + Math.sin(a) * 216]);
      }
      outline.push([456, 800], [24, 800]);
      const shp = new THREE.Shape();
      shp.moveTo(wx(outline[0][0]), -wz(outline[0][1]));
      for (let i = 1; i < outline.length; i++) shp.lineTo(wx(outline[i][0]), -wz(outline[i][1]));
      shp.closePath();
      const DEPTH = 0.26;
      const g = new THREE.ExtrudeGeometry(shp, { depth: DEPTH, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      // 整体下移到台面平面**以下**：顶盖若与台面同高会 z-fighting（表现为横条纹）
      g.translate(0, -DEPTH - 0.012, 0);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: 0x101a38,
        emissive: 0x24448c,
        emissiveIntensity: 0.55,
        roughness: 0.42,
        metalness: 0.85
      }));
      m.renderOrder = 5;
      scene.add(m);

      // 台面外缘一圈发光线（霓虹机台边）
      const rimPts = outline.map(function (p) {
        return new THREE.Vector3(wx(p[0]), 0.002, wz(p[1]));
      });
      rimPts.push(rimPts[0].clone());
      scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(rimPts),
        new THREE.LineBasicMaterial({ color: 0x7fd0ff, transparent: true, opacity: 0.55 })
      ));
    })();

    /* ---------- ① 台面底层（原版 2D 全部静态层）---------- */
    // 烘焙分辨率：按物理像素 1:1（DPR×480）出图，避免透视重采样后发虚
    const BAKESCALE = Math.max(2, Math.min(4, Math.ceil((window.devicePixelRatio || 1))));
    try { addLayer(PS.bake('base', BAKESCALE), 0, 10); }
    catch (e) { console.log('base layer failed: ' + e.message); }

    /* ---------- ② 弹射器 / 缓冲器：各自一层 ---------- */
    // 弹射器/缓冲器与物理坐标严格对应：必须 z=0，否则会像挡板一样被透视挪位
    try { addLayer(PS.bake('slings', BAKESCALE), 0, 20); } catch (e) {}
    /* 缓冲器：真圆柱体，顶面用原版绘制裁出来的图案。
       —— 美术一点没重画，但有了真实的体积、侧面受光与投影。 */
    (function () {
      let bumpCv = null;
      try { bumpCv = PS.bake('bumpers', BAKESCALE); } catch (e) { bumpCv = null; }
      if (!bumpCv) return;
      const BODY_H = 0.115;             // 缓冲器露出一截的高度（世界单位）
      (PS.BUMPERS || []).forEach(function (b) {
        const col = new THREE.Color(b.c);
        const rW = (b.r + 2) * S;

        // 侧面：深色金属 + 本色自发光，斜看时有明暗过渡
        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(rW, rW * 1.06, BODY_H, 36, 1, true),
          new THREE.MeshStandardMaterial({
            color: 0x101a38,
            emissive: col.clone().multiplyScalar(0.45),
            emissiveIntensity: 0.9,
            roughness: 0.3,
            metalness: 0.92,
            side: THREE.DoubleSide
          })
        );
        body.position.set(wx(b.x), BODY_H / 2, wz(b.y));
        body.renderOrder = 38;
        scene.add(body);

        // 顶盖：从烘焙图裁出该缓冲器所在的正方形，1:1 贴到圆面上（不做任何缩放/偏移）
        const pad = b.r + 2;
        const sq = Math.round(pad * 2 * BAKESCALE);
        const capCv = document.createElement('canvas');
        capCv.width = capCv.height = sq;
        const cg = capCv.getContext('2d');
        cg.drawImage(bumpCv,
          Math.round((b.x - pad) * BAKESCALE), Math.round((b.y - pad) * BAKESCALE),
          sq, sq, 0, 0, sq, sq);
        const capTex = new THREE.CanvasTexture(capCv);
        capTex.encoding = THREE.sRGBEncoding;
        capTex.anisotropy = 8;
        const cap = new THREE.Mesh(
          new THREE.CircleGeometry(rW, 40),
          new THREE.MeshBasicMaterial({
            map: capTex, transparent: true, depthWrite: false
          })
        );
        cap.rotation.x = -Math.PI / 2;
        cap.position.set(wx(b.x), BODY_H, wz(b.y));
        cap.renderOrder = 39;
        scene.add(cap);

        // 顶盖外沿一圈霓虹，补上"发光边"的读法
        const halo = new THREE.Mesh(
          new THREE.TorusGeometry(rW * 0.99, 0.016, 8, 40),
          new THREE.MeshBasicMaterial({
            color: col, transparent: true, opacity: 0.85, depthWrite: false
          })
        );
        halo.rotation.x = Math.PI / 2;
        halo.position.set(wx(b.x), BODY_H + 0.004, wz(b.y));
        halo.renderOrder = 41;
        scene.add(halo);
      });
    })();

    /* ---------- ③ 挡板：每帧重绘（会转动）----------
       只烘焙"挡板所在的小矩形"，每帧纹理上传 ~0.5MB 而不是整屏 3.4MB。 */
    (function () {
      flipCanvas = document.createElement('canvas');
      flipCanvas.width = Math.round(FLIP_RECT.w * flipScale);
      flipCanvas.height = Math.round(FLIP_RECT.h * flipScale);
      flipCtx = flipCanvas.getContext('2d');
      flipTex = makeTexFromCanvas(flipCanvas);
      const geo = new THREE.PlaneGeometry(FLIP_RECT.w * S, FLIP_RECT.h * S, 1, 1);
      const mat = new THREE.MeshBasicMaterial({
        map: flipTex, transparent: true, depthWrite: false, side: THREE.DoubleSide
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      // 挡板会与球发生碰撞，位置必须与物理完全一致 → z=0
      m.position.set(wx(FLIP_RECT.x + FLIP_RECT.w / 2), 0, wz(FLIP_RECT.y + FLIP_RECT.h / 2));
      m.renderOrder = 30;
      scene.add(m);
    })();

    /* ---------- ④ 坡道：按高度切片，做出真实的抬升 ---------- */
    (function () {
      let cvR = null;
      try { cvR = PS.bake('ramp', BAKESCALE); } catch (e) { cvR = null; }
      if (!cvR) return;
      const N = 30;
      const H = (PS.DECK3D ? PS.DECK3D.z : 52);
      const tex = makeTexFromCanvas(cvR);
      // 坡道整体投影：贴着台面铺一层，让"桥"读作架空的
      try {
        const rsh = makeShadowLayer(cvR, BAKESCALE * 4, 0.5);
        const rshLayer = addLayer(rsh, 0, 33);
        rshLayer.position.set(0.04, 0.002, 0.06);
      } catch (e) {}
      const sh = 1 / N;
      for (let i = 0; i < N; i++) {
        const t0 = i / N, t1 = (i + 1) / N;
        const tc = (t0 + t1) / 2;
        const geo = new THREE.PlaneGeometry(4.8, 8 * sh, 1, 1);
        const uv = geo.attributes.uv;
        for (let k = 0; k < uv.count; k++) {
          const v = uv.getY(k);
          uv.setY(k, 1 - t1 + v * sh);
        }
        uv.needsUpdate = true;
        const mat = new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide
        });
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        const yc = 800 * tc;                       // 该带的逻辑 y（0=顶部）
        const hh = H * Math.pow(tc, 1.35);         // 越靠顶部抬得越高
        m.position.set(0, hzS(hh + 2), wz(yc));
        m.renderOrder = 35;
        scene.add(m);
      }
    })();

    /* ---------- ⑤ 二层：阴影层 + 平台层 ---------- */
    try { addLayer(PS.bake('deckUnder', BAKESCALE), 0, 15); } catch (e) {}
    // 二层是真正有高度的平台（物理里球会走上去），保持抬升
    try {
      const deckCanvas = PS.bake('deck', BAKESCALE);
      const deckH = hzS(PS.DECK3D ? PS.DECK3D.z : 52);
      // 投影：偏移一点、贴在台面上，二层立刻读作"悬空平台"
      const shCv = makeShadowLayer(deckCanvas, BAKESCALE * 5, 0.66);
      const shLayer = addLayer(shCv, 0, 48);
      shLayer.position.set(0.055, 0.004, 0.075);
      const deckLayer = addLayer(deckCanvas, 0, 50);
      deckLayer.position.y = deckH;
    } catch (e) {}

    /* ---------- ⑥ 蓄力条 ---------- */
    try { addLayer(PS.bake('plunger', BAKESCALE), 0, 25); } catch (e) {}

    /* ---------- ⑦ 球：真 3D 金属球 ---------- */
    const ballGeo = new THREE.SphereGeometry(9 * S, 36, 26);
    // 关键：透明贴图层都在透明渲染队列，不透明球会先画、然后被贴图盖住。
    // 让球也进透明队列，并用 renderOrder 排到最上面。
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 1.0, roughness: 0.07,
      envMapIntensity: 2.4, emissive: 0x0a1020,
      transparent: true, opacity: 1
    });
    ballMesh = new THREE.Mesh(ballGeo, ballMat);
    ballMesh.visible = false;
    ballMesh.renderOrder = 70;
    scene.add(ballMesh);
    ball2Mesh = new THREE.Mesh(ballGeo, ballMat.clone());
    ball2Mesh.visible = false;
    ball2Mesh.renderOrder = 70;
    scene.add(ball2Mesh);

    // 只照球的三盏点光（台面用 Basic 材质，完全不受影响）
    const l1 = new THREE.PointLight(0xcfe4ff, 2.2, 12, 2); l1.position.set(-2.2, 3.4, -1.4);
    const l2 = new THREE.PointLight(0xff8fd0, 1.1, 10, 2); l2.position.set(2.6, 2.2, 1.6);
    const l3 = new THREE.PointLight(0xffffff, 1.5, 12, 2); l3.position.set(0.6, 4.6, 2.6);
    scene.add(l1); scene.add(l2); scene.add(l3);

    // 球的投影贴片
    [0, 1].forEach(function () {
      const sp = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: shadowTex, transparent: true, opacity: 0.5,
          depthWrite: false, color: 0x000000
        })
      );
      sp.rotation.x = -Math.PI / 2;
      sp.visible = false;
      sp.scale.set(0.42, 0.42, 1);
      sp.renderOrder = 60;
      scene.add(sp);
      ballShadows.push(sp);
    });

    /* ---------- ⑧ 缓冲器光晕 ---------- */
    (PS.BUMPERS || []).forEach(function (b) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: new THREE.Color(b.c), transparent: true,
        opacity: 0.40, blending: THREE.AdditiveBlending, depthWrite: false
      }));
      sp.position.set(wx(b.x), hz(24), wz(b.y));
      sp.scale.set(b.r * S * 6.4, b.r * S * 6.4, 1);
      sp.renderOrder = 55;
      scene.add(sp);
      bumperPops.push({ sprite: sp, src: b });
    });

    // 必须显式设置渲染缓冲区尺寸：不设的话 WebGL 停在默认 300x150，
    // 被 CSS 拉伸到全屏 → 整张台面糊成一片（"像素都降低了"的直接原因）。
    resize(canvas.clientWidth || 480, canvas.clientHeight || 940);

    ready = true;
    return true;
  }

  function resize(cssW, cssH) {
    if (!renderer) return;
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    renderer.setSize(w, h, false);
  }

  /* ============================================================
     每帧
     ============================================================ */
  function heightOf(b) {
    if (b.rampT !== undefined) return b.rampZ || 0;
    if (b.deck === 'upper') return (PS.DECK3D ? PS.DECK3D.z : 52) + 1;
    return 0;
  }
  // 物理高度 → 世界高度（统一压缩，保证球贴在平台上）
  const worldH = h => hzS(h);

  function redrawFlippers() {
    if (!flipCtx || !PS.drawInto) return false;
    const g = flipCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, flipCanvas.width, flipCanvas.height);
    // 平移到该子区域，使全局坐标绘制正确落在小画布上
    g.setTransform(flipScale, 0, 0, flipScale, -FLIP_RECT.x * flipScale, -FLIP_RECT.y * flipScale);
    PS.drawInto(g, 'flip');
    flipTex.needsUpdate = true;
    return true;
  }

  function frame() {
    if (!ready) return;

    const balls = PS.balls || [];
    const meshes = [ballMesh, ball2Mesh];
    const visible = [];
    for (let i = 0; i < balls.length && visible.length < 2; i++) {
      if (!balls[i].hidden) visible.push(balls[i]);
    }
    for (let i = 0; i < 2; i++) {
      const m = meshes[i], b = visible[i];
      if (!b) { m.visible = false; ballShadows[i].visible = false; continue; }
      const h = heightOf(b);
      m.visible = true;
      m.position.set(wx(b.x), worldH(h) + 9 * S, wz(b.y));
    }

    for (let i = 0; i < 2; i++) {
      const shm = ballShadows[i], b = visible[i];
      if (!b) { shm.visible = false; continue; }
      const h = heightOf(b);
      const lift = Math.min(1, h / 60);
      shm.visible = true;
      shm.position.set(wx(b.x) - 0.03, worldH(h) + 0.008, wz(b.y) + 0.05);
      shm.material.opacity = 0.5 * (1 - lift * 0.4);
      const k = 0.40 + lift * 0.22;
      shm.scale.set(k, k, 1);
    }

    redrawFlippers();

    for (let i = 0; i < bumperPops.length; i++) {
      const bp = bumperPops[i];
      const pop = Math.max(0, (bp.src && bp.src.pop) || 0);
      bp.sprite.material.opacity = 0.32 + Math.min(0.46, pop * 0.8);
      const sc2 = 1 + Math.min(0.34, pop * 0.5);
      bp.sprite.scale.set(bp.src.r * S * 6.4 * sc2, bp.src.r * S * 6.4 * sc2, 1);
    }

    renderer.render(scene, camera);
    drawFx();
  }

  /* 粒子与飘分：投影到 2D 画布，文字保持清晰 */
  let hudCtx = null;
  function drawFx() {
    if (!hudCtx) {
      const c2 = document.getElementById('c');
      if (!c2) return;
      hudCtx = c2.getContext('2d');
    }
    const g = hudCtx;
    const DPRv = Math.min(window.devicePixelRatio || 1, 2);
    g.save();
    g.setTransform(DPRv, 0, 0, DPRv, 0, 0);

    const parts = PS.parts || [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const sp = project(p.x, p.y, 10);
      if (!sp) continue;
      g.globalAlpha = Math.max(0, p.life);
      g.fillStyle = p.c;
      g.beginPath();
      g.arc(sp.x, sp.y, Math.max(0.7, p.r * p.life), 0, 6.2832);
      g.fill();
    }
    g.globalAlpha = 1;

    const pops = PS.pops || [];
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 13px ui-monospace,Menlo,monospace';
    for (let i = 0; i < pops.length; i++) {
      const p = pops[i];
      const sp = project(p.x, p.y, 30);
      if (!sp) continue;
      g.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      g.fillStyle = p.c;
      g.fillText(p.text, sp.x, sp.y);
    }
    g.globalAlpha = 1;
    g.restore();
  }

  /* 逻辑坐标 → 画布坐标（与相机严格一致） */
  const tmpV = new THREE.Vector3();
  function project(x, y, h) {
    if (!camera) return null;
    tmpV.set(wx(x), hz(h || 0), wz(y));
    tmpV.project(camera);
    return {
      x: (tmpV.x * 0.5 + 0.5) * 480,
      y: (-tmpV.y * 0.5 + 0.5) * 800
    };
  }

  /* ============================================================
     启动
     ============================================================ */
  window.addEventListener('error', function (e) {
    document.title = 'ERR ' + (e && e.message ? e.message : 'unknown');
  });

  function boot() {
    const gl = document.getElementById('gl');
    if (!gl) return;
    let ok = false;
    try { ok = !!init(gl); } catch (e) {
      console.log('R3 init failed: ' + (e && e.message) + ' | ' + (e && e.stack));
      ok = false;
    }
    window.__R3 = ok
      ? { ready: true, frame: frame, resize: resize, project: project,
          renderer: renderer, scene: scene, camera: camera }
      : { ready: false };
    if (ok) console.log('R3 ready (layered perspective, art untouched)');
    if (ok) driveIfAsked();
  }

  // #diag：把渲染尺寸打到标题上，供无头检查（清晰度问题的直接证据）
  if (location.hash.indexOf('#diag') >= 0) {
    setTimeout(function () {
      try {
        const gl = document.getElementById('gl');
        document.title = 'DIAG ' + JSON.stringify({
          css: gl.clientWidth + 'x' + gl.clientHeight,
          buf: gl.width + 'x' + gl.height,
          pr: window.devicePixelRatio
        });
      } catch (e) { document.title = 'DIAGERR ' + e.message; }
    }, 2500);
  }

  function driveIfAsked() {
    if (location.hash !== '#auto3d') return;
    const st = PS.state;
    PS.restart('classic');
    st.paused = false;
    if (PS.startCharge) PS.startCharge();
    st.charge = 1;
    if (PS.releaseCharge) PS.releaseCharge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();