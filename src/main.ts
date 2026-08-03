import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import GUI from 'lil-gui';
import {
    drawWaveTrain,
    drawSetMeter,
    drawSwellRadar,
    drawTrimGauge,
    type RiderReadout,
} from './instruments';
import {
    verticalOrbitalVelocity,
    MAX_COMPONENTS,
    buildWaveField,
    surfaceAtWorldPos,
    waterHeightFast,
    analyseSwell,
    dominantSwell,
    periodToWavelength,
    periodToPhaseSpeed,
    type SwellSpec,
    type WaveField,
} from './waves';

const BASE = import.meta.env.BASE_URL;

// --- GAME PARAMETERS ---
const SPAWN_POINT = new THREE.Vector3(0, 0, -800);

const PARAMS = {

    waterColor: '#004466',
    foamColor: '#ffffff',
    sunElevation: 85,
    sunAzimuth: 180,
    turbidity: 40,
    rayleigh: 0.12,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.8,
    fogColor: '#d6edff',
    fogDensity: 0.002,
    ambientIntensity: 0.05,
    hemiIntensity: 20.0,
    dirIntensity: 0.5,  
    showWireframe: false,
    selectedFoil: 'Downwind 900',
    chaseCamera: true,
};

// --- FOIL CONFIGURATION ---
interface FoilConfig {
    name: string;
    wingSpan: number;       // m
    wingArea: number;       // m^2
    chord: number;          // m, mean = area / span
    aspectRatio: number;    // span^2 / area
    baseDragCoeff: number;  // CD_0 of the section
    turnRateMax: number;    // rad/s, falls with span and aspect ratio
}

// Area in cm^2 is how foils are actually sold, so it names the presets.
// Aspect ratio is span^2/area, and it drives everything else through the
// lifting-line slope 2*pi*AR/(AR+2): higher AR lifts harder per degree and
// carries less induced drag, at the cost of turning and low-speed manners.
function makeFoil(
    name: string, span: number, areaCm2: number, cd0: number, turn: number
): FoilConfig {
    const area = areaCm2 / 10000;
    return {
        name,
        wingSpan: span,
        wingArea: area,
        chord: area / span,
        aspectRatio: (span * span) / area,
        baseDragCoeff: cd0,
        turnRateMax: turn,
    };
}

const FOIL_PRESETS: Record<string, FoilConfig> = {
    'Beginner 1600':   makeFoil('Beginner 1600',   1.15, 1600, 0.0130, 1.60),
    'Cruiser 1200':    makeFoil('Cruiser 1200',    1.15, 1200, 0.0110, 1.35),
    'Mid Aspect 1000': makeFoil('Mid Aspect 1000', 1.05, 1000, 0.0100, 1.50),
    'Downwind 900':    makeFoil('Downwind 900',    1.10,  900, 0.0090, 1.20),
    'High Aspect 800': makeFoil('High Aspect 800', 1.05,  800, 0.0080, 1.10),
    'Race 700':        makeFoil('Race 700',        1.00,  700, 0.0075, 1.00),
    'Ultra HA 600':    makeFoil('Ultra HA 600',    0.98,  600, 0.0070, 0.85),
};

let activeFoil: FoilConfig = { ...FOIL_PRESETS['Downwind 900'] };

// --- RACE CONFIGURATION ---
let RACE_LENGTH_KM = 1; // total race distance — changed via intro HUD picker
const RACE_START_Z = SPAWN_POINT.z; // player starts here; race km marks are at RACE_START_Z + k*1000

// Returns how far the player has travelled directly downwind (Z-axis progress).
// This aligns with the physical buoy/gate positions and is used for all race logic.
// distanceTravelled (total path length) is kept separately for display.
function downwindDist(): number {
    return Math.max(0, foilState.position.z - RACE_START_Z);
}

// --- PHYSICS CONSTANTS ---
// Gravitational acceleration — scales lift-to-weight ratio and wave slope energy
const GRAVITY = 9.81;
// Seawater density (kg/m³) — multiplier in all lift and drag force calculations
const RHO_WATER = 1025;
// Rider + gear mass (kg). Heavier needs more speed to fly and more foot
// pressure to hold altitude, so it is a real difficulty dial.
let riderMass = 85;
// Foil mast length (m) — caps maximum ride height above the water surface
const MAST_LENGTH = 0.8;
// Mast frontal area for drag (m²) — higher = more speed bleed from the submerged mast
const MAST_DRAG_AREA = 0.0007;
// Velocity kick (m/s) added per pump — higher = bigger speed burst each pump
const PUMP_IMPULSE = 2.5;
// Energy spent per pump — higher = fewer pumps before you're drained
const PUMP_COST = 20;
// Minimum seconds between pumps — prevents spam-pumping for free speed
const PUMP_COOLDOWN = 0.35;
// Energy recovered per second — controls how quickly you can pump again
const ENERGY_REGEN = 5;
// Max bank angle (~30°) — limits how hard you can lean into turns
const MAX_ROLL = Math.PI / 6;
// Max pitch angle (~5°) — visual board attitude, driven by foot pressure
const MAX_PITCH = Math.PI / 36;
// --- Foil aerodynamics (hydrodynamics) ---
// Trim angle of attack at neutral foot pressure (deg). Sets the natural
// cruising speed: the foil flies where lift from this AoA equals rider weight.
const ALPHA_NEUTRAL = 2.4 * Math.PI / 180;
// AoA authority from full front-to-back foot pressure (deg either side).
// To fly parallel to a sloping surface the rider must change flight path angle
// by roughly the surface slope, which needs a comparable change in angle of
// attack. Wave faces here reach 12-13 degrees, so 5 degrees left the rider
// unable to follow a face at all — they simply sank through it.
const ALPHA_RANGE = 9.0 * Math.PI / 180;
// Stall angle — beyond this CL collapses and you fall off foil.
const ALPHA_STALL = 15.0 * Math.PI / 180;
// Wing depth (m) below which the foil starts ventilating and loses lift.
// This is the breach mechanic: fly too high and the wing sucks air.
const VENT_DEPTH = 0.30;
// How fast foot pressure follows input (1/s) — rider weight-shift rate.
const FOOT_RESPONSE = 4.5;
// Extra vertical damping beyond the natural AoA feedback.
const HEAVE_DAMPING = 0.6;
// Roll spring stiffness — higher = snappier response to turn input
const ROLL_SPRING = 6.0;
// Roll damping — higher = less oscillation, smoother settling into turns
const ROLL_DAMPING = 3.0;
// Wave-induced roll strength — higher = more wobble from uneven wave surface across the wing
const WAVE_TORQUE_GAIN = 2.0;
// Wave thrust multiplier. The term below is physically derived, so 1.0 is the
// honest value; this only exists to exaggerate or damp it for feel.
const WAVE_ENERGY_MULT = 1.0;
// Sideways slip decay rate — higher = tighter tracking along heading, less drift in turns
const LATERAL_RESISTANCE = 1.0;
// Air density (kg/m^3) for the aerodynamic force on rider and board
const RHO_AIR = 1.225;
// Drag area (CD * frontal area, m^2) of a standing rider plus board
const RIDER_DRAG_AREA = 0.62;

// True wind. A foiler feels APPARENT wind — true wind minus their own velocity
// — so running downwind at close to wind speed the push nearly vanishes, and
// outrunning the wind turns it into a headwind. Modelled that way rather than
// as a constant shove.
const WIND = {
    enabled: true,
    speed: 12,      // m/s true wind
    direction: 0,   // degrees, direction the wind blows TOWARD (0 = +Z downwind)
    force: 1.0,     // multiplier, for exaggerating the effect
};

/**
 * Speed at which the foil flies level at neutral foot pressure — the natural
 * cruise for this wing and this rider. Solving L = m*g at the trim angle:
 *   V = sqrt( 2*m*g / (rho * A * CL_alpha * alpha_trim) )
 */
function trimSpeedFor(foil: FoilConfig, mass: number): number {
    const clAlpha = (2 * Math.PI * foil.aspectRatio) / (foil.aspectRatio + 2);
    return Math.sqrt(
        (2 * mass * GRAVITY) / (RHO_WATER * foil.wingArea * clAlpha * ALPHA_NEUTRAL)
    );
}

/**
 * Minimum flying speed: where the wing at stall angle can just carry the
 * rider. Derived rather than configured, so it tracks both foil area and
 * rider weight.
 */
function stallSpeedFor(foil: FoilConfig, mass: number): number {
    const clAlpha = (2 * Math.PI * foil.aspectRatio) / (foil.aspectRatio + 2);
    const clMax = clAlpha * ALPHA_STALL;
    return Math.sqrt((2 * mass * GRAVITY) / (RHO_WATER * foil.wingArea * clMax));
}

// --- PHYSICS STATE ---
const foilState = {
    position: SPAWN_POINT.clone(),
    velocity: new THREE.Vector3(0, 0, 0),
    heading: 0,
    pitch: 0,
    roll: 0,
    rollRate: 0,
    rideHeight: 0.35,
    /** World-frame vertical velocity of the board, m/s. */
    vy: 0,
    /** World-frame altitude of the board, m. rideHeight = worldY - surfaceY. */
    worldY: 0.35,
    /** Water surface height under the board this frame, m. */
    surfaceY: 0,
    onFoil: true,
    energy: 100,
    speed: 0,
    lastPumpTime: -10,
    distanceTravelled: 0,
    // --- Foil flight state (read by the instrument cluster) ---
    /** Rider fore/aft weight shift. -1 = all front foot, +1 = all back foot. */
    footPressure: 0,
    /** Foot pressure that would hold altitude right now — the target to chase. */
    footPressureTrim: 0,
    /** Current angle of attack at the wing, radians. */
    alpha: 0,
    /** Geometric trim angle the rider is holding, radians. */
    alphaTrim: 0,
    /** Angle of the oncoming water relative to the flight path, radians. */
    inflowAngle: 0,
    /** Lift as a multiple of rider weight. 1.0 = holding altitude. */
    loadFactor: 1,
    /** Wing depth below the surface, m. Zero means breached. */
    wingDepth: MAST_LENGTH - 0.35,
    /** 0 = fully ventilated (no lift), 1 = clean flow. */
    ventFactor: 1,
    /** Vertical water velocity at the wing, m/s. Positive = rising. */
    orbitalW: 0,
    /** Forward thrust from the wave this frame, N. */
    waveThrust: 0,
    /** Apparent wind speed at the rider, m/s. */
    apparentWind: 0,
    /** Apparent wind bearing, radians (direction it blows toward). */
    apparentWindDir: 0,
    /** Why the last crash happened, for the HUD message. */
    crashReason: '' as '' | 'breach' | 'touchdown' | 'stall',
};

type GameState = 'starting' | 'riding' | 'crashed';
let gameState: GameState = 'starting';

// --- RACE STATE ---
interface RaceData {
    active: boolean;
    finished: boolean;
    startTime: number;
    kmSplitTimes: number[]; // elapsed seconds when each km was reached
    lastKmReached: number;
    totalElapsed: number;
    splitFlashText: string;
    splitFlashTimer: number;
}

const race: RaceData = {
    active: false,
    finished: false,
    startTime: 0,
    kmSplitTimes: [],
    lastKmReached: 0,
    totalElapsed: 0,
    splitFlashText: '',
    splitFlashTimer: 0,
};

function resetRace() {
    race.active = false;
    race.finished = false;
    race.startTime = 0;
    race.kmSplitTimes = [];
    race.lastKmReached = 0;
    race.totalElapsed = 0;
    race.splitFlashText = '';
    race.splitFlashTimer = 0;
}

function startRace(clockTime: number) {
    race.active = true;
    race.finished = false;
    race.startTime = clockTime;
    race.kmSplitTimes = [];
    race.lastKmReached = 0;
    race.totalElapsed = 0;
    race.splitFlashText = '';
    race.splitFlashTimer = 0;
}

function fmtTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// --- GLOBAL LEADERBOARD (App Engine Datastore) ---
const API_BASE = '/downwind-sim/api';
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

interface LeaderboardEntry {
    name: string;
    time: number;
    date: string;
    foil: string;
}

const MOCK_LEADERBOARD: LeaderboardEntry[] = [
    { name: 'WaveDave', time: 52.3, date: '', foil: 'High Aspect Race' },
    { name: 'FoilQueen', time: 55.8, date: '', foil: 'High Aspect Race' },
    { name: 'BumpRider', time: 58.1, date: '', foil: 'Mid Aspect Cruise' },
    { name: 'GlideKing', time: 61.4, date: '', foil: 'High Aspect Race' },
    { name: 'OceanAce', time: 64.7, date: '', foil: 'High Aspect Race' },
    { name: 'WindChaser', time: 67.2, date: '', foil: 'Mid Aspect Cruise' },
    { name: 'SwellHunter', time: 70.0, date: '', foil: 'High Aspect Race' },
    { name: 'TideRunner', time: 73.5, date: '', foil: 'Mid Aspect Cruise' },
    { name: 'ReefPilot', time: 76.9, date: '', foil: 'High Aspect Race' },
    { name: 'FoamChaser', time: 80.1, date: '', foil: 'Mid Aspect Cruise' },
];

function getStoredPlayerName(): string {
    try { return localStorage.getItem('downwind-player-name') || ''; } catch { return ''; }
}

function setStoredPlayerName(name: string) {
    try { localStorage.setItem('downwind-player-name', name); } catch { /* ignore */ }
}

// The global leaderboard lives behind an API on the game's own host. Builds
// served from anywhere else (a fork, a static preview) have no such endpoint,
// so track availability and hide the score UI rather than showing a submit
// button that can only fail.
let leaderboardAvailable = true;

async function fetchLeaderboard(km: number): Promise<LeaderboardEntry[]> {
    if (IS_LOCAL) return MOCK_LEADERBOARD;
    try {
        const res = await fetch(`${API_BASE}/scores?km=${km}`);
        if (!res.ok) { leaderboardAvailable = false; return []; }
        const data = await res.json();
        return data.scores || [];
    } catch {
        leaderboardAvailable = false;
        return [];
    }
}

async function submitScore(
    km: number, time: number, name: string, foil: string
): Promise<{ rank: number; isNew: boolean }> {
    if (IS_LOCAL) {
        console.log('[DEV] submitScore:', { km, time, name, foil });
        return { rank: 1, isNew: true };
    }
    try {
        const res = await fetch(`${API_BASE}/scores`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ km, time, name, foil }),
        });
        if (!res.ok) return { rank: 0, isNew: false };
        return await res.json();
    } catch {
        return { rank: 0, isNew: false };
    }
}

let scoreSubmitted = false;

let cachedTop3HTML = '';

async function refreshStartScreenLeaderboard() {
    const scores = await fetchLeaderboard(RACE_LENGTH_KM);
    const limit = isMobile ? 5 : 10;
    const top = scores.slice(0, limit);
    if (top.length === 0) {
        cachedTop3HTML = '';
        return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    let html = `<div class="hud-lb-title">TOP TIMES — ${RACE_LENGTH_KM} km</div>`;
    for (let i = 0; i < top.length; i++) {
        const s = top[i];
        const rank = medals[i] || `${i + 1}.`;
        html += `<div class="hud-lb-row"><span class="hud-lb-rank">${rank}</span> ${escapeHTML(s.name)} <span class="hud-lb-time">${fmtTime(s.time)}</span></div>`;
    }
    cachedTop3HTML = html;
}

refreshStartScreenLeaderboard();

// --- INPUT STATE ---
const input = {
    left: false,
    right: false,
    up: false,
    down: false,
    pump: false,
    steerX: 0,
    pitchY: 0,
};

// --- MOBILE ---
const isMobile = matchMedia('(pointer: coarse)').matches;

if (isMobile) {
    document.body.style.touchAction = 'manipulation';
}

let useChaseCamera = PARAMS.chaseCamera;

// --- HELPER FUNCTIONS ---
function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function headingToDir(heading: number): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
}

function resetFoilState() {
    foilState.position.copy(SPAWN_POINT);
    foilState.velocity.set(0, 0, 0);
    foilState.heading = 0;
    foilState.pitch = 0;
    foilState.roll = 0;
    foilState.rollRate = 0;
    foilState.rideHeight = 0.35;
    foilState.vy = 0;
    foilState.worldY = 0.35;
    foilState.surfaceY = 0;
    foilState.onFoil = true;
    foilState.energy = 100;
    foilState.speed = 0;
    foilState.lastPumpTime = -10;
    foilState.distanceTravelled = 0;
    foilState.footPressure = 0;
    foilState.footPressureTrim = 0;
    foilState.alpha = 0;
    foilState.loadFactor = 1;
    foilState.wingDepth = MAST_LENGTH - 0.35;
    foilState.ventFactor = 1;
    foilState.orbitalW = 0;
    foilState.crashReason = '';
    gameState = 'starting';
    prevGameState = null;
    clearWakeTrail();
    clearBubbles();
    resetRace();
    resetGpsPath();
    hideFinishOverlay();
    // Reset the lateral tracking so the course re-centres on X=0
    raceTrackX = 0;
    finishGate.position.x = 0;
}

