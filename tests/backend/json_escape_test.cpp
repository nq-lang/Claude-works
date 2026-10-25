// Property test: json::escape() (with its "nothing to escape" fast path) must equal a
// straightforward reference implementation for every input, and its output must be a valid
// JSON string body (no raw control characters, no unescaped quote/backslash).
#include <cstdint>
#include <iostream>
#include <random>
#include <string>

#include "skylit/json_serialize.hpp"

namespace {
std::string reference_escape(const std::string& s) {
    std::string out;
    for (char c : s) {
        const auto u = static_cast<unsigned char>(c);
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (u < 0x20) {
            static const char* hex = "0123456789abcdef";
            out += "\\u00";
            out += hex[u >> 4];
            out += hex[u & 0xF];
        } else out += c;
    }
    return out;
}

bool valid_body(const std::string& e) {
    for (std::size_t i = 0; i < e.size(); ++i) {
        const auto u = static_cast<unsigned char>(e[i]);
        if (u < 0x20) return false;
        if (e[i] == '"') return false;
        if (e[i] == '\\') {
            if (++i >= e.size()) return false;
            const char n = e[i];
            if (n == 'u') {
                if (i + 4 >= e.size()) return false;  // needs 4 hex digits after the 'u'
                i += 4;
            }
            else if (std::string("\"\\nrt").find(n) == std::string::npos) return false;
        }
    }
    return true;
}
}  // namespace

int main() {
    std::mt19937_64 rng(0xE5CA9E);
    long cases = 0, failures = 0;
    auto check = [&](const std::string& s) {
        ++cases;
        const std::string got = skylit::json::escape(s);
        if (got != reference_escape(s) || !valid_body(got)) {
            if (++failures <= 5) std::cerr << "MISMATCH on input of size " << s.size() << "\n";
        }
    };
    check("");
    check("SPY");
    check("plain ascii text, no escapes needed 123.45");
    check("\"");
    check("\\");
    check(std::string("\0", 1));
    check(std::string("a\0b", 3));
    check("\x1f\x7f\x80\xff");
    check("utf8 \xc3\xa9\xe2\x82\xac ok");
    for (int round = 0; round < 400000; ++round) {
        const std::size_t n = rng() % 24;
        std::string s;
        for (std::size_t i = 0; i < n; ++i) {
            switch (rng() % 6) {
                case 0: s += static_cast<char>(rng() % 0x20); break;           // control
                case 1: s += "\"\\"[rng() % 2]; break;                          // quote / backslash
                case 2: s += static_cast<char>(0x80 + rng() % 0x80); break;     // high bytes
                default: s += static_cast<char>(0x20 + rng() % 0x5f); break;    // printable
            }
        }
        check(s);
    }
    std::cout << "json escape property test: " << cases << " cases, " << failures << " failures\n";
    return failures == 0 ? 0 : 1;
}
