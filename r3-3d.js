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

  // 相机倾角：原版矩阵约 24°，但我们的美术是为"正俯视"画的，
  // 角度一大就会明显失真、和 2D 版拉开差距。取 14° 兼顾纵深感与原版观感。
  let TILT_DEG = 14;
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

    /* ---------- ① 台面底层（原版 2D 全部静态层）---------- */
    try { addLayer(PS.bake('base', 2), 0, 10); }
    catch (e) { console.log('base layer failed: ' + e.message); }

    /* ---------- ② 弹射器 / 缓冲器：各自一层 ---------- */
    try { addLayer(PS.bake('slings', 1.5), 10, 20); } catch (e) {}
    try { addLayer(PS.bake('bumpers', 1.5), 22, 40); } catch (e) {}

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
      m.position.set(wx(FLIP_RECT.x + FLIP_RECT.w / 2), hz(7), wz(FLIP_RECT.y + FLIP_RECT.h / 2));
      m.renderOrder = 30;
      scene.add(m);
    })();

    /* ---------- ④ 坡道：按高度切片，做出真实的抬升 ---------- */
    (function () {
      let cvR = null;
      try { cvR = PS.bake('ramp', 1.5); } catch (e) { cvR = null; }
      if (!cvR) return;
      const N = 30;
      const H = (PS.DECK3D ? PS.DECK3D.z : 52);
      const tex = makeTexFromCanvas(cvR);
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
        m.position.set(0, hz(hh + 2), wz(yc));
        m.renderOrder = 35;
        scene.add(m);
      }
    })();

    /* ---------- ⑤ 二层：阴影层 + 平台层 ---------- */
    try { addLayer(PS.bake('deckUnder', 1.5), 1, 15); } catch (e) {}
    try { addLayer(PS.bake('deck', 1.5), (PS.DECK3D ? PS.DECK3D.z : 52), 50); } catch (e) {}

    /* ---------- ⑥ 蓄力条 ---------- */
    try { addLayer(PS.bake('plunger', 1.5), 0, 25); } catch (e) {}

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

  function redrawFlippers() {
    if (!flipCtx || !PS.drawFlippers) return false;
    const g = flipCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, flipCanvas.width, flipCanvas.height);
    // 平移到该子区域，使全局坐标绘制正确落在小画布上
    g.setTransform(flipScale, 0, 0, flipScale, -FLIP_RECT.x * flipScale, -FLIP_RECT.y * flipScale);
    try { PS.drawFlippers(g); } catch (e) { return false; }
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
      m.position.set(wx(b.x), hz(h) + 9 * S, wz(b.y));
    }

    for (let i = 0; i < 2; i++) {
      const shm = ballShadows[i], b = visible[i];
      if (!b) { shm.visible = false; continue; }
      const h = heightOf(b);
      const lift = Math.min(1, h / 60);
      shm.visible = true;
      shm.position.set(wx(b.x) - 0.03, hz(h) + 0.008, wz(b.y) + 0.05);
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