function launchFoil() {
    const initialSpeed = trimSpeedFor(activeFoil, riderMass) * 1.15;
    const dir = headingToDir(foilState.heading);
    foilState.velocity.copy(dir.multiplyScalar(initialSpeed));
    foilState.rideHeight = 0.45;
    // Start in equilibrium with the surface the rider is about to fly over.
    //
    // What matters is not the water's local vertical velocity but the rate the
    // surface changes UNDER A MOVING RIDER: d(eta)/dt + v . grad(eta). Matching
    // only the orbital term still left the board sinking through steep faces,
    // and launching at an unlucky wave phase killed the run instantly. Measure
    // the following rate directly and match it.
    {
        const t0 = clock.elapsedTime;
        const dt = 0.05;
        const h0 = getSurfaceInfoAtWorldPos(
            foilState.position.x, foilState.position.z, t0
        ).position.y;
        const h1 = getSurfaceInfoAtWorldPos(
            foilState.position.x + foilState.velocity.x * dt,
            foilState.position.z + foilState.velocity.z * dt,
            t0 + dt
        ).position.y;
        foilState.vy = (h1 - h0) / dt;
    }
    foilState.surfaceY = getSurfaceInfoAtWorldPos(
        foilState.position.x, foilState.position.z, clock.elapsedTime
    ).position.y;
    foilState.worldY = foilState.surfaceY + 0.45;
    foilState.footPressure = 0;
    foilState.crashReason = '';
    foilState.onFoil = true;
    gameState = 'riding';
}


// --- SEA STATE ---
// Two independent swell systems plus wind chop. Each is specified the way a
// forecast reads it — significant height, peak period, direction — and expanded
// into a band of spectral components by buildWaveField(), so wave groups (sets)
// emerge from the physics instead of being faked.
// Presets are the three buttons; 'custom' is what a row becomes once the
// height or period slider is touched.
type SwellPreset = 'small' | 'medium' | 'large';
type SwellSize = SwellPreset | 'custom';

// Size presets per swell system, as (significant height, peak period). Bigger
// swell runs longer period too, the way a real sea state scales.
// Period, not height, decides whether a wave is ridable. Crest speed is
// c = g*T/2pi, so an 8 s wave runs at 24 kt and a 13 s wave at 39 kt — both
// faster than a foiler, so they just roll underneath. Matching a 9-10 m/s
// rider means T ~ 5-7 s, which is 40-75 m between bumps. That is the band
// people actually downwind in, so the primary swell lives there.
const SWELL_SIZES: Record<SwellPreset, { height: number; period: number }>[] = [
    {   // Primary — the bumps you ride.
        //
        // Height is limited by STEEPNESS, not by looks. To fly parallel to a
        // wave face the rider must change flight-path angle by roughly the
        // surface slope, and they only have so much angle of attack before the
        // wing stalls. The original game ran Hs 4.15 m on a 40 m wavelength —
        // 10.4% steepness, about double anything real — which demanded ~19
        // degrees of AoA to follow. It got away with it because its ride height
        // was a spring toward a target, not a flying wing. With real flight
        // dynamics that sea cannot be ridden, so these stay near 4% steepness:
        // still big faces, but on wavelengths long enough to fly.
        small: { height: 1.6, period: 5.5 },
        medium: { height: 2.6, period: 6.5 },
        large: { height: 3.2, period: 8.0 },
    },
    {   // Secondary — groundswell you ride over, not on
        small: { height: 0.8, period: 10.0 },
        medium: { height: 1.2, period: 12.0 },
        large: { height: 1.8, period: 14.0 },
    },
    {   // Wind chop — texture underfoot
        small: { height: 0.55, period: 3.0 },
        medium: { height: 0.85, period: 3.6 },
        large: { height: 1.00, period: 4.3 },
    },
];

/** How a swell's crest speed compares with a foiler's realistic top speed. */
function ridability(period: number): { text: string; color: string } {
    const kt = periodToPhaseSpeed(period) * 1.944;
    if (kt <= 22) return { text: 'rideable', color: '#4ade80' };
    if (kt <= 30) return { text: 'hard to catch', color: '#fbbf24' };
    return { text: 'rolls under you', color: '#ef5350' };
}

const swellSize: SwellSize[] = ['medium', 'medium', 'medium'];
const SIZE_BUTTONS: SwellPreset[] = ['small', 'medium', 'large'];
const SWELL_COLORS = ['#60a5fa', '#a78bfa', '#94a3b8'];

const SWELLS: SwellSpec[] = [
    {
        name: 'Primary swell',
        enabled: true,
        height: SWELL_SIZES[0].medium.height,
        period: SWELL_SIZES[0].medium.period,
        direction: 0,       // straight downwind (+Z)
        spread: 10,
        // Deliberately few components. Spreading Hs over a broad spectrum is
        // more realistic but leaves no single wave large enough to see or ride;
        // concentrating it gives a dominant bump, like the original's discrete
        // sines. Three still beat against each other, so sets still form.
        components: 3,
        bandwidth: 0.05,
    },
    {
        name: 'Secondary swell',
        enabled: true,
        height: SWELL_SIZES[1].medium.height,
        period: SWELL_SIZES[1].medium.period,
        direction: 30,      // crossing from the left
        spread: 14,
        components: 8,
        bandwidth: 0.05,
    },
    {
        name: 'Wind chop',
        enabled: true,
        height: SWELL_SIZES[2].medium.height,
        period: SWELL_SIZES[2].medium.period,
        direction: 6,
        spread: 32,
        components: 5,
        bandwidth: 0.18,
    },
];

const SWELL_DEFAULTS = SWELLS.map(s => ({ ...s }));

let waveField: WaveField = buildWaveField(SWELLS);

// --- THREE.JS SETUP ---
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
// renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
//scene.background = new THREE.Color('#87ceeb');
scene.fog = new THREE.FogExp2(PARAMS.fogColor, PARAMS.fogDensity);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(SPAWN_POINT.x, 30, SPAWN_POINT.z - 50);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(SPAWN_POINT);
controls.maxPolarAngle = Math.PI / 2 - 0.05;

// --- MOBILE VIRTUAL JOYSTICK & TAP HANDLER (must come after canvas creation) ---
if (isMobile) {
    controls.enabled = false;
    canvas.style.touchAction = 'none';

    const touchOverlay = document.createElement('div');
    touchOverlay.id = 'mobile-touch-overlay';
    Object.assign(touchOverlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '150',
        touchAction: 'none',
        WebkitTapHighlightColor: 'transparent',
    });
    document.body.appendChild(touchOverlay);

    const joyOuter = document.createElement('div');
    Object.assign(joyOuter.style, {
        position: 'fixed',
        width: '120px',
        height: '120px',
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.3)',
        background: 'rgba(255,255,255,0.06)',
        pointerEvents: 'none',
        display: 'none',
        zIndex: '200',
    });
    document.body.appendChild(joyOuter);

    const joyKnob = document.createElement('div');
    Object.assign(joyKnob.style, {
        position: 'absolute',
        width: '48px',
        height: '48px',
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.3)',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
    });
    joyOuter.appendChild(joyKnob);

    let joyTouchId: number | null = null;
    let joyCX = 0;
    let joyCY = 0;

    const JOY_R = 70;
    const JOY_DEAD = 14;
    const TAP_MS = 250;
    const TAP_PX = 18;

    const tStarts = new Map<number, { x: number; y: number; t: number }>();

    function doTap() {
        if (gameState === 'starting') launchFoil();
        else if (gameState === 'riding' && !race.finished) input.pump = true;
        else if (gameState === 'crashed' || race.finished) resetFoilState();
    }

    function setJoyInput(dx: number, dy: number) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < JOY_DEAD) {
            input.steerX = 0;
            input.pitchY = 0;
            return;
        }
        const f = Math.min((d - JOY_DEAD) / (JOY_R - JOY_DEAD), 1);
        input.steerX = (dx / d) * f;
        input.pitchY = (dy / d) * f;
    }

    function posKnob(dx: number, dy: number) {
        const d = Math.sqrt(dx * dx + dy * dy);
        const c = Math.min(d, JOY_R);
        const s = d > 0 ? c / d : 0;
        joyKnob.style.transform =
            `translate(calc(-50% + ${dx * s}px), calc(-50% + ${dy * s}px))`;
    }

    touchOverlay.addEventListener('touchstart', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            tStarts.set(t.identifier, {
                x: t.clientX, y: t.clientY, t: performance.now(),
            });

            if (joyTouchId === null && t.clientY > window.innerHeight * 0.45) {
                joyTouchId = t.identifier;
                joyCX = t.clientX;
                joyCY = t.clientY;
                joyOuter.style.left = (t.clientX - 60) + 'px';
                joyOuter.style.top = (t.clientY - 60) + 'px';
                joyOuter.style.display = 'block';
                joyKnob.style.transform = 'translate(-50%, -50%)';
            }
        }
    }, { passive: false });

    touchOverlay.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            if (t.identifier === joyTouchId) {
                const dx = t.clientX - joyCX;
                const dy = t.clientY - joyCY;
                posKnob(dx, dy);
                setJoyInput(dx, dy);
            }
        }
    }, { passive: false });

    function onTouchEnd(e: TouchEvent) {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const s = tStarts.get(t.identifier);
            tStarts.delete(t.identifier);

            const tap = s &&
                (performance.now() - s.t) < TAP_MS &&
                Math.hypot(t.clientX - s.x, t.clientY - s.y) < TAP_PX;

            if (t.identifier === joyTouchId) {
                joyTouchId = null;
                joyOuter.style.display = 'none';
                input.steerX = 0;
                input.pitchY = 0;
                if (tap) doTap();
            } else if (tap) {
                doTap();
            }
        }
    }

    touchOverlay.addEventListener('touchend', onTouchEnd, { passive: false });
    touchOverlay.addEventListener('touchcancel', onTouchEnd, { passive: false });
}

// --- LIGHTING & ENVIRONMENT ---
const ambientLight = new THREE.AmbientLight(0xffffff, PARAMS.ambientIntensity);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x000000, PARAMS.hemiIntensity);
hemiLight.position.set(30, 200, 20);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffeedd, PARAMS.dirIntensity);
dirLight.castShadow = false;
scene.add(dirLight);
scene.add(dirLight.target);

const sky = new Sky();
sky.scale.setScalar(10000);
scene.add(sky);

const skyUniforms = sky.material.uniforms;
skyUniforms['turbidity'].value = PARAMS.turbidity;
skyUniforms['rayleigh'].value = PARAMS.rayleigh;
skyUniforms['mieCoefficient'].value = PARAMS.mieCoefficient;
skyUniforms['mieDirectionalG'].value = PARAMS.mieDirectionalG;

const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

let renderTarget: THREE.WebGLRenderTarget | null = null;
const sunDirection = new THREE.Vector3();

function updateEnvironment() {
    const phi = THREE.MathUtils.degToRad(90 - PARAMS.sunElevation);
    const theta = THREE.MathUtils.degToRad(PARAMS.sunAzimuth);

    sunDirection.setFromSphericalCoords(1, phi, theta);

    skyUniforms['sunPosition'].value.copy(sunDirection);
    skyUniforms['turbidity'].value = PARAMS.turbidity;
    skyUniforms['rayleigh'].value = PARAMS.rayleigh;
    skyUniforms['mieCoefficient'].value = PARAMS.mieCoefficient;
    skyUniforms['mieDirectionalG'].value = PARAMS.mieDirectionalG;

    (scene.fog as THREE.FogExp2).color.set(PARAMS.fogColor);
    (scene.fog as THREE.FogExp2).density = PARAMS.fogDensity;

    if (renderTarget) renderTarget.dispose();
    renderTarget = pmremGenerator.fromScene(sky as any);
    scene.environment = renderTarget.texture;
}

updateEnvironment();

// --- PRE-BAKED NOISE TEXTURE ---
const NOISE_SIZE = 512;
const NOISE_GRID_PERIOD = 8;

function generateNoiseTexture(size: number, gridPeriod: number): THREE.DataTexture {
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 255; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const p = new Uint16Array(512);
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

    const GRAD: [number, number][] = [
        [1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]
    ];

    function fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }

    function perlin(x: number, y: number, period: number): number {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const x0 = ((xi % period) + period) % period;
        const x1 = ((xi + 1) % period + period) % period;
        const y0 = ((yi % period) + period) % period;
        const y1 = ((yi + 1) % period + period) % period;
        const u = fade(xf), v = fade(yf);
        const dot = (h: number, fx: number, fy: number) => { const g = GRAD[h & 7]; return g[0]*fx + g[1]*fy; };
        const aa = p[p[x0]+y0], ab = p[p[x0]+y1], ba = p[p[x1]+y0], bb = p[p[x1]+y1];
        return (1-v) * ((1-u)*dot(aa,xf,yf) + u*dot(ba,xf-1,yf)) +
                  v  * ((1-u)*dot(ab,xf,yf-1) + u*dot(bb,xf-1,yf-1));
    }

    function fbm(x: number, y: number): number {
        let f = 0, freq = 1;
        const amps = [0.5, 0.25, 0.125, 0.0625];
        for (let i = 0; i < 4; i++) {
            f += amps[i] * perlin(x * freq, y * freq, gridPeriod * freq);
            freq *= 2;
        }
        return f;
    }

    const values = new Float32Array(size * size);
    for (let j = 0; j < size; j++)
        for (let i = 0; i < size; i++)
            values[j * size + i] = fbm((i / size) * gridPeriod, (j / size) * gridPeriod);

    const texelSize = gridPeriod / size;
    const data = new Float32Array(size * size * 4);
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const idx = j * size + i;
            const dx = (values[j*size + (i+1)%size] - values[j*size + (i-1+size)%size]) / (2 * texelSize);
            const dy = (values[((j+1)%size)*size + i] - values[((j-1+size)%size)*size + i]) / (2 * texelSize);
            data[idx*4]   = values[idx];
            data[idx*4+1] = dx;
            data[idx*4+2] = dy;
            data[idx*4+3] = 1;
        }
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

const noiseTexture = generateNoiseTexture(NOISE_SIZE, NOISE_GRID_PERIOD);

// --- WATER SHADER ---
/**
 * Water grid with vertex density graded toward the centre.
 *
 * The mesh follows the player, so its centre is always under the board. A
 * uniform 1500x2000 grid spread its vertices evenly and gave 2.9 m quads
 * everywhere, which samples a 16 m chop wave about four times — it aliased
 * into ripples. Warping the spacing gives sub-metre quads near the rider and
 * coarse ones out in the fog, for the same vertex count.
 *
 * warp(t) = k*|t| + (1-k)*|t|^3, so k sets near-field density directly:
 * centre spacing is halfSize * k * (2/segments).
 */
