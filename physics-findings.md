# Physics orientation — measured findings

Measurements taken against the current build by stepping the simulation
deterministically (fixed 1/60 s), most of them on glassy water so drag and
control effects are isolated from wave forcing. Rider 85 kg, Downwind 900 foil,
0.8 m mast.

These are the answers to "is any of this sensible", intended as input to a
rebuild spec rather than as a description of a finished design.

---

## 1. Mast height buys you nothing — confirmed bug

Deceleration at 10 m/s, held at a fixed ride height on flat water:

| ride height | submerged mast | deceleration |
|---|---|---|
| 0.15 m | 0.65 m | −0.887 m/s² |
| 0.35 m | 0.45 m | −0.887 m/s² |
| 0.55 m | 0.25 m | −0.887 m/s² |
| 0.75 m | 0.05 m | −0.887 m/s² |

Identical at every height. Mast drag is computed from a **fixed** area:

```
dragMag += 0.5 * RHO_WATER * speed^2 * 0.8 * MAST_DRAG_AREA
```

so it never accounts for how much mast is actually in the water. Flying high is
free but pointless, and the only height that matters is the 0.05 m case where a
separate board-contact penalty kicks in (−5.41 m/s²).

**For the rebuild:** mast drag must scale with submerged length,
`MAST_LENGTH − rideHeight`. At present the mast is ~38% of total drag at 10 m/s,
so making it proportional turns "fly high" into roughly a 30% drag saving. That
single change is what makes ride height a resource worth managing.

The range itself is available: full back foot reaches **0.73 m of 0.80 m**, full
front foot touches down. So the mast is usable — there is just no reward.

---

## 2. Height as a battery — works, but over-delivers

Same duration (3 s), same start, one run holding height and one bleeding it:

| | ride height | speed |
|---|---|---|
| held | 0.59 m | 15.19 kt |
| descended | 0.209 m | 16.18 kt |

Spending **0.381 m** of height bought **+0.99 kt**. Lossless conversion of that
potential energy would give **+0.71 kt**, so the exchange currently returns about
**139% of what is physically available**.

The mechanism is right — descent tilts the lift vector forward and that is
genuinely how a foil converts height to speed — but the implementation
over-credits it, probably through the small-angle approximation and the
`vRef = max(speed, 1.5)` floor.

**For the rebuild:** keep the mechanism, but make the exchange energy-conserving
and test it explicitly against `v1 = sqrt(v0² + 2*g*dh)`. A battery that returns
more than you put in removes the tension from the whole mechanic.

---

## 3. Pumping is overpowered

Speed gained from a single pump:

| speed | gain |
|---|---|
| 11.7 kt | +4.85 kt |
| 17.5 kt | +4.77 kt |
| 23.3 kt | +3.56 kt |
| 38.9 kt | +2.03 kt |

Sustained on **flat water with no waves at all**, pumping alone held flight for
52 s at an average of **18.3 kt**, at 0.33 pumps/second.

That is the core problem with the current feel. If pumping sustains 18 kt on a
mirror, the waves are decoration — there is no reason to hunt a bump, and the
wave mechanics read as random because they are not what is carrying you.

**For the rebuild:** pumping should be a recovery and connection tool, not a
propulsion system. Sustained flat-water pumping should decay — perhaps 8-10 kt
and falling — so that linking bumps is the only way to hold speed. The gain per
pump should also fall off much harder with speed than it currently does.

---

## 4. Turning is both too fast and fatal

Held turn at full roll input, height held by autopilot:

| | result |
|---|---|
| turn rate | **39.7 °/s** (a full 360 in 9 s) |
| radius | ~13 m |
| roll reached | 29.8° |
| straight for 6 s | survives, 13.2 kt |
| turning for 6 s | **crashed at 3.5 s** |

A sustained turn cannot be held at all. Banking tilts the lift vector, so
vertical lift falls with `cos(roll)` — correct physics — but there is no
coordinated pitch compensation and the rider runs out of angle of attack before
the turn can be completed.

