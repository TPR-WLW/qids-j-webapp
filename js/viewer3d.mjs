/**
 * viewer3d.mjs — Three.js 顔ランドマーク 3D ビューアー
 *
 * - MediaPipe 478 点を Points として描画
 * - face_topology.json の connector 配列をベースにワイヤーフレームを構築
 * - baseline（最初のフレーム or ベースライン区間の平均）を薄く表示
 *   current と baseline の差分を色コードで見られる
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export async function createViewer(canvas, topologyUrl = 'models/face_topology.json') {
  const topology = await fetch(topologyUrl).then(r => r.json());

  const scene = new THREE.Scene();
  scene.background = null;

  // camera
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0, 3.0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // lights — subtle, because we mostly draw lines/points
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 0.3);
  dir.position.set(1, 1, 2);
  scene.add(dir);

  // orbit controls
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.minDistance = 1.2;
  controls.maxDistance = 10;

  // ------ mesh wireframe ------
  const mergedEdges = [
    ...topology.tesselation,
  ].map(([a, b]) => [a, b]);
  const highlightEdges = [
    ...topology.faceOval,
    ...topology.lips,
    ...topology.leftEye,
    ...topology.rightEye,
    ...topology.leftEyebrow,
    ...topology.rightEyebrow,
  ];
  const irisEdges = [
    ...topology.leftIris,
    ...topology.rightIris,
  ];

  const meshLineGeo = makeLineGeometry(mergedEdges, 478);
  const meshLineMat = new THREE.LineBasicMaterial({ color: 0x6cb4a0, transparent: true, opacity: 0.25 });
  const meshLines = new THREE.LineSegments(meshLineGeo, meshLineMat);
  scene.add(meshLines);

  const highlightGeo = makeLineGeometry(highlightEdges, 478);
  const highlightMat = new THREE.LineBasicMaterial({ color: 0x6cb4a0, transparent: true, opacity: 0.95 });
  const highlightLines = new THREE.LineSegments(highlightGeo, highlightMat);
  scene.add(highlightLines);

  const irisGeo = makeLineGeometry(irisEdges, 478);
  const irisMat = new THREE.LineBasicMaterial({ color: 0x5b8fb9, transparent: true, opacity: 0.95 });
  const irisLines = new THREE.LineSegments(irisGeo, irisMat);
  scene.add(irisLines);

  // ------ points (478) ------
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(478 * 3), 3));
  pointsGeo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(478 * 3), 3));
  const pointsMat = new THREE.PointsMaterial({
    size: 0.012,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    sizeAttenuation: true
  });
  const points = new THREE.Points(pointsGeo, pointsMat);
  scene.add(points);

  // ------ baseline mesh (ghost) ------
  const baselineGeo = makeLineGeometry(
    [...topology.tesselation, ...highlightEdges],
    478
  );
  const baselineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 });
  const baselineLines = new THREE.LineSegments(baselineGeo, baselineMat);
  baselineLines.visible = false;
  scene.add(baselineLines);

  // ------ sizing ------
  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ------ state ------
  let baselinePts = null;   // Float32Array [478*3]
  let colorizeByBaseline = false;
  let visibility = { mesh: true, points: true, features: true, baseline: false };

  // ------ API ------
  function setBaseline(pts) {
    baselinePts = pts ? pts.slice() : null;
    if (baselinePts) {
      const posAttr = baselineGeo.getAttribute('position');
      for (let i = 0; i < 478; i++) writePoint(posAttr.array, i, baselinePts, i);
      posAttr.needsUpdate = true;
    }
  }

  function setFrame(pts) {
    // pts は [[x,y,z], ...] 生フレーム（0-1 正規化）
    const posLines = meshLineGeo.getAttribute('position').array;
    const posHigh  = highlightGeo.getAttribute('position').array;
    const posIris  = irisGeo.getAttribute('position').array;
    const posPts   = pointsGeo.getAttribute('position').array;
    const colPts   = pointsGeo.getAttribute('color').array;

    // Normalize into a flat Float32Array centered around origin
    const flat = new Float32Array(478 * 3);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // MediaPipe: x right, y down; 中心に持ってきてスケール調整 + y 反転
      flat[i*3]     = (p[0] - 0.5) * 2.0;
      flat[i*3 + 1] = -(p[1] - 0.5) * 2.0;
      flat[i*3 + 2] = -p[2] * 2.0;   // z is forward-positive for MediaPipe; flip for THREE camera
    }

    // Update wireframe line geometries
    writeAllLines(posLines, mergedEdges, flat);
    writeAllLines(posHigh,  highlightEdges, flat);
    writeAllLines(posIris,  irisEdges, flat);
    meshLineGeo.getAttribute('position').needsUpdate = true;
    highlightGeo.getAttribute('position').needsUpdate = true;
    irisGeo.getAttribute('position').needsUpdate = true;

    // Update points
    for (let i = 0; i < 478; i++) {
      posPts[i*3]     = flat[i*3];
      posPts[i*3 + 1] = flat[i*3 + 1];
      posPts[i*3 + 2] = flat[i*3 + 2];
    }
    // Colorize by baseline delta if requested
    if (colorizeByBaseline && baselinePts && baselinePts.length === 478 * 3) {
      for (let i = 0; i < 478; i++) {
        const dx = flat[i*3]     - baselinePts[i*3];
        const dy = flat[i*3 + 1] - baselinePts[i*3 + 1];
        const dz = flat[i*3 + 2] - baselinePts[i*3 + 2];
        const mag = Math.sqrt(dx*dx + dy*dy + dz*dz);
        // clamp to 0..0.08 for full spectrum
        const t = Math.min(1, mag / 0.08);
        // teal → yellow → red gradient
        if (t < 0.5) {
          const u = t * 2;
          colPts[i*3]     = 0.42 + u * (1 - 0.42);   // r
          colPts[i*3 + 1] = 0.70 + u * (0.85 - 0.70);// g
          colPts[i*3 + 2] = 0.62 - u * 0.62;         // b
        } else {
          const u = (t - 0.5) * 2;
          colPts[i*3]     = 1.0;
          colPts[i*3 + 1] = 0.85 - u * 0.6;
          colPts[i*3 + 2] = 0.0;
        }
      }
    } else {
      for (let i = 0; i < 478; i++) {
        colPts[i*3]     = 0.42;
        colPts[i*3 + 1] = 0.70;
        colPts[i*3 + 2] = 0.62;
      }
    }
    pointsGeo.getAttribute('position').needsUpdate = true;
    pointsGeo.getAttribute('color').needsUpdate = true;
  }

  function setVisibility(opts) {
    Object.assign(visibility, opts);
    meshLines.visible      = visibility.mesh;
    points.visible         = visibility.points;
    highlightLines.visible = visibility.features;
    irisLines.visible      = visibility.features;
    baselineLines.visible  = visibility.baseline && baselinePts !== null;
  }

  function setColorizeByBaseline(flag) { colorizeByBaseline = flag; }

  function setRotationFromMatrix(mat16) {
    // column-major 4x4; optional — apply to the whole face group
    // (for v1, skip — the face already sits in normalized coords)
    // Could be implemented later if we want to align to captured head pose.
    void mat16;
  }

  // ------ render loop ------
  let rafId = null;
  function start() {
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function dispose() {
    stop();
    ro.disconnect();
    renderer.dispose();
    [meshLineGeo, highlightGeo, irisGeo, pointsGeo, baselineGeo].forEach(g => g.dispose());
    [meshLineMat, highlightMat, irisMat, pointsMat, baselineMat].forEach(m => m.dispose());
  }

  return {
    setFrame, setBaseline, setVisibility, setColorizeByBaseline,
    setRotationFromMatrix, start, stop, dispose,
    resize
  };
}

// ---------- helpers ----------
function makeLineGeometry(edges, numPoints) {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(edges.length * 2 * 3);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.userData.edges = edges;
  geom.userData.numPoints = numPoints;
  return geom;
}
function writeAllLines(positionArray, edges, flatPts) {
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    positionArray[i*6]     = flatPts[a*3];
    positionArray[i*6 + 1] = flatPts[a*3 + 1];
    positionArray[i*6 + 2] = flatPts[a*3 + 2];
    positionArray[i*6 + 3] = flatPts[b*3];
    positionArray[i*6 + 4] = flatPts[b*3 + 1];
    positionArray[i*6 + 5] = flatPts[b*3 + 2];
  }
}
function writePoint(arr, dstIndex, srcArr, srcIndex) {
  arr[dstIndex*3]     = srcArr[srcIndex*3];
  arr[dstIndex*3 + 1] = srcArr[srcIndex*3 + 1];
  arr[dstIndex*3 + 2] = srcArr[srcIndex*3 + 2];
}
