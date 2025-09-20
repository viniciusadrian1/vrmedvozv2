// Cena 3D: Three.js + WebXR + GLTF do pulmão (ES Modules)
import * as THREE from 'three';
import { OrbitControls } from '/node_modules/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { VRButton } from '/node_modules/three/examples/jsm/webxr/VRButton.js';
import { XRControllerModelFactory } from '/node_modules/three/examples/jsm/webxr/XRControllerModelFactory.js';

let renderer, scene, camera, controls;
let lungRoot = null, placeholderMesh = null, axesHelper = null;
let controller1, controller2, controllerGrip1, controllerGrip2;
let raycaster, tempMatrix = new THREE.Matrix4();
let group; // Grupo para manipulação em VR
let selectedObject = null;
let previousScale = 1;

// Variáveis para movimento em VR
let dolly, dummyCam;
let prevGamePads = new Map();

window.addEventListener('DOMContentLoaded', () => {
  console.log('DOMContentLoaded - iniciando cena com ES Modules');
  init();
  animate();
});

function init() {
  console.log('init() chamado');
  const container = document.getElementById('canvas-container');
  if (!container) {
    console.error('Container #canvas-container não encontrado');
    return;
  }

  // Renderer com WebXR habilitado
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const rect = container.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height);
  renderer.xr.enabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Cena
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  // Grupo para movimento em VR (dolly)
  dolly = new THREE.Group();
  dolly.position.set(0, 0, 0);
  scene.add(dolly);

  // Câmera
  camera = new THREE.PerspectiveCamera(60, rect.width / rect.height, 0.01, 100);
  camera.position.set(0.5, 1.6, 1.5); // Altura dos olhos aproximada
  dolly.add(camera);

  // Dummy camera para cálculos
  dummyCam = new THREE.Object3D();
  camera.add(dummyCam);

  // Grupo para o modelo (permite manipulação)
  group = new THREE.Group();
  group.position.set(0, 1.3, 0); // 1.30m do chão
  scene.add(group);

  // Luzes
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
  dir1.position.set(1, 2, 1);
  dir1.castShadow = true;
  scene.add(dir1);
  
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
  dir2.position.set(-1, 0.5, -0.5);
  scene.add(dir2);

  // Chão visual para referência
  const floorGeo = new THREE.PlaneGeometry(10, 10);
  const floorMat = new THREE.MeshStandardMaterial({ 
    color: 0x1e293b,
    roughness: 0.8,
    metalness: 0.2
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Grid para referência espacial
  const grid = new THREE.GridHelper(10, 20, 0x334155, 0x1e293b);
  scene.add(grid);

  // Eixos de referência
  axesHelper = new THREE.AxesHelper(0.2);
  group.add(axesHelper);

  // Placeholder
  const placeholderGeo = new THREE.BoxGeometry(0.1, 0.3, 0.1);
  const placeholderMat = new THREE.MeshStandardMaterial({ color: 0x22c55e });
  placeholderMesh = new THREE.Mesh(placeholderGeo, placeholderMat);
  placeholderMesh.castShadow = true;
  group.add(placeholderMesh);

  // Controles para modo desktop
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.3;
  controls.maxDistance = 5.0;
  controls.target.set(0, 1.3, 0);
  controls.enabled = !renderer.xr.isPresenting;

  // Configuração VR
  setupVR();

  // Carrega o modelo
  const loader = new GLTFLoader();
  loader.load(
    'models/lung.glb',
    (gltf) => {
      lungRoot = gltf.scene || gltf.scenes[0];
      centerAndScaleModel(lungRoot);
      
      // Habilita sombras no modelo
      lungRoot.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      
      group.add(lungRoot);
      
      if (placeholderMesh) {
        group.remove(placeholderMesh);
        placeholderMesh.geometry.dispose();
        placeholderMesh.material.dispose();
        placeholderMesh = null;
      }
      console.log('Pulmão carregado com sucesso');
    },
    (xhr) => {
      if (xhr.total) {
        const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
        if (pct % 10 === 0) console.log(`Carregando pulmão: ${pct}%`);
      }
    },
    (error) => {
      console.error('Falha ao carregar models/lung.glb', error);
    }
  );

  // Botão VR
  document.getElementById('vrButtonContainer').appendChild(VRButton.createButton(renderer));

  // Botões de controle
  document.getElementById('resetCameraBtn').addEventListener('click', resetCamera);
  document.getElementById('toggleAxesBtn').addEventListener('click', () => {
    if (axesHelper) axesHelper.visible = !axesHelper.visible;
  });
  document.getElementById('mouseModeBtn').addEventListener('click', () => {
    if (renderer?.xr?.isPresenting) {
      const session = renderer.xr.getSession();
      if (session) session.end();
    }
  });

  // Eventos
  window.addEventListener('resize', onWindowResize);
  renderer.xr.addEventListener('sessionstart', onXRSessionStart);
  renderer.xr.addEventListener('sessionend', onXRSessionEnd);
}

function setupVR() {
  // Raycaster para seleção
  raycaster = new THREE.Raycaster();

  // Factory para modelos de controles
  const controllerModelFactory = new XRControllerModelFactory();

  // Controller 1 (geralmente mão direita)
  controller1 = renderer.xr.getController(0);
  controller1.addEventListener('selectstart', onSelectStart);
  controller1.addEventListener('selectend', onSelectEnd);
  controller1.addEventListener('connected', (event) => {
    controller1.gamepad = event.data.gamepad;
    controller1.add(buildController(event.data));
  });
  controller1.addEventListener('disconnected', () => {
    controller1.remove(controller1.children[0]);
    controller1.gamepad = null;
  });
  dolly.add(controller1);

  // Controller 2 (geralmente mão esquerda)
  controller2 = renderer.xr.getController(1);
  controller2.addEventListener('selectstart', onSelectStart);
  controller2.addEventListener('selectend', onSelectEnd);
  controller2.addEventListener('connected', (event) => {
    controller2.gamepad = event.data.gamepad;
    controller2.add(buildController(event.data));
  });
  controller2.addEventListener('disconnected', () => {
    controller2.remove(controller2.children[0]);
    controller2.gamepad = null;
  });
  dolly.add(controller2);

  // Grip controls (modelos 3D dos controles)
  controllerGrip1 = renderer.xr.getControllerGrip(0);
  controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
  dolly.add(controllerGrip1);

  controllerGrip2 = renderer.xr.getControllerGrip(1);
  controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
  dolly.add(controllerGrip2);
}

function buildController(data) {
  let geometry, material;
  
  switch (data.targetRayMode) {
    case 'tracked-pointer':
      // Linha de raio para apontar
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute([0.5, 0.5, 0.5, 0, 0, 0], 3));
      material = new THREE.LineBasicMaterial({ 
        vertexColors: true, 
        blending: THREE.AdditiveBlending,
        linewidth: 2
      });
      return new THREE.Line(geometry, material);
      
    case 'gaze':
      // Cursor para eye tracking
      geometry = new THREE.RingGeometry(0.02, 0.03, 32).translate(0, 0, -1);
      material = new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true });
      return new THREE.Mesh(geometry, material);
      
    default:
      return new THREE.Group();
  }
}

