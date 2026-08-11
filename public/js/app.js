/*
 * app.js — application entry point.
 * fetches config, initialises the 3d scene, loads the library,
 * wires controls, ui, and starts the animation loop.
 */

import { SceneManager } from './scene/scene-manager.js';
import { createRoom } from './scene/room.js';
import { Shelves, computeStoreDims } from './scene/shelves.js';
import { createKiosk } from './scene/kiosk.js';
import { createSign } from './scene/signage.js';
import { createWallPosters, createStockBanner, createCurtain } from './scene/decor.js';
import { createCheckoutCounter } from './scene/checkout.js';
import { createEmployeeOfMonth } from './scene/employee-plaque.js';
import { createStorefront, STOREFRONT_WIDTH } from './scene/storefront.js';
import { createPromoDisplays } from './scene/promo.js';
import { createDustParticles } from './scene/effects.js';
import { FirstPersonControls } from './controls/first-person.js';
import { setupPointerLock } from './controls/pointer-lock.js';
import { CaseRaycaster } from './controls/raycaster.js';
import * as THREE from 'three';
import { ImageLoader } from './api/image-loader.js';
import { fetchConfig, fetchItems, fetchRecommendations } from './api/media-api.js';
import { setConfig } from './config.js';
import { createLoadingScreen } from './ui/loading-screen.js';
import { createHUD } from './ui/hud.js';
import { createModal } from './ui/modal.js';
import { createSearch } from './ui/search.js';
import { createBrowse2D } from './ui/browse-2d.js';
import { createStoreAudio } from './ui/audio.js';
import store from './store.js';

