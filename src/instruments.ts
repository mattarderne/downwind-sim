// Instrument cluster: the readouts a foiler gets from feel on the water but
// cannot get through a screen.
//
//  - Wave train profile: the surface along your line, the bump you are on, the
//    set envelope around it, and which way the crests are marching.
//  - Swell radar: where each swell system is coming from relative to your
//    heading, plus the foil's actual track angle.
//  - Trim gauge: front/back foot pressure against the trim needed to hold
//    altitude, with breach and touchdown limits marked.

import {
    analyseSwell,
    waterHeightFast,
    type WaveField,
} from './waves';

export interface RiderReadout {
    x: number;
    z: number;
    heading: number;
    /** Course over ground — differs from heading when slipping sideways. */
    track: number;
    speed: number;
    rideHeight: number;
    mastLength: number;
    footPressure: number;
    footPressureTrim: number;
    alpha: number;
    loadFactor: number;
    wingDepth: number;
    ventFactor: number;
    orbitalW: number;
    roll: number;
    onFoil: boolean;
}

const FG = 'rgba(255,255,255,0.85)';
const DIM = 'rgba(255,255,255,0.35)';
const FAINT = 'rgba(255,255,255,0.14)';
const PANEL = 'rgba(0, 18, 36, 0.72)';
const BORDER = 'rgba(255,255,255,0.12)';

const GREEN = '#4ade80';
const AMBER = '#fbbf24';
const RED = '#ef5350';
const BLUE = '#3c8cff';

function panel(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = PANEL;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 10);
    ctx.stroke();
}

function label(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    color = DIM, align: CanvasTextAlign = 'left', size = 9
) {
    ctx.fillStyle = color;
    ctx.font = `${size}px monospace`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
}

// --- WAVE TRAIN PROFILE -----------------------------------------------------

export interface WaveTrainOpts {
    /** Metres shown behind the rider. */
    behind: number;
    /** Metres shown ahead of the rider. */
    ahead: number;
    /** Which swell's envelope to overlay. */
    swellIndex: number;
}

/**
 * Side elevation of the sea surface along the rider's heading.
 *
 * The solid line is the real surface (all swells summed). The shaded band is
 * the dominant swell's group envelope — the "set". Where the envelope is tall
 * you are inside a set; where it pinches you are between sets. Because crests
 * travel at twice the envelope speed, you can watch bumps being born at the
 * back of the band and dying off the front.
 */
