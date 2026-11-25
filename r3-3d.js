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
  // 高度压缩：DECK2.z=52 是 2D 版的"上移量"，直接在 3D 里用会显得像一堵墙，
  // 压缩到 0.58 后既看得出是抬升面，又不会挡住后方台面。
  const HSCALE = 0.58;
  const wh = h => (h || 0) * S * HSCALE;

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
  /* 从烘焙图上裁一块圆形区域当贴图 —— 让 3D 物件顶面直接复用原版的图案，
     这是"不简陋"最省力的办法：原版那些精细纹样是画好的，照搬即可。 */
  function cropBaked(baked, lx, ly, radiusLogic, scale) {
    if (!baked) return null;
    const sc = scale || 2;
    const px = lx * sc, py = ly * sc, pr = radiusLogic * sc;
    const size = Math.max(8, Math.round(pr * 2));
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    try {
      g.drawImage(baked, px - pr, py - pr, pr * 2, pr * 2, 0, 0, size, size);
    } catch (e) { return null; }
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function makeShadowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.45, 'rgba(255,255,255,.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
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
  let shadowTex = null, dust = null;
  const ballShadows = [];
  const bumperGroups = [];       // {g, ring, base, pop}
  const flipperMeshes = [];      // {m, f}
  const lampMeshes = [];
  const tmpV = new THREE.Vector3();

  /* ---------------- 程序化材质贴图 ---------------- */

  // 台面：深空底色 + 细网格 + 中轴冷光，全部程序生成，不占包体
  /* 台面纹理：把 2D 版的全部视觉语言（分区、刻线、警示纹、物件铭牌、星云）
     烘进一张高分辨率贴图。零额外 draw call，且是"印刷在台面上"的真实感，
     比贴一堆 billboard 更像真机台。 */
  const TEX_W = 2048, TEX_H = 3584;
  // 逻辑坐标 → 纹理像素（与 ExtrudeGeometry 的 UV 包围盒严格对应）
  const BX0 = 24, BX1 = 456, BY0 = 264, BY1 = 1020;
  const tx = x => (x - BX0) / (BX1 - BX0) * TEX_W;
  const ty = y => (y - BY0) / (BY1 - BY0) * TEX_H;
  const ts = k => k / (BX1 - BX0) * TEX_W;    // 逻辑长度 → 纹理长度

  function makePlayfieldTexture() {
    const c = document.createElement('canvas');
    c.width = TEX_W; c.height = TEX_H;
    const g = c.getContext('2d');
    g.textBaseline = 'middle';

    /* ---- 底：深空渐变 ---- */
    const bg = g.createRadialGradient(tx(240), ty(300), 40, tx(240), ty(520), ts(760));
    bg.addColorStop(0, '#14203f');
    bg.addColorStop(0.45, '#0a1128');
    bg.addColorStop(1, '#04060e');
    g.fillStyle = bg; g.fillRect(0, 0, TEX_W, TEX_H);

    /* ---- 星云：三团彩色雾，对应原版三个湾 ---- */
    [[90, 200, 190, 'rgba(80,120,255,.20)'],
     [400, 380, 220, 'rgba(190,80,220,.15)'],
     [250, 700, 250, 'rgba(40,170,200,.12)']].forEach(function (n) {
      const rg = g.createRadialGradient(tx(n[0]), ty(n[1]), 0, tx(n[0]), ty(n[1]), ts(n[2]));
      rg.addColorStop(0, n[3]);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, TEX_W, TEX_H);
    });

    /* ---- 细网格（"表面"感，几乎零成本）---- */
    g.strokeStyle = 'rgba(120,170,255,.05)';
    g.lineWidth = 1;
    for (let x = BX0; x <= BX1; x += 24) {
      g.beginPath(); g.moveTo(tx(x), 0); g.lineTo(tx(x), TEX_H); g.stroke();
    }
    for (let y = BY0; y <= BY1; y += 24) {
      g.beginPath(); g.moveTo(0, ty(y)); g.lineTo(TEX_W, ty(y)); g.stroke();
    }

    /* ---- 分区：淡描边 + 分区名（原版 5 区）---- */
    (PS.ZONES || []).forEach(function (z) {
      const col = z.c;
      g.save();
      g.strokeStyle = col; g.globalAlpha = 0.16; g.lineWidth = ts(3);
      const x0 = tx(z.x), y0 = ty(z.y), w = ts(z.w), h = ts(z.h);
      if (z.arc) {
        g.beginPath();
        g.arc(x0 + w / 2, y0 + h / 2, Math.min(w, h) / 2, 0, 6.2832);
        g.stroke();
      } else {
        g.strokeRect(x0, y0, w, h);
      }
      // 角落刻度
      g.globalAlpha = 0.5; g.lineWidth = ts(3.4);
      const L = ts(14);
      [[x0, y0, 1, 1], [x0 + w, y0, -1, 1], [x0, y0 + h, 1, -1], [x0 + w, y0 + h, -1, -1]].forEach(function (p) {
        g.beginPath();
        g.moveTo(p[0] + p[2] * L, p[1]); g.lineTo(p[0], p[1]); g.lineTo(p[0], p[1] + p[3] * L);
        g.stroke();
      });
      // 分区名：中文大字 + 英文小字
      g.globalAlpha = 0.26;
      g.fillStyle = col;
      g.font = '700 ' + Math.round(ts(8)) + 'px ui-monospace,Menlo,monospace';
      g.textAlign = 'left';
      g.fillText(z.zh, x0 + ts(9), y0 + ts(9));
      g.globalAlpha = 0.15;
      g.font = '600 ' + Math.round(ts(5.6)) + 'px ui-monospace,Menlo,monospace';
      g.fillText(z.sub, x0 + ts(9), y0 + ts(16.5));
      g.restore();
    });

    /* ---- 中央军衔环：同心刻度 + 四方位标记（原版 RING）---- */
    (function () {
      const R = PS.RING, cx = tx(R.cx), cy = ty(R.cy), rr = ts(R.rad);
      g.save();
      g.strokeStyle = 'rgba(100,210,255,.30)'; g.lineWidth = ts(2.2);
      g.beginPath(); g.arc(cx, cy, rr, 0, 6.2832); g.stroke();
      g.globalAlpha = 0.5; g.lineWidth = ts(1.4);
      g.beginPath(); g.arc(cx, cy, rr - ts(11), 0, 6.2832); g.stroke();
      // 48 道放射刻度
      g.globalAlpha = 0.22;
      for (let i = 0; i < 48; i++) {
        const a = i / 48 * 6.2832;
        const r0 = rr - ts(i % 4 === 0 ? 15 : 9), r1 = rr - ts(3);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        g.stroke();
      }
      // 四方位菱形节点（对应原版环上四个虫洞/井位）
      g.globalAlpha = 0.55; g.fillStyle = '#7fe4ff';
      for (let i = 0; i < 4; i++) {
        const a = i / 4 * 6.2832 - Math.PI / 2;
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        g.save(); g.translate(px, py); g.rotate(a + Math.PI / 4);
        g.fillRect(-ts(3.4), -ts(3.4), ts(6.8), ts(6.8));
        g.restore();
      }
      g.restore();
    })();

    /* ---- 缓冲器底圈：三层同心光环（原版每个缓冲器脚下的装饰）---- */
    (PS.BUMPERS || []).forEach(function (b) {
      const cx = tx(b.x), cy = ty(b.y);
      for (let k = 0; k < 3; k++) {
        g.save();
        g.globalAlpha = 0.30 - k * 0.08;
        g.strokeStyle = b.c; g.lineWidth = ts(2.4);
        g.beginPath(); g.arc(cx, cy, ts(b.r + 8 + k * 11), 0, 6.2832); g.stroke();
        g.restore();
      }
    });

    /* ---- 发射槽：警示斜纹（原版满力发射槽的工业感）---- */
    (function () {
      g.save();
      g.beginPath();
      g.rect(tx(414), ty(392), ts(40), ts(388));
      g.clip();
      g.globalAlpha = 0.13; g.strokeStyle = '#ffd166'; g.lineWidth = ts(7);
      for (let i = -40; i < 60; i++) {
        const yy = ty(392) + i * ts(22);
        g.beginPath(); g.moveTo(tx(410), yy); g.lineTo(tx(460), yy + ts(26)); g.stroke();
      }
      g.restore();
    })();

    /* ---- 排水区：红色警示弧（原版底部危险区）---- */
    (function () {
      g.save();
      g.globalAlpha = 0.16; g.strokeStyle = '#ff5a6e'; g.lineWidth = ts(4);
      g.beginPath();
      g.arc(tx(240), ty(700), ts(150), Math.PI * 0.14, Math.PI * 0.86);
      g.stroke();
      g.globalAlpha = 0.09;
      g.beginPath();
      g.arc(tx(240), ty(700), ts(168), Math.PI * 0.18, Math.PI * 0.82);
      g.stroke();
      g.restore();
    })();

    /* ---- 物件铭牌：原版"每个可击打物件都有名字" ---- */
    (function () {
      // 只标"可击打的主物件"。旗、井、星道这些次要件全标会让台面糊成一片字。
      const S2 = PS.SPOTS || {};
      const KEEP = /^(b\d|w\d|s\d|p\d|ramp|shooter|deck)$/;
      g.textAlign = 'center';
      Object.keys(S2).forEach(function (k) {
        if (!KEEP.test(k)) return;
        const sp = S2[k];
        if (!sp || !sp.name) return;
        g.save();
        g.globalAlpha = 0.40;
        g.font = '700 ' + Math.round(ts(8)) + 'px ui-monospace,Menlo,monospace';
        const off = k.charAt(0) === 'b' ? 46 : (k.charAt(0) === 'w' ? 30 : 24);
        const lx = tx(sp.x), ly = ty(sp.y) + ts(off);
        // 深色描边保证在任何底色上都读得清（对应原版 tinyText 的暗底处理）
        g.lineWidth = ts(2.2);
        g.strokeStyle = 'rgba(4,8,20,.8)';
        g.strokeText(sp.name, lx, ly);
        g.fillStyle = 'rgba(186,216,255,.95)';
        g.fillText(sp.name, lx, ly);
        g.restore();
      });
    })();

    /* ---- 底部机械区：排水口、inlane 引导、螺栓点阵 ----
       原版下半部是很密的机械细节（挡板、排水口、引导弧），
       3D 里如果不画，这里就是一大片空台面，整张桌子会显得"没做完"。 */
    (function () {
      // 排水口：底部中央的暗色梯形 + 红色警示边
      g.save();
      g.globalAlpha = 0.5;
      g.fillStyle = 'rgba(8,10,20,.85)';
      g.beginPath();
      g.moveTo(tx(200), ty(748));
      g.lineTo(tx(280), ty(748));
      g.lineTo(tx(266), ty(806));
      g.lineTo(tx(214), ty(806));
      g.closePath();
      g.fill();
      g.globalAlpha = 0.5; g.strokeStyle = '#ff5a6e'; g.lineWidth = ts(2.4);
      g.stroke();
      // 排水口内的格栅
      g.globalAlpha = 0.24; g.strokeStyle = '#8fa8d8'; g.lineWidth = ts(1.6);
      for (let i = 1; i < 5; i++) {
        const yy = ty(748 + i * 12);
        g.beginPath(); g.moveTo(tx(203 + i * 2.4), yy); g.lineTo(tx(277 - i * 2.4), yy); g.stroke();
      }
      g.restore();

      // inlane 引导弧：从挡板区到上区两条对称弧（原版球道引导）
      [-1, 1].forEach(function (sd) {
        g.save();
        g.globalAlpha = 0.3;
        g.strokeStyle = '#6fd4ff'; g.lineWidth = ts(3);
        g.beginPath();
        g.moveTo(tx(240 + sd * 96), ty(742));
        g.quadraticCurveTo(tx(240 + sd * 150), ty(660), tx(240 + sd * 172), ty(566));
        g.stroke();
        g.globalAlpha = 0.16; g.lineWidth = ts(1.6);
        g.beginPath();
        g.moveTo(tx(240 + sd * 106), ty(748));
        g.quadraticCurveTo(tx(240 + sd * 160), ty(662), tx(240 + sd * 182), ty(568));
        g.stroke();
        g.restore();
      });

      // 挡板转轴底座
      [140, 340].forEach(function (px) {
        g.save();
        g.globalAlpha = 0.4; g.fillStyle = 'rgba(120,160,240,.7)';
        g.beginPath(); g.arc(tx(px), ty(700), ts(9), 0, 6.2832); g.fill();
        g.globalAlpha = 0.7; g.strokeStyle = '#9fc8ff'; g.lineWidth = ts(2);
        g.beginPath(); g.arc(tx(px), ty(700), ts(9), 0, 6.2832); g.stroke();
        g.restore();
      });

      // 边缘螺栓点阵：沿机壳内缘一圈，提供"装配件"的实感
      g.save();
      g.globalAlpha = 0.34;
      for (let i = 0; i < 44; i++) {
        const t2 = i / 44;
        // 左壁 + 右壁 + 底边
        let bx2, by2;
        if (i < 16) { bx2 = 40; by2 = 300 + t2 * 3 * 480; }
        else if (i < 32) { bx2 = 440; by2 = 300 + (t2 - 16 / 44) * 3 * 480; }
        else { bx2 = 60 + (t2 - 32 / 44) * 3.1 * 360; by2 = 772; }
        g.fillStyle = 'rgba(150,190,255,.85)';
        g.beginPath(); g.arc(tx(bx2), ty(by2), ts(2.2), 0, 6.2832); g.fill();
      }
      g.restore();

      // 底部横贯装饰弧（机柜前沿）
      g.save();
      g.globalAlpha = 0.18; g.strokeStyle = '#7fb0ff'; g.lineWidth = ts(4);
      g.beginPath();
      g.moveTo(tx(24), ty(792));
      g.quadraticCurveTo(tx(240), ty(852), tx(456), ty(792));
      g.stroke();
      g.globalAlpha = 0.1; g.lineWidth = ts(8);
      g.beginPath();
      g.moveTo(tx(24), ty(806));
      g.quadraticCurveTo(tx(240), ty(872), tx(456), ty(806));
      g.stroke();
      g.restore();
    })();

    /* ---- 缓冲器顶面花纹：同心刻环 + 十字刻度（原版每个缓冲器都有精细图案）---- */
    (PS.BUMPERS || []).forEach(function (b) {
      const cx = tx(b.x), cy = ty(b.y);
      // 花纹必须画在圆柱**外围**：圆心位置在 3D 里被圆柱本体占着，画了也看不见
      g.save();
      g.globalAlpha = 0.42;
      g.strokeStyle = b.c; g.lineWidth = ts(1.8);
      [1.55, 1.95].forEach(function (k) {
        g.beginPath(); g.arc(cx, cy, ts(b.r) * k, 0, 6.2832); g.stroke();
      });
      // 外围放射刻度
      g.globalAlpha = 0.3;
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * ts(b.r) * 1.6, cy + Math.sin(a) * ts(b.r) * 1.6);
        g.lineTo(cx + Math.cos(a) * ts(b.r) * 1.95, cy + Math.sin(a) * ts(b.r) * 1.95);
        g.stroke();
      }
      g.restore();
    });

    /* ---- 星点：真实"星空台面"---- */
    (function () {
      for (let i = 0; i < 420; i++) {
        const px = Math.random() * TEX_W;
        const py = Math.random() * TEX_H;
        const r = Math.random() * 1.9 + 0.4;
        g.globalAlpha = 0.16 + Math.random() * 0.5;
        g.fillStyle = Math.random() < 0.22 ? '#9fd8ff' : '#ffffff';
        g.beginPath(); g.arc(px, py, r, 0, 6.2832); g.fill();
      }
      g.globalAlpha = 1;
    })();

    /* ---- 彩色光斑：把整体从"灰蓝"拉回原版的霓虹星空 ---- */
    (function () {
      [[240, 300, 300, 'rgba(90,220,255,.10)'],
       [240, 560, 260, 'rgba(170,110,250,.10)'],
       [240, 760, 240, 'rgba(255,150,90,.07)'],
       [120, 470, 200, 'rgba(90,150,255,.08)'],
       [360, 470, 200, 'rgba(255,110,215,.07)']].forEach(function (p) {
        const rg = g.createRadialGradient(tx(p[0]), ty(p[1]), 0, tx(p[0]), ty(p[1]), ts(p[2]));
        rg.addColorStop(0, p[3]);
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg; g.fillRect(0, 0, TEX_W, TEX_H);
      });
    })();

    /* ---- 边缘暗角：让台面有"凹进去"的容积感 ---- */
    (function () {
      const vg = g.createRadialGradient(TEX_W / 2, TEX_H * 0.45, TEX_W * 0.30,
                                        TEX_W / 2, TEX_H * 0.45, TEX_W * 0.95);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,.62)');
      g.fillStyle = vg; g.fillRect(0, 0, TEX_W, TEX_H);
    })();

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    tex.encoding = THREE.sRGBEncoding;
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
    push(456, 800);
    push(24, 800);
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
    renderer.toneMappingExposure = 1.34;   // 透视压缩会把细节压暗，补回亮度

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(36, 480 / 940, 0.1, 60);
    camera.position.set(0, 12.4, 7.0);
    camera.lookAt(0, -0.1, 0.1);

    const env = makeEnvTexture();
    glowTex = makeGlowTexture();

    /* ---- 灯光 ---- */
    scene.add(new THREE.AmbientLight(0x2a3a5e, 1.0));

    const key = new THREE.DirectionalLight(0xdfe9ff, 0.55);
    key.position.set(2.2, 9.0, 4.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = -4; sc.right = 4; sc.top = 5; sc.bottom = -5; sc.near = 0.5; sc.far = 20;
    key.shadow.bias = -0.0012;
    key.target.position.set(0, 0, 0.6);
    scene.add(key.target);
    scene.add(key);

    const rimCyan = new THREE.PointLight(0x3fd8ff, 1.0, 7.5, 2);
    rimCyan.position.set(-1.9, 1.5, -1.2);
    scene.add(rimCyan);

    const rimMag = new THREE.PointLight(0xff5ecb, 0.7, 6.5, 2);
    rimMag.position.set(2.0, 1.3, 0.9);
    scene.add(rimMag);

    const warm = new THREE.PointLight(0xffa860, 0.45, 6, 2);
    warm.position.set(0.3, 1.0, 3.6);
    scene.add(warm);

    // 顶部聚光：真实球台就是被顶灯照亮的，中心亮、边缘暗，这一步给足"立体感"
    const spot = new THREE.SpotLight(0xe8f2ff, 0.45, 18, Math.PI * 0.30, 0.55, 1.4);
    spot.position.set(0.4, 8.6, 3.2);
    spot.target.position.set(0, 0, 0.8);
    scene.add(spot.target);
    scene.add(spot);

    const topCyan = new THREE.PointLight(0x9fe8ff, 0.5, 7, 2);
    topCyan.position.set(0.2, 2.6, -2.4);
    scene.add(topCyan);

    /* ---- 台面 ---- */
    const floorShape = buildFloorShape();
    const floorGeo = new THREE.ExtrudeGeometry(floorShape, {
      depth: 0.26, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2
    });
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, -0.26, 0);
    // 优先用原版台面烘焙图（视觉 100% 与 2D 版一致）；烘焙失败才退回程序纹理
    let floorTex = null;
    let bakedCanvas = null;
    try {
      bakedCanvas = PS.bakeTable ? PS.bakeTable(2) : null;
      if (bakedCanvas) {
        floorTex = new THREE.CanvasTexture(bakedCanvas);
        floorTex.anisotropy = 4;
        floorTex.encoding = THREE.sRGBEncoding;
      }
    } catch (e) { bakedCanvas = null; }
    if (!floorTex) floorTex = makePlayfieldTexture();

    // 台面用 Basic：烘焙图就是成品画，任何再打光都会让它偏离原版配色。
    // 立体感改由两件事承担：① 3D 实体自身的高光/暗面 ② 实体下方的柔和投影贴片。
    const floorMat = new THREE.MeshBasicMaterial({ map: floorTex, color: 0xffffff });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    // ExtrudeGeometry 的 UV 需要映射到 0..1 才能贴图
    // UV 精确对齐烘焙图（480x800 逻辑像素）：
    //   世界 x = (逻辑x-240)/100  →  u = (x+2.4)/4.8 = 逻辑x/480
    //   世界 z = (逻辑y-400)/100  →  v = (4-z)/8     = 1 - 逻辑y/800
    const uv = floorGeo.attributes.uv;
    const pos = floorGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const px = pos.getX(i), pz = pos.getZ(i);
      uv.setXY(i, (px + 2.4) / 4.8, (4 - pz) / 8);
    }
    uv.needsUpdate = true;
    floor.receiveShadow = true;
    scene.add(floor);

    /* ---- 立体墙：与物理墙体一一对应 ---- */
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x0e1838, emissive: 0x4a9cff, emissiveIntensity: 1.0,
      roughness: 0.2, metalness: 0.9
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
      s3.set(len + 0.04, 0.20, Math.max(0.035, w.r * 1.25 * S));
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

      // 底座压得很矮：原版缓冲器的精美图案才是主角，3D 只负责给它一个"厚度"。
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(b.r * S * 1.02, b.r * S * 1.10, 0.13, 28),
        new THREE.MeshStandardMaterial({
          color: 0x141c3c, emissive: col.clone().multiplyScalar(0.5),
          emissiveIntensity: 0.9, roughness: 0.34, metalness: 0.85
        })
      );
      body.position.y = 0.065;
      body.castShadow = true;
      g.add(body);

      // 顶面：直接用原版缓冲器的图案（含同心光环与刻度），比自造更精细
      const capTex = cropBaked(bakedCanvas, b.x, b.y, b.r * 1.30, 2);
      // 顶面：原版缓冲器的核心是"发光圆盘 + 同心环"。
      // 用纯色圆盘 + 多层环来还原，比贴图更可控（贴图在圆几何上会被内切圆裁掉一圈）。
      const cap = new THREE.Mesh(
        new THREE.CircleGeometry(b.r * S * 0.98, 32),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.92 })
      );
      cap.rotation.x = -Math.PI / 2;
      cap.position.y = 0.134;
      g.add(cap);

      // 内层同心环（原版缓冲器顶面的刻环）
      [0.72, 0.46].forEach(function (k, idx) {
        const rg2 = new THREE.Mesh(
          new THREE.RingGeometry(b.r * S * (k - 0.045), b.r * S * (k + 0.005), 32),
          new THREE.MeshBasicMaterial({
            color: 0x04060f, transparent: true, opacity: 0.42 + idx * 0.12,
            side: THREE.DoubleSide
          })
        );
        rg2.rotation.x = -Math.PI / 2;
        rg2.position.y = 0.138 + idx * 0.001;
        g.add(rg2);
      });

      // 中心亮核：原版缓冲器被击中时最亮的那一点
      const core = new THREE.Mesh(
        new THREE.CircleGeometry(b.r * S * 0.30, 20),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 })
      );
      core.rotation.x = -Math.PI / 2;
      core.position.y = 0.142;
      g.add(core);

      // 外圈发光环：给矮底座一个"霓虹边"，这是原版缓冲器的视觉签名
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(b.r * S * 1.06, 0.022, 8, 36),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9 })
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.135;
      g.add(halo);

      scene.add(g);
      const gl2 = addGlow(b.x, b.y, 0.14, b.r * S * 5.4, b.c, 0.34);
      bumperGroups.push({ g: g, halo: halo, cap: cap, pop: 0, glow: gl2 });
    }

    /* ---- 挡板 ---- */
    [[PS.leftF], [PS.rightF]].forEach(function (pair) {
      const f = pair[0];
      const lenW = f.len * S;
      // 圆头棒：真实挡板是圆头的，方块会显得"塑料积木"
      const geo = new THREE.CylinderGeometry(0.085, 0.085, lenW, 14);
      geo.rotateZ(Math.PI / 2);
      geo.translate(lenW / 2, 0, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x3a2a6e, emissive: 0xc47cff, emissiveIntensity: 0.85,
        roughness: 0.25, metalness: 0.8
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.position.set(wx(f.px), 0.085, wz(f.py));
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
        color: 0x1a2650, emissive: 0x2f5cc0, emissiveIntensity: 0.42,
        roughness: 0.3, metalness: 0.92, side: THREE.DoubleSide,
        transparent: true, opacity: 0.93
      });
      rampMesh = new THREE.Mesh(rg, rmat);
      rampMesh.castShadow = true;
      rampMesh.receiveShadow = true;
      scene.add(rampMesh);

      /* 侧壁 + 横向肋条：真实坡道是"槽"，不是一张斜板。
         没有侧壁时，高的斜板在透视下会读成一堵挡路的墙。 */
      const sideMat = new THREE.MeshStandardMaterial({
        color: 0x1a2a5c, emissive: 0x4a8cff, emissiveIntensity: 0.8,
        roughness: 0.25, metalness: 0.9, side: THREE.DoubleSide
      });
      const ribMat = new THREE.MeshStandardMaterial({
        color: 0x2a3a72, emissive: 0x6fa8ff, emissiveIntensity: 0.55,
        roughness: 0.3, metalness: 0.85
      });
      [-1, 1].forEach(function (side) {
        const sv = [], si = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const fi = t * (pts.length - 1);
          const i0 = Math.floor(fi), i1 = Math.min(pts.length - 1, i0 + 1);
          const f2 = fi - i0;
          const x = pts[i0].x + (pts[i1].x - pts[i0].x) * f2;
          const y = pts[i0].y + (pts[i1].y - pts[i0].y) * f2;
          const x2 = pts[Math.min(pts.length - 1, i0 + 1)].x, y2 = pts[Math.min(pts.length - 1, i0 + 1)].y;
          const dx = x2 - x, dy = y2 - y, L = Math.hypot(dx, dy) || 1;
          const nx = -dy / L, ny = dx / L;
          const hw = halfAt(t) * S;
          const h = (H * Math.pow(t, 1.35)) * S + 0.0;
          const bxp = wx(x) + nx * hw * side, bzp = wz(y) + ny * hw * side;
          sv.push(bxp, 0, bzp);                 // 底
          sv.push(bxp, h, bzp);                 // 顶
          if (i < N) {
            const a = i * 2;
            si.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
        sg.setIndex(si);
        sg.computeVertexNormals();
        const sm = new THREE.Mesh(sg, sideMat);
        sm.castShadow = true;
        scene.add(sm);
      });
      // 横向肋条（每 1/7 一道），强化"手工金属槽"的质感
      for (let k = 1; k < 7; k++) {
        const t = k / 7;
        const fi = t * (pts.length - 1);
        const i0 = Math.floor(fi), i1 = Math.min(pts.length - 1, i0 + 1);
        const f2 = fi - i0;
        const x = pts[i0].x + (pts[i1].x - pts[i0].x) * f2;
        const y = pts[i0].y + (pts[i1].y - pts[i0].y) * f2;
        const x2 = pts[Math.min(pts.length - 1, i0 + 1)].x, y2 = pts[Math.min(pts.length - 1, i0 + 1)].y;
        const dx2 = x2 - x, dy2 = y2 - y, L2 = Math.hypot(dx2, dy2) || 1;
        const nx2 = -dy2 / L2, ny2 = dx2 / L2;
        const hw = halfAt(t) * S * 2;
        const h = (H * Math.pow(t, 1.35)) * S + 0.012;
        const rib = new THREE.Mesh(new THREE.BoxGeometry(1, 0.026, 0.05), ribMat);
        rib.position.set(wx(x), h, wz(y));
        rib.rotation.y = Math.atan2(-(ny2), nx2) + Math.PI / 2;
        rib.scale.x = hw;
        scene.add(rib);
      }

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
      // 只做一块"悬空薄板"（厚 0.06），抬升到 D.z 高度。
      // 之前用整个抬升量当挤出深度，等于做成一根冰柱，把左半边台面全封死了。
      const DECK_T = 0.06;
      const dg = new THREE.ExtrudeGeometry(shp, {
        depth: DECK_T, bevelEnabled: false
      });
      dg.rotateX(-Math.PI / 2);
      dg.translate(0, wh(D.z) - DECK_T, 0);
      const dm = new THREE.Mesh(dg, new THREE.MeshStandardMaterial({
        color: 0x111a36, emissive: 0x2a4a9a, emissiveIntensity: 0.42,
        roughness: 0.34, metalness: 0.9, transparent: true, opacity: 0.74
      }));
      dm.castShadow = true; dm.receiveShadow = true;
      deckGroup.add(dm);

      // 顶面轮廓：沿多边形画一圈霓虹边，这是"平台"最强的识别信号
      const outlinePts = [];
      for (let i = 0; i < D.poly.length; i++) {
        outlinePts.push(new THREE.Vector3(wx(D.poly[i].x), wh(D.z) + 0.004, wz(D.poly[i].y)));
      }
      outlinePts.push(new THREE.Vector3(wx(D.poly[0].x), wh(D.z) + 0.004, wz(D.poly[0].y)));
      deckGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(outlinePts),
        new THREE.LineBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.85 })
      ));

      // 支撑柱：两根，让"抬升"这件事在视觉上成立
      if (D.poly && D.poly.length > 2) {
        [[-0.28, 0.30], [0.28, 0.30]].forEach(function (o) {
          const cxp = wx(D.cx + o[0] * 150), czp = wz(D.cy + o[1] * 150);
          const pier = new THREE.Mesh(
            new THREE.CylinderGeometry(0.045, 0.055, wh(D.z), 10),
            new THREE.MeshStandardMaterial({
              color: 0x1a2450, emissive: 0x3f7cff, emissiveIntensity: 0.8,
              roughness: 0.3, metalness: 0.85
            })
          );
          pier.position.set(cxp, wh(D.z) / 2, czp);
          deckGroup.add(pier);
        });
      }
      scene.add(deckGroup);
    }

    /* ---- 弹射器（SLINGS）：三角棱柱，物理里是最活跃的击打件 ---- */
    const slingMat = new THREE.MeshStandardMaterial({
      color: 0x2e2660, emissive: 0xa87cff, emissiveIntensity: 0.8,
      roughness: 0.28, metalness: 0.72
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

    /* ================= 细节层 =================
       原版的"精致感"来自密集的细小发光元素。3D 里大色块一多就显得简陋，
       所以这里补三样成本极低的装饰几何：墙体内侧霓虹线、区域细框、悬浮光尘。 */

    /* ---- ① 墙体内侧霓虹线：沿每段墙向内偏移一条细亮线 ---- */
    (function () {
      const pts = [];
      const CXl = 240;
      for (let i = 0; i < PS.WALLS.length; i++) {
        const w = PS.WALLS[i];
        const mx = (w.ax + w.bx) / 2, my = (w.ay + w.by) / 2;
        // 朝向台面中心的方向 = 内侧
        const dx = CXl - mx, dy = 400 - my;
        const dl = Math.hypot(dx, dy) || 1;
        const ox = dx / dl * 7, oy = dy / dl * 7;
        pts.push(new THREE.Vector3(wx(w.ax + ox), 0.225, wz(w.ay + oy)));
        pts.push(new THREE.Vector3(wx(w.bx + ox), 0.225, wz(w.by + oy)));
      }
      const geo2 = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.LineSegments(geo2, new THREE.LineBasicMaterial({
        color: 0x9fe0ff, transparent: true, opacity: 0.62
      }));
      scene.add(line);
    })();

    /* ---- ② 区域细框：给每个 zone 画一圈极淡的发光边（原版分区的框线） ---- */
    (function () {
      const pts = [];
      (PS.ZONES || []).forEach(function (z) {
        if (z.arc) return;
        const x0 = wx(z.x), x1 = wx(z.x + z.w);
        const z0 = wz(z.y), z1 = wz(z.y + z.h);
        const y = 0.006;
        // 四个角各画一小段（角标），比画整圈更精致
        const L = 0.22;
        [[x0, z0, 1, 1], [x1, z0, -1, 1], [x0, z1, 1, -1], [x1, z1, -1, -1]].forEach(function (p) {
          pts.push(new THREE.Vector3(p[0] + p[2] * L, y, p[1]));
          pts.push(new THREE.Vector3(p[0], y, p[1]));
          pts.push(new THREE.Vector3(p[0], y, p[1]));
          pts.push(new THREE.Vector3(p[0], y, p[1] + p[3] * L));
        });
      });
      const g3 = new THREE.BufferGeometry().setFromPoints(pts);
      scene.add(new THREE.LineSegments(g3, new THREE.LineBasicMaterial({
        color: 0x7fd8ff, transparent: true, opacity: 0.34
      })));
    })();

    /* ---- ③ 悬浮光尘：台面上方一层缓慢漂浮的细光点（体积感的关键） ---- */
    (function () {
      const N3 = 320;
      const arr = new Float32Array(N3 * 3);
      for (let i = 0; i < N3; i++) {
        arr[i * 3]     = (Math.random() - 0.5) * 4.4;
        arr[i * 3 + 1] = 0.02 + Math.random() * 0.85;
        arr[i * 3 + 2] = (Math.random() - 0.5) * 7.6;
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const pm = new THREE.PointsMaterial({
        color: 0xbfe6ff, size: 0.030, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
      });
      dust = new THREE.Points(pg, pm);
      scene.add(dust);
    })();

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

    /* 柔和投影贴片：贴在台面上的一层径向暗斑。
       比真阴影贴图便宜得多（2 个 sprite，零 shadow map），
       但足以让球"压"在台面上而不是飘着。 */
    shadowTex = makeShadowTexture();
    [0, 1].forEach(function (i) {
      const sp = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: shadowTex, transparent: true, opacity: 0.55,
          depthWrite: false, color: 0x000000
        })
      );
      sp.rotation.x = -Math.PI / 2;
      sp.visible = false;
      sp.scale.set(0.46, 0.46, 1);
      scene.add(sp);
      ballShadows.push(sp);
    });

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

    // 投影贴片跟着球，略微偏向光源反方向
    for (let i = 0; i < 2; i++) {
      const shm = ballShadows[i];
      if (!shm) continue;
      if (i < visibleCount) {
        const b = balls.filter(function (x) { return !x.hidden; })[i];
        if (!b) { shm.visible = false; continue; }
        const h = heightOf(b);
        shm.visible = true;
        shm.position.set(wx(b.x) - 0.05, wh(h) + 0.012, wz(b.y) + 0.07);
        // 抬得越高影越淡越大
        const lift = Math.min(1, h / 60);
        shm.material.opacity = 0.55 * (1 - lift * 0.45);
        const k = 0.44 + lift * 0.30;
        shm.scale.set(k, k, 1);
      } else {
        shm.visible = false;
      }
    }

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
      if (bg.cap.material.emissiveIntensity !== undefined) {
        bg.cap.material.emissiveIntensity = 1.4 + Math.min(2.4, pop * 3);
      }
      if (bg.glow) bg.glow.material.opacity = 0.26 + Math.min(0.34, pop * 0.6);
    }

    // 轻微相机呼吸：让"3D"可感知，但不影响操作（幅度极小）
    const t = (st && st.time) || 0;

    // 光尘缓慢上浮 + 环绕，给静态的画面一点"活着"的感觉
    if (dust) {
      const pos2 = dust.geometry.attributes.position;
      for (let i = 0; i < pos2.count; i++) {
        let yy = pos2.getY(i) + 0.0009;
        if (yy > 0.9) yy = 0.02;
        pos2.setY(i, yy);
      }
      pos2.needsUpdate = true;
      dust.rotation.y = Math.sin(t * 0.06) * 0.02;
    }
    camera.position.x = Math.sin(t * 0.23) * 0.08;
    camera.position.y = 12.4 + Math.sin(t * 0.31) * 0.05;
    camera.lookAt(0, -0.1, 0.1);

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