**For the rebuild:** this is where the difficulty should live, and it is
currently in the wrong shape. Turning should cost speed and require coordinated
back-foot input to hold altitude through the bank — a skill to learn, not an
instant crash. Turn rate should be slower and scale with speed and foil span.

---

## 5. Staying on foil is too hard; everything else is too easy

- Hands-off, no input at all: **under 1 second** before touchdown.
- With a PD autopilot holding height: 240 s runs are routine on the small
  preset (6/7), 4/7 on medium.

A real foil is close to neutral in heave and does need constant attention, so
some of this is honest. But sub-second is not a difficulty curve, it is a wall,
and it means players never get far enough in to meet the interesting problems.

**For the rebuild, the intended shape:**

1. **Staying up should be forgiving.** More pitch damping, or a gentle
   height-seeking assist that can be dialled down as a difficulty setting.
   Getting airborne and staying there is the tutorial, not the game.
2. **Linking bumps should be the main skill.** Reachable only if pumping is
   nerfed enough that the wave is genuinely the energy source.
3. **Turning, carving and holding a line should be the hard part**, with real
   costs: speed scrubbed in the bank, altitude lost without compensation,
   sideslip when the turn is uncoordinated.

---

## 6. Answers to the direct questions

**Does pushing down speed the rider up?** No — down is back foot, nose up,
climb, and it slows you. **Up** is nose down and speeds you up, but only by about
1 kt for 0.38 m of height, which is why it feels weak.

**Does the rider use the full 80 cm?** Yes, 0.73 m is reachable. It does not
*look* or *feel* like it because there is no speed consequence (§1) and the
board's height above the water is a small part of the frame.

**Is turning naive?** The turn itself uses the standard coordinated-turn
relation, `heading_rate = L*sin(roll)/(m*V)`, which is sound. What is missing is
everything around it: no pitch coordination, no speed cost, no sideslip.

---

## 7. Priority order for a rebuild

1. Mast drag proportional to submerged length — makes height meaningful
2. Nerf pumping — makes waves meaningful
3. Energy-conserving height/speed exchange — makes the battery honest
4. Forgiving heave, expensive turning — puts difficulty in the right place
5. Coordinated turn model with speed cost and sideslip

---

# Round 2 — the bump-linking mechanic

## 8. Mast drag and pumping, fixed and measured

Mast drag now scales with submerged length, so height is a resource:

| ride height | before | after |
|---|---|---|
| 0.15 m | −0.887 m/s² | −1.099 m/s² |
| 0.75 m | −0.887 m/s² | −0.592 m/s² |

46% less drag flying high. Pumping now falls off with the square of the speed
ratio: on flat water it decays 19.2 kt → 15.5 kt → touchdown at 28.5 s, where
before it held 18.3 kt for a full minute. Waves are now the energy source.

## 9. The whole game is one ratio: c / V

Staying with a swell requires the component of your velocity along the swell
direction to match its phase speed:

```
V * cos(theta) = c        =>   theta = acos(c / V)
```

Three regimes, and they are entirely determined by crest speed against rider
speed:

| c / V | what happens | play |
|---|---|---|
| **> 1** | no angle syncs; swell passes underneath | flat, boring, "run up the back and stop" |
| **~ 1** | straight already syncs | forgiving, no technique needed |
| **< 1** | must angle by acos(c/V) to hold a bump | the actual game |

**The current default sits at c/V = 1.04** — crests 19.7 kt, rider 19 kt — which
is the worst of the three. That single number is why the mechanic feels absent.

Measured, holding a heading across 5 spawns, 180 s each, with the swell slowed
to 16.7 kt crests:

| heading | full runs | median downwind |
|---|---|---|
| 0° | 0/5 | 48 m |
| 15° | 0/5 | 44 m |
| 25° | 0/5 | 48 m |
| **35°** | **3/5** | **1416 m** |

