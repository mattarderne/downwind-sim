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