function createGradedWaterGeometry(
    halfX: number, halfZ: number, segX: number, segZ: number, k: number
): THREE.BufferGeometry {
    const nx = segX + 1;
    const nz = segZ + 1;
    const positions = new Float32Array(nx * nz * 3);

    const warp = (t: number) => {
        const a = Math.abs(t);
        return Math.sign(t) * (k * a + (1 - k) * a * a * a);
    };

    for (let j = 0; j < nz; j++) {
        const z = warp((j / segZ) * 2 - 1) * halfZ;
        for (let i = 0; i < nx; i++) {
            const x = warp((i / segX) * 2 - 1) * halfX;
            const o = (j * nx + i) * 3;
            positions[o] = x;
            positions[o + 1] = 0;
            positions[o + 2] = z;
        }
    }

    const index = new Uint32Array(segX * segZ * 6);
    let p = 0;
    for (let j = 0; j < segZ; j++) {
        for (let i = 0; i < segX; i++) {
            const a = j * nx + i;
            const b = a + 1;
            const c = a + nx;
            const d = c + 1;
            index[p++] = a; index[p++] = c; index[p++] = b;
            index[p++] = b; index[p++] = c; index[p++] = d;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Normals come from the Gerstner tangents in the vertex shader; these
    // attributes only need to exist for the standard material chunks.
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nx * nz * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nx * nz * 2), 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    return geo;
}

const waterGeometry = createGradedWaterGeometry(750, 1000, 512, isMobile ? 384 : 512, 0.12);

const waterMaterial = new THREE.MeshStandardMaterial({
    color: PARAMS.waterColor,
    roughness: 0.05,
    metalness: 0.9,
    wireframe: PARAMS.showWireframe,
    side: THREE.DoubleSide
});

// Wave components are uploaded as flat uniform arrays so the component count
// can change at runtime (swell edits) without recompiling the shader.
//   uWaveDirAmp[i]     = (dirX, dirZ, amplitude, wavenumber)
//   uWaveOmegaPhase[i] = (angularFrequency, phaseOffset)
const waveDirAmpBuf = new Float32Array(MAX_COMPONENTS * 4);
const waveOmegaPhaseBuf = new Float32Array(MAX_COMPONENTS * 2);

const waterUniforms = {
    uTime: { value: 0 },
    uWindSpeed: { value: 1.0 },
    uWorldOffset: { value: new THREE.Vector2(0, 0) },
    uNoiseTexture: { value: noiseTexture },
    uNoisePeriod: { value: NOISE_GRID_PERIOD },
    uWaveDirAmp: { value: waveDirAmpBuf },
    uWaveOmegaPhase: { value: waveOmegaPhaseBuf },
    uWaveCount: { value: 0 },
    uVizSlope: { value: 0 },
    uVizHeight: { value: 0 },
    uVizContour: { value: 0 },
    uVizFoam: { value: 0 },
    uVizFace: { value: 0 },
    uVizGrid: { value: 0 },
    uRideDir: { value: new THREE.Vector2(0, 1) },
    uWaveScale: { value: 2.0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
};

/** Push the current wave field into the GPU uniform buffers. */
function uploadWaveField() {
    const comps = waveField.components;
    const n = Math.min(comps.length, MAX_COMPONENTS);
    for (let i = 0; i < n; i++) {
        const w = comps[i];
        waveDirAmpBuf[i * 4] = w.dx;
        waveDirAmpBuf[i * 4 + 1] = w.dz;
        waveDirAmpBuf[i * 4 + 2] = w.amp;
        waveDirAmpBuf[i * 4 + 3] = w.k;
        waveOmegaPhaseBuf[i * 2] = w.omega;
        waveOmegaPhaseBuf[i * 2 + 1] = w.phase;
    }
    for (let i = n; i < MAX_COMPONENTS; i++) {
        waveDirAmpBuf[i * 4 + 2] = 0; // zero amplitude = inert
    }
    waterUniforms.uWaveCount.value = n;

    // Ripple/micro-normal strength tracks the wind chop swell.
    const chop = SWELLS[2];
    waterUniforms.uWindSpeed.value = chop.enabled
        ? THREE.MathUtils.clamp(chop.height / 0.35, 0.15, 3.0)
        : 0.15;

    if (comps.length > MAX_COMPONENTS) {
        console.warn(
            `Wave field has ${comps.length} components, capped at ${MAX_COMPONENTS}.`
        );
    }
}

uploadWaveField();

// Debug hook: inspect and drive the sim from the browser console.
// Dev-only — in production this would be a one-line leaderboard cheat.
if (import.meta.env.DEV) (window as any).__sea = {
    get field() { return waveField; },
    get swells() { return SWELLS; },
    get state() { return gameState; },
    get foil() { return foilState; },
    get input() { return input; },
    get time() { return clock.elapsedTime; },
    rebuild: () => rebuildWaveField(),
    launch: () => launchFoil(),
    reset: () => resetFoilState(),
    /** Advance physics by a fixed step — deterministic, frame-rate independent. */
    step: (dt: number, t: number) => updatePhysics(dt, t),
    height: (x: number, z: number, t: number) => waterHeightFast(waveField, x, z, t),
    analyse: (i: number, x: number, z: number, t: number) =>
        analyseSwell(waveField, i, x, z, t),
};

waterMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.uniforms.uWindSpeed = waterUniforms.uWindSpeed;
    shader.uniforms.uWorldOffset = waterUniforms.uWorldOffset;
    shader.uniforms.uNoiseTexture = waterUniforms.uNoiseTexture;
    shader.uniforms.uNoisePeriod = waterUniforms.uNoisePeriod;
    shader.uniforms.uWaveDirAmp = waterUniforms.uWaveDirAmp;
    shader.uniforms.uWaveOmegaPhase = waterUniforms.uWaveOmegaPhase;
    shader.uniforms.uWaveCount = waterUniforms.uWaveCount;
    shader.uniforms.uVizSlope = waterUniforms.uVizSlope;
    shader.uniforms.uVizHeight = waterUniforms.uVizHeight;
    shader.uniforms.uVizContour = waterUniforms.uVizContour;
    shader.uniforms.uVizFoam = waterUniforms.uVizFoam;
    shader.uniforms.uVizFace = waterUniforms.uVizFace;
    shader.uniforms.uVizGrid = waterUniforms.uVizGrid;
    shader.uniforms.uRideDir = waterUniforms.uRideDir;
    shader.uniforms.uWaveScale = waterUniforms.uWaveScale;
    shader.uniforms.uSunDir = waterUniforms.uSunDir;

    shader.vertexShader = `
        #define MAX_WAVE_COMPONENTS ${MAX_COMPONENTS}

        uniform float uTime;
        uniform vec2 uWorldOffset;
        uniform vec4 uWaveDirAmp[MAX_WAVE_COMPONENTS];
        uniform vec2 uWaveOmegaPhase[MAX_WAVE_COMPONENTS];
        uniform int uWaveCount;

        varying vec3 vGridPos;
        varying vec3 vViewTangent;
        varying vec3 vViewBinormal;
        varying vec3 vWorldPos;
        varying vec3 vWaveNormal;
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `
        // Use world-space position so waves stay fixed in the world
        // even when the water mesh is moved to follow the player
        vec3 gridPoint = position + vec3(uWorldOffset.x, 0.0, uWorldOffset.y);
        vec3 waveTangent = vec3(1.0, 0.0, 0.0);
        vec3 waveBinormal = vec3(0.0, 0.0, 1.0);
        vec3 p = gridPoint;

        // Gerstner sum. Must match waterDisplacement() in waves.ts exactly,
        // otherwise the rider desyncs from the visible surface.
        for (int i = 0; i < MAX_WAVE_COMPONENTS; i++) {
            if (i >= uWaveCount) break;

            vec4 da = uWaveDirAmp[i];
            vec2 dir = da.xy;
            float a = da.z;
            float k = da.w;
            float omega = uWaveOmegaPhase[i].x;
            float phase = uWaveOmegaPhase[i].y;

            float f = k * dot(dir, gridPoint.xz) - omega * uTime + phase;
            float sf = sin(f);
            float cf = cos(f);
            float steep = a * k;

            p += vec3(dir.x * a * cf, a * sf, dir.y * a * cf);

            waveTangent += vec3(
                -dir.x * dir.x * steep * sf,
                 dir.x * steep * cf,
                -dir.x * dir.y * steep * sf
            );

            waveBinormal += vec3(
                -dir.x * dir.y * steep * sf,
                 dir.y * steep * cf,
                -dir.y * dir.y * steep * sf
            );
        }

        vec3 objectNormal = normalize(cross(waveBinormal, waveTangent));
        // Convert displaced world position back to object space
        vec3 displacedPosition = p - vec3(uWorldOffset.x, 0.0, uWorldOffset.y);

        vGridPos = gridPoint; // world-space for ripple UVs
        vViewTangent = normalize(normalMatrix * waveTangent);
        vViewBinormal = normalize(normalMatrix * waveBinormal);
        vWorldPos = p;                 // displaced, world space
        vWaveNormal = objectNormal;    // mesh is unrotated, so this is world space
        `
    );

    shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        vec3 transformed = displacedPosition;
        `
    );

    shader.fragmentShader = `
        uniform float uTime;
        uniform float uWindSpeed;
        uniform sampler2D uNoiseTexture;
        uniform float uNoisePeriod;

        uniform float uVizSlope;
        uniform float uVizHeight;
        uniform float uVizContour;
        uniform float uVizFoam;
        uniform float uVizFace;
        uniform float uVizGrid;
        uniform vec2  uRideDir;
        uniform float uWaveScale;
        uniform vec3  uSunDir;

        varying vec3 vGridPos;
        varying vec3 vViewTangent;
        varying vec3 vViewBinormal;
        varying vec3 vWorldPos;
        varying vec3 vWaveNormal;
    ` + shader.fragmentShader;

    // Readability overlays, applied to the final colour so they sit on top of
    // the standard lighting rather than fighting it.
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        {
            vec3 wn = normalize(vWaveNormal);
            float ny = max(wn.y, 0.001);
            vec2 slope = vec2(-wn.x / ny, -wn.z / ny);
            float steep = length(slope);
            float hgt = vWorldPos.y;

            // Exaggerated directional shading — the main cue a mirror surface lacks
            if (uVizSlope > 0.0) {
                float lam = clamp(dot(wn, normalize(uSunDir)), 0.0, 1.0);
                gl_FragColor.rgb *= mix(1.0, 0.35 + 1.25 * lam, uVizSlope);
            }

            // Height ramp: crests light, troughs dark
            if (uVizHeight > 0.0) {
                float t = clamp(hgt / max(uWaveScale, 0.1) * 0.5 + 0.5, 0.0, 1.0);
                vec3 ramp = mix(vec3(0.01, 0.09, 0.22), vec3(0.62, 0.88, 1.0), t);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, ramp, uVizHeight);
            }

            // Iso-height contours, like a topo map
            if (uVizContour > 0.0) {
                float spacing = max(uWaveScale * 0.22, 0.05);
                float f = hgt / spacing;
                float d = abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-4);
                float line = 1.0 - clamp(d, 0.0, 1.0);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), line * uVizContour * 0.75);
            }

            // Whitecap the steep faces
            if (uVizFoam > 0.0) {
                float fo = smoothstep(0.09, 0.26, steep);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), fo * uVizFoam * 0.85);
            }

            // Rideable faces: green where the surface runs downhill along your
            // heading, red where you would be climbing. This is the one that
            // maps directly onto what you are trying to do.
            if (uVizFace > 0.0) {
                float fav = -dot(slope, normalize(uRideDir + vec2(1e-5)));
                float g = smoothstep(0.015, 0.10, fav);
                float r = smoothstep(0.015, 0.10, -fav);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.15, 1.0, 0.35), g * uVizFace * 0.55);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.25, 0.2), r * uVizFace * 0.30);
            }

            // World-space grid for parallax and scale
            if (uVizGrid > 0.0) {
                vec2 gr = vWorldPos.xz / 10.0;
                vec2 gd = abs(fract(gr - 0.5) - 0.5) / max(fwidth(gr), vec2(1e-4));
                float gline = 1.0 - clamp(min(gd.x, gd.y), 0.0, 1.0);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), gline * uVizGrid * 0.4);
            }
        }
        `
    );

    const fwidth_shader = `
        #include <normal_fragment_begin>

        float invPeriod = 1.0 / uNoisePeriod;
        float rippleTime = uTime * 1.05;
        vec2 rippleUv = vGridPos.xz * 0.4 - vec2(0.1, 0.8) * rippleTime;

        float ripplePx = length(fwidth(rippleUv));
        float rippleFade = 1.0 / (1.0 + ripplePx * 2.0);

        vec3 rippleN = texture2D(uNoiseTexture, rippleUv * invPeriod).rgb;
        float rAmp = 0.319 * uWindSpeed * rippleFade;
        float ddx_r = rippleN.g * 0.4 * rAmp;
        float ddz_r = rippleN.b * 0.4 * rAmp;

        vec2 microUv = vGridPos.xz * 1.8 - vec2(0.15, 0.9) * rippleTime * 1.2;

        float microPx = length(fwidth(microUv));
        float microFade = 1.0 / (1.0 + microPx * 15.0);

        vec3 microN = texture2D(uNoiseTexture, microUv * invPeriod).rgb;
        float mAmp = 0.079 * uWindSpeed * microFade;
        ddx_r += microN.g * 1.8 * mAmp;
        ddz_r += microN.b * 1.8 * mAmp;

        normal = normalize(normal - ddx_r * vViewTangent - ddz_r * vViewBinormal);
    `;


    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        fwidth_shader
    );
};

const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
waterMesh.receiveShadow = false;
scene.add(waterMesh);


// --- CPU WAVE LOGIC (FOR FOIL PHYSICS) ---
// Thin wrappers over the shared wave field so physics reads exactly the surface
// the vertex shader draws.
function getSurfaceInfoAtWorldPos(worldX: number, worldZ: number, time: number) {
    return surfaceAtWorldPos(waveField, worldX, worldZ, time);
}

function getWaterHeightFast(x: number, z: number, time: number): number {
    return waterHeightFast(waveField, x, z, time);
}


// --- WAVE SAMPLING (multi-point across wing span) ---
function sampleWaveAtFoilPoints(time: number) {
    const dir = headingToDir(foilState.heading);
    const right = new THREE.Vector3(dir.z, 0, -dir.x);
    const halfSpan = activeFoil.wingSpan / 2;

    const cx = foilState.position.x;
    const cz = foilState.position.z;

    const center = getSurfaceInfoAtWorldPos(cx, cz, time);
    const leftTip = getSurfaceInfoAtWorldPos(
        cx - right.x * halfSpan,
        cz - right.z * halfSpan,
        time
    );
    const rightTip = getSurfaceInfoAtWorldPos(
        cx + right.x * halfSpan,
        cz + right.z * halfSpan,
        time
    );

    const n = center.normal;
    const ny = Math.max(n.y, 0.01);
    const gradient = new THREE.Vector2(-n.x / ny, -n.z / ny);

    return { center, leftTip, rightTip, gradient };
}


// --- FOIL BOARD (OBJ model) ---
const boardGroup = new THREE.Group();
scene.add(boardGroup);

const mtlLoader = new MTLLoader();
mtlLoader.setPath(BASE);
    mtlLoader.load('board.mtl', (materials) => {
    materials.preload();
    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath(BASE);
    objLoader.load('board.obj', (obj) => {
        const boardMat = new THREE.MeshStandardMaterial({
            color: '#1a1a1a',
            roughness: 0.35,
            metalness: 0.0,
        });
        obj.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                mesh.material = boardMat;
                mesh.geometry.computeVertexNormals();
                mesh.castShadow = false;
                mesh.receiveShadow = false;
            }
        });
        boardGroup.add(obj);
    });
});


// --- RIDER (FBX from Mixamo) ---
let riderMixer: THREE.AnimationMixer | null = null;
const riderActions: Record<string, THREE.AnimationAction> = {};
let activeAction: THREE.AnimationAction | null = null;
let prevGameState: GameState | null = null;

const RIDER_SCALE = 0.023;
const RIDER_OFFSET = new THREE.Vector3(0, 0.15, 0);
const SITTING_Y_OFFSET = -1.1;

//let riderHips: THREE.Bone | null = null;
let riderModel: THREE.Group | null = null;
let riderLoaded = false;
let currentAnimName = '';
let pumpPlaying = false;

const PUMP_ANIM_DURATION_MS = 250;

function crossfadeTo(name: string, duration = 0.4) {
    const next = riderActions[name];
    if (!next || next === activeAction) return;
    if (name === 'pump') return; // pump uses triggerPumpAnim
    next.reset().setEffectiveWeight(1).fadeIn(duration).play();
    activeAction?.fadeOut(duration);
    activeAction = next;
    currentAnimName = name;
}

function triggerPumpAnim() {
    const pump = riderActions['pump'];
    if (!pump || !riderMixer) return;

    pumpPlaying = true;

    pump.reset();
    pump.setLoop(THREE.LoopOnce, 1);
    pump.clampWhenFinished = false;
    pump.setEffectiveWeight(1);

    const clipDuration = pump.getClip().duration;
    const desiredSec = PUMP_ANIM_DURATION_MS / 1000;
    pump.setEffectiveTimeScale(clipDuration / desiredSec);

    pump.fadeIn(0.08).play();
    activeAction?.fadeOut(0.08);

    const prevAction = activeAction;
    const prevName = currentAnimName;
    activeAction = pump;
    currentAnimName = 'pump';

    const onFinished = (e: { action: THREE.AnimationAction }) => {
        if (e.action !== pump) return;
        riderMixer!.removeEventListener('finished', onFinished);
        pumpPlaying = false;

        const returnTo = prevAction ?? riderActions['surfing'];
        if (returnTo) {
            returnTo.reset().setEffectiveWeight(1).fadeIn(0.15).play();
            pump.fadeOut(0.15);
            activeAction = returnTo;
            currentAnimName = prevName || 'surfing';
        }
    };
    riderMixer.addEventListener('finished', onFinished);
}

{
    const fbxLoader = new FBXLoader();
    fbxLoader.load(`${BASE}surfing-skinned.fbx`, (fbx) => {
        fbx.scale.setScalar(RIDER_SCALE);
        fbx.position.copy(RIDER_OFFSET);

        fbx.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                (child as THREE.Mesh).castShadow = false;
                (child as THREE.Mesh).receiveShadow = false;
            }
            if ((child as THREE.Bone).isBone) {
                //console.log('Bone:', child.name);
                if (child.name.toLowerCase().includes('hips')) {
                    //riderHips = child as THREE.Bone;
                }
            }
        });
        
        riderModel = fbx;
        boardGroup.add(fbx);    

        riderMixer = new THREE.AnimationMixer(fbx);

        if (fbx.animations.length > 0) {
            const clip = fbx.animations[0];
            clip.name = 'surfing';
            riderActions['surfing'] = riderMixer.clipAction(clip);
        }

        fbxLoader.load(`${BASE}sitting.fbx`, (sitFbx) => {
            if (sitFbx.animations.length > 0) {
                const clip = sitFbx.animations[0];
                clip.name = 'sitting';
                riderActions['sitting'] = riderMixer!.clipAction(clip);
            }

            fbxLoader.load(`${BASE}pump.fbx`, (pumpFbx) => {
                if (pumpFbx.animations.length > 0) {
                    const clip = pumpFbx.animations[0];
                    clip.name = 'pump';
                    riderActions['pump'] = riderMixer!.clipAction(clip);
                    riderActions['pump'].setLoop(THREE.LoopOnce, 1);
                    riderActions['pump'].clampWhenFinished = false;
                }

                if (riderActions['sitting']) {
                    riderActions['sitting'].play();
                    activeAction = riderActions['sitting'];
                    currentAnimName = 'sitting';
                } else if (riderActions['surfing']) {
                    riderActions['surfing'].play();
                    activeAction = riderActions['surfing'];
                    currentAnimName = 'surfing';
                }
                riderLoaded = true;
            });
        });
    });
}

function updateRiderAnimation() {
    if (gameState === prevGameState) return;
    prevGameState = gameState;

    if (pumpPlaying && gameState === 'riding') return;

    switch (gameState) {
        case 'starting':
            pumpPlaying = false;
            crossfadeTo('sitting');
            break;
        case 'riding':
            crossfadeTo('surfing');
            break;
        case 'crashed':
            pumpPlaying = false;
            crossfadeTo('sitting', 0.8);
            break;
    }
}

// --- HUD (elements defined in index.html, styled in style.css) ---
const hudSpeed = document.querySelector('#hud-speed') as HTMLElement;
const hudSpeedFill = document.querySelector('#speed-bar-fill') as HTMLElement;

const SPEED_BAR_MAX_KTS = 30;

function speedColor(knots: number): string {
    const t = Math.min(knots / SPEED_BAR_MAX_KTS, 1);
    if (t < 0.33) {
        const p = t / 0.33;
        const r = Math.round(239 + (255 - 239) * p);
        const g = Math.round(83 + (167 - 83) * p);
        const b = Math.round(80 + (38 - 80) * p);
        return `rgb(${r},${g},${b})`;
    } else if (t < 0.66) {
        const p = (t - 0.33) / 0.33;
        const r = Math.round(255 - (255 - 139) * p);
        const g = Math.round(167 + (195 - 167) * p);
        const b = Math.round(38 + (74 - 38) * p);
        return `rgb(${r},${g},${b})`;
    } else {
        const p = (t - 0.66) / 0.34;
        const r = Math.round(139 - (139 - 76) * p);
        const g = Math.round(195 + (175 - 195) * p);
        const b = Math.round(74 + (80 - 74) * p);
        return `rgb(${r},${g},${b})`;
    }
}

const hudHeight = document.querySelector('#hud-height') as HTMLElement;
const hudHeightFill = document.querySelector('#height-bar-fill') as HTMLElement;
const hudEnergy = document.querySelector('#hud-energy') as HTMLElement;
const hudEnergyFill = document.querySelector('#energy-bar-fill') as HTMLElement;
const hudTitle = document.querySelector('#hud-title') as HTMLElement;
const hudSubtitle = document.querySelector('#hud-subtitle') as HTMLElement;
const hudControls = document.querySelector('#hud-controls') as HTMLElement;
const hudLeaderboard = document.querySelector('#hud-leaderboard') as HTMLElement;
const raceDistancePicker = document.querySelector('#race-distance-picker') as HTMLElement;
const distBtns = raceDistancePicker.querySelectorAll<HTMLButtonElement>('.dist-btn');

distBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const km = Number(btn.dataset.km);
        if (km === RACE_LENGTH_KM) return;
        RACE_LENGTH_KM = km;
        rebuildRaceCourse();
        distBtns.forEach(b => b.classList.toggle('dist-btn--active', b === btn));
        refreshStartScreenLeaderboard();
    });
});

const distanceContainer = document.querySelector('#distance-container') as HTMLElement;
const distanceLabel = document.querySelector('#distance-label') as HTMLElement;
const distanceBarFill = document.querySelector('#distance-bar-fill') as HTMLElement;

function updateHUD() {
    const knots = foilState.speed * 1.944;
    hudSpeed.textContent = `${knots.toFixed(1)} kts`;
    const speedPct = Math.max(0, Math.min(100, (knots / SPEED_BAR_MAX_KTS) * 100));
    hudSpeedFill.style.width = `${speedPct}%`;
    hudSpeedFill.style.background = speedColor(knots);

    const heightPct = Math.max(0, Math.min(100, (foilState.rideHeight / MAST_LENGTH) * 100));
    hudHeight.textContent = `Height: ${(foilState.rideHeight * 100).toFixed(0)} cm`;
    hudHeightFill.style.width = `${heightPct}%`;
    hudHeightFill.style.background = heightPct < 20 ? '#ef5350' : '#4fc3f7';

    hudEnergy.textContent = `Energy: ${Math.round(foilState.energy)}`;
    hudEnergyFill.style.width = `${foilState.energy}%`;

    // Hide distance bar before the race; show during riding/crashed
    if (gameState === 'starting') {
        distanceContainer.style.display = 'none';
    } else {
        distanceContainer.style.display = '';
    }
    updateRaceHUD();

    if (gameState === 'starting') {
        hudTitle.textContent = '🏄 Downwind';
        hudSubtitle.textContent = riderLoaded
            ? `race to ${RACE_LENGTH_KM} km · pump to stay on foil`
            : `race to ${RACE_LENGTH_KM} km · pump to stay on foil · loading rider…`;
        raceDistancePicker.style.display = 'flex';
        if (isMobile) {
            hudControls.textContent = 'Tap to launch · Drag to steer & trim';
        } else {
            hudControls.textContent = '← → Turn  ·  ↑ climb  ↓ sink  ·  SPACE Pump\n\n    Press SPACE to launch';
        }
        hudLeaderboard.innerHTML = cachedTop3HTML;
        hudLeaderboard.style.display = cachedTop3HTML ? '' : 'none';
    } else if (gameState === 'crashed') {
        hudTitle.textContent = 'Off Foil!';
        hudSubtitle.textContent = '';
        hudControls.textContent = isMobile ? 'Tap to restart' : 'Press R to restart';
        raceDistancePicker.style.display = 'none';
        hudLeaderboard.style.display = 'none';
    } else {
        hudTitle.textContent = '';
        hudSubtitle.textContent = '';
        hudControls.textContent = '';
        raceDistancePicker.style.display = 'none';
        hudLeaderboard.style.display = 'none';
    }
}


// --- RACE HUD ELEMENTS (defined in index.html, styled in style.css) ---
const raceTimerEl = document.querySelector('#race-timer') as HTMLElement;
const kmTickRow = document.querySelector('#km-tick-row') as HTMLElement;
const kmSplitsRow = document.querySelector('#km-splits-row') as HTMLElement;
const splitFlashEl = document.querySelector('#split-flash') as HTMLElement;
const finishOverlay = document.querySelector('#finish-overlay') as HTMLElement;

// Populate km tick marks
for (let k = 1; k <= RACE_LENGTH_KM; k++) {
    const tick = document.createElement('span');
    tick.textContent = `${k}km`;
    kmTickRow.appendChild(tick);
}

function renderLeaderboardHTML(
    scores: LeaderboardEntry[], highlightTime?: number, highlightName?: string
): string {
    if (scores.length === 0) return '';
    const medals = ['🥇', '🥈', '🥉'];
    let html = `<div class="finish-highscores">`;
    html += `<div class="finish-highscores-title">GLOBAL LEADERBOARD — ${RACE_LENGTH_KM} km</div>`;
    let highlighted = false;
    for (let i = 0; i < scores.length; i++) {
        const s = scores[i];
        const isCurrent = !highlighted && highlightName && highlightTime !== undefined
            && s.name === highlightName && Math.abs(s.time - highlightTime) < 0.05;
        if (isCurrent) highlighted = true;
        const cls = isCurrent ? 'finish-hs-row finish-hs-row--current' : 'finish-hs-row';
        html += `<div class="${cls}">` +
            `<span class="finish-hs-rank">${medals[i] || (i + 1)}</span>` +
            `<span class="finish-hs-name">${escapeHTML(s.name)}</span>` +
            `<span class="finish-hs-time">${fmtTime(s.time)}</span>` +
            `</div>`;
    }
    html += `</div>`;
    return html;
}

function escapeHTML(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showRaceResults() {
    scoreSubmitted = false;
    const total = race.totalElapsed;
    const roundedTotal = Math.round(total * 100) / 100;
    const avgPerKm = total / RACE_LENGTH_KM;

    let html = `<div class="finish-title">RACE COMPLETE</div>`;
    html += `<div class="finish-total">Total&nbsp; <span class="finish-total-time">${fmtTime(total)}</span></div>`;
    html += `<div class="finish-splits">`;

    let prevElapsed = 0;
    for (let i = 0; i < race.kmSplitTimes.length; i++) {
        const elapsed = race.kmSplitTimes[i];
        const split = elapsed - prevElapsed;
        html += `<div class="finish-split-row">` +
            `<span class="finish-split-label">KM ${i + 1}</span>` +
            `<span class="finish-split-time">${fmtTime(split)}</span></div>`;
        prevElapsed = elapsed;
    }
    html += `</div>`;
    html += `<div class="finish-avg">Avg / km &nbsp;<span class="finish-avg-time">${fmtTime(avgPerKm)}</span></div>`;

    if (leaderboardAvailable) {
        html += `<div id="finish-submit-section" class="finish-submit">` +
            `<input type="text" id="finish-name-input" placeholder="Your name" maxlength="20" ` +
            `value="${escapeHTML(getStoredPlayerName())}" />` +
            `<button id="finish-submit-btn">Submit Score</button>` +
            `</div>`;
        html += `<div id="finish-submit-status"></div>`;
        html += `<div id="finish-leaderboard-slot">` +
            `<div class="finish-loading">Loading leaderboard…</div></div>`;
    } else {
        html += `<div class="finish-offline">Offline preview — scores are not ranked</div>`;
    }

    html += `<div class="finish-hint">Press R to restart</div>`;

    finishOverlay.innerHTML = html;
    finishOverlay.style.display = 'block';
    finishOverlay.style.pointerEvents = 'auto';

    const nameInput = document.getElementById('finish-name-input') as HTMLInputElement | null;
    const submitBtn = document.getElementById('finish-submit-btn') as HTMLButtonElement | null;
    const statusEl = document.getElementById('finish-submit-status');
    const lbSlot = document.getElementById('finish-leaderboard-slot');
    if (!nameInput || !submitBtn || !statusEl || !lbSlot) return;

    fetchLeaderboard(RACE_LENGTH_KM).then(scores => {
        lbSlot.innerHTML = renderLeaderboardHTML(scores);
    });

    submitBtn.addEventListener('click', async () => {
        if (scoreSubmitted) return;
        const name = nameInput.value.trim().slice(0, 20) || 'Anon';
        setStoredPlayerName(name);
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        statusEl.textContent = '';

        const result = await submitScore(RACE_LENGTH_KM, roundedTotal, name, activeFoil.name);
        scoreSubmitted = true;

        if (result.rank > 0 && result.isNew) {
            statusEl.innerHTML = `<span class="finish-newbest">#${result.rank} on the leaderboard!</span>`;
        } else if (result.rank > 0) {
            statusEl.textContent = 'Score submitted!';
        } else {
            statusEl.textContent = 'Could not submit — try again later.';
            scoreSubmitted = false;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Submit Score';
            return;
        }

        submitBtn.textContent = 'Submitted ✓';

        const refreshed = await fetchLeaderboard(RACE_LENGTH_KM);
        lbSlot.innerHTML = renderLeaderboardHTML(refreshed, roundedTotal, name);
        refreshStartScreenLeaderboard();
    });

    nameInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') submitBtn.click();
    });
}

