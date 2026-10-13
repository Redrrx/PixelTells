#include <algorithm>
#include <array>
#include <cerrno>
#include <cfenv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef __FAST_MATH__
#error "Build without fast-math: float32 rounding is part of the formulas."
#endif

static_assert(std::numeric_limits<float>::is_iec559 && std::numeric_limits<float>::digits == 24);
static_assert(std::numeric_limits<double>::is_iec559 && std::numeric_limits<double>::digits == 53);
static_assert(std::numeric_limits<int>::digits >= 31);

int round_even(double value) {
    const int integer = static_cast<int>(std::floor(value));
    const double fraction = value - integer;
    return integer + (fraction > 0.5 || (fraction == 0.5 && (integer & 1)));
}

float float32(double value) {
    volatile float rounded = static_cast<float>(value);
    return rounded;
}

double half_rtz(float value) {
    int exponent = 0;
    std::frexp(value, &exponent);
    const double step = std::ldexp(1.0, std::max(-24, exponent - 11));
    return std::floor(double(value) / step) * step;
}

int weighted_sum(int a, int b, int c, int d, int s, int t) {
    return (256 - s) * (256 - t) * a + s * (256 - t) * b
         + (256 - s) * t * c + s * t * d;
}

// AMD
int amd(int a, int b, int c, int d, int s, int t) {
    const int sum = weighted_sum(a, b, c, d, s, t);
    const float value = float32(round_even(sum / 8.0) / (8192.0 * 255));
    return round_even(255 * half_rtz(value));
}

// NVIDIA
int nvidia(int a, int b, int c, int d, int s, int t) {
    const int w = (s * t + 128) >> 8;
    const int n = (256 + w - s - t) * a + (s - w) * b + (t - w) * c + w * d;
    const int q = n + ((n + 128) >> 8);
    const int k = q >> 4;
    return (255 * k + 2047) >> 12;
}

// SwiftShader
int swiftshader(int a, int b, int c, int d, int s, int t) {
    const int sum = weighted_sum(a, b, c, d, s, t);
    const float value = float32((sum / 256.0) * float32(1.0 / 65280.0));
    return round_even(float32(255.0 * value));
}

using Formula = int (*)(int, int, int, int, int, int);
struct Model {
    const char* name;
    Formula formula;
    std::size_t mismatches = 0;
    std::uint64_t error = 0;
};

int argument(const char* text, int minimum, int maximum) {
    char* end = nullptr;
    errno = 0;
    const long value = std::strtol(text, &end, 10);
    if (errno || end == text || *end || value < minimum || value > maximum)
        throw std::runtime_error("Invalid argument: " + std::string(text));
    return static_cast<int>(value);
}

void usage() {
    std::cout << "PixelTells\n"
              << "  PixelTells predict X Y R G B R G B R G B R G B\n"
              << "  PixelTells check canvas.rgba R G B R G B R G B R G B\n"
              << "Colors: top-left, top-right, bottom-left, bottom-right; bytes 0..255.\n"
              << "Coordinates: 64..191. File: raw 512x256 RGBA8, not PNG.\n";
}

int main(int argc, char** argv) {
    if (argc < 2 || std::string(argv[1]) == "--help") {
        usage();
        return argc < 2 ? 2 : 0;
    }
    const std::string command = argv[1];
    const bool predict = command == "predict";
    if (!((predict && argc == 16) || (command == "check" && argc == 15))) {
        usage();
        return 2;
    }

    try {
        if (std::fesetround(FE_TONEAREST) != 0)
            throw std::runtime_error("Cannot enable nearest rounding on this platform.");
        std::array<int, 12> colors{};
        for (int i = 0; i < 12; ++i)
            colors[i] = argument(argv[(predict ? 4 : 3) + i], 0, 255);
        std::array<Model, 3> models{{{"AMD", amd}, {"NVIDIA", nvidia}, {"SwiftShader", swiftshader}}};

        if (predict) {
            const int s = 2 * argument(argv[2], 64, 191) - 127;
            const int t = 2 * argument(argv[3], 64, 191) - 127;
            for (const auto& model : models) {
                std::cout << model.name << ':';
                for (int channel = 0; channel < 3; ++channel)
                    std::cout << ' ' << model.formula(colors[channel], colors[3 + channel],
                        colors[6 + channel], colors[9 + channel], s, t);
                std::cout << '\n';
            }
            return 0;
        }

        constexpr std::size_t frame_bytes = 512 * 256 * 4;
        constexpr std::size_t channels = 128 * 128 * 3;
        std::ifstream file(argv[2], std::ios::binary);
        if (!file) throw std::runtime_error("Cannot open canvas file.");
        std::vector<std::uint8_t> pixels(frame_bytes);
        file.read(reinterpret_cast<char*>(pixels.data()), frame_bytes);
        if (file.gcount() != frame_bytes || file.peek() != std::char_traits<char>::eof())
            throw std::runtime_error("Canvas file must contain exactly 524288 RGBA bytes.");

        const auto start = std::chrono::steady_clock::now();
        std::size_t controls = 0;
        for (std::size_t i = 0; i < frame_bytes; i += 4) {
            const bool right = (i / 4) % 512 >= 256;
            if (pixels[i + 3] != 255 || (right && (pixels[i] || pixels[i + 1] || pixels[i + 2])))
                ++controls;
        }
        for (int y = 64; y < 192; ++y) {
            for (int x = 64; x < 192; ++x) {
                for (int channel = 0; channel < 3; ++channel) {
                    const int actual = pixels[(y * 512 + x) * 4 + channel];
                    for (auto& model : models) {
                        const int expected = model.formula(colors[channel], colors[3 + channel],
                            colors[6 + channel], colors[9 + channel], 2 * x - 127, 2 * y - 127);
                        model.mismatches += actual != expected;
                        model.error += static_cast<unsigned>(std::abs(actual - expected));
                    }
                }
            }
        }
        const double milliseconds = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - start).count();

        int matches = 0;
        const char* result = "Invalid";
        std::cout << "Model Score Error\n" << std::fixed << std::setprecision(3);
        for (const auto& model : models) {
            const double score = 100.0 * double(channels - model.mismatches) / double(channels);
            std::cout << model.name << ' ' << score << "% " << model.error << '\n';
            if (controls == 0 && model.mismatches == 0) {
                ++matches;
                result = model.name;
            }
        }
        if (matches > 1) result = "Ambiguous";
        std::cout << "Controls: " << controls << "\nResult: " << result
                  << "\nCheck ms: " << milliseconds << '\n';
        return matches == 1 ? 0 : 1;
    } catch (const std::exception& error) {
        std::cerr << "PixelTells: " << error.what() << '\n';
        return 2;
    }
}
