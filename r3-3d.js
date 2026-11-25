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
  /* 纵向补偿（保真的核心）：
    我们的台面贴图是**正交**画的（480x800 像素图），而 24° 斜视会把纵深压缩 cos24°=0.913，
    直接贴上去就会变成"上窄下宽 + 纵向压扁"。把世界 Z 预拉伸 1/cos24°，
     在斜视投影下正好还原成 4.8:8 —— 贴图比例、位置全部与原版 2D 一致。
     而立体物件（圆柱/侧墙）的高度仍按真实压缩，斜视感由它们和投影提供。 */
  let WZ_K = 1;
  const wz = y => (y - CY) * S * WZ_K;
  const hz = h => (h || 0) * S;
  // 2D 版的"抬升 52px"是视觉位移，不是真实物理高度；压缩后既保纵深又不挡后方台面。
  // 球/二层/坡道共用同一系数，保证球始终贴在平台表面上。
  const HSCALE = 0.50;
  const hzS = h => (h || 0) * S * HSCALE;
  /* 坡道与二层**必须用同一个高度系数**：
     rampH(1) === DECK3D.z，坡道末端本来就该正好落在二层顶面。
     之前给坡道单独压到 0.30、二层用 0.50，两者在交付口差了一截 —— 视觉上就是"坡道和二层分体"。
     统一后坡道末端与二层顶面严丝合缝，读作一个整体。 */
  const RAMP_HSCALE = HSCALE;
  const hzR = h => (h || 0) * S * RAMP_HSCALE;

  // 相机倾角：原版矩阵约 24°，但我们的美术是为"正俯视"画的，
  // 角度一大就会明显失真、和 2D 版拉开差距。取 14° 兼顾纵深感与原版观感。
  // 原版 Space Cadet 的投影矩阵（proj.cpp 常量）反算：