function hideFinishOverlay() {
    finishOverlay.style.display = 'none';
    finishOverlay.style.pointerEvents = 'none';
    scoreSubmitted = false;
}

function updateRaceHUD() {
    const dwind = downwindDist();           // Z progress — drives the race bar
    const path  = foilState.distanceTravelled; // total path — shown as secondary info
    const totalRaceDist = RACE_LENGTH_KM * 1000;

    if (race.finished) {
        distanceLabel.textContent = `FINISHED — ${RACE_LENGTH_KM} km  (path ${(path / 1000).toFixed(2)} km)`;
        distanceBarFill.style.width = '100%';
        distanceBarFill.style.background = 'linear-gradient(90deg,#ffeb3b,#ff9800)';
        raceTimerEl.textContent = fmtTime(race.totalElapsed);
        raceTimerEl.style.display = 'block';
        kmTickRow.style.display = 'flex';
        kmSplitsRow.style.display = 'flex';
    } else if (race.active) {
        const racePct = Math.min(dwind / totalRaceDist, 1) * 100;
        distanceLabel.textContent =
            `${(dwind / 1000).toFixed(2)} / ${RACE_LENGTH_KM} km` +
            `  · path ${(path / 1000).toFixed(2)} km`;
        distanceBarFill.style.width = `${racePct}%`;
        distanceBarFill.style.background = 'linear-gradient(90deg,#ffeb3b,#ff9800)';
        raceTimerEl.textContent = fmtTime(race.totalElapsed);
        raceTimerEl.style.display = 'block';
        kmTickRow.style.display = 'flex';
        kmSplitsRow.style.display = 'flex';
    } else if (gameState === 'crashed' && path > 0) {
        const racePct = Math.min(dwind / totalRaceDist, 1) * 100;
        distanceLabel.textContent =
            `Crashed at ${(dwind / 1000).toFixed(2)} / ${RACE_LENGTH_KM} km` +
            `  · path ${(path / 1000).toFixed(2)} km`;
        distanceBarFill.style.width = `${racePct}%`;
        distanceBarFill.style.background = 'linear-gradient(90deg,#ef5350,#ff7043)';
        raceTimerEl.textContent = fmtTime(race.totalElapsed);
        raceTimerEl.style.display = 'block';
        kmTickRow.style.display = 'flex';
        kmSplitsRow.style.display = 'flex';
    } else {
        raceTimerEl.style.display = 'none';
        kmTickRow.style.display = 'none';
        kmSplitsRow.style.display = 'none';
    }

    // Km split badges
    kmSplitsRow.innerHTML = '';
    for (let i = 0; i < race.kmSplitTimes.length; i++) {
        const prev = i > 0 ? race.kmSplitTimes[i - 1] : 0;
        const split = race.kmSplitTimes[i] - prev;
        const badge = document.createElement('span');
        badge.className = 'km-split-badge';
        badge.textContent = `${i + 1}km ${fmtTime(split)}`;
        kmSplitsRow.appendChild(badge);
    }

    // Split flash fade
    if (race.splitFlashTimer > 0) {
        const alpha = Math.min(race.splitFlashTimer / 0.6, 1.0);
        splitFlashEl.style.opacity = String(alpha);
        splitFlashEl.textContent = race.splitFlashText;
    } else {
        splitFlashEl.style.opacity = '0';
    }
}


// --- GUI ---
const gui = new GUI();
gui.close();
gui.add(PARAMS, 'selectedFoil', Object.keys(FOIL_PRESETS)).name('Foil').onChange((v: string) => {
    activeFoil = { ...FOIL_PRESETS[v] };
});

// --- SWELL CONTROLS ---
// Forecast-style inputs: significant height, peak period, direction. Everything
// downstream (wavelength, crest speed, set speed, set length) is derived from
// deep-water theory, so the readouts update themselves.
const swellFolder = gui.addFolder('Sea State');

const swellReadouts: HTMLElement[] = [];

function rebuildWaveField() {
    waveField = buildWaveField(SWELLS);
    uploadWaveField();
    updateSwellReadouts();
}

function updateSwellReadouts() {
    for (let i = 0; i < SWELLS.length; i++) {
        const s = SWELLS[i];
        const el = swellReadouts[i];
        if (!el) continue;
        const lambda = periodToWavelength(s.period);
        const c = periodToPhaseSpeed(s.period);
        const cg = c / 2;
        const groupLen = s.bandwidth > 1e-4 ? lambda / (4 * s.bandwidth) : Infinity;
        el.textContent = s.enabled
            ? `λ ${lambda.toFixed(0)} m · crest ${(c * 1.944).toFixed(0)} kt · ` +
              `set ${(cg * 1.944).toFixed(0)} kt · set len ${groupLen.toFixed(0)} m`
            : 'off';
    }
}

for (let i = 0; i < SWELLS.length; i++) {
    const s = SWELLS[i];
    const f = swellFolder.addFolder(s.name);
    f.add(s, 'enabled').name('Enabled').onChange(rebuildWaveField);
    f.add(s, 'height', 0, 5, 0.05).name('Height Hs (m)').onChange(rebuildWaveField);
    f.add(s, 'period', 2, 20, 0.1).name('Period Tp (s)').onChange(rebuildWaveField);
    f.add(s, 'direction', -90, 90, 1).name('Direction (°)').onChange(rebuildWaveField);
    f.add(s, 'spread', 0, 60, 1).name('Spread (°)').onChange(rebuildWaveField);
    f.add(s, 'bandwidth', 0.005, 0.3, 0.005).name('Bandwidth').onChange(rebuildWaveField);
    f.add(s, 'components', 1, 16, 1).name('Components').onChange(rebuildWaveField);

    // Derived readout line appended under the folder's controls.
    const readout = document.createElement('div');
    readout.className = 'swell-readout';
    f.domElement.querySelector('.children')?.appendChild(readout);
    swellReadouts.push(readout);
    f.close();
}
updateSwellReadouts();


// --- LOOK: BUMP READABILITY EXPERIMENTS ---
// The wave field is correct but hard to read, because the water is a near
// mirror (roughness 0.05 / metalness 0.9) lit by an almost overhead sun and a
// dominant uniform hemisphere light. A mirror under uniform light reflects
// nearly the same colour whichever way it tilts, so the surface has shape but
// shows none of it. Each mode below attacks that differently — cycle and pick.

interface VizPreset {
    name: string;
    note: string;
    sunElevation?: number;
    sunAzimuth?: number;
    roughness?: number;
    metalness?: number;
    hemi?: number;
    dir?: number;
    ambient?: number;
    slope?: number;
    height?: number;
    contour?: number;
    foam?: number;
    face?: number;
    grid?: number;
}

const VIZ_STOCK: VizPreset = {
    name: 'Stock',
    note: 'as shipped — mirror water, overhead sun',
    sunElevation: 85, sunAzimuth: 180, roughness: 0.05, metalness: 0.9,
    hemi: 20, dir: 0.5, ambient: 0.05,
};