async function main() {
  // ---- loading screen ----
  const loadingScreen = createLoadingScreen();
  loadingScreen.setProgress(0);

  // ---- fetch config from backend ----
  let config;
  try {
    config = await fetchConfig();
    setConfig(config);
    store.libraries = config.sections || [];
    if (config.sections && config.sections.length > 0) {
      store.activeSectionId = config.sections[0].key;
    }
    store.setLoadingProgress(0.15);
  } catch (err) {
    loadingScreen.setProgress(0, `failed to connect: ${err.message}. check that the server is running.`);
    return;
  }

  // ---- init three.js scene ----
  // if webgl is unavailable, fall back to the 2d browse mode
  const canvas = document.getElementById('store-canvas');
  let sceneManager;
  try {
    sceneManager = new SceneManager(canvas);
  } catch (err) {
    console.warn('[app] webgl unavailable, falling back to 2d mode:', err.message);
    loadingScreen.hide();
    canvas.style.display = 'none';
    createModal();
    createBrowse2D();
    store.setMode('2d');
    return;
  }
  loadingScreen.setProgress(0.25);

  // fetch a full section catalogue in pages
  async function fetchAllItems(sectionId, label) {
    const PAGE = 1000;
    const first = await fetchItems(sectionId, { start: 0, size: PAGE, sort: 'titleSort:asc' });
    const collected = first.items || [];
    const total = first.totalSize || collected.length;

    while (collected.length < total) {
      loadingScreen.setProgress(
        0.25 + 0.3 * (collected.length / total),
        `stocking the ${label} shelves... ${collected.length} of ${total}`,
      );
      const page = await fetchItems(sectionId, {
        start: collected.length, size: PAGE, sort: 'titleSort:asc',
      });
      if (!page.items || page.items.length === 0) break;
      collected.push(...page.items);
    }
    return collected;
  }

  // movies room + tv room stock — merge every library of each type
  let allItems = [];
  let tvItems = [];
  try {
    const movieSections = store.libraries.filter(l => l.type === 'movie');
    const tvSections = store.libraries.filter(l => l.type === 'show');

    if (movieSections.length > 0) {
      store.activeSectionId = movieSections[0].key;
      for (const section of movieSections) {
        allItems.push(...await fetchAllItems(section.key, 'film'));
      }
    }
    for (const section of tvSections) {
      tvItems.push(...await fetchAllItems(section.key, 'tv'));
    }

    store.itemOrder = allItems.map(i => i.ratingKey);
    for (const item of [...allItems, ...tvItems]) {
      store.items.set(item.ratingKey, item);
    }
    store.setLoadingProgress(0.6);
  } catch (err) {
    console.error('[app] failed to fetch items:', err.message);
    const serverName = config.serverType === 'jellyfin' ? 'jellyfin' : 'plex';
    loadingScreen.setProgress(0.6, `failed to load library. check that ${serverName} is running.`);
    return;
  }

  // the back room claims the 18+ titles — they shelve only back there
  const ADULT_RATINGS = new Set(['NC-17', '18+', 'X', 'XXX']);
  const backroomItems = allItems.filter(i => ADULT_RATINGS.has(i.contentRating));
  const shopItems = allItems.filter(i => !ADULT_RATINGS.has(i.contentRating));

  // ---- movies room (main) ----
  const dims = computeStoreDims(allItems.length);
  // doorway to the tv room in the left wall, near the entrance end;
  // doorway to the 18+ back room in the right wall, towards the back
  const doorZOffset = dims.depth / 2 - 8;
  const backDoorZ = -dims.depth / 2 + 6;
  const movieRoom = createRoom(sceneManager.scene, {
    ...dims,
    marquee: 'hollywoodplex',
    mainLighting: true,
    doorways: {
      // the glass storefront fills this opening — collision keeps it shut
      front: [{ offset: 0, width: STOREFRONT_WIDTH }],
      ...(tvItems.length > 0 ? { left: [{ offset: doorZOffset, width: 3.5 }] } : {}),
      ...(backroomItems.length > 0 ? { right: [{ offset: backDoorZ, width: 2 }] } : {}),
    },
  });

  // glass entrance looking out on the night-time car park
  const storefront = createStorefront(sceneManager.scene, dims);
  loadingScreen.setProgress(0.65);

  // llm-curated shelves — served from the server-side cache, so this
  // resolves instantly; missing shelves just don't appear
  let llmFeatured = [];
  let llmAisle = [];
  try {
    const recs = await fetchRecommendations();
    const byKey = new Map(shopItems.map(i => [String(i.ratingKey), i]));
    for (const shelf of recs.shelves || []) {
      const picks = (shelf.items || [])
        .filter(r => byKey.has(String(r.ratingKey)))
        .map(r => ({ ...byKey.get(String(r.ratingKey)), reason: r.reason }));
      if (picks.length === 0) continue;
      const section = { title: shelf.title, items: picks, accent: shelf.accent };
      if (shelf.placement === 'aisle') llmAisle.push(section);
      else llmFeatured.push(section);
    }
  } catch (err) {
    console.warn('[app] recommendations unavailable:', err.message);
  }

  const imageLoader = new ImageLoader();
  const shelves = new Shelves(sceneManager.scene, imageLoader);
  loadingScreen.setProgress(0.7, 'arranging the aisles...');
  shelves.populate(shopItems, dims, llmFeatured, {
    extraAisle: llmAisle,
    // wall shelving skips the doorway spans
    wallDoorways: {
      left: tvItems.length > 0 ? [{ offset: doorZOffset, width: 3.5 }] : [],
      right: backroomItems.length > 0 ? [{ offset: backDoorZ, width: 2 }] : [],
    },
    // family sections steer clear of the wall units by this door
    ...(backroomItems.length > 0
      ? { adultDoor: { x: dims.width / 2, z: backDoorZ } }
      : {}),
  });

  // ---- tv room through the doorway ----
  let tvShelves = null;
  let tvRoom = null;
  if (tvItems.length > 0) {
    const tvDims = computeStoreDims(tvItems.length, 30);
    // align the tv room so its front wall lines up with the doorway zone
    const tvCx = -dims.width / 2 - tvDims.width / 2;
    const tvCz = doorZOffset + 4.5 - tvDims.depth / 2;
    tvRoom = createRoom(sceneManager.scene, {
      ...tvDims,
      cx: tvCx,
      cz: tvCz,
      marquee: 'tv shows',
      mainLighting: false,
      skipWalls: ['right'], // shares the movie room's left wall
    });
    tvShelves = new Shelves(sceneManager.scene, imageLoader);
    tvShelves.populate(tvItems, { ...tvDims, cx: tvCx, cz: tvCz }, [], {
      // the shared wall's doorway, in tv-room-local z
      wallDoorways: { right: [{ offset: doorZOffset - tvCz, width: 3.5 }] },
    });

    // doorway signs mounted flat on the wall above the door opening:
    // tv shows on the movies side, movies on the tv side. the shared
    // wall is 0.2m thick at x = -width/2, so each sign sits just off
    // its face, rotated to face into its room
    const doorSign = createSign('TV Shows', {
      x: -dims.width / 2 + 0.13,
      y: 3.7,
      z: doorZOffset,
    }, '#42c9a0', { hanging: false, rotationY: Math.PI / 2 });
    sceneManager.scene.add(doorSign);

    const returnSign = createSign('Movies', {
      x: -dims.width / 2 - 0.13,
      y: 3.7,
      z: doorZOffset,
    }, '#d42027', { hanging: false, rotationY: Math.PI / 2 });
    sceneManager.scene.add(returnSign);
  }

  // ---- the 18+ back room, behind a bead curtain off the right wall ----
  let backShelves = null;
  let backRoom = null;
  if (backroomItems.length > 0) {
    const backDims = { width: 10, depth: 8, cx: dims.width / 2 + 5, cz: backDoorZ };
    backRoom = createRoom(sceneManager.scene, {
      ...backDims,
      marquee: null,
      mainLighting: false,
      style: 'dingy',
      skipWalls: ['left'], // shares the movie room's right wall
    });
    backShelves = new Shelves(sceneManager.scene, imageLoader);
    backShelves.populate(backroomItems, backDims, [], {
      plainTitle: 'Staff Only',
      plainAccent: '#d42027',
    });

    // bead curtain hanging in the doorway
    const curtain = createCurtain(
      new THREE.Vector3(dims.width / 2, 0, backDoorZ), 2, Math.PI / 2,
    );
    sceneManager.scene.add(curtain);

    // warning sign above the door on the shop side
    const adultSign = createSign('18+ Only', {
      x: dims.width / 2 - 0.13,
      y: 3.7,
      z: backDoorZ,
    }, '#d42027', { hanging: false, rotationY: -Math.PI / 2 });
    sceneManager.scene.add(adultSign);
  }
  store.setLoadingProgress(0.8);

  // spawn just inside the entrance, facing the featured racks
  sceneManager.camera.position.set(0, 1.7, dims.depth / 2 - 1.5);
  sceneManager.camera.lookAt(0, 1.7, dims.depth / 2 - 10);

  // search kiosk beside the entrance
  const kiosk = createKiosk(new THREE.Vector3(dims.width / 2 - 3, 0, dims.depth / 2 - 3));
  sceneManager.scene.add(kiosk.mesh);

  // ---- store atmosphere ----
  // checkout counter on the other side of the entrance, facing the door
  const counter = createCheckoutCounter(
    new THREE.Vector3(-dims.width / 2 + 6, 0, dims.depth / 2 - 2.5), Math.PI,
  );
  sceneManager.scene.add(counter.group);

  // employee of the month plaque on the wall behind the counter,
  // offset so it clears the framed release posters either side
  sceneManager.scene.add(createEmployeeOfMonth(
    new THREE.Vector3(-dims.width / 2 + 5.2, 2.05, dims.depth / 2 - 0.17), Math.PI,
  ));

  // framed posters high on the walls: the latest releases, like the
  // promo one-sheets a store would hang for new stock
  const releaseDate = (i) => i.originallyAvailableAt
    ? Date.parse(i.originallyAvailableAt) || 0
    : (i.year ? Date.UTC(i.year, 0, 1) : 0);
  const posterPicks = [...shopItems]
    .filter(i => releaseDate(i) > 0)
    .sort((a, b) => releaseDate(b) - releaseDate(a));
  createWallPosters(sceneManager.scene, movieRoom.dimensions, posterPicks, 20,
    { frontClear: STOREFRONT_WIDTH / 2 + 1.2 });

  // entrance promo dressing: a-frames with the newest releases,
  // popcorn and soda by the window, and the 3-d glasses standee
  const promo = createPromoDisplays(sceneManager.scene, dims, posterPicks);
  if (tvRoom) {
    const tvPicks = [...tvItems]
      .filter(i => releaseDate(i) > 0)
      .sort((a, b) => releaseDate(b) - releaseDate(a));
    createWallPosters(sceneManager.scene, tvRoom.dimensions, tvPicks, 10);
  }

  // gold guaranteed-in-stock banner over the entrance walkway,
  // in front of the featured racks so it clears their hanging signs
  const banner = createStockBanner(new THREE.Vector3(0, 4.35, dims.depth / 2 - 2.3));
  sceneManager.scene.add(banner);

  store.setLoadingProgress(0.85);

  // atmospheric effects
  const dust = createDustParticles(sceneManager.scene, movieRoom.dimensions);
  store.setLoadingProgress(0.9);

  // ---- controls ----
  const controls = new FirstPersonControls(sceneManager.camera, canvas);
  controls.setCollisionBoxes([
    ...shelves.getCollisionBoxes(),
    ...movieRoom.collisionBoxes,
    ...storefront.collisionBoxes,
    ...promo.collisionBoxes,
    ...counter.collisionBoxes,
    ...(tvShelves ? tvShelves.getCollisionBoxes() : []),
    ...(tvRoom ? tvRoom.collisionBoxes : []),
    ...(backShelves ? backShelves.getCollisionBoxes() : []),
    ...(backRoom ? backRoom.collisionBoxes : []),
  ]);

  // ambient store audio — starts on the first pointer lock gesture
  const audio = createStoreAudio();
  store.on('audio-muted', (m) => hud.showMessage(m ? 'audio muted' : 'audio on', 2000));

  // pointer lock
  const pointerLock = setupPointerLock(canvas,
    () => {
      // on lock
      controls.enable();
      audio.startMuzak();
      hud.showMessage('wasd to move, mouse to look, click cases to view, m to mute', 5000);
    },
    () => {
      // on unlock
      controls.disable();
      hud.showMessage('click to explore', 0);
    },
  );

  // raycaster for case interaction — instanced case meshes plus the kiosk
  const raycaster = new CaseRaycaster(sceneManager.camera, canvas, sceneManager.scene);
  raycaster.setTargets(
    [{ mesh: kiosk.mesh, item: { isKiosk: true } }],
    [
      shelves.getInstancedTarget(),
      tvShelves ? tvShelves.getInstancedTarget() : null,
      backShelves ? backShelves.getInstancedTarget() : null,
    ],
  );

  // warp the player to a film's case when picked from search, and
  // flash a pulsing outline on the case so it stands out on the shelf
  let locateFlash = null;
  store.on('locate-item', (ratingKey) => {
    const cases = shelves.caseByKey.get(ratingKey)
      || (tvShelves && tvShelves.caseByKey.get(ratingKey))
      || (backShelves && backShelves.caseByKey.get(ratingKey));
    if (!cases || cases.length === 0) return;
    const target = cases[cases.length - 1]; // genre-aisle copy over featured
    const pos = target.position;
    // stand 1.6m out along the direction the case faces (works for
    // wall shelves facing any axis, not just gondolas facing z)
    const fx = Math.sin(target.rotationY);
    const fz = Math.cos(target.rotationY);
    sceneManager.camera.position.set(pos.x + fx * 1.6, 1.7, pos.z + fz * 1.6);
    sceneManager.camera.lookAt(pos.x, pos.y, pos.z);

    // highlight flash for a few seconds
    if (locateFlash) {
      sceneManager.scene.remove(locateFlash.mesh);
      clearTimeout(locateFlash.timer);
    }
    const flashMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.55, 0.08),
      new THREE.MeshBasicMaterial({
        color: '#f0c419', transparent: true, opacity: 0.45, depthWrite: false,
      }),
    );
    flashMesh.position.copy(pos);
    flashMesh.quaternion.copy(target.quat);
    sceneManager.scene.add(flashMesh);
    const timer = setTimeout(() => {
      sceneManager.scene.remove(flashMesh);
      flashMesh.geometry.dispose();
      flashMesh.material.dispose();
      locateFlash = null;
    }, 3500);
    locateFlash = { mesh: flashMesh, timer };
  });

  // ---- ui ----
  const hud = createHUD();
  hud.show();

  const modal = createModal();
  const search = createSearch();
  const browse2d = createBrowse2D();

  // ---- animation loop ----
  sceneManager.onAnimate((dt) => {
    controls.update(dt);
    const playerPos = controls.getPosition();

    // update visibility-based texture loading (throttled internally)
    shelves.updateVisible(playerPos, sceneManager.camera, dt);
    if (tvShelves) tvShelves.updateVisible(playerPos, sceneManager.camera, dt);
    if (backShelves) backShelves.updateVisible(playerPos, sceneManager.camera, dt);

    // update raycaster (throttled internally)
    raycaster.update(dt);

    // update kiosk
    if (kiosk.update) kiosk.update(dt);

    // update dust particles
    if (dust.update) dust.update(dt);

    // back room bulb flicker
    if (backRoom && backRoom.update) backRoom.update(dt);

    // storefront neon: open sign buzz and the broken brandys b
    if (storefront.update) storefront.update(dt);

    // promo animations: the jaws 3-d shark lunge
    if (promo.update) promo.update(dt);

    // footsteps while moving
    const moving = store.isPointerLocked
      && controls.velocity && controls.velocity.lengthSq() > 0.5;
    audio.update(dt, moving);

    // update hud with the current room and its stock count
    let hudInfo;
    if (tvRoom && playerPos.x < -dims.width / 2) {
      hudInfo = `tv shows — ${tvItems.length} titles`;
    } else if (backRoom && playerPos.x > dims.width / 2) {
      hudInfo = `the back room — ${backroomItems.length} titles`;
    } else {
      hudInfo = `movies — ${shopItems.length} films`;
    }
    hud.update(playerPos, hudInfo);
  });

  // react to mode changes
  store.on('mode-changed', (mode) => {
    if (mode === '2d') {
      pointerLock.exitLock();
      controls.disable();
      canvas.style.display = 'none';
      hud.hide();
    } else {
      canvas.style.display = 'block';
      hud.show();
      hud.showMessage('click to explore', 3000);
    }
  });

  // overlays (search, film card) release the mouse so their buttons
  // are clickable, and re-capture it when they close in 3d mode
  store.on('overlay-opened', () => {
    if (store.isPointerLocked) pointerLock.exitLock();
  });
  store.on('overlay-closed', () => {
    if (store.mode === '3d') pointerLock.requestLock();
  });

  // ---- start ----
  sceneManager.start();
  store.setLoadingProgress(1);
  loadingScreen.setProgress(1, 'the store is open');

  // hide loading screen after a brief delay
  setTimeout(() => {
    loadingScreen.hide();
    hud.showMessage('click to explore the store', 0);
  }, 500);

  // ---- debug ----
  if (typeof window !== 'undefined') {
    window.__hollywodplex = {
      store,
      sceneManager,
      shelves,
      controls,
      imageLoader,
      getStats: () => ({
        imageCache: imageLoader.getCacheStats(),
        itemCount: allItems.length,
        mode: store.mode,
        locked: store.isPointerLocked,
      }),
    };
  }
}

// wait for dom ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