export function drawWaveTrain(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    field: WaveField,
    rider: RiderReadout,
    time: number,
    opts: WaveTrainOpts
) {
    panel(ctx, w, h);

    const padL = 6, padR = 6, padT = 16, padB = 14;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const midY = padT + plotH / 2;

    const total = opts.behind + opts.ahead;
    const dirX = Math.sin(rider.heading);
    const dirZ = Math.cos(rider.heading);

    // Sample the surface and envelope along the heading line.
    const N = Math.max(48, Math.min(220, Math.floor(plotW)));
    const surf = new Float32Array(N);
    const envU = new Float32Array(N);
    let maxAbs = 0.35;

    for (let i = 0; i < N; i++) {
        const s = -opts.behind + (i / (N - 1)) * total;
        const x = rider.x + dirX * s;
        const z = rider.z + dirZ * s;
        surf[i] = waterHeightFast(field, x, z, time);
        envU[i] = analyseSwell(field, opts.swellIndex, x, z, time).envelope;
        const a = Math.max(Math.abs(surf[i]), envU[i]);
        if (a > maxAbs) maxAbs = a;
    }

    const yScale = (plotH / 2) / (maxAbs * 1.12);
    const sx = (i: number) => padL + (i / (N - 1)) * plotW;
    const sy = (v: number) => midY - v * yScale;

    // Mean water line
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, midY);
    ctx.lineTo(padL + plotW, midY);
    ctx.stroke();

    // Set envelope band
    ctx.fillStyle = 'rgba(60, 140, 255, 0.13)';
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(envU[0]));
    for (let i = 1; i < N; i++) ctx.lineTo(sx(i), sy(envU[i]));
    for (let i = N - 1; i >= 0; i--) ctx.lineTo(sx(i), sy(-envU[i]));
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(60, 140, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
        const X = sx(i), Y = sy(envU[i]);
        i === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
    }
    ctx.stroke();

    // Surface profile, coloured by slope: green where the face runs downhill in
    // your direction of travel (free speed), red where you are climbing.
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let i = 1; i < N; i++) {
        const dyds = (surf[i] - surf[i - 1]) / (total / (N - 1));
        // Travelling toward +s; a negative gradient ahead means downhill.
        const t = Math.max(-1, Math.min(1, -dyds * 12));
        ctx.strokeStyle = t > 0.15 ? GREEN : t < -0.15 ? 'rgba(239,83,80,0.75)' : DIM;
        ctx.beginPath();
        ctx.moveTo(sx(i - 1), sy(surf[i - 1]));
        ctx.lineTo(sx(i), sy(surf[i]));
        ctx.stroke();
    }

    // Rider marker
    const riderI = (opts.behind / total) * (N - 1);
    const rx = sx(riderI);
    const ry = sy(surf[Math.round(riderI)] + rider.rideHeight);

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, padT);
    ctx.lineTo(rx, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = rider.onFoil ? '#fff' : RED;
    ctx.beginPath();
    ctx.arc(rx, ry, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Crest travel direction. Crests move through the set faster than the set
    // itself, so this arrow always runs forward along the swell.
    label(ctx, 'WAVE TRAIN', padL, 11, DIM);
    label(ctx, 'crests →', padL + plotW, 11, 'rgba(60,140,255,0.65)', 'right');
    label(ctx, `${opts.behind | 0}m`, padL, h - 4, FAINT);
    label(ctx, 'you', rx, h - 4, DIM, 'center');
    label(ctx, `+${opts.ahead | 0}m`, padL + plotW, h - 4, FAINT, 'right');
}

// --- SET POSITION -----------------------------------------------------------

/**
 * Where you sit inside the current set, and where you sit on the individual
 * wave. Two different things, and confusing them is what makes downwind hard.
 */
export function drawSetMeter(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    field: WaveField,
    rider: RiderReadout,
    time: number,
    swellIndex: number
) {
    panel(ctx, w, h);
    const a = analyseSwell(field, swellIndex, rider.x, rider.z, time);

    const padL = 8, padR = 8;
    const barW = w - padL - padR;

    // Set strength bar
    label(ctx, 'IN THE SET', padL, 12, DIM);
    const setY = 20;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.roundRect(padL, setY, barW, 6, 3); ctx.fill();

    const strength = Math.max(0, Math.min(1, a.setStrength));
    ctx.fillStyle = strength > 0.66 ? GREEN : strength > 0.33 ? AMBER : DIM;
    ctx.beginPath();
    ctx.roundRect(padL, setY, Math.max(2, barW * strength), 6, 3);
    ctx.fill();

    label(
        ctx,
        strength > 0.66 ? 'peak of set' : strength > 0.33 ? 'building' : 'between sets',
        padL + barW, 12, strength > 0.66 ? GREEN : DIM, 'right'
    );

    // Position on the wave: a small circle diagram. Crest at top, trough at
    // bottom, front face on the right (the side you want to be on).
    const cy = h - 30;
    const cx = w / 2;
    const R = 20;

    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

    // Highlight the front face arc (phase 0..pi -> downhill side)
    ctx.strokeStyle = 'rgba(74,222,128,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, Math.PI / 2); ctx.stroke();

    // Marker. phase 0 = crest (top), +pi/2 = front face (right), pi = trough.
    const ang = -Math.PI / 2 + a.phase;
    const mx = cx + Math.cos(ang) * R;
    const my = cy + Math.sin(ang) * R;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, Math.PI * 2); ctx.fill();

    label(ctx, 'crest', cx, cy - R - 5, FAINT, 'center', 8);
    label(ctx, 'trough', cx, cy + R + 11, FAINT, 'center', 8);
    label(ctx, 'face', cx + R + 4, cy + 3, 'rgba(74,222,128,0.7)', 'left', 8);
    label(ctx, 'back', cx - R - 4, cy + 3, FAINT, 'right', 8);
}