const VIZ_PRESETS: VizPreset[] = [
    VIZ_STOCK,
    {
        name: 'Raking sun',
        note: 'low sun across the swell — pure lighting, no overlay',
        sunElevation: 11, sunAzimuth: 205, roughness: 0.22, metalness: 0.65,
        hemi: 3.0, dir: 4.5, ambient: 0.12,
    },
    {
        name: 'Matte',
        note: 'diffuse water so shading follows slope directly',
        sunElevation: 28, sunAzimuth: 200, roughness: 0.8, metalness: 0.05,
        hemi: 1.6, dir: 3.5, ambient: 0.15,
    },
    {
        name: 'Slope shading',
        note: 'exaggerated directional shading on top of stock',
        sunElevation: 25, sunAzimuth: 200, roughness: 0.35, metalness: 0.5,
        hemi: 4, dir: 2.0, slope: 1.0,
    },
    {
        name: 'Height ramp',
        note: 'crests light, troughs dark',
        sunElevation: 40, roughness: 0.4, metalness: 0.3, hemi: 4, dir: 1.5,
        height: 0.75,
    },
    {
        name: 'Contours',
        note: 'iso-height lines, like a topo map',
        sunElevation: 40, roughness: 0.3, metalness: 0.5, hemi: 5, dir: 1.0,
        contour: 1.0,
    },
    {
        name: 'Crest foam',
        note: 'whitecaps wherever the surface is steep',
        sunElevation: 20, sunAzimuth: 200, roughness: 0.3, metalness: 0.5,
        hemi: 4, dir: 2.5, foam: 1.0,
    },
    {
        name: 'Rideable faces',
        note: 'green = downhill along your heading, red = climbing',
        sunElevation: 30, roughness: 0.35, metalness: 0.4, hemi: 4, dir: 1.5,
        face: 1.0,
    },
    {
        name: 'Faces + foam',
        note: 'the gameplay cue plus crest definition',
        sunElevation: 18, sunAzimuth: 200, roughness: 0.28, metalness: 0.5,
        hemi: 3.5, dir: 3.0, face: 0.9, foam: 0.7,
    },
    {
        name: 'X-ray',
        note: 'dark water, contours + grid + slope shading',
        sunElevation: 35, roughness: 0.5, metalness: 0.2, hemi: 1.2, dir: 1.0,
        ambient: 0.05, contour: 0.9, grid: 0.7, slope: 0.8,
    },
    {
        name: 'Everything',
        note: 'all cues at once — ugly, but nothing is hidden',
        sunElevation: 15, sunAzimuth: 205, roughness: 0.3, metalness: 0.4,
        hemi: 2.5, dir: 3.5, slope: 0.7, height: 0.3, contour: 0.5,
        foam: 0.6, face: 0.7, grid: 0.3,
    },
];

let vizIndex = 0;
const vizBarEl = document.querySelector('#viz-bar') as HTMLElement;
const vizNoteEl = document.querySelector('#viz-note') as HTMLElement;

function applyViz(preset: VizPreset) {
    const p = { ...VIZ_STOCK, ...preset };
    PARAMS.sunElevation = p.sunElevation!;
    PARAMS.sunAzimuth = p.sunAzimuth!;
    PARAMS.ambientIntensity = p.ambient ?? 0.05;
    PARAMS.hemiIntensity = p.hemi ?? 20;
    PARAMS.dirIntensity = p.dir ?? 0.5;

    waterMaterial.roughness = p.roughness ?? 0.05;
    waterMaterial.metalness = p.metalness ?? 0.9;
    ambientLight.intensity = PARAMS.ambientIntensity;
    hemiLight.intensity = PARAMS.hemiIntensity;
    dirLight.intensity = PARAMS.dirIntensity;

    waterUniforms.uVizSlope.value = preset.slope ?? 0;
    waterUniforms.uVizHeight.value = preset.height ?? 0;
    waterUniforms.uVizContour.value = preset.contour ?? 0;
    waterUniforms.uVizFoam.value = preset.foam ?? 0;
    waterUniforms.uVizFace.value = preset.face ?? 0;
    waterUniforms.uVizGrid.value = preset.grid ?? 0;

    updateEnvironment();
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    renderVizBar();
}

/** Randomise the overlay weights — the "what if" button. */
function randomViz() {
    const r = () => Math.round(Math.random() * 10) / 10;
    applyViz({
        name: 'Random', note: 'randomised mixture — press again to reroll',
        sunElevation: 8 + Math.random() * 50,
        sunAzimuth: 120 + Math.random() * 120,
        roughness: 0.15 + Math.random() * 0.6,
        metalness: Math.random() * 0.8,
        hemi: 1 + Math.random() * 6,
        dir: 0.5 + Math.random() * 4,
        slope: r() * 0.9, height: r() * 0.6, contour: r() * 0.8,
        foam: r() * 0.9, face: r() * 0.9, grid: r() * 0.5,
    });
}

function setViz(i: number) {
    vizIndex = (i + VIZ_PRESETS.length) % VIZ_PRESETS.length;
    applyViz(VIZ_PRESETS[vizIndex]);
}

function renderVizBar() {
    vizBarEl.querySelectorAll('button').forEach((b, i) => {
        b.classList.toggle('viz-btn--active', i === vizIndex);
    });
}

function buildVizBar() {
    vizBarEl.innerHTML = '';
    VIZ_PRESETS.forEach((preset, i) => {
        const b = document.createElement('button');
        b.textContent = `${i}`;
        b.title = `${preset.name} — ${preset.note}`;
        b.addEventListener('click', () => {
            setViz(i);
            vizNoteEl.textContent = `${i}. ${preset.name} — ${preset.note}`;
        });
        vizBarEl.appendChild(b);
    });
    const rnd = document.createElement('button');
    rnd.textContent = '\u21bb';
    rnd.title = 'Random mixture';
    rnd.addEventListener('click', () => {
        randomViz();
        vizNoteEl.textContent = 'random mixture — press again to reroll';
    });
    vizBarEl.appendChild(rnd);
    renderVizBar();
    vizNoteEl.textContent = `0. ${VIZ_STOCK.name} — ${VIZ_STOCK.note}`;
}

buildVizBar();


// --- SEA STATE CONFIG PANEL ---
// Plain HTML rather than lil-gui: it has to work on a phone, which is where
// most people hit this, and small/medium/large is a faster decision than
// typing a significant wave height.

const swellPanelEl = document.querySelector('#swell-panel') as HTMLElement;
const swellRowsEl = document.querySelector('#swell-rows') as HTMLElement;
const swellSummaryEl = document.querySelector('#swell-summary') as HTMLElement;
const swellBtnEl = document.querySelector('#swell-btn') as HTMLButtonElement;

function applySwellSize(i: number, size: SwellPreset) {
    swellSize[i] = size;
    SWELLS[i].height = SWELL_SIZES[i][size].height;
    SWELLS[i].period = SWELL_SIZES[i][size].period;
    rebuildWaveField();
    renderSwellPanel();
}

function buildSwellPanel() {
    swellRowsEl.innerHTML = '';
    for (let i = 0; i < SWELLS.length; i++) {
        const s = SWELLS[i];
        const row = document.createElement('div');
        row.className = 'swell-row';
        row.dataset.index = String(i);
        row.innerHTML =
            `<label class="swell-toggle">` +
            `<input type="checkbox" data-role="enable"${s.enabled ? ' checked' : ''}>` +
            `<span class="swell-swatch" style="background:${SWELL_COLORS[i]}"></span>` +
            `<span>${s.name}</span></label>` +
            `<div class="swell-sizes">` +
            SIZE_BUTTONS.map(sz =>
                `<button data-size="${sz}">${sz[0].toUpperCase() + sz.slice(1)}</button>`
            ).join('') +
            `</div>` +
            `<div class="swell-dir"><span>HT&nbsp;</span>` +
            `<input type="range" data-role="height" min="0" max="5" step="0.1" value="${s.height}">` +
            `<span data-role="heightval">${s.height.toFixed(1)}m</span></div>` +
            `<div class="swell-dir"><span>PER</span>` +
            `<input type="range" data-role="period" min="2" max="18" step="0.5" value="${s.period}">` +
            `<span data-role="periodval">${s.period.toFixed(1)}s</span></div>` +
            `<div class="swell-dir"><span>DIR</span>` +
            `<input type="range" data-role="dir" min="-90" max="90" step="1" value="${s.direction}">` +
            `<span data-role="dirval">${s.direction}°</span></div>` +
            `<div class="swell-meta" data-role="meta"></div>`;

        row.querySelector('[data-role="enable"]')!.addEventListener('change', (e) => {
            SWELLS[i].enabled = (e.target as HTMLInputElement).checked;
            rebuildWaveField();
            renderSwellPanel();
        });
        row.querySelectorAll<HTMLButtonElement>('.swell-sizes button').forEach(b => {
            b.addEventListener('click', () => applySwellSize(i, b.dataset.size as SwellPreset));
        });
        row.querySelector('[data-role="dir"]')!.addEventListener('input', (e) => {
            SWELLS[i].direction = Number((e.target as HTMLInputElement).value);
            rebuildWaveField();
            renderSwellPanel();
        });
        // Fine-tuning height or period puts the row into a custom state, so no
        // size preset stays highlighted.
        row.querySelector('[data-role="height"]')!.addEventListener('input', (e) => {
            SWELLS[i].height = Number((e.target as HTMLInputElement).value);
            swellSize[i] = 'custom';
            rebuildWaveField();
            renderSwellPanel();
        });
        row.querySelector('[data-role="period"]')!.addEventListener('input', (e) => {
            SWELLS[i].period = Number((e.target as HTMLInputElement).value);
            swellSize[i] = 'custom';
            rebuildWaveField();
            renderSwellPanel();
        });

        swellRowsEl.appendChild(row);
    }
    renderSwellPanel();
}

function renderSwellPanel() {
    const rows = swellRowsEl.querySelectorAll<HTMLElement>('.swell-row');
    rows.forEach((row, i) => {
        const s = SWELLS[i];
        row.classList.toggle('swell-row--off', !s.enabled);
        (row.querySelector('[data-role="enable"]') as HTMLInputElement).checked = s.enabled;

        row.querySelectorAll<HTMLButtonElement>('.swell-sizes button').forEach(b => {
            b.classList.toggle('swell-size--active', b.dataset.size === swellSize[i]);
        });

        (row.querySelector('[data-role="dir"]') as HTMLInputElement).value = String(s.direction);
        row.querySelector('[data-role="dirval"]')!.textContent = `${s.direction}°`;
        (row.querySelector('[data-role="height"]') as HTMLInputElement).value = String(s.height);
        row.querySelector('[data-role="heightval"]')!.textContent = `${s.height.toFixed(1)}m`;
        (row.querySelector('[data-role="period"]') as HTMLInputElement).value = String(s.period);
        row.querySelector('[data-role="periodval"]')!.textContent = `${s.period.toFixed(1)}s`;

        const lambda = periodToWavelength(s.period);
        const c = periodToPhaseSpeed(s.period);
        const rid = ridability(s.period);
        row.querySelector('[data-role="meta"]')!.innerHTML =
            `${s.height.toFixed(1)} m @ ${s.period.toFixed(0)} s · λ ${lambda.toFixed(0)} m<br>` +
            `crest ${(c * 1.944).toFixed(0)} kt · set ${(c / 2 * 1.944).toFixed(0)} kt · ` +
            `<span style="color:${rid.color}">${rid.text}</span>`;
    });

    // Combined sea state: variances add, so Hs adds in quadrature.
    let sumSq = 0;
    for (const s of SWELLS) if (s.enabled) sumSq += s.height * s.height;
    const clamped = waveField.steepnessScale < 0.999;
    // Gerstner waves fold through themselves past a total steepness, so the
    // field scales amplitudes down to stay physical. Say so rather than
    // quietly ignoring what the sliders were set to.
    swellSummaryEl.innerHTML = clamped
        ? `Combined Hs ${(Math.sqrt(sumSq) * waveField.steepnessScale).toFixed(1)} m ` +
          `<span style="color:#fbbf24">(capped — too steep)</span>`
        : `Combined Hs ${Math.sqrt(sumSq).toFixed(1)} m`;

    updateSwellReadouts();
}

// --- RIG & WIND CONTROLS ---
const rigRowsEl = document.querySelector('#rig-rows') as HTMLElement;

function buildRigPanel() {
    rigRowsEl.innerHTML =
        `<div class="rig-row">` +
        `<div class="swell-dir" style="margin-top:0"><span>FOIL</span></div>` +
        `<select data-role="foil">` +
        Object.keys(FOIL_PRESETS).map(k =>
            `<option value="${k}"${k === activeFoil.name ? ' selected' : ''}>${k}</option>`
        ).join('') +
        `</select>` +
        `<div class="swell-meta" data-role="foilmeta"></div>` +
        `</div>` +
        `<div class="rig-row">` +
        `<div class="swell-dir"><span>KG&nbsp;</span>` +
        `<input type="range" data-role="mass" min="55" max="130" step="1" value="${riderMass}">` +
        `<span data-role="massval">${riderMass}kg</span></div>` +
        `</div>` +
        `<div class="rig-row">` +
        `<label class="swell-toggle">` +
        `<input type="checkbox" data-role="windon"${WIND.enabled ? ' checked' : ''}>` +
        `<span class="swell-swatch" style="background:#7dd3fc"></span><span>Wind</span></label>` +
        `<div class="swell-dir"><span>KT&nbsp;</span>` +
        `<input type="range" data-role="windspd" min="0" max="30" step="0.5" value="${(WIND.speed * 1.944).toFixed(1)}">` +
        `<span data-role="windspdval"></span></div>` +
        `<div class="swell-dir"><span>DIR</span>` +
        `<input type="range" data-role="winddir" min="-90" max="90" step="1" value="${WIND.direction}">` +
        `<span data-role="winddirval"></span></div>` +
        `<div class="swell-meta" data-role="windmeta"></div>` +
        `</div>`;

    rigRowsEl.querySelector('[data-role="foil"]')!.addEventListener('change', (e) => {
        const k = (e.target as HTMLSelectElement).value;
        activeFoil = { ...FOIL_PRESETS[k] };
        PARAMS.selectedFoil = k;
        gui.controllersRecursive().forEach(c => c.updateDisplay());
        renderRigPanel();
    });
    rigRowsEl.querySelector('[data-role="mass"]')!.addEventListener('input', (e) => {
        riderMass = Number((e.target as HTMLInputElement).value);
        renderRigPanel();
    });
    rigRowsEl.querySelector('[data-role="windon"]')!.addEventListener('change', (e) => {
        WIND.enabled = (e.target as HTMLInputElement).checked;
        renderRigPanel();
    });
    rigRowsEl.querySelector('[data-role="windspd"]')!.addEventListener('input', (e) => {
        WIND.speed = Number((e.target as HTMLInputElement).value) / 1.944;
        renderRigPanel();
    });
    rigRowsEl.querySelector('[data-role="winddir"]')!.addEventListener('input', (e) => {
        WIND.direction = Number((e.target as HTMLInputElement).value);
        renderRigPanel();
    });
    renderRigPanel();
}

function renderRigPanel() {
    const f = activeFoil;
    const stall = stallSpeedFor(f, riderMass);
    rigRowsEl.querySelector('[data-role="foilmeta"]')!.textContent =
        `${(f.wingArea * 10000).toFixed(0)} cm² · AR ${f.aspectRatio.toFixed(1)} · ` +
        `span ${(f.wingSpan * 100).toFixed(0)} cm · min fly ${(stall * 1.944).toFixed(1)} kt`;
    (rigRowsEl.querySelector('[data-role="mass"]') as HTMLInputElement).value = String(riderMass);
    rigRowsEl.querySelector('[data-role="massval"]')!.textContent = `${riderMass}kg`;
    rigRowsEl.querySelector('[data-role="windspdval"]')!.textContent =
        `${(WIND.speed * 1.944).toFixed(0)}kt`;
    rigRowsEl.querySelector('[data-role="winddirval"]')!.textContent = `${WIND.direction}°`;
    rigRowsEl.querySelector('[data-role="windmeta"]')!.textContent = WIND.enabled
        ? `pushes while slower than the wind, drags once you outrun it`
        : 'off';
}

buildRigPanel();

function setSwellPanelOpen(open: boolean) {
    swellPanelEl.classList.toggle('swell-panel--hidden', !open);
}

swellBtnEl.addEventListener('click', () =>
    setSwellPanelOpen(swellPanelEl.classList.contains('swell-panel--hidden'))
);
document.querySelector('#swell-close')!.addEventListener('click', () => setSwellPanelOpen(false));
document.querySelector('#swell-reset')!.addEventListener('click', () => {
    for (let i = 0; i < SWELLS.length; i++) {
        Object.assign(SWELLS[i], SWELL_DEFAULTS[i]);
        swellSize[i] = 'medium';
    }
    rebuildWaveField();
    renderSwellPanel();
});

buildSwellPanel();

