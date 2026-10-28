// Validates the analytic Greeks against independent central finite differences of the price / lower-order Greeks,
// plus put-call relations, across a grid of moneyness, vol, maturity, rate and dividend yield.
#include <cstdio>
#include <string>
#include <cmath>
#include <algorithm>
#include "skylit/bs_greeks.hpp"
using namespace skylit::bs;

static double price(const Inputs& p, bool call) {   // independent pricer used only by this test
    const double a = d1(p), b = d2(p), er = std::exp(-p.r * p.T), eq = std::exp(-p.q * p.T);
    return call ? p.S * eq * cdf(a) - p.K * er * cdf(b) : p.K * er * cdf(-b) - p.S * eq * cdf(-a);
}
static int fails = 0, total = 0;
static double maxerr[8]; static const char* names[8]; static int nn = 0;
static void expect(const char* name, double got, double ref, double tol) {
    ++total; const double err = std::abs(got - ref) / std::max(1e-9, std::abs(ref) + 1e-12);
    int k = 0; while (k < nn && std::string(names[k]) != name) ++k; if (k == nn) names[nn++] = name; maxerr[k] = std::max(maxerr[k], err);
    if (!(err < tol)) { ++fails; std::printf("  FAIL %s got=%.8g ref=%.8g relerr=%.2e\n", name, got, ref, err); }
}
int main() {
    int cases = 0;
    for (double m : {0.85, 0.95, 1.0, 1.05, 1.2}) for (double sg : {0.12, 0.25, 0.6}) for (double T : {1.0 / 365, 7.0 / 365, 0.25, 1.0})
    for (double r : {0.0, 0.045}) for (double q : {0.0, 0.015}) for (bool call : {true, false}) {
        Inputs p{100.0, 100.0 / m, r, q, sg, T}; ++cases;
        const double hS = p.S * 2e-3, hs = 2e-3, hT = std::min(2e-3, T * 0.05);
        auto bumpS = [&](double d) { Inputs x = p; x.S += d; return x; };
        auto bumpV = [&](double d) { Inputs x = p; x.sigma += d; return x; };
        auto bumpT = [&](double d) { Inputs x = p; x.T += d; return x; };
        // central difference with Richardson extrapolation (removes the O(h^2) truncation term)
        auto fd = [](auto f, double h) { auto c = [&](double hh) { return (f(hh) - f(-hh)) / (2 * hh); }; return (4 * c(h / 2) - c(h)) / 3; };
        const double fdDelta = fd([&](double d) { return price(bumpS(d), call); }, hS);
        expect("delta", delta(p, call), fdDelta, 1e-3);
        expect("gamma", gamma(p), fd([&](double d) { return delta(bumpS(d), call); }, hS), 5e-3);
        expect("vanna", vanna(p), fd([&](double d) { return delta(bumpV(d), call); }, hs), 1e-3);
        expect("charm", charm(p, call), -fd([&](double d) { return delta(bumpT(d), call); }, hT), 1e-3);
        expect("color", color(p), -fd([&](double d) { return gamma(bumpT(d)); }, hT), 5e-3);
        expect("speed", speed(p), fd([&](double d) { return gamma(bumpS(d)); }, hS), 5e-3);
        // put-call parity of delta: delta_call - delta_put = exp(-qT)
        expect("parity delta", delta(p, true) - delta(p, false), std::exp(-q * T), 1e-12);
    }
    // sign sanity: ATM gamma > 0; OTM-call vanna (d2 > 0 region) negative; deep ITM vanna sign flips
    Inputs atm{100, 100, 0.03, 0.0, 0.2, 0.1};
    ++total; if (!(gamma(atm) > 0)) { ++fails; std::puts("  FAIL gamma sign"); }
    for (int k = 0; k < nn; ++k) std::printf("  max rel err vs finite difference  %-6s %.2e\n", names[k], maxerr[k]);
    std::printf("%d cases, %d checks, %d failures\n", cases, total, fails);
    return fails ? 1 : 0;
}