function onSelectStart(event) {
  const controller = event.target;
  const intersections = getIntersections(controller);
  
  if (intersections.length > 0) {
    const intersection = intersections[0];
    const object = intersection.object;
    
    // Verifica se é o modelo do pulmão ou seu grupo
    if (object.parent === group || object === group) {
      selectedObject = group;
      controller.attach(selectedObject);
      controller.userData.selected = selectedObject;
      previousScale = selectedObject.scale.x;
    }
  }
}

function onSelectEnd(event) {
  const controller = event.target;
  
  if (controller.userData.selected !== undefined) {
    const object = controller.userData.selected;
    scene.attach(object);
    controller.userData.selected = undefined;
    selectedObject = null;
  }
}

function getIntersections(controller) {
  tempMatrix.identity().extractRotation(controller.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  
  const intersects = raycaster.intersectObjects(group.children, true);
  return intersects;
}

function handleVRMovement() {
  if (!renderer.xr.isPresenting) return;
  
  const session = renderer.xr.getSession();
  if (!session || !session.inputSources) return;
  
  session.inputSources.forEach((source) => {
    if (source.gamepad) {
      const gamepad = source.gamepad;
      const axes = gamepad.axes;
      
      // Thumbstick esquerdo para movimento (axes 2 e 3)
      if (axes.length >= 4) {
        const x = axes[2];
        const y = axes[3];
        
        // Deadzone para evitar drift
        const deadzone = 0.1;
        if (Math.abs(x) > deadzone || Math.abs(y) > deadzone) {
          // Movimento baseado na direção da câmera
          const speed = 0.02;
          const direction = new THREE.Vector3();
          camera.getWorldDirection(direction);
          direction.y = 0;
          direction.normalize();
          
          const right = new THREE.Vector3();
          right.crossVectors(direction, new THREE.Vector3(0, 1, 0));
          
          dolly.position.addScaledVector(right, x * speed);
          dolly.position.addScaledVector(direction, -y * speed);
        }
      }
      
      // Botões para ações adicionais
      if (gamepad.buttons.length > 0) {
        // Botão A/X - Reset posição do modelo
        if (gamepad.buttons[4] && gamepad.buttons[4].pressed) {
          if (!prevGamePads.get(source.handedness)?.buttons[4]?.pressed) {
            group.position.set(0, 1.3, 0);
            group.rotation.set(0, 0, 0);
            group.scale.set(1, 1, 1);
          }
        }
        
        // Grip buttons para escala quando segurando
        if (selectedObject && gamepad.buttons[1] && gamepad.buttons[1].pressed) {
          const scaleSpeed = gamepad.buttons[1].value * 0.01;
          const newScale = Math.max(0.1, Math.min(3, selectedObject.scale.x + scaleSpeed));
          selectedObject.scale.set(newScale, newScale, newScale);
        }
      }
      
      // Salva estado anterior
      prevGamePads.set(source.handedness, {
        buttons: gamepad.buttons.map(b => ({pressed: b.pressed, value: b.value})),
        axes: [...gamepad.axes]
      });
    }
  });
}

function centerAndScaleModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Centraliza na origem
  root.position.sub(center);

  // Escala para 30cm de altura
  const targetHeight = 0.30;
  const currentHeight = size.y || 1.0;
  const scale = targetHeight / currentHeight;
  root.scale.setScalar(scale);

  // Não precisa ajustar Y pois o grupo já está a 1.30m
  root.position.y = 0;
}