gui.addColor(PARAMS, 'waterColor').name('Water Color').onChange((c: string) => {
    waterMaterial.color.set(c);
});
const skyFolder = gui.addFolder('Sun / Sky');
skyFolder.add(PARAMS, 'sunElevation', 0, 90, 0.1).name('Sun Elevation').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'sunAzimuth', -180, 180, 0.1).name('Sun Azimuth').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'turbidity', 0, 50, 0.1).name('Turbidity').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'rayleigh', 0, 4, 0.01).name('Rayleigh').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'mieCoefficient', 0, 0.1, 0.001).name('Mie Coefficient').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'mieDirectionalG', 0, 1, 0.01).name('Mie Directional G').onChange(updateEnvironment);
skyFolder.addColor(PARAMS, 'fogColor').name('Fog Color').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'fogDensity', 0, 0.02, 0.0005).name('Fog Density').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'ambientIntensity', 0, 2, 0.01).name('Ambient Light').onChange((v: number) => {
    ambientLight.intensity = v;
});
skyFolder.add(PARAMS, 'hemiIntensity', 0, 40, 0.1).name('Hemisphere Light').onChange((v: number) => {
    hemiLight.intensity = v;
});
skyFolder.add(PARAMS, 'dirIntensity', 0, 60, 0.1).name('Directional Light').onChange((v: number) => {
    dirLight.intensity = v;
});
gui.add(PARAMS, 'showWireframe').name('Wireframe').onChange((v: boolean) => {
    waterMaterial.wireframe = v;
});
gui.add(PARAMS, 'chaseCamera').name('Chase Camera').onChange((v: boolean) => {
    useChaseCamera = v;
    controls.enabled = !v;
});

// --- PERFORMANCE STATS ---
const perfStats = {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
};

const statsFolder = gui.addFolder('Performance');
statsFolder.add(perfStats, 'fps').name('FPS').listen().disable();
statsFolder.add(perfStats, 'frameMs').name('Frame (ms)').listen().disable();
statsFolder.add(perfStats, 'drawCalls').name('Draw Calls').listen().disable();
statsFolder.add(perfStats, 'triangles').name('Triangles').listen().disable();

let prevTime = performance.now();
let frameCount = 0;
let fpsAccum = 0;


// --- FOAM WAKE TRAIL ---
const WAKE_MAX_POINTS = 200;
const WAKE_WIDTH_START = 0.15;
const WAKE_WIDTH_END = 2.0;
const WAKE_MAX_AGE = 3.5;
const WAKE_EMIT_INTERVAL = 0.018;
const WAKE_Y_OFFSET = -0.01;

interface WakePoint {
    x: number; z: number;
    perpX: number; perpZ: number;
    age: number;
    speedFactor: number;
}

const wakePoints: WakePoint[] = [];
let lastWakeEmitTime = 0;

const wakeGeom = new THREE.BufferGeometry();
const wakePosBuf = new Float32Array(WAKE_MAX_POINTS * 2 * 3);
const wakeUvBuf = new Float32Array(WAKE_MAX_POINTS * 2 * 2);
wakeGeom.setAttribute('position', new THREE.BufferAttribute(wakePosBuf, 3));
wakeGeom.setAttribute('uv', new THREE.BufferAttribute(wakeUvBuf, 2));

const wakeIdxArr: number[] = [];
for (let i = 0; i < WAKE_MAX_POINTS - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    wakeIdxArr.push(a, c, b, b, c, d);
}
wakeGeom.setIndex(wakeIdxArr);

const wakeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;

        vec3 pm(vec3 x){ return mod(((x*34.0)+1.0)*x, 289.0); }

        float sn(vec2 v){
            const vec4 C=vec4(0.211324865405187,0.366025403784439,
                              -0.577350269189626,0.024390243902439);
            vec2 i=floor(v+dot(v,C.yy));
            vec2 x0=v-i+dot(i,C.xx);
            vec2 i1=(x0.x>x0.y)?vec2(1,0):vec2(0,1);
            vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod(i,289.0);
            vec3 p=pm(pm(i.y+vec3(0,i1.y,1))+i.x+vec3(0,i1.x,1));
            vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
            m=m*m; m=m*m;
            vec3 x3=2.*fract(p*C.www)-1.;
            vec3 h=abs(x3)-.5;
            vec3 ox=floor(x3+.5);
            vec3 a0=x3-ox;
            m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
            vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
            return 130.*dot(m,g);
        }

        void main(){
            float t = vUv.y;

            vec2 nc = vUv * vec2(1.5, 10.0) + vec2(uTime * 0.2, -uTime * 0.1);
            float n1 = sn(nc) * 0.5 + 0.5;
            float n2 = sn(nc * 2.3 + 7.0) * 0.5 + 0.5;
            float foam = smoothstep(0.1, 0.6, n1) * 0.7 + smoothstep(0.3, 0.7, n2) * 0.3;

            float cx = vUv.x * 2.0 - 1.0;
            float edgeFade = 1.0 - cx * cx;

            float ageFade = 1.0 - t;
            ageFade = ageFade * ageFade;

            float alpha = ageFade * foam * edgeFade * 0.4;
            vec3 color = mix(vec3(1.0), vec3(0.75, 0.88, 0.95), t);
            gl_FragColor = vec4(color, alpha);
        }
    `,
});

const wakeMesh = new THREE.Mesh(wakeGeom, wakeMat);
wakeMesh.frustumCulled = false;
//wakeMesh.renderOrder = 1;
scene.add(wakeMesh);

function clearWakeTrail() {
    wakePoints.length = 0;
}

const WAKE_MAST_OFFSET = -0.6;
const WAKE_MIN_SPACING_SQ = 0.15 * 0.15;

function updateWakeTrail(dt: number, time: number) {
    if (gameState === 'riding' && foilState.onFoil && foilState.speed > 1.0) {
        if (time - lastWakeEmitTime >= WAKE_EMIT_INTERVAL) {
            const dir = headingToDir(foilState.heading);
            const ex = foilState.position.x + dir.x * WAKE_MAST_OFFSET;
            const ez = foilState.position.z + dir.z * WAKE_MAST_OFFSET;

            const last = wakePoints.length > 0 ? wakePoints[wakePoints.length - 1] : null;
            const dx = ex - (last?.x ?? -Infinity);
            const dz = ez - (last?.z ?? -Infinity);
            if (dx * dx + dz * dz >= WAKE_MIN_SPACING_SQ) {
                lastWakeEmitTime = time;
                const speedNorm = Math.min(foilState.speed / 12.0, 1.0);
                wakePoints.push({
                    x: ex,
                    z: ez,
                    perpX: -dir.z,
                    perpZ: dir.x,
                    age: 0,
                    speedFactor: speedNorm,
                });
                if (wakePoints.length > WAKE_MAX_POINTS) wakePoints.shift();
            }
        }
    }

    const notFoiling = gameState !== 'riding' || !foilState.onFoil;
    const ageStep = notFoiling ? dt * 7.0 : dt;
    for (const wp of wakePoints) wp.age += ageStep;
    while (wakePoints.length > 0 && wakePoints[0].age >= WAKE_MAX_AGE) wakePoints.shift();

    const posAttr = wakeGeom.getAttribute('position') as THREE.BufferAttribute;
    const uvAttr = wakeGeom.getAttribute('uv') as THREE.BufferAttribute;
    const n = wakePoints.length;

    for (let i = 0; i < n; i++) {
        const vi = i * 2;
        const wp = wakePoints[i];
        const t = wp.age / WAKE_MAX_AGE;
        const width = (WAKE_WIDTH_START + (WAKE_WIDTH_END - WAKE_WIDTH_START) * t)
            * (0.5 + 0.5 * wp.speedFactor);
        const hw = width * 0.5;

        const lx = wp.x - wp.perpX * hw;
        const lz = wp.z - wp.perpZ * hw;
        const rx = wp.x + wp.perpX * hw;
        const rz = wp.z + wp.perpZ * hw;

        const ly = getWaterHeightFast(lx, lz, time) + WAKE_Y_OFFSET;
        const ry = getWaterHeightFast(rx, rz, time) + WAKE_Y_OFFSET;

        posAttr.setXYZ(vi,     lx, ly, lz);
        posAttr.setXYZ(vi + 1, rx, ry, rz);
        uvAttr.setXY(vi, 0, t);
        uvAttr.setXY(vi + 1, 1, t);
    }

    const drawCount = Math.max(0, n - 1) * 6;
    wakeGeom.setDrawRange(0, drawCount);

    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    wakeMat.uniforms.uTime.value = time;
}


// --- FOAM BUBBLES (instanced spheres) ---
const BUBBLE_MAX = 300;
const BUBBLE_MAX_AGE = 4.0;
const BUBBLE_EMIT_RATE = 40;
const BUBBLE_MIN_SIZE = 0.03;
const BUBBLE_MAX_SIZE = 0.12;

interface Bubble {
    x: number; z: number;
    size: number;
    age: number;
    alive: boolean;
}

const bubbles: Bubble[] = [];
for (let i = 0; i < BUBBLE_MAX; i++) {
    bubbles.push({ x: 0, z: 0, size: 0, age: 0, alive: false });
}
let bubbleHead = 0;
let bubbleEmitAccum = 0;

const bubbleGeom = new THREE.SphereGeometry(1, 6, 4);
const bubbleMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0.0,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
});

const bubbleInstMesh = new THREE.InstancedMesh(bubbleGeom, bubbleMat, BUBBLE_MAX);
bubbleInstMesh.frustumCulled = false;
scene.add(bubbleInstMesh);

const _bubbleMat4 = new THREE.Matrix4();
const _bubbleZeroScale = new THREE.Matrix4().makeScale(0, 0, 0);

for (let i = 0; i < BUBBLE_MAX; i++) {
    bubbleInstMesh.setMatrixAt(i, _bubbleZeroScale);
}
bubbleInstMesh.instanceMatrix.needsUpdate = true;

function clearBubbles() {
    for (const b of bubbles) b.alive = false;
    for (let i = 0; i < BUBBLE_MAX; i++) {
        bubbleInstMesh.setMatrixAt(i, _bubbleZeroScale);
    }
    bubbleInstMesh.instanceMatrix.needsUpdate = true;
}

function updateBubbles(dt: number, time: number) {
    const foiling = gameState === 'riding' && foilState.onFoil && foilState.speed > 1.0;

    if (foiling) {
        bubbleEmitAccum += BUBBLE_EMIT_RATE * dt;
        const dir = headingToDir(foilState.heading);
        const mastX = foilState.position.x + dir.x * WAKE_MAST_OFFSET;
        const mastZ = foilState.position.z + dir.z * WAKE_MAST_OFFSET;

        while (bubbleEmitAccum >= 1.0) {
            bubbleEmitAccum -= 1.0;
            const spread = 0.2;//    + foilState.speed * 0.05;
            const b = bubbles[bubbleHead];
            b.x = mastX + (Math.random() - 0.5) * spread;
            b.z = mastZ + (Math.random() - 0.5) * spread;
            b.size = BUBBLE_MIN_SIZE + Math.random() * (BUBBLE_MAX_SIZE - BUBBLE_MIN_SIZE);
            b.age = 0;
            b.alive = true;
            bubbleHead = (bubbleHead + 1) % BUBBLE_MAX;
        }
    } else {
        bubbleEmitAccum = 0;
    }

    let anyUpdate = false;

    for (let i = 0; i < BUBBLE_MAX; i++) {
        const b = bubbles[i];
        if (!b.alive) continue;

        b.age += dt;
        if (b.age >= BUBBLE_MAX_AGE) {
            b.alive = false;
            bubbleInstMesh.setMatrixAt(i, _bubbleZeroScale);
            anyUpdate = true;
            continue;
        }

        const fade = 1.0 - (b.age / BUBBLE_MAX_AGE);
        const s = b.size * fade;
        const y = getWaterHeightFast(b.x, b.z, time) - s * 0.5;

        _bubbleMat4.makeScale(s, s, s);
        _bubbleMat4.setPosition(b.x, y, b.z);
        bubbleInstMesh.setMatrixAt(i, _bubbleMat4);
        anyUpdate = true;
    }

    if (anyUpdate) {
        bubbleInstMesh.instanceMatrix.needsUpdate = true;
    }
}


// --- GPS MINIMAP ---
const GPS_SAMPLE_INTERVAL = 0.15;
const GPS_CANVAS_W = 180;
const GPS_CANVAS_H = 220;
const GPS_DPR = Math.min(window.devicePixelRatio, 2);

const gpsCanvas = document.querySelector('#gps-minimap') as HTMLCanvasElement;
const gpsCtx = gpsCanvas.getContext('2d')!;
gpsCanvas.width = GPS_CANVAS_W * GPS_DPR;
gpsCanvas.height = GPS_CANVAS_H * GPS_DPR;
gpsCtx.scale(GPS_DPR, GPS_DPR);

interface GpsPoint { x: number; z: number; speed: number; }
const gpsPath: GpsPoint[] = [];
let gpsStartPoint: GpsPoint | null = null;
let lastGpsSampleTime = -1;

function resetGpsPath() {
    gpsPath.length = 0;
    gpsStartPoint = null;
    lastGpsSampleTime = -1;
}

function sampleGpsPoint(time: number) {
    if (gameState === 'starting') return;
    if (!gpsStartPoint) {
        gpsStartPoint = { x: foilState.position.x, z: foilState.position.z, speed: 0 };
    }
    if (gameState !== 'riding') return;
    if (time - lastGpsSampleTime >= GPS_SAMPLE_INTERVAL) {
        lastGpsSampleTime = time;
        gpsPath.push({ x: foilState.position.x, z: foilState.position.z, speed: foilState.speed * 1.944 });
    }
}

function gpsSpeedColor(kts: number): string {
    const lo = 16, hi = 32;
    const t = Math.max(0, Math.min(1, (kts - lo) / (hi - lo)));
    // red (0) → yellow (0.5) → green (1), with slight desaturation at extremes
    const r = Math.round(t < 0.5 ? 230 : 230 - (t - 0.5) * 2 * 180);
    const g = Math.round(t < 0.5 ? 60 + t * 2 * 180 : 240);
    const b = Math.round(50 + (1 - Math.abs(t - 0.5) * 2) * 20);
    return `rgba(${r},${g},${b},0.9)`;
}

function drawGpsMinimap() {
    const w = GPS_CANVAS_W;
    const h = GPS_CANVAS_H;
    const pad = 14;
    const ctx = gpsCtx;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = 'rgba(0, 18, 36, 0.72)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 10);
    ctx.fill();

    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 10);
    ctx.stroke();

    const startZ = RACE_START_Z;
    const finishZ = RACE_START_Z + RACE_LENGTH_KM * 1000;
    const zRange = finishZ - startZ;

    // Find X extents from path
    let minX = gpsStartPoint ? gpsStartPoint.x : foilState.position.x;
    let maxX = minX;
    for (const p of gpsPath) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
    }
    if (gameState !== 'starting') {
        minX = Math.min(minX, foilState.position.x);
        maxX = Math.max(maxX, foilState.position.x);
    }

    // Ensure minimum lateral spread so the trail is visible
    const xSpread = Math.max(maxX - minX, zRange * 0.25);
    const centerX = (minX + maxX) / 2;

    const drawW = w - pad * 2;
    const drawH = h - pad * 2;

    const scaleZ = drawH / zRange;
    const scaleX = drawW / xSpread;
    const scale = Math.min(scaleX, scaleZ);

    // Centering offsets
    const usedW = xSpread * scale;
    const usedH = zRange * scale;
    const offsetX = pad + (drawW - usedW) / 2;
    const offsetY = pad + (drawH - usedH) / 2;

    // World → canvas: Z goes bottom-to-top, X mirrored so left in-game = left on map
    const toCanvas = (wx: number, wz: number): [number, number] => {
        const cx = offsetX + (centerX - wx + xSpread / 2) * scale;
        const cy = offsetY + (finishZ - wz) * scale;
        return [cx, cy];
    };

    // Distance grid lines — 250m for 1km race, 1km for longer races
    const gridStepM = RACE_LENGTH_KM <= 1 ? 250 : 1000;
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    for (let m = gridStepM; m < RACE_LENGTH_KM * 1000; m += gridStepM) {
        const kz = startZ + m;
        const [lx, ly] = toCanvas(centerX - xSpread / 2, kz);
        const [rx] = toCanvas(centerX + xSpread / 2, kz);
        const isKm = m % 1000 === 0;
        ctx.strokeStyle = isKm ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(rx, ly);
        ctx.stroke();
        const label = isKm ? `${m / 1000}k` : `${m / 1000}`;
        ctx.fillStyle = isKm ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.2)';
        ctx.fillText(label, lx + 2, ly - 2);
    }
    ctx.setLineDash([]);

    // Finish line (checkered dashes)
    const [fl1, fly] = toCanvas(centerX - xSpread / 2, finishZ);
    const [fl2] = toCanvas(centerX + xSpread / 2, finishZ);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.max(pad, fl1), fly);
    ctx.lineTo(Math.min(w - pad, fl2), fly);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('FINISH', w / 2, fly - 4);

    // Start line
    const [sl1, sly] = toCanvas(centerX - xSpread / 2, startZ);
    const [sl2] = toCanvas(centerX + xSpread / 2, startZ);
    ctx.strokeStyle = 'rgba(76, 175, 80, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.max(pad, sl1), sly);
    ctx.lineTo(Math.min(w - pad, sl2), sly);
    ctx.stroke();

    // Path trail — colored by speed (red ≤10 kts → green ≥25 kts)
    if (gpsPath.length > 1) {
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (let i = 1; i < gpsPath.length; i++) {
            const [x0, y0] = toCanvas(gpsPath[i - 1].x, gpsPath[i - 1].z);
            const [x1, y1] = toCanvas(gpsPath[i].x, gpsPath[i].z);
            const kts = gpsPath[i].speed;
            ctx.strokeStyle = gpsSpeedColor(kts);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        }
    }

    // Start dot (green)
    if (gpsStartPoint) {
        const [sx, sy] = toCanvas(gpsStartPoint.x, gpsStartPoint.z);
        ctx.fillStyle = '#4caf50';
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(76, 175, 80, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Current position dot — pulsing blue
    if (gameState !== 'starting') {
        const [cx, cy] = toCanvas(foilState.position.x, foilState.position.z);
        const t = performance.now() / 1000;
        const pulse = 0.5 + 0.5 * Math.sin(t * 3.5);

        if (gameState === 'crashed') {
            ctx.fillStyle = 'rgba(239, 83, 80, 0.25)';
            ctx.beginPath();
            ctx.arc(cx, cy, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ef5350';
            ctx.beginPath();
            ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
            ctx.fill();
        } else {
            const outerR = 7 + pulse * 5;
            const outerAlpha = 0.12 + pulse * 0.1;
            ctx.fillStyle = `rgba(60, 140, 255, ${outerAlpha})`;
            ctx.beginPath();
            ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = 'rgba(60, 140, 255, 0.3)';
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#3c8cff';
            ctx.beginPath();
            ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = `rgba(180, 215, 255, ${0.5 + pulse * 0.5})`;
            ctx.beginPath();
            ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Title label
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('GPS', pad, pad - 3);
}


// --- INSTRUMENT CLUSTER ---
// Canvas readouts giving the rider what a real foiler gets through their feet:
// which bump they are on, where the set is, and whether the foil is trimmed.

const INST_DPR = Math.min(window.devicePixelRatio, 2);

function setupInstCanvas(id: string, w: number, h: number): CanvasRenderingContext2D {
    const c = document.querySelector(id) as HTMLCanvasElement;
    c.width = w * INST_DPR;
    c.height = h * INST_DPR;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d')!;
    ctx.scale(INST_DPR, INST_DPR);
    return ctx;
}

const INST_WAVETRAIN = { w: 320, h: 112 };
const INST_SET = { w: 152, h: 112 };
const INST_RADAR = { w: 160, h: 112 };
const INST_TRIM = { w: 168, h: 190 };

// How far the wave train looks ahead/behind. Cycled by clicking the panel:
// ~1 set length by default so the group structure is visible.
const WAVETRAIN_RANGES = [
    { behind: 150, ahead: 350 },
    { behind: 300, ahead: 700 },
    { behind: 60, ahead: 140 },
];
let waveTrainRange = 0;

const instWaveTrainCtx = setupInstCanvas('#inst-wavetrain', INST_WAVETRAIN.w, INST_WAVETRAIN.h);
const instSetCtx = setupInstCanvas('#inst-set', INST_SET.w, INST_SET.h);
const instRadarCtx = setupInstCanvas('#inst-radar', INST_RADAR.w, INST_RADAR.h);
const instTrimCtx = setupInstCanvas('#inst-trim', INST_TRIM.w, INST_TRIM.h);

const instrumentsEl = document.querySelector('#instruments') as HTMLElement;
const trimDockEl = document.querySelector('#trim-dock') as HTMLElement;
const instToggleEl = document.querySelector('#inst-toggle') as HTMLButtonElement;

let instrumentsVisible = true;
function setInstrumentsVisible(v: boolean) {
    instrumentsVisible = v;
    instrumentsEl.classList.toggle('instruments--hidden', !v);
    trimDockEl.classList.toggle('instruments--hidden', !v);
    instToggleEl.style.opacity = v ? '1' : '0.5';
}
instToggleEl.addEventListener('click', () => setInstrumentsVisible(!instrumentsVisible));

// Click the wave train to cycle how far it looks up and down the track.
(document.querySelector('#inst-wavetrain') as HTMLCanvasElement)
    .addEventListener('click', () => {
        waveTrainRange = (waveTrainRange + 1) % WAVETRAIN_RANGES.length;
    });

const _riderReadout: RiderReadout = {
    x: 0, z: 0, heading: 0, track: 0, speed: 0, rideHeight: 0,
    mastLength: MAST_LENGTH, footPressure: 0, footPressureTrim: 0, alpha: 0,
    alphaTrim: 0, inflowAngle: 0,
    loadFactor: 1, wingDepth: 0, ventFactor: 1, orbitalW: 0, roll: 0, pitch: 0,
    onFoil: true, surfaceHeight: 0, ventDepth: VENT_DEPTH,
};

function drawInstruments(time: number) {
    if (!instrumentsVisible) return;

    const r = _riderReadout;
    r.x = foilState.position.x;
    r.z = foilState.position.z;
    r.heading = foilState.heading;
    r.track = foilState.speed > 0.5
        ? Math.atan2(foilState.velocity.x, foilState.velocity.z)
        : foilState.heading;
    r.speed = foilState.speed;
    r.rideHeight = foilState.rideHeight;
    r.footPressure = foilState.footPressure;
    r.footPressureTrim = foilState.footPressureTrim;
    r.alpha = foilState.alpha;
    r.alphaTrim = foilState.alphaTrim;
    r.inflowAngle = foilState.inflowAngle;
    r.loadFactor = foilState.loadFactor;
    r.wingDepth = foilState.wingDepth;
    r.ventFactor = foilState.ventFactor;
    r.orbitalW = foilState.orbitalW;
    r.roll = foilState.roll;
    r.pitch = foilState.pitch;
    r.onFoil = foilState.onFoil;
    r.surfaceHeight = foilState.surfaceY;

    // Instrument the swell that is actually biggest under the rider right now.
    const dom = dominantSwell(waveField, r.x, r.z, time);
    const si = dom.index >= 0 ? dom.index : 0;

    const range = WAVETRAIN_RANGES[waveTrainRange];
    drawWaveTrain(instWaveTrainCtx, INST_WAVETRAIN.w, INST_WAVETRAIN.h,
        waveField, r, time, { ...range, swellIndex: si });
    drawSetMeter(instSetCtx, INST_SET.w, INST_SET.h, waveField, r, time, si);
    drawSwellRadar(instRadarCtx, INST_RADAR.w, INST_RADAR.h, waveField,
        SWELLS.map(s => s.name), SWELLS.map(s => s.enabled), r);
    drawTrimGauge(instTrimCtx, INST_TRIM.w, INST_TRIM.h, waveField, r, time);
}


// --- RACE MARKERS ---
// All buoys and the finish gate are centred on `raceTrackX`, which smoothly
// tracks the player's lateral (X) position.  Each buoy stores its relative
// X offset from that centre so the whole course shifts with the rider.

// raceTrackX starts at 0 and lerps toward the player's X every frame.
let raceTrackX = 0;

interface RaceBuoy {
    group: THREE.Group;
    relativeX: number; // offset from raceTrackX centre
    baseZ: number;
}
const raceBuoys: RaceBuoy[] = [];

function createBuoyMesh(red: boolean): THREE.Group {
    const g = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.22, 0.9, 8);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: red ? 0xcc2200 : 0xf0f0f0,
        roughness: 0.6,
        metalness: 0.0,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.45;
    g.add(body);

    const ballGeo = new THREE.SphereGeometry(0.3, 8, 6);
    const ballMat = new THREE.MeshStandardMaterial({
        color: red ? 0xff3300 : 0xffffff,
        roughness: 0.35,
    });
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.position.y = 1.05;
    g.add(ball);

    return g;
}

// Relative X offsets within each km cluster (centred on 0)
const BUOY_REL_X = [-55, -33, -13, 0, 13, 33, 55];

for (let km = 1; km <= RACE_LENGTH_KM; km++) {
    const z = RACE_START_Z + km * 1000;
    for (let i = 0; i < BUOY_REL_X.length; i++) {
        const isRed = i % 2 === 0;
        const buoyGroup = createBuoyMesh(isRed);
        buoyGroup.position.set(BUOY_REL_X[i], 0, z); // initial X; updated every frame
        scene.add(buoyGroup);
        raceBuoys.push({ group: buoyGroup, relativeX: BUOY_REL_X[i], baseZ: z });
    }
}

// Finish gate — two tall orange poles with a checkered crossbar
let FINISH_Z = RACE_START_Z + RACE_LENGTH_KM * 1000;
const finishGate = new THREE.Group();
finishGate.position.set(0, 0, FINISH_Z);
scene.add(finishGate);

const poleMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.5 });
const poleGeo = new THREE.CylinderGeometry(0.28, 0.28, 12, 8);

const gateLeftPole = new THREE.Mesh(poleGeo, poleMat);
gateLeftPole.position.set(-30, 6, 0);
finishGate.add(gateLeftPole);

const gateRightPole = new THREE.Mesh(poleGeo, poleMat);
gateRightPole.position.set(30, 6, 0);
finishGate.add(gateRightPole);

// Big orange buoys at the base of each pole
const gateBuoyGeo = new THREE.SphereGeometry(0.9, 10, 7);
const gateBuoyMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.4 });
[[-30], [30]].forEach(([bx]) => {
    const gb = new THREE.Mesh(gateBuoyGeo, gateBuoyMat);
    gb.position.set(bx, 0.9, 0);
    finishGate.add(gb);
});

// Checkered crossbar made of alternating black/white segments
const crossBarY = 12;
const segCount = 33;
const totalBarWidth = 66;
const segW = totalBarWidth / segCount;
const segGeo = new THREE.BoxGeometry(segW - 0.05, 0.7, 0.5);
for (let i = 0; i < segCount; i++) {
    const segMat = new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? 0x111111 : 0xffffff,
        roughness: 0.5,
    });
    const seg = new THREE.Mesh(segGeo, segMat);
    seg.position.set(-totalBarWidth / 2 + segW * (i + 0.5), crossBarY, 0);
    finishGate.add(seg);
}

// Thin support rod behind the segments
const rodGeo = new THREE.CylinderGeometry(0.1, 0.1, totalBarWidth + 0.5, 6);
rodGeo.rotateZ(Math.PI / 2);
const rodMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5 });
const rod = new THREE.Mesh(rodGeo, rodMat);
rod.position.set(0, crossBarY, -0.3);
finishGate.add(rod);

// finishGate X is driven by raceTrackX (set to 0 initially)

function rebuildRaceCourse() {
    // Remove old buoys
    for (const buoy of raceBuoys) scene.remove(buoy.group);
    raceBuoys.length = 0;

    // Spawn new buoys
    for (let km = 1; km <= RACE_LENGTH_KM; km++) {
        const z = RACE_START_Z + km * 1000;
        for (let i = 0; i < BUOY_REL_X.length; i++) {
            const buoyGroup = createBuoyMesh(i % 2 === 0);
            buoyGroup.position.set(BUOY_REL_X[i], 0, z);
            scene.add(buoyGroup);
            raceBuoys.push({ group: buoyGroup, relativeX: BUOY_REL_X[i], baseZ: z });
        }
    }

    // Move finish gate
    FINISH_Z = RACE_START_Z + RACE_LENGTH_KM * 1000;
    finishGate.position.z = FINISH_Z;

    // Rebuild km tick marks
    kmTickRow.innerHTML = '';
    for (let k = 1; k <= RACE_LENGTH_KM; k++) {
        const tick = document.createElement('span');
        tick.textContent = `${k}km`;
        kmTickRow.appendChild(tick);
    }
}


// --- INPUT SYSTEM ---
function isTypingInInput(): boolean {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
    if (isTypingInInput()) return;
    switch (e.code) {
        case 'ArrowLeft': input.left = true; break;
        case 'ArrowRight': input.right = true; break;
        case 'ArrowUp': input.up = true; break;
        case 'ArrowDown': input.down = true; break;
        case 'Space':
            e.preventDefault();
            if (gameState === 'starting') {
                launchFoil();
            } else if (gameState === 'riding') {
                input.pump = true;
            }
            break;
        case 'KeyR':
            if (gameState === 'crashed' || race.finished) {
                resetFoilState();
            }
            break;
        case 'KeyV':
            resetChaseView();
            break;
        case 'BracketLeft':
            setViz(vizIndex - 1);
            vizNoteEl.textContent =
                `${vizIndex}. ${VIZ_PRESETS[vizIndex].name} — ${VIZ_PRESETS[vizIndex].note}`;
            break;
        case 'BracketRight':
            setViz(vizIndex + 1);
            vizNoteEl.textContent =
                `${vizIndex}. ${VIZ_PRESETS[vizIndex].name} — ${VIZ_PRESETS[vizIndex].note}`;
            break;
        case 'KeyI':
            setInstrumentsVisible(!instrumentsVisible);
            break;
        case 'KeyS':
            setSwellPanelOpen(swellPanelEl.classList.contains('swell-panel--hidden'));
            break;
        case 'KeyC':
            useChaseCamera = !useChaseCamera;
            controls.enabled = !useChaseCamera;
            PARAMS.chaseCamera = useChaseCamera;
            gui.controllersRecursive().forEach(c => c.updateDisplay());
            break;
    }
});

window.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'ArrowLeft': input.left = false; break;
        case 'ArrowRight': input.right = false; break;
        case 'ArrowUp': input.up = false; break;
        case 'ArrowDown': input.down = false; break;
    }
});


// --- PHYSICS UPDATE ---
function updatePhysics(dt: number, time: number) {
    if (gameState !== 'riding') return;

    dt = Math.min(dt, 1 / 30);

    const foil = activeFoil;
    const speed = foilState.velocity.length();
    foilState.speed = speed;

    let targetRoll = 0;
    if (input.steerX !== 0) {
        targetRoll = -input.steerX * MAX_ROLL;
    } else {
        if (input.left) targetRoll = MAX_ROLL;
        if (input.right) targetRoll = -MAX_ROLL;
    }

    // Fore/aft weight shift. This mapping matches the ORIGINAL game exactly and
    // must not be changed — only how it is drawn:
    //
    //   up arrow   -> back foot  -> more angle of attack -> CLIMB
    //   down arrow -> front foot -> less angle of attack -> SINK
    //
    // The original's own 3D board tipped its nose DOWN while climbing, which
    // reads as an inverted control. That is a fault in the drawing, not the
    // control, and is corrected in updateBoardVisuals rather than here.
    let targetFoot = 0;
    if (input.pitchY !== 0) {
        targetFoot = -input.pitchY;
    } else {
        if (input.up) targetFoot = 1;
        if (input.down) targetFoot = -1;
    }
    foilState.footPressure +=
        (targetFoot - foilState.footPressure) * Math.min(1, FOOT_RESPONSE * dt);

    // Sample wave surface at center and both wingtips
    const wave = sampleWaveAtFoilPoints(time);

    // Wave-induced roll torque from height difference across wingspan
    const heightDiff = wave.rightTip.position.y - wave.leftTip.position.y;
    const waveTorque = (heightDiff / foil.wingSpan) * WAVE_TORQUE_GAIN;

    // Spring-damper roll dynamics with wave torque
    const rollError = targetRoll - foilState.roll;
    const rollAccel = rollError * ROLL_SPRING - foilState.rollRate * ROLL_DAMPING + waveTorque;
    foilState.rollRate += rollAccel * dt;
    foilState.roll += foilState.rollRate * dt;
    foilState.roll = THREE.MathUtils.clamp(foilState.roll, -MAX_ROLL * 1.2, MAX_ROLL * 1.2);

    // Board attitude follows foot pressure (visual + used for wave-relative trim)
    foilState.pitch += (foilState.footPressure * MAX_PITCH - foilState.pitch) * 5.0 * dt;

    // --- Foil flight: angle of attack drives lift ---
    // Wing depth below the surface. rideHeight is the board above the water, so
    // the wing sits (mast - rideHeight) down. Fly too high and it ventilates.
    const wingDepth = Math.max(0, MAST_LENGTH - foilState.rideHeight);
    const ventFactor = smoothstep(0.03, VENT_DEPTH, wingDepth);

    // Vertical water motion at the wing adds angle of attack for free — this is
    // what lets you hold flight on the right part of a bump without pumping.
    const orbitalW = verticalOrbitalVelocity(
        waveField, foilState.position.x, foilState.position.z, time, wingDepth
    );

    // Inflow angle: climbing reduces AoA, rising water increases it. This
    // feedback is what makes the foil naturally self-damping (and porpoise).
    const vRef = Math.max(speed, 1.5);
    const inflowAngle = Math.atan2(foilState.vy - orbitalW, vRef);
    const alphaTrim = ALPHA_NEUTRAL + foilState.footPressure * ALPHA_RANGE;
    let alpha = alphaTrim - inflowAngle;
    foilState.inflowAngle = inflowAngle;
    foilState.alphaTrim = alphaTrim;

    // Finite-wing lift slope (lifting-line): CL_alpha = 2*pi*AR / (AR + 2)
    const clAlpha = (2 * Math.PI * foil.aspectRatio) / (foil.aspectRatio + 2);
    // Soft stall: CL rolls off past ALPHA_STALL instead of climbing forever.
    const alphaEff = Math.sign(alpha) *
        Math.min(Math.abs(alpha), ALPHA_STALL) *
        (1 - 0.7 * smoothstep(ALPHA_STALL, ALPHA_STALL * 1.6, Math.abs(alpha)));
    const CL = clAlpha * alphaEff;

    const liftMag = 0.5 * RHO_WATER * speed * speed * CL * foil.wingArea * ventFactor;

    foilState.alpha = alpha;
    foilState.wingDepth = wingDepth;
    foilState.ventFactor = ventFactor;
    foilState.orbitalW = orbitalW;
    foilState.loadFactor = liftMag / (riderMass * GRAVITY);

    // Foot pressure that would exactly hold altitude at this speed — the marker
    // the player chases on the trim gauge.
    const clNeeded = (riderMass * GRAVITY) /
        Math.max(0.5 * RHO_WATER * speed * speed * foil.wingArea * Math.max(ventFactor, 0.05), 1e-3);
    const alphaNeeded = clNeeded / clAlpha;
    foilState.footPressureTrim = THREE.MathUtils.clamp(
        (alphaNeeded + inflowAngle - ALPHA_NEUTRAL) / ALPHA_RANGE, -1.5, 1.5
    );

    // --- Drag force ---
    const inducedCD = (CL * CL) / (Math.PI * foil.aspectRatio * 0.85);
    const totalCD = foil.baseDragCoeff + inducedCD;
    let dragMag = 0.5 * RHO_WATER * speed * speed * totalCD * foil.wingArea;
    // Mast drag
    dragMag += 0.5 * RHO_WATER * speed * speed * 0.8 * MAST_DRAG_AREA;
    // Board touching water drag penalty
    if (foilState.rideHeight < 0.1) {
        const wetFactor = 1.0 - foilState.rideHeight / 0.1;
        dragMag += wetFactor * 0.5 * RHO_WATER * speed * speed * 0.3 * 0.05;
    }

    // --- Accumulate horizontal forces ---
    const force = new THREE.Vector3(0, 0, 0);

    // Wave propulsion: the lift vector tilting forward in rising water.
    //
    // A foiler is not a sled on the surface — they are flying, connected to the
    // water only through a wing half a metre down. Gravity along the surface
    // slope does not act on them. What does act is that lift is perpendicular
    // to the LOCAL FLOW, so where orbital motion carries water upward past the
    // wing, the lift vector tilts forward and its forward component is thrust.
    // Same mechanism as a glider working ridge lift.
    //
    // This also gives the speed limit the old model lacked. Thrust scales with
    // the flow tilt w/V, so it falls away as you accelerate, while drag climbs
    // with V^2. The two cross at a natural terminal speed instead of letting
    // pump-spam run away.
    const flowTilt = Math.atan2(orbitalW - foilState.vy, vRef);
    const thrustMag = liftMag * Math.sin(flowTilt) * WAVE_ENERGY_MULT;
    if (speed > 0.5) {
        force.addScaledVector(foilState.velocity.clone().normalize(), thrustMag);
    } else {
        force.addScaledVector(headingToDir(foilState.heading), thrustMag);
    }
    foilState.waveThrust = thrustMag;

    // Apparent wind on rider and board
    if (WIND.enabled && WIND.speed > 0.01) {
        const wd = THREE.MathUtils.degToRad(WIND.direction);
        const relX = Math.sin(wd) * WIND.speed - foilState.velocity.x;
        const relZ = Math.cos(wd) * WIND.speed - foilState.velocity.z;
        const relSpeed = Math.hypot(relX, relZ);
        const q = 0.5 * RHO_AIR * RIDER_DRAG_AREA * relSpeed * WIND.force;
        force.x += q * relX;
        force.z += q * relZ;
        foilState.apparentWind = relSpeed;
        foilState.apparentWindDir = Math.atan2(relX, relZ);
    } else {
        foilState.apparentWind = 0;
        foilState.apparentWindDir = 0;
    }

    // Drag opposing velocity
    if (speed > 0.01) {
        const dragDir = foilState.velocity.clone().normalize();
        force.addScaledVector(dragDir, -dragMag);
    }

    // --- Turning from roll ---
    if (Math.abs(foilState.roll) > 0.01 && speed > 1.0) {
        const centripetal = liftMag * Math.sin(foilState.roll);
        let headingRate = centripetal / (riderMass * Math.max(speed, 2.0));
        headingRate = THREE.MathUtils.clamp(headingRate, -foil.turnRateMax, foil.turnRateMax);
        foilState.heading += headingRate * dt;
    }

    // --- Pump ---
    if (input.pump && foilState.energy >= PUMP_COST && (time - foilState.lastPumpTime) > PUMP_COOLDOWN) {
        const pumpDir = headingToDir(foilState.heading);
        // A pump works by the same mechanism as the wave: oscillating the foil
        // throws extra flow past the wing and tilts lift forward. That tilt is
        // w/V, so it fades as you speed up. A flat impulse let riders pump
        // their way to 38 kt, which no amount of pumping achieves in reality.
        const pumpGain = Math.min(1, trimSpeedFor(foil, riderMass) / Math.max(speed, 0.5));
        foilState.velocity.addScaledVector(pumpDir, PUMP_IMPULSE * pumpGain);
        foilState.energy -= PUMP_COST;
        foilState.lastPumpTime = time;
        foilState.vy += 0.35;
        triggerPumpAnim();
        input.pump = false;
    }
    input.pump = false;

    // Energy regen
    foilState.energy = Math.min(100, foilState.energy + ENERGY_REGEN * dt);

    // --- Integrate velocity ---
    const accel = force.clone().divideScalar(riderMass);
    foilState.velocity.addScaledVector(accel, dt);
    foilState.velocity.y = 0;

    // Lateral slip decay: foil has high sideways resistance
    const dir = headingToDir(foilState.heading);
    const fwdSpeed = foilState.velocity.dot(dir);
    const lateral = foilState.velocity.clone().addScaledVector(dir, -fwdSpeed);
    lateral.multiplyScalar(Math.exp(-LATERAL_RESISTANCE * dt));
    foilState.velocity.copy(dir.clone().multiplyScalar(fwdSpeed)).add(lateral);

    // --- Integrate position ---
    foilState.position.addScaledVector(foilState.velocity, dt);
    foilState.distanceTravelled += speed * dt;

    // --- Vertical flight dynamics ---
    // Integrated in the WORLD frame, not relative to the water. Ride height is
    // then derived by subtracting the surface, which is itself heaving and
    // sliding underneath the rider. Getting this wrong makes the board fall
    // through the surface every time a wave lifts under it.
    const verticalLift = liftMag * Math.cos(foilState.roll);
    const heaveAccel =
        (verticalLift - riderMass * GRAVITY) / riderMass
        - foilState.vy * HEAVE_DAMPING;

    foilState.vy += heaveAccel * dt;
    foilState.worldY += foilState.vy * dt;

    // Re-sample the surface at the position we just moved to, so ride height is
    // measured against the water actually under the board this frame.
    const surfaceNow = getSurfaceInfoAtWorldPos(
        foilState.position.x, foilState.position.z, time
    );
    foilState.surfaceY = surfaceNow.position.y;
    foilState.rideHeight = foilState.worldY - foilState.surfaceY;

    // The board cannot rise past the mast — the wing would be out of the water.
    if (foilState.rideHeight > MAST_LENGTH) {
        foilState.rideHeight = MAST_LENGTH;
        foilState.worldY = foilState.surfaceY + MAST_LENGTH;
        if (foilState.vy > 0) foilState.vy = 0;
    }

    foilState.speed = foilState.velocity.length();

    // --- Check crash ---
    if (foilState.rideHeight <= 0.001) {
        // Board has hit the water.
        crashFoil(foilState.speed < stallSpeedFor(foil, riderMass) * 0.9 ? 'stall' : 'touchdown');
    } else if (wingDepth < 0.04 && foilState.vy - foilState.orbitalW > 0.2) {
        // Wing has come out of the water while still climbing — a breach.
        crashFoil('breach');
    }
}

function crashFoil(reason: 'breach' | 'touchdown' | 'stall') {
    foilState.rideHeight = 0;
    foilState.vy = 0;
    foilState.onFoil = false;
    foilState.speed = 0;
    foilState.velocity.set(0, 0, 0);
    foilState.crashReason = reason;
    gameState = 'crashed';
}


// --- CHASE CAMERA ---
const _chaseCamPos = new THREE.Vector3();
const _chaseLookAt = new THREE.Vector3();

const CHASE_CAM_LATERAL_MAG = 10;
const CHASE_CAM_DEAD_ZONE = 0.1;
const CHASE_CAM_SWING_SPEED = 1.0;

let chaseCamLateralTarget = -CHASE_CAM_LATERAL_MAG;
let chaseCamLateralSmoothed = -CHASE_CAM_LATERAL_MAG;

// --- Chase camera mouse control ---
// The chase framing stays automatic, but the wheel pulls the camera back and
// dragging swings it around the rider. Useful for judging how big the swell
// actually is, which is impossible from a fixed close-in view.
const CHASE_BASE_DIST = 16;
const CHASE_BASE_HEIGHT = 9;
let chaseZoom = 1;
let chaseYaw = 0;
let chasePitch = 0;
let chaseDragging = false;

canvas.addEventListener('wheel', (e) => {
    if (!useChaseCamera) return;
    e.preventDefault();
    chaseZoom = THREE.MathUtils.clamp(chaseZoom * Math.exp(e.deltaY * 0.0012), 0.35, 8);
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
    if (!useChaseCamera || e.button !== 0) return;
    chaseDragging = true;
    canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
    if (!chaseDragging) return;
    chaseYaw += e.movementX * 0.005;
    chasePitch = THREE.MathUtils.clamp(chasePitch + e.movementY * 0.004, -0.6, 1.1);
});

function endChaseDrag() { chaseDragging = false; }
canvas.addEventListener('pointerup', endChaseDrag);
canvas.addEventListener('pointercancel', endChaseDrag);

/** Return the view to the default over-the-shoulder framing. */
function resetChaseView() {
    chaseZoom = 1;
    chaseYaw = 0;
    chasePitch = 0;
}

function updateChaseCamera(dt: number) {
    if (!useChaseCamera) {
        controls.enabled = true;
        controls.target.lerp(boardGroup.position, 0.1);
        controls.update();
        return;
    }

    controls.enabled = false;

    const headDir = headingToDir(foilState.heading);
    const rightDir = new THREE.Vector3(headDir.z, 0, -headDir.x);

    // Swing camera side based on rider heading vs wave direction (+Z).
    // sin(heading) > 0 → heading left of downwind → camera on left (-lateral)
    // sin(heading) < 0 → heading right of downwind → camera on right (+lateral)
    const headingSin = Math.sin(foilState.heading);
    if (headingSin > CHASE_CAM_DEAD_ZONE) {
        chaseCamLateralTarget = -CHASE_CAM_LATERAL_MAG;
    } else if (headingSin < -CHASE_CAM_DEAD_ZONE) {
        chaseCamLateralTarget = CHASE_CAM_LATERAL_MAG;
    }

    chaseCamLateralSmoothed += (chaseCamLateralTarget - chaseCamLateralSmoothed)
        * (1.0 - Math.exp(-CHASE_CAM_SWING_SPEED * dt));

    // Orbit offset applied on top of the automatic framing.
    const cy = Math.cos(chaseYaw), sy = Math.sin(chaseYaw);
    const backX = -headDir.x * cy - rightDir.x * sy;
    const backZ = -headDir.z * cy - rightDir.z * sy;
    const dist = CHASE_BASE_DIST * chaseZoom;

    _chaseCamPos.set(
        boardGroup.position.x + backX * dist + rightDir.x * chaseCamLateralSmoothed * chaseZoom,
        boardGroup.position.y + CHASE_BASE_HEIGHT * chaseZoom + chasePitch * dist,
        boardGroup.position.z + backZ * dist + rightDir.z * chaseCamLateralSmoothed * chaseZoom
    );

    const followFactor = 1.0 - Math.exp(-3.0 * dt);
    camera.position.lerp(_chaseCamPos, followFactor);

    _chaseLookAt.copy(boardGroup.position)
        .addScaledVector(headDir, 8 * Math.min(chaseZoom, 2));

    camera.lookAt(_chaseLookAt);
}


// --- BOARD VISUAL UPDATE ---
function updateBoardVisuals(time: number) {
    const wave = getSurfaceInfoAtWorldPos(
        foilState.position.x,
        foilState.position.z,
        time
    );

    if (gameState === 'starting') {
        // Float on the surface
        boardGroup.position.copy(wave.position);
        const up = new THREE.Vector3(0, 1, 0);
        boardGroup.quaternion.setFromUnitVectors(up, wave.normal);
        return;
    }

    // Position: wave surface + ride height along surface normal
    boardGroup.position.set(
        wave.position.x,
        wave.position.y + foilState.rideHeight,
        wave.position.z
    );

    // Orientation: combine heading, pitch, roll, and wave surface tilt
    const yawQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), foilState.heading
    );
    // Negated deliberately. Rotating by +pitch about +X points the nose DOWN,
    // so the original board dipped its nose while the rider climbed. Same
    // control, honest picture.
    const pitchQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0), -foilState.pitch
    );
    const rollQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1), -foilState.roll
    );
    const surfaceQ = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), wave.normal
    );

    boardGroup.quaternion.copy(surfaceQ).multiply(yawQ).multiply(pitchQ).multiply(rollQ);
}


// --- RACE LOGIC ---
function updateRace(dt: number, time: number) {
    // Auto-start when the player launches
    if (gameState === 'riding' && !race.active && !race.finished) {
        startRace(time);
    }

    if (!race.active) return;

    race.totalElapsed = time - race.startTime;

    // Use downwind (Z) distance so km marks align with the physical buoy positions.
    // Total path distance (distanceTravelled) is tracked separately for display.
    const dwind = downwindDist();
    const kmReached = Math.floor(dwind / 1000);

    // Record split time for each newly crossed km mark
    for (let k = race.lastKmReached + 1; k <= Math.min(kmReached, RACE_LENGTH_KM); k++) {
        race.kmSplitTimes.push(race.totalElapsed);
        const prev = race.kmSplitTimes.length > 1 ? race.kmSplitTimes[race.kmSplitTimes.length - 2] : 0;
        const split = race.totalElapsed - prev;
        race.splitFlashText = `KM ${k}\n${fmtTime(split)}`;
        race.splitFlashTimer = 3.0;
        race.lastKmReached = k;
    }

    // Decay flash
    if (race.splitFlashTimer > 0) race.splitFlashTimer -= dt;

    // Check finish
    if (dwind >= RACE_LENGTH_KM * 1000) {
        race.finished = true;
        race.active = false;
        race.totalElapsed = time - race.startTime;
        race.splitFlashTimer = 0;
        // Ensure all km splits are recorded
        while (race.kmSplitTimes.length < RACE_LENGTH_KM) {
            race.kmSplitTimes.push(race.totalElapsed);
        }
        showRaceResults();
    }

    // Crash during race — reset race so they must start over clean
    if (gameState === 'crashed') {
        race.active = false;
    }
}


// --- ANIMATION LOOP ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();
    const time = clock.elapsedTime;

    // Update GPU water
    waterUniforms.uTime.value = time;

    // Move water mesh to follow player — shader uses uWorldOffset to keep
    // waves world-space correct so the ocean looks infinite.
    waterMesh.position.x = foilState.position.x;
    waterMesh.position.z = foilState.position.z;
    waterUniforms.uWorldOffset.value.set(foilState.position.x, foilState.position.z);

    // Readability overlays need the rider's heading and a height scale
    waterUniforms.uRideDir.value.set(
        Math.sin(foilState.heading), Math.cos(foilState.heading)
    );
    let hsSq = 0;
    for (const sw of SWELLS) if (sw.enabled) hsSq += sw.height * sw.height;
    waterUniforms.uWaveScale.value = Math.max(0.5, Math.sqrt(hsSq));
    waterUniforms.uSunDir.value.copy(sunDirection);

    // Physics step
    updatePhysics(dt, time);

    // Race logic
    updateRace(dt, time);

    // Lateral race-track tracking: the whole course (buoys + finish gate) drifts
    // to stay centred on the player's X so markers are always visible regardless
    // of how far the rider has drifted downwind.
    raceTrackX += (foilState.position.x - raceTrackX) * (1 - Math.exp(-4.0 * dt));

    // Bob buoys on the water surface and apply lateral tracking
    {
        for (const buoy of raceBuoys) {
            const bx = raceTrackX + buoy.relativeX;
            buoy.group.position.x = bx;
            buoy.group.position.y = getWaterHeightFast(bx, buoy.baseZ, time);
        }
        // Finish gate — same lateral centre, just bob on waves
        finishGate.position.x = raceTrackX;
        finishGate.position.y = getWaterHeightFast(raceTrackX, FINISH_Z, time);
    }

    // GPS minimap
    sampleGpsPoint(time);
    drawGpsMinimap();
    drawInstruments(time);

    // Wake trail
    updateWakeTrail(dt, time);
    updateBubbles(dt, time);

    // Board visuals
    updateBoardVisuals(time);

    // Rider animation
    updateRiderAnimation();
    riderMixer?.update(dt);
    if (riderModel) {
        const yOffset = currentAnimName === 'sitting' ? SITTING_Y_OFFSET : 0;
        riderModel.position.set(RIDER_OFFSET.x, RIDER_OFFSET.y + yOffset, RIDER_OFFSET.z);
    }

    // Camera
    updateChaseCamera(dt);

    // Keep directional light tracking the board so it always illuminates nearby geometry
    dirLight.position.copy(boardGroup.position).addScaledVector(sunDirection, 100);
    dirLight.target.position.copy(boardGroup.position);

    // Render
    renderer.render(scene, camera);

    // HUD
    updateHUD();

    // Perf stats
    const now = performance.now();
    const frameDelta = now - prevTime;
    prevTime = now;
    frameCount++;
    fpsAccum += frameDelta;

    if (fpsAccum >= 500) {
        perfStats.fps = Math.round((frameCount / fpsAccum) * 1000);
        perfStats.frameMs = +(frameDelta).toFixed(1);
        frameCount = 0;
        fpsAccum = 0;
    }

    perfStats.drawCalls = renderer.info.render.calls;
    perfStats.triangles = renderer.info.render.triangles;
}


// Handle resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start loop
animate();
