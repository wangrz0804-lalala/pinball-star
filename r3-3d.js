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
  const HSCALE = 0.50;
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
  const flipperMeshes = [];      // {g, f, glow, body, core, ring}
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

    /* ---------- ⓪ 实体侧墙 ----------
       2D 版墙体 = 深色厚墙（22px 暗底 + 16px 蓝调） + 顶部 2px 霓虹棱线。
       这里照这个结构做实体：墙身是深色金属（不发光，否则就成白带），
       只有顶棱是一条细亮线 —— 这正是 3D 感与保真度的平衡点。 */
    (function () {
      const walls = PS.WALLS || [];
      if (!walls.length) return;
      const WALL_H = 0.052;              // 墙高：低矮橡胶挡条，不是高墙
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x161f46,                 // 对应 2D 的 #1c2650 系深色
        emissive: 0x1b2f66,
        emissiveIntensity: 0.20,         // 极弱：只给一点存在感，绝不抢台面
        roughness: 0.34,
        metalness: 0.88
      });
      const box = new THREE.BoxGeometry(1, 1, 1);
      const inst = new THREE.InstancedMesh(box, bodyMat, walls.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(),
            p3 = new THREE.Vector3(), s3 = new THREE.Vector3(),
            axisY = new THREE.Vector3(0, 1, 0);
      // 顶棱：2D 里是一条 2px 霓虹线。3D 里 1px 的 Line 没有宽度、几乎看不见，
      // 所以做成"细长条"实体（有宽度，能受光并投出高光），这才是 2D 那条棱线的对应物。
      const rimMat = new THREE.MeshBasicMaterial({
        color: 0x8cc0ff, transparent: true, opacity: 0.9
      });
      const rimInst = new THREE.InstancedMesh(box, rimMat, walls.length);
      const rimPts = [];
      for (let i = 0; i < walls.length; i++) {
        const w = walls[i];
        const dx = (w.bx - w.ax) * S, dz = (w.by - w.ay) * S;
        const len = Math.hypot(dx, dz) || 0.001;
        q.setFromAxisAngle(axisY, Math.atan2(-dz, dx));
        const wId = Math.max(0.055, w.r * 2 * S * 0.92);
        p3.set(wx((w.ax + w.bx) / 2), WALL_H / 2, wz((w.ay + w.by) / 2));
        s3.set(len + wId * 0.5, WALL_H, wId);
        m4.compose(p3, q, s3);
        inst.setMatrixAt(i, m4);
        // 顶棱细条：压在墙顶正中，宽 0.010、高 0.005
        const rp = new THREE.Vector3(wx((w.ax + w.bx) / 2), WALL_H + 0.0015, wz((w.ay + w.by) / 2));
        const rs = new THREE.Vector3(len + wId * 0.5, 0.005, 0.010);
        m4.compose(rp, q, rs);
        rimInst.setMatrixAt(i, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.renderOrder = 8;
      scene.add(inst);

      rimInst.instanceMatrix.needsUpdate = true;
      rimInst.renderOrder = 9;
      scene.add(rimInst);
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

    /* ---------- ③ 挡板：实体几何，绕转轴真实旋转 ----------
       严格照 2D 的视觉语言做分层：
         · 2D 是 shadowBlur 外发光 + 17px 亮描边 + 11px 深色棒 + 3.5px 亮内芯 + 转轴圆
         · 3D 就做  外辉光柱 + 深色棒体（带本色自发光）+ 顶部亮内芯 + 转轴柱与环
       按下时整体由蓝转品红（对应 2D 的 #84bcff → #ff9ee8）。 */
    flipperMeshes.length = 0;
    [PS.leftF, PS.rightF].forEach(function (f) {
      if (!f) return;
      const lenW = f.len * S;
      const g = new THREE.Group();
      g.position.set(wx(f.px), 0, wz(f.py));

      /* 2D 的霓虹描边是"沿棒外形的一圈亮线"。3D 里用两根细棱条实现：
         俯视时正好落在棒的上下两侧，读作描边；同时棒体保持深色不被染白。
         （之前用加色辉光柱会把整根棒冲淡，丢掉 2D 的深色棒对比。） */
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0x6fb8ff, transparent: true, opacity: 1
      });
      const glowGroup = new THREE.Group();
      // 棱条必须落在棒体**表面**上：棒半径 0.052、中心 y=0.055，
      // 在 z=±0.040 处表面高度约 0.088，棱条就压在这条线上。
      [-1, 1].forEach(function (sd) {
        const eg = new THREE.BoxGeometry(lenW * 0.99, 0.011, 0.011);
        eg.translate(lenW / 2, 0, 0);
        const e = new THREE.Mesh(eg, glowMat);
        e.position.set(0, 0.092, sd * 0.040);
        e.renderOrder = 29;
        glowGroup.add(e);
      });
      g.add(glowGroup);

      // 柔和外晕：大范围、极低不透明度，只在棒周围形成一层光雾。
      // 作用是加强"深色棒 vs 亮背景"的对比（2D 的 shadowBlur 就是这个观感）。
      const hazeGeo = new THREE.CylinderGeometry(0.145, 0.145, lenW * 1.02, 16, 1, true);
      hazeGeo.rotateZ(Math.PI / 2);
      hazeGeo.translate(lenW / 2, 0, 0);
      const hazeMat = new THREE.MeshBasicMaterial({
        color: 0x2f6fd8, transparent: true, opacity: 0.13,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      const haze = new THREE.Mesh(hazeGeo, hazeMat);
      haze.position.y = 0.048;
      haze.renderOrder = 27;
      g.add(haze);

      // 棒体：深色金属（对应 2D 的 #0c1430、11px）
      const bodyGeo = new THREE.CylinderGeometry(0.052, 0.052, lenW, 18);
      bodyGeo.rotateZ(Math.PI / 2);
      bodyGeo.translate(lenW / 2, 0, 0);
      // 用 Basic 而非 Standard：2D 的棒体就是纯色 #0c1430，
      // 一旦交给 PBR 就会被点光照成灰白，丢掉那种"深色棒 + 霓虹描边"的对比。
      const bodyMat = new THREE.MeshBasicMaterial({ color: 0x0c1430 });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.053;
      body.renderOrder = 30;
      g.add(body);

      // 内芯亮线（对应 2D 的 3.5px #d8edff 细线，压在棒顶）
      const coreGeo = new THREE.CylinderGeometry(0.009, 0.009, lenW * 0.97, 10);
      coreGeo.rotateZ(Math.PI / 2);
      coreGeo.translate(lenW / 2, 0, 0);
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xd8edff, transparent: true, opacity: 0.92
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.position.y = 0.101;
      core.renderOrder = 31;
      g.add(core);

      // 转轴：深色柱 + 霓虹环（2D 的 8px 圆 + 2px 描边）
      const piv = new THREE.Mesh(
        new THREE.CylinderGeometry(0.072, 0.072, 0.098, 22),
        new THREE.MeshBasicMaterial({ color: 0x16204a })
      );
      piv.position.y = 0.056;
      piv.renderOrder = 30;
      g.add(piv);

      const ringGeo = new THREE.TorusGeometry(0.072, 0.0085, 8, 26);
      ringGeo.rotateX(Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x5a9cff, transparent: true, opacity: 0.9
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 0.100;
      ring.renderOrder = 32;
      g.add(ring);

      scene.add(g);
      flipperMeshes.push({ g: g, f: f, glow: glowMat, body: bodyMat, core: coreMat, ring: ringMat, haze: hazeMat });
    });

    /* ---------- ④ 坡道：实体槽（槽底 + 侧壁 + 银轨 + 黄带）----------
       2D 坡道 = 半透明槽底 + 两侧立壁 + 三层描边钢轨 + 立柱/横档 + 黄色标识带。
       这里照同一套结构做实体：斜视时能看到真实的槽内壁与轨道高度，而不是一张贴纸。
       中心线与高度曲线直接复用物理（PS.rampPoint / PS.rampH），保证球贴在槽里。 */
    (function () {
      const ramp = PS.RAMP;
      if (!ramp || !PS.rampPoint) return;

      const N = 64;
      const DECK_H = (PS.DECK3D ? PS.DECK3D.z : 52);

      // 采样中心线（含法向、半宽、抬升）
      const F = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const p = PS.rampPoint(t);
        const p2 = PS.rampPoint(Math.min(1, t + 0.006));
        let dx = p2.x - p.x, dy = p2.y - p.y;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl; dy /= dl;
        F.push({
          t: t,
          x: p.x, y: p.y,
          nx: -dy, ny: dx,
          hw: PS.rampHalfW(t),
          h: PS.rampH(t)
        });
      }

      const vertToWorld = function (f, side, extraW, extraH) {
        const w = (f.hw + (extraW || 0)) * side;
        return new THREE.Vector3(
          wx(f.x + f.nx * w),
          hzS(f.h + (extraH || 0)),
          wz(f.y + f.ny * w)
        );
      };

      /* —— 槽底 —— */
      (function () {
        const verts = [], idx = [], uvs = [];
        for (let i = 0; i <= N; i++) {
          const f = F[i];
          const L = vertToWorld(f, -1, 0, 0);
          const R = vertToWorld(f, 1, 0, 0);
          verts.push(L.x, L.y, L.z, R.x, R.y, R.z);
          uvs.push(0, f.t, 1, f.t);
          if (i < N) {
            const a = i * 2;
            idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.setIndex(idx);
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
          color: 0x080e1e, transparent: true, opacity: 0.97,
          side: THREE.DoubleSide, depthWrite: false
        }));
        m.renderOrder = 34;
        scene.add(m);
      })();

      /* —— 两侧槽壁：从槽底向上立起（这是"槽"的核心）—— */
      [-1, 1].forEach(function (side) {
        const verts = [], idx = [];
        const WALL_H = 0.078;
        for (let i = 0; i <= N; i++) {
          const f = F[i];
          const b = vertToWorld(f, side, 0, 0);
          const tp = b.clone(); tp.y += WALL_H;
          verts.push(b.x, b.y, b.z, tp.x, tp.y, tp.z);
          if (i < N) {
            const a = i * 2;
            // 内侧面朝向槽内，双侧可见更稳
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
          color: 0x2c4384, transparent: true, opacity: 0.95,
          side: THREE.DoubleSide, depthWrite: false
        }));
        m.renderOrder = 35;
        scene.add(m);
      });

      /* —— 银轨：沿两侧槽壁顶端的细亮线（2D 的 3 层描边导轨）—— */
      [-1, 1].forEach(function (side) {
        const pts = [];
        for (let i = 0; i <= N; i += 2) {
          const p = vertToWorld(F[i], side, 0, 0);
          pts.push(new THREE.Vector3(p.x, p.y + 0.080, p.z));
        }
        scene.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0xc8dcff, transparent: true, opacity: 0.9 })
        ));
      });

      /* —— 黄色标识带：2D 在 t=0.22/0.30/0.40/0.50/0.60 处的 5 条横带 ——
         直接用"槽底局部切片"生成，天然横跨槽面并贴合曲率。
         （用旋转 Box 会因朝向轴算错而退化成沿槽细线 —— 踩过。） */
      const bandMat = new THREE.MeshBasicMaterial({
        color: 0xffce54, transparent: true, opacity: 0.95, side: THREE.DoubleSide
      });
      [0.22, 0.30, 0.40, 0.50, 0.60].forEach(function (tt) {
        const half = 0.018;                 // 沿槽方向半宽：合计约 3.6 逻辑 px
        const t0 = Math.max(0, tt - half), t1 = Math.min(1, tt + half);
        const verts = [], idx = [];
        let vi = 0;
        for (let k = 0; k <= 2; k++) {
          const t = t0 + (t1 - t0) * k / 2;
          const i2 = Math.round(t * N);
          const f = F[i2];
          if (!f) continue;
          const L = vertToWorld(f, -1, -3.0, 1.2);
          const R = vertToWorld(f, 1, -3.0, 1.2);
          verts.push(L.x, L.y, L.z, R.x, R.y, R.z);
          if (k < 2) { idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3); }
          vi += 2;
        }
        if (!idx.length) return;
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        bg.setIndex(idx);
        bg.computeVertexNormals();
        const band = new THREE.Mesh(bg, bandMat);
        band.renderOrder = 36;
        scene.add(band);
      });

      /* —— 架空感：整条坡道在台面上的投影 —— */
      try {
        const cvR2 = PS.bake('ramp', BAKESCALE);
        if (cvR2) {
          const rsh = makeShadowLayer(cvR2, BAKESCALE * 4, 0.5);
          const rshLayer = addLayer(rsh, 0, 33);
          rshLayer.position.set(0.04, 0.002, 0.06);
        }
      } catch (e) {}
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

    // 挡板：绕转轴真实旋转；按下时蓝→品红（对应 2D 的颜色切换）
    for (let i = 0; i < flipperMeshes.length; i++) {
      const fm = flipperMeshes[i];
      fm.g.rotation.y = -fm.f.angle;
      const pressed = !!fm.f.pressed;
      fm.glow.color.setHex(pressed ? 0xff7ee0 : 0x5a9cff);
      fm.glow.opacity = 1;
      if (fm.haze) {
        fm.haze.color.setHex(pressed ? 0xd8409c : 0x2f6fd8);
        fm.haze.opacity = pressed ? 0.20 : 0.13;
      }
      fm.core.color.setHex(pressed ? 0xffe6f9 : 0xd8edff);
      fm.ring.color.setHex(pressed ? 0xff5ecb : 0x5a9cff);
      fm.body.color.setHex(pressed ? 0x3a1030 : 0x0c1430);
    }

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
    // #ride：把球摆到坡道上，验证球与槽底的贴合（高度/宽度是否正确）
    if (location.hash.indexOf('#ride') >= 0) {
      const m = /ride=(\d+)/.exec(location.hash);
      const t = m ? Math.min(1, Math.max(0, parseInt(m[1], 10) / 100)) : 0.45;
      PS.restart('classic');
      PS.state.paused = false;
      PS.state.mode = 'play';
      const b = PS.balls && PS.balls[0];
      if (b && PS.rampPoint) {
        const p = PS.rampPoint(t);
        b.x = p.x; b.y = p.y;
        b.rampT = t; b.rampZ = PS.rampH(t);
        b.vx = 0; b.vy = 0; b.hidden = false;
      }
      return;
    }
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