function resetCamera() {
  if (renderer.xr.isPresenting) {
    // Em VR, reseta a posição do dolly
    dolly.position.set(0, 0, 0);
    group.position.set(0, 1.3, 0);
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
  } else {
    // Desktop
    camera.position.set(0.5, 1.6, 1.5);
    controls.target.set(0, 1.3, 0);
    controls.update();
  }
}

function onXRSessionStart() {
  console.log('VR Session iniciada');
  controls.enabled = false;
}

function onXRSessionEnd() {
  console.log('VR Session finalizada');
  controls.enabled = true;
  // Retorna o modelo para a cena principal
  if (selectedObject) {
    scene.attach(selectedObject);
    selectedObject = null;
  }
}

function onWindowResize() {
  const container = document.getElementById('canvas-container');
  const rect = container.getBoundingClientRect();
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
  renderer.setSize(rect.width, rect.height);
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render() {
  // Movimento em VR
  handleVRMovement();
  
  // Atualiza controles desktop
  if (controls && controls.enabled) {
    controls.update();
  }
  
  // Animação do placeholder
  if (placeholderMesh) {
    placeholderMesh.rotation.y += 0.01;
  }
  
  // Animação suave de rotação quando não selecionado
  if (lungRoot && !selectedObject && renderer.xr.isPresenting) {
    lungRoot.rotation.y += 0.002;
  }
  
  renderer.render(scene, camera);
}

// Log de erros
window.addEventListener('error', (e) => {
  console.error('GlobalError:', e.message, e.filename, e.lineno);
});