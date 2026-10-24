// LD_PRELOAD shim: freezes (and lets the test advance) the wall clock so every backend output that
// depends on "now" (candle buckets, velocity baselines, session labels, OPEX week) is reproducible.
//   SKYLIT_FAKE_EPOCH=<unix seconds>   start time;  skylit_fake_time_advance(n) moves it forward.
// Only CLOCK_REALTIME / time() / gettimeofday() are faked; monotonic clocks and sleeping are untouched.
#include <dlfcn.h>
#include <sys/time.h>
#include <time.h>
#include <cstdlib>

static long long g_now = -1;
static long long now_secs() {
    if (g_now < 0) {
        const char* e = std::getenv("SKYLIT_FAKE_EPOCH");
        g_now = e ? std::atoll(e) : 1773848700LL;
    }
    return g_now;
}

extern "C" void skylit_fake_time_advance(long secs) { now_secs(); g_now += secs; }

extern "C" int clock_gettime(clockid_t clk, struct timespec* ts) {
    if (clk == CLOCK_REALTIME || clk == CLOCK_REALTIME_COARSE) {
        ts->tv_sec = static_cast<time_t>(now_secs());
        ts->tv_nsec = 0;
        return 0;
    }
    using Fn = int (*)(clockid_t, struct timespec*);
    static Fn real = reinterpret_cast<Fn>(dlsym(RTLD_NEXT, "clock_gettime"));
    return real(clk, ts);
}

extern "C" time_t time(time_t* t) {
    time_t v = static_cast<time_t>(now_secs());
    if (t) *t = v;
    return v;
}

extern "C" int gettimeofday(struct timeval* tv, void*) {
    tv->tv_sec = static_cast<time_t>(now_secs());
    tv->tv_usec = 0;
    return 0;
}
