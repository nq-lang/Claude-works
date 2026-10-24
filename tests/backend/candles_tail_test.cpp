// Property test: aggregate_candles_tail(ticks, iv, n) must equal the last n candles of
// aggregate_candles(ticks, iv), bit for bit, for ANY tick sequence (irregular spacing, duplicate
// timestamps, gaps, even out-of-order timestamps) and any interval / count.
#include <cstdio>
#include <cstring>
#include <random>

#include "skylit/candles.hpp"

using namespace skylit::market;

static bool same(const std::vector<Candle>& a, const std::vector<Candle>& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i].time != b[i].time || std::memcmp(&a[i].open, &b[i].open, sizeof(double)) ||
            std::memcmp(&a[i].high, &b[i].high, sizeof(double)) || std::memcmp(&a[i].low, &b[i].low, sizeof(double)) ||
            std::memcmp(&a[i].close, &b[i].close, sizeof(double)))
            return false;
    return true;
}

int main() {
    std::mt19937_64 rng(2026);
    long cases = 0, failures = 0;
    for (int iter = 0; iter < 30000; ++iter) {
        std::deque<PriceTick> ticks;
        const int n = static_cast<int>(rng() % 400);
        std::int64_t t = static_cast<std::int64_t>(rng() % 2'000'000'000) - 1000;
        const int mode = static_cast<int>(rng() % 4);  // 0 regular, 1 duplicates/gaps, 2 out of order, 3 negative epochs
        if (mode == 3) t = -static_cast<std::int64_t>(rng() % 100000);
        double p = 100.0;
        for (int i = 0; i < n; ++i) {
            if (mode == 0) t += 1;
            else if (mode == 1) t += static_cast<std::int64_t>(rng() % 3 == 0 ? 0 : rng() % 400);
            else if (mode == 2) t += static_cast<std::int64_t>(rng() % 700) - 300;
            else t += static_cast<std::int64_t>(rng() % 90);
            p += (static_cast<double>(rng() % 2001) - 1000.0) * 1e-3;
            ticks.push_back({t, p});
        }
        for (std::int64_t iv : {1LL, 7LL, 60LL, 300LL, 900LL, 3600LL, 86400LL, 0LL, -5LL}) {
            const auto full = aggregate_candles(ticks, iv);
            for (std::size_t count : {0u, 1u, 2u, 3u, 5u, 50u, 1000u}) {
                std::vector<Candle> want;
                if (count > 0) want.assign(full.size() > count ? full.end() - static_cast<std::ptrdiff_t>(count) : full.begin(), full.end());
                const auto got = aggregate_candles_tail(ticks, iv, count);
                ++cases;
                if (!same(want, got)) {
                    if (++failures <= 5) std::printf("MISMATCH iter=%d mode=%d n=%d iv=%lld count=%zu\n", iter, mode, n, static_cast<long long>(iv), count);
                }
            }
        }
    }
    std::printf("candles tail property test: %ld cases, %ld failures\n", cases, failures);
    return failures ? 1 : 0;
}