A 30x difference in distance, with the optimum landing where theory says it
should: acos(16.7/20) = 33.4°.

**Correction to an earlier reading.** A single run had suggested 30° was best in
the current sea. It did not replicate — across 5 spawns straight was better
(4/5 full runs vs 2/5). Single runs in this sim vary enormously; nothing here
should be trusted below about 5 spawns.

## 10. Design consequences

**Tune the sea by c/V, not by wave height.** Height sets how it looks and how
steep it is; the crest-to-rider speed ratio sets whether there is a game. Period
controls c via c = g*T/2pi, so period is the difficulty dial.

**This gives progression for free.** Cruise speed V comes from foil area and
rider weight, so:

- A big beginner foil cruises ~13.5 kt. Against 16.7 kt crests, c/V > 1 — the
  swell carries them, nothing to learn, forgiving.
- A race foil cruises ~21 kt. Against the same swell, c/V = 0.8, and they must
  hold ~37° to stay connected.

The same water is a gentle ride on one foil and a technical one on another. That
is a real upgrade path: a faster foil does not just raise the number, it changes
the line you have to ride.

**Suggested difficulty curve**, expressed as c/V rather than as height:

| tier | c/V | sync angle | feel |
|---|---|---|---|
| learning | ~1.0 | 0° | straight works, stay on foil |
| intermediate | 0.9 | 25° | angling helps noticeably |
| advanced | 0.8 | 37° | must link bumps or stop |

**Still to do:** the crest-crossing penalty is brutal (−65 N, −1.06 kt/s, ~7 kt
lost per crest). Once angling is properly rewarded that penalty is the stick and
the sync line is the carrot, but it likely wants softening so a mistake costs a
bump rather than the run.


---

# Round 3 — corrections and the turn

## 11. Correction: the energy exchange was never over-unity

Section 2 claimed the height-to-speed exchange returned 139% of the available
energy. That was a measurement error, not a bug. Tracking total mechanical
energy through a descent:

```
KE + PE:  5731 J  ->  5262 J     (-469 J)
```

Energy falls monotonically, as drag requires. The apparent surplus came from
comparing a descending run against a run *holding* altitude, and holding costs
more induced drag — 1.80 deg AoA against 1.43 deg. Two effects, one comparison.
No fix needed.

## 12. The turn was destroying momentum, not scrubbing it

A held turn bled 21.4 kt to 6.1 kt in 3.7 s and stalled. Height held fine
throughout (load ~1.15), so it was not a lift coordination failure. It was a
death spiral: speed falls, AoA must rise to hold lift, induced drag rises with
CL squared, speed falls faster.

The energy was going somewhere unaccounted. The turn rotated `heading` but never
applied any force to `velocity` — the velocity only caught up through the
LATERAL_RESISTANCE damper, which deletes the sideways component. Deleting
momentum destroys kinetic energy, every frame of every turn.

A centripetal force is perpendicular to travel and does no work. Applying it to
the velocity, at the same rate the heading rotates, keeps course and heading
together so no sideslip is manufactured for the damper to eat.

| | before | after |
|---|---|---|
| full-bank turn | crashed at 3.5 s, 139 deg | 7.3 s, 329 deg |
| half-bank turn | — | survives 8 s, 153 deg, 8.4 kt |

Turning still costs speed, roughly 12 kt over 7 s against holding a straight
line, but that is now the induced drag of carrying extra load in a bank, which
is the honest cost.

## 13. State of the five priorities

1. Mast drag proportional to submerged length — **done**, 46% spread
2. Nerf pumping — **done**, decays to touchdown in 28.5 s on flat water
3. Energy-conserving height/speed exchange — **was never broken**
4. Forgiving heave, expensive turning — turn cost is now honest; heave is still
   unforgiving (hands-off under a second) and remains open
5. Coordinated turn model — **done** for the energy bug; sideslip modelling and
   speed-dependent turn rates remain open