// --- SWELL RADAR ------------------------------------------------------------

/**
 * Compass rose showing each swell's travel direction against the rider's
 * heading and actual track. Downwind (+Z) points up.
 */
export function drawSwellRadar(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    field: WaveField,
    swellNames: string[],
    swellEnabled: boolean[],
    rider: RiderReadout
) {
    panel(ctx, w, h);
    const cx = w / 2;
    const cy = h / 2 + 4;
    const R = Math.min(w, h) / 2 - 16;

    label(ctx, 'SWELL / HEADING', 8, 12, DIM);

    // Rings and cardinal ticks
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    for (const f of [0.5, 1]) {
        ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    label(ctx, 'DW', cx, cy - R - 4, FAINT, 'center', 8);

    // Screen angle for a world bearing (0 = +Z = up, positive = clockwise)
    const toScreen = (bearing: number, r: number): [number, number] =>
        [cx + Math.sin(bearing) * r, cy - Math.cos(bearing) * r];

    function arrow(
        bearing: number, r: number, color: string, width: number, head = 5
    ) {
        const [ax, ay] = toScreen(bearing, r);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        const back = bearing + Math.PI;
        const [b1x, b1y] = [
            ax + Math.sin(back + 0.4) * head, ay - Math.cos(back + 0.4) * head,
        ];
        const [b2x, b2y] = [
            ax + Math.sin(back - 0.4) * head, ay - Math.cos(back - 0.4) * head,
        ];
        ctx.lineTo(b1x, b1y);
        ctx.lineTo(b2x, b2y);
        ctx.closePath();
        ctx.fill();
    }

    // Swell arrows, length scaled by relative size
    let maxH = 0.001;
    const heights = field.derived.map((_d, i) => {
        // Recover Hs from the component amplitudes of this swell.
        let sumSq = 0;
        for (const c of field.components) if (c.swell === i) sumSq += c.amp * c.amp;
        const hs = Math.sqrt(sumSq * 8);
        if (hs > maxH) maxH = hs;
        return hs;
    });

    const swellColors = ['#60a5fa', '#a78bfa', '#94a3b8'];
    for (let i = 0; i < field.derived.length; i++) {
        if (!swellEnabled[i] || heights[i] <= 0.01) continue;
        const d = field.derived[i];
        const bearing = Math.atan2(d.dirX, d.dirZ);
        const r = R * (0.4 + 0.6 * (heights[i] / maxH));
        arrow(bearing, r, swellColors[i % swellColors.length], 2.5, 6);
    }

    // Rider heading (where the board points) and track (where it actually goes)
    arrow(rider.track, R * 0.85, 'rgba(255,255,255,0.35)', 1.5, 4);
    arrow(rider.heading, R * 0.85, '#fff', 2, 5);

    // Legend: height and period per active swell (deep water, lambda = 1.56*T^2)
    const active = field.derived
        .map((d, i) => ({ d, i }))
        .filter(({ i }) => swellEnabled[i] && heights[i] > 0.01);

    let ly = h - 6 - (active.length - 1) * 10;
    for (const { d, i } of active) {
        const period = Math.sqrt(d.wavelength / 1.56);
        ctx.fillStyle = swellColors[i % swellColors.length];
        ctx.fillRect(8, ly - 5, 6, 2);
        label(
            ctx,
            `${swellNames[i].split(' ')[0].slice(0, 4)} ${heights[i].toFixed(1)}m ${period.toFixed(0)}s`,
            18, ly, DIM, 'left', 8
        );
        ly += 10;
    }

    // Heading angle readout, relative to straight downwind
    const off = ((rider.heading * 180) / Math.PI + 540) % 360 - 180;
    label(
        ctx,
        `${off >= 0 ? '+' : ''}${off.toFixed(0)}° off DW`,
        w - 8, 12, off > 45 || off < -45 ? AMBER : FG, 'right', 9
    );
}

// --- TRIM / FOOT PRESSURE ---------------------------------------------------

/**
 * Fore/aft foot pressure against the pressure needed to hold altitude.
 *
 * Back foot raises angle of attack: you climb, and if the wing reaches the
 * surface it ventilates and you breach. Front foot drops the nose: you sink,
 * and the board touches down. The hollow marker is the trim that would hold
 * you level right now — bring the solid bar to it.
 */
export function drawTrimGauge(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    rider: RiderReadout
) {
    panel(ctx, w, h);

    const padT = 20, padB = 26;
    const trackX = w * 0.36;
    const trackTop = padT;
    const trackH = h - padT - padB;
    const trackW = 14;
    const midY = trackTop + trackH / 2;

    label(ctx, 'TRIM', 8, 12, DIM);

    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.roundRect(trackX, trackTop, trackW, trackH, 7);
    ctx.fill();

    // Danger zones at each end
    const zone = trackH * 0.22;
    ctx.fillStyle = 'rgba(239,83,80,0.22)';
    ctx.beginPath(); ctx.roundRect(trackX, trackTop, trackW, zone, [7, 7, 0, 0]); ctx.fill();
    ctx.beginPath();
    ctx.roundRect(trackX, trackTop + trackH - zone, trackW, zone, [0, 0, 7, 7]);
    ctx.fill();

    // Centre line
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(trackX - 3, midY); ctx.lineTo(trackX + trackW + 3, midY);
    ctx.stroke();

    const toY = (p: number) => midY - Math.max(-1, Math.min(1, p)) * (trackH / 2);

    // Trim target — where the player should be
    const ty = toY(rider.footPressureTrim);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(trackX - 5, ty);
    ctx.lineTo(trackX + trackW + 5, ty);
    ctx.stroke();

    // Current foot pressure
    const py = toY(rider.footPressure);
    const err = Math.abs(rider.footPressure - rider.footPressureTrim);
    const knobColor = err < 0.25 ? GREEN : err < 0.6 ? AMBER : RED;
    ctx.fillStyle = knobColor;
    ctx.beginPath();
    ctx.roundRect(trackX - 2, py - 3.5, trackW + 4, 7, 3);
    ctx.fill();

    label(ctx, 'BACK', trackX + trackW + 8, trackTop + 8, DIM, 'left', 8);
    label(ctx, 'FRONT', trackX + trackW + 8, trackTop + trackH, DIM, 'left', 8);

    // Ride height column: shows the flight band between breach and touchdown.
    const hx = w - 26;
    const hTop = padT;
    const hH = trackH;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.roundRect(hx, hTop, 10, hH, 5); ctx.fill();

    const ventFrac = 1 - 0.22 / rider.mastLength; // top band where wing ventilates
    ctx.fillStyle = 'rgba(239,83,80,0.22)';
    ctx.beginPath();
    ctx.roundRect(hx, hTop, 10, hH * (1 - ventFrac), [5, 5, 0, 0]);
    ctx.fill();

    const frac = Math.max(0, Math.min(1, rider.rideHeight / rider.mastLength));
    const fy = hTop + hH * (1 - frac);
    ctx.fillStyle = rider.ventFactor < 0.6 ? RED : frac < 0.15 ? AMBER : BLUE;
    ctx.beginPath(); ctx.roundRect(hx - 2, fy - 3, 14, 6, 3); ctx.fill();
    label(ctx, 'HT', hx + 5, hTop - 6, DIM, 'center', 8);

    // Status line
    let msg = 'trimmed';
    let msgColor = GREEN;
    if (rider.ventFactor < 0.55) { msg = 'BREACHING'; msgColor = RED; }
    else if (rider.rideHeight < 0.1) { msg = 'TOUCHING'; msgColor = RED; }
    else if (rider.footPressure - rider.footPressureTrim > 0.3) { msg = 'ease forward'; msgColor = AMBER; }
    else if (rider.footPressureTrim - rider.footPressure > 0.3) { msg = 'more back foot'; msgColor = AMBER; }
    label(ctx, msg, w / 2, h - 12, msgColor, 'center', 9);

    // Angle of attack readout
    label(
        ctx,
        `AoA ${(rider.alpha * 180 / Math.PI).toFixed(1)}°  ${rider.loadFactor.toFixed(2)}g`,
        w / 2, h - 2, DIM, 'center', 8
    );
}
