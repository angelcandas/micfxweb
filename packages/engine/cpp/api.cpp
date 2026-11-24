// The engine's C API, exported from engine.wasm. Strings cross the boundary through one
// text buffer (micfx_text): the caller writes an ASCII ID there, or reads a result back.
// Audio crosses through the engine's own buffers (micfx_input / micfx_output).
#include "LiveEngine.h"

#define MICFX_EXPORT extern "C" __attribute__ ((used, visibility ("default")))

namespace
{
constexpr int textSize = 32768;
char text[textSize];

struct Instance
{
    Instance (double rate, int block) : engine (rate, block), input ((size_t) block), left ((size_t) block), right ((size_t) block) {}
    micfx::web::LiveEngine engine;
    std::vector<float> input, left, right;
    float meters[3] {};
};

juce::String readText (int length)
{
    return juce::String (text, (size_t) juce::jlimit (0, textSize - 1, length));
}

int writeText (const juce::String& value)
{
    const auto utf8 = value.toRawUTF8();
    const auto length = juce::jmin ((int) std::strlen (utf8), textSize - 1);
    std::memcpy (text, utf8, (size_t) length);
    text[length] = 0;
    return length;
}
} // namespace

MICFX_EXPORT char* micfx_text() { return text; }

MICFX_EXPORT Instance* micfx_create (double sampleRate, int maxBlockSize)
{
    return new Instance (sampleRate, juce::jlimit (16, 8192, maxBlockSize));
}

MICFX_EXPORT void micfx_destroy (Instance* instance) { delete instance; }

MICFX_EXPORT float* micfx_input (Instance* instance)              { return instance->input.data(); }
MICFX_EXPORT float* micfx_output (Instance* instance, int channel) { return channel == 0 ? instance->left.data() : instance->right.data(); }

MICFX_EXPORT void micfx_process (Instance* instance, int numSamples)
{
    numSamples = juce::jlimit (0, (int) instance->input.size(), numSamples);
    instance->engine.process (instance->input.data(), instance->left.data(), instance->right.data(), numSamples);
}

// The ID is in micfx_text, `idLength` bytes. 1 when the ID is known.
MICFX_EXPORT int micfx_set_value (Instance* instance, int idLength, float value)
{
    return instance->engine.setValue (readText (idLength), value) ? 1 : 0;
}

// NaN for an unknown ID.
MICFX_EXPORT float micfx_get_value (Instance* instance, int idLength)
{
    float value = 0;
    return instance->engine.getValue (readText (idLength), value) ? value : std::numeric_limits<float>::quiet_NaN();
}

MICFX_EXPORT void micfx_reset_values (Instance* instance) { instance->engine.resetValues(); }

// Every value as "id=default=switch" lines, written to micfx_text; returns the length.
MICFX_EXPORT int micfx_value_info (Instance* instance)
{
    juce::String lines;
    for (const auto& info : instance->engine.getValueInfo())
        lines << info.id << "=" << juce::String (info.defaultValue) << "=" << (info.isSwitch ? "1" : "0") << "\n";
    return writeText (lines);
}

// The order as comma-separated module keys in micfx_text.
MICFX_EXPORT void micfx_set_order (Instance* instance, int length)
{
    instance->engine.setOrder (juce::StringArray::fromTokens (readText (length), ",", ""));
}

MICFX_EXPORT int micfx_get_order (Instance* instance)
{
    return writeText (instance->engine.getOrder().joinIntoString (","));
}

// [input peak, output peak, latency in samples], peaks since the last call.
MICFX_EXPORT float* micfx_meters (Instance* instance)
{
    const auto peaks = instance->engine.takeMeters();
    instance->meters[0] = peaks.input;
    instance->meters[1] = peaks.output;
    instance->meters[2] = (float) instance->engine.getLatencySamples();
    return instance->meters;
}
