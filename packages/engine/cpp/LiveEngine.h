#pragma once

#include "dsp/FxChain.h"

#include <array>
#include <vector>

namespace micfx::web
{
// MicFX Live mode's voice path for the browser, the same as PluginProcessor::processBlock
// in Live mode:
//
//   mic (mono) -> input gain -> FxChain (every module, Live order) -> output gain -> limiter (-1 dB)
//
// The FxChain is the desktop's own (extern/local-mic-effects/src/dsp), unchanged. Values use
// the desktop parameter IDs ("reverbOn", "tuneSpeed"...), in real units, so presets and the
// UI carry over. Everything here runs on one thread (the AudioWorklet's).
class LiveEngine
{
public:
    LiveEngine (double sampleRate, int maxBlockSize);

    // Mono in, stereo out, `numSamples` <= the max block size.
    void process (const float* input, float* left, float* right, int numSamples) noexcept;

    // Sets a value by its desktop parameter ID. Returns false for an unknown ID.
    // Besides the chain's values: "inputGain" and "outputGain" (dB), "dryCompare" (1 skips
    // the effects: hold for dry) and "outputMuted".
    bool setValue (const juce::String& id, float value) noexcept;
    bool getValue (const juce::String& id, float& value) const noexcept;

    // Every value ID, with its default (the value it has when the engine is made).
    struct ValueInfo { juce::String id; float defaultValue; bool isSwitch; };
    const std::vector<ValueInfo>& getValueInfo() const noexcept { return valueInfo; }

    // Every value back to its default (presets start from there).
    void resetValues() noexcept;

    // The effects' order as module keys, first to last; unknown keys are ignored, and
    // missing ones keep their places after the listed ones (like the desktop presets).
    void setOrder (const juce::StringArray& keys);
    juce::StringArray getOrder() const;

    // Peak levels since the last call (linear), then reset: input after the input gain,
    // output after the limiter.
    struct Meters { float input = 0, output = 0; };
    Meters takeMeters() noexcept;

    // Samples of delay the effects add (autotune, pitch shift).
    int getLatencySamples() const noexcept { return chain.getLatencySamples(); }

    fx::FxChain& getChain() noexcept { return chain; }

private:
    fx::FxChain chain { fx::FxChain::getAllTypes() };
    juce::dsp::Gain<float> inputGain, outputGain;
    juce::dsp::Limiter<float> limiter;
    juce::AudioBuffer<float> buffer;
    std::vector<ValueInfo> valueInfo;
    float inputGainDb = 0, outputGainDb = 0;
    bool dry = false, muted = false;
    Meters peaks;
};
} // namespace micfx::web
