# Greeks: definitions, validation, and what is NOT yet real (S10)

## Reference math — `backend/include/skylit/bs_greeks.hpp`
Black-Scholes-Merton, continuous dividend yield q, European exercise. S spot, K strike, r rate, σ vol, T years.

| Greek | Definition | Units | Calls vs puts |
|---|---|---|---|
| gamma | ∂²V/∂S² | per $ spot | same |
| vanna | ∂Δ/∂σ | per 1.00 vol | same |
| charm | −∂Δ/∂T (delta change as time passes) | per year | differs by the q term |
| color | −∂Γ/∂T | per year | same |
| speed | ∂Γ/∂S | per $ spot | same |

Validated (`tests/backend/bs_greeks_test.cpp`, run by `make test`): 480 parameter sets (moneyness 0.85–1.2,
σ 12–60 %, 1 day–1 year, r ∈ {0, 4.5 %}, q ∈ {0, 1.5 %}, calls and puts) against independent central finite differences
with Richardson extrapolation of a separate pricer / lower-order Greek, plus delta put-call parity. Max relative
error vs finite difference: delta 2e-4, gamma 2e-4, vanna 5e-5, charm 1e-3, color 3e-3, speed 2e-3 (the larger
values are deep-OTM one-day cases where the finite difference itself is the limiting factor). The test caught a
real sign error in the first color formula.

## Exposure (dealer) convention
Position exposure = Greek × open interest × multiplier × spot-scaling, signed by assumed dealer side
(positive = net long-dealer). **This sign/scale convention is not applied by the synthetic backend** — it
needs real open interest and a side assumption from the data vendor. Decide and document it when real data lands.

## Codes and labels (Orbs & Nodes)
`G` GEX, `V` VEX, `S` SPEED, `C` CHEX, `K` COLOR, `Z` GEX+VEX. Label: `Pos|Neg <code> <value>`. Greeks are
requested and drawn separately and never summed, with ONE exception below.

## GEX+VEX (the only sanctioned combination)
`C_i = G_i + (Gmax/Vmax)·V_i` with Gmax, Vmax the board-wide peak magnitudes (Vmax = 0 → C_i = G_i): each Greek is
normalised by its own peak with equal weight and expressed in GEX-equivalent units. Implemented in
`combine_gex_vex()` (`exposure_engine.hpp`). **This is not the calibrated spot-vol elasticity / skew-drift /
stress-tested model you described** — that needs concrete coefficients, which I have asked for. Velocity Mode on a
GEX+VEX view uses the raw per-strike sum (limitation).

## What is still synthetic
The running backend does not use `bs_greeks.hpp`: its VEX/CHEX/COLOR/SPEED series are placeholders derived from
one synthetic series (so GEX and VEX King/Barney coincide). Per-Greek exposure from a real option chain
(OI, IV per strike/expiry) is the next integration step; the library and its test are ready for it.
The legacy API still sums arbitrary comma-lists (used by Projections); the Orbs/heatmap frontend never sends them.