//   cosθ=0.913545, sinθ=0.406737 → θ = 24.000°
// 这就是原版的观察倾角，默认按原版来。
let TILT_DEG = 24;
  (function () {
    const m = /#.*tilt=(\d+(?:\.\d+)?)/.exec(location.hash);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= 0 && v <= 55) TILT_DEG = v;
    }
  })();
  const CAM_DIST = 220.0;   // 极远相机 + 极窄 fov：几乎正交，无梯形   // 配合窄 fov：近似正交，梯形可忽略

  let renderer = null, scene = null, camera = null;
  let ballMesh = null, ball2Mesh = null;
  const ballShadows = [];
  let shadowTex = null, glowTex = null;
  const bumperPops = [];
  const flipperMeshes = [];      // {g, f, halo, edge, body, core, ring}
  let edgeGlowMat = null;
  let deckLayerRef = null, deckShadowRef = null;
  // 挡板占用区域（逻辑坐标）：两支挡板 + 转轴 + 一点点余量
  const FLIP_RECT = { x: 50, y: 620, w: 380, h: 170 };
  let ready = false;

  /* ---------------- 小工具 ---------------- */
  function makeTexFromCanvas(c) {
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    // 不设 sRGB 编码：贴图内容本身就是"最终像素值"（和 2D canvas 完全一样），
    // 解码再编码只会引入偏差。见 renderer.outputEncoding 处的说明。
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
    /* 色彩管线必须"直通"：
       我们的贴图是 Canvas 画好的**最终像素**（与 2D 版逐字节一致）。
       如果开 sRGB 输出，Three.js 会把纯色材质当线性色再编码一次 ——
       所有纯色都被提亮（挡板的 #0c1430 被冲成灰白、侧壁变亮带，都是这个原因）。
       关掉编码后，材质色 = 屏幕色，贴图色 = 原图色，与 2D 完全一致。 */
    renderer.outputEncoding = THREE.LinearEncoding;
    renderer.toneMapping = THREE.NoToneMapping;

    scene = new THREE.Scene();

    const tilt = TILT_DEG * Math.PI / 180;
    WZ_K = 1 / Math.cos(tilt);          // 纵向补偿（见 wz 定义处说明）
    // 拉远 + 收窄 fov：透视趋近正交，消除"近端变宽"的梯形，
    // 这样正交绘制的美术在 24° 斜视下仍是矩形，不会左右溢出。
    camera = new THREE.PerspectiveCamera(2.45, 480 / 940, 1, 600);
    camera.position.set(0, CAM_DIST * Math.cos(tilt), CAM_DIST * Math.sin(tilt));
    // up 必须位于"相机上方向"：绕 X 轴倾斜 tilt 后应为 (0, sin, -cos)。
    // 写成 (0, cos, -sin) 会让 up 与视线接近反平行，lookAt 正交化后投影矩阵退化
    // —— 表现为 project() 返回 sy≈5000 这种离谱值，且整个视角是歪的。
    camera.up.set(0, Math.sin(tilt), -Math.cos(tilt));
    camera.lookAt(0, 0, 0);
    // 台面贴齐 2D 版心（屏幕 y=140..940）。
    // 平移必须沿相机 up 轴做"刚体平移"（translateY）——它只挪画面、不改朝向，比例不变。
    // 用 lookAt 抬目标点或 setViewOffset 都会引入额外的透视压缩/矩阵失真（都踩过）。
    camera.translateY(0.66);

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
      // 用纯色不受光：24° 斜视能看到侧壁正面，一旦交给 PBR 就会被点光照成一条亮带
      // 侧壁用接近背景的深空色：24° 斜视会看到它的正面，
      // 颜色偏亮就会在画面底部横一条突兀的带子（2D 版那里是自然的深空延伸）。
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x060a16 }));
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
        capTex.encoding = THREE.LinearEncoding;
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

    /* ---------- ③ 挡板：实体几何 + 荧光分层 ----------
       严格复刻 2D 的绘制分层（drawFlippers）：
         ① 外发光（shadowBlur 16~28，加色外溢）  → 加色外晕管 + 柔光雾
         ② 亮蓝描边（lineWidth 17）              → 亮蓝管
         ③ 深色棒体（lineWidth 11，#0c1430）     → 深色管（压在亮蓝管上）
         ④ 亮内芯（lineWidth 3.5，#d8edff）      → 白色细芯
       四层同心套起来，俯视就是 2D 的"荧光边 + 深色棒 + 白芯"，
       斜视还能看到圆柱的真实体积与受光。 */
    flipperMeshes.length = 0;
    [PS.leftF, PS.rightF].forEach(function (f) {
      if (!f) return;
      const lenW = f.len * S;
      const g = new THREE.Group();
      g.position.set(wx(f.px), 0, wz(f.py));

      const tube = function (radius, mat, yOff, order, lenMul) {
        const geo = new THREE.CylinderGeometry(radius, radius, lenW * (lenMul || 1), 22, 1, false);
        geo.rotateZ(Math.PI / 2);
        geo.translate(lenW / 2, 0, 0);
        const m = new THREE.Mesh(geo, mat);
        m.position.y = yOff;
        m.renderOrder = order;
        g.add(m);
        return m;
      };

      /* ① 外发光：围绕棒轮廓的一圈柔光（shadowBlur 的对应物）。
         不能做成圆柱：实心圆柱会把整根棒包住，additive 一叠就冲成白色（踩过两次）。
         做成平铺在棒下方的拉伸柔光面 —— 只在棒体外围溢出。 */
      const haloMat = new THREE.MeshBasicMaterial({
        map: glowTex, color: 0x5aa4ff, transparent: true, opacity: 0.60,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      const haloGeo = new THREE.PlaneGeometry(lenW * 2.1, lenW * 2.1);
      haloGeo.rotateX(-Math.PI / 2);
      haloGeo.translate(lenW / 2, 0, 0);
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.y = 0.016;
      halo.renderOrder = 25;
      g.add(halo);

      /* ② 深色棒体（2D 的 11px #0c1430）。
         用"深色大圆柱 + 顶部两条亮棱线"，不用同心套管 ——
         套管的外层半径一大，就会从侧面把内层深色棒整个遮住（实测深色完全看不见）。 */
      const bodyMat = new THREE.MeshBasicMaterial({ color: 0x0c1430 });
      const bodyMesh = tube(0.070, bodyMat, 0.056, 30);

      /* ③ 荧光棱线：棒顶两侧各一条，读作 2D 的 17px 亮蓝描边。
         每条分两层：不透明亮线（描边本体）+ 更宽的加色外溢（shadowBlur 的辉光）。
         这样荧光是"从描边向外扩散"的，而不是把整根棒冲白。 */
      const edgeMat = new THREE.MeshBasicMaterial({ color: 0x84bcff });
      edgeGlowMat = new THREE.MeshBasicMaterial({
        color: 0x5aa4ff, transparent: true, opacity: 0.42,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      [-1, 1].forEach(function (sd) {
        // 辉光层（宽、淡、加色）
        const gg = new THREE.BoxGeometry(lenW * 0.995, 0.042, 0.070);
        gg.translate(lenW / 2, 0, 0);
        const gm = new THREE.Mesh(gg, edgeGlowMat);
        gm.position.set(0, 0.090, sd * 0.055);
        gm.renderOrder = 30;
        g.add(gm);

        // 描边本体（窄、实）
        const eg = new THREE.BoxGeometry(lenW * 0.995, 0.014, 0.019);
        eg.translate(lenW / 2, 0, 0);
        const e = new THREE.Mesh(eg, edgeMat);
        e.position.set(0, 0.093, sd * 0.055);
        e.renderOrder = 31;
        g.add(e);
      });

      // ④ 亮内芯（2D 的 3.5px #d8edff），压在棒顶正中
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xd8edff });
      tube(0.011, coreMat, 0.093, 32);

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
      const ringMat = new THREE.MeshBasicMaterial({ color: 0x5a9cff, transparent: true, opacity: 0.95 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 0.100;
      ring.renderOrder = 32;
      g.add(ring);

      scene.add(g);
      flipperMeshes.push({
        g: g, f: f, halo: haloMat, edge: edgeMat, haloMesh: halo,
        body: bodyMat, core: coreMat, ring: ringMat
      });
    });

    /* ---------- ④ 坡道：实体槽（槽底 + 侧壁 + 银轨 + 黄带）----------
       2D 坡道 = 半透明槽底 + 两侧立壁 + 三层描边钢轨 + 立柱/横档 + 黄色标识带。
       这里照同一套结构做实体：斜视时能看到真实的槽内壁与轨道高度，而不是一张贴纸。
       中心线与高度曲线直接复用物理（PS.rampPoint / PS.rampH），保证球贴在槽里。 */
    (function () {
      const ramp = PS.RAMP;
      if (!ramp || !PS.rampPoint) return;

      const N = 64;

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
        /* 末段裙边：2D 的 apron 从 t=0.70 起把半宽加 6px（drawLift 里 w = rampHalfW(t)+6），
           目的就是让坡道"铺开"盖住二层入口，读作一个整体。
           这里同样处理，并且多给一点（+14），因为 3D 斜视下需要更宽才盖得住接缝。 */
        // 2D 的 apron 就是 rampHalfW(t) + 6；给多了末端会比二层颈部还宽，反而露出截断面
        const apron = f.t > 0.70 ? (f.t - 0.70) / 0.30 : 0;
        const extra = (extraW || 0) + apron * apron * 6;
        const w = (f.hw + extra) * side;
        return new THREE.Vector3(
          wx(f.x + f.nx * w),
          hzR(f.h + (extraH || 0)),
          wz(f.y + f.ny * w)
        );
      };

      /* —— 槽底（含"钻进二层"的延伸段）——
         坡道中心线终点正好落在二层入口边界上，只画到那里视觉上就是"贴在边上"；
         2D 用 apron 裙边把这一段盖住。3D 这里让槽底继续沿二层颈部向前延伸 52px，
         延伸段藏在二层平台之下（二层 renderOrder 50 > 槽底 34），
         只露出接缝附近的一小截 —— 于是坡道与二层读作一个整体，而不是两件东西。 */
      (function () {
        const DECKH = (PS.DECK3D ? PS.DECK3D.z : 52);
        const EXT_N = 10, EXT_LEN = 52;
        const lastP = F[N];
        const FEX = F.slice();
        for (let k = 1; k <= EXT_N; k++) {
          const u = k / EXT_N;
          FEX.push({
            t: 1 + u * 0.001,                       // 保持 ~1，裙边加宽公式自然生效
            x: lastP.x,
            y: lastP.y + EXT_LEN * u,
            nx: 0, ny: 1,
            hw: 16 - 2 * u,                          // 16 → 14：贴住二层颈部，不外溢
            h: DECKH
          });
        }
        const verts = [], idx = [], uvs = [];
        for (let i = 0; i < FEX.length; i++) {
          const f = FEX[i];
          const L = vertToWorld(f, -1, 0, 0);
          const R = vertToWorld(f, 1, 0, 0);
          verts.push(L.x, L.y, L.z, R.x, R.y, R.z);
          uvs.push(0, f.t, 1, f.t);
          if (i < FEX.length - 1) {
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
          color: 0x101c38, transparent: true, opacity: 0.58,
          side: THREE.DoubleSide, depthWrite: false
        }));
        m.renderOrder = 34;
        scene.add(m);
      })();

      /* —— 两侧槽壁：从槽底向上立起（这是"槽"的核心）—— */
      [-1, 1].forEach(function (side) {
        const verts = [], idx = [];
        const WALL_H = 0.078;
        /* 末段槽壁渐隐（2D 的 apron fusion）：
           坡道越靠近二层，槽壁越矮，到交付口正好归零 ——
           这样槽体与二层顶面自然融成一体，不会出现一道"截断"的边界。 */
        const wallAt = function (t) {
          if (t < 0.70) return WALL_H;
          const k = Math.min(1, (t - 0.70) / 0.30);
          return WALL_H * (1 - k * k);
        };
        for (let i = 0; i <= N; i++) {
          const f = F[i];
          const b = vertToWorld(f, side, 0, 0);
          const tp = b.clone(); tp.y += wallAt(f.t);
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
          color: 0x2a4384, transparent: true, opacity: 0.80,
          side: THREE.DoubleSide, depthWrite: false
        }));
        m.renderOrder = 35;
        scene.add(m);
      });

      /* —— 银轨：沿两侧槽壁顶端的细亮线（2D 的 3 层描边导轨）—— */
      [-1, 1].forEach(function (side) {
        const pts = [];
        for (let i = 0; i <= N; i += 2) {
          const f2 = F[i];
          const p = vertToWorld(f2, side, 0, 0);
          // 末段银轨同样收进槽底，与二层顶面平齐
          const k2 = f2.t < 0.70 ? 0 : Math.min(1, (f2.t - 0.70) / 0.30);
          pts.push(new THREE.Vector3(p.x, p.y + 0.080 * (1 - k2 * k2), p.z));
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
        color: 0xffce54, transparent: true, opacity: 0.82, side: THREE.DoubleSide
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
      // 记录引用：每帧按 PS.DECK3D.fade 调整不透明度，
      // 球钻到二层下方时平台淡出（与 2D 版同一套逻辑，fade 1→0.42）
      deckLayerRef = deckLayer;
      deckShadowRef = shLayer;
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
  // 物理高度 → 世界高度。坡道与平台用了不同压缩系数，
  // 球必须跟着所在层走，否则会在坡道上"浮起来"或陷进去。
  const worldH = (h, isRamp) => (isRamp ? hzR(h) : hzS(h));

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
      m.position.set(wx(b.x), worldH(h, b.rampT !== undefined) + 9 * S, wz(b.y));
    }

    for (let i = 0; i < 2; i++) {
      const shm = ballShadows[i], b = visible[i];
      if (!b) { shm.visible = false; continue; }
      const h = heightOf(b);
      const lift = Math.min(1, h / 60);
      shm.visible = true;
      shm.position.set(wx(b.x) - 0.03, worldH(h, b.rampT !== undefined) + 0.008, wz(b.y) + 0.05);
      shm.material.opacity = 0.5 * (1 - lift * 0.4);
      const k = 0.40 + lift * 0.22;
      shm.scale.set(k, k, 1);
    }

    /* 二层遮挡淡出：球从二层下方掠过时，平台变半透明让球可见。
       直接读 2D 版算好的 PS.DECK3D.fade（update 里已做 1→0.42 的平滑过渡），
       两边共用同一份状态，行为与 2D 完全一致。 */
    if (deckLayerRef) {
      const fd = (PS.DECK3D && PS.DECK3D.fade !== undefined) ? PS.DECK3D.fade : 1;
      deckLayerRef.material.opacity = fd;
      if (deckShadowRef) deckShadowRef.material.opacity = 0.62 * fd;
    }

    // 挡板：绕转轴真实旋转；按下时蓝→品红（对应 2D 的 #84bcff → #ff9ee8）
    for (let i = 0; i < flipperMeshes.length; i++) {
      const fm = flipperMeshes[i];
      fm.g.rotation.y = -fm.f.angle;
      const pressed = !!fm.f.pressed;
      fm.halo.color.setHex(pressed ? 0xff5ecb : 0x4f9dff);
      fm.halo.opacity = pressed ? 0.60 : 0.46;
      fm.edge.color.setHex(pressed ? 0xff9ee8 : 0x84bcff);
      if (edgeGlowMat) {
        edgeGlowMat.color.setHex(pressed ? 0xff5ecb : 0x5aa4ff);
        edgeGlowMat.opacity = pressed ? 0.62 : 0.42;
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
  function project(x, y, h, isRamp) {
    if (!camera) return null;
    // 必须在这里刷新：菜单态 3D 不渲染，camera.matrixWorld 可能还是初始化时的旧值，
    // 直接 project 会算出完全错的坐标（曾出现 sy≈5000）。
    camera.updateMatrixWorld();
    // 与实际几何用同一套高度系数，否则飘字/粒子会飘在元素上方
    tmpV.set(wx(x), isRamp ? hzR(h || 0) : hzS(h || 0), wz(y));
    tmpV.project(camera);
    if (!isFinite(tmpV.x) || !isFinite(tmpV.y)) return null;
    // NDC → 逻辑画布坐标（480 x 940，含 140 背板）
    return {
      x: (tmpV.x * 0.5 + 0.5) * 480,
      y: (-tmpV.y * 0.5 + 0.5) * 940
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
  if (location.hash.indexOf('#rampdiag') >= 0) {
    setTimeout(function () {
      try {
        const out = [];
        // 先打台面四角：判断 4.8x8 的台面是否正好落在 480x800（y=140..940）
        [[0,0],[0,800],[480,0],[480,800],[240,400]].forEach(function (p) {
          const sp = project(p[0], p[1], 0);
          out.push({ pt: p.join(','), sx: sp ? +sp.x.toFixed(1) : null, sy: sp ? +sp.y.toFixed(1) : null });
        });
        [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
          const p = PS.rampPoint(t);
          const h = PS.rampH(t);
          const sp = project(p.x, p.y, h);
          out.push({ t: t, lx: +p.x.toFixed(1), ly: +p.y.toFixed(1), h: +h.toFixed(1),
                     sx: sp ? +sp.x.toFixed(1) : null, sy: sp ? +sp.y.toFixed(1) : null });
        });
        document.title = 'RAMPDIAG ' + JSON.stringify(out);
      } catch (e) { document.title = 'RAMPDIAGERR ' + e.message; }
    }, 2500);
  }

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
    // #under：把球放到二层正下方，验证平台淡出（2D 的 DECK3D.fade 1→0.42）
    if (location.hash.indexOf('#under') >= 0) {
      PS.restart('classic');
      PS.state.paused = false;
      PS.state.mode = 'play';
      const b = PS.balls && PS.balls[0];
      if (b) {
        b.deck = 'lower';
        b.rampT = undefined;
        b.x = 96 - 6;        // DECK2.cx
        b.y = 400;           // 落在二层多边形内
        b.vx = 0; b.vy = 0;
        b.hidden = false;
      }
      return;
    }
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