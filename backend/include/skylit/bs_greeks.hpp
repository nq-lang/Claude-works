// Black-Scholes-Merton Greeks (continuous dividend yield q), the reference math for the per-Greek exposures.
// Units / conventions (also in docs/GREEKS.md):
//   S spot, K strike, r rate, q dividend yield (all annualised, continuous), sigma annualised vol, T years to expiry.
//   delta  = dV/dS                         gamma = d2V/dS2 (per $ of spot)
//   vanna  = d(delta)/d(sigma) = d2V/dS dsigma   (per 1.00 of vol, i.e. per 100 vol points)
//   charm  = -d(delta)/dT   (delta change as time PASSES, per year)
//   color  = -d(gamma)/dT   (gamma change as time passes, per year)
//   speed  = d(gamma)/dS    (per $ of spot)
// Gamma, vanna, color and speed are identical for calls and puts; delta and charm differ (charm by the q term).
// European exercise. American equity options need a lattice/PDE pricer — NOT provided here.
#pragma once
#include <cmath>

namespace skylit::bs {

struct Inputs { double S, K, r, q, sigma, T; };

inline double pdf(double x) { return std::exp(-0.5 * x * x) / std::sqrt(2.0 * M_PI); }
inline double cdf(double x) { return 0.5 * std::erfc(-x / std::sqrt(2.0)); }
inline double d1(const Inputs& p) { return (std::log(p.S / p.K) + (p.r - p.q + 0.5 * p.sigma * p.sigma) * p.T) / (p.sigma * std::sqrt(p.T)); }
inline double d2(const Inputs& p) { return d1(p) - p.sigma * std::sqrt(p.T); }

inline double delta(const Inputs& p, bool call) {
    const double e = std::exp(-p.q * p.T), x = d1(p);
    return call ? e * cdf(x) : -e * cdf(-x);
}
inline double gamma(const Inputs& p) { return std::exp(-p.q * p.T) * pdf(d1(p)) / (p.S * p.sigma * std::sqrt(p.T)); }
inline double vanna(const Inputs& p) { return -std::exp(-p.q * p.T) * pdf(d1(p)) * d2(p) / p.sigma; }
inline double charm(const Inputs& p, bool call) {
    const double e = std::exp(-p.q * p.T), x1 = d1(p), x2 = d2(p), st = p.sigma * std::sqrt(p.T);
    const double common = e * pdf(x1) * (2.0 * (p.r - p.q) * p.T - x2 * st) / (2.0 * p.T * st);
    return call ? p.q * e * cdf(x1) - common : -p.q * e * cdf(-x1) - common;
}
inline double color(const Inputs& p) {
    const double e = std::exp(-p.q * p.T), x1 = d1(p), x2 = d2(p), st = p.sigma * std::sqrt(p.T);
    return e * pdf(x1) / (2.0 * p.S * p.T * st) * (2.0 * p.q * p.T + 1.0 + x1 * (2.0 * (p.r - p.q) * p.T - x2 * st) / st);
}
inline double speed(const Inputs& p) { return -gamma(p) / p.S * (d1(p) / (p.sigma * std::sqrt(p.T)) + 1.0); }

}  // namespace skylit::